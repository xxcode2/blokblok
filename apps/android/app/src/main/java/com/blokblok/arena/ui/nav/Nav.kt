package com.blokblok.arena.ui.nav

// Navigation routes for the whole app (Compose Navigation).

sealed class Route(val path: String) {
    data object Splash : Route("splash")
    data object Menu : Route("menu")
    data object Lobby : Route("lobby?kind={kind}&roomCode={roomCode}&difficulty={difficulty}") {
        fun build(kind: String, roomCode: String = "", difficulty: String = ""): String =
            "lobby?kind=$kind&roomCode=$roomCode&difficulty=$difficulty"
    }
    data object Game : Route("game")
    data object Results : Route("results")
    data object Settings : Route("settings")
}
