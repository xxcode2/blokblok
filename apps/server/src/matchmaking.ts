// BLOCKADE ARENA — public 1v1 matchmaking queue.
// FIFO pairing on identical mode + gridSize. Ranked-lite: no skill rating in
// milestone 1 (spec §7 lists rating as a later-phase concern); first two
// compatible players are paired.

import type { GameMode } from "@blockade/core";

export interface QueueEntry {
  playerId: string;
  name: string;
  mode: GameMode;
  gridSize: number;
  /** Room size requested (2, or 4 for trophy mode). */
  playerCount: number;
  enqueuedAtMs: number;
}

export class Matchmaker {
  private queue: QueueEntry[] = [];

  enqueue(playerId: string, name: string, mode: GameMode, gridSize: number, playerCount = 2): number {
    const existing = this.queue.findIndex((e) => e.playerId === playerId);
    if (existing >= 0) return existing + 1;
    this.queue.push({ playerId, name, mode, gridSize, playerCount, enqueuedAtMs: Date.now() });
    return this.queue.length;
  }

  leave(playerId: string): boolean {
    const i = this.queue.findIndex((e) => e.playerId === playerId);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  position(playerId: string): number {
    const i = this.queue.findIndex((e) => e.playerId === playerId);
    return i < 0 ? 0 : i + 1;
  }

  size(): number {
    return this.queue.length;
  }

  /** Oldest two entries with the same mode + gridSize, or null. */
  findPair(): [QueueEntry, QueueEntry] | null {
    const group = this.findGroup(2);
    return group ? [group[0], group[1]] : null;
  }

  /** Player count requested by the oldest queued entry (2, or 4 for a 4P
   *  trophy room); 2 when the queue is empty. */
  peekGroupSize(): number {
    return this.queue[0]?.playerCount ?? 2;
  }

  /**
   * Oldest `count` entries with the same mode + gridSize + playerCount, or
   * null. Used for 4P trophy rooms (count 4); race rooms always pair 2.
   * Player count is part of the match key: a 2P trophy player never joins
   * a 4P trophy room.
   */
  findGroup(count: number): QueueEntry[] | null {
    for (let i = 0; i < this.queue.length; i++) {
      const head = this.queue[i];
      const group: QueueEntry[] = [head];
      for (let j = i + 1; j < this.queue.length && group.length < count; j++) {
        const cand = this.queue[j];
        if (cand.mode === head.mode && cand.gridSize === head.gridSize && cand.playerCount === head.playerCount) {
          group.push(cand);
        }
      }
      if (group.length === count) {
        // Remove the grouped entries (highest index first to keep indices valid).
        const idxs = group.map((g) => this.queue.indexOf(g)).sort((a, b) => b - a);
        for (const k of idxs) this.queue.splice(k, 1);
        return group;
      }
    }
    return null;
  }
}
