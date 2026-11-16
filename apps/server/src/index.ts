// BLOCKADE ARENA — authoritative multiplayer server.
// WebSocket (JSON) + a tiny HTTP surface (/health, /stats) on the same port.
// Server-authoritative: every input is validated by the GameEngine on the
// 20/s tick loop; clients never send state, only inputs.
// Storage is IN-MEMORY ONLY (Map). Match results are lost on restart —
// PostgreSQL/Redis persistence is a later phase (see DEVELOPMENT.md).

import { randomBytes } from "node:crypto";
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { PROTOCOL_VERSION, type ClientMessage, type GridSize, type ServerMessage } from "@blockade/core";
import { Matchmaker } from "./matchmaking.js";
import { RoomManager, type Room } from "./rooms.js";
import type { MatchHooks } from "./match.js";

const PORT = Number(process.env.PORT ?? 3001);
const SERVER_VERSION = "0.1.0";
const MAX_INPUTS_PER_SEC = 30;
const DISCONNECT_GRACE_MS = 30_000;
const VALID_GRID_SIZES = [12, 20, 30, 40];
const DIRS = ["up", "down", "left", "right"];

const startedAtMs = Date.now();
const log = (...args: unknown[]) => console.log(new Date().toISOString(), "[server]", ...args);

interface Conn {
  ws: WebSocket;
  playerId: string | null;
  name: string;
  roomId: string | null;
  inputTimes: number[];
}

interface StoredResult extends Extract<ServerMessage, { type: "result" }> {
  roomId: string;
  finishedAtMs: number;
}

const rooms = new RoomManager();
const matchmaker = new Matchmaker();
const connsByPlayer = new Map<string, Conn>();
const connsByWs = new Map<WebSocket, Conn>();
const tokens = new Map<string, { roomId: string; playerId: string }>();
const results = new Map<string, StoredResult>();
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// send helpers
// ---------------------------------------------------------------------------
function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendTo(playerId: string, msg: ServerMessage): void {
  const c = connsByPlayer.get(playerId);
  if (c) send(c.ws, msg);
}

function broadcastToRoom(room: Room, msg: ServerMessage): void {
  for (const p of room.players.keys()) sendTo(p, msg);
}

function sendError(ws: WebSocket, code: string, message: string): void {
  send(ws, { type: "error", code, message });
}

// ---------------------------------------------------------------------------
// room / match lifecycle
// ---------------------------------------------------------------------------
function makeMatchHooks(room: Room): MatchHooks {
  return {
    send: (playerId, msg) => sendTo(playerId, msg),
    broadcast: (msg) => broadcastToRoom(room, msg),
    onFinish: (result) => {
      results.set(room.id, { ...result, roomId: room.id, finishedAtMs: Date.now() });
      room.markFinished();
      broadcastToRoom(room, result);
      log(`match finished room=${room.code} winner=${result.winnerId ?? "draw"} reason=${result.reason}`);
    },
  };
}

function beginMatch(room: Room): boolean {
  const hooks = makeMatchHooks(room);
  return room.startCountdown(
    hooks,
    () => broadcastToRoom(room, { type: "countdown", seconds: 3 }),
    () => broadcastToRoom(room, { type: "matchStart", snapshot: room.engine.snapshot() }),
  );
}

function leaveCurrentRoom(conn: Conn): void {
  if (conn.playerId) matchmaker.leave(conn.playerId);
  const roomId = conn.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  conn.roomId = null;
  if (!room) return;
  if (room.status === "countdown") room.cancelCountdown();
  room.removePlayer(conn.playerId!);
  if (room.size === 0) {
    rooms.delete(room.id);
    log(`room deleted code=${room.code} (empty)`);
  } else {
    broadcastToRoom(room, { type: "lobbyUpdate", players: room.lobbyPlayers() });
  }
}

function registerToken(room: Room, playerId: string): string {
  const p = room.players.get(playerId);
  if (!p) return "";
  tokens.set(p.token, { roomId: room.id, playerId });
  return p.token;
}

