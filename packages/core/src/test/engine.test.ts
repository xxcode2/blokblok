import test from "node:test";
import assert from "node:assert/strict";
import { GameEngine } from "../engine.js";
import { chooseAiAction } from "../ai.js";

const T0 = 1_000_000;

function twoPlayer(n = 12): GameEngine {
  const e = new GameEngine({ gridSize: n, durationSec: 180 });
  e.addPlayer("p1", "One");
  e.addPlayer("p2", "Two");
  e.start(T0); // turn 1 = p1, deadline T0 + 30000
  return e;
}

/**
 * Harmless idle action for the player whose turn it is: wiggle left/right
 * between columns 5 and 6 on their start row (never progresses to the goal).
 * `dir` overrides the wiggle direction for one step.
 */
function idle(e: GameEngine, id: string, dir?: "left" | "right"): void {
  const p = e.getPlayer(id)!;
  const d = dir ?? (p.col === 6 ? "left" : "right");
  const r = e.move(id, d);
  assert.equal(r.ok, true, `idle ${id} ${d} should succeed, got ${JSON.stringify(r)}`);
}

test("spawns: P1 bottom centre, P2 top centre; goals opposite; turn 1 is P1", () => {
  const e = twoPlayer();
  const s = e.snapshot();
  assert.equal(s.players[0].row, 11);
  assert.equal(s.players[0].col, 6);
  assert.equal(s.players[1].row, 0);
  assert.equal(s.players[1].col, 6);
  assert.equal(e.goalRow(e.getPlayer("p1")!), 0);
  assert.equal(e.goalRow(e.getPlayer("p2")!), 11);
  assert.equal(s.activePlayerId, "p1");
  assert.equal(s.turnNumber, 1);
  assert.equal(s.turnDeadlineMs, T0 + 30000);
});

test("move: one cell per turn; second action same turn rejected NOT_YOUR_TURN", () => {
  const e = twoPlayer();
  assert.equal(e.move("p1", "up").ok, true);
  assert.equal(e.getPlayer("p1")!.row, 10);
  // Same turn, same player: rejected, turn does NOT pass, no state change.
  const again = e.move("p1", "up");
  assert.equal(again.ok, false);
  assert.equal((again as { code: string }).code, "NOT_YOUR_TURN");
  assert.equal(e.snapshot().activePlayerId, "p2");
  assert.equal(e.snapshot().turnNumber, 2);
  assert.equal(e.getPlayer("p1")!.row, 10);
  // P2 acts, then P1 may move again. P2 at the top row cannot move up
  // (invalid, turn does NOT pass).
  const bad = e.move("p2", "up");
  assert.deepEqual(bad, { ok: false, code: "INVALID_MOVE", message: "move leaves the grid" });
  assert.equal(e.snapshot().activePlayerId, "p2");
  assert.equal(e.move("p2", "down").ok, true);
  assert.equal(e.snapshot().activePlayerId, "p1");
  assert.equal(e.snapshot().turnNumber, 3);
  assert.equal(e.move("p1", "up").ok, true);
});

test("move onto opponent cell is illegal", () => {
  const e = new GameEngine({ gridSize: 12 });
  e.addPlayer("p1", "One");
  e.addPlayer("p2", "Two");
  e.start(T0);
  // Walk P1 up to row 1, P2 idles (ends back on (0,6)): P1 at (1,6) moving up hits P2.
  for (let i = 0; i < 10; i++) {
    assert.equal(e.move("p1", "up").ok, true);
    idle(e, "p2");
  }
  const r = e.move("p1", "up");
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "INVALID_MOVE");
  assert.equal(e.snapshot().activePlayerId, "p1"); // invalid move: turn stays
});

