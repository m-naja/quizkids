'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');

const db = require('./src/db');
const S = require('./src/schemas');
const game = require('./src/game');
const { generateQuestions } = require('./src/gemini');

const app = express();
const IS_PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;

if (IS_PROD && !process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(session({
  name: 'qk.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // NOTE: default in-memory store. Use a persistent store (e.g. a SQLite session store)
  // before running for more than one process or across restarts.
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PROD,
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

// CSRF defence: state-changing calls must carry a custom header. Browsers will not
// attach it cross-site without a CORS preflight, which we never allow.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'QuizKids') {
    return res.status(403).json({ error: 'Request blocked.' });
  }
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_ATTEMPTS_PER_15_MIN) || 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait 15 minutes.' },
});
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Slow down a little, then try again.' },
});

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny', index: 'index.html' }));

// ---------- helpers ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const e = new Error(r.error.issues[0].message);
    e.status = 400;
    throw e;
  }
  return r.data;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.session.role !== role) return res.status(403).json({ error: 'Not allowed.' });
    next();
  };
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, displayName: u.display_name };
}

function randomPassword() {
  // Unambiguous characters so kids can read and type it.
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
};

// ---------- auth ----------
app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
  const { username, password } = parse(S.login, req.body);
  const user = q.userByName.get(username);
  // Always run a bcrypt compare so response timing does not reveal valid usernames.
  const hash = user ? user.password_hash : '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(password, hash);
  if (!user || !ok) return res.status(401).json({ error: 'Wrong username or password.' });

  await new Promise((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve()))
  ); // new session id after login blocks session fixation
  req.session.userId = user.id;
  req.session.role = user.role;
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('qk.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = q.userById.get(req.session.userId);
  res.json({ user: user ? publicUser(user) : null });
});

// ---------- teacher: students ----------
const teacherOnly = [requireAuth, requireRole('teacher')];

app.get('/api/students', teacherOnly, (req, res) => {
  const rows = db.prepare(
    'SELECT id, username, display_name, created_at FROM users WHERE role = ? AND teacher_id = ? ORDER BY display_name'
  ).all('student', req.session.userId);
  res.json({ students: rows.map((r) => ({ id: r.id, username: r.username, displayName: r.display_name, createdAt: r.created_at })) });
});

app.post('/api/students', teacherOnly, wrap(async (req, res) => {
  const data = parse(S.createStudent, req.body);
  const password = data.password || randomPassword();
  const hash = await bcrypt.hash(password, 12);
  try {
    const info = db.prepare(
      'INSERT INTO users (username, password_hash, role, display_name, teacher_id) VALUES (?,?,?,?,?)'
    ).run(data.username, hash, 'student', data.displayName, req.session.userId);
    // The generated password is shown ONCE here and never stored in plain text.
    res.status(201).json({
      student: { id: Number(info.lastInsertRowid), username: data.username, displayName: data.displayName },
      temporaryPassword: data.password ? undefined : password,
    });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That username is taken.' });
    throw e;
  }
}));

app.delete('/api/students/:id', teacherOnly, (req, res) => {
  const r = db.prepare('DELETE FROM users WHERE id = ? AND role = ? AND teacher_id = ?')
    .run(Number(req.params.id), 'student', req.session.userId);
  if (r.changes === 0) return res.status(404).json({ error: 'Student not found.' });
  res.json({ ok: true });
});

// ---------- teacher: lessons ----------
app.get('/api/lessons', teacherOnly, (req, res) => {
  const rows = db.prepare('SELECT id, title, created_at FROM lessons WHERE teacher_id = ? ORDER BY id DESC')
    .all(req.session.userId);
  res.json({ lessons: rows });
});

