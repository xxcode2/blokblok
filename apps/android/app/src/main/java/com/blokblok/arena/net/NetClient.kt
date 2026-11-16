package com.blokblok.arena.net

// BLOCKADE ARENA — Ktor WebSocket client for the authoritative server.
// Mirrors apps/web/src/net.ts exactly: hello, createRoom, joinRoom, queue,
// ready, start, input (move/place/placeAuto), ping, reconnect.
// Auto-reconnects with the session token if the socket drops mid-match
// (up to 6 attempts, exponential backoff 1s → 8s).

import com.blokblok.arena.game.Dir
import com.blokblok.arena.game.Edge
import com.blokblok.arena.game.Orientation
import com.blokblok.arena.game.PROTOCOL_VERSION
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

interface NetHandlers {
    fun onMessage(msg: ServerMessage)
    fun onOpen()
    /** `inMatch` is true when we held a reconnect token (match in progress). */
    fun onClose(inMatch: Boolean)
    fun onError(e: Throwable)
}

private const val PING_INTERVAL_MS = 2000L
private const val RECONNECT_MAX_ATTEMPTS = 6

class NetClient(
    val url: String,
    private val scope: CoroutineScope,
) {
    var playerId: String? = null
        private set
    var token: String? = null
        private set
    var roomCode: String? = null
        private set
    var roomId: String? = null
        private set
    var latencyMs: Long? = null
        private set
    var inMatch: Boolean = false
        private set

    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val http = HttpClient(OkHttp) {
        install(WebSockets) {
            pingIntervalMillis = 20_000
            maxFrameSize = Long.MAX_VALUE
        }
    }

    private var socketJob: Job? = null
    private var pingJob: Job? = null
    private var seq = 0L
    private var handlers: NetHandlers? = null
    private var helloName = "Player"
    private var reconnectAttempts = 0
    private var manualClose = false
    @Volatile
    private var sendSession: io.ktor.client.plugins.websocket.DefaultClientWebSocketSession? = null

    /** Connect (or reconnect) the socket. Resolves true once the socket is open. */
    suspend fun connect(name: String, handlers: NetHandlers): Boolean {
        this.handlers = handlers
        this.helloName = name
        this.manualClose = false
        this.reconnectAttempts = 0
        return openSocket(isReconnect = false)
    }

    private suspend fun openSocket(isReconnect: Boolean): Boolean {
        return try {
            socketJob?.cancel()
            socketJob = scope.launch {
                try {
                    http.webSocket(urlString = url) {
                        sendSession = this
                        _connected.value = true
                        handlers?.onOpen()
                        startPing()
                        if (isReconnect && token != null) {
                            sendRaw(ClientMessage.Reconnect(token!!))
                        } else {
                            sendRaw(ClientMessage.Hello(helloName, PROTOCOL_VERSION))
                        }
                        for (frame in incoming) {
                            if (frame is Frame.Text) handleRaw(frame.readText())
                        }
                    }
                } catch (e: Exception) {
                    handlers?.onError(e)
                } finally {
                    sendSession = null
                    _connected.value = false
                    stopPing()
                    handleClose()
                }
            }
            // Wait briefly for the socket to come up (openSocket is async).
            var waited = 0
            while (!_connected.value && waited < 5000) {
                delay(50)
                waited += 50
            }
            _connected.value
        } catch (e: Exception) {
            handlers?.onError(e)
            false
        }
    }

    private fun handleRaw(data: String) {
        val msg = parseServerMessage(data) ?: return
        when (msg) {
            is ServerMessage.Welcome -> playerId = msg.playerId
            is ServerMessage.RoomCreated, is ServerMessage.MatchFound -> {
                val code = if (msg is ServerMessage.RoomCreated) msg.roomCode else (msg as ServerMessage.MatchFound).roomCode
                val id = if (msg is ServerMessage.RoomCreated) msg.roomId else (msg as ServerMessage.MatchFound).roomId
                val tok = if (msg is ServerMessage.RoomCreated) msg.token else (msg as ServerMessage.MatchFound).token
                token = tok
                roomId = id
                roomCode = code
                inMatch = true
            }
            is ServerMessage.RoomJoined -> {
                roomId = msg.roomId
                roomCode = msg.roomCode
                inMatch = true
            }
            is ServerMessage.Pong -> {
                latencyMs = maxOf(0L, System.currentTimeMillis() - msg.t)
                return // latency is consumed here, not forwarded
            }
            is ServerMessage.Reconnected -> reconnectAttempts = 0
            else -> Unit
        }
        handlers?.onMessage(msg)
    }

    private fun handleClose() {
        val hadMatch = inMatch && token != null
        handlers?.onClose(hadMatch)
        if (hadMatch && !manualClose && reconnectAttempts < RECONNECT_MAX_ATTEMPTS) {
            val delayMs = minOf(8000L, 1000L * (1L shl reconnectAttempts))
            reconnectAttempts++
            scope.launch {
                delay(delayMs)
                if (!manualClose && scope.isActive) openSocket(isReconnect = true)
            }
        }
    }

    private fun startPing() {
        stopPing()
        pingJob = scope.launch {
            while (isActive) {
                delay(PING_INTERVAL_MS)
                sendRaw(ClientMessage.Ping(System.currentTimeMillis()))
            }
        }
    }

    private fun stopPing() {
        pingJob?.cancel()
        pingJob = null
    }

    /** Leave the current room/match and close the socket (no auto-reconnect). */
    fun disconnect() {
        manualClose = true
        inMatch = false
        token = null
        stopPing()
        scope.launch {
            try {
                sendSession?.close(CloseReason(CloseReason.Codes.NORMAL, "leave"))
            } catch (_: Exception) {
            }
        }
        socketJob?.cancel()
        sendSession = null
        _connected.value = false
    }

    fun close() {
        disconnect()
        http.close()
    }

    private suspend fun sendRaw(msg: ClientMessage) {
        val session = sendSession ?: return
        try {
            session.send(Frame.Text(encodeClientMessage(msg)))
        } catch (_: Exception) {
        }
    }

    fun send(msg: ClientMessage) {
        scope.launch { sendRaw(msg) }
    }

    fun createRoom(gridSize: Int, durationSec: Int) {
        send(ClientMessage.CreateRoom(com.blokblok.arena.game.GameMode.RACE, gridSize, durationSec))
    }

    fun joinRoom(roomCode: String) {
        send(ClientMessage.JoinRoom(roomCode.trim().uppercase()))
    }

    fun queue(gridSize: Int) {
        send(ClientMessage.Queue(com.blokblok.arena.game.GameMode.RACE, gridSize))
    }

    fun leaveQueue() {
        send(ClientMessage.LeaveQueue)
    }

    fun setReady(ready: Boolean) {
        send(ClientMessage.Ready(ready))
    }

    fun start() {
        send(ClientMessage.Start)
    }

    fun inputMove(dir: Dir) {
        send(ClientMessage.InputMove(++seq, dir))
    }

    fun inputPlace(edge: Edge) {
        send(ClientMessage.InputPlace(++seq, edge))
    }

    fun inputPlaceAuto(dir: Dir, orientation: Orientation, len: Int) {
        send(ClientMessage.InputPlaceAuto(++seq, dir, orientation, len))
    }
}

