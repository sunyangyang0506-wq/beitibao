import { consumePracticeDeadline, settleExpiredPractices } from '../dist/server/practice.js';
import { dispatchPracticeDeadline } from '../dist/server/practice-deadline.js';
import { processNextPrediction } from '../dist/server/predictions.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../dist/server/app.js';
import { processNextSolution } from '../dist/server/model-solution.js';
import { processNextPaper } from '../dist/server/paper-worker.js';
import { processNextPageRecognition } from '../dist/server/pdf-page-recognition.js';
import { samplePaper } from './fixtures/sample-paper.mjs';
import { dispatchBusinessJob } from '../dist/server/job-outbox.js';
import { runBusinessBatch, runBusinessEvent } from '../dist/server/release-jobs.js';
import { readQueueCloudEvents } from '../dist/server/smq.js';
import { purgeExpiredPaperUpload } from '../dist/server/maintenance.js';
import { ossPaperStorage } from '../dist/server/paper-storage.js';
import sharp from 'sharp';

const origin = 'http://127.0.0.1:5173';

test('signs a constrained OSS upload and fetches the selected object version on the private endpoint', async t => {
  const temporary = {
    ALIBABA_CLOUD_ACCESS_KEY_ID: 'synthetic-sts-id',
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'synthetic-sts-secret',
    ALIBABA_CLOUD_SECURITY_TOKEN: 'synthetic-sts-token'
  };
  const saved = Object.fromEntries(Object.keys(temporary).map(key => [key, process.env[key]]));
  Object.assign(process.env, temporary);
  try {
    const storage = ossPaperStorage('beitibao-staging-test01-papers', {}, () => new Date('2026-11-08T05:00:00Z'));
    const key = 'papers/' + randomUUID() + '/' + randomUUID();
    const bytes = Buffer.from('fixture');
    const { url, fields } = storage.signUpload(key, 'application/pdf', bytes.length, new Date('2026-11-08T05:05:00Z'));
    const policy = JSON.parse(Buffer.from(fields.policy, 'base64').toString('utf8'));
    assert.equal(url, 'https://beitibao-staging-test01-papers.oss-cn-beijing.aliyuncs.com/');
    assert.deepEqual(policy.conditions.at(-1), ['content-length-range', bytes.length, bytes.length]);
    assert.ok(policy.conditions.some(item => item.key === key));
    assert.equal(fields['x-oss-signature-version'], 'OSS4-HMAC-SHA256');
    assert.match(fields['x-oss-signature'], /^[a-f0-9]{64}$/);
    t.mock.method(globalThis, 'fetch', async input => {
      const target = new URL(input);
      assert.equal(target.hostname, 'beitibao-staging-test01-papers.oss-cn-beijing-internal.aliyuncs.com');
      assert.equal(target.searchParams.get('versionId'), 'fixed-version');
      assert.ok(target.searchParams.get('x-oss-signature'));
      return new Response(bytes, { headers: { 'content-length': String(bytes.length),
        'content-type': 'application/pdf', 'x-oss-version-id': 'fixed-version' } });
    });
    assert.deepEqual(await storage.read({ key, version: 'fixed-version', bytes: bytes.length, mediaType: 'application/pdf' }), bytes);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('secure release handles private versions, queue recovery, manual practice and deletion', async () => {
  const releaseOrigin = 'https://release.example.test';
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const worker = new pg.Pool({ connectionString: process.env.RELEASE_PAPER_DATABASE_URL });
  const maintenance = new pg.Pool({ connectionString: process.env.MAINTENANCE_DATABASE_URL });
  const versions = new Map();
  const reads = [];
  const storage = {
    signUpload: key => ({ url: 'https://oss.example.test/', fields: { key } }),
    async read(object) {
      reads.push(object);
      return versions.get(object.key)?.get(object.version) ?? null;
    }
  };
  const privatePapers = { storage: () => storage, modelsEnabled: false, predictionsEnabled: false };
  const app = await createApp({ pool, origin: releaseOrigin, privatePapers });
  const request = (auth, method, path, payload) => app.inject({
    method, url: '/api/v1' + path, payload, headers: { origin: releaseOrigin, ...auth }
  });
  async function register(email) {
    const invite = randomBytes(32).toString('base64url');
    await admin.query("INSERT INTO invitations (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [email, createHash('sha256').update(invite).digest('hex')]);
    const signedIn = await request({}, 'POST', '/auth/register', { email, invite, password: 'production test passphrase' });
    assert.equal(signedIn.statusCode, 201, signedIn.body);
    assert.match(signedIn.headers['set-cookie'], /; Secure/);
    return { cookie: signedIn.headers['set-cookie'].split(';')[0], 'x-csrf-token': signedIn.json().csrfToken };
  }
  try {
    assert.equal((await app.inject('/readyz')).statusCode, 200);
    const owner = await register('release-owner@example.test');
    const other = await register('release-other@example.test');
    const course = await request(owner, 'POST', '/courses', { name: 'Production fixture', term: '2026' });
    assert.equal(course.statusCode, 201);
    const coursePath = '/courses/' + course.json().course.id;
    assert.equal((await request(owner, 'GET', coursePath + '/papers')).json().uploadMode, 'private');
    assert.equal((await request(owner, 'POST', coursePath + '/papers?title=legacy', {})).statusCode, 404);
    assert.equal((await request(owner, 'POST', coursePath + '/prediction', {})).json().code, 'PREDICTION_NOT_RELEASED');
    assert.equal((await request(owner, 'GET', '/mistakes')).statusCode, 200);
    const source = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#eee' } }).png().toBuffer();
    const metadata = { title: 'Synthetic camera capture', school: 'Release fixture', mediaType: 'image/png',
      bytes: source.length, sha256: createHash('sha256').update(source).digest('hex'), rightsConfirmed: true, allowModels: false };
    const issuePath = coursePath + '/paper-uploads';
    assert.equal((await request(other, 'POST', issuePath, metadata)).statusCode, 404);
    assert.equal((await request(owner, 'POST', issuePath, { ...metadata, rightsConfirmed: false })).statusCode, 400);
    assert.equal((await request(owner, 'POST', issuePath, { ...metadata, allowModels: true })).statusCode, 400);
    const issued = await request(owner, 'POST', issuePath, metadata);
    assert.equal(issued.statusCode, 201, issued.body);
    const { uploadId, fields } = issued.json();
    const uploaded = '/paper-uploads/' + uploadId + '/complete';
    versions.set(fields.key, new Map([['v1', source], ['v2', Buffer.alloc(source.length)]]));
    assert.equal((await request(other, 'POST', uploaded, { versionId: 'v1' })).statusCode, 404);
    assert.equal((await request(owner, 'POST', uploaded, { versionId: 'v2' })).statusCode, 422);
    const attempts = await Promise.all(Array.from({ length: 2 }, () => request(owner, 'POST', uploaded, { versionId: 'v1' })));
    assert.deepEqual(attempts.map(result => result.statusCode).sort(), [200, 202], attempts.map(result => result.body).join('\n'));
    const paperId = attempts[0].json().paper.id;
    assert.equal(attempts[1].json().paper.id, paperId);
    const path = '/papers/' + paperId;
    const { rows: [event] } = await admin.query(`
      SELECT id, tenant_id FROM business_job_outbox WHERE lane = 'paper' AND job_key = $1
    `, [paperId]);
    let observed = false;
    for (let i = 0; i < 100 && !observed; i++) {
      await dispatchBusinessJob(worker, 'paper', async message => {
        if (message.eventId === event.id) {
          observed = true;
          throw new Error('simulated queue failure');
        }
      });
    }
    assert.ok(observed);
    const state = await admin.query('SELECT state, attempts FROM business_job_outbox WHERE id = $1', [event.id]);
    assert.deepEqual(state.rows[0], { state: 'pending', attempts: 1 });
    const settings = { ...privatePapers, storage };
    assert.equal((await runBusinessBatch(worker, 'paper', null, settings)).recovered, true);
    const readCount = reads.length;
    const delivery = { subject: 'acs:mns:cn-beijing:1234567890123456:queues/beitibao-staging-test01-paper',
      type: 'mns:Queue:SendMessage', data: { messageBody: JSON.stringify({ version: 1, eventId: event.id }) } };
    assert.equal(readQueueCloudEvents(delivery, '1234567890123456', 'beitibao-staging-other1-paper'), null);
    const [eventId] = readQueueCloudEvents([delivery], '1234567890123456', 'beitibao-staging-test01-paper');
    assert.equal(await runBusinessEvent(worker, 'paper', eventId, settings), true);
    assert.equal(await runBusinessEvent(worker, 'paper', eventId, settings), true);
    assert.equal(reads.length, readCount, 'redelivery must not read or process a completed job again');
    const review = (await request(owner, 'GET', path)).json();
    assert.equal(review.paper.status, 'review');
    assert.equal(review.paper.recognition, null);
    assert.equal(review.paper.modelAvailable, false);
    assert.equal((await request(other, 'GET', path + '/pages/1')).statusCode, 404);
    const preview = await request(owner, 'GET', path + '/pages/1');
    assert.equal(preview.statusCode, 200);
    assert.deepEqual(preview.rawPayload, source);
    assert.equal(reads.at(-1).version, 'v1');
    const question = await request(owner, 'POST', path + '/questions', { pageNumber: 1, stem: 'What is 2 + 2?' });
    assert.equal(question.statusCode, 201, question.body);
    const questionId = question.json().id;
    const attempt = await request(owner, 'POST', path + '/practice', {});
    assert.equal(attempt.statusCode, 200, attempt.body);
    assert.equal((await request(owner, 'GET', path + '/pages/1')).statusCode, 409);
    const submitted = await request(owner, 'POST', path + '/practice/save', {
      revision: attempt.json().revision, answers: { [questionId]: '4' }, submit: true
    });
    assert.equal(submitted.statusCode, 200, submitted.body);
    assert.ok(submitted.json().submittedAt);
    assert.equal((await request(other, 'POST', path + '/delete', { confirmed: true })).statusCode, 404);
    const deleted = await request(owner, 'POST', path + '/delete', { confirmed: true });
    assert.equal(deleted.statusCode, 204, deleted.body);
    assert.equal((await request(owner, 'GET', path + '/pages/1')).statusCode, 404);
    assert.equal((await request(owner, 'POST', uploaded, { versionId: 'v1' })).statusCode, 404);
    await admin.query(`
      UPDATE paper_uploads
      SET expires_at = now() - interval '2 days',
          erased_at = date_trunc('milliseconds', erased_at) + interval '321 microseconds'
      WHERE id = $1
    `, [uploadId]);
    assert.equal(await purgeExpiredPaperUpload(maintenance, async (key, keptVersion) => {
      assert.equal(key, fields.key);
      assert.equal(keptVersion, null);
      versions.delete(key);
      return true;
    }), true);
    assert.equal(versions.has(fields.key), false);
    const { rows: [cleanup] } = await admin.query(
      'SELECT cleaned_at IS NOT NULL AS cleaned FROM paper_uploads WHERE id = $1', [uploadId]);
    assert.equal(cleanup.cleaned, true);

    const autoPdf = samplePaper();
    const autoUpload = await request(owner, 'POST', '/courses/auto/paper-uploads', {
      title: '未命名扫描件', autoTitle: true, mediaType: 'application/pdf', bytes: autoPdf.length,
      sha256: createHash('sha256').update(autoPdf).digest('hex'), rightsConfirmed: true, allowModels: false
    });
    assert.equal(autoUpload.statusCode, 201, autoUpload.body);
    const autoIssue = autoUpload.json();
    versions.set(autoIssue.fields.key, new Map([['auto-v1', autoPdf]]));
    const autoComplete = await request(owner, 'POST', '/paper-uploads/' + autoIssue.uploadId + '/complete', { versionId: 'auto-v1' });
    assert.equal(autoComplete.statusCode, 202, autoComplete.body);
    const autoPaper = autoComplete.json().paper;
    assert.equal(autoPaper.courseId, null);
    const { rows: [{ id: ownerId }] } = await admin.query("SELECT id FROM accounts WHERE email = 'release-owner@example.test'");
    assert.equal(await processNextPaper(worker, undefined, undefined, { storage, modelsEnabled: false }, { tenant: ownerId, id: autoPaper.id }), true);
    assert.equal((await request(owner, 'GET', '/courses/auto/papers')).json().papers.find(paper => paper.id === autoPaper.id).libraryStatus, 'unassigned');
    assert.equal((await request(other, 'POST', '/papers/' + autoPaper.id + '/assignment', { courseId: course.json().course.id })).statusCode, 404);
    assert.equal((await request(owner, 'POST', '/papers/' + autoPaper.id + '/assignment', { courseId: course.json().course.id })).statusCode, 200);
    const autoStatus = async () => (await request(owner, 'GET', '/courses/auto/papers')).json().papers
      .find(paper => paper.id === autoPaper.id).libraryStatus;
    assert.equal(await autoStatus(), 'no_questions');
    const autoPath = '/papers/' + autoPaper.id;
    assert.equal((await request(owner, 'POST', autoPath + '/practice', {})).statusCode, 404);
    const added = await request(owner, 'POST', autoPath + '/questions', { pageNumber: 1, stem: '从原卷补录的试题' });
    assert.equal(added.statusCode, 201, added.body);
    assert.equal(await autoStatus(), 'ready');
    const autoPractice = await request(owner, 'POST', autoPath + '/practice', {});
    assert.equal(autoPractice.statusCode, 200, autoPractice.body);
    assert.equal(autoPractice.json().questions[0].id, added.json().id);
  } finally {
    await app.close();
    await Promise.all([pool.end(), admin.end(), worker.end(), maintenance.end()]);
  }
});

test('processes a private PDF asynchronously and stores a confirmed question with its source page', async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const worker = new pg.Pool({ connectionString: process.env.LOCAL_PAPER_WORKER_DATABASE_URL });
  const queue = new pg.Pool({ connectionString: process.env.PRACTICE_QUEUE_DATABASE_URL });
  const app = await createApp({ pool, origin, localPapers: true });
  try {
    const owner = await register('paper-owner@example.test');
    const other = await register('paper-other@example.test');
    const { rows: [{ id: ownerId }] } = await admin.query("SELECT id FROM accounts WHERE email = 'paper-owner@example.test'");
    const { rows: [{ id: otherId }] } = await admin.query("SELECT id FROM accounts WHERE email = 'paper-other@example.test'");
    const ownerJob = id => ({ tenant: ownerId, id });
    const course = await request(owner, 'POST', '/courses', { name: '数据结构', term: '2026 秋' });
    assert.equal(course.statusCode, 201);
    const coursePath = '/courses/' + course.json().course.id + '/papers';
    const uploadPath = coursePath + '?title=Mock%20exam';
    const pdf = samplePaper();
    assert.equal((await request(other, 'POST', uploadPath, pdf)).statusCode, 404);
    assert.equal((await request(owner, 'POST', uploadPath, Buffer.from('not pdf'))).statusCode, 400);
    const accepted = await request(owner, 'POST', uploadPath, pdf);
    assert.equal(accepted.statusCode, 202);
    const paper = accepted.json().paper;
    assert.equal(paper.status, 'queued');
    const duplicate = await request(owner, 'POST', uploadPath, pdf);
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().paper.id, paper.id);
    assert.equal((await request(owner, 'GET', coursePath)).json().papers.length, 1);

    const path = '/papers/' + paper.id;
    assert.equal((await request(owner, 'GET', path + '/pages/1')).statusCode, 404);
    assert.equal(await processNextPaper(worker, undefined, undefined, undefined, ownerJob(paper.id)), true);
    assert.equal(await processNextPaper(worker, undefined, undefined, undefined, ownerJob(paper.id)), false);
    const review = (await request(owner, 'GET', path)).json();
    assert.equal(review.paper.status, 'review');
    assert.match(review.paper.pages[0], /stack and a queue/);
    const image = await request(owner, 'GET', path + '/pages/1');
    assert.equal(image.statusCode, 200);
    assert.equal(image.headers['content-type'], 'image/png');
    assert.equal(image.rawPayload.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal((await request(other, 'GET', path)).statusCode, 404);
    assert.equal((await request(other, 'GET', path + '/pages/1')).statusCode, 404);

    const question = { pageNumber: 1, stem: '说明栈与队列的区别。' };
    assert.equal((await request(other, 'POST', path + '/questions', question)).statusCode, 404);
    assert.equal((await request(owner, 'POST', path + '/questions', { ...question, pageNumber: 2 })).statusCode, 404);
    assert.equal((await request(owner, 'POST', path + '/questions', { ...question, stem: '  ' })).statusCode, 400);
    const confirmed = await request(owner, 'POST', path + '/questions', question);
    assert.equal(confirmed.statusCode, 201);
    assert.equal((await request(owner, 'POST', path + '/questions', question)).json().reused, true);
    assert.deepEqual((await request(owner, 'GET', path)).json().questions, [{ ...question, id: confirmed.json().id, inputRevision: 1, kind: 'other' }]);
    const beforePractice = (await request(owner, 'GET', '/progress')).json().courses[0];
    assert.equal(beforePractice.totalPapers, 1);
    assert.equal(beforePractice.draftPaperId, null);

    const questionJob = ownerJob(confirmed.json().id);
    assert.equal(await processNextSolution(worker, async () => assert.fail('unexpected model call'), undefined, questionJob), false);
    const practicePath = path + '/practice';
    const questionPath = path + '/questions/' + confirmed.json().id;
    const correction = { answer: '我的核对答案', explanation: '我的解析' };
    assert.equal((await request(owner, 'POST', questionPath + '/correction', correction)).statusCode, 404);
    assert.equal((await request(other, 'POST', practicePath, {})).statusCode, 404);
    const attempt = (await request(owner, 'POST', practicePath, {})).json();
    assert.equal(attempt.questions.length, 1);
    const beforeSubmit = (await request(owner, 'GET', practicePath)).json();
    assert.equal('modelSolution' in beforeSubmit.questions[0], false);
    assert.equal('knowledgeNetwork' in beforeSubmit, false);
    const answers = { [confirmed.json().id]: '栈后进先出，队列先进先出。' };
    assert.equal((await request(owner, 'GET', path + '?includeAnalysis=true')).json().closedBook, true);
    assert.equal((await request(owner, 'GET', path + '/pages/1')).json().code, 'CLOSED_BOOK_ACTIVE');
    assert.equal((await request(owner, 'POST', questionPath + '/reveal', {})).json().code, 'CLOSED_BOOK_ACTIVE');
    const draftState = { marked: [confirmed.json().id], position: confirmed.json().id };
    const draft = { revision: attempt.revision, changes: answers, draft: draftState, submit: false };
    assert.equal((await request(owner, 'POST', practicePath + '/save', draft)).statusCode, 200);
    assert.equal((await request(owner, 'POST', practicePath + '/save', draft)).statusCode, 409);
    const resumed = (await request(owner, 'GET', practicePath)).json();
    assert.deepEqual(resumed.answers, answers);
    assert.deepEqual(resumed.draft, draftState);
    assert.equal((await request(owner, 'GET', '/progress')).json().courses[0].draftPaperId, paper.id);
    const submission = { revision: resumed.revision, answers, submit: true };
    const submissions = await Promise.all(Array.from({ length: 2 }, () =>
      request(owner, 'POST', practicePath + '/save', submission)));
    assert.ok(submissions[0].json().submittedAt);
    assert.equal(submissions[0].json().questions[0].modelSolution, null);
    assert.equal(submissions[0].json().questions[0].result, 'needs_review');
    assert.deepEqual(submissions[0].json(), submissions[1].json());
    assert.equal((await request(owner, 'GET', '/progress')).json().courses[0].draftPaperId, null);
    const solvedAnswer = '栈后进先出，队列先进先出。';
    assert.equal(await processNextSolution(worker, async stem => {
      assert.equal(stem, question.stem);
      return { model: 'test', promptVersion: 'test', status: 'solved', answer: solvedAnswer, explanation: '按出队顺序比较。', knowledgePoints: ['栈', '队列'], designLogic: '对比存取顺序。' };
    }, undefined, questionJob), true);
    const completedAnalysis = (await request(owner, 'GET', practicePath)).json();
    assert.equal(completedAnalysis.questions[0].modelSolution.answer, solvedAnswer);
    assert.equal(completedAnalysis.questions[0].result, 'correct');
    assert.equal(completedAnalysis.knowledgeNetwork.edges.length, 1);
    await admin.query(`UPDATE paper_questions SET model_solution = model_solution ||
      '{"answer":"更新后的题库答案","knowledgePoints":["新知识点"]}'::jsonb WHERE id = $1`, [confirmed.json().id]);
    const historical = (await request(owner, 'GET', practicePath)).json();
    assert.equal(historical.questions[0].modelSolution.answer, solvedAnswer);
    assert.equal(historical.questions[0].result, 'correct');
    assert.equal(historical.knowledgeNetwork.edges.length, 1);
    assert.deepEqual((await admin.query('SELECT covered FROM practice_results WHERE paper_id = $1', [paper.id])).rows,
      [{ covered: [confirmed.json().id] }]);
    assert.equal((await request(owner, 'POST', practicePath + '/save', draft)).statusCode, 409);
    assert.equal((await request(other, 'GET', practicePath)).statusCode, 404);
    assert.equal((await request(owner, 'POST', questionPath + '/correction', correction)).statusCode, 200);
    assert.deepEqual((await request(owner, 'GET', practicePath)).json().questions[0].correction, correction);
    assert.equal((await request(owner, 'GET', path)).json().questions[0].modelSolution, undefined);
    assert.equal((await request(owner, 'GET', path + '?includeAnalysis=true')).json().questions[0].modelSolution.answer, '更新后的题库答案');

    const predictionPath = '/courses/' + course.json().course.id + '/prediction';
    assert.equal((await request(other, 'POST', predictionPath, {})).statusCode, 404);
    assert.equal((await request(owner, 'POST', predictionPath, {})).json().code, 'PREDICTION_SOURCES_UNCONFIRMED');
    assert.equal((await request(owner, 'POST', predictionPath + '/confirm-sources', { paperIds: [paper.id] })).statusCode, 200);
    const jobs = await Promise.all(Array.from({ length: 2 }, () => request(owner, 'POST', predictionPath, {})));
    assert.equal(jobs[0].json().id, jobs[1].json().id);
    const predictionStems = [
      '比较栈和队列在浏览器历史中的应用。',
      '哪种结构适合处理浏览器的后退操作？\nA. 栈\nB. 队列',
      '一个空栈连续压入三个元素，再弹出一个元素后，栈中还剩几个元素？'
    ];
    assert.equal(await processNextPrediction(worker, async evidence => [{
      stem: predictionStems[0], answer: '栈适合回退，队列适合按到达顺序处理。',
      explanation: '按访问与处理顺序比较。', sourceIds: [evidence[0].id], rationale: '考察存取顺序', knowledgePoints: ['栈', '队列']
    }, {
      stem: predictionStems[1], kind: 'choice', answer: 'A',
      explanation: '后退时先访问最近的记录。', sourceIds: [evidence[0].id], rationale: '考察后进先出'
    }, {
      stem: predictionStems[2], kind: 'calculation', answer: '$2$',
      explanation: '三次压入后弹出一个元素。', sourceIds: [evidence[0].id], rationale: '考察栈的操作'
    }], ownerJob(jobs[0].json().id)), true);
    const preview = (await request(owner, 'GET', predictionPath)).json();
    const predicted = preview.prediction;
    assert.equal(predicted.status, 'ready');
    assert.deepEqual(preview.questions.map(({ stem, ...question }) => [stem, Object.keys(question).sort()]),
      predictionStems.map(stem => [stem, ['id', 'kind']]));
    const predictionPractice = '/papers/' + predicted.paperId + '/practice';
    const predictionAttempt = (await request(owner, 'POST', predictionPractice, { durationMinutes: 30 })).json();
    assert.deepEqual((await request(owner, 'GET', predictionPath)).json().questions, []);
    assert.equal(predictionAttempt.questions.length, 3);
    assert.ok(predictionAttempt.questions.every(item => !('modelSolution' in item) && !('reference' in item)));
    assert.ok(predictionAttempt.deadlineAt);
    const { rows: [scheduled] } = await admin.query('SELECT id, state FROM practice_deadline_outbox WHERE paper_id=$1', [predicted.paperId]);
    assert.equal(scheduled.state, 'pending');
    assert.equal(await dispatchPracticeDeadline(queue, async () => { throw new Error('simulated SMQ failure'); }, scheduled.id), true);
    assert.equal((await admin.query('SELECT attempts FROM practice_deadline_outbox WHERE id=$1', [scheduled.id])).rows[0].attempts, 1);
    assert.equal(await dispatchPracticeDeadline(queue, async () => assert.fail('backoff skipped'), scheduled.id), false);
    await admin.query('UPDATE practice_deadline_outbox SET next_attempt_at = now() WHERE id=$1', [scheduled.id]);
    const deliveries = [];
    const dispatched = await Promise.all(Array.from({ length: 2 }, () => dispatchPracticeDeadline(queue, async (event, delay) => {
      assert.ok(delay > 0 && delay <= 1800);
      deliveries.push(event);
    }, scheduled.id)));
    assert.deepEqual(dispatched.sort(), [false, true]);
    assert.deepEqual(deliveries, [{ version: 1, eventId: scheduled.id }]);
    assert.equal(await consumePracticeDeadline(queue, scheduled.id), false);
    const [openQuestion, choiceQuestion, numericQuestion] = predictionAttempt.questions;
    const savedAnswer = { [openQuestion.id]: '我的预测卷草稿', [choiceQuestion.id]: 'B', [numericQuestion.id]: '2.0' };
    await request(owner, 'POST', predictionPractice + '/save', {
      revision: predictionAttempt.revision, answers: savedAnswer, submit: false
    });
    await admin.query("UPDATE practice_attempts SET deadline_at = now() - interval '1 second' WHERE paper_id = $1", [predicted.paperId]);
    await Promise.all([settleExpiredPractices(worker), consumePracticeDeadline(queue, scheduled.id)]);
    assert.equal(await consumePracticeDeadline(queue, scheduled.id), true);
    const predictedResult = (await request(owner, 'GET', predictionPractice)).json();
    assert.ok(predictedResult.submittedAt);
    assert.equal(predictedResult.knowledgeNetwork.questionLogic[0].text, '考察存取顺序');
    assert.deepEqual(predictedResult.answers, savedAnswer);
    assert.deepEqual(predictedResult.questions.map(item => item.result), ['needs_review', 'incorrect', 'correct']);
    assert.equal((await admin.query('SELECT 1 FROM practice_results WHERE paper_id = $1', [predicted.paperId])).rowCount, 1);
    assert.equal(predictedResult.questions[0].modelSolution.evidence[0].id, confirmed.json().id);
    const modelMistake = (await request(owner, 'GET', '/mistakes')).json().mistakes.find(item => item.id === choiceQuestion.id);
    assert.equal(modelMistake?.originalAnswer, 'B');
    const retry = await request(owner, 'POST', '/mistakes/' + choiceQuestion.id + '/retry', { attemptKey: randomUUID(), answer: 'A' });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().result, 'correct');
    assert.equal((await request(owner, 'GET', '/progress')).json().courses[0].totalPapers, 1);
    await request(owner, 'POST', questionPath + '/kind', { kind: 'short_answer' });
    assert.equal((await request(owner, 'GET', predictionPath)).json().locked, true);
    // The original question changed from other to short_answer above. Its old
    // attempt must not count as current coverage until the new input is practised.
    const beforeKindRetake = (await request(owner, 'GET', '/progress')).json().courses.find(item => item.id === course.json().course.id);
    const kindRetakeResponse = await request(owner, 'POST', practicePath, {});
    assert.equal(kindRetakeResponse.statusCode, 200, kindRetakeResponse.body);
    const kindRetake = kindRetakeResponse.json();
    assert.notEqual(kindRetake.attemptId, attempt.attemptId);
    assert.equal(kindRetake.questions[0].kind, 'short_answer');
    const kindSubmission = await request(owner, 'POST', practicePath + '/save', {
      revision: kindRetake.revision, answers, submit: true
    });
    assert.equal(kindSubmission.statusCode, 200, kindSubmission.body);
    const afterKindRetake = (await request(owner, 'GET', '/progress')).json().courses.find(item => item.id === course.json().course.id);
    assert.equal(afterKindRetake.completedPapers, beforeKindRetake.completedPapers + 1);
    assert.equal((await request(owner, 'GET', predictionPath)).json().prediction.status, 'superseded');
    const newJob = (await request(owner, 'POST', predictionPath, {})).json();
    assert.equal(await processNextPrediction(worker, async evidence => [{
      stem: '如何选择结构以保留服务请求的到达顺序？', answer: '使用队列。',
      explanation: '队列按照入队顺序处理请求。', sourceIds: [evidence[0].id], rationale: '用调度场景核对队列性质。'
    }], ownerJob(newJob.id)), true);
    const regenerated = (await request(owner, 'GET', predictionPath)).json();
    assert.notEqual(regenerated.prediction.paperId, predicted.paperId);
    assert.equal(regenerated.history[0].paperId, predicted.paperId);
    assert.deepEqual((await request(owner, 'GET', predictionPractice)).json().answers, savedAnswer);

    const imageUpload = await request(owner, 'POST', coursePath + '?title=Image', image.rawPayload, 'image/png');
    assert.equal(imageUpload.statusCode, 202);
    const relocked = (await request(owner, 'GET', predictionPath)).json();
    assert.equal(relocked.locked, true);
    assert.equal(relocked.sourcesConfirmed, false);
    assert.equal(relocked.prediction, null);
    assert.equal((await request(owner, 'GET', predictionPractice)).json().code, 'PREDICTION_LOCKED');
    assert.ok(!(await request(owner, 'GET', '/mistakes')).json().mistakes.some(item => item.id === choiceQuestion.id));
    const imagePath = '/papers/' + imageUpload.json().paper.id;
    const recognize = async (_bytes, mediaType) => {
      assert.equal(mediaType, 'image/png');
      return { model: 'stub', promptVersion: 'test-v1', stems: ['OCR错字', '正确题干', '误识别'],
        figures: [[{ box: [100, 100, 500, 500], initial: null, reread: null, status: 'needs_review', reason: 'conflict' }], [], []] };
    };
    assert.equal(await processNextPaper(worker, recognize, undefined, undefined, ownerJob(imageUpload.json().paper.id)), true);
    const candidate = await request(owner, 'GET', imagePath);
    assert.equal(candidate.json().paper.recognition.stems.length, 3);
    assert.equal(candidate.json().questions.length, 0);
    const reviewPath = imagePath + '/recognition-review';
    const cropPath = imagePath + '/recognition/0/figures/0';
    assert.equal((await request(owner, 'GET', cropPath)).headers['content-type'], 'image/png');
    assert.equal((await request(other, 'GET', cropPath)).statusCode, 404);
    assert.equal((await request(owner, 'POST', reviewPath, {
      candidateIndex: 0, stem: '修订题干'
    })).json().code, 'FIGURE_REVIEW_REQUIRED');
    const newBox = { box: [120, 120, 480, 480] };
    assert.equal((await request(other, 'POST', cropPath + '/reread', newBox)).statusCode, 404);
    const recrop = await request(owner, 'POST', cropPath + '/reread', newBox);
    assert.equal(recrop.statusCode, 200);
    assert.deepEqual(recrop.json().figure.box, newBox.box);
    assert.equal(recrop.json().figure.status, 'needs_review');
    assert.deepEqual(recrop.json().figure.previous.box, [100, 100, 500, 500]);
    assert.equal((await request(owner, 'POST', cropPath + '/reread', newBox)).statusCode, 409);
    const change = { candidateIndex: 0, stem: '修订题干', visualReview: '原图确认 A→B' };
    assert.equal((await request(other, 'POST', reviewPath, change)).statusCode, 404);
    const repetitions = await Promise.all(Array.from({ length: 2 }, () => request(owner, 'POST', reviewPath, change)));
    assert.ok(repetitions.every(response => response.json().outcome === 'corrected'));
    assert.equal((await request(owner, 'POST', reviewPath, { ...change, stem: '冲突题干' })).statusCode, 409);
    assert.equal((await request(owner, 'POST', reviewPath, { candidateIndex: 1, stem: '正确题干' })).json().outcome, 'confirmed');
    assert.equal((await request(owner, 'POST', reviewPath, { candidateIndex: 2, stem: null })).json().outcome, 'rejected');
    const reviewedImage = (await request(owner, 'GET', imagePath)).json();
    assert.equal(reviewedImage.questions.length, 2);
    assert.equal(reviewedImage.reviews[0].reviewedStem, '修订题干');
    const recallJob = ownerJob(reviewedImage.questions[0].id);
    const recallQuestion = imagePath + '/questions/' + recallJob.id;
    assert.equal((await request(owner, 'POST', recallQuestion + '/kind', { kind: 'calculation' })).statusCode, 200);
    assert.equal((await request(owner, 'POST', imagePath + '/recall', { kind: 'calculation' })).json().queued, 1);
    assert.equal((await request(owner, 'POST', imagePath + '/recall', { kind: 'calculation' })).json().queued, 0);
    assert.equal(await processNextSolution(worker, async () => ({
      model: 'test', promptVersion: 'test', status: 'solved', answer: '42', explanation: '测试解析'
    }), undefined, recallJob), true);
    assert.equal((await request(other, 'POST', recallQuestion + '/reveal', {})).statusCode, 404);
    assert.equal((await request(owner, 'POST', recallQuestion + '/reveal', {})).json().modelSolution.answer, '42');
    assert.equal((await request(owner, 'POST', recallQuestion + '/correction', correction)).statusCode, 200);
    const savedRecall = (await request(owner, 'POST', recallQuestion + '/reveal', {})).json();
    assert.deepEqual(savedRecall.correction, correction);
    assert.equal(savedRecall.modelSolution.answer, '42');
    assert.equal((await request(owner, 'POST', recallQuestion + '/bookmark', { bookmarked: true })).json().bookmarked, true);
    assert.equal((await request(owner, 'POST', recallQuestion + '/bookmark', { bookmarked: false })).json().bookmarked, false);
    assert.equal((await request(owner, 'POST', recallQuestion + '/assessment', { rating: 'partial' })).json().selfRating, 'partial');
    assert.ok((await request(owner, 'GET', '/mistakes')).json().mistakes.some(item =>
      item.id === reviewedImage.questions[0].id && item.mode === 'recall' && item.kind === 'calculation' && /^\d{4}-\d{2}-\d{2}$/.test(item.day)));
    assert.equal((await request(owner, 'POST', recallQuestion + '/assessment', { rating: 'mastered' })).json().selfRating, 'mastered');
    assert.equal(await processNextSolution(worker, async () => assert.fail('unexpected model call'), undefined, recallJob), false);
    const feedback = await admin.query(
      'SELECT original_stem, reviewed_stem, model, prompt_version FROM recognition_feedback WHERE paper_id = $1 AND candidate_index = 0',
      [imageUpload.json().paper.id]
    );
    assert.deepEqual(feedback.rows, [{ original_stem: 'OCR错字', reviewed_stem: '修订题干', model: 'stub', prompt_version: 'test-v1' }]);

    const otherCourse = await request(other, 'POST', '/courses', { name: '数据结构', term: '2026 秋' });
    const sharedPath = coursePath + '?title=Shared&school=Example%20University';
    const firstShared = await request(owner, 'POST', sharedPath, pdf);
    assert.equal(firstShared.json().modelReused, false);
    let modelCalls = 0;
    const solvePaper = async () => {
      modelCalls++;
      return [{ stem: question.stem, model: 'test', promptVersion: 'paper-test',
        status: 'solved', answer: '共享模型答案', explanation: '同卷缓存' }];
    };
    assert.equal(await processNextPaper(worker, undefined, solvePaper, undefined, ownerJob(firstShared.json().paper.id)), true);
    const secondShared = await request(other, 'POST',
      '/courses/' + otherCourse.json().course.id + '/papers?title=Shared&school=example%20university', pdf);
    assert.equal(secondShared.json().modelReused, false);
    assert.equal(await processNextPaper(worker, undefined, solvePaper, undefined, { tenant: otherId, id: secondShared.json().paper.id }), true);
    assert.equal(modelCalls, 2);
    assert.equal((await request(owner, 'GET', '/papers/' + secondShared.json().paper.id)).statusCode, 404);

    const anotherTerm = await request(owner, 'POST', '/courses', { name: '数据结构', term: '2027 春' });
    const sameTenant = await request(owner, 'POST',
      '/courses/' + anotherTerm.json().course.id + '/papers?title=Shared&school=example%20university', pdf);
    assert.equal(sameTenant.json().modelReused, true);
    assert.equal(await processNextPaper(worker, undefined, solvePaper, undefined, ownerJob(sameTenant.json().paper.id)), true);
    assert.equal(modelCalls, 2);
    const samePath = '/papers/' + sameTenant.json().paper.id;
    const sameQuestion = await request(owner, 'POST', samePath + '/questions', question);
    const sameReveal = samePath + '/questions/' + sameQuestion.json().id + '/reveal';
    await request(owner, 'POST', sameReveal, {});
    assert.equal(await processNextSolution(worker, async () => assert.fail('unexpected per-question call'),
      undefined, ownerJob(sameQuestion.json().id)), true);
    assert.equal((await request(owner, 'POST', sameReveal, {})).json().modelSolution.answer, '共享模型答案');

    const malformed = await request(owner, 'POST', uploadPath, Buffer.from('%PDF-1.7\ninvalid'));
    assert.equal(malformed.statusCode, 202);
    assert.equal(await processNextPaper(worker, undefined, undefined, undefined, ownerJob(malformed.json().paper.id)), true);
    const failed = await request(owner, 'GET', '/papers/' + malformed.json().paper.id);
    assert.equal(failed.json().paper.status, 'failed');

    const mixedUpload = await request(owner, 'POST', uploadPath + '&recognizeScans=true', samplePaper(true));
    assert.equal(mixedUpload.statusCode, 202);
    assert.equal(await processNextPaper(worker, undefined, undefined, undefined, ownerJob(mixedUpload.json().paper.id)), true);
    const mixedJob = ownerJob(mixedUpload.json().paper.id);
    const mixed = '/papers/' + mixedJob.id;
    const libraryStatus = async () => (await request(owner, 'GET', coursePath)).json().papers
      .find(item => item.id === mixedUpload.json().paper.id).libraryStatus;
    assert.equal(await libraryStatus(), 'recognizing');
    const mixedReview = (await request(owner, 'GET', mixed)).json();
    assert.equal(mixedReview.paper.pages.length, 2);
    assert.match(mixedReview.paper.pages[0], /stack and a queue/);
    assert.equal(mixedReview.paper.pages[1], '');
    assert.deepEqual(mixedReview.pageReviews.map(page => [page.page, page.status]), [[2, 'queued']]);
    assert.equal((await request(owner, 'POST', mixed + '/questions', {
      pageNumber: 1, stem: 'Explain the stack.', sourcePages: [3]
    })).json().code, 'INVALID_SOURCE_PAGES');
    const crossPage = (await request(owner, 'POST', mixed + '/questions', {
      pageNumber: 1, stem: 'Explain the stack.', sourcePages: [2]
    })).json().id;
    assert.deepEqual((await request(owner, 'GET', mixed)).json().questions[0].sourcePages, [1, 2]);
    assert.equal((await request(owner, 'POST', mixed + '/practice', {})).json().code, 'PAGE_REVIEW_REQUIRED');
    assert.equal((await request(other, 'POST', mixed + '/pages/2/recognition', {})).statusCode, 404);
    assert.equal(await processNextPageRecognition(worker, async () => { throw new Error('OCR_NOT_CONFIGURED'); }, undefined, { ...mixedJob, page: 2 }), true);
    assert.equal((await request(owner, 'GET', mixed)).json().pageReviews[0].failure, 'OCR_NOT_CONFIGURED');
    assert.equal(await libraryStatus(), 'failed');
    assert.equal((await request(owner, 'POST', mixed + '/pages/2/recognition', {})).statusCode, 202);
    assert.equal(await processNextPageRecognition(worker, async (bytes, mediaType) => {
      assert.equal(mediaType, 'image/png');
      assert.equal(bytes.readUInt32BE(20), 2400);
      return { model: 'test', promptVersion: 'test', stems: ['Explain the diagram.'],
        figures: [[{ box: [10, 10, 950, 950], status: 'needs_review', reason: 'conflict', initial: null, reread: null }]] };
    }, undefined, { ...mixedJob, page: 2 }), true);
    assert.equal(await processNextPageRecognition(worker, async () => assert.fail('text page should not run OCR'), undefined, { ...mixedJob, page: 1 }), false);
    assert.equal(await libraryStatus(), 'needs_review');
    assert.equal((await request(owner, 'POST', mixed + '/pages/2/confirm', {})).statusCode, 409);
    const pdfCrop = mixed + '/recognition/100/figures/0';
    assert.equal((await request(owner, 'GET', pdfCrop)).headers['content-type'], 'image/png');
    assert.equal((await request(other, 'GET', pdfCrop)).statusCode, 404);
    assert.equal((await request(owner, 'POST', mixed + '/recognition-review', {
      candidateIndex: 100, stem: 'Explain the diagram.'
    })).json().code, 'FIGURE_REVIEW_REQUIRED');
    assert.equal((await request(owner, 'POST', mixed + '/recognition-review', {
      candidateIndex: 100, stem: 'Explain the diagram.', visualReview: 'Raster checked on page 2.'
    })).json().outcome, 'confirmed');
    assert.equal((await request(owner, 'POST', mixed + '/pages/2/confirm', {})).json().status, 'confirmed');
    const markMissing = { revision: 0, missingPages: true, pageOrder: [2, 1] };
    assert.equal((await request(other, 'POST', mixed + '/review-state', markMissing)).statusCode, 404);
    assert.equal((await request(owner, 'POST', mixed + '/review-state', { ...markMissing, pageOrder: [2, 3] })).json().code, 'INVALID_PAGE_ORDER');
    assert.equal((await request(owner, 'POST', mixed + '/review-state', markMissing)).json().paper.reviewRevision, 1);
    assert.equal(await libraryStatus(), 'missing_pages');
    assert.equal((await request(owner, 'POST', mixed + '/review-state', markMissing)).json().code, 'PAPER_REVIEW_CONFLICT');
    assert.equal((await request(owner, 'POST', mixed + '/practice', {})).json().code, 'PAGE_REVIEW_REQUIRED');
    assert.equal((await request(owner, 'POST', mixed + '/recall', { kind: 'other' })).statusCode, 200);
    const complete = { revision: 1, missingPages: false };
    assert.deepEqual((await request(owner, 'POST', mixed + '/review-state', complete)).json().paper.pageOrder, [2, 1]);
    assert.equal(await libraryStatus(), 'ready');
    const referencePath = mixed + '/questions/' + crossPage + '/reference';
    const reference = { kind: 'numeric', source: 'teacher', answers: ['0.05 m'], explanation: '测量结果为五厘米。' };
    assert.equal((await request(owner, 'POST', referencePath, reference)).statusCode, 200);
    const mixedAttempt = (await request(owner, 'POST', mixed + '/practice', {})).json();
    assert.deepEqual(mixedAttempt.questions.map(item => item.pageNumber), [2, 1]);
    assert.deepEqual(mixedAttempt.questions.find(item => item.id === crossPage).sourcePages, [1, 2]);
    assert.equal((await request(owner, 'POST', mixed + '/review-state', { ...complete, revision: 2 })).json().code, 'CLOSED_BOOK_ACTIVE');
    const mixedResult = (await request(owner, 'POST', mixed + '/practice/save', {
      revision: mixedAttempt.revision, changes: { [crossPage]: '4 cm' }, submit: true
    })).json();
    assert.equal(mixedResult.questions.find(item => item.id === crossPage).result, 'incorrect');
    const retryPath = '/mistakes/' + crossPage + '/retry';
    const correct = { attemptKey: randomUUID(), answer: '50 mm' };
    assert.equal((await request(owner, 'POST', retryPath, correct)).json().result, 'correct');
    assert.equal((await request(owner, 'POST', retryPath, correct)).json().result, 'correct');
    const wrong = { attemptKey: randomUUID(), answer: '6 cm' };
    assert.equal((await request(owner, 'POST', retryPath, wrong)).json().result, 'incorrect');
    assert.equal((await admin.query('SELECT 1 FROM mistake_retries WHERE question_id = $1', [crossPage])).rowCount, 2);
    assert.equal((await request(owner, 'POST', referencePath, { ...reference, answers: ['6 cm'] })).statusCode, 200);
    const changed = (await request(owner, 'GET', mixed + '/practice')).json().questions.find(item => item.id === crossPage);
    assert.equal(changed.referenceChanged, true);
    assert.equal(changed.result, 'incorrect'); // Saved grade stays tied to the original teacher answer.
    assert.deepEqual(changed.reference, reference);
    assert.equal((await admin.query('SELECT graded->>$2 AS grade FROM practice_results WHERE paper_id=$1', [mixedUpload.json().paper.id, crossPage])).rows[0].grade, 'incorrect');
    assert.equal((await request(owner, 'POST', retryPath, { ...wrong, attemptKey: randomUUID() })).json().result, 'needs_review');

    const variant = Buffer.concat([pdf, Buffer.from('\n% independently uploaded variant\n')]);
    const variantUpload = (await request(owner, 'POST', uploadPath + '&school=equivalence-test', variant)).json();
    const variantPath = '/papers/' + variantUpload.paper.id;
    assert.equal(await processNextPaper(worker, undefined, undefined, undefined, ownerJob(variantUpload.paper.id)), true);
    const linkedQuestion = (await request(owner, 'POST', variantPath + '/questions', question)).json().id;
    assert.equal((await request(owner, 'POST', variantPath + '/questions/' + linkedQuestion + '/kind', { kind: 'short_answer' })).statusCode, 200);
    const equivalents = questionPath + '/equivalences';
    const priorCoverage = (await request(owner, 'GET', '/progress')).json().courses.find(item => item.id === course.json().course.id);
    assert.equal((await request(other, 'GET', equivalents)).statusCode, 404);
    assert.equal((await request(owner, 'GET', equivalents)).json().candidates[0].id, linkedQuestion);
    const links = await Promise.all(Array.from({ length: 2 }, () => request(owner, 'POST', equivalents, { memberId: linkedQuestion })));
    assert.equal(links[0].statusCode, 200);
    assert.deepEqual(links[0].json(), links[1].json());
    const afterLink = (await request(owner, 'GET', '/progress')).json().courses.find(item => item.id === priorCoverage.id);
    assert.equal(afterLink.completedPapers, priorCoverage.completedPapers + 1);
    await request(owner, 'POST', questionPath + '/bookmark', { bookmarked: true });
    await request(owner, 'POST', variantPath + '/questions/' + linkedQuestion + '/bookmark', { bookmarked: true });
    await admin.query("UPDATE question_recall SET mistake_recorded_at = '2026-11-03 16:01:00+00' WHERE question_id = $1", [linkedQuestion]);
    await admin.query("UPDATE question_recall SET mistake_recorded_at = '2026-11-06 00:00:00+00' WHERE question_id = $1", [confirmed.json().id]);
    const linkedMistakes = (await request(owner, 'GET', '/mistakes')).json().mistakes.filter(item => item.stem === question.stem);
    assert.equal(linkedMistakes.length, 1);
    assert.equal(linkedMistakes[0].sourceCount, 2);
    assert.equal(linkedMistakes[0].day, '2026-11-04');
    assert.equal(linkedMistakes[0].mistakeDay, '2026-11-06');
    assert.equal((await request(other, 'POST', equivalents, { revokeId: links[0].json().id })).statusCode, 404);
    assert.equal((await request(owner, 'POST', equivalents, { revokeId: links[0].json().id })).json().status, 'revoked');
    const restored = (await request(owner, 'GET', '/progress')).json().courses.find(item => item.id === priorCoverage.id);
    assert.deepEqual(restored, priorCoverage);
    assert.ok((await request(owner, 'GET', equivalents)).json().links[0].revokedAt);
    assert.equal((await request(owner, 'GET', '/mistakes')).json().mistakes.filter(item => item.stem === question.stem).length, 2);

    const unordered = await request(owner, 'POST', uploadPath + '&school=page-order-test&autoTitle=true', samplePaper(true));
    const unorderedId = unordered.json().paper.id;
    const unorderedPath = '/papers/' + unorderedId;
    assert.equal(await processNextPaper(worker, undefined, undefined, undefined, { tenant: ownerId, id: unorderedId }, true), true);
    assert.deepEqual((await request(owner, 'GET', unorderedPath)).json().pageReviews.map(row => [row.page, row.status]),
      [[1, 'queued'], [2, 'queued']]);
    const pageWorker = new pg.Pool({ user: 'beitibao_test_release_page' });
    try {
      for (const page of [1, 2]) {
        assert.equal(await processNextPageRecognition(pageWorker, async () => ({
          model: 'test', promptVersion: 'test', printedPage: 3 - page,
          paperTitle: page === 1 ? '卷面识别标题' : '第二页标题不得覆盖',
          ...(page === 1 && { continuation: 'Give the proof.' }),
          stems: page === 1 ? ['Explain binary trees.', 'Describe round robin scheduling.', 'Compare arrays and lists.']
            : ['Derive the tangent slope.', 'Compute the variance.', 'Prove the limit exists.']
        }), undefined, { tenant: ownerId, id: unorderedId, page }, true, true), true);
        assert.deepEqual((await request(owner, 'GET', unorderedPath)).json().paper.pageOrder, page === 1 ? [] : [2, 1]);
      }
    } finally {
      await pageWorker.end();
    }
    const autoPublished = (await request(owner, 'GET', unorderedPath)).json();
    assert.equal(autoPublished.paper.title, '卷面识别标题');
    assert.equal(autoPublished.questions.length, 6);
    assert.deepEqual(autoPublished.questions.find(question => question.stem === 'Prove the limit exists.\nGive the proof.').sourcePages, [2, 1]);
    assert.equal((await admin.query("SELECT count(*)::int AS count FROM paper_questions WHERE paper_id = $1 AND solution_status = 'queued'", [unorderedId])).rows[0].count, 6);
    assert.ok(autoPublished.pageReviews.every(page => page.reviewedAt));
    const autoPractice = (await request(owner, 'POST', unorderedPath + '/practice', {})).json();
    assert.equal(autoPractice.questions.length, 6);
    assert.equal(autoPractice.questions[0].pageNumber, 2);
    const first = autoPractice.questions[0];
    const editPath = unorderedPath + '/questions/' + first.id + '/stem-correction';
    assert.equal((await request(other, 'POST', editPath, { stem: 'Unauthorized' })).statusCode, 404);
    assert.equal((await request(owner, 'POST', editPath, { stem: 'Corrected in practice.' })).json().stemCorrection, 'Corrected in practice.');
    const during = (await request(owner, 'GET', unorderedPath + '/practice')).json().questions[0];
    assert.equal(during.stem, first.stem);
    assert.equal(during.inputChanged, true);
    assert.equal(during.stemCorrection, undefined);
    assert.equal(during.reference, undefined);


  } finally {
    await app.close();
    await Promise.all([pool.end(), admin.end(), worker.end(), queue.end()]);
  }

  async function register(email) {
    const invite = randomBytes(32).toString('base64url');
    await admin.query(
      "INSERT INTO invitations (token_hash, email, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [createHash('sha256').update(invite).digest('hex'), email]
    );
    const response = await request(null, 'POST', '/auth/register', { email, invite, password: 'local demo test password' });
    assert.equal(response.statusCode, 201);
    return { cookie: response.headers['set-cookie'].split(';')[0], csrf: response.json().csrfToken };
  }

  function request(session, method, path, payload, mediaType = 'application/pdf') {
    return app.inject({
      method, url: '/api/v1' + path, payload,
      headers: {
        origin,
        ...(Buffer.isBuffer(payload) && { 'content-type': mediaType }),
        ...(session && { cookie: session.cookie, 'x-csrf-token': session.csrf })
      }
    });
  }
});

test('archives model-identified PDF covers only when the course match is unique', async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const worker = new pg.Pool({ connectionString: process.env.LOCAL_PAPER_WORKER_DATABASE_URL });
  const app = await createApp({ pool, origin, localPapers: true, localModelPreview: true, pdfOnlyUploads: true });
  const invite = randomBytes(32).toString('base64url');
  const email = 'automatic-pdf@example.test';
  await admin.query("INSERT INTO invitations (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [email, createHash('sha256').update(invite).digest('hex')]);
  const register = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
    headers: { origin }, payload: { email, invite, password: 'automatic test passphrase' } });
  assert.equal(register.statusCode, 201, register.body);
  const headers = { origin, cookie: register.headers['set-cookie'].split(';')[0], 'x-csrf-token': register.json().csrfToken };
  const call = (method, path, payload) => app.inject({ method, url: '/api/v1' + path, payload,
    headers: { ...headers, ...(Buffer.isBuffer(payload) && { 'content-type': 'application/pdf' }) } });
  try {
    const { rows: [{ id: tenant }] } = await admin.query('SELECT id FROM accounts WHERE email = $1', [email]);
    const course = (await call('POST', '/courses', { name: '计算机基础', term: '2026 秋' })).json().course;
    const path = '/courses/auto/papers?title=untitled-scan&recognizeScans=true&autoTitle=true';
    const pdf = samplePaper();
    const submit = await call('POST', path, pdf);
    assert.equal(submit.statusCode, 202, submit.body);
    const id = submit.json().paper.id;
    assert.equal(submit.json().paper.courseId, null);
    const target = { id, tenant };
    assert.equal(await processNextPaper(worker, undefined, undefined, undefined, target, true), true);
    const recognize = async () => ({ model: 'test', promptVersion: 'test', paperTitle: '计算机基础期末试卷', paperSubject: '计算机基础',
      printedPage: 1, stems: ['1. 简述栈的用途。', '2. 简述队列的用途。', '3. 举例说明树的层序遍历。',
        '4. 比较顺序表与链表。', '5. 说明散列表处理冲突的方法。'] });
    assert.equal(await processNextPageRecognition(worker, recognize, undefined, { ...target, page: 1 }, true, true), true);
    const paper = (await call('GET', '/papers/' + id)).json().paper;
    assert.equal(paper.title, '计算机基础期末试卷');
    assert.equal(paper.recognizedSubject, '计算机基础');
    assert.equal(paper.courseId, course.id);
    assert.equal((await call('POST', path, pdf)).json().paper.id, id);
    const assigned = (await call('GET', '/courses/' + course.id + '/papers')).json().papers;
    assert.equal(assigned[0].libraryStatus, 'ready');
    assert.equal((await admin.query('SELECT count(*)::int AS total FROM paper_questions WHERE paper_id = $1 AND solution_status = $2', [id, 'queued'])).rows[0].total, 5);
    assert.equal((await admin.query('SELECT count(*)::int AS total FROM predictions WHERE tenant_id = $1 AND course_id = $2', [tenant, course.id])).rows[0].total, 0);
    const confirm = await call('POST', '/courses/' + course.id + '/prediction/confirm-sources', { paperIds: [id] });
    assert.equal(confirm.statusCode, 200, confirm.body);
    assert.equal((await admin.query('SELECT count(*)::int AS total FROM predictions WHERE tenant_id = $1 AND course_id = $2', [tenant, course.id])).rows[0].total, 1);

    const scan = await call('POST', path, samplePaper(true));
    assert.equal(scan.statusCode, 202, scan.body);
    const scanTarget = { id: scan.json().paper.id, tenant };
    const scanPath = '/papers/' + scanTarget.id;
    assert.equal(await processNextPaper(worker, undefined, undefined, undefined, scanTarget, true), true);
    assert.equal(await processNextPageRecognition(worker, async () => ({
      model: 'test', promptVersion: 'test', paperSubject: '计算机基础', choiceOnly: true, printedPage: 1,
      stems: ['1. 跨页选择题（A）甲（B）乙'], choiceCounts: [4]
    }), undefined, { ...scanTarget, page: 1 }, true), true);
    const readSecond = complete => async (_image, _type, _request, examIsChoiceOnly) => {
      assert.equal(examIsChoiceOnly, true);
      return { model: 'test', promptVersion: 'test', printedPage: 2, continuation: '（C）丙（D）丁',
        stems: [complete ? '2. 另一道选择题\nA. 甲\nB. 乙\nC. 丙\nD. 丁' : '2. 另一道选择题'] };
    };
    assert.equal(await processNextPageRecognition(worker, readSecond(false), undefined, { ...scanTarget, page: 2 }, true), true);
    const partial = (await call('GET', scanPath)).json();
    assert.deepEqual(partial.questions.map(question => [question.kind, question.sourcePages]), [['choice', [1, 2]]]);
    assert.match(partial.questions[0].stem, /A\. 甲\nB\. 乙\nC\. 丙\nD\. 丁$/u);
    assert.equal(partial.pageReviews[1].failure, 'OCR_INCOMPLETE_OPTIONS');
    assert.equal(partial.pageReviews[1].reviewedAt, null);
    assert.equal((await call('POST', scanPath + '/practice', {})).json().code, 'PAGE_REVIEW_REQUIRED');
    assert.equal((await call('POST', scanPath + '/recall', { kind: 'choice' })).statusCode, 200);
    const retryPath = scanPath + '/pages/2/recognition';
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await call('POST', retryPath)).statusCode, 202);
    }
    assert.equal(await processNextPageRecognition(worker, readSecond(true), undefined, { ...scanTarget, page: 2 }, true), true);
    const complete = (await call('POST', scanPath + '/practice', {})).json();
    assert.deepEqual(complete.questions.map(question => [question.pageNumber, question.kind]), [[1, 'choice'], [2, 'choice']]);
    assert.equal(complete.questions[0].id, partial.questions[0].id);

    const otherTerm = (await call('POST', '/courses', { name: '计算机基础', term: '2027 春' })).json().course;
    const secondPdf = Buffer.concat([pdf, Buffer.from('\n% second fixture\n')]);
    const second = (await call('POST', path, secondPdf)).json().paper;
    const secondTarget = { id: second.id, tenant };
    assert.equal(await processNextPaper(worker, undefined, undefined, undefined, secondTarget, true), true);
    assert.equal(await processNextPageRecognition(worker, recognize, undefined, { ...secondTarget, page: 1 }, true, true), true);
    const pending = (await call('GET', '/courses/auto/papers')).json().papers.find(item => item.id === second.id);
    assert.equal(pending.libraryStatus, 'unassigned');
    assert.equal((await call('POST', '/papers/' + second.id + '/practice', {})).statusCode, 404);
    assert.equal((await call('POST', '/papers/' + second.id + '/assignment', { courseId: otherTerm.id })).statusCode, 200);
    assert.equal((await call('GET', '/papers/' + second.id)).json().paper.courseId, otherTerm.id);
  } finally {
    await app.close();
    await Promise.all([pool.end(), admin.end(), worker.end()]);
  }
});
