# BLOCKADE ARENA — Development Notes

> Milestone 1 (2026-11-16): core engine + authoritative server + web client + native
> Android project. Honest status at the bottom. $0 budget, free/open-source tooling only.

## Architecture

```
blokblok/
  packages/core/     Shared TypeScript game engine + protocol types (no DOM, no Node APIs)
  apps/server/       Node.js + TypeScript + `ws`, server-authoritative, 20 ticks/sec
  apps/web/          React + TypeScript + Vite + Canvas renderer (NOT Phaser — see below)
  apps/android/      Kotlin + Jetpack Compose + Canvas, Ktor WebSocket client
```

### Deviation from the spec (deliberate, documented)
- **Web renderer is plain Canvas, not Phaser 3.** Phaser adds a large dependency
  and build risk for a grid game whose rendering is rectangles, circles and lines.
  Canvas keeps the build reliable and the frame budget trivial. The game logic is
  identical either way; a Phaser swap later would only touch `apps/web`.
- **In-memory store on the server.** PostgreSQL/Redis are a later phase (§"Not built").
  Match results are kept in memory only and lost on restart.
- **Ranked is "Ranked-lite"**: no divisions, seasons, leaderboards or
  persistence yet — and no points at all since protocol 1.3.0 removed the
  points system (a match ends win/lose/draw only).

## The protocol (single source of truth)

Transport: WebSocket, JSON text frames. Every message is `{ "type": string, ...fields }`.
All ids are strings. All times in ms unless noted.

### Client → Server

| type | fields | meaning |
|---|---|---|
| `hello` | `name: string`, `clientVersion: string` | First message after connect. Server replies `welcome`. |
| `createRoom` | `mode: "race"\|"trophy"`, `gridSize: 12\|20\|30\|40`, `durationSec: number`, `playerCount?: 2\|4` | Create a private room. → `roomCreated`. Race is always 2P; trophy is 2P (default) or 4P. |
| `joinRoom` | `roomCode: string` | Join a private room. → `roomJoined` or `error` |
| `queue` | `mode: "race"\|"trophy"`, `gridSize: number`, `playerCount?: 2\|4` | Enter public matchmaking. → `queued`, then `matchFound`. A 4P trophy queue entry only matches three other 4P trophy entries with the same gridSize. |
| `leaveQueue` | — | Leave the queue. → `queueLeft` |
| `ready` | `ready: boolean` | Toggle ready in the lobby. → `lobbyUpdate` |
| `start` | — | Host starts when all players are ready. → `countdown` |
| `input` | `seq: number`, `kind: "move"`, `dir: "up"\|"down"\|"left"\|"right"` | Request a move. Server validates + applies on tick. |
| `input` | `seq: number`, `kind: "place"`, `edge: {row:number,col:number,orientation:"h"\|"v",len:number}` | Place a blockade on grid edges. |
| `input` | `seq: number`, `kind: "placeAuto"`, `dir: "up"\|"down"\|"left"\|"right"`, `orientation: "h"\|"v"`, `len: number` | Button placement: server picks the nearest valid placement ahead of the player in `dir`. |
| `ping` | `t: number` | Latency probe. → `pong` |
| `reconnect` | `token: string` | Rejoin a match after a drop. → `reconnected` or `error` |

### Server → Client

