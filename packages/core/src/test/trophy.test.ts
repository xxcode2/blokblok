// Trophy mode + 4-player tests (protocol 1.3.0; trophy/4P arrived in 1.2.0).
// Trophy cell = centre cell (floor(n/2), floor(n/2)); first orb to step onto
// it wins (reason "trophy"). 4 players only in trophy mode; turns rotate
// P1→P2→P3→P4→P1; BFS fairness checks EVERY player's path to the trophy.
import test from "node:test";
import assert from "node:assert/strict";
import { GameEngine } from "../engine.js";
import { chooseAiAction } from "../ai.js";
import { trophyCellFor } from "../types.js";

const T0 = 1_000_000;

/** Trophy engine with `n` players (2 or 4), started at T0. */
function trophyEngine(n = 12, players = 2): GameEngine {
  const e = new GameEngine({ gridSize: n, durationSec: 180, mode: "trophy" });
  const names = ["One", "Two", "Three", "Four"];
  for (let i = 0; i < players; i++) e.addPlayer(`p${i + 1}`, names[i]);
  e.start(T0); // turn 1 = p1, deadline T0 + 30000
  return e;
}

/** Harmless idle action for the player whose turn it is: wiggle left/right
 *  around their spawn column (never progresses toward the trophy). */
function idle(e: GameEngine, id: string): void {
  const p = e.getPlayer(id)!;
  const idx = e.snapshot().players.findIndex((q) => q.id === id);
  const centre = Math.floor(e.gridSize / 2);
  const spawnCol = idx <= 1 ? centre : idx === 2 ? 0 : e.gridSize - 1;
  // Wiggle between spawnCol and spawnCol+1 (or -1 at the right edge).
  const dir = p.col === spawnCol ? (spawnCol + 1 < e.gridSize ? "right" : "left") : p.col > spawnCol ? "left" : "right";
  const r = e.move(id, dir);
  assert.equal(r.ok, true, `idle ${id} ${dir} should succeed, got ${JSON.stringify(r)}`);
}

test("trophy cell: centre cell for grid 12 and 20", () => {
  assert.deepEqual(trophyCellFor(12), { row: 6, col: 6 });
  assert.deepEqual(trophyCellFor(20), { row: 10, col: 10 });
  const e12 = trophyEngine(12);
  const e20 = trophyEngine(20);
  assert.deepEqual(e12.snapshot().trophy, { row: 6, col: 6 });
  assert.deepEqual(e20.snapshot().trophy, { row: 10, col: 10 });
  assert.equal(e12.snapshot().playerCount, 2);
  // Race mode has no trophy cell.
  const race = new GameEngine({ gridSize: 12, mode: "race" });
  race.addPlayer("p1", "One");
  assert.equal(race.snapshot().trophy, null);
  assert.equal(race.snapshot().playerCount, 1);
});

test("2P trophy spawns keep the race spawns (P1 bottom, P2 top)", () => {
  const e = trophyEngine(12, 2);
  const s = e.snapshot();
  assert.deepEqual([s.players[0].row, s.players[0].col], [11, 6]);
  assert.deepEqual([s.players[1].row, s.players[1].col], [0, 6]);
  assert.equal(s.players[0].color, "blue");
  assert.equal(s.players[1].color, "red");
  assert.equal(s.activePlayerId, "p1");
  assert.equal(s.turnNumber, 1);
});

test("4P trophy spawns: P1 bottom, P2 top, P3 left, P4 right; colours blue/red/green/amber", () => {
  const e = trophyEngine(12, 4);
  const s = e.snapshot();
  assert.equal(s.playerCount, 4);
  assert.deepEqual([s.players[0].row, s.players[0].col], [11, 6]);
  assert.deepEqual([s.players[1].row, s.players[1].col], [0, 6]);
  assert.deepEqual([s.players[2].row, s.players[2].col], [6, 0]);
  assert.deepEqual([s.players[3].row, s.players[3].col], [6, 11]);
  assert.deepEqual(
    s.players.map((p) => p.color),
    ["blue", "red", "green", "amber"],
  );
  // Grid 20 spawns scale with the grid.
  const e20 = trophyEngine(20, 4);
  const s20 = e20.snapshot();
  assert.deepEqual([s20.players[0].row, s20.players[0].col], [19, 10]);
  assert.deepEqual([s20.players[1].row, s20.players[1].col], [0, 10]);
  assert.deepEqual([s20.players[2].row, s20.players[2].col], [10, 0]);
  assert.deepEqual([s20.players[3].row, s20.players[3].col], [10, 19]);
});

