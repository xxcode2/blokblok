package com.blokblok.arena.ui

// BLOCKADE ARENA — match state machine (ViewModel).
// Owns the NetClient (online) or a local GameEngine (practice / local 2P),
// exposes a single Snapshot flow the screen renders every frame.
// Inputs go through here so online + offline share one control path.

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.blokblok.arena.data.ArenaSettings
import com.blokblok.arena.game.AiDifficulty
import com.blokblok.arena.game.Dir
import com.blokblok.arena.game.Edge
import com.blokblok.arena.game.EngineResult
import com.blokblok.arena.game.ERR_NOT_YOUR_TURN
import com.blokblok.arena.game.GameEngine
import com.blokblok.arena.game.GameMode
import com.blokblok.arena.game.LobbyPlayer
import com.blokblok.arena.game.MatchStatus
import com.blokblok.arena.game.Orientation
import com.blokblok.arena.game.PlayerStats
import com.blokblok.arena.game.Snapshot
import com.blokblok.arena.game.WinReason
import com.blokblok.arena.game.chooseAiAction
import com.blokblok.arena.game.AiAction
import com.blokblok.arena.net.NetClient
import com.blokblok.arena.net.NetHandlers
import com.blokblok.arena.net.ServerMessage
import com.blokblok.arena.net.applyDeltaToSnapshot
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

enum class MatchKind { ONLINE_PRIVATE, ONLINE_QUEUE, PRACTICE, LOCAL_2P }

data class MatchConfig(
    val kind: MatchKind,
    val difficulty: AiDifficulty? = null,
    val gridSize: Int = 12,
    val durationSec: Int = 180,
    val roomCode: String? = null,
)

enum class ConnectionState { CONNECTING, ONLINE, RECONNECTING, OFFLINE }

class GameViewModel : ViewModel() {
    private val _snapshot = MutableStateFlow<Snapshot?>(null)
    val snapshot: StateFlow<Snapshot?> = _snapshot.asStateFlow()

    private val _connection = MutableStateFlow(ConnectionState.OFFLINE)
    val connection: StateFlow<ConnectionState> = _connection.asStateFlow()

    private val _lobbyPlayers = MutableStateFlow<List<LobbyPlayer>>(emptyList())
    val lobbyPlayers: StateFlow<List<LobbyPlayer>> = _lobbyPlayers.asStateFlow()

    private val _countdown = MutableStateFlow<Int?>(null)
    val countdown: StateFlow<Int?> = _countdown.asStateFlow()

    private val _result = MutableStateFlow<ServerMessage.Result?>(null)
    val result: StateFlow<ServerMessage.Result?> = _result.asStateFlow()

    private val _queuePosition = MutableStateFlow<Int?>(null)
    val queuePosition: StateFlow<Int?> = _queuePosition.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _roomCode = MutableStateFlow<String?>(null)
    val roomCode: StateFlow<String?> = _roomCode.asStateFlow()

    private val _myId = MutableStateFlow<String?>(null)
    val myId: StateFlow<String?> = _myId.asStateFlow()

    private var net: NetClient? = null
    private var engine: GameEngine? = null
    private var config: MatchConfig? = null
    private var localJob: Job? = null
    /** One-shot pending AI action for the current AI turn (see startLocal). */
    private var aiPending: Job? = null
    /** Turn number the AI has already acted on (prevents double actions). */
    private var lastAiTurn: Int = 0
    private var myLocalId: String = "p1"
    private var localPlayer2Id: String = "p2"

    /** Called by the screen when the user makes a move (for optimistic glide). */
    var onPredictedMove: ((playerId: String, dir: Dir) -> Unit)? = null

    fun startMatch(cfg: MatchConfig, settings: ArenaSettings) {
        config = cfg
        _result.value = null
        _error.value = null
        _snapshot.value = null
        when (cfg.kind) {
            MatchKind.PRACTICE, MatchKind.LOCAL_2P -> startLocal(cfg, settings)
            MatchKind.ONLINE_PRIVATE, MatchKind.ONLINE_QUEUE -> startOnline(cfg, settings)
        }
    }