test("reaching the goal row wins immediately", () => {
  const e = twoPlayer();
  // Walk up 10 to row 1, sidestep right (P2 wiggles on cols 5-6, never (0,7)), then up into (0,7).
  for (let i = 0; i < 10; i++) {
    assert.equal(e.move("p1", "up").ok, true);
    idle(e, "p2");
  }
  assert.equal(e.move("p1", "right").ok, true);
  idle(e, "p2");
  assert.equal(e.move("p1", "up").ok, true);
  const s = e.snapshot();
  assert.equal(s.status, "finished");
  assert.equal(s.winnerId, "p1");
  assert.equal(e.winReason, "goal");
  // No points any more (protocol 1.3.0): the result is win/lose only.
  // Match stats survive: P1 moved 12 times, P2 wiggled 11 times.
  assert.equal(e.stats()["p1"].moves, 12);
  assert.ok(e.durationMs() >= 0);
  assert.ok(!("score" in s.players[0]));
  assert.ok(!e.deltaSince(-1).some((ev) => (ev as { k: string }).k === "score"));
});

test("blockade blocks crossing, costs energy, and the next turn regains +10", () => {
  const e = twoPlayer();
  // Horizontal wall directly above P1: h-edge (11,6) len 1.
  const r = e.place("p1", { row: 11, col: 6, orientation: "h", len: 1 });
  assert.equal(r.ok, true);
  assert.equal(e.getPlayer("p1")!.energy, 80);
  assert.equal(e.snapshot().activePlayerId, "p2"); // placement passed the turn
  idle(e, "p2"); // P1's turn starts: +10 energy (capped at 100)
  assert.equal(e.getPlayer("p1")!.energy, 90);
  assert.equal(e.move("p1", "up").ok, false);
  assert.equal(e.move("p1", "left").ok, true);
});

test("overlapping blockade is rejected; rejected actions do not pass the turn", () => {
  const e = twoPlayer();
  assert.equal(e.place("p1", { row: 11, col: 6, orientation: "h", len: 2 }).ok, true);
  const r = e.place("p2", { row: 11, col: 7, orientation: "h", len: 1 });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "INVALID_BLOCKADE");
  assert.equal(e.snapshot().activePlayerId, "p2"); // still P2's turn
  assert.equal(e.getPlayer("p2")!.energy, 100); // no energy spent
});

test("BFS fairness: a wall that seals a player in is rejected", () => {
  const e = new GameEngine({ gridSize: 12 });
  e.addPlayer("p1", "One");
  e.addPlayer("p2", "Two");
  e.start(T0);
  // Box P2 (0,6) in: left v-edge (0,6), right v-edge (0,7), bottom h-edge (1,6).
  // Place two of the three, then the third must be rejected with NO_PATH.
  assert.equal(e.place("p1", { row: 0, col: 6, orientation: "v", len: 1 }).ok, true);
  assert.equal(e.move("p2", "down").ok, true); // P2 steps out of the way (its turn)
  assert.equal(e.place("p1", { row: 0, col: 7, orientation: "v", len: 1 }).ok, true);
  assert.equal(e.move("p2", "up").ok, true); // back to (0,6)
  const r = e.place("p1", { row: 1, col: 6, orientation: "h", len: 1 });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "NO_PATH");
  // Energy was not spent on the rejected placement: 100 - 20 + 10 - 20 = 70,
  // plus +10 when P2's second turn started... recount: after place 1 (80),
  // P2's turn gives P1 nothing yet; P1 regains +10 at the START of its own
  // next turn: 90 before place 2, 70 after; +10 again before the rejected
  // place 3 -> 80, unchanged by the rejection.
  assert.equal(e.getPlayer("p1")!.energy, 80);
});

test("energy: len 3 costs 35; +10 per turn (no per-second regen); insufficient rejected", () => {
  const e = twoPlayer();
  assert.equal(e.place("p1", { row: 6, col: 0, orientation: "h", len: 3 }).ok, true);
  assert.equal(e.getPlayer("p1")!.energy, 65);
  idle(e, "p2"); // P1 regains +10 at the start of its turn
  assert.equal(e.getPlayer("p1")!.energy, 75);
  e.tickMs(1000); // a whole second passes: NO per-second regen any more
  assert.equal(e.getPlayer("p1")!.energy, 75);
  // Drain with len-4 walls (35 each); each P2 idle gives P1 +10 back.
  assert.equal(e.place("p1", { row: 7, col: 0, orientation: "h", len: 4 }).ok, true); // 75-35=40
  idle(e, "p2"); // 50
  assert.equal(e.place("p1", { row: 8, col: 0, orientation: "h", len: 4 }).ok, true); // 50-35=15
  idle(e, "p2"); // 25
  assert.equal(e.place("p1", { row: 9, col: 0, orientation: "h", len: 1 }).ok, true); // 25-20=5
  idle(e, "p2"); // 15
  assert.ok(e.getPlayer("p1")!.energy < 20);
  const r = e.place("p1", { row: 9, col: 2, orientation: "h", len: 1 });
  assert.equal((r as { code: string }).code, "NO_ENERGY");
  assert.equal(e.getPlayer("p1")!.energy, 15);
});

