// Headless verification of the web client's Game-screen logic (no DOM):
// fixed-step 50ms simulation + tryMove buffering + AI driver + placeAuto,
// exactly as apps/web/src/screens/Game.tsx runs a practice match, plus the
// pointer helpers from apps/web/src/game/input.ts.
// Run: npx tsx apps/web/scripts/verify-practice.mts
import { GameEngine, chooseAiAction } from "@blockade/core";
import { pickEdge, extendEdge, swipeDir, joystickDir, keyToDir } from "../src/game/input.js";

let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  console.log(`  ${cond ? "[ok]" : "[FAIL]"} ${name}${extra}`);
  if (!cond) failures++;
}

// --- input helpers ---------------------------------------------------------
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

// --- practice match, Game-screen loop shape --------------------------------
// Fixed-step 50ms sim; P1 scripted via nextStepTowardGoal, spamming tryMove
// every 100ms (faster than the 150ms cooldown) to exercise input buffering;
// P2 driven by Hard AI every 380ms; one placeAuto mid-game.
const eng = new GameEngine({ gridSize: 12, durationSec: 180 });
eng.addPlayer("p1", "Tester");
eng.addPlayer("p2", "AI · hard");
let bufferedSeen = 0;
let movesSent = 0;
let placeAutoOk = false;
let simMs = 0;
let aiAcc = 0;
let p1Acc = 0;
let placedAt = false;

while (eng.snapshot().status !== "finished" && simMs < 180_000) {
  const step = 50;
  simMs += step;
  aiAcc += step;
  p1Acc += step;
  eng.tickMs(step);

  if (p1Acc >= 100) {
    p1Acc = 0;
    const dir = eng.nextStepTowardGoal("p1");
    if (dir) {
      movesSent++;
      const res = eng.tryMove("p1", dir);
      if (res.ok && res.buffered) bufferedSeen++;
    }
  }
  if (aiAcc >= 380) {
    aiAcc = 0;
    const action = chooseAiAction(eng, "p2", "hard");
    if (action) {
      if (action.kind === "move") eng.tryMove("p2", action.dir);
      else eng.place("p2", action.edge);
    }
  }
  if (!placedAt && simMs >= 500) {
    placedAt = true;
    const r = eng.placeAuto("p1", "up", "h", 2);
    placeAutoOk = r.ok;
  }
}

const snap = eng.snapshot();
check("practice match finished", snap.status === "finished", ` (status=${snap.status}, simMs=${simMs})`);
check("practice match has a winner", snap.winnerId === "p1" || snap.winnerId === "p2", ` (winner=${snap.winnerId})`);
check("tryMove buffering exercised (inputs during cooldown buffered)", bufferedSeen > 0, ` (${bufferedSeen} buffered of ${movesSent} sent)`);
check("placeAuto (blockade button) placed a wall", placeAutoOk);
check("winner score > 100", (snap.players.find((p) => p.id === snap.winnerId)?.score ?? 0) > 100);
check("blockades were placed during the match", snap.blockades.length > 0, ` (${snap.blockades.length})`);
check("engine stats tracked", JSON.stringify(eng.stats()).includes("moves"));

console.log(failures === 0 ? "\nVERIFY PRACTICE: PASS" : `\nVERIFY PRACTICE: FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
