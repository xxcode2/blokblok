// Matchmaking smoke test: two clients queue -> matchFound -> countdown ->
// matchStart. Run: node apps/web/scripts/smoke-queue.mjs
const URL = process.argv[2] ?? "ws://localhost:3001";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class Client {
  constructor(name) {
    this.name = name;
    this.queue = [];
    this.waiters = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.addEventListener("open", () => {
        this.send({ type: "hello", name: this.name, clientVersion: "1.0.0" });
        resolve();
      });
      this.ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "welcome") this.playerId = msg.playerId;
        this.queue.push(msg);
        for (const w of this.waiters.splice(0)) w(msg);
      });
      this.ws.addEventListener("error", () => reject(new Error(`${this.name}: connect failed`)));
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  waitFor(type, timeoutMs = 10000) {
    const found = this.queue.find((m) => m.type === type);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push((msg) => {
        if (msg.type === type) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

try {
  const a = new Client("Queue-A");
  const b = new Client("Queue-B");
  await a.connect();
  await b.connect();
  await a.waitFor("welcome");
  await b.waitFor("welcome");
  a.send({ type: "queue", mode: "race", gridSize: 12 });
  b.send({ type: "queue", mode: "race", gridSize: 12 });
  const qa = await a.waitFor("queued");
  console.log(`  [ok] queued position=${qa.position}`);
  const mfA = await a.waitFor("matchFound");
  const mfB = await b.waitFor("matchFound");
  console.log(`  [ok] matchFound roomCode=${mfA.roomCode} opponent=${mfA.opponent.name} / ${mfB.opponent.name}`);
  const cd = await a.waitFor("countdown", 10000);
  console.log(`  [ok] countdown seconds=${cd.seconds}`);
  const ms = await a.waitFor("matchStart", 10000);
  console.log(`  [ok] matchStart status=${ms.snapshot.status} players=${ms.snapshot.players.length}`);
  a.close();
  b.close();
  console.log("\nSMOKE QUEUE: PASS");
  process.exit(0);
} catch (e) {
  console.error(`\nSMOKE QUEUE: FAIL — ${e.message}`);
  process.exit(1);
}
