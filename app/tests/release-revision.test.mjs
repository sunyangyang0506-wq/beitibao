import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { readReleaseRevision } from '../dist/server/release-revision.js';
import { requireExpectedRevision, verifyReleaseRevision } from '../infra/beijing/release-checks.mjs';

const candidate = 'a'.repeat(40);
const previous = 'b'.repeat(40);

test('release smoke rejects a healthy old or unidentified deployment', () => {
  for (const revision of [previous, null, undefined, candidate.slice(0, 7)]) {
    assert.throws(() => verifyReleaseRevision({ status: 'ok', revision }, candidate), /Running revision/);
  }
  assert.throws(() => verifyReleaseRevision({ status: 'unavailable', revision: candidate }, candidate), /Health endpoint/);
  verifyReleaseRevision({ status: 'ok', revision: candidate }, candidate);
});

test('release smoke requires an explicit full candidate revision', () => {
  for (const value of [undefined, '', candidate.slice(0, 7), 'g'.repeat(40), candidate + '\n', 123]) {
    assert.throws(() => requireExpectedRevision(value), /full expected Git commit SHA/);
  }
  assert.equal(requireExpectedRevision(candidate), candidate);
});

test('image manifest distinguishes local absence from a corrupt release identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'beitibao-release-id-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = pathToFileURL(join(directory, 'release-revision.json'));
  assert.equal(await readReleaseRevision(path), null);
  for (const contents of ['not json', 'null', '{}', '{"revision":123}', JSON.stringify({ revision: 'short' })]) {
    await writeFile(path, contents);
    await assert.rejects(readReleaseRevision(path), /Invalid release revision manifest/);
  }
  await writeFile(path, JSON.stringify({ revision: candidate, ignored: 'not exposed' }));
  assert.equal(await readReleaseRevision(path), candidate);
  await assert.rejects(readReleaseRevision(pathToFileURL(directory)), /Cannot read release revision manifest/);
});