app.post('/api/lessons', teacherOnly, (req, res) => {
  const data = parse(S.lesson, req.body);
  const info = db.prepare('INSERT INTO lessons (teacher_id, title, content) VALUES (?,?,?)')
    .run(req.session.userId, data.title, data.content);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.delete('/api/lessons/:id', teacherOnly, (req, res) => {
  const r = db.prepare('DELETE FROM lessons WHERE id = ? AND teacher_id = ?').run(Number(req.params.id), req.session.userId);
  if (r.changes === 0) return res.status(404).json({ error: 'Lesson not found.' });
  res.json({ ok: true });
});

// Gemini generates pending questions from one of the teacher's lessons.
app.post('/api/lessons/:id/generate', teacherOnly, aiLimiter, wrap(async (req, res) => {
  const { count, gradeLevel } = parse(S.generate, req.body || {});
  const lesson = db.prepare('SELECT * FROM lessons WHERE id = ? AND teacher_id = ?')
    .get(Number(req.params.id), req.session.userId);
  if (!lesson) return res.status(404).json({ error: 'Lesson not found.' });

  const items = await generateQuestions({
    lessonTitle: lesson.title, lessonContent: lesson.content, count, gradeLevel,
  });

  const insert = db.prepare(
    `INSERT INTO questions (teacher_id, lesson_id, text, options, correct_index, time_limit, status, source)
     VALUES (?,?,?,?,?,?, 'pending', 'gemini')`
  );
  const created = db.transaction((list) =>
    list.map((it) => Number(insert.run(req.session.userId, lesson.id, it.text, JSON.stringify(it.options),
      it.correct_index, it.time_limit).lastInsertRowid))
  )(items);

  res.status(201).json({ created: created.length, ids: created });
}));

// ---------- teacher: questions ----------
function serializeQuestion(r) {
  return {
    id: r.id,
    lessonId: r.lesson_id,
    text: r.text,
    options: JSON.parse(r.options),
    correctIndex: r.correct_index,
    timeLimit: r.time_limit,
    status: r.status,
    source: r.source,
  };
}

app.get('/api/questions', teacherOnly, (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : null;
  const rows = status
    ? db.prepare('SELECT * FROM questions WHERE teacher_id = ? AND status = ? ORDER BY id DESC').all(req.session.userId, status)
    : db.prepare('SELECT * FROM questions WHERE teacher_id = ? ORDER BY id DESC').all(req.session.userId);
  res.json({ questions: rows.map(serializeQuestion) });
});

app.post('/api/questions', teacherOnly, (req, res) => {
  const data = parse(S.manualQuestion, req.body);
  if (data.lesson_id) {
    const owns = db.prepare('SELECT 1 FROM lessons WHERE id = ? AND teacher_id = ?').get(data.lesson_id, req.session.userId);
    if (!owns) return res.status(404).json({ error: 'Lesson not found.' });
  }
  const info = db.prepare(
    `INSERT INTO questions (teacher_id, lesson_id, text, options, correct_index, time_limit, status, source)
     VALUES (?,?,?,?,?,?, 'approved', 'manual')`
  ).run(req.session.userId, data.lesson_id || null, data.text, JSON.stringify(data.options),
    data.correct_index, data.time_limit);
  res.status(201).json({ id: Number(info.lastInsertRowid) });
});

app.patch('/api/questions/:id', teacherOnly, (req, res) => {
  const id = Number(req.params.id);
  const current = db.prepare('SELECT * FROM questions WHERE id = ? AND teacher_id = ?').get(id, req.session.userId);
  if (!current) return res.status(404).json({ error: 'Question not found.' });

  const patch = parse(S.questionPatch, req.body);
  const merged = {
    text: patch.text ?? current.text,
    options: patch.options ?? JSON.parse(current.options),
    correct_index: patch.correct_index ?? current.correct_index,
    time_limit: patch.time_limit ?? current.time_limit,
  };
  if (merged.correct_index >= merged.options.length) {
    return res.status(400).json({ error: 'The correct answer must be one of the options.' });
  }
  db.prepare('UPDATE questions SET text=?, options=?, correct_index=?, time_limit=? WHERE id=? AND teacher_id=?')
    .run(merged.text, JSON.stringify(merged.options), merged.correct_index, merged.time_limit, id, req.session.userId);
  res.json({ ok: true });
});

app.post('/api/questions/:id/approve', teacherOnly, (req, res) => {
  const r = db.prepare("UPDATE questions SET status='approved' WHERE id=? AND teacher_id=?")
    .run(Number(req.params.id), req.session.userId);
  if (r.changes === 0) return res.status(404).json({ error: 'Question not found.' });
  res.json({ ok: true });
});

app.post('/api/questions/:id/reject', teacherOnly, (req, res) => {
  const r = db.prepare("UPDATE questions SET status='rejected' WHERE id=? AND teacher_id=?")
    .run(Number(req.params.id), req.session.userId);
  if (r.changes === 0) return res.status(404).json({ error: 'Question not found.' });
  res.json({ ok: true });
});

// Bulk approve or reject. Only the teacher's own questions are touched.
app.post('/api/questions/bulk', teacherOnly, (req, res) => {
  const { ids, action } = parse(S.bulkAction, req.body);
  const status = action === 'approve' ? 'approved' : 'rejected';
  const stmt = db.prepare('UPDATE questions SET status=? WHERE id=? AND teacher_id=?');
  const changed = db.transaction((list) =>
    list.reduce((n, id) => n + stmt.run(status, id, req.session.userId).changes, 0)
  )(ids);
  res.json({ updated: changed });
});

app.delete('/api/questions/:id', teacherOnly, (req, res) => {
  const r = db.prepare('DELETE FROM questions WHERE id = ? AND teacher_id = ?').run(Number(req.params.id), req.session.userId);
  if (r.changes === 0) return res.status(404).json({ error: 'Question not found.' });
  res.json({ ok: true });
});

// ---------- teacher: quizzes ----------
app.get('/api/quizzes', teacherOnly, (req, res) => {
  const rows = db.prepare(
    `SELECT z.id, z.title, COUNT(qq.question_id) AS questionCount
       FROM quizzes z LEFT JOIN quiz_questions qq ON qq.quiz_id = z.id
      WHERE z.teacher_id = ? GROUP BY z.id ORDER BY z.id DESC`
  ).all(req.session.userId);
  res.json({ quizzes: rows });
});

app.post('/api/quizzes', teacherOnly, (req, res) => {
  const { title, questionIds } = parse(S.quiz, req.body);
  // Only approved questions the teacher owns can go into a quiz.
  const placeholders = questionIds.map(() => '?').join(',');
  const valid = db.prepare(
    `SELECT id FROM questions WHERE teacher_id = ? AND status = 'approved' AND id IN (${placeholders})`
  ).all(req.session.userId, ...questionIds).map((r) => r.id);
  if (valid.length === 0) return res.status(400).json({ error: 'Approve some questions before making a quiz.' });

  const quizId = db.transaction(() => {
    const id = Number(db.prepare('INSERT INTO quizzes (teacher_id, title) VALUES (?,?)')
      .run(req.session.userId, title).lastInsertRowid);
    const ins = db.prepare('INSERT INTO quiz_questions (quiz_id, question_id, position) VALUES (?,?,?)');
    valid.forEach((qid, i) => ins.run(id, qid, i));
    return id;
  })();
  res.status(201).json({ id: quizId, questionCount: valid.length });
});

// ---------- live games ----------
const saveResults = db.prepare(
  'INSERT INTO game_results (pin, quiz_id, student_id, score) VALUES (?,?,?,?)'
);

function gameForHost(req, res) {
  const g = game.getGame(req.params.id);
  if (!g || g.hostId !== req.session.userId) {
    res.status(404).json({ error: 'Game not found.' });
    return null;
  }
  return g;
}

app.post('/api/quizzes/:id/host', teacherOnly, (req, res) => {
  const quizId = Number(req.params.id);
  const quiz = db.prepare('SELECT * FROM quizzes WHERE id = ? AND teacher_id = ?').get(quizId, req.session.userId);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });

  const questions = db.prepare(
    `SELECT q.id, q.text, q.options, q.correct_index, q.time_limit
       FROM quiz_questions qq JOIN questions q ON q.id = qq.question_id
      WHERE qq.quiz_id = ? AND q.status = 'approved' ORDER BY qq.position`
  ).all(quizId).map((r) => ({ ...r, options: JSON.parse(r.options) }));
  if (questions.length === 0) return res.status(400).json({ error: 'This quiz has no approved questions.' });

  const g = game.createGame({
    quizId,
    quizTitle: quiz.title,
    hostId: req.session.userId,
    questions,
    onFinish: (finished) => {
      db.transaction(() => {
        for (const p of finished.players.values()) {
          saveResults.run(finished.pin, quizId, p.id, p.score);
        }
      })();
    },
  });
  res.status(201).json({ id: g.id, pin: g.pin });
});

