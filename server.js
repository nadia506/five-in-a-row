import express from "express";
import http from "http";
import cors from "cors";
import { WebSocketServer } from "ws";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const rooms = new Map();

const GRID = 19;
function emptyBoard() {
  return Array.from({ length: GRID }, () => Array(GRID).fill(0));
}

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
      players: { black: null, white: null },
      sockets: new Set(),
      createdAt: Date.now(),
    };
    rooms.set(roomId, room);
  }

  let color = null;
  if (!room.players.black) color = 1;
  else if (!room.players.white) color = 2;
  else return res.status(409).json({ error: "room full" });

  const token = `${roomId}.${color}.${Math.random().toString(36).slice(2)}`;
  const playerId = token.split(".").slice(-1)[0];
  if (color === 1) room.players.black = { id: playerId, token };
  else room.players.white = { id: playerId, token };

  res.json({ room: roomId, token, color });
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

      const expect = color === 1 ? room.players.black : room.players.white;
      if (!expect || expect.token !== token) {
        return ws.send(json({ type: "error", message: "auth failed" }));
      }

      ws.meta = { roomId, color };
      room.sockets.add(ws);

      sendStateTo(ws, room, color);
      broadcastExcept(ws, room, {
        type: "info",
        message: color === 1 ? "Black joined" : "White joined",
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

      room.board[r][c] = color;

      const win = computeWin(room.board, r, c);
      if (win.win) {
        room.gameOver = true;
        room.winLine = win.line;
        broadcast(room, {
          type: "state",
          board: room.board,
          lastMove: { r, c, color },
          current: room.current,
          gameOver: true,
          winner: color,
          winLine: room.winLine,
        });
        return;
      }

      room.current = room.current === 1 ? 2 : 1;
      broadcast(room, {
        type: "state",
        board: room.board,
        lastMove: { r, c, color },
        current: room.current,
        gameOver: false,
      });
      return;
    }

    if (msg.type === "restart") {
      if (!ws.meta) return;
      const { roomId } = ws.meta;
      const room = rooms.get(roomId);
      if (!room) return;
      room.board = emptyBoard();
      room.current = 1; // 새 게임은 Black 선공
      room.gameOver = false;
      room.winLine = null;
      broadcast(room, {
        type: "state",
        board: room.board,
        current: room.current,
        gameOver: false,
      });
      return;
    }
  });

  ws.on("close", () => {
    if (!ws.meta) return;
    const room = rooms.get(ws.meta.roomId);
    if (!room) return;
    room.sockets.delete(ws);
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
server.listen(PORT, () => {
  console.log(`Server at http://localhost:${PORT}`);
});

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
