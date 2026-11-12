import React, { useEffect, useState } from 'react';
import { RecallSequence } from './QuestionRecall.jsx';
import { PaperText } from './PaperText.jsx';
import { assignmentMessage } from './paper-assignment.js';

const active = value => ['queued', 'processing'].includes(value?.status);
const pageFailure = {
  MODEL_PAYMENT_REQUIRED: '模型服务余额不足，需由服务方处理。',
  MODEL_SERVICE_NOT_ENABLED: '模型服务尚未开通。',
  MODEL_AUTHENTICATION_FAILED: '模型服务认证失败。',
  MODEL_ACCESS_DENIED: '模型服务权限不足。',
  MODEL_NOT_CONFIGURED: '模型服务尚未配置。',
  MODEL_BUDGET_LIMIT: '今天的模型识别额度已用完。',
  MODEL_RATE_LIMIT: '模型请求过多，请稍后重试。',
  OCR_NOT_CONFIGURED: '自动识别服务尚未配置。',
  OCR_ACCESS_DENIED: '识别服务暂不可用。服务恢复后可重试。',
  OCR_INCOMPLETE_OPTIONS: '本页有选择题缺少选项。',
  OCR_TIMEOUT: '本页处理超时。'
};

const terminalModelFailure = code => ['MODEL_PAYMENT_REQUIRED', 'MODEL_SERVICE_NOT_ENABLED',
  'MODEL_AUTHENTICATION_FAILED', 'MODEL_ACCESS_DENIED', 'MODEL_BUDGET_LIMIT', 'MODEL_NOT_CONFIGURED'].includes(code);