app.post('/api/games/join', requireAuth, requireRole('student'), (req, res) => {
  const { pin } = parse(S.join, req.body);
  const student = q.userById.get(req.session.userId);
  const g = game.getGameByPin(pin);
  if (!g) return res.status(404).json({ error: 'No game found with that PIN.' });
  if (g.hostId !== student.teacher_id) return res.status(403).json({ error: 'That game is not for your class.' });
  try {
    game.join(g, { id: student.id, name: student.display_name });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  res.json({ gameId: g.id });
});

// Students and hosts both poll this. The response shape depends on who is asking.
app.get('/api/games/:id/state', requireAuth, (req, res) => {
  const g = game.getGame(req.params.id);
  if (!g) return res.status(404).json({ error: 'Game not found.' });

  const viewer = { id: req.session.userId };
  const isHost = g.hostId === viewer.id;
  const isPlayer = g.players.has(viewer.id);
  if (!isHost && !isPlayer) return res.status(403).json({ error: 'Join this game first.' });

  res.json(game.viewFor(g, viewer));
});

app.post('/api/games/:id/start', requireAuth, requireRole('teacher'), (req, res, next) => {
  try {
    const g = gameForHost(req, res);
    if (!g) return;
    game.start(g);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/games/:id/next', requireAuth, requireRole('teacher'), (req, res, next) => {
  try {
    const g = gameForHost(req, res);
    if (!g) return;
    if (g.status === 'question') game.reveal(g);       // host can skip the timer
    else if (g.status === 'reveal') game.nextQuestion(g);
    else throw Object.assign(new Error('Start the game first.'), { status: 409 });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/games/:id/answer', requireAuth, requireRole('student'), (req, res, next) => {
  try {
    const { choice } = parse(S.answer, req.body);
    const g = game.getGame(req.params.id);
    if (!g) return res.status(404).json({ error: 'Game not found.' });
    const result = game.answer(g, req.session.userId, choice);
    res.json(result);
  } catch (e) { next(e); }
});

// ---------- errors & fallback ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  const status = err.status && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('Server error:', err.message);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message });
});

app.listen(PORT, () => {
  console.log(`QuizKids running on http://localhost:${PORT}`);
});

module.exports = app;
