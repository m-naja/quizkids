'use strict';
// Usage: TEACHER_PASSWORD='...' node scripts/create-teacher.js <username> "<Display Name>"
// The password comes from the environment so it does not land in shell history.
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const [username, ...nameParts] = process.argv.slice(2);
const displayName = nameParts.join(' ').trim();
const password = process.env.TEACHER_PASSWORD;

if (!username || !displayName || !password) {
  console.error('Usage: TEACHER_PASSWORD=... node scripts/create-teacher.js <username> "<Display Name>"');
  process.exit(1);
}
if (password.length < 12) {
  console.error('Use a teacher password of at least 12 characters.');
  process.exit(1);
}

(async () => {
  const hash = await bcrypt.hash(password, 12);
  try {
    db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)')
      .run(username, hash, 'teacher', displayName);
    console.log(`Teacher "${username}" created.`);
  } catch (e) {
    console.error(e.message.includes('UNIQUE') ? 'That username already exists.' : e.message);
    process.exit(1);
  }
})();
