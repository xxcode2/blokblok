// Online smoke test for the BLOCKADE ARENA web track — turn-based protocol 1.1.0.
// Drives the exact protocol from DEVELOPMENT.md through a running server
// (ws://localhost:3001 by default) with two WebSocket clients, using the
// shared core engine to pick legal moves. No browser needed.
//
// Turn model: turn 1 belongs to P1 (blue, the room creator). Each turn is
// exactly ONE action — a move or a blockade — then the turn passes; the
// server confirms the pass with a `turn` delta event. Out-of-turn input is
// rejected with NOT_YOUR_TURN. A walks to the goal; B places blockades far
// from A's path (or sidesteps when out of energy/spots).
//
//   node apps/web/scripts/smoke-online.mjs [ws://localhost:3001]
//
// Exit 0 = full flow verified (create, join, ready, start, countdown,
// matchStart, NOT_YOUR_TURN rejection, place, alternating turns, result).
// Exit 1 = failure, with the step that failed printed.

import { GameEngine, PROTOCOL_VERSION } from "../../../packages/core/dist/index.js";

const URL = process.argv[2] ?? "ws://localhost:3001";
const TIMEOUT_MS = 60000;

class Client {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.playerId = null;
    this.queue = [];
    this.waiters = []; // { pred, resolve, timer } — persist until they match
    this.seq = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.addEventListener("open", () => {
        this.send({ type: "hello", name: this.name, clientVersion: PROTOCOL_VERSION });
        resolve();
      });
      this.ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "welcome") this.playerId = msg.playerId;
        this.queue.push(msg);
        for (const w of [...this.waiters]) {
          if (w.pred(msg)) {
            this.waiters = this.waiters.filter((x) => x !== w);
            w.resolve(msg);
          }
        }
      });
      this.ws.addEventListener("error", () => reject(new Error(`${this.name}: connect failed (${URL})`)));
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Send an input with this client's own sequence number. */
  input(fields) {
    this.send({ type: "input", seq: ++this.seq, ...fields });
  }

  /** Wait for the next message matching `pred` (checks the backlog first).
   *  Only for one-shot message types — never for repeating turn events. */
  waitForMsg(pred, timeoutMs, label) {
    const found = this.queue.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const entry = { pred, resolve: null, timer: null };
      entry.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== entry);
        reject(new Error(`${this.name}: timed out waiting for ${label}`));
      }, timeoutMs);
      entry.resolve = (msg) => {
        clearTimeout(entry.timer);
        resolve(msg);
      };
      this.waiters.push(entry);
    });
  }

  waitFor(type, timeoutMs = 8000) {
    return this.waitForMsg((m) => m.type === type, timeoutMs, type);
  }

  /** Wait until the server confirms the turn passed to `playerId` — via a
   *  `turn` delta event or a `state` snapshot. No backlog scan: turn events
   *  repeat every turn, so only messages arriving from now on count. */
  waitForTurn(playerId, timeoutMs = 8000) {
    const pred = (m) =>
      (m.type === "delta" && m.events.some((e) => e.k === "turn" && e.activePlayerId === playerId)) ||
      (m.type === "state" && m.snapshot.activePlayerId === playerId);
    return new Promise((resolve, reject) => {
      const entry = { pred, resolve: null, timer: null };
      entry.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== entry);
        reject(new Error(`${this.name}: timed out waiting for turn -> ${playerId}`));
      }, timeoutMs);
      entry.resolve = (msg) => {
        clearTimeout(entry.timer);
        resolve(msg);
      };
      this.waiters.push(entry);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

const steps = [];
function step(name) {
  steps.push(name);
  console.log(`  [ok] ${name}`);
}

const deadline = setTimeout(() => {
  console.error(`\nFAIL: overall timeout after ${TIMEOUT_MS}ms. Completed steps: ${steps.join(" > ")}`);
  process.exit(1);
}, TIMEOUT_MS);

