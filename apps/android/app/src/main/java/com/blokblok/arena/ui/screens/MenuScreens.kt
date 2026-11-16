package com.blokblok.arena.ui.screens

// BLOCKADE ARENA — screens (Compose). Splash, Menu, Settings, Lobby.

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.blokblok.arena.data.ArenaSettings
import com.blokblok.arena.data.SettingsStore
import com.blokblok.arena.game.AiDifficulty
import com.blokblok.arena.ui.GameViewModel
import com.blokblok.arena.ui.MatchKind
import com.blokblok.arena.ui.theme.GraphiteCard
import com.blokblok.arena.ui.theme.NeonBlue
import com.blokblok.arena.ui.theme.NeonCyan
import com.blokblok.arena.ui.theme.NeonRed
import com.blokblok.arena.ui.theme.TextPrimary
import com.blokblok.arena.ui.theme.TextSecondary
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// ---------------------------------------------------------------------------
// Splash
// ---------------------------------------------------------------------------
@Composable
fun SplashScreen(onDone: () -> Unit) {
    LaunchedEffect(Unit) {
        delay(900)
        onDone()
    }
    Box(
        modifier = Modifier.fillMaxSize().background(Color(0xFF0A0E14)),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text("BLOCKADE", color = NeonCyan, fontSize = 44.sp, fontWeight = FontWeight.Black, letterSpacing = 6.sp)
            Text("ARENA", color = TextPrimary, fontSize = 44.sp, fontWeight = FontWeight.Black, letterSpacing = 14.sp)
            Spacer(Modifier.height(12.dp))
            Text("Race to the top. Block the way.", color = TextSecondary, fontSize = 14.sp)
            Spacer(Modifier.height(28.dp))
            CircularProgressIndicator(color = NeonCyan)
        }
    }
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------
@Composable
fun MenuScreen(
    settings: ArenaSettings,
    onPlayOnline: () -> Unit,
    onPrivateRoom: () -> Unit,
    onPractice: (AiDifficulty) -> Unit,
    onLocal2P: () -> Unit,
    onSettings: () -> Unit,
) {
    var showPracticePicker by remember { mutableStateOf(false) }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0A0E14))
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("BLOCKADE ARENA", color = NeonCyan, fontSize = 30.sp, fontWeight = FontWeight.Black)
        Text("Signed in as ${settings.playerName}", color = TextSecondary, fontSize = 13.sp)
        Spacer(Modifier.height(28.dp))

        MenuButton("Play Online", "Quick match vs a random opponent", NeonCyan) { onPlayOnline() }
        Spacer(Modifier.height(12.dp))
        MenuButton("Private Room", "Create or join with a room code", NeonBlue) { onPrivateRoom() }
        Spacer(Modifier.height(12.dp))
        MenuButton("Practice vs AI", "Offline — Easy / Normal / Hard", NeonBlue) { showPracticePicker = true }
        Spacer(Modifier.height(12.dp))
        MenuButton("Local 2P", "Two players, one device (offline)", NeonBlue) { onLocal2P() }
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = onSettings, modifier = Modifier.fillMaxWidth(0.85f)) {
            Text("Settings", color = TextPrimary)
        }

        if (showPracticePicker) {
            Spacer(Modifier.height(20.dp))
            Card(
                modifier = Modifier.fillMaxWidth(0.85f),
                colors = CardDefaults.cardColors(containerColor = GraphiteCard),
            ) {
                Column(Modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Choose AI difficulty", color = TextPrimary, fontWeight = FontWeight.Bold)
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (d in AiDifficulty.entries) {
                            Button(
                                onClick = { onPractice(d) },
                                colors = ButtonDefaults.buttonColors(containerColor = NeonCyan, contentColor = Color(0xFF06202A)),
                            ) { Text(d.name) }
                        }
                    }
                }
            }
        }

        Spacer(Modifier.height(28.dp))
        Text("v1.0.0 · Free & open source", color = TextSecondary, fontSize = 11.sp)
    }
}

