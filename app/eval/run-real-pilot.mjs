import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extractPages, maxPdfBytes, renderPage } from '../dist/server/paper-parser.js';

const root = new URL('./source-materials/real-pilot/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
const files = new Map();
const hashes = new Set();

for (const entry of manifest.files) {
  assert.match(entry.file, /^(?:test|evaluation|answer-keys)\/[a-z0-9-]+\.pdf$/);
  assert.ok(entry.file.startsWith(entry.split + '/'), 'Split mismatch: ' + entry.file);
  assert.ok(!files.has(entry.file), 'Duplicate file: ' + entry.file);
  const bytes = await readFile(new URL(entry.file, root));
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash, entry.sha256, 'Changed file: ' + entry.file);
  assert.ok(!hashes.has(hash), 'Duplicate content: ' + entry.file);
  assert.ok(bytes.length <= maxPdfBytes, 'File exceeds upload limit: ' + entry.file);
  files.set(entry.file, { entry, bytes });
  hashes.add(hash);
}

const results = [];
for (const { entry, bytes } of files.values()) {
  if (entry.split === 'evaluation') {
    const answer = files.get(entry.answerFile)?.entry;
    assert.ok(answer?.split === 'answer-keys' && answer.institution === entry.institution
      && answer.course === entry.course, 'Missing or mismatched answer key: ' + entry.file);
  }
  const pages = await extractPages(bytes);
  assert.equal(pages.length, entry.pageCount, 'Unexpected page count: ' + entry.file);
  const blankTextPages = pages.flatMap((page, index) => page ? [] : [index + 1]);
  if (entry.split !== 'answer-keys') {
    for (let page = 1; page <= pages.length; page++) {
      const png = await renderPage(bytes, page);
      assert.ok(png.length > 8 && png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
        'Page rendering failed: ' + entry.file + ' page ' + page);
    }
  }
  results.push({ file: entry.file, pageCount: pages.length, blankTextPages,
    authorizationStatus: entry.authorizationStatus });
}
console.log(JSON.stringify({ status: 'local-parser-check', results }, null, 2));
