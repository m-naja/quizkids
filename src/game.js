'use strict';
const crypto = require('node:crypto');

/**
 * In-memory live game engine. The server owns the clock, so scores cannot be
 * inflated by a client changing its timer. State is lost on restart, which is
 * acceptable for a live session; final scores are written to the database.
 */
const games = new Map();      // gameId -> game
const pinIndex = new Map();   // pin -> gameId

function randomPin() {
  for (let i = 0; i < 50; i++) {
    const pin = String(crypto.randomInt(100000, 1000000));
    if (!pinIndex.has(pin)) return pin;
  }
  throw new Error('Could not allocate a game PIN');
}

function createGame({ quizId, quizTitle, hostId, questions, onFinish }) {
  const id = crypto.randomUUID();
  const pin = randomPin();
  const game = {
    id,
    pin,
    quizId,
    quizTitle,
    hostId,
    questions,            // [{ id, text, options, correct_index, time_limit }]
    status: 'lobby',      // lobby | question | reveal | finished
    index: -1,
    players: new Map(),   // studentId -> { id, name, score, lastGain }
    answers: new Map(),   // questionIndex -> Map(studentId -> { choice, ms, points })
    questionStartedAt: 0,
    timer: null,
    onFinish,
  };
  games.set(id, game);
  pinIndex.set(pin, id);
  return game;
}

function getGame(id) {
  return games.get(id) || null;
}

function getGameByPin(pin) {
  const id = pinIndex.get(pin);
  return id ? games.get(id) : null;
}

function join(game, student) {
  if (game.status !== 'lobby') {
    const err = new Error('This game has already started.');
    err.status = 409;
    throw err;
  }
  if (!game.players.has(student.id)) {
    game.players.set(student.id, { id: student.id, name: student.name, score: 0, lastGain: 0 });
  }
  return game.players.get(student.id);
}

function clearTimer(game) {
  if (game.timer) {
    clearTimeout(game.timer);
    game.timer = null;
  }
}

function start(game) {
  if (game.status !== 'lobby') throw httpError(409, 'Game already started.');
  if (game.players.size === 0) throw httpError(400, 'Wait for at least one player to join.');
  nextQuestion(game);
}

function nextQuestion(game) {
  clearTimer(game);
  game.index += 1;
  if (game.index >= game.questions.length) {
    finish(game);
    return;
  }
  game.status = 'question';
  game.questionStartedAt = Date.now();
  game.answers.set(game.index, new Map());
  for (const p of game.players.values()) p.lastGain = 0;

  const q = game.questions[game.index];
  // Close automatically when the time limit runs out.
  game.timer = setTimeout(() => reveal(game), q.time_limit * 1000);
}

function answer(game, studentId, choice) {
  if (game.status !== 'question') throw httpError(409, 'Not accepting answers right now.');
  if (!game.players.has(studentId)) throw httpError(403, 'Join the game first.');

  const answersForRound = game.answers.get(game.index);
  if (answersForRound.has(studentId)) throw httpError(409, 'You already answered.');

  const q = game.questions[game.index];
  if (choice >= q.options.length) throw httpError(400, 'Invalid choice.');

  const elapsedMs = Date.now() - game.questionStartedAt;
  const limitMs = q.time_limit * 1000;
  let points = 0;
  if (choice === q.correct_index && elapsedMs <= limitMs) {
    // Kahoot-style: 1000 points at the start, down to 500 at the deadline.
    const fraction = Math.min(elapsedMs / limitMs, 1);
    points = Math.round(1000 - fraction * 500);
  }

  answersForRound.set(studentId, { choice, ms: elapsedMs, points });
  const player = game.players.get(studentId);
  player.score += points;
  player.lastGain = points;

  // Everyone answered: no need to wait for the timer.
  if (answersForRound.size >= game.players.size) reveal(game);
  return { points };
}

function reveal(game) {
  if (game.status !== 'question') return;
  clearTimer(game);
  game.status = 'reveal';
}

function finish(game) {
  clearTimer(game);
  game.status = 'finished';
  if (game.onFinish) {
    try {
      game.onFinish(game);
    } catch (e) {
      console.error('Saving results failed', e.message);
    }
  }
  pinIndex.delete(game.pin);
  // Keep the finished game briefly so late clients can read the final board.
  setTimeout(() => games.delete(game.id), 10 * 60 * 1000).unref();
}

function leaderboard(game) {
  return [...game.players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

/** Build the view for one viewer. Correct answers stay hidden until reveal. */
function viewFor(game, viewer) {
  const isHost = viewer.id === game.hostId;
  const q = game.questions[game.index] || null;
  const showAnswer = game.status === 'reveal' || game.status === 'finished';

  let question = null;
  if (q && (game.status === 'question' || game.status === 'reveal')) {
    question = {
      number: game.index + 1,
      total: game.questions.length,
      text: q.text,
      options: q.options,
      timeLimit: q.time_limit,
      startedAt: game.questionStartedAt,
      correctIndex: showAnswer ? q.correct_index : null,
    };
  }

  const player = game.players.get(viewer.id);
  const roundAnswers = game.answers.get(game.index);
  const answeredCount = roundAnswers ? roundAnswers.size : 0;

  return {
    id: game.id,
    serverNow: Date.now(), // lets the client compute the countdown without trusting its own clock
    pin: isHost ? game.pin : null,
    quizTitle: game.quizTitle,
    status: game.status,
    isHost,
    playerCount: game.players.size,
    answeredCount,
    question,
    leaderboard: leaderboard(game),
    you: player
      ? { score: player.score, lastGain: player.lastGain, answered: !!(roundAnswers && roundAnswers.has(viewer.id)) }
      : null,
  };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = {
  createGame, getGame, getGameByPin, join, start, nextQuestion, answer, reveal, finish, viewFor,
  leaderboard, games,
};
