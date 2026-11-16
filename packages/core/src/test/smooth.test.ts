// Turn-model + animation tests: one action per turn, NOT_YOUR_TURN,
// energy per turn, turn delta events, timeout auto-pass, tryMove/tryPlace/
// tryPlaceAuto result shapes, move/blockade animation state, collide/win
// delta events, drainDeltas/deltaSince, tick(nowMs).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEPLOY_MS, easeOutCubic, GameEngine, MOVE_ANIM_MS } from "../index.js";

const T0 = 1_000_000;

function makeEngine(gridSize = 12, durationSec = 180): GameEngine {
  const eng = new GameEngine({ gridSize, durationSec });
  eng.addPlayer("P1", "Blue");
  eng.addPlayer("P2", "Red");
  eng.start(T0); // turn 1 = P1, deadline T0 + 30000
  return eng;
}

function state(eng: GameEngine, id: string) {
  return eng.snapshot().players.find((p) => p.id === id)!;
}

/** Wiggle the active player left/right between cols 5 and 6 (harmless idle). */
function idle(eng: GameEngine, id: string): void {
  const p = eng.getPlayer(id)!;
  const dir = p.col === 6 ? "left" : "right";
  assert.equal(eng.move(id, dir).ok, true);
}

describe("turn model (tryMove / turn passing)", () => {
  it("one action per turn: a second action is rejected with NOT_YOUR_TURN", () => {
    const eng = makeEngine();
    assert.equal(eng.tryMove("P1", "up").ok, true);
    assert.deepEqual([state(eng, "P1").row, state(eng, "P1").col], [10, 6]);
    assert.equal(eng.snapshot().activePlayerId, "P2");
    assert.equal(eng.snapshot().turnNumber, 2);
    const second = eng.tryMove("P1", "up");
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error, "NOT_YOUR_TURN");
    // The turn did not pass and P1 did not move.
    assert.equal(eng.snapshot().activePlayerId, "P2");
    assert.equal(eng.snapshot().turnNumber, 2);
    assert.deepEqual([state(eng, "P1").row, state(eng, "P1").col], [10, 6]);
  });

  it("a valid action emits a turn delta event for the next player", () => {
    const eng = makeEngine();
    eng.drainDeltas();
    eng.tryMove("P1", "up");
    const turns = eng.drainDeltas().filter((e) => e.k === "turn");
    assert.equal(turns.length, 1);
    if (turns[0]?.k === "turn") {
      assert.equal(turns[0].activePlayerId, "P2");
      assert.equal(turns[0].turnNumber, 2);
      assert.equal(turns[0].turnDeadlineMs, T0 + 30000);
    }
  });

  it("tryMove on an unknown player reports NOT_IN_MATCH", () => {
    const eng = makeEngine();
    const res = eng.tryMove("nobody", "up");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "NOT_IN_MATCH");
  });

  it("energy: +10 at the start of your turn (capped at 100), no per-second regen", () => {
    const eng = makeEngine();
    eng.tryPlace("P1", { row: 5, col: 5, orientation: "h", len: 2 }); // 100 - 20 = 80
    assert.equal(state(eng, "P1").energy, 80);
    idle(eng, "P2"); // P1's turn starts: +10
    assert.equal(state(eng, "P1").energy, 90);
    eng.tickMs(5000); // 5 s pass with no action: energy does NOT regen
    assert.equal(state(eng, "P1").energy, 90);
    eng.tickMs(5000); // still P1's turn (deadline is wall-clock, tickMs advances it)
    assert.equal(state(eng, "P1").energy, 90);
  });

  it("turn timeout auto-passes after 30 s and the incoming player gains +10", () => {
    const eng = makeEngine();
    eng.tryPlace("P1", { row: 5, col: 5, orientation: "h", len: 1 }); // P1: 80, turn -> P2
    eng.tickAt(T0 + 31_000); // P2 idle for 31 s
    const snap = eng.snapshot();
    assert.equal(snap.activePlayerId, "P1");
    assert.equal(snap.turnNumber, 3);
    assert.equal(snap.turnDeadlineMs, T0 + 60_000);
    assert.equal(state(eng, "P1").energy, 90); // 80 + 10 for the new turn
    assert.equal(eng.deltaSince(0).some((e) => e.k === "turn"), true);
  });
});

describe("tryPlace / tryPlaceAuto result shapes", () => {
  it("tryPlace returns the blockade on success and an error code on failure", () => {
    const eng = makeEngine();
    const ok = eng.tryPlace("P1", { row: 5, col: 5, orientation: "h", len: 2 });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.blockade.edges.length, 2);
      assert.equal(ok.blockade.playerId, "P1");
    }
    // It is now P2's turn: P1 placing again is NOT_YOUR_TURN.
    const oot = eng.tryPlace("P1", { row: 0, col: 0, orientation: "h", len: 1 });
    assert.equal(oot.ok, false);
    if (!oot.ok) assert.equal(oot.error, "NOT_YOUR_TURN");
    // P2's own invalid placement is INVALID_BLOCKADE.
    const bad = eng.tryPlace("P2", { row: 0, col: 0, orientation: "h", len: 1 });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error, "INVALID_BLOCKADE");
  });

  it("tryPlaceAuto places the nearest valid blockade ahead", () => {
    const eng = makeEngine();
    const res = eng.tryPlaceAuto("P1", "up", "h", 2);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.blockade.edges.length, 2);
    assert.equal(eng.snapshot().blockades.length, 1);
    assert.equal(state(eng, "P1").energy, 80);
  });
});

