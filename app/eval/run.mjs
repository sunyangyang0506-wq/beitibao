import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractPages, maxPdfBytes, renderPage } from '../dist/server/paper-parser.js';

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const normalize = text => text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const [mode = 'parse', split = 'evaluation', candidateFile] = process.argv.slice(2);
assert.ok(['parse', 'inputs', 'answers'].includes(mode), 'Use parse, inputs or answers');
assert.ok(['development', 'evaluation', 'national-exams'].includes(split), 'Unknown split');
assert.ok(split !== 'national-exams' || mode === 'parse', 'National exams currently support parse evaluation only');

const documents = {};
const paperIds = new Set();
const questionIds = new Set();
const groups = new Map();
const hashes = new Map();

const splits = split === 'national-exams' ? [split] : ['development', 'evaluation'];
for (const name of splits) {
  const dataset = await readJson(new URL(`./data/${name}.json`, import.meta.url));
  assert.equal(dataset.split, name);
  const papers = new Map();
  for (const paper of dataset.papers) {
    assert.ok(!paperIds.has(paper.id), `Duplicate paper ID: ${paper.id}`);
    const national = name === 'national-exams';
    const filePattern = national
      ? /^(?:national-exam-archive\/papers\/(?:national|university)\/evaluation|papers\/national-evaluation)\/[a-z0-9-]+\.pdf$/
      : /^[a-z0-9-]+\.pdf$/;
    assert.match(paper.file, filePattern);
    assert.ok(paper.sourceGroup, `Missing source group: ${paper.id}`);
    assert.ok(!groups.has(paper.sourceGroup) || groups.get(paper.sourceGroup) === name, `Source group leak: ${paper.sourceGroup}`);
    const pdf = await readFile(new URL(national ? './' + paper.file : './papers/' + paper.file, import.meta.url));
    const digest = createHash('sha256').update(pdf).digest('hex');
    if (national) {
      assert.equal(digest, paper.sha256, `Changed file: ${paper.file}`);
      assert.ok(pdf.length <= maxPdfBytes, `File exceeds upload limit: ${paper.file}`);
    }
    assert.ok(!hashes.has(digest) || hashes.get(digest) === name, `File leak: ${paper.file}`);
    paperIds.add(paper.id);
    groups.set(paper.sourceGroup, name);
    hashes.set(digest, name);
    papers.set(paper.id, { ...paper, pdf, digest });
  }
  for (const question of dataset.questions) {
    const paper = papers.get(question.paperId);
    assert.ok(paper && question.page >= 1 && question.page <= paper.pageCount, `Invalid source page: ${question.id}`);
    assert.ok(!questionIds.has(question.id), `Duplicate question ID: ${question.id}`);
    assert.ok(question.kind === 'subjective' ? question.rubric?.length : question.acceptedAnswers?.length, `Missing gold: ${question.id}`);
    questionIds.add(question.id);
  }
  documents[name] = { ...dataset, papers };
}

const dataset = documents[split];
const metadata = { datasetVersion: dataset.datasetVersion, split };
if (mode === 'inputs') {
  const questions = dataset.questions.map(({ id, kind, prompt }) => ({ id, kind, prompt }));
  console.log(JSON.stringify({ ...metadata, questions }, null, 2));
} else if (mode === 'answers') {
  assert.ok(candidateFile, 'Provide a candidate JSON file');
  const candidate = await readJson(candidateFile);
  assert.equal(candidate.datasetVersion, dataset.datasetVersion);
  assert.equal(candidate.split, split);
  assert.ok(typeof candidate.runId === 'string' && candidate.runId.trim(), 'Missing runId');
  const ids = new Set(dataset.questions.map(question => question.id));
  const answers = new Map();
  for (const { id, answer } of candidate.answers) {
    assert.ok(ids.has(id) && !answers.has(id) && typeof answer === 'string', `Invalid candidate answer: ${id}`);
    answers.set(id, answer);
  }
  const results = dataset.questions.map(question => {
    const answer = answers.get(question.id);
    const missing = !answer?.trim();
    const result = missing ? 'missing' : question.kind === 'subjective' ? 'manual_review'
      : question.acceptedAnswers.some(gold => normalize(answer) === normalize(gold)) ? 'correct' : 'incorrect';
    return { id: question.id, kind: question.kind, result };
  });
  const objective = results.filter(result => result.kind !== 'subjective');
  console.log(JSON.stringify({ ...metadata, runId: candidate.runId,
    objectiveCorrect: objective.filter(result => result.result === 'correct').length,
    objectiveTotal: objective.length, results }, null, 2));
} else {
  const results = [];
  for (const paper of dataset.papers.values()) {
    const started = performance.now();
    const checks = [];
    let pages;
    try {
      pages = await extractPages(paper.pdf);
    } catch (error) {
      if (error.code === 'ENOENT' || error.signal) throw error;
    }
    checks.push({ name: 'status', pass: (pages ? 'review' : 'failed') === paper.expected });
    if (paper.expected === 'review') {
      checks.push({ name: 'page_count', pass: pages?.length === paper.pageCount });
      for (const { page, contains } of paper.textPages ?? []) {
        for (const fragment of contains) {
          checks.push({ name: 'page_' + page + '_text', pass: normalize(pages?.[page - 1] ?? '').includes(normalize(fragment)) });
        }
      }
      for (const page of paper.blankTextPages ?? []) {
        checks.push({ name: 'page_' + page + '_empty_text', pass: pages?.[page - 1] === '' });
      }
      if (split === 'national-exams' && pages) {
        for (let page = 1; page <= pages.length; page++) {
          const png = await renderPage(paper.pdf, page);
          checks.push({ name: 'page_' + page + '_render', pass: png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' });
        }
      }
    }
    results.push({ id: paper.id, layout: paper.layout, sha256: paper.digest,
      ms: Math.round(performance.now() - started), checks });
  }
  const checks = results.flatMap(result => result.checks);
  const passed = checks.filter(check => check.pass).length;
  console.log(JSON.stringify({ ...metadata, papers: results.length, passed, total: checks.length, results }, null, 2));
  if (passed !== checks.length) process.exitCode = 1;
}
