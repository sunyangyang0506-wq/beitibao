import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import sharp from 'sharp';
import { createApp } from '../../dist/server/app.js';
import { processNextPaper } from '../../dist/server/paper-worker.js';
import { processNextSolution } from '../../dist/server/model-solution.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const worker = new pg.Pool({ connectionString: process.env.LOCAL_PAPER_WORKER_DATABASE_URL });
const origin = 'http://127.0.0.1:5173';
const app = await createApp({ pool, origin, localPapers: true });
const calls = [];
const figuresOnly = process.argv.includes('--figures-only');
const manualCrops = process.argv.includes('--manual-crops');
const phoneJpeg = process.argv.includes('--phone-jpeg');
const singleQuestion = process.argv.find(argument => argument.startsWith('--question='))?.slice('--question='.length);
assert.ok(!phoneJpeg || (figuresOnly && !manualCrops), 'The phone variant needs recognition-only evaluation and fresh crop coordinates');
assert.ok(singleQuestion === undefined || (figuresOnly && !manualCrops && /^(1\.[1-5]|2\.[1-3])$/.test(singleQuestion)), 'A question fixture requires recognition-only evaluation');
const report = process.argv.find(argument => argument.startsWith('--report='))?.slice('--report='.length);
if (report && !/^results-[a-z0-9-]+\.json$/.test(report)) throw new Error('INVALID_REPORT_FILENAME');
const replay = process.argv.includes('--replay')
  ? JSON.parse(await readFile(new URL('results-whole-paper.json', import.meta.url), 'utf8')) : null;
const fetchModel = globalThis.fetch;
const result = { startedAt: new Date().toISOString(), calls, questions: [] };
globalThis.fetch = async (url, options) => {
  assert.equal(new URL(url).hostname, process.env.BAILIAN_WORKSPACE_ID + '.cn-beijing.maas.aliyuncs.com');
  const started = Date.now();
  const model = JSON.parse(options.body).model;
  const row = { model, startedAt: new Date(started).toISOString() };
  calls.push(row);
  if (replay) {
    const payload = JSON.parse(options.body);
    const content = calls.length === 1
      ? { questions: replay.recognition.stems.map((stem, index) => ({
        stem, visualContext: replay.recognition.visualContexts[index]
      })) }
      : { solutions: JSON.parse(payload.messages[1].content[0].text).map(({ index, stem }) => ({
        ...replay.cachedSolutions.find(item => item.stem === stem), index
      })) };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
  }
  const response = await fetchModel(url, options).catch(error => {
    Object.assign(row, { error: error.name, elapsedMs: Date.now() - started });
    throw error;
  });
  const body = await response.clone().json();
  Object.assign(row, { http: response.status, requestId: body.request_id ?? body.id, usage: body.usage,
    finishReason: body.choices?.[0]?.finish_reason, code: body.error?.code, elapsedMs: Date.now() - started });
  const message = body.error?.message ?? body.message;
  if (!response.ok && typeof message === 'string' && !/https?:|base64|Bearer|sk-/i.test(message)) row.message = message.slice(0, 240);
  return response;
};

let auth;
function request(method, path, payload, type) {
  return app.inject({ method, url: '/api/v1' + path, payload,
    headers: { origin, ...auth, ...(type && { 'content-type': type }) } });
}

