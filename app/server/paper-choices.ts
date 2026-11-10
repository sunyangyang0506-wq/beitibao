const labels = 'ABCDEFGH';
const missingOption = /^(?:\.{2,}|…+|[（(\[【]?(?:缺失|无法辨[认識识]|無法辨[認識]|看不清|未识别|未識別|待补录|待補錄)[）)\]】]?)$/u;

export function splitChoices(stem: string) {
  const markers = Array.from(stem.matchAll(/[（(]\s*([A-HＡ-Ｈ])\s*[）)]|(?<![a-zA-Z0-9_])([A-HＡ-Ｈ])[.．、)）:：](?![a-zA-Z0-9_])/gu));
  return {
    body: stem.slice(0, markers[0]?.index).trim(),
    options: markers.map((item, index) => ({
      label: (item[1] ?? item[2])!.normalize('NFKC'),
      text: stem.slice(item.index + item[0].length, markers[index + 1]?.index).trim()
    }))
  };
}

export function choiceOptionCount(stem: string, declared: unknown, choiceOnly = false) {
  const { options } = splitChoices(stem);
  const explicit = typeof declared === 'number' && Number.isInteger(declared) && declared >= 2 && declared <= labels.length ? declared : 0;
  const looksLikeChoice = choiceOnly || options.length > 0 ||
    /(?:請選擇|请选择)[^。\n]{0,18}(?:選項|选项|答案)|下列[^。\n？?]{0,100}(?:何者|哪[一個个種种項项])/u.test(stem);
  const observed = Math.max(0, ...options.map(item => labels.indexOf(item.label) + 1));
  return Math.max(observed, explicit || (looksLikeChoice ? 4 : 0));
}

function formatOptions(options: { label: string; text: string }[], count: number) {
  if (options.length !== count || !options.every(({ label, text }, index) =>
    label === labels[index] && text && !missingOption.test(text))) return null;
  return options.map(({ label, text }) => `${label}. ${text}`).join('\n');
}

export function completeChoiceStem(stem: string, count: number) {
  if (!count) return stem;
  const { body, options } = splitChoices(stem);
  const formatted = formatOptions(options, count);
  if (!body || !formatted || /^(?:第\s*)?\d{1,3}\s*[.、)題题]?$/u.test(body.normalize('NFKC'))) return null;
  const complete = body + '\n' + formatted;
  return [...complete].length <= 8000 ? complete : null;
}

export function repairChoiceStem(stem: string, value: unknown, count: number) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const choices = value as Record<string, unknown>;
  const options = Array.from(labels.slice(0, count), label => ({ label, text: choices[label] }));
  if (!options.every((item): item is { label: string; text: string } =>
    typeof item.text === 'string' && item.text.length <= 1000 && !item.text.includes('\u0000'))) return null;
  const formatted = formatOptions(options.map(({ label, text }) => ({ label, text: text.trim() })), count);
  return formatted ? completeChoiceStem(splitChoices(stem).body + '\n' + formatted, count) : null;
}
