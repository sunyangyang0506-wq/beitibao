import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createApp } from '../dist/server/app.js';
import { processNextPaper } from '../dist/server/paper-worker.js';
import { processNextPrediction } from '../dist/server/predictions.js';
import { minimumPaperQuestions, predictionVersion } from '../dist/server/prediction-model.js';

const argument = name => process.argv.find(value => value.startsWith('--' + name + '='))?.split('=', 2)[1];
const subjectId = argument('subject') ?? 'data-structures';
const subject = { 'data-structures': '数据结构', 'linear-algebra': '线性代数' }[subjectId];
const report = argument('report') ?? 'prediction-live-results.json';
if (!subject || !/^prediction-[a-z0-9-]+\.json$/.test(report)) throw new Error('INVALID_EVALUATION_OPTIONS');

const origin = 'http://127.0.0.1:5173';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const worker = new pg.Pool({ connectionString: process.env.LOCAL_PAPER_WORKER_DATABASE_URL });
const app = await createApp({ pool, origin, localPapers: true });
const result = { startedAt: new Date().toISOString(), source: 'project synthetic exam papers', subject, predictionVersion };
let auth;
const json = async url => JSON.parse(await readFile(url, 'utf8'));
async function api(method, path, payload, status = 200) {
  const response = await app.inject({
    method, url: '/api/v1' + path, payload,
    headers: { origin, ...auth, ...(Buffer.isBuffer(payload) && { 'content-type': 'application/pdf' }) }
  });
  assert.equal(response.statusCode, status, method + ' ' + path + ' ' + response.body);
  return response;
}