| type | fields | meaning |
|---|---|---|
| `welcome` | `playerId: string`, `serverVersion: string` | Assigned id for this connection. |
| `roomCreated` | `roomId, roomCode (6 chars), token` | Private room ready; share the code. |
| `roomJoined` | `roomId, roomCode, mode, playerCount, gridSize, durationSec, players: [{id,name,ready,isHost}]` | You are in the room. |
| `lobbyUpdate` | `mode, playerCount, players: [{id,name,ready,isHost}]` | Someone's ready state changed (or joined/left). |
| `queued` | `position: number` | You are in the matchmaking queue. |
| `queueLeft` | — | You left the queue. |
| `matchFound` | `roomId, roomCode, token, mode, playerCount, opponent: {id,name}, opponents: [{id,name}]` | Match made; join the room flow. `opponent` is the first opponent (2P compat); `opponents` lists all other players (1 in 2P, 3 in 4P). |
| `countdown` | `seconds: 3` | Match starts in N seconds. |
| `matchStart` | `snapshot: Snapshot` | Initial full state. Snapshot carries `mode`, `playerCount` and `trophy`. |
| `state` | `tick: number`, `snapshot: Snapshot` | Full snapshot (on join/reconnect and every ~1s). |
| `delta` | `tick: number`, `events: DeltaEvent[]` | Incremental updates between snapshots. |
| `result` | `winnerId: string \| null, reason: "goal"\|"trophy"\|"timeout"\|"forfeit"\|"draw"`, `stats, durationMs` | Match over. No points since protocol 1.3.0. |
| `opponentLeft` | `playerId: string` | Opponent disconnected (match continues vs AI? No — forfeit after 30s grace, see rules). |
| `error` | `code: string`, `message: string` | Rejected request. Codes: `BAD_REQUEST`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `NOT_READY`, `NOT_HOST`, `INVALID_MOVE`, `INVALID_BLOCKADE`, `NO_PATH`, `NO_ENERGY`, `NO_BLOCKADES`, `NOT_YOUR_TURN`, `NOT_IN_MATCH`, `BAD_TOKEN`. |

### Snapshot (shared type `Snapshot` in `packages/core`)
```ts
interface Snapshot {
  tick: number;
  status: "lobby" | "countdown" | "playing" | "finished";
  mode: "race" | "trophy";
  playerCount: number; // 2, or 4 in a 4P trophy match
  trophy: { row: number; col: number } | null; // centre cell in trophy mode, null in race
  gridSize: number;
  durationSec: number;
  timeLeftMs: number;
  activePlayerId: string; // whose turn it is (turn 1 = P1, blue)
  turnNumber: number;     // starts at 1, +1 on every turn pass
  turnDeadlineMs: number; // epoch ms when the current turn expires (0 = not started)
  players: PlayerState[];   // { id, name, color: "blue"|"red"|"green"|"amber", row, col,
                             //   energy, blockadesLeft, progress }
  blockades: BlockadeState[]; // { id, playerId, edges: Edge[], createdTick }
  winnerId: string | null;
}
```

### DeltaEvent (shared type in `packages/core`)
```ts
type DeltaEvent =
  | { k: "move"; playerId: string; row: number; col: number; tick: number }
  | { k: "blockade"; blockade: BlockadeState }
  | { k: "energy"; playerId: string; energy: number }
  | { k: "timer"; timeLeftMs: number }
  | { k: "turn"; activePlayerId: string; turnNumber: number; turnDeadlineMs: number }
  | { k: "collide"; playerId: string; row: number; col: number; tick: number }
  | { k: "win"; winnerId: string | null; reason: "goal" | "trophy" | "timeout" | "forfeit" | "draw"; tick: number };
```
The `turn` event is emitted on every turn pass — after a valid action and
on a timeout auto-pass. Protocol version is **1.3.0** (turn-based +
trophy/4P, no points, 10 blockades per player per match);
`GET /health` reports it as both `version` and `protocol`, and `welcome`
reports it as `serverVersion`.

## Edge model (shared by every client — get this exactly right)

Cells are `(row, col)`, `0 <= row, col < N`. A blockade sits on **edges between cells**:
- `'h'` edge at `(row, col)`: the horizontal edge on the **top** side of cell `(row, col)`,
  i.e. between `(row-1, col)` and `(row, col)`. Valid for `1 <= row < N`, `0 <= col < N`.
- `'v'` edge at `(row, col)`: the vertical edge on the **left** side of cell `(row, col)`,
  i.e. between `(row, col-1)` and `(row, col)`. Valid for `0 <= row < N`, `1 <= col < N`.
- A blockade of length `L` is `L` consecutive edges in one line:
  horizontal from `(row, col0)` covers `h`-edges `(row, col0 .. col0+L-1)`;
  vertical from `(row0, col)` covers `v`-edges `(row0 .. row0+L-1, col)`.
- Movement from `(r,c)`: up is blocked iff `h`-edge `(r,c)` exists; down iff `h`-edge
  `(r+1,c)`; left iff `v`-edge `(r,c)`; right iff `v`-edge `(r,c+1)`.

## Game rules (summary — full rules in GAME_RULES.md)
- Race to the Top, 1v1. P1 blue starts bottom row centre, goal = row 0. P2 red starts
  top row centre, goal = row `N-1`. First to any goal-row cell wins.
