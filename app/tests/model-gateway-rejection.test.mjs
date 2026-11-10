import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelRequest } from '../dist/server/model-gateway.js';

// Exercises reserve and settle control flow with an in-memory query recorder.
// Native PostgreSQL transactional semantics are covered by the separate DB suite.
function recorder() {
  const statements = [];
  const db = { release() {}, async query(sql, params = []) {
    statements.push({ sql, params });
    if (sql.includes('AS day')) return { rows: [{ day: '2026-11-10' }] };
    if (sql.includes('RETURNING warned')) return { rows: [{ warned: true, used: '100' }] };
    if (sql.includes("state = 'reserved'")) return { rows: [{ day: '2026-11-10', held: '100' }] };
    return { rows: [], rowCount: 1 };
  } };
  return { pool: { async connect() { return db; } }, statements };
}

test('non-JSON 402, timeouts and 5xx retain holds; known HTTP rejections keep existing handling', async () => {
  process.env.BAILIAN_WORKSPACE_ID = 'synthetic-workspace';
  delete process.env.BAILIAN_MODEL_LIMITS_JSON;
  const endpoint = 'https://synthetic-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
  const options = { method: 'POST', body: JSON.stringify({ model: 'qwen-flash-2025-07-28', max_tokens: 100 }) };
  for (const status of [400, 401, 402, 403, 429, 500, 503]) {
    const { pool, statements } = recorder();
    const result = await modelRequest(pool, 'tenant', 'solution', async () => new Response('not JSON', { status }))(endpoint, options);
    assert.equal(result.status, status);
    const settled = statements.find(row => row.sql.includes('UPDATE model_invocations'));
    const rejected = status < 500 && status !== 402;
    assert.equal(settled.params[2], rejected ? 'rejected' : 'unknown');
    assert.equal(settled.params[3], 0);
    assert.equal(statements.filter(row => row.sql.includes('held_micros = held_micros -')).length, rejected ? 2 : 0);
  }
  const timed = recorder();
  await assert.rejects(modelRequest(timed.pool, 'tenant', 'solution', async () => {
    throw new DOMException('synthetic timeout', 'TimeoutError');
  })(endpoint, options), { name: 'TimeoutError' });
  assert.equal(timed.statements.find(row => row.sql.includes('UPDATE model_invocations')).params[2], 'unknown');
  assert.equal(timed.statements.filter(row => row.sql.includes('held_micros = held_micros -')).length, 0);
});

test('402 with measured usage remains metered rather than erasing actual cost', async () => {
  const { pool, statements } = recorder();
  const options = { method: 'POST', body: JSON.stringify({ model: 'qwen-flash-2025-07-28', max_tokens: 100 }) };
  await modelRequest(pool, 'tenant', 'solution', async () => Response.json({ usage: { prompt_tokens: 10, completion_tokens: 20 } }, { status: 402 }))('https://synthetic-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions', options);
  const settled = statements.find(row => row.sql.includes('UPDATE model_invocations'));
  assert.equal(settled.params[2], 'metered');
  assert.equal(settled.params[3], 32);
});


test('402 releases holds only for explicit pre-call billing rejection without usage', async () => {
  const endpoint = 'https://synthetic-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
  const options = { method: 'POST', body: JSON.stringify({ model: 'qwen-flash-2025-07-28', max_tokens: 100 }) };
  const bodies = [
    [{ code: 'Arrearage' }, 'rejected'],
    [{ error: { code: 'InsufficientBalance' } }, 'rejected'],
    [{}, 'unknown'],
    [{ code: 'UnrecognizedProviderCode' }, 'unknown'],
    [{ code: 'Arrearage', usage: null }, 'unknown'],
    [{ code: 'Arrearage', usage: {} }, 'unknown'],
    [{ code: 'Arrearage', usage: { prompt_tokens: 123 } }, 'unknown'],
    [{ code: 'Arrearage', usage: { prompt_tokens: 123, completion_tokens: '10' } }, 'unknown'],
    [{ code: 'Arrearage', usage: { prompt_tokens: 2000001, completion_tokens: 10 } }, 'unknown'],
    [{ code: 'Arrearage', usage: { prompt_tokens: -1, completion_tokens: 10 } }, 'unknown'],
    [{ code: 'Arrearage', usage: { prompt_tokens: 123, completion_tokens: 2000001 } }, 'unknown'],
    [{ code: 'Arrearage', usage: { prompt_tokens: 32001, completion_tokens: 10 } }, 'unknown'],
  ];
  for (const [body, expected] of bodies) {
    const { pool, statements } = recorder();
    await modelRequest(pool, 'tenant', 'solution', async () => Response.json(body, { status: 402 }))(endpoint, options);
    const settled = statements.find(row => row.sql.includes('UPDATE model_invocations'));
    assert.equal(settled.params[2], expected, JSON.stringify(body));
    assert.equal(statements.filter(row => row.sql.includes('held_micros = held_micros -')).length, expected === 'rejected' ? 2 : 0);
  }
  const { pool, statements } = recorder();
  // Simulated body-read failure, not a real provider call.
  await modelRequest(pool, 'tenant', 'solution', async () => ({ status: 402, clone() { return { async json() { throw new Error('stream interrupted'); } }; } }))(endpoint, options);
  assert.equal(statements.find(row => row.sql.includes('UPDATE model_invocations')).params[2], 'unknown');
  assert.equal(statements.filter(row => row.sql.includes('held_micros = held_micros -')).length, 0);
});
