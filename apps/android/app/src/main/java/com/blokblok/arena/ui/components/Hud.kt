package com.blokblok.arena.ui.components

// BLOCKADE ARENA — HUD (energy bar, timer, scores, connection) and the
// virtual touch joystick. Both are pure Compose; the joystick reports a
// direction the moment it crosses its dead zone (spec §13).

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.blokblok.arena.game.Dir
import com.blokblok.arena.game.PlayerColor
import com.blokblok.arena.game.TURN_DURATION_MS
import com.blokblok.arena.game.joystickDir
import com.blokblok.arena.ui.ConnectionState
import com.blokblok.arena.ui.theme.NeonAmber
import com.blokblok.arena.ui.theme.NeonBlue
import com.blokblok.arena.ui.theme.NeonCyan
import com.blokblok.arena.ui.theme.NeonRed
import com.blokblok.arena.ui.theme.PlayerGreen
import com.blokblok.arena.ui.theme.TextPrimary
import com.blokblok.arena.ui.theme.TextSecondary
import kotlin.math.sqrt

/** Compose colour for a player colour (P1 blue, P2 red, P3 green #22c55e,
 *  P4 amber #f59e0b). */
fun playerColorCompose(color: PlayerColor): Color = when (color) {
    PlayerColor.BLUE -> NeonBlue
    PlayerColor.RED -> NeonRed
    PlayerColor.GREEN -> PlayerGreen
    PlayerColor.AMBER -> NeonAmber
}

/** One scoreboard row: name, score, energy, colour, seat label, active-turn flag. */
data class PlayerHudEntry(
    val name: String,
    val score: Int,
    val energy: Int,
    val color: PlayerColor,
    val label: String,
    val isActive: Boolean = false,
)

@Composable
fun ConnectionDot(state: ConnectionState, latencyMs: Long?) {
    val (color, label) = when (state) {
        ConnectionState.ONLINE -> NeonCyan to "Online${latencyMs?.let { " · ${it}ms" } ?: ""}"
        ConnectionState.CONNECTING -> Color(0xFFFBBF24) to "Connecting…"
        ConnectionState.RECONNECTING -> Color(0xFFFBBF24) to "Reconnecting…"
        ConnectionState.OFFLINE -> TextSecondary to "Offline"
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(color),
        )
        Spacer(Modifier.width(6.dp))
        Text(label, color = TextSecondary, fontSize = 12.sp)
    }
}

@Composable
fun Hud(
    players: List<PlayerHudEntry>,
    timeLeftMs: Long,
    connection: ConnectionState,
    latencyMs: Long?,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Scoreboard: one compact column per player (2 or 4).
            Row(modifier = Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                for (entry in players) {
                    val color = playerColorCompose(entry.color)
                    Column(modifier = Modifier.weight(1f)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier.size(12.dp).clip(CircleShape)
                                    .background(color),
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(
                                "${entry.label} ${entry.name}",
                                color = if (entry.isActive) TextPrimary else TextSecondary,
                                fontWeight = if (entry.isActive) FontWeight.Bold else FontWeight.Normal,
                                fontSize = 13.sp,
                            )
                            Spacer(Modifier.width(6.dp))
                            Text("${entry.score}", color = color, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                        }
                        Spacer(Modifier.height(4.dp))
                        LinearProgressIndicator(
                            progress = { entry.energy / 100f },
                            modifier = Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)),
                            color = color,
                            trackColor = Color(0xFF1E293B),
                        )
                        Text("Energy ${entry.energy}", color = TextSecondary, fontSize = 11.sp)
                    }
                }
            }
            // Timer
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(horizontal = 12.dp)) {
                val secs = (timeLeftMs / 1000).coerceAtLeast(0)
                Text(
                    "%d:%02d".format(secs / 60, secs % 60),
                    color = if (secs <= 30) NeonRed else TextPrimary,
                    fontWeight = FontWeight.Bold,
                    fontSize = 22.sp,
                )
                ConnectionDot(connection, latencyMs)
            }
        }
    }
}

