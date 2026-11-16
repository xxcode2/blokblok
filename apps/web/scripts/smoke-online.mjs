// Online smoke test for the BLOCKADE ARENA web track.
// Drives the exact protocol from DEVELOPMENT.md through a running server
// (ws://localhost:3001 by default) with two WebSocket clients, using the
// shared core engine to pick legal moves. No browser needed.
//
//   node apps/web/scripts/smoke-online.mjs [ws://localhost:3001]
//
// Exit 0 = full flow verified (create, join, ready, start, countdown,
// matchStart, move, place, delta, result). Exit 1 = failure, with the step
// that failed printed.

import { GameEngine } from "../../../packages/core/dist/index.js";

const URL = process.argv[2] ?? "ws://localhost:3001";
const TIMEOUT_MS = 30000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Client {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.playerId = null;
    this.queue = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.addEventListener("open", () => {
        this.send({ type: "hello", name: this.name, clientVersion: "1.0.0" });
        resolve();
      });
      this.ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "welcome") this.playerId = msg.playerId;
        this.queue.push(msg);
        const ws = this.waiters.splice(0);
        for (const w of ws) w(msg);
      });
      this.ws.addEventListener("error", () => reject(new Error(`${this.name}: connect failed (${URL})`)));
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Wait for the next message of `type` (checks the backlog first). */
  waitFor(type, timeoutMs = 8000) {
    const found = this.queue.find((m) => m.type === type);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push((msg) => {
        if (msg.type === type) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
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
  await sleep(300);
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

  // Track the live state locally with the core engine so our moves are legal.
  const mirror = GameEngine.fromSnapshot(start.snapshot);
  const aId = a.playerId;
  const bId = b.playerId;
  let seq = 0;

  // B places a blockade far from A's column-6 walking path (A will cross
  // h-edge (6,6), so the wall goes at cols 0-1 instead).
  const placeRes = mirror.place(bId, { row: 6, col: 0, orientation: "h", len: 2 });
  if (!placeRes.ok) throw new Error(`mirror place failed: ${placeRes.code}`);
  b.send({ type: "input", seq: ++seq, kind: "place", edge: { row: 6, col: 0, orientation: "h", len: 2 } });
  const delta = await a.waitFor("delta");
  const blockadeEvent = delta.events.find((e) => e.k === "blockade");
  if (!blockadeEvent) throw new Error("no blockade event in delta");
  step(`place -> delta blockade ${blockadeEvent.blockade.id}`);

  // A walks to the goal: up x10, left, up (B spawns on (0,6)).
  const moves = ["up", "up", "up", "up", "up", "up", "up", "up", "up", "up", "left", "up"];
  for (const dir of moves) {
    const res = mirror.move(aId, dir);
    if (!res.ok) throw new Error(`mirror move ${dir} failed: ${res.code}`);
    a.send({ type: "input", seq: ++seq, kind: "move", dir });
    await sleep(220); // respect the 150ms move cooldown
    mirror.tickMs(220);
  }
  step(`move x${moves.length} (walked A to the goal row)`);

  const result = await a.waitFor("result", 10000);
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