- **Trophy mode (since protocol 1.2.0):** 2 or 4 players; the trophy sits on the
  centre cell `(floor(N/2), floor(N/2))` — (6,6) on 12×12, (10,10) on 20×20.
  First orb to step onto it wins (reason `trophy`). 2P trophy keeps the Race
  spawns. 4P spawns: P1 bottom centre, P2 top centre, P3 left centre (green
  `#22c55e`), P4 right centre (amber `#f59e0b`). Race stays 2-player.
- **Turn-based (since protocol 1.1.0):** one action per turn — move 1 cell
  (up/down/left/right) OR place 1 blockade. Turn 1 belongs to P1. After a
  valid action the turn passes to the next player in seat order
  (P1→P2 in 2P, P1→P2→P3→P4→P1… in 4P), `turnNumber += 1`, and
  the new deadline is now + 30 s (`TURN_DURATION_MS = 30000`). An invalid
  action is rejected (`INVALID_MOVE` / `INVALID_BLOCKADE` / `NO_PATH` /
  `NO_ENERGY` / `NO_BLOCKADES`, or `NOT_YOUR_TURN` out of turn) and the turn does NOT pass.
  If the active player does not act within 30 s, the turn auto-passes with
  no other penalty. There are NO move/place cooldowns and NO input buffering
  any more (removed in the 1.1.0 revision); `MOVE_ANIM_MS = 150` is now an
  animation-only constant (orb glide duration).
- Blockade: energy cost 20 (len 1–2) or 35 (len 3+), max energy 100,
  **+10 energy at the start of each of your turns** (`ENERGY_PER_TURN = 10`,
  capped at 100; no per-second regen), **10 blockades per player per match**
  (hard cap, counted on placement; the 11th is rejected `NO_BLOCKADES`),
  max length 4. Energy is pacing; the 10-cap is the match budget.
- **BFS fairness rule:** a placement is rejected if, after placing it, ANY player
  has no BFS path to their target (goal row in Race, trophy cell in Trophy).
  This is enforced in the core engine AND on the server. Never allow a softlock.
- Timer default 180 s. On timeout, the player closest to their target wins
  (fewest rows in Race, shortest path to the trophy in Trophy); equal
  distance = draw.
- Server tick 20/s. Server is authoritative: it validates every input, enforces
  the turn (`NOT_YOUR_TURN` on every `input` before applying), simulates,
  and broadcasts. The 20/s tick loop drives the engine tick, so 30 s turn
  timeouts fire on the server. Clients never send state, only inputs.

## How to run (milestone 1)

```bash
npm install                 # root: installs all workspaces
npm run test --workspace=@blockade/core     # core unit tests (must pass)
npm run dev --workspace=@blockade/server    # server on ws://localhost:3001
npm run dev --workspace=@blockade/web       # web on http://localhost:5173
# Android: open apps/android in Android Studio, or:
#   ANDROID_HOME=<sdk> ./gradlew assembleDebug   (needs Android SDK — not on this VM)
```

## What works (milestone 1)
- Core engine: grid/edge model, movement, blockades, BFS validation, energy,
  Race mode, timer, AI (Easy/Normal/Hard), protocol types. Unit tests pass.
  No points since protocol 1.3.0 (win/lose/draw only); 10 blockades per
  player per match (`NO_BLOCKADES` on the 11th).
  Turn-based since protocol 1.1.0 (2026-11-16): one action per turn, 30 s
  turn timer with auto-pass, +10 energy at the start of your turn, no
  cooldowns, no input buffering. `chooseAiAction` picks a single
  move-or-blockade action per AI turn.
  - **Trophy mode + 4 players since protocol 1.2.0 (2026-11-17):** trophy on
    the centre cell, first orb onto it wins (reason `trophy`); 4P trophy
    rooms (P3 green `#22c55e`, P4 amber `#f59e0b`, spawns on all four sides);
    turns rotate P1→P2→P3→P4→P1…; BFS fairness checks every player's path
    to their target; AI targets the trophy cell in trophy mode and blocks the
    most threatening opponent in 4P. Core tests: 57/57 pass (43 race/turn
    tests + 14 trophy/4P tests in `packages/core/src/test/trophy.test.ts`;
    the 43rd race test is the protocol 1.3.0 blockade-cap test: 10
    placements allowed, the 11th rejected `NO_BLOCKADES`).
  - Animation support in the engine: `PlayerState.anim` carries the in-flight
    move (from→to, startTick, durationMs) and `BlockadeState.placedTick/
    deployDurationMs` carry the grow-in window; `interpolatedPosition()` /
    `blockadeDeployProgress()` give clients eased 0..1 progress. Orbs glide
    cell to cell in 150 ms with easeOutCubic, blockades grow in over 250 ms.
    Delta events include `collide` (illegal move feedback), `turn` (every
    turn pass) and `win`.
  - Engine note: the tick counter field is `tickCount` (the `tick(nowMs)`
    wall-clock entry point owns the name `tick`).
