import sharp from 'sharp';
import { classificationText } from './subject-assignment.js';
import { choiceOptionCount, completeChoiceStem, repairChoiceStem } from './paper-choices.js';
import { compareFigure, cropOriginal, figureBox, figureReading, figureText, figureWithinQuestion, isNumericSearchTree, type PaperFigure } from './paper-figures.js';

export const imageRecognitionModel = 'qwen3.5-flash-2026-02-23';
export const imagePromptVersion = 'image-questions-v24';
export type ImageType = 'image/png' | 'image/jpeg';

export function isImageType(value: unknown): value is ImageType {
  return value === 'image/png' || value === 'image/jpeg';
}

export function validImage(bytes: Buffer, mediaType: ImageType) {
  if (mediaType === 'image/jpeg') {
    return bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
      && bytes.subarray(-2).equals(Buffer.from('ffd9', 'hex'));
  }
  return bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0
    && bytes.readUInt32BE(16) * bytes.readUInt32BE(20) <= 25_000_000;
}

const figureSchema = 'reading 为 {kind:"directed|undirected|tree|other",nodes:["逐字节点名"],edges:[{from:"起点/父节点",to:"终点/子节点",label:"权重或空字符串；树用 left、middle、right 或 child"}],description:"其余可见标注"}。非图结构的图表用 other、空 nodes/edges 和完整描述。所有节点名（含前导零）用字符串；有向边从箭尾到箭头，逐条放大核对；树按从上到下记录父子节点和左右，不要把节点旁数字臆称为平衡因子。不确定时返回 null，严禁补全。';
const transcriptionRules = '按卷面保留繁体、简体和异体字，禁止翻译或转换字形。数字逐位核对，代码保留换行和原始缩进。每个行内公式整体放在一对单美元符号内，独立公式用双美元符号。进制写成 $(101)_2$ 或 $(AB)_{16}$，乘号用 \\times，对数用 \\log，保留分式、指数、下标、积分限和分段条件。';
const pagePrompt = '按原文逐字转录题目，保留大题号、选项、公式和代码。选择题的 stem 中逐字保留所有可见选项，每项一行，例如 A. 原文。双栏选项按标签排序。choiceOptionCount 填原题应有的选项数，常见 A–D 填 4，个别选项看不清也不要降低数量。非选择题填 null。只有卷面明确说明整份考试均为选择题时，在 choiceInstructions 逐字转录该说明。' +
  '同一大题的小问放一起。没有新题号的跨页续文和选项放入 continuation。不要猜测缺失文字。忽略署名、版权、空白答题栏和参考答案区。若只有答案、解析或评分说明，返回空 questions 数组。' +
  '逐字转录页眉或页脚确实可见的页码标注到 printedPageLabel，保留所有数字和分隔符。例如「頁次：4－1」必须保留原文，其当前页是 1、总页数是 4。「3/16」当前页是 3。单独印刷的页码可只填该数字。无法辨认填 null，不要把代号、题号、年份或总页数当当前页。' +
  '识别学科名称，在 paperSubject 返回不含学校、教师、学期、试卷版本的课程名称。优先使用卷面明确标注的学科，可根据明确的科目代码和题目确定学科。无法可靠确定时返回 null。' +
  'paperTerm 和 paperTeacher 仅逐字转录卷面明确的学期和教师，无法确定时返回 null，禁止猜测当前学期或教师。' +
  '如果卷面有明确的试卷主标题，在 paperTitle 中逐字转录。只取主标题，忽略答题说明、机构水印、页眉页脚和章节标题；无明确主标题时返回 null，禁止猜测。' +
  '逐行核对从本页第一道新题到最后一道新题的编号。每道题的 printedQuestionNumber 单独记录实际印刷的阿拉伯大题号，如 "01" 或 "17"，没有则填 null。stem 开头也保留原题号。禁止按数组位置推算编号。页首即使出现上一题选项或小问，也必须继续识别紧随其后的第一道新题。只有没有独立大题号的续文才跳过。分两栏排版的 A-D 选项仍全部纳入该题。输出前核查题号、选项、数字和公式。' +
  '多栏页先找到分栏线，按栏从上到下读，同一题的题干和图表才放在一起。含答案版中，留空题内已经填好的答案，保留完整题干和所有选项。' + transcriptionRules +
  '只返回 JSON 对象 {"printedPageLabel":null,"choiceInstructions":null,"paperTitle":null,"paperSubject":null,"paperTerm":null,"paperTeacher":null,"continuation":null,"questions":[{"printedQuestionNumber":null,"stem":"原文题号、题干和可见选项","choiceOptionCount":null,"questionBox":[左,上,右,下],"visualContext":"可见图表的简述，纯文字题为空","standalone":false,"figures":[{"box":[左,上,右,下],"reading":{}}]}]}。' +
  'standalone 仅在本题题干完整且可独立作答、无需图表、同页或其他页材料、前题信息或卷尾答案时设为 true，任何疑点均设为 false。' +
  'questionBox 包围整道题及其图表。figures 的 box 只包围本题实际图表，紧贴四边并包含所有标签。纯文字题的 figures 为空数组。' +
  '所有框使用整页 0 到 1000 整数坐标。无法定位的框用 null。' + figureSchema;
