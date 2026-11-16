// BLOCKADE ARENA — server smoke test (scripted 1v1 over raw WebSockets).
// Run with the server already up:  npm start --workspace=@blockade/server
// then:                                node apps/server/scripts/smoke-test.mjs
// Expects: hello → createRoom → joinRoom → ready → start → countdown →
// matchStart → valid place → illegal place (error) → P1 walks to the goal
// row → result with P1 as winner. Also measures tick smoothness: inter-arrival
// gaps of delta/state broadcasts during play, plus the server's own tick
// timing from GET /stats (avg/max tick processing time).
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

  // 4. B places a valid blockade (off P1's path), then the same edge again.
  let seqB = 0;
  b.send({ type: "input", seq: ++seqB, kind: "place", edge: { row: 5, col: 9, orientation: "h", len: 2 } });
  const blockadeDelta = await b.waitFor(
    (m) => m.type === "delta" && m.events.some((e) => e.k === "blockade"),
    5000,
    "blockade delta",
  );
  check(!!blockadeDelta, "valid placement accepted (blockade delta broadcast)");
  await sleep(700); // clear the 500ms place cooldown
  b.send({ type: "input", seq: ++seqB, kind: "place", edge: { row: 5, col: 9, orientation: "h", len: 2 } });
  const err = await b.waitFor((m) => m.type === "error", 5000, "illegal placement error");
  check(err.code === "INVALID_BLOCKADE", `illegal overlap rejected with INVALID_BLOCKADE (got ${err.code})`);

  // 5. Drive P1 to the goal row: up x10, left (sidestep P2 on (0,6)), up.
  let seqA = 0;
  const path = ["up", "up", "up", "up", "up", "up", "up", "up", "up", "up", "left", "up"];
  for (const dir of path) {
    a.send({ type: "input", seq: ++seqA, kind: "move", dir });
    await sleep(220); // > 150ms move cooldown
  }
  const result = await a.waitFor((m) => m.type === "result", 15000, "result");
  check(result.winnerId === wa.playerId, `result winner is P1 (got ${result.winnerId})`);
  check(result.reason === "goal", `result reason is goal (got ${result.reason})`);
  check(result.scores[wa.playerId] > 100, `winner score > 100 (got ${result.scores[wa.playerId]})`);
  check(result.scores[wb.playerId] === 0, "loser score is 0");

  // 6. Smoothness: gaps between delta/state broadcasts received during play.
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

  a.close();
  b.close();
  await sleep(200);

  console.log("BLOCKADE ARENA smoke test — 1v1 scripted match");
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
