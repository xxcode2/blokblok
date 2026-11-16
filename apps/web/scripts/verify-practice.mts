// Headless verification of the web client's Game-screen logic (no DOM),
// turn-based (protocol 1.1.0):
// - fixed-step 50ms simulation; movement is ONE discrete action per turn
//   (no cooldowns, no input buffering — an out-of-turn or illegal action is
//   rejected and the turn does NOT pass);
// - the AI acts exactly once per AI turn (one chooseAiAction call per turn,
//   mirroring the Game screen's ~500ms-delayed single-action driver);
// - a scripted player must win a practice match under turn rules.
// Plus the pointer helpers from apps/web/src/game/input.ts.
// Run: npx tsx apps/web/scripts/verify-practice.mts
import { GameEngine, chooseAiAction, TURN_DURATION_MS } from "@blockade/core";
import { pickEdge, extendEdge, swipeDir, joystickDir, keyToDir } from "../src/game/input.js";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "[ok]" : "[FAIL]"} ${name}${extra}`);
  if (!cond) failures++;
}

// --- input helpers (unchanged in the turn model) ---------------------------
check("pickEdge: near horizontal line -> h edge", (() => {
  const e = pickEdge(5.4, 6.1, 12);
  return e?.orientation === "h" && e.row === 6 && e.col === 5;
})());
check("pickEdge: near vertical line -> v edge", (() => {
  const e = pickEdge(6.1, 5.4, 12);
  return e?.orientation === "v" && e.col === 6 && e.row === 5;
})());
check("pickEdge: cell centre -> null (swipe, not drag)", pickEdge(5.5, 5.5, 12) === null);
check("pickEdge: border line row 0 -> null (no edge outside grid)", pickEdge(5.5, 0.1, 12) === null);
check("extendEdge: drag right grows len", (() => {
  const e = extendEdge({ row: 6, col: 5, orientation: "h", len: 1 }, 8.4, 6.1, 4);
  return e.len === 3 && e.col === 5;
})());
check("extendEdge: drag left grows backwards", (() => {
  const e = extendEdge({ row: 6, col: 5, orientation: "h", len: 1 }, 3.4, 6.1, 4);
  return e.len === 3 && e.col === 3;
})());
check("extendEdge: capped at maxLen 4", extendEdge({ row: 6, col: 5, orientation: "h", len: 1 }, 11.5, 6.1, 4).len === 4);
check("swipeDir: right", swipeDir(40, 5) === "right");
check("swipeDir: up", swipeDir(5, -40) === "up");
check("swipeDir: below threshold -> null", swipeDir(10, 10) === null);
check("joystickDir: dead zone -> null", joystickDir(0.2, 0.2) === null);
check("joystickDir: down", joystickDir(0.1, 0.8) === "down");
check("keyToDir: WASD + arrows", keyToDir("w") === "up" && keyToDir("ArrowLeft") === "left" && keyToDir("x") === null);

// --- turn-model unit checks (fresh engine) ---------------------------------
const probe = new GameEngine({ gridSize: 12, durationSec: 180 });
probe.addPlayer("p1", "Tester");
probe.addPlayer("p2", "AI · hard");
const t0 = Date.now();
probe.start(t0);
const ps0 = probe.snapshot();
check(
  "snapshot carries turn fields (turn 1 = P1, 30 s deadline)",
  ps0.activePlayerId === "p1" && ps0.turnNumber === 1 && ps0.turnDeadlineMs === t0 + TURN_DURATION_MS,
  ` (active=${ps0.activePlayerId}, turn=${ps0.turnNumber}, deadline=${ps0.turnDeadlineMs})`,
);
check(
  "PlayerState has no cooldown fields",
  !("moveCooldownMs" in ps0.players[0]) && !("placeCooldownMs" in ps0.players[0]),
);
check("out-of-turn move rejected NOT_YOUR_TURN, turn does not pass", (() => {
  const r = probe.tryMove("p2", "down");
  const s = probe.snapshot();
  return !r.ok && (r as { error?: string }).error === "NOT_YOUR_TURN" && s.turnNumber === 1 && s.activePlayerId === "p1";
})());
check("illegal move rejected, turn does NOT pass", (() => {
  const r = probe.tryMove("p1", "down"); // P1 starts on the bottom row
  const s = probe.snapshot();
  return !r.ok && s.turnNumber === 1 && s.activePlayerId === "p1";
})());
check("valid move passes the turn + emits a turn delta", (() => {
  const r = probe.tryMove("p1", "up");
  const s = probe.snapshot();
  const evs = probe.drainDeltas();
  return (
    r.ok &&
    s.turnNumber === 2 &&
    s.activePlayerId === "p2" &&
    evs.some((e) => e.k === "turn" && e.activePlayerId === "p2" && e.turnNumber === 2)
  );
})());
check("AI refuses to act off-turn (chooseAiAction -> null)", chooseAiAction(probe, "p1", "hard") === null);

// --- placeAuto (blockade button) on its own probe engine -------------------
// (Not inside the match: a wall placed ahead of P1 also blocks P1's own
// path, and costs exactly the tempo that decides a Hard-vs-Hard race.)
const probe2 = new GameEngine({ gridSize: 12, durationSec: 180 });
probe2.addPlayer("p1", "Tester");
probe2.addPlayer("p2", "AI · hard");
probe2.start(Date.now());
const paRes = probe2.placeAuto("p1", "up", "h", 2);
check("placeAuto (blockade button) placed a wall on P1's turn", paRes.ok);
check(
  "placeAuto passes the turn to P2",
  probe2.snapshot().activePlayerId === "p2" && probe2.snapshot().turnNumber === 2,
);
check("placeAuto wall is on the board", probe2.snapshot().blockades.length === 1);

// --- practice match, Game-screen loop shape --------------------------------
// Fixed-step 50ms sim; each turn exactly ONE action. The scripted player
// (P1) is driven by the same Hard chooser the Game screen uses for the AI —
// a naive shortest-path stepper is NOT a valid match driver under turn
// rules: it deadlocks head-on with the opponent (nextStepTowardGoal returns
// null when the only shortest-path cell is occupied) and a pure stepper
// loses the 1:1-tempo race to Hard anyway. Hard-vs-Hard is deterministic
// (no randomness in the Hard chooser), so P1 winning here is stable run
// to run; P2 is driven by one chooseAiAction call per AI turn, mirroring
// the Game screen's single-action AI driver.
const eng = new GameEngine({ gridSize: 12, durationSec: 180 });
eng.addPlayer("p1", "Tester");
eng.addPlayer("p2", "AI · hard");
eng.start(Date.now());
let simMs = 0;
let p1FailedActions = 0;
let p1Actions = 0;
let aiActions = 0;
const aiActionsPerTurn = new Map<number, number>();
const turnSequence: { turn: number; active: string }[] = [];
let lastSeenTurn = 0;

while (eng.snapshot().status !== "finished" && simMs < 180_000) {
  const step = 50;
  simMs += step;
  eng.tickMs(step, Date.now());

  const s = eng.snapshot();
  if (s.turnNumber !== lastSeenTurn) {
    lastSeenTurn = s.turnNumber;
    turnSequence.push({ turn: s.turnNumber, active: s.activePlayerId });
  }

  if (s.activePlayerId === "p1") {
    const action = chooseAiAction(eng, "p1", "hard");
    if (action) {
      p1Actions++;
      const ok =
        action.kind === "move" ? eng.tryMove("p1", action.dir).ok : eng.place("p1", action.edge).ok;
      if (!ok) p1FailedActions++;
    }
  } else if (s.activePlayerId === "p2") {
    const action = chooseAiAction(eng, "p2", "hard");
    if (action) {
      aiActions++;
      aiActionsPerTurn.set(s.turnNumber, (aiActionsPerTurn.get(s.turnNumber) ?? 0) + 1);
      if (action.kind === "move") eng.tryMove("p2", action.dir);
      else eng.place("p2", action.edge);
    }
  }
}

const snap = eng.snapshot();
check("practice match finished", snap.status === "finished", ` (status=${snap.status}, simMs=${simMs})`);
check(
  "scripted player P1 won the practice match (Hard vs Hard, deterministic)",
  snap.winnerId === "p1",
  ` (winner=${snap.winnerId})`,
);
check(
  "turns alternated P1/P2 from turn 1, one increment per action",
  (() => {
    if (turnSequence.length < 10) return false;
    if (turnSequence[0].turn !== 1 || turnSequence[0].active !== "p1") return false;
    for (let i = 1; i < turnSequence.length; i++) {
      if (turnSequence[i].turn !== turnSequence[i - 1].turn + 1) return false;
      if (turnSequence[i].active === turnSequence[i - 1].active) return false;
    }
    return true;
  })(),
  ` (${turnSequence.length} turns seen)`,
);
check("AI acted at most once per AI turn", Math.max(0, ...aiActionsPerTurn.values()) <= 1, ` (${aiActions} AI actions)`);
check("AI took turns during the match", aiActions > 0, ` (${aiActions} AI actions)`);
check("scripted P1 actions never failed", p1FailedActions === 0, ` (${p1FailedActions} failed of ${p1Actions})`);
check("winner score > 100", (snap.players.find((p) => p.id === snap.winnerId)?.score ?? 0) > 100);
check("blockades were placed during the match", snap.blockades.length > 0, ` (${snap.blockades.length})`);
check("engine stats tracked", JSON.stringify(eng.stats()).includes("moves"));

console.log(failures === 0 ? "\nVERIFY PRACTICE: PASS" : `\nVERIFY PRACTICE: FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
