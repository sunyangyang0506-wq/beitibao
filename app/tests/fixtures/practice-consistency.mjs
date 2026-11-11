import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../../dist/server/app.js';

// Shared by the PostgreSQL test suite and an optional isolated PGlite verification runner.
// All accounts, papers and answers are synthetic; no remote models or storage are used.
export async function verifyPracticeConsistency(pool, query) {
  const { rows: [permissions] } = await pool.query(`
    SELECT has_column_privilege(current_user, 'practice_results', 'solution_snapshots', 'UPDATE') AS snapshots,
      has_column_privilege(current_user, 'practice_results', 'graded', 'UPDATE') AS grades,
      has_column_privilege(current_user, 'practice_results', 'covered', 'UPDATE') AS coverage,
      has_column_privilege(current_user, 'practice_results', 'submitted_at', 'UPDATE') AS submission
  `);
  assert.deepEqual(permissions, { snapshots: true, grades: true, coverage: false, submission: false });
  const origin = 'https://practice-consistency.example.test';
  const app = await createApp({ pool, origin, localPapers: true, passwordRecovery: null });
  const tenant = randomUUID(), course = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sha = value => createHash('sha256').update(value).digest('hex');
  const teacherReference = { kind: 'choice', source: 'teacher', answers: ['A'], explanation: 'Teacher answer' };
  const originalSolution = { status: 'solved', answer: 'A', explanation: 'Original explanation', knowledgePoints: ['Original concept'] };
  await query('INSERT INTO accounts (id, email, password_hash) VALUES ($1,$2,$3)', [tenant, tenant + '@example.test', 'synthetic-not-a-password']);
  await query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1,$2,now()+interval '1 hour')", [sha(token), tenant]);
  await query('INSERT INTO courses (tenant_id,id,name,term) VALUES ($1,$2,$3,$4)', [tenant, course, 'Synthetic consistency', '2026']);
  async function request(method, path, payload, expected = 200) {
    const response = await app.inject({ method, url: '/api/v1' + path, payload,
      headers: { origin, cookie: 'beitibao_session=' + token, 'x-csrf-token': sha('csrf:' + token) } });
    assert.equal(response.statusCode, expected, path + ': ' + response.body);
    return response.json();
  }
  async function makePaper(names) {
    const paper = randomUUID();
    await query('INSERT INTO papers (tenant_id,id,course_id,title,fingerprint,pdf,status,pages) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [tenant, paper, course, 'Synthetic paper', paper, Buffer.alloc(0), 'review', JSON.stringify(['synthetic page'])]);
    const ids = {};
    for (const name of names) {
      ids[name] = randomUUID();
      await query(`INSERT INTO paper_questions (tenant_id,id,paper_id,page_number,fingerprint,stem,question_kind,solution_status,reference)
        VALUES ($1,$2,$3,1,$4,$5,'choice','queued',$6)`, [tenant, ids[name], paper, ids[name],
        name + ': Choose one. A. One B. Two C. Three D. Four', name === 'teacher' ? JSON.stringify(teacherReference) : null]);
    }
    return { paper, ids, path: '/papers/' + paper + '/practice' };
  }
  async function publish(id, solution = originalSolution) {
    await query("UPDATE paper_questions SET model_solution=$2,solution_status='ready' WHERE id=$1", [id, JSON.stringify(solution)]);
  }
  async function mistakes() { return (await request('GET', '/mistakes')).mistakes; }
  try {
    const { paper, ids, path } = await makePaper(['wrong', 'correct', 'unanswered', 'stem', 'visual', 'kind', 'reference', 'teacher']);
    const started = await request('POST', path, {});
    assert.ok(started.questions.every(item => !('modelSolution' in item) && !('reference' in item)));
    const answers = Object.fromEntries(Object.entries(ids).filter(([name]) => name !== 'unanswered').map(([name, id]) => [id, name === 'correct' ? 'A' : 'B']));
    const submitted = await request('POST', path + '/save', { revision: started.revision, changes: answers, submit: true });
    assert.equal(submitted.questions.find(item => item.id === ids.wrong).result, 'needs_review');
    const coverageBefore = (await query('SELECT covered FROM practice_results WHERE paper_id=$1', [paper])).rows[0].covered;
    for (const id of Object.values(ids)) await publish(id);
    await query("UPDATE paper_questions SET stem='Changed question' WHERE id=$1", [ids.stem]);
    await query("UPDATE paper_questions SET visual_review='Changed diagram' WHERE id=$1", [ids.visual]);
    await query("UPDATE paper_questions SET question_kind='short_answer' WHERE id=$1", [ids.kind]);
    await query('UPDATE paper_questions SET reference=$2 WHERE id=$1', [ids.reference, JSON.stringify(teacherReference)]);

    // A different account cannot read or reconcile this account's pending result.
    const otherTenant = randomUUID(), otherToken = randomBytes(32).toString('base64url');
    await query('INSERT INTO accounts (id, email, password_hash) VALUES ($1,$2,$3)', [otherTenant, otherTenant + '@example.test', 'synthetic-not-a-password']);
    await query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1,$2,now()+interval '1 hour')", [sha(otherToken), otherTenant]);
    const otherMistakes = await app.inject({ method: 'GET', url: '/api/v1/mistakes', headers: { origin, cookie: 'beitibao_session=' + otherToken } });
    assert.equal(otherMistakes.statusCode, 200, otherMistakes.body);
    assert.deepEqual(otherMistakes.json().mistakes, []);
    const untouched = (await query('SELECT graded, solution_snapshots FROM practice_results WHERE paper_id=$1', [paper])).rows[0];
    assert.equal(untouched.graded[ids.wrong], 'needs_review');
    assert.equal(untouched.solution_snapshots[ids.wrong].model_solution, null);

    // The first read after generation is the mistake list, not the results page.
    const firstMistakes = await mistakes();
    assert.deepEqual(firstMistakes.map(item => item.id).sort(), [ids.wrong, ids.teacher].sort());
    assert.equal(firstMistakes.find(item => item.id === ids.wrong).status, 'open');
    assert.deepEqual(firstMistakes.find(item => item.id === ids.wrong).knowledgePoints, ['Original concept']);
    const saved = (await query('SELECT graded, covered, solution_snapshots FROM practice_results WHERE paper_id=$1', [paper])).rows[0];
    assert.equal(saved.graded[ids.wrong], 'incorrect');
    assert.equal(saved.graded[ids.correct], 'correct');
    assert.equal(saved.graded[ids.unanswered], 'unanswered');
    assert.deepEqual(saved.covered, coverageBefore);
    for (const name of ['stem', 'visual', 'kind', 'reference']) assert.equal(saved.solution_snapshots[ids[name]].model_solution, null);
    const result = await request('GET', path);
    assert.equal(result.questions.find(item => item.id === ids.wrong).result, 'incorrect');
    assert.equal(result.questions.find(item => item.id === ids.correct).result, 'correct');

    // Idempotent successful retry is invalidated in the list after the source answer changes.
    const retryPath = '/mistakes/' + ids.wrong + '/retry';
    const retry = { attemptKey: randomUUID(), answer: 'A' };
    assert.equal((await request('POST', retryPath, retry)).result, 'correct');
    assert.equal((await request('POST', retryPath, retry)).result, 'correct');
    assert.equal((await query('SELECT 1 FROM mistake_retries WHERE question_id=$1', [ids.wrong])).rowCount, 1);
    assert.equal((await mistakes()).find(item => item.id === ids.wrong).status, 'resolved');
    await publish(ids.wrong, { ...originalSolution, explanation: 'New explanation', knowledgePoints: ['New concept'] });
    assert.equal((await mistakes()).find(item => item.id === ids.wrong).status, 'resolved');
    await publish(ids.wrong, { ...originalSolution, answer: 'B', knowledgePoints: ['New concept'] });
    const changed = (await mistakes()).find(item => item.id === ids.wrong);
    assert.equal(changed.status, 'needs_review');
    assert.equal(changed.reference.answers[0], 'A');
    assert.deepEqual(changed.knowledgePoints, ['Original concept']);
    assert.equal((await request('POST', retryPath, { attemptKey: randomUUID(), answer: 'B' })).result, 'needs_review');
    const historical = (await request('GET', path)).questions.find(item => item.id === ids.wrong);
    assert.equal(historical.modelSolution.answer, 'A');
    assert.equal(historical.result, 'incorrect');

    // An unchanged teacher answer still takes precedence over a changed model output.
    await publish(ids.teacher, { ...originalSolution, answer: 'B' });
    assert.equal((await mistakes()).find(item => item.id === ids.teacher).status, 'open');
    assert.equal((await request('POST', '/mistakes/' + ids.teacher + '/retry', { attemptKey: randomUUID(), answer: 'A' })).result, 'correct');
    await query('UPDATE paper_questions SET reference=$2 WHERE id=$1', [ids.teacher, JSON.stringify({ ...teacherReference, answers: ['B'] })]);
    assert.equal((await mistakes()).find(item => item.id === ids.teacher).status, 'needs_review');

    // Direct retry also reconciles a late answer, without opening either results or mistakes.
    const direct = await makePaper(['direct']);
    const opened = await request('POST', direct.path, {});
    await request('POST', direct.path + '/save', { revision: opened.revision, changes: { [direct.ids.direct]: 'B' }, submit: true });
    await publish(direct.ids.direct);
    assert.equal((await request('POST', '/mistakes/' + direct.ids.direct + '/retry', { attemptKey: randomUUID(), answer: 'A' })).result, 'correct');
    await request('POST', '/papers/' + direct.paper + '/questions/' + direct.ids.direct + '/stem-correction', { stem: 'A materially corrected question' });
    assert.equal((await mistakes()).find(item => item.id === direct.ids.direct).status, 'needs_review');

    // Unknown historical model evidence is never reconstructed from a newer source answer.
    await query('UPDATE question_recall SET stem_correction=NULL WHERE question_id=$1', [direct.ids.direct]);
    await query('UPDATE practice_results SET solution_snapshots=NULL WHERE paper_id=$1', [direct.paper]);
    const legacy = (await mistakes()).find(item => item.id === direct.ids.direct);
    assert.equal(legacy.status, 'needs_review');
    assert.equal(legacy.reference, null);
    const legacyRetry = await request('POST', '/mistakes/' + direct.ids.direct + '/retry', { attemptKey: randomUUID(), answer: 'A' });
    assert.equal(legacyRetry.result, 'needs_review');
    assert.equal(legacyRetry.reference, null);
    assert.equal((await request('GET', direct.path)).questions[0].legacySolutionUnavailable, true);
    return { cases: ['late-mistake-list', 'late-direct-retry', 'persisted-grades', 'immutable-history', 'unchanged-coverage',
      'changed-stem-visual-kind-reference', 'changed-model-answer', 'teacher-priority', 'retry-idempotency', 'legacy-snapshot', 'cross-account-read-and-reconciliation', 'least-privilege-result-update'] };
  } finally { await app.close(); }
}
