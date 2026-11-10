import assert from 'node:assert/strict';
import { test } from 'node:test';
import { predictionFailureMessage } from '../src/prediction-failure.js';

test('provider failures explain the required administrator action rather than blind retry', () => {
  for (const [code, clue] of [
    ['MODEL_AUTHENTICATION_FAILED', '凭据'], ['MODEL_ACCESS_DENIED', '权限'],
    ['MODEL_PAYMENT_REQUIRED', '账单'], ['MODEL_SERVICE_NOT_ENABLED', '开通']
  ]) {
    const message = predictionFailureMessage(code);
    assert.match(message, /管理员/);
    assert.ok(message.includes(clue));
    assert.ok(!message.includes('稍后重试'));
  }
});
test('existing transient and quality failure guidance is preserved', () => {
  assert.match(predictionFailureMessage('MODEL_RATE_LIMIT'), /稍后重试/);
  assert.match(predictionFailureMessage('PREDICTION_VERIFICATION_FAILED'), /复算/);
  assert.equal(predictionFailureMessage('unknown'), '请稍后重试。');
});
