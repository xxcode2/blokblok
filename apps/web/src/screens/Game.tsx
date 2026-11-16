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
// - Turn-based (protocol 1.1.0): ONE action per turn — move 1 cell OR place
//   1 blockade — then the turn passes (30 s per turn, auto-pass on timeout).
//   Out-of-turn input is ignored and the board dims; there are no cooldowns,
//   no input buffering, and no hold-to-glide: every action is one discrete
//   tap / keypress / swipe. The turn-timer bar is updated every animation
//   frame from turnDeadlineMs inside this same rAF loop (no second timer).
// - Practice: the AI acts exactly ONCE per AI turn, ~500 ms after the turn
//   starts, via one chooseAiAction call.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dir, Edge, GameEngine, Orientation, Snapshot } from "@blockade/core";
import { GameEngine as Engine, TURN_DURATION_MS, blockadeCost } from "@blockade/core";
import type { AiDifficulty } from "../ai";
import { chooseAiAction } from "../ai";
import type { NetClient } from "../net";
import { BoardRenderer, type Preview } from "../game/render";
import { arenaModeOf, dirTowardCell, isTrophyMode, playerLabel, trophyCell } from "../game/mode";
import { extendEdge, isP1MoveKey, isP2MoveKey, joystickDir, keyToDir, pickEdge, swipeDir } from "../game/input";
import { Hud } from "../components/Hud";
import { sfx, isMuted, setMuted } from "../sound";

export interface MatchResult {
  winnerId: string | null;
  reason: string;
  scores: Record<string, number>;
  stats: Record<string, { moves: number; blockades: number }>;
  durationMs: number;
  players: { id: string; name: string; color: "blue" | "red" | "green" | "amber" }[];
  /** Arena mode the match was played in ("race" default, "trophy" for Rebut Piala). */
  mode?: "race" | "trophy";
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

const SIM_STEP_MS = 50;
const LOCAL_COUNTDOWN_MS = 2100;
/** Delay after an AI turn starts before the AI acts once (feels human). */
const AI_TURN_DELAY_MS = 500;
/** Retries of a failed AI action for one turn before giving up (the 30 s
 *  turn timeout then passes the turn). */
const AI_MAX_ATTEMPTS = 5;

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
  /** AI turn currently being waited on: { turn, at (rAF timestamp), attempts }. */
  const aiPendingRef = useRef<{ turn: number; at: number; attempts: number } | null>(null);
  const countdownLeftRef = useRef(online ? 0 : LOCAL_COUNTDOWN_MS);
  const countdownShownRef = useRef(online ? props.countdown : 3);
  const joyRef = useRef<{ dir: Dir | null; active: boolean }>({ dir: null, active: false });
  const joyKnobRef = useRef<HTMLDivElement | null>(null);
  const lastHudRef = useRef(0);
  /** Turn-timer bar fill + seconds, updated imperatively every rAF frame. */
  const turnBarRef = useRef<HTMLDivElement | null>(null);
  const turnTextRef = useRef<HTMLSpanElement | null>(null);

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
        // The snapshot carries no win reason; the arena mode tells us which
        // win it was (trophy capture vs goal row). The server `result`
        // message (App) carries the authoritative reason when it arrives.
        reason: isTrophyMode(props.snapshot) ? "trophy" : "goal",
        scores: Object.fromEntries(props.snapshot.players.map((p) => [p.id, p.score])),
        stats: Object.fromEntries(props.snapshot.players.map((p) => [p.id, { moves: 0, blockades: 0 }])),
        durationMs: (props.snapshot.durationSec - props.snapshot.timeLeftMs / 1000) * 1000,
        players: props.snapshot.players.map((p) => ({ id: p.id, name: p.name, color: p.color })),
        mode: arenaModeOf(props.snapshot),
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

  /** Is it this player's turn right now? Turn-based: every action is gated
   *  on this — out-of-turn input is silently ignored (the banner shows
   *  whose turn it is; the board dims when it is not yours). */
  const isTurnOf = useCallback(
    (playerId: string): boolean => {
      const snap = currentSnapshot();
      return !!snap && snap.status === "playing" && snap.activePlayerId === playerId;
    },
    [currentSnapshot],
  );

