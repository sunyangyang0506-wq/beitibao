import assert from 'node:assert/strict';
import {test} from 'node:test';
import {samePracticeAttempt} from '../src/practice-draft.js';
test('browser drafts and conflict merges require the same explicit practice identity',()=>{
  assert.equal(samePracticeAttempt('old','new'),false);
  assert.equal(samePracticeAttempt('same','same'),true);
  assert.equal(samePracticeAttempt(undefined,undefined),false);
  assert.equal(samePracticeAttempt(null,null),false);
  assert.equal(samePracticeAttempt('',''),false);
});
