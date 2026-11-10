import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const config = JSON.parse(await readFile(new URL('./subject-coverage.json', import.meta.url), 'utf8'));
const manifestPath = process.argv[2];
const records = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')).papers : [];
assert.ok(Array.isArray(records), 'Manifest must contain a papers array');
const counts = new Map(config.subjects.map(subject => [subject.id, { test: 0, evaluation: 0 }]));
const sources = new Set();
const hashes = new Set();

for (const paper of records) {
  const count = counts.get(paper.subjectId);
  assert.ok(count && Object.hasOwn(count, paper.split), 'Unknown subject or split');
  assert.ok(paper.origin === 'real' && paper.authorizationRef?.trim() && paper.sourceGroup?.trim(),
    'Each paper needs real provenance, an authorization reference and a source group');
  assert.ok(!sources.has(paper.sourceGroup), 'Duplicate source group: ' + paper.sourceGroup);
  const bytes = await readFile(resolve(dirname(manifestPath), paper.file));
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.ok(bytes.length && hash === paper.sha256 && !hashes.has(hash), 'Invalid or duplicate file: ' + paper.file);
  if (paper.split === 'evaluation') {
    const gold = JSON.parse(await readFile(resolve(dirname(manifestPath), paper.goldFile), 'utf8'));
    assert.ok(Array.isArray(gold.questions) && gold.questions.length && gold.questions.every(question =>
      Number.isInteger(question.page) && question.page > 0 && question.stem?.trim()
      && (question.acceptedAnswers?.some(answer => answer.trim()) || question.rubric?.some(point => point.trim()))
    ), 'Evaluation paper needs source pages and reviewed labels: ' + paper.file);
  }
  sources.add(paper.sourceGroup);
  hashes.add(hash);
  count[paper.split]++;
}

const report = config.subjects.map(({ id, name }) => {
  const actual = counts.get(id);
  const missing = Object.fromEntries(Object.entries(config.minimumPapers)
    .map(([split, minimum]) => [split, Math.max(0, minimum - actual[split])]));
  return { subject: name, actual, missing };
});
console.log(JSON.stringify(report, null, 2));
if (!config.courseRegistryComplete) console.error("The course registry is still being collected.");
if (!config.courseRegistryComplete || report.some(({ missing }) => missing.test || missing.evaluation)) process.exitCode = 1;
