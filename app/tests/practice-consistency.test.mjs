import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { reconcilePracticeResult, modelGradingBasisChanged } from '../dist/server/practice-results.js';

const question = { id: 'q', stem: 'Choose one. A. One B. Two C. Three D. Four', kind: 'choice', reference: null, visualReview: null };
const solution = { status: 'solved', answer: 'A', explanation: 'Original explanation', knowledgePoints: ['Original concept'] };
function fixture() {
  return {
    questions: [structuredClone(question)], answers: { q: 'B' }, graded: { q: 'needs_review' },
    solution_snapshots: { q: { stem: question.stem, visual_review: null, model_solution: null, solution_status: 'queued' } }
  };
}
const current = (overrides = {}) => ({ id: 'q', stem: question.stem, question_kind: 'choice', reference: null,
  visual_review: null, model_solution: solution, solution_status: 'ready', ...overrides });

test('late solutions fill matching snapshots and persist grades without mutating the input', () => {
  const saved = fixture();
  const result = reconcilePracticeResult(saved, [current()]);
  assert.equal(result.grades.q, 'incorrect');
  assert.deepEqual(result.snapshots.q.model_solution, solution);
  assert.equal(saved.solution_snapshots.q.model_solution, null);
  assert.equal(saved.graded.q, 'needs_review');
  assert.equal(reconcilePracticeResult({ ...saved, graded: result.grades, solution_snapshots: result.snapshots }, [current()]), null);
});

test('late grading preserves unanswered and already final grades', () => {
  for (const grade of ['unanswered', 'correct', 'incorrect']) {
    const saved = fixture();
    saved.graded.q = grade;
    if (grade === 'unanswered') saved.answers = {};
    const result = reconcilePracticeResult(saved, [current()]);
    assert.equal(result.grades.q, grade);
  }
  const saved = fixture();
  saved.answers.q = 'A';
  assert.equal(reconcilePracticeResult(saved, [current()]).grades.q, 'correct');
});

test('changed input and missing or legacy snapshots cannot acquire current solutions', () => {
  for (const change of [
    { stem: 'A changed question' }, { visual_review: 'A changed diagram' }, { question_kind: 'short_answer' },
    { reference: { kind: 'choice', source: 'teacher', answers: ['A'], explanation: '' } }, { model_solution: null }
  ]) assert.equal(reconcilePracticeResult(fixture(), [current(change)]), null);
  assert.equal(reconcilePracticeResult({ ...fixture(), solution_snapshots: null }, [current()]), null);
  assert.equal(reconcilePracticeResult({ ...fixture(), solution_snapshots: {} }, [current()]), null);
});

test('completed snapshots stay immutable and older late snapshots can repair persisted grades', () => {
  const saved = fixture();
  saved.solution_snapshots.q.model_solution = solution;
  saved.solution_snapshots.q.solution_status = 'ready';
  const result = reconcilePracticeResult(saved, [current({ model_solution: { ...solution, answer: 'B' } })]);
  assert.equal(result.grades.q, 'incorrect');
  assert.deepEqual(result.snapshots.q.model_solution, solution);
});

test('model answer or status changes invalidate retries but explanations and teacher overrides do not', () => {
  assert.equal(modelGradingBasisChanged(null, solution, { ...solution, answer: 'B' }), true);
  assert.equal(modelGradingBasisChanged(null, solution, { ...solution, status: 'needs_review' }), true);
  assert.equal(modelGradingBasisChanged(null, solution, null), true);
  assert.equal(modelGradingBasisChanged(null, solution, { ...solution, explanation: 'Edited explanation' }), false);
  const reference = { kind: 'choice', source: 'teacher', answers: ['A'], explanation: '' };
  assert.equal(modelGradingBasisChanged(reference, solution, { ...solution, answer: 'B' }), false);
});

test('SQL practice and mistake routes share late grades and preserve historical grading evidence', async () => {
  const { verifyPracticeConsistency } = await import('./fixtures/practice-consistency.mjs');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  try {
    await verifyPracticeConsistency(pool, (sql, values) => admin.query(sql, values));
  } finally {
    await pool.end();
    await admin.end();
  }
});
