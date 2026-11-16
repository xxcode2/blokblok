# BLOCKADE ARENA — Game Rules (Milestone 1)

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

## Movement
- One cell at a time: up, down, left, right. No diagonals.
- A move is illegal if it leaves the grid, crosses a blockade edge, or lands on
  the opponent's cell.
- Move cooldown: 150 ms between moves. Inputs during cooldown are buffered
  (the latest buffered direction is executed when the cooldown ends).
- Movement is interpolated smoothly on the client; the server simulates
  discretely (one cell per accepted move).

## Blockades
- A blockade is a straight line of 1–4 consecutive edges, horizontal or vertical.
- Placement methods: (A) drag from a grid edge with a live preview (green/cyan =
  valid, red = invalid); (B) blockade button — the server places the nearest
  valid blockade ahead of you in the chosen direction.
- Energy: max 100. Cost 20 for length 1–2, 35 for length 3–4. Regeneration 5/s.
- Placement cooldown: 500 ms. Max 10 active blockades per player.
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
  cooldowns, energy, and the BFS fairness rule, and never trusts client state.
- Inputs carry sequence numbers; duplicates and out-of-order inputs are ignored.