describe("animation state (smooth rendering)", () => {
  it("a move records from→to animation; interpolation never teleports", () => {
    const eng = makeEngine();
    eng.move("P1", "up");
    const tick = eng.tickCount;
    const snap = state(eng, "P1");
    assert.ok(snap.anim);
    assert.deepEqual(
      [snap.anim!.fromRow, snap.anim!.fromCol, snap.anim!.toRow, snap.anim!.toCol],
      [11, 6, 10, 6],
    );
    assert.equal(snap.anim!.durationMs, MOVE_ANIM_MS);
    // At the landing tick the orb is still at the old cell (progress 0).
    const at0 = eng.interpolatedPosition("P1", tick);
    assert.equal(at0.row, 11);
    assert.equal(at0.moving, true);
    // Mid-animation it is strictly between the cells, eased.
    const at1 = eng.interpolatedPosition("P1", tick + 1);
    assert.ok(at1.row > 10 && at1.row < 11);
    assert.ok(at1.progress > 0 && at1.progress < 1);
    // After the duration it rests exactly on the new cell.
    const at3 = eng.interpolatedPosition("P1", tick + 3);
    assert.equal(at3.row, 10);
    assert.equal(at3.moving, false);
  });

  it("easeOutCubic is 0→1, monotonic, and eases (fast start)", () => {
    assert.equal(easeOutCubic(0), 0);
    assert.equal(easeOutCubic(1), 1);
    assert.ok(easeOutCubic(0.5) > 0.5);
    assert.ok(easeOutCubic(0.25) < easeOutCubic(0.5));
    assert.ok(easeOutCubic(0.5) < easeOutCubic(0.75));
  });

  it("a blockade grows in over DEPLOY_MS instead of popping in", () => {
    const eng = makeEngine();
    eng.place("P1", { row: 5, col: 5, orientation: "h", len: 2 });
    const b = eng.snapshot().blockades[0];
    assert.equal(b.placedTick, b.createdTick);
    assert.equal(b.deployDurationMs, DEPLOY_MS);
    assert.equal(eng.blockadeDeployProgress(b, b.createdTick!), 0);
    const mid = eng.blockadeDeployProgress(b, b.createdTick! + 2);
    assert.ok(mid > 0 && mid < 1);
    assert.equal(eng.blockadeDeployProgress(b, b.createdTick! + 5), 1);
  });

  it("a blocked move emits a collide event for impact particles", () => {
    const eng = makeEngine();
    eng.move("P1", "left"); // P1 to (11,5); turn -> P2
    eng.place("P2", { row: 11, col: 5, orientation: "h", len: 1 }); // wall above P1
    eng.move("P1", "up"); // blocked: collide, turn stays P1
    const collides = eng.drainDeltas().filter((e) => e.k === "collide");
    assert.equal(collides.length, 1);
    assert.equal(state(eng, "P1").row, 11);
    assert.equal(eng.snapshot().activePlayerId, "P1");
  });
});

describe("win / timeout / deltas", () => {
  it("reaching the goal emits a win event in the delta stream", () => {
    const eng = makeEngine();
    for (let i = 0; i < 10; i++) {
      eng.move("P1", "up");
      idle(eng, "P2");
    }
    eng.move("P1", "right"); // sidestep: P2 wiggles on cols 5-6, never (0,7)
    idle(eng, "P2");
    eng.move("P1", "up");
    assert.equal(eng.status, "finished");
    assert.equal(eng.winnerId, "P1");
    // deltaSince(-1): this test never ticks, so events sit at tick 0.
    const winEvents = eng.deltaSince(-1).filter((e) => e.k === "win");
    assert.equal(winEvents.length, 1);
    if (winEvents[0]?.k === "win") assert.equal(winEvents[0].reason, "goal");
  });

  it("drainDeltas returns pending events once; deltaSince filters by tick", () => {
    const eng = makeEngine();
    eng.move("P1", "up");
    const drained = eng.drainDeltas();
    assert.ok(drained.some((e) => e.k === "move"));
    assert.ok(drained.some((e) => e.k === "turn"));
    assert.equal(eng.drainDeltas().length, 0);
    idle(eng, "P2"); // P2's turn action
    // (No tick has run, so the move event sits at tick 0.)
    assert.ok(eng.drainDeltas().some((e) => e.k === "move"));
  });

  it("tickAt(nowMs) advances the sim by real elapsed time", () => {
    const eng = makeEngine();
    eng.start(1_000_000);
    eng.tickAt(1_000_050);
    assert.equal(eng.tickCount, 1);
    eng.tickAt(1_000_200);
    assert.equal(eng.tickCount, 2);
  });

  it("fromSnapshot round-trips positions and blockade collision", () => {
    const eng = makeEngine();
    eng.move("P1", "left"); // turn -> P2
    eng.place("P2", { row: 11, col: 6, orientation: "h", len: 1 });
    const snap = eng.snapshot();
    const copy = GameEngine.fromSnapshot(snap);
    assert.deepEqual(
      copy.snapshot().players.map((p) => [p.row, p.col]),
      snap.players.map((p) => [p.row, p.col]),
    );
    assert.equal(copy.snapshot().activePlayerId, snap.activePlayerId);
    copy.getPlayer("P1")!.row = 11;
    copy.getPlayer("P1")!.col = 6;
    assert.equal(copy.move("P1", "up").ok, false);
  });
});