// Source management lives in the library; recognized questions live in study.
// Both modes use the same closed-book guard returned by the server.
export function PaperStudy({ api, csrf, paperId, onExpired, onBack, onPractice, onBrowse,
  onMistakes, notice, courses = [], study = false, embedded = false }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [duration, setDuration] = useState('');
  const path = '/papers/' + paperId;
  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function load() {
      try {
        const details = await api(path, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setResult(details);
        if (active(details.paper) || details.pageReviews?.some(active)) timer = setTimeout(load, 1500);
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure.status === 401) onExpired();
        else setError(failure.message);
      }
    }
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, path, reload, onExpired]);

  async function act(suffix, data = {}) {
    setBusy(true); setError(''); setRecoveryNotice('');
    try {
      const response = await api(path + suffix, { data, csrf });
      if (suffix === '/publish-saved-recognition') setRecoveryNotice(response.pending
        ? `已整理 ${response.published} 道题，另有 ${response.pending} 道题的保存结果不完整，暂未发布。原始结果已保留，请核对原卷并补充清晰材料。`
        : '已有识别结果已整理，可在下方背诵。');
      if (suffix === '/delete') onBack();
      else setReload(value => value + 1);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally { setBusy(false); }
  }

  const paper = result?.paper;
  const course = courses.find(item => item.id === paper?.courseId);
  const pending = result?.pageReviews?.filter(page => !page.reviewedAt) ?? [];
  const processing = active(paper) || pending.some(active);
  const pageOrder = paper?.pageOrder?.length ? paper.pageOrder : paper?.pages?.map((_, index) => index + 1) ?? [];
  const parentBlocked = active(paper) || terminalModelFailure(paper?.failure);
  const ready = Boolean(!parentBlocked && paper?.courseId && paper.status === 'review' && !paper.missingPages &&
    !pending.length && result?.questions?.length);
  const Container = embedded ? 'section' : 'main';
  return <Container className={embedded ? 'pc-study-paper' : 'content'}>
    {onBack && <button onClick={onBack}>{study ? '返回题目背诵' : '返回试卷库'}</button>}
    <div className="intro pc-review-title"><h1>{paper?.title?.replace(/\\[nr]/g, ' ') ?? '正在读取试卷…'}</h1>
      {paper && <p>{course?.name || paper.recognizedSubject || '科目待确认'}{course && ' · ' + course.term} · {processing ? '正在自动整理题目…' :
        !paper.courseId ? assignmentMessage(paper) : '已归属科目'}</p>}
    </div>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error} <button onClick={() => { setError(''); setReload(value => value + 1); }}>重新读取</button></p>}
    {result?.closedBook ? <p role="status">本卷正在闭卷练习。交卷后可查看原卷与答案。
      <button onClick={() => onPractice(paperId)}>继续整套答题</button></p> : <>
      {paper && !processing && !paper.courseId && <p role="status">题目和原卷已保留，不会猜测科目。
        <button disabled={busy} onClick={() => act('/retry-assignment')}>重新自动归属</button></p>}
      <PaperProcessingRecovery result={result} busy={busy} onRetry={() => act('/retry-recognition')} />
      <SavedImageRecovery result={result} busy={busy} onPublish={() => act('/publish-saved-recognition')} />
      {recoveryNotice && <p role="status">{recoveryNotice}</p>}
      <PendingPageRecovery pages={pending} blocked={parentBlocked} busy={busy} onRetry={page => act('/pages/' + page + '/recognition')} />
      <FigureReviews pages={parentBlocked ? [] : pending} path={path} busy={busy} canReread={paper?.modelAvailable} onAction={act} />
      {paper?.missingPages && <p role="status">原卷有缺页，请补齐后上传完整 PDF。已有题目仍可背诵。</p>}
      {result && <div className="pc-dialog-actions">
        <label>整套练习计时<select value={duration} onChange={event => setDuration(event.target.value)}><option value="">不限时</option>{[30,60,90,120].map(minutes => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}</select></label>
        <button className="primary" disabled={!ready || busy} onClick={() => onPractice(paperId, duration ? Number(duration) : undefined)}>开始整套答题</button>
        {!study && <button onClick={() => onBrowse(paperId)}>去题目背诵</button>}
      </div>}
      {study && <StudyQuestions result={result} paperId={paperId} api={api} csrf={csrf}
        onExpired={onExpired} onMistakes={onMistakes} />}
      {!study && paper && <section className="panel padded">
        <h2>原卷预览</h2>
        <p>题干、参考答案与知识点已集中到「题目背诵」。</p>
        <div className="chips">{pageOrder.map((page, index) => <button key={page}
          onClick={() => document.getElementById('source-page-' + page)?.scrollIntoView({ block: 'start' })}>第 {index + 1} 页</button>)}</div>
        {pageOrder.map((page, index) => <section key={page} id={'source-page-' + page}>
          <h3>原卷 · 第 {index + 1} 页</h3>
          <PaperPageImage src={'/api/v1' + path + '/pages/' + page} alt={'原卷第 ' + (index + 1) + ' 页'} />
        </section>)}
        {paper.status === 'review' && <details><summary>调整原卷页序与缺页状态</summary>
          <p>仅在原卷页序有误时调整，题目保留与原文件的对应关系。</p>
          {pageOrder.map((page, index) => <div className="pc-dialog-actions" key={page}>原文件第 {page} 页
            {[-1, 1].map(delta => <button key={delta} disabled={busy || index + delta < 0 || index + delta >= pageOrder.length}
              onClick={() => {
                const next = [...pageOrder];
                [next[index], next[index + delta]] = [next[index + delta], next[index]];
                act('/review-state', { revision: paper.reviewRevision, missingPages: paper.missingPages, pageOrder: next });
              }}>{delta < 0 ? '上移' : '下移'}</button>)}
          </div>)}
          <button disabled={busy} onClick={() => act('/review-state', { revision: paper.reviewRevision, missingPages: !paper.missingPages })}>
            {paper.missingPages ? '确认卷面齐全' : '标记试卷缺页'}</button>
        </details>}
      </section>}
    </>}
    {!study && paper?.sharedAtSchool && <button disabled={busy} onClick={() => act('/revoke-school-sharing')}>撤回校内共享授权</button>}
    {!study && result?.canDelete && <details><summary>删除试卷</summary><form onSubmit={event => { event.preventDefault(); act('/delete', { confirmed: true }); }}>
      <label className="pc-check"><input type="checkbox" required />确认删除原卷、相关作答和引用本卷的预测卷。</label>
      <button disabled={busy}>确认删除</button></form></details>}
  </Container>;
}

