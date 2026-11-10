import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import { modelRequest } from '../dist/server/model-gateway.js';

const endpoint = 'https://synthetic-workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions';
const plus = 'qwen-plus-2025-12-01';
const keys = ['BAILIAN_WORKSPACE_ID', 'BAILIAN_DAILY_BUDGET_CENTS', 'BAILIAN_TENANT_DAILY_BUDGET_CENTS', 'BAILIAN_MODEL_LIMITS_JSON'];
let previous;
beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.BAILIAN_WORKSPACE_ID = 'synthetic-workspace';
  process.env.BAILIAN_DAILY_BUDGET_CENTS = '100';
  process.env.BAILIAN_TENANT_DAILY_BUDGET_CENTS = '100';
  delete process.env.BAILIAN_MODEL_LIMITS_JSON;
});
afterEach(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

// Query-level unit fixture, not a substitute for the PostgreSQL transaction suite.
function recorder({ siteUsed = 0, tenantUsed = 0 } = {}) {
  const statements = [];
  let held = 0;
  const db = { release() {}, async query(sql, params = []) {
    statements.push({ sql, params });
    if (sql.includes('AS day')) return { rows: [{ day: '2026-11-10' }] };
    if (sql.includes('RETURNING warned')) return { rows: siteUsed + params[1] <= params[2] ? [{ warned: true, used: String(siteUsed + params[1]) }] : [] };
    if (sql.includes('UPDATE model_tenant_days SET held_micros = held_micros +')) return { rows: [], rowCount: tenantUsed + params[2] <= params[3] ? 1 : 0 };
    if (sql.includes('INSERT INTO model_invocations')) held = params[5];
    if (sql.includes("state = 'reserved'")) return { rows: [{ day: '2026-11-10', held: String(held) }] };
    return { rows: [], rowCount: 1 };
  } };
  return { pool: { async connect() { return db; } }, statements };
}
const options = body => ({ method: 'POST', body: JSON.stringify({ model: plus, max_tokens: 160, ...body }) });
const reservation = fixture => fixture.statements.find(row => row.sql.includes('INSERT INTO model_invocations')).params[5];
const settlement = fixture => fixture.statements.find(row => row.sql.includes('UPDATE model_invocations')).params;

test('Plus uses the request mode for both reservation and all measured output, without double counting reasoning', async () => {
  for (const [body, held, spent] of [
    [{ enable_thinking: true, thinking_budget: 1200 }, 36480, 1680],
    [{ enable_thinking: false }, 25920, 480],
    [{}, 25920, 480]
  ]) {
    const fixture = recorder();
    const responseBody = { usage: { prompt_tokens: 100, completion_tokens: 200,
      completion_tokens_details: { reasoning_tokens: body.enable_thinking ? 120 : 0 } } };
    const response = await modelRequest(fixture.pool, 'tenant', 'solution', async () => Response.json(responseBody))(endpoint, options(body));
    assert.equal(reservation(fixture), held);
    assert.deepEqual(settlement(fixture).slice(2, 6), ['metered', spent, 100, 200]);
    assert.deepEqual(await response.json(), responseBody, 'metering must not consume the caller response');
    const releases = fixture.statements.filter(row => row.sql.includes('held_micros = held_micros -'));
    assert.equal(releases.length, 2);
    assert.deepEqual(releases[0].params.slice(1), [String(held), spent]);
    assert.deepEqual(releases[1].params.slice(2), [String(held), spent]);
  }
});

test('the existing solution and prediction request shapes reserve the full thinking output price', async () => {
  for (const [task, max_tokens, held] of [['solution', 3400, 65600], ['prediction', 700, 44000]]) {
    const fixture = recorder();
    await modelRequest(fixture.pool, 'tenant', task, async () => Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }))(
      endpoint, options({ max_tokens, enable_thinking: true, thinking_budget: 1600 }));
    assert.equal(reservation(fixture), held);
    assert.equal(settlement(fixture)[3], 9, 'fractional micro-CNY rounds upward');
  }
});