const cropPrompt = '这是从原页按原始像素裁出的单张图，独立转录。只输出 JSON 对象 {"reading":{}}。忽略四周少量题干或页脚，专注图本身。只有图截断、混有另一张图或存在无法辨认的关键边、节点或数据时，返回 {"reading":null}。不要解题。' + figureSchema;
const searchTreeCropPrompt = '本图是整数键值的搜索树。只沿实际连线读取父子关系，逐字保留键值和前导零。没有明确的左右标记时，每条边的 label 用 child。图上有明确的左右标记时，按原样转录。不要按键值推断是否存在连线或新增节点。';
const otherCropPrompt = '如果图中明确为 AVL 或 BST，用节点键值检查左右关系；不确定则保留原图所见，不新增或改写边。';

type RecognitionPayload = { questions?: unknown; printedPageLabel?: unknown; printedPage?: unknown; printedTotalPages?: unknown;
  choiceInstructions?: unknown; paperTitle?: unknown; paperSubject?: unknown; paperTerm?: unknown; paperTeacher?: unknown; continuation?: unknown;
  reading?: unknown; options?: unknown; choiceOptions?: unknown; printedQuestionNumbers?: unknown };
class RetryableRecognitionError extends Error {}

function validPageQuestions(questions: unknown) {
  return Array.isArray(questions) && questions.length <= 100 && questions.every(item =>
    typeof item?.stem === 'string' && item.stem.trim() && !item.stem.includes('\u0000') && [...item.stem.trim()].length <= 8000 &&
    (item.visualContext === undefined || (typeof item.visualContext === 'string' && !item.visualContext.includes('\u0000') &&
      [...item.visualContext].length <= 8000)));
}

function printedPageMetadata(result: RecognitionPayload) {
  const number = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 9999 ? value : undefined;
  const label = typeof result.printedPageLabel === 'string' ? result.printedPageLabel.trim() : '';
  if (!label || label.length > 48 || /[\p{Cc}\p{Cf}]/u.test(label)) {
    const page = number(result.printedPage);
    const total = number(result.printedTotalPages);
    return { ...(page && { printedPage: page }), ...(total && (!page || page <= total) && { printedTotalPages: total }) };
  }
  const text = label.normalize('NFKC').replace(/^(?:[頁页](?:次|[碼码])|page)\s*:?\s*/iu, '');
  const totalFirst = /^(\d{1,4})\s*[-–—−]\s*(\d{1,4})$/u.exec(text);
  const currentFirst = /^(?:第\s*)?(\d{1,4})\s*[頁页]?\s*(?:\/\s*(?:共\s*)?|共\s*|of\s*)(\d{1,4})\s*[頁页]?$/iu.exec(text);
  const single = /^(?:第\s*)?(\d{1,4})\s*[頁页]?$/u.exec(text);
  const page = number(Number(totalFirst?.[2] ?? currentFirst?.[1] ?? single?.[1]));
  const total = number(Number(totalFirst?.[1] ?? currentFirst?.[2]));
  if (!page || ((totalFirst || currentFirst) && (!total || page > total))) return { printedPageLabel: label };
  return { printedPageLabel: label, printedPage: page, ...(total && { printedTotalPages: total }) };
}

