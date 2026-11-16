// Lobby — spec §14: room code, player slots, ready toggles, host Start,
// countdown. Also used as the matchmaking "searching" screen.
// Protocol 1.2.0: the lobby carries the arena mode + player count — 2 slots
// for Race, 2 or 4 for Trophy.

import { useState } from "react";
import { colorOfIndex, playerLabel, type ArenaMode, type ArenaPlayerCount } from "../game/mode";

export interface LobbyPlayer {
  id: string;
  name: string;
  ready: boolean;
  isHost: boolean;
}

export interface LobbyProps {
  roomCode: string | null;
  players: LobbyPlayer[];
  myId: string | null;
  isHost: boolean;
  searching: boolean;
  queuePosition: number | null;
  countdown: number | null;
  error: string | null;
  /** Arena mode for this room/match (default "race"). */
  mode?: ArenaMode;
  /** Player slots in this room: 2, or 4 in trophy mode (default 2). */
  playerCount?: ArenaPlayerCount;
  onToggleReady: () => void;
  onStart: () => void;
  onLeave: () => void;
  onCancelQueue: () => void;
}

export function Lobby(props: LobbyProps): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const me = props.players.find((p) => p.id === props.myId);
  const playerCount = props.playerCount ?? 2;
  const mode: ArenaMode = props.mode ?? "race";
  const modeLabel = mode === "trophy" ? "🏆 Rebut Piala" : "🏁 Race to the Top";
  const allReady = props.players.length >= playerCount && props.players.every((p) => p.ready);
  const emptySlots = Math.max(0, playerCount - props.players.length);

  const copyCode = async () => {
    if (!props.roomCode) return;
    try {
      await navigator.clipboard.writeText(props.roomCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="lobby-screen">
      <h2>{props.searching ? "Finding an opponent…" : "Lobby"}</h2>
      <p className="lobby-mode">
        {modeLabel} · {playerCount} pemain
        {mode === "trophy" ? " — first to the centre trophy wins" : " — first to the opposite goal row wins"}
      </p>

      {props.searching ? (
        <div className="lobby-card">
          <div className="spinner" />
          <p>
            In the matchmaking queue
            {props.queuePosition !== null ? ` — position #${props.queuePosition}` : ""}. All players
            share one queue in milestone 1.
          </p>
          <button className="btn" onClick={props.onCancelQueue}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="lobby-card">
          {props.roomCode && (
            <div className="room-code-box">
              <span>Room code</span>
              <strong>{props.roomCode}</strong>
              <button className="btn small" onClick={copyCode}>
                {copied ? "✓ Copied" : "Copy"}
              </button>
            </div>
          )}
          <div className="lobby-slots">
            {props.players.map((p, i) => (
              <div key={p.id} className={`lobby-slot ${p.ready ? "ready" : ""}`}>
                <span className={`lobby-orb ${colorOfIndex(i)}`} />
                <span className="lobby-name">
                  {playerLabel(i)} · {p.name}
                  {p.isHost ? " 👑 host" : ""}
                  {p.id === props.myId ? " (you)" : ""}
                </span>
                <span className="lobby-ready">{p.ready ? "✓ Ready" : "… Not ready"}</span>
              </div>
            ))}
            {Array.from({ length: emptySlots }, (_, k) => (
              <div key={`empty-${k}`} className="lobby-slot empty">
                <span className="lobby-orb ghost" />
                <span className="lobby-name">
                  {playerLabel(props.players.length + k)} · Waiting for player…
                </span>
                <span className="lobby-ready">Share the room code</span>
              </div>
            ))}
          </div>

          {props.error && <div className="menu-error">{props.error}</div>}

          {props.countdown !== null ? (
            <div className="countdown-overlay inline">
              <div className="countdown-num">{props.countdown}</div>
              <div className="countdown-sub">Match starting…</div>
            </div>
          ) : (
            <div className="lobby-actions">
              <button className="btn primary" onClick={props.onToggleReady}>
                {me?.ready ? "Not ready" : "✓ Ready"}
              </button>
              {props.isHost && (
                <button className="btn primary big" disabled={!allReady} onClick={props.onStart} title={allReady ? "Start the match" : "All players must be ready"}>
                  ▶ Start match
                </button>
              )}
              <button className="btn" onClick={props.onLeave}>
                Leave lobby
              </button>
            </div>
          )}
          {!props.isHost && <p className="lobby-note">Only the host can start the match.</p>}
        </div>
      )}
    </div>
  );
}
