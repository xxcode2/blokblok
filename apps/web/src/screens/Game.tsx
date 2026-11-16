// Game screen: responsive Canvas + HUD + keyboard / pointer / touch input.
//
// Loop design (animation quality bar):
// - ONE requestAnimationFrame loop drives everything. No setTimeout /
//   setInterval drives animation or simulation.
// - Local modes: fixed-step simulation (50 ms steps, 20/s — same as the
//   server) with an accumulator; rendering interpolates every frame.
// - Online: snapshots/deltas from the server; the renderer glides orbs
//   between cells (150 ms easeOutCubic) and reconciles optimistically
//   predicted moves when the authoritative state arrives.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dir, Edge, GameEngine, Orientation, Snapshot } from "@blockade/core";
import { GameEngine as Engine, blockadeCost } from "@blockade/core";
import type { AiDifficulty } from "../ai";
import { chooseAiAction } from "../ai";
import type { NetClient } from "../net";
import { BoardRenderer, type Preview } from "../game/render";
import { extendEdge, isP1MoveKey, isP2MoveKey, joystickDir, keyToDir, pickEdge, swipeDir } from "../game/input";
import { Hud } from "../components/Hud";
import { sfx, isMuted, setMuted } from "../sound";

export interface MatchResult {
  winnerId: string | null;
  reason: string;
  scores: Record<string, number>;
  stats: Record<string, { moves: number; blockades: number }>;
  durationMs: number;
  players: { id: string; name: string; color: "blue" | "red" }[];
}

export interface GameProps {
  mode: "practice" | "local2p" | "online";
  engine: GameEngine | null;
  net: NetClient | null;
  myId: string;
  aiDifficulty: AiDifficulty | null;
  snapshot: Snapshot | null;
  countdown: number | null;
  onResult: (r: MatchResult) => void;
  onLeave: () => void;
}

const AI_INTERVAL_MS: Record<AiDifficulty, number> = { easy: 800, normal: 550, hard: 380 };
const SIM_STEP_MS = 50;
const LOCAL_COUNTDOWN_MS = 2100;