export function PaperProcessingRecovery({ result, busy, onRetry }) {
  const paper = result?.paper;
  if (!paper || result.closedBook) return null;
  const image = ['image/png', 'image/jpeg'].includes(paper.mediaType);
  const terminal = terminalModelFailure(paper.failure);
  if ((paper.mediaType === 'application/pdf' || image) && terminal && ['review', 'failed'].includes(paper.status)) {
    const canRetry = paper.canRetryModelProcessing === true && paper.modelAvailable === true && result.questions?.length === 0;
    return <p role="alert">原卷的自动处理已暂停。{pageFailure[paper.failure]}
      {canRetry ? <>请在服务恢复后点击重试；重新处理可能调用模型并计入使用额度，不会自动重试。
        <button disabled={busy} onClick={onRetry}>重试处理原卷</button></>
        : <>原卷与已有题目已保留。当前不满足重新处理条件，请联系服务方检查模型权限、原文件或已有题目状态。</>}
    </p>;
  }
  // Older private image uploads retained their readable original as review even
  // when OCR failed. They use the existing retry endpoint, not PDF page recovery.
  const legacyImageFailure = image && paper.status === 'review' &&
    ['OCR_FAILED', 'OCR_NOT_CONFIGURED'].includes(paper.failure) && result.questions?.length === 0;
  if (paper.status !== 'failed' && !legacyImageFailure) return null;
  const canRetry = paper.failure === 'PAPER_ORIGINAL_UNAVAILABLE' || (image && paper.modelAvailable !== false);
  return <p role="alert">
    {image ? '原卷图片尚未生成可背诵题目。' : '原卷处理失败，请检查 PDF 是否完整、清晰且未加密。'}
    {paper.failure === 'OCR_NOT_CONFIGURED' && '图片识别服务尚未配置，服务恢复后可重试。'}
    {image && paper.modelAvailable === false && '当前未开放或未授权模型处理，原卷已保留。'}
    {canRetry && <button disabled={busy} onClick={onRetry}>重试处理原卷</button>}
  </p>;
}

export function PendingPageRecovery({ pages, busy, onRetry, blocked = false }) {
  if (blocked) return null;
  return pages.filter(page => !page.figureReviewCandidates?.length && ['failed', 'review'].includes(page.status)).map(page =>
    <p role={page.status === 'failed' ? 'alert' : 'status'} key={page.page}>
      第 {page.page} 页：{page.status === 'review' ? '已有结果待整理，可继续处理后加入题目背诵。' : pageFailure[page.failure] ?? '题目整理失败。'}
      <button disabled={busy} onClick={() => onRetry(page.page)}>{page.status === 'review' ? '重新整理本页' : '重试本页'}</button>
    </p>);
}

export function SavedImageRecovery({ result, busy, onPublish }) {
  const paper = result?.paper;
  if (!paper || result.closedBook || paper.status !== 'review' ||
      !['image/png', 'image/jpeg'].includes(paper.mediaType)) return null;
  // The server uses the same normalization as publication and excludes existing
  // questions and human decisions. Counts therefore survive a page refresh.
  const { publishable = 0, pending = 0 } = result.savedImageRecovery ?? {};
  if (!publishable && !pending) return null;
  return <p role="status">
    {publishable > 0 && <>已有 {publishable} 道识别结果待整理。只使用保存结果，不重新调用模型，历史记录保持不变。
      <button disabled={busy} onClick={onPublish}>整理已有题目</button></>}
    {pending > 0 && <>另有 {pending} 道题的保存结果不完整，原始结果已保留，请核对原卷并补充清晰材料。</>}
  </p>;
}

export function orderedStudyQuestions(questions, pageOrder) {
  if (!pageOrder?.length) return questions;
  const positions = new Map(pageOrder.map((page, index) => [page, index]));
  // pageNumber is the original-file anchor, including cross-page questions.
  // Reorder the view, never the stored question or its source-page references.
  return [...questions].sort((left, right) =>
    (positions.get(left.pageNumber) ?? pageOrder.length + left.pageNumber) -
    (positions.get(right.pageNumber) ?? pageOrder.length + right.pageNumber));
}

export function StudyQuestions({ result, paperId, api, csrf, onExpired, onMistakes }) {
  if (!result) return <p role="status">正在读取题目…</p>;
  if (result.closedBook) return <p role="status">闭卷练习中，题目与答案预览已隐藏。</p>;
  if (!result.questions?.length) return <p role="status">暂无可背诵题目。已上传的原卷会保留，处理成功后题目自动出现在这里。</p>;
  return <section className="panel padded" aria-label="本卷题目">
    <h2>本卷题目 · {result.questions.length} 题</h2>
    <p>先回忆，再逐题查看答案和知识点。</p>
    <RecallSequence key={paperId} questions={orderedStudyQuestions(result.questions, result.paper.pageOrder).map(question => ({
      ...question, paperId, paperTitle: result.paper.title
    }))} api={api} csrf={csrf} onExpired={onExpired} onMistakes={onMistakes} />
  </section>;
}

