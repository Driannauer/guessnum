import http from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer, WebSocket } from "ws";
import {
  isCode,
  scoreGuess,
  makeSolo,
  publicSolo,
  publicRoom,
  MAX_GUESSES,
} from "./lib/game.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(root, "data");
const frameAncestors = process.env.FRAME_ANCESTORS || "'self'";
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, "guessnum.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at);
  CREATE INDEX IF NOT EXISTS rooms_updated ON rooms(updated_at);
`);
const q = {
  session: db.prepare("SELECT data FROM sessions WHERE id = ?"),
  saveSession: db.prepare(
    "INSERT INTO sessions VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  ),
  room: db.prepare("SELECT data FROM rooms WHERE code = ?"),
  saveRoom: db.prepare(
    "INSERT INTO rooms VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
  ),
  expireSessions: db.prepare("DELETE FROM sessions WHERE updated_at < ?"),
  expireRooms: db.prepare("DELETE FROM rooms WHERE updated_at < ?"),
};

const clients = new Map();
const rateLimits = new Map();
const DAY = 86_400_000;
let version = Date.now() * 1000;
const getSession = (id) => {
  const row = q.session.get(id);
  if (!row) return null;
  const session = JSON.parse(row.data);
  if (
    session.solo?.status === "playing" &&
    session.solo.guesses.length >= MAX_GUESSES
  ) {
    session.solo.status = "lost";
    q.saveSession.run(id, JSON.stringify(session), Date.now());
  }
  return session;
};
const getRoom = (code) => {
  const row = code && q.room.get(code);
  if (!row) return null;
  const room = JSON.parse(row.data);
  // Existing rooms from before the attempt limit also finish consistently.
  if (
    room.phase === "playing" &&
    room.players.every((p) => p.guesses.length >= MAX_GUESSES)
  ) {
    room.phase = "finished";
    room.reason = "limit";
    room.winner = null;
    room.turn = null;
    q.saveRoom.run(code, JSON.stringify(room), Date.now());
  }
  return room;
};
const saveSession = (s) =>
  q.saveSession.run(s.id, JSON.stringify(s), Date.now());
const saveRoom = (r) => q.saveRoom.run(r.code, JSON.stringify(r), Date.now());
const online = (id) => Boolean(clients.get(id)?.size);

function identity(req) {
  const token = req.headers.cookie
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("guessnum_session="))
    ?.slice(17);
  if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
  return createHash("sha256").update(token).digest("hex");
}

function sessionFor(req, res) {
  const existing = identity(req);
  let session = existing && getSession(existing);
  if (!session) {
    const token = randomBytes(24).toString("hex");
    const id = createHash("sha256").update(token).digest("hex");
    session = { id, solo: null, room: null };
    const secure = req.headers["x-forwarded-proto"] === "https";
    res.setHeader(
      "Set-Cookie",
      `guessnum_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`,
    );
  }
  saveSession(session);
  return session;
}

function stateFor(session) {
  return {
    version: ++version,
    solo: publicSolo(session.solo),
    room: publicRoom(getRoom(session.room), session.id, online),
  };
}

function pushSession(id) {
  const session = getSession(id);
  if (!session) return;
  const payload = JSON.stringify({ type: "state", ...stateFor(session) });
  for (const socket of clients.get(id) || []) {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }
}

function pushRoom(room) {
  for (const player of room.players) pushSession(player.id);
}

class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
function requireCode(value) {
  if (!isCode(value))
    throw new GameError("请输入完整的四位数字，可以以 0 开头，也可以重复。");
}
function activeRoom(session) {
  const room = getRoom(session.room);
  if (!room || !room.players.some((p) => p.id === session.id && !p.left)) {
    throw new GameError("房间已过期，请重新创建或加入。", 409);
  }
  return room;
}
function nameFor(value, fallback) {
  return typeof value === "string"
    ? value.trim().slice(0, 12) || fallback
    : fallback;
}
function checkRate(key, limit, window = 60_000) {
  const now = Date.now();
  let entry = rateLimits.get(key);
  if (!entry || entry.until <= now) {
    entry = { count: 0, until: now + window };
    rateLimits.set(key, entry);
  }
  if (++entry.count > limit)
    throw new GameError("操作有点快，稍等片刻再试。", 429);
}

// All game mutations are synchronous after the request body is read. SQLite
// commits them before either the HTTP reply or the per-player WebSocket update.
function action(path, session, body) {
  let room;
  switch (path) {
    case "/api/solo/start":
      session.solo = makeSolo();
      break;
    case "/api/solo/guess": {
      requireCode(body.guess);
      const solo = session.solo;
      if (!solo || solo.status !== "playing")
        throw new GameError("请先开始新的一局。", 409);
      if (solo.guesses.length >= MAX_GUESSES)
        throw new GameError("已用完 16 次机会，请开始新的一局。", 409);
      if (solo.guesses.some((g) => g.guess === body.guess))
        throw new GameError("这个数字已经猜过了");
      const result = scoreGuess(solo.secret, body.guess);
      solo.guesses.push({ guess: body.guess, ...result });
      if (result.positions === 4) solo.status = "won";
      else if (solo.guesses.length >= MAX_GUESSES) solo.status = "lost";
      break;
    }
    case "/api/solo/reveal":
      if (!session.solo || session.solo.status !== "playing")
        throw new GameError("当前没有进行中的单机游戏。", 409);
      session.solo.status = "revealed";
      break;
    case "/api/rooms/create": {
      if (publicRoom(getRoom(session.room), session.id))
        throw new GameError("你已经在房间里，请先退出当前房间。", 409);
      checkRate(`create:${session.id}`, 12);
      let code;
      do {
        code = String(randomInt(100_000, 1_000_000));
      } while (getRoom(code));
      room = {
        code,
        phase: "waiting",
        match: 1,
        turn: null,
        winner: null,
        players: [
          {
            id: session.id,
            name: nameFor(body.name, "玩家一"),
            secret: null,
            guesses: [],
            rematch: false,
          },
        ],
        first: session.id,
      };
      session.room = code;
      break;
    }
    case "/api/rooms/join": {
      checkRate(`join:${session.id}`, 30);
      if (typeof body.code !== "string" || !/^[0-9]{6}$/.test(body.code))
        throw new GameError("请输入六位房间码。");
      if (
        session.room === body.code &&
        publicRoom(getRoom(body.code), session.id)
      )
        break;
      if (publicRoom(getRoom(session.room), session.id))
        throw new GameError("请先退出当前房间，再加入新的房间。", 409);
      room = getRoom(body.code);
      if (!room || room.phase === "closed")
        throw new GameError("房间不存在或已关闭，请检查房间码。", 404);
      if (room.players.length >= 2)
        throw new GameError("这个房间已经有两位玩家了。", 409);
      room.players.push({
        id: session.id,
        name: nameFor(body.name, "玩家二"),
        secret: null,
        guesses: [],
        rematch: false,
      });
      room.phase = "setup";
      session.room = room.code;
      break;
    }
    case "/api/rooms/secret": {
      requireCode(body.secret);
      room = activeRoom(session);
      if (!["waiting", "setup"].includes(room.phase))
        throw new GameError("本局已经开始，不能更改秘密数字。", 409);
      const me = room.players.find((p) => p.id === session.id);
      if (me.secret !== null)
        throw new GameError("秘密数字已锁定，等待双方准备完成。", 409);
      me.secret = body.secret;
      if (
        room.players.length === 2 &&
        room.players.every((p) => p.secret !== null)
      ) {
        room.phase = "playing";
        room.turn = room.first;
      }
      break;
    }
    case "/api/rooms/guess": {
      requireCode(body.guess);
      room = activeRoom(session);
      if (room.phase !== "playing")
        throw new GameError("请等待双方都设置好秘密数字。", 409);
      if (room.turn !== session.id)
        throw new GameError("现在是对手的回合，请稍候。", 409);
      const me = room.players.find((p) => p.id === session.id);
      const opponent = room.players.find((p) => p.id !== session.id);
      if (me.guesses.length >= MAX_GUESSES)
        throw new GameError("你已用完 16 次机会，请等待对手完成。", 409);
      if (me.guesses.some((g) => g.guess === body.guess))
        throw new GameError("这个数字已经猜过了");
      const result = scoreGuess(opponent.secret, body.guess);
      me.guesses.push({ guess: body.guess, ...result });
      if (result.positions === 4) {
        room.phase = "finished";
        room.winner = session.id;
        room.reason = "guessed";
      } else if (room.players.every((p) => p.guesses.length >= MAX_GUESSES)) {
        room.phase = "finished";
        room.winner = null;
        room.reason = "limit";
        room.turn = null;
      } else {
        room.turn = opponent.id;
      }
      break;
    }
    case "/api/rooms/rematch": {
      room = activeRoom(session);
      if (room.phase !== "finished" || room.players.some((p) => p.left))
        throw new GameError("当前不能再来一局，请重新创建房间。", 409);
      room.players.find((p) => p.id === session.id).rematch = true;
      if (room.players.every((p) => p.rematch)) {
        room.first = room.players.find((p) => p.id !== room.first).id;
        room.phase = "setup";
        room.turn = null;
        room.winner = null;
        room.reason = null;
        room.match++;
        for (const p of room.players) {
          p.secret = null;
          p.guesses = [];
          p.rematch = false;
        }
      }
      break;
    }
    case "/api/rooms/leave": {
      room = getRoom(session.room);
      if (room && room.players.some((p) => p.id === session.id && !p.left)) {
        room.players.find((p) => p.id === session.id).left = true;
        if (room.phase !== "finished" && room.phase !== "closed") {
          room.reason = "left";
          room.winner =
            room.phase === "playing"
              ? room.players.find((p) => p.id !== session.id)?.id
              : null;
        }
        room.phase = "closed";
      }
      session.room = null;
      break;
    }
    default:
      throw new GameError("接口不存在。", 404);
  }
  saveSession(session);
  if (room) {
    saveRoom(room);
    pushRoom(room);
  } else pushSession(session.id);
  return stateFor(session);
}

const assets = new Map(
  [
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ].map(([url, [file, type]]) => [
    url,
    {
      data: readFileSync(join(root, "public", file)),
      type,
      cache: "no-store, no-transform",
    },
  ]),
);
// File names change with their contents, so an old CDN/browser entry cannot
// pair an earlier script with a newer page. Keep the old URLs as aliases only.
let index = assets.get("/").data.toString("utf8");
for (const [path, stem, extension] of [
  ["/app.js", "app", "js"],
  ["/styles.css", "styles", "css"],
]) {
  const asset = assets.get(path);
  const hash = createHash("sha256")
    .update(asset.data)
    .digest("hex")
    .slice(0, 16);
  const versioned = `/assets/${stem}.${hash}.${extension}`;
  assets.set(versioned, {
    ...asset,
    cache: "public, max-age=31536000, immutable",
  });
  index = index.replace(path, versioned);
}
assets.get("/").data = Buffer.from(index);

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors ${frameAncestors}; form-action 'self'`,
  );
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health" && req.method === "GET") {
      db.prepare("SELECT 1").get();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end('{"ok":true}');
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      if (!["GET", "POST"].includes(req.method))
        throw new GameError("不支持的请求方法。", 405);
      // Host is supplied by Nginx; cookies are never accepted across origins.
      if (
        req.headers.origin &&
        req.headers.origin !==
          `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`
      ) {
        throw new GameError("请在本站页面内操作。", 403);
      }
      const ip = req.headers["x-real-ip"] || req.socket.remoteAddress;
      checkRate(`ip:${ip}`, 240);
      const session = sessionFor(req, res);
      if (req.method === "GET") {
        if (url.pathname !== "/api/state")
          throw new GameError("接口不存在。", 404);
        res.end(JSON.stringify(stateFor(session)));
        return;
      }
      if (!req.headers["content-type"]?.startsWith("application/json"))
        throw new GameError("请求必须使用 JSON。", 415);
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2048) throw new GameError("请求内容过长。", 413);
        chunks.push(chunk);
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        throw new GameError("请求格式不正确。");
      }
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new GameError("请求格式不正确。");
      // Reload after awaiting the body so simultaneous tabs cannot overwrite a
      // newer game state with an old session snapshot.
      const fresh = getSession(session.id);
      res.end(JSON.stringify(action(url.pathname, fresh, body)));
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset || !["GET", "HEAD"].includes(req.method)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("页面不存在");
      return;
    }
    res.writeHead(200, {
      "Content-Type": asset.type,
      "Content-Length": asset.data.length,
      "Cache-Control": asset.cache,
      "Cloudflare-CDN-Cache-Control": asset.cache,
    });
    res.end(req.method === "HEAD" ? undefined : asset.data);
  } catch (error) {
    const status = error instanceof GameError ? error.status : 500;
    if (status === 500) console.error(error);
    if (!res.headersSent)
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
    res.end(
      JSON.stringify({
        error: status === 500 ? "服务器暂时忙碌，请稍后再试。" : error.message,
      }),
    );
  }
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024,
  perMessageDeflate: false,
});
server.on("upgrade", (req, socket, head) => {
  const id = identity(req);
  const origin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
  if (
    req.url !== "/ws" ||
    !id ||
    !getSession(id) ||
    (req.headers.origin && req.headers.origin !== origin) ||
    (clients.get(id)?.size || 0) >= 8
  ) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  try {
    checkRate(`ws:${req.headers["x-real-ip"] || req.socket.remoteAddress}`, 90);
  } catch {
    socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.sessionId = id;
    wss.emit("connection", ws);
  });
});
wss.on("connection", (ws) => {
  const id = ws.sessionId;
  if (!clients.has(id)) clients.set(id, new Set());
  clients.get(id).add(ws);
  ws.alive = true;
  ws.on("pong", () => {
    ws.alive = true;
  });
  ws.on("error", () => {});
  const session = getSession(id);
  const room = getRoom(session?.room);
  if (room) pushRoom(room);
  else pushSession(id);
  ws.on("close", () => {
    clients.get(id)?.delete(ws);
    if (!clients.get(id)?.size) clients.delete(id);
    const current = getSession(id);
    const currentRoom = getRoom(current?.room);
    if (currentRoom) pushRoom(currentRoom);
  });
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25_000);
const cleanup = () => {
  q.expireSessions.run(Date.now() - 30 * DAY);
  q.expireRooms.run(Date.now() - DAY);
  for (const [key, value] of rateLimits)
    if (value.until < Date.now()) rateLimits.delete(key);
};
cleanup();
const maintenance = setInterval(cleanup, 15 * 60_000);

const port = Number(process.env.PORT || 4186);
server.listen(port, "127.0.0.1", () =>
  console.log(
    `数字炸弹 listening on http://127.0.0.1:${server.address().port}`,
  ),
);
function shutdown() {
  clearInterval(heartbeat);
  clearInterval(maintenance);
  for (const ws of wss.clients) ws.close(1012, "Server restarting");
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
