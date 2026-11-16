package com.blokblok.arena

// BLOCKADE ARENA — navigation host + app-level wiring.
// Holds the pending match config, the SettingsStore, the SoundEngine, and
// saves finished matches to Room history. The GameViewModel is shared
// between Lobby / Game / Results so the match survives navigation.

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.blokblok.arena.data.ArenaDatabase
import com.blokblok.arena.data.ArenaSettings
import com.blokblok.arena.data.MatchRecord
import com.blokblok.arena.data.SettingsStore
import com.blokblok.arena.game.GameMode
import com.blokblok.arena.game.SoundEngine
import com.blokblok.arena.ui.GameViewModel
import com.blokblok.arena.ui.MatchConfig
import com.blokblok.arena.ui.MatchKind
import com.blokblok.arena.ui.nav.Route
import com.blokblok.arena.ui.screens.GameScreen
import com.blokblok.arena.ui.screens.LobbyScreen
import com.blokblok.arena.ui.screens.MenuScreen
import com.blokblok.arena.ui.screens.ResultsScreen
import com.blokblok.arena.ui.screens.SettingsScreen
import com.blokblok.arena.ui.screens.SplashScreen
import com.blokblok.arena.ui.theme.TextPrimary
import kotlinx.coroutines.launch

@Composable
fun ArenaApp(gameViewModel: GameViewModel) {
    val context = LocalContext.current
    val navController = rememberNavController()
    val store = remember { SettingsStore(context) }
    val settings by store.settings.collectAsState(initial = ArenaSettings())
    val sound = remember { SoundEngine() }
    val db = remember { ArenaDatabase.get(context) }

    LaunchedEffect(context) { sound.init(context) }
    LaunchedEffect(settings.soundEnabled) { sound.setMuted(!settings.soundEnabled) }

    var pendingConfig by remember { mutableStateOf<MatchConfig?>(null) }
    var showPrivateDialog by remember { mutableStateOf(false) }
    var joinCode by remember { mutableStateOf("") }
    // Mode / player count picked in the menu when "Private Room" was tapped.
    var privateMode by remember { mutableStateOf(GameMode.RACE) }
    var privatePlayerCount by remember { mutableStateOf(2) }

    // Save finished matches to history (once per result).
    val result by gameViewModel.result.collectAsState()
    val myId by gameViewModel.myId.collectAsState()
    LaunchedEffect(result) {
        val r = result ?: return@LaunchedEffect
        val snap = gameViewModel.snapshot.value ?: return@LaunchedEffect
        val foe = snap.players.find { it.id != myId }
        val outcome = when {
            r.winnerId == null -> "DRAW"
            r.winnerId == myId -> "WIN"
            else -> "LOSS"
        }
        launch {
            db.matchDao().insert(
                MatchRecord(
                    mode = (pendingConfig?.kind?.name ?: "ONLINE"),
                    opponentName = foe?.name ?: "Opponent",
                    result = outcome,
                    durationMs = r.durationMs,
                ),
            )
        }
    }

    NavHost(navController = navController, startDestination = Route.Splash.path) {
        composable(Route.Splash.path) {
            SplashScreen(onDone = {
                navController.navigate(Route.Menu.path) {
                    popUpTo(Route.Splash.path) { inclusive = true }
                }
            })
        }

        composable(Route.Menu.path) {
            MenuScreen(
                settings = settings,
                onPlayOnline = { mode, playerCount ->
                    pendingConfig = MatchConfig(
                        MatchKind.ONLINE_QUEUE, gridSize = settings.gridSize,
                        durationSec = settings.durationSec, mode = mode, playerCount = playerCount,
                    )
                    navController.navigate(Route.Lobby.build("queue"))
                },
                onPrivateRoom = { mode, playerCount ->
                    privateMode = mode
                    privatePlayerCount = playerCount
                    showPrivateDialog = true
                },
                onPractice = { difficulty, mode, playerCount ->
                    pendingConfig = MatchConfig(
                        MatchKind.PRACTICE, difficulty = difficulty, gridSize = settings.gridSize,
                        durationSec = settings.durationSec, mode = mode, playerCount = playerCount,
                    )
                    navController.navigate(Route.Game.path)
                },
                onLocal2P = {
                    pendingConfig = MatchConfig(MatchKind.LOCAL_2P, gridSize = settings.gridSize, durationSec = settings.durationSec)
                    navController.navigate(Route.Game.path)
                },
                onSettings = { navController.navigate(Route.Settings.path) },
            )
        }

        composable(
            route = Route.Lobby.path,
            arguments = listOf(
                navArgument("kind") { type = NavType.StringType; defaultValue = "queue" },
                navArgument("roomCode") { type = NavType.StringType; defaultValue = "" },
                navArgument("difficulty") { type = NavType.StringType; defaultValue = "" },
            ),
        ) { backStackEntry ->
            val kind = backStackEntry.arguments?.getString("kind") ?: "queue"
            val cfg = pendingConfig
            LaunchedEffect(cfg) {
                if (cfg != null) gameViewModel.startMatch(cfg, settings)
            }
            LobbyScreen(
                vm = gameViewModel,
                isQueue = kind == "queue",
                onMatchStart = {
                    navController.navigate(Route.Game.path) {
                        popUpTo(Route.Lobby.path) { inclusive = true }
                    }
                },
                onLeave = {
                    gameViewModel.leave()
                    navController.navigate(Route.Menu.path) {
                        popUpTo(Route.Menu.path) { inclusive = true }
                    }
                },
            )
        }

        composable(Route.Game.path) {
            val cfg = pendingConfig
            LaunchedEffect(cfg) {
                // Local modes start here; online modes were started in the lobby.
                if (cfg != null && (cfg.kind == MatchKind.PRACTICE || cfg.kind == MatchKind.LOCAL_2P)) {
                    gameViewModel.startMatch(cfg, settings)
                }
            }
            GameScreen(
                vm = gameViewModel,
                kind = cfg?.kind ?: MatchKind.PRACTICE,
                settings = settings,
                sound = sound,
                onMatchEnd = {
                    navController.navigate(Route.Results.path) {
                        popUpTo(Route.Game.path) { inclusive = true }
                    }
                },
                onQuit = {
                    gameViewModel.leave()
                    navController.navigate(Route.Menu.path) {
                        popUpTo(Route.Menu.path) { inclusive = true }
                    }
                },
            )
        }

        composable(Route.Results.path) {
            ResultsScreen(
                vm = gameViewModel,
                onRematch = {
                    val cfg = pendingConfig
                    if (cfg != null) {
                        // Online private rematch creates a FRESH room (the old
                        // code is spent); queue rematch just re-queues.
                        val rematchCfg = if (cfg.kind == MatchKind.ONLINE_PRIVATE) cfg.copy(roomCode = null) else cfg
                        pendingConfig = rematchCfg
                        gameViewModel.startMatch(rematchCfg, settings)
                        navController.navigate(Route.Game.path) {
                            popUpTo(Route.Results.path) { inclusive = true }
                        }
                    }
                },
                onMenu = {
                    gameViewModel.leave()
                    navController.navigate(Route.Menu.path) {
                        popUpTo(Route.Menu.path) { inclusive = true }
                    }
                },
            )
        }

        composable(Route.Settings.path) {
            SettingsScreen(
                store = store,
                settings = settings,
                onBack = { navController.popBackStack() },
            )
        }
    }

    if (showPrivateDialog) {
        AlertDialog(
            onDismissRequest = { showPrivateDialog = false },
            title = { Text("Private Room", color = TextPrimary) },
            text = {
                Column {
                    Text("Create a room and share the code, or join with a code.", color = TextPrimary)
                    Spacer(Modifier.height(12.dp))
                    OutlinedTextField(
                        value = joinCode,
                        onValueChange = { joinCode = it.uppercase().filter { c -> c.isLetterOrDigit() }.take(6) },
                        label = { Text("Room code (to join)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                Button(onClick = {
                    pendingConfig = MatchConfig(
                        MatchKind.ONLINE_PRIVATE,
                        gridSize = settings.gridSize,
                        durationSec = settings.durationSec,
                        roomCode = joinCode.ifBlank { null },
                        mode = privateMode,
                        playerCount = privatePlayerCount,
                    )
                    showPrivateDialog = false
                    joinCode = ""
                    navController.navigate(Route.Lobby.build("private"))
                }) {
                    Text(if (joinCode.isBlank()) "Create room" else "Join room")
                }
            },
            dismissButton = {
                OutlinedButton(onClick = { showPrivateDialog = false }) {
                    Text("Cancel", color = TextPrimary)
                }
            },
            containerColor = Color(0xFF161D27),
        )
    }
}