- Server: authoritative 20-tick sim, rooms by 6-char code, 1v1 matchmaking queue,
  reconnect tokens, snapshots + deltas, match results (in-memory).
  - Rooms carry `mode` + `playerCount` (capacity 2, or 4 for trophy); the
    matchmaking queue groups by mode + gridSize + playerCount, so a 4P trophy
    room fills with exactly 4 players; `matchFound` carries `mode`,
    `playerCount`, `opponent` (first opponent) and `opponents` (all other
    players); `matchStart` snapshots carry `mode`, `playerCount` and the
    trophy position; reconnect snapshots carry the same fields.
  - Verified 2026-11-16 (Track 1, live server on :3001, protocol 1.1.0):
    `apps/server/scripts/smoke-test.mjs` PASSED — turn-based scripted 1v1:
    hello, ping/pong, createRoom (6-char code), joinRoom, ready, start,
    countdown 3s, matchStart (turn 1, P1 active, deadline now+30s), P1 valid
    place → blockade + `turn` deltas, P1 out-of-turn move → `NOT_YOUR_TURN`,
    P2 overlapping place → `INVALID_BLOCKADE` (turn does not pass), then
    alternating turns (P1 walks up, P2 wiggles) until P1 reaches the goal
    row → `result` winner P1, reason `goal` (points still existed in 1.1.0:
    winner score was ~448-452, i.e. 100 + 2 × seconds remaining; the points
    system was removed in protocol 1.3.0).
    Smoothness (fresh 1.1.0 run): 64 delta/state broadcasts, mean gap 47.8 ms,
    max 52 ms, 0 stalls (>250 ms); server tick processing avg 0.48 ms,
    max 3.52 ms (20/s budget is 50 ms).
    room code → auto matchStart, turn 1 checked). `reconnect-test.mjs` PASSED (drop mid-match
    → reconnect with token → `reconnected` with live snapshot incl. turn state; bad token →
    `BAD_TOKEN`). One bug found + fixed during verification: `reconnect` was
    rejected by the hello-gate because it arrives as the first message on a
    fresh socket — it now authenticates via token before the gate.
  - Verified 2026-11-17 (protocol 1.2.0, re-run of the 1v1 smoke test):
    `smoke-test.mjs` PASSED again (64 broadcasts, max gap
    52 ms, tick max 2.91 ms; winner score was 452 under the points system
    removed in 1.3.0). `apps/server/scripts/smoke-test-4p-trophy.mjs`
    PASSED — scripted 4P trophy match: createRoom (trophy, playerCount 4),
    3 joins, 5th join rejected `ROOM_FULL`, all ready, countdown,
    matchStart (mode trophy, playerCount 4, trophy (6,6), spawns
    (11,6)/(0,6)/(6,0)/(6,11), colours blue/red/green/amber), P2 out-of-turn
    move → `NOT_YOUR_TURN`, turn rotation back to P1 verified at turns 5, 9,
    13 and 17, P1 walks up column 6 onto the trophy → `result` winner P1,
    reason `trophy` (winner score was 456 under the removed points system).
    `queue-test.mjs` and `reconnect-test.mjs` still pass unchanged.
  - Verified 2026-11-17 (protocol 1.3.0, points removed + 10-blockade cap):
    core tests 57/57 (new cap test: 10 placements allowed across a long
    game, the 11th rejected `NO_BLOCKADES`, turn and energy unchanged).
    `smoke-test.mjs` PASSED — scripted 1v1 now drives a real cap game
    (P1 places 10, 11th → `NO_BLOCKADES`, snapshot `blockadesLeft` 0,
    result has no `scores` field, `stats.blockades` 10, 119 broadcasts,
    max gap 52 ms, tick max 3.72 ms). `smoke-test-4p-trophy.mjs` PASSED —
    same cap drive in 4P (turn rotation verified at turns 5–65, result
    winner P1, reason `trophy`, `stats.blockades` 10). `queue-test.mjs`
    and `reconnect-test.mjs` still pass unchanged.
  - Rate limiting: max 30 inputs/sec per player (drop + `BAD_REQUEST`).
    Matchmade rooms auto-ready both players and auto-start 500 ms after
    `matchFound`. Results + tick stats on GET /stats; GET /health for liveness.