try {
  const a = new Client("Smoke-A");
  const b = new Client("Smoke-B");
  await a.connect();
  await b.connect();
  await a.waitFor("welcome");
  await b.waitFor("welcome");
  step("hello/welcome (both clients got playerIds)");

  a.send({ type: "createRoom", mode: "race", gridSize: 12, durationSec: 180 });
  const created = await a.waitFor("roomCreated");
  step(`createRoom -> roomCreated code=${created.roomCode}`);
  if (!/^[A-Z0-9]{6}$/.test(created.roomCode)) throw new Error(`bad room code: ${created.roomCode}`);

  b.send({ type: "joinRoom", roomCode: created.roomCode });
  const joined = await b.waitFor("roomJoined");
  step(`joinRoom -> roomJoined (${joined.players.length} players)`);
  if (joined.players.length !== 2) throw new Error("expected 2 players in room");

  a.send({ type: "ready", ready: true });
  b.send({ type: "ready", ready: true });
  await new Promise((r) => setTimeout(r, 300));
  step("ready x2");

  a.send({ type: "start" });
  const cd = await a.waitFor("countdown");
  step(`start -> countdown seconds=${cd.seconds}`);
  if (cd.seconds !== 3) throw new Error(`expected countdown 3, got ${cd.seconds}`);

  const start = await a.waitFor("matchStart");
  const startB = await b.waitFor("matchStart");
  step(`matchStart (tick=${start.snapshot.tick}, grid=${start.snapshot.gridSize})`);
  if (start.snapshot.status !== "playing") throw new Error(`bad status: ${start.snapshot.status}`);
  if (startB.snapshot.players.length !== 2) throw new Error("matchStart missing players");

  const aId = a.playerId;
  const bId = b.playerId;
  // Turn 1 belongs to P1 (blue) — the room creator.
  const p1Id = start.snapshot.players.find((p) => p.color === "blue")?.id;
  if (p1Id !== aId) throw new Error(`expected room creator to be P1 (blue), got P1=${p1Id} A=${aId}`);
  if (start.snapshot.activePlayerId !== aId) throw new Error(`expected turn 1 active=${aId}, got ${start.snapshot.activePlayerId}`);
  if (start.snapshot.turnNumber !== 1) throw new Error(`expected turnNumber 1, got ${start.snapshot.turnNumber}`);
  if (!(start.snapshot.turnDeadlineMs > Date.now())) {
    throw new Error(`expected turnDeadlineMs in the future, got ${start.snapshot.turnDeadlineMs}`);
  }
  step(`turn 1 = A (P1/blue), turnNumber=1, deadline in ~${Math.round((start.snapshot.turnDeadlineMs - Date.now()) / 1000)}s`);

  // Track the live state locally with the core engine so our moves are legal.
  // The mirror is kept in lockstep by applying the exact actions we send, in
  // order — it is never ticked with wall-clock time (its turn clock is
  // unanchored after fromSnapshot; only move/place/validate are used).
  let mirror = GameEngine.fromSnapshot(start.snapshot);

  // B tries to move out of turn (turn 1 is A's): expect NOT_YOUR_TURN.
  b.input({ kind: "move", dir: "down" });
  const err = await b.waitForMsg((m) => m.type === "error" && m.code === "NOT_YOUR_TURN", 5000, "NOT_YOUR_TURN error");
  if (!err) throw new Error("expected a NOT_YOUR_TURN error");
  step("out-of-turn move -> NOT_YOUR_TURN (turn did not pass)");

  // Play alternating turns until someone wins. A walks to the goal; B places
  // blockades far from A's column-6 path (or sidesteps when it cannot place).
  // A's driver takes the next step toward the goal, falling back to a
  // sidestep when the goal cell is occupied by B (nextStepTowardGoal returns
  // null head-on — a human would step around, and so must the script).
  const resultWait = a.waitFor("result", 55000);
  const safeSpots = [
    { row: 6, col: 0, orientation: "h", len: 2 },
    { row: 3, col: 0, orientation: "h", len: 2 },
    { row: 9, col: 0, orientation: "h", len: 2 },
    { row: 6, col: 9, orientation: "h", len: 2 },
    { row: 3, col: 9, orientation: "h", len: 2 },
    { row: 9, col: 9, orientation: "h", len: 2 },
    { row: 6, col: 4, orientation: "v", len: 2 },
    { row: 3, col: 4, orientation: "v", len: 2 },
  ];
  let spotIdx = 0;
  let bSide = "left";
  let turnsPlayed = 0;
  let blockadesPlaced = 0;

  /** A's next move: shortest-path step, or a sidestep if the goal cell (or
   *  the only shortest-path cell) is occupied by B. */
  function aNextMove() {
    const dir = mirror.nextStepTowardGoal(aId);
    if (dir) return dir;
    const legal = mirror.legalMoves(aId);
    const side = ["left", "right", "down", "up"].find((d) => legal.includes(d));
    if (!side) throw new Error("A has no legal move at all");
    return side;
  }

  while (mirror.snapshot().status !== "finished") {
    const ms = mirror.snapshot();
    if (ms.activePlayerId === aId) {
      const dir = aNextMove();
      const res = mirror.move(aId, dir);
      if (!res.ok) throw new Error(`mirror move ${dir} failed: ${res.code}`);
      a.input({ kind: "move", dir });
      turnsPlayed++;
      if (mirror.snapshot().status === "finished") break;
      await a.waitForTurn(bId);
    } else {
      // B's turn: place at the next safe spot, else sidestep along row 0.
      let acted = false;
      while (spotIdx < safeSpots.length && !acted) {
        const edge = safeSpots[spotIdx++];
        const res = mirror.place(bId, edge);
        if (res.ok) {
          b.input({ kind: "place", edge });
          blockadesPlaced++;
          acted = true;
        }
      }
      if (!acted) {
        const legal = mirror.legalMoves(bId);
        const side = legal.includes(bSide) ? bSide : legal.includes("left") ? "left" : legal.includes("right") ? "right" : legal[0];
        if (!side) throw new Error("B has no legal action on its turn");
        const res = mirror.move(bId, side);
        if (!res.ok) throw new Error(`mirror sidestep ${side} failed: ${res.code}`);
        b.input({ kind: "move", dir: side });
        bSide = side === "left" ? "right" : "left";
        acted = true;
      }
      turnsPlayed++;
      if (mirror.snapshot().status === "finished") break;
      await b.waitForTurn(aId);
    }
  }
  step(`alternating turns played (${turnsPlayed} actions, ${blockadesPlaced} blockades by B)`);

  const result = await resultWait;
  step(`result winnerId=${result.winnerId} reason=${result.reason} scores=${JSON.stringify(result.scores)}`);
  if (result.winnerId !== aId) throw new Error(`expected A to win, winner was ${result.winnerId}`);
  if (result.reason !== "goal") throw new Error(`expected reason goal, got ${result.reason}`);
  if (result.scores[aId] <= 100) throw new Error(`expected winning score > 100, got ${result.scores[aId]}`);

  a.close();
  b.close();
  clearTimeout(deadline);
  console.log(`\nSMOKE ONLINE: PASS (${steps.length} steps)`);
  process.exit(0);
} catch (e) {
  clearTimeout(deadline);
  console.error(`\nSMOKE ONLINE: FAIL — ${e.message}`);
  console.error(`Completed steps: ${steps.join(" > ") || "(none)"}`);
  process.exit(1);
}
