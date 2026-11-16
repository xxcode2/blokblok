// BLOCKADE ARENA — web client root.
// Screen state machine: menu → lobby → game → results.
// Online play speaks the DEVELOPMENT.md protocol via NetClient; practice and
// local 2P run a local GameEngine from @blockade/core.

import { useCallback, useRef, useState } from "react";
import type { GameEngine, ServerMessage, Snapshot } from "@blockade/core";
import { GameEngine as Engine } from "@blockade/core";
import { DEFAULT_SERVER_URL, NetClient, applyDeltaToSnapshot } from "./net";
import type { AiDifficulty } from "./ai";
import { Menu, type MenuChoices } from "./screens/Menu";
import { Lobby, type LobbyPlayer } from "./screens/Lobby";
import { Game, type MatchResult } from "./screens/Game";
import { Results } from "./screens/Results";

type Screen = "menu" | "lobby" | "game" | "results";
type GameMode = "practice" | "local2p" | "online";
type RematchKind = "practice" | "local2p" | "queue" | "room" | "none";

function loadName(): string {
  try {
    return localStorage.getItem("ba-name") ?? "Player";
  } catch {
    return "Player";
  }
}

function loadPoints(): number {
  try {
    return Number(localStorage.getItem("ba-points") ?? "0") || 0;
  } catch {
    return 0;
  }
}

