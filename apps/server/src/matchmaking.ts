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
  enqueuedAtMs: number;
}

export class Matchmaker {
  private queue: QueueEntry[] = [];

  enqueue(playerId: string, name: string, mode: GameMode, gridSize: number): number {
    const existing = this.queue.findIndex((e) => e.playerId === playerId);
    if (existing >= 0) return existing + 1;
    this.queue.push({ playerId, name, mode, gridSize, enqueuedAtMs: Date.now() });
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
    for (let i = 0; i < this.queue.length; i++) {
      for (let j = i + 1; j < this.queue.length; j++) {
        const a = this.queue[i];
        const b = this.queue[j];
        if (a.mode === b.mode && a.gridSize === b.gridSize) {
          this.queue.splice(j, 1);
          this.queue.splice(i, 1);
          return [a, b];
        }
      }
    }
    return null;
  }
}
