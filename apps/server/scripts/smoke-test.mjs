// BLOCKADE ARENA — server smoke test (scripted TURN-BASED 1v1 over raw WebSockets).
// Protocol 1.3.0: one action per turn (move 1 cell OR place 1 blockade),
// 30 s per turn, +10 energy at the start of your turn, turn 1 belongs to P1.
// No points: the result is win/lose/draw only (winnerId + reason + stats +
// durationMs). Blockade cap: 10 per player per match (NO_BLOCKADES).
// Run with the server already up:  npm start --workspace=@blockade/server
// then:                                node apps/server/scripts/smoke-test.mjs
// Expects: hello → createRoom → joinRoom → ready → start → countdown →
// matchStart (turn 1, P1 active, deadline now+30s, 10 blockadesLeft) →
// P1 valid place → P1 out-of-turn move rejected NOT_YOUR_TURN → P2
// overlapping place rejected INVALID_BLOCKADE (turn does NOT pass) →
// P1 places 9 more blockades (10 total, recharging with idle wiggles when
// energy runs short) → 11th placement rejected NO_BLOCKADES (turn does NOT
// pass) → alternating turns: P1 walks to the goal row while P2 wiggles →
// result with P1 as winner, reason goal, stats blockades 10.
// Also measures tick smoothness: inter-arrival gaps of delta/state
// broadcasts during play, plus the server's own tick timing from GET /stats.
import WebSocket from "ws";

const PORT = Number(process.env.SMOKE_PORT ?? process.env.PORT ?? 3001);
const URL = `ws://127.0.0.1:${PORT}`;
const HTTP = `http://127.0.0.1:${PORT}`;

const failures = [];
const notes = [];
function check(cond, label) {
  if (cond) notes.push(`  ok: ${label}`);
  else failures.push(label);
}

