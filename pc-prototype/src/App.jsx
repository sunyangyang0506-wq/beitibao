import { DemoPersonalNotes } from './DemoPersonalNotes.jsx';
import { assignDemoSubject } from './demo-paper-assignment.js';
import { assignmentMessage } from './paper-assignment.js';
import React, { useEffect, useState } from 'react';
import { ArrowLeft, BookOpen, ChartBar, CheckCircle, ClipboardText, FileText, Plus, Sparkle, UploadSimple } from '@phosphor-icons/react';
import { initialCourses, initialLearned, demoPaperTitle, demoPaperSubject, demoRecognitionQuestions, demoPredictionFor } from './data';
import { PdfUpload, PdfScanGuide } from './PdfUpload.jsx';
import { readPaperFiles, storePaperFiles } from './local-paper-files.js';

const nav = [['progress','学习进展',ChartBar],['practice','题目背诵',BookOpen],['mistakes','错题本',ClipboardText],['prediction','考题预测',Sparkle],['papers','试卷库',FileText]];
const uid = () => crypto.randomUUID();
const get = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem('study-' + key)) ?? fallback; } catch { return fallback; }
};
export function useSaved(key, fallback) {
  const [value,set] = useState(() => get(key,fallback));
  useEffect(() => { try { localStorage.setItem('study-' + key,JSON.stringify(value)); } catch {} },[key,value]);
  return [value,set];
}
const dayKey = at => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(at);
const option = (q, value) => {
  if (q.type === '多选题') return [...new Set(value ?? '')].filter(letter => 'ABCD'.slice(0, q.options.length).includes(letter)).sort().join('');
  return /^[A-D]$/.test(value ?? '') ? value : 'ABCD'[q.options.indexOf(value)] ?? '';
};
const mistakeTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const demoMistakes = initialCourses.flatMap(course =>
  [...new Set([...course.papers.flatMap(paper => paper.questions), ...course.prediction].map(q => q.type))]
    .map(type => {
      const q = [...course.papers.flatMap(paper => paper.questions), ...course.prediction].find(item => item.type === type);
      const value = q.options.length ? 'ABCD'[q.options.findIndex(text => text !== q.answer)] :
        type === '计算题' ? '只写出了计算式，未完成求值。' : '只记得部分要点，解释不完整。';
      return { q, courseId: course.id, status: q.options.length ? '待重练' : '待复核',
        reason: q.options.length ? '客观题答错' : '自评待巩固', value, at: Date.now(), demo: true };
    }));
const displayAnswer = (question, value) => {
  const letter = question.options.length ? option(question, value) : '';
  return letter ? [...letter].map(key => key + ' · ' + question.options['ABCD'.indexOf(key)]).join('；') : value;
};

const mistakeViews = [
  { id: 'time', label: '按错题时间', keys: ['day'] },
  { id: 'type', label: '按题型', keys: ['type'] },
  { id: 'type-time', label: '按题型和错题时间', keys: ['type', 'day'] }
];

function MistakeGroups({ entries, groupKeys, renderEntry, nested = false }) {
  if (!groupKeys.length) return entries.map(renderEntry);
  const [key, ...remaining] = groupKeys;
  const groups = new Map();
  for (const entry of entries) {
    const label = key === 'day' ? dayKey(entry.at) : entry.q.type;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(entry);
  }
  const Heading = nested ? 'h3' : 'h2';
  return [...groups].map(([label, items]) => {
    return <section className="prototype-mistake-group" key={label}>
      <Heading>{key === 'day' ? label.replaceAll('-', '/') : label}<span>{items.length} 道</span></Heading>
      <MistakeGroups entries={items} groupKeys={remaining} renderEntry={renderEntry} nested />
    </section>;
  });
}

function MistakeCard({ entry, course, onRetry, expanded }) {
  const { q } = entry;
  const picked = option(q, entry.value);
  const expected = option(q, q.answer);
  return <article className="prototype-mistake-card">
    <div className="prototype-mistake-meta">
      <span className="badge blue">{q.type}</span><span className="badge">{entry.status}</span>
      {entry.demo && <span className="badge">演示</span>}
      <span>{course?.name} · {q.source} · 第 {q.no} 题</span>
      <time dateTime={new Date(entry.at).toISOString()}>错题时间 {mistakeTime.format(entry.at)}</time>
    </div>
    <details open={expanded || undefined}>
      <summary>{q.prompt}</summary>
      {q.options.length > 0 && <ul className="prototype-mistake-options">{q.options.map((text, index) => {
        const letter = 'ABCD'[index];
        return <li key={letter}><strong>{letter}.</strong> {text}
          {picked.includes(letter) && <span className="badge amber">我的选择</span>}
          {expected.includes(letter) && <span className="badge green">参考选项</span>}</li>;
      })}</ul>}
      <div className="prototype-mistake-answers">
        <div><strong>当时的作答</strong><p>{displayAnswer(q, entry.value) || '未记录作答'}</p></div>
        <div><strong>{q.type === '计算题' ? '参考结果' : q.type === '简答题' ? '参考要点' : '参考答案'}</strong><p>{displayAnswer(q, q.answer) || '暂无参考答案'}</p></div>
      </div>
      {q.explanation && <div className="prototype-mistake-explanation"><strong>{q.type === '计算题' ? '解题步骤' : q.type === '简答题' ? '答题思路' : '选项解析'}</strong><p>{q.explanation}</p></div>}
    </details>
    <div className="prototype-mistake-footer"><span>{entry.reason}{q.topic && ' · 知识点 ' + q.topic}</span><button type="button" onClick={onRetry}>重练</button></div>
  </article>;
}

const paperState = paper => paper.status ?? (paper.questions.length ? '可练习' : '待核对');
const paperNext = {
  识别中: '整理完成后题目自动出现在题目背诵',
  待核对: '查看识别结果，确认是否需要重新上传',
  待归属: '科目暂未确定，原卷已保留',
  缺页: '补齐缺页后重新上传完整 PDF',
  识别失败: '检查 PDF 是否清晰，重新上传',
  可练习: '查看原卷，或开始整套答题'
};

export const samplePdfUrl = import.meta.env.BASE_URL + 'sample-paper.pdf';
const emptyMathCourse = { ...initialCourses.find(item => item.name === demoPaperSubject), teacher: '', papers: [], prediction: null };
const elapsed = (paper, now) => now - paper.uploadedAt;
const identified = (paper, now) => !paper.uploadedAt || elapsed(paper, now) >= 900;
const questionsReady = (paper, now) => elapsed(paper, now) >= 2000;
const answersReady = (paper, now) => elapsed(paper, now) >= 3200;
const predictionReady = (paper, now) => elapsed(paper, now) >= 4700;
const fileTitle = file => file.name.replace(/\.pdf$/i, '').trim();
const normalized = name => name.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();

async function loadSample() {
  const response = await fetch(samplePdfUrl);
  if (!response.ok) throw new Error('演示 PDF 暂时无法读取。');
  return response.arrayBuffer();
}

