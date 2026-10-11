# QuizKids

A live, Kahoot-style quiz game for children aged about 10–12. Teachers turn
their lessons into questions with Google Gemini, approve every question before
a child sees it, and run live games where students join with a PIN.

## Features

- **Lessons → questions.** A teacher saves a lesson. Gemini drafts multiple-choice
  questions from that lesson text only.
- **Teacher approval.** Every AI draft lands in a review queue. The teacher edits,
  approves or rejects each question one by one, or approves/rejects in bulk.
  Only approved questions can be used in a game.
- **Quizzes and live games.** Build a quiz from approved questions and host it.
  Students join with a 6-digit PIN and answer on colourful tiles. Faster correct
  answers score more, with a live leaderboard.
- **Secure accounts.** Teachers create student accounts. Students cannot sign up
  on their own, and each student only sees games run by their own teacher.

## Security

| Area | What is done |
|---|---|
| Passwords | bcrypt (cost 12). Generated student passwords are shown once and never stored in plain text. |
| Sessions | HTTP-only, `SameSite=Strict` cookies; `Secure` in production; session ID regenerated at login. |
| Brute force | Login is rate-limited (10 attempts / 15 min per IP by default). Failed logins take the same time whether or not the username exists. |
| CSRF | Every state-changing API call must send a custom `X-Requested-With` header, which browsers do not send cross-site. |
| Authorization | Teacher-only and student-only routes are enforced server-side. Every teacher resource query is scoped to `teacher_id`. |
| Input | Every request body is validated with Zod. SQL uses parameterised statements only. |
| Browser | Helmet with a strict Content-Security-Policy (no inline scripts or styles). All user text is inserted with `textContent`, never as HTML. |
| Cheating | The server runs the question timer and scores answers. Correct answers are hidden from students until reveal. The PIN is only sent to the host. |
| AI safety | The lesson is passed to Gemini as data inside delimiters. The API key is sent in a header, never in a URL. AI output is validated, and bad items are dropped. |
| Errors | Internal errors return a generic message. Upstream AI errors never echo the key or response body. |

## Setup

Requires Node.js 22 or newer.

```bash
npm install
cp .env.example .env          # then edit .env
```

Set these in `.env`:

- `SESSION_SECRET`: a long random string (required in production).
  Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
- `GEMINI_API_KEY`: a key from Google AI Studio. Without it, the AI button shows a
  clear message and everything else still works.
- `GEMINI_MODEL`: defaults to `gemini-2.5-pro`. Change it if your account uses another model name.

Create the first teacher account (the password is read from the environment so it
stays out of shell history):

```bash
TEACHER_PASSWORD='use-a-long-passphrase' npm run create-teacher -- mrnaja "Mr Naja"
```

Start the app:

```bash
npm start            # production-style
npm run dev          # restarts on file changes
```

Open http://localhost:3000, sign in as the teacher, then add students under **Students**.

## Testing

With the server running:

```bash
BASE=http://localhost:3000 TEACHER_USER=mrnaja TEACHER_PASS='...' node tests/smoke.js
```

The smoke test covers sign-in, CSRF, role separation, validation, the approval
rules, quiz building, a full live game and access control. It creates and then
removes its own test data.

## Deployment notes

- Run behind HTTPS (a reverse proxy such as Caddy or nginx). Cookies are marked
  `Secure` when `NODE_ENV=production`.
- Sessions use the default in-memory store. Restarting the process signs everyone
  out, and live games in progress are lost. Before running for more than one
  process, switch to a persistent session store.
- Live games are kept in memory for the length of a session. Final scores are
  saved to the `game_results` table.
- Children's data: under laws such as COPPA (US) and similar rules elsewhere, a
  school or parent must consent before a child's account is created. Accounts are
  created by teachers and contain only a username, a display name and a password.
  Keep student data to what the game needs.

## Project layout

```
server.js            Express app: auth, teacher, AI and game routes
src/db.js            SQLite schema (better-sqlite3)
src/schemas.js       Zod validation for every request body
src/gemini.js        Gemini client: prompt, call, validation, safe errors
src/game.js          Live game engine: timer, scoring, reveal, leaderboard
public/              Front end (plain HTML, CSS and JS; no build step)
scripts/create-teacher.js
tests/smoke.js       End-to-end test
```