@Composable
private fun MenuButton(title: String, subtitle: String, accent: Color, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(0.85f).height(64.dp),
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(containerColor = GraphiteCard, contentColor = TextPrimary),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Box(Modifier.size(10.dp).clip(RoundedCornerShape(5.dp)).background(accent))
            Spacer(Modifier.width(12.dp))
            Column {
                Text(title, fontWeight = FontWeight.Bold, fontSize = 17.sp)
                Text(subtitle, color = TextSecondary, fontSize = 12.sp)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
@Composable
fun SettingsScreen(store: SettingsStore, settings: ArenaSettings, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember(settings.playerName) { mutableStateOf(settings.playerName) }
    var serverUrl by remember(settings.serverUrl) { mutableStateOf(settings.serverUrl) }
    var gridSize by remember(settings.gridSize) { mutableStateOf(settings.gridSize.toString()) }
    var savedNote by remember { mutableStateOf("") }
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0A0E14))
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
    ) {
        Text("Settings", color = TextPrimary, fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(20.dp))

        OutlinedTextField(
            value = name, onValueChange = { name = it },
            label = { Text("Player name") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Spacer(Modifier.height(8.dp))
        Button(onClick = {
            scope.launch {
                store.setPlayerName(name.trim().ifBlank { "Player" })
                store.setServerUrl(serverUrl.trim())
                gridSize.toIntOrNull()?.let { store.setGridSize(it.coerceIn(9, 15)) }
                savedNote = "Saved — applies on the next match."
            }
        }) {
            Text("Save settings")
        }
        if (savedNote.isNotBlank()) {
            Spacer(Modifier.height(8.dp))
            Text(savedNote, color = NeonCyan, fontSize = 13.sp)
        }
        Spacer(Modifier.height(16.dp))

        OutlinedTextField(
            value = serverUrl, onValueChange = { serverUrl = it },
            label = { Text("Server URL (ws://host:3001)") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "Default 10.0.2.2:3001 reaches your PC's localhost from the Android emulator. " +
                "On a real device use your PC's LAN IP, e.g. ws://192.168.1.5:3001.",
            color = TextSecondary, fontSize = 12.sp,
        )
        Spacer(Modifier.height(16.dp))

        OutlinedTextField(
            value = gridSize, onValueChange = { gridSize = it.filter { c -> c.isDigit() } },
            label = { Text("Grid size (9–15)") },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )
        Spacer(Modifier.height(16.dp))

        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text("Sound effects", color = TextPrimary, modifier = Modifier.weight(1f))
            Switch(
                checked = settings.soundEnabled,
                onCheckedChange = { scope.launch { store.setSoundEnabled(it) } },
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
            Text("Haptics", color = TextPrimary, modifier = Modifier.weight(1f))
            Switch(
                checked = settings.hapticsEnabled,
                onCheckedChange = { scope.launch { store.setHapticsEnabled(it) } },
            )
        }
        Spacer(Modifier.height(24.dp))
        OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth()) {
            Text("Back to menu", color = TextPrimary)
        }
        Text(
            "Changes apply on the next match. Sound/haptics toggles are saved immediately.",
            color = TextSecondary, fontSize = 12.sp,
        )
    }
}

// ---------------------------------------------------------------------------
// Lobby (online only)
// ---------------------------------------------------------------------------
@Composable
fun LobbyScreen(
    vm: GameViewModel,
    isQueue: Boolean,
    onMatchStart: () -> Unit,
    onLeave: () -> Unit,
) {
    val players by vm.lobbyPlayers.collectAsState()
    val queuePos by vm.queuePosition.collectAsState()
    val countdown by vm.countdown.collectAsState()
    val roomCode by vm.roomCode.collectAsState()
    val myId by vm.myId.collectAsState()
    val error by vm.error.collectAsState()
    val snapshot by vm.snapshot.collectAsState()
    val clipboard = LocalClipboardManager.current

    LaunchedEffect(snapshot) {
        if (snapshot != null) onMatchStart()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0A0E14))
            .padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(if (isQueue) "Finding opponent…" else "Private Room", color = TextPrimary, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(8.dp))

        if (isQueue && queuePos != null) {
            Text("Position in queue: #$queuePos", color = NeonCyan, fontSize = 16.sp)
            Spacer(Modifier.height(8.dp))
            OutlinedButton(onClick = { vm.leaveQueue() }) { Text("Leave queue", color = TextPrimary) }
        }

        if (!roomCode.isNullOrBlank()) {
            Spacer(Modifier.height(8.dp))
            Text("ROOM CODE", color = TextSecondary, fontSize = 12.sp)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(roomCode!!, color = NeonCyan, fontSize = 36.sp, fontWeight = FontWeight.Black, letterSpacing = 8.sp)
                Spacer(Modifier.width(12.dp))
                OutlinedButton(onClick = { clipboard.setText(AnnotatedString(roomCode!!)) }) {
                    Text("Copy", color = TextPrimary)
                }
            }
            Text("Share this code — your opponent joins with it.", color = TextSecondary, fontSize = 12.sp)
        }

        Spacer(Modifier.height(20.dp))
        Text("Players", color = TextSecondary, fontSize = 13.sp)
        Spacer(Modifier.height(8.dp))
        for (p in players) {
            Card(
                modifier = Modifier.fillMaxWidth(0.85f).padding(vertical = 4.dp),
                colors = CardDefaults.cardColors(containerColor = GraphiteCard),
            ) {
                Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(12.dp).clip(RoundedCornerShape(6.dp))
                            .background(if (p.isHost) NeonCyan else NeonBlue),
                    )
                    Spacer(Modifier.width(10.dp))
                    Text(
                        p.name + if (p.id == myId) " (you)" else "",
                        color = TextPrimary, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f),
                    )
                    if (p.isHost) Text("HOST", color = TextSecondary, fontSize = 11.sp)
                    Spacer(Modifier.width(8.dp))
                    Text(if (p.ready) "READY" else "NOT READY", color = if (p.ready) NeonCyan else NeonRed, fontSize = 12.sp)
                }
            }
        }

        if (players.size < 2) {
            Text("Waiting for an opponent to join…", color = TextSecondary, fontSize = 13.sp)
        }

        Spacer(Modifier.height(20.dp))
        val me = players.find { it.id == myId }
        if (me != null && !isQueue) {
            OutlinedButton(onClick = { vm.setReady(!me.ready) }, modifier = Modifier.fillMaxWidth(0.85f)) {
                Text(if (me.ready) "Cancel ready" else "I'm ready", color = TextPrimary)
            }
            Spacer(Modifier.height(8.dp))
            if (me.isHost && players.size >= 2 && players.all { it.ready }) {
                Button(
                    onClick = { vm.startOnlineMatch() },
                    modifier = Modifier.fillMaxWidth(0.85f),
                    colors = ButtonDefaults.buttonColors(containerColor = NeonCyan, contentColor = Color(0xFF06202A)),
                ) { Text("Start match", fontWeight = FontWeight.Bold) }
            }
        }

        countdown?.let {
            Spacer(Modifier.height(16.dp))
            Text("Starting in $it…", color = NeonCyan, fontSize = 28.sp, fontWeight = FontWeight.Bold)
        }
        error?.let {
            Spacer(Modifier.height(16.dp))
            Text(it, color = NeonRed, fontSize = 13.sp)
        }

        Spacer(Modifier.weight(1f))
        OutlinedButton(onClick = onLeave, modifier = Modifier.fillMaxWidth(0.85f)) {
            Text("Leave lobby", color = TextPrimary)
        }
    }
}
