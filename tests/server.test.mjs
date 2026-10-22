import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import { TIME_LIMIT_MS, makeClock } from "../lib/game.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "guessnum-test-"));
let child;
let base;
let log = "";
let clientNumber = 0;

async function start() {
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: "0", DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (data) => {
    log += data.toString();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Server did not start: ${log}`)),
      10_000,
    );
    child.stdout.on("data", (data) => {
      const match = data.toString().match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        base = match[0];
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (code) {
        clearTimeout(timer);
        reject(new Error(`Server exit ${code}: ${log}`));
      }
    });
  });
}
async function stop() {
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
}
function client() {
  const ip = `127.0.0.${++clientNumber}`;
  return {
    cookie: "",
    async request(path, body, headers = {}) {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: this.cookie,
          "X-Real-IP": ip,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const cookie = response.headers.get("set-cookie");
      if (cookie) this.cookie = cookie.split(";")[0];
      return {
        status: response.status,
        data: await response.json(),
        headers: response.headers,
      };
    },
  };
}
async function connect(person) {
  const socket = new WebSocket(base.replace("http:", "ws:") + "/ws", {
    headers: { Cookie: person.cookie, Origin: base },
  });
  const messages = [];
  socket.on("message", (raw) => {
    messages.push(JSON.parse(raw));
  });
  await once(socket, "open");
  socket.messages = messages;
  return socket;
}
async function until(predicate, message) {
  const until = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > until) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
before(start);
after(async () => {
  await stop();
  rmSync(dataDir, { recursive: true, force: true });
});

test("静态页面、健康检查和内容安全策略", async () => {
  for (const path of ["/", "/styles.css", "/app.js", "/favicon.svg"]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.ok(
      response.headers
        .get("content-security-policy")
        .includes("script-src 'self'"),
    );
    assert.ok((await response.text()).length > 50);
  }
  assert.equal((await fetch(base + "/../../etc/passwd")).status, 404);
  assert.deepEqual(await (await fetch(base + "/health")).json(), { ok: true });
});

test("页面引用按内容生成的资源地址，绕过旧脚本与样式缓存", async () => {
  const response = await fetch(base + "/");
  assert.match(response.headers.get("cache-control"), /no-store/);
  const html = await response.text();
  const paths = html.match(
    /\/assets\/(?:app|styles)\.[a-f0-9]{16}\.(?:js|css)/g,
  );
  assert.equal(paths.length, 2);
  for (const path of paths) {
    const asset = await fetch(base + path);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control"), /immutable/);
    const content = await asset.text();
    const fingerprint = createHash("sha256")
      .update(content)
      .digest("hex")
      .slice(0, 16);
    assert.ok(path.includes(fingerprint));
  }
  assert.ok(html.includes('data-cfasync="false"'));
});

test("单机：服务端生成、输入验证、前导零、记录、揭晓、重新开始、刷新恢复", async () => {
  const alice = client();
  const initial = await alice.request("/api/state");
  assert.equal(initial.data.solo, null);
  assert.match(alice.cookie, /^guessnum_session=[a-f0-9]{48}$/);
  assert.match(initial.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
  const start = await alice.request("/api/solo/start", {});
  assert.equal(start.data.solo.status, "playing");
  assert.equal("answer" in start.data.solo, false);
  const db = new DatabaseSync(join(dataDir, "guessnum.sqlite"));
  const id = createHash("sha256")
    .update(alice.cookie.split("=")[1])
    .digest("hex");
  const secret = JSON.parse(
    db.prepare("SELECT data FROM sessions WHERE id = ?").get(id).data,
  ).solo.secret;
  db.close();
  for (const guess of ["123", "12345", 1234, "1e03"])
    assert.equal(
      (await alice.request("/api/solo/guess", { guess })).status,
      400,
    );
  const guess = secret === "0012" ? "0001" : "0012";
  const result = await alice.request("/api/solo/guess", { guess });
  assert.equal(result.data.solo.guesses[0].guess, guess);
  assert.equal((await alice.request("/api/solo/guess", { guess })).status, 400);
  assert.equal((await alice.request("/api/state")).data.solo.guesses.length, 1);
  const won = await alice.request("/api/solo/guess", { guess: secret });
  assert.equal(won.data.solo.status, "won");
  assert.equal(won.data.solo.answer, secret);
  assert.deepEqual(won.data.solo.guesses.at(-1), {
    guess: secret,
    digits: 4,
    positions: 4,
  });
  assert.equal(
    (await alice.request("/api/solo/guess", { guess: "1234" })).status,
    409,
  );
  await alice.request("/api/solo/start", {});
  const reveal = await alice.request("/api/solo/reveal", {});
  assert.equal(reveal.data.solo.status, "revealed");
  assert.match(reveal.data.solo.answer, /^\d{4}$/);
  assert.deepEqual(reveal.data.solo.guesses, []);
});

test("双人：邀请、保密、重复数字、回合限制、胜负、再战交换先手、离开", async () => {
  const alice = client();
  const bob = client();
  const third = client();
  await Promise.all([
    alice.request("/api/state"),
    bob.request("/api/state"),
    third.request("/api/state"),
  ]);
  const host = await alice.request("/api/rooms/create", { name: "Alice" });
  const code = host.data.room.code;
  assert.match(code, /^\d{6}$/);
  assert.equal(host.data.room.phase, "waiting");
  const aWs = await connect(alice);
  const bWs = await connect(bob);
  try {
    assert.equal(
      (await alice.request("/api/rooms/secret", { secret: "0012" })).status,
      200,
    );
    assert.equal(
      (await alice.request("/api/rooms/secret", { secret: "1234" })).status,
      409,
    );
    const joined = await bob.request("/api/rooms/join", { code, name: "Bob" });
    assert.equal(joined.data.room.opponent.name, "Alice");
    assert.equal("secret" in joined.data.room.opponent, false);
    assert.equal(
      (await third.request("/api/rooms/join", { code })).status,
      409,
    );
    assert.equal(
      (await alice.request("/api/rooms/guess", { guess: "0123" })).status,
      409,
    );
    await bob.request("/api/rooms/secret", { secret: "1122" });
    await until(
      () => aWs.messages.some((x) => x.room?.phase === "playing"),
      "Ready event did not reach Alice",
    );
    assert.equal(aWs.messages.at(-1).room.turn, "you");
    assert.equal(
      (await bob.request("/api/rooms/guess", { guess: "0001" })).status,
      409,
    );
    const aGuess = await alice.request("/api/rooms/guess", { guess: "1111" });
    assert.deepEqual(aGuess.data.room.you.guesses[0], {
      guess: "1111",
      digits: 2,
      positions: 2,
    });
    assert.equal(aGuess.data.room.turn, "opponent");
    const bGuess = await bob.request("/api/rooms/guess", { guess: "0001" });
    assert.deepEqual(bGuess.data.room.you.guesses[0], {
      guess: "0001",
      digits: 3,
      positions: 2,
    });
    await until(
      () => aWs.messages.some((x) => x.room?.opponent?.guesses.length === 1),
      "Guess event did not reach Alice",
    );
    for (const message of [...aWs.messages, ...bWs.messages]) {
      if (message.room && !["finished", "closed"].includes(message.room.phase))
        assert.equal("secret" in (message.room.opponent || {}), false);
    }
    const finished = await alice.request("/api/rooms/guess", { guess: "1122" });
    assert.equal(finished.data.room.winner, "you");
    assert.equal(finished.data.room.opponent.secret, "1122");
    assert.equal(
      (await bob.request("/api/state")).data.room.winner,
      "opponent",
    );
    assert.equal(
      (await bob.request("/api/rooms/guess", { guess: "0012" })).status,
      409,
    );
    await alice.request("/api/rooms/rematch", {});
    assert.equal(
      (await bob.request("/api/state")).data.room.you.rematch,
      false,
    );
    const rematch = await bob.request("/api/rooms/rematch", {});
    assert.equal(rematch.data.room.phase, "setup");
    assert.equal(rematch.data.room.match, 2);
    assert.deepEqual(rematch.data.room.you.guesses, []);
    assert.equal(rematch.data.room.you.secret, null);
    await alice.request("/api/rooms/secret", { secret: "0000" });
    const ready = await bob.request("/api/rooms/secret", { secret: "9999" });
    assert.equal(ready.data.room.turn, "you");
    assert.equal(
      (await alice.request("/api/rooms/guess", { guess: "9999" })).status,
      409,
    );
    await bob.request("/api/rooms/leave", {});
    const left = await alice.request("/api/state");
    assert.equal(left.data.room.phase, "closed");
    assert.equal(left.data.room.winner, "you");
    assert.equal(left.data.room.opponent.left, true);
    assert.equal(
      (await third.request("/api/rooms/join", { code })).status,
      404,
    );
    assert.equal((await alice.request("/api/rooms/leave", {})).data.room, null);
    assert.equal(
      (await alice.request("/api/rooms/create", {})).data.room.phase,
      "waiting",
    );
  } finally {
    aWs.terminate();
    bWs.terminate();
  }
});

test("同一浏览器的多个标签同步；断线重连后恢复记录", async () => {
  const alice = client();
  await alice.request("/api/solo/start", {});
  const one = await connect(alice);
  const two = await connect(alice);
  await alice.request("/api/solo/guess", { guess: "0123" });
  await until(
    () =>
      one.messages.some((x) => x.solo?.guesses.length === 1) &&
      two.messages.some((x) => x.solo?.guesses.length === 1),
    "Tabs did not synchronize",
  );
  one.terminate();
  two.terminate();
  const reconnected = await connect(alice);
  try {
    await until(
      () => reconnected.messages.some((x) => x.solo?.guesses.length === 1),
      "Reconnected tab did not recover guesses",
    );
  } finally {
    reconnected.terminate();
  }
});

test("跨站请求、无身份 WebSocket 和非 JSON 请求被拒绝", async () => {
  const alice = client();
  await alice.request("/api/state");
  assert.equal(
    (
      await alice.request(
        "/api/solo/start",
        {},
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await alice.request(
        "/api/solo/start",
        {},
        { "Content-Type": "text/plain" },
      )
    ).status,
    415,
  );
  const bad = new WebSocket(base.replace("http:", "ws:") + "/ws");
  const error = await once(bad, "error");
  assert.match(error[0].message, /403/);
});

test("服务重启后，单机记录和双人房间持久保存", async () => {
  const alice = client();
  const bob = client();
  await alice.request("/api/solo/start", {});
  await alice.request("/api/solo/guess", { guess: "0001" });
  const room = (await alice.request("/api/rooms/create", {})).data.room;
  await bob.request("/api/rooms/join", { code: room.code });
  await alice.request("/api/rooms/secret", { secret: "0012" });
  await bob.request("/api/rooms/secret", { secret: "1122" });
  await alice.request("/api/rooms/guess", { guess: "1111" });
  const beforeRestart = (await alice.request("/api/state")).data;
  await stop();
  await start();
  const restored = (await alice.request("/api/state")).data;
  assert.equal(restored.solo.guesses[0].guess, "0001");
  assert.equal(restored.room.code, room.code);
  assert.equal(restored.room.you.secret, "0012");
  assert.deepEqual(restored.room.you.guesses[0], {
    guess: "1111",
    digits: 2,
    positions: 2,
  });
  assert.equal(restored.room.turn, "opponent");
  assert.equal("secret" in restored.room.opponent, false);
  assert.deepEqual(restored.solo.clock, beforeRestart.solo.clock);
  assert.deepEqual(restored.room.you.clock, beforeRestart.room.you.clock);
  assert.deepEqual(
    restored.room.opponent.clock,
    beforeRestart.room.opponent.clock,
  );
});

function soloSecret(person) {
  const db = new DatabaseSync(join(dataDir, "guessnum.sqlite"));
  try {
    const id = createHash("sha256")
      .update(person.cookie.split("=")[1])
      .digest("hex");
    return JSON.parse(
      db.prepare("SELECT data FROM sessions WHERE id = ?").get(id).data,
    ).solo.secret;
  } finally {
    db.close();
  }
}

async function duel() {
  const alice = client();
  const bob = client();
  const created = await alice.request("/api/rooms/create", {});
  const code = created.data.room.code;
  await bob.request("/api/rooms/join", { code });
  await alice.request("/api/rooms/secret", { secret: "0012" });
  await bob.request("/api/rooms/secret", { secret: "1122" });
  return { alice, bob, code };
}

test("单机 16 次未中则失败，第 16 次猜中仍获胜，结束后禁止继续提交", async () => {
  for (const wins of [false, true]) {
    const alice = client();
    await alice.request("/api/solo/start", {});
    const secret = soloSecret(alice);
    const misses = Array.from({ length: 17 }, (_, i) =>
      String(9000 + i),
    ).filter((guess) => guess !== secret);
    for (let i = 0; i < 16; i++) {
      const guess = wins && i === 15 ? secret : misses[i];
      const response = await alice.request("/api/solo/guess", { guess });
      assert.equal(response.status, 200);
      assert.equal(response.data.solo.guesses.length, i + 1);
      assert.equal(
        response.data.solo.status,
        i < 15 ? "playing" : wins ? "won" : "lost",
      );
      assert.equal("answer" in response.data.solo, i === 15);
    }
    const restored = (await alice.request("/api/state")).data.solo;
    assert.equal(restored.status, wins ? "won" : "lost");
    assert.equal(restored.answer, secret);
    assert.equal(
      (await alice.request("/api/solo/guess", { guess: "2222" })).status,
      409,
    );
    assert.equal(
      (await alice.request("/api/state")).data.solo.guesses.length,
      16,
    );
  }
});

test("联机双方各 16 次，后手保留最后机会，均未中则流局且可以交换先手再战", async () => {
  const { alice, bob } = await duel();
  for (let i = 0; i < 16; i++) {
    const a = await alice.request("/api/rooms/guess", {
      guess: String(9000 + i),
    });
    assert.equal(a.status, 200);
    assert.equal(a.data.room.phase, "playing");
    assert.equal(a.data.room.you.guesses.length, i + 1);
    assert.equal(a.data.room.turn, "opponent");
    const b = await bob.request("/api/rooms/guess", {
      guess: String(8000 + i),
    });
    assert.equal(b.status, 200);
    assert.equal(b.data.room.phase, i === 15 ? "finished" : "playing");
  }
  for (const player of [alice, bob]) {
    const room = (await player.request("/api/state")).data.room;
    assert.equal(room.phase, "finished");
    assert.equal(room.reason, "limit");
    assert.equal(room.winner, null);
    assert.equal(room.you.guesses.length, 16);
    assert.equal(room.opponent.guesses.length, 16);
    assert.match(room.opponent.secret, /^[0-9]{4}$/);
    assert.equal(
      (await player.request("/api/rooms/guess", { guess: "3333" })).status,
      409,
    );
  }
  await alice.request("/api/rooms/rematch", {});
  const rematch = await bob.request("/api/rooms/rematch", {});
  assert.equal(rematch.data.room.phase, "setup");
  assert.equal(rematch.data.room.match, 2);
  assert.equal(rematch.data.room.reason, null);
  assert.equal(rematch.data.room.you.secret, null);
  assert.deepEqual(rematch.data.room.you.guesses, []);
  assert.deepEqual(rematch.data.room.opponent.guesses, []);
  await alice.request("/api/rooms/secret", { secret: "0012" });
  const ready = await bob.request("/api/rooms/secret", { secret: "1122" });
  assert.equal(ready.data.room.turn, "you");
});

test("联机任一方在第 16 次猜中都判胜，不误判流局", async () => {
  for (const winner of ["alice", "bob"]) {
    const { alice, bob } = await duel();
    for (let i = 0; i < 15; i++) {
      assert.equal(
        (await alice.request("/api/rooms/guess", { guess: String(9000 + i) }))
          .status,
        200,
      );
      assert.equal(
        (await bob.request("/api/rooms/guess", { guess: String(8000 + i) }))
          .status,
        200,
      );
    }
    const lastA = await alice.request("/api/rooms/guess", {
      guess: winner === "alice" ? "1122" : "9015",
    });
    const won =
      winner === "alice"
        ? lastA
        : await bob.request("/api/rooms/guess", { guess: "0012" });
    assert.equal(won.status, 200);
    assert.equal(won.data.room.phase, "finished");
    assert.equal(won.data.room.reason, "guessed");
    assert.equal(won.data.room.winner, "you");
    assert.equal(won.data.room.you.guesses.length, 16);
    assert.equal(won.data.room.you.guesses.at(-1).positions, 4);
  }
});

test("更新前已有 16 次未中记录的游戏会正常结束", async () => {
  const { alice, code } = await duel();
  await alice.request("/api/solo/start", {});
  const id = createHash("sha256")
    .update(alice.cookie.split("=")[1])
    .digest("hex");
  const db = new DatabaseSync(join(dataDir, "guessnum.sqlite"));
  const guesses = Array.from({ length: 16 }, (_, i) => ({
    guess: String(9000 + i),
    digits: 0,
    positions: 0,
  }));
  try {
    const session = JSON.parse(
      db.prepare("SELECT data FROM sessions WHERE id = ?").get(id).data,
    );
    session.solo.guesses = guesses;
    db.prepare("UPDATE sessions SET data = ? WHERE id = ?").run(
      JSON.stringify(session),
      id,
    );
    const room = JSON.parse(
      db.prepare("SELECT data FROM rooms WHERE code = ?").get(code).data,
    );
    room.players.forEach((player) => {
      player.guesses = guesses;
    });
    db.prepare("UPDATE rooms SET data = ? WHERE code = ?").run(
      JSON.stringify(room),
      code,
    );
  } finally {
    db.close();
  }
  const restored = (await alice.request("/api/state")).data;
  assert.equal(restored.solo.status, "lost");
  assert.match(restored.solo.answer, /^[0-9]{4}$/);
  assert.equal(restored.room.phase, "finished");
  assert.equal(restored.room.reason, "limit");
  assert.equal(restored.room.winner, null);
});

function sessionId(person) {
  return createHash("sha256").update(person.cookie.split("=")[1]).digest("hex");
}

function storedGame(table, key, mutate) {
  const column = table === "sessions" ? "id" : "code";
  const db = new DatabaseSync(join(dataDir, "guessnum.sqlite"));
  try {
    const value = JSON.parse(
      db.prepare(`SELECT data FROM ${table} WHERE ${column} = ?`).get(key).data,
    );
    if (mutate) {
      mutate(value);
      db.prepare(`UPDATE ${table} SET data = ? WHERE ${column} = ?`).run(
        JSON.stringify(value),
        key,
      );
    }
    return value;
  } finally {
    db.close();
  }
}

test("单机首次有效猜测才开始，重复和非法输入不重置计时，揭晓后停止", async () => {
  const alice = client();
  const initial = (await alice.request("/api/solo/start", {})).data;
  assert.equal(initial.timeLimitMs, TIME_LIMIT_MS);
  assert.equal(typeof initial.serverNow, "number");
  assert.deepEqual(initial.solo.clock, makeClock());
  storedGame("sessions", sessionId(alice), (session) => {
    session.solo.startedAt = Date.now() - 10 * TIME_LIMIT_MS;
  });
  await alice.request("/api/solo/guess", { guess: "123" });
  assert.deepEqual(
    (await alice.request("/api/state")).data.solo.clock,
    makeClock(),
  );
  const secret = soloSecret(alice);
  const misses = ["0000", "1111", "2222"].filter((guess) => guess !== secret);
  const first = (
    await alice.request("/api/solo/guess", {
      guess: misses[0],
      clock: { elapsedMs: 0, runningSince: null },
    })
  ).data.solo;
  assert.ok(first.clock.runningSince >= initial.serverNow);
  assert.equal(
    (await alice.request("/api/solo/guess", { guess: misses[0] })).status,
    400,
  );
  const second = (await alice.request("/api/solo/guess", { guess: misses[1] }))
    .data.solo;
  assert.equal(second.clock.runningSince, first.clock.runningSince);
  const revealed = (await alice.request("/api/solo/reveal", {})).data.solo;
  assert.equal(revealed.clock.runningSince, null);
  assert.ok(revealed.clock.elapsedMs >= 0);
  assert.deepEqual(
    (await alice.request("/api/state")).data.solo.clock,
    revealed.clock,
  );
  assert.deepEqual(
    (await alice.request("/api/solo/start", {})).data.solo.clock,
    makeClock(),
  );
});

test("单机无人操作时服务器也会超时判负、推送答案并拒绝迟到猜测", async () => {
  const alice = client();
  await alice.request("/api/solo/start", {});
  const secret = soloSecret(alice);
  await alice.request("/api/solo/guess", {
    guess: secret === "0000" ? "1111" : "0000",
  });
  const ws = await connect(alice);
  try {
    storedGame("sessions", sessionId(alice), (session) => {
      session.solo.clock = {
        elapsedMs: 2000,
        runningSince: Date.now() - (TIME_LIMIT_MS - 2000) + 600,
      };
    });
    await alice.request("/api/state");
    await until(
      () => ws.messages.some((message) => message.solo?.reason === "timeout"),
      "Solo timeout was not pushed",
    );
    const expired = ws.messages.find(
      (message) => message.solo?.reason === "timeout",
    ).solo;
    assert.equal(expired.status, "lost");
    assert.equal(expired.answer, secret);
    assert.deepEqual(expired.clock, {
      elapsedMs: TIME_LIMIT_MS,
      runningSince: null,
    });
    const late = await alice.request("/api/solo/guess", { guess: secret });
    assert.equal(late.status, 409);
    assert.match(late.data.error, /超时/);
    assert.equal(
      (await alice.request("/api/state")).data.solo.guesses.length,
      1,
    );
  } finally {
    ws.terminate();
  }
});

test("联机等待和准备不计时，换手只暂停本方时间，恢复回合时累计而非重置", async () => {
  const alice = client();
  const bob = client();
  const created = (await alice.request("/api/rooms/create", {})).data.room;
  assert.deepEqual(created.you.clock, makeClock());
  await alice.request("/api/rooms/secret", { secret: "0012" });
  const joined = (await bob.request("/api/rooms/join", { code: created.code }))
    .data.room;
  assert.deepEqual(joined.you.clock, makeClock());
  assert.deepEqual(joined.opponent.clock, makeClock());
  const ready = (await bob.request("/api/rooms/secret", { secret: "1122" }))
    .data.room;
  assert.deepEqual(ready.you.clock, makeClock());
  assert.equal(typeof ready.opponent.clock.runningSince, "number");
  storedGame("rooms", created.code, (room) => {
    room.players[0].clock = {
      elapsedMs: 40_000,
      runningSince: Date.now() - 1000,
    };
    room.players[1].clock = { elapsedMs: 15_000, runningSince: null };
  });
  const aGuess = (await alice.request("/api/rooms/guess", { guess: "9999" }))
    .data.room;
  assert.equal(aGuess.you.clock.runningSince, null);
  assert.ok(aGuess.you.clock.elapsedMs >= 41_000);
  assert.equal(aGuess.opponent.clock.elapsedMs, 15_000);
  assert.equal(typeof aGuess.opponent.clock.runningSince, "number");
  const waiting = (await alice.request("/api/state")).data.room;
  assert.deepEqual(waiting.you.clock, aGuess.you.clock);
  const bGuess = (await bob.request("/api/rooms/guess", { guess: "8888" })).data
    .room;
  assert.equal(bGuess.you.clock.runningSince, null);
  assert.ok(bGuess.you.clock.elapsedMs >= 15_000);
  assert.equal(bGuess.opponent.clock.elapsedMs, aGuess.you.clock.elapsedMs);
  assert.equal(typeof bGuess.opponent.clock.runningSince, "number");
  const won = (await alice.request("/api/rooms/guess", { guess: "1122" })).data
    .room;
  assert.equal(won.winner, "you");
  assert.equal(won.you.clock.runningSince, null);
  assert.equal(won.opponent.clock.runningSince, null);
  assert.deepEqual(
    (await alice.request("/api/state")).data.room.you.clock,
    won.you.clock,
  );
});

test("联机任一方累计超时会主动通知双方，保留记录并可重置计时再战", async () => {
  for (const loser of ["alice", "bob"]) {
    const { alice, bob, code } = await duel();
    if (loser === "bob")
      await alice.request("/api/rooms/guess", { guess: "9999" });
    const aWs = await connect(alice);
    const bWs = await connect(bob);
    try {
      storedGame("rooms", code, (room) => {
        const current = room.players.find((p) => p.id === room.turn);
        current.clock = {
          elapsedMs: 250_000,
          runningSince: Date.now() - 50_000 + 600,
        };
        room.players.find((p) => p !== current).clock = {
          elapsedMs: 10_000,
          runningSince: null,
        };
      });
      await alice.request("/api/state");
      await until(
        () =>
          [aWs, bWs].every((ws) =>
            ws.messages.some((message) => message.room?.reason === "timeout"),
          ),
        "Room timeout was not pushed to both players",
      );
      const expired = (await alice.request("/api/state")).data.room;
      assert.equal(expired.phase, "finished");
      assert.equal(expired.winner, loser === "alice" ? "opponent" : "you");
      assert.equal(expired.turn, null);
      assert.equal(expired.opponent.secret, "1122");
      assert.equal(expired.you.clock.runningSince, null);
      assert.equal(expired.opponent.clock.runningSince, null);
      const loserClock =
        loser === "alice" ? expired.you.clock : expired.opponent.clock;
      assert.equal(loserClock.elapsedMs, TIME_LIMIT_MS);
      const late = await (loser === "alice" ? alice : bob).request(
        "/api/rooms/guess",
        { guess: loser === "alice" ? "1122" : "0012" },
      );
      assert.equal(late.status, 409);
      assert.match(late.data.error, /超时/);
      await alice.request("/api/rooms/rematch", {});
      const rematch = (await bob.request("/api/rooms/rematch", {})).data.room;
      assert.equal(rematch.phase, "setup");
      assert.equal(rematch.match, 2);
      assert.deepEqual(rematch.you.clock, makeClock());
      assert.deepEqual(rematch.opponent.clock, makeClock());
      await alice.request("/api/rooms/secret", { secret: "0012" });
      const next = (await bob.request("/api/rooms/secret", { secret: "1122" }))
        .data.room;
      assert.equal(next.turn, "you");
      assert.equal(typeof next.you.clock.runningSince, "number");
      assert.deepEqual(next.opponent.clock, makeClock());
    } finally {
      aWs.terminate();
      bWs.terminate();
    }
  }
});

test("服务重启保留预算，离线期间到期的单机和房间也会自动结算", async () => {
  const { alice, code } = await duel();
  await alice.request("/api/solo/start", {});
  const secret = soloSecret(alice);
  await alice.request("/api/solo/guess", {
    guess: secret === "0000" ? "1111" : "0000",
  });
  await stop();
  const deadline = Date.now() + 600;
  storedGame("sessions", sessionId(alice), (session) => {
    session.solo.clock = {
      elapsedMs: 10_000,
      runningSince: deadline - TIME_LIMIT_MS + 10_000,
    };
  });
  storedGame("rooms", code, (room) => {
    room.players.find((p) => p.id === room.turn).clock = {
      elapsedMs: 30_000,
      runningSince: deadline - TIME_LIMIT_MS + 30_000,
    };
  });
  await start();
  // Read SQLite directly: no page, request or socket is needed to finish games.
  await until(
    () =>
      storedGame("sessions", sessionId(alice)).solo.reason === "timeout" &&
      storedGame("rooms", code).reason === "timeout",
    "Restart did not restore idle timeout jobs",
  );
  const restored = (await alice.request("/api/state")).data;
  assert.equal(restored.solo.status, "lost");
  assert.equal(restored.solo.answer, secret);
  assert.equal(restored.room.phase, "finished");
  assert.equal(restored.room.winner, "opponent");
});
