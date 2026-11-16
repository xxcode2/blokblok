package com.blokblok.arena.ui.theme

// BLOCKADE ARENA — dark graphite neon theme (matches the web client).

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val GraphiteBg = Color(0xFF0A0E14)
val GraphiteSurface = Color(0xFF11161D)
val GraphiteCard = Color(0xFF161D27)
val GraphiteBorder = Color(0xFF26303D)
val NeonCyan = Color(0xFF22D3EE)
val NeonBlue = Color(0xFF38BDF8)
val NeonRed = Color(0xFFF43F5E)
val NeonGreen = Color(0xFF22FF88)
/** Player 3 (trophy 4P): green #22c55e. Player 4: amber #f59e0b. */
val PlayerGreen = Color(0xFF22C55E)
val NeonAmber = Color(0xFFF59E0B)
val TextPrimary = Color(0xFFE2E8F0)
val TextSecondary = Color(0xFF94A3B8)

private val ArenaColors = darkColorScheme(
    primary = NeonCyan,
    secondary = NeonBlue,
    tertiary = NeonRed,
    background = GraphiteBg,
    surface = GraphiteSurface,
    surfaceVariant = GraphiteCard,
    onBackground = TextPrimary,
    onSurface = TextPrimary,
    onPrimary = Color(0xFF06202A),
    outline = GraphiteBorder,
)

@Composable
fun ArenaTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = ArenaColors,
        content = content,
    )
}
