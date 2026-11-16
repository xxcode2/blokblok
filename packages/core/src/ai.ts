// BLOCKADE ARENA — AI opponents (practice mode).
// AI uses only legal actions through the public engine API — same rules as humans.
// Difficulties: Easy / Normal / Hard (no Expert in milestone 1).

import { edgesForBlockade, type Dir, type Edge, type Orientation } from "./types.js";
import type { GameEngine } from "./engine.js";

export type AiDifficulty = "easy" | "normal" | "hard";

export type AiAction =
  | { kind: "move"; dir: Dir }
  | { kind: "place"; edge: Edge };

const DIRS: Dir[] = ["up", "down", "left", "right"];

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Find a blockade (len 1..2) that lengthens the opponent's shortest path the
 *  most, without lengthening our own path. Returns null if none helps. */
function bestBlockingPlacement(engine: GameEngine, me: string, foe: string): Edge | null {
  const foeBefore = engine.shortestPathLength(foe);
  const meBefore = engine.shortestPathLength(me);
  if (foeBefore === null || meBefore === null) return null;
  const foePlayer = engine.getPlayer(foe)!;
  const mePlayer = engine.getPlayer(me)!;
  let best: Edge | null = null;
  let bestGain = 0;
  // Candidate edges: h/v edges around the foe's position and along the foe's
  // shortest-path corridor (a small window keeps this cheap on 40x40).
  const candidates = new Set<string>();
  const consider = (row: number, col: number, orientation: Orientation, len: number) => {
    candidates.add(JSON.stringify({ row, col, orientation, len }));
  };
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const r = foePlayer.row + dr;
      const c = foePlayer.col + dc;
      for (const len of [1, 2]) {
        consider(r, c, "h", len);
        consider(r, c, "v", len);
      }
    }
  }
  // Also edges directly in front of the foe (their next step).
  const step = engine.nextStepTowardGoal(foe);
  if (step) {
    const { row, col } = foePlayer;
    if (step === "up") consider(row, col, "h", 2);
    if (step === "down") consider(row + 1, col, "h", 2);
    if (step === "left") consider(row, col, "v", 2);
    if (step === "right") consider(row, col + 1, "v", 2);
  }
  void mePlayer;
  for (const raw of candidates) {
    const edge = JSON.parse(raw) as Edge;
    if (engine.validatePlace(me, edge) !== null) continue;
    const extra = new Set(edgesForBlockade(edge).map((s) => `${s.orientation}:${s.row}:${s.col}`));
    const foeAfter = engine.shortestPathLength(foe, extra);
    const meAfter = engine.shortestPathLength(me, extra);
    if (foeAfter === null || meAfter === null) continue; // validatePlace already guards, belt & braces
    const gain = foeAfter - foeBefore - Math.max(0, meAfter - meBefore);
    if (gain > bestGain) {
      bestGain = gain;
      best = edge;
    }
  }
  return bestGain > 0 ? best : null;
}

export function chooseAiAction(engine: GameEngine, playerId: string, difficulty: AiDifficulty): AiAction | null {
  // Turn model (protocol 1.2.0): the AI acts only on its own turn, picking
  // exactly ONE move-or-blockade action per call (one per AI turn).
  if (!engine.isActivePlayer(playerId)) return null;
  const others = engine.snapshot().players.filter((p) => p.id !== playerId);
  if (others.length === 0) return null;
  // Block the most threatening opponent: the one closest to their target
  // (goal row in race mode, trophy cell in trophy mode).
  const foe = others.reduce((best, p) => {
    const me = engine.getPlayer(best.id)!;
    const cand = engine.getPlayer(p.id)!;
    return engine.distanceToTarget(cand) < engine.distanceToTarget(me) ? p : best;
  });
  const me = engine.getPlayer(playerId)!;
  const legal = engine.legalMoves(playerId);
  const step = engine.nextStepTowardGoal(playerId);

  if (difficulty === "easy") {
    // Mostly wanders toward the goal with noise; rarely places blockades.
    if (Math.random() < 0.12) {
      const block = bestBlockingPlacement(engine, playerId, foe.id);
      if (block) return { kind: "place", edge: block };
    }
    if (step && Math.random() < 0.7) return { kind: "move", dir: step };
    if (legal.length > 0) return { kind: "move", dir: rand(legal) };
    return null;
  }

  if (difficulty === "normal") {
    if (Math.random() < 0.3) {
      const block = bestBlockingPlacement(engine, playerId, foe.id);
      if (block) return { kind: "place", edge: block };
    }
    if (step) return { kind: "move", dir: step };
    if (legal.length > 0) return { kind: "move", dir: rand(legal) };
    return null;
  }

  // hard: always block when it buys at least one extra step for the foe,
  // otherwise take the shortest path. Never wastes energy on a useless wall.
  const block = bestBlockingPlacement(engine, playerId, foe.id);
  if (block && me.energy >= 20) return { kind: "place", edge: block };
  if (step) return { kind: "move", dir: step };
  if (legal.length > 0) return { kind: "move", dir: rand(legal) };
  return null;
}

/** Task-spec name for the same chooser: `chooseAction(engine, playerId, difficulty)`. */
export { chooseAiAction as chooseAction };
/** Task-spec name for the difficulty union. */
export type { AiDifficulty as Difficulty };
