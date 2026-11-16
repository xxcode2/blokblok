// Pointer / keyboard input helpers (pure functions — no DOM here).
// Edge picking follows the DEVELOPMENT.md edge model exactly:
//   'h' edge at (row,col) is the top side of cell (row,col), valid 1<=row<N.
//   'v' edge at (row,col) is the left side of cell (row,col), valid 1<=col<N.

import type { Dir, Edge, Orientation } from "@blockade/core";

export function keyToDir(key: string): Dir | null {
  switch (key) {
    case "ArrowUp":
    case "w":
    case "W":
      return "up";
    case "ArrowDown":
    case "s":
    case "S":
      return "down";
    case "ArrowLeft":
    case "a":
    case "A":
      return "left";
    case "ArrowRight":
    case "d":
    case "D":
      return "right";
    default:
      return null;
  }
}

export function isP1MoveKey(key: string): boolean {
  return key === "w" || key === "W" || key === "a" || key === "A" || key === "s" || key === "S" || key === "d" || key === "D";
}

export function isP2MoveKey(key: string): boolean {
  return key.startsWith("Arrow");
}

/** Nearest grid edge to a pointer position in fractional cell coordinates.
 *  Returns null when the pointer is not close enough to any edge line. */
export function pickEdge(fx: number, fy: number, n: number, snapDist = 0.35): Edge | null {
  // Horizontal lines sit at integer y; vertical lines at integer x.
  const hRow = Math.round(fy);
  const hDist = Math.abs(fy - hRow);
  const vCol = Math.round(fx);
  const vDist = Math.abs(fx - vCol);
  const hCol = Math.floor(fx);
  const vRow = Math.floor(fy);
  if (hDist <= vDist && hDist < snapDist && hRow >= 1 && hRow < n && hCol >= 0 && hCol < n) {
    return { row: hRow, col: hCol, orientation: "h", len: 1 };
  }
  if (vDist < snapDist && vCol >= 1 && vCol < n && vRow >= 0 && vRow < n) {
    return { row: vRow, col: vCol, orientation: "v", len: 1 };
  }
  return null;
}

/** Extend a drag-started single edge into a blockade of length 1..4.
 *  The line grows away from the drag start along the dragged axis. */
export function extendEdge(start: Edge, fx: number, fy: number, maxLen = 4): Edge {
  const span = start.orientation === "h" ? fx - (start.col + 0.5) : fy - (start.row + 0.5);
  const dirSign = span >= 0 ? 1 : -1;
  const len = Math.min(maxLen, Math.max(1, Math.floor(Math.abs(span)) + 1));
  if (start.orientation === "h") {
    const col0 = dirSign >= 0 ? start.col : start.col - (len - 1);
    return { row: start.row, col: col0, orientation: "h", len };
  }
  const row0 = dirSign >= 0 ? start.row : start.row - (len - 1);
  return { row: row0, col: start.col, orientation: "v", len };
}

/** Dominant swipe direction for a pointer drag vector (pixels). */
export function swipeDir(dx: number, dy: number, minPx = 24): Dir | null {
  if (Math.abs(dx) < minPx && Math.abs(dy) < minPx) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

/** Direction from a joystick deflection (normalised -1..1). */
export function joystickDir(dx: number, dy: number, deadZone = 0.35): Dir | null {
  if (Math.abs(dx) < deadZone && Math.abs(dy) < deadZone) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

export function opposite(dir: Dir): Dir {
  return dir === "up" ? "down" : dir === "down" ? "up" : dir === "left" ? "right" : "left";
}

export function rotateOrientation(o: Orientation): Orientation {
  return o === "h" ? "v" : "h";
}
