package com.blokblok.arena.game

// BLOCKADE ARENA — authoritative game engine (Kotlin port).
// Implements GAME_RULES.md exactly: Race to the Top, edge-model blockades,
// BFS fairness rule, energy/cooldowns, timer + timeout scoring.
// Deterministic, no I/O. Ticked at 20/s (50 ms steps) locally and by the
// server. Mirrors packages/core/src/engine.ts line for line in behaviour.

sealed interface EngineResult {
    data class Ok(val events: List<DeltaEvent>) : EngineResult
    data class Err(val code: String, val message: String) : EngineResult
}

sealed interface TryMoveResult {
    data object Ok : TryMoveResult
    data object Buffered : TryMoveResult
    data class Err(val code: String, val message: String) : TryMoveResult
}

sealed interface TryPlaceResult {
    data class Ok(val blockade: BlockadeState) : TryPlaceResult
    data class Err(val code: String, val message: String) : TryPlaceResult
}

internal class PlayerInternal(
    val id: String,
    val name: String,
    val color: PlayerColor,
    var row: Int,
    var col: Int,
    var energy: Double,
    var moveCooldownMs: Long,
    var placeCooldownMs: Long,
    var score: Int,
    var moves: Int,
    var blockadesPlaced: Int,
    var bufferedDir: Dir?,
    var anim: MoveAnim?,
)