async function matchesSample(file, sample) {
  if (sample.byteLength !== file.size) return false;
  const bytes = new Uint8Array(await file.arrayBuffer());
  return new Uint8Array(sample).every((byte, index) => byte === bytes[index]);
}

function ChoicePrompt({ question, number, value, readOnly, onChange }) {
  const blank = /[（(]\s*[）)]/u.exec(question.prompt);
  const before = blank ? question.prompt.slice(0, blank.index) : question.prompt + ' ';
  const after = blank ? question.prompt.slice(blank.index + blank[0].length) : '';
  return <>{number}. {before}<span className={'pc-choice-blank ' + (question.type === '多选题' ? 'multiple' : '')}>
    {blank?.[0][0] ?? '（'}<input aria-label={'第 ' + number + ' 题作答'} type="text" value={option(question, value)}
      autoComplete="off" readOnly={readOnly} onChange={event => {
        const next = event.target.value.normalize('NFKC').trim().toUpperCase();
        const letters = 'ABCD'.slice(0, question.options.length);
        if ([...next].every(letter => letters.includes(letter)) && (question.type === '多选题' || next.length <= 1)) onChange(option(question, next));
      }} />{blank?.[0].at(-1) ?? '）'}
  </span>{after}</>;
}

function PreviewSheet({ paper, questions, recognized }) {
  return <div className="paper-sheet prototype-sheet">
    <div className="paper-heading"><h2>{paper.title}</h2><p>期末复习样卷{paper.sample ? ' · 120 分钟' : ''}</p></div>
    {recognized && paper.sample && questions[0]?.page === 1 && <p>考试说明：本卷共 6 题。选择题作答写在括号内，计算题和简答题写出主要步骤。</p>}
    {questions.map((q, index) => <React.Fragment key={q.id}>
      {(index === 0 || questions[index-1].type !== q.type) && <h3 className="answer-group-title">{q.type}</h3>}
      <article className="question"  id={recognized ? "recognized-" + q.id : undefined} key={q.id}>
      <strong>{recognized && q.options.length && q.answer
        ? <ChoicePrompt question={q} number={q.no} value={q.answer} readOnly />
        : <>{q.no}. {q.prompt}</>}</strong>
      {q.options.map((o, i) => <div key={o}>{'ABCD'[i]}. {o}</div>)}
      {recognized && <div className="pc-model-answer"><strong>{q.answer ? '参考答案 · 样卷演示' : '参考答案生成中'}</strong>{!q.options.length && q.answer}
        {q.answer && <details><summary>知识点与解析</summary><p>{q.topic}</p><p>{q.explanation}</p></details>}</div>}
    </article></React.Fragment>)}
  </div>;
}

