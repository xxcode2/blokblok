package com.blokblok.arena.net

// BLOCKADE ARENA — WebSocket protocol (JSON text frames).
// Kotlin port of the DEVELOPMENT.md message table + packages/core/src/types.ts.
// The client sends inputs only; the server is authoritative and sends
// snapshots/deltas. Parsing is manual JsonObject mapping (no polymorphic
// serializer) so a single unknown field can never crash the client.

import com.blokblok.arena.game.BlockadeState
import com.blokblok.arena.game.DeltaEvent
import com.blokblok.arena.game.Dir
import com.blokblok.arena.game.Edge
import com.blokblok.arena.game.GameMode
import com.blokblok.arena.game.LobbyPlayer
import com.blokblok.arena.game.MatchStatus
import com.blokblok.arena.game.MoveAnim
import com.blokblok.arena.game.Orientation
import com.blokblok.arena.game.PlayerColor
import com.blokblok.arena.game.PlayerState
import com.blokblok.arena.game.PlayerStats
import com.blokblok.arena.game.Snapshot
import com.blokblok.arena.game.WinReason
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

private val json = Json { ignoreUnknownKeys = true }

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------
sealed interface ServerMessage {
    data class Welcome(val playerId: String, val serverVersion: String) : ServerMessage
    data class RoomCreated(val roomId: String, val roomCode: String, val token: String) : ServerMessage
    data class RoomJoined(
        val roomId: String,
        val roomCode: String,
        val mode: GameMode,
        val gridSize: Int,
        val durationSec: Int,
        val players: List<LobbyPlayer>,
    ) : ServerMessage
    data class LobbyUpdate(val players: List<LobbyPlayer>) : ServerMessage
    data class Queued(val position: Int) : ServerMessage
    data object QueueLeft : ServerMessage
    data class MatchFound(
        val roomId: String,
        val roomCode: String,
        val token: String,
        val opponent: LobbyPlayer,
    ) : ServerMessage
    data class Countdown(val seconds: Int) : ServerMessage
    data class MatchStart(val snapshot: Snapshot) : ServerMessage
    data class State(val tick: Long, val snapshot: Snapshot) : ServerMessage
    data class Delta(val tick: Long, val events: List<DeltaEvent>) : ServerMessage
    data class Result(
        val winnerId: String?,
        val reason: WinReason,
        val scores: Map<String, Int>,
        val stats: Map<String, PlayerStats>,
        val durationMs: Long,
    ) : ServerMessage
    data class OpponentLeft(val playerId: String) : ServerMessage
    data class Error(val code: String, val message: String) : ServerMessage
    data class Pong(val t: Long) : ServerMessage
    data class Reconnected(val snapshot: Snapshot) : ServerMessage
    /** Unknown / future message types are surfaced, never crashed on. */
    data class Unknown(val type: String, val raw: String) : ServerMessage
}

// ---------------------------------------------------------------------------
// Client -> Server (encoded with the same field names as the web client)
// ---------------------------------------------------------------------------
sealed interface ClientMessage {
    data class Hello(val name: String, val clientVersion: String) : ClientMessage
    data class CreateRoom(val mode: GameMode, val gridSize: Int, val durationSec: Int) : ClientMessage
    data class JoinRoom(val roomCode: String) : ClientMessage
    data class Queue(val mode: GameMode, val gridSize: Int) : ClientMessage
    data object LeaveQueue : ClientMessage
    data class Ready(val ready: Boolean) : ClientMessage
    data object Start : ClientMessage
    data class InputMove(val seq: Long, val dir: Dir) : ClientMessage
    data class InputPlace(val seq: Long, val edge: Edge) : ClientMessage
    data class InputPlaceAuto(val seq: Long, val dir: Dir, val orientation: Orientation, val len: Int) : ClientMessage
    data class Ping(val t: Long) : ClientMessage
    data class Reconnect(val token: String) : ClientMessage
}

fun encodeClientMessage(msg: ClientMessage): String {
    val obj = buildJsonObject {
        when (msg) {
            is ClientMessage.Hello -> {
                put("type", "hello")
                put("name", msg.name)
                put("clientVersion", msg.clientVersion)
            }
            is ClientMessage.CreateRoom -> {
                put("type", "createRoom")
                put("mode", "race")
                put("gridSize", msg.gridSize)
                put("durationSec", msg.durationSec)
            }
            is ClientMessage.JoinRoom -> {
                put("type", "joinRoom")
                put("roomCode", msg.roomCode)
            }
            is ClientMessage.Queue -> {
                put("type", "queue")
                put("mode", "race")
                put("gridSize", msg.gridSize)
            }
            is ClientMessage.LeaveQueue -> put("type", "leaveQueue")
            is ClientMessage.Ready -> {
                put("type", "ready")
                put("ready", msg.ready)
            }
            is ClientMessage.Start -> put("type", "start")
            is ClientMessage.InputMove -> {
                put("type", "input")
                put("seq", msg.seq)
                put("kind", "move")
                put("dir", msg.dir.name.lowercase())
            }
            is ClientMessage.InputPlace -> {
                put("type", "input")
                put("seq", msg.seq)
                put("kind", "place")
                put("edge", edgeJson(msg.edge))
            }
            is ClientMessage.InputPlaceAuto -> {
                put("type", "input")
                put("seq", msg.seq)
                put("kind", "placeAuto")
                put("dir", msg.dir.name.lowercase())
                put("orientation", msg.orientation.name.lowercase())
                put("len", msg.len)
            }
            is ClientMessage.Ping -> {
                put("type", "ping")
                put("t", msg.t)
            }
            is ClientMessage.Reconnect -> {
                put("type", "reconnect")
                put("token", msg.token)
            }
        }
    }
    return json.encodeToString(JsonObject.serializer(), obj)
}

