package com.blokblok.arena.game

// BLOCKADE ARENA — AI opponents (practice mode).
// Kotlin port of packages/core/src/ai.ts. AI uses only legal actions through
// the public engine API — same rules as humans.
// Difficulties: Easy / Normal / Hard (no Expert in milestone 1).

enum class AiDifficulty { EASY, NORMAL, HARD }

sealed interface AiAction {
    data class Move(val dir: Dir) : AiAction
    data class Place(val edge: Edge) : AiAction
}

private val ALL_DIRS = listOf(Dir.UP, Dir.DOWN, Dir.LEFT, Dir.RIGHT)

/** Find a blockade (len 1..2) that lengthens the opponent's shortest path the
 *  most, without lengthening our own path. Returns null if none helps. */
private fun bestBlockingPlacement(engine: GameEngine, me: String, foe: String): Edge? {
    val foeBefore = engine.shortestPathLength(foe) ?: return null
    val meBefore = engine.shortestPathLength(me) ?: return null
    val foePlayer = engine.getPlayer(foe) ?: return null
    val candidates = LinkedHashSet<String>()
    fun consider(row: Int, col: Int, orientation: Orientation, len: Int) {
        candidates += "$row,$col,${orientation.name},$len"
    }
    for (dr in -2..2) {
        for (dc in -2..2) {
            val r = foePlayer.row + dr
            val c = foePlayer.col + dc
            for (len in listOf(1, 2)) {
                consider(r, c, Orientation.H, len)
                consider(r, c, Orientation.V, len)
            }
        }
    }
    // Also edges directly in front of the foe (their next step).
    val step = engine.nextStepTowardGoal(foe)
    if (step != null) {
        val (row, col) = foePlayer.row to foePlayer.col
        when (step) {
            Dir.UP -> consider(row, col, Orientation.H, 2)
            Dir.DOWN -> consider(row + 1, col, Orientation.H, 2)
            Dir.LEFT -> consider(row, col, Orientation.V, 2)
            Dir.RIGHT -> consider(row, col + 1, Orientation.V, 2)
        }
    }
    var best: Edge? = null
    var bestGain = 0
    for (raw in candidates) {
        val parts = raw.split(",")
        val edge = Edge(parts[0].toInt(), parts[1].toInt(), Orientation.valueOf(parts[2]), parts[3].toInt())
        if (engine.validatePlace(me, edge) != null) continue
        val extra = edgesForBlockade(edge).map { edgeKey(it.row, it.col, it.orientation) }.toSet()
        val foeAfter = engine.shortestPathLength(foe, extra) ?: continue
        val meAfter = engine.shortestPathLength(me, extra) ?: continue
        val gain = foeAfter - foeBefore - maxOf(0, meAfter - meBefore)
        if (gain > bestGain) {
            bestGain = gain
            best = edge
        }
    }
    return if (bestGain > 0) best else null
}

fun chooseAiAction(engine: GameEngine, playerId: String, difficulty: AiDifficulty): AiAction? {
    val foe = engine.snapshot().players.find { it.id != playerId } ?: return null
    val me = engine.getPlayer(playerId) ?: return null
    val legal = engine.legalMoves(playerId)
    val step = engine.nextStepTowardGoal(playerId)

    when (difficulty) {
        AiDifficulty.EASY -> {
            // Mostly wanders toward the goal with noise; rarely places blockades.
            if (Math.random() < 0.12) {
                val block = bestBlockingPlacement(engine, playerId, foe.id)
                if (block != null) return AiAction.Place(block)
            }
            if (step != null && Math.random() < 0.7) return AiAction.Move(step)
            if (legal.isNotEmpty()) return AiAction.Move(legal.random())
            return null
        }
        AiDifficulty.NORMAL -> {
            if (Math.random() < 0.3) {
                val block = bestBlockingPlacement(engine, playerId, foe.id)
                if (block != null) return AiAction.Place(block)
            }
            if (step != null) return AiAction.Move(step)
            if (legal.isNotEmpty()) return AiAction.Move(legal.random())
            return null
        }
        AiDifficulty.HARD -> {
            // Always block when it buys at least one extra step for the foe,
            // otherwise take the shortest path. Never wastes energy.
            val block = bestBlockingPlacement(engine, playerId, foe.id)
            if (block != null && me.energy >= 20) return AiAction.Place(block)
            if (step != null) return AiAction.Move(step)
            if (legal.isNotEmpty()) return AiAction.Move(legal.random())
            return null
        }
    }
}