class GameEngine(
    val gridSize: Int = DEFAULT_GRID_SIZE,
    val durationSec: Int = DEFAULT_DURATION_SEC,
    val mode: GameMode = GameMode.RACE,
) {
    var tickCount: Long = 0
        private set
    var status: MatchStatus = MatchStatus.PLAYING
        private set
    var timeLeftMs: Long = durationSec * 1000L
        private set
    var winnerId: String? = null
        private set
    var winReason: WinReason? = null
        private set
    var startedAtMs: Long = 0
        private set

    private val players = mutableListOf<PlayerInternal>()
    private val blocked = HashSet<String>()
    private val blockades = mutableListOf<BlockadeState>()
    private var elapsedMs: Long = 0
    private var clockMs: Long = 0
    private var lastTickMs: Long = 0
    private val pendingEvents = mutableListOf<DeltaEvent>()
    private val retainedEvents = ArrayDeque<Pair<Long, DeltaEvent>>()

    companion object {
        private var blockadeSeq = 0

        fun fromSnapshot(snap: Snapshot): GameEngine {
            val eng = GameEngine(snap.gridSize, snap.durationSec, snap.mode)
            eng.tickCount = snap.tick
            eng.status = snap.status
            eng.timeLeftMs = snap.timeLeftMs
            eng.winnerId = snap.winnerId
            for (ps in snap.players) {
                eng.players += PlayerInternal(
                    id = ps.id, name = ps.name, color = ps.color,
                    row = ps.row, col = ps.col, energy = ps.energy.toDouble(),
                    moveCooldownMs = ps.moveCooldownMs, placeCooldownMs = ps.placeCooldownMs,
                    score = ps.score, moves = 0, blockadesPlaced = 0,
                    bufferedDir = null,
                    anim = ps.anim?.let {
                        MoveAnim(it.fromRow, it.fromCol, it.toRow, it.toCol, it.startTick, it.durationMs)
                    },
                )
            }
            for (b in snap.blockades) {
                eng.blockades += b.copy(edges = b.edges.map { it.copy() })
                for (s in b.edges) eng.blocked.add(edgeKey(s.row, s.col, s.orientation))
            }
            return eng
        }
    }

    fun getClockMs(): Long = clockMs

    private fun record(events: List<DeltaEvent>) {
        for (e in events) {
            pendingEvents += e
            retainedEvents += tickCount to e
        }
        while (retainedEvents.size > 2000) retainedEvents.removeFirst()
    }

    fun drainDeltas(): List<DeltaEvent> {
        val out = pendingEvents.toList()
        pendingEvents.clear()
        return out
    }

    fun deltaSince(sinceTick: Long): List<DeltaEvent> =
        retainedEvents.filter { it.first > sinceTick }.map { it.second }

    // -- setup ---------------------------------------------------------------
    fun addPlayer(id: String, name: String): PlayerState {
        require(players.size < 2) { "Race mode supports exactly 2 players" }
        val idx = players.size
        val color = if (idx == 0) PlayerColor.BLUE else PlayerColor.RED
        val centre = gridSize / 2
        val p = PlayerInternal(
            id = id, name = name, color = color,
            row = if (idx == 0) gridSize - 1 else 0, col = centre,
            energy = MAX_ENERGY.toDouble(), moveCooldownMs = 0, placeCooldownMs = 0,
            score = 0, moves = 0, blockadesPlaced = 0, bufferedDir = null, anim = null,
        )
        players += p
        return playerState(p)
    }

    internal fun getPlayer(id: String): PlayerInternal? = players.find { it.id == id }

    fun beginCountdown() {
        if (status == MatchStatus.LOBBY) status = MatchStatus.COUNTDOWN
    }

    fun start(nowMs: Long) {
        status = MatchStatus.PLAYING
        elapsedMs = 0
        timeLeftMs = durationSec * 1000L
        lastTickMs = nowMs
        for (p in players) {
            p.moveCooldownMs = 0
            p.placeCooldownMs = 0
            p.bufferedDir = null
        }
    }

    /** Wall-clock tick entry point (20/s). Returns the delta events. */
    fun tickAt(nowMs: Long): List<DeltaEvent> {
        val dt = if (lastTickMs > 0) (nowMs - lastTickMs).coerceIn(0, 250) else 50L
        lastTickMs = nowMs
        if (status != MatchStatus.PLAYING) return emptyList()
        return tickMs(dt)
    }

    internal fun goalRow(p: PlayerInternal): Int = if (p.color == PlayerColor.BLUE) 0 else gridSize - 1
    internal fun rowsRemaining(p: PlayerInternal): Int = kotlin.math.abs(p.row - goalRow(p))
    internal fun progress(p: PlayerInternal): Float = 1f - rowsRemaining(p).toFloat() / (gridSize - 1)

    // -- edge model ----------------------------------------------------------
    fun isEdgeBlocked(row: Int, col: Int, orientation: Orientation): Boolean =
        blocked.contains(edgeKey(row, col, orientation))

    fun isMoveBlocked(row: Int, col: Int, dir: Dir): Boolean = when (dir) {
        Dir.UP -> isEdgeBlocked(row, col, Orientation.H)
        Dir.DOWN -> isEdgeBlocked(row + 1, col, Orientation.H)
        Dir.LEFT -> isEdgeBlocked(row, col, Orientation.V)
        Dir.RIGHT -> isEdgeBlocked(row, col + 1, Orientation.V)
    }

    fun legalMoves(playerId: String): List<Dir> {
        val p = getPlayer(playerId) ?: return emptyList()
        if (status != MatchStatus.PLAYING) return emptyList()
        val out = mutableListOf<Dir>()
        for ((dir, d) in DIRS) {
            val nr = p.row + d.first
            val nc = p.col + d.second
            if (nr !in 0 until gridSize || nc !in 0 until gridSize) continue
            if (isMoveBlocked(p.row, p.col, dir)) continue
            if (players.any { q -> q.id != p.id && q.row == nr && q.col == nc }) continue
            out += dir
        }
        return out
    }

    // -- pathfinding (BFS fairness rule) --------------------------------------
    /** Shortest path length in moves from a player's cell to their goal row,
     *  or null if unreachable. `extra` edges are treated as blocked too. */
    fun shortestPathLength(playerId: String, extra: Set<String>? = null): Int? {
        val p = getPlayer(playerId) ?: return null
        val goal = goalRow(p)
        fun blockedAt(r: Int, c: Int, dir: Dir): Boolean {
            if (extra != null) {
                when (dir) {
                    Dir.UP -> if (extra.contains(edgeKey(r, c, Orientation.H))) return true
                    Dir.DOWN -> if (extra.contains(edgeKey(r + 1, c, Orientation.H))) return true
                    Dir.LEFT -> if (extra.contains(edgeKey(r, c, Orientation.V))) return true
                    Dir.RIGHT -> if (extra.contains(edgeKey(r, c + 1, Orientation.V))) return true
                }
            }
            return isMoveBlocked(r, c, dir)
        }
        val seen = HashSet<String>()
        seen += "${p.row},${p.col}"
        val queue = ArrayDeque<Triple<Int, Int, Int>>()
        queue += Triple(p.row, p.col, 0)
        while (queue.isNotEmpty()) {
            val (r, c, d) = queue.removeFirst()
            if (r == goal) return d
            for ((dir, dd) in DIRS) {
                val nr = r + dd.first
                val nc = c + dd.second
                if (nr !in 0 until gridSize || nc !in 0 until gridSize) continue
                if (blockedAt(r, c, dir)) continue
                val key = "$nr,$nc"
                if (seen.contains(key)) continue
                seen += key
                queue += Triple(nr, nc, d + 1)
            }
        }
        return null
    }

    /** Next direction along a shortest path to the goal, or null. */
    fun nextStepTowardGoal(playerId: String): Dir? {
        val p = getPlayer(playerId) ?: return null
        val goal = goalRow(p)
        val dist = HashMap<String, Int>()
        val queue = ArrayDeque<Pair<Int, Int>>()
        for (c in 0 until gridSize) {
            dist["$goal,$c"] = 0
            queue += goal to c
        }
        while (queue.isNotEmpty()) {
            val (r, c) = queue.removeFirst()
            val d = dist["$r,$c"]!!
            for ((dir, dd) in DIRS) {
                val nr = r + dd.first
                val nc = c + dd.second
                if (nr !in 0 until gridSize || nc !in 0 until gridSize) continue
                val rev = when (dir) {
                    Dir.UP -> Dir.DOWN
                    Dir.DOWN -> Dir.UP
                    Dir.LEFT -> Dir.RIGHT
                    Dir.RIGHT -> Dir.LEFT
                }
                if (isMoveBlocked(nr, nc, rev)) continue
                val key = "$nr,$nc"
                if (!dist.containsKey(key)) {
                    dist[key] = d + 1
                    queue += nr to nc
                }
            }
        }
        val here = dist["${p.row},${p.col}"] ?: return null
        if (here == 0) return null
        for ((dir, dd) in DIRS) {
            val nr = p.row + dd.first
            val nc = p.col + dd.second
            if (nr !in 0 until gridSize || nc !in 0 until gridSize) continue
            if (isMoveBlocked(p.row, p.col, dir)) continue
            if (players.any { q -> q.id != p.id && q.row == nr && q.col == nc }) continue
            if (dist["$nr,$nc"] == here - 1) return dir
        }
        return null
    }

    // -- validation ------------------------------------------------------------
    /** Validate a blockade without applying it. Returns an error code or null. */
    fun validatePlace(playerId: String, edge: Edge): String? {
        val p = getPlayer(playerId) ?: return "NOT_IN_MATCH"
        if (status != MatchStatus.PLAYING) return "INVALID_BLOCKADE"
        if (edge.len < 1 || edge.len > MAX_BLOCKADE_LEN) return "INVALID_BLOCKADE"
        if (p.placeCooldownMs > 0) return "ON_COOLDOWN"
        if (blockades.count { it.playerId == playerId } >= MAX_BLOCKADES_PER_PLAYER) return "INVALID_BLOCKADE"
        if (blockadeCost(edge.len) > p.energy) return "NO_ENERGY"
        val singles = edgesForBlockade(edge)
        for (s in singles) {
            if (edge.orientation == Orientation.H) {
                if (s.row < 1 || s.row >= gridSize || s.col < 0 || s.col >= gridSize) return "INVALID_BLOCKADE"
            } else {
                if (s.row < 0 || s.row >= gridSize || s.col < 1 || s.col >= gridSize) return "INVALID_BLOCKADE"
            }
            if (blocked.contains(edgeKey(s.row, s.col, s.orientation))) return "INVALID_BLOCKADE"
        }
        // BFS fairness: both players must keep a path to their goal.
        val extra = singles.map { edgeKey(it.row, it.col, it.orientation) }.toSet()
        for (q in players) {
            if (shortestPathLength(q.id, extra) == null) return "NO_PATH"
        }
        return null
    }

    // -- actions -----------------------------------------------------------------
    fun move(playerId: String, dir: Dir): EngineResult {
        val p = getPlayer(playerId) ?: return EngineResult.Err("NOT_IN_MATCH", "player not in match")
        if (status != MatchStatus.PLAYING) return EngineResult.Err("INVALID_MOVE", "match not playing")
        if (p.moveCooldownMs > 0) return EngineResult.Err("ON_COOLDOWN", "move on cooldown")
        val d = DIRS[dir]!!
        val nr = p.row + d.first
        val nc = p.col + d.second
        fun collide(message: String): EngineResult {
            record(listOf(DeltaEvent.Collide(playerId, p.row, p.col, tickCount)))
            return EngineResult.Err("INVALID_MOVE", message)
        }
        if (nr !in 0 until gridSize || nc !in 0 until gridSize) return collide("move leaves the grid")
        if (isMoveBlocked(p.row, p.col, dir)) return collide("move crosses a blockade")
        if (players.any { q -> q.id != p.id && q.row == nr && q.col == nc }) return collide("cell occupied by opponent")
        p.anim = MoveAnim(p.row, p.col, nr, nc, tickCount, MOVE_ANIM_MS)
        p.row = nr
        p.col = nc
        p.moves++
        p.moveCooldownMs = MOVE_COOLDOWN_MS
        val events: List<DeltaEvent> = listOf(DeltaEvent.Move(playerId, nr, nc, tickCount))
        record(events)
        if (nr == goalRow(p)) finish(p.id, WinReason.GOAL)
        return EngineResult.Ok(events)
    }

    /** Inputs during the move cooldown are BUFFERED (latest wins) and applied
     *  by tick() when the cooldown ends — holding a direction glides smoothly. */
    fun tryMove(playerId: String, dir: Dir): TryMoveResult {
        val p = getPlayer(playerId) ?: return TryMoveResult.Err("NOT_IN_MATCH", "player not in match")
        if (status != MatchStatus.PLAYING) return TryMoveResult.Err("NOT_IN_MATCH", "match not playing")
        if (p.moveCooldownMs > 0) {
            p.bufferedDir = dir
            return TryMoveResult.Buffered
        }
        return when (val res = move(playerId, dir)) {
            is EngineResult.Ok -> TryMoveResult.Ok
            is EngineResult.Err -> TryMoveResult.Err(res.code, res.message)
        }
    }

    fun place(playerId: String, edge: Edge): EngineResult {
        val err = validatePlace(playerId, edge)
        if (err != null) {
            val message = when (err) {
                "NO_PATH" -> "placement would leave a player with no path to their goal"
                "NO_ENERGY" -> "not enough energy"
                "ON_COOLDOWN" -> "placement on cooldown"
                else -> "invalid blockade placement"
            }
            return EngineResult.Err(err, message)
        }
        val p = getPlayer(playerId)!!
        val singles = edgesForBlockade(edge).map { it.copy(len = 1) }
        val blockade = BlockadeState(
            id = "b${++blockadeSeq}_$tickCount",
            playerId = playerId,
            edges = singles,
            createdTick = tickCount,
            placedTick = tickCount,
            deployDurationMs = DEPLOY_MS,
        )
        for (s in singles) blocked.add(edgeKey(s.row, s.col, s.orientation))
        blockades += blockade
        p.energy -= blockadeCost(edge.len)
        p.placeCooldownMs = PLACE_COOLDOWN_MS
        p.blockadesPlaced++
        val events: List<DeltaEvent> = listOf(
            DeltaEvent.Blockade(blockade),
            DeltaEvent.Energy(playerId, p.energy.toInt()),
        )
        record(events)
        return EngineResult.Ok(events)
    }

    fun tryPlace(playerId: String, edge: Edge): TryPlaceResult {
        return when (val res = place(playerId, edge)) {
            is EngineResult.Ok -> {
                val b = res.events.filterIsInstance<DeltaEvent.Blockade>().firstOrNull()?.blockade
                    ?: return TryPlaceResult.Err("INVALID_BLOCKADE", "placement produced no blockade")
                TryPlaceResult.Ok(b)
            }
            is EngineResult.Err -> TryPlaceResult.Err(res.code, res.message)
        }
    }

    /** Button placement: nearest valid blockade ahead of the player in `dir`. */
    fun placeAuto(playerId: String, dir: Dir, orientation: Orientation, len: Int): EngineResult {
        val p = getPlayer(playerId) ?: return EngineResult.Err("NOT_IN_MATCH", "player not in match")
        val n = gridSize
        for (d in 0 until n) {
            val anchors = mutableListOf<Edge>()
            if (orientation == Orientation.H) {
                val row = when (dir) {
                    Dir.UP -> p.row - d
                    Dir.DOWN -> p.row + 1 + d
                    else -> p.row
                }
                if (dir == Dir.LEFT || dir == Dir.RIGHT) {
                    if (d > 0) break
                }
                val base = p.col - (len - 1) / 2
                for (shift in 0 until n) {
                    val shifts = if (shift == 0) listOf(0) else listOf(shift, -shift)
                    for (s in shifts) anchors += Edge(row, base + s, Orientation.H, len)
                }
            } else {
                val col = when (dir) {
                    Dir.LEFT -> p.col - d
                    Dir.RIGHT -> p.col + 1 + d
                    else -> p.col
                }
                if (dir == Dir.UP || dir == Dir.DOWN) {
                    if (d > 0) break
                }
                val base = p.row - (len - 1) / 2
                for (shift in 0 until n) {
                    val shifts = if (shift == 0) listOf(0) else listOf(shift, -shift)
                    for (s in shifts) anchors += Edge(base + s, col, Orientation.V, len)
                }
            }
            for (edge in anchors) {
                if (validatePlace(playerId, edge) == null) return place(playerId, edge)
            }
        }
        return EngineResult.Err("INVALID_BLOCKADE", "no valid placement ahead")
    }

    fun tryPlaceAuto(playerId: String, dir: Dir, orientation: Orientation, len: Int): TryPlaceResult {
        return when (val res = placeAuto(playerId, dir, orientation, len)) {
            is EngineResult.Ok -> {
                val b = res.events.filterIsInstance<DeltaEvent.Blockade>().firstOrNull()?.blockade
                    ?: return TryPlaceResult.Err("INVALID_BLOCKADE", "placement produced no blockade")
                TryPlaceResult.Ok(b)
            }
            is EngineResult.Err -> TryPlaceResult.Err(res.code, res.message)
        }
    }

    // -- simulation ---------------------------------------------------------------
    /** Advance the simulation by dtMs (server ticks at 50ms; local client per frame). */
    fun tickMs(dtMs: Long): List<DeltaEvent> {
        if (status != MatchStatus.PLAYING) return emptyList()
        tickCount++
        clockMs += dtMs
        elapsedMs += dtMs
        timeLeftMs = maxOf(0L, durationSec * 1000L - elapsedMs)
        val ownEvents = mutableListOf<DeltaEvent>()
        val moveEvents = mutableListOf<DeltaEvent>()
        for (p in players) {
            p.moveCooldownMs = maxOf(0L, p.moveCooldownMs - dtMs)
            p.placeCooldownMs = maxOf(0L, p.placeCooldownMs - dtMs)
            val before = p.energy
            p.energy = minOf(MAX_ENERGY.toDouble(), p.energy + ENERGY_REGEN_PER_SEC * dtMs / 1000.0)
            if (p.energy.toInt() != before.toInt()) {
                ownEvents += DeltaEvent.Energy(p.id, p.energy.toInt())
            }
        }
        for (p in players) {
            if (p.bufferedDir != null && p.moveCooldownMs <= 0) {
                val dir = p.bufferedDir!!
                p.bufferedDir = null
                val res = move(p.id, dir)
                if (res is EngineResult.Ok) moveEvents += res.events
                if (status != MatchStatus.PLAYING) break
            }
        }
        if (timeLeftMs <= 0) {
            finishByTimeout()
            ownEvents += DeltaEvent.Timer(0)
        } else {
            ownEvents += DeltaEvent.Timer(timeLeftMs)
        }
        record(ownEvents)
        return moveEvents + ownEvents
    }

    private fun finish(winnerId: String?, reason: WinReason) {
        status = MatchStatus.FINISHED
        this.winnerId = winnerId
        winReason = reason
        val secsLeft = (timeLeftMs / 1000).toInt()
        val events = mutableListOf<DeltaEvent>()
        events += DeltaEvent.Win(winnerId, reason, tickCount)
        for (p in players) {
            val outcome = if (winnerId == null) "draw" else if (p.id == winnerId) "win" else "loss"
            p.score = scoreForOutcome(outcome, if (outcome == "win") secsLeft else 0)
            events += DeltaEvent.Score(p.id, p.score)
        }
        record(events)
    }

    private fun finishByTimeout() {
        if (players.size < 2) {
            finish(players.firstOrNull()?.id, WinReason.TIMEOUT)
            return
        }
        val a = players[0]
        val b = players[1]
        val ra = rowsRemaining(a)
        val rb = rowsRemaining(b)
        if (ra == rb) finish(null, WinReason.DRAW)
        else finish(if (ra < rb) a.id else b.id, WinReason.TIMEOUT)
    }

    fun forfeit(playerId: String) {
        if (status != MatchStatus.PLAYING) return
        val other = players.find { it.id != playerId }
        finish(other?.id, WinReason.FORFEIT)
    }

    // -- animation helpers (render-facing) ---------------------------------------
    /** Interpolated orb position at engine tick [atTick] (default: current).
     *  Fractional cell coordinates, eased with easeOutCubic — the orb glides
     *  from the old cell to the new one and NEVER teleports. */
    fun interpolatedPosition(
        playerId: String,
        atTick: Long = tickCount,
    ): Triple<Float, Float, Boolean> {
        val p = getPlayer(playerId) ?: return Triple(0f, 0f, false)
        val anim = p.anim ?: return Triple(p.row.toFloat(), p.col.toFloat(), false)
        val raw = ((atTick - anim.startTick) * 50).toFloat() / MOVE_ANIM_MS
        if (raw >= 1f) return Triple(p.row.toFloat(), p.col.toFloat(), false)
        val t = easeOutCubic(raw)
        return Triple(
            anim.fromRow + (anim.toRow - anim.fromRow) * t,
            anim.fromCol + (anim.toCol - anim.fromCol) * t,
            true,
        )
    }

    /** Grow-in progress (0..1, eased) of a blockade at engine tick [atTick]. */
    fun blockadeDeployProgress(blockade: BlockadeState, atTick: Long = tickCount): Float {
        val placedTick = blockade.placedTick ?: blockade.createdTick
        val durationMs = blockade.deployDurationMs ?: DEPLOY_MS
        return easeOutCubic(((atTick - placedTick) * 50).toFloat() / durationMs)
    }

    // -- snapshots ------------------------------------------------------------------
    internal fun playerState(p: PlayerInternal): PlayerState {
        var animOut: MoveAnim? = null
        val anim = p.anim
        if (anim != null) {
            val done = (tickCount - anim.startTick) * 50 >= MOVE_ANIM_MS
            if (!done) {
                animOut = MoveAnim(anim.fromRow, anim.fromCol, anim.toRow, anim.toCol, anim.startTick, MOVE_ANIM_MS)
            }
        }
        return PlayerState(
            id = p.id, name = p.name, color = p.color,
            row = p.row, col = p.col,
            energy = p.energy.toInt(),
            moveCooldownMs = p.moveCooldownMs,
            placeCooldownMs = p.placeCooldownMs,
            score = p.score,
            progress = progress(p),
            anim = animOut,
        )
    }

    fun snapshot(): Snapshot = Snapshot(
        tick = tickCount,
        status = status,
        mode = mode,
        gridSize = gridSize,
        durationSec = durationSec,
        timeLeftMs = timeLeftMs,
        players = players.map { playerState(it) },
        blockades = blockades.map { it.copy(edges = it.edges.map { e -> e.copy() }) },
        winnerId = winnerId,
    )

    fun stats(): Map<String, PlayerStats> {
        val out = HashMap<String, PlayerStats>()
        for (p in players) out[p.id] = PlayerStats(p.moves, p.blockadesPlaced)
        return out
    }

    fun durationMs(): Long = elapsedMs
}

