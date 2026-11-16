// Results — spec §14: winner, match statistics, rating change, rematch,
// return to menu.

import type { MatchResult } from "./Game";

export interface ResultsProps {
  result: MatchResult;
  myId: string;
  ranked: boolean;
  ratingDelta: number;
  rematchLabel: string;
  onRematch: () => void;
  onMenu: () => void;
}

const REASON_LABEL: Record<string, string> = {
  goal: "reached the goal row",
  timeout: "won on time — closest to the goal",
  forfeit: "opponent forfeited",
  draw: "draw — equal distance to the goal",
};

export function Results(props: ResultsProps): React.ReactElement {
  const { result, myId } = props;
  const iWon = result.winnerId === myId;
  const isDraw = result.winnerId === null;
  const winner = result.players.find((p) => p.id === result.winnerId);
  const title = isDraw ? "🤝 Draw" : iWon ? "🏆 You win!" : `😞 ${winner?.name ?? "Opponent"} wins`;
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
              <th>Score</th>
              <th>Moves</th>
              <th>Blockades</th>
            </tr>
          </thead>
          <tbody>
            {result.players.map((p) => (
              <tr key={p.id} className={p.id === myId ? "me" : ""}>
                <td>
                  <span className={`lobby-orb ${p.color}`} /> {p.name}
                  {p.id === myId ? " (you)" : ""}
                </td>
                <td>{result.scores[p.id] ?? 0}</td>
                <td>{result.stats[p.id]?.moves ?? 0}</td>
                <td>{result.stats[p.id]?.blockades ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="results-meta">Match length: {fmtDur(result.durationMs)}</p>
        {props.ranked && (
          <p className="results-rating">
            Ranked-lite: {props.ratingDelta >= 0 ? "+" : ""}
            {props.ratingDelta} pts
          </p>
        )}

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
