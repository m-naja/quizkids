'use strict';
(() => {
  const SHAPES = ['▲', '◆', '●', '■'];
  const app = document.getElementById('app');
  const nav = document.getElementById('nav');
  const who = document.getElementById('who');
  const toastEl = document.getElementById('toast');

  let user = null;
  let pollTimer = null;
  let tickTimer = null;
  let lastSig = '';
  let teacherTab = 'lessons';
  let activeGame = null;      // { id, pin } for the teacher's host view
  let activeGameId = null;    // for students
  let clockOffset = 0;        // server time minus local time, refreshed by polling

  // ---------- helpers ----------
  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        // Set styles through the DOM, not as an attribute: our CSP blocks style attributes.
        else if (k === 'style') node.style.cssText = v;
        else if (k === 'value') node.value = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else if (typeof node[k] === 'boolean') node[k] = v;
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  function toast(msg, kind = '') {
    toastEl.textContent = msg;
    toastEl.className = 'toast ' + kind;
    toastEl.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { toastEl.hidden = true; }, 3200);
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'QuizKids' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong.');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function stopTimers() {
    clearInterval(pollTimer); pollTimer = null;
    clearInterval(tickTimer); tickTimer = null;
    lastSig = '';
  }

  function setChrome() {
    if (user) {
      nav.hidden = false;
      who.textContent = `${user.displayName}${user.role === 'teacher' ? ' (teacher)' : ''}`;
    } else {
      nav.hidden = true;
    }
  }

  // replaceChildren() would print null/false as text, so drop empty children first.
  function put(node, ...kids) {
    node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
  }

  function setView(...nodes) {
    put(app, ...nodes);
  }

  function hero(text) {
    return h('div', { class: 'hero' }, h('h1', null, text));
  }

  // ---------- boot ----------
  async function boot() {
    try {
      const { user: u } = await api('GET', '/api/auth/me');
      user = u;
    } catch {
      user = null;
    }
    render();
  }

  function render() {
    stopTimers();
    setChrome();
    if (!user) return loginView();
    if (user.role === 'teacher') return teacherView();
    return studentHome();
  }

  // ---------- login ----------
  function loginView() {
    const username = h('input', { type: 'text', id: 'u', autocomplete: 'username', required: true, maxlength: 40 });
    const password = h('input', { type: 'password', id: 'p', autocomplete: 'current-password', required: true, maxlength: 128 });
    const err = h('div', { class: 'notice', role: 'alert', hidden: true });

    const form = h('form', {
      class: 'card narrow',
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        try {
          const r = await api('POST', '/api/auth/login', { username: username.value.trim(), password: password.value });
          user = r.user;
          render();
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
        }
      },
    },
      h('h2', null, 'Sign in'),
      h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), username),
      h('div', { class: 'field' }, h('label', { for: 'p' }, 'Password'), password),
      err,
      h('button', { class: 'btn block', type: 'submit' }, 'Let’s go!'),
      h('p', { class: 'muted' }, 'Accounts are created by your teacher. Ask them if you need a login.'),
    );

    setView(hero('Learn. Play. Win!'), h('div', { class: 'center' }, form));
  }

  document.getElementById('logout').addEventListener('click', async () => {
    try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
    user = null;
    activeGame = null;
    activeGameId = null;
    render();
  });

  // ---------- student ----------
  function studentHome() {
    const pin = h('input', { type: 'text', class: 'pin-input', inputmode: 'numeric', maxlength: 6, placeholder: '000000', autocomplete: 'off' });
    const err = h('div', { class: 'notice', role: 'alert', hidden: true });
    const btn = h('button', { class: 'btn green block', type: 'submit' }, 'Join game');

    const form = h('form', {
      class: 'card narrow',
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        btn.disabled = true;
        try {
          const r = await api('POST', '/api/games/join', { pin: pin.value.trim() });
          activeGameId = r.gameId;
          studentPlay();
        } catch (ex) {
          err.textContent = ex.message;
          err.hidden = false;
          btn.disabled = false;
        }
      },
    },
      h('h2', null, `Hi ${user.displayName}!`),
      h('p', { class: 'muted' }, 'Type the 6-digit code your teacher shows on the board.'),
      h('div', { class: 'field' }, pin),
      err,
      btn,
    );
    setView(hero('Ready to play?'), h('div', { class: 'center' }, form));
    setTimeout(() => pin.focus(), 0);
  }

  function studentPlay() {
    stopTimers();
    const box = h('div', { class: 'card', style: 'max-width:900px;margin:0 auto' });
    setView(box);
    pollTimer = setInterval(() => pollStudent(box), 1000);
    pollStudent(box);
  }

  async function pollStudent(box) {
    let s;
    try {
      s = await api('GET', `/api/games/${activeGameId}/state`);
    } catch (ex) {
      clearInterval(pollTimer);
      put(box, h('h2', null, 'Game ended'), h('p', { class: 'muted' }, ex.message),
        h('button', { class: 'btn', onclick: () => { activeGameId = null; render(); } }, 'Back'));
      return;
    }
    clockOffset = s.serverNow - Date.now();
    const sig = JSON.stringify([s.status, s.question && s.question.number, s.you && s.you.answered,
      s.you && s.you.lastGain, s.you && s.you.score, s.question && s.question.correctIndex, s.playerCount]);
    if (sig === lastSig) return;
    lastSig = sig;
    renderStudentState(box, s);
  }

  function renderStudentState(box, s) {
    clearInterval(tickTimer); tickTimer = null;

    if (s.status === 'lobby') {
      put(box, 
        h('h2', null, s.quizTitle),
        h('p', { class: 'bubble-wait' }, 'You’re in! Look at the board. The game starts soon. 🎉'),
        h('p', { class: 'muted', style: 'text-align:center' }, `${s.playerCount} player(s) joined`),
      );
      return;
    }

    if (s.status === 'finished') {
      const rank = s.leaderboard.findIndex((p) => p.id === user.id) + 1;
      put(box, 
        h('h2', null, 'Game over! 🏁'),
        h('p', null, `Your score: ${s.you ? s.you.score : 0} points${rank ? ` · Rank #${rank}` : ''}`),
        leaderboardList(s.leaderboard),
        h('button', { class: 'btn block', style: 'margin-top:12px', onclick: () => { activeGameId = null; render(); } }, 'Play another game'),
      );
      return;
    }

    const q = s.question;
    if (!q) return;

    const timer = h('div', { class: 'timer' }, '-');
    const bar = h('div');
    const timerbar = h('div', { class: 'timerbar' }, bar);

    const tiles = q.options.map((opt, i) => {
      const correct = q.correctIndex === i;
      const cls = ['tile', 't' + i];
      if (s.status === 'reveal' && correct) cls.push('correct');
      if (s.status === 'reveal' && !correct) cls.push('wrong');
      return h('button', {
        class: cls.join(' '),
        disabled: s.status !== 'question' || (s.you && s.you.answered),
        onclick: () => answer(i),
      }, h('span', { class: 'shape', 'aria-hidden': 'true' }, SHAPES[i]), h('span', null, opt));
    });

    let feedback;
    if (s.status === 'reveal') {
      const gain = s.you ? s.you.lastGain : 0;
      feedback = gain > 0
        ? h('p', { class: 'bubble-wait' }, `Correct! +${gain} points 🌟`)
        : h('p', { class: 'bubble-wait' }, 'Not this time. Keep going! 💪');
    } else if (s.you && s.you.answered) {
      feedback = h('p', { class: 'bubble-wait' }, 'Answer locked in! Waiting for others…');
    } else {
      feedback = h('p', { class: 'bubble-wait' }, 'Tap your answer!');
    }

    put(box, 
      h('div', { class: 'row spread' }, h('span', { class: 'badge' }, `Question ${q.number} of ${q.total}`), timer),
      h('div', { class: 'qtext', style: 'margin-top:14px' }, q.text),
      s.status === 'question' ? timerbar : null,
      h('div', { class: 'answers' }, tiles),
      h('div', { style: 'margin-top:16px' }, feedback),
    );

    const tick = () => {
      const remaining = Math.max(0, (q.startedAt + q.timeLimit * 1000) - (Date.now() + clockOffset));
      timer.textContent = Math.ceil(remaining / 1000);
      bar.style.width = `${Math.max(0, Math.min(100, (remaining / (q.timeLimit * 1000)) * 100))}%`;
    };
    tick();
    if (s.status === 'question') tickTimer = setInterval(tick, 250);
  }

  async function answer(choice) {
    try {
      await api('POST', `/api/games/${activeGameId}/answer`, { choice });
      lastSig = '';
      const box = app.firstElementChild;
      if (box) pollStudent(box);
    } catch (ex) {
      toast(ex.message, 'error');
    }
  }

  function leaderboardList(board) {
    return h('ol', { class: 'board' },
      board.slice(0, 10).map((p) => h('li', null, h('span', null, p.name), h('span', null, `${p.score}`))));
  }

  // ---------- teacher shell ----------
  const TABS = [
    ['lessons', 'Lessons'],
    ['review', 'Review questions'],
    ['questions', 'Question bank'],
    ['quizzes', 'Quizzes'],
    ['students', 'Students'],
  ];

  function teacherView() {
    const tabs = h('div', { class: 'tabs', role: 'tablist' },
      TABS.map(([key, label]) => h('button', {
        class: 'tab', role: 'tab', 'aria-selected': teacherTab === key ? 'true' : 'false',
        onclick: () => { teacherTab = key; activeGame = null; teacherView(); },
      }, label)));
    const body = h('div', { class: 'card' });
    setView(hero('Teacher dashboard'), tabs, body);
    if (activeGame) return hostView(body);

    const loaders = { lessons: lessonsTab, review: reviewTab, questions: bankTab, quizzes: quizzesTab, students: studentsTab };
    loaders[teacherTab](body);
  }

  // ---------- teacher: lessons + AI generation ----------
  async function lessonsTab(body) {
    const title = h('input', { type: 'text', maxlength: 120, placeholder: 'e.g. The Water Cycle' });
    const content = h('textarea', { maxlength: 20000, placeholder: 'Paste the lesson text here. The AI writes questions only from this text.' });
    const list = h('div', { class: 'grid', style: 'margin-top:18px' });

    const create = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/api/lessons', { title: title.value, content: content.value });
          toast('Lesson saved', 'success');
          title.value = ''; content.value = '';
          loadLessons(list);
        } catch (ex) { toast(ex.message, 'error'); }
      },
    },
      h('h2', null, 'New lesson'),
      h('div', { class: 'field' }, h('label', null, 'Lesson title'), title),
      h('div', { class: 'field' }, h('label', null, 'Lesson text'), content),
      h('button', { class: 'btn green', type: 'submit' }, 'Save lesson'),
    );

    put(body, create, h('h2', { style: 'margin-top:26px' }, 'Your lessons'), list);
    loadLessons(list);
  }

  async function loadLessons(list) {
    const { lessons } = await api('GET', '/api/lessons');
    if (!lessons.length) {
      put(list, h('p', { class: 'muted' }, 'No lessons yet. Save one above, then let AI draft questions from it.'));
      return;
    }
    put(list, ...lessons.map((l) => {
      const count = h('select', null,
        [3, 5, 8, 10].map((n) => h('option', { value: n, selected: n === 5 }, `${n} questions`)));
      const grade = h('select', null,
        h('option', { value: 'grade5' }, 'Ages 10–11'),
        h('option', { value: 'grade6' }, 'Ages 11–12'));
      const gen = h('button', {
        class: 'btn blue small',
        onclick: async () => {
          gen.disabled = true; gen.textContent = 'AI is writing…';
          try {
            const r = await api('POST', `/api/lessons/${l.id}/generate`, { count: Number(count.value), gradeLevel: grade.value });
            toast(`${r.created} questions sent to Review`, 'success');
          } catch (ex) { toast(ex.message, 'error'); }
          finally { gen.disabled = false; gen.textContent = 'Make questions with AI ✨'; }
        },
      }, 'Make questions with AI ✨');
      const del = h('button', {
        class: 'btn red small',
        onclick: async () => {
          if (!confirm(`Delete "${l.title}"? Its questions stay in the bank.`)) return;
          try { await api('DELETE', `/api/lessons/${l.id}`); loadLessons(list); }
          catch (ex) { toast(ex.message, 'error'); }
        },
      }, 'Delete');
      return h('div', { class: 'qcard' },
        h('h3', null, l.title),
        h('div', { class: 'row' }, count, grade),
        h('div', { class: 'row' }, gen, del),
      );
    }));
  }

  // ---------- teacher: review queue (one by one or bulk) ----------
  async function reviewTab(body) {
    const { questions } = await api('GET', '/api/questions?status=pending');
    const selected = new Map(); // id -> checkbox
    const readers = new Map();  // id -> () => edited values

    const bulkBar = h('div', { class: 'row', style: 'margin:10px 0 16px' });
    const list = h('div', { class: 'grid' });

    const refresh = () => reviewTab(body);

    const bulkAct = async (ids, action) => {
      if (!ids.length) return toast('Nothing to change', 'error');
      try {
        const r = await api('POST', '/api/questions/bulk', { ids, action });
        toast(`${r.updated} question(s) ${action === 'approve' ? 'approved' : 'rejected'}`, 'success');
        refresh();
      } catch (ex) { toast(ex.message, 'error'); }
    };

    const selectedIds = () => [...selected].filter(([, cb]) => cb.checked).map(([id]) => id);

    bulkBar.append(
      h('button', { class: 'btn green small', onclick: () => bulkAct(selectedIds(), 'approve') }, 'Approve selected'),
      h('button', { class: 'btn red small', onclick: () => bulkAct(selectedIds(), 'reject') }, 'Reject selected'),
      h('button', { class: 'btn yellow small', onclick: () => bulkAct(questions.map((q) => q.id), 'approve') }, 'Approve all'),
    );

    if (!questions.length) {
      list.append(h('p', { class: 'muted' }, 'Nothing waiting. Generate questions from a lesson, or write one below.'));
    }

    for (const q of questions) {
      const cb = h('input', { type: 'checkbox', 'aria-label': 'Select question' });
      selected.set(q.id, cb);
      const { node, read } = editor(q);
      readers.set(q.id, read);

      const approve = h('button', {
        class: 'btn green small',
        onclick: async () => {
          try {
            await api('PATCH', `/api/questions/${q.id}`, read());
            await api('POST', `/api/questions/${q.id}/approve`);
            toast('Approved ✅', 'success');
            refresh();
          } catch (ex) { toast(ex.message, 'error'); }
        },
      }, 'Approve');
      const reject = h('button', {
        class: 'btn red small',
        onclick: async () => {
          try { await api('POST', `/api/questions/${q.id}/reject`); refresh(); }
          catch (ex) { toast(ex.message, 'error'); }
        },
      }, 'Reject');

      list.append(h('div', { class: 'qcard' },
        h('div', { class: 'row spread' },
          h('span', { class: 'badge ai' }, q.source === 'gemini' ? 'AI draft' : 'Manual'),
          h('label', { class: 'row' }, cb, h('span', { class: 'muted' }, 'Select'))),
        node,
        h('div', { class: 'row' }, approve, reject),
      ));
    }

    put(body, 
      h('h2', null, `Review (${questions.length} waiting)`),
      h('p', { class: 'muted' }, 'Check each question. Edit it if needed, then approve or reject. Only approved questions can go into a quiz.'),
      bulkBar, list,
      h('hr', { style: 'margin:26px 0;border:0;border-top:2px solid #eee' }),
      manualForm(),
    );
  }

  function editor(q) {
    const text = h('input', { type: 'text', value: q.text, maxlength: 300 });
    const time = h('input', { type: 'number', value: q.timeLimit, min: 5, max: 60 });
    const radioName = 'correct-' + q.id;
    const opts = q.options.map((o, i) => ({
      input: h('input', { type: 'text', value: o, maxlength: 100, 'aria-label': `Option ${SHAPES[i]}` }),
      radio: h('input', { type: 'radio', name: radioName, value: i, checked: i === q.correctIndex, 'aria-label': `Correct: option ${i + 1}` }),
    }));
    const node = h('div', null,
      h('div', { class: 'field' }, h('label', null, 'Question'), text),
      h('div', { class: 'field' },
        h('label', null, 'Answers (tick the correct one)'),
        opts.map((o, i) => h('div', { class: 'opt-row' }, o.radio, h('span', { class: 'shape' }, SHAPES[i]), o.input)),
      ),
      h('div', { class: 'field' }, h('label', null, 'Seconds to answer (5–60)'), time),
    );
    const read = () => ({
      text: text.value.trim(),
      options: opts.map((o) => o.input.value.trim()),
      correct_index: Number((opts.find((o) => o.radio.checked) || { radio: { value: 0 } }).radio.value),
      time_limit: Number(time.value),
    });
    return { node, read };
  }

  function manualForm() {
    const text = h('input', { type: 'text', maxlength: 300, placeholder: 'Write a question' });
    const a = h('input', { type: 'text', maxlength: 100, placeholder: 'Answer A' });
    const b = h('input', { type: 'text', maxlength: 100, placeholder: 'Answer B' });
    const c = h('input', { type: 'text', maxlength: 100, placeholder: 'Answer C (optional)' });
    const d = h('input', { type: 'text', maxlength: 100, placeholder: 'Answer D (optional)' });
    const correct = h('select', null,
      h('option', { value: 0 }, 'Correct: A'), h('option', { value: 1 }, 'Correct: B'),
      h('option', { value: 2 }, 'Correct: C'), h('option', { value: 3 }, 'Correct: D'));
    return h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const options = [a, b, c, d].map((x) => x.value.trim()).filter(Boolean);
        const idx = Number(correct.value);
        try {
          await api('POST', '/api/questions', {
            text: text.value.trim(), options, correct_index: idx, time_limit: 20,
          });
          toast('Question added to the bank', 'success');
          text.value = ''; [a, b, c, d].forEach((x) => { x.value = ''; });
        } catch (ex) { toast(ex.message, 'error'); }
      },
    },
      h('h3', null, 'Write your own question'),
      h('div', { class: 'field' }, text),
      h('div', { class: 'grid' }, a, b, c, d),
      h('div', { class: 'row', style: 'margin-top:12px' }, correct,
        h('button', { class: 'btn green', type: 'submit' }, 'Add to bank')),
    );
  }

  // ---------- teacher: question bank ----------
  async function bankTab(body) {
    const { questions } = await api('GET', '/api/questions');
    const approved = questions.filter((q) => q.status === 'approved');
    const other = questions.filter((q) => q.status !== 'approved');
    const grid = h('div', { class: 'grid' });
    const card = (q) => h('div', { class: 'qcard ' + q.status },
      h('div', { class: 'row spread' },
        h('span', { class: 'badge ' + (q.status === 'approved' ? 'ok' : 'no') }, q.status),
        h('span', { class: 'badge' }, q.source === 'gemini' ? 'AI' : 'Manual')),
      h('strong', null, q.text),
      h('ul', { class: 'muted', style: 'margin:0;padding-left:18px' },
        q.options.map((o, i) => h('li', null, i === q.correctIndex ? `✔ ${o}` : o))),
      h('button', {
        class: 'btn red small',
        onclick: async () => {
          if (!confirm('Delete this question?')) return;
          try { await api('DELETE', `/api/questions/${q.id}`); bankTab(body); }
          catch (ex) { toast(ex.message, 'error'); }
        },
      }, 'Delete'),
    );
    put(body, 
      h('h2', null, `Approved questions (${approved.length})`),
      approved.length ? grid : h('p', { class: 'muted' }, 'No approved questions yet.'),
      other.length ? h('h3', { style: 'margin-top:20px' }, 'Rejected') : null,
      other.length ? h('div', { class: 'grid' }, other.map(card)) : null,
    );
    grid.append(...approved.map(card));
  }

  // ---------- teacher: quizzes ----------
  async function quizzesTab(body) {
    const [{ questions }, { quizzes }] = await Promise.all([
      api('GET', '/api/questions?status=approved'),
      api('GET', '/api/quizzes'),
    ]);

    const title = h('input', { type: 'text', maxlength: 120, placeholder: 'e.g. Science Friday' });
    const checks = questions.map((q) => ({
      id: q.id,
      cb: h('input', { type: 'checkbox', checked: true }),
      q,
    }));

    const create = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const ids = checks.filter((c) => c.cb.checked).map((c) => c.id);
        try {
          await api('POST', '/api/quizzes', { title: title.value.trim(), questionIds: ids });
          toast('Quiz created', 'success');
          quizzesTab(body);
        } catch (ex) { toast(ex.message, 'error'); }
      },
    },
      h('h2', null, 'Build a quiz'),
      h('div', { class: 'field' }, h('label', null, 'Quiz name'), title),
      questions.length
        ? checks.map((c) => h('label', { class: 'row', style: 'padding:6px 0' }, c.cb, c.q.text))
        : h('p', { class: 'muted' }, 'Approve some questions first.'),
      h('button', { class: 'btn green', type: 'submit', disabled: !questions.length }, 'Create quiz'),
    );

    const list = quizzes.length
      ? h('div', { class: 'grid', style: 'margin-top:24px' }, quizzes.map((z) => h('div', { class: 'qcard' },
        h('h3', null, z.title),
        h('span', { class: 'muted' }, `${z.questionCount} question(s)`),
        h('button', { class: 'btn small', onclick: () => hostQuiz(z.id) }, 'Play with class ▶'))))
      : h('p', { class: 'muted' }, 'No quizzes yet.');

    put(body, create, h('h2', { style: 'margin-top:26px' }, 'Your quizzes'), list);
  }

  async function hostQuiz(quizId) {
    try {
      const r = await api('POST', `/api/quizzes/${quizId}/host`);
      activeGame = { id: r.id, pin: r.pin };
      lastSig = '';
      teacherView();
    } catch (ex) { toast(ex.message, 'error'); }
  }

  // ---------- teacher: live host ----------
  function hostView(body) {
    stopTimers();
    put(body, h('p', { class: 'muted' }, 'Loading game…'));
    pollTimer = setInterval(() => pollHost(body), 1000);
    pollHost(body);
  }

  async function pollHost(body) {
    let s;
    try {
      s = await api('GET', `/api/games/${activeGame.id}/state`);
    } catch (ex) {
      clearInterval(pollTimer);
      put(body, h('p', null, ex.message));
      return;
    }
    clockOffset = s.serverNow - Date.now();
    const sig = JSON.stringify([s.status, s.question && s.question.number, s.answeredCount, s.playerCount, s.leaderboard.length]);
    if (sig === lastSig) return;
    lastSig = sig;
    renderHost(body, s);
  }

  function renderHost(body, s) {
    clearInterval(tickTimer); tickTimer = null;
    const exit = h('button', { class: 'btn ghost small', onclick: () => { activeGame = null; lastSig = ''; teacherView(); } }, 'Leave game');

    if (s.status === 'lobby') {
      put(body, 
        h('div', { class: 'row spread' }, h('h2', null, s.quizTitle), exit),
        h('p', { class: 'muted' }, 'Players type this code on their device:'),
        h('div', { class: 'big-pin' }, s.pin),
        h('p', { class: 'muted', style: 'text-align:center' }, `${s.playerCount} player(s) joined`),
        h('div', { class: 'center' }, h('button', {
          class: 'btn green', disabled: s.playerCount === 0,
          onclick: () => control('start'),
        }, 'Start game ▶')),
      );
      return;
    }

    if (s.status === 'finished') {
      put(body, 
        h('div', { class: 'row spread' }, h('h2', null, 'Final results 🏆'), exit),
        leaderboardList(s.leaderboard),
      );
      return;
    }

    const q = s.question;
    const correctIndex = q ? q.correctIndex : null;
    const reveal = s.status === 'reveal';
    const tiles = q ? q.options.map((o, i) => h('div', {
      class: ['tile', 't' + i, reveal && i === correctIndex ? 'correct' : '', reveal && i !== correctIndex ? 'wrong' : ''].join(' '),
      style: 'cursor:default',
    }, h('span', { class: 'shape', 'aria-hidden': 'true' }, SHAPES[i]), h('span', null, o))) : [];

    const nextBtn = h('button', {
      class: reveal ? 'btn green' : 'btn yellow',
      onclick: () => control('next'),
    }, reveal
      ? (s.question && s.question.number === s.question.total ? 'Finish game 🏁' : 'Next question ▶')
      : 'Show answer now');

    const timer = h('div', { class: 'timer' }, '-');
    const bar = h('div');
    put(body, 
      h('div', { class: 'row spread' },
        h('span', { class: 'badge' }, q ? `Question ${q.number} of ${q.total}` : ''),
        h('div', { class: 'row' }, timer, exit)),
      h('div', { class: 'qtext', style: 'margin-top:14px' }, q ? q.text : ''),
      !reveal ? h('div', { class: 'timerbar' }, bar) : null,
      h('p', { class: 'muted', style: 'text-align:center' }, `${s.answeredCount} of ${s.playerCount} answered`),
      h('div', { class: 'answers' }, tiles),
      h('div', { class: 'center', style: 'margin-top:18px' }, nextBtn),
      reveal ? h('div', { style: 'margin-top:20px' }, h('h3', null, 'Leaderboard'), leaderboardList(s.leaderboard)) : null,
    );

    if (q && !reveal) {
      const tick = () => {
        const remaining = Math.max(0, (q.startedAt + q.timeLimit * 1000) - (Date.now() + clockOffset));
        timer.textContent = Math.ceil(remaining / 1000);
        bar.style.width = `${Math.max(0, Math.min(100, (remaining / (q.timeLimit * 1000)) * 100))}%`;
      };
      tick();
      tickTimer = setInterval(tick, 250);
    }
  }

  async function control(action) {
    try {
      await api('POST', `/api/games/${activeGame.id}/${action}`);
      lastSig = '';
    } catch (ex) { toast(ex.message, 'error'); }
  }

  // ---------- teacher: students ----------
  async function studentsTab(body) {
    const { students } = await api('GET', '/api/students');
    const username = h('input', { type: 'text', maxlength: 20, placeholder: 'e.g. ayesha_5b', autocomplete: 'off' });
    const display = h('input', { type: 'text', maxlength: 30, placeholder: 'Name shown on the board' });
    const password = h('input', { type: 'text', maxlength: 128, placeholder: 'Leave blank to generate one', autocomplete: 'off' });
    const reveal = h('div');

    const create = h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const r = await api('POST', '/api/students', {
            username: username.value.trim(),
            displayName: display.value.trim(),
            password: password.value || undefined,
          });
          put(reveal, 
            h('p', { class: 'notice' }, 'Write this password down now. It will not be shown again.'),
            h('p', null, `Username: ${r.student.username}`),
            h('div', { class: 'secret' }, r.temporaryPassword || 'Set by you'),
          );
          username.value = ''; display.value = ''; password.value = '';
          studentsTab(body);
        } catch (ex) { toast(ex.message, 'error'); }
      },
    },
      h('h2', null, 'Add a student'),
      h('div', { class: 'grid' },
        h('div', { class: 'field' }, h('label', null, 'Username'), username),
        h('div', { class: 'field' }, h('label', null, 'Display name'), display),
        h('div', { class: 'field' }, h('label', null, 'Password (optional)'), password)),
      h('button', { class: 'btn green', type: 'submit' }, 'Create account'),
      reveal,
    );

    const list = students.length
      ? h('div', { class: 'grid', style: 'margin-top:20px' }, students.map((st) => h('div', { class: 'qcard' },
        h('strong', null, st.displayName),
        h('span', { class: 'muted' }, `@${st.username}`),
        h('button', {
          class: 'btn red small',
          onclick: async () => {
            if (!confirm(`Remove ${st.displayName}?`)) return;
            try { await api('DELETE', `/api/students/${st.id}`); studentsTab(body); }
            catch (ex) { toast(ex.message, 'error'); }
          },
        }, 'Remove'))))
      : h('p', { class: 'muted' }, 'No students yet.');

    put(body, create, h('h2', { style: 'margin-top:26px' }, 'Your class'), list);
  }

  boot();
})();