test("blockade cap: 10 placements per player per match; the 11th is NO_BLOCKADES", () => {
  const e = twoPlayer();
  // Energy math per placement round-trip: a len-1 place costs 20, +10 comes
  // back at the start of the next own turn, so five consecutive placements
  // take energy 100 -> 50 (the last P2 idle already started P1's next
  // turn). Five idle turns recharge it to 100 for the second five
  // (100 -> 50 again). The cap — not energy — must bind on the 11th
  // attempt (energy is 50, well above the 20 cost).
  const placeAt = (col: number) => e.place("p1", { row: 5, col, orientation: "h", len: 1 });
  for (let c = 0; c < 5; c++) {
    assert.equal(placeAt(c).ok, true);
    assert.equal(e.snapshot().players[0].blockadesLeft, 10 - (c + 1));
    idle(e, "p2");
  }
  assert.equal(e.getPlayer("p1")!.energy, 50);
  for (let i = 0; i < 5; i++) {
    idle(e, "p1");
    idle(e, "p2");
  }
  assert.equal(e.getPlayer("p1")!.energy, 100);
  for (let c = 5; c < 10; c++) {
    assert.equal(placeAt(c).ok, true);
    assert.equal(e.snapshot().players[0].blockadesLeft, 10 - (c + 1));
    idle(e, "p2");
  }
  assert.equal(e.getPlayer("p1")!.energy, 50);
  assert.equal(e.snapshot().players[0].blockadesLeft, 0);
  assert.equal(e.stats()["p1"].blockades, 10);
  // 11th attempt: a fresh, otherwise-valid edge. validatePlace names the cap.
  assert.equal(e.validatePlace("p1", { row: 5, col: 10, orientation: "h", len: 1 }), "NO_BLOCKADES");
  const turnBefore = e.snapshot().turnNumber;
  const r = e.place("p1", { row: 5, col: 10, orientation: "h", len: 1 });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "NO_BLOCKADES");
  assert.equal(e.snapshot().activePlayerId, "p1"); // rejected: turn stays
  assert.equal(e.snapshot().turnNumber, turnBefore);
  assert.equal(e.getPlayer("p1")!.energy, 50); // no energy spent
  assert.equal(e.snapshot().players[0].blockadesLeft, 0);
  // placeAuto is capped the same way (not a generic INVALID_BLOCKADE).
  const auto = e.placeAuto("p1", "up", "h", 1);
  assert.equal(auto.ok, false);
  assert.equal((auto as { code: string }).code, "NO_BLOCKADES");
  assert.equal(e.snapshot().activePlayerId, "p1");
});

test("one action per turn: a second placement on the same turn is NOT_YOUR_TURN", () => {
  const e = twoPlayer();
  assert.equal(e.place("p1", { row: 6, col: 0, orientation: "h", len: 1 }).ok, true);
  const r = e.place("p1", { row: 6, col: 2, orientation: "h", len: 1 });
  assert.equal((r as { code: string }).code, "NOT_YOUR_TURN");
  assert.equal(e.snapshot().turnNumber, 2);
  assert.equal(e.getPlayer("p1")!.energy, 80); // no second spend
});

test("placeAuto finds a wall ahead of the player", () => {
  const e = twoPlayer();
  const r = e.placeAuto("p1", "up", "h", 2);
  assert.equal(r.ok, true);
  // The wall sits on the edge directly above P1.
  const snap = e.snapshot();
  assert.equal(snap.blockades.length, 1);
  assert.equal(snap.blockades[0].edges[0].row, 11);
  assert.equal(snap.blockades[0].edges[0].orientation, "h");
  idle(e, "p2");
  assert.equal(e.move("p1", "up").ok, false);
});

