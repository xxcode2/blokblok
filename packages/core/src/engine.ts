// BLOCKADE ARENA — authoritative game engine (shared by server + web client).
// Implements GAME_RULES.md exactly: Race to the Top, edge-model blockades,
// BFS fairness rule, energy/cooldowns, timer + timeout scoring.
// The engine is deterministic and has no I/O; the server ticks it at 20/s,
// the web client ticks a local copy for practice / local 2P / drag previews.

import {
  blockadeCost,
  DIRS,
  edgeKey,
  edgesForBlockade,
  ENERGY_REGEN_PER_SEC,
  MAX_BLOCKADES_PER_PLAYER,
  MAX_BLOCKADE_LEN,
  MAX_ENERGY,
  MOVE_COOLDOWN_MS,
  PLACE_COOLDOWN_MS,
  scoreForOutcome,
  type BlockadeState,
  type DeltaEvent,
  type Dir,
  type Edge,
  type GameMode,
  type MatchStatus,
  type Orientation,
  type PlayerState,
  type Snapshot,
} from "./types.js";

export type EngineResult = { ok: true; events: DeltaEvent[] } | { ok: false; code: string; message: string };

export interface EngineOptions {
  gridSize?: number;
  durationSec?: number;
  mode?: GameMode;
}

interface PlayerInternal {
  id: string;
  name: string;
  color: "blue" | "red";
  row: number;
  col: number;
  energy: number;
  moveCooldownMs: number;
  placeCooldownMs: number;
  score: number;
  moves: number;
  blockadesPlaced: number;
  /** Latest direction received during the move cooldown; applied when it ends. */
  bufferedDir: Dir | null;
  /** In-flight move animation: from-cell, to-cell, tick the move landed on. */
  anim: { fromRow: number; fromCol: number; toRow: number; toCol: number; startTick: number } | null;
}

let blockadeSeq = 0;

/** Move animation length (ms) — one cell per move cooldown, eased, never a teleport. */
export const MOVE_ANIM_MS = MOVE_COOLDOWN_MS;
/** Blockade deployment (grow-in) length in ms. */
export const DEPLOY_MS = 250;

/** easeOutCubic: fast start, soft landing — the standard orb-move easing. */
export function easeOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - x, 3);
}

export class GameEngine {
  readonly gridSize: number;
  readonly durationSec: number;
  readonly mode: GameMode;
  tickCount = 0;
  status: MatchStatus = "playing";
  timeLeftMs: number;
  winnerId: string | null = null;
  winReason: "goal" | "timeout" | "forfeit" | "draw" | null = null;
  startedAtMs = 0;
  private players: PlayerInternal[] = [];
  /** occupied single edges, keyed by edgeKey */
  private blocked = new Set<string>();
  private blockades: BlockadeState[] = [];
  private elapsedMs = 0;
  /** Monotonic engine clock (ms), advanced by tickMs. Animations key off ticks. */
  private clockMs = 0;
  private lastTickMs = 0;
  /** Delta events since the last drainDeltas() (server broadcasts these). */
  private pendingEvents: DeltaEvent[] = [];
  /** Retained events for deltaSince() (ring, capped). */
  private retainedEvents: { tick: number; event: DeltaEvent }[] = [];

  /** Record events into the delta log (pending + retained ring). */
  private record(events: DeltaEvent[]): void {
    for (const e of events) {
      this.pendingEvents.push(e);
      this.retainedEvents.push({ tick: this.tickCount, event: e });
    }
    if (this.retainedEvents.length > 2000) {
      this.retainedEvents.splice(0, this.retainedEvents.length - 2000);
    }
  }

  /** Drain and clear all pending delta events (server calls this each tick). */
  drainDeltas(): DeltaEvent[] {
    const out = this.pendingEvents;
    this.pendingEvents = [];
    return out;
  }

  /** All retained events with tick > `sinceTick` (non-destructive). */
  deltaSince(sinceTick: number): DeltaEvent[] {
    return this.retainedEvents.filter((r) => r.tick > sinceTick).map((r) => r.event);
  }

  getClockMs(): number {
    return this.clockMs;
  }

  constructor(opts: EngineOptions = {}) {
    this.gridSize = opts.gridSize ?? 12;
    this.durationSec = opts.durationSec ?? 180;
    this.mode = opts.mode ?? "race";
    this.timeLeftMs = this.durationSec * 1000;
  }

