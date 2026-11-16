// In-game HUD: turn banner + turn timer, energy, progress, connection,
// blockade controls. Turn-based (protocol 1.2.0): one action per turn, 30 s
// per turn — no cooldowns. The turn banner + timer bar live here and nowhere
// else; the bar fill / seconds are updated every animation frame by the Game
// screen's rAF loop through turnBarRef / turnTextRef (no second timer, and
// React never overwrites them because no width/text is set in props).

import type { Orientation, Snapshot } from "@blockade/core";
import { blockadeCost } from "@blockade/core";
import type { RefObject } from "react";
import { arenaModeOf } from "../game/mode";

export interface HudProps {
  snap: Snapshot;
  myId: string | null; // null in local 2P (both players shown)
  latencyMs: number | null;
  connected: boolean;
  online: boolean;
  orientation: Orientation;
  length: number;
  onOrientation: (o: Orientation) => void;
  onLength: (len: number) => void;
  onPlaceAuto: (playerId: string) => void;
  onLeave: () => void;
  muted: boolean;
  onToggleMute: () => void;
  flash: string | null;
  /** "Giliran kamu · Turn 3" / "Giliran P3 · Turn 3"; null when no turn is live. */
  turnLabel: string | null;
  /** Colour of the player whose turn it is (drives the banner dot). */
  turnColor: "blue" | "red" | "green" | "amber" | null;
  /** True when the banner marks the local player's own turn (online/practice). */
  turnMine: boolean;
  /** Bar fill driven imperatively every frame by the Game rAF loop. */
  turnBarRef: RefObject<HTMLDivElement | null>;
  /** Seconds text driven imperatively every frame by the Game rAF loop. */
  turnTextRef: RefObject<HTMLSpanElement | null>;
  /** True when the acting (local) player may act this turn. */
  canAct: boolean;
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Hud(props: HudProps): React.ReactElement {
  const { snap } = props;
  const mode = arenaModeOf(snap);
  const trophy = mode === "trophy";
  const me = props.myId ? snap.players.find((p) => p.id === props.myId) : snap.players[0];
  const foe = props.myId ? snap.players.find((p) => p.id !== props.myId) : snap.players[1];
  const cost = blockadeCost(props.length);
  const placeReady = props.canAct && me ? me.energy >= cost : false;

  return (
    <div className="hud">
      {props.turnLabel && (
        <div className={`hud-turn ${props.turnMine ? "mine" : "theirs"}`}>
          <span className={`hud-turn-dot ${props.turnColor ?? ""}`} />
          <span className="hud-turn-label">{props.turnLabel}</span>
          <span className="hud-turn-secs" ref={props.turnTextRef} />
          <div className="hud-turn-bar" title="Time left in this turn (30 s per turn)">
            <div className="hud-turn-fill" ref={props.turnBarRef} />
          </div>
        </div>
      )}
      <div className="hud-row">
        <div className="hud-players">
          {/* Every player in the match, 2 or 4, each with their energy bar. */}
          {snap.players.map((p, i) => {
            const isMe = p.id === props.myId;
            const isActive = p.id === snap.activePlayerId && snap.status === "playing";
            const goalRow = p.color === "blue" ? "row 0" : `row ${snap.gridSize - 1}`;
            const progressTitle = trophy ? "Progress to the trophy" : `Progress to ${goalRow}`;
            return (
              <div key={p.id} className={`hud-player ${p.color}${isMe ? " me" : ""}${isActive ? " active-turn" : ""}`}>
                <span className="hud-orb-dot" />
                <span className="hud-name">
                  P{i + 1} · {p.name}
                  {isMe ? " (you)" : ""}
                  {isActive ? " ●" : ""}
                </span>
                <span className="hud-score">{p.score} pts</span>
                <div className="hud-progress" title={progressTitle}>
                  <div className="hud-progress-fill" style={{ width: `${Math.round(p.progress * 100)}%` }} />
                </div>
                <span className="hud-energy-label">⚡ {Math.floor(p.energy)}/100</span>
                <div className="hud-energy" title="Blockade energy (+10 at the start of each of your turns)">
                  <div className="hud-energy-fill" style={{ width: `${Math.round(p.energy)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="hud-center">
          <div className="hud-timer" title="Match timer">
            ⏱ {fmtTime(snap.timeLeftMs)}
          </div>
          <div className="hud-objective">
            {trophy ? "🏆 First to the trophy in the centre wins" : "🎯 First to the opposite goal row wins"}
          </div>
          {props.online && (
            <div className={`hud-conn ${props.connected ? "ok" : "bad"}`} title="Connection to the game server">
              <span className="hud-conn-dot" />
              {props.connected ? `online · ${props.latencyMs ?? "—"} ms` : "reconnecting…"}
            </div>
          )}
        </div>
        <div className="hud-actions">
          <button className="hud-icon-btn" onClick={props.onToggleMute} title={props.muted ? "Unmute" : "Mute"}>
            {props.muted ? "🔇" : "🔊"}
          </button>
          <button className="hud-icon-btn" onClick={props.onLeave} title="Leave match">
            ✕
          </button>
        </div>
      </div>

      {props.flash && <div className="hud-flash">{props.flash}</div>}

      <div className="hud-controls">
        <div className="hud-seg" title="Blockade orientation">
          <button className={props.orientation === "h" ? "active" : ""} onClick={() => props.onOrientation("h")}>
            ― Horizontal
          </button>
          <button className={props.orientation === "v" ? "active" : ""} onClick={() => props.onOrientation("v")}>
            | Vertical
          </button>
        </div>
        <div className="hud-seg" title="Blockade length (cost 20 for 1–2, 35 for 3–4)">
          {[1, 2, 3, 4].map((len) => (
            <button key={len} className={props.length === len ? "active" : ""} onClick={() => props.onLength(len)}>
              ×{len}
            </button>
          ))}
          <span className="hud-cost">cost {cost}⚡</span>
        </div>
        {props.myId || snap.players.length === 1 ? (
          <button
            className="hud-place"
            disabled={!placeReady}
            onClick={() => me && props.onPlaceAuto(me.id)}
            title={placeReady ? "Place a blockade ahead of you (B)" : props.canAct ? "Not enough energy" : "Wait for your turn"}
          >
            🧱 Place blockade
          </button>
        ) : (
          <>
            {snap.players.map((p) => {
              const pActive = p.id === snap.activePlayerId && snap.status === "playing";
              return (
                <button
                  key={p.id}
                  className={`hud-place ${p.color}`}
                  disabled={!pActive || p.energy < cost}
                  onClick={() => props.onPlaceAuto(p.id)}
                  title={pActive ? `Place a blockade ahead of ${p.name}` : `Wait for ${p.name}'s turn`}
                >
                  🧱 {p.name}
                </button>
              );
            })}
          </>
        )}
      </div>
      {me && snap.players.length === 2 && foe && (
        <div className="hud-vs">
          {me.name} vs {foe.name} · {snap.gridSize}×{snap.gridSize} · Race to the Top · one action per turn
        </div>
      )}
      {me && snap.players.length > 2 && (
        <div className="hud-vs">
          {snap.players.map((p) => p.name).join(" · ")} · {snap.gridSize}×{snap.gridSize} ·{" "}
          {trophy ? "Rebut Piala" : "Race to the Top"} · one action per turn
        </div>
      )}
    </div>
  );
}
