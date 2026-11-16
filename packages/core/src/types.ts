// BLOCKADE ARENA — shared protocol types + constants.
// Single source of truth for the wire protocol (see DEVELOPMENT.md).
// Pure TypeScript: no DOM, no Node APIs.

export type Dir = "up" | "down" | "left" | "right";
export type Orientation = "h" | "v";
export type PlayerColor = "blue" | "red";
export type GameMode = "race";
export type MatchStatus = "lobby" | "countdown" | "playing" | "finished";
export type GridSize = 12 | 20 | 30 | 40;

/** One grid edge. 'h' at (row,col) is the top side of cell (row,col);
 *  'v' at (row,col) is the left side of cell (row,col). */
export interface Edge {
  row: number;
  col: number;
  orientation: Orientation;
  len: number;
}

export interface PlayerState {
  id: string;
  name: string;
  color: PlayerColor;
  row: number;
  col: number;
  energy: number;
  moveCooldownMs: number;
  placeCooldownMs: number;
  score: number;
  /** 0..1 fraction of the way to the goal row. */
  progress: number;
  /**
   * In-flight move animation (render hint — clients interpolate from→to with
   * easing instead of teleporting). `startTick` is the engine tick the move
   * landed on; progress at tick T is
   *   clamp((T - startTick) * 50 / durationMs), eased (easeOutCubic).
   * Absent when the player is not mid-animation.
   */
  anim?: {
    fromRow: number;
    fromCol: number;
    toRow: number;
    toCol: number;
    startTick: number;
    durationMs: number;
  };
}

export interface BlockadeState {
  id: string;
  playerId: string;
  edges: Edge[];
  createdTick: number;
  /**
   * Deployment animation (render hint): the blockade grows in over
   * `deployDurationMs` starting at `placedTick` instead of popping in.
   * Progress at tick T is clamp((T - placedTick) * 50 / deployDurationMs).
   */
  placedTick?: number;
  deployDurationMs?: number;
}

export interface Snapshot {
  tick: number;
  status: MatchStatus;
  mode: GameMode;
  gridSize: number;
  durationSec: number;
  timeLeftMs: number;
  players: PlayerState[];
  blockades: BlockadeState[];
  winnerId: string | null;
}

export type DeltaEvent =
  | { k: "move"; playerId: string; row: number; col: number; tick: number }
  | { k: "blockade"; blockade: BlockadeState }
  | { k: "energy"; playerId: string; energy: number }
  | { k: "timer"; timeLeftMs: number }
  | { k: "score"; playerId: string; score: number }
  | { k: "collide"; playerId: string; row: number; col: number; tick: number }
  | { k: "win"; winnerId: string | null; reason: "goal" | "timeout" | "forfeit" | "draw"; tick: number };

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------
export type ClientMessage =
  | { type: "hello"; name: string; clientVersion: string }
  | { type: "createRoom"; mode: GameMode; gridSize: GridSize; durationSec: number }
  | { type: "joinRoom"; roomCode: string }
  | { type: "queue"; mode: GameMode; gridSize: number }
  | { type: "leaveQueue" }
  | { type: "ready"; ready: boolean }
  | { type: "start" }
  | { type: "input"; seq: number; kind: "move"; dir: Dir }
  | { type: "input"; seq: number; kind: "place"; edge: Edge }
  | { type: "input"; seq: number; kind: "placeAuto"; dir: Dir; orientation: Orientation; len: number }
  | { type: "ping"; t: number }
  | { type: "reconnect"; token: string };

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------
export type ServerMessage =
  | { type: "welcome"; playerId: string; serverVersion: string }
  | { type: "roomCreated"; roomId: string; roomCode: string; token: string }
  | {
      type: "roomJoined";
      roomId: string;
      roomCode: string;
      mode: GameMode;
      gridSize: number;
      durationSec: number;
      players: { id: string; name: string; ready: boolean; isHost: boolean }[];
    }
  | { type: "lobbyUpdate"; players: { id: string; name: string; ready: boolean; isHost: boolean }[] }
  | { type: "queued"; position: number }
  | { type: "queueLeft" }
  | { type: "matchFound"; roomId: string; roomCode: string; token: string; opponent: { id: string; name: string } }
  | { type: "countdown"; seconds: number }
  | { type: "matchStart"; snapshot: Snapshot }
  | { type: "state"; tick: number; snapshot: Snapshot }
  | { type: "delta"; tick: number; events: DeltaEvent[] }
  | {
      type: "result";
      winnerId: string | null;
      reason: "goal" | "timeout" | "forfeit" | "draw";
      scores: Record<string, number>;
      stats: Record<string, { moves: number; blockades: number }>;
      durationMs: number;
    }
  | { type: "opponentLeft"; playerId: string }
  | { type: "error"; code: string; message: string }
  | { type: "pong"; t: number }
  | { type: "reconnected"; snapshot: Snapshot };

export type ErrorCode =
  | "BAD_REQUEST"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "NOT_READY"
  | "NOT_HOST"
  | "INVALID_MOVE"
  | "INVALID_BLOCKADE"
  | "NO_PATH"
  | "NO_ENERGY"
  | "ON_COOLDOWN"
  | "NOT_IN_MATCH"
  | "BAD_TOKEN";

export interface MatchScores {
  scores: Record<string, number>;
  rankedPoints: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Tunables (GAME_RULES.md)
// ---------------------------------------------------------------------------
export const PROTOCOL_VERSION = "1.0.0";
export const MOVE_COOLDOWN_MS = 150;
export const PLACE_COOLDOWN_MS = 500;
export const MAX_ENERGY = 100;
export const ENERGY_REGEN_PER_SEC = 5;
export const MAX_BLOCKADES_PER_PLAYER = 10;
export const MAX_BLOCKADE_LEN = 4;
export const DEFAULT_DURATION_SEC = 180;
export const DEFAULT_GRID_SIZE: GridSize = 12;

export function blockadeCost(len: number): number {
  return len >= 3 ? 35 : 20;
}

/** Score for a match outcome. */
export function scoreForOutcome(outcome: "win" | "draw" | "loss", secondsRemaining: number): number {
  if (outcome === "win") return 100 + 2 * Math.floor(secondsRemaining);
  if (outcome === "draw") return 25;
  return 0;
}

export const DIRS: Record<Dir, { dr: number; dc: number }> = {
  up: { dr: -1, dc: 0 },
  down: { dr: 1, dc: 0 },
  left: { dr: 0, dc: -1 },
  right: { dr: 0, dc: 1 },
};

export function edgeKey(e: { row: number; col: number; orientation: Orientation }): string {
  return `${e.orientation}:${e.row}:${e.col}`;
}

/** The L single edges covered by a blockade anchored at `edge`. */
export function edgesForBlockade(edge: Edge): { row: number; col: number; orientation: Orientation }[] {
  const out = [];
  for (let i = 0; i < edge.len; i++) {
    out.push(
      edge.orientation === "h"
        ? { row: edge.row, col: edge.col + i, orientation: "h" as const }
        : { row: edge.row + i, col: edge.col, orientation: "v" as const },
    );
  }
  return out;
}
