// Matchmaking smoke test — turn-based protocol 1.3.0: two clients queue ->
// matchFound -> countdown -> matchStart (turn 1 = P1/blue, turnNumber 1,
// 30 s deadline), then P1 moves once and the `turn` delta passes the turn
// to P2. Run: node apps/web/scripts/smoke-queue.mjs
import { PROTOCOL_VERSION } from "../../../packages/core/dist/index.js";

const URL = process.argv[2] ?? "ws://localhost:3001";

class Client {
  constructor(name) {
    this.name = name;
    this.queue = [];
    this.waiters = []; // { pred, resolve, timer } — persist until they match
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
      this.ws.addEventListener("error", () => reject(new Error(`${this.name}: connect failed`)));
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
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
  waitFor(type, timeoutMs = 10000) {
    return this.waitForMsg((m) => m.type === type, timeoutMs, type);
  }
  /** Wait for the turn to pass to `playerId` (turn delta or state snapshot).
   *  No backlog scan: turn events repeat every turn. */
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
    } catch {}
  }
}

try {
  const a = new Client("Queue-A");
  const b = new Client("Queue-B");
  await a.connect();
  await b.connect();
  await a.waitFor("welcome");
  await b.waitFor("welcome");
  a.send({ type: "queue", mode: "race", gridSize: 12 });
  b.send({ type: "queue", mode: "race", gridSize: 12 });
  const qa = await a.waitFor("queued");
  console.log(`  [ok] queued position=${qa.position}`);
  const mfA = await a.waitFor("matchFound");
  const mfB = await b.waitFor("matchFound");
  console.log(`  [ok] matchFound roomCode=${mfA.roomCode} opponent=${mfA.opponent.name} / ${mfB.opponent.name}`);
  const cd = await a.waitFor("countdown", 10000);
  console.log(`  [ok] countdown seconds=${cd.seconds}`);
  const ms = await a.waitFor("matchStart", 10000);
  console.log(`  [ok] matchStart status=${ms.snapshot.status} players=${ms.snapshot.players.length}`);
  if (ms.snapshot.status !== "playing") throw new Error(`bad status: ${ms.snapshot.status}`);
  if (ms.snapshot.turnNumber !== 1) throw new Error(`expected turnNumber 1, got ${ms.snapshot.turnNumber}`);
  if (!(ms.snapshot.turnDeadlineMs > Date.now())) {
    throw new Error(`expected turnDeadlineMs in the future, got ${ms.snapshot.turnDeadlineMs}`);
  }
  const p1 = ms.snapshot.players.find((p) => p.color === "blue");
  const p2 = ms.snapshot.players.find((p) => p.color === "red");
  if (!p1 || !p2) throw new Error("matchStart missing blue/red players");
  if (ms.snapshot.activePlayerId !== p1.id) {
    throw new Error(`expected turn 1 active=${p1.id} (P1/blue), got ${ms.snapshot.activePlayerId}`);
  }
  console.log(`  [ok] turn 1 = P1 (blue), turnNumber=1, deadline in ~${Math.round((ms.snapshot.turnDeadlineMs - Date.now()) / 1000)}s`);
  // Protocol 1.3.0: every player starts with 10 blockades left, no score.
  if (ms.snapshot.players.some((p) => p.blockadesLeft !== 10)) {
    throw new Error(`expected blockadesLeft=10 for all players, got ${JSON.stringify(ms.snapshot.players.map((p) => p.blockadesLeft))}`);
  }
  if (ms.snapshot.players.some((p) => "score" in p)) throw new Error("snapshot players must not carry score in protocol 1.3.0");
  console.log(`  [ok] blockadesLeft=10 for every player at matchStart, no score on players`);
  // P1 moves once (up, from the bottom row); the turn delta must pass the
  // turn to P2.
  const p1Client = a.playerId === p1.id ? a : b;
  const p2Client = p1Client === a ? b : a;
  p1Client.send({ type: "input", seq: 1, kind: "move", dir: "up" });
  await p2Client.waitForTurn(p2.id);
  console.log(`  [ok] P1 move -> turn delta passed the turn to P2`);
  a.close();
  b.close();
  console.log("\nSMOKE QUEUE: PASS");
  process.exit(0);
} catch (e) {
  console.error(`\nSMOKE QUEUE: FAIL — ${e.message}`);
  process.exit(1);
}
