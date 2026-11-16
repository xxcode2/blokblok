// BLOCKADE ARENA — private rooms (lobby → countdown → match).
// A room owns its GameEngine from creation; players join as P1 (host, blue)
// then P2 (red). The Match wrapper (tick loop) is attached at countdown end.

import { randomBytes } from "node:crypto";
import { GameEngine } from "@blockade/core";
import type { GameMode, GridSize } from "@blockade/core";
import { Match, type MatchHooks } from "./match.js";

export interface RoomPlayer {
  id: string;
  name: string;
  ready: boolean;
  isHost: boolean;
  /** Reconnect token (also used to re-attach after a drop). */
  token: string;
  connected: boolean;
}

export type RoomStatus = "lobby" | "countdown" | "playing" | "finished";

export function newToken(): string {
  return randomBytes(16).toString("hex");
}

export function newRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1 — readable over voice/chat
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[randomBytes(1)[0] % chars.length];
  return code;
}

export class Room {
  readonly id: string;
  readonly code: string;
  readonly mode: GameMode;
  readonly gridSize: GridSize;
  readonly durationSec: number;
  readonly engine: GameEngine;
  readonly createdAtMs = Date.now();
  players = new Map<string, RoomPlayer>();
  status: RoomStatus = "lobby";
  match: Match | null = null;
  private countdownTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(id: string, code: string, mode: GameMode, gridSize: GridSize, durationSec: number) {
    this.id = id;
    this.code = code;
    this.mode = mode;
    this.gridSize = gridSize;
    this.durationSec = durationSec;
    this.engine = new GameEngine({ gridSize, durationSec });
    // The engine defaults to "playing" for local/practice use; a server
    // room holds it in the lobby until the countdown completes.
    this.engine.status = "lobby";
  }

  get hostId(): string | null {
    for (const p of this.players.values()) if (p.isHost) return p.id;
    return null;
  }

  get size(): number {
    return this.players.size;
  }

  isFull(): boolean {
    return this.players.size >= 2;
  }

  addPlayer(id: string, name: string, isHost: boolean): RoomPlayer {
    const player: RoomPlayer = { id, name, ready: false, isHost, token: newToken(), connected: true };
    this.players.set(id, player);
    this.engine.addPlayer(id, name);
    return player;
  }

  removePlayer(id: string): RoomPlayer | undefined {
    const p = this.players.get(id);
    if (!p) return undefined;
    this.players.delete(id);
    // Promote the remaining player to host so the room stays usable.
    if (p.isHost) {
      const next = this.players.values().next().value as RoomPlayer | undefined;
      if (next) next.isHost = true;
    }
    return p;
  }

  setReady(id: string, ready: boolean): boolean {
    const p = this.players.get(id);
    if (!p) return false;
    p.ready = ready;
    return true;
  }

  allReady(): boolean {
    return this.players.size === 2 && [...this.players.values()].every((p) => p.ready);
  }

  lobbyPlayers(): { id: string; name: string; ready: boolean; isHost: boolean }[] {
    return [...this.players.values()].map((p) => ({ id: p.id, name: p.name, ready: p.ready, isHost: p.isHost }));
  }

  /**
   * Begin the 3 s countdown, then attach the Match loop and start the engine.
   * `hooks` wires the match's broadcasts back to the room's sockets.
   */
  startCountdown(hooks: MatchHooks, onCountdown: () => void, onMatchStart: () => void): boolean {
    if (this.status !== "lobby" || !this.allReady()) return false;
    this.status = "countdown";
    this.engine.beginCountdown();
    onCountdown();
    this.countdownTimer = setTimeout(() => {
      this.countdownTimer = null;
      if (this.status !== "countdown") return;
      this.status = "playing";
      const players = [...this.players.values()].map((p) => ({ id: p.id, name: p.name }));
      this.match = new Match(this.id, this.engine, players as [typeof players[0], typeof players[0]], hooks);
      this.match.start(Date.now());
      onMatchStart();
    }, 3000);
    return true;
  }

  cancelCountdown(): void {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
    if (this.status === "countdown") {
      this.status = "lobby";
      this.engine.status = "lobby";
    }
  }

  markFinished(): void {
    this.status = "finished";
    if (this.match) this.match.stop();
  }
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private byCode = new Map<string, Room>();

  create(mode: GameMode, gridSize: GridSize, durationSec: number): Room {
    const id = `room_${randomBytes(6).toString("hex")}`;
    let code = newRoomCode();
    while (this.byCode.has(code)) code = newRoomCode();
    const room = new Room(id, code, mode, gridSize, durationSec);
    this.rooms.set(id, room);
    this.byCode.set(code, room);
    return room;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  getByCode(code: string): Room | undefined {
    return this.byCode.get(code.toUpperCase());
  }

  delete(id: string): void {
    const room = this.rooms.get(id);
    if (!room) return;
    room.cancelCountdown();
    room.markFinished();
    this.rooms.delete(id);
    this.byCode.delete(room.code);
  }

  count(): number {
    return this.rooms.size;
  }

  activeMatches(): number {
    let n = 0;
    for (const r of this.rooms.values()) if (r.match && !r.match.isFinished()) n++;
    return n;
  }

  allTickStats(): { ticks: number; avgMs: number; maxMs: number } {
    let ticks = 0;
    let totalMs = 0;
    let maxMs = 0;
    for (const r of this.rooms.values()) {
      if (!r.match) continue;
      const s = r.match.getTickStats();
      ticks += s.ticks;
      totalMs += s.avgMs * s.ticks;
      if (s.maxMs > maxMs) maxMs = s.maxMs;
    }
    return { ticks, avgMs: ticks === 0 ? 0 : totalMs / ticks, maxMs };
  }
}
