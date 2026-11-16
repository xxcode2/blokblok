# BLOCKADE ARENA — Native Android Client

Native Kotlin + Jetpack Compose client for BLOCKADE ARENA. **No WebView anywhere** —
the game renders on a native Canvas (`BoardRenderer`), and the rules are a Kotlin
port of `packages/core` so Practice vs AI and Local 2P work fully offline.

> ⚠️ **Build status — read this first**
>
> **No APK was produced in this workspace.** This VM has no Java and no Android
> SDK, so the project could not be compiled here. The Gradle project is complete
> and written to build, but it has **not** been verified by a compiler run —
> that includes the protocol 1.3.0 revision (2026-11-17): no points system
> anywhere + hard 10-blockade cap per player per match. The code was
> verified statically only (brace balance, cross-file symbol checks,
> protocol-string checks — see the track report).
> Build it on a machine with Android Studio (or JDK 17 + Android SDK) with:
>
> ```bash
> cp local.properties.example local.properties   # then set sdk.dir to your SDK
> ./gradlew assembleDebug
> ```
>
> The debug APK lands at `app/build/outputs/apk/debug/app-debug.apk`.
> Install it with `adb install app/build/outputs/apk/debug/app-debug.apk`.
> Animation smoothness (60 fps target, 150 ms eased glides, 250 ms blockade
> deploy) is structured into the code but was **not** verified on a device here.

## What it does

| Screen | What happens |
| --- | --- |
| Splash | Logo + tagline, ~0.9 s, then menu. |
| Main Menu | Play Online (quick match), Private Room (create/join by code), Practice vs AI (Easy/Normal/Hard), Local 2P (one device, offline), Settings. Mode picker: Race to the Top (2P) or Rebut Piala (trophy, 2P or 4P). |
| Lobby (online) | Room code (copyable), player slots, ready toggle, host starts when all are ready, countdown. Queue shows your position. |
| Game | Native Canvas board, HUD (energy bars, blockade counts, timer, connection dot), virtual joystick + swipe to move, drag on grid edges to place blockades (green/red validity preview + snap), quick-place H/V buttons, haptics, synthesized SoundPool effects. Landscape while playing. |
| Results | Winner, reason, match stats (moves, blockades placed), match length, Rematch / Back to menu. Match history is saved to Room. |
| Settings | Player name, server URL, grid size, sound + haptics toggles (DataStore). |

## How it plays

- **Race to the Top** (same rules as `GAME_RULES.md`): blue starts bottom-centre,
  red starts top-centre; first to the opposite goal row wins. Turn-based:
  one action per turn (move 1 cell OR place 1 blockade), 30 s per turn with
  auto-pass, +10 energy at the start of your turn, 180 s timer (timeout →
  closer player wins). **No points system** (protocol 1.3.0): matches are
  win/lose/draw only — no scores anywhere, in the engine, the wire format,
  the HUD, or the results screen.
