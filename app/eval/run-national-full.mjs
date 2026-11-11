import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { createApp } from '../dist/server/app.js';
import { processNextPaper } from '../dist/server/paper-worker.js';
import { pdfRecognitionSize, processNextPageRecognition } from '../dist/server/pdf-page-recognition.js';
import { maxPdfBytes, renderPage } from '../dist/server/paper-parser.js';

const run = promisify(execFile);
const origin = 'http://127.0.0.1:5173';
const root = new URL('./national-exam-archive/', import.meta.url);
const json = async url => JSON.parse(await readFile(url, 'utf8'));
const archive = await json(new URL('manifest.json', root));
const datasetUrl = new URL('./data/national-exams.json', import.meta.url);
const dataset = await json(datasetUrl);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const result = { datasetVersion: dataset.datasetVersion, manifestSha256: sha256(await readFile(datasetUrl)),
  startedAt: new Date().toISOString(), mode: 'offline', externalModelCalls: 0,
  goldQuestions: dataset.questions.length, archive: {}, papers: [], trimmedSources: [] };
const reportUrl = new URL('./national-exams-v1-results.json', import.meta.url);
const scratch = await mkdtemp(join(tmpdir(), 'beitibao-national-eval-'));
const imagePath = join(scratch, 'page.png');
const answerHeading = /^.{0,24}(?:(?:参考|试题|真题)答案(?:(?:及|与)?(?:解析|评分(?:标准|参考)))?|答案(?:及|与)(?:解析|评分(?:标准|参考))|评分标准|answer\s*key|suggested\s*answers)(?:$|[：:（(])/iu;
const flaggedHeading = text => text.split('\n').some(line => answerHeading.test(line.normalize('NFKC').trim()));
const ocrCommand = process.env.BEITIBAO_LOCAL_PAGE_OCR;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const worker = new pg.Pool({ connectionString: process.env.LOCAL_PAPER_WORKER_DATABASE_URL });
const app = await createApp({ pool, origin, localPapers: true });

async function auditArchive() {
  const ids = new Set();
  const hashes = new Set();
  const files = new Set();
  const roles = {};
  for (const item of archive.papers) {
    assert.match(item.file, /^papers\/(?:national|university)\/(?:train|evaluation)\/[a-z0-9-]+\.pdf$/u);
    assert.equal(item.file.split('/')[1], item.scope);
    assert.equal(item.file.split('/')[2], item.candidate_split);
    roles[item.scope + '_' + item.candidate_split] = (roles[item.scope + '_' + item.candidate_split] ?? 0) + 1;
    if (item.answer_reference) {
      assert.match(item.answer_reference.file, /^answer-references\/[0-9]{4}-408\.pdf$/u);
      assert.equal(item.answer_reference.file.split('/').at(-1), item.file.split('/').at(-1), item.id);
    }
    for (const record of [item, item.answer_reference].filter(Boolean)) {
      assert.ok(!ids.has(record.id) && !files.has(record.file), record.id);
      const url = new URL(record.file, root);
      const bytes = await readFile(url);
      const hash = sha256(bytes);
      assert.equal(hash, record.sha256, record.id);
      assert.equal(bytes.length, record.bytes, record.id);
      assert.ok(!hashes.has(hash), record.id + ' duplicates another archive file');
      const { stdout } = await run('pdfinfo', [fileURLToPath(url)], { timeout: 15_000 });
      assert.equal(Number(stdout.match(/^Pages:\s+(\d+)$/m)?.[1]), record.pages, record.id);
      const text = await run('pdftotext', ['-layout', '-enc', 'UTF-8', fileURLToPath(url), '-'],
        { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
      const textPages = text.stdout.split('\f').slice(0, record.pages).filter(page => page.trim()).length;
      assert.equal(textPages, record.pages_with_text, record.id);
      hashes.add(hash);
      files.add(record.file);
      ids.add(record.id);
    }
  }
  const onDisk = (await readdir(root, { recursive: true })).filter(file => file.endsWith('.pdf')).sort();
  assert.deepEqual([...files].sort(), onDisk);
  const holdouts = archive.papers.filter(item => item.candidate_split === 'evaluation').map(item => item.id).sort();
  assert.deepEqual(dataset.papers.map(paper => paper.id).sort(), holdouts);
  assert.equal(new Set(dataset.papers.map(paper => paper.sourceGroup)).size, dataset.papers.length);
  result.archive = { papers: archive.papers.length, references: files.size - archive.papers.length,
    files: files.size, textLayerPageCountsChecked: files.size, byteDuplicates: 0, splits: roles,
    duplicateCheck: 'exact file SHA-256' };
}

async function call(session, method, url, payload, expected) {
  const response = await app.inject({
    method, url: '/api/v1' + url, payload,
    headers: { origin, ...session, ...(Buffer.isBuffer(payload) && { 'content-type': 'application/pdf' }) }
  });
  assert.equal(response.statusCode, expected, method + ' ' + url);
  return response;
}

async function register(email) {
  const invite = randomBytes(32).toString('base64url');
  await admin.query(
    "INSERT INTO invitations (token_hash, email, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [sha256(invite), email]);
  const response = await call({}, 'POST', '/auth/register', { email, invite, password: randomBytes(24).toString('hex') }, 201);
  return { cookie: response.headers['set-cookie'].split(';')[0], 'x-csrf-token': response.json().csrfToken };
}

async function probePng(png) {
  await writeFile(imagePath, png, { mode: 0o600 });
  const { stdout } = await run(ocrCommand, [imagePath], { timeout: 30_000, maxBuffer: 1024 * 16 });
  const metrics = JSON.parse(stdout);
  assert.ok(Number.isInteger(metrics.lines) && Number.isInteger(metrics.characters) && typeof metrics.answerHeadingDetected === 'boolean');
  return metrics;
}

try {
  assert.ok(ocrCommand, 'Set the local OCR executable via scripts/test-local.sh --national-full');
  // Abort immediately if the evaluation ever reaches a network fetch.
  globalThis.fetch = () => {
    result.externalModelCalls++;
    throw new Error('NETWORK_DISABLED_FOR_NATIONAL_EVALUATION');
  };
  await auditArchive();
  const owner = await register('national-eval@example.test');
  const other = await register('national-eval-isolation@example.test');
  const course = (await call(owner, 'POST', '/courses', { name: '全国真题本地回归', term: dataset.datasetVersion }, 201)).json().course;
  for (const paper of dataset.papers) {
    const started = performance.now();
    const source = archive.papers.find(item => item.id === paper.id);
    assert.ok(source && source.candidate_split === 'evaluation' && source.scope === paper.scope && source.exam_year === paper.examYear);
    assert.equal(source.training_or_evaluation_permission, paper.authorizationStatus);
    assert.match(paper.file, /^(?:national-exam-archive\/papers\/(?:national|university)\/evaluation|papers\/national-evaluation)\/[a-z0-9-]+\.pdf$/u);
    const pdf = await readFile(new URL(paper.file, import.meta.url));
    assert.equal(sha256(pdf), paper.sha256, paper.id);
    assert.ok(pdf.length <= maxPdfBytes, paper.id);
    const originalFile = 'national-exam-archive/' + source.file;
    const original = paper.file === originalFile ? null : await readFile(new URL(source.file, root));
    if (!original) assert.equal(paper.sha256, source.sha256, paper.id);

    const upload = '/courses/' + course.id + '/papers?' + new URLSearchParams({ title: paper.id, recognizeScans: 'true' });
    const { paper: accepted } = (await call(owner, 'POST', upload, pdf, 202)).json();
    const duplicate = (await call(owner, 'POST', upload, pdf, 200)).json();
    assert.equal(duplicate.reused, true, paper.id);
    assert.equal(duplicate.paper.id, accepted.id, paper.id);
    assert.equal(await processNextPaper(worker), true, paper.id);
    const path = '/papers/' + accepted.id;
    const { paper: reviewed, pageReviews } = (await call(owner, 'GET', path, undefined, 200)).json();
    assert.equal(reviewed.status, 'review', paper.id);
    assert.equal(reviewed.pages.length, paper.pageCount, paper.id);
    const blank = reviewed.pages.flatMap((text, i) => text ? [] : [i + 1]);
    assert.deepEqual(blank, paper.blankTextPages, paper.id);
    assert.deepEqual(pageReviews.map(row => [row.page, row.status]), blank.map(page => [page, 'queued']), paper.id);
    await call(other, 'GET', path + '/pages/1', undefined, 404);
    const practice = await call(owner, 'POST', path + '/practice', {}, blank.length ? 409 : 404);
    if (blank.length) assert.equal(practice.json().code, 'PAGE_REVIEW_REQUIRED', paper.id);

    const detail = { id: paper.id, scope: paper.scope, subject: paper.subject, sha256: paper.sha256, bytes: pdf.length,
      pages: [], duplicateUploadReused: true, crossTenantPreviewDenied: true,
      practiceBeforeReview: practice.json().code, status: reviewed.status, queuedOcrPages: blank };
    result.papers.push(detail);
    for (let i = 0; i < paper.pageCount; i++) {
      const page = i + 1;
      const preview = await call(owner, 'GET', path + '/pages/' + page, undefined, 200);
      assert.equal(preview.headers['content-type'], 'image/png', paper.id);
      assert.equal(preview.rawPayload.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', paper.id);
      if (original) assert.ok(preview.rawPayload.equals(await renderPage(original, page)), paper.id + '/' + page);
      const text = reviewed.pages[i];
      detail.pages.push({ page, textCharacters: [...text].length,
        answerHeadingDetected: flaggedHeading(text), pngBytes: preview.rawPayload.length });
    }
    for (const page of blank) {
      assert.equal(await processNextPageRecognition(worker, async (png, mediaType) => {
        assert.equal(mediaType, 'image/png');
        assert.equal(Math.max(png.readUInt32BE(16), png.readUInt32BE(20)), pdfRecognitionSize);
        return { model: 'macos-vision-local-probe', promptVersion: 'offline-v1',
          stems: [], questionBoxes: [], visualContexts: [], figures: [], resolvedContexts: [], probe: await probePng(png) };
      }), true, paper.id + '/' + page);
    }
    const finalReviews = (await call(owner, 'GET', path, undefined, 200)).json().pageReviews;
    for (const row of finalReviews) {
      assert.equal(row.status, 'review', paper.id + '/' + row.page);
      assert.equal(row.reviewedAt, null);
      assert.ok(row.recognition?.probe, paper.id + '/' + row.page);
      detail.pages[row.page - 1].ocr = row.recognition.probe;
    }
    if (blank.length) {
      const blocked = (await call(owner, 'POST', path + '/practice', {}, 409)).json();
      assert.equal(blocked.code, 'PAGE_REVIEW_REQUIRED', paper.id);
    }
    if (original) {
      const firstExcluded = paper.pageCount + 1;
      const excluded = await probePng(await renderPage(original, firstExcluded, pdfRecognitionSize));
      result.trimmedSources.push({ id: paper.id, retainedPagesIdentical: paper.pageCount,
        sourcePages: source.pages, firstExcludedPage: firstExcluded, firstExcludedPageOcr: excluded });
    }
    detail.elapsedMs = Math.round(performance.now() - started);
  }
  assert.equal(await processNextPaper(worker), false);
  assert.equal(await processNextPageRecognition(worker), false);
  const unconfirmed = await call(owner, 'POST', '/courses/' + course.id + '/prediction', {}, 409);
  assert.equal(unconfirmed.json().code, 'PREDICTION_SOURCES_UNCONFIRMED');
  const pages = result.papers.flatMap(paper => paper.pages);
  result.summary = {
    papers: result.papers.length, previewedPages: pages.length, textLayerPages: pages.filter(page => page.textCharacters > 0).length,
    scannedPages: pages.filter(page => page.ocr).length, scannedPagesWithRecognizedText: pages.filter(page => page.ocr?.characters > 0).length,
    answerHeadingCandidates: result.papers.flatMap(paper => paper.pages.filter(page => page.answerHeadingDetected || page.ocr?.answerHeadingDetected)
      .map(page => ({ id: paper.id, page: page.page }))),
    studyAndPredictionReviewGuardsPassed: true
  };
  assert.equal(result.externalModelCalls, 0);
  console.log(JSON.stringify({ archive: result.archive, summary: result.summary, trimmedSources: result.trimmedSources }, null, 2));
} finally {
  result.finishedAt = new Date().toISOString();
  await writeFile(reportUrl, JSON.stringify(result, null, 2) + '\n');
  await app.close();
  await Promise.all([pool.end(), admin.end(), worker.end(), rm(scratch, { force: true, recursive: true })]);
}
