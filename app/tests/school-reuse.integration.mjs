import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createApp } from '../dist/server/app.js';
import { processNextPaper } from '../dist/server/paper-worker.js';
import { processNextPageRecognition } from '../dist/server/pdf-page-recognition.js';
import { processNextSolution } from '../dist/server/model-solution.js';
import { processNextPrediction } from '../dist/server/predictions.js';
import { schoolPageFingerprints } from '../dist/server/paper-parser.js';

const origin = 'https://school-reuse.example.test';
const adminEmail = 'school-admin@example.test';
const pages = [
  ['1. Which structure removes the most recently added item?', '2. Which structure processes items in arrival order?', '3. Explain the condition needed for binary search.'],
  ['4. Describe breadth-first tree traversal.', '5. Explain an advantage of hashing keys.', '6. Define the base case in a recursive function.']
];
const changes = [pages[0], ['4. Describe depth-first tree traversal.', ...pages[1].slice(1)]];
const generated = [
  '从浏览器连续回退的行为判断适合保存访问历史的结构。',
  '银行按取号顺序叫号，待办请求适合放进什么结构？',
  '目录编号已经递增，定位目标时可以采用哪种折半方法？',
  '比赛对阵图按离根节点距离输出记录，采用哪种遍历？',
  '用邮箱地址作为映射键，直接查询账户时依赖哪类映射？',
  '求整数阶乘的函数在输入为零时应当返回什么？'
];

function pdfOf(contents) {
  const kids = contents.map((_, index) => (4 + index * 2) + ' 0 R').join(' ');
  const items = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [' + kids + '] /Count ' + contents.length + ' >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (const [index, questions] of contents.entries()) {
    items.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (5 + index * 2) + ' 0 R >>');
    const rows = ['Algorithms final practice', ...questions, 'Page ' + (index + 1) + ' of 2'];
    const stream = 'BT /F1 12 Tf 40 760 Td 24 TL ' + rows.map(text => '(' + text + ') Tj T*').join(' ') + ' ET\n';
    items.push('<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream');
  }
  let file = '%PDF-1.4\n';
  const offsets = items.map((item, index) => {
    const offset = file.length;
    file += (index + 1) + ' 0 obj\n' + item + '\nendobj\n';
    return offset;
  });
  return Buffer.from(file + 'xref\n0 ' + (items.length + 1) + '\n0000000000 65535 f \n' +
    offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') +
    'trailer\n<< /Size ' + (items.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + file.length + '\n%%EOF\n');
}

