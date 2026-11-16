package com.blokblok.arena.ui.screens

// BLOCKADE ARENA — results screen: winner, score, stats, rematch, menu.

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.blokblok.arena.game.WinReason
import com.blokblok.arena.ui.GameViewModel
import com.blokblok.arena.ui.theme.NeonCyan
import com.blokblok.arena.ui.theme.NeonRed
import com.blokblok.arena.ui.theme.TextPrimary
import com.blokblok.arena.ui.theme.TextSecondary

@Composable
fun ResultsScreen(
    vm: GameViewModel,
    onRematch: () -> Unit,
    onMenu: () -> Unit,
) {
    val result by vm.result.collectAsState()
    val snap by vm.snapshot.collectAsState()
    val myId by vm.myId.collectAsState()

    val winner = snap?.players?.find { it.id == result?.winnerId }
    val me = snap?.players?.find { it.id == myId }
    val foe = snap?.players?.find { it.id != myId }
    val iWon = result?.winnerId != null && result?.winnerId == myId
    val isDraw = result?.winnerId == null

    val title = when {
        isDraw -> "DRAW"
        iWon -> "YOU WIN!"
        else -> "YOU LOSE"
    }
    val titleColor = when {
        isDraw -> TextSecondary
        iWon -> NeonCyan
        else -> NeonRed
    }
    val reasonText = when (result?.reason) {
        WinReason.GOAL -> "${winner?.name ?: "Winner"} reached the goal row"
        WinReason.TROPHY -> "${winner?.name ?: "Winner"} captured the trophy"
        WinReason.TIMEOUT -> "Time ran out — closest to the target wins"
        WinReason.FORFEIT -> "Opponent left the match"
        WinReason.DRAW -> "Nobody reached the target in time"
        null -> ""
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0A0E14))
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, color = titleColor, fontSize = 40.sp, fontWeight = FontWeight.Black)
        Spacer(Modifier.height(8.dp))
        Text(reasonText, color = TextSecondary, fontSize = 14.sp)
        Spacer(Modifier.height(28.dp))

        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(me?.name ?: "You", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                Text("${me?.score ?: 0}", color = NeonCyan, fontSize = 36.sp, fontWeight = FontWeight.Black)
                Text("points", color = TextSecondary, fontSize = 12.sp)
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(foe?.name ?: "Opponent", color = TextPrimary, fontWeight = FontWeight.Bold, fontSize = 16.sp)
                Text("${foe?.score ?: 0}", color = NeonRed, fontSize = 36.sp, fontWeight = FontWeight.Black)
                Text("points", color = TextSecondary, fontSize = 12.sp)
            }
        }

        Spacer(Modifier.height(16.dp))
        val myStats = result?.stats?.get(myId)
        val foeStats = foe?.let { result?.stats?.get(it.id) }
        Text(
            "Blockades placed — you: ${myStats?.blockades ?: 0} · opponent: ${foeStats?.blockades ?: 0}",
            color = TextSecondary, fontSize = 13.sp,
        )
        result?.let {
            val secs = it.durationMs / 1000
            Text("Match length: ${secs / 60}:${"%02d".format(secs % 60)}", color = TextSecondary, fontSize = 13.sp)
        }

        Spacer(Modifier.height(32.dp))
        Button(
            onClick = onRematch,
            modifier = Modifier.fillMaxWidth(0.85f),
            colors = ButtonDefaults.buttonColors(containerColor = NeonCyan, contentColor = Color(0xFF06202A)),
        ) { Text("Rematch", fontWeight = FontWeight.Bold) }
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = onMenu, modifier = Modifier.fillMaxWidth(0.85f)) {
            Text("Back to menu", color = TextPrimary)
        }
    }
}
