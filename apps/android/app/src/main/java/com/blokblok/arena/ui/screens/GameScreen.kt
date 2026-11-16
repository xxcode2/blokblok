package com.blokblok.arena.ui.screens

// BLOCKADE ARENA — game screen.
//
// Rendering contract (spec §13, user quality bar):
// - ONE render loop driven by the display frame clock (withFrameNanos).
//   No timers, no Handler posts, no LaunchedEffect delays for animation.
// - The BoardRenderer owns all interpolation; this screen only feeds it the
//   latest snapshot and the frame timestamp.
// - Orbs glide 150 ms easeOutCubic between cells (renderer); blockades grow
//   in over 250 ms; particles burst on placement/collision/win.
// - Controls: virtual joystick (bottom-left) + swipe on the board to move;
//   drag on a grid edge to place a blockade (green/red preview + snap);
//   quick-place buttons (H/V) auto-place in front of you.
// - Local 2P: swipe starting on the top half of the board moves P2 (red),
//   bottom half moves P1 (blue); the joystick always drives P1.

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.blokblok.arena.data.ArenaSettings
import com.blokblok.arena.game.BoardRenderer
import com.blokblok.arena.game.Dir
import com.blokblok.arena.game.Edge
import com.blokblok.arena.game.Orientation
import com.blokblok.arena.game.PlayerColor
import com.blokblok.arena.game.Preview
import com.blokblok.arena.game.Sfx
import com.blokblok.arena.game.SoundEngine
import com.blokblok.arena.game.extendEdge
import com.blokblok.arena.game.pickEdge
import com.blokblok.arena.game.swipeDir
import com.blokblok.arena.game.validateEdgeAgainstSnapshot
import com.blokblok.arena.ui.GameViewModel
import com.blokblok.arena.ui.MatchKind
import com.blokblok.arena.ui.components.Hud
import com.blokblok.arena.ui.components.Joystick
import com.blokblok.arena.ui.theme.NeonBlue
import com.blokblok.arena.ui.theme.NeonCyan
import com.blokblok.arena.ui.theme.NeonRed
import com.blokblok.arena.ui.theme.TextSecondary
import kotlinx.coroutines.isActive
import androidx.compose.runtime.withFrameNanos

private enum class DragMode { NONE, BLOCKADE, SWIPE }