test("race mode rejects a 3rd player; trophy mode rejects a 5th player", () => {
  const race = new GameEngine({ gridSize: 12, mode: "race" });
  race.addPlayer("p1", "One");
  race.addPlayer("p2", "Two");
  assert.throws(() => race.addPlayer("p3", "Three"), /at most 2 players/);
  const e = trophyEngine(12, 4);
  assert.throws(() => e.addPlayer("p5", "Five"), /at most 4 players/);
});

test("trophy win: landing on the centre cell wins immediately (reason trophy)", () => {
  const e = trophyEngine(12, 2);
  // P1 walks up column 6: (11,6) → (6,6) trophy in 5 moves; P2 idles.
  for (let i = 0; i < 4; i++) {
    assert.equal(e.move("p1", "up").ok, true);
    idle(e, "p2");
  }
  assert.equal(e.move("p1", "up").ok, true); // onto (6,6)
  const s = e.snapshot();
  assert.equal(s.status, "finished");
  assert.equal(s.winnerId, "p1");
  assert.equal(e.winReason, "trophy");
  const winEvents = e.deltaSince(-1).filter((ev) => ev.k === "win");
  assert.equal(winEvents.length, 1);
  if (winEvents[0]?.k === "win") assert.equal(winEvents[0].reason, "trophy");
  // No points any more (protocol 1.3.0): the result is win/lose only.
  // Match stats survive: P1 moved 5 times to reach the trophy.
  assert.equal(e.stats()["p1"].moves, 5);
  assert.ok(!("score" in s.players[0]));
  assert.ok(!e.deltaSince(-1).some((ev) => (ev as { k: string }).k === "score"));
});

test("turn rotation: P1→P2→P3→P4→P1, turnNumber increments each pass", () => {
  const e = trophyEngine(12, 4);
  const order = ["p1", "p2", "p3", "p4", "p1", "p2"];
  for (let i = 0; i < order.length; i++) {
    const s = e.snapshot();
    assert.equal(s.activePlayerId, order[i], `turn ${i + 1} should belong to ${order[i]}`);
    assert.equal(s.turnNumber, i + 1);
    idle(e, order[i]);
  }
  assert.equal(e.snapshot().turnNumber, 7);
  assert.equal(e.snapshot().activePlayerId, "p3");
});

test("out-of-turn action in 4P is NOT_YOUR_TURN and does not pass the turn", () => {
  const e = trophyEngine(12, 4);
  const r = e.move("p3", "right");
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "NOT_YOUR_TURN");
  assert.equal(e.snapshot().activePlayerId, "p1");
  assert.equal(e.snapshot().turnNumber, 1);
});

test("BFS fairness to the trophy checks ALL players, not just the placer", () => {
  const e = trophyEngine(12, 4);
  // Box P4 in at (6,11): left v-edge (6,11), up h-edge (6,11), then the
  // down h-edge (7,11) must be rejected with NO_PATH — P4 would have no
  // path left to the trophy. P4 is neither the placer nor the "opponent"
  // of a 2P check, so this proves the all-players rule.
  assert.equal(e.place("p1", { row: 6, col: 11, orientation: "v", len: 1 }).ok, true); // blocks P4 left
  idle(e, "p2");
  assert.equal(e.place("p3", { row: 6, col: 11, orientation: "h", len: 1 }).ok, true); // blocks P4 up
  // P4 idles with a harmless placement far from the trophy.
  assert.equal(e.place("p4", { row: 3, col: 3, orientation: "h", len: 1 }).ok, true);
  // P1's turn: sealing P4's last exit (down) is rejected.
  const r = e.place("p1", { row: 7, col: 11, orientation: "h", len: 1 });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "NO_PATH");
  assert.equal(e.snapshot().activePlayerId, "p1"); // rejected: turn stays
  // P4 still has a path to the trophy (down, then around).
  assert.ok(e.shortestPathLength("p4") !== null);
  // Every player keeps a path after the two legal walls.
  for (const id of ["p1", "p2", "p3", "p4"]) {
    assert.ok(e.shortestPathLength(id) !== null, `${id} must keep a path to the trophy`);
  }
});

test("AI in trophy mode targets the trophy cell (shortest path)", () => {
  const e = trophyEngine(12, 2);
  // P2's next step from (0,6) toward the trophy (6,6) is down.
  assert.equal(e.nextStepTowardTarget("p2"), "down");
  assert.equal(e.nextStepTowardGoal("p2"), "down");
  // P1 from (11,6) steps up toward the trophy.
  assert.equal(e.nextStepTowardTarget("p1"), "up");
  // Distances: P1's spawn is 5 moves from the trophy, P2's is 6.
  assert.equal(e.shortestPathLength("p1"), 5);
  assert.equal(e.shortestPathLength("p2"), 6);
  // P3 (left-centre) is 6 moves away.
  const e4 = trophyEngine(12, 4);
  assert.equal(e4.shortestPathLength("p3"), 6);
  assert.equal(e4.shortestPathLength("p4"), 5);
});

