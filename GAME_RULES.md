# BLOCKADE ARENA — Game Rules (Milestone 1, protocol 1.1.0)

## The arena
- Square grid of cells. Sizes: 12×12 (default), 20×20, 30×30, 40×40.
- Every cell is `(row, col)`, rows 0 (top) to N−1 (bottom).
- Blockades sit on **edges between cells**, never inside cells (see DEVELOPMENT.md
  for the exact edge model).

## Race to the Top (the only mode in milestone 1)
- 2 players. Player 1 (electric blue) starts on the bottom row, centre column.
  Player 2 (neon red) starts on the top row, centre column.
- Goal: reach any cell in the opposite row (P1 → row 0, P2 → row N−1).
- First player to step onto their goal row wins immediately.

## Turns (protocol 1.1.0 — turn-based, no real-time play)
- The match is played in turns. **Turn 1 belongs to Player 1 (blue).**
- On your turn you may do **exactly ONE action**: move 1 cell
  (up, down, left, right) OR place 1 blockade.
- After a valid action the turn passes to the other player: `turnNumber`
  increases by 1 and the new turn deadline is now + 30 seconds.
- Each turn lasts **30 seconds** (`TURN_DURATION_MS = 30000`). If the active
  player does not act within 30 s, the turn **auto-passes** to the other
  player with no other penalty (no energy loss, no score loss). The incoming
  player still gains their +10 energy for the new turn.
- An invalid action is **rejected and the turn does NOT pass**: the same
  player keeps the turn and may try a different action. Rejection codes:
  `INVALID_MOVE` (illegal move), `INVALID_BLOCKADE` (illegal placement),
  `NO_PATH` (placement would leave a player with no path to their goal),
  `NO_ENERGY` (not enough energy), `NOT_YOUR_TURN` (acting while it is the
  opponent's turn).
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
  the opponent's cell. An illegal move is rejected (`INVALID_MOVE`) and does
  not consume the turn.
- Movement is interpolated smoothly on the client (150 ms eased glide); the
  server simulates discretely (one cell per accepted move).

## Blockades
- A blockade is a straight line of 1–4 consecutive edges, horizontal or vertical.
- Placement methods: (A) drag from a grid edge with a live preview (green/cyan =
  valid, red = invalid); (B) blockade button — the server places the nearest
  valid blockade ahead of you in the chosen direction.
- Energy: max 100. Cost 20 for length 1–2, 35 for length 3–4. **Regeneration
  is +10 energy at the start of each of your turns** (`ENERGY_PER_TURN = 10`,
  capped at 100). There is no per-second regeneration any more.
- Max 10 active blockades per player. (In practice the energy economy binds
  first: each placement costs at least 20 and only 10 comes back per turn.)
- A blockade may not overlap an existing blockade edge, may not leave the grid,
  and — the fairness rule — **must never leave either player without a path to
  their goal**. The engine runs BFS for both players after a hypothetical
  placement and rejects it if either has no path. This is enforced on the
  server; clients only preview.
- Blockades are permanent for the match in milestone 1 (no expiry/retraction).

## Timer and scoring
- Default match length: 180 seconds (configurable per room).
- On timeout: the player with the fewest rows remaining to their goal wins.
  Equal distance is a draw.
- Score (per match): win = 100 + 2 × seconds remaining (rounded down);
  draw = 25 each; loss = 0. Ranked-lite points: win +25, draw +5, loss −10
  (floor 0), tracked in-session only in milestone 1.
- If a player disconnects, the opponent waits 30 s (grace period, reconnect
  token); after that the disconnected player forfeits.

## Fair play
- The server is authoritative: it validates every move and placement, enforces
  the turn order, energy, and the BFS fairness rule, and never trusts client state.
- Inputs carry sequence numbers; duplicates and out-of-order inputs are ignored.