    // ------------------------------------------------------------------
    // Local modes (offline): engine + tick loop + AI
    // ------------------------------------------------------------------
    private fun startLocal(cfg: MatchConfig, settings: ArenaSettings) {
        _connection.value = ConnectionState.OFFLINE
        val eng = GameEngine(
            gridSize = cfg.gridSize,
            durationSec = cfg.durationSec,
            mode = GameMode.RACE,
        )
        eng.addPlayer("p1", settings.playerName)
        eng.addPlayer(
            "p2",
            if (cfg.kind == MatchKind.PRACTICE) "AI (${cfg.difficulty?.name ?: "NORMAL"})" else "Player 2",
        )
        eng.start(System.currentTimeMillis())
        engine = eng
        val ids = eng.snapshot().players.map { it.id }
        myLocalId = ids.getOrNull(0) ?: "p1"
        localPlayer2Id = ids.getOrNull(1) ?: "p2"
        _myId.value = myLocalId
        _snapshot.value = eng.snapshot()
        _lobbyPlayers.value = listOf(
            LobbyPlayer(myLocalId, settings.playerName, ready = true, isHost = true),
            LobbyPlayer(localPlayer2Id, eng.snapshot().players[1].name, ready = true, isHost = false),
        )
        localJob?.cancel()
        aiPending?.cancel()
        lastAiTurn = 0
        localJob = viewModelScope.launch {
            while (isActive) {
                delay(50)
                val now = System.currentTimeMillis()
                // tickAt (not tickMs): the engine needs the wall clock for
                // the 30 s turn deadline / timeout auto-pass.
                eng.tickAt(now)
                val snap = eng.snapshot()
                _snapshot.value = snap
                // Turn-based AI: act ONCE per AI turn, ~500 ms after the
                // turn starts. The engine + chooseAiAction both reject
                // off-turn actions, so a stale/mis-fired job is a no-op.
                if (cfg.kind == MatchKind.PRACTICE && cfg.difficulty != null &&
                    snap.status == MatchStatus.PLAYING &&
                    snap.activePlayerId == localPlayer2Id &&
                    snap.turnNumber != lastAiTurn
                ) {
                    lastAiTurn = snap.turnNumber
                    aiPending?.cancel()
                    aiPending = viewModelScope.launch {
                        delay(500)
                        val cur = _snapshot.value ?: return@launch
                        if (cur.status != MatchStatus.PLAYING) return@launch
                        if (cur.activePlayerId != localPlayer2Id) return@launch
                        if (cur.turnNumber != lastAiTurn) return@launch
                        val engNow = engine ?: return@launch
                        val action = chooseAiAction(engNow, localPlayer2Id, cfg.difficulty)
                        when (action) {
                            is AiAction.Move -> engNow.move(localPlayer2Id, action.dir)
                            is AiAction.Place -> engNow.place(localPlayer2Id, action.edge)
                            null -> Unit
                        }
                    }
                }
                if (snap.status == MatchStatus.FINISHED) {
                    finishLocal(snap)
                    break
                }
            }
        }
    }

    private fun finishLocal(snap: Snapshot) {
        val scores = snap.players.associate { it.id to it.score }
        val engStats = engine?.stats()
        val stats = snap.players.associate {
            it.id to (engStats?.get(it.id) ?: PlayerStats(
                moves = 0,
                blockades = snap.blockades.count { b -> b.playerId == it.id },
            ))
        }
        _result.value = ServerMessage.Result(
            winnerId = snap.winnerId,
            reason = if (snap.winnerId == null) WinReason.DRAW
                else if (snap.timeLeftMs <= 0) WinReason.TIMEOUT else WinReason.GOAL,
            scores = scores,
            stats = stats,
            durationMs = (snap.durationSec * 1000L) - snap.timeLeftMs,
        )
    }

    // ------------------------------------------------------------------
    // Online mode: Ktor WebSocket client
    // ------------------------------------------------------------------
    private fun startOnline(cfg: MatchConfig, settings: ArenaSettings) {
        _connection.value = ConnectionState.CONNECTING
        val client = NetClient(settings.serverUrl, viewModelScope)
        net = client
        viewModelScope.launch {
            val ok = client.connect(settings.playerName, object : NetHandlers {
                override fun onMessage(msg: ServerMessage) = handleServerMessage(msg, cfg)
                override fun onOpen() {
                    _connection.value = ConnectionState.ONLINE
                    _error.value = null
                }
                override fun onClose(inMatch: Boolean) {
                    _connection.value = if (inMatch) ConnectionState.RECONNECTING else ConnectionState.OFFLINE
                }
                override fun onError(e: Throwable) {
                    _error.value = e.message ?: e.toString()
                }
            })
            if (!ok) {
                _connection.value = ConnectionState.OFFLINE
                _error.value = "Could not reach the server at ${settings.serverUrl}. Check the URL in Settings or play Practice offline."
            }
        }
    }