- **Rebut Piala / Trophy mode** (since protocol 1.2.0): a gold trophy sits on the
  centre cell `floor(n/2), floor(n/2)` — 12×12 → (6,6), 20×20 → (10,10).
  First player to land on it wins immediately (reason `trophy`). 2 or 4
  players: P1 blue bottom-centre, P2 red top-centre, P3 green (#22c55e)
  left-centre, P4 amber (#f59e0b) right-centre; turns rotate P1→P2→P3→P4→P1…,
  30 s per turn with auto-pass, +10 energy at the start of your turn, one
  action per turn. The BFS fairness rule covers every player: a blockade is
  illegal (`NO_PATH`) if it leaves ANY player without a path to the trophy.
  On timeout the player with the shortest BFS distance to the trophy wins.
  Practice: you vs 1 AI (2P) or vs 3 AI (4P trophy); the AI targets the
  trophy and blocks the opponent closest to it.
- **Blockades**: drag on a grid edge, extend to length 1–4. Cost 20 energy
  (len 1–2) / 35 (len 3–4), max 100 energy, +10 energy at the start of each
  of your turns (capped at 100). **Hard cap: 10 blockades per player per
  match** — the HUD shows "Blok: X/10" per player, the quick-place buttons
  disable at 0 ("Blok habis"), the drag preview turns red when out of
  blocks, and placing with none left is rejected with `NO_BLOCKADES`
  (turn does not pass, energy unchanged). Placement is rejected if either
  player loses all paths to goal (BFS fairness) — the preview turns red
  before you release.
- **Local 2P**: swipe starting on the top half of the board moves P2 (red),
  bottom half moves P1 (blue); the joystick always drives P1.
- **Practice vs AI**: Easy wanders with noise, Normal blocks when it helps,
  Hard always blocks when it buys a step and otherwise takes the shortest path.

## Animation (the quality bar)

- **One render loop, driven by the display frame clock** (`withFrameNanos` in
  `GameScreen`). No timers, no `Handler` posts, no delayed launches animate
  anything.
- **Orbs never teleport**: every cell change starts a 150 ms `easeOutCubic`
  glide from the current display position, with a fading motion trail and a
  rotating energy arc. Authoritative snapshots reconcile; large corrections
  (reconnect) snap instead of gliding across the board.
- **Blockades grow in centre-out over ~250 ms** (`easeOutCubic`) with a glow
  pulse and a particle burst; they never pop in.
- **Particles**: fixed 256-particle pool, no allocation in the draw loop.
  Bursts on placement, collision (amber sparks + tiny screen shake), and win.
- **Cheap per-frame work**: the grid, goal tints and border are pre-rendered
  once per resize into an offscreen bitmap; orb sprites are pre-rendered once
  per colour.

## Networking (same protocol as the web client)

Ktor WebSocket client (`net/NetClient.kt`) speaking the `DEVELOPMENT.md`
JSON protocol (version **1.3.0**) against `ws://<host>:3001`:

- Client → server: `hello`, `createRoom` (mode + playerCount), `joinRoom`,
  `queue` (mode + playerCount), `leaveQueue`,
  `ready`, `start`, `input` (`move` / `place` / `placeAuto`, with `seq`
  numbers), `ping`, `reconnect`.
- Server → client: `welcome`, `roomCreated`, `roomJoined` (mode +
  playerCount), `lobbyUpdate`, `queued`, `queueLeft`, `matchFound` (mode +
  playerCount + opponents), `countdown`, `matchStart`, `state`, `delta`,
  `result` (reason `trophy` possible; no `scores` — win/lose/draw only),
  `opponentLeft`, `error` (incl. `NO_BLOCKADES` when out of blockades),
  `pong`, `reconnected`. Snapshots carry `mode`, `playerCount`, `trophy`,
  and per-player `blockadesLeft` (10 − blockades placed); there is no
  `score` field and no `score` delta any more.
- Reconnect: keeps the session token; if the socket drops mid-match it
  retries up to 6 times with exponential backoff (1 s → 8 s) and sends
  `reconnect` with the token. Ping every 2 s; latency shown in the HUD.
- Unknown future message types are surfaced as `Unknown`, never crashed on.

Default server URL is `ws://10.0.2.2:3001` (the emulator's route to your PC's
localhost). On a real device, set your PC's LAN IP in Settings, e.g.
`ws://192.168.1.5:3001`, and make sure the server in `apps/server` is running
(`pnpm --filter @blockade-arena/server dev` from the repo root, port 3001).

## Project layout

```
apps/android/
├── settings.gradle.kts / build.gradle.kts / gradle.properties
├── gradle/wrapper/ (Gradle 8.5) + gradlew / gradlew.bat
├── local.properties.example          # copy to local.properties, set sdk.dir
└── app/
    ├── build.gradle.kts              # AGP 8.3.2, Kotlin 1.9.22, Compose BOM 2024.02.00
    ├── proguard-rules.pro
    └── src/main/
        ├── AndroidManifest.xml       # INTERNET, ACCESS_NETWORK_STATE, VIBRATE
        ├── res/values/ (strings, colors, themes) + launcher icons
        └── java/com/blokblok/arena/
            ├── MainActivity.kt       # single activity, Compose entry
            ├── ArenaApp.kt           # NavHost + settings/sound/history wiring
            ├── game/
            │   ├── Types.kt          # protocol types + tunables (port of core types.ts)
            │   ├── Engine.kt         # full engine port (movement, blockades, BFS, timer, turn-based play; no scoring)
            │   ├── Ai.kt             # Easy/Normal/Hard (port of core ai.ts)
            │   ├── BoardRenderer.kt  # native Canvas renderer + animation system
            │   ├── Input.kt          # edge picking, drag-extend, swipe/joystick dirs
            │   └── Sound.kt          # synthesized SoundPool effects (no audio assets)
            ├── net/
            │   ├── Protocol.kt       # JSON encode/decode for every protocol message
            │   └── NetClient.kt      # Ktor WebSocket client + reconnect + delta applier
            ├── data/Store.kt         # DataStore settings + Room match history
            └── ui/
                ├── GameViewModel.kt  # match state machine (online + local)
                ├── theme/Theme.kt    # dark graphite neon theme
                ├── nav/Nav.kt        # routes
                ├── components/Hud.kt # HUD + virtual joystick
                └── screens/          # Splash, Menu, Settings, Lobby, Game, Results
```

## Tech

- Kotlin 1.9.22, AGP 8.3.2, Gradle 8.5, compileSdk 34, minSdk 26, targetSdk 34.
- Jetpack Compose (BOM 2024.02.00), Navigation Compose 2.7.7.
- Ktor 2.3.9 (OkHttp engine) WebSockets, kotlinx-serialization-json 1.6.3.
- Room 2.6.1 (KSP), DataStore Preferences 1.0.0, SoundPool, HapticFeedback.
- Free / open-source tooling only. No proprietary SDKs, no analytics.

## Known limitations (milestone 1)

- Not compiled or run on a device here (no JDK/SDK on this VM) — see build
  status above. Treat the first real build as the verification step.
- Results screen shows you vs the first opponent only (stats layout is
  still 2-player); in a 4P match the other two players' stats are not
  shown there yet. The HUD in-game lists all players.
- `forfeit` crowns the first other player as winner, which is only
  meaningful in 2P; 4P forfeit handling is server-defined.
- No ranked ladder / matchmaking rating yet (Ranked-lite = casual queue).
- No in-game chat, emotes, or spectators.
- Sound effects are synthesized tones, not recorded audio.
- Local 2P shares one screen (swipe halves + joystick); no split-screen.