// ---------------------------------------------------------------------------
// message handlers
// ---------------------------------------------------------------------------
function handleCreateRoom(conn: Conn, msg: Extract<ClientMessage, { type: "createRoom" }>): void {
  if (msg.mode !== "race") return sendError(conn.ws, "BAD_REQUEST", "only mode 'race' is supported");
  if (!VALID_GRID_SIZES.includes(msg.gridSize)) {
    return sendError(conn.ws, "BAD_REQUEST", "gridSize must be 12, 20, 30 or 40");
  }
  const durationSec =
    typeof msg.durationSec === "number" && Number.isFinite(msg.durationSec)
      ? Math.min(600, Math.max(30, Math.floor(msg.durationSec)))
      : 180;
  leaveCurrentRoom(conn);
  const room = rooms.create(msg.mode, msg.gridSize, durationSec);
  const player = room.addPlayer(conn.playerId!, conn.name || "Player", true);
  conn.roomId = room.id;
  const token = registerToken(room, player.id);
  send(conn.ws, { type: "roomCreated", roomId: room.id, roomCode: room.code, token });
  log(`room created code=${room.code} host=${player.id} grid=${room.gridSize} dur=${durationSec}s`);
}

function handleJoinRoom(conn: Conn, msg: Extract<ClientMessage, { type: "joinRoom" }>): void {
  if (typeof msg.roomCode !== "string" || msg.roomCode.length === 0) {
    return sendError(conn.ws, "BAD_REQUEST", "roomCode is required");
  }
  const room = rooms.getByCode(msg.roomCode);
  if (!room) return sendError(conn.ws, "ROOM_NOT_FOUND", `no room with code ${msg.roomCode}`);
  if (room.status !== "lobby") return sendError(conn.ws, "BAD_REQUEST", "match already started");
  if (room.isFull()) return sendError(conn.ws, "ROOM_FULL", "room already has 2 players");
  leaveCurrentRoom(conn);
  const player = room.addPlayer(conn.playerId!, conn.name || "Player", false);
  conn.roomId = room.id;
  const token = registerToken(room, player.id);
  send(conn.ws, {
    type: "roomJoined",
    roomId: room.id,
    roomCode: room.code,
    mode: room.mode,
    gridSize: room.gridSize,
    durationSec: room.durationSec,
    players: room.lobbyPlayers(),
  });
  // Keep the token usable for reconnect (spec issues it at roomCreated /
  // matchFound; joining players need one too).
  void token;
  broadcastToRoom(room, { type: "lobbyUpdate", players: room.lobbyPlayers() });
  log(`room joined code=${room.code} player=${player.id}`);
}

function tryPairQueue(): void {
  const pair = matchmaker.findPair();
  if (!pair) return;
  const [a, b] = pair;
  const room = rooms.create(a.mode, a.gridSize as GridSize, 180);
  const pa = room.addPlayer(a.playerId, a.name, true);
  const pb = room.addPlayer(b.playerId, b.name, false);
  const connA = connsByPlayer.get(a.playerId);
  const connB = connsByPlayer.get(b.playerId);
  if (connA) connA.roomId = room.id;
  if (connB) connB.roomId = room.id;
  const tokenA = registerToken(room, pa.id);
  const tokenB = registerToken(room, pb.id);
  // Matchmade players are auto-ready; the host auto-starts shortly after
  // matchFound so a public match needs no lobby clicks.
  room.setReady(pa.id, true);
  room.setReady(pb.id, true);
  sendTo(a.playerId, { type: "matchFound", roomId: room.id, roomCode: room.code, token: tokenA, opponent: { id: b.playerId, name: b.name } });
  sendTo(b.playerId, { type: "matchFound", roomId: room.id, roomCode: room.code, token: tokenB, opponent: { id: a.playerId, name: a.name } });
  log(`match found room=${room.code} ${a.playerId} vs ${b.playerId}`);
  setTimeout(() => {
    if (room.status === "lobby" && room.size === 2 && room.allReady()) {
      beginMatch(room);
    }
  }, 500);
}

function handleQueue(conn: Conn, msg: Extract<ClientMessage, { type: "queue" }>): void {
  if (msg.mode !== "race") return sendError(conn.ws, "BAD_REQUEST", "only mode 'race' is supported");
  if (!VALID_GRID_SIZES.includes(msg.gridSize)) {
    return sendError(conn.ws, "BAD_REQUEST", "gridSize must be 12, 20, 30 or 40");
  }
  leaveCurrentRoom(conn);
  const position = matchmaker.enqueue(conn.playerId!, conn.name || "Player", msg.mode, msg.gridSize);
  send(conn.ws, { type: "queued", position });
  tryPairQueue();
}

