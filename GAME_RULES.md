# BLOCKADE ARENA — Game Rules (Milestone 1, protocol 1.3.0)

## The arena
- Square grid of cells. Sizes: 12×12 (default), 20×20, 30×30, 40×40.
- Every cell is `(row, col)`, rows 0 (top) to N−1 (bottom).
- Blockades sit on **edges between cells**, never inside cells (see DEVELOPMENT.md
  for the exact edge model).

## Race to the Top
- 2 players. Player 1 (electric blue) starts on the bottom row, centre column.
  Player 2 (neon red) starts on the top row, centre column.
- Goal: reach any cell in the opposite row (P1 → row 0, P2 → row N−1).
- First player to step onto their goal row wins immediately.

## Trophy mode (since protocol 1.2.0)
- 2 or 4 players. The **trophy** sits on the centre cell of the grid:
  `(floor(N/2), floor(N/2))` — (6,6) on 12×12, (10,10) on 20×20.
- Goal: be the first orb to step **onto the trophy cell**. Landing on it wins
  immediately (win reason `trophy`). The trophy cell is a normal walkable
  cell — it does not block movement and no blockade can cover it (blockades
  sit on edges, never inside cells).
- 2-player trophy keeps the Race spawns (P1 bottom centre, P2 top centre).
- On timeout, the player with the shortest path to the trophy wins; equal
  distance is a draw.

## 4 players (trophy mode only)
- 4-player matches exist **only** in trophy mode. Race stays 2-player.
- Spawns: P1 bottom centre `(N−1, floor(N/2))`, P2 top centre `(0, floor(N/2))`,
  P3 left centre `(floor(N/2), 0)`, P4 right centre `(floor(N/2), N−1)`.
- Colours: P1 blue, P2 red, P3 green (`#22c55e`), P4 amber (`#f59e0b`).
- Turns rotate in seat order P1→P2→P3→P4→P1…; `turnNumber` increments on
  every pass. All other turn rules are unchanged (one action per turn,
  30 s per turn, +10 energy at the start of your turn, timeout auto-pass).
- The BFS fairness rule checks **all four** players: a blockade is illegal
  if it leaves any player without a path to the trophy.

## Turns (since protocol 1.1.0 — turn-based, no real-time play)
- The match is played in turns. **Turn 1 belongs to Player 1 (blue).**
- On your turn you may do **exactly ONE action**: move 1 cell
  (up, down, left, right) OR place 1 blockade.
- After a valid action the turn passes to the **next player in seat order**
  (P1→P2 in a 2-player match, P1→P2→P3→P4→P1… in a 4-player match):
  `turnNumber` increases by 1 and the new turn deadline is now + 30 seconds.
- Each turn lasts **30 seconds** (`TURN_DURATION_MS = 30000`). If the active
  player does not act within 30 s, the turn **auto-passes** to the other
  player with no other penalty (no energy loss). The incoming
  player still gains their +10 energy for the new turn.
- An invalid action is **rejected and the turn does NOT pass**: the same
  player keeps the turn and may try a different action. Rejection codes:
  `INVALID_MOVE` (illegal move), `INVALID_BLOCKADE` (illegal placement),
  `NO_PATH` (placement would leave a player with no path to their target —
  goal row in Race, trophy cell in Trophy mode),
  `NO_ENERGY` (not enough energy),
  `NO_BLOCKADES` (the player has already placed 10 blockades this match),
  `NOT_YOUR_TURN` (acting while it is another player's turn).
- There are **no move or place cooldowns and no input buffering**. The old
  real-time rules (150 ms move cooldown, 500 ms placement cooldown, buffered
  inputs during cooldown) were removed in the 1.1.0 revision. The 150 ms
  figure survives only as an animation: the orb still glides from cell to
  cell over 150 ms with easing, and blockades still grow in over 250 ms.
- The server is authoritative for turns: it rejects out-of-turn inputs with
  `NOT_YOUR_TURN` before applying them, and its 20/s tick loop drives the
  engine tick, so turn timeouts fire on the server. Every turn pass is
  broadcast as a `turn` delta event
  (`{k:"turn", activePlayerId, turnNumber, turnDeadlineMs}`), and every
  snapshot carries `activePlayerId`, `turnNumber` and `turnDeadlineMs`.

## Movement
- One cell at a time: up, down, left, right. No diagonals.
- A move is illegal if it leaves the grid, crosses a blockade edge, or lands on
  another player's cell. An illegal move is rejected (`INVALID_MOVE`) and does
  not consume the turn.
- Movement is interpolated smoothly on the client (150 ms eased glide); the
  server simulates discretely (one cell per accepted move).

## Blockades: 10 per player per match
- A blockade is a straight line of 1–4 consecutive edges, horizontal or vertical.
- **Hard cap: each player may place at most 10 blockades per match**
  (`MAX_BLOCKADES_PER_PLAYER = 10`, counted on placement). The 11th
  placement is rejected with `NO_BLOCKADES` — the turn does NOT pass and no
  energy is spent. The cap is checked before energy, so a capped player is
  out of blockades even with energy to spare. Each player's snapshot state
  carries `blockadesLeft` (10 − placed) so the UI can show the remaining
  budget ("Blok: x/10").
- Energy is pacing, not the budget: max 100, cost 20 for length 1–2,
  35 for length 3–4, **+10 energy at the start of each of your turns**
  (`ENERGY_PER_TURN = 10`, capped at 100). There is no per-second
  regeneration any more. In practice the energy economy binds first — a
  player who places on every turn runs dry around the 8th–9th blockade and
  must spend idle turns recharging — but the 10-cap is the hard match
  budget regardless of energy.
- A blockade may not overlap an existing blockade edge, may not leave the grid,
  and — the fairness rule — **must never leave any player without a path to
  their target** (goal row in Race, trophy cell in Trophy mode). The engine
  runs BFS for every player after a hypothetical placement and rejects it if
  any player has no path. This is enforced on the server; clients only preview.
- Blockades are permanent for the match in milestone 1 (no expiry/retraction).

## Timer and timeout
- Default match length: 180 seconds (configurable per room).
- On timeout: in Race, the player with the fewest rows remaining to their goal
  wins; in Trophy, the player with the shortest path to the trophy wins.
  Equal distance is a draw.
- There is no points system: a match ends win, loss, or draw only. Match
  stats (moves made, blockades placed, match duration) are reported with
  the result but are not points.
- If a player disconnects, the opponent waits 30 s (grace period, reconnect
  token); after that the disconnected player forfeits.

## Fair play
- The server is authoritative: it validates every move and placement, enforces
  the turn order, energy, and the BFS fairness rule, and never trusts client state.
- Inputs carry sequence numbers; duplicates and out-of-order inputs are ignored.