/** Turn banner (protocol 1.1.0): whose turn it is + the turn number.
 *  [label] is e.g. "Giliran kamu", "Giliran lawan", or "Giliran P1".."Giliran P4"
 *  in local modes; [activeColor] is the active player's orb colour. */
@Composable
fun TurnBanner(
    label: String,
    turnNumber: Int,
    activeColor: Color,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(12.dp)
                .clip(CircleShape)
                .background(activeColor),
        )
        Spacer(Modifier.width(8.dp))
        Text(label, color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        Spacer(Modifier.width(8.dp))
        Text("Giliran ke-$turnNumber", color = TextSecondary, fontSize = 14.sp)
    }
}

/** Turn-timer bar: counts down the 30 s turn from [turnDeadlineMs] against
 *  the frame clock [nowMs]. Red under 5 s. When no deadline is known yet
 *  ([turnDeadlineMs] <= 0) the bar renders full with no countdown. */
@Composable
fun TurnTimerBar(
    turnDeadlineMs: Long,
    nowMs: Long,
    modifier: Modifier = Modifier,
) {
    val hasDeadline = turnDeadlineMs > 0L
    val remainingMs = if (hasDeadline) (turnDeadlineMs - nowMs).coerceAtLeast(0L) else TURN_DURATION_MS
    val fraction = (remainingMs.toFloat() / TURN_DURATION_MS).coerceIn(0f, 1f)
    val secs = (remainingMs + 999) / 1000 // ceil so the bar shows 30…1, never 0 early
    Row(
        modifier = modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LinearProgressIndicator(
            progress = { fraction },
            modifier = Modifier.weight(1f).height(6.dp).clip(RoundedCornerShape(3.dp)),
            color = if (remainingMs <= 5_000L) NeonRed else NeonCyan,
            trackColor = Color(0xFF1E293B),
        )
        Spacer(Modifier.width(8.dp))
        Text(
            if (hasDeadline) "${secs}s" else "—",
            color = if (remainingMs <= 5_000L) NeonRed else TextSecondary,
            fontWeight = FontWeight.Bold,
            fontSize = 12.sp,
        )
    }
}

/** Virtual joystick: drag anywhere inside the circle; crossing the dead zone
 *  fires [onDirection] once per direction change. Releasing re-centres. */
@Composable
fun Joystick(
    onDirection: (Dir) -> Unit,
    modifier: Modifier = Modifier,
) {
    var knob by remember { mutableStateOf(Offset.Zero) }
    var lastDir by remember { mutableStateOf<Dir?>(null) }
    val radius = 56.dp
    Box(
        modifier = modifier
            .size(radius * 2)
            .pointerInput(Unit) {
                detectDragGestures(
                    onDragStart = { knob = Offset.Zero },
                    onDragEnd = { knob = Offset.Zero; lastDir = null },
                    onDragCancel = { knob = Offset.Zero; lastDir = null },
                    onDrag = { change, dragAmount ->
                        change.consume()
                        val next = knob + dragAmount
                        val len = sqrt(next.x * next.x + next.y * next.y)
                        val max = 110f
                        knob = if (len > max) next * (max / len) else next
                        val dir = joystickDir(knob.x / max, knob.y / max)
                        if (dir != null && dir != lastDir) {
                            lastDir = dir
                            onDirection(dir)
                        }
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.size(radius * 2)) {
            drawCircle(Color(0xFF1E293B).copy(alpha = 0.85f), radius.toPx(), center)
            drawCircle(NeonBlue.copy(alpha = 0.25f), radius.toPx(), center, style = androidx.compose.ui.graphics.drawscope.Stroke(width = 3f))
            val knobPx = Offset(center.x + knob.x, center.y + knob.y)
            drawCircle(NeonBlue.copy(alpha = 0.35f), 34f, knobPx)
            drawCircle(NeonBlue, 28f, knobPx)
        }
    }
}
