// BLOCKADE ARENA — Canvas renderer (dark graphite neon, spec §13).
//
// Animation contract (user quality bar):
// - Driven ONLY by requestAnimationFrame — never setTimeout / setInterval.
// - Orbs NEVER teleport: every cell change starts a 150 ms easeOutCubic glide
//   from the current display position to the new cell, with a motion trail.
// - Blockades grow in over 250 ms (easeOutCubic, centre-out) + glow pulse +
//   particle burst; they never pop in instantly.
// - Per-frame work is light: grid + background are pre-rendered once per
//   resize, orb sprites are pre-rendered once per colour, particles are a
//   fixed pool (no allocation in the draw loop).

import type { Edge, PlayerState, Snapshot } from "@blockade/core";
import { easeOutCubic, MOVE_ANIM_MS, DEPLOY_MS } from "@blockade/core";

export interface Preview {
  edge: Edge;
  valid: boolean;
}

interface Glide {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  start: number;
  dur: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  alive: boolean;
}

const MAX_PARTICLES = 256;
const TRAIL_LEN = 10;

const COLORS = {
  blue: { core: "#7dd3fc", mid: "#38bdf8", glow: "#0ea5e9", dark: "#0369a1" },
  red: { core: "#fda4af", mid: "#fb7185", glow: "#f43f5e", dark: "#9f1239" },
} as const;

function makeOrbSprite(color: keyof typeof COLORS): HTMLCanvasElement {
  const S = 128;
  const c = document.createElement("canvas");
  c.width = S;
  c.height = S;
  const g = c.getContext("2d")!;
  const cx = S / 2;
  const cy = S / 2;
  const col = COLORS[color];
  // Outer glow.
  const glow = g.createRadialGradient(cx, cy, 4, cx, cy, 62);
  glow.addColorStop(0, col.glow);
  glow.addColorStop(0.45, col.mid + "cc");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, S, S);
  // Body.
  const body = g.createRadialGradient(cx - 10, cy - 12, 4, cx, cy, 34);
  body.addColorStop(0, "#ffffff");
  body.addColorStop(0.25, col.core);
  body.addColorStop(0.7, col.mid);
  body.addColorStop(1, col.dark);
  g.fillStyle = body;
  g.beginPath();
  g.arc(cx, cy, 32, 0, Math.PI * 2);
  g.fill();
  // Bright rim.
  g.strokeStyle = "rgba(255,255,255,0.9)";
  g.lineWidth = 2.5;
  g.beginPath();
  g.arc(cx, cy, 31, 0, Math.PI * 2);
  g.stroke();
  // Inner energy swirl (static part; rotation is drawn live as an arc).
  g.strokeStyle = "rgba(255,255,255,0.55)";
  g.lineWidth = 3;
  g.beginPath();
  g.arc(cx, cy, 18, 0.6, 2.4);
  g.stroke();
  g.beginPath();
  g.arc(cx, cy, 18, Math.PI + 0.6, Math.PI + 2.4);
  g.stroke();
  // Hot core.
  const core = g.createRadialGradient(cx, cy, 0, cx, cy, 10);
  core.addColorStop(0, "#ffffff");
  core.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = core;
  g.beginPath();
  g.arc(cx, cy, 10, 0, Math.PI * 2);
  g.fill();
  return c;
}

export class BoardRenderer {
  private sprites: Record<"blue" | "red", HTMLCanvasElement>;
  private bg: HTMLCanvasElement | null = null;
  private size = 0;
  private dpr = 1;
  private cell = 0;
  private originX = 0;
  private originY = 0;
  private n = 12;

  // Display state (separate from authoritative game state).
  private display = new Map<string, { row: number; col: number }>();
  private glides = new Map<string, Glide>();
  private trails = new Map<string, { row: number; col: number }[]>();
  private lastDir = new Map<string, { dr: number; dc: number }>();
  private blockadeSeen = new Map<string, number>();
  private particles: Particle[] = [];
  private prevSnap: Snapshot | null = null;
  private shakeUntil = 0;
  private shakeMag = 0;
  private winBurstDoneFor: string | null = null;

