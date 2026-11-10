import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createApp } from '../dist/server/app.js';
import { processNextPaper } from '../dist/server/paper-worker.js';

const origin = 'http://127.0.0.1:5173';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const worker = new pg.Pool({ connectionString: process.env.LOCAL_PAPER_WORKER_DATABASE_URL });
const app = await createApp({ pool, origin, localPapers: true });
const config = await json(new URL('./subject-coverage.json', import.meta.url));
const seenHashes = new Set();
const seenGroups = new Set();
const seenStems = new Set();
const summary = [];
let cookie, csrf;

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function call(method, url, payload, expected = 200) {
  const response = await app.inject({
    method, url: '/api/v1' + url, payload, headers: {
      origin, ...(cookie && { cookie, 'x-csrf-token': csrf }),
      ...(Buffer.isBuffer(payload) && { 'content-type': 'application/pdf' })
    }
  });
  assert.equal(response.statusCode, expected, method + ' ' + url + ' ' + response.body);
  return { body: response.json(), cookie: response.headers['set-cookie'] };
}

const normalize = value => value.normalize('NFKC').replace(/\s+/gu, '');

try {
  const email = 'corpus-run@example.test';
  const invite = randomBytes(32).toString('base64url');
  await admin.query("INSERT INTO invitations (token_hash, email, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [createHash('sha256').update(invite).digest('hex'), email]);
  const registration = await call('POST', '/auth/register', { email, invite, password: randomBytes(24).toString('hex') }, 201);
  cookie = registration.cookie.split(';')[0];
  csrf = registration.body.csrfToken;

  for (const split of ['test', 'evaluation']) {
    const folder = new URL('./subject-corpus/' + split + '/', import.meta.url);
    const manifest = await json(new URL('manifest.json', folder));
    const { questions } = await json(new URL('gold.json', folder));
    assert.equal(manifest.split, split);
    assert.equal(manifest.papers.length, config.subjects.length * config.minimumPapers[split]);
    assert.equal(questions.length, manifest.papers.length * 3);

    for (const subject of config.subjects) {
      const papers = manifest.papers.filter(paper => paper.subjectId === subject.id);
      assert.equal(papers.length, config.minimumPapers[split]);
      const { body: { course } } = await call('POST', '/courses', { name: subject.name, term: '合成数据 ' + split }, 201);
      let correct = 0;
      let incorrect = 0;
      for (const paper of papers) {
        assert.match(paper.file, /^[a-z0-9-]+\.pdf$/);
        const pdf = await readFile(new URL(paper.file, folder));
        const hash = createHash('sha256').update(pdf).digest('hex');
        assert.equal(hash, paper.sha256);
        assert.ok(!seenHashes.has(hash) && !seenGroups.has(paper.sourceGroup));
        seenHashes.add(hash);
        seenGroups.add(paper.sourceGroup);
        const { body: { paper: uploaded } } = await call('POST',
          '/courses/' + course.id + '/papers?' + new URLSearchParams({ title: paper.title }), pdf, 202);
        assert.equal(await processNextPaper(worker), true);
        const path = '/papers/' + uploaded.id;
        const { body: review } = await call('GET', path);
        assert.equal(review.paper.status, 'review');
        assert.equal(review.paper.pages.length, paper.pageCount);
        const gold = questions.filter(question => question.paperId === paper.id);
        assert.equal(gold.length, 3);
        const answers = {};
        for (const [index, question] of gold.entries()) {
          const stem = normalize(question.prompt);
          assert.ok(!seenStems.has(stem), 'Repeated question text: ' + question.id);
          seenStems.add(stem);
          assert.ok(normalize(review.paper.pages[question.page - 1]).includes(stem), question.id);
          const { body: confirmed } = await call('POST', path + '/questions', { pageNumber: question.page, stem: question.prompt }, 201);
          await call('POST', path + '/questions/' + confirmed.id + '/reference', {
            kind: 'numeric', source: 'verified', answers: question.acceptedAnswers, explanation: ''
          });
          answers[confirmed.id] = split === 'evaluation' && index === 2 ? '-999' : question.acceptedAnswers[0];
        }
        const practice = path + '/practice';
        const { body: attempt } = await call('POST', practice, {});
        assert.equal(attempt.questions.length, gold.length);
        assert.ok(attempt.questions.every(question => !('reference' in question)));
        const { body: draft } = await call('POST', practice + '/save', { revision: attempt.revision, answers, submit: false });
        assert.deepEqual((await call('GET', practice)).body.answers, answers);
        const submission = { revision: draft.revision, answers, submit: true };
        const { body: final } = await call('POST', practice + '/save', submission);
        assert.ok(final.submittedAt);
        assert.deepEqual((await call('POST', practice + '/save', submission)).body, final);
        if (split === 'evaluation') {
          for (const question of final.questions) {
            const label = gold.find(item => item.prompt === question.stem);
            const expected = label.acceptedAnswers.includes(final.answers[question.id]) ? 'correct' : 'incorrect';
            assert.equal(question.result, expected);
            if (question.result === 'correct') correct++;
            else incorrect++;
          }
        }
      }
      if (split === 'evaluation') assert.deepEqual([correct, incorrect], [papers.length * 2, papers.length]);
      summary.push({ subject: subject.name, split, papers: papers.length, submitted: papers.length,
        ...(split === 'evaluation' && { scriptedCorrect: correct, scriptedIncorrect: incorrect }) });
    }
  }
  const progress = (await call('GET', '/progress')).body;
  assert.equal(progress.completed, 6);
  const { mistakes } = (await call('GET', '/mistakes')).body;
  assert.equal(mistakes.length, 15);
  assert.ok(mistakes.every(item => !('reference' in item) && item.status === 'open'));
  const selected = mistakes[0];
  const target = '/mistakes/' + selected.id + '/retry';
  const evaluationGold = await json(new URL('./subject-corpus/evaluation/gold.json', import.meta.url));
  const correctAnswer = evaluationGold.questions.find(question => question.prompt === selected.stem).acceptedAnswers[0];
  const retry = { attemptKey: randomUUID(), answer: correctAnswer };
  assert.equal((await call('POST', target, retry)).body.result, 'correct');
  assert.equal((await call('POST', target, retry)).body.result, 'correct');
  const reloaded = (await call('GET', '/mistakes')).body.mistakes;
  assert.equal(reloaded.find(item => item.id === selected.id).status, 'resolved');
  console.log(JSON.stringify({ datasetVersion: 'subject-synthetic-v1', results: summary }, null, 2));
} finally {
  await app.close();
  await Promise.all([pool.end(), admin.end(), worker.end()]);
}
