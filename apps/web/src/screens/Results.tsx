// Results — spec §14: winner, match statistics, rematch, return to menu.
// Protocol 1.3.0: no points system — no scores, no rating change, only the
// winner, the win reason, the match duration, and per-player stats
// (moves, blockades placed).

import type { MatchResult } from "./Game";

export interface ResultsProps {
  result: MatchResult;
  myId: string;
  rematchLabel: string;
  onRematch: () => void;
  onMenu: () => void;
}

const REASON_LABEL: Record<string, string> = {
  goal: "reached the goal row",
  trophy: "reached the trophy first",
  timeout: "won on time — closest to the goal",
  forfeit: "opponent forfeited",
  draw: "draw — equal distance to the goal",
};

export function Results(props: ResultsProps): React.ReactElement {
  const { result, myId } = props;
  const iWon = result.winnerId === myId;
  const isDraw = result.winnerId === null;
  const winnerIdx = result.players.findIndex((p) => p.id === result.winnerId);
  const winner = winnerIdx >= 0 ? result.players[winnerIdx] : undefined;
  const winnerSeat = winnerIdx >= 0 ? `P${winnerIdx + 1}` : "";
  // Trophy mode: name the seat that captured the trophy ("P3 merebut piala!").
  const title = isDraw
    ? "🤝 Draw"
    : result.reason === "trophy"
      ? iWon
        ? `🏆 Kamu (${winnerSeat}) merebut piala!`
        : `🏆 ${winnerSeat} ${winner?.name ?? "Opponent"} merebut piala!`
      : iWon
        ? "🏆 You win!"
        : `😞 ${winner?.name ?? "Opponent"} wins`;
  const fmtDur = (ms: number) => {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  return (
    <div className="results-screen">
      <div className={`results-card ${iWon ? "win" : isDraw ? "draw" : "lose"}`}>
        <h2>{title}</h2>
        <p className="results-reason">{REASON_LABEL[result.reason] ?? result.reason}</p>

        <table className="results-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Moves</th>
              <th>Blockades</th>
            </tr>
          </thead>
          <tbody>
            {result.players.map((p, i) => (
              <tr key={p.id} className={p.id === myId ? "me" : ""}>
                <td>
                  <span className={`lobby-orb ${p.color}`} /> P{i + 1} · {p.name}
                  {p.id === myId ? " (you)" : ""}
                </td>
                <td>{result.stats[p.id]?.moves ?? 0}</td>
                <td>{result.stats[p.id]?.blockades ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="results-meta">Match length: {fmtDur(result.durationMs)}</p>

        <div className="results-actions">
          <button className="btn primary big" onClick={props.onRematch}>
            ↻ {props.rematchLabel}
          </button>
          <button className="btn" onClick={props.onMenu}>
            Main menu
          </button>
        </div>
      </div>
    </div>
  );
}
