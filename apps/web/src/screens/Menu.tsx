// Main menu — spec §14: Play Online, Ranked-lite / Casual, Private Room,
// Practice vs AI, Local 2P. Ranked-lite points live in localStorage only.

import { useState } from "react";
import type { AiDifficulty } from "../ai";
import type { GridSize } from "@blockade/core";
import type { ArenaMode, ArenaPlayerCount } from "../game/mode";

export interface MenuChoices {
  name: string;
  ranked: boolean;
  gridSize: GridSize;
  durationSec: number;
  /** Game mode: race to the goal row, or first to the centre trophy. */
  mode: ArenaMode;
  /** 2 players, or 4 (trophy mode only — race locks to 2). */
  playerCount: ArenaPlayerCount;
}

export interface MenuProps {
  name: string;
  onName: (n: string) => void;
  rankedPoints: number;
  onPlayOnline: (c: MenuChoices) => void;
  onCreateRoom: (c: MenuChoices) => void;
  onJoinRoom: (c: MenuChoices, code: string) => void;
  onPractice: (c: MenuChoices, diff: AiDifficulty) => void;
  onLocal2P: (c: MenuChoices) => void;
  connecting: boolean;
  error: string | null;
}

export function Menu(props: MenuProps): React.ReactElement {
  const [ranked, setRanked] = useState(true);
  const [gridSize, setGridSize] = useState<GridSize>(12);
  const [durationSec, setDurationSec] = useState(180);
  const [joinCode, setJoinCode] = useState("");
  const [showJoin, setShowJoin] = useState(false);
  const [showPractice, setShowPractice] = useState(false);
  const [mode, setMode] = useState<ArenaMode>("race");
  const [playerCount, setPlayerCount] = useState<ArenaPlayerCount>(2);

  const choices = (): MenuChoices => ({
    name: props.name.trim() || "Player",
    ranked,
    gridSize,
    durationSec,
    mode,
    playerCount,
  });

  const pickMode = (m: ArenaMode) => {
    setMode(m);
    // Race is 2 players only — the player-count picker locks to 2.
    if (m === "race") setPlayerCount(2);
  };

  return (
    <div className="menu-screen">
      <header className="menu-hero">
        <h1 className="logo">
          BLOCKADE <span>ARENA</span>
        </h1>
        <p className="tagline">Race to the top. Wall them in. Never get walled in.</p>
      </header>

      <div className="menu-card">
        <label className="field">
          <span>Your name</span>
          <input
            value={props.name}
            maxLength={16}
            onChange={(e) => props.onName(e.target.value)}
            placeholder="Player"
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span>Arena</span>
            <select value={gridSize} onChange={(e) => setGridSize(Number(e.target.value) as GridSize)}>
              <option value={12}>12 × 12 — Classic</option>
              <option value={20}>20 × 20 — Large</option>
              <option value={30}>30 × 30 — Huge</option>
              <option value={40}>40 × 40 — XL</option>
            </select>
          </label>
          <label className="field">
            <span>Match length</span>
            <select value={durationSec} onChange={(e) => setDurationSec(Number(e.target.value))}>
              <option value={120}>2 min</option>
              <option value={180}>3 min</option>
              <option value={300}>5 min</option>
            </select>
          </label>
        </div>

        <div className="mode-toggle" title="Race: first to the opposite goal row. Trophy: first to the trophy in the centre of the board.">
          <button className={mode === "race" ? "active" : ""} onClick={() => pickMode("race")}>
            🏁 Race to the Top
          </button>
          <button className={mode === "trophy" ? "active" : ""} onClick={() => pickMode("trophy")}>
            🏆 Rebut Piala
          </button>
        </div>

        <div className="mode-toggle" title={mode === "race" ? "Race to the Top is 2 players only" : "Trophy mode: 2 or 4 players"}>
          <button className={playerCount === 2 ? "active" : ""} onClick={() => setPlayerCount(2)}>
            👤👤 2 pemain
          </button>
          <button
            className={playerCount === 4 ? "active" : ""}
            disabled={mode === "race"}
            onClick={() => setPlayerCount(4)}
            title={mode === "race" ? "4 players needs Trophy mode" : "4 players — P1 vs P2 vs P3 vs P4"}
          >
            👥 4 pemain
          </button>
          {mode === "race" && <span className="picker-note">Race locks to 2 players — pick Rebut Piala for 4.</span>}
        </div>

        <div className="mode-toggle" title="Ranked-lite: ±points per match, kept in this browser only">
          <button className={ranked ? "active" : ""} onClick={() => setRanked(true)}>
            ★ Ranked-lite
          </button>
          <button className={!ranked ? "active" : ""} onClick={() => setRanked(false)}>
            ☺ Casual
          </button>
          <span className="ranked-points">Rating: {props.rankedPoints} pts</span>
        </div>

        {props.error && <div className="menu-error">{props.error}</div>}

        <div className="menu-actions">
          <button className="btn primary big" disabled={props.connecting} onClick={() => props.onPlayOnline(choices())}>
            {props.connecting ? "Connecting…" : "▶ Play Online"}
          </button>
          <button className="btn" disabled={props.connecting} onClick={() => props.onCreateRoom(choices())}>
            🏠 Create private room
          </button>
          <button
            className="btn"
            onClick={() => {
              setShowJoin((s) => !s);
              setShowPractice(false);
            }}
          >
            🔑 Join private room
          </button>
          {showJoin && (
            <div className="join-row">
              <input
                value={joinCode}
                maxLength={6}
                placeholder="6-char code"
                onChange={(e) => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && joinCode.length === 6) props.onJoinRoom(choices(), joinCode);
                }}
              />
              <button className="btn primary" disabled={joinCode.length !== 6 || props.connecting} onClick={() => props.onJoinRoom(choices(), joinCode)}>
                Join
              </button>
            </div>
          )}
          <button
            className="btn"
            onClick={() => {
              setShowPractice((s) => !s);
              setShowJoin(false);
            }}
          >
            🤖 Practice vs AI
          </button>
          {showPractice && (
            <div className="practice-row">
              {(["easy", "normal", "hard"] as AiDifficulty[]).map((d) => (
                <button key={d} className="btn" onClick={() => props.onPractice(choices(), d)}>
                  {d[0].toUpperCase() + d.slice(1)}
                </button>
              ))}
            </div>
          )}
          {showPractice && (
            <p className="picker-note">
              {mode === "trophy" && playerCount === 4
                ? "Practice: you vs 3 AI (P2, P3, P4) — first to the centre trophy wins."
                : mode === "trophy"
                  ? "Practice: you vs 1 AI — first to the centre trophy wins."
                  : "Practice: you vs 1 AI — first to the opposite goal row wins."}
            </p>
          )}
          <button
            className="btn"
            disabled={mode !== "race" || playerCount !== 2}
            title={mode !== "race" || playerCount !== 2 ? "Local play is Race 2P only — pick Race + 2 pemain" : "Two players, one device"}
            onClick={() => props.onLocal2P(choices())}
          >
            👥 Local 2P — one device
          </button>
        </div>

        <p className="menu-foot">
          {mode === "trophy"
            ? "Rebut Piala: first to step on the gold trophy in the centre wins. "
            : "Race to the Top: first to the opposite goal row wins. "}
          Turn-based: one action per turn — move or place a blockade — 30 s per turn. WASD / arrows to
          move, drag a grid edge to place a blockade, <b>B</b> for quick place. Blockades cost energy —
          and can never trap a player.
        </p>
      </div>
    </div>
  );
}
