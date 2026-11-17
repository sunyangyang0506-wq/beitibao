import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../dist/server/app.js';
import { verifyReleaseRevision } from '../infra/beijing/release-checks.mjs';

test('health exposes only the running revision and prevents stale cached acceptance', async t => {
  const candidate = 'a'.repeat(40);
  for (const revision of [candidate, null]) {
    const app = await createApp({ pool: {}, origin: 'https://example.test', releaseRevision: revision });
    t.after(() => app.close());
    const response = await app.inject('/healthz');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json(), { status: 'ok', revision });
    if (revision) verifyReleaseRevision(response.json(), candidate);
    else assert.throws(() => verifyReleaseRevision(response.json(), candidate), /Running revision/);
  }
});