  constructor() {
    this.sprites = { blue: makeOrbSprite("blue"), red: makeOrbSprite("red") };
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: "#fff", alive: false });
    }
  }

  get gridSize(): number {
    return this.n;
  }

  /** Start an optimistic glide (local prediction): the orb glides to the
   *  target cell now; the next authoritative snapshot reconciles it — if
   *  the server rejected the move, setSnapshot glides it smoothly back. */
  startGlide(playerId: string, toRow: number, toCol: number, now: number): void {
    const from = this.displayPosition(playerId, now);
    if (Math.round(from.row) === toRow && Math.round(from.col) === toCol) return;
    this.glides.set(playerId, { fromRow: from.row, fromCol: from.col, toRow, toCol, start: now, dur: MOVE_ANIM_MS });
  }

  /** Recompute geometry + pre-render the static background. Call on resize. */
  resize(cssSize: number, dpr: number, gridSize: number): void {
    this.size = cssSize;
    this.dpr = dpr;
    this.n = gridSize;
    const pad = Math.max(8, cssSize * 0.02);
    this.cell = (cssSize - pad * 2) / gridSize;
    this.originX = pad;
    this.originY = pad;
    // Static background: graphite + grid + goal-row base tints.
    const bg = document.createElement("canvas");
    bg.width = Math.max(1, Math.round(cssSize * dpr));
    bg.height = Math.max(1, Math.round(cssSize * dpr));
    const g = bg.getContext("2d")!;
    g.scale(dpr, dpr);
    const grad = g.createLinearGradient(0, 0, cssSize, cssSize);
    grad.addColorStop(0, "#11161d");
    grad.addColorStop(0.5, "#0a0e14");
    grad.addColorStop(1, "#0d1117");
    g.fillStyle = grad;
    g.fillRect(0, 0, cssSize, cssSize);
    // Goal rows (static base tint; the pulse is drawn live).
    g.fillStyle = "rgba(34,211,238,0.10)";
    g.fillRect(this.originX, this.originY, this.cell * gridSize, this.cell);
    g.fillStyle = "rgba(244,63,94,0.10)";
    g.fillRect(this.originX, this.originY + this.cell * (gridSize - 1), this.cell * gridSize, this.cell);
    // Grid lines.
    g.strokeStyle = "rgba(148,163,184,0.20)";
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 0; i <= gridSize; i++) {
      const p = this.originX + i * this.cell;
      g.moveTo(p, this.originY);
      g.lineTo(p, this.originY + this.cell * gridSize);
      const q = this.originY + i * this.cell;
      g.moveTo(this.originX, q);
      g.lineTo(this.originX + this.cell * gridSize, q);
    }
    g.stroke();
    // Board border glow.
    g.strokeStyle = "rgba(34,211,238,0.45)";
    g.lineWidth = 2;
    g.strokeRect(this.originX - 1, this.originY - 1, this.cell * gridSize + 2, this.cell * gridSize + 2);
    this.bg = bg;
  }

  /** Fractional cell coordinates of a point in CSS pixels relative to the canvas. */
  pointToCell(px: number, py: number): { fx: number; fy: number } {
    return { fx: (px - this.originX) / this.cell, fy: (py - this.originY) / this.cell };
  }

  cellCenter(row: number, col: number): { x: number; y: number } {
    return {
      x: this.originX + (col + 0.5) * this.cell,
      y: this.originY + (row + 0.5) * this.cell,
    };
  }

  /** Feed the latest authoritative snapshot. Starts glides / bursts on change. */
  setSnapshot(snap: Snapshot, now: number): void {
    this.n = snap.gridSize;
    const prev = this.prevSnap;
    for (const p of snap.players) {
      const cur = this.display.get(p.id);
      if (!cur) {
        this.display.set(p.id, { row: p.row, col: p.col });
        this.trails.set(p.id, []);
        continue;
      }
      if (cur.row !== p.row || cur.col !== p.col) {
        const prevCell = prev?.players.find((x) => x.id === p.id);
        const jumped = prevCell ? Math.abs(p.row - prevCell.row) + Math.abs(p.col - prevCell.col) > 1 : false;
        if (jumped) {
          // Resync (reconnect / big correction): snap, never glide across the board.
          this.display.set(p.id, { row: p.row, col: p.col });
          this.glides.delete(p.id);
        } else {
          const from = this.displayPosition(p.id, now);
          this.glides.set(p.id, {
            fromRow: from.row,
            fromCol: from.col,
            toRow: p.row,
            toCol: p.col,
            start: now,
            dur: MOVE_ANIM_MS,
          });
          this.lastDir.set(p.id, { dr: p.row - Math.round(from.row), dc: p.col - Math.round(from.col) });
        }
      }
    }
    for (const b of snap.blockades) {
      if (!this.blockadeSeen.has(b.id)) {
        this.blockadeSeen.set(b.id, now);
        // Particle burst along the new blockade.
        for (const e of b.edges) {
          const { x, y } = this.edgeCenter(e);
          this.burst(x, y, "#22d3ee", 6);
        }
      }
    }
    if (snap.winnerId && this.winBurstDoneFor !== snap.winnerId) {
      this.winBurstDoneFor = snap.winnerId;
      const w = snap.players.find((p) => p.id === snap.winnerId);
      if (w) {
        const { x, y } = this.cellCenter(w.row, w.col);
        this.burst(x, y, COLORS[w.color].glow, 60);
        this.burst(x, y, "#ffffff", 30);
      }
    }
    this.prevSnap = snap;
  }

  /** Collision feedback: sparks at the orb + a tiny screen shake. */
  collide(playerId: string, now: number): void {
    const d = this.display.get(playerId);
    if (!d) return;
    const { x, y } = this.cellCenter(d.row, d.col);
    this.burst(x, y, "#fbbf24", 10);
    this.shakeUntil = now + 140;
    this.shakeMag = 2.5;
  }

  private edgeCenter(e: Edge): { x: number; y: number } {
    if (e.orientation === "h") {
      return {
        x: this.originX + (e.col + e.len / 2) * this.cell,
        y: this.originY + e.row * this.cell,
      };
    }
    return {
      x: this.originX + e.col * this.cell,
      y: this.originY + (e.row + e.len / 2) * this.cell,
    };
  }

  private burst(x: number, y: number, color: string, count: number): void {
    let spawned = 0;
    for (const pt of this.particles) {
      if (spawned >= count) break;
      if (pt.alive) continue;
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 160;
      pt.x = x;
      pt.y = y;
      pt.vx = Math.cos(a) * sp;
      pt.vy = Math.sin(a) * sp;
      pt.maxLife = 0.35 + Math.random() * 0.45;
      pt.life = pt.maxLife;
      pt.size = 1.5 + Math.random() * 2.5;
      pt.color = color;
      pt.alive = true;
      spawned++;
    }
  }

  /** Current interpolated display position (advances glides to `now`). */
  displayPosition(playerId: string, now: number): { row: number; col: number } {
    const g = this.glides.get(playerId);
    const cur = this.display.get(playerId) ?? { row: 0, col: 0 };
    if (!g) return { ...cur };
    const t = Math.min(1, (now - g.start) / g.dur);
    if (t >= 1) {
      this.display.set(playerId, { row: g.toRow, col: g.toCol });
      this.glides.delete(playerId);
      return { row: g.toRow, col: g.toCol };
    }
    const e = easeOutCubic(t);
    return {
      row: g.fromRow + (g.toRow - g.fromRow) * e,
      col: g.fromCol + (g.toCol - g.fromCol) * e,
    };
  }

  render(ctx: CanvasRenderingContext2D, snap: Snapshot, now: number, dtMs: number, preview: Preview | null): void {
    const S = this.size;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    if (now < this.shakeUntil) {
      const m = this.shakeMag * ((this.shakeUntil - now) / 140);
      ctx.translate((Math.random() - 0.5) * m * 2, (Math.random() - 0.5) * m * 2);
    }
    if (this.bg) ctx.drawImage(this.bg, 0, 0, S, S);

    // Goal-row pulse.
    const pulse = 0.05 + 0.04 * Math.sin(now / 450);
    ctx.fillStyle = `rgba(34,211,238,${pulse})`;
    ctx.fillRect(this.originX, this.originY, this.cell * this.n, this.cell);
    ctx.fillStyle = `rgba(244,63,94,${pulse})`;
    ctx.fillRect(this.originX, this.originY + this.cell * (this.n - 1), this.cell * this.n, this.cell);

    // Blockades (grow-in + glow pulse).
    for (const b of snap.blockades) {
      const seenAt = this.blockadeSeen.get(b.id) ?? now;
      const prog = easeOutCubic(Math.min(1, (now - seenAt) / DEPLOY_MS));
      const glowPulse = 0.75 + 0.25 * Math.sin(now / 300 + seenAt);
      for (const e of b.edges) {
        this.drawEdge(ctx, e, prog, glowPulse);
      }
    }

    // Drag preview.
    if (preview) this.drawPreview(ctx, preview, now);

    // Orbs + trails.
    for (const p of snap.players) {
      const pos = this.displayPosition(p.id, now);
      this.pushTrail(p.id, pos);
      this.drawTrail(ctx, p, now);
      this.drawOrb(ctx, p, pos, now);
    }

    // Particles (additive).
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const pt of this.particles) {
      if (!pt.alive) continue;
      pt.life -= dtMs / 1000;
      if (pt.life <= 0) {
        pt.alive = false;
        continue;
      }
      pt.x += pt.vx * (dtMs / 1000);
      pt.y += pt.vy * (dtMs / 1000);
      pt.vx *= 0.96;
      pt.vy *= 0.96;
      const a = Math.max(0, pt.life / pt.maxLife);
      ctx.globalAlpha = a;
      ctx.fillStyle = pt.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.size * (0.5 + a * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    ctx.restore();
  }

  private pushTrail(playerId: string, pos: { row: number; col: number }): void {
    const t = this.trails.get(playerId);
    if (!t) return;
    const last = t[t.length - 1];
    if (last && Math.abs(last.row - pos.row) < 0.01 && Math.abs(last.col - pos.col) < 0.01) return;
    t.push({ row: pos.row, col: pos.col });
    if (t.length > TRAIL_LEN) t.shift();
  }

  private drawTrail(ctx: CanvasRenderingContext2D, p: PlayerState, _now: number): void {
    const t = this.trails.get(p.id);
    if (!t || t.length < 2) return;
    const col = COLORS[p.color];
    for (let i = 0; i < t.length - 1; i++) {
      const a = (i / t.length) * 0.28;
      const { x, y } = this.cellCenter(t[i].row, t[i].col);
      ctx.globalAlpha = a;
      ctx.fillStyle = col.glow;
      ctx.beginPath();
      ctx.arc(x, y, this.cell * 0.22 * (0.4 + (i / t.length) * 0.6), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private drawOrb(ctx: CanvasRenderingContext2D, p: PlayerState, pos: { row: number; col: number }, now: number): void {
    const { x, y } = this.cellCenter(pos.row, pos.col);
    const pulse = 1 + 0.05 * Math.sin(now / 280 + (p.color === "blue" ? 0 : Math.PI));
    const r = this.cell * 0.52 * pulse;
    const moving = this.glides.has(p.id);
    const spriteR = r * (moving ? 1.12 : 1.05);
    ctx.drawImage(this.sprites[p.color], x - spriteR, y - spriteR, spriteR * 2, spriteR * 2);
    // Rotating energy arc (live — cheap stroke, no shadowBlur).
    const col = COLORS[p.color];
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = Math.max(1.5, this.cell * 0.045);
    const rot = now / 500;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.62, rot, rot + 1.9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.62, rot + Math.PI, rot + Math.PI + 1.9);
    ctx.stroke();
    // Direction indicator.
    const d = this.lastDir.get(p.id);
    if (d && (d.dr !== 0 || d.dc !== 0)) {
      const ang = Math.atan2(d.dr, d.dc);
      const tx = x + Math.cos(ang) * r * 1.15;
      const ty = y + Math.sin(ang) * r * 1.15;
      ctx.fillStyle = col.core;
      ctx.beginPath();
      ctx.moveTo(tx + Math.cos(ang) * 6, ty + Math.sin(ang) * 6);
      ctx.lineTo(tx + Math.cos(ang + 2.5) * 6, ty + Math.sin(ang + 2.5) * 6);
      ctx.lineTo(tx + Math.cos(ang - 2.5) * 6, ty + Math.sin(ang - 2.5) * 6);
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawEdge(ctx: CanvasRenderingContext2D, e: Edge, prog: number, glowPulse: number): void {
    if (prog <= 0) return;
    // Centre-out growth: draw the middle `prog` fraction of the segment.
    const x0 = this.originX + e.col * this.cell;
    const y0 = this.originY + e.row * this.cell;
    let ax: number;
    let ay: number;
    let bx: number;
    let by: number;
    if (e.orientation === "h") {
      const cx = x0 + (this.cell * e.len) / 2;
      const half = (this.cell * e.len * prog) / 2;
      ax = cx - half;
      bx = cx + half;
      ay = by = y0;
    } else {
      const cy = y0 + (this.cell * e.len) / 2;
      const half = (this.cell * e.len * prog) / 2;
      ay = cy - half;
      by = cy + half;
      ax = bx = x0;
    }
    ctx.save();
    ctx.lineCap = "round";
    // Outer glow.
    ctx.globalAlpha = 0.35 * glowPulse;
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = this.cell * 0.34;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    // Bright core.
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = "#ecfeff";
    ctx.lineWidth = this.cell * 0.13;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.restore();
  }

  private drawPreview(ctx: CanvasRenderingContext2D, preview: Preview, now: number): void {
    const e = preview.edge;
    const x0 = this.originX + e.col * this.cell;
    const y0 = this.originY + e.row * this.cell;
    const x1 = e.orientation === "h" ? x0 + this.cell * e.len : x0;
    const y1 = e.orientation === "v" ? y0 + this.cell * e.len : y0;
    const color = preview.valid ? "#22ff88" : "#ff4455";
    const dash = 6 + 3 * Math.sin(now / 150);
    ctx.save();
    ctx.lineCap = "round";
    ctx.setLineDash([dash, 6]);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = color;
    ctx.lineWidth = this.cell * 0.22;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    // End caps.
    ctx.fillStyle = color;
    for (const [px, py] of [
      [x0, y0],
      [x1, y1],
    ] as const) {
      ctx.beginPath();
      ctx.arc(px, py, this.cell * 0.14, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
