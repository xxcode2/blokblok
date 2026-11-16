// Quick check: public 1v1 matchmaking pairs two queued players and auto-starts.
import WebSocket from "ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client(name) {
  const ws = new WebSocket("ws://127.0.0.1:3001");
  const log = [];
  ws.on("message", (d) => log.push(JSON.parse(d.toString())));
  const waitFor = (pred, ms, what) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const m = log.find(pred);
        if (m) {
          clearInterval(iv);
          resolve(m);
        } else if (Date.now() - t0 > ms) {
          clearInterval(iv);
          reject(new Error("timeout: " + what));
        }
      }, 25);
    });
  return { ws, log, waitFor, send: (o) => ws.send(JSON.stringify(o)) };
}
const a = client("A");
const b = client("B");
await Promise.all([new Promise((r) => a.ws.on("open", r)), new Promise((r) => b.ws.on("open", r))]);
a.send({ type: "hello", name: "Q1", clientVersion: "q" });
b.send({ type: "hello", name: "Q2", clientVersion: "q" });
await a.waitFor((m) => m.type === "welcome", 3000, "welcome");
await b.waitFor((m) => m.type === "welcome", 3000, "welcome");
a.send({ type: "queue", mode: "race", gridSize: 12 });
const q = await a.waitFor((m) => m.type === "queued", 3000, "queued");
console.log("queued position:", q.position);
b.send({ type: "queue", mode: "race", gridSize: 12 });
const found = await a.waitFor((m) => m.type === "matchFound", 5000, "matchFound A");
const foundB = await b.waitFor((m) => m.type === "matchFound", 5000, "matchFound B");
console.log("matchFound A room:", found.roomCode, "opponent:", found.opponent.name);
console.log("matchFound B room:", foundB.roomCode, "opponent:", foundB.opponent.name);
console.log("same room:", found.roomCode === foundB.roomCode);
const start = await a.waitFor((m) => m.type === "matchStart", 8000, "auto matchStart");
console.log("auto matchStart status:", start.snapshot.status, "players:", start.snapshot.players.length);
a.ws.close();
b.ws.close();
await sleep(200);
console.log("QUEUE TEST PASSED");