async function imageCompletion(bytes: Buffer, mediaType: ImageType, prompt: string, timeout: number, maxTokens: number,
  request: typeof fetch, page = false): Promise<RecognitionPayload> {
  const workspace = process.env.BAILIAN_WORKSPACE_ID;
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!workspace || !/^[a-zA-Z0-9-]+$/.test(workspace) || !apiKey) throw new Error('OCR_NOT_CONFIGURED');
  const signal = AbortSignal.timeout(timeout);
  const send = async (input: Buffer, type: ImageType, instructions: string, strictJson = true, requestSignal = signal) => {
    const response = await request(`https://${workspace}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: requestSignal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: imageRecognitionModel, enable_thinking: false, max_tokens: maxTokens,
        ...(strictJson && { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: [{ type: 'image_url', image_url: {
            url: `data:${type};base64,${input.toString('base64')}`
          } }] }
        ]
      })
    });
    if (response.status === 400) {
      const error = (await response.json().catch(() => null))?.error;
      if (error?.code === 'invalid_parameter_error' && typeof error.message === 'string' &&
          error.message.startsWith('Model output became abnormal while generating a JSON response')) {
        throw new RetryableRecognitionError('OCR_REQUEST_FAILED');
      }
    }
    if (page && [408, 500, 502, 503, 504].includes(response.status)) throw new RetryableRecognitionError('OCR_REQUEST_FAILED');
    if (response.status === 401 || response.status === 403) throw new Error('OCR_ACCESS_DENIED');
    if (response.status === 429) throw new Error('MODEL_RATE_LIMIT');
    if (!response.ok) throw new Error('OCR_REQUEST_FAILED');
    const choice = (await response.json().catch(() => null))?.choices?.[0];
    if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') {
      if (page && (!choice || ['length', 'stop'].includes(choice.finish_reason))) throw new RetryableRecognitionError('OCR_INVALID_OUTPUT');
      throw new Error('OCR_INVALID_OUTPUT');
    }
    let payload;
    const content = strictJson ? choice.message.content : choice.message.content.trim()
      .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
    try { payload = JSON.parse(content); } catch { payload = null; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || (page && !validPageQuestions(payload.questions))) {
      throw new RetryableRecognitionError('OCR_INVALID_OUTPUT');
    }
    return payload as RecognitionPayload;
  };
  try {
    return await send(bytes, mediaType, prompt);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    if (!page && error instanceof RetryableRecognitionError && !signal.aborted) {
      return send(bytes, mediaType, prompt);
    }
    if (!page || !(timedOut || error instanceof RetryableRecognitionError || error instanceof TypeError)) throw error;
    const retryPrompt = prompt +
      '只输出紧凑 JSON。原卷每道题的印刷题号仍须在 printedQuestionNumber 中保留，题干和所有可见选项须完整逐字转录。保留图框；图结构未看清时 reading 用 null，visualContext 保持简短。';
    if (mediaType === 'image/png') return send(bytes, mediaType, retryPrompt, false, AbortSignal.timeout(24_000));
    if (timedOut) return send(bytes, mediaType, retryPrompt, false, AbortSignal.timeout(24_000));
    if (signal.aborted) throw error;
    const normalized = await sharp(bytes).resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .normalise().png().toBuffer();
    return send(normalized, 'image/png', retryPrompt, false);
  }
}

export async function rereadFigure(bytes: Buffer, box: NonNullable<PaperFigure['box']>, request = fetch, numericSearchTree = false) {
  const crop = await cropOriginal(bytes, box);
  const result = await imageCompletion(crop, 'image/png', cropPrompt + (numericSearchTree ? searchTreeCropPrompt : otherCropPrompt), 18_000, 3072, request);
  return figureReading(result?.reading);
}

const optionPrompt = '只逐字转录题号对应的印刷选项，按标签读全双栏选项，保留公式、正负号和代码。看不见或无法辨认的选项填 null。不要猜测、解题或使用其他题的选项。' + transcriptionRules;

function questionNumberInStem(stem: string) {
  const number = /^(?:第\s*)?(\d{1,3})(?=\s|[.、):題题])/u.exec(stem.normalize('NFKC'))?.[1];
  return number === undefined ? null : Number(number);
}

function printedQuestionLabel(value: unknown) {
  const label = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().normalize('NFKC') : '';
  return /^\d{1,3}$/u.test(label) ? label : null;
}

function withPrintedQuestionNumber(stem: string, value: unknown) {
  const label = printedQuestionLabel(value);
  if (!label || questionNumberInStem(stem) === Number(label) ||
      /^(?:第\s*)?\d{1,3}[.、):題题]/u.test(stem.normalize('NFKC')) || [...stem].length + label.length + 2 > 8000) return stem;
  return label + '. ' + stem;
}

async function recoverMissingQuestionNumbers(bytes: Buffer, mediaType: ImageType, stems: string[], timeout: number, request: typeof fetch) {
  const present = new Set(stems.map(questionNumberInStem).filter(number => number !== null));
  if (present.size < 2) return;
  const targets = stems.flatMap((stem, index) => questionNumberInStem(stem) === null ? [{ index, beginning: stem.split('\n')[0]!.slice(0, 90) }] : []);
  if (!targets.length || targets.length > 20) return;
  try {
    const { printedQuestionNumbers } = await imageCompletion(bytes, mediaType,
      '逐条在图片上找到题干开头对应的原题，只读左侧印刷大题号。不要把题干中的数字当编号。index 只是回传键，不能用它或相邻题号推算。无法定位或看不清时填 null。' +
      '只输出 JSON {"printedQuestionNumbers":{"index":"原题号"}}。待查题干 ' + JSON.stringify(targets),
    timeout, 1000, request);
    if (!printedQuestionNumbers || typeof printedQuestionNumbers !== 'object' || Array.isArray(printedQuestionNumbers)) return;
    for (const { index } of targets) {
      const label = printedQuestionLabel((printedQuestionNumbers as Record<string, unknown>)[index]);
      if (!label || present.has(Number(label))) continue;
      stems[index] = withPrintedQuestionNumber(stems[index]!, label);
      present.add(Number(label));
    }
  } catch {
    // The question and its source page remain available without an inferred number.
  }
}

async function recoverMissingChoices(bytes: Buffer, mediaType: ImageType, stems: string[], counts: number[],
  boxes: ReturnType<typeof figureBox>[], request: typeof fetch) {
  const missing = stems.flatMap((stem, index) => completeChoiceStem(stem, counts[index]!) === null ? [index] : []);
  if (!missing.length) return;
  const numbers = stems.map(questionNumberInStem);
  const first = missing[0]!;
  const box = boxes[first];
  try {
    if (missing.length === 1 && box) {
      const [left, top, right, bottom] = box;
      const next = boxes[first + 1];
      const gap = next ? next[1] - bottom : -1;
      const sameColumn = next && Math.min(right, next[2]) - Math.max(left, next[0]) >= (right - left) / 2;
      const cropBottom = sameColumn && gap > 9 && gap <= 100 ? next[1] - 3 : Math.min(1000, bottom + 9);
      const crop = await cropOriginal(bytes, [Math.max(0, left - 12), top, Math.min(1000, right + 12), cropBottom]);
      const target = numbers[first] ? `找到印刷题号 ${numbers[first]}。` : '找到裁片中唯一一道题。';
      const { options } = await imageCompletion(crop, 'image/png', target + optionPrompt +
        `该题应有 ${counts[first]} 项。只输出 JSON {"options":{"A":"原文","B":"原文"}}，按题面补充所有后续标签。`,
      14_000, 1500, request);
      stems[first] = repairChoiceStem(stems[first]!, options, counts[first]!) ?? stems[first]!;
      return;
    }
    const targets = missing.filter(index => {
      const number = numbers[index] ?? null;
      return number !== null && numbers.indexOf(number) === numbers.lastIndexOf(number);
    }).slice(0, 30);
    if (!targets.length) return;
    const instructions = targets.map(index => `${numbers[index]}（${counts[index]} 项）`).join('、');
    const { choiceOptions } = await imageCompletion(bytes, mediaType, optionPrompt +
      `只查找以下印刷题号和选项数 ${instructions}。只输出 JSON {"choiceOptions":{"题号":{"A":"原文","B":"原文"}}}，每题按原有标签补全可见的全部选项。`,
    22_000, 6144, request);
    if (!choiceOptions || typeof choiceOptions !== 'object' || Array.isArray(choiceOptions)) return;
    const readings = Object.entries(choiceOptions).filter(([label]) => /^\d{1,3}$/u.test(label));
    for (const index of targets) {
      const matching = readings.filter(([label]) => Number(label) === numbers[index]);
      if (matching.length === 1) stems[index] = repairChoiceStem(stems[index]!, matching[0]![1], counts[index]!) ?? stems[index]!;
    }
  } catch {
    // Keep the observed stem for publication checks or a later retry.
  }
}

export async function recognizeImage(bytes: Buffer, mediaType: ImageType, request = fetch, examIsChoiceOnly = false) {
  const original = sharp(bytes, { limitInputPixels: 25_000_000 });
  const metadata = await original.metadata();
  if ((mediaType === 'image/png' ? 'png' : 'jpeg') !== metadata.format) throw new Error('INVALID_IMAGE');
  const oriented = metadata.orientation && metadata.orientation > 1 ? await original.autoOrient().toBuffer() : bytes;
  const instructions = examIsChoiceOnly ? pagePrompt + '卷首明确说明整份考试都是选择题，本页每道题都必须转录选项。' : pagePrompt;
  const result = await imageCompletion(oriented, mediaType, instructions, 42_000, 8192, request, true);
  const recognized: unknown = result?.questions;
  if (!Array.isArray(recognized) || recognized.length > 100) throw new Error('OCR_INVALID_OUTPUT');
  const leading = recognized[0]?.stem;
  const next = recognized[1]?.stem;
  const startsWithContinuation = typeof leading === 'string' && typeof next === 'string' &&
    /^\s*(?:[（(]\d+[）)]|(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[IVX]+|[A-D])[.．、)])/u.test(leading) &&
    /^\s*(?:第\s*)?\d+[.．、)题]/u.test(next) &&
    (/^[（(]\d+[）)]/u.test(leading.trim()) || (leading.match(/(?:^|\s)[A-D][.．、)]/gu)?.length ?? 0) >= 2);
  const carried = [result.continuation, startsWithContinuation ? leading : null]
    .find(value => typeof value === 'string' && value.trim() && value.length <= 4000 && !value.includes('\u0000'));
  const continuation = typeof carried === 'string' ? carried.trim() : undefined;
  const candidates = startsWithContinuation ? recognized.slice(1) : recognized;
  const questions: typeof candidates = [];
  for (const candidate of candidates) {
    const previous = questions.at(-1);
    if (previous && typeof candidate.stem === 'string' &&
        /^\s*(?:请回答下列问题|回答下列问题|[（(]\d+[）)])/u.test(candidate.stem) &&
        /^\s*(?:第\s*)?\d+[.．、)题]/u.test(previous.stem) &&
        previous.stem.length + candidate.stem.length < 8000) {
      previous.stem += '\n' + candidate.stem;
      previous.standalone = false;
      const left = figureBox(previous.questionBox);
      const right = figureBox(candidate.questionBox);
      if (left && right) previous.questionBox = [
        Math.min(left[0], right[0]), Math.min(left[1], right[1]), Math.max(left[2], right[2]), Math.max(left[3], right[3])
      ];
      if (Array.isArray(candidate.figures)) previous.figures = [...(previous.figures ?? []), ...candidate.figures];
    } else {
      questions.push({ ...candidate });
    }
  }
  const stems: string[] = questions.map(item => withPrintedQuestionNumber(item.stem.trim(), item.printedQuestionNumber));
  const visualContexts: string[] = questions.map(item => item.visualContext?.trim() ?? '');
  const choiceOnly = typeof result.choiceInstructions === 'string' && result.choiceInstructions.length <= 200 &&
    !/(?:非[選选][擇择][題题]|申[論论][題题]|[問问]答[題题]|[簡简]答[題题])/u.test(result.choiceInstructions) &&
    /(?:本[卷試试測测]|本科目|全卷)[^。；\n]{0,50}(?:[單单][項项一選选]|[選选][擇择][題题])/u.test(result.choiceInstructions);
  const choiceCounts = questions.map((item, index) => choiceOptionCount(stems[index]!, item.choiceOptionCount, choiceOnly || examIsChoiceOnly));
  const questionBoxes = questions.map(item => figureBox(item?.questionBox));
  const figures: PaperFigure[][] = questions.map((item, index) => {
    const candidates: unknown = item.figures;
    if (Array.isArray(candidates) && candidates.length) {
      return candidates.slice(0, 4).map(candidate => {
        const box = figureBox(candidate?.box);
        return { box, initial: figureReading(candidate?.reading), reread: null, status: 'needs_review',
          reason: box && figureWithinQuestion(box, questionBoxes[index]) ? 'budget' : 'location' };
      });
    }
    return visualContexts[index] || /(?:如下图|见图|下列图表|siguiente (?:grafo|árbol|figura)|muestra la figura)/iu.test(stems[index]!)
      ? [{ box: null, initial: null, reread: null, status: 'needs_review', reason: 'location' }] : [];
  });
  const repairDeadline = Date.now() + 22_000;
  await recoverMissingChoices(oriented, mediaType, stems, choiceCounts, questionBoxes, request);
  const numberReadTime = Math.min(12_000, repairDeadline - Date.now());
  if ((choiceOnly || examIsChoiceOnly) && numberReadTime > 0) {
    await recoverMissingQuestionNumbers(oriented, mediaType, stems, numberReadTime, request);
  }
  for (const [index, stem] of stems.entries()) {
    stems[index] = completeChoiceStem(stem, choiceCounts[index]!) ?? stem;
  }
  const pending = figures.flatMap((items, question) => items.flatMap((figure, index) =>
    figure.box && figure.reason !== 'location' ? [{ figure, question, index }] : [] )).slice(0, 8);
  for (let start = 0; start < pending.length; start += 4) {
    await Promise.all(pending.slice(start, start + 4).map(async ({ figure, question, index }) => {
      let reread = null;
      try {
        reread = await rereadFigure(bytes, figure.box!, request, isNumericSearchTree(stems[question] ?? '', figure.initial));
      } catch {
        // The original page and initial result remain available for manual review.
      }
      figures[question]![index] = compareFigure(figure, reread, stems[question]);
    }));
  }
  const resolvedContexts = figures.map(items => items.map(item =>
    item.status === 'consistent' ? figureText(item.reread) : '').filter(Boolean).join('\n\n'));
  const title = typeof result.paperTitle === 'string' ? result.paperTitle.replace(/\\[nr]/gu, ' ').trim().replace(/\s+/gu, ' ') : '';
  const paperTitle = title && [...title].length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(title) ? title : undefined;
  const subject = typeof result.paperSubject === 'string' ? result.paperSubject.normalize('NFKC').trim().replace(/\s+/gu, ' ') : '';
  const paperSubject = subject && [...subject].length <= 100 && !/[\p{Cc}\p{Cf}]/u.test(subject) ? subject : undefined;
  const paperTerm = classificationText(result.paperTerm, 80);
  const paperTeacher = classificationText(result.paperTeacher, 100);
  const standaloneStems = questions.flatMap((item, index) => item.standalone === true && !visualContexts[index] &&
    !figures[index]?.length && completeChoiceStem(stems[index]!, choiceCounts[index]!) !== null ? [stems[index]!] : []);
  return { ...printedPageMetadata(result), ...(choiceOnly && { choiceOnly }), ...(choiceCounts.some(Boolean) && { choiceCounts }),
    ...(standaloneStems.length && { standaloneStems }), ...(paperSubject && { paperSubject }), ...(paperTitle && { paperTitle }),
    ...(paperTerm && { paperTerm }), ...(paperTeacher && { paperTeacher }),
    ...(continuation && { continuation }), model: imageRecognitionModel, promptVersion: imagePromptVersion,
    stems, visualContexts, questionBoxes, figures, resolvedContexts };
}
