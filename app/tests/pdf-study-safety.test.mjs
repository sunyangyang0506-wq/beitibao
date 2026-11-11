import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import sharp from 'sharp';
import { createApp } from '../dist/server/app.js';
import { processNextSolution } from '../dist/server/model-solution.js';
import { processNextPaper } from '../dist/server/paper-worker.js';
import { processNextPageRecognition } from '../dist/server/pdf-page-recognition.js';
import { matchPrintedChoiceReferences, printedChoiceKey } from '../dist/server/printed-paper-answers.js';
import { samplePaper } from './fixtures/sample-paper.mjs';

const choice = number => `${number}. Which structure uses FIFO?\nA. Queue\nB. Stack\nC. Heap\nD. Tree`;

test('an answer key requires an explicit heading, a unique numbered choice and agreement between sources', () => {
  assert.deepEqual(printedChoiceKey('参考答案\n０１．Ｃ　2、A；3) B'), [
    { number: 1, answer: 'C' }, { number: 2, answer: 'A' }, { number: 3, answer: 'B' }
  ]);
  assert.deepEqual(printedChoiceKey('1. A\n2. B'), []);
  assert.deepEqual(printedChoiceKey('Answers\n1. A. This is a worked solution.'), []);
  const questions = [{ id: 'q', stem: choice(1), question_kind: 'choice' }];
  for (const pages of [
    [{ page: 1, text: 'Answers: 1. C', ocr: 'Answers: 1. A' }],
    [{ page: 1, text: 'Answers: 1. H' }],
    [{ page: 1, text: 'Answers: 1. A' }, { page: 2, text: 'Answers: 1. A' }]
  ]) assert.deepEqual(matchPrintedChoiceReferences(questions, [choice(1)], pages), []);
  assert.deepEqual(matchPrintedChoiceReferences(questions, [choice(1), '1. Same number in another section'],
    [{ page: 1, text: 'Answers: 1. A' }]), []);
});