try {
  const email = 'urjc-eval@example.test';
  const invite = randomBytes(32).toString('base64url');
  await admin.query("INSERT INTO invitations (token_hash, email, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [createHash('sha256').update(invite).digest('hex'), email]);
  const signup = await request('POST', '/auth/register', { email, invite, password: 'isolated evaluation password' });
  assert.equal(signup.statusCode, 201);
  auth = { cookie: signup.headers['set-cookie'].split(';')[0], 'x-csrf-token': signup.json().csrfToken };
  const course = await request('POST', '/courses', { name: 'Estructuras de Datos', term: '2025' });
  assert.equal(course.statusCode, 201);
  const source = await readFile(new URL(singleQuestion ? `inputs/${singleQuestion}.png` : 'whole-paper.png', import.meta.url));
  const image = phoneJpeg ? await sharp(source).resize({ width: 3200, height: 3200, fit: 'inside', withoutEnlargement: true }).rotate(3, { background: '#dedbd4' })
    .modulate({ brightness: 0.92 }).jpeg({ quality: 68 }).toBuffer() : source;
  const mediaType = phoneJpeg ? 'image/jpeg' : 'image/png';
  result.input = { mediaType, bytes: image.length, sha256: createHash('sha256').update(image).digest('hex'),
    ...(singleQuestion && { question: singleQuestion }),
    ...(phoneJpeg && { simulation: { maxLongEdgeBeforeRotation: 3200, rotationDegrees: 3, brightness: 0.92, jpegQuality: 68 } }) };
  const upload = await request('POST', '/courses/' + course.json().course.id + '/papers?title=URJC&school=Universidad%20Rey%20Juan%20Carlos', image, mediaType);
  assert.equal(upload.statusCode, 202);
  const paperId = upload.json().paper.id;
  const path = '/papers/' + paperId;
  assert.equal(await processNextPaper(worker, undefined, figuresOnly ? async () => { throw new Error('Recognition-only evaluation'); } : undefined), true);
  const paper = (await request('GET', path)).json().paper;
  result.paperStatus = paper.status;
  result.recognition = paper.recognition;
  assert.equal(paper.status, 'review');
  if (figuresOnly) {
    result.previews = [];
    const boxes = manualCrops ? JSON.parse(await readFile(new URL('figure-boxes.json', import.meta.url), 'utf8')) : {};
    result.manualRereads = {};
    let checkedApproval = false;
    for (const [candidate, figures] of (paper.recognition.figures ?? []).entries()) {
      for (const [index, figure] of figures.entries()) {
        if (!figure.box) continue;
        const response = await request('GET', `${path}/recognition/${candidate}/figures/${index}`);
        assert.equal(response.statusCode, 200);
        result.previews.push({ candidate, index, bytes: response.rawPayload.length });
      }
      if (figures.some(figure => figure.status === 'needs_review')) {
        const attempt = await request('POST', path + '/recognition-review', {
          candidateIndex: candidate, stem: paper.recognition.stems[candidate]
        });
        assert.equal(attempt.json().code, 'FIGURE_REVIEW_REQUIRED');
      }
      const id = paper.recognition.stems[candidate].match(/\b[12]\.[1-5]\b/)?.[0];
      if (id && boxes[id] && figures.length) {
        const region = `${path}/recognition/${candidate}/figures/0`;
        const response = await request('POST', region + '/reread', { box: boxes[id] });
        assert.equal(response.statusCode, 200, response.body);
        result.manualRereads[id] = response.json().figure;
        assert.equal((await request('POST', region + '/reread', { box: boxes[id] })).statusCode, 409);
        const preview = await request('GET', region);
        assert.equal(preview.statusCode, 200);
        if (!report && (id === '1.1' || id === '1.5')) {
          await writeFile(new URL(`b06-figure-${id}.png`, import.meta.url), preview.rawPayload);
        }
        if (!checkedApproval) {
          const review = await request('POST', path + '/recognition-review', {
            candidateIndex: candidate, stem: paper.recognition.stems[candidate],
            visualReview: '核对流程测试记录，模型评测以独立原图为准。'
          });
          assert.equal(review.json().outcome, 'confirmed', review.body);
          const saved = (await request('GET', path)).json().reviews.find(row => row.candidateIndex === candidate);
          assert.ok(saved.questionId && saved.visualReview);
          checkedApproval = true;
        }
      }
    }
  } else {
  const {rows:[cache]} = await admin.query('SELECT c.solutions FROM paper_model_cache c JOIN papers p ON p.model_cache_key = c.cache_key WHERE p.id = $1', [paperId]);
  assert.ok(cache, 'Whole-paper solve did not populate the production cache');
  result.cachedSolutions = cache.solutions;
  for (const [candidateIndex, stem] of paper.recognition.stems.entries()) {
    const review = await request('POST', path + '/recognition-review', { candidateIndex, stem });
    assert.equal(review.json().outcome, 'confirmed');
  }
  const reviewed = (await request('GET', path)).json();
  const inferenceCount = calls.length;
  for (const {id,stem} of reviewed.questions) {
    const reveal = path + '/questions/' + id + '/reveal';
    await request('POST', reveal, {});
    assert.equal(await processNextSolution(worker), true);
    const revealed = await request('POST', reveal, {});
    assert.equal(revealed.statusCode, 200);
    const data = revealed.json();
    assert.equal(data.solutionStatus, 'ready');
    assert.deepEqual(data.modelSolution, cache.solutions.find(item => item.stem === stem));
    result.questions.push({ stem, solution: data.modelSolution });
  }
  assert.equal(calls.length, inferenceCount, 'Reveals should use cached whole-paper solutions');
  }
} finally {
  result.finishedAt = new Date().toISOString();
  if (!replay) await writeFile(new URL(report ?? (figuresOnly ? (manualCrops ? 'results-b06-recrop.json' : 'results-b06.json') : 'results-whole-paper.json'), import.meta.url), JSON.stringify(result,null,2)+'\n');
  globalThis.fetch = fetchModel;
  await app.close();
  await Promise.all([pool.end(),admin.end(),worker.end()]);
}
console.log(JSON.stringify({status:result.paperStatus, questions:result.questions.length, replay:Boolean(replay), calls}));