function handleInput(conn: Conn, msg: Extract<ClientMessage, { type: "input" }>): void {
  const now = Date.now();
  const recent = conn.inputTimes.filter((t) => now - t < 1000);
  if (recent.length >= MAX_INPUTS_PER_SEC) {
    return sendError(conn.ws, "BAD_REQUEST", `input rate limit: max ${MAX_INPUTS_PER_SEC}/sec`);
  }
  recent.push(now);
  conn.inputTimes = recent;
  if (!conn.roomId) return sendError(conn.ws, "NOT_IN_MATCH", "not in a match");
  const room = rooms.get(conn.roomId);
  if (!room || !room.match || room.status !== "playing") {
    return sendError(conn.ws, "NOT_IN_MATCH", "not in an active match");
  }
  if (typeof msg.seq !== "number" || !Number.isFinite(msg.seq)) {
    return sendError(conn.ws, "BAD_REQUEST", "input seq must be a number");
  }
  if (msg.kind === "move") {
    if (!DIRS.includes(msg.dir)) return sendError(conn.ws, "BAD_REQUEST", "invalid dir");
  } else if (msg.kind === "place") {
    const e = msg.edge;
    if (!e || typeof e.row !== "number" || typeof e.col !== "number" || !["h", "v"].includes(e.orientation)) {
      return sendError(conn.ws, "BAD_REQUEST", "invalid edge");
    }
  } else if (msg.kind === "placeAuto") {
    if (!DIRS.includes(msg.dir) || !["h", "v"].includes(msg.orientation) || typeof msg.len !== "number") {
      return sendError(conn.ws, "BAD_REQUEST", "invalid placeAuto");
    }
  } else {
    return sendError(conn.ws, "BAD_REQUEST", "unknown input kind");
  }
  room.match.queueInput(conn.playerId!, msg);
}

function handleReconnect(conn: Conn, msg: Extract<ClientMessage, { type: "reconnect" }>): void {
  const found = tokens.get(msg.token);
  if (!found) return sendError(conn.ws, "BAD_TOKEN", "unknown or expired reconnect token");
  const room = rooms.get(found.roomId);
  if (!room || !room.players.has(found.playerId)) {
    return sendError(conn.ws, "BAD_TOKEN", "match no longer exists");
  }
  // Rebind this connection to the returning player (the old socket is dead).
  const old = connsByPlayer.get(found.playerId);
  if (old && old !== conn) old.playerId = null;
  conn.playerId = found.playerId;
  conn.roomId = room.id;
  connsByPlayer.set(found.playerId, conn);
  const player = room.players.get(found.playerId)!;
  player.connected = true;
  const graceKey = `${room.id}:${found.playerId}`;
  const timer = graceTimers.get(graceKey);
  if (timer) {
    clearTimeout(timer);
    graceTimers.delete(graceKey);
  }
  send(conn.ws, { type: "reconnected", snapshot: room.engine.snapshot() });
  if (room.match && room.status === "playing") {
    send(conn.ws, { type: "state", tick: room.engine.tickCount, snapshot: room.engine.snapshot() });
  }
  const stored = results.get(room.id);
  if (stored && room.status === "finished") send(conn.ws, stored);
  log(`reconnected player=${found.playerId} room=${room.code}`);
}

