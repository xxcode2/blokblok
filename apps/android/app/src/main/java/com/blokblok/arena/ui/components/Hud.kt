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
import com.blokblok.arena.game.joystickDir
import com.blokblok.arena.ui.ConnectionState
import com.blokblok.arena.ui.theme.NeonBlue
import com.blokblok.arena.ui.theme.NeonCyan
import com.blokblok.arena.ui.theme.NeonRed
import com.blokblok.arena.ui.theme.TextPrimary
import com.blokblok.arena.ui.theme.TextSecondary
import kotlin.math.sqrt

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
    myName: String,
    myScore: Int,
    myEnergy: Int,
    myColor: Color,
    oppName: String,
    oppScore: Int,
    oppEnergy: Int,
    oppColor: Color,
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
            // Player 1 (me)
            Column(modifier = Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(12.dp).clip(CircleShape).background(myColor))
                    Spacer(Modifier.width(6.dp))
                    Text(myName, color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    Spacer(Modifier.width(8.dp))
                    Text("$myScore", color = myColor, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                }
                Spacer(Modifier.height(4.dp))
                LinearProgressIndicator(
                    progress = { myEnergy / 100f },
                    modifier = Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)),
                    color = myColor,
                    trackColor = Color(0xFF1E293B),
                )
                Text("Energy $myEnergy", color = TextSecondary, fontSize = 11.sp)
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
            // Player 2 (opponent)
            Column(modifier = Modifier.weight(1f), horizontalAlignment = Alignment.End) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("$oppScore", color = oppColor, fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    Spacer(Modifier.width(8.dp))
                    Text(oppName, color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                    Spacer(Modifier.width(6.dp))
                    Box(Modifier.size(12.dp).clip(CircleShape).background(oppColor))
                }
                Spacer(Modifier.height(4.dp))
                LinearProgressIndicator(
                    progress = { oppEnergy / 100f },
                    modifier = Modifier.fillMaxWidth().height(8.dp).clip(RoundedCornerShape(4.dp)),
                    color = oppColor,
                    trackColor = Color(0xFF1E293B),
                )
                Text("Energy $oppEnergy", color = TextSecondary, fontSize = 11.sp)
            }
        }
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
