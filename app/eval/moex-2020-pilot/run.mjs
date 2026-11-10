import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createApp } from '../../dist/server/app.js';
import { runBusinessBatch } from '../../dist/server/release-jobs.js';

const filename = process.argv[2];
assert.match(filename ?? '', /^official-exam-2020-[a-z0-9-]+\.json$/u, 'Pass a fresh report filename');
const report = new URL(filename, import.meta.url);
assert.ok(!existsSync(report), 'The report already exists');
const source = await readFile(new URL('trial-question-pages.pdf', import.meta.url));
const inputSha256 = createHash('sha256').update(source).digest('hex');
assert.equal(inputSha256, '497b779fd1596cf3d8151b338b5c2623c01504963d1b06ad61401f5397744882');

const origin = 'https://beitibao-official-exam.example.test';
function connect(variable) {
  const connectionString = process.env[variable];
  assert.ok(connectionString && new URL(connectionString).searchParams.get('host')?.startsWith('/tmp/beitibao-pg.'),
    'Use the isolated database started by scripts/test-local.sh');
  return new pg.Pool({ connectionString });
}
const pool = connect('DATABASE_URL');
const admin = connect('MIGRATION_DATABASE_URL');
const workers = Object.fromEntries(['paper', 'page', 'solution'].map(lane => [lane, connect(`RELEASE_${lane.toUpperCase()}_DATABASE_URL`)]));
const objects = new Map();
const storage = {
  signUpload: key => ({ url: 'https://oss.example.test/', fields: { key } }),
  async read(object) {
    const stored = objects.get(object.key);
    return stored?.version === object.version ? stored.bytes : null;
  }
};
const settings = { storage, modelsEnabled: true, predictionsEnabled: false };
const app = await createApp({ pool, origin, pdfOnlyUploads: true, privatePapers: { ...settings, storage: () => storage } });
let auth = {};
async function call(method, path, payload, expected = 200) {
  const response = await app.inject({ method, url: '/api/v1' + path, payload, headers: { origin, ...auth } });
  if (expected) assert.equal(response.statusCode, expected, `${path} returned ${response.statusCode} ${response.json().code ?? ''}`);
  return response;
}
async function drain(lane, concurrency) {
  let count = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while ((await runBusinessBatch(workers[lane], lane, null, settings)).recovered) count++;
  }));
  return count;
}

const result = { source: 'MOEX 109090/1503/6452 question pages', inputSha256 };
try {
  const email = 'official-exam-pilot@example.test';
  const invite = randomBytes(32).toString('base64url');
  await admin.query("INSERT INTO invitations (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [email, createHash('sha256').update(invite).digest('hex')]);
  const signup = await call('POST', '/auth/register', { email, invite, password: 'isolated evaluation password' }, 201);
  auth = { cookie: signup.headers['set-cookie'].split(';')[0], 'x-csrf-token': signup.json().csrfToken };
  const course = (await call('POST', '/courses', { name: '計算機概要', term: '官方样卷独立评测' }, 201)).json().course;
  result.startedAt = new Date().toISOString();
  const { uploadId, fields } = (await call('POST', '/courses/auto/paper-uploads', { title: '109年普通考試計算機概要', autoTitle: true,
    mediaType: 'application/pdf', bytes: source.length, sha256: inputSha256,
    rightsConfirmed: true, allowModels: true, redacted: true }, 201)).json();
  const versionId = 'official-exam-2020-pilot';
  objects.set(fields.key, { version: versionId, bytes: source });
  const { paper: uploaded } = (await call('POST', `/paper-uploads/${uploadId}/complete`, { versionId }, 202)).json();
  const path = '/papers/' + uploaded.id;
  assert.equal(await drain('paper', 1), 1);
  console.log('已通过发布版 API 上传四页评测 PDF。');
  result.pageTasks = await drain('page', 4);
  result.recognitionFinishedAt = new Date().toISOString();
  const { paper, pageReviews, questions } = (await call('GET', path)).json();
  result.recognition = { title: paper.title, subject: paper.recognizedSubject, autoAssigned: paper.courseId === course.id,
    pages: paper.pages.length, pageOrder: paper.pageOrder, pageReviews, acceptedQuestions: questions.length };
  console.log(JSON.stringify({ accepted: questions.length, pages: pageReviews.map(page => ({ page: page.page,
    status: page.status, failure: page.failure, printedPage: page.recognition?.printedPage, candidates: page.recognition?.stems.length })) }));
  if (!paper.courseId) {
    await call('POST', path + '/assignment', { courseId: course.id });
    result.recognition.assignedManually = true;
  }
  result.solutionTasks = await drain('solution', 6);
  const pending = await admin.query(`SELECT 1 FROM paper_questions WHERE paper_id = $1 AND solution_status = 'processing' LIMIT 1`, [uploaded.id]);
  if (pending.rowCount) {
    await delay(5500);
    result.solutionTasks += await drain('solution', 6);
  }
  result.finishedAt = new Date().toISOString();
  const solved = (await call('GET', path + '?includeAnalysis=true')).json();
  result.questions = solved.questions.map(question => ({ page: question.pageNumber, stem: question.stem, kind: question.kind,
    status: question.solutionStatus, failure: question.solutionFailure, answer: question.modelSolution?.answer ?? null,
    explanation: question.modelSolution?.explanation ?? null, model: question.modelSolution?.model ?? null,
    solutionPromptVersion: question.modelSolution?.promptVersion ?? null }));
  const practice = await call('POST', path + '/practice', {}, null);
  result.practice = { status: practice.statusCode, questionCount: practice.json().questions?.length ?? 0,
    ...(practice.json().code && { code: practice.json().code }) };
  result.usage = (await admin.query(`SELECT task, model, state, input_tokens AS "inputTokens", output_tokens AS "outputTokens",
    spent_micros AS "spentMicros", request_id AS "requestId", http_status AS "httpStatus"
    FROM model_invocations ORDER BY created_at`)).rows;
  await writeFile(report, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ solutions: result.solutionTasks, practice: result.practice,
    yuan: result.usage.reduce((sum, call) => sum + Number(call.spentMicros ?? 0), 0) / 1e6 }));
} finally {
  await app.close();
  await Promise.all([pool.end(), admin.end(), ...Object.values(workers).map(worker => worker.end())]);
}