/** Validate a blockade against a bare snapshot (no engine instance) — used
 *  by the drag preview so the green/red indicator is honest for online
 *  matches too. Same rules as GameEngine.validatePlace. */
fun validateEdgeAgainstSnapshot(snap: Snapshot, playerId: String, edge: Edge): String? {
    val p = snap.players.find { it.id == playerId } ?: return "NOT_IN_MATCH"
    if (snap.status != MatchStatus.PLAYING) return "INVALID_BLOCKADE"
    if (edge.len < 1 || edge.len > MAX_BLOCKADE_LEN) return "INVALID_BLOCKADE"
    if (p.placeCooldownMs > 0) return "ON_COOLDOWN"
    if (snap.blockades.count { it.playerId == playerId } >= MAX_BLOCKADES_PER_PLAYER) return "INVALID_BLOCKADE"
    if (blockadeCost(edge.len) > p.energy) return "NO_ENERGY"
    val n = snap.gridSize
    val blocked = HashSet<String>()
    for (b in snap.blockades) for (e in b.edges) blocked += edgeKey(e.row, e.col, e.orientation)
    val singles = edgesForBlockade(edge)
    for (s in singles) {
        if (s.orientation == Orientation.H) {
            if (s.row < 1 || s.row >= n || s.col < 0 || s.col >= n) return "INVALID_BLOCKADE"
        } else {
            if (s.row < 0 || s.row >= n || s.col < 1 || s.col >= n) return "INVALID_BLOCKADE"
        }
        if (blocked.contains(edgeKey(s.row, s.col, s.orientation))) return "INVALID_BLOCKADE"
    }
    val extra = singles.map { edgeKey(it.row, it.col, it.orientation) }.toSet()
    for (q in snap.players) {
        val goal = if (q.color == PlayerColor.BLUE) 0 else n - 1
        if (bfsFromSnapshot(n, blocked + extra, q.row, q.col, goal) == null) return "NO_PATH"
    }
    return null
}

