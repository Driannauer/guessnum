import { randomInt } from "node:crypto";

export const MAX_GUESSES = 16;

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
  };
}

export function publicSolo(solo) {
  if (!solo) return null;
  return {
    status: solo.status,
    guesses: solo.guesses,
    startedAt: solo.startedAt,
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
    turn: room.turn === sessionId ? "you" : "opponent",
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
    },
    opponent: opponent
      ? {
          name: opponent.name,
          ready: opponent.secret !== null,
          online: online(opponent.id),
          left: Boolean(opponent.left),
          guesses: opponent.guesses,
          rematch: opponent.rematch,
          ...(ended ? { secret: opponent.secret } : {}),
        }
      : null,
  };
}
