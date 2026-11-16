// BLOCKADE ARENA — authoritative match simulation.
// One Match = one GameEngine + a fixed 20 ticks/sec loop. Inputs are queued
// between ticks and applied in seq order; the engine validates everything.
// The tick path is deliberately light: apply inputs, step the engine, drain
// deltas, broadcast. No blocking work happens on the tick path.

import { GameEngine } from "@blockade/core";
import type {
  ClientMessage,
  Dir,
  Edge,
  Orientation,
  ServerMessage,
} from "@blockade/core";

export const TICK_MS = 50;
export const STATE_BROADCAST_EVERY_TICKS = 20; // full snapshot ~every 1s

export interface MatchPlayer {
  id: string;
  name: string;
}

export interface MatchHooks {
  send(playerId: string, msg: ServerMessage): void;
  broadcast(msg: ServerMessage): void;
  onFinish(result: ServerMessage & { type: "result" }): void;
}

interface QueuedInput {
  seq: number;
  msg: Extract<ClientMessage, { type: "input" }>;
}

export interface TickStats {
  ticks: number;
  avgMs: number;
  maxMs: number;
}

export class Match {
  readonly id: string;
  readonly engine: GameEngine;
  readonly players: [MatchPlayer, MatchPlayer];
  private hooks: MatchHooks;
  private timer: ReturnType<typeof setInterval> | null = null;
  private queues = new Map<string, QueuedInput[]>();
  private lastSeq = new Map<string, number>();
  private tickStats = { ticks: 0, totalMs: 0, maxMs: 0 };
  private ticksSinceState = 0;
  private finished = false;
  private startedAtMs = 0;

  constructor(id: string, engine: GameEngine, players: [MatchPlayer, MatchPlayer], hooks: MatchHooks) {
    this.id = id;
    this.engine = engine;
    this.players = players;
    this.hooks = hooks;
    for (const p of players) {
      this.queues.set(p.id, []);
      this.lastSeq.set(p.id, 0);
    }
  }

  /** Start the 20/s loop. Call once, right after the countdown ends. */
  start(nowMs: number): void {
    if (this.timer) return;
    this.startedAtMs = nowMs;
    this.engine.start(nowMs);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Unref so a stray match never keeps the process alive on its own.
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === "function") {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isFinished(): boolean {
    return this.finished;
  }

  getTickStats(): TickStats {
    const { ticks, totalMs, maxMs } = this.tickStats;
    return { ticks, avgMs: ticks === 0 ? 0 : totalMs / ticks, maxMs };
  }

  /** Queue an input for the next tick. Duplicates / out-of-order seqs are ignored. */
  queueInput(playerId: string, msg: Extract<ClientMessage, { type: "input" }>): boolean {
    if (this.finished) return false;
    const last = this.lastSeq.get(playerId) ?? 0;
    if (msg.seq <= last) return false; // duplicate or out-of-order: ignore silently
    this.lastSeq.set(playerId, msg.seq);
    this.queues.get(playerId)?.push({ seq: msg.seq, msg });
    return true;
  }

  /** Forfeit: the named player loses immediately (disconnect grace expired). */
  forfeit(playerId: string): void {
    if (this.finished) return;
    this.engine.forfeit(playerId);
    this.finishNow();
  }

  private applyInput(playerId: string, input: QueuedInput): void {
    const msg = input.msg;
    const sendError = (code: string, message: string) =>
      this.hooks.send(playerId, { type: "error", code, message });
    // Authoritative turn enforcement (protocol 1.1.0): only the active
    // player may act, and only once per turn. The engine enforces this too;
    // the check here rejects out-of-turn inputs before they reach it.
    if (this.engine.activePlayerId !== playerId) {
      return sendError("NOT_YOUR_TURN", "it is not your turn");
    }
    if (msg.kind === "move") {
      const res = this.engine.tryMove(playerId, msg.dir as Dir);
      if (!res.ok) sendError(res.error, res.message);
    } else if (msg.kind === "place") {
      const res = this.engine.tryPlace(playerId, msg.edge as Edge);
      if (!res.ok) sendError(res.error, res.message);
    } else if (msg.kind === "placeAuto") {
      const res = this.engine.tryPlaceAuto(playerId, msg.dir as Dir, msg.orientation as Orientation, msg.len);
      if (!res.ok) sendError(res.error, res.message);
    } else {
      sendError("BAD_REQUEST", "unknown input kind");
    }
  }

  private tick(): void {
    if (this.finished) return;
    const t0 = performance.now();
    // 1. Apply queued inputs in seq order (per player; players are independent).
    for (const [playerId, queue] of this.queues) {
      if (queue.length === 0) continue;
      queue.sort((a, b) => a.seq - b.seq);
      for (const input of queue) this.applyInput(playerId, input);
      queue.length = 0;
    }
    // 2. Step the engine by real elapsed time.
    this.engine.tickAt(Date.now());
    // 3. Broadcast the delta for this tick (may be timer-only).
    const events = this.engine.drainDeltas();
    if (events.length > 0) {
      this.hooks.broadcast({ type: "delta", tick: this.engine.tickCount, events });
    }
    // 4. Full snapshot ~every 1s so clients can resync cheaply.
    this.ticksSinceState++;
    if (this.ticksSinceState >= STATE_BROADCAST_EVERY_TICKS) {
      this.ticksSinceState = 0;
      this.hooks.broadcast({ type: "state", tick: this.engine.tickCount, snapshot: this.engine.snapshot() });
    }
    // 5. Match over? Send the result once.
    if (this.engine.status === "finished") this.finishNow();
    const dt = performance.now() - t0;
    this.tickStats.ticks++;
    this.tickStats.totalMs += dt;
    if (dt > this.tickStats.maxMs) this.tickStats.maxMs = dt;
  }

  private finishNow(): void {
    if (this.finished) return;
    this.finished = true;
    this.stop();
    const snap = this.engine.snapshot();
    const scores: Record<string, number> = {};
    for (const p of snap.players) scores[p.id] = p.score;
    const reason = this.engine.winReason ?? "draw";
    this.hooks.onFinish({
      type: "result",
      winnerId: this.engine.winnerId,
      reason,
      scores,
      stats: this.engine.stats(),
      durationMs: this.engine.durationMs(),
    });
  }
}