- Web: menu, lobby, online 1v1, practice vs AI, local 2P, Canvas renderer,
  keyboard/mouse + touch controls, HUD, results screen.
  - Animation (user quality bar): a single requestAnimationFrame loop drives
    rendering — no setTimeout/Handler-driven animation. Orbs glide cell to
    cell in 150 ms with easeOutCubic (renderer-side, plus optimistic
    prediction for own online moves reconciled by snapshots); blockades grow
    in centre-out over 250 ms with a glow pulse and a particle burst; grid
    and background are pre-rendered once per resize, orb sprites once per
    colour, particles are a fixed pool — no allocation in the draw loop.
  - Verified 2026-11-16 (no browser automation on this VM, so no real
    mouse/keyboard playtest — see below): `npm run build
    --workspace=@blockade/web` exits 0 (tsc + vite); `vite dev` serves the
    app on :5173; `apps/web/scripts/smoke-online.mjs` against the live
    server passes 9/9 steps (hello, createRoom, joinRoom, ready, start,
    countdown, matchStart, place→delta, 12 moves → result — the "winner
    score 454" step predates the protocol 1.3.0 removal of points); `apps/web/scripts/smoke-queue.mjs` passes (queue → matchFound →
    countdown → matchStart); `apps/web/scripts/verify-practice.mts`
    passes (fixed-step 50 ms sim, tryMove buffering 16/19, Hard AI, button
    placeAuto, practice match won by the scripted player).
- Android: native Kotlin/Compose app (splash, menu, lobby, Canvas gameplay,
  touch joystick, drag blockade, haptics, Ktor WebSocket client, same protocol).
  Gradle project complete; **no APK was built on this VM (no Android SDK)** —
  see "Android build" below.

## What is partial
- Ranked-lite: not implemented — no points, divisions, seasons, leaderboards.
- AI: Easy/Normal/Hard only (no Expert). AI runs in the web client for practice
  and on the server only as a fill-in when an opponent forfeits (grace 30 s).
- Reconnect: works within a running match while the server process lives; no
  cross-restart persistence.
- Sound: WebAudio beeps only (no music, no asset pipeline). Android: haptics only.
- Web client: verified by protocol smoke tests + headless practice sim (see
  above), NOT by a real browser playthrough — no browser automation exists
  on this VM. Drag-to-place, swipe, joystick and the canvas visuals were
  verified statically (input-helper unit checks in verify-practice.mts) and
  the production bundle builds and serves; a human should click through
  menu → practice → drag a blockade → finish a match in a real browser
  before calling the web track done.

## What is NOT built (later phases)
- 2v2 / FFA / Territory / Survival / Speed Rush / Team / Puzzle modes (spec §9:
  only Race and Trophy are implemented).
- Accounts, profiles, XP, achievements, cosmetics, leaderboards, seasons (§15).
- PostgreSQL / Redis persistence (§8). Match results are in-memory only.
- Moving/sliding/retracting/oscillating/rotating blockade types (§4 lists 11 types;
  only Standard + Extended lengths are implemented).
- Diagonal movement, dash, speed boost (§3 optionals).
- Production deployment, Play Store release build, automated device testing.

## Android build
No Android SDK exists on this VM (checked 2026-11-16: no `ANDROID_HOME`, no
`java`). The Gradle project in `apps/android` is complete and uses only
standard plugins (Kotlin, Compose, Ktor, Room, DataStore). To build:
```bash
export ANDROID_HOME=/path/to/android-sdk
cd apps/android && ./gradlew assembleDebug
```
The APK was **not** built or tested here — do not claim otherwise.
