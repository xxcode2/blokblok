// In-game HUD: timer, energy, progress, connection, blockade controls.
// Spec §14: player score, opponent score, energy, timer, blockade cooldown,
// current objective, network indicator.

import type { Orientation, Snapshot } from "@blockade/core";
import { blockadeCost } from "@blockade/core";

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
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function Hud(props: HudProps): React.ReactElement {
  const { snap } = props;
  const me = props.myId ? snap.players.find((p) => p.id === props.myId) : snap.players[0];
  const foe = props.myId ? snap.players.find((p) => p.id !== props.myId) : snap.players[1];
  const cost = blockadeCost(props.length);
  const placeReady = me ? me.placeCooldownMs <= 0 && me.energy >= cost : false;
  const cdPct = me ? Math.max(0, 1 - me.placeCooldownMs / 500) : 1;

  return (
    <div className="hud">
      <div className="hud-row">
        <div className="hud-players">
          {snap.players.map((p) => {
            const isMe = p.id === props.myId;
            const goalRow = p.color === "blue" ? "row 0" : `row ${snap.gridSize - 1}`;
            return (
              <div key={p.id} className={`hud-player ${p.color}${isMe ? " me" : ""}`}>
                <span className="hud-orb-dot" />
                <span className="hud-name">
                  {p.name}
                  {isMe ? " (you)" : ""}
                </span>
                <span className="hud-score">{p.score} pts</span>
                <div className="hud-progress" title={`Progress to ${goalRow}`}>
                  <div className="hud-progress-fill" style={{ width: `${Math.round(p.progress * 100)}%` }} />
                </div>
                <span className="hud-energy-label">⚡ {Math.floor(p.energy)}/100</span>
                <div className="hud-energy" title="Blockade energy (regenerates 5/s)">
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
          <div className="hud-objective">🎯 First to the opposite goal row wins</div>
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
            title={placeReady ? "Place a blockade ahead of you (B)" : "On cooldown or not enough energy"}
          >
            🧱 Place blockade {me && me.placeCooldownMs > 0 ? `(${(me.placeCooldownMs / 1000).toFixed(1)}s)` : ""}
          </button>
        ) : (
          <>
            {snap.players.map((p) => (
              <button
                key={p.id}
                className={`hud-place ${p.color}`}
                disabled={p.placeCooldownMs > 0 || p.energy < cost}
                onClick={() => props.onPlaceAuto(p.id)}
                title={`Place a blockade ahead of ${p.name}`}
              >
                🧱 {p.name}
              </button>
            ))}
          </>
        )}
        <div className="hud-cooldown" title="Blockade placement cooldown">
          <div className="hud-cooldown-fill" style={{ width: `${Math.round(cdPct * 100)}%` }} />
        </div>
      </div>
      {foe && me && (
        <div className="hud-vs">
          {me.name} vs {foe.name} · {snap.gridSize}×{snap.gridSize} · Race to the Top
        </div>
      )}
    </div>
  );
}
