// Smoothness + task-spec API tests: input buffering, tryMove/tryPlace/
// tryPlaceAuto result shapes, move/blockade animation state, collide/win
// delta events, drainDeltas/deltaSince, tick(nowMs).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEPLOY_MS, easeOutCubic, GameEngine, MOVE_ANIM_MS } from "../index.js";

function makeEngine(gridSize = 12, durationSec = 180): GameEngine {
  const eng = new GameEngine({ gridSize, durationSec });
  eng.addPlayer("P1", "Blue");
  eng.addPlayer("P2", "Red");
  return eng;
}

function state(eng: GameEngine, id: string) {
  return eng.snapshot().players.find((p) => p.id === id)!;
}

describe("input buffering (tryMove)", () => {
  it("buffers during the move cooldown and applies on tick (latest wins)", () => {
    const eng = makeEngine();
    assert.equal(eng.tryMove("P1", "up").ok, true);
    const buffered = eng.tryMove("P1", "left");
    assert.equal(buffered.ok, true);
    if (buffered.ok) assert.equal(buffered.buffered, true);
    assert.deepEqual([state(eng, "P1").row, state(eng, "P1").col], [10, 6]); // not yet applied
    eng.tickMs(150);
    assert.deepEqual([state(eng, "P1").row, state(eng, "P1").col], [10, 5]); // buffered left applied
  });

  it("a buffered move that becomes illegal is dropped, not retried forever", () => {
    const eng = makeEngine();
    eng.tryMove("P1", "up");
    eng.place("P2", { row: 10, col: 6, orientation: "h", len: 1 }); // wall above the next cell
    eng.tryMove("P1", "up"); // buffered while on cooldown
    eng.tickMs(150);
    // P1 is still at (10,6): the buffered up-move hit the new wall and dropped.
    assert.deepEqual([state(eng, "P1").row, state(eng, "P1").col], [10, 6]);
  });

  it("tryMove on an unknown player / finished match reports NOT_IN_MATCH", () => {
    const eng = makeEngine();
    const res = eng.tryMove("nobody", "up");
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "NOT_IN_MATCH");
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
    const bad = eng.tryPlace("P1", { row: 0, col: 0, orientation: "h", len: 1 });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error, "ON_COOLDOWN"); // cooldown precedes validity
    eng.tickMs(600);
    const bad2 = eng.tryPlace("P1", { row: 0, col: 0, orientation: "h", len: 1 });
    assert.equal(bad2.ok, false);
    if (!bad2.ok) assert.equal(bad2.error, "INVALID_BLOCKADE");
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
    eng.place("P2", { row: 11, col: 6, orientation: "h", len: 1 });
    eng.move("P1", "up");
    const collides = eng.drainDeltas().filter((e) => e.k === "collide");
    assert.equal(collides.length, 1);
    assert.equal(state(eng, "P1").row, 11);
  });
});

describe("win / timeout / deltas", () => {
  it("reaching the goal emits a win event in the delta stream", () => {
    const eng = makeEngine();
    for (let i = 0; i < 10; i++) {
      eng.move("P1", "up");
      eng.tickMs(150);
    }
    eng.move("P1", "left"); // sidestep: P2 spawns on (0,6)
    eng.tickMs(150);
    eng.move("P1", "up");
    assert.equal(eng.status, "finished");
    assert.equal(eng.winnerId, "P1");
    const winEvents = eng.deltaSince(0).filter((e) => e.k === "win");
    assert.equal(winEvents.length, 1);
    if (winEvents[0]?.k === "win") assert.equal(winEvents[0].reason, "goal");
  });

  it("drainDeltas returns pending events once; deltaSince filters by tick", () => {
    const eng = makeEngine();
    eng.move("P1", "up");
    const drained = eng.drainDeltas();
    assert.ok(drained.some((e) => e.k === "move"));
    assert.equal(eng.drainDeltas().length, 0);
    eng.tryMove("P1", "left"); // buffered (move cooldown), applied by the tick
    eng.tickMs(150);
    assert.ok(eng.deltaSince(0).some((e) => e.k === "move"));
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
    eng.place("P2", { row: 11, col: 6, orientation: "h", len: 1 });
    eng.move("P1", "left");
    const snap = eng.snapshot();
    const copy = GameEngine.fromSnapshot(snap);
    assert.deepEqual(
      copy.snapshot().players.map((p) => [p.row, p.col]),
      snap.players.map((p) => [p.row, p.col]),
    );
    copy.getPlayer("P1")!.row = 11;
    copy.getPlayer("P1")!.col = 6;
    assert.equal(copy.move("P1", "up").ok, false);
  });
});
