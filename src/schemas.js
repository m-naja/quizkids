'use strict';
const { z } = require('zod');

const username = z.string().trim().regex(/^[a-zA-Z0-9_]{3,20}$/, 'Username: 3-20 letters, numbers or _');
const password = z.string().min(8, 'Password must be at least 8 characters').max(128);
const displayName = z.string().trim().min(1).max(30);

const questionFields = {
  text: z.string().trim().min(5).max(300),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(4),
  correct_index: z.number().int().min(0).max(3),
  time_limit: z.number().int().min(5).max(60),
};

// The route re-checks that correct_index points at a real option after merging.
const questionPatch = z.object(questionFields).partial();

module.exports = {
  login: z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(128) }),
  createStudent: z.object({ username, displayName, password: password.optional() }),
  lesson: z.object({ title: z.string().trim().min(2).max(120), content: z.string().trim().min(20).max(20000) }),
  manualQuestion: z.object({ lesson_id: z.number().int().positive().nullable().optional(), ...questionFields }).refine(
    (q) => q.correct_index < q.options.length,
    { message: 'correct_index must point to an existing option', path: ['correct_index'] }
  ),
  questionPatch,
  bulkAction: z.object({
    ids: z.array(z.number().int().positive()).min(1).max(200),
    action: z.enum(['approve', 'reject']),
  }),
  quiz: z.object({
    title: z.string().trim().min(2).max(120),
    questionIds: z.array(z.number().int().positive()).min(1).max(50),
  }),
  join: z.object({ pin: z.string().regex(/^\d{6}$/, 'PIN is 6 digits') }),
  answer: z.object({ choice: z.number().int().min(0).max(3) }),
  generate: z.object({
    count: z.number().int().min(1).max(10).default(5),
    gradeLevel: z.enum(['grade5', 'grade6']).default('grade5'),
  }),
};
