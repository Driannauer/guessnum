import test from "node:test";
import assert from "node:assert/strict";
import {
  isCode,
  scoreGuess,
  randomCode,
  publicSolo,
  publicRoom,
  makeClock,
  makeSolo,
  elapsedTime,
  stopClock,
  syncSoloClock,
  syncRoomClocks,
  TIME_LIMIT_MS,
} from "../lib/game.mjs";

test("四位数字保留前导零，允许重复，拒绝数字类型和不完整输入", () => {
  for (const value of ["0000", "0123", "9999", "0101"])
    assert.equal(isCode(value), true);
  for (const value of [
    1234,
    null,
    "",
    "123",
    "12345",
    " 1234",
    "1e03",
    "１２３４",
    "12a4",
  ])
    assert.equal(isCode(value), false);
});

test("重复数字各匹配一次；数字对的个数包含位置正确的数字", () => {
  const cases = [
    ["0012", "0001", 3, 2],
    ["0012", "1000", 3, 1],
    ["1122", "2211", 4, 0],
    ["1122", "1111", 2, 2],
    ["0000", "0000", 4, 4],
    ["0123", "1230", 4, 0],
    ["0000", "1234", 0, 0],
    ["1234", "1234", 4, 4],
  ];
  for (const [secret, guess, digits, positions] of cases) {
    assert.deepEqual(
      scoreGuess(secret, guess),
      { digits, positions },
      `${secret} / ${guess}`,
    );
  }
});

test("全部一万种猜测的重复数字判定与逐个移除的独立算法一致", () => {
  for (const secret of ["0012", "1122", "0000", "0123", "9989"]) {
    for (let i = 0; i < 10_000; i++) {
      const guess = String(i).padStart(4, "0");
      const remaining = [...secret];
      let matches = 0;
      for (const digit of guess) {
        const index = remaining.indexOf(digit);
        if (index !== -1) {
          remaining.splice(index, 1);
          matches++;
        }
      }
      const result = scoreGuess(secret, guess);
      assert.equal(result.digits, matches);
      assert.ok(result.positions <= result.digits);
      assert.deepEqual(result, scoreGuess(guess, secret));
    }
  }
});

test("随机答案总是四位字符串", () => {
  for (let i = 0; i < 100; i++) assert.equal(isCode(randomCode()), true);
});

test("公开状态不会暴露进行中答案或对手的身份令牌", () => {
  const solo = { secret: "0001", guesses: [], status: "playing", startedAt: 1 };
  assert.equal("answer" in publicSolo(solo), false);
  solo.status = "won";
  assert.equal(publicSolo(solo).answer, "0001");
  const room = {
    code: "123456",
    phase: "playing",
    match: 1,
    turn: "alice-private-id",
    players: [
      {
        id: "alice-private-id",
        name: "Alice",
        secret: "0012",
        guesses: [],
        rematch: false,
      },
      {
        id: "bob-private-id",
        name: "Bob",
        secret: "3456",
        guesses: [],
        rematch: false,
      },
    ],
  };
  const state = publicRoom(room, "alice-private-id");
  assert.equal(state.you.secret, "0012");
  assert.equal("secret" in state.opponent, false);
  assert.equal(JSON.stringify(state).includes("private-id"), false);
  assert.equal(publicRoom(room, "uninvited"), null);
  room.phase = "finished";
  assert.equal(publicRoom(room, "alice-private-id").opponent.secret, "3456");
});

test("计时只累计运行区间，暂停后冻结，继续时保留已用时间", () => {
  const clock = makeClock();
  assert.equal(elapsedTime(clock, 100_000), 0);
  clock.runningSince = 1000;
  stopClock(clock, 31_000);
  assert.deepEqual(clock, { elapsedMs: 30_000, runningSince: null });
  assert.equal(elapsedTime(clock, 200_000), 30_000);
  clock.runningSince = 200_000;
  assert.equal(elapsedTime(clock, 210_000), 40_000);
  stopClock(clock, 600_000);
  assert.equal(clock.elapsedMs, TIME_LIMIT_MS);
});

test("单机首猜前不计时，5 分钟边界判负，结束后计时冻结", () => {
  const solo = makeSolo();
  syncSoloClock(solo, solo.startedAt + TIME_LIMIT_MS * 10);
  assert.equal(solo.status, "playing");
  assert.deepEqual(solo.clock, makeClock());
  solo.clock.runningSince = 1000;
  syncSoloClock(solo, 1000 + TIME_LIMIT_MS - 1);
  assert.equal(solo.status, "playing");
  syncSoloClock(solo, 1000 + TIME_LIMIT_MS);
  assert.equal(solo.status, "lost");
  assert.equal(solo.reason, "timeout");
  assert.deepEqual(solo.clock, {
    elapsedMs: TIME_LIMIT_MS,
    runningSince: null,
  });
  assert.equal(publicSolo(solo).answer, solo.secret);
  assert.equal(syncSoloClock(solo, 1000 + TIME_LIMIT_MS * 2), false);
});

test("联机累计本方回合时间，恰好耗尽预算时判负并冻结双方计时", () => {
  const room = {
    phase: "playing",
    turn: "alice",
    players: [
      {
        id: "alice",
        guesses: [],
        clock: { elapsedMs: 20_000, runningSince: 1000 },
      },
      {
        id: "bob",
        guesses: [],
        clock: { elapsedMs: 8000, runningSince: null },
      },
    ],
  };
  const deadline = 1000 + TIME_LIMIT_MS - 20_000;
  syncRoomClocks(room, deadline - 1);
  assert.equal(room.phase, "playing");
  syncRoomClocks(room, deadline);
  assert.equal(room.phase, "finished");
  assert.equal(room.reason, "timeout");
  assert.equal(room.winner, "bob");
  assert.equal(room.turn, null);
  assert.deepEqual(
    room.players.map((p) => p.clock),
    [
      { elapsedMs: TIME_LIMIT_MS, runningSince: null },
      { elapsedMs: 8000, runningSince: null },
    ],
  );
});

test("更新前的旧游戏恢复时获得完整预算，不按创建时间追溯判负", () => {
  const solo = {
    status: "playing",
    startedAt: 1,
    guesses: [{ guess: "0000" }],
  };
  assert.equal(syncSoloClock(solo, 1_000_000), true);
  assert.equal(solo.status, "playing");
  assert.deepEqual(solo.clock, { elapsedMs: 0, runningSince: 1_000_000 });
  const room = {
    phase: "playing",
    turn: "bob",
    players: [
      { id: "alice", guesses: [] },
      { id: "bob", guesses: [] },
    ],
  };
  assert.equal(syncRoomClocks(room, 1_000_000), true);
  assert.deepEqual(
    room.players.map((p) => p.clock),
    [makeClock(), { elapsedMs: 0, runningSince: 1_000_000 }],
  );
});
