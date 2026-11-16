// BLOCKADE ARENA — grid / edge model.
// Pure TypeScript: no DOM, no Node APIs.
// Edge convention (DEVELOPMENT.md, single source of truth):
//   'h' edge at (r,c) is the TOP edge of cell (r,c), i.e. between (r-1,c) and (r,c).
//     Valid for 1 <= r < N, 0 <= c < N.
//   'v' edge at (r,c) is the LEFT edge of cell (r,c), i.e. between (r,c-1) and (r,c).
//     Valid for 0 <= r < N, 1 <= c < N.
//   Movement from (r,c): up blocked iff h-edge (r,c); down iff h-edge (r+1,c);
//     left iff v-edge (r,c); right iff v-edge (r,c+1).

import { DIRS, edgeKey, edgesForBlockade, type Dir, type Edge, type Orientation } from "./types.js";

export interface Cell {
  row: number;
  col: number;
}

export function isValidCell(row: number, col: number, n: number): boolean {
  return row >= 0 && row < n && col >= 0 && col < n;
}

/** A single edge is valid iff it lies strictly between two cells of the grid. */
export function isValidEdge(edge: { row: number; col: number; orientation: Orientation }, n: number): boolean {
  if (edge.orientation === "h") return edge.row >= 1 && edge.row < n && edge.col >= 0 && edge.col < n;
  return edge.row >= 0 && edge.row < n && edge.col >= 1 && edge.col < n;
}

/** All single edges of a blockade anchored at `edge` with length `edge.len`. */
export function blockadeEdges(edge: Edge): Edge[] {
  return edgesForBlockade(edge).map((e) => ({ ...e, len: 1 }));
}

/** True iff every single edge of the blockade is a valid in-grid edge. */
export function isValidBlockade(edge: Edge, n: number): boolean {
  if (!Number.isInteger(edge.len) || edge.len < 1 || edge.len > 4) return false;
  return edgesForBlockade(edge).every((e) => isValidEdge(e, n));
}

/** The edge crossed when moving `dir` out of `from`, or null if it leaves the grid. */
export function edgeForMove(from: Cell, dir: Dir, n: number): { row: number; col: number; orientation: Orientation } | null {
  switch (dir) {
    case "up":
      return from.row === 0 ? null : { row: from.row, col: from.col, orientation: "h" };
    case "down":
      return from.row + 1 >= n ? null : { row: from.row + 1, col: from.col, orientation: "h" };
    case "left":
      return from.col === 0 ? null : { row: from.row, col: from.col, orientation: "v" };
    case "right":
      return from.col + 1 >= n ? null : { row: from.row, col: from.col + 1, orientation: "v" };
  }
}

/** Cell reached by moving `dir` from `from` (may be outside the grid). */
export function neighbour(from: Cell, dir: Dir): Cell {
  const d = DIRS[dir];
  return { row: from.row + d.dr, col: from.col + d.dc };
}

/** True iff moving `dir` from `from` is blocked by an edge in `edgeSet` or the grid border. */
export function isMoveBlocked(from: Cell, dir: Dir, edgeSet: ReadonlySet<string>, n: number): boolean {
  const edge = edgeForMove(from, dir, n);
  if (edge === null) return true; // leaves the grid
  return edgeSet.has(edgeKey(edge));
}

/**
 * BFS: does a path exist from `from` to any cell in `goalRow`, moving 4-dir
 * without crossing an edge in `edgeSet`? `blockedCells` (e.g. the opponent's
 * cell) are treated as impassable.
 */
export function pathExists(
  from: Cell,
  goalRow: number,
  edgeSet: ReadonlySet<string>,
  n: number,
  blockedCells: ReadonlySet<string> = new Set(),
): boolean {
  return shortestPath(from, goalRow, edgeSet, n, blockedCells) !== null;
}

/**
 * BFS shortest path from `from` to any cell in `goalRow` as a list of
 * directions, or null if unreachable. Also used for distance measurement.
 */
export function shortestPath(
  from: Cell,
  goalRow: number,
  edgeSet: ReadonlySet<string>,
  n: number,
  blockedCells: ReadonlySet<string> = new Set(),
): Dir[] | null {
  if (from.row === goalRow) return [];
  const key = (r: number, c: number) => `${r},${c}`;
  const visited = new Set<string>([key(from.row, from.col)]);
  // queue of [cell, path-so-far]
  const queue: { cell: Cell; path: Dir[] }[] = [{ cell: from, path: [] }];
  const dirs: Dir[] = ["up", "down", "left", "right"];
  for (let head = 0; head < queue.length; head++) {
    const { cell, path } = queue[head];
    for (const dir of dirs) {
      if (isMoveBlocked(cell, dir, edgeSet, n)) continue;
      const next = neighbour(cell, dir);
      if (!isValidCell(next.row, next.col, n)) continue;
      if (blockedCells.has(key(next.row, next.col))) continue;
      const k = key(next.row, next.col);
      if (visited.has(k)) continue;
      const nextPath = [...path, dir];
      if (next.row === goalRow) return nextPath;
      visited.add(k);
      queue.push({ cell: next, path: nextPath });
    }
  }
  return null;
}

/** BFS distance (in cells) from `from` to `goalRow`, or null if unreachable. */
export function shortestDistance(
  from: Cell,
  goalRow: number,
  edgeSet: ReadonlySet<string>,
  n: number,
  blockedCells: ReadonlySet<string> = new Set(),
): number | null {
  const path = shortestPath(from, goalRow, edgeSet, n, blockedCells);
  return path === null ? null : path.length;
}