test('same-school accounts reuse complete originals and predictions with zero model calls and compare subsequent pages', async t => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const workers = Object.fromEntries(['paper', 'page', 'solution', 'prediction'].map(lane =>
    [lane, new pg.Pool({ connectionString: process.env['RELEASE_' + lane.toUpperCase() + '_DATABASE_URL'] })]));
  const stored = new Map();
  const storage = {
    signUpload: key => ({ url: origin + '/objects', fields: { key } }),
    read: async ({ key, version }) => stored.get(key)?.get(version) ?? null
  };
  const settings = { storage, modelsEnabled: true, predictionsEnabled: true };
  const app = await createApp({ pool, origin, accountAdminEmail: adminEmail, pdfOnlyUploads: true,
    privatePapers: { ...settings, storage: () => storage } });
  const call = (session, method, path, payload) =>
    app.inject({ method, url: '/api/v1' + path, payload, headers: { origin, ...session } });
  function sessionOf(response) {
    assert.equal(response.statusCode, 201, response.body);
    return { cookie: response.headers['set-cookie'].split(';')[0], 'x-csrf-token': response.json().csrfToken };
  }
  const response = value => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }],
    usage: { prompt_tokens: 20, completion_tokens: 20 } });
  process.env.BAILIAN_WORKSPACE_ID = 'school-fixture';
  process.env.DASHSCOPE_API_KEY = 'fixture-key';
  process.env.BAILIAN_DAILY_BUDGET_CENTS = '2000';
  process.env.BAILIAN_TENANT_DAILY_BUDGET_CENTS = '2000';
  delete process.env.BAILIAN_MODEL_LIMITS_JSON;
  const calls = { ocr: 0, solution: 0, prediction: 0 };
  const modelPages = [];
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    assert.match(String(url), /^https:\/\/school-fixture\.cn-beijing\.maas\.aliyuncs\.com\//);
    const { messages, enable_thinking: thinking } = JSON.parse(body);
    if (messages[0].content.startsWith('按原文逐字转录')) {
      calls.ocr++;
      const { number, stems } = modelPages.shift();
      return response({ printedPage: number, printedTotalPages: 2, paperTitle: 'Algorithms final practice', paperSubject: 'Algorithms',
        questions: stems.map(stem => ({ stem, standalone: true, visualContext: '', figures: [] })) });
    }
    if (messages[0].content.startsWith('你是大学课程解题助手')) {
      calls.solution++;
      const input = messages.at(-1).content;
      const stem = input.startsWith('{') ? JSON.parse(input).stem : input;
      return response({ status: 'solved', answer: '参考结论 ' + stem[0], explanation: '按题给条件推导。',
        knowledgePoints: ['考点 ' + stem[0]], designLogic: '理解基本概念。' });
    }
    calls.prediction++;
    const input = JSON.parse(messages.at(-1).content.split('\n').at(-1));
    if (thinking) return response({ solvable: true, answer: '对应术语', explanation: '根据给出的约束判断。' });
    if (input.proposedAnswer) return response({ independentAnswer: input.proposedAnswer, supported: true });
    const stem = input.evidence.stem.includes('depth-first') ? '遍历迷宫分支时一路走到尽头再回到分岔口，采用哪种搜索？'
      : generated[Number(input.evidence.stem[0]) - 1];
    return response({ stem, answer: '对应术语', explanation: '根据给出的约束判断。',
      rationale: '检验同一知识点的应用。', knowledgePoints: ['基础概念'] });
  });

  const pdf = pdfOf(pages);
  const variant = pdfOf(changes);
  async function upload(learner, bytes, { course = 'auto', share = false } = {}) {
    const initialized = await call(learner.session, 'POST', '/courses/' + course + '/paper-uploads', {
      title: '未命名扫描件', autoTitle: true, mediaType: 'application/pdf', rightsConfirmed: true, allowModels: true,
      redacted: true, shareAtSchool: share, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')
    });
    assert.equal(initialized.statusCode, 201, initialized.body);
    const { uploadId, fields } = initialized.json();
    const versionId = randomUUID();
    stored.set(fields.key, new Map([[versionId, bytes]]));
    const result = await call(learner.session, 'POST', '/paper-uploads/' + uploadId + '/complete', { versionId });
    assert.equal(result.statusCode, 202, result.body);
    return { id: result.json().paper.id, tenant: learner.id };
  }
  const inspect = async (learner, target) => (await call(learner.session, 'GET', '/papers/' + target.id + '?includeAnalysis=true')).json();
  const meter = async learner => (await admin.query(
    'SELECT task,count(*)::int AS calls FROM model_invocations WHERE tenant_id=$1 GROUP BY task ORDER BY task', [learner.id])).rows;
  const prediction = async (learner, course = learner.course) =>
    (await call(learner.session, 'GET', '/courses/' + course + '/prediction')).json();
  const job = async (learner, course = learner.course) => (await admin.query(`
    SELECT id, status, paper_id AS "paperId" FROM predictions WHERE tenant_id=$1 AND course_id=$2
    ORDER BY created_at DESC, id DESC LIMIT 1`, [learner.id, course])).rows[0];
  async function confirmSources(learner, papers, course = learner.course) {
    const result = await call(learner.session, 'POST', '/courses/' + course + '/prediction/confirm-sources',
      { paperIds: papers.map(paper => paper.id) });
    assert.equal(result.statusCode, 200, result.body);
    return result.json();
  }
  async function completeOriginal(learner, target) {
    const path = '/papers/' + target.id + '/practice';
    const started = await call(learner.session, 'POST', path, {});
    assert.equal(started.statusCode, 200, started.body);
    const { questions, revision } = started.json();
    const submitted = await call(learner.session, 'POST', path + '/save', {
      revision, answers: Object.fromEntries(questions.map(question => [question.id, '已练习'])), submit: true
    });
    assert.equal(submitted.statusCode, 200, submitted.body);
  }
  async function runPage(target, number, stems) {
    modelPages.push({ number, stems });
    assert.equal(await processNextPageRecognition(workers.page, undefined, storage, { ...target, page: number }, true, true), true);
    assert.equal(modelPages.length, 0);
  }
  async function solveAll(learner, target) {
    const before = await inspect(learner, target);
    for (const q of before.questions.filter(q => q.solutionStatus === 'queued')) {
      assert.equal(await processNextSolution(workers.solution, undefined, storage, { tenant: learner.id, id: q.id }), true);
    }
    return inspect(learner, target);
  }

  try {
    const invite = randomBytes(32).toString('base64url');
    await admin.query("INSERT INTO invitations (email,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 hour')",
      [adminEmail, createHash('sha256').update(invite).digest('hex')]);
    const operator = sessionOf(await call({}, 'POST', '/auth/register', { email: adminEmail, invite, password: 'demo admin passphrase' }));
    const learners = [];
    for (const phone of ['13900002151', '13900002152']) {
      const issued = await call(operator, 'POST', '/admin/invitations', { phone, subjectLimit: 3 });
      assert.equal(issued.statusCode, 201, issued.body);
      const session = sessionOf(await call({}, 'POST', '/auth/register',
        { phone, invite: issued.json().invite, password: 'demo student passphrase' }));
      const { rows: [{ id }] } = await admin.query('SELECT id FROM accounts WHERE phone=$1', [phone]);
      const school = await call(operator, 'POST', '/admin/accounts/' + id + '/school', { schoolName: '复用验收大学' });
      assert.equal(school.statusCode, 200, school.body);
      assert.equal((await call(session, 'POST', '/admin/accounts/' + id + '/school', { schoolName: '其他学校' })).statusCode, 403);
      const course = await call(session, 'POST', '/courses', { name: 'Algorithms', teacher: '陈宏远', term: '2026 秋' });
      assert.equal(course.statusCode, 201, course.body);
      learners.push({ id, session, course: course.json().course.id, school: school.json().schoolId });
    }
    const [first, second] = learners;
    assert.equal(first.school, second.school);
    const original = await upload(first, pdf, { share: true });
    const duplicate = await upload(second, pdf);
    assert.equal(await processNextPaper(workers.paper, undefined, undefined, settings, original), true);
    assert.equal(await processNextPaper(workers.paper, undefined, undefined, settings, duplicate), true);
    assert.equal((await inspect(second, duplicate)).paper.status, 'processing');
    assert.deepEqual(await meter(second), []);
    assert.equal(calls.ocr + calls.solution + calls.prediction, 0);
    await runPage(original, 1, pages[0]);
    assert.equal(await job(first), undefined);
    assert.deepEqual(await confirmSources(first, [original]), { sourcesConfirmed: true, waitingForPapers: true });
    assert.equal(await job(first), undefined);
    await runPage(original, 2, pages[1]);
    const solved = await solveAll(first, original);
    assert.equal(solved.questions.length, 6);
    assert.ok(solved.questions.every(q => q.modelSolution?.knowledgePoints.length));
    const queued = await job(first);
    assert.equal(queued.status, 'queued');
    assert.equal(await processNextPrediction(workers.prediction, undefined, { id: queued.id, tenant: first.id }), true);
    const readyWhileLocked = await job(first);
    assert.equal(readyWhileLocked.status, 'ready');
    assert.deepEqual(await prediction(first), { enabled: true, locked: true, sourcesConfirmed: true, waitingForPapers: false,
      questions: [], prediction: null, history: [] });
    assert.equal((await call(first.session, 'GET', '/papers/' + readyWhileLocked.paperId)).json().code, 'PREDICTION_LOCKED');
    assert.equal((await call(first.session, 'POST', '/papers/' + readyWhileLocked.paperId + '/practice', {})).json().code, 'PREDICTION_LOCKED');
    await completeOriginal(first, original);
    const firstPrediction = await prediction(first);
    assert.equal(firstPrediction.prediction.status, 'ready', JSON.stringify(firstPrediction.prediction));
    assert.equal(firstPrediction.questions.length, 6);
    assert.deepEqual(await meter(first), [{ task: 'page', calls: 2 }, { task: 'prediction', calls: 18 }, { task: 'solution', calls: 6 }]);

    const baseline = { ...calls };
    await admin.query("UPDATE papers SET lease_until=now()-interval '1 second' WHERE tenant_id=$1 AND id=$2", [second.id, duplicate.id]);
    assert.equal(await processNextPaper(workers.paper, undefined, undefined, settings, duplicate), true);
    const reused = await inspect(second, duplicate);
    assert.equal(reused.paper.schoolReuse, 'exact');
    assert.equal(reused.paper.courseId, second.course);
    assert.equal(reused.paper.title, solved.paper.title);
    assert.equal(reused.questions.length, solved.questions.length);
    assert.deepEqual(reused.questions.map(q => q.modelSolution), solved.questions.map(q => q.modelSolution));
    assert.ok(reused.questions.every(q => !solved.questions.some(firstQ => firstQ.id === q.id)));
    assert.equal(await processNextPageRecognition(workers.page, undefined, storage, { ...duplicate, page: 1 }, true, true), false);
    assert.equal(await processNextSolution(workers.solution, undefined, storage, { tenant: second.id, id: reused.questions[0].id }), false);
    assert.equal((await call(second.session, 'GET', '/papers/' + original.id)).statusCode, 404);

    assert.equal(await job(second), undefined);
    await confirmSources(second, [duplicate]);
    const secondJob = await job(second);
    assert.equal(await processNextPrediction(workers.prediction, undefined, { id: secondJob.id, tenant: second.id }), true);
    assert.equal((await prediction(second)).locked, true);
    await completeOriginal(second, duplicate);
    const secondPrediction = await prediction(second);
    assert.equal(secondPrediction.prediction.schoolReused, true);
    assert.notEqual(secondPrediction.prediction.paperId, firstPrediction.prediction.paperId);
    assert.deepEqual(secondPrediction.questions.map(q => q.stem), firstPrediction.questions.map(q => q.stem));
    const predictionView = await inspect(second, { id: secondPrediction.prediction.paperId });
    assert.ok(predictionView.questions.every(q => q.modelSolution.evidence.every(e => e.paperId === duplicate.id &&
      reused.questions.some(originQuestion => originQuestion.id === e.id))));
    assert.deepEqual(await meter(second), []);
    assert.deepEqual(calls, baseline);

    const repacked = Buffer.concat([pdf, Buffer.from('% repacked metadata\n')]);
    const renderedMatch = await upload(second, repacked);
    assert.equal(await processNextPaper(workers.paper, undefined, undefined, settings, renderedMatch), true);
    assert.equal((await inspect(second, renderedMatch)).paper.schoolReuse, 'exact');
    const staleConfirm = await call(second.session, 'POST', '/courses/' + second.course + '/prediction/confirm-sources',
      { paperIds: [duplicate.id] });
    assert.equal(staleConfirm.json().code, 'PREDICTION_SOURCES_CHANGED');
    assert.equal((await prediction(second)).locked, true);
    await confirmSources(second, [duplicate, renderedMatch]);
    await completeOriginal(second, renderedMatch);
    assert.equal((await prediction(second)).prediction.id, secondJob.id);
    assert.deepEqual(await meter(second), []);
    assert.deepEqual(calls, baseline);

    const beforeHashes = await schoolPageFingerprints(pdf, 2);
    const afterHashes = await schoolPageFingerprints(variant, 2);
    assert.equal(beforeHashes[0], afterHashes[0]);
    assert.notEqual(beforeHashes[1], afterHashes[1]);
    const partial = await upload(second, variant, { course: second.course, share: true });
    assert.equal(await processNextPaper(workers.paper, undefined, undefined, settings, partial), true);
    assert.equal(await processNextPageRecognition(workers.page, undefined, storage, { ...partial, page: 1 }, true, true), false);
    await runPage(partial, 2, changes[1]);
    const changed = await inspect(second, partial);
    assert.equal(changed.paper.schoolReuse, 'pages');
    assert.ok(changed.questions.find(q => q.stem === changes[1][0]));
    assert.deepEqual(changed.questions.filter(q => q.pageNumber === 1).map(q => q.modelSolution),
      solved.questions.filter(q => q.pageNumber === 1).map(q => q.modelSolution));
    assert.ok(changed.questions.filter(q => q.pageNumber === 2).every(q => q.solutionStatus === 'queued'));
    assert.equal((await job(second)).id, secondJob.id);
    assert.equal((await prediction(second)).sourcesConfirmed, false);
    await confirmSources(second, [duplicate, renderedMatch, partial]);
    const refreshed = await job(second);
    assert.equal(refreshed.status, 'queued');
    assert.notEqual(refreshed.id, secondJob.id);
    assert.deepEqual(await meter(second), [{ task: 'page', calls: 1 }]);
    const solvedVariant = await solveAll(second, partial);
    assert.ok(solvedVariant.questions.every(question => question.solutionStatus === 'ready'));
    assert.deepEqual(await meter(second), [{ task: 'page', calls: 1 }, { task: 'solution', calls: 3 }]);
    const beforeChangedPrediction = calls.prediction;
    assert.equal(await processNextPrediction(workers.prediction, undefined, { id: refreshed.id, tenant: second.id }), true);
    assert.ok(calls.prediction > beforeChangedPrediction);
    await completeOriginal(second, partial);
    assert.equal((await prediction(second)).prediction.schoolReused, false);

    const shorter = await upload(second, pdfOf([pages[0]]), { course: second.course });
    assert.equal(await processNextPaper(workers.paper, undefined, undefined, settings, shorter), true);
    await runPage(shorter, 1, pages[0]);
    const incomplete = await inspect(second, shorter);
    assert.notEqual(incomplete.paper.schoolReuse, 'exact');
    assert.equal(incomplete.paper.missingPages, true);

    const newTerm = (await call(second.session, 'POST', '/courses',
      { name: 'Algorithms', teacher: '王老师', term: '2027 春' })).json().course.id;
    const otherTerm = await upload(second, pdf, { course: newTerm });
    assert.equal(await processNextPaper(workers.paper, undefined, undefined, settings, otherTerm), true);
    assert.equal((await inspect(second, otherTerm)).paper.schoolReuse, 'exact');
    await confirmSources(second, [otherTerm], newTerm);
    const otherTermPrediction = await job(second, newTerm);
    assert.equal(otherTermPrediction.status, 'queued');
    const predictionCalls = calls.prediction;
    assert.equal(await processNextPrediction(workers.prediction, undefined, { id: otherTermPrediction.id, tenant: second.id }), true);
    await completeOriginal(second, otherTerm);
    assert.equal((await prediction(second, newTerm)).prediction.schoolReused, true);
    assert.equal(calls.prediction, predictionCalls);

    const schoolPath = '/admin/accounts/' + second.id + '/school';
    assert.equal((await call(operator, 'POST', schoolPath, { schoolName: '另一所学校' })).statusCode, 200);
    const differentSchool = await upload(second, Buffer.concat([pdf, Buffer.from('% other verified school\n')]));
    assert.equal(await processNextPaper(workers.paper, undefined, undefined, settings, differentSchool), true);
    assert.equal((await inspect(second, differentSchool)).paper.schoolReuse, null);
    assert.equal((await call(operator, 'POST', schoolPath, { schoolName: '复用验收大学' })).statusCode, 200);

    assert.equal((await call(first.session, 'POST', '/papers/' + original.id + '/revoke-school-sharing', {})).statusCode, 200);
    const revoked = await upload(second, Buffer.concat([pdf, Buffer.from('% after revocation\n')]));
    assert.equal(await processNextPaper(workers.paper, undefined, undefined, settings, revoked), true);
    const cold = await inspect(second, revoked);
    assert.equal(cold.paper.schoolReuse, null);
    assert.ok(cold.pageReviews.every(page => page.status === 'queued'));
    t.diagnostic('Confirmed sources produced a prediction before learning completion. Identical complete sets reused it with zero model calls. Changed material queued and ran a new prediction.');
  } finally {
    await app.close();
    await Promise.all([pool.end(), admin.end(), ...Object.values(workers).map(worker => worker.end())]);
  }
});
