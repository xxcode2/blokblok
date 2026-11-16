import test from "node:test";
import assert from "node:assert/strict";
import { GameEngine } from "../engine.js";
import { chooseAiAction } from "../ai.js";

function twoPlayer(n = 12): GameEngine {
  const e = new GameEngine({ gridSize: n, durationSec: 180 });
  e.addPlayer("p1", "One");
  e.addPlayer("p2", "Two");
  return e;
}

test("spawns: P1 bottom centre, P2 top centre; goals opposite", () => {
  const e = twoPlayer();
  const s = e.snapshot();
  assert.equal(s.players[0].row, 11);
  assert.equal(s.players[0].col, 6);
  assert.equal(s.players[1].row, 0);
  assert.equal(s.players[1].col, 6);
  assert.equal(e.goalRow(e.getPlayer("p1")!), 0);
  assert.equal(e.goalRow(e.getPlayer("p2")!), 11);
});

test("move: one cell, cooldown, blocked by grid edge", () => {
  const e = twoPlayer();
  assert.equal(e.move("p1", "up").ok, true);
  assert.equal(e.getPlayer("p1")!.row, 10);
  // cooldown: second move immediately rejected
  assert.equal(e.move("p1", "up").ok, false);
  e.tickMs(200);
  assert.equal(e.move("p1", "up").ok, true);
  // P2 at top row cannot move up
  assert.deepEqual(e.move("p2", "up"), { ok: false, code: "INVALID_MOVE", message: "move leaves the grid" });
});

test("move onto opponent cell is illegal", () => {
  const e = new GameEngine({ gridSize: 12 });
  e.addPlayer("p1", "One");
  e.addPlayer("p2", "Two");
  // Walk P1 up to row 1, P2 stays at row 0 col 6: P1 at (1,6) moving up hits P2.
  for (let i = 0; i < 10; i++) {
    e.tickMs(200);
    assert.equal(e.move("p1", "up").ok, true);
  }
  e.tickMs(200);
  const r = e.move("p1", "up");
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "INVALID_MOVE");
});

test("reaching the goal row wins immediately", () => {
  const e = twoPlayer();
  // Walk up 10 to row 1, sidestep (P2 spawns on (0,6)), then up into (0,5).
  for (let i = 0; i < 10; i++) {
    e.tickMs(200);
    assert.equal(e.move("p1", "up").ok, true);
  }
  e.tickMs(200);
  assert.equal(e.move("p1", "left").ok, true);
  e.tickMs(200);
  assert.equal(e.move("p1", "up").ok, true);
  const s = e.snapshot();
  assert.equal(s.status, "finished");
  assert.equal(s.winnerId, "p1");
  assert.equal(s.players[0].score, 100 + 2 * Math.floor(s.timeLeftMs / 1000));
});

test("blockade blocks crossing and costs energy", () => {
  const e = twoPlayer();
  // Horizontal wall directly above P1: h-edge (11,6) len 1.
  const r = e.place("p1", { row: 11, col: 6, orientation: "h", len: 1 });
  assert.equal(r.ok, true);
  assert.equal(e.getPlayer("p1")!.energy, 80);
  e.tickMs(600);
  assert.equal(e.move("p1", "up").ok, false);
  assert.equal(e.move("p1", "left").ok, true);
});

test("overlapping blockade is rejected", () => {
  const e = twoPlayer();
  assert.equal(e.place("p1", { row: 11, col: 6, orientation: "h", len: 2 }).ok, true);
  e.tickMs(600);
  const r = e.place("p2", { row: 11, col: 7, orientation: "h", len: 1 });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "INVALID_BLOCKADE");
});

test("BFS fairness: a wall that seals a player in is rejected", () => {
  const e = new GameEngine({ gridSize: 12 });
  e.addPlayer("p1", "One");
  e.addPlayer("p2", "Two");
  // Box P2 (0,6) in: left v-edge (0,6), right v-edge (0,7), bottom h-edge (1,6).
  // Place two of the three, then the third must be rejected with NO_PATH.
  assert.equal(e.place("p1", { row: 0, col: 6, orientation: "v", len: 1 }).ok, true);
  e.tickMs(600);
  assert.equal(e.place("p1", { row: 0, col: 7, orientation: "v", len: 1 }).ok, true);
  e.tickMs(600);
  const r = e.place("p1", { row: 1, col: 6, orientation: "h", len: 1 });
  assert.equal(r.ok, false);
  assert.equal((r as { code: string }).code, "NO_PATH");
  // Energy was not spent on the rejected placement (100 - 20 - 20 + 6 regen).
  assert.equal(e.getPlayer("p1")!.energy, 66);
});

