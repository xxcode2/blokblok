// BLOCKADE ARENA — WebSocket client for the authoritative server.
// Speaks the protocol in DEVELOPMENT.md exactly: hello, createRoom, joinRoom,
// queue, ready, start, input (move/place/placeAuto), ping, reconnect.
// Auto-reconnects with the session token if the socket drops mid-match.
//
// Protocol 1.3.0: createRoom / queue / roomJoined / matchFound carry
// `mode: "race" | "trophy"` and `playerCount: 2 | 4`; snapshots carry
// `mode`, `playerCount` and `trophy: { row, col } | null`; the `win` delta
// and `result` win reason may be "trophy". There is NO score anywhere in
// 1.3.0 — no `score` on PlayerState, no `score` delta event, no `scores`
// on `result`; players carry `blockadesLeft` (10 − blockades placed).
// PROTOCOL_VERSION comes from @blockade/core (1.3.0).

import type {
  ClientMessage,
  Edge,
  Dir,
  GameMode,
  GridSize,
  Orientation,
  ServerMessage,
  Snapshot,
  DeltaEvent,
} from "@blockade/core";
import { PROTOCOL_VERSION } from "@blockade/core";

export const DEFAULT_SERVER_URL =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_SERVER_URL) || "ws://localhost:3001";

export interface NetHandlers {
  onMessage: (msg: ServerMessage) => void;
  onOpen: () => void;
  /** `inMatch` is true when we held a reconnect token (match in progress). */
  onClose: (inMatch: boolean) => void;
  onError: (e: Event) => void;
}

const PING_INTERVAL_MS = 2000;
const RECONNECT_MAX_ATTEMPTS = 6;

export class NetClient {
  readonly url: string;
  playerId: string | null = null;
  token: string | null = null;
  roomCode: string | null = null;
  roomId: string | null = null;
  latencyMs: number | null = null;
  connected = false;
  /** True once a match/room is live, until we leave it. */
  inMatch = false;
  /** Arena mode of the current room, when the server reported it (1.2.0). */
  roomMode: "race" | "trophy" | null = null;
  /** Player count of the current room, when the server reported it (1.2.0). */
  roomPlayerCount: number | null = null;

  private ws: WebSocket | null = null;
  private seq = 0;
  private handlers: NetHandlers | null = null;
  private pingTimer: number | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private manualClose = false;
  private helloName = "Player";

  constructor(url: string = DEFAULT_SERVER_URL) {
    this.url = url;
  }

  connect(name: string, handlers: NetHandlers): Promise<void> {
    this.handlers = handlers;
    this.helloName = name;
    this.manualClose = false;
    this.reconnectAttempts = 0;
    return this.openSocket(false);
  }

