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
- **Ranked is "Ranked-lite"**: local rating points per session only, no divisions,
  seasons, leaderboards or persistence yet.

## The protocol (single source of truth)

Transport: WebSocket, JSON text frames. Every message is `{ "type": string, ...fields }`.
All ids are strings. All times in ms unless noted.

### Client → Server

| type | fields | meaning |
|---|---|---|
| `hello` | `name: string`, `clientVersion: string` | First message after connect. Server replies `welcome`. |
| `createRoom` | `mode: "race"`, `gridSize: 12\|20\|30\|40`, `durationSec: number` | Create a private room. → `roomCreated` |
| `joinRoom` | `roomCode: string` | Join a private room. → `roomJoined` or `error` |
| `queue` | `mode: "race"`, `gridSize: number` | Enter public 1v1 matchmaking. → `queued`, then `matchFound` |
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
| `roomJoined` | `roomId, roomCode, mode, gridSize, durationSec, players: [{id,name,ready,isHost}]` | You are in the room. |
| `lobbyUpdate` | `players: [{id,name,ready,isHost}]` | Someone's ready state changed. |
| `queued` | `position: number` | You are in the matchmaking queue. |
| `queueLeft` | — | You left the queue. |
| `matchFound` | `roomId, roomCode, token, opponent: {id,name}` | Match made; join the room flow. |
| `countdown` | `seconds: 3` | Match starts in N seconds. |
| `matchStart` | `snapshot: Snapshot` | Initial full state. |
| `state` | `tick: number`, `snapshot: Snapshot` | Full snapshot (on join/reconnect and every ~1s). |
| `delta` | `tick: number`, `events: DeltaEvent[]` | Incremental updates between snapshots. |
| `result` | `winnerId: string \| null, reason: "goal"\|"timeout"\|"forfeit"\|"draw"`, `scores, stats, durationMs` | Match over. |
| `opponentLeft` | `playerId: string` | Opponent disconnected (match continues vs AI? No — forfeit after 30s grace, see rules). |
| `error` | `code: string`, `message: string` | Rejected request. Codes: `BAD_REQUEST`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `NOT_READY`, `NOT_HOST`, `INVALID_MOVE`, `INVALID_BLOCKADE`, `NO_PATH`, `NO_ENERGY`, `ON_COOLDOWN`, `NOT_IN_MATCH`, `BAD_TOKEN`. |

### Snapshot (shared type `Snapshot` in `packages/core`)
```ts
interface Snapshot {
  tick: number;
  status: "lobby" | "countdown" | "playing" | "finished";
  mode: "race";
  gridSize: number;
  durationSec: number;
  timeLeftMs: number;
  players: PlayerState[];   // { id, name, color: "blue"|"red", row, col,
                             //   energy, moveCooldownMs, placeCooldownMs, score, progress }
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
  | { k: "score"; playerId: string; score: number };
```

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
- Move: 4-dir, one cell per move, 150 ms move cooldown, input buffering (latest wins).
- Blockade: energy cost 20 (len 1–2) or 35 (len 3+), max energy 100, regen 5/s,
  placement cooldown 500 ms, max 10 active per player, max length 4.
- **BFS fairness rule:** a placement is rejected if, after placing it, EITHER player
  has no BFS path to their goal row. This is enforced in the core engine AND on the
  server. Never allow a softlock.
- Timer default 180 s. On timeout, the player closer to their goal (fewest rows away)
  wins; equal distance = draw.
- Server tick 20/s. Server is authoritative: it validates every input, simulates,
  and broadcasts. Clients never send state, only inputs.

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
  Race mode, timer, scoring, AI (Easy/Normal/Hard), protocol types. Unit tests pass.
  - Animation support in the engine: `tryMove` buffers inputs during the
    move cooldown (latest wins, so holding a direction glides instead of
    stuttering); `PlayerState.anim` carries the in-flight move (from→to,
    startTick, durationMs) and `BlockadeState.placedTick/deployDurationMs`
    carry the grow-in window; `interpolatedPosition()` /
    `blockadeDeployProgress()` give clients eased 0..1 progress. Delta
    events include `collide` (illegal move feedback) and `win`.
  - Engine note: the tick counter field is `tickCount` (the `tick(nowMs)`
    wall-clock entry point owns the name `tick`).
- Server: authoritative 20-tick sim, rooms by 6-char code, 1v1 matchmaking queue,
  reconnect tokens, snapshots + deltas, match results (in-memory).
  - Verified 2026-11-16 (Track 1, live server on :3001):
    `apps/server/scripts/smoke-test.mjs` PASSED — scripted 1v1: hello, ping/pong,
    createRoom (6-char code), joinRoom, ready, start, countdown 3s, matchStart,
    valid place → blockade delta, overlapping place → `INVALID_BLOCKADE`, P1
    walks to the goal row → `result` winner P1, reason `goal`, score 452.
    Smoothness: 67 delta/state broadcasts, mean gap 48.0 ms, max 52 ms,
    0 stalls (>250 ms); server tick processing avg 0.44 ms, max 3.34 ms
    (20/s budget is 50 ms). `queue-test.mjs` PASSED (queue → matchFound same
    room code → auto matchStart). `reconnect-test.mjs` PASSED (drop mid-match
    → reconnect with token → `reconnected` with live snapshot; bad token →
    `BAD_TOKEN`). One bug found + fixed during verification: `reconnect` was
    rejected by the hello-gate because it arrives as the first message on a
    fresh socket — it now authenticates via token before the gate.
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
    countdown, matchStart, place→delta, 12 moves → result, winner score
    454); `apps/web/scripts/smoke-queue.mjs` passes (queue → matchFound →
    countdown → matchStart); `apps/web/scripts/verify-practice.mts`
    passes (fixed-step 50 ms sim, tryMove buffering 16/19, Hard AI, button
    placeAuto, practice match won by the scripted player).
- Android: native Kotlin/Compose app (splash, menu, lobby, Canvas gameplay,
  touch joystick, drag blockade, haptics, Ktor WebSocket client, same protocol).
  Gradle project complete; **no APK was built on this VM (no Android SDK)** —
  see "Android build" below.

## What is partial
- Ranked-lite: points tracked in-session only; no divisions, seasons, leaderboards.
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
  only Race is implemented).
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
