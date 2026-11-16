// Main menu — spec §14: Play Online, Ranked-lite / Casual, Private Room,
// Practice vs AI, Local 2P. Ranked-lite points live in localStorage only.

import { useState } from "react";
import type { AiDifficulty } from "../ai";
import type { GridSize } from "@blockade/core";

export interface MenuChoices {
  name: string;
  ranked: boolean;
  gridSize: GridSize;
  durationSec: number;
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

  const choices = (): MenuChoices => ({ name: props.name.trim() || "Player", ranked, gridSize, durationSec });

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
          <button className="btn" onClick={() => props.onLocal2P(choices())}>
            👥 Local 2P — one device
          </button>
        </div>

        <p className="menu-foot">
          Turn-based: one action per turn — move or place a blockade — 30 s per turn. WASD / arrows to
          move, drag a grid edge to place a blockade, <b>B</b> for quick place. Blockades cost energy —
          and can never trap a player.
        </p>
      </div>
    </div>
  );
}
