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
function inRange(r, c) {
  return r >= 0 && r < GRID && c >= 0 && c < GRID;
}
function json(obj) {
  return JSON.stringify(obj);
}

function seatsFilled(room) {
  return room.ai
    ? !!room.players.black
    : !!(room.players.black && room.players.white);
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

const DIRS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

function countRun(bd, r, c, dr, dc, color) {
  let n = 0;
  let rr = r + dr,
    cc = c + dc;
  while (inRange(rr, cc) && bd[rr][cc] === color) {
    n++;
    rr += dr;
    cc += dc;
  }
  return n;
}
function nextCell(bd, r, c, dr, dc) {
  const rr = r + dr,
    cc = c + dc;
  if (!inRange(rr, cc)) return null;
  return { r: rr, c: cc, v: bd[rr][cc] };
}

function scoreLine(bd, r, c, dr, dc, color) {
  const forward = countRun(bd, r, c, dr, dc, color);
  const backward = countRun(bd, r, c, -dr, -dc, color);
  const len = 1 + forward + backward;

  if (len >= 5) return 1e9;

  const fNext = nextCell(bd, r + forward * dr, c + forward * dc, dr, dc);
  const bNext = nextCell(bd, r - backward * dr, c - backward * dc, -dr, -dc);
  const openF = fNext && fNext.v === 0 ? 1 : 0;
  const openB = bNext && bNext.v === 0 ? 1 : 0;
  const openEnds = openF + openB;

  if (len === 4) {
    if (openEnds === 2) return 200000;
    if (openEnds === 1) return 80000;
  } else if (len === 3) {
    if (openEnds === 2) return 15000;
    if (openEnds === 1) return 4000;
  } else if (len === 2) {
    if (openEnds === 2) return 1200;
    if (openEnds === 1) return 300;
  }
  return 0;
}

function evaluateAt(bd, r, c, me, opp) {
  let atk = 0;
  for (const [dr, dc] of DIRS) {
    atk += scoreLine(bd, r, c, dr, dc, me);
  }
  let def = 0;
  for (const [dr, dc] of DIRS) {
    def += scoreLine(bd, r, c, dr, dc, opp);
  }
  const DEF_W = 0.5;
  return atk + DEF_W * def;
}
function hasNeighbor(bd, r, c, radius = 2) {
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      if (dr === 0 && dc === 0) continue;
      const rr = r + dr,
        cc = c + dc;
      if (inRange(rr, cc) && bd[rr][cc] !== 0) return true;
    }
  }
  return false;
}

function aiPickMove(room) {
  const bd = room.board;
  const AI = 2,
    HUMAN = 1;

  let anyStone = false;
  outer: for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++) {
      if (bd[r][c]) {
        anyStone = true;
        break outer;
      }
    }
  if (!anyStone) {
    const mid = (GRID - 1) >> 1;
    return { r: mid, c: mid };
  }

  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (bd[r][c] !== 0) continue;
      if (!hasNeighbor(bd, r, c)) continue;
      bd[r][c] = AI;
      const w = computeWin(bd, r, c);
      bd[r][c] = 0;
      if (w.win) return { r, c };
    }
  }

  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (bd[r][c] !== 0) continue;
      if (!hasNeighbor(bd, r, c)) continue;
      bd[r][c] = HUMAN;
      const w = computeWin(bd, r, c);
      bd[r][c] = 0;
      if (w.win) return { r, c };
    }
  }

  let best = null;
  let bestScore = -Infinity;
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (bd[r][c] !== 0) continue;
      if (!hasNeighbor(bd, r, c)) continue;
      const s = evaluateAt(bd, r, c, AI, HUMAN);
      if (s > bestScore) {
        bestScore = s;
        best = { r, c };
      }
    }
  }
  if (best) return best;

  const cand = [];
  const center = (GRID - 1) / 2;
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (bd[r][c] !== 0) continue;
      const dr = Math.abs(r - center);
      const dc = Math.abs(c - center);
      const dist = Math.sqrt(dr * dr + dc * dc);
      const w = 1 / (1 + dist);
      cand.push({ r, c, w });
    }
  }
  if (cand.length === 0) return null;
  let sum = 0;
  for (const k of cand) sum += k.w;
  let pick = Math.random() * sum;
  for (const k of cand) {
    pick -= k.w;
    if (pick <= 0) return { r: k.r, c: k.c };
  }
  return cand[cand.length - 1];
}