test('corrected holds block calls at site, tenant and prediction thresholds before the provider', async () => {
  for (const [site, tenant, task, max_tokens] of [[6, 100, 'solution', 3400], [100, 6, 'solution', 3400], [5, 100, 'prediction', 700]]) {
    process.env.BAILIAN_DAILY_BUDGET_CENTS = String(site);
    process.env.BAILIAN_TENANT_DAILY_BUDGET_CENTS = String(tenant);
    const fixture = recorder();
    let calls = 0;
    await assert.rejects(modelRequest(fixture.pool, 'tenant', task, async () => { calls++; throw new Error('must not call'); })(
      endpoint, options({ max_tokens, enable_thinking: true, thinking_budget: 1600 })), /MODEL_BUDGET_LIMIT/);
    assert.equal(calls, 0);
    assert.equal(fixture.statements.some(row => row.sql.includes('INSERT INTO model_invocations')), false);
    assert.equal(fixture.statements.at(-1).sql, 'ROLLBACK');
  }
});

test('the exact corrected budget boundary is admitted and one extra micro-CNY is blocked', async () => {
  process.env.BAILIAN_DAILY_BUDGET_CENTS = '6';
  process.env.BAILIAN_TENANT_DAILY_BUDGET_CENTS = '6';
  for (const used of [{}, { siteUsed: 1 }, { tenantUsed: 1 }]) {
    const fixture = recorder(used);
    let calls = 0;
    const result = modelRequest(fixture.pool, 'tenant', 'solution', async () => {
      calls++;
      return Response.json({ usage: { prompt_tokens: 0, completion_tokens: 0 } });
    })(endpoint, options({ max_tokens: 3000, enable_thinking: true, thinking_budget: 1300 }));
    if (!Object.keys(used).length) { await result; assert.equal(reservation(fixture), 60000); assert.equal(calls, 1); }
    else { await assert.rejects(result, /MODEL_BUDGET_LIMIT/); assert.equal(calls, 0); }
  }
});

test('unknown Plus usage and timeouts retain the corrected hold; trusted 402 usage still charges at the selected rate', async () => {
  const requestOptions = options({ enable_thinking: true, thinking_budget: 1200 });
  for (const body of [{}, { usage: { prompt_tokens: 100 } }, { usage: { prompt_tokens: 32001, completion_tokens: 200 } }]) {
    const fixture = recorder();
    await modelRequest(fixture.pool, 'tenant', 'solution', async () => Response.json(body))(endpoint, requestOptions);
    assert.equal(reservation(fixture), 36480);
    assert.equal(settlement(fixture)[2], 'unknown');
    assert.equal(fixture.statements.some(row => row.sql.includes('held_micros = held_micros -')), false);
  }
  const timed = recorder();
  await assert.rejects(modelRequest(timed.pool, 'tenant', 'solution', async () => { throw new Error('timeout'); })(endpoint, requestOptions), /timeout/);
  assert.equal(reservation(timed), 36480);
  assert.equal(settlement(timed)[2], 'unknown');
  assert.equal(timed.statements.some(row => row.sql.includes('held_micros = held_micros -')), false);
  const metered = recorder();
  await modelRequest(metered.pool, 'tenant', 'solution', async () => Response.json({ usage: { prompt_tokens: 100, completion_tokens: 200 } }, { status: 402 }))(endpoint, requestOptions);
  assert.deepEqual(settlement(metered).slice(2, 4), ['metered', 1680]);
});

test('ambiguous thinking modes and invalid thinking budgets fail before reservation or provider calls', async () => {
  for (const body of [
    ...['true', 'false', 1, 0, null, {}].map(enable_thinking => ({ enable_thinking, thinking_budget: 1200 })),
    ...[undefined, 0, -1, 2049, 1.5, '1200'].map(thinking_budget => ({ enable_thinking: true, thinking_budget }))
  ]) {
    const fixture = recorder();
    await assert.rejects(modelRequest(fixture.pool, 'tenant', 'solution', async () => { assert.fail('must not call'); })(endpoint, options(body)), /INVALID_MODEL_REQUEST/);
    assert.equal(fixture.statements.length, 0);
  }
});

test('non-Plus model rates are unchanged for the existing non-thinking callers', async () => {
  for (const [model, held, spent] of [
    ['qwen-flash-2025-07-28', 4950, 32],
    ['qwen3.5-flash-2026-02-23', 6600, 42],
    ['qwen3-vl-plus', 33000, 210]
  ]) {
    const fixture = recorder();
    await modelRequest(fixture.pool, 'tenant', 'page', async () => Response.json({ usage: { prompt_tokens: 10, completion_tokens: 20 } }))(
      endpoint, options({ model, max_tokens: 100, enable_thinking: false }));
    assert.equal(reservation(fixture), held);
    assert.equal(settlement(fixture)[3], spent);
  }
});
