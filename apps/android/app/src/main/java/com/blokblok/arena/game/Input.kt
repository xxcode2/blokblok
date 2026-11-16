package com.blokblok.arena.game

// Pointer / joystick input helpers (pure functions — no Android APIs here).
// Kotlin port of apps/web/src/game/input.ts. Edge picking follows the
// DEVELOPMENT.md edge model exactly:
//   'H' edge at (row,col) is the top side of cell (row,col), valid 1<=row<N.
//   'V' edge at (row,col) is the left side of cell (row,col), valid 1<=col<N.

/** Nearest grid edge to a pointer position in fractional cell coordinates.
 *  Returns null when the pointer is not close enough to any edge line. */
fun pickEdge(fx: Float, fy: Float, n: Int, snapDist: Float = 0.35f): Edge? {
    // Horizontal lines sit at integer y; vertical lines at integer x.
    val hRow = Math.round(fy)
    val hDist = kotlin.math.abs(fy - hRow)
    val vCol = Math.round(fx)
    val vDist = kotlin.math.abs(fx - vCol)
    val hCol = fx.toInt() // floor for non-negative fx
    val vRow = fy.toInt()
    if (hDist <= vDist && hDist < snapDist && hRow in 1 until n && hCol in 0 until n) {
        return Edge(hRow, hCol, Orientation.H, 1)
    }
    if (vDist < snapDist && vCol in 1 until n && vRow in 0 until n) {
        return Edge(vRow, vCol, Orientation.V, 1)
    }
    return null
}

/** Extend a drag-started single edge into a blockade of length 1..4.
 *  The line grows away from the drag start along the dragged axis. */
fun extendEdge(start: Edge, fx: Float, fy: Float, maxLen: Int = MAX_BLOCKADE_LEN): Edge {
    val span = if (start.orientation == Orientation.H) fx - (start.col + 0.5f) else fy - (start.row + 0.5f)
    val dirSign = if (span >= 0) 1 else -1
    val len = minOf(maxLen, maxOf(1, kotlin.math.abs(span).toInt() + 1))
    return if (start.orientation == Orientation.H) {
        val col0 = if (dirSign >= 0) start.col else start.col - (len - 1)
        Edge(start.row, col0, Orientation.H, len)
    } else {
        val row0 = if (dirSign >= 0) start.row else start.row - (len - 1)
        Edge(row0, start.col, Orientation.V, len)
    }
}

/** Dominant swipe direction for a pointer drag vector (pixels). */
fun swipeDir(dx: Float, dy: Float, minPx: Float = 24f): Dir? {
    if (kotlin.math.abs(dx) < minPx && kotlin.math.abs(dy) < minPx) return null
    return if (kotlin.math.abs(dx) >= kotlin.math.abs(dy)) {
        if (dx > 0) Dir.RIGHT else Dir.LEFT
    } else {
        if (dy > 0) Dir.DOWN else Dir.UP
    }
}

/** Direction from a joystick deflection (normalised -1..1). */
fun joystickDir(dx: Float, dy: Float, deadZone: Float = 0.35f): Dir? {
    if (kotlin.math.abs(dx) < deadZone && kotlin.math.abs(dy) < deadZone) return null
    return if (kotlin.math.abs(dx) >= kotlin.math.abs(dy)) {
        if (dx > 0) Dir.RIGHT else Dir.LEFT
    } else {
        if (dy > 0) Dir.DOWN else Dir.UP
    }
}

fun opposite(dir: Dir): Dir = when (dir) {
    Dir.UP -> Dir.DOWN
    Dir.DOWN -> Dir.UP
    Dir.LEFT -> Dir.RIGHT
    Dir.RIGHT -> Dir.LEFT
}
