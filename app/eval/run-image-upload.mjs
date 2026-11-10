import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import sharp from 'sharp';
import { createApp } from '../dist/server/app.js';
import { processNextPaper } from '../dist/server/paper-worker.js';
import { renderPage } from '../dist/server/paper-parser.js';

const run = promisify(execFile);
const browser = process.argv.includes('--browser');
const origin = browser ? 'http://127.0.0.1:5174' : 'http://127.0.0.1:5173';
const scratch = await mkdtemp(join(tmpdir(), 'beitibao-image-upload-'));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const admin = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const worker = new pg.Pool({ connectionString: process.env.LOCAL_PAPER_WORKER_DATABASE_URL });
const app = await createApp({ pool, origin, localPapers: true, secureCookies: false });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ocr = process.env.BEITIBAO_LOCAL_PAGE_OCR;
const result = { startedAt: new Date().toISOString(), mode: 'offline', externalModelCalls: 0, uploads: [] };
globalThis.fetch = () => {
  result.externalModelCalls++;
  throw new Error('NETWORK_DISABLED');
};

async function api(auth, method, path, payload, expected, mediaType) {
  const response = await app.inject({ method, url: '/api/v1' + path, payload,
    headers: { origin, ...auth, ...(mediaType && { 'content-type': mediaType }) } });
  assert.equal(response.statusCode, expected, method + ' ' + path);
  return response;
}
async function user(email, password) {
  const invite = randomBytes(32).toString('base64url');
  await admin.query("INSERT INTO invitations (token_hash,email,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [sha(invite), email]);
  const registered = await api({}, 'POST', '/auth/register', { email, invite, password }, 201);
  return { cookie: registered.headers['set-cookie'].split(';')[0], 'x-csrf-token': registered.json().csrfToken };
}

const recognize = async (bytes, mediaType) => {
  const input = sharp(bytes).autoOrient();
  const png = await input.png().toBuffer();
  const path = join(scratch, 'ocr.png');
  await writeFile(path, png, { mode: 0o600 });
  const { stdout } = await run(ocr, [path], { timeout: 30_000 });
  const probe = JSON.parse(stdout);
  return { model: 'macos-vision-local-probe', promptVersion: 'image-upload-v1', stems: [],
    figures: [], visualContexts: [], probe: { ...probe, mediaType } };
};

try {
  const email = 'image-upload@example.test';
  const owner = await user(email, 'Synthetic image upload passphrase');
  const { course } = (await api(owner, 'POST', '/courses', { name: '图片上传回归', term: '隔离测试' }, 201)).json();
  if (browser) {
    const png = await renderPage(await readFile(new URL('./papers/dev-cs.pdf', import.meta.url)), 1);
    await writeFile(join(scratch, 'fixture.png'), png);
    await sharp(png).rotate(3, { background: '#dedbd4' }).jpeg({ quality: 70 }).toFile(join(scratch, 'fixture.jpg'));
    const fixtureRecognizer = async () => ({ model: 'fixture', promptVersion: 'browser-flow',
      stems: ['Which structure follows FIFO?\nA. Stack\nB. Queue'], figures: [[]], visualContexts: [''] });
    await app.listen({ host: '127.0.0.1', port: 3042 });
    console.log('Browser fixtures:', scratch);
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    while (!stopping) {
      await processNextPaper(worker, fixtureRecognizer, async () => { throw new Error('FIXTURE_ONLY'); });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } else {
    assert.ok(ocr);
    const other = await user('image-upload-other@example.test', 'Synthetic isolation test passphrase');
    const manifest = await readFile(new URL('./data/national-exams.json', import.meta.url));
    const dataset = JSON.parse(manifest);
    result.datasetVersion = dataset.datasetVersion;
    result.manifestSha256 = sha(manifest);
    for (const paper of dataset.papers) {
      const pdf = await readFile(new URL('./' + paper.file, import.meta.url));
      assert.equal(sha(pdf), paper.sha256, paper.id);
      for (let page = 1; page <= paper.pageCount; page++) {
        const started = performance.now();
        const raster = await renderPage(pdf, page, 1800);
        const index = result.uploads.length % 3;
        const variant = ['png', 'phone-jpeg', 'exif-jpeg'][index];
        const bytes = index === 0 ? raster : index === 1
          ? await sharp(raster).rotate(3, { background: '#dedbd4' }).modulate({ brightness: 0.92 }).jpeg({ quality: 68 }).toBuffer()
          : await sharp(raster).rotate(270).jpeg({ quality: 80 }).withMetadata({ orientation: 6 }).toBuffer();
        const mediaType = index === 0 ? 'image/png' : 'image/jpeg';
        const path = '/courses/' + course.id + '/papers?' + new URLSearchParams({ title: paper.id + '-' + page });
        const { paper: uploaded } = (await api(owner, 'POST', path, bytes, 202, mediaType)).json();
        const replay = (await api(owner, 'POST', path, bytes, 200, mediaType)).json();
        assert.equal(replay.paper.id, uploaded.id);
        assert.equal(replay.reused, true);
        assert.equal(await processNextPaper(worker, recognize), true);
        const detail = '/papers/' + uploaded.id;
        const { paper: review } = (await api(owner, 'GET', detail, undefined, 200)).json();
        assert.equal(review.status, 'review', paper.id + '/' + page);
        assert.equal(review.recognition.probe.mediaType, mediaType);
        const preview = await api(owner, 'GET', detail + '/pages/1', undefined, 200);
        assert.equal(preview.headers['content-type'], mediaType);
        assert.equal(sha(preview.rawPayload), sha(bytes));
        await api(other, 'GET', detail + '/pages/1', undefined, 404);
        await api(owner, 'POST', detail + '/practice', {}, 404);
        result.uploads.push({ paperId: paper.id, page, variant, bytes: bytes.length,
          probe: review.recognition.probe, elapsedMs: Math.round(performance.now() - started) });
      }
    }
    assert.equal(result.uploads.length, dataset.papers.reduce((sum, paper) => sum + paper.pageCount, 0));
    assert.ok(result.uploads.every(item => item.probe.characters > 0), 'A page returned no OCR text');
    assert.equal(await processNextPaper(worker, recognize), false);
    assert.equal(result.externalModelCalls, 0);
    console.log(JSON.stringify(Object.fromEntries(Object.entries(Object.groupBy(result.uploads, item => item.variant))
      .map(([variant, rows]) => [variant, { uploads: rows.length, textReturned: rows.filter(item => item.probe.characters > 0).length }]))));
  }
} finally {
  result.finishedAt = new Date().toISOString();
  if (!browser) await writeFile(new URL('./image-upload-local-results.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  await app.close();
  await Promise.all([pool.end(), admin.end(), worker.end(), rm(scratch, { recursive: true, force: true })]);
}
