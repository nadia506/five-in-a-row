import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const rooms = new Map();

const GRID = 19;
function emptyBoard() {
  return Array.from({ length: GRID }, () => Array(GRID).fill(0));
}
const ROOM_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genRoomId(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++)
    s += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
  return s;
}
function seatsFilled(room) {
  return !!(room.players.black && room.players.white);
}

app.post("/rooms", (req, res) => {
  let roomId = genRoomId();
  let tries = 0;
  while (rooms.has(roomId) && tries < 5) {
    roomId = genRoomId();
    tries++;
  }
  if (rooms.has(roomId))
    return res.status(500).json({ error: "could not create room" });

  const room = {
    board: emptyBoard(),
    current: 1,
    gameOver: false,
    winLine: null,
    lastWinner: null,
    players: { black: null, white: null },
    sockets: new Set(),
    createdAt: Date.now(),
    cleanupTimer: null,
    seatTimers: { black: null, white: null },
  };
  rooms.set(roomId, room);
  return res.json({ room: roomId });
});

app.get("/token", (req, res) => {
  const roomId = String(req.query.room || "").trim();
  if (!roomId) return res.status(400).json({ error: "room required" });

  let room = rooms.get(roomId);
  if (!room) {
    room = {
      board: emptyBoard(),
      current: 1,
      gameOver: false,
      winLine: null,
      lastWinner: null,
      players: { black: null, white: null },
      sockets: new Set(),
      createdAt: Date.now(),
      cleanupTimer: null,
      seatTimers: { black: null, white: null }, // ✅ 여기에도 포함
    };
    rooms.set(roomId, room);
  } else if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  let color = null;
  if (!room.players.black) color = 1;
  else if (!room.players.white) color = 2;
  else return res.status(409).json({ error: "room full" });

  const token = `${roomId}.${color}.${crypto.randomUUID()}`;
  const playerId = token.split(".").slice(-1)[0];
  if (color === 1) room.players.black = { id: playerId, token };
  else room.players.white = { id: playerId, token };

  return res.json({ room: roomId, token, color });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "hello") {
      const { token } = msg;
      const parsed = parseToken(token);
      if (!parsed)
        return ws.send(json({ type: "error", message: "invalid token" }));
      const { roomId, color } = parsed;

      const room = rooms.get(roomId);
      if (!room)
        return ws.send(json({ type: "error", message: "room not found" }));

      const expected = color === 1 ? room.players.black : room.players.white;
      if (!expected || expected.token !== token) {
        return ws.send(json({ type: "error", message: "auth failed" }));
      }

      ws.meta = { roomId, color };
      room.sockets.add(ws);

      const seatKey = color === 1 ? "black" : "white";
      if (room.seatTimers?.[seatKey]) {
        clearTimeout(room.seatTimers[seatKey]);
        room.seatTimers[seatKey] = null;
      }

      sendStateTo(ws, room, color);
      broadcastExcept(ws, room, {
        type: "state",
        board: room.board,
        current: room.current,
        gameOver: room.gameOver,
        winLine: room.winLine,
        ready: seatsFilled(room),
      });

      return;
    }

    if (msg.type === "move") {
      if (!ws.meta) return;
      const { roomId, color } = ws.meta;
      const room = rooms.get(roomId);
      if (!room) return;

      const { r, c } = msg;
      if (room.gameOver) return sendError(ws, "game already over");
      if (!inRange(r, c)) return sendError(ws, "out of range");
      if (room.board[r][c] !== 0) return sendError(ws, "occupied");
      if (color !== room.current) return sendError(ws, "not your turn");
      if (!seatsFilled(room)) return sendError(ws, "waiting for opponent");

      room.board[r][c] = color;

      const win = computeWin(room.board, r, c);
      if (win.win) {
        room.gameOver = true;
        room.winLine = win.line;
        room.lastWinner = color;
        return broadcast(room, {
          type: "state",
          board: room.board,
          lastMove: { r, c, color },
          current: room.current,
          gameOver: true,
          winner: color,
          winLine: room.winLine,
          ready: seatsFilled(room),
        });
      }

      room.current = room.current === 1 ? 2 : 1;
      return broadcast(room, {
        type: "state",
        board: room.board,
        lastMove: { r, c, color },
        current: room.current,
        gameOver: false,
        ready: seatsFilled(room),
      });
    }

    if (msg.type === "restart") {
      if (!ws.meta) return;
      const { roomId } = ws.meta;
      const room = rooms.get(roomId);
      if (!room) return;

      room.board = emptyBoard();
      room.current = room.lastWinner === 2 ? 2 : 1;
      room.gameOver = false;
      room.winLine = null;

      return broadcast(room, {
        type: "state",
        board: room.board,
        current: room.current,
        gameOver: false,
        winLine: null,
        ready: seatsFilled(room),
      });
    }
  });

  ws.on("close", () => {
    if (!ws.meta) return;
    const { roomId, color } = ws.meta;
    const room = rooms.get(roomId);
    if (!room) return;

    room.sockets.delete(ws);
    const seatKey = color === 1 ? "black" : "white";
    if (room.seatTimers?.[seatKey]) clearTimeout(room.seatTimers[seatKey]);
    room.seatTimers[seatKey] = setTimeout(() => {
      const stillHere = [...room.sockets].some(
        (s) => s.meta?.roomId === roomId && s.meta?.color === color
      );
      if (!stillHere) room.players[seatKey] = null;
      room.seatTimers[seatKey] = null;
    }, 90 * 1000);

    if (room.sockets.size === 0) {
      if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
      room.cleanupTimer = setTimeout(
        () => rooms.delete(roomId),
        10 * 60 * 1000
      );
    }
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server at http://localhost:${PORT}`));

function parseToken(token) {
  if (!token) return null;
  const [roomId, colorStr] = token.split(".");
  const color = Number(colorStr);
  if (!roomId || !(color === 1 || color === 2)) return null;
  return { roomId, color };
}
function json(obj) {
  return JSON.stringify(obj);
}
function sendError(ws, message) {
  ws.send(json({ type: "error", message }));
}
function broadcast(room, obj) {
  const data = json(obj);
  room.sockets.forEach((s) => {
    try {
      s.send(data);
    } catch {}
  });
}
function broadcastExcept(ws, room, obj) {
  const data = json(obj);
  room.sockets.forEach((s) => {
    if (s !== ws)
      try {
        s.send(data);
      } catch {}
  });
}
function sendStateTo(ws, room, yourColor) {
  ws.send(
    json({
      type: "state",
      board: room.board,
      current: room.current,
      gameOver: room.gameOver,
      winLine: room.winLine,
      youAre: yourColor,
      ready: seatsFilled(room),
    })
  );
}
function inRange(r, c) {
  return r >= 0 && r < GRID && c >= 0 && c < GRID;
}
function computeWin(bd, r, c) {
  const color = bd[r][c];
  const dirs = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of dirs) {
    const cells = [{ r, c }];
    let nr = r + dr,
      nc = c + dc;
    while (inRange(nr, nc) && bd[nr][nc] === color) {
      cells.push({ r: nr, c: nc });
      nr += dr;
      nc += dc;
    }
    nr = r - dr;
    nc = c - dc;
    while (inRange(nr, nc) && bd[nr][nc] === color) {
      cells.unshift({ r: nr, c: nc });
      nr -= dr;
      nc -= dc;
    }
    if (cells.length >= 5) return { win: true, line: cells };
  }
  return { win: false, line: null };
}