test("energy: len 3 costs 35; regen 5/s; insufficient energy rejected", () => {
  const e = twoPlayer();
  assert.equal(e.place("p1", { row: 6, col: 0, orientation: "h", len: 3 }).ok, true);
  assert.equal(e.getPlayer("p1")!.energy, 65);
  e.tickMs(1000);
  assert.ok(Math.abs(e.getPlayer("p1")!.energy - 70) < 0.01);
  // Drain with len-4 walls (35 each), ticking 600ms between placements
  // so the cooldown is always clear and only the energy check can fire.
  e.tickMs(600);
  assert.equal(e.place("p1", { row: 7, col: 0, orientation: "h", len: 4 }).ok, true); // 73-35=38
  e.tickMs(600);
  assert.equal(e.place("p1", { row: 8, col: 0, orientation: "h", len: 4 }).ok, true); // 41-35=6
  e.tickMs(600); // 9 energy, cooldown clear
  assert.ok(e.getPlayer("p1")!.energy < 20);
  const r = e.place("p1", { row: 9, col: 0, orientation: "h", len: 1 });
  assert.equal((r as { code: string }).code, "NO_ENERGY");
});

test("place cooldown enforced; max 10 blockades per player", () => {
  const e = twoPlayer();
  assert.equal(e.place("p1", { row: 6, col: 0, orientation: "h", len: 1 }).ok, true);
  const r = e.place("p1", { row: 6, col: 2, orientation: "h", len: 1 });
  assert.equal((r as { code: string }).code, "ON_COOLDOWN");
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
  e.tickMs(600);
  assert.equal(e.move("p1", "up").ok, false);
});

test("timeout: closer player wins; equal distance draws", () => {
  const e = new GameEngine({ gridSize: 12, durationSec: 1 });
  e.addPlayer("p1", "One");
  e.addPlayer("p2", "Two");
  e.tickMs(200);
  e.move("p1", "up"); // P1 one row closer
  e.tickMs(1000);
  const s = e.snapshot();
  assert.equal(s.status, "finished");
  assert.equal(s.winnerId, "p1");
});

test("fromSnapshot round-trips state for client-side previews", () => {
  const e = twoPlayer();
  e.place("p1", { row: 11, col: 6, orientation: "h", len: 1 });
  const copy = GameEngine.fromSnapshot(e.snapshot());
  assert.equal(copy.isMoveBlocked(11, 6, "up"), true);
  assert.equal(copy.validatePlace("p2", { row: 11, col: 6, orientation: "h", len: 1 }), "INVALID_BLOCKADE");
  assert.equal(copy.validatePlace("p2", { row: 5, col: 5, orientation: "h", len: 1 }), null);
});

test("AI returns only legal actions on every difficulty", () => {
  for (const diff of ["easy", "normal", "hard"] as const) {
    const e = twoPlayer();
    for (let i = 0; i < 30; i++) {
      e.tickMs(600);
      const a = chooseAiAction(e, "p2", diff);
      assert.ok(a !== null, `${diff} returned null with legal options`);
      if (a!.kind === "move") {
        assert.ok(e.legalMoves("p2").includes(a!.dir), `${diff} chose illegal move ${a!.dir}`);
        e.move("p2", a!.dir);
      } else {
        assert.equal(e.validatePlace("p2", a!.edge), null, `${diff} chose invalid placement`);
        e.place("p2", a!.edge);
      }
      if (e.snapshot().status === "finished") break;
    }
  }
});

test("AI can win a game against a stationary opponent (hard)", () => {
  const e = twoPlayer();
  let guard = 0;
  while (e.snapshot().status !== "finished" && guard++ < 400) {
    e.tickMs(600);
    const a = chooseAiAction(e, "p2", "hard");
    if (!a) break;
    if (a.kind === "move") e.move("p2", a.dir);
    else e.place("p2", a.edge);
  }
  assert.equal(e.snapshot().winnerId, "p2");
});
