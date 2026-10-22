import { randomInt } from "node:crypto";

export const MAX_GUESSES = 16;
export const TIME_LIMIT_MS = 5 * 60_000;

export const makeClock = () => ({ elapsedMs: 0, runningSince: null });

export function elapsedTime(clock, now = Date.now()) {
  if (!clock) return 0;
  return Math.min(
    TIME_LIMIT_MS,
    clock.elapsedMs +
      (clock.runningSince === null ? 0 : Math.max(0, now - clock.runningSince)),
  );
}

export function stopClock(clock, now = Date.now()) {
  clock.elapsedMs = elapsedTime(clock, now);
  clock.runningSince = null;
}

// Give games created before clocks existed a fresh budget on first recovery.
export function syncSoloClock(solo, now = Date.now()) {
  if (!solo) return false;
  let changed = false;
  if (!solo.clock) {
    solo.clock = makeClock();
    if (solo.status === "playing" && solo.guesses.length)
      solo.clock.runningSince = now;
    changed = true;
  }
  if (solo.status === "playing") {
    if (solo.guesses.length >= MAX_GUESSES) {
      solo.status = "lost";
      solo.reason = "limit";
    } else if (elapsedTime(solo.clock, now) >= TIME_LIMIT_MS) {
      solo.status = "lost";
      solo.reason = "timeout";
    }
    if (solo.status !== "playing") {
      stopClock(solo.clock, now);
      changed = true;
    }
  }
  return changed;
}

export function syncRoomClocks(room, now = Date.now()) {
  let changed = false;
  for (const player of room.players) {
    if (!player.clock) {
      player.clock = makeClock();
      if (room.phase === "playing" && room.turn === player.id)
        player.clock.runningSince = now;
      changed = true;
    }
  }
  if (room.phase === "playing") {
    const current = room.players.find((p) => p.id === room.turn);
    if (room.players.every((p) => p.guesses.length >= MAX_GUESSES)) {
      room.phase = "finished";
      room.reason = "limit";
      room.winner = null;
    } else if (current && elapsedTime(current.clock, now) >= TIME_LIMIT_MS) {
      room.phase = "finished";
      room.reason = "timeout";
      room.winner = room.players.find((p) => p.id !== current.id)?.id || null;
    }
    if (room.phase === "finished") {
      room.turn = null;
      for (const player of room.players) stopClock(player.clock, now);
      changed = true;
    }
  }
  return changed;
}

export function isCode(value) {
  return typeof value === "string" && /^[0-9]{4}$/.test(value);
}

// Digits includes correctly positioned digits. Each occurrence is counted once.
export function scoreGuess(secret, guess) {
  if (!isCode(secret) || !isCode(guess))
    throw new TypeError("请输入完整的四位数字");
  const a = Array(10).fill(0);
  const b = Array(10).fill(0);
  let positions = 0;
  for (let i = 0; i < 4; i++) {
    a[Number(secret[i])]++;
    b[Number(guess[i])]++;
    if (secret[i] === guess[i]) positions++;
  }
  return {
    digits: a.reduce((total, count, i) => total + Math.min(count, b[i]), 0),
    positions,
  };
}

export function randomCode() {
  return String(randomInt(10_000)).padStart(4, "0");
}

export function makeSolo() {
  return {
    secret: randomCode(),
    guesses: [],
    status: "playing",
    startedAt: Date.now(),
    clock: makeClock(),
  };
}

export function publicSolo(solo) {
  if (!solo) return null;
  return {
    status: solo.status,
    guesses: solo.guesses,
    startedAt: solo.startedAt,
    reason: solo.reason || null,
    clock: solo.clock || makeClock(),
    ...(solo.status !== "playing" ? { answer: solo.secret } : {}),
  };
}

export function publicRoom(room, sessionId, online = () => false) {
  if (!room) return null;
  const me = room.players.find((p) => p.id === sessionId);
  if (!me || me.left) return null;
  const opponent = room.players.find((p) => p.id !== sessionId);
  const ended = room.phase === "finished" || room.phase === "closed";
  return {
    code: room.code,
    phase: room.phase,
    match: room.match,
    turn: room.turn ? (room.turn === sessionId ? "you" : "opponent") : null,
    winner: room.winner
      ? room.winner === sessionId
        ? "you"
        : "opponent"
      : null,
    reason: room.reason || null,
    you: {
      name: me.name,
      ready: me.secret !== null,
      secret: me.secret,
      guesses: me.guesses,
      rematch: me.rematch,
      clock: me.clock || makeClock(),
    },
    opponent: opponent
      ? {
          name: opponent.name,
          ready: opponent.secret !== null,
          online: online(opponent.id),
          left: Boolean(opponent.left),
          guesses: opponent.guesses,
          rematch: opponent.rematch,
          clock: opponent.clock || makeClock(),
          ...(ended ? { secret: opponent.secret } : {}),
        }
      : null,
  };
}