  // -- setup ---------------------------------------------------------------
  addPlayer(id: string, name: string): PlayerState {
    if (this.players.length >= 2) throw new Error("Race mode supports exactly 2 players");
    const idx = this.players.length;
    const color = idx === 0 ? ("blue" as const) : ("red" as const);
    const centre = Math.floor(this.gridSize / 2);
    const p: PlayerInternal = {
      id,
      name,
      color,
      row: idx === 0 ? this.gridSize - 1 : 0,
      col: centre,
      energy: MAX_ENERGY,
      moveCooldownMs: 0,
      placeCooldownMs: 0,
      score: 0,
      moves: 0,
      blockadesPlaced: 0,
      bufferedDir: null,
      anim: null,
    };
    this.players.push(p);
    return this.playerState(p);
  }

  getPlayer(id: string): PlayerInternal | undefined {
    return this.players.find((p) => p.id === id);
  }

  /** Lobby → countdown phase (server drives the 3 s countdown, then start()). */
  beginCountdown(): void {
    if (this.status === "lobby") this.status = "countdown";
  }

  /** Start the match clock. Safe to call when status is already "playing". */
  start(nowMs: number): void {
    this.status = "playing";
    this.elapsedMs = 0;
    this.timeLeftMs = this.durationSec * 1000;
    this.lastTickMs = nowMs;
    for (const p of this.players) {
      p.moveCooldownMs = 0;
      p.placeCooldownMs = 0;
      p.bufferedDir = null;
    }
  }

  /**
   * Wall-clock tick entry point (server: 20/s). Advances the simulation by
   * the real elapsed time since the previous tick and returns the delta
   * events for this tick. Also applies buffered moves whose cooldown ended.
   * (Named tickAt because `tick` is already the engine's tick counter.)
   */
  tickAt(nowMs: number): DeltaEvent[] {
    const dt = this.lastTickMs > 0 ? Math.min(250, Math.max(0, nowMs - this.lastTickMs)) : 50;
    this.lastTickMs = nowMs;
    if (this.status !== "playing") return [];
    return this.tickMs(dt);
  }

  goalRow(p: PlayerInternal): number {
    return p.color === "blue" ? 0 : this.gridSize - 1;
  }

  rowsRemaining(p: PlayerInternal): number {
    return Math.abs(p.row - this.goalRow(p));
  }

  progress(p: PlayerInternal): number {
    return 1 - this.rowsRemaining(p) / (this.gridSize - 1);
  }

  // -- edge model ----------------------------------------------------------
  /** Is the single edge occupied by a blockade? */
  isEdgeBlocked(row: number, col: number, orientation: Orientation): boolean {
    return this.blocked.has(edgeKey({ row, col, orientation }));
  }

  /** Is movement from (row,col) in `dir` blocked by a blockade edge? */
  isMoveBlocked(row: number, col: number, dir: Dir): boolean {
    switch (dir) {
      case "up":
        return this.isEdgeBlocked(row, col, "h");
      case "down":
        return this.isEdgeBlocked(row + 1, col, "h");
      case "left":
        return this.isEdgeBlocked(row, col, "v");
      case "right":
        return this.isEdgeBlocked(row, col + 1, "v");
    }
  }

  legalMoves(playerId: string): Dir[] {
    const p = this.getPlayer(playerId);
    if (!p || this.status !== "playing") return [];
    const out: Dir[] = [];
    for (const dir of Object.keys(DIRS) as Dir[]) {
      const { dr, dc } = DIRS[dir];
      const nr = p.row + dr;
      const nc = p.col + dc;
      if (nr < 0 || nr >= this.gridSize || nc < 0 || nc >= this.gridSize) continue;
      if (this.isMoveBlocked(p.row, p.col, dir)) continue;
      if (this.players.some((q) => q.id !== p.id && q.row === nr && q.col === nc)) continue;
      out.push(dir);
    }
    return out;
  }

