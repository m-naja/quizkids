'use strict';
const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'quizkids.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('teacher','student')),
  display_name  TEXT NOT NULL,
  teacher_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lessons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id     INTEGER REFERENCES lessons(id) ON DELETE SET NULL,
  text          TEXT NOT NULL,
  options       TEXT NOT NULL,            -- JSON array of 2..4 strings
  correct_index INTEGER NOT NULL,
  time_limit    INTEGER NOT NULL DEFAULT 20,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','gemini')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quizzes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  quiz_id     INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (quiz_id, question_id)
);

CREATE TABLE IF NOT EXISTS game_results (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pin        TEXT NOT NULL,
  quiz_id    INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score      INTEGER NOT NULL,
  ended_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_questions_teacher_status ON questions(teacher_id, status);
CREATE INDEX IF NOT EXISTS idx_lessons_teacher ON lessons(teacher_id);
`);

module.exports = db;