private fun edgeJson(e: Edge): JsonObject = buildJsonObject {
    put("row", e.row)
    put("col", e.col)
    put("orientation", e.orientation.name.lowercase())
    put("len", e.len)
}

// ---------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------
private fun JsonObject.str(key: String): String = this[key]?.jsonPrimitive?.content ?: ""
private fun JsonObject.int(key: String, default: Int = 0): Int = this[key]?.jsonPrimitive?.intOrNull ?: default
private fun JsonObject.long(key: String, default: Long = 0L): Long =
    this[key]?.jsonPrimitive?.longOrNull ?: this[key]?.jsonPrimitive?.intOrNull?.toLong() ?: default
private fun JsonObject.bool(key: String, default: Boolean = false): Boolean =
    this[key]?.jsonPrimitive?.booleanOrNull ?: default
private fun JsonObject.obj(key: String): JsonObject? = this[key]?.jsonObject
private fun JsonObject.nullableStr(key: String): String? {
    val e = this[key] ?: return null
    if (e is kotlinx.serialization.json.JsonNull) return null
    return e.jsonPrimitive.contentOrNull
}
private fun JsonObject.arr(key: String): JsonArray? = this[key]?.jsonArray

private fun parseDir(s: String): Dir = when (s.lowercase()) {
    "up" -> Dir.UP
    "down" -> Dir.DOWN
    "left" -> Dir.LEFT
    "right" -> Dir.RIGHT
    else -> Dir.UP
}

private fun parseOrientation(s: String): Orientation = if (s.lowercase() == "v") Orientation.V else Orientation.H

private fun parseColor(s: String): PlayerColor = if (s.lowercase() == "red") PlayerColor.RED else PlayerColor.BLUE

private fun parseStatus(s: String): MatchStatus = when (s.lowercase()) {
    "lobby" -> MatchStatus.LOBBY
    "countdown" -> MatchStatus.COUNTDOWN
    "finished" -> MatchStatus.FINISHED
    else -> MatchStatus.PLAYING
}

private fun parseWinReason(s: String): WinReason = when (s.lowercase()) {
    "goal" -> WinReason.GOAL
    "timeout" -> WinReason.TIMEOUT
    "forfeit" -> WinReason.FORFEIT
    else -> WinReason.DRAW
}

private fun parseEdge(o: JsonObject): Edge = Edge(
    row = o.int("row"),
    col = o.int("col"),
    orientation = parseOrientation(o.str("orientation")),
    len = o.int("len", 1),
)

private fun parseMoveAnim(o: JsonObject?): MoveAnim? {
    if (o == null) return null
    return MoveAnim(
        fromRow = o.int("fromRow"),
        fromCol = o.int("fromCol"),
        toRow = o.int("toRow"),
        toCol = o.int("toCol"),
        startTick = o.long("startTick"),
        durationMs = o.long("durationMs", 150),
    )
}

private fun parsePlayer(o: JsonObject): PlayerState = PlayerState(
    id = o.str("id"),
    name = o.str("name"),
    color = parseColor(o.str("color")),
    row = o.int("row"),
    col = o.int("col"),
    energy = o.int("energy"),
    moveCooldownMs = o.long("moveCooldownMs"),
    placeCooldownMs = o.long("placeCooldownMs"),
    score = o.int("score"),
    progress = (o["progress"]?.jsonPrimitive?.content?.toFloatOrNull() ?: 0f),
    anim = parseMoveAnim(o.obj("anim")),
)

private fun parseBlockade(o: JsonObject): BlockadeState {
    val edges = o.arr("edges")?.map { parseEdge(it.jsonObject) } ?: emptyList()
    return BlockadeState(
        id = o.str("id"),
        playerId = o.str("playerId"),
        edges = edges,
        createdTick = o.long("createdTick"),
        placedTick = o["placedTick"]?.jsonPrimitive?.longOrNull,
        deployDurationMs = o["deployDurationMs"]?.jsonPrimitive?.longOrNull,
    )
}

