import assert from 'node:assert/strict';

export function requireExpectedRevision(value) {
  assert.ok(typeof value === 'string' && /^[0-9a-f]{40}$/.test(value),
    'BEITIBAO_ACCEPTANCE_REVISION must be the full expected Git commit SHA');
  return value;
}

export function verifyReleaseRevision(health, expected) {
  requireExpectedRevision(expected);
  assert.equal(health?.status, 'ok', 'Health endpoint did not identify a healthy application');
  assert.equal(health?.revision, expected,
    'Running revision differs from the acceptance candidate (or this image has no revision manifest)');
}