  const sendMove = useCallback(
    (playerId: string, dir: Dir) => {
      if (!isTurnOf(playerId)) return;
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
        sfx.move();
      } else {
        rendererRef.current?.collide(playerId, performance.now());
        sfx.collide();
      }
    },
    [online, engine, net, mirrorEngine, isTurnOf],
  );

  const sendPlace = useCallback(
    (playerId: string, edge: Edge) => {
      if (!isTurnOf(playerId)) {
        showFlash("Not your turn yet");
        return;
      }
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
              : res.code === "NOT_YOUR_TURN"
                ? "Not your turn yet"
                : "Invalid placement";
        showFlash(msg);
        sfx.error();
      }
    },
    [online, engine, net, showFlash, isTurnOf],
  );

  const sendPlaceAuto = useCallback(
    (playerId: string) => {
      const snap = currentSnapshot();
      const p = snap?.players.find((x) => x.id === playerId);
      if (!isTurnOf(playerId)) {
        showFlash("Not your turn yet");
        return;
      }
      // "Ahead" means toward the goal: the opposite row in race mode, the
      // centre trophy in trophy mode.
      let dir = lastDirRef.current[playerId] ?? (p?.color === "red" ? "down" : "up");
      if (p && isTrophyMode(snap)) {
        const t = trophyCell(snap);
        if (t) dir = dirTowardCell(p.row, p.col, t.row, t.col);
      }
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
        showFlash(
          res.code === "NO_ENERGY"
            ? "Not enough energy ⚡"
            : res.code === "NOT_YOUR_TURN"
              ? "Not your turn yet"
              : "No valid placement ahead",
        );
        sfx.error();
      }
    },
    [currentSnapshot, length, net, online, engine, orientation, showFlash, isTurnOf],
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
            // Wall-clock now: turn deadlines are epoch ms, and turn
            // timeouts auto-pass after 30 s of inactivity.
            eng.tickMs(SIM_STEP_MS, Date.now());
          }
          // AI driver (practice): exactly ONE action per AI turn, ~500 ms
          // after the turn starts. The core AI refuses to act off-turn,
          // and a successful action passes the turn on. In trophy 4P there
          // are THREE AI seats (P2, P3, P4); whichever AI seat is active
          // gets its one action — the human seat never does.
          if (p.mode === "practice" && p.aiDifficulty) {
            const s = eng.snapshot();
            const aiIds = s.players.filter((x) => x.id !== p.myId).map((x) => x.id);
            const aiId = aiIds.includes(s.activePlayerId) ? s.activePlayerId : null;
            if (aiId && s.status === "playing") {
              const pend = aiPendingRef.current;
              if (!pend || pend.turn !== s.turnNumber) {
                aiPendingRef.current = { turn: s.turnNumber, at: now, attempts: 0 };
              } else if (now - pend.at >= AI_TURN_DELAY_MS) {
                const action = chooseAiAction(eng, aiId, p.aiDifficulty);
                let ok = false;
                if (action) {
                  ok =
                    action.kind === "move"
                      ? eng.tryMove(aiId, action.dir).ok
                      : eng.place(aiId, action.edge).ok;
                }
                if (ok || pend.attempts >= AI_MAX_ATTEMPTS) {
                  // Acted (or gave up — the 30 s turn timeout passes the turn).
                  aiPendingRef.current = null;
                } else {
                  pend.attempts += 1;
                  pend.at = now; // retry after another short delay
                }
              }
            } else {
              aiPendingRef.current = null;
            }
          }
        }
      }
      // Online: no per-frame simulation here — the server is authoritative.
      // (No joystick hold-to-repeat anywhere: one discrete action per turn.)

      const snap = currentSnapshot();

      // Turn timer: countdown bar + seconds, updated every animation frame
      // from the authoritative turn deadline (same rAF loop, no second timer).
      if (snap && snap.status === "playing" && snap.turnDeadlineMs > 0) {
        const remaining = Math.max(0, snap.turnDeadlineMs - Date.now());
        const bar = turnBarRef.current;
        if (bar) bar.style.width = `${Math.min(100, (remaining / TURN_DURATION_MS) * 100).toFixed(1)}%`;
        const secs = turnTextRef.current;
        if (secs) secs.textContent = `${Math.ceil(remaining / 1000)}s`;
      }

      if (snap) {
        if (snap.gridSize !== renderer.gridSize) resize();
        renderer.setSnapshot(snap, now);
        // Refresh the HUD (energy / timer / progress / turn label) at 4 Hz —
        // cheap, and it keeps React out of the 60 fps render path.
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
            mode: arenaModeOf(s),
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
      // One discrete action per keypress — holding a key never queues moves.
      if (e.repeat) return;
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
        if (mode === "local2p") {
          // Local 2P: the blockade button acts for whoever's turn it is.
          const snap = currentSnapshot();
          sendPlaceAuto(snap?.activePlayerId ?? "p1");
        } else sendPlaceAuto(myId);
      } else if (e.key === "h" || e.key === "H") {
        setOrientation((o) => (o === "h" ? "v" : "h"));
      } else if (["1", "2", "3", "4"].includes(e.key)) {
        setLength(Number(e.key));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, myId, sendMove, sendPlaceAuto, currentSnapshot]);

  // -- pointer: drag blockade / swipe move --------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    const snap = currentSnapshot();
    if (!snap || snap.status !== "playing") return;
    // Only the active player can act this turn. Local 2P: the player whose
    // turn it is, on the same device. Online/practice: me, on my turn only.
    const playerId = mode === "local2p" ? snap.activePlayerId : myId;
    if (snap.activePlayerId !== playerId) return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const { fx, fy } = pointerPos(e);
    const n = snap.gridSize;
    const edge = pickEdge(fx, fy, n);
    if (edge) {
      dragRef.current = { start: edge, current: edge, playerId };
      previewRef.current = { edge, valid: validatePreview(playerId, edge) === null };
    } else {
      swipeRef.current = { x: e.clientX, y: e.clientY, playerId };
    }
  };

  const pointerPos = (e: React.PointerEvent): { fx: number; fy: number } => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return rendererRef.current
      ? rendererRef.current.pointToCell(e.clientX - rect.left, e.clientY - rect.top)
      : { fx: 0, fy: 0 };
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

  // -- joystick (one discrete move per direction change, no hold-to-repeat) -----
  const joyCenter = useRef<{ x: number; y: number } | null>(null);
  const onJoyDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    joyCenter.current = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    joyRef.current.active = true;
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

  // Turn banner (single place — the HUD): whose turn, which turn number.
  // Always shows the seat label WITH its colour ("Giliran P3 · Turn 5"),
  // for 2 or 4 players; in practice/online "(kamu)" marks your own turn.
  let turnLabel: string | null = null;
  let turnColor: "blue" | "red" | "green" | "amber" | null = null;
  let turnMine = false;
  if (snap && snap.status === "playing" && snap.players.length >= 2) {
    const activeIdx = snap.players.findIndex((p) => p.id === snap.activePlayerId);
    const active = activeIdx >= 0 ? snap.players[activeIdx] : null;
    if (active) {
      turnColor = active.color;
      turnMine = mode !== "local2p" && active.id === myId;
      const seat = playerLabel(activeIdx);
      if (mode === "local2p") {
        turnLabel = `Giliran ${seat} · Turn ${snap.turnNumber}`;
      } else if (active.id === myId) {
        turnLabel = `Giliran ${seat} (kamu) · Turn ${snap.turnNumber}`;
      } else {
        turnLabel = `Giliran ${seat} · Turn ${snap.turnNumber}`;
      }
    }
  }
  // Board input is gated (and the board visibly dimmed) whenever it is not
  // the local player's turn — online and practice. Local 2P never dims:
  // the active player is always at the device.
  const inputGated =
    !!snap && snap.status === "playing" && mode !== "local2p" && snap.activePlayerId !== myId;
  const canAct = !!snap && snap.status === "playing" && snap.activePlayerId === myId;

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
          turnLabel={turnLabel}
          turnColor={turnColor}
          turnMine={turnMine}
          turnBarRef={turnBarRef}
          turnTextRef={turnTextRef}
          canAct={canAct}
        />
      )}
      <div className={`board-wrap${inputGated ? " board-dimmed" : ""}`} ref={wrapRef}>
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
        <span>
          <b>1 action</b> per turn · 30 s
        </span>
      </div>
    </div>
  );
}