function makeClient(label) {
  const ws = new WebSocket(URL);
  const log = [];
  const waiters = [];
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    log.push({ at: Date.now(), msg });
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(msg)) {
        const w = waiters.splice(i, 1)[0];
        w.resolve(msg);
      }
    }
  });
  const waitFor = (pred, timeoutMs, what) =>
    new Promise((resolve, reject) => {
      const found = log.find((e) => pred(e.msg));
      if (found) return resolve(found.msg);
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${what} (${label})`)), timeoutMs);
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  const send = (obj) => ws.send(JSON.stringify(obj));
  const close = () => ws.close();
  return { label, ws, log, waitFor, send, close };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Send one input and wait a tick so the server applies it before the next
// input is sent (inputs are applied on the 50 ms tick loop, in seq order).
async function sendAndSettle(client, obj) {
  client.send(obj);
  await sleep(120);
}

async function main() {
  const t0 = Date.now();
  const baseline = await (await fetch(`${HTTP}/stats`)).json().catch(() => ({ results: 0, matches: 0 }));
  const a = makeClient("A(host/P1)");
  const b = makeClient("B(P2)");
  await Promise.all([
    new Promise((r) => a.ws.on("open", r)),
    new Promise((r) => b.ws.on("open", r)),
  ]);

  // 1. hello → welcome
  a.send({ type: "hello", name: "Alice", clientVersion: "smoke-1" });
  b.send({ type: "hello", name: "Bob", clientVersion: "smoke-1" });
  const wa = await a.waitFor((m) => m.type === "welcome", 5000, "welcome A");
  const wb = await b.waitFor((m) => m.type === "welcome", 5000, "welcome B");
  check(wa.playerId && wb.playerId && wa.playerId !== wb.playerId, "welcome assigns distinct playerIds");
  check(wa.serverVersion === "1.3.0", `welcome serverVersion is 1.3.0 (got ${wa.serverVersion})`);

  // ping/pong
  a.send({ type: "ping", t: 123 });
  const pong = await a.waitFor((m) => m.type === "pong" && m.t === 123, 5000, "pong");
  check(!!pong, "ping → pong");

  // 2. A creates a room, B joins with the code
  a.send({ type: "createRoom", mode: "race", gridSize: 12, durationSec: 180 });
  const created = await a.waitFor((m) => m.type === "roomCreated", 5000, "roomCreated");
  check(/^[A-Z0-9]{6}$/.test(created.roomCode), `room code is 6 chars (got ${created.roomCode})`);
  check(!!created.token, "roomCreated carries a reconnect token");
  b.send({ type: "joinRoom", roomCode: created.roomCode });
  const joined = await b.waitFor((m) => m.type === "roomJoined", 5000, "roomJoined");
  check(joined.players.length === 2, "roomJoined lists 2 players");

  // 3. Both ready, host starts
  a.send({ type: "ready", ready: true });
  b.send({ type: "ready", ready: true });
  await sleep(300);
  a.send({ type: "start" });
  const cd = await a.waitFor((m) => m.type === "countdown", 5000, "countdown");
  check(cd.seconds === 3, "countdown seconds=3");
  const ms = await a.waitFor((m) => m.type === "matchStart", 8000, "matchStart");
  check(ms.snapshot.status === "playing", "matchStart snapshot is playing");
  check(ms.snapshot.players.length === 2, "matchStart snapshot has 2 players");
  const p1 = ms.snapshot.players.find((p) => p.id === wa.playerId);
  check(p1 && p1.row === 11 && p1.col === 6, "P1 starts bottom centre (11,6)");
  check(p1 && p1.blockadesLeft === 10, `matchStart: P1 has 10 blockadesLeft (got ${p1 && p1.blockadesLeft})`);
  // Turn-based matchStart: turn 1, P1 active, 30 s deadline.
  check(ms.snapshot.activePlayerId === wa.playerId, "matchStart: turn 1 belongs to P1 (blue)");
  check(ms.snapshot.turnNumber === 1, "matchStart: turnNumber is 1");
  check(
    ms.snapshot.turnDeadlineMs > Date.now() && ms.snapshot.turnDeadlineMs <= Date.now() + 30000,
    `matchStart: turnDeadlineMs is now+30s (got ${ms.snapshot.turnDeadlineMs}, now ${Date.now()})`,
  );

  // 4. Turn 1 — P1 places a valid blockade (off P1's path). Turn passes to P2.
  let seqA = 0;
  let seqB = 0;
  await sendAndSettle(a, { type: "input", seq: ++seqA, kind: "place", edge: { row: 5, col: 9, orientation: "h", len: 2 } });
  const blockadeDelta = await b.waitFor(
    (m) => m.type === "delta" && m.events.some((e) => e.k === "blockade"),
    5000,
    "blockade delta",
  );
  check(!!blockadeDelta, "valid placement accepted (blockade delta broadcast)");
  const turnDelta = await b.waitFor(
    (m) => m.type === "delta" && m.events.some((e) => e.k === "turn" && e.activePlayerId === wb.playerId && e.turnNumber === 2),
    5000,
    "turn delta to P2",
  );
  check(!!turnDelta, "placement passed the turn: turn delta {activePlayerId: P2, turnNumber: 2}");

  // 5. Out of turn: P1 tries to move while it is P2's turn → NOT_YOUR_TURN.
  a.send({ type: "input", seq: ++seqA, kind: "move", dir: "up" });
  const oot = await a.waitFor((m) => m.type === "error" && m.code === "NOT_YOUR_TURN", 5000, "NOT_YOUR_TURN error");
  check(oot.code === "NOT_YOUR_TURN", `out-of-turn move rejected with NOT_YOUR_TURN (got ${oot.code})`);

  // 6. Turn 2 — P2 places on the same edge again → INVALID_BLOCKADE, and
  // the turn does NOT pass (the next turn delta is still turn 3 after P2's
  // next valid action, not turn 3 already).
  await sendAndSettle(b, { type: "input", seq: ++seqB, kind: "place", edge: { row: 5, col: 9, orientation: "h", len: 2 } });
  const err = await b.waitFor((m) => m.type === "error" && m.code === "INVALID_BLOCKADE", 5000, "illegal placement error");
  check(err.code === "INVALID_BLOCKADE", `illegal overlap rejected with INVALID_BLOCKADE (got ${err.code})`);

  // 7. Cap drive (real game): P1 places 9 more blockades — 10 total
  // including turn 1 — on vertical edges at row 5 that never block either
  // orb's walk, then the 11th placement is rejected NO_BLOCKADES and the
  // turn does NOT pass. Energy per round-trip: a len-1 place costs 20,
  // +10 comes back at the start of the next own turn, so places 2..9 run
  // energy 90 -> 0; turn 19 recharges with a wiggle (10), turn 21 places
  // the 10th (20 -> 0), turn 23 recharges again (20), and the 11th
  // attempt on turn 25 is rejected by the cap, not by energy.
  let p2col = 6;
  const p2wiggle = async () => {
    const dir = p2col === 6 ? "left" : "right";
    p2col += dir === "left" ? -1 : 1;
    await sendAndSettle(b, { type: "input", seq: ++seqB, kind: "move", dir });
  };
  const p1move = async (dir) => {
    await sendAndSettle(a, { type: "input", seq: ++seqA, kind: "move", dir });
  };
  await p2wiggle(); // P2's turn 2 action (valid) → turn 3, P1
  const turn3 = await a.waitFor(
    (m) => m.type === "delta" && m.events.some((e) => e.k === "turn" && e.turnNumber === 3),
    5000,
    "turn 3 delta",
  );
  check(!!turn3, "rejected placement did not pass the turn (turn 3 only after P2's valid move)");
  let p1col = 6;
  const p1wiggle = async () => {
    const dir = p1col === 6 ? "left" : "right";
    p1col += dir === "left" ? -1 : 1;
    await sendAndSettle(a, { type: "input", seq: ++seqA, kind: "move", dir });
  };
  const capEdges = [2, 3, 4, 5, 6, 7, 8, 9, 10].map((col) => ({ row: 5, col, orientation: "v", len: 1 }));
  for (let i = 0; i < 8; i++) {
    await sendAndSettle(a, { type: "input", seq: ++seqA, kind: "place", edge: capEdges[i] });
    await p2wiggle();
  }
  await p1wiggle(); // turn 19: recharge (energy 10)
  await p2wiggle();
  await sendAndSettle(a, { type: "input", seq: ++seqA, kind: "place", edge: capEdges[8] }); // 10th, turn 21
  await p2wiggle();
  await p1wiggle(); // turn 23: recharge (energy 20)
  await p2wiggle();
  a.send({ type: "input", seq: ++seqA, kind: "place", edge: { row: 5, col: 11, orientation: "v", len: 1 } });
  const capErr = await a.waitFor((m) => m.type === "error" && m.code === "NO_BLOCKADES", 5000, "NO_BLOCKADES error");
  check(capErr.code === "NO_BLOCKADES", `11th blockade rejected with NO_BLOCKADES (got ${capErr.code})`);
  // A periodic state snapshot confirms the wire field: 0 blockades left.
  const cappedState = await a.waitFor(
    (m) => m.type === "state" && m.snapshot.players.find((p) => p.id === wa.playerId)?.blockadesLeft === 0,
    5000,
    "state with blockadesLeft 0",
  );
  check(!!cappedState, "snapshot reports blockadesLeft 0 for P1 after 10 placements");

  // 8. Alternating turns: P1 walks to the goal row while P2 wiggles
  // left/right on the top row (never reaching its own goal).
  // P1: up x10 → (1,6), right → (1,7), up → (0,7) goal. P2: wiggle.
  for (let i = 0; i < 10; i++) {
    await p1move("up");
    await p2wiggle();
  }
  await p1move("right");
  await p2wiggle();
  await p1move("up"); // P1 reaches (0,7) — goal
  const result = await a.waitFor((m) => m.type === "result", 15000, "result");
  check(result.winnerId === wa.playerId, `result winner is P1 (got ${result.winnerId})`);
  check(result.reason === "goal", `result reason is goal (got ${result.reason})`);
  check(!("scores" in result), "result carries no scores field (protocol 1.3.0)");
  check(result.stats[wa.playerId].blockades === 10, `winner placed 10 blockades (got ${result.stats[wa.playerId].blockades})`);
  check(result.stats[wa.playerId].moves === 14, `winner made 14 moves (2 wiggles + 12 to the goal, got ${result.stats[wa.playerId].moves})`);
  check(
    typeof result.durationMs === "number" && result.durationMs > 0,
    `result durationMs is a positive number (got ${result.durationMs})`,
  );

  // 9. Smoothness: gaps between delta/state broadcasts received during play.
  const play = a.log.filter((e) => (e.msg.type === "delta" || e.msg.type === "state") && e.at >= t0);
  const gaps = [];
  for (let i = 1; i < play.length; i++) gaps.push(play[i].at - play[i - 1].at);
  const meanGap = gaps.length ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
  const maxGap = gaps.length ? Math.max(...gaps) : 0;
  const stalls = gaps.filter((g) => g > 250).length;
  check(play.length >= 20, `received ${play.length} delta/state broadcasts during play (>= 20)`);
  check(maxGap <= 250, `no broadcast stall: max inter-broadcast gap ${maxGap}ms (mean ${meanGap.toFixed(1)}ms, ${stalls} gaps > 250ms)`);

  // Server-side tick timing (processing time per tick, not wall interval).
  const stats = await (await fetch(`${HTTP}/stats`)).json();
  check(stats.matches === baseline.matches, `no active matches left after result (was ${baseline.matches})`);
  check(stats.results === baseline.results + 1, `${baseline.results + 1} result(s) stored in memory (was ${baseline.results})`);
  const tick = stats.tick ?? {};
  notes.push(`  info: server tick stats: ${tick.ticks ?? 0} ticks, avg ${(tick.avgMs ?? 0).toFixed(2)}ms, max ${(tick.maxMs ?? 0).toFixed(2)}ms`);
  check((tick.maxMs ?? 999) < 50, `server tick processing max ${(tick.maxMs ?? 0).toFixed(2)}ms < 50ms budget`);

  const health = await (await fetch(`${HTTP}/health`)).json();
  check(health.status === "ok", "GET /health returns ok");
  check(health.protocol === "1.3.0", `GET /health protocol is 1.3.0 (got ${health.protocol})`);
  check(health.version === "1.3.0", `GET /health version is 1.3.0 (got ${health.version})`);

  a.close();
  b.close();
  await sleep(200);

  console.log("BLOCKADE ARENA smoke test — turn-based 1v1 scripted match (protocol 1.3.0)");
  console.log(notes.join("\n"));
  console.log(`broadcast gaps during play: n=${gaps.length} mean=${meanGap.toFixed(1)}ms max=${maxGap}ms stalls(>250ms)=${stalls}`);
  console.log(`total time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (failures.length > 0) {
    console.log(`FAIL (${failures.length}):`);
    for (const f of failures) console.log(`  FAIL: ${f}`);
    process.exit(1);
  }
  console.log("SMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("SMOKE TEST ERROR:", err.message);
  process.exit(1);
});