private fun bfsFromSnapshot(n: Int, blocked: Set<String>, sr: Int, sc: Int, goal: Int): Int? {
    val seen = HashSet<String>()
    seen += "$sr,$sc"
    val queue = ArrayDeque<Triple<Int, Int, Int>>()
    queue += Triple(sr, sc, 0)
    fun isBlocked(r: Int, c: Int, dir: Dir): Boolean = when (dir) {
        Dir.UP -> blocked.contains(edgeKey(r, c, Orientation.H))
        Dir.DOWN -> blocked.contains(edgeKey(r + 1, c, Orientation.H))
        Dir.LEFT -> blocked.contains(edgeKey(r, c, Orientation.V))
        Dir.RIGHT -> blocked.contains(edgeKey(r, c + 1, Orientation.V))
    }
    while (queue.isNotEmpty()) {
        val (r, c, d) = queue.removeFirst()
        if (r == goal) return d
        for ((dir, dd) in DIRS) {
            val nr = r + dd.first
            val nc = c + dd.second
            if (nr !in 0 until n || nc !in 0 until n) continue
            if (isBlocked(r, c, dir)) continue
            val key = "$nr,$nc"
            if (seen.contains(key)) continue
            seen += key
            queue += Triple(nr, nc, d + 1)
        }
    }
    return null
}