private fun parseSnapshot(o: JsonObject): Snapshot = Snapshot(
    tick = o.long("tick"),
    status = parseStatus(o.str("status")),
    mode = GameMode.RACE,
    gridSize = o.int("gridSize", 12),
    durationSec = o.int("durationSec", 180),
    timeLeftMs = o.long("timeLeftMs"),
    players = o.arr("players")?.map { parsePlayer(it.jsonObject) } ?: emptyList(),
    blockades = o.arr("blockades")?.map { parseBlockade(it.jsonObject) } ?: emptyList(),
    winnerId = o.nullableStr("winnerId"),
)

private fun parseLobbyPlayer(o: JsonObject): LobbyPlayer = LobbyPlayer(
    id = o.str("id"),
    name = o.str("name"),
    ready = o.bool("ready"),
    isHost = o.bool("isHost"),
)

private fun parseDelta(e: JsonObject): DeltaEvent? {
    return when (e.str("k")) {
        "move" -> DeltaEvent.Move(e.str("playerId"), e.int("row"), e.int("col"), e.long("tick"))
        "blockade" -> e.obj("blockade")?.let { DeltaEvent.Blockade(parseBlockade(it)) }
        "energy" -> DeltaEvent.Energy(e.str("playerId"), e.int("energy"))
        "timer" -> DeltaEvent.Timer(e.long("timeLeftMs"))
        "score" -> DeltaEvent.Score(e.str("playerId"), e.int("score"))
        "collide" -> DeltaEvent.Collide(e.str("playerId"), e.int("row"), e.int("col"), e.long("tick"))
        "win" -> DeltaEvent.Win(
            e.nullableStr("winnerId"),
            parseWinReason(e.str("reason")),
            e.long("tick"),
        )
        else -> null
    }
}

/** Parse one server JSON frame. Returns null only if the frame is not JSON. */
fun parseServerMessage(text: String): ServerMessage? {
    val root = try {
        json.parseToJsonElement(text).jsonObject
    } catch (_: Exception) {
        return null
    }
    return when (val type = root.str("type")) {
        "welcome" -> ServerMessage.Welcome(root.str("playerId"), root.str("serverVersion"))
        "roomCreated" -> ServerMessage.RoomCreated(root.str("roomId"), root.str("roomCode"), root.str("token"))
        "roomJoined" -> ServerMessage.RoomJoined(
            root.str("roomId"), root.str("roomCode"), GameMode.RACE,
            root.int("gridSize", 12), root.int("durationSec", 180),
            root.arr("players")?.map { parseLobbyPlayer(it.jsonObject) } ?: emptyList(),
        )
        "lobbyUpdate" -> ServerMessage.LobbyUpdate(
            root.arr("players")?.map { parseLobbyPlayer(it.jsonObject) } ?: emptyList(),
        )
        "queued" -> ServerMessage.Queued(root.int("position"))
        "queueLeft" -> ServerMessage.QueueLeft
        "matchFound" -> ServerMessage.MatchFound(
            root.str("roomId"), root.str("roomCode"), root.str("token"),
            root.obj("opponent")?.let { parseLobbyPlayer(it) } ?: LobbyPlayer("", "Opponent", ready = true, isHost = false),
        )
        "countdown" -> ServerMessage.Countdown(root.int("seconds", 3))
        "matchStart" -> root.obj("snapshot")?.let { ServerMessage.MatchStart(parseSnapshot(it)) }
            ?: ServerMessage.Unknown(type, text)
        "state" -> root.obj("snapshot")?.let { ServerMessage.State(root.long("tick"), parseSnapshot(it)) }
            ?: ServerMessage.Unknown(type, text)
        "delta" -> ServerMessage.Delta(
            root.long("tick"),
            root.arr("events")?.mapNotNull { parseDelta(it.jsonObject) } ?: emptyList(),
        )
        "result" -> {
            val scores = HashMap<String, Int>()
            root.obj("scores")?.forEach { (k, v) -> scores[k] = v.jsonPrimitive.intOrNull ?: 0 }
            val stats = HashMap<String, PlayerStats>()
            root.obj("stats")?.forEach { (k, v) ->
                val o = v.jsonObject
                stats[k] = PlayerStats(o.int("moves"), o.int("blockades"))
            }
            ServerMessage.Result(
                root.nullableStr("winnerId"),
                parseWinReason(root.str("reason")),
                scores, stats, root.long("durationMs"),
            )
        }
        "opponentLeft" -> ServerMessage.OpponentLeft(root.str("playerId"))
        "error" -> ServerMessage.Error(root.str("code"), root.str("message"))
        "pong" -> ServerMessage.Pong(root.long("t"))
        "reconnected" -> root.obj("snapshot")?.let { ServerMessage.Reconnected(parseSnapshot(it)) }
            ?: ServerMessage.Unknown(type, text)
        else -> ServerMessage.Unknown(type, text)
    }
}

private val JsonPrimitive.contentOrNull: String?
    get() = if (isString) content else null
