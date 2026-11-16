// BLOCKADE ARENA — web-side helpers for the 1.3.0 arena modes.
// Thin wrappers over the real core 1.3.0 API (GameMode, PLAYER_COLORS,
// Snapshot.mode / playerCount / trophy, trophyCellFor) so the screens,
// HUD and renderer share one spelling of each rule.

import type { Dir, PlayerColor, Snapshot } from "@blockade/core";
import { MAX_BLOCKADES_PER_PLAYER, PLAYER_COLORS as CORE_COLORS, trophyCellFor } from "@blockade/core";

/** Game mode: race to the goal row, or first to the centre trophy. */
export type ArenaMode = "race" | "trophy";
export type ArenaPlayerCount = 2 | 4;

/** Seat colours, in seat order. P1 blue, P2 red (existing), P3 green, P4 amber. */
export const PLAYER_COLORS: readonly PlayerColor[] = CORE_COLORS;
export type ArenaPlayerColor = PlayerColor;

export const PLAYER_COLOR_HEX: Record<ArenaPlayerColor, string> = {
  blue: "#38bdf8",
  red: "#f43f5e",
  green: "#22c55e",
  amber: "#f59e0b",
};

/** "P1" .. "P4" for a 0-based seat index. */
export function playerLabel(index: number): string {
  return `P${index + 1}`;
}

/** Colour for a 0-based seat index (wraps defensively). */
export function colorOfIndex(index: number): ArenaPlayerColor {
  return CORE_COLORS[((index % CORE_COLORS.length) + CORE_COLORS.length) % CORE_COLORS.length];
}

/** True when this snapshot is a trophy-mode match. */
export function isTrophyMode(snap: Snapshot | null | undefined): boolean {
  return snap?.mode === "trophy";
}

/** "race" | "trophy" for a snapshot (defaults to "race" on old snapshots). */
export function arenaModeOf(snap: Snapshot | null | undefined): ArenaMode {
  return isTrophyMode(snap) ? "trophy" : "race";
}

/** How many players this match has (snapshot field, else players array). */
export function playerCountOf(snap: Snapshot | null | undefined): number {
  const n = snap?.playerCount;
  if (n === 2 || n === 4) return n;
  return snap?.players.length ?? 2;
}

/**
 * Blockades a player may still place this match (cap 10 per player,
 * protocol 1.3.0). Prefers the wire field `PlayerState.blockadesLeft`
 * when the server/engine sends it; otherwise derives it from the
 * snapshot's blockade list (10 − blockades placed by this player), so
 * the HUD stays correct against either shape.
 */
export function blockadesLeftOf(snap: Snapshot | null | undefined, playerId: string): number {
  if (!snap) return MAX_BLOCKADES_PER_PLAYER;
  const p = snap.players.find((x) => x.id === playerId);
  const wire = (p as unknown as { blockadesLeft?: unknown } | undefined)?.blockadesLeft;
  if (typeof wire === "number" && Number.isFinite(wire)) return Math.max(0, Math.floor(wire));
  const placed = snap.blockades.filter((b) => b.playerId === playerId).length;
  return Math.max(0, MAX_BLOCKADES_PER_PLAYER - placed);
}

/**
 * The trophy cell: the snapshot's `trophy` (centre cell), falling back to
 * trophyCellFor(gridSize) in trophy mode; null in race mode. The cell is a
 * normal walkable cell.
 */
export function trophyCell(snap: Snapshot | null | undefined): { row: number; col: number } | null {
  if (!snap) return null;
  if (snap.trophy) return { row: snap.trophy.row, col: snap.trophy.col };
  if (!isTrophyMode(snap)) return null;
  return trophyCellFor(snap.gridSize);
}

/** Dominant-axis step from (fromRow, fromCol) toward (toRow, toCol). */
export function dirTowardCell(fromRow: number, fromCol: number, toRow: number, toCol: number): Dir {
  const dr = toRow - fromRow;
  const dc = toCol - fromCol;
  if (dr === 0 && dc === 0) return "up";
  if (Math.abs(dr) >= Math.abs(dc)) return dr > 0 ? "down" : "up";
  return dc > 0 ? "right" : "left";
}
