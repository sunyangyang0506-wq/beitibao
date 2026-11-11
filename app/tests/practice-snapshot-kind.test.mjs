import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../dist/server/app.js';
import { processNextSolution } from '../dist/server/model-solution.js';

test('does not grade an older draft with a model answer for a changed question kind', async () => {
  const origin = 'https://practice-snapshot.example.test';
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const worker = new pg.Pool({ connectionString: process.env.LOCAL_PAPER_WORKER_DATABASE_URL });
  const app = await createApp({ pool, origin, localPapers: true });
  const [tenant, course, paper, question] = Array.from({ length: 4 }, () => randomUUID());
  const token = randomBytes(32).toString('base64url');
  const sha = value => createHash('sha256').update(value).digest('hex');
  const headers = { origin, cookie: 'beitibao_session=' + token, 'x-csrf-token': sha('csrf:' + token) };
  const practice = '/api/v1/papers/' + paper + '/practice';
  async function post(url, payload) {
    const result = await app.inject({ method: 'POST', url, headers, payload });
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  }
  try {
    await admin.query('INSERT INTO accounts (id,email,password_hash) VALUES ($1,$2,$3)', [tenant, tenant + '@example.test', 'synthetic']);
    await admin.query("INSERT INTO sessions (token_hash,account_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [sha(token), tenant]);
    await admin.query("INSERT INTO courses (tenant_id,id,name,term) VALUES ($1,$2,'Synthetic','2026')", [tenant, course]);
    await admin.query(`INSERT INTO papers (tenant_id,id,course_id,title,fingerprint,pdf,status,pages)
      VALUES ($1,$2,$3,'Synthetic',$2::uuid::text,$4,'review','["Synthetic text"]')`, [tenant, paper, course, Buffer.alloc(0)]);
    await admin.query(`INSERT INTO paper_questions (tenant_id,id,paper_id,page_number,fingerprint,stem,question_kind)
      VALUES ($1,$2,$3,1,$2::uuid::text,'Explain which structure to use.','short_answer')`, [tenant, question, paper]);

    const draft = await post(practice, {});
    assert.equal(draft.questions[0].kind, 'short_answer');
    await post('/api/v1/papers/' + paper + '/questions/' + question + '/kind', { kind: 'choice' });
    assert.equal(await processNextSolution(worker, async (_stem, _request, _image, _text, _unused, kind) => {
      assert.equal(kind, 'choice');
      return { status: 'solved', answer: 'B', explanation: 'Answer for the revised choice format.' };
    }, undefined, { tenant, id: question }), true);

    const old = await post(practice + '/save', { revision: draft.revision, changes: { [question]: 'B' }, submit: true });
    assert.equal(old.questions[0].result, 'needs_review');
    assert.equal(old.questions[0].modelSolution, null);
    const retry = await post(practice, {});
    assert.equal(retry.questions[0].kind, 'choice');
    const current = await post(practice + '/save', { revision: retry.revision, changes: { [question]: 'B' }, submit: true });
    assert.equal(current.questions[0].result, 'correct');
  } finally {
    await app.close();
    await Promise.all([pool.end(), admin.end(), worker.end()]);
  }
});