function handleMessage(conn: Conn, raw: string): void {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    return sendError(conn.ws, "BAD_REQUEST", "invalid JSON");
  }
  if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
    return sendError(conn.ws, "BAD_REQUEST", "message must be an object with a type");
  }
  if (msg.type === "hello") {
    if (!conn.playerId) {
      conn.playerId = `p_${randomBytes(6).toString("hex")}`;
      connsByPlayer.set(conn.playerId, conn);
    }
    if (typeof msg.name === "string" && msg.name.length > 0) conn.name = msg.name.slice(0, 32);
    return send(conn.ws, { type: "welcome", playerId: conn.playerId, serverVersion: SERVER_VERSION });
  }
  // reconnect authenticates via token, so it is valid as the first message
  // on a fresh socket (no hello yet — the playerId comes from the token).
  if (msg.type === "reconnect") return handleReconnect(conn, msg);
  if (!conn.playerId) return sendError(conn.ws, "BAD_REQUEST", "send hello first");
  switch (msg.type) {
    case "createRoom":
      return handleCreateRoom(conn, msg);
    case "joinRoom":
      return handleJoinRoom(conn, msg);
    case "queue":
      return handleQueue(conn, msg);
    case "leaveQueue": {
      const left = matchmaker.leave(conn.playerId);
      void left;
      return send(conn.ws, { type: "queueLeft" });
    }
    case "ready": {
      const room = conn.roomId ? rooms.get(conn.roomId) : undefined;
      if (!room) return sendError(conn.ws, "BAD_REQUEST", "not in a room");
      if (room.status !== "lobby") return sendError(conn.ws, "BAD_REQUEST", "match already started");
      room.setReady(conn.playerId, msg.ready === true);
      return broadcastToRoom(room, { type: "lobbyUpdate", players: room.lobbyPlayers() });
    }
    case "start": {
      const room = conn.roomId ? rooms.get(conn.roomId) : undefined;
      if (!room) return sendError(conn.ws, "BAD_REQUEST", "not in a room");
      if (room.hostId !== conn.playerId) return sendError(conn.ws, "NOT_HOST", "only the host can start");
      if (!room.allReady()) return sendError(conn.ws, "NOT_READY", "all players must be ready");
      if (!beginMatch(room)) return sendError(conn.ws, "NOT_READY", "could not start match");
      return;
    }
    case "input":
      return handleInput(conn, msg);
    case "ping":
      return send(conn.ws, { type: "pong", t: msg.t });
    default:
      return sendError(conn.ws, "BAD_REQUEST", `unknown message type ${(msg as { type: string }).type}`);
  }
}

function handleDisconnect(conn: Conn): void {
  const playerId = conn.playerId;
  connsByWs.delete(conn.ws);
  if (!playerId) return;
  // Only clear the binding if this socket is still the live one (a
  // reconnect may already have rebound the player to a new socket).
  if (connsByPlayer.get(playerId) === conn) connsByPlayer.delete(playerId);
  matchmaker.leave(playerId);
  const room = conn.roomId ? rooms.get(conn.roomId) : undefined;
  if (!room || !room.players.has(playerId)) return;
  const player = room.players.get(playerId)!;
  player.connected = false;
  if (room.status === "lobby" || room.status === "countdown") {
    if (room.status === "countdown") room.cancelCountdown();
    room.removePlayer(playerId);
    if (room.size === 0) {
      rooms.delete(room.id);
      log(`room deleted code=${room.code} (empty after disconnect)`);
    } else {
      broadcastToRoom(room, { type: "lobbyUpdate", players: room.lobbyPlayers() });
    }
    return;
  }
  if (room.status === "playing" && room.match && !room.match.isFinished()) {
    broadcastToRoom(room, { type: "opponentLeft", playerId });
    const graceKey = `${room.id}:${playerId}`;
    const timer = setTimeout(() => {
      graceTimers.delete(graceKey);
      const p = room.players.get(playerId);
      if (p && !p.connected && room.match && !room.match.isFinished()) {
        log(`forfeit player=${playerId} room=${room.code} (30s grace expired)`);
        room.match.forfeit(playerId);
      }
    }, DISCONNECT_GRACE_MS);
    graceTimers.set(graceKey, timer);
    log(`player disconnected mid-match player=${playerId} room=${room.code} (30s grace)`);
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket server (same port)
// ---------------------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: SERVER_VERSION, protocol: PROTOCOL_VERSION, uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000) }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/stats") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        rooms: rooms.count(),
        matches: rooms.activeMatches(),
        queued: matchmaker.size(),
        results: results.size,
        playersOnline: connsByPlayer.size,
        uptimeSec: Math.floor((Date.now() - startedAtMs) / 1000),
        tick: rooms.allTickStats(),
      }),
    );
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const conn: Conn = { ws, playerId: null, name: "Player", roomId: null, inputTimes: [] };
  connsByWs.set(ws, conn);
  ws.on("message", (data) => {
    try {
      handleMessage(conn, data.toString());
    } catch (err) {
      log("message handler error:", err);
      sendError(ws, "BAD_REQUEST", "internal error handling message");
    }
  });
  ws.on("close", () => handleDisconnect(conn));
  ws.on("error", () => handleDisconnect(conn));
});

httpServer.listen(PORT, () => {
  log(`BLOCKADE ARENA server listening on :${PORT} (ws + http /health /stats)`);
});
