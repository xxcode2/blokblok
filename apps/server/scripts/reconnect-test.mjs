// Quick check: a player who drops mid-match can reconnect with the token
// from roomCreated and receives `reconnected` with the live snapshot.
import WebSocket from "ws";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client() {
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
const a = client();
const b = client();
await Promise.all([new Promise((r) => a.ws.on("open", r)), new Promise((r) => b.ws.on("open", r))]);
a.send({ type: "hello", name: "R1", clientVersion: "r" });
b.send({ type: "hello", name: "R2", clientVersion: "r" });
await a.waitFor((m) => m.type === "welcome", 3000, "welcome");
await b.waitFor((m) => m.type === "welcome", 3000, "welcome");
a.send({ type: "createRoom", mode: "race", gridSize: 12, durationSec: 180 });
const created = await a.waitFor((m) => m.type === "roomCreated", 3000, "roomCreated");
b.send({ type: "joinRoom", roomCode: created.roomCode });
await b.waitFor((m) => m.type === "roomJoined", 3000, "roomJoined");
a.send({ type: "ready", ready: true });
b.send({ type: "ready", ready: true });
await sleep(200);
a.send({ type: "start" });
await a.waitFor((m) => m.type === "matchStart", 8000, "matchStart");
// A drops mid-match...
a.ws.close();
await sleep(300);
// ...and reconnects with the token.
const a2 = client();
await new Promise((r) => a2.ws.on("open", r));
a2.send({ type: "reconnect", token: created.token });
const re = await a2.waitFor((m) => m.type === "reconnected", 5000, "reconnected");
console.log("reconnected snapshot status:", re.snapshot.status, "players:", re.snapshot.players.length);
// A bad token must be rejected.
const a3 = client();
await new Promise((r) => a3.ws.on("open", r));
a3.send({ type: "reconnect", token: "deadbeefdeadbeefdeadbeefdeadbeef" });
const bad = await a3.waitFor((m) => m.type === "error", 5000, "bad token error");
console.log("bad token error code:", bad.code);
if (bad.code !== "BAD_TOKEN") throw new Error("expected BAD_TOKEN");
a2.ws.close();
a3.ws.close();
b.ws.close();
await sleep(200);
console.log("RECONNECT TEST PASSED");