export function Game(props: GameProps): React.ReactElement {
  const { mode, engine, net, myId } = props;
  const online = mode === "online";
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<BoardRenderer | null>(null);
  const snapRef = useRef<Snapshot | null>(props.snapshot);
  const mirrorRef = useRef<{ tick: number; engine: GameEngine } | null>(null);
  const previewRef = useRef<Preview | null>(null);
  const dragRef = useRef<{ start: Edge; current: Edge; playerId: string } | null>(null);
  const swipeRef = useRef<{ x: number; y: number; playerId: string } | null>(null);
  const lastDirRef = useRef<Record<string, Dir>>({});
  const resultSentRef = useRef(false);
  const simAccRef = useRef(0);
  const aiAccRef = useRef(0);
  const countdownLeftRef = useRef(online ? 0 : LOCAL_COUNTDOWN_MS);
  const countdownShownRef = useRef(online ? props.countdown : 3);
  const joyRef = useRef<{ dir: Dir | null; lastSent: number; active: boolean }>({ dir: null, lastSent: 0, active: false });
  const joyKnobRef = useRef<HTMLDivElement | null>(null);
  const lastHudRef = useRef(0);

  const [orientation, setOrientation] = useState<Orientation>("h");
  const [length, setLength] = useState(2);
  const [flash, setFlash] = useState<string | null>(null);
  const [muted, setMutedState] = useState(isMuted());
  const [countdown, setCountdown] = useState<number | null>(online ? props.countdown : 3);
  const [snapState, setSnapState] = useState<Snapshot | null>(props.snapshot);

  const propsRef = useRef(props);
  propsRef.current = props;

  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    window.setTimeout(() => setFlash((f) => (f === msg ? null : f)), 2600);
  }, []);

  // Mirror the live online snapshot into the ref the loop reads.
  useEffect(() => {
    snapRef.current = props.snapshot;
    setSnapState(props.snapshot);
    if (props.snapshot && props.snapshot.status === "finished" && !resultSentRef.current) {
      resultSentRef.current = true;
      propsRef.current.onResult({
        winnerId: props.snapshot.winnerId,
        reason: "goal",
        scores: Object.fromEntries(props.snapshot.players.map((p) => [p.id, p.score])),
        stats: Object.fromEntries(props.snapshot.players.map((p) => [p.id, { moves: 0, blockades: 0 }])),
        durationMs: (props.snapshot.durationSec - props.snapshot.timeLeftMs / 1000) * 1000,
        players: props.snapshot.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
      });
    }
  }, [props.snapshot]);

  useEffect(() => {
    setCountdown(props.countdown);
  }, [props.countdown]);

  const currentSnapshot = useCallback((): Snapshot | null => {
    if (online) return snapRef.current;
    return engine ? engine.snapshot() : null;
  }, [online, engine]);

  const mirrorEngine = useCallback((): GameEngine | null => {
    const snap = snapRef.current;
    if (!snap) return null;
    const m = mirrorRef.current;
    if (m && m.tick === snap.tick) return m.engine;
    const eng = Engine.fromSnapshot(snap);
    mirrorRef.current = { tick: snap.tick, engine: eng };
    return eng;
  }, []);

  const validatePreview = useCallback(
    (playerId: string, edge: Edge): string | null => {
      if (online) {
        const m = mirrorEngine();
        return m ? m.validatePlace(playerId, edge) : "INVALID_BLOCKADE";
      }
      return engine ? engine.validatePlace(playerId, edge) : "INVALID_BLOCKADE";
    },
    [online, engine, mirrorEngine],
  );

  const sendMove = useCallback(
    (playerId: string, dir: Dir) => {
      lastDirRef.current[playerId] = dir;
      if (online) {
        const snap = snapRef.current;
        const me = snap?.players.find((p) => p.id === playerId);
        // Local prediction: glide immediately if the move looks legal on the
        // mirror engine; the authoritative snapshot reconciles it.
        if (me && net) {
          const m = mirrorEngine();
          if (m && m.legalMoves(playerId).includes(dir)) {
            const r = rendererRef.current;
            const target = { row: me.row + (dir === "up" ? -1 : dir === "down" ? 1 : 0), col: me.col + (dir === "left" ? -1 : dir === "right" ? 1 : 0) };
            r?.startGlide(playerId, target.row, target.col, performance.now());
          }
          net.inputMove(dir);
          sfx.move();
        }
        return;
      }
      if (!engine) return;
      const res = engine.tryMove(playerId, dir);
      if (res.ok) {
        if (!res.buffered) sfx.move();
      } else {
        rendererRef.current?.collide(playerId, performance.now());
        sfx.collide();
      }
    },
    [online, engine, net, mirrorEngine],
  );

  const sendPlace = useCallback(
    (playerId: string, edge: Edge) => {
      if (online) {
        net?.inputPlace(edge);
        sfx.place();
        return;
      }
      if (!engine) return;
      const res = engine.place(playerId, edge);
      if (res.ok) {
        sfx.place();
      } else {
        const msg =
          res.code === "NO_ENERGY"
            ? "Not enough energy ⚡"
            : res.code === "NO_PATH"
              ? "That would trap a player — illegal"
              : res.code === "ON_COOLDOWN"
                ? "Blockade on cooldown"
                : "Invalid placement";
        showFlash(msg);
        sfx.error();
      }
    },
    [online, engine, net, showFlash],
  );

  const sendPlaceAuto = useCallback(
    (playerId: string) => {
      const snap = currentSnapshot();
      const p = snap?.players.find((x) => x.id === playerId);
      const dir = lastDirRef.current[playerId] ?? (p?.color === "red" ? "down" : "up");
      const cost = blockadeCost(length);
      if (p && p.energy < cost) {
        showFlash("Not enough energy ⚡");
        sfx.error();
        return;
      }
      if (online) {
        net?.inputPlaceAuto(dir, orientation, length);
        sfx.place();
        return;
      }
      if (!engine) return;
      const res = engine.placeAuto(playerId, dir, orientation, length);
      if (res.ok) {
        sfx.place();
      } else {
        showFlash(res.code === "NO_ENERGY" ? "Not enough energy ⚡" : "No valid placement ahead");
        sfx.error();
      }
    },
    [currentSnapshot, length, net, online, engine, orientation, showFlash],
  );

  // -- main loop -------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!rendererRef.current) rendererRef.current = new BoardRenderer();
    const renderer = rendererRef.current;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const size = Math.max(240, Math.min(rect.width, rect.height));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      const snap = currentSnapshot();
      renderer.resize(size, dpr, snap?.gridSize ?? 12);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(100, now - last);
      last = now;
      const p = propsRef.current;

      // Countdown (local modes run their own 3-2-1; online is server-driven).
      if (!online && countdownLeftRef.current > 0) {
        countdownLeftRef.current -= dt;
        const shown = Math.max(0, Math.ceil(countdownLeftRef.current / 700));
        if (shown !== countdownShownRef.current) {
          countdownShownRef.current = shown;
          setCountdown(shown === 0 ? null : shown);
          if (shown > 0) sfx.countdown(false);
          else sfx.countdown(true);
        }
        if (countdownLeftRef.current <= 0) {
          // Simulation starts only after the countdown.
        }
      } else if (!online) {
        // Fixed-step simulation.
        simAccRef.current += dt;
        const eng = p.engine;
        if (eng && eng.snapshot().status === "playing") {
          let guard = 0;
          while (simAccRef.current >= SIM_STEP_MS && guard++ < 6) {
            simAccRef.current -= SIM_STEP_MS;
            eng.tickMs(SIM_STEP_MS);
          }
          // AI driver (practice).
          if (p.mode === "practice" && p.aiDifficulty) {
            aiAccRef.current += dt;
            const interval = AI_INTERVAL_MS[p.aiDifficulty];
            if (aiAccRef.current >= interval) {
              aiAccRef.current = 0;
              const aiId = eng.snapshot().players.find((x) => x.id !== p.myId)?.id;
              if (aiId && eng.snapshot().status === "playing") {
                const action = chooseAiAction(eng, aiId, p.aiDifficulty);
                if (action) {
                  if (action.kind === "move") eng.tryMove(aiId, action.dir);
                  else eng.place(aiId, action.edge);
                }
              }
            }
          }
          // Joystick hold-to-move repeat.
          const joy = joyRef.current;
          if (joy.active && joy.dir && now - joy.lastSent >= 170) {
            joy.lastSent = now;
            sendMove(p.myId, joy.dir);
          }
        }
      } else {
        // Online joystick repeat.
        const joy = joyRef.current;
        if (joy.active && joy.dir && now - joy.lastSent >= 170) {
          joy.lastSent = now;
          sendMove(p.myId, joy.dir);
        }
      }

      const snap = currentSnapshot();
      if (snap) {
        if (snap.gridSize !== renderer.gridSize) resize();
        renderer.setSnapshot(snap, now);
        // Refresh the HUD (energy / timer / progress) at 4 Hz — cheap, and
        // it keeps React out of the 60 fps render path.
        if (now - lastHudRef.current >= 250) {
          lastHudRef.current = now;
          setSnapState(snap);
        }
        // Scale the context once per frame (canvas is dpr-sized).
        ctx.setTransform(Math.min(2, window.devicePixelRatio || 1), 0, 0, Math.min(2, window.devicePixelRatio || 1), 0, 0);
        renderer.render(ctx, snap, now, dt, previewRef.current);
      }

      // Local match end.
      if (!online && engine) {
        const s = engine.snapshot();
        if (s.status === "finished" && !resultSentRef.current) {
          resultSentRef.current = true;
          const reason = engine.winReason ?? "goal";
          propsRef.current.onResult({
            winnerId: s.winnerId,
            reason,
            scores: Object.fromEntries(s.players.map((x) => [x.id, x.score])),
            stats: engine.stats(),
            durationMs: engine.durationMs(),
            players: s.players.map((x) => ({ id: x.id, name: x.name, color: x.color })),
          });
          if (s.winnerId === myId) sfx.win();
          else if (s.winnerId) sfx.lose();
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- keyboard ---------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat && !isP1MoveKey(e.key) && !isP2MoveKey(e.key)) return;
      const dir = keyToDir(e.key);
      if (dir) {
        e.preventDefault();
        if (mode === "local2p") {
          sendMove(isP2MoveKey(e.key) ? "p2" : "p1", dir);
        } else {
          sendMove(myId, dir);
        }
        return;
      }
      if (e.key === "b" || e.key === "B" || e.key === " ") {
        e.preventDefault();
        if (mode === "local2p") sendPlaceAuto("p1");
        else sendPlaceAuto(myId);
      } else if (e.key === "h" || e.key === "H") {
        setOrientation((o) => (o === "h" ? "v" : "h"));
      } else if (["1", "2", "3", "4"].includes(e.key)) {
        setLength(Number(e.key));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, myId, sendMove, sendPlaceAuto]);

  // -- pointer: drag blockade / swipe move --------------------------------------
  const nearestPlayerId = (fx: number, fy: number): string => {
    const snap = currentSnapshot();
    if (!snap) return myId;
    let best = snap.players[0];
    let bestD = Infinity;
    for (const p of snap.players) {
      const d = Math.abs(p.row + 0.5 - fy) + Math.abs(p.col + 0.5 - fx);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best.id;
  };

  const pointerPos = (e: React.PointerEvent): { fx: number; fy: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return rendererRef.current
      ? rendererRef.current.pointToCell(e.clientX - rect.left, e.clientY - rect.top)
      : { fx: 0, fy: 0 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const { fx, fy } = pointerPos(e);
    const snap = currentSnapshot();
    const n = snap?.gridSize ?? 12;
    const edge = pickEdge(fx, fy, n);
    const playerId = mode === "local2p" ? nearestPlayerId(fx, fy) : myId;
    if (edge) {
      dragRef.current = { start: edge, current: edge, playerId };
      previewRef.current = { edge, valid: validatePreview(playerId, edge) === null };
    } else {
      swipeRef.current = { x: e.clientX, y: e.clientY, playerId };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { fx, fy } = pointerPos(e);
    const current = extendEdge(drag.start, fx, fy, 4);
    if (current.row !== drag.current.row || current.col !== drag.current.col || current.len !== drag.current.len) {
      drag.current = current;
      previewRef.current = { edge: current, valid: validatePreview(drag.playerId, current) === null };
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag) {
      dragRef.current = null;
      const preview = previewRef.current;
      previewRef.current = null;
      if (preview && preview.valid) sendPlace(drag.playerId, preview.edge);
      else if (preview) {
        showFlash("Invalid placement");
        sfx.error();
      }
      return;
    }
    const swipe = swipeRef.current;
    swipeRef.current = null;
    if (!swipe) return;
    const dir = swipeDir(e.clientX - swipe.x, e.clientY - swipe.y);
    if (dir) sendMove(swipe.playerId, dir);
  };

  // -- joystick -------------------------------------------------------------------
  const joyCenter = useRef<{ x: number; y: number } | null>(null);
  const onJoyDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    joyCenter.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    joyRef.current.active = true;
    joyRef.current.lastSent = 0;
    onJoyMove(e);
  };
  const onJoyMove = (e: React.PointerEvent) => {
    if (!joyCenter.current || !joyRef.current.active) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const dx = (e.clientX - joyCenter.current.x) / (rect.width / 2);
    const dy = (e.clientY - joyCenter.current.y) / (rect.height / 2);
    const clamped = Math.max(-1, Math.min(1, dx));
    const clampedY = Math.max(-1, Math.min(1, dy));
    if (joyKnobRef.current) {
      joyKnobRef.current.style.transform = `translate(${clamped * 28}px, ${clampedY * 28}px)`;
    }
    const dir = joystickDir(clamped, clampedY);
    if (dir && dir !== joyRef.current.dir) {
      joyRef.current.dir = dir;
      joyRef.current.lastSent = performance.now();
      sendMove(myId, dir);
    } else if (!dir) {
      joyRef.current.dir = null;
    }
  };
  const onJoyUp = () => {
    joyRef.current.active = false;
    joyRef.current.dir = null;
    if (joyKnobRef.current) joyKnobRef.current.style.transform = "translate(0px, 0px)";
  };

  const snap = snapState ?? currentSnapshot();
  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    setMutedState(m);
  };

  return (
    <div className="game-screen">
      {snap && (
        <Hud
          snap={snap}
          myId={mode === "local2p" ? null : myId}
          latencyMs={net?.latencyMs ?? null}
          connected={net?.connected ?? true}
          online={online}
          orientation={orientation}
          length={length}
          onOrientation={setOrientation}
          onLength={setLength}
          onPlaceAuto={sendPlaceAuto}
          onLeave={props.onLeave}
          muted={muted}
          onToggleMute={toggleMute}
          flash={flash}
        />
      )}
      <div className="board-wrap" ref={wrapRef}>
        <canvas
          ref={canvasRef}
          className="board-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onContextMenu={(e) => e.preventDefault()}
        />
        {countdown !== null && countdown > 0 && (
          <div className="countdown-overlay">
            <div className="countdown-num">{countdown}</div>
            <div className="countdown-sub">Get ready…</div>
          </div>
        )}
        {snap?.status === "finished" && <div className="board-finished">Match over — see results…</div>}
      </div>
      <div className="touch-controls">
        <div
          className="joystick"
          onPointerDown={onJoyDown}
          onPointerMove={onJoyMove}
          onPointerUp={onJoyUp}
          onPointerCancel={onJoyUp}
        >
          <div className="joystick-knob" ref={joyKnobRef} />
        </div>
        <div className="touch-hint">Drag the stick to move · drag a grid edge to place a blockade</div>
      </div>
      <div className="game-help">
        <span>
          <b>WASD / arrows</b> move
        </span>
        <span>
          <b>Drag edge</b> blockade
        </span>
        <span>
          <b>B</b> quick place
        </span>
        <span>
          <b>H</b> orientation
        </span>
        <span>
          <b>1–4</b> length
        </span>
      </div>
    </div>
  );
}