export function App(): React.ReactElement {
  const [screen, setScreen] = useState<Screen>("menu");
  const [name, setName] = useState(loadName());
  const [points, setPoints] = useState(loadPoints());
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const [mode, setMode] = useState<GameMode>("practice");
  const [engine, setEngine] = useState<GameEngine | null>(null);
  const [myId, setMyId] = useState("p1");
  const [aiDifficulty, setAiDifficulty] = useState<AiDifficulty | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);

  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [lobbyPlayers, setLobbyPlayers] = useState<LobbyPlayer[]>([]);
  const [isHost, setIsHost] = useState(false);
  const [searching, setSearching] = useState(false);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);

  const [result, setResult] = useState<MatchResult | null>(null);
  const [ratingDelta, setRatingDelta] = useState(0);
  const [rankedMatch, setRankedMatch] = useState(false);
  const [rematchLabel, setRematchLabel] = useState("Play again");

  const netRef = useRef<NetClient | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null); // latest snapshot for stale closures
  const choicesRef = useRef<MenuChoices | null>(null);
  const rematchRef = useRef<RematchKind>("none");
  const rankedRef = useRef(false);
  const screenRef = useRef<Screen>("menu");
  screenRef.current = screen;

  const savePoints = (p: number) => {
    setPoints(p);
    try {
      localStorage.setItem("ba-points", String(p));
    } catch {
      /* storage unavailable */
    }
  };

  const onName = (n: string) => {
    setName(n);
    try {
      localStorage.setItem("ba-name", n);
    } catch {
      /* storage unavailable */
    }
  };

  const applyResult = useCallback(
    (r: MatchResult) => {
      if (screenRef.current !== "game") return;
      let delta = 0;
      if (rankedRef.current && mode === "online") {
        if (r.winnerId === null) delta = 5;
        else if (r.winnerId === myId) delta = 25;
        else delta = -10;
        savePoints(Math.max(0, loadPoints() + delta));
      }
      setRatingDelta(delta);
      setResult(r);
      setScreen("results");
    },
    [mode, myId],
  );

  const handleServerMessage = useCallback(
    (msg: ServerMessage) => {
      const net = netRef.current;
      switch (msg.type) {
        case "welcome":
          setMyId(msg.playerId);
          break;
        case "roomCreated":
          setRoomCode(msg.roomCode);
          setIsHost(true);
          setLobbyPlayers([{ id: net?.playerId ?? "me", name: name || "Player", ready: false, isHost: true }]);
          setSearching(false);
          setScreen("lobby");
          break;
        case "roomJoined":
          setRoomCode(msg.roomCode);
          setIsHost(msg.players.find((p) => p.id === net?.playerId)?.isHost ?? false);
          setLobbyPlayers(msg.players);
          setSearching(false);
          setScreen("lobby");
          break;
        case "lobbyUpdate":
          setLobbyPlayers(msg.players);
          break;
        case "queued":
          setQueuePosition(msg.position);
          setSearching(true);
          setScreen("lobby");
          break;
        case "queueLeft":
          setSearching(false);
          setScreen("menu");
          break;
        case "matchFound": {
          setSearching(false);
          setRoomCode(msg.roomCode);
          setLobbyPlayers([
            { id: net?.playerId ?? "me", name: name || "Player", ready: true, isHost: false },
            { id: msg.opponent.id, name: msg.opponent.name, ready: true, isHost: false },
          ]);
          setScreen("lobby");
          break;
        }
        case "countdown":
          setCountdown(msg.seconds);
          break;
        case "matchStart":
          setSnapshot(msg.snapshot);
          snapshotRef.current = msg.snapshot;
          setCountdown(null);
          setScreen("game");
          break;
        case "state":
          setSnapshot(msg.snapshot);
          snapshotRef.current = msg.snapshot;
          break;
        case "delta":
          setSnapshot((prev) => {
            const next = prev ? applyDeltaToSnapshot(prev, msg.events) : prev;
            if (next) snapshotRef.current = next;
            return next;
          });
          break;
        case "result":
          applyResult({
            winnerId: msg.winnerId,
            reason: msg.reason,
            scores: msg.scores,
            stats: msg.stats,
            durationMs: msg.durationMs,
            players: (snapshotRef.current?.players ?? []).map((p) => ({ id: p.id, name: p.name, color: p.color })),
          });
          break;
        case "opponentLeft":
          setServerError("Opponent disconnected — 30 s to reconnect, then they forfeit.");
          window.setTimeout(() => setServerError(null), 8000);
          break;
        case "reconnected":
          setSnapshot(msg.snapshot);
          snapshotRef.current = msg.snapshot;
          setScreen("game");
          setError(null);
          break;
        case "error": {
          // Routine rejections (cooldown / illegal move) are feedback, not errors.
          if (msg.code === "INVALID_MOVE" || msg.code === "ON_COOLDOWN") break;
          const label =
            msg.code === "ROOM_NOT_FOUND"
              ? "Room not found — check the code."
              : msg.code === "ROOM_FULL"
                ? "That room is full."
                : msg.code === "NO_ENERGY"
                  ? "Not enough energy ⚡"
                  : msg.code === "NO_PATH"
                    ? "That would trap a player — illegal."
                    : msg.message;
          if (screenRef.current === "game") {
            setServerError(label);
            window.setTimeout(() => setServerError(null), 3000);
          } else {
            setError(label);
          }
          break;
        }
        default:
          break;
      }
    },
    [applyResult, name],
  );

  const ensureNet = useCallback(async (): Promise<NetClient | null> => {
    if (netRef.current?.connected) return netRef.current;
    const net = new NetClient(DEFAULT_SERVER_URL);
    netRef.current = net;
    setConnecting(true);
    setError(null);
    try {
      await net.connect(name || "Player", {
        onMessage: handleServerMessage,
        onOpen: () => setConnecting(false),
        onClose: (inMatch) => {
          if (inMatch) {
            setServerError("Connection lost — reconnecting…");
          } else if (screenRef.current === "lobby") {
            setError("Lost connection to the server.");
            setScreen("menu");
          }
          setConnecting(false);
        },
        onError: () => {
          /* onClose carries the user-visible state */
        },
      });
      return net;
    } catch {
      setConnecting(false);
      setError("Could not reach the game server (ws://localhost:3001). Is it running?");
      return null;
    }
  }, [handleServerMessage, name]);

  const startPractice = useCallback((c: MenuChoices, diff: AiDifficulty) => {
    const eng = new Engine({ gridSize: c.gridSize, durationSec: c.durationSec });
    eng.addPlayer("p1", c.name);
    eng.addPlayer("p2", `AI · ${diff}`);
    choicesRef.current = c;
    rematchRef.current = "practice";
    setRematchLabel("Practice again");
    rankedRef.current = false;
    setRankedMatch(false);
    setMode("practice");
    setEngine(eng);
    setMyId("p1");
    setAiDifficulty(diff);
    setSnapshot(eng.snapshot());
    setCountdown(null);
    setResult(null);
    setError(null);
    setScreen("game");
  }, []);

  const startLocal2P = useCallback((c: MenuChoices) => {
    const eng = new Engine({ gridSize: c.gridSize, durationSec: c.durationSec });
    eng.addPlayer("p1", `${c.name} · P1`);
    eng.addPlayer("p2", `${c.name} · P2`);
    choicesRef.current = c;
    rematchRef.current = "local2p";
    setRematchLabel("Play again (local 2P)");
    rankedRef.current = false;
    setRankedMatch(false);
    setMode("local2p");
    setEngine(eng);
    setMyId("p1");
    setAiDifficulty(null);
    setSnapshot(eng.snapshot());
    setCountdown(null);
    setResult(null);
    setError(null);
    setScreen("game");
  }, []);

  const playOnline = useCallback(
    async (c: MenuChoices) => {
      choicesRef.current = c;
      rematchRef.current = "queue";
      setRematchLabel("Find a new match");
      rankedRef.current = c.ranked;
      setRankedMatch(c.ranked);
      const net = await ensureNet();
      if (!net) return;
      setMode("online");
      net.queue("race", c.gridSize);
      setSearching(true);
      setScreen("lobby");
    },
    [ensureNet],
  );

  const createRoom = useCallback(
    async (c: MenuChoices) => {
      choicesRef.current = c;
      rematchRef.current = "room";
      setRematchLabel("Create a new room");
      rankedRef.current = c.ranked;
      setRankedMatch(c.ranked);
      const net = await ensureNet();
      if (!net) return;
      setMode("online");
      net.createRoom("race", c.gridSize, c.durationSec);
    },
    [ensureNet],
  );

  const joinRoom = useCallback(
    async (c: MenuChoices, code: string) => {
      choicesRef.current = c;
      rematchRef.current = "room";
      setRematchLabel("Create a new room");
      rankedRef.current = c.ranked;
      setRankedMatch(c.ranked);
      const net = await ensureNet();
      if (!net) return;
      setMode("online");
      net.joinRoom(code);
    },
    [ensureNet],
  );

  const leaveToMenu = useCallback(() => {
    netRef.current?.disconnect();
    netRef.current = null;
    setEngine(null);
    setSnapshot(null);
    setSearching(false);
    setCountdown(null);
    setResult(null);
    setError(null);
    setScreen("menu");
  }, []);

  const onRematch = useCallback(() => {
    const c = choicesRef.current;
    if (!c) return leaveToMenu();
    if (rematchRef.current === "practice" && aiDifficulty) return startPractice(c, aiDifficulty);
    if (rematchRef.current === "local2p") return startLocal2P(c);
    if (rematchRef.current === "queue") {
      leaveToMenu();
      void playOnline(c);
      return;
    }
    // room: fresh room, same settings
    leaveToMenu();
    void createRoom(c);
  }, [aiDifficulty, createRoom, leaveToMenu, playOnline, startLocal2P, startPractice]);

  const me = lobbyPlayers.find((p) => p.id === netRef.current?.playerId);

  return (
    <div className="app">
      {screen === "menu" && (
        <Menu
          name={name}
          onName={onName}
          rankedPoints={points}
          onPlayOnline={playOnline}
          onCreateRoom={createRoom}
          onJoinRoom={joinRoom}
          onPractice={startPractice}
          onLocal2P={startLocal2P}
          connecting={connecting}
          error={error}
        />
      )}
      {screen === "lobby" && (
        <Lobby
          roomCode={roomCode}
          players={lobbyPlayers}
          myId={netRef.current?.playerId ?? null}
          isHost={isHost}
          searching={searching}
          queuePosition={queuePosition}
          countdown={countdown}
          error={error}
          onToggleReady={() => {
            const next = !(me?.ready ?? false);
            netRef.current?.setReady(next);
            setLobbyPlayers((ps) => ps.map((p) => (p.id === me?.id ? { ...p, ready: next } : p)));
          }}
          onStart={() => netRef.current?.start()}
          onLeave={() => {
            netRef.current?.leaveQueue();
            leaveToMenu();
          }}
          onCancelQueue={() => {
            netRef.current?.leaveQueue();
            leaveToMenu();
          }}
        />
      )}
      {screen === "game" && (
        <Game
          mode={mode}
          engine={engine}
          net={netRef.current}
          myId={myId}
          aiDifficulty={aiDifficulty}
          snapshot={snapshot}
          countdown={countdown}
          onResult={applyResult}
          onLeave={leaveToMenu}
        />
      )}
      {screen === "results" && result && (
        <Results
          result={result}
          myId={myId}
          ranked={rankedMatch}
          ratingDelta={ratingDelta}
          rematchLabel={rematchLabel}
          onRematch={onRematch}
          onMenu={leaveToMenu}
        />
      )}
      {screen === "game" && serverError && <div className="server-toast">{serverError}</div>}
      <footer className="app-foot">BLOCKADE ARENA · milestone 1 · Race to the Top · server {DEFAULT_SERVER_URL}</footer>
    </div>
  );
}