function FigureReading({ label, reading }) {
  return <div><strong>{label}</strong>
    {reading ? <>
      {reading.nodes?.length > 0 && <p>节点 {reading.nodes.join('、')}</p>}
      {reading.edges?.length > 0 && <ul>{reading.edges.map(({ from, to, label: edgeLabel }, index) =>
        <li key={index}>{from}{reading.kind === 'undirected' ? ' — ' : ' → '}{to}{edgeLabel && '（' + edgeLabel + '）'}</li>)}</ul>}
      {reading.description && <PaperText text={reading.description} />}
    </> : <p>无可靠读数。</p>}
  </div>;
}

function FigureCropReview({ figure, path, busy, canReread, onReread }) {
  const source = '/api/v1' + path;
  const box = Array.isArray(figure.box) ? figure.box : null;
  return <section>
    {box && <a href={source} target="_blank" rel="noreferrer">
      <PaperPageImage key={box.join(',')} src={source} alt="图表裁片，可打开原尺寸查看" />
    </a>}
    <div className="pc-review-grid">
      <FigureReading label="整页识别" reading={figure.initial} />
      <FigureReading label="裁片重读" reading={figure.reread} />
    </div>
    {canReread && !figure.manualReread && <details><summary>调整裁片并重读</summary>
      <form className="pc-fields" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onReread(['left', 'top', 'right', 'bottom'].map(name => Number(data.get(name))));
      }}>
        <p>按原页从左上到右下定位，边界取 0 到 1000。</p>
        <div className="pc-dialog-actions">{[['left', '左'], ['top', '上'], ['right', '右'], ['bottom', '下']]
          .map(([name, label], index) => <label key={name}>{label} <input type="number" name={name}
            min={0} max={1000} required defaultValue={box?.[index]} /></label>)}</div>
        <button disabled={busy}>重读裁片</button>
      </form>
    </details>}
  </section>;
}

export function FigureReviews({ pages, path, busy, canReread, onAction }) {
  const candidates = pages.flatMap(page => (page.figureReviewCandidates ?? []).map(candidate => ({ page, candidate })));
  if (!candidates.length) return null;
  return <section className="panel padded" aria-label="图表待核对">
    <h2>图表待核对</h2>
    {candidates.map(({ page, candidate }) => {
      const index = candidate % 100;
      const stem = page.recognition?.stems?.[index];
      const figures = page.recognition?.figures?.[index];
      return <details className="pc-recognition-item" key={candidate}>
        <summary>原文件第 {page.page} 页 · 第 {index + 1} 条识别题目</summary>
        <a href={'/api/v1' + path + '/pages/' + page.page} target="_blank" rel="noreferrer">查看原页</a>
        {Array.isArray(figures) && figures.map((figure, number) => {
          const suffix = '/recognition/' + candidate + '/figures/' + number;
          return figure && <FigureCropReview key={number} figure={figure} path={path + suffix}
            canReread={canReread} busy={busy} onReread={box => onAction(suffix + '/reread', { box })} />;
        })}
        <form className="pc-fields" onSubmit={event => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onAction('/recognition-review', { candidateIndex: candidate, stem: data.get('stem'), visualReview: data.get('visualReview') });
        }}>
          <label>题干<textarea name="stem" maxLength={8000} required defaultValue={stem} /></label>
          <label>核对后的图表内容<textarea name="visualReview" maxLength={8000} required /></label>
          <button disabled={busy}>保存核对结果</button>
        </form>
        <details><summary>这条识别结果不是题目</summary>
          <button type="button" disabled={busy} onClick={() => onAction('/recognition-review', { candidateIndex: candidate, stem: null })}>
            确认移除这条识别结果
          </button>
        </details>
      </details>;
    })}
  </section>;
}

function PaperPageImage({ src, alt }) {
  const [unavailable, setUnavailable] = useState(false);
  return unavailable ? <p role="alert">原页暂时无法加载。<button onClick={() => setUnavailable(false)}>重试原页</button></p>
    : <img loading="lazy" className="pc-paper-preview" src={src} alt={alt} onError={() => setUnavailable(true)} />;
}

