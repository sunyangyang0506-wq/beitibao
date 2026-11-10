export type QuestionReference = {
  kind: 'choice' | 'numeric' | 'manual';
  source: 'teacher' | 'verified';
  answers: string[];
  explanation: string;
};

type ModelReference = Omit<QuestionReference, 'source'> & { source: 'model' };
export type ModelGradingSolution = { status?: string; answer?: string; explanation?: string };

const metricUnits = new Map<string, [string, number]>([
  ['km', ['m', 3]], ['m', ['m', 0]], ['cm', ['m', -2]], ['mm', ['m', -3]],
  ['kg', ['kg', 0]], ['g', ['kg', -3]], ['mg', ['kg', -6]],
  ['s', ['s', 0]], ['ms', ['s', -3]], ['N', ['N', 0]], ['kN', ['N', 3]],
  ['J', ['J', 0]], ['kJ', ['J', 3]], ['Pa', ['Pa', 0]], ['kPa', ['Pa', 3]],
  ['W', ['W', 0]], ['kW', ['W', 3]], ['m/s', ['m/s', 0]], ['m/s2', ['m/s2', 0]]
]);

export function normalizeAnswer(value: string, kind: QuestionReference['kind']) {
  const text = value.normalize('NFKC').trim();
  if (kind === 'choice') return /^[A-Z]$/i.test(text) ? text.toUpperCase() : null;
  if (kind !== 'numeric') return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:\s*([a-zA-Z][a-zA-Z/2]*))?$/.exec(text);
  if (!match) return null;
  const whole = match[2]!;
  const digits = whole + (match[3] ?? '');
  const unit = match[4] && metricUnits.get(match[4]);
  if (match[4] && !unit) return null;
  const decimal = whole.length + (unit ? unit[1] : 0);
  const integer = (decimal > 0 ? digits.slice(0, decimal).padEnd(decimal, '0') : '0').replace(/^0+(?=\d)/, '');
  const fraction = ('0'.repeat(Math.max(0, -decimal)) + digits.slice(Math.max(0, decimal))).replace(/0+$/, '');
  const sign = match[1] === '-' && (integer !== '0' || fraction) ? '-' : '';
  return sign + integer + (fraction ? '.' + fraction : '') + (unit ? ' ' + unit[0] : '');
}

export function gradeAnswer(answer: string | undefined, reference?: QuestionReference | ModelReference | null) {
  if (!answer?.trim()) return 'unanswered';
  if (!reference) return 'needs_review';
  const normalized = normalizeAnswer(answer, reference.kind);
  if (normalized === null) return 'needs_review';
  return reference.answers.some(value => normalizeAnswer(value, reference.kind) === normalized)
    ? 'correct' : 'incorrect';
}

function answerText(value: string) {
  return value.normalize('NFC').trim()
    .replace(/^\$\$([\s\S]+)\$\$$|^\$([^$]+)\$$|^\\\(([\s\S]+)\\\)$/u, '$1$2$3').trim()
    .replace(/[！-～]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(/−/gu, '-')
    .replace(/\\pi(?![a-zA-Z])/gu, 'π')
    .replace(/\\sqrt(?:\{([0-9])\}|([0-9]))(?![0-9])/gu, (_, braced, digit) => '√' + (braced ?? digit));
}

function comparableNumber(value: string) {
  // Compatibility normalization must not flatten a power such as 2² into 22.
  return /^[+\-\d.a-z/\s]+$/iu.test(value) ? normalizeAnswer(value, 'numeric') : null;
}

function choiceQuestion(kind: string | undefined, stem: string) {
  if (kind === 'choice') return true;
  const labels = Array.from(stem.matchAll(/(?:^|\s)(?:\(([A-D])\)|([A-D])[.、):])/gu), option => option[1] ?? option[2]);
  return labels.join('') === 'ABCD';
}

export function modelGradingReference(kind: string | undefined, stem: string, solution?: ModelGradingSolution | null): ModelReference | null {
  if (solution?.status !== 'solved' || !solution.answer?.trim()) return null;
  const answer = answerText(solution.answer);
  const explanation = solution.explanation ?? '';
  const choice = /^(?:答案:\s*)?([a-z])(?:[.。])?$/iu.exec(answer)?.[1];
  if (choice && choiceQuestion(kind, answerText(stem))) return { kind: 'choice', source: 'model', answers: [choice], explanation };
  if ((kind === 'calculation' || kind === 'fill') && comparableNumber(answer) !== null) {
    return { kind: 'numeric', source: 'model', answers: [answer], explanation };
  }
  return null;
}

export function gradePracticeAnswer(answer: string | undefined, reference: QuestionReference | null | undefined,
  kind: string | undefined, stem: string, solution?: ModelGradingSolution | null): ReturnType<typeof gradeAnswer> {
  if (!answer?.trim() || reference) return gradeAnswer(answer, reference);
  if (solution?.status !== 'solved' || !solution.answer?.trim()) return 'needs_review';
  const candidate = answerText(answer);
  const expected = answerText(solution.answer);
  if (candidate && candidate === expected) return 'correct';
  const key = modelGradingReference(kind, stem, solution);
  if (key?.kind === 'choice') return /^[a-z]$/i.test(candidate) ? gradeAnswer(candidate, key) : 'needs_review';
  if (key?.kind === 'numeric') {
    const value = comparableNumber(candidate);
    const target = comparableNumber(expected);
    if (value !== null && target !== null && value.split(' ')[1] === target.split(' ')[1]) {
      return value === target ? 'correct' : 'incorrect';
    }
  }
  return 'needs_review';
}