  private openSocket(isReconnect: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.url);
      } catch (e) {
        reject(e instanceof Error ? e : new Error("WebSocket failed"));
        return;
      }
      this.ws = ws;
      let settled = false;
      const onOpen = () => {
        this.connected = true;
        this.handlers?.onOpen();
        this.startPing();
        if (isReconnect && this.token) {
          this.send({ type: "reconnect", token: this.token });
        } else {
          this.send({ type: "hello", name: this.helloName, clientVersion: PROTOCOL_VERSION });
        }
        settled = true;
        resolve();
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("message", (ev) => this.handleRaw(ev.data));
      ws.addEventListener("error", (e) => {
        if (!settled) {
          settled = true;
          reject(new Error("Could not connect to the game server"));
        }
        this.handlers?.onError(e);
      });
      ws.addEventListener("close", () => this.handleClose());
    });
  }

  private handleRaw(data: unknown): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(String(data)) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === "welcome") {
      this.playerId = msg.playerId;
    } else if (msg.type === "roomCreated") {
      this.token = msg.token;
      this.roomId = msg.roomId;
      this.roomCode = msg.roomCode;
      this.inMatch = true;
    } else if (msg.type === "matchFound") {
      this.token = msg.token;
      this.roomId = msg.roomId;
      this.roomCode = msg.roomCode;
      this.inMatch = true;
      // 1.2.0: matchFound carries the arena mode + player count.      this.roomMode = msg.mode;
      this.roomPlayerCount = msg.playerCount;
    } else if (msg.type === "roomJoined") {
      this.roomId = msg.roomId;
      this.roomCode = msg.roomCode;
      this.inMatch = true;
      this.roomMode = msg.mode;
      this.roomPlayerCount = msg.playerCount;
    } else if (msg.type === "pong") {
      this.latencyMs = Math.max(0, Date.now() - msg.t);
      return; // latency is consumed here, not forwarded
    } else if (msg.type === "reconnected") {
      this.reconnectAttempts = 0;
    }
    this.handlers?.onMessage(msg);
  }

  private handleClose(): void {
    this.connected = false;
    this.stopPing();
    this.ws = null;
    const hadMatch = this.inMatch && this.token !== null;
    this.handlers?.onClose(hadMatch);
    if (hadMatch && !this.manualClose && this.reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
      const delay = Math.min(8000, 1000 * 2 ** this.reconnectAttempts);
      this.reconnectAttempts++;
      this.reconnectTimer = window.setTimeout(() => {
        void this.openSocket(true).catch(() => {
          /* next close event re-triggers the backoff */
        });
      }, delay);
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ type: "ping", t: Date.now() });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Leave the current room/match and close the socket (no auto-reconnect). */
  disconnect(): void {
    this.manualClose = true;
    this.inMatch = false;
    this.token = null;
    this.roomMode = null;
    this.roomPlayerCount = null;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.connected = false;
  }

  send(msg: ClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  createRoom(mode: GameMode, gridSize: GridSize, durationSec: number, playerCount: 2 | 4 = 2): void {
    // 1.2.0: the room carries mode + playerCount.
    this.send({ type: "createRoom", mode, gridSize, durationSec, playerCount });
  }

  joinRoom(roomCode: string): void {
    this.send({ type: "joinRoom", roomCode: roomCode.trim().toUpperCase() });
  }

  queue(mode: GameMode, gridSize: number, playerCount: 2 | 4 = 2): void {
    this.send({ type: "queue", mode, gridSize, playerCount });
  }

  leaveQueue(): void {
    this.send({ type: "leaveQueue" });
  }

  setReady(ready: boolean): void {
    this.send({ type: "ready", ready });
  }

  start(): void {
    this.send({ type: "start" });
  }

  inputMove(dir: Dir): void {
    this.send({ type: "input", seq: ++this.seq, kind: "move", dir });
  }

  inputPlace(edge: Edge): void {
    this.send({ type: "input", seq: ++this.seq, kind: "place", edge });
  }

  inputPlaceAuto(dir: Dir, orientation: Orientation, len: number): void {
    this.send({ type: "input", seq: ++this.seq, kind: "placeAuto", dir, orientation, len });
  }
}

/** Apply server delta events to a snapshot copy (client-side state tracking). */
export function applyDeltaToSnapshot(snap: Snapshot, events: DeltaEvent[]): Snapshot {
  const next: Snapshot = {
    ...snap,
    players: snap.players.map((p) => ({ ...p })),
    blockades: [...snap.blockades],
  };
  for (const e of events) {
    if (e.k === "move") {
      const p = next.players.find((x) => x.id === e.playerId);
      if (p) {
        p.row = e.row;
        p.col = e.col;
      }
      next.tick = Math.max(next.tick, e.tick);
    } else if (e.k === "blockade") {
      if (!next.blockades.some((b) => b.id === e.blockade.id)) {
        next.blockades = [...next.blockades, e.blockade];
      }
    } else if (e.k === "energy") {
      const p = next.players.find((x) => x.id === e.playerId);
      if (p) p.energy = e.energy;
    } else if (e.k === "timer") {
      next.timeLeftMs = e.timeLeftMs;
    } else if (e.k === "turn") {
      // Turn-based (protocol 1.2.0): the turn passed — update who may act,
      // the turn number, and the deadline the turn-timer bar counts down from.
      next.activePlayerId = e.activePlayerId;
      next.turnNumber = e.turnNumber;
      next.turnDeadlineMs = e.turnDeadlineMs;
    } else if (e.k === "collide") {
      // No state change — the renderer turns this into sparks + a thud.
    } else if (e.k === "win") {
      // Win reason is "goal" in race, "trophy" in trophy mode (1.2.0) —
      // either way the match is finished and winnerId is authoritative.
      next.winnerId = e.winnerId;
      next.status = "finished";
    }
  }
  return next;
}
