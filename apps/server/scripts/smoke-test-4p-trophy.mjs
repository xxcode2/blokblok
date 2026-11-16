// BLOCKADE ARENA — 4-player trophy smoke test (scripted match over raw WebSockets).
// Protocol 1.3.0: trophy mode, 4 players, trophy on the centre cell (6,6 on
// a 12x12 grid); first orb to step onto it wins (reason "trophy"). Turns
// rotate P1→P2→P3→P4→P1, one action per turn, 30 s per turn. No points:
// the result is win/lose/draw only (winnerId + reason + stats +
// durationMs). Blockade cap: 10 per player per match (NO_BLOCKADES).
// Run with the server already up:  npm start --workspace=@blockade/server
// then:                                node apps/server/scripts/smoke-test-4p-trophy.mjs
// Expects: hello → createRoom (trophy, playerCount 4) → 3x joinRoom → ready
// → start → countdown → matchStart (mode trophy, playerCount 4, trophy
// (6,6), 4 spawns, turn 1 P1, 10 blockadesLeft) → P2 out-of-turn move
// rejected NOT_YOUR_TURN → P1 places 10 blockades (recharging with idle
// wiggles when energy runs short) → 11th placement rejected NO_BLOCKADES
// → alternating turns: P1 walks up column 6 to the trophy while P2/P3/P4
// wiggle → result with P1 as winner, reason "trophy", stats blockades 10.
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
  const names = ["Alice", "Bob", "Carol", "Dave"];
  const clients = names.map((n) => makeClient(n));
  await Promise.all(clients.map((c) => new Promise((r) => c.ws.on("open", r))));

  // 1. hello → welcome (all four)
  clients.forEach((c, i) => c.send({ type: "hello", name: names[i], clientVersion: "smoke-4p-1" }));
  const welcomes = await Promise.all(
    clients.map((c) => c.waitFor((m) => m.type === "welcome", 5000, "welcome")),
  );
  const ids = welcomes.map((w) => w.playerId);
  check(new Set(ids).size === 4, "welcome assigns 4 distinct playerIds");
  check(welcomes.every((w) => w.serverVersion === "1.3.0"), `welcome serverVersion is 1.3.0 (got ${welcomes[0].serverVersion})`);

  // 2. A creates a 4P trophy room, B/C/D join with the code
  const [a, b, c, d] = clients;
  a.send({ type: "createRoom", mode: "trophy", gridSize: 12, durationSec: 180, playerCount: 4 });
  const created = await a.waitFor((m) => m.type === "roomCreated", 5000, "roomCreated");
  check(/^[A-Z0-9]{6}$/.test(created.roomCode), `room code is 6 chars (got ${created.roomCode})`);
  check(!!created.token, "roomCreated carries a reconnect token");
  for (const client of [b, c, d]) {
    client.send({ type: "joinRoom", roomCode: created.roomCode });
  }
  const joined = await d.waitFor((m) => m.type === "roomJoined", 5000, "roomJoined");
  check(joined.mode === "trophy", `roomJoined mode is trophy (got ${joined.mode})`);
  check(joined.playerCount === 4, `roomJoined playerCount is 4 (got ${joined.playerCount})`);
  check(joined.players.length === 4, "roomJoined lists 4 players");
  // A 5th player cannot join a full 4P room.
  const e = makeClient("Eve(5th)");
  await new Promise((r) => e.ws.on("open", r));
  e.send({ type: "hello", name: "Eve", clientVersion: "smoke-4p-1" });
  await e.waitFor((m) => m.type === "welcome", 5000, "welcome E");
  e.send({ type: "joinRoom", roomCode: created.roomCode });
  const full = await e.waitFor((m) => m.type === "error" && m.code === "ROOM_FULL", 5000, "ROOM_FULL");
  check(full.code === "ROOM_FULL", `5th join rejected with ROOM_FULL (got ${full.code})`);
  e.close();

  // 3. All four ready, host starts
  for (const client of clients) client.send({ type: "ready", ready: true });
  await sleep(300);
  a.send({ type: "start" });
  const cd = await a.waitFor((m) => m.type === "countdown", 5000, "countdown");
  check(cd.seconds === 3, "countdown seconds=3");
  const ms = await a.waitFor((m) => m.type === "matchStart", 8000, "matchStart");
  check(ms.snapshot.status === "playing", "matchStart snapshot is playing");
  check(ms.snapshot.mode === "trophy", `matchStart snapshot mode is trophy (got ${ms.snapshot.mode})`);
  check(ms.snapshot.playerCount === 4, `matchStart snapshot playerCount is 4 (got ${ms.snapshot.playerCount})`);
  check(
    ms.snapshot.trophy && ms.snapshot.trophy.row === 6 && ms.snapshot.trophy.col === 6,
    `matchStart snapshot trophy is (6,6) (got ${JSON.stringify(ms.snapshot.trophy)})`,
  );
  check(ms.snapshot.players.length === 4, "matchStart snapshot has 4 players");
  const byId = new Map(ms.snapshot.players.map((p) => [p.id, p]));
  check(byId.get(ids[0]).row === 11 && byId.get(ids[0]).col === 6, "P1 starts bottom centre (11,6)");
  check(byId.get(ids[1]).row === 0 && byId.get(ids[1]).col === 6, "P2 starts top centre (0,6)");
  check(byId.get(ids[2]).row === 6 && byId.get(ids[2]).col === 0, "P3 starts left centre (6,0)");
  check(byId.get(ids[3]).row === 6 && byId.get(ids[3]).col === 11, "P4 starts right centre (6,11)");
  check(
    JSON.stringify(ms.snapshot.players.map((p) => p.color)) === JSON.stringify(["blue", "red", "green", "amber"]),
    `player colours are blue/red/green/amber (got ${ms.snapshot.players.map((p) => p.color).join("/")})`,
  );
  check(ms.snapshot.activePlayerId === ids[0], "matchStart: turn 1 belongs to P1 (blue)");
  check(ms.snapshot.turnNumber === 1, "matchStart: turnNumber is 1");
  check(
    ms.snapshot.players.every((p) => p.blockadesLeft === 10),
    `matchStart: every player has 10 blockadesLeft (got ${ms.snapshot.players.map((p) => p.blockadesLeft).join("/")})`,
  );
  check(
    ms.snapshot.turnDeadlineMs > Date.now() && ms.snapshot.turnDeadlineMs <= Date.now() + 30000,
    `matchStart: turnDeadlineMs is now+30s (got ${ms.snapshot.turnDeadlineMs}, now ${Date.now()})`,
  );

  // 4. Out of turn: P2 tries to move while it is P1's turn → NOT_YOUR_TURN.
  const seqs = [0, 0, 0, 0];
  b.send({ type: "input", seq: ++seqs[1], kind: "move", dir: "down" });
  const oot = await b.waitFor((m) => m.type === "error" && m.code === "NOT_YOUR_TURN", 5000, "NOT_YOUR_TURN error");
  check(oot.code === "NOT_YOUR_TURN", `out-of-turn move rejected with NOT_YOUR_TURN (got ${oot.code})`);

  // 5. Cap drive (real game): P1 places 10 blockades on vertical edges at
  // row 5 that never block any orb's walk, then the 11th placement is
  // rejected NO_BLOCKADES and the turn does NOT pass. Energy per P1 turn:
  // +10 at the turn start, −20 per len-1 place, so places 1..9 run energy
  // 100 -> 0 (P1 turns 1, 5, …, 33); a recharge wiggle on turn 37 brings
  // 20 for the 10th place (turn 41), and another recharge wiggle on turn
  // 45 brings 20 so the 11th attempt (turn 49) is rejected by the cap,
  // not by energy. P2/P3/P4 wiggle on their turns; after each full round
  // the turn is back on P1, turnNumber +4.
  const wiggle = [6, 6, 0, 11]; // current col per player
  const act = async (i, dir) => {
    await sendAndSettle(clients[i], { type: "input", seq: ++seqs[i], kind: "move", dir });
  };
  const wiggleAct = async (i) => {
    // P1 (bottom row): cols 6↔5; P2 (top row): cols 6↔7;
    // P3 (left): cols 0↔1; P4 (right): cols 11↔10.
    let dir;
    if (i === 0) {
      dir = wiggle[0] === 6 ? "left" : "right";
      wiggle[0] += dir === "left" ? -1 : 1;
    } else if (i === 1) {
      dir = wiggle[1] === 6 ? "right" : "left";
      wiggle[1] += dir === "right" ? 1 : -1;
    } else if (i === 2) {
      dir = wiggle[2] === 0 ? "right" : "left";
      wiggle[2] += dir === "right" ? 1 : -1;
    } else {
      dir = wiggle[3] === 11 ? "left" : "right";
      wiggle[3] += dir === "left" ? -1 : 1;
    }
    await act(i, dir);
  };
  let turnNumber = 1;
  // One full round: P1 acts, then P2/P3/P4 take their turns in order.
  const round = async (p1action) => {
    await p1action();
    turnNumber++;
    await wiggleAct(1);
    turnNumber++;
    await wiggleAct(2);
    turnNumber++;
    await wiggleAct(3);
    turnNumber++;
    const turnDelta = await a.waitFor(
      (m) => m.type === "delta" && m.events.some((e) => e.k === "turn" && e.activePlayerId === ids[0] && e.turnNumber === turnNumber),
      5000,
      `turn ${turnNumber} delta back to P1`,
    );
    check(!!turnDelta, `turn rotation returned to P1 at turn ${turnNumber}`);
  };
  const p1place = (edge) => async () => {
    await sendAndSettle(a, { type: "input", seq: ++seqs[0], kind: "place", edge });
  };
  const capEdges = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((col) => ({ row: 5, col, orientation: "v", len: 1 }));
  for (let i = 0; i < 9; i++) await round(p1place(capEdges[i])); // places 1..9, P1 turns 1..33
  await round(() => wiggleAct(0)); // recharge, P1 turn 37
  await round(p1place(capEdges[9])); // 10th blockade, P1 turn 41
  await round(() => wiggleAct(0)); // recharge, P1 turn 45
  // 11th placement on P1 turn 49: rejected NO_BLOCKADES, turn does NOT pass.
  a.send({ type: "input", seq: ++seqs[0], kind: "place", edge: { row: 5, col: 1, orientation: "v", len: 1 } });
  const capErr = await a.waitFor((m) => m.type === "error" && m.code === "NO_BLOCKADES", 5000, "NO_BLOCKADES error");
  check(capErr.code === "NO_BLOCKADES", `11th blockade rejected with NO_BLOCKADES (got ${capErr.code})`);
  // A periodic state snapshot confirms the wire field: 0 blockades left.
  const cappedState = await a.waitFor(
    (m) => m.type === "state" && m.snapshot.players.find((p) => p.id === ids[0])?.blockadesLeft === 0,
    5000,
    "state with blockadesLeft 0",
  );
  check(!!cappedState, "snapshot reports blockadesLeft 0 for P1 after 10 placements");

  // 6. P1 walks up column 6 to the trophy (5 moves); P2 wiggles on the
  // top row, P3 on the left edge, P4 on the right edge.
  // Turn order P1→P2→P3→P4→P1… — P1 acts on turns 49, 53, 57, 61, 65.
  for (let step = 0; step < 5; step++) {
    await act(0, "up"); // P1's move
    turnNumber++;
    if (step === 4) break; // P1 just stepped onto the trophy — match over
    // The other three take their turns in order.
    await wiggleAct(1);
    turnNumber++;
    await wiggleAct(2);
    turnNumber++;
    await wiggleAct(3);
    turnNumber++;
    // Verify the rotation landed back on P1 for the next round.
    const turnDelta = await a.waitFor(
      (m) => m.type === "delta" && m.events.some((e) => e.k === "turn" && e.activePlayerId === ids[0] && e.turnNumber === turnNumber),
      5000,
      `turn ${turnNumber} delta back to P1`,
    );
    check(!!turnDelta, `turn rotation returned to P1 at turn ${turnNumber}`);
  }
  const result = await a.waitFor((m) => m.type === "result", 15000, "result");
  check(result.winnerId === ids[0], `result winner is P1 (got ${result.winnerId})`);
  check(result.reason === "trophy", `result reason is trophy (got ${result.reason})`);
  check(!("scores" in result), "result carries no scores field (protocol 1.3.0)");
  check(result.stats[ids[0]].blockades === 10, `winner placed 10 blockades (got ${result.stats[ids[0]].blockades})`);
  check(
    typeof result.durationMs === "number" && result.durationMs > 0,
    `result durationMs is a positive number (got ${result.durationMs})`,
  );

  // 7. No active matches left; health reports protocol 1.3.0.
  const stats = await (await fetch(`${HTTP}/stats`)).json();
  check(stats.matches === baseline.matches, `no active matches left after result (was ${baseline.matches})`);
  check(stats.results === baseline.results + 1, `${baseline.results + 1} result(s) stored in memory (was ${baseline.results})`);
  const health = await (await fetch(`${HTTP}/health`)).json();
  check(health.status === "ok", "GET /health returns ok");
  check(health.protocol === "1.3.0", `GET /health protocol is 1.3.0 (got ${health.protocol})`);
  check(health.version === "1.3.0", `GET /health version is 1.3.0 (got ${health.version})`);

  for (const client of clients) client.close();
  await sleep(200);

  console.log("BLOCKADE ARENA smoke test — 4-player trophy scripted match (protocol 1.3.0)");
  console.log(notes.join("\n"));
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