export function App({ account, onAdmin, onLogin, onLogout }) {
  const useWorkspace = (key, fallback) => useSaved(account ? account.phone + '-' + key : key, fallback);
  const [courses,setCourses] = useWorkspace('courses', account ? [emptyMathCourse] : initialCourses);
  const subjectLimit = account?.limit ?? 10;
  const [examCourseId, setExamCourseId] = useState('');
  const examCourse = courses.find(item => item.id === examCourseId);
  const [unassignedPapers,setUnassignedPapers] = useWorkspace('unassigned-papers', []);
  const [uploadIds,setUploadIds] = useWorkspace('recent-uploads', []);
  const [learned,setLearned] = useWorkspace('learned', account ? {} : initialLearned);
  const [mistakes,setMistakes] = useWorkspace('mistakes',{});
  const [drafts,setDrafts] = useWorkspace('drafts',{});
  const [finished,setFinished] = useWorkspace('finished',{});
  const [screen,setScreen] = useState('progress');
  const [filter,setFilter] = useState('全部');
  const [courseId,setCourseId] = useState('');
  const [mode,setMode] = useState('whole');
  const [type,setType] = useState('');
  const [picked,setPicked] = useState([]);
  const [paperId,setPaperId] = useState('');
  const [session,setSession] = useState(null);
  const [dialog,setDialog] = useState('');
  const [uploads,setUploads] = useState([]);
  const [savingPaper,setSavingPaper] = useState(false);
  const [localPages,setLocalPages] = useState({});
  const [notice,setNotice] = useState('');
  const [mistakeFilter,setMistakeFilter] = useState('全部');
  const [mistakeView,setMistakeView] = useState(mistakeViews[0]);
  const [mistakeCourse,setMistakeCourse] = useState('');
  const [mistakeType,setMistakeType] = useState('');
  const [mistakeDay,setMistakeDay] = useState('');
  const [guideSeen,setGuideSeen] = useWorkspace('guide-seen',false);
  const [clock,setClock] = useState(Date.now());
  const [jobClock, setJobClock] = useState(Date.now);
  const [allowUse, setAllowUse] = useState(false);
  const [duration, setDuration] = useState('original');
  const [personalNotes, setPersonalNotes] = useWorkspace('answer-notes', {});
  const [readerQuestion, setReaderQuestion] = useState('');
  const samples = account ? [] : demoMistakes;
  const course = courses.find(c => c.id === courseId);
  const allPapers = [...courses.flatMap(item => item.papers), ...unassignedPapers];
  const newestDemoPaper = course?.papers.findLast(item => item.sample && item.status !== '待归属');
  const pendingPrediction = newestDemoPaper && !newestDemoPaper.generatedPrediction;
  const predictionQuestions = newestDemoPaper?.generatedPrediction ?? course?.prediction ?? [];
  const predictionKey = newestDemoPaper?.generatedPrediction ? newestDemoPaper.id + '-prediction' : course?.id + '-prediction';
  const predictionHistory = Object.values(finished).filter(result => result?.kind === 'prediction' && result.courseId === courseId && result.key !== predictionKey);
  const predictionSources = newestDemoPaper?.generatedPrediction ? [newestDemoPaper] : course?.papers.filter(p => p.questions.length) ?? [];
  const paper = course?.papers.find(p => p.id === paperId) ?? unassignedPapers.find(p => p.id === paperId);
  const hasJobs = allPapers.some(item => item.uploadedAt && (!identified(item, jobClock) || item.status === '识别中' || (item.sample && item.status === '可练习' && !item.generatedPrediction)));
  const storedPaperId = screen === 'reader' && paper?.filesStored ? paper.id : null;
  useEffect(() => {
    if (!storedPaperId) return;
    let disposed = false;
    let urls = [];
    readPaperFiles(storedPaperId).then(files => {
      if (disposed) return;
      if (!files) throw new Error('本机原卷文件已不可用。');
      urls = files.map(file => URL.createObjectURL(file));
      setLocalPages({ id: storedPaperId, urls });
    }).catch(error => { if (!disposed) setLocalPages({ id: storedPaperId, error: error.message }); });
    return () => { disposed = true; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [storedPaperId]);
  useEffect(() => {
    if (!hasJobs) return;
    const timer = setInterval(() => setJobClock(Date.now()), 150);
    return () => clearInterval(timer);
  }, [hasJobs]);

  useEffect(() => {
    function advance(paper) {
      let next = paper;
      if (paper.status === '识别中' && questionsReady(paper, jobClock)) {
        next = { ...next, status: paper.sample ? '可练习' : '待核对',
          questions: paper.sample ? demoRecognitionQuestions(paper.id) : [] };
      }
      if (next.sample && next.status === '可练习' && !next.generatedPrediction && predictionReady(next, jobClock)) {
        next = { ...next, generatedPrediction: demoPredictionFor(next) };
      }
      return next;
    }
    if (!courses.some(item => item.papers.some(paper => advance(paper) !== paper))) return;
    setCourses(current => current.map(item => ({ ...item, papers: item.papers.map(advance) })));
  }, [jobClock, courses]);

  const sourceUrl = paper?.filesStored ? (localPages.id === paper.id ? localPages.urls?.[0] : null) : paper?.pages[0]?.url;
  const mistakeEntries = [...Object.values(mistakes), ...samples.filter(entry => !mistakes[entry.q.id])];
  const visibleMistakes = mistakeEntries.filter(m => (mistakeFilter === '全部' || m.status === mistakeFilter) &&
    (!mistakeCourse || m.courseId === mistakeCourse) && (!mistakeType || m.q.type === mistakeType) &&
    (!mistakeDay || dayKey(m.at) === mistakeDay)).sort((a,b)=>b.at-a.at);
  const draft = session?.submitted && session.draft ? session.draft : drafts[session?.key] || {};
  const questions = session?.questions || [];
  const byType = [...new Set(course?.papers.flatMap(p => p.questions.map(q => q.type)))];
  const matching = course?.papers.filter(p => p.questions.some(q => q.type === type)) || [];
  const chosen = matching.filter(p => picked.includes(p.id));
  const grouped = [...new Map(chosen.flatMap(p => p.questions.filter(q => q.type === type)).map(q => [q.id, q])).values()];
  const count = p => p.questions.filter(q => learned[q.id]).length;
  const complete = p => paperState(p) === '可练习' && p.questions.length > 0 && count(p) === p.questions.length;
  const remaining = c => c.papers.filter(p => !complete(p)).length;
  const completed = c => c.papers.length > 0 && remaining(c) === 0;
  const allDone = courses.filter(completed).length;
  const isExam = screen === 'exam' && !session?.submitted;
  const answered = questions.filter(q => draft.answers?.[q.id]?.trim()).length;
  const changeCourse = id => { setCourseId(id); setType(''); setPicked([]); setPaperId(''); };
  const openUpload = () => { setUploads([]); setAllowUse(false); setNotice(''); setDialog('upload'); };
  const go = next => { setScreen(next); setNotice(''); window.scrollTo(0,0); };
  const openPaper = (c,p,q) => { if (q) setMode('whole'); changeCourse(c.id); setPaperId(p.id); setReaderQuestion(q?.id ?? ''); go(q ? 'practice' : 'reader'); };
  const browsePaper = (c,p) => { changeCourse(c?.id ?? ''); setPaperId(p.id); setMode('whole'); go('practice'); };
  useEffect(() => {
    if (screen === 'practice' && readerQuestion) document.getElementById('recognized-' + readerQuestion)?.scrollIntoView({block:'start'});
  }, [screen, readerQuestion]);
  const updateDraft = fn => setDrafts(old => ({...old,[session.key]:fn(old[session.key] || {})}));
  const answer = (q,value) => updateDraft(d => ({...d,answers:{...d.answers,[q.id]:value}}));
  const mark = q => updateDraft(d => ({...d,marks:{...d.marks,[q.id]:!d.marks?.[q.id]}}));
  const jump = q => {
    if (!session.submitted) updateDraft(d => ({...d,current:q.id}));
    document.getElementById(q.id)?.scrollIntoView({block:'start',behavior:'smooth'});
  };

  function start(title, list, key, kind, owner = courseId) {
    if (!list.length) return;
    const timed = kind !== 'type' && kind !== 'redo';
    const minutes = duration === 'original' ? (kind === 'whole' && list[0].page ? 120 : 0) : Number(duration);
    const previous = drafts[key];
    if (!previous) setDrafts(old => ({...old,[key]:{answers:{},marks:{},current:list[0].id,deadline:timed && minutes ? Date.now() + minutes * 60 * 1000 : null}}));
    setClock(Date.now());
    setSession({ title, questions:list, key, kind, courseId:owner, submitted:false });
    go('exam');
    if (previous?.current) setTimeout(() => document.getElementById(previous.current)?.scrollIntoView({block:'start'}),60);
  }

  function record(q, self, assessment = false) {
    const value = draft.answers?.[q.id]?.trim();
    if (value || self) setLearned(old => ({...old,[q.id]:true}));
    const prior = mistakes[q.id] ?? samples.find(entry => entry.q.id === q.id);
    let status;
    let reason;
    if (self === '待巩固') { status = '待重练'; reason = '自评待巩固'; }
    else if (self === '已掌握') { status = '已重练'; reason = '自评能独立说出'; }
    else if (value && q.options.length && q.verified && (!q.paperId || !allPapers.some(p => p.id === q.paperId && p.sample && !answersReady(p, jobClock)))) {
      const correct = option(q, value) === option(q, q.answer);
      status = correct ? '已重练' : '待重练';
      reason = correct ? '重练答对' : '客观题答错';
    } else if (value) { status = '待复核'; reason = '对照参考答案与评分要点'; }
    if (status && (status !== '已重练' || prior)) {
      setMistakes(old => {
        const previous = old[q.id] ?? prior;
        const now = Date.now();
        return { ...old, [q.id]: { q, courseId: session.courseId, status, reason,
          value: status === '已重练' ? previous?.value : value,
          at: status === '已重练' ? previous?.at ?? now : now, firstAt: previous?.firstAt ?? previous?.at ?? now,
          history: [...(previous?.history ?? []), { value, at: now, status, assessment }] } };
      });
    }
  }

  function submit() {
    questions.forEach(q => { if (!draft.self?.[q.id]) record(q); });
    const result = { ...session, draft, submitted: true, submittedAt: Date.now() };
    setFinished(old => ({ ...old, [session.key]: result }));
    setDrafts(old => { const next = { ...old }; delete next[session.key]; return next; });
    setSession(s => ({...s,draft,submitted:true}));
    setDialog('');
  }

  useEffect(() => {
    if (!isExam || !draft.deadline) return;
    const timer = setInterval(() => setClock(Date.now()),1000);
    return () => clearInterval(timer);
  },[isExam,draft.deadline]);

  const seconds = draft.deadline ? Math.max(0,Math.ceil((draft.deadline-clock)/1000)) : null;
  useEffect(() => {
    if (isExam && seconds === 0) submit();
  },[isExam,seconds]);

  function toggleManual(q) {
    setMistakes(current => {
      const prior = current[q.id];
      if (prior?.manualOnly) {
        const next = { ...current };
        delete next[q.id];
        return next;
      }
      if (prior) return current;
      const now = Date.now();
      return { ...current, [q.id]: { q, courseId:session.courseId, status:'待重练', reason:'手动收录',
        manualOnly:true, at:now, firstAt:now, value:draft.answers?.[q.id] } };
    });
  }

  function saveNotes(event, q) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    setPersonalNotes(current => ({ ...current, [q.id]: { answer:fields.get('answer'), explanation:fields.get('explanation') } }));
    setNotice('已保存个人答案和解析。');
  }

  function selfAssess(q, status) {
    updateDraft(d => ({...d,self:{...d.self,[q.id]:status}}));
    record(q,status,true);
    setNotice(status === '已掌握' ? '已记录自评。' : '已加入错题本。');
  }

  function openResult(key) {
    const result = finished[key];
    if (!result?.questions) return;
    changeCourse(result.courseId);
    setSession(result);
    go('exam');
  }

  function closeResult() {
    go(session.kind === 'prediction' ? 'prediction' : session.kind === 'redo' ? 'mistakes' : 'progress');
  }

  function saveExamTime(examAt) {
    setCourses(current => current.map(item => item.id === examCourseId ? { ...item, examAt } : item));
    setDialog('');
  }

  function addCourse(e) {
    e.preventDefault();
    const data = new FormData(e.target);
    const name = data.get('name').trim();
    const teacher = data.get('teacher').trim();
    const term = data.get('term').trim();
    if (!name || !term) return;
    if (courses.some(c => normalized(c.name) === normalized(name) && c.teacher === teacher && c.term === term)) {
      setNotice('这门科目已经存在。');
      return;
    }
    if (new Set(courses.map(item => normalized(item.name))).size >= subjectLimit && !courses.some(item => normalized(item.name) === normalized(name))) {
      setNotice('当前账号已达到学科上限。');
      return;
    }
    const id = uid();
    setCourses(old => [...old,{id,name,teacher,term,papers:[],prediction:null}]);
    changeCourse(id); setDialog(''); setNotice('已添加「' + name + '」。可以上传试卷。');
  }

  async function addPaper(event) {
    event.preventDefault();
    if (!uploads.length || savingPaper || !allowUse) return;
    setSavingPaper(true);
    const uploadedAt = Date.now();
    const sampleBytes = loadSample();
    const workingCourses = [...courses];
    const results = await Promise.allSettled(uploads.map(async ({ file }) => {
      const sample = await matchesSample(file, await sampleBytes);
      const subject = sample ? demoPaperSubject : '';
      const title = sample ? demoPaperTitle : fileTitle(file);
      const assignment = assignDemoSubject(workingCourses, subject, subjectLimit, uid);
      const target = assignment.course;
      if (assignment.created) workingCourses.push(target);
      const existing = sample && target?.papers.find(paper => paper.sample && paper.filesStored);
      if (existing) return existing;
      const id = uid();
      await storePaperFiles(id, [file]);
      return { id, title, sample, uploadedAt, questions: [], filesStored: true, pages: [{ name: file.name }],
        status: target ? '识别中' : '待归属', assignmentReason: assignment.reason, recognition: { subject, title: sample ? title : '', targetId: target?.id,
          targetLabel: target ? target.name + ' · ' + target.term : '' } };
    }));
    const papers = results.flatMap((result, index) => result.status === 'fulfilled' ? [result.value] : [{
      id: uid(), title: fileTitle(uploads[index].file), pages: [{ name: uploads[index].file.name }],
      status: '识别失败', questions: [], recognition: {}
    }]);
    setJobClock(Date.now());
    setCourses(current => [...current, ...workingCourses.filter(item => !current.some(existing => existing.id === item.id))].map(item => ({
      ...item, papers: [...item.papers, ...papers.filter(paper => paper.recognition.targetId === item.id && !item.papers.some(previous => previous.id === paper.id))]
    })));
    setUnassignedPapers(current => [...current, ...papers.filter(item => !item.recognition.targetId)]);
    setUploadIds([...new Set(papers.map(item => item.id))]);
    setGuideSeen(true);
    setSavingPaper(false);
    setDialog('');
    setUploads([]);
    changeCourse('');
    go('papers');
  }


  const uploadResults = uploadIds.map(id => allPapers.find(paper => paper.id === id)).filter(Boolean);
  const recentPredictionCourse = courses.find(item => item.papers.some(p => uploadIds.includes(p.id) && p.sample));
  const canShowAnswer = q => {
    const source = allPapers.find(item => item.id === q.paperId);
    return !source?.sample || answersReady(source, jobClock);
  };

  const courseSelect = <select aria-label="选择科目" value={courseId} onChange={e => changeCourse(e.target.value)}><option value="">请选择科目</option>{courses.map(c => <option key={c.id} value={c.id}>{c.name} · {c.teacher || '教师未填写'} · {c.term}</option>)}</select>;
  const openWhole = (c,p) => { changeCourse(c.id); start(p.title,p.questions,p.id,'whole',c.id); };
  const badge = (label, tone = '') => <span className={'badge '+tone}>{label}</span>;
  const button = (label,action,kind='secondary',disabled=false) => <button type="button" className={kind} onClick={action} disabled={disabled}>{label}</button>;

  return <div className="app">
    <aside className="sidebar"><div className="brand"><div className="brand-icon"><BookOpen size={21} weight="bold"/></div><div>背题宝<small>PC 复习工作区</small></div></div>
      <div className="nav-label">复习工作区</div>
      {nav.map(([id,label,Icon]) => <button key={id} className={'nav '+((screen===id || (id==='practice' && screen==='exam' && session.kind!=='prediction' && session.kind!=='redo') || (id==='prediction' && screen==='exam' && session.kind==='prediction') || (id==='mistakes' && screen==='exam' && session.kind==='redo') || (id==='papers' && screen==='reader'))?'active':'')} onClick={() => go(id)}><Icon size={21}/>{label}</button>)}
      <div className="sidebar-foot">{course ? <><strong>{course.name}</strong><small>{course.teacher} · {course.term}</small></> : <><strong>{account ? '学员 ' + account.phone.slice(0, 3) + '****' + account.phone.slice(-4) : '示例工作区'}</strong><small>学科上限 {subjectLimit} 门</small></>}</div>
    </aside>
    <div className="main">
      <header className="top"><div className="top-title">{screen==='reader'?paper?.title:screen==='exam'?session.title:nav.find(n=>n[0]===screen)?.[1]}{screen==='exam'&&badge(session.kind==='type'?'按题型背诵':session.kind==='redo'?'错题重练':session.kind==='prediction'?'预测卷':'整套模拟','blue')}</div>
      <div className="top-actions">{badge('交互原型','blue')}{isExam && <>{seconds!==null && <strong className="timer">剩余 {Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</strong>}<span className="saved"><CheckCircle size={17}/> 草稿已保存</span></>}{button('账号管理',onAdmin,'link')}{button(account ? '退出登录' : '学员登录',account ? onLogout : onLogin,'link')}{screen==='progress'&&button(<><Plus size={17}/> 添加科目</>,()=>{setNotice('');setDialog('course');},'primary')}{screen==='papers'&&button(<><UploadSimple size={18}/> 上传试卷</>,openUpload,'primary')}</div></header>

      {notice && !dialog && <div className="notice" role="status">{notice}</div>}
      {screen==='progress' && <main className="content">
        <div className="intro"><div className="eyebrow">复习总览</div><h1>学习进展</h1><p>查看各科还剩几套卷，接着上次的进度复习。</p></div>
        {!guideSeen && <section className="panel padded prototype-guide">
          {button('上传试卷',()=>{go('papers');openUpload();},'primary')}
          <p>将纸质试卷扫描成 PDF 后上传，模型会识别科目、卷名、题干和知识点，并生成参考答案。</p>
        </section>}
        <div className="metrics">{[['科目总数',courses.length,BookOpen],['背题完成',allDone,CheckCircle],['尚未完成',courses.length-allDone,ChartBar]].map(([label,value,Icon])=><div className="metric" key={label}><div className="metric-icon"><Icon size={23}/></div><div><span>{label}</span><div><strong>{value}</strong> 门</div></div></div>)}</div>
        <section className="panel table-panel"><div className="panel-head"><div><h2>科目进展</h2><p>原卷背题按套统计，预测卷单独记录。</p></div><div className="segments">{['全部','未完成','已完成'].map(f=><button key={f} className={filter===f?'selected':''} onClick={()=>setFilter(f)}>{f}</button>)}</div></div>
        <table><thead><tr><th>科目</th><th>原卷背题进展</th><th>剩余套数</th><th>考题预测</th><th>下一步</th></tr></thead><tbody>{courses.filter(c=>filter==='全部'||(filter==='已完成')===completed(c)).map(c=>{
          const total=c.papers.length, left=remaining(c), done=total-left;
          return <tr key={c.id}><td><strong>{c.name}</strong><small>{c.teacher || '教师未填写'} · {c.term}</small>
            <button type="button" className="link prototype-exam-time"
              aria-label={(c.examAt ? '修改考试时间：' : '考试时间：') + c.name}
              onClick={() => { setExamCourseId(c.id); setDialog('exam-time'); }}>
              {c.examAt ? <time dateTime={c.examAt}>考试 {c.examAt.replace('T', ' ')}</time> : '考试时间'}
            </button></td><td><span>已完成 {done} / {total} 套</span><progress value={done} max={total||1}/></td><td>{total ? left ? <strong>{left} 套</strong> : badge('已完成','green') : '待上传'}</td><td>{button(c.prediction || c.papers.some(p => p.sample) ? '查看预测卷' : '查看生成条件',()=>{changeCourse(c.id);go('prediction');},'link')}</td><td>{button(total?(completed(c)?'查看试卷':'继续背题'):'上传试卷',()=>{changeCourse(c.id); if(total){setMode('whole');setPaperId((c.papers.find(p=>drafts[p.id]&&!complete(p))||c.papers.find(p=>p.questions.length&&!complete(p)))?.id||'');go(completed(c)?'papers':'practice');}else{go('papers');openUpload();}},'secondary')}</td></tr>;
        })}</tbody></table></section>
      </main>}

      {screen==='practice' && <main className="split content">
        <section className="panel padded"><div className="mode-grid">{[['whole','整套答题','按原卷顺序作答，整套提交',FileText],['type','按题型背诵','汇总同科目多套试卷的同类题',BookOpen]].map(([id,label,desc,Icon])=><button key={id} className={'mode '+(mode===id?'selected':'')} onClick={()=>{setMode(id);setPaperId('');}}><Icon size={24}/><strong>{label}</strong><span>{desc}</span></button>)}</div>
        <div className="step"><h2><b>1</b>选择科目</h2>{courseSelect}</div>
        {mode==='type' && <div className="step"><h2><b>2</b>选择题型</h2>{!course?<p>请先选择科目。</p>:!byType.length?<p>当前科目暂无可用题型。</p>:<div className="chips">{byType.map(t=><button key={t} className={t===type?'selected':''} onClick={()=>{setType(t);setPicked(course.papers.filter(p=>p.questions.some(q=>q.type===t)).map(p=>p.id));}}>{t}</button>)}</div>}</div>}
        <div className="step"><h2><b>{mode==='whole'?2:3}</b>选择试卷</h2>
        {!course || (mode==='type'&&!type) ? <p>{course?'选择题型后显示匹配试卷。':'选择科目后显示该科目的试卷。'}</p> : !(mode==='whole'?course.papers:matching).length ? <p>暂无匹配试卷。</p> : (mode==='whole'?course.papers:matching).map(p=><label key={p.id} className="paper-row"><input type={mode==='whole'?'radio':'checkbox'} name="paper" checked={mode==='whole'?p.id===paperId:picked.includes(p.id)} onChange={()=>mode==='whole'?setPaperId(p.id):setPicked(old=>old.includes(p.id)?old.filter(id=>id!==p.id):[...old,p.id])}/><strong>{p.title}</strong><span>{mode==='whole'?(p.questions.length?'已练 '+count(p)+' / '+p.questions.length+' 题':'待核对') : p.questions.filter(q=>q.type===type).length+' 道'+type}</span></label>)}
        </div></section>
        <aside className="panel padded summary"><h2>本次练习</h2><dl><dt>科目</dt><dd>{course?.name || '请选择科目'}</dd><dt>{mode==='whole'?'试卷':'题型'}</dt><dd>{mode==='whole'?(paper?.title||'未选择'):(type||'未选择')}</dd><dt>范围</dt><dd>{mode==='whole'?(paper?.questions.length||0)+' 题':chosen.length+' 套原卷 · '+grouped.length+' 题'}</dd></dl>
        {mode==='whole'&&<label className="prototype-duration">模拟时长<select value={duration} onChange={event => setDuration(event.target.value)}><option value="original">按原卷时长</option><option value="">不限时</option><option value="90">90 分钟</option><option value="120">120 分钟</option></select></label>}
        {mode==='whole'?button(paper&&drafts[paper.id]?'继续答题':'开始整套答题',()=>openWhole(course,paper),'primary wide',!paper?.questions.length):button('开始背题',()=>start(type+'专项背诵',grouped,[courseId,type,...picked.slice().sort()].join('/'),'type'),'primary wide',!grouped.length)}
        <p>{mode==='whole'?'交卷后统一查看参考答案。':'先回忆或输入作答，再核对要点。'}</p></aside>
      </main>}

      {screen==='practice' && mode==='whole' && paper && <section className="content">
        {drafts[paper.id] ? <p role="status">本卷正在闭卷练习，请继续答题。交卷后可查看参考答案。</p>
          : paper.questions.length ? <section className="panel padded"><h2>本卷题目</h2><PreviewSheet paper={paper} questions={paper.questions.map(q => canShowAnswer(q) ? q : { ...q, answer: '' })} recognized /></section>
          : <section className="panel padded"><h2>{paper.title}</h2><p role="status">{paper.recognition?.targetId ? paperNext[paperState(paper)] : assignmentMessage({ ...paper, recognizedSubject: paper.recognition?.subject })}</p>
            <p>当前演示只回放配套样卷，其他 PDF 只保留原卷，不虚构科目或题目。</p>{button('查看原卷',()=>go('reader'))}</section>}
      </section>}

      {screen==='prediction' && <main className="content"><div className="intro"><div className="eyebrow">每科一套</div><h1>考题预测</h1><p>原卷识别结束后，系统自动为符合条件的科目生成一套预测卷。</p></div>
        <section className="panel padded"><h2>选择科目</h2>{courseSelect}
        {pendingPrediction && <div className="pipeline-progress" role="status">{badge('自动生成中','blue')}<strong>正在组卷与复核</strong><p>原卷答案和预测卷独立生成。所有题通过复核后，整套预测卷会自动出现在这里。</p></div>}
        {predictionQuestions.length > 0 ? <div className="prediction">
          <div className="panel-head"><div>{badge('整套预测卷','blue')} {badge('样卷演示')}
            <h2>{course.name}预测卷</h2>
            <p>来自 {predictionSources.length} 套原卷 · 共 {predictionQuestions.length} 题 · {finished[predictionKey] ? '已交卷' : '待作答'}{predictionSources.length === 1 && ' · 依据有限'}</p></div>
            <div className="top-actions">
              {finished[predictionKey] && button('查看交卷结果',()=>openResult(predictionKey))}
              {button(drafts[predictionKey]?'继续答题':'开始预测卷',()=>start(course.name+'预测卷',predictionQuestions,predictionKey,'prediction'),'primary')}
            </div></div>
          <div className="prototype-prediction-preview"><PreviewSheet paper={{ title: course.name + '预测卷' }} questions={predictionQuestions} /></div>
          <details><summary>查看知识网与预测逻辑</summary><div className="evidence">
            <strong>材料中观察到</strong><div className="chips">{predictionSources.flatMap(p=>p.questions.map(q=><button key={q.id} onClick={()=>openPaper(course,p,q)}>{p.title} · 第 {q.no} 题 · {q.topic}</button>))}</div>
            <strong>模型推演示例</strong><ul>{predictionQuestions.map(q => <li key={q.id}>第 {q.no} 题 · {q.topic}{q.evidence && ' · 参考原卷第 ' + q.sourceNo + ' 题的「' + q.evidence + '」'}</li>)}</ul>
            <p>知识点关系以卷面可见内容为依据。未覆盖范围标记为未知。</p></div></details>
          {predictionHistory.length > 0 && <details><summary>历史预测卷作答</summary>
            {predictionHistory.map(result=><button key={result.key} className="link" onClick={()=>openResult(result.key)}>{mistakeTime.format(result.submittedAt)} · 查看结果</button>)}
          </details>}
        </div> : !pendingPrediction && <div className="empty">{course ? '可用来源题不足 5 道，上传原卷后会自动检查。' : '选择科目后查看该科目的预测卷。'}
          {course && button('上传试卷',()=>{go('papers');openUpload();},'link')}</div>}</section>
      </main>}

      {screen==='mistakes' && <main className="content"><div className="intro"><div className="eyebrow">薄弱项复习</div><h1>错题本</h1><p>从原卷或预测卷回到上次卡住的地方。</p></div><section className="panel padded"><div className="panel-head flush"><div className="segments">{['全部','待重练','待复核','已重练'].map(f=><button key={f} aria-pressed={mistakeFilter===f} className={mistakeFilter===f?'selected':''} onClick={()=>setMistakeFilter(f)}>{f}</button>)}</div></div><div className="prototype-filters">
        <label>科目<select value={mistakeCourse} onChange={event => setMistakeCourse(event.target.value)}><option value="">全部科目</option>{courses.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>题型<select value={mistakeType} onChange={event=>setMistakeType(event.target.value)}><option value="">全部题型</option>{[...new Set(mistakeEntries.map(entry=>entry.q.type))].map(item=><option key={item}>{item}</option>)}</select></label>
        <label>错题时间<input type="date" value={mistakeDay} onChange={event=>setMistakeDay(event.target.value)} /></label>
      </div>
      <div className="prototype-mistake-view">
        <p className="prototype-mistake-count" role="status">共 {visibleMistakes.length} 道错题</p>
        <div className="segments" role="group" aria-label="查看方式">
          {mistakeViews.map(view => <button key={view.id} type="button" aria-pressed={mistakeView.id === view.id}
            className={mistakeView.id === view.id ? 'selected' : ''} onClick={() => setMistakeView(view)}>{view.label}</button>)}
        </div>
      </div>
      <MistakeGroups entries={visibleMistakes} groupKeys={mistakeView.keys}
        renderEntry={entry => <MistakeCard key={entry.q.id} entry={entry}
          course={courses.find(item => item.id === entry.courseId)} expanded={entry === visibleMistakes[0]}
          onRetry={() => start('错题重练',[entry.q],'redo-'+entry.q.id,'redo',entry.courseId)} />} />
      {!visibleMistakes.length&&<div className="empty">暂无符合筛选条件的错题。{button('清除筛选',()=>{setMistakeCourse('');setMistakeType('');setMistakeDay('');setMistakeFilter('全部');},'link')}{button('去题目背诵',()=>go('practice'),'link')}</div>}</section></main>}

      {screen==='papers' && <main className="content"><div className="intro"><div className="eyebrow">试卷归档</div><h1>试卷库</h1><p>按科目管理 PDF 原卷，查看识别进度和下一步。</p></div>
      {uploadResults.length > 0 && <section className="panel padded prototype-guide">
        <h2>上传处理进度 <span className="badge blue">原型演示</span></h2>
        <div className="pipeline-steps" aria-label="自动处理流程"><span>01 上传 PDF</span><span>02 识别科目与卷名</span><span>03 生成原卷答案与整套预测卷</span></div>
        <div role="status">{uploadResults.map(item => {
          const known = identified(item, jobClock);
          const state = known ? paperState(item) : '识别中';
          return <div key={item.id} className="paper-row pipeline-row">
            <div className="grow"><strong>{known ? item.title : item.pages[0].name}</strong>
              <small>原文件 {item.pages[0].name}</small>
              <small>识别科目 {known ? item.recognition.subject || '待确认' : '识别中'} · 归档位置 {known ? item.recognition.targetLabel || '待归属' : '匹配中'}</small>
              <small>{paperNext[state]}</small></div>
            <div className="pipeline-badges">
              {badge(state,state === '可练习' ? 'green' : 'amber')}
              {known && item.sample && item.recognition.targetId && <>
                {badge(answersReady(item, jobClock) ? '原卷答案已就绪' : '原卷答案生成中', answersReady(item, jobClock) ? 'green' : 'blue')}
                {badge(item.generatedPrediction ? '整套预测卷已就绪' : '预测卷自动生成中',item.generatedPrediction ? 'green' : 'blue')}
              </>}
            </div>
          </div>;
        })}</div>
        {recentPredictionCourse && button('查看整套预测卷',()=>{changeCourse(recentPredictionCourse.id);go('prediction');},'link')}
      </section>}
      {!course && unassignedPapers.length > 0 && <section className="panel padded prototype-guide"><h2>待处理</h2>
        {unassignedPapers.map(item => <div key={item.id} className="paper-row">
          <div className="grow"><strong>{identified(item,jobClock) ? item.title : item.pages[0].name}</strong><small>{identified(item,jobClock) ? paperNext[paperState(item)] : '正在识别卷面'}</small></div>
          {badge(identified(item,jobClock) ? paperState(item) : '识别中','amber')}
          {item.filesStored ? button('查看原卷',()=>{setPaperId(item.id);go('reader');}) : button('重新上传',openUpload)}
        </div>)}
      </section>}
      <section className="panel padded"><div className="panel-head flush"><h2>原卷列表</h2>{courseSelect}</div>
      {(course?[course]:courses).flatMap(c=>c.papers.map(p=><div className="paper-row" key={p.id}><FileText size={22}/>
        <div className="grow"><strong>{c.name} · {identified(p,jobClock) ? p.title : p.pages[0].name}</strong><small>{paperNext[paperState(p)]}</small></div>
        {badge(paperState(p),paperState(p)==='可练习'?'green':'amber')}
        {button('查看原卷',()=>openPaper(c,p),'secondary')}
        {button('题目背诵',()=>browsePaper(c,p),'secondary')}
        {p.questions.length>0&&button('开始练习',()=>openWhole(c,p),'link')}
        {finished[p.id] && button('查看交卷结果',()=>openResult(p.id),'link')}
      </div>))}
      {course&&!course.papers.length&&<div className="empty">暂无原卷，可上传一份或多份 PDF。</div>}</section></main>}

      {screen==='reader' && paper && <main className="content">
        {button('返回试卷库',()=>go('papers'),'secondary')}
        <div className="intro prototype-reader-title"><h1>{paper.title}</h1><p>{badge(paperState(paper),paperState(paper)==='可练习'?'green':'amber')}　{paperNext[paperState(paper)]}</p></div>
        {drafts[paper.id] ? <section className="panel padded"><p>本卷正在闭卷练习，原卷与答案暂时隐藏。</p>{button('继续答题',()=>openWhole(course,paper),'primary')}</section> : <>
          {button('去题目背诵',()=>browsePaper(course,paper),'primary')}
          <section className="panel padded"><h2>原卷预览</h2>
            <p>题干、参考答案与知识点集中在「题目背诵」。</p>
            {paper.sample ? [1,2].map(page => <img key={page} className="prototype-original-page" src={import.meta.env.BASE_URL + 'sample-page-' + page + '.png'} alt={'上传样卷原貌，第 ' + page + ' 页'} />)
              : paper.filesStored ? (sourceUrl ? <iframe className="source-file" title="原卷 PDF" src={sourceUrl}/> : <p role="status">{localPages.id===paper.id&&localPages.error || '正在读取原卷…'}</p>)
              : <PreviewSheet paper={paper} questions={paper.questions} />}
          </section>
        </>}
      </main>}

      {screen==='exam' && <main className="split exam content"><section className="paper-sheet"><div className="paper-heading"><h1>{session.title}</h1><p className="paper-meta">{session.kind==='type'?'同科目专项练习':session.kind==='redo'?'错题重练':draft.deadline ? '限时模拟' : '不限时模拟'} · 共 {questions.length} 题</p></div>
      {session.submitted&&<div className="result">
        <strong>本次练习已提交</strong><p>已作答 {answered} / {questions.length} 题 · 未答 {questions.length - answered} 题 · 已判错 {questions.filter(q=>draft.answers?.[q.id] && q.verified && q.options.length && canShowAnswer(q) && option(q,draft.answers[q.id]) !== option(q,q.answer)).length} 题 · 待复核 {questions.filter(q=>draft.answers?.[q.id] && (!q.verified || !q.options.length || !canShowAnswer(q))).length} 题</p>
        <details><summary>{session.kind === 'prediction' ? '整卷知识网与预测逻辑' : '整卷知识网与出题逻辑'}</summary>
          <ul className="knowledge-links">{[...new Set(questions.map(q => q.topic))].map(topic => <li key={topic}><strong>{topic}</strong>{questions.filter(q => q.topic === topic).map(q=><button key={q.id} className="link" onClick={()=>jump(q)}>第 {q.no} 题</button>)}</li>)}</ul>
          {questions.some(q=>q.topic.includes('导数')) && <p>综合应用 · 导数可用于判定单调性与极值。</p>}
          {session.kind === 'prediction' ? <ul>{questions.filter(q=>q.evidence).map(q=><li key={q.id}>预测第 {q.no} 题：从原卷第 {q.sourceNo} 题的「{q.evidence}」推演至「{q.topic}」。</li>)}</ul> : <p>卷面观察：选择题检查概念辨析，计算和简答题检查方法与应用。</p>}
        </details></div>}
      {questions.map((q,i)=><React.Fragment key={q.id}>{(i===0||questions[i-1].type!==q.type)&&<h2 className="paper-section">{q.type}</h2>}<article className="question" id={q.id}><div className="question-head"><strong>{q.options.length ? <ChoicePrompt question={q} number={i+1} value={draft.answers?.[q.id]} readOnly={session.submitted} onChange={value=>answer(q,value)}/> : <>{i+1}. {q.prompt}</>}</strong>{!session.submitted&&button(draft.marks?.[q.id]?'已标记':'标记',()=>mark(q),'link')}</div>
      {(session.kind==='type'||session.kind==='redo')&&<small>来源 · {q.source} · 第 {q.no} 题</small>}
      {q.options.length?<div className="options">{q.options.map((o,j)=><label className={option(q,draft.answers?.[q.id]).includes('ABCD'[j])?'picked':''} key={o}><input type={q.type==='多选题'?'checkbox':'radio'} name={q.id} value={o} checked={option(q,draft.answers?.[q.id]).includes('ABCD'[j])} disabled={session.submitted} onChange={()=>{
        const letter = 'ABCD'[j];
        const picked = option(q,draft.answers?.[q.id]);
        answer(q,q.type==='多选题' ? option(q,picked.includes(letter)?picked.replace(letter,''):picked+letter) : letter);
      }}/>{'ABCD'[j]}. {o}</label>)}</div>:<textarea value={draft.answers?.[q.id]||''} readOnly={session.submitted} onChange={e=>answer(q,e.target.value)} placeholder="在这里填写作答过程和结果" aria-label={'第 '+(i+1)+' 题作答'}/>}
      {(session.kind==='type'||session.kind==='redo')&&!session.submitted&&button(draft.revealed?.[q.id]?'收起参考答案':'我想好了，核对要点',()=>updateDraft(d=>({...d,revealed:{...d.revealed,[q.id]:!d.revealed?.[q.id]}})),'secondary')}
      {(session.submitted||draft.revealed?.[q.id]) && (canShowAnswer(q) ? <div className="feedback">
        <strong>参考答案</strong> {draft.answers?.[q.id]?.trim() && q.verified && q.options.length>0 && badge(option(q,draft.answers[q.id])===option(q,q.answer)?'答对':'作答不符',option(q,draft.answers[q.id])===option(q,q.answer)?'green':'amber')}
        {badge(q.verified?'样卷已复核':'待核验',q.verified?'green':'amber')}
        <p>{q.options.length ? <ChoicePrompt question={q} number={i+1} value={q.answer} readOnly /> : q.answer || '暂无参考答案'}</p>
        <p>{q.explanation}</p>{q.topic&&<small>知识点 · {q.topic}</small>}
        <DemoPersonalNotes question={q} notes={personalNotes[q.id]} onSave={saveNotes} />
        {session.kind !== 'redo' && (!mistakes[q.id] || mistakes[q.id].manualOnly) && button(mistakes[q.id]?.manualOnly?'取消手动收录':'加入错题本',()=>toggleManual(q),'link')}
        {session.kind === 'type' && !session.submitted && <div className="chips">{button('能独立说出',()=>selfAssess(q,'已掌握'))}{button('漏了部分',()=>selfAssess(q,'待巩固'))}{button('还想不起来',()=>selfAssess(q,'待巩固'))}</div>}
      </div> : <div className="feedback" role="status">参考答案和知识点生成中，完成后会在此补齐。</div>)}
      </article></React.Fragment>)}</section>
      <aside className="panel padded summary"><div className="panel-head flush"><h2>答题卡</h2><span>已作答 {answered} / {questions.length}</span></div><div>{[...new Set(questions.map(q=>q.type))].map(type=><section key={type} className="answer-group"><h3>{type}</h3><div className="answer-grid">{questions.map((q,i)=>q.type===type && <button key={q.id} className={[draft.current===q.id?'current':'',draft.marks?.[q.id]?'marked':draft.answers?.[q.id]?.trim()?'answered':''].join(' ')} onClick={()=>jump(q)} aria-label={'定位第 '+(i+1)+' 题'} title={draft.marks?.[q.id]?'已标记':draft.answers?.[q.id]?.trim()?'已作答':'未作答'}>{i+1}</button>)}</div></section>)}</div>
      <p className="legend"><span>已作答</span><span>未作答</span><span>已标记</span></p>
      {session.submitted?button('完成并返回',closeResult,'primary wide'):button(session.kind==='type'||session.kind==='redo'?'完成本次练习':'提交整套',()=>setDialog('submit'),'primary wide')}
      {!session.submitted&&button(<><ArrowLeft size={16}/> 保存并退出</>,()=>go(session.kind==='prediction'?'prediction':session.kind==='redo'?'mistakes':'practice'),'link wide')}</aside></main>}
    </div>

    {dialog&&<div className="overlay" onClick={()=>{ if (!savingPaper) setDialog(''); }}><div className="modal" role="dialog" aria-modal="true" aria-label={dialog==='course'?'添加科目':dialog==='upload'?'上传试卷':dialog==='exam-time'?'设置考试时间':'确认提交'} onClick={e=>e.stopPropagation()}>
    {dialog==='course'&&<form className="form" onSubmit={addCourse}><h2>添加科目</h2><label>科目名称<input name="name" required autoFocus placeholder="例如：大学物理"/></label><label>教师<input name="teacher" placeholder="选填"/></label><label>学期<input name="term" required defaultValue="本学期"/></label>{notice&&<p role="alert">{notice}</p>}<div className="modal-actions">{button('取消',()=>setDialog(''))}<button className="primary">添加科目</button></div></form>}
    {dialog==='exam-time' && examCourse && <form className="form" onSubmit={event => {
      event.preventDefault();
      saveExamTime(new FormData(event.currentTarget).get('examAt'));
    }}>
      <h2>设置考试时间</h2>
      <p>{examCourse.name} · {examCourse.term}</p>
      <label>考试日期和时间（北京时间）<input type="datetime-local" name="examAt"
        defaultValue={examCourse.examAt || ''} required autoFocus /></label>
      <div className="modal-actions">
        {examCourse.examAt && button('清除考试时间', () => saveExamTime(''), 'link')}
        {button('取消', () => setDialog(''))}
        <button className="primary">保存</button>
      </div>
    </form>}
    {dialog==='upload'&&<form className="form" onSubmit={addPaper}><h2>上传试卷</h2>
      <p>只支持 PDF，单次最多 30 份，每份最多 50 MB，独立处理。模型从卷面识别并自动归属科目。题目直接在题目背诵展示。</p>
      <div className="sample-box"><strong>体验完整自动流程</strong><p>上传配套样卷后会回放识别、原卷解析与整套预测结果。你也可以选本机 PDF 预览。</p>
        <a href={samplePdfUrl} download="demo-upload.pdf">下载演示 PDF</a>
        {button('选用演示 PDF',async()=>{
          try {
            const response = await fetch(samplePdfUrl);
            if (!response.ok) throw new Error();
            const blob = await response.blob();
            setUploads([{ file:new File([blob],'demo-upload.pdf',{type:'application/pdf'}) }]);
            setNotice('');
          } catch { setNotice('未能加载演示 PDF，请重试。'); }
        },'secondary',savingPaper)}
      </div>
      <PdfScanGuide /><PdfUpload files={uploads} setFiles={files=>{setUploads(files);setNotice('');}} disabled={savingPaper} maxBytes={50 * 1024 * 1024} keepValid />
      <label className="prototype-consent"><input type="checkbox" checked={allowUse} onChange={event=>setAllowUse(event.target.checked)} disabled={savingPaper} />我有权使用所选试卷，并同意在本机原型中处理。</label>
      {notice&&<p role="alert">{notice}</p>}
      <div className="modal-actions">{button('取消',()=>setDialog(''),'secondary',savingPaper)}<button className="primary" disabled={savingPaper||!uploads.length||!allowUse}>{savingPaper ? '正在上传…' : '上传并识别'}</button></div>
    </form>}
    {dialog==='submit'&&<div className="form"><h2>确认提交本次练习？</h2><p>{answered<questions.length?'还有 '+(questions.length-answered)+' 题未输入作答。':''}提交后可以查看参考答案。</p><div className="modal-actions">{button('返回检查',()=>setDialog(''))}{button('确认提交',submit,'primary')}</div></div>}
    </div></div>}
  </div>;
}