function scheduleAiMove(room) {
  if (!room.ai) return;
  if (room.gameOver) return;
  if (room.current !== 2) return;
  if (!room.players.black) return;
  if (room.aiTimer) return;

  const delay = 1000;
  room.aiTimer = setTimeout(() => {
    room.aiTimer = null;
    if (!room.ai || room.gameOver || room.current !== 2 || !room.players.black)
      return;

    const mv = aiPickMove(room);
    if (!mv) return;
    const { r, c } = mv;

    room.board[r][c] = 2;
    const winst = computeWin(room.board, r, c);
    if (winst.win) {
      room.gameOver = true;
      room.winLine = winst.line;
      room.lastWinner = 2;
      broadcast(room, {
        type: "state",
        board: room.board,
        lastMove: { r, c, color: 2 },
        current: room.current,
        gameOver: true,
        winner: 2,
        winLine: room.winLine,
        ready: seatsFilled(room),
      });
      return;
    }

    room.current = 1;
    broadcast(room, {
      type: "state",
      board: room.board,
      lastMove: { r, c, color: 2 },
      current: room.current,
      gameOver: false,
      ready: seatsFilled(room),
    });
  }, delay);
}

app.post("/rooms", (req, res) => {
  const aiMode = String(req.query.ai || "") === "1";
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
    ai: aiMode,
    players: { black: null, white: null },
    sockets: new Set(),
    cleanupTimer: null,
    seatTimers: { black: null, white: null },
    aiTimer: null,
  };
  rooms.set(roomId, room);
  return res.json({ room: roomId, ai: aiMode });
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
      ai: false,
      players: { black: null, white: null },
      sockets: new Set(),
      cleanupTimer: null,
      seatTimers: { black: null, white: null },
      aiTimer: null,
    };
    rooms.set(roomId, room);
  } else if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }

  let color = null;
  if (!room.players.black) {
    color = 1;
  } else if (!room.players.white) {
    if (room.ai) {
      return res.status(409).json({ error: "room full (AI reserved white)" });
    }
    color = 2;
  } else {
    return res.status(409).json({ error: "room full" });
  }

  const token = `${roomId}.${color}.${crypto.randomUUID()}`;
  if (color === 1) room.players.black = { token };
  else room.players.white = { token };

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
      if (room.ai) scheduleAiMove(room);
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
        broadcast(room, {
          type: "state",
          board: room.board,
          lastMove: { r, c, color },
          current: room.current,
          gameOver: true,
          winner: color,
          winLine: room.winLine,
          ready: seatsFilled(room),
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
        ready: seatsFilled(room),
      });

      if (room.ai) {
        if (room.aiTimer) {
          clearTimeout(room.aiTimer);
          room.aiTimer = null;
        }
        scheduleAiMove(room);
      }
      return;
    }

    if (msg.type === "restart") {
      if (!ws.meta) return;
      const { roomId } = ws.meta;
      const room = rooms.get(roomId);
      if (!room) return;

      if (room.aiTimer) {
        clearTimeout(room.aiTimer);
        room.aiTimer = null;
      }

      room.board = emptyBoard();
      room.gameOver = false;
      room.winLine = null;

      if (room.ai) {
        room.current = 1;
      } else {
        room.current = room.lastWinner === 2 ? 2 : 1;
      }

      broadcast(room, {
        type: "state",
        board: room.board,
        current: room.current,
        gameOver: false,
        winLine: null,
        ready: seatsFilled(room),
      });

      if (room.ai) scheduleAiMove(room);
      return;
    }
  });

  ws.on("close", () => {
    if (!ws.meta) return;
    const { roomId, color } = ws.meta;
    const room = rooms.get(roomId);
    if (!room) return;

    room.sockets.delete(ws);

    const seatKey = color === 1 ? "black" : "white";
    if (!room.ai || seatKey === "black") {
      if (room.seatTimers?.[seatKey]) clearTimeout(room.seatTimers[seatKey]);
      room.seatTimers[seatKey] = setTimeout(() => {
        const stillHere = [...room.sockets].some(
          (s) => s.meta?.roomId === roomId && s.meta?.color === color
        );
        if (!stillHere) room.players[seatKey] = null;
        room.seatTimers[seatKey] = null;
      }, 90 * 1000);
    }

    if (room.sockets.size === 0) {
      if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
      room.cleanupTimer = setTimeout(() => {
        if (room.aiTimer) {
          clearTimeout(room.aiTimer);
          room.aiTimer = null;
        }
        rooms.delete(roomId);
      }, 10 * 60 * 1000);
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
