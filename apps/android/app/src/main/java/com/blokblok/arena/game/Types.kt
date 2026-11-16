package com.blokblok.arena.game

// BLOCKADE ARENA — protocol types + tunables.
// Kotlin port of packages/core/src/types.ts (single source of truth).
// Keep this file in sync with the TypeScript core and DEVELOPMENT.md.

enum class Dir { UP, DOWN, LEFT, RIGHT }
enum class Orientation { H, V }
enum class PlayerColor { BLUE, RED, GREEN, AMBER }
enum class GameMode { RACE, TROPHY }
enum class MatchStatus { LOBBY, COUNTDOWN, PLAYING, FINISHED }

/** One grid edge. 'H' at (row,col) is the top side of cell (row,col);
 *  'V' at (row,col) is the left side of cell (row,col). */
data class Edge(
    val row: Int,
    val col: Int,
    val orientation: Orientation,
    val len: Int,
)

data class PlayerState(
    val id: String,
    val name: String,
    val color: PlayerColor,
    val row: Int,
    val col: Int,
    val energy: Int,
    val score: Int,
    /** 0..1 fraction of the way to the goal row. */
    val progress: Float,
    /** In-flight move animation (render hint). */
    val anim: MoveAnim? = null,
)

data class MoveAnim(
    val fromRow: Int,
    val fromCol: Int,
    val toRow: Int,
    val toCol: Int,
    val startTick: Long,
    val durationMs: Long,
)

data class BlockadeState(
    val id: String,
    val playerId: String,
    val edges: List<Edge>,
    val createdTick: Long,
    val placedTick: Long? = null,
    val deployDurationMs: Long? = null,
)

/** The trophy cell in trophy mode: the exact centre cell of the board,
 *  `{ row: floor(n/2), col: floor(n/2) }` — 12 → (6,6), 20 → (10,10). */
data class TrophyCell(val row: Int, val col: Int)

fun trophyCellFor(gridSize: Int): TrophyCell = TrophyCell(gridSize / 2, gridSize / 2)

data class Snapshot(
    val tick: Long,
    val status: MatchStatus,
    val mode: GameMode,
    val gridSize: Int,
    val durationSec: Int,
    val timeLeftMs: Long,
    val players: List<PlayerState>,
    val blockades: List<BlockadeState>,
    val winnerId: String?,
    /** Id of the player whose turn it is (P1/blue first, turn 1). */
    val activePlayerId: String,
    /** Current turn number, starting at 1. Increments on every turn pass. */
    val turnNumber: Int,
    /** Epoch ms when the current turn expires (30 s after it started). */
    val turnDeadlineMs: Long,
    /** Number of players in the match (2, or 4 in trophy mode). */
    val playerCount: Int = 2,
    /** Trophy cell in trophy mode, null in race mode. */
    val trophy: TrophyCell? = null,
)

sealed interface DeltaEvent {
    data class Move(val playerId: String, val row: Int, val col: Int, val tick: Long) : DeltaEvent
    data class Blockade(val blockade: BlockadeState) : DeltaEvent
    data class Energy(val playerId: String, val energy: Int) : DeltaEvent
    data class Timer(val timeLeftMs: Long) : DeltaEvent
    data class Score(val playerId: String, val score: Int) : DeltaEvent
    data class Collide(val playerId: String, val row: Int, val col: Int, val tick: Long) : DeltaEvent
    data class Win(
        val winnerId: String?,
        val reason: WinReason,
        val tick: Long,
    ) : DeltaEvent
    /** Turn passed: it is now [activePlayerId]'s turn ([turnNumber]),
     *  which expires at [turnDeadlineMs] (epoch ms). */
    data class Turn(
        val activePlayerId: String,
        val turnNumber: Int,
        val turnDeadlineMs: Long,
    ) : DeltaEvent
}

enum class WinReason { GOAL, TROPHY, TIMEOUT, FORFEIT, DRAW }

data class LobbyPlayer(
    val id: String,
    val name: String,
    val ready: Boolean,
    val isHost: Boolean,
)

data class MatchResultData(
    val winnerId: String?,
    val reason: WinReason,
    val scores: Map<String, Int>,
    val stats: Map<String, PlayerStats>,
    val durationMs: Long,
    val players: List<PlayerState>,
)

data class PlayerStats(val moves: Int, val blockades: Int)

// ---------------------------------------------------------------------------
// Tunables (GAME_RULES.md) — TURN-BASED model, protocol 1.2.0.
// One action per turn (move 1 cell OR place 1 blockade); the turn then
// passes. No move/place cooldowns and no input buffering any more.
// Modes: RACE (2 players, goal rows) and TROPHY (2 or 4 players, centre
// trophy cell wins). Trophy mode + 4 players: P3 green spawns left-centre,
// P4 amber spawns right-centre; turns rotate P1→P2→P3→P4→P1…
// ---------------------------------------------------------------------------
const val PROTOCOL_VERSION = "1.2.0"
const val TURN_DURATION_MS = 30000L
/** Energy gained by the incoming player at the start of each of their turns. */
const val ENERGY_PER_TURN = 10
const val MAX_ENERGY = 100
const val MAX_BLOCKADES_PER_PLAYER = 10
const val MAX_BLOCKADE_LEN = 4
const val DEFAULT_DURATION_SEC = 180
const val DEFAULT_GRID_SIZE = 12
/** Animation-only glide duration (150 ms, eased) — NOT a cooldown. */
const val MOVE_ANIM_MS = 150L
const val DEPLOY_MS = 250L
const val SERVER_TICK_MS = 50L

/** Error code when a player acts while it is not their turn. */
const val ERR_NOT_YOUR_TURN = "NOT_YOUR_TURN"

fun blockadeCost(len: Int): Int = if (len >= 3) 35 else 20

fun scoreForOutcome(outcome: String, secondsRemaining: Int): Int = when (outcome) {
    "win" -> 100 + 2 * secondsRemaining
    "draw" -> 25
    else -> 0
}

val DIRS: Map<Dir, Pair<Int, Int>> = mapOf(
    Dir.UP to (-1 to 0),
    Dir.DOWN to (1 to 0),
    Dir.LEFT to (0 to -1),
    Dir.RIGHT to (0 to 1),
)

fun edgeKey(row: Int, col: Int, orientation: Orientation): String = "${orientation.name}:$row:$col"

/** Spawn colour by seat: P1 blue, P2 red, P3 green (#22c55e), P4 amber (#f59e0b). */
fun colorForSeat(index: Int): PlayerColor = when (index) {
    0 -> PlayerColor.BLUE
    1 -> PlayerColor.RED
    2 -> PlayerColor.GREEN
    else -> PlayerColor.AMBER
}

/** Display label for a seat ("P1".."P4"). */
fun labelForSeat(index: Int): String = "P${index + 1}"
fun edgesForBlockade(edge: Edge): List<Edge> {
    val out = ArrayList<Edge>(edge.len)
    for (i in 0 until edge.len) {
        out += if (edge.orientation == Orientation.H) {
            Edge(edge.row, edge.col + i, Orientation.H, 1)
        } else {
            Edge(edge.row + i, edge.col, Orientation.V, 1)
        }
    }
    return out
}

/** easeOutCubic: fast start, soft landing — the standard orb-move easing. */
fun easeOutCubic(t: Float): Float {
    val x = t.coerceIn(0f, 1f)
    return 1f - (1f - x) * (1f - x) * (1f - x)
}
