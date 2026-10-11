'use strict';
// End-to-end smoke test against a running server.
// Usage: BASE=http://localhost:3000 TEACHER_USER=... TEACHER_PASS=... node tests/smoke.js
const BASE = process.env.BASE || 'http://localhost:3000';
const TEACHER_USER = process.env.TEACHER_USER;
const TEACHER_PASS = process.env.TEACHER_PASS;
if (!TEACHER_USER || !TEACHER_PASS) {
  console.error('Set TEACHER_USER and TEACHER_PASS.');
  process.exit(1);
}

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
};

// Minimal cookie-jar client.
function client() {
  let cookie = '';
  return async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'QuizKids',
        ...(cookie ? { Cookie: cookie } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data };
  };
}

const uniq = Date.now().toString(36).slice(-5);

(async () => {
  const teacher = client();

  // Auth
  let r = await teacher('POST', '/api/auth/login', { username: TEACHER_USER, password: TEACHER_PASS });
  ok(r.status === 200 && r.data.user.role === 'teacher', 'teacher can sign in');

  r = await teacher('POST', '/api/auth/login', { username: TEACHER_USER, password: 'not-the-password' });
  ok(r.status === 401, 'wrong password is rejected');

  r = await client()('POST', '/api/lessons', { title: 'x', content: 'x'.repeat(30) }, { 'X-Requested-With': '' });
  ok(r.status === 403, 'state change without CSRF header is blocked');

  r = await client()('GET', '/api/students');
  ok(r.status === 401, 'anonymous access to teacher data is refused');

  // Students
  const s1 = `kid${uniq}a`;
  const s2 = `kid${uniq}b`;
  r = await teacher('POST', '/api/students', { username: s1, displayName: 'Ayesha' });
  ok(r.status === 201 && typeof r.data.temporaryPassword === 'string', 'teacher creates a student with a generated password');
  const pw1 = r.data.temporaryPassword;
  const studentId1 = r.data.student.id;

  r = await teacher('POST', '/api/students', { username: s2, displayName: 'Nimal', password: 'Strong-Kid-Pass1' });
  ok(r.status === 201 && r.data.temporaryPassword === undefined, 'teacher can set a student password (not echoed back)');
  const studentId2 = r.data.student.id;

  r = await teacher('POST', '/api/students', { username: s1, displayName: 'Dup' });
  ok(r.status === 409, 'duplicate username is refused');

  // Student login and privilege separation
  const kid = client();
  r = await kid('POST', '/api/auth/login', { username: s1, password: pw1 });
  ok(r.status === 200 && r.data.user.role === 'student', 'student signs in with generated password');
  r = await kid('GET', '/api/students');
  ok(r.status === 403, 'student cannot access teacher endpoints');

  // Lessons + AI (no key configured here, so the server must refuse cleanly)
  r = await teacher('POST', '/api/lessons', { title: `Water ${uniq}`, content: 'Water evaporates, condenses into clouds, then falls as rain.' });
  ok(r.status === 201, 'teacher saves a lesson');
  const lessonId = r.data.id;

  r = await teacher('POST', `/api/lessons/${lessonId}/generate`, { count: 3, gradeLevel: 'grade5' });
  ok(r.status === 503 || r.status === 201, 'AI generation responds cleanly (503 when no GEMINI_API_KEY)');

  // Question bank: manual question is approved immediately
  r = await teacher('POST', '/api/questions', {
    text: 'What turns water vapour into clouds?', options: ['Condensation', 'Erosion', 'Fire'], correct_index: 0, time_limit: 15,
  });
  ok(r.status === 201, 'teacher adds a manual question');
  const qA = r.data.id;

  r = await teacher('POST', '/api/questions', {
    text: 'Bad question', options: ['only one'], correct_index: 0,
  });
  ok(r.status === 400, 'question with a single option is refused');

  r = await teacher('POST', '/api/questions', {
    text: 'Index out of range here', options: ['a', 'b'], correct_index: 3,
  });
  ok(r.status === 400, 'correct_index outside the options is refused');

  r = await teacher('PATCH', `/api/questions/${qA}`, { correct_index: 9 });
  ok(r.status === 400, 'editing to an invalid correct answer is refused');

  // Quiz from approved questions only
  r = await teacher('POST', '/api/quizzes', { title: `Quiz ${uniq}`, questionIds: [qA] });
  ok(r.status === 201 && r.data.questionCount === 1, 'teacher builds a quiz from approved questions');
  const quizId = r.data.id;

  // Live game: host, join, answer, reveal, finish
  r = await teacher('POST', `/api/quizzes/${quizId}/host`);
  ok(r.status === 201 && /^\d{6}$/.test(r.data.pin), 'teacher hosts the quiz and gets a 6-digit PIN');
  const gameId = r.data.id;
  const pin = r.data.pin;

  const kid2 = client();
  await kid2('POST', '/api/auth/login', { username: s2, password: 'Strong-Kid-Pass1' });

  r = await kid('POST', '/api/games/join', { pin });
  ok(r.status === 200, 'student joins with the PIN');
  r = await kid2('POST', '/api/games/join', { pin });
  ok(r.status === 200, 'second student joins');

  r = await kid('GET', `/api/games/${gameId}/state`);
  ok(r.status === 200 && r.data.status === 'lobby' && r.data.pin === null, 'students see the lobby without the PIN in the state');

  r = await teacher('POST', `/api/games/${gameId}/start`);
  ok(r.status === 200, 'host starts the game');

  r = await kid('GET', `/api/games/${gameId}/state`);
  ok(r.data.status === 'question' && r.data.question && r.data.question.correctIndex === null,
    'during a question the correct answer is hidden from students');

  r = await kid('POST', `/api/games/${gameId}/answer`, { choice: 0 });
  ok(r.status === 200 && r.data.points > 0, 'correct answer on time earns points');
  r = await kid('POST', `/api/games/${gameId}/answer`, { choice: 0 });
  ok(r.status === 409, 'a second answer to the same question is refused');

  r = await kid2('POST', `/api/games/${gameId}/answer`, { choice: 2 });
  ok(r.status === 200 && r.data.points === 0, 'wrong answer earns zero points');

  r = await kid('POST', `/api/games/${gameId}/start`);
  ok(r.status === 403 || r.status === 404, 'a student cannot control the host');

  // Both students answered, so the server reveals automatically.
  r = await kid('GET', `/api/games/${gameId}/state`);
  ok(r.data.status === 'reveal' && r.data.question.correctIndex === 0, 'auto-reveal when everyone has answered, correct answer shown');
  ok(r.data.pin === null, 'students never receive the game PIN in state');

  r = await teacher('GET', `/api/games/${gameId}/state`);
  ok(r.data.pin === pin, 'host receives the game PIN');

  r = await teacher('POST', `/api/games/${gameId}/next`);
  ok(r.status === 200, 'host advances past the last question');
  r = await kid('GET', `/api/games/${gameId}/state`);
  ok(r.data.status === 'finished' && r.data.leaderboard[0].name === 'Ayesha', 'game finishes with Ayesha ranked first');
  ok(r.data.leaderboard[0].score > r.data.leaderboard[1].score, 'faster correct answer scores more than a wrong one');

  // Access control on game state
  r = await client()('GET', `/api/games/${gameId}/state`);
  ok(r.status === 401, 'anonymous user cannot read a game state');

  r = await teacher('GET', `/api/games/00000000-0000-0000-0000-000000000000/state`);
  ok(r.status === 404, 'unknown game id returns 404');

  // Cleanup test data
  await teacher('DELETE', `/api/students/${studentId1}`);
  await teacher('DELETE', `/api/students/${studentId2}`);
  await teacher('DELETE', `/api/questions/${qA}`);
  await teacher('DELETE', `/api/lessons/${lessonId}`);

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('Smoke test crashed:', e);
  process.exit(1);
});