test('PDF upload holds conflicting figures and grades printed keys only with their captured source', async () => {
  const origin = 'https://pdf-study-safety.example.test';
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const paperWorker = new pg.Pool({ connectionString: process.env.RELEASE_PAPER_DATABASE_URL });
  const pageWorker = new pg.Pool({ connectionString: process.env.RELEASE_PAGE_DATABASE_URL });
  const solutionWorker = new pg.Pool({ connectionString: process.env.RELEASE_SOLUTION_DATABASE_URL });
  const app = await createApp({ pool, origin, localPapers: true, localModelPreview: true });
  const tenant = randomUUID(), course = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const sha = value => createHash('sha256').update(value).digest('hex');
  const headers = { origin, cookie: 'beitibao_session=' + token, 'x-csrf-token': sha('csrf:' + token) };
  const call = (method, path, payload) => app.inject({ method, url: '/api/v1' + path, payload,
    headers: { ...headers, ...(Buffer.isBuffer(payload) && { 'content-type': 'application/pdf' }) } });
  const post = async (path, payload, status = 200) => {
    const response = await call('POST', path, payload);
    assert.equal(response.statusCode, status, response.body);
    return response.json();
  };
  const graph = { kind: 'directed', nodes: ['A', 'B'], edges: [{ from: 'A', to: 'B', label: '7' }], description: '' };
  const opposite = { ...graph, edges: [{ from: 'B', to: 'A', label: '7' }] };
  const tree = { kind: 'tree', nodes: ['0041', '0011', '0075'],
    edges: [{ from: '0041', to: '0011', label: 'left' }, { from: '0041', to: '0075', label: 'right' }], description: '' };
  const box = [100, 100, 550, 550];
  const figure = (initial, reread) => ({ box, initial, reread, status: 'needs_review', reason: 'conflict' });
  const directedStem = '3. Calculate the weighted out-degree from the directed graph.';
  const avlStem = '4. Describe the parent and child relationships of the AVL tree.';
  try {
    await admin.query('INSERT INTO accounts (id,email,password_hash) VALUES ($1,$2,$3)', [tenant, tenant + '@example.test', 'synthetic']);
    await admin.query("INSERT INTO sessions (token_hash,account_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [sha(token), tenant]);
    await admin.query("INSERT INTO courses (tenant_id,id,name,term) VALUES ($1,$2,'Synthetic','2026')", [tenant, course]);
    const uploaded = await post('/courses/' + course + '/papers?title=Study+safety&recognizeScans=true', samplePaper(true, 'Answer Key: 1. A'), 202);
    const id = uploaded.paper.id;
    const path = '/papers/' + id;
    assert.equal(await processNextPaper(paperWorker, undefined, undefined, undefined, { id, tenant }, true), true);
    assert.equal(await processNextPageRecognition(pageWorker, async (_bytes, _type, _request, _choiceOnly, figureSource) => {
      const image = await sharp(await figureSource()).metadata();
      assert.equal(Math.max(image.width, image.height), 3600);
      return { model: 'stub', promptVersion: 'test', stems: [choice(1), choice(2), directedStem, avlStem],
        figures: [[], [], [figure(graph, opposite)], [figure(tree, { ...tree, edges: [tree.edges[0],
          { from: '0011', to: '0075', label: 'right' }] })]] };
    }, undefined, { id, tenant, page: 1 }, true), true);
    assert.equal(await processNextPageRecognition(pageWorker, async () => ({
      model: 'stub', promptVersion: 'test', stems: [], printedAnswerKey: 'Answer Key: 1. A 2. C'
    }), undefined, { id, tenant, page: 2 }, true), true);
    const pending = (await call('GET', path)).json();
    assert.deepEqual(pending.questions.map(item => item.stem), [choice(1), choice(2)]);
    assert.deepEqual(pending.pageReviews[0].figureReviewCandidates, [2, 3]);
    assert.equal(pending.pageReviews[0].reviewedAt, null);
    assert.equal(pending.pageReviews[1].recognition.printedAnswerKey, undefined);
    assert.equal((await post(path + '/practice', {}, 409)).code, 'PAGE_REVIEW_REQUIRED');
    const [first, second] = pending.questions.map(question => path + '/questions/' + question.id);
    assert.deepEqual((await post(first + '/reveal', {})).reference,
      { kind: 'choice', source: 'paper', answers: ['A'], explanation: '', sourcePage: 2 });
    assert.equal((await post(second + '/reveal', {})).reference.source, 'paper_ocr');
    const crop = await call('GET', path + '/recognition/2/figures/0');
    assert.equal(crop.headers['content-type'], 'image/png');
    assert.equal((await post(path + '/recognition-review', { candidateIndex: 2, stem: directedStem }, 409)).code, 'FIGURE_REVIEW_REQUIRED');
    const verifiedGraph = { candidateIndex: 2, stem: directedStem, visualReview: 'A → B (7)' };
    for (let replay = 0; replay < 2; replay++) {
      assert.equal((await post(path + '/recognition-review', verifiedGraph)).outcome, 'confirmed');
    }
    assert.deepEqual((await call('GET', path)).json().pageReviews[0].figureReviewCandidates, [3]);
    await post(path + '/recognition-review', { candidateIndex: 3, stem: avlStem, visualReview: '0041 → 0011 (left); 0041 → 0075 (right)' });
    const ready = (await call('GET', path)).json();
    assert.equal(ready.questions.length, 4);
    assert.ok(ready.pageReviews.every(page => page.reviewedAt));
    const graphId = ready.questions.find(question => question.stem === directedStem).id;
    let solverCalled = false;
    assert.equal(await processNextSolution(solutionWorker, async (stem, _request, image) => {
      solverCalled = true;
      assert.ok(stem.includes('A → B (7)'));
      assert.ok(image);
      return { status: 'solved', answer: '7', explanation: 'The one outgoing edge has weight 7.' };
    }, undefined, { id: graphId, tenant }), true);
    assert.ok(solverCalled);
    const draft = await post(path + '/practice', {});
    assert.ok(draft.questions.every(question => !('reference' in question)));
    assert.equal((await post(second + '/reveal', {}, 409)).code, 'CLOSED_BOOK_ACTIVE');
    const result = await post(path + '/practice/save', { revision: draft.revision, changes: {
      [pending.questions[0].id]: 'A', [pending.questions[1].id]: 'C'
    }, submit: true });
    assert.equal(result.questions.find(question => question.id === pending.questions[0].id).result, 'correct');
    assert.equal(result.questions.find(question => question.id === pending.questions[1].id).result, 'needs_review');
    const confirm = { kind: 'choice', source: 'verified', answers: ['C'], explanation: '', confirmPrinted: true };
    for (let replay = 0; replay < 2; replay++) {
      const saved = (await post(second + '/reference', confirm)).reference;
      assert.equal(saved.source, 'verified');
      assert.equal(saved.sourcePage, 2);
    }
    await post(second + '/reference', { ...confirm, confirmPrinted: false, source: 'teacher', answers: ['D'] });
    assert.equal((await post(second + '/reference', confirm, 409)).code, 'QUESTION_VERSION_CONFLICT');
  } finally {
    await app.close();
    await Promise.all([pool.end(), admin.end(), paperWorker.end(), pageWorker.end(), solutionWorker.end()]);
  }
});
