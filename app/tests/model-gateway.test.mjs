import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { modelRequest } from '../dist/server/model-gateway.js';

test('enforces the prediction budget under concurrent calls and keeps uncertain charges reserved', async () => {
  const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  process.env.BAILIAN_WORKSPACE_ID = 'synthetic-workspace';
  process.env.BAILIAN_DAILY_BUDGET_CENTS = '9';
  process.env.BAILIAN_TENANT_DAILY_BUDGET_CENTS = '9';
  const endpoint = 'https://synthetic-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
  const options = { method: 'POST', body: JSON.stringify({
    model: 'qwen-plus-2025-12-01', max_tokens: 160, enable_thinking: true, thinking_budget: 1200
  }) };
  const hold = 28320;
  const release = Promise.withResolvers();
  const called = Promise.withResolvers();
  let count = 0;
  try {
    const { rows: [{ id: tenant }] } = await admin.query(
      "INSERT INTO accounts (email, password_hash) VALUES ('model-budget@example.test', 'stub') RETURNING id"
    );
    const request = modelRequest(pool, tenant, 'prediction', async () => {
      const index = ++count;
      if (count === 2) called.resolve();
      await release.promise;
      if (index === 2) throw new DOMException('simulated timeout', 'TimeoutError');
      return Response.json({ id: 'request-metered', usage: { prompt_tokens: 100, completion_tokens: 200 } });
    });
    const first = request(endpoint, options);
    const second = request(endpoint, options);
    const settlements = Promise.allSettled([first, second]);
    await called.promise;
    try {
      await assert.rejects(request(endpoint, options), /MODEL_BUDGET_LIMIT/);
      assert.equal(count, 2);
    } finally { release.resolve(); }
    assert.deepEqual((await settlements).map(item => item.status).sort(), ['fulfilled', 'rejected']);
    const { rows } = await admin.query(
      "SELECT state, held_micros, spent_micros, request_id FROM model_invocations WHERE tenant_id=$1 ORDER BY state", [tenant]);
    assert.deepEqual(rows, [
      { state: 'metered', held_micros: String(hold), spent_micros: '480', request_id: 'request-metered' },
      { state: 'unknown', held_micros: String(hold), spent_micros: '0', request_id: null }
    ]);
    const { rows: [budget] } = await admin.query('SELECT held_micros, spent_micros FROM model_budget_days');
    assert.deepEqual(budget, { held_micros: String(hold), spent_micros: '480' });
    assert.equal((await pool.query('SELECT id FROM model_invocations')).rowCount, 0);

    const reject = modelRequest(pool, tenant, 'paper', async () => Response.json({}, { status: 429 }));
    assert.equal((await reject(endpoint, options)).status, 429);
    assert.deepEqual((await admin.query('SELECT held_micros, spent_micros FROM model_budget_days')).rows[0], budget);
    await assert.rejects(request('https://example.test/', options), /INVALID_MODEL_REQUEST/);
    await assert.rejects(request(endpoint, { ...options, body: JSON.stringify({ model: 'qwen-plus-2025-12-01', max_tokens: 160, enable_thinking: true }) }),
      /INVALID_MODEL_REQUEST/);
  } finally {
    release.resolve();
    await Promise.all([admin.end(), pool.end()]);
  }
});

test('shares the rolling model quota across tenants before calling the provider', async () => {
  const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const previous = process.env.BAILIAN_MODEL_LIMITS_JSON;
  const models = ['qwen-flash-2025-07-28', 'qwen-plus-2025-12-01', 'qwen3.5-flash-2026-02-23', 'qwen3-vl-plus'];
  process.env.BAILIAN_MODEL_LIMITS_JSON = JSON.stringify(Object.fromEntries(models.map(model => [model, { rpm: 3, tpm: 50_000 }])));
  let calls = 0;
  try {
    const { rows } = await admin.query(`
      INSERT INTO accounts (email, password_hash) VALUES ('quota-a@example.test', 'stub'), ('quota-b@example.test', 'stub')
      RETURNING id
    `);
    const endpoint = 'https://synthetic-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
    const options = { method: 'POST', body: JSON.stringify({ model: models[0], max_tokens: 160 }) };
    const results = await Promise.allSettled(rows.map(({ id }) => modelRequest(pool, id, 'solution', async () => {
      calls++;
      return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 10 } });
    })(endpoint, options)));
    assert.equal(calls, 1);
    assert.match(results.find(result => result.status === 'rejected').reason.message, /MODEL_RATE_LIMIT/);
  } finally {
    if (previous === undefined) delete process.env.BAILIAN_MODEL_LIMITS_JSON;
    else process.env.BAILIAN_MODEL_LIMITS_JSON = previous;
    await Promise.all([admin.end(), pool.end()]);
  }
});
