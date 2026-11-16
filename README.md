# BLOCKADE ARENA

Competitive grid strategy game — web + native Android + authoritative multiplayer
server. Two glowing orbs race across a grid arena; players move cell to cell and
deploy energy blockades on the edges between cells to redirect their opponent.
First to the opposite goal row wins.

Inspired by the reference board (grid arena, circular orbs, edge blockades, goal
rows), rebuilt with a neon visual direction: dark graphite arena, glowing orbs,
cyan energy blockades.

## Status (milestone 1, 2026-11-17)

- `packages/core` — shared TypeScript engine: grid/edge model, turn-based
  movement (one action per turn, 30 s turn timer with auto-pass, +10 energy
  at the start of your turn), blockades, BFS fairness validation, energy,
  Race mode, Trophy mode (centre-cell trophy, 2 or 4 players), AI
  (Easy/Normal/Hard). Protocol 1.3.0.
  Tests: 56/56 pass.
- `apps/server` — Node.js + `ws`, server-authoritative 20 ticks/s, rooms by
  6-char code (2P race, 2P/4P trophy), matchmaking queue (groups by mode +
  gridSize + playerCount), reconnect tokens, in-memory results.
- `apps/web` — React + Vite + Canvas. Menu, lobby, online 1v1, practice vs AI,
  local 2P. Builds cleanly.
- `apps/android` — **not built**: the agent assigned to it was refused by a
  safety policy and was not re-staffed. See DEVELOPMENT.md.

Full honest status, protocol and rules: [DEVELOPMENT.md](DEVELOPMENT.md),
[GAME_RULES.md](GAME_RULES.md).

## Run it

```bash
npm install
npm run test --workspace=@blockade/core     # 56 unit tests
npm run dev --workspace=@blockade/server    # ws://localhost:3001 (+ GET /health)
npm run dev --workspace=@blockade/web       # http://localhost:5173
```

Production builds: `npm run build --workspace=@blockade/core`,
`npm run build --workspace=@blockade/server`, `npm run build --workspace=@blockade/web`.

## Android (needs an Android SDK — none on this VM)

```bash
export ANDROID_HOME=/path/to/android-sdk
cd apps/android && ./gradlew assembleDebug
```

No APK has been built or tested here.

## Repository

- `packages/core/` — shared engine + protocol types
- `apps/server/` — authoritative server + smoke-test scripts
- `apps/web/` — web client
- `apps/android/` — native Android app (not yet created)
