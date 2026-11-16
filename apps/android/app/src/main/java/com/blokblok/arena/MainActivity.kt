package com.blokblok.arena

// BLOCKADE ARENA — entry point. No WebView anywhere; the whole UI is
// Jetpack Compose over the native Canvas renderer.

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import com.blokblok.arena.ui.GameViewModel
import com.blokblok.arena.ui.theme.ArenaTheme

class MainActivity : ComponentActivity() {
    private val gameViewModel: GameViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            ArenaTheme {
                ArenaApp(gameViewModel = gameViewModel)
            }
        }
    }
}
