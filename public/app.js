(() => {
  "use strict";

  const GRID = 19;
  const MARGIN = 24;
  const STONE_RADIUS = 12;

  const startScreen = document.getElementById("startScreen");
  const gameScreen = document.getElementById("gameScreen");
  const localBtn = document.getElementById("localBtn");
  const onlineBtn = document.getElementById("onlineBtn");
  const mpChoices = document.getElementById("mpChoices");
  const createBtn = document.getElementById("createBtn");
  const showJoinBtn = document.getElementById("showJoinBtn");
  const onlineSetup = document.getElementById("onlineSetup");
  const joinBtn = document.getElementById("join");
  const roomInput = document.getElementById("room");

  const canvas = document.getElementById("board");
  const statusEl = document.getElementById("status");
  const restartBtn = document.getElementById("restart");
  const backBtn = document.getElementById("backBtn");
  const roomBadge = document.getElementById("roomBadge");
  const ctx = canvas.getContext("2d");

  let mode = null;
  const L = {
    board: makeBoard(),
    current: 1,
    gameOver: false,
    winLine: null,
    nextFirst: 1,
  };
  const O = {
    board: makeBoard(),
    current: 1,
    gameOver: false,
    winLine: null,
    youAre: 0,
    token: null,
    ws: null,
    room: null,
  };

  function apiBase() {
    if (location.protocol === "file:") return "http://localhost:3000";
    return ""; // same-origin
  }
  function wsBase() {
    if (location.protocol === "file:") return "ws://localhost:3000";
    return (
      (location.protocol === "https:" ? "wss://" : "ws://") + location.host
    );
  }

  function setBoardInteractivity(on) {
    canvas.style.pointerEvents = on ? "auto" : "none";
    canvas.style.cursor = on ? "pointer" : "not-allowed";
  }
  let DPR = getDPR();
  function getDPR() {
    return Math.max(1, Math.floor((window.devicePixelRatio || 1) * 100) / 100);
  }
  function setupHiDPI() {
    const rect = canvas.getBoundingClientRect();
    DPR = getDPR();
    let cssW = rect.width || canvas.clientWidth || 640;
    let cssH = rect.height || 0;
    if (!cssH || cssH < 2) {
      cssH = cssW;
      canvas.style.height = cssH + "px";
    }
    canvas.width = Math.round(cssW * DPR);
    canvas.height = Math.round(cssH * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  const align = (v) => Math.round(v * DPR) / DPR;

  function makeBoard() {
    return Array.from({ length: GRID }, () => Array(GRID).fill(0));
  }
  function inRange(r, c) {
    return r >= 0 && r < GRID && c >= 0 && c < GRID;
  }
  function setStatus(msg) {
    statusEl.textContent = msg;
  }
  function metrics() {
    const W = canvas.width / DPR,
      H = canvas.height / DPR;
    const size = Math.min(W, H);
    const start = MARGIN,
      end = size - MARGIN;
    const step = (end - start) / (GRID - 1);
    return { W, H, start, end, step, size };
  }
  function cellCenter(r, c) {
    const { start, step } = metrics();
    return { x: start + c * step, y: start + r * step };
  }
  function clear() {
    const { W, H } = metrics();
    ctx.clearRect(0, 0, W, H);
  }

  function drawGrid() {
    const { start, end, step } = metrics();
    ctx.save();
    ctx.lineWidth = 1 / DPR;
    ctx.strokeStyle = "#333333A0";
    for (let i = 0; i < GRID; i++) {
      const x = align(start + i * step);
      ctx.beginPath();
      ctx.moveTo(x, align(start));
      ctx.lineTo(x, align(end));
      ctx.stroke();
    }
    for (let i = 0; i < GRID; i++) {
      const y = align(start + i * step);
      ctx.beginPath();
      ctx.moveTo(align(start), y);
      ctx.lineTo(align(end), y);
      ctx.stroke();
    }
    const starIdx = [3, 9, 15];
    ctx.fillStyle = "#222";
    for (const r of starIdx)
      for (const c of starIdx) {
        const { x, y } = cellCenter(r, c);
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    ctx.restore();
  }

  function drawStones(board) {
    ctx.save();
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const v = board[r][c];
        if (!v) continue;
        const { x, y } = cellCenter(r, c);
        ctx.beginPath();
        ctx.arc(x, y, STONE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = v === 1 ? "#111" : "#f5f5f5";
        ctx.fill();
        ctx.lineWidth = 1 / DPR;
        ctx.strokeStyle = "#00000022";
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function highlightWinLine(line) {
    if (!line) return;
    ctx.save();
    ctx.lineWidth = Math.max(2, 3 / DPR);
    ctx.strokeStyle = "#c89d00";
    for (const { r, c } of line) {
      const { x, y } = cellCenter(r, c);
      ctx.beginPath();
      ctx.arc(x, y, STONE_RADIUS - 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (line.length >= 2) {
      const a = cellCenter(line[0].r, line[0].c);
      const b = cellCenter(line[line.length - 1].r, line[line.length - 1].c);
      ctx.lineWidth = Math.max(4, 6 / DPR);
      ctx.strokeStyle = "#c89d00AA";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawDimOverlay() {
    const { W, H } = metrics();
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }

  function showWinOverlay(text) {
    const { W, H } = metrics();
    drawDimOverlay();
    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font =
      "bold 40px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.fillText(text, W / 2, H / 2);
    ctx.font =
      "16px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
    ctx.fillText("Press Restart to play again", W / 2, H / 2 + 40);
    ctx.restore();
  }

  function drawAll() {
    clear();
    drawGrid();
    if (mode === "local") {
      drawStones(L.board);
      highlightWinLine(L.winLine);
      if (L.gameOver && L.winLine) drawDimOverlay();
    } else if (mode === "online") {
      drawStones(O.board);
      highlightWinLine(O.winLine);
      if (O.gameOver && O.winLine) drawDimOverlay();
    }
  }

  function localReset(first) {
    L.board = makeBoard();
    L.current = first;
    L.gameOver = false;
    L.winLine = null;
    setStatus(`${L.current === 1 ? "Black's Turn" : "White's Turn"}`);
    drawAll();
  }

  function localComputeWin(bd, r, c) {
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

  function onLocalClick(evt) {
    if (L.gameOver) return;
    const rect = canvas.getBoundingClientRect();
    const x = (evt.clientX - rect.left) * (canvas.width / rect.width);
    const y = (evt.clientY - rect.top) * (canvas.height / rect.height);
    const { start, step } = metrics();
    const col = Math.round((x / DPR - start) / step);
    const row = Math.round((y / DPR - start) / step);
    if (!inRange(row, col)) return;
    if (L.board[row][col] !== 0) {
      setStatus("Local • This spot is already taken");
      return;
    }

    L.board[row][col] = L.current;

    const res = localComputeWin(L.board, row, col);
    if (res.win) {
      L.gameOver = true;
      L.winLine = res.line;
      drawAll();
      const winText = L.current === 1 ? "Black Wins!" : "White Wins!";
      setStatus(`Local • ${winText}`);
      showWinOverlay(winText);
      L.nextFirst = L.current === 2 ? 2 : 1;
      restartBtn.disabled = false;
      return;
    }

    L.current = L.current === 1 ? 2 : 1;
    setStatus(`${L.current === 1 ? "Black's Turn" : "White's Turn"}`);
    drawAll();
  }
  async function requestToken(roomId) {
    const res = await fetch(
      `${apiBase()}/token?room=${encodeURIComponent(roomId)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Token request failed");
    return data; // { room, token, color }
  }

  async function createRoomOnServer() {
    try {
      const resp = await fetch(`${apiBase()}/rooms`, { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "create room failed");
      return data.room;
    } catch {
      return genRoomId();
    }
  }

  function connectWS() {
    if (O.ws)
      try {
        O.ws.close();
      } catch {}
    const url = wsBase();
    O.ws = new WebSocket(url);

    O.ws.addEventListener("open", () => {
      O.ws.send(JSON.stringify({ type: "hello", token: O.token }));
      setStatus(`You are ${O.youAre === 1 ? "Black" : "White"}`);
      restartBtn.disabled = false;
      setBoardInteractivity(false);
    });

    O.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);

      if (msg.type === "error") {
        setStatus(`Server error: ${msg.message}`);
        return;
      }
      if (msg.type === "info") {
        setStatus(`${msg.message}`);
      }
      if (msg.type === "state") {
        O.board = msg.board || O.board;
        O.current = msg.current ?? O.current;
        O.gameOver = !!msg.gameOver;
        O.winLine = msg.winLine || null;

        const ready = !!msg.ready;
        const yourTurn = ready && !O.gameOver && O.youAre === O.current;
        setBoardInteractivity(yourTurn);

        if (!ready) {
          setStatus("Waiting for opponent…");
          drawAll();
          return;
        }

        if (O.gameOver && msg.winner) {
          drawAll();
          const winText = msg.winner === 1 ? "Black Wins!" : "White Wins!";
          setStatus(`${winText}`);
          showWinOverlay(winText);
        } else {
          const turnTxt = O.current === 1 ? "Black's Turn" : "White's Turn";
          const youTxt = O.youAre === 1 ? "You are Black" : "You are White";
          setStatus(`${turnTxt} • ${youTxt}`);
          drawAll();
        }
      }
    });

    O.ws.addEventListener("close", () => {
      setStatus("Disconnected");
      setBoardInteractivity(false);
    });
  }

  function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }
  function genRoomId(len = 6) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let s = "";
    for (let i = 0; i < len; i++)
      s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  localBtn.addEventListener("click", async () => {
    mode = "local";
    mpChoices.style.display = "none";
    onlineSetup.style.display = "none";
    if (roomBadge) roomBadge.style.display = "none";

    startScreen.style.display = "none";
    gameScreen.style.display = "block";
    await nextFrame();
    setupHiDPI();
    drawAll();
    restartBtn.disabled = false;
    setStatus("Black's Turn");
    localReset(1);
    setBoardInteractivity(true);
  });

  onlineBtn.addEventListener("click", () => {
    mpChoices.style.display = "flex";
    onlineSetup.style.display = "none";
  });

  showJoinBtn.addEventListener("click", () => {
    mpChoices.style.display = "none";
    onlineSetup.style.display = "flex";
    roomInput.focus();
  });

  createBtn.addEventListener("click", async () => {
    mpChoices.style.display = "none";
    try {
      setStatus("Creating room...");
      const code = await createRoomOnServer();
      const data = await requestToken(code);
      O.token = data.token;
      O.youAre = data.color;
      O.room = code;
      sessionStorage.setItem(
        "gomoku_session",
        JSON.stringify({ room: O.room, token: O.token, color: O.youAre })
      );

      mode = "online";
      startScreen.style.display = "none";
      gameScreen.style.display = "block";
      await nextFrame();
      setupHiDPI();
      drawAll();
      setBoardInteractivity(false);
      setStatus("Waiting for opponent…");

      if (roomBadge) {
        roomBadge.style.display = "inline-block";
        roomBadge.textContent = `Room: ${code}`;
      }

      connectWS();
    } catch (e) {
      setStatus(`${e.message}`);
    }
  });

  joinBtn.addEventListener("click", async () => {
    const room = (roomInput.value || "").trim();
    if (!room) {
      setStatus("Please enter a room ID");
      return;
    }
    try {
      setStatus("Requesting token...");
      const data = await requestToken(room);
      O.token = data.token;
      O.youAre = data.color;
      O.room = room;
      sessionStorage.setItem(
        "gomoku_session",
        JSON.stringify({ room: O.room, token: O.token, color: O.youAre })
      );

      mode = "online";
      startScreen.style.display = "none";
      gameScreen.style.display = "block";
      await nextFrame();
      setupHiDPI();
      drawAll();
      setBoardInteractivity(false);
      setStatus("Waiting for opponent…");

      if (roomBadge) {
        roomBadge.style.display = "inline-block";
        roomBadge.textContent = `Room: ${room}`;
      }

      connectWS();
    } catch (e) {
      setStatus(`${e.message}`);
    }
  });

  backBtn.addEventListener("click", () => {
    gameScreen.style.display = "none";
    startScreen.style.display = "flex";

    mode = null;
    setStatus("Waiting to start...");
    restartBtn.disabled = true;

    mpChoices.style.display = "none";
    onlineSetup.style.display = "none";
    roomInput.value = "";
    if (roomBadge) roomBadge.style.display = "none";

    L.board = makeBoard();
    O.board = makeBoard();
    L.gameOver = O.gameOver = false;
    L.winLine = O.winLine = null;
    drawAll();

    if (O.ws && O.ws.readyState === WebSocket.OPEN) {
      O.ws.close();
    }
    O.ws = null;
    O.room = null;
    sessionStorage.removeItem("gomoku_session");

    setBoardInteractivity(false);
  });

  restartBtn.addEventListener("click", () => {
    if (mode === "local") {
      localReset(L.nextFirst);
      setBoardInteractivity(true);
    } else if (mode === "online") {
      if (O.ws && O.ws.readyState === WebSocket.OPEN) {
        O.ws.send(JSON.stringify({ type: "restart" }));
      }
      setBoardInteractivity(false);
      setStatus("Waiting for opponent…");
    }
  });

  canvas.addEventListener("click", (evt) => {
    if (mode === "local") return onLocalClick(evt);
    if (mode === "online") return onOnlineClick(evt);
    setStatus("Select a mode on the start screen");
  });

  function onOnlineClick(evt) {
    if (!O.ws || O.ws.readyState !== WebSocket.OPEN) {
      setStatus("Join a room first");
      return;
    }
    if (O.gameOver) return;

    const rect = canvas.getBoundingClientRect();
    const x = (evt.clientX - rect.left) * (canvas.width / rect.width);
    const y = (evt.clientY - rect.top) * (canvas.height / rect.height);
    const { start, step } = metrics();
    const col = Math.round((x / DPR - start) / step);
    const row = Math.round((y / DPR - start) / step);

    if (!inRange(row, col)) return;
    if (O.board[row][col] !== 0) {
      setStatus("This spot is already taken");
      return;
    }
    if (canvas.style.pointerEvents === "none") {
      setStatus("Not your turn");
      return;
    }

    setBoardInteractivity(false);
    O.ws.send(JSON.stringify({ type: "move", r: row, c: col }));
  }

  let resizeTimer = 0;
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        setupHiDPI();
        drawAll();
      }, 16);
    });
    ro.observe(canvas);
  } else {
    window.addEventListener("resize", () => {
      setupHiDPI();
      drawAll();
    });
  }

  (function tryResume() {
    const raw = sessionStorage.getItem("gomoku_session");
    if (!raw) return;
    try {
      const saved = JSON.parse(raw);
      if (!saved?.room || !saved?.token || !saved?.color) return;

      mode = "online";
      O.room = saved.room;
      O.token = saved.token;
      O.youAre = saved.color;

      startScreen.style.display = "none";
      gameScreen.style.display = "block";
      setupHiDPI();
      drawAll();
      setBoardInteractivity(false);
      setStatus("Reconnecting…");

      if (roomBadge) {
        roomBadge.style.display = "inline-block";
        roomBadge.textContent = `Room: ${O.room}`;
      }

      connectWS();
    } catch {}
  })();
})();