try {
  const email = 'prediction-live@example.test';
  const invite = randomBytes(32).toString('base64url');
  await admin.query("INSERT INTO invitations (token_hash, email, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [createHash('sha256').update(invite).digest('hex'), email]);
  const signup = await api('POST', '/auth/register', { email, invite, password: randomBytes(24).toString('hex') }, 201);
  auth = { cookie: signup.headers['set-cookie'].split(';')[0], 'x-csrf-token': signup.json().csrfToken };
  const course = (await api('POST', '/courses', { name: subject, term: '合成预测验证' }, 201)).json().course;
  const corpus = new URL('./subject-corpus/test/', import.meta.url);
  const { papers } = await json(new URL('manifest.json', corpus));
  const { questions } = await json(new URL('gold.json', corpus));
  const sourcePapers = papers.filter(paper => paper.subjectId === subjectId).slice(0, 1)
    .map(paper => ({ ...paper, file: new URL(paper.file, corpus) }));
  for (const split of ['development', 'evaluation']) {
    const { papers: examples, questions: labels } = await json(new URL(`./data/${split}.json`, import.meta.url));
    const example = examples.find(paper => paper.subject === subject);
    sourcePapers.push({ ...example, title: subject + (split === 'development' ? ' 合成开发卷' : ' 合成评测卷'),
      file: new URL('./papers/' + example.file, import.meta.url) });
    questions.push(...labels.filter(question => question.paperId === example.id));
  }
  const kinds = { choice: 'choice', numeric: 'calculation', subjective: 'short_answer' };
  const sources = new Map();
  for (const paper of sourcePapers) {
    const bytes = await readFile(paper.file);
    if (paper.sha256) assert.equal(createHash('sha256').update(bytes).digest('hex'), paper.sha256);
    const upload = (await api('POST', '/courses/' + course.id + '/papers?' + new URLSearchParams({ title: paper.title }), bytes, 202)).json().paper;
    assert.equal(await processNextPaper(worker), true);
    for (const question of questions.filter(item => item.paperId === paper.id)) {
      const route = '/papers/' + upload.id + '/questions';
      const saved = (await api('POST', route, { pageNumber: question.page, stem: question.prompt }, 201)).json();
      await api('POST', route + '/' + saved.id + '/kind', { kind: kinds[question.kind] });
      sources.set(saved.id, question.prompt);
    }
  }

  const path = '/courses/' + course.id + '/prediction';
  const before = (await api('GET', '/progress')).json().courses[0];
  const planned = (await api('GET', path)).json().targetQuestions;
  assert.ok(planned >= minimumPaperQuestions, 'This fixture must exercise a complete prediction paper');
  const requests = await Promise.all([api('POST', path, {}), api('POST', path, {})]);
  assert.equal(requests[0].json().id, requests[1].json().id);
  assert.equal(await processNextPrediction(worker), true);
  const info = (await api('GET', path)).json();
  const {rows:[job]} = await admin.query('SELECT model_calls FROM predictions WHERE id = $1', [info.prediction.id]);
  const { rows: usage } = await admin.query(`
    SELECT model, state, input_tokens AS "inputTokens", output_tokens AS "outputTokens",
      spent_micros AS "spentMicros", request_id AS "requestId"
    FROM model_invocations WHERE task = 'prediction' ORDER BY created_at
  `);
  Object.assign(result, { ...info, calls: job.model_calls, usage });
  assert.equal(info.prediction.status, 'ready', info.prediction.failure ?? 'PREDICTION_NOT_READY');
  assert.equal(info.available, sources.size);
  assert.equal(info.sourcePapers, sourcePapers.length);
  const metered = usage.filter(item => item.state === 'metered');
  assert.ok(metered.length && metered.every(item => item.requestId));
  assert.deepEqual(new Set(usage.map(item => item.requestId).filter(Boolean)),
    new Set(result.calls.map(item => item.requestId).filter(Boolean)));
  result.usageCoverage = { metered: metered.length, unmetered: usage.length - metered.length };
  const practice = '/papers/' + info.prediction.paperId + '/practice';
  const attempt = (await api('POST', practice, {})).json();
  assert.equal(attempt.questions.length, planned);
  assert.equal(attempt.questions.length, info.prediction.questionCount);
  assert.ok(attempt.questions.every(question => !('reference' in question) && !('modelSolution' in question)));
  const reveal = '/papers/' + info.prediction.paperId + '/questions/' + attempt.questions[0].id + '/reveal';
  assert.equal((await api('POST', reveal, {}, 409)).json().code, 'CLOSED_BOOK_ACTIVE');
  const answers = Object.fromEntries(attempt.questions.map(question => [question.id, '本次验证用的空答案占位']));
  const finished = (await api('POST', practice + '/save', { revision: attempt.revision, answers, submit: true })).json();
  assert.ok(finished.submittedAt);
  result.questions = finished.questions.map(question => {
    assert.ok(question.modelSolution.evidence.length > 0);
    assert.ok(question.modelSolution.evidence.every(item => sources.get(item.id) === item.stem));
    return { stem: question.stem, model: question.modelSolution.model, answer: question.modelSolution.answer,
      explanation: question.modelSolution.explanation, rationale: question.modelSolution.rationale,
      sourceStems: question.modelSolution.evidence.map(item => item.stem) };
  });
  const after = (await api('GET', '/progress')).json().courses[0];
  for (const field of ['totalPapers', 'completedPapers', 'remainingPapers']) assert.equal(after[field], before[field]);
  assert.equal((await api('POST', path, {})).json().paperId, info.prediction.paperId);
  assert.equal(await processNextPrediction(worker), false);
  result.verified = { requestsCoalesced: true, blindPractice: true, evidenceBelongsToCourse: true,
    originalProgressUnchanged: true, duplicateRequestReusesPaper: true };
} finally {
  result.finishedAt = new Date().toISOString();
  await writeFile(new URL('./' + report, import.meta.url), JSON.stringify(result, null, 2) + '\n');
  await app.close();
  await Promise.all([pool.end(), admin.end(), worker.end()]);
}
console.log(JSON.stringify({ prediction: result.prediction.status, questions: result.questions.length, calls: result.calls }));