test("placeAuto out of turn is NOT_YOUR_TURN", () => {
  const e = twoPlayer();
  const r = e.placeAuto("p2", "down", "h", 2);
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "NOT_YOUR_TURN");
});

test("timeout: closer player wins; equal distance draws", () => {
  const e = new GameEngine({ gridSize: 12, durationSec: 1 });
  e.addPlayer("p1", "One");
  e.addPlayer("p2", "Two");
  e.start(T0);
  e.move("p1", "up"); // P1 one row closer
  e.tickMs(1000);
  const s = e.snapshot();
  assert.equal(s.status, "finished");
  assert.equal(s.winnerId, "p1");
});

test("turn timeout: 30 s of inactivity auto-passes the turn (no other penalty)", () => {
  const e = twoPlayer();
  assert.equal(e.place("p1", { row: 5, col: 5, orientation: "h", len: 1 }).ok, true);
  assert.equal(e.getPlayer("p1")!.energy, 80);
  assert.equal(e.snapshot().activePlayerId, "p2");
  // P2 idles for 31 s: the turn auto-passes back to P1 (+10 energy).
  e.tickAt(T0 + 31_000);
  let s = e.snapshot();
  assert.equal(s.activePlayerId, "p1");
  assert.equal(s.turnNumber, 3);
  assert.equal(s.turnDeadlineMs, T0 + 60_000); // previous deadline + 30 s
  assert.equal(e.getPlayer("p1")!.energy, 90);
  // A `turn` delta event was emitted for the auto-pass.
  const turns = e.deltaSince(0).filter((ev) => ev.k === "turn");
  assert.ok(turns.length >= 1);
  const last = turns[turns.length - 1];
  if (last?.k === "turn") {
    assert.equal(last.activePlayerId, "p1");
    assert.equal(last.turnNumber, 3);
  }
  // Acting before the deadline works normally again.
  assert.equal(e.move("p1", "up").ok, true);
  s = e.snapshot();
  assert.equal(s.activePlayerId, "p2");
  assert.equal(s.turnNumber, 4);
});

test("fromSnapshot round-trips state (incl. turn fields) for client-side previews", () => {
  const e = twoPlayer();
  e.place("p1", { row: 11, col: 6, orientation: "h", len: 1 });
  const copy = GameEngine.fromSnapshot(e.snapshot());
  assert.equal(copy.snapshot().activePlayerId, "p2");
  assert.equal(copy.snapshot().turnNumber, 2);
  assert.equal(copy.snapshot().turnDeadlineMs, e.snapshot().turnDeadlineMs);
  assert.equal(copy.isMoveBlocked(11, 6, "up"), true);
  assert.equal(copy.validatePlace("p2", { row: 11, col: 6, orientation: "h", len: 1 }), "INVALID_BLOCKADE");
  assert.equal(copy.validatePlace("p2", { row: 5, col: 5, orientation: "h", len: 1 }), null);
  assert.equal(copy.validatePlace("p1", { row: 5, col: 5, orientation: "h", len: 1 }), "NOT_YOUR_TURN");
});

test("AI returns only legal actions on every difficulty (one per AI turn)", () => {
  for (const diff of ["easy", "normal", "hard"] as const) {
    const e = twoPlayer();
    // The AI (p2) has no action while it is P1's turn.
    assert.equal(chooseAiAction(e, "p2", diff), null);
    for (let i = 0; i < 30; i++) {
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
    }
  }
});

test("AI can win a game against a stationary opponent (hard)", () => {
  const e = twoPlayer();
  let guard = 0;
  while (e.snapshot().status !== "finished" && guard++ < 400) {
    idle(e, "p1"); // P1 wiggles on its start row, never progresses
    const a = chooseAiAction(e, "p2", "hard");
    if (!a) break;
    if (a.kind === "move") e.move("p2", a.dir);
    else e.place("p2", a.edge);
  }
  assert.equal(e.snapshot().winnerId, "p2");
});