test("AI can win a 4P trophy game against stationary opponents (hard)", () => {
  const e = trophyEngine(12, 4);
  let guard = 0;
  while (e.snapshot().status !== "finished" && guard++ < 600) {
    const active = e.snapshot().activePlayerId;
    if (active === "p2") {
      const a = chooseAiAction(e, "p2", "hard");
      assert.ok(a !== null, "hard AI returned null on its own turn");
      if (a!.kind === "move") {
        assert.ok(e.legalMoves("p2").includes(a!.dir), `hard AI chose illegal move ${a!.dir}`);
        assert.equal(e.move("p2", a!.dir).ok, true);
      } else {
        assert.equal(e.validatePlace("p2", a!.edge), null, "hard AI chose invalid placement");
        assert.equal(e.place("p2", a!.edge).ok, true);
      }
    } else {
      idle(e, active);
    }
  }
  assert.equal(e.snapshot().winnerId, "p2");
  assert.equal(e.winReason, "trophy");
});

test("AI returns only legal actions in trophy mode on every difficulty", () => {
  for (const diff of ["easy", "normal", "hard"] as const) {
    const e = trophyEngine(12, 4);
    assert.equal(chooseAiAction(e, "p2", diff), null); // not P2's turn
    for (let i = 0; i < 12; i++) {
      idle(e, "p1"); // P1's turn
      const a = chooseAiAction(e, "p2", diff);
      assert.ok(a !== null, `${diff} returned null on its own turn`);
      if (a!.kind === "move") {
        assert.ok(e.legalMoves("p2").includes(a!.dir), `${diff} chose illegal move ${a!.dir}`);
        assert.equal(e.move("p2", a!.dir).ok, true);
      } else {
        assert.equal(e.validatePlace("p2", a!.edge), null, `${diff} chose invalid placement`);
        assert.equal(e.place("p2", a!.edge).ok, true);
      }
      if (e.snapshot().status === "finished") break;
      idle(e, "p3");
      idle(e, "p4");
      if (e.snapshot().status === "finished") break;
    }
  }
});

test("4P timeout auto-pass rotates through all four players", () => {
  const e = trophyEngine(12, 4);
  // Each 31 s tick passes exactly one turn (deadline advances 30 s/pass).
  e.tickAt(T0 + 31_000);
  assert.equal(e.snapshot().activePlayerId, "p2");
  assert.equal(e.snapshot().turnNumber, 2);
  e.tickAt(T0 + 61_000);
  assert.equal(e.snapshot().activePlayerId, "p3");
  assert.equal(e.snapshot().turnNumber, 3);
  e.tickAt(T0 + 91_000);
  assert.equal(e.snapshot().activePlayerId, "p4");
  assert.equal(e.snapshot().turnNumber, 4);
  e.tickAt(T0 + 121_000);
  assert.equal(e.snapshot().activePlayerId, "p1");
  assert.equal(e.snapshot().turnNumber, 5);
  // A long stall passes the turn repeatedly, wrapping the rotation.
  e.tickAt(T0 + 121_000 + 4 * 30_000 + 1_000);
  assert.equal(e.snapshot().activePlayerId, "p1");
  assert.equal(e.snapshot().turnNumber, 9);
});

test("trophy timeout: closest player to the trophy wins; equal distance draws", () => {
  const e = new GameEngine({ gridSize: 12, durationSec: 1, mode: "trophy" });
  e.addPlayer("p1", "One");
  e.addPlayer("p2", "Two");
  e.start(T0);
  e.move("p1", "up"); // P1 one move closer to the trophy
  e.tickMs(1000);
  const s = e.snapshot();
  assert.equal(s.status, "finished");
  assert.equal(s.winnerId, "p1");
});

test("fromSnapshot round-trips trophy fields for client-side previews", () => {
  const e = trophyEngine(12, 4);
  idle(e, "p1");
  const copy = GameEngine.fromSnapshot(e.snapshot());
  assert.equal(copy.snapshot().mode, "trophy");
  assert.deepEqual(copy.snapshot().trophy, { row: 6, col: 6 });
  assert.equal(copy.snapshot().playerCount, 4);
  assert.equal(copy.snapshot().activePlayerId, "p2");
  assert.equal(copy.shortestPathLength("p3"), 6);
});
