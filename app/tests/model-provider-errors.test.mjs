import { samplePaper } from './fixtures/sample-paper.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelProviderFailure } from '../dist/server/model-provider-errors.js';
import { solveQuestion, processNextSolution } from '../dist/server/model-solution.js';
import { generatePrediction, blindCheck } from '../dist/server/prediction-model.js';

const configure = () => {
  process.env.BAILIAN_WORKSPACE_ID = 'synthetic-workspace';
  process.env.DASHSCOPE_API_KEY = 'stub';
};
const failures = [
  [401, { error: { code: 'InvalidApiKey', message: 'secret must not escape' } }, 'MODEL_AUTHENTICATION_FAILED'],
  [403, { error: { code: 'AccessDenied.Unpurchased' } }, 'MODEL_SERVICE_NOT_ENABLED'],
  [403, { code: 'Arrearage' }, 'MODEL_PAYMENT_REQUIRED'],
  [400, { error: { code: 'Arrearage' } }, 'MODEL_PAYMENT_REQUIRED'],
  [402, {}, 'MODEL_PAYMENT_REQUIRED'],
  [403, {}, 'MODEL_ACCESS_DENIED'],
];
const evidence = Array.from({ length: 9 }, (_, index) => ({ id: String(index), stem: ['栈','队列','链表','二叉树','积分','导数','矩阵','向量','概率'][index], kind: 'calculation', paperId: 'p', title: 'synthetic', page: 1 }));

test('provider errors retain safe operational codes instead of becoming quality failures', async () => {
  configure();
  for (const [status, body, expected] of failures) {
    assert.equal(modelProviderFailure(status, body), expected);
    await assert.rejects(solveQuestion('求值', async () => Response.json(body, { status })), { message: expected });
    let calls = 0;
    const records = [];
    await assert.rejects(generatePrediction(evidence, async () => {
      calls++;
      return Response.json(body, { status });
    }, record => records.push(record)), { message: expected });
    // Five concurrent calls may already be in flight. No retry or next slot.
    assert.equal(calls, 5);
    assert.equal(records.length, 5);
    assert.ok(records.every(record => record.httpStatus === status && record.outcome === 'provider_error'));
    assert.ok(!JSON.stringify(records).includes('secret'));
  }
});

test('non-JSON access denial is terminal in solution, generation and blind checking', async () => {
  configure();
  const denied = async () => new Response('<html>denied</html>', { status: 403 });
  await assert.rejects(solveQuestion('test', denied), /MODEL_ACCESS_DENIED/);
  await assert.rejects(generatePrediction(evidence, denied), /MODEL_ACCESS_DENIED/);
  await assert.rejects(blindCheck('https://example.test/', { stem: 'test', answer: '1', kind: 'calculation' }, denied, () => {}), /MODEL_ACCESS_DENIED/);
});

test('solution worker persists terminal reason and never escalates a PDF to vision', async () => {
  for (const [, , expected] of failures) {
    let calls = 0;
    let update;
    const pool = { async query(sql, params) {
      if (sql.includes('WITH next')) return { rows: [{ tenant_id: 'tenant', id: 'question', stem: 'A.一 B.二 C.三 D.四', input_revision: 1, question_kind: 'choice', cache_key: null, source_pages: [], solution_attempt_count: 1 }] };
      if (sql.includes('SELECT pdf')) return { rows: [{ media_type: 'application/pdf', pages: ['题干'] }] };
      if (sql.includes('UPDATE paper_questions')) { update = params; return { rows: [] }; }
      throw new Error('Unexpected DB operation');
    } };
    await processNextSolution(pool, async () => { calls++; throw new Error(expected); });
    assert.equal(calls, 1);
    assert.equal(update[3], 'failed');
    assert.equal(update[4], null);
    assert.equal(update[5], expected);
  }
});