@Composable
fun GameScreen(
    vm: GameViewModel,
    kind: MatchKind,
    settings: ArenaSettings,
    sound: SoundEngine,
    onMatchEnd: () -> Unit,
    onQuit: () -> Unit,
) {
    val snap by vm.snapshot.collectAsState()
    val connection by vm.connection.collectAsState()
    val result by vm.result.collectAsState()
    val myId by vm.myId.collectAsState()
    val error by vm.error.collectAsState()
    val countdown by vm.countdown.collectAsState()
    val haptics = LocalHapticFeedback.current
    val renderer = remember { BoardRenderer() }

    // Landscape gameplay: lock orientation while this screen is alive.
    val activity = LocalContext.current as? android.app.Activity
    DisposableEffect(Unit) {
        activity?.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        onDispose {
            activity?.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    // Frame clock: the single source of time for all animation.
    var frameNowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
    var lastFrameMs by remember { mutableLongStateOf(frameNowMs) }
    LaunchedEffect(Unit) {
        while (isActive) {
            withFrameNanos { nanos ->
                lastFrameMs = frameNowMs
                frameNowMs = nanos / 1_000_000
            }
        }
    }

    // Optimistic glide on local prediction.
    LaunchedEffect(vm) {
        vm.onPredictedMove = { playerId, dir ->
            val s = vm.snapshot.value
            val p = s?.players?.find { it.id == playerId }
            if (s != null && p != null) {
                val (r, c) = when (dir) {
                    Dir.UP -> p.row - 1 to p.col
                    Dir.DOWN -> p.row + 1 to p.col
                    Dir.LEFT -> p.row to p.col - 1
                    Dir.RIGHT -> p.row to p.col + 1
                }
                renderer.startGlide(playerId, r, c, System.currentTimeMillis())
            }
        }
    }

    // Feed authoritative snapshots into the renderer (starts glides/bursts).
    LaunchedEffect(snap) {
        snap?.let { renderer.setSnapshot(it, System.currentTimeMillis()) }
    }

    // Result → results screen + win sound.
    LaunchedEffect(result) {
        if (result != null) {
            sound.play(Sfx.WIN)
            onMatchEnd()
        }
    }

    // Sound effects from snapshot changes: my moves, new blockades.
    var prevBlockades by remember { mutableStateOf(0) }
    var prevMyCell by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    LaunchedEffect(snap) {
        val s = snap ?: return@LaunchedEffect
        if (s.blockades.size > prevBlockades) sound.play(Sfx.PLACE)
        prevBlockades = s.blockades.size
        val meNow = s.players.find { it.id == myId }
        if (meNow != null) {
            val cell = meNow.row to meNow.col
            if (prevMyCell != null && prevMyCell != cell) sound.play(Sfx.MOVE)
            prevMyCell = cell
        }
    }

    // Drag state (blockade preview / swipe).
    var preview by remember { mutableStateOf<Preview?>(null) }
    var dragMode by remember { mutableStateOf(DragMode.NONE) }
    var dragStartEdge by remember { mutableStateOf<Edge?>(null) }
    var swipeFired by remember { mutableStateOf(false) }
    var swipeStart by remember { mutableStateOf(Offset.Zero) }
    var swipeAccum by remember { mutableStateOf(Offset.Zero) }

    val me = snap?.players?.find { it.id == myId }
    val foe = snap?.players?.find { it.id != myId }
    val myColor = if (me?.color == PlayerColor.RED) NeonRed else NeonBlue
    val foeColor = if (foe?.color == PlayerColor.RED) NeonRed else NeonBlue

    Column(
        modifier = Modifier.fillMaxSize().background(Color(0xFF0A0E14)),
    ) {
        // HUD
        Hud(
            myName = me?.name ?: settings.playerName,
            myScore = me?.score ?: 0,
            myEnergy = me?.energy ?: 100,
            myColor = myColor,
            oppName = foe?.name ?: "Opponent",
            oppScore = foe?.score ?: 0,
            oppEnergy = foe?.energy ?: 100,
            oppColor = foeColor,
            timeLeftMs = snap?.timeLeftMs ?: 0,
            connection = connection,
            latencyMs = null,
        )
        // Cooldown chips.
        Row(modifier = Modifier.padding(horizontal = 12.dp)) {
            val moveCd = me?.moveCooldownMs ?: 0
            val placeCd = me?.placeCooldownMs ?: 0
            if (placeCd > 0) {
                Text("Place ready in ${(placeCd + 99) / 1000}s", color = TextSecondary, fontSize = 12.sp)
                Spacer(Modifier.width(16.dp))
            }
            if (moveCd > 0) {
                Text("Move cooling down…", color = TextSecondary, fontSize = 12.sp)
            }
        }

        // Board area.
        BoxWithConstraints(modifier = Modifier.weight(1f).fillMaxSize()) {
            val density = LocalDensity.current
            val boardPx = with(density) { minOf(maxWidth, maxHeight).toPx() }
            val gridSize = snap?.gridSize ?: settings.gridSize
            LaunchedEffect(boardPx, gridSize) {
                renderer.resize(boardPx, gridSize)
            }
            val boardDp = with(density) { boardPx.toDp() }
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                val currentSnap = snap
                if (currentSnap != null) {
                    Canvas(
                        modifier = Modifier
                            .size(boardDp)
                            .pointerInput(currentSnap.gridSize, kind) {
                                detectDragGestures(
                                    onDragStart = { offset ->
                                        val (fx, fy) = renderer.pointToCell(offset.x, offset.y)
                                        val edge = pickEdge(fx, fy, currentSnap.gridSize)
                                        if (edge != null) {
                                            dragMode = DragMode.BLOCKADE
                                            dragStartEdge = edge
                                            val valid = validateEdgeAgainstSnapshot(currentSnap, myId ?: "", edge) == null
                                            preview = Preview(edge, valid = valid)
                                        } else {
                                            dragMode = DragMode.SWIPE
                                            swipeFired = false
                                            swipeStart = offset
                                            swipeAccum = Offset.Zero
                                        }
                                    },
                                    onDrag = { change, dragAmount ->
                                        change.consume()
                                        when (dragMode) {
                                            DragMode.BLOCKADE -> {
                                                val start = dragStartEdge ?: return@detectDragGestures
                                                val (fx, fy) = renderer.pointToCell(change.position.x, change.position.y)
                                                val extended = extendEdge(start, fx, fy)
                                                val valid = validateEdgeAgainstSnapshot(currentSnap, myId ?: "", extended) == null
                                                preview = Preview(extended, valid = valid)
                                            }
                                            DragMode.SWIPE -> {
                                                swipeAccum += dragAmount
                                                if (!swipeFired) {
                                                    val dir = swipeDir(swipeAccum.x, swipeAccum.y)
                                                    if (dir != null) {
                                                        swipeFired = true
                                                        // Local 2P: top half of the board drives P2.
                                                        val targetId = if (kind == MatchKind.LOCAL_2P && swipeStart.y < boardPx / 2) {
                                                            foe?.id
                                                        } else null
                                                        vm.move(dir, targetId)
                                                    }
                                                }
                                            }
                                            DragMode.NONE -> Unit
                                        }
                                    },
                                    onDragEnd = {
                                        if (dragMode == DragMode.BLOCKADE) {
                                            val p = preview
                                            if (p != null && p.valid) {
                                                vm.place(p.edge)
                                                if (settings.hapticsEnabled) {
                                                    haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                                }
                                            }
                                        }
                                        preview = null
                                        dragMode = DragMode.NONE
                                        dragStartEdge = null
                                    },
                                    onDragCancel = {
                                        preview = null
                                        dragMode = DragMode.NONE
                                        dragStartEdge = null
                                    },
                                )
                            },
                    ) {
                        val dt = (frameNowMs - lastFrameMs).coerceIn(0, 100)
                        renderer.draw(this, currentSnap, frameNowMs, dt, preview)
                    }
                } else {
                    // Waiting for match start.
                    Text("Waiting for the match to start…", color = TextSecondary, fontSize = 15.sp)
                }

                // Countdown overlay.
                if (countdown != null) {
                    Text(
                        "$countdown",
                        color = NeonCyan,
                        fontSize = 72.sp,
                        fontWeight = FontWeight.Black,
                    )
                }
            }
        }

        // Bottom controls: joystick + quick-place.
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Joystick(onDirection = { dir -> vm.move(dir) })
            Spacer(Modifier.weight(1f))
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Quick place", color = TextSecondary, fontSize = 11.sp)
                Row {
                    Button(
                        onClick = { vm.placeAuto(Dir.UP, Orientation.H, 2) },
                        colors = ButtonDefaults.buttonColors(containerColor = NeonCyan, contentColor = Color(0xFF06202A)),
                    ) { Text("━ H", fontWeight = FontWeight.Bold) }
                    Spacer(Modifier.width(8.dp))
                    Button(
                        onClick = { vm.placeAuto(Dir.UP, Orientation.V, 2) },
                        colors = ButtonDefaults.buttonColors(containerColor = NeonCyan, contentColor = Color(0xFF06202A)),
                    ) { Text("┃ V", fontWeight = FontWeight.Bold) }
                }
                Text("auto-places in front of you", color = TextSecondary, fontSize = 10.sp)
            }
        }

        error?.let {
            Text(it, color = NeonRed, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 16.dp))
        }
        Row(modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)) {
            Button(onClick = onQuit) { Text("Quit match") }
        }
    }
}
