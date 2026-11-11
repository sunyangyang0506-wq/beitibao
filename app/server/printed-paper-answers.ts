import { completeChoiceStem, splitChoices } from './paper-choices.js';
import type { QuestionReference } from './question-reference.js';

const heading = /^(?:(?:[选選][择擇][题題]\s*)?(?:[参參]考答案|答案|答案[汇彙][总總])|answer key|answers)(?:\s*:\s*|\s*$)/iu;
const entry = /(\d{1,3})(?:\s*[.、):]\s*|\s+)([A-H])(?=$|[\s,;、])/g;
const footer = /^(?:第\s*\d+\s*[页頁]|page\s+\d+(?:\s+of\s+\d+)?|\d+)$/iu;

export function printedQuestionNumber(stem: string) {
  const number = /^(?:第\s*)?(\d{1,3})(?=[.、):題题]|\s)/u.exec(stem.normalize('NFKC').trim())?.[1];
  return number ? Number(number) : null;
}

// Accept compact, explicitly labelled answer keys. Worked solutions and prose
// are intentionally left to the original-page reader.
export function printedChoiceKey(raw: string) {
  const lines = raw.normalize('NFKC').split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const first = lines.findIndex(line => heading.test(line));
  if (first < 0 || lines.slice(first + 1).some(line => heading.test(line))) return [];
  const body = [lines[first]!.replace(heading, ''), ...lines.slice(first + 1)].filter(Boolean);
  const entries: { number: number; answer: string }[] = [];
  for (const [index, line] of body.entries()) {
    if (index === body.length - 1 && footer.test(line)) break;
    const matches = [...line.matchAll(entry)];
    if (!matches.length || line.replace(entry, '').replace(/[\s,;、]/gu, '') || entries.length + matches.length > 100) return [];
    entries.push(...matches.map(match => ({ number: Number(match[1]), answer: match[2]! })));
  }
  return entries;
}

export function matchPrintedChoiceReferences(
  questions: { id: string; stem: string; question_kind: string }[],
  recognizedStems: string[],
  pages: { page: number; text: string; ocr?: string }[]
) {
  const keys = pages.flatMap(({ page, text, ocr }) => [
    ...printedChoiceKey(text).map(value => ({ ...value, page, source: 'paper' as const })),
    ...printedChoiceKey(ocr ?? '').map(value => ({ ...value, page, source: 'paper_ocr' as const }))
  ]);
  if (!keys.length) return [];
  const recognizedNumbers = recognizedStems.map(printedQuestionNumber);
  const numbers = questions.map(question => printedQuestionNumber(question.stem));
  return questions.flatMap((question, index) => {
    const number = numbers[index];
    if (question.question_kind !== 'choice' || !number || numbers.indexOf(number) !== numbers.lastIndexOf(number) ||
        recognizedNumbers.indexOf(number) !== recognizedNumbers.lastIndexOf(number)) return [];
    const matching = keys.filter(key => key.number === number);
    if (!matching.length || new Set(matching.map(key => key.answer)).size !== 1 ||
        new Set(matching.map(key => key.page)).size !== 1) return [];
    const candidate = matching.find(key => key.source === 'paper') ?? matching[0]!;
    const { options } = splitChoices(question.stem);
    if (options.length < 2 || !completeChoiceStem(question.stem, options.length) ||
        !options.some(option => option.label === candidate.answer)) return [];
    const reference: QuestionReference = { kind: 'choice', source: candidate.source,
      answers: [candidate.answer], explanation: '', sourcePage: candidate.page };
    return [{ id: question.id, stem: question.stem, reference }];
  });
}