    private fun handleServerMessage(msg: ServerMessage, cfg: MatchConfig) {
        when (msg) {
            is ServerMessage.Welcome -> {
                _myId.value = msg.playerId
                when (cfg.kind) {
                    MatchKind.ONLINE_PRIVATE -> {
                        if (cfg.roomCode.isNullOrBlank()) {
                            net?.createRoom(cfg.gridSize, cfg.durationSec)
                        } else {
                            net?.joinRoom(cfg.roomCode)
                        }
                    }
                    MatchKind.ONLINE_QUEUE -> net?.queue(cfg.gridSize)
                    else -> Unit
                }
            }
            is ServerMessage.RoomCreated -> {
                _roomCode.value = msg.roomCode
            }
            is ServerMessage.RoomJoined -> {
                _roomCode.value = msg.roomCode
                _lobbyPlayers.value = msg.players
            }
            is ServerMessage.LobbyUpdate -> {
                _lobbyPlayers.value = msg.players
            }
            is ServerMessage.Queued -> {
                _queuePosition.value = msg.position
            }
            is ServerMessage.QueueLeft -> {
                _queuePosition.value = null
            }
            is ServerMessage.MatchFound -> {
                _roomCode.value = msg.roomCode
                _queuePosition.value = null
            }
            is ServerMessage.Countdown -> {
                _countdown.value = msg.seconds
            }
            is ServerMessage.MatchStart -> {
                _countdown.value = null
                _snapshot.value = msg.snapshot
            }
            is ServerMessage.State -> {
                _snapshot.value = msg.snapshot
            }
            is ServerMessage.Delta -> {
                val cur = _snapshot.value
                if (cur != null) _snapshot.value = applyDeltaToSnapshot(cur, msg.events)
            }
            is ServerMessage.Result -> {
                _result.value = msg
            }
            is ServerMessage.OpponentLeft -> {
                _error.value = "Opponent left the match."
            }
            is ServerMessage.Error -> {
                // NOT_YOUR_TURN (protocol 1.1.0): the server rejected an
                // off-turn input — surface it plainly, it is not fatal.
                _error.value = if (msg.code == ERR_NOT_YOUR_TURN) {
                    "Bukan giliranmu — tunggu giliran berikutnya."
                } else {
                    msg.message
                }
            }
            is ServerMessage.Pong -> Unit
            is ServerMessage.Reconnected -> {
                _snapshot.value = msg.snapshot
                _connection.value = ConnectionState.ONLINE
            }
            is ServerMessage.Unknown -> Unit
        }
    }

    // ------------------------------------------------------------------
    // Inputs (shared path for online + local)
    // ------------------------------------------------------------------
    /** Move the local player (or P1 in local 2P). Returns false if blocked. */
    fun move(dir: Dir, playerId: String? = null) {
        val target = playerId ?: myLocalId
        val eng = engine
        if (eng != null) {
            // Turn-based: exactly one action per turn; an off-turn or
            // illegal move is rejected by the engine and the turn does NOT
            // pass. Only glide optimistically when the move was accepted.
            val res = eng.move(target, dir)
            if (res is EngineResult.Ok) onPredictedMove?.invoke(target, dir)
            return
        }
        net?.inputMove(dir)
        onPredictedMove?.invoke(_myId.value ?: "", dir)
    }

    fun place(edge: Edge, playerId: String? = null) {
        val target = playerId ?: myLocalId
        val eng = engine
        if (eng != null) {
            eng.place(target, edge)
            return
        }
        net?.inputPlace(edge)
    }

    fun placeAuto(dir: Dir, orientation: Orientation, len: Int, playerId: String? = null) {
        val eng = engine
        if (eng != null) {
            // Local modes: quick-place acts for the player whose turn it is.
            val target = playerId ?: eng.snapshot().activePlayerId.ifBlank { myLocalId }
            eng.placeAuto(target, dir, orientation, len)
            return
        }
        net?.inputPlaceAuto(dir, orientation, len)
    }

    fun setReady(ready: Boolean) {
        net?.setReady(ready)
    }

    fun startOnlineMatch() {
        net?.start()
    }

    fun leaveQueue() {
        net?.leaveQueue()
        _queuePosition.value = null
    }

    fun leave() {
        localJob?.cancel()
        aiPending?.cancel()
        net?.disconnect()
        net = null
        engine = null
    }

    override fun onCleared() {
        leave()
        super.onCleared()
    }
}
