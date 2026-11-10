export function samePracticeAttempt(left, right) {
  return typeof left === 'string' && left.length > 0 && left === right;
}