  // -- pathfinding (BFS fairness rule) --------------------------------------
  /** Shortest path length in moves from a player's cell to their goal row,
   *  or null if unreachable. `extra` edges are treated as blocked too. */
  shortestPathLength(playerId: string, extra?: Set<string>): number | null {
    const p = this.getPlayer(playerId);
    if (!p) return null;
    const goal = this.goalRow(p);
    const blocked = (r: number, c: number, dir: Dir): boolean => {
      if (extra) {
        switch (dir) {
          case "up":
            if (extra.has(edgeKey({ row: r, col: c, orientation: "h" }))) return true;
            break;
          case "down":
            if (extra.has(edgeKey({ row: r + 1, col: c, orientation: "h" }))) return true;
            break;
          case "left":
            if (extra.has(edgeKey({ row: r, col: c, orientation: "v" }))) return true;
            break;
          case "right":
            if (extra.has(edgeKey({ row: r, col: c + 1, orientation: "v" }))) return true;
            break;
        }
      }
      return this.isMoveBlocked(r, c, dir);
    };
    const seen = new Set<string>([`${p.row},${p.col}`]);
    const queue: { r: number; c: number; d: number }[] = [{ r: p.row, c: p.col, d: 0 }];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.r === goal) return cur.d;
      for (const dir of Object.keys(DIRS) as Dir[]) {
        const { dr, dc } = DIRS[dir];
        const nr = cur.r + dr;
        const nc = cur.c + dc;
        if (nr < 0 || nr >= this.gridSize || nc < 0 || nc >= this.gridSize) continue;
        if (blocked(cur.r, cur.c, dir)) continue;
        const key = `${nr},${nc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ r: nr, c: nc, d: cur.d + 1 });
      }
    }
    return null;
  }

  /** Next direction along a shortest path to the goal, or null. */
  nextStepTowardGoal(playerId: string): Dir | null {
    const p = this.getPlayer(playerId);
    if (!p) return null;
    // BFS from the goal row backwards, then walk from the player.
    const goal = this.goalRow(p);
    const dist = new Map<string, number>();
    const queue: { r: number; c: number }[] = [];
    for (let c = 0; c < this.gridSize; c++) {
      dist.set(`${goal},${c}`, 0);
      queue.push({ r: goal, c });
    }
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const d = dist.get(`${cur.r},${cur.c}`)!;
      for (const dir of Object.keys(DIRS) as Dir[]) {
        const { dr, dc } = DIRS[dir];
        const nr = cur.r + dr;
        const nc = cur.c + dc;
        if (nr < 0 || nr >= this.gridSize || nc < 0 || nc >= this.gridSize) continue;
        // reverse move: from (nr,nc) moving opposite dir reaches cur
        const rev: Dir = dir === "up" ? "down" : dir === "down" ? "up" : dir === "left" ? "right" : "left";
        if (this.isMoveBlocked(nr, nc, rev)) continue;
        const key = `${nr},${nc}`;
        if (!dist.has(key)) {
          dist.set(key, d + 1);
          queue.push({ r: nr, c: nc });
        }
      }
    }
    const here = dist.get(`${p.row},${p.col}`);
    if (here === undefined || here === 0) return null;
    for (const dir of Object.keys(DIRS) as Dir[]) {
      const { dr, dc } = DIRS[dir];
      const nr = p.row + dr;
      const nc = p.col + dc;
      if (nr < 0 || nr >= this.gridSize || nc < 0 || nc >= this.gridSize) continue;
      if (this.isMoveBlocked(p.row, p.col, dir)) continue;
      if (this.players.some((q) => q.id !== p.id && q.row === nr && q.col === nc)) continue;
      if (dist.get(`${nr},${nc}`) === here - 1) return dir;
    }
    return null;
  }

  // -- validation ------------------------------------------------------------
  /** Validate a blockade without applying it. Returns an error code or null. */
  validatePlace(playerId: string, edge: Edge): string | null {
    const p = this.getPlayer(playerId);
    if (!p) return "NOT_IN_MATCH";
    if (this.status !== "playing") return "INVALID_BLOCKADE";
    if (!Number.isInteger(edge.len) || edge.len < 1 || edge.len > MAX_BLOCKADE_LEN) return "INVALID_BLOCKADE";
    if (p.placeCooldownMs > 0) return "ON_COOLDOWN";
    if (this.blockades.filter((b) => b.playerId === playerId).length >= MAX_BLOCKADES_PER_PLAYER) {
      return "INVALID_BLOCKADE";
    }
    if (blockadeCost(edge.len) > p.energy) return "NO_ENERGY";
    const singles = edgesForBlockade(edge);
    for (const s of singles) {
      if (edge.orientation === "h") {
        if (s.row < 1 || s.row >= this.gridSize || s.col < 0 || s.col >= this.gridSize) return "INVALID_BLOCKADE";
      } else {
        if (s.row < 0 || s.row >= this.gridSize || s.col < 1 || s.col >= this.gridSize) return "INVALID_BLOCKADE";
      }
      if (this.blocked.has(edgeKey(s))) return "INVALID_BLOCKADE";
    }
    // BFS fairness: both players must keep a path to their goal.
    const extra = new Set(singles.map((s) => edgeKey(s)));
    for (const q of this.players) {
      if (this.shortestPathLength(q.id, extra) === null) return "NO_PATH";
    }
    return null;
  }

  // -- actions -----------------------------------------------------------------
  move(playerId: string, dir: Dir): EngineResult {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, code: "NOT_IN_MATCH", message: "player not in match" };
    if (this.status !== "playing") return { ok: false, code: "INVALID_MOVE", message: "match not playing" };
    if (p.moveCooldownMs > 0) return { ok: false, code: "ON_COOLDOWN", message: "move on cooldown" };
    const { dr, dc } = DIRS[dir];
    const nr = p.row + dr;
    const nc = p.col + dc;
    const collide = (message: string): EngineResult => {
      // Collision feedback: clients turn this into sparks + a thud, and the
      // orb stays put — it never teleports or clips through the wall.
      this.record([{ k: "collide", playerId, row: p.row, col: p.col, tick: this.tickCount }]);
      return { ok: false, code: "INVALID_MOVE", message };
    };
    if (nr < 0 || nr >= this.gridSize || nc < 0 || nc >= this.gridSize) {
      return collide("move leaves the grid");
    }
    if (this.isMoveBlocked(p.row, p.col, dir)) {
      return collide("move crosses a blockade");
    }
    if (this.players.some((q) => q.id !== p.id && q.row === nr && q.col === nc)) {
      return collide("cell occupied by opponent");
    }
    // Record the animation BEFORE updating the cell: clients interpolate
    // from the old cell to the new one over MOVE_ANIM_MS with easing.
    p.anim = { fromRow: p.row, fromCol: p.col, toRow: nr, toCol: nc, startTick: this.tickCount };
    p.row = nr;
    p.col = nc;
    p.moves++;
    p.moveCooldownMs = MOVE_COOLDOWN_MS;
    const events: DeltaEvent[] = [{ k: "move", playerId, row: nr, col: nc, tick: this.tickCount }];
    this.record(events);
    if (nr === this.goalRow(p)) {
      this.finish(p.id, "goal");
    }
    return { ok: true, events };
  }

  /**
   * Task-spec move entry point: inputs arriving during the move cooldown are
   * BUFFERED (latest wins) and applied by tick() when the cooldown ends,
   * instead of being rejected — holding a direction glides smoothly instead
   * of stuttering. Returns {ok, buffered} for a buffered input.
   */
  tryMove(
    playerId: string,
    dir: Dir,
    _nowMs?: number,
  ): { ok: true; buffered?: boolean } | { ok: false; error: string; message: string } {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, error: "NOT_IN_MATCH", message: "player not in match" };
    if (this.status !== "playing") return { ok: false, error: "NOT_IN_MATCH", message: "match not playing" };
    if (p.moveCooldownMs > 0) {
      p.bufferedDir = dir;
      return { ok: true, buffered: true };
    }
    const res = this.move(playerId, dir);
    return res.ok ? { ok: true } : { ok: false, error: res.code, message: res.message };
  }

  place(playerId: string, edge: Edge): EngineResult {
    const err = this.validatePlace(playerId, edge);
    if (err) {
      const message =
        err === "NO_PATH"
          ? "placement would leave a player with no path to their goal"
          : err === "NO_ENERGY"
            ? "not enough energy"
            : err === "ON_COOLDOWN"
              ? "placement on cooldown"
              : "invalid blockade placement";
      return { ok: false, code: err, message };
    }
    const p = this.getPlayer(playerId)!;
    // Store the blockade as its L individual single edges (DEVELOPMENT.md:
    // a length-L blockade IS L consecutive edges) so clients can render the
    // grow-in animation edge-by-edge and collision checks stay trivial.
    const singles = edgesForBlockade(edge).map((s) => ({ ...s, len: 1 }));
    const blockade: BlockadeState = {
      id: `b${++blockadeSeq}_${this.tickCount}`,
      playerId,
      edges: singles,
      createdTick: this.tickCount,
      placedTick: this.tickCount,
      deployDurationMs: DEPLOY_MS,
    };
    for (const s of singles) this.blocked.add(edgeKey(s));
    this.blockades.push(blockade);
    p.energy -= blockadeCost(edge.len);
    p.placeCooldownMs = PLACE_COOLDOWN_MS;
    p.blockadesPlaced++;
    const events: DeltaEvent[] = [
      { k: "blockade", blockade },
      { k: "energy", playerId, energy: p.energy },
    ];
    this.record(events);
    return { ok: true, events };
  }

  /** Task-spec place entry point (same rules, {ok, blockade} | {error} shape). */
  tryPlace(
    playerId: string,
    edge: Edge,
    _nowMs?: number,
  ): { ok: true; blockade: BlockadeState } | { ok: false; error: string; message: string } {
    const res = this.place(playerId, edge);
    if (!res.ok) return { ok: false, error: res.code, message: res.message };
    let blockade: BlockadeState | undefined;
    for (const e of res.events) if (e.k === "blockade") blockade = e.blockade;
    if (!blockade) return { ok: false, error: "INVALID_BLOCKADE", message: "placement produced no blockade" };
    return { ok: true, blockade };
  }

  /** Button placement: nearest valid blockade ahead of the player in `dir`.
   *  Scans outward from the player; tries placements centred on the player's
   *  line first, then shifted along the line. Returns the placed edge or an
   *  error (same codes as place). */
  placeAuto(playerId: string, dir: Dir, orientation: Orientation, len: number): EngineResult {
    const p = this.getPlayer(playerId);
    if (!p) return { ok: false, code: "NOT_IN_MATCH", message: "player not in match" };
    const N = this.gridSize;
    // Candidate anchors at increasing distance d ahead of the player.
    for (let d = 0; d < N; d++) {
      const anchors: Edge[] = [];
      if (orientation === "h") {
        // Horizontal line: row is just ahead of the player in dir.
        const row = dir === "up" ? p.row - d : dir === "down" ? p.row + 1 + d : p.row;
        if (dir === "left" || dir === "right") {
          // No forward step for h-lines when moving sideways; only d=0 makes sense.
          if (d > 0) break;
        }
        // Centre the line on the player's column, then shift both ways.
        const base = p.col - Math.floor((len - 1) / 2);
        for (let shift = 0; shift < N; shift++) {
          for (const s of shift === 0 ? [0] : [shift, -shift]) {
            anchors.push({ row, col: base + s, orientation: "h", len });
          }
        }
      } else {
        const col = dir === "left" ? p.col - d : dir === "right" ? p.col + 1 + d : p.col;
        if (dir === "up" || dir === "down") {
          if (d > 0) break;
        }
        const base = p.row - Math.floor((len - 1) / 2);
        for (let shift = 0; shift < N; shift++) {
          for (const s of shift === 0 ? [0] : [shift, -shift]) {
            anchors.push({ row: base + s, col, orientation: "v", len });
          }
        }
      }
      for (const edge of anchors) {
        if (this.validatePlace(playerId, edge) === null) {
          return this.place(playerId, edge);
        }
      }
    }
    return { ok: false, code: "INVALID_BLOCKADE", message: "no valid placement ahead" };
  }

  /** Task-spec auto-place entry point (same rules, {ok, blockade} | {error}). */
  tryPlaceAuto(
    playerId: string,
    dir: Dir,
    orientation: Orientation,
    len: number,
    _nowMs?: number,
  ): { ok: true; blockade: BlockadeState } | { ok: false; error: string; message: string } {
    const res = this.placeAuto(playerId, dir, orientation, len);
    if (!res.ok) return { ok: false, error: res.code, message: res.message };
    let blockade: BlockadeState | undefined;
    for (const e of res.events) if (e.k === "blockade") blockade = e.blockade;
    if (!blockade) return { ok: false, error: "INVALID_BLOCKADE", message: "placement produced no blockade" };
    return { ok: true, blockade };
  }

  // -- simulation ---------------------------------------------------------------
  /** Advance the simulation by dtMs (server ticks at 50ms; local client per frame). */
  tickMs(dtMs: number): DeltaEvent[] {
    if (this.status !== "playing") return [];
    this.tickCount++;
    this.clockMs += dtMs;
    this.elapsedMs += dtMs;
    this.timeLeftMs = Math.max(0, this.durationSec * 1000 - this.elapsedMs);
    // Events this tick itself generates (energy/timer). Buffered-move events
    // are recorded inside move() — they are returned here, not re-recorded.
    const ownEvents: DeltaEvent[] = [];
    const moveEvents: DeltaEvent[] = [];
    for (const p of this.players) {
      p.moveCooldownMs = Math.max(0, p.moveCooldownMs - dtMs);
      p.placeCooldownMs = Math.max(0, p.placeCooldownMs - dtMs);
      const before = p.energy;
      p.energy = Math.min(MAX_ENERGY, p.energy + (ENERGY_REGEN_PER_SEC * dtMs) / 1000);
      if (Math.floor(p.energy) !== Math.floor(before)) {
        ownEvents.push({ k: "energy", playerId: p.id, energy: Math.floor(p.energy) });
      }
    }
    // Apply buffered moves whose cooldown has now ended (one per player per
    // tick — the next buffered input waits for the next cooldown window, so
    // held directions glide cell-by-cell instead of queue-jumping).
    for (const p of this.players) {
      if (p.bufferedDir !== null && p.moveCooldownMs <= 0) {
        const dir = p.bufferedDir;
        p.bufferedDir = null;
        const res = this.move(p.id, dir);
        if (res.ok) moveEvents.push(...res.events);
        if (this.status !== "playing") break;
      }
    }
    if (this.timeLeftMs <= 0) {
      this.finishByTimeout();
      ownEvents.push({ k: "timer", timeLeftMs: 0 });
    } else {
      ownEvents.push({ k: "timer", timeLeftMs: this.timeLeftMs });
    }
    this.record(ownEvents);
    return [...moveEvents, ...ownEvents];
  }

  private finish(winnerId: string | null, reason: "goal" | "timeout" | "forfeit" | "draw"): void {
    this.status = "finished";
    this.winnerId = winnerId;
    this.winReason = reason;
    const secsLeft = Math.floor(this.timeLeftMs / 1000);
    const events: DeltaEvent[] = [{ k: "win", winnerId, reason, tick: this.tickCount }];
    for (const p of this.players) {
      const outcome = winnerId === null ? "draw" : p.id === winnerId ? "win" : "loss";
      p.score = scoreForOutcome(outcome, outcome === "win" ? secsLeft : 0);
      events.push({ k: "score", playerId: p.id, score: p.score });
    }
    this.record(events);
  }

  private finishByTimeout(): void {
    if (this.players.length < 2) {
      this.finish(this.players[0]?.id ?? null, "timeout");
      return;
    }
    const [a, b] = this.players;
    const ra = this.rowsRemaining(a);
    const rb = this.rowsRemaining(b);
    if (ra === rb) this.finish(null, "draw");
    else this.finish(ra < rb ? a.id : b.id, "timeout");
  }

  forfeit(playerId: string): void {
    if (this.status !== "playing") return;
    const other = this.players.find((p) => p.id !== playerId);
    this.finish(other?.id ?? null, "forfeit");
  }

  // -- animation helpers (render-facing) ---------------------------------------
  /**
   * Interpolated orb position at engine tick `atTick` (default: current tick).
   * Returns fractional cell coordinates eased with easeOutCubic, so the orb
   * glides from the old cell to the new one and NEVER teleports: at the tick
   * a move lands the orb is still at the old cell (progress 0) and it
   * arrives over the next MOVE_ANIM_MS (3 ticks at 20/s).
   */
  interpolatedPosition(
    playerId: string,
    atTick: number = this.tickCount,
  ): { row: number; col: number; progress: number; moving: boolean } {
    const p = this.getPlayer(playerId);
    if (!p) return { row: 0, col: 0, progress: 1, moving: false };
    const anim = p.anim;
    if (!anim) return { row: p.row, col: p.col, progress: 1, moving: false };
    const raw = ((atTick - anim.startTick) * 50) / MOVE_ANIM_MS;
    if (raw >= 1) return { row: p.row, col: p.col, progress: 1, moving: false };
    const t = easeOutCubic(raw);
    return {
      row: anim.fromRow + (anim.toRow - anim.fromRow) * t,
      col: anim.fromCol + (anim.toCol - anim.fromCol) * t,
      progress: t,
      moving: true,
    };
  }

  /** Grow-in progress (0..1, eased) of a blockade at engine tick `atTick`. */
  blockadeDeployProgress(blockade: BlockadeState, atTick: number = this.tickCount): number {
    const placedTick = blockade.placedTick ?? blockade.createdTick;
    const durationMs = blockade.deployDurationMs ?? DEPLOY_MS;
    return easeOutCubic(((atTick - placedTick) * 50) / durationMs);
  }

  // -- snapshots ------------------------------------------------------------------
  playerState(p: PlayerInternal): PlayerState {
    const state: PlayerState = {
      id: p.id,
      name: p.name,
      color: p.color,
      row: p.row,
      col: p.col,
      energy: Math.floor(p.energy),
      moveCooldownMs: p.moveCooldownMs,
      placeCooldownMs: p.placeCooldownMs,
      score: p.score,
      progress: this.progress(p),
    };
    // Expose the in-flight animation while it is still running so clients
    // can interpolate; once done the orb simply sits on its cell.
    if (p.anim) {
      const done = (this.tickCount - p.anim.startTick) * 50 >= MOVE_ANIM_MS;
      if (!done) {
        state.anim = {
          fromRow: p.anim.fromRow,
          fromCol: p.anim.fromCol,
          toRow: p.anim.toRow,
          toCol: p.anim.toCol,
          startTick: p.anim.startTick,
          durationMs: MOVE_ANIM_MS,
        };
      }
    }
    return state;
  }

  snapshot(): Snapshot {
    return {
      tick: this.tickCount,
      status: this.status,
      mode: this.mode,
      gridSize: this.gridSize,
      durationSec: this.durationSec,
      timeLeftMs: this.timeLeftMs,
      players: this.players.map((p) => this.playerState(p)),
      blockades: this.blockades.map((b) => ({ ...b, edges: b.edges.map((e) => ({ ...e })) })),
      winnerId: this.winnerId,
    };
  }

  stats(): Record<string, { moves: number; blockades: number }> {
    const out: Record<string, { moves: number; blockades: number }> = {};
    for (const p of this.players) out[p.id] = { moves: p.moves, blockades: p.blockadesPlaced };
    return out;
  }

  durationMs(): number {
    return this.elapsedMs;
  }

  /** Rebuild an engine from a server snapshot (client-side preview/validation
   *  only — the server remains authoritative). */
  static fromSnapshot(snap: Snapshot): GameEngine {
    const eng = new GameEngine({ gridSize: snap.gridSize, durationSec: snap.durationSec, mode: snap.mode });
    eng.tickCount = snap.tick;
    eng.status = snap.status;
    eng.timeLeftMs = snap.timeLeftMs;
    eng.winnerId = snap.winnerId;
    for (const ps of snap.players) {
      const p: PlayerInternal = {
        id: ps.id,
        name: ps.name,
        color: ps.color,
        row: ps.row,
        col: ps.col,
        energy: ps.energy,
        moveCooldownMs: ps.moveCooldownMs,
        placeCooldownMs: ps.placeCooldownMs,
        score: ps.score,
        moves: 0,
        blockadesPlaced: 0,
        bufferedDir: null,
        anim: ps.anim
          ? {
              fromRow: ps.anim.fromRow,
              fromCol: ps.anim.fromCol,
              toRow: ps.anim.toRow,
              toCol: ps.anim.toCol,
              startTick: ps.anim.startTick,
            }
          : null,
      };
      eng.players.push(p);
    }
    for (const b of snap.blockades) {
      eng.blockades.push({ ...b, edges: b.edges.map((e) => ({ ...e })) });
      // Blockades store their L single edges directly; register each one.
      for (const s of b.edges) eng.blocked.add(edgeKey(s));
    }
    return eng;
  }
}