/** Apply server delta events to a snapshot copy (client-side state tracking). */
fun applyDeltaToSnapshot(snap: com.blokblok.arena.game.Snapshot, events: List<com.blokblok.arena.game.DeltaEvent>): com.blokblok.arena.game.Snapshot {
    var next = snap.copy(
        players = snap.players.map { it.copy() },
        blockades = snap.blockades.toList(),
    )
    for (e in events) {
        when (e) {
            is com.blokblok.arena.game.DeltaEvent.Move -> {
                next = next.copy(
                    players = next.players.map { if (it.id == e.playerId) it.copy(row = e.row, col = e.col) else it },
                    tick = maxOf(next.tick, e.tick),
                )
            }
            is com.blokblok.arena.game.DeltaEvent.Blockade -> {
                if (next.blockades.none { it.id == e.blockade.id }) {
                    next = next.copy(blockades = next.blockades + e.blockade)
                }
            }
            is com.blokblok.arena.game.DeltaEvent.Energy -> {
                next = next.copy(
                    players = next.players.map { if (it.id == e.playerId) it.copy(energy = e.energy) else it },
                )
            }
            is com.blokblok.arena.game.DeltaEvent.Timer -> {
                next = next.copy(timeLeftMs = e.timeLeftMs)
            }
            is com.blokblok.arena.game.DeltaEvent.Score -> {
                next = next.copy(
                    players = next.players.map { if (it.id == e.playerId) it.copy(score = e.score) else it },
                )
            }
            is com.blokblok.arena.game.DeltaEvent.Collide -> {
                // No state change — the renderer turns this into sparks + a thud.
            }
            is com.blokblok.arena.game.DeltaEvent.Win -> {
                next = next.copy(winnerId = e.winnerId, status = com.blokblok.arena.game.MatchStatus.FINISHED)
            }
        }
    }
    return next
}