test('provider classifications do not change ordinary overload or server error policy', async () => {
  configure();
  assert.equal(modelProviderFailure(200, { code: 'Arrearage' }), null);
  assert.equal(modelProviderFailure(429, {}), null);
  assert.equal(modelProviderFailure(503, {}), null);
  await assert.rejects(solveQuestion('test', async () => Response.json({}, { status: 429 })), /MODEL_RATE_LIMIT/);
  await assert.rejects(solveQuestion('test', async () => Response.json({}, { status: 503 })), /MODEL_REQUEST_FAILED/);
});

const ok = value => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] });
const inputOf = options => JSON.parse(JSON.parse(options.body).messages.at(-1).content.split('\n').at(-1));
const generated = input => ({ stem: `已知${input.evidence.stem}样例，请计算指定结果。`, answer: '9', explanation: '依据定义推导。', rationale: '保留核心考点改变条件。', knowledgePoints: ['基本计算'] });

test('terminal denial at blind or verification stage stops regeneration', async () => {
  configure();
  for (const deniedStage of ['blind', 'verification']) {
    let calls = 0;
    const records = [];
    await assert.rejects(generatePrediction(evidence, async (_url, options) => {
      calls++;
      const input = inputOf(options);
      const stage = input.evidence ? 'generation' : input.proposedAnswer ? 'verification' : 'blind';
      if (stage === deniedStage) return Response.json({ code: 'Arrearage' }, { status: 403 });
      return ok(stage === 'generation' ? generated(input) : { solvable: true, answer: '9' });
    }, record => records.push(record)), /MODEL_PAYMENT_REQUIRED/);
    assert.equal(calls, deniedStage === 'blind' ? 10 : 15);
    assert.equal(records.filter(call => call.stage === 'generation').length, 5);
  }
});

test('an in-flight successful generation cannot launch its next stage after denial', async () => {
  configure();
  const pending = [];
  const records = [];
  let calls = 0;
  const result = generatePrediction(evidence, async (_url, options) => {
    calls++;
    const input = inputOf(options);
    if (calls === 1) return Response.json({}, { status: 401 });
    return new Promise(resolve => pending.push(() => resolve(ok(generated(input)))));
  }, record => records.push(record));
  // Let the rejection from the first call reach the shared stop flag.
  await new Promise(resolve => setImmediate(resolve));
  pending.forEach(resolve => resolve());
  await assert.rejects(result, /MODEL_AUTHENTICATION_FAILED/);
  assert.equal(calls, 5);
  assert.equal(records.length, calls);
  assert.ok(records.every(record => record.stage === 'generation')); 
});


test('terminal visual error clears an earlier insufficient-evidence solution', async () => {
  for (const expected of ['MODEL_AUTHENTICATION_FAILED', 'MODEL_PAYMENT_REQUIRED', 'MODEL_SERVICE_NOT_ENABLED']) {
    let calls = 0;
    let update;
    const pool = { async query(sql, params) {
      if (sql.includes('WITH next')) return { rows: [{ tenant_id: 'tenant', id: 'question', stem: 'A.一 B.二 C.三 D.四', input_revision: 1, question_kind: 'choice', cache_key: null, source_pages: [], page_number: 1, solution_attempt_count: 1 }] };
      if (sql.includes('SELECT pdf')) return { rows: [{ media_type: 'application/pdf', pdf: samplePaper(), pages: ['题干'] }] };
      if (sql.includes('UPDATE paper_questions')) { update = params; return { rows: [] }; }
      throw new Error('Unexpected DB operation');
    } };
    await processNextSolution(pool, async () => {
      if (++calls === 1) return { status: 'insufficient_evidence', answer: '', explanation: '待核对', model: 'stub', promptVersion: 'stub', knowledgePoints: [], designLogic: '' };
      throw new Error(expected);
    });
    assert.equal(calls, 2);
    assert.equal(update[3], 'failed');
    assert.equal(update[4], null);
    assert.equal(update[5], expected);
  }
});
