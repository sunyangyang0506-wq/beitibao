import { QuestionRecall } from './QuestionRecall.jsx';
import { questionKinds } from './QuestionRecall.jsx';
import React, { useEffect, useState } from 'react';
import { libraryStatusLabels } from './paper-library-status.js';
import { PdfUpload, PdfScanGuide } from './PdfUpload.jsx';
import { PaperText } from './PaperText.jsx';

const status = { queued: '排队中', processing: '正在识别', review: '可核对', failed: '识别失败' };
const pageFailure = {
  MODEL_BUDGET_LIMIT: '今天的模型识别额度已用完。',
  MODEL_RATE_LIMIT: '模型请求过多，请稍后重试。',
  OCR_NOT_CONFIGURED: '图片识别服务尚未配置。',
  OCR_ACCESS_DENIED: '识别服务拒绝了本次请求。服务恢复后可重试本页。',
  OCR_INCOMPLETE_OPTIONS: '本页有选择题缺少选项。重试本页可重新读取原卷。',
  OCR_TIMEOUT: '本页识别超时，请重试。'
};
const reuseMessage = { exact: '已复用同校同科试卷识别', pages: '已复用同校同科的相同内容' };
const active = paper => paper.status === 'queued' || paper.status === 'processing';

async function uploadPrivatePaper(api, path, file, mediaType, data, csrf, title) {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const upload = await api(path + '/paper-uploads', { csrf, data: {
    title, autoTitle: true, mediaType, bytes: file.size, sha256,
    rightsConfirmed: data.has('rightsConfirmed'), allowModels: data.has('allowModels'), redacted: data.has('redacted'), shareAtSchool: data.has('shareAtSchool')
  } });
  const form = new FormData();
  for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
  form.append('file', new Blob([file], { type: mediaType }), 'exam');
  const response = await fetch(upload.url, { method: 'POST', body: form, credentials: 'omit', redirect: 'error' });
  const versionId = response.headers.get('x-oss-version-id');
  if (!response.ok || !versionId) throw new Error('原卷上传失败，请重试。');
  return api('/paper-uploads/' + upload.uploadId + '/complete', { data: { versionId }, csrf });
}

export function PaperLibrary({ api, csrf, courses, courseId, onCourse, onExpired, onPractice, onMistakes, onPrediction, guided = false }) {
  const [papers, setPapers] = useState([]);
  const [paperId, setPaperId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [uploadMode, setUploadMode] = useState('');
  const [maxUploadMb, setMaxUploadMb] = useState(10);
  const [schoolSharing, setSchoolSharing] = useState(false);
  const [modelUploads, setModelUploads] = useState(false);
  const [modelConsent, setModelConsent] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploadProgress, setUploadProgress] = useState('');
  const [retryPdfBatch, setRetryPdfBatch] = useState(false);
  const pdfBatch = retryPdfBatch || selectedFiles.length > 1;
  const courseBase = '/courses/' + courseId;
  const coursePath = courseBase + '/papers';

  useEffect(() => {
    if (paperId) return;
    const controller = new AbortController();
    let timer;
    async function load() {
      try {
        const result = await api(coursePath, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPapers(result.papers);
        setUploadMode(result.uploadMode ?? 'local');
        setMaxUploadMb(result.maxUploadMb ?? 10);
        setModelUploads(Boolean(result.modelUploads));
        setSchoolSharing(Boolean(result.schoolSharingAvailable));
        if (result.papers.some(paper => paper.libraryStatus === 'recognizing' || active(paper))) timer = setTimeout(load, 1800);
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure.status === 401) onExpired();
        else setError(failure.message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, coursePath, paperId, reload, onExpired]);

  async function upload(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      async function send(file, index = 0) {
        const title = [...(file?.name ?? '').replace(/\.pdf$/i, '').trim()].slice(0, 200).join('') || '试卷 ' + (index + 1);
        const mediaType = 'application/pdf';
        const maxMb = uploadMode === 'private' ? 50 : maxUploadMb;
        if (!file?.size || file.size > maxMb * 1024 * 1024) {
          throw new Error('请选择不超过 ' + maxMb + ' MB 的 PDF。');
        }
        return uploadMode === 'private' ? uploadPrivatePaper(api, '/courses/auto', file, mediaType, data, csrf, title)
          : api('/courses/auto/papers?' + new URLSearchParams({ title,
            recognizeScans: String(modelUploads), autoTitle: 'true', shareAtSchool: String(data.has('shareAtSchool')),
            redacted: String(data.has('shareAtSchool')) }), { file, mediaType, csrf });
      }
      if (pdfBatch) {
        const started = performance.now();
        const failed = [];
        let completed = 0;
        let attempted = 0;
        let nextIndex = 0;
        let expired = false;
        const total = selectedFiles.length;
        setUploadProgress('已处理 0 / ' + total + ' 份 PDF…');
        async function uploadNext() {
          while (!expired && nextIndex < total) {
            const index = nextIndex++;
            const item = selectedFiles[index];
            try {
              await send(item.file, index);
              completed++;
            } catch (failure) {
              if (failure.status === 401) expired = true;
              failed.push({ index, item, message: item.file.name + '：' + failure.message });
            } finally {
              setUploadProgress('已处理 ' + (++attempted) + ' / ' + total + ' 份 PDF…');
            }
          }
        }
        await Promise.all([uploadNext(), uploadNext()]);
        if (expired) { onExpired(); return; }
        failed.sort((a, b) => a.index - b.index);
        const seconds = Math.ceil((performance.now() - started) / 1000);
        setRetryPdfBatch(failed.length > 0);
        setSelectedFiles(failed.map(({ item }) => item));
        if (completed) {
          onCourse('auto');
          setNotice(completed + ' / ' + total + ' 份 PDF 已上传并进入处理队列，用时 ' + seconds + ' 秒。识别进度可在左侧查看。');
        }
        if (failed.length) setError(failed.map(({ message }) => message).join('；'));
        else {
          form.reset();
          setModelConsent(false);
        }
        setReload(value => value + 1);
        return;
      }
      const result = await send(selectedFiles[0]?.file);
      form.reset();
      setSelectedFiles([]);
      setModelConsent(false);
      setNotice(result.reused ? '已打开这份已归档的试卷。' : result.modelReused ? '已找到你之前处理的同校同科原卷，正在复用。' : '试卷已上传。');
      setPaperId(result.paper.id);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setUploadProgress('');
      setBusy(false);
    }
  }

  if (paperId) return <PaperReview key={paperId} api={api} csrf={csrf} paperId={paperId}
    onExpired={onExpired} onPractice={onPractice} onMistakes={onMistakes} onPrediction={onPrediction} courses={courses}
    modelUploads={modelUploads} onBack={() => { setLoading(true); setPaperId(null); }} notice={notice} />;

  return <main className="content">
    <div className="intro"><div className="eyebrow">试卷归档</div><h1>试卷库</h1><p>上传 PDF 后可预览原卷，并查看识别和练习状态。</p></div>
    <div className="split pc-paper-layout">
      <section className="panel padded">
        <h2>原卷列表</h2>
        <label className="pc-course-select">选择科目<select value={courseId} disabled={busy} onChange={event => onCourse(event.target.value)}>
          <option value="auto">全部试卷</option>
          {courses.map(course => <option key={course.id} value={course.id}>{course.name} · {course.term}</option>)}
        </select></label>
        {loading && <p role="status">正在读取试卷…</p>}
        {!loading && !papers.length && <p>此科目还没有试卷。</p>}
        {papers.map(paper => {
          const state = paper.libraryStatus;
          const next = {
            recognizing: '等待系统识别科目、卷名和题干，可打开查看进度。',
            unassigned: '请打开试卷，选择归属课程。',
            needs_review: paper.hasQuestions ? '核对题干和页码，确认所有待核对页。' : '打开原卷核对题干，确认后即可练习。',
            no_questions: '打开原卷，查看识别状态或手动补录题目。',
            missing_pages: '补齐缺页后上传完整 PDF。',
            failed: paper.status === 'failed' ? '查看失败原因，检查 PDF 后重新上传。' : '打开试卷，重试失败页或先练已识别题。',
            ready: '查看试卷或开始整套练习。'
          }[state];
          return <div className="pc-paper-row" key={paper.id}>
            <div className="pc-paper-row-copy">
              <strong>{paper.title}</strong>
              {paper.schoolReuse && <span className="badge green">{reuseMessage[paper.schoolReuse]}</span>}
              <small>{paper.recognizedSubject && '识别科目 ' + paper.recognizedSubject + ' · '}{courses.find(course => course.id === paper.courseId)?.name && '已归档 · '}{next}</small>
            </div>
            <div className="pc-paper-row-actions">
              <span className={'badge ' + (state === 'ready' ? 'green' : state === 'recognizing' ? 'blue' : 'amber')}>{libraryStatusLabels[state]}</span>
              <button type="button" className="link" aria-label={'查看试卷 ' + paper.title} onClick={() => { setNotice(''); setPaperId(paper.id); }}>查看试卷</button>
              {state === 'ready' && <button type="button" aria-label={'开始练习 ' + paper.title} onClick={() => onPractice(paper.id)}>开始练习</button>}
            </div>
          </div>;
        })}
      </section>
      <section className="panel padded">
        <h2>上传试卷</h2>
        <p>仅支持 PDF。一次可选最多 30 份，每份独立归档。每套最多 30 页、{uploadMode === 'private' ? 50 : maxUploadMb} MB。</p>
        {guided && <p className="pc-status">首次上传可以先查看扫描步骤。已有 PDF 时，直接选择文件即可。</p>}
        <PdfScanGuide open={guided} />
        <form className="pc-fields" onSubmit={upload}>

          <PdfUpload keepValid maxBytes={(uploadMode === 'private' ? 50 : maxUploadMb) * 1024 * 1024} key="pdf-only" files={selectedFiles} setFiles={files => { setRetryPdfBatch(false); setSelectedFiles(files); }} disabled={busy} />
          {modelUploads ? <p>授权后自动识别科目和卷名，唯一匹配时归档，并生成原卷答案。</p>
            : uploadMode && <p role="status">自动识别暂未开放。上传后可预览原卷并补录题目。</p>}
          {uploadMode === 'private' ? <>
            <p>请先移除姓名、学号等个人信息。</p>
            <label className="pc-check"><input name="rightsConfirmed" type="checkbox" required />我有权上传和使用这份试卷。</label>
            {modelUploads && <>
              <label className="pc-check"><input name="allowModels" type="checkbox" checked={modelConsent}
                onChange={event => setModelConsent(event.target.checked)} />允许百炼识别题干、知识点和参考答案。</label>
              {modelConsent && <label className="pc-check"><input name="redacted" type="checkbox" required />已移除试卷上的个人信息。</label>}
            </>}
          </> : modelUploads ? <>
            <label className="pc-check"><input type="checkbox" required
              onInvalid={() => setError('请先勾选试卷使用和百炼处理授权，再上传。')}
              onChange={() => setError('')} />我有权使用这份试卷，并授权百炼处理试卷内容。</label>
          </> : null}
          {schoolSharing && modelUploads && (uploadMode !== 'private' || modelConsent) &&
            <label className="pc-check"><input name="shareAtSchool" type="checkbox" />
              我已移除个人信息，并授权已核验的同校学员复用本卷、解析及据此生成的预测卷。
            </label>}
          {notice && <p role="status">{notice}</p>}
          {uploadProgress && <p role="status">{uploadProgress}</p>}
          {error && <div role="alert">{error} <button type="button" onClick={() => { setError(''); setReload(value => value + 1); }}>刷新列表</button></div>}
          <button className="primary" disabled={busy || loading || !selectedFiles.length}>{busy ? '正在上传…' :
            !modelUploads || (uploadMode === 'private' && !modelConsent) ? '上传试卷' : '上传并识别整卷'}</button>
        </form>
      </section>
    </div>
  </main>;
}

function PaperReview({ api, csrf, paperId, onExpired, onBack, notice, onPractice, onMistakes, onPrediction, courses, modelUploads }) {
  const [recallConfirmed, setRecallConfirmed] = useState(false);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const path = '/papers/' + paperId;
  const [assignment, setAssignment] = useState('');

  async function assign(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(path + '/assignment', { data: { courseId: assignment }, csrf });
      setReload(value => value + 1);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function addQuestion(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setBusy(true);
    setError('');
    try {
      await api(path + '/questions', { data: { pageNumber: Number(fields.get('pageNumber')), stem: fields.get('stem') }, csrf });
      form.elements.namedItem('stem').value = '';
      setReload(value => value + 1);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function load() {
      try {
        const details = await api(path + '?includeAnalysis=true', { signal: controller.signal });
        if (controller.signal.aborted) return;
        setResult(details);
        setError('');
        if (active(details.paper) || details.pageReviews?.some(active) ||
          details.questions?.some(question => active({ status: question.solutionStatus }))) timer = setTimeout(load, 1500);
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure.status === 401) onExpired();
        else setError(failure.message);
      }
    }
    load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, path, reload, onExpired]);

  async function requestSolution(questionId) {
    setBusy(true);
    setError('');
    try {
      await api(path + '/questions/' + questionId + '/solution', { data: {}, csrf });
      setReload(value => value + 1);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function retryRecognition() {
    setBusy(true);
    setError('');
    try {
      await api(path + '/retry-recognition', { data: {}, csrf });
      setReload(value => value + 1);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function revokeSchoolSharing() {
    setBusy(true);
    setError('');
    try {
      await api(path + '/revoke-school-sharing', { data: {}, csrf });
      setReload(value => value + 1);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function deletePaper(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(path + '/delete', { data: { confirmed: true }, csrf });
      onBack();
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function changePageReview(page, action) {
    setBusy(true);
    setError('');
    try {
      await api(path + '/pages/' + page + '/' + action, { data: {}, csrf });
      setReload(value => value + 1);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function savePaperReview(missingPages, nextOrder) {
    setBusy(true);
    setError('');
    try {
      const { paper: updated } = await api(path + '/review-state', {
        data: { revision: paper.reviewRevision, missingPages, ...(nextOrder && { pageOrder: nextOrder }) }, csrf
      });
      setResult(current => ({ ...current, paper: { ...current.paper, ...updated } }));
      setReload(value => value + 1);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  const paper = result?.paper;
  const automatic = paper?.autoReview === true;
  const image = paper?.mediaType?.startsWith('image/');
  const pageOrder = paper?.pageOrder?.length ? paper.pageOrder : paper?.pages.map((_, index) => index + 1) ?? [];
  const reviews = new Map(result?.reviews?.map(review => [review.candidateIndex, review]));
  const pendingPages = (result?.pageReviews?.filter(item => !item.reviewedAt) ?? [])
    .sort((a, b) => pageOrder.indexOf(a.page) - pageOrder.indexOf(b.page));
  const settledPdf = paper?.status === 'review' && !image && !result.closedBook && !pendingPages.length;
  const noQuestions = settledPdf && result.questions.length === 0;
  const displayStatus = paper?.missingPages ? '缺页待处理' : result?.closedBook ? '练习中' :
    settledPdf ? libraryStatusLabels[!paper.courseId ? 'unassigned' : noQuestions ? 'no_questions' : 'ready'] :
    automatic && paper.status === 'review' && pendingPages.length ?
      (pendingPages.some(active) ? '识别中' : '识别失败') : status[paper?.status];
  const archivedCourse = courses.find(course => course.id === paper?.courseId);
  const solutionsReady = result?.questions.filter(question => question.reference || question.modelSolution?.status === 'solved').length ?? 0;
  const solutionsPending = result?.questions.filter(question => active({ status: question.solutionStatus })).length ?? 0;
  const printedPages = new Map(image ? [[1, paper.recognition?.printedPage]] :
    result?.pageReviews?.map(item => [item.page, item.recognition?.printedPage]));
  const printedSequence = pageOrder.map(number => printedPages.get(number));
  const completePageRead = result?.pageReviews?.length === pageOrder.length &&
    result.pageReviews.every(item => ['review', 'failed'].includes(item.status));
  const needsPageOrderReview = pageOrder.length > 1 && completePageRead && printedSequence.some((number, index) =>
    !number || (index > 0 && number !== printedSequence[index - 1] + 1));
  function movePage(pagePosition, delta) {
    const next = [...pageOrder];
    [next[pagePosition], next[pagePosition + delta]] = [next[pagePosition + delta], next[pagePosition]];
    return savePaperReview(paper.missingPages, next);
  }

  return <main className="content">
    <button onClick={onBack}>返回试卷库</button>
    <div className="intro pc-review-title"><div className="eyebrow">{automatic ? '原卷识别' : '原卷核对'}</div><h1>{paper?.title?.replace(/\\[nr]/g, ' ') ?? '正在打开试卷'}</h1>
      {paper && <p>状态 <strong>{displayStatus}</strong></p>}
    </div>
    {notice && <p className="pc-status" role="status">{notice}</p>}
    {error && <div className="pc-status" role="alert">{error} <button onClick={() => { setError(''); setReload(value => value + 1); }}>重新读取</button></div>}
    {paper?.schoolReuse && <p className="pc-status" role="status">
      {paper.schoolReuse === 'exact' && solutionsReady > 0 && solutionsReady === result.questions.length
        ? '已复用同校同科试卷解析' : reuseMessage[paper.schoolReuse]}
    </p>}
    {paper?.sharedAtSchool && <button type="button" disabled={busy} onClick={revokeSchoolSharing}>撤回校内共享授权</button>}
    {result?.canDelete && <details><summary>删除试卷</summary>
      <form className="pc-fields" onSubmit={deletePaper}>
        <label className="pc-check"><input type="checkbox" required />确认删除原卷、相关作答和引用本卷的预测卷。</label>
        <button type="submit" disabled={busy}>确认删除</button>
      </form>
    </details>}
    {paper?.status === 'failed' && (paper.failure === 'PAPER_ORIGINAL_UNAVAILABLE' ? <div role="alert">
      <p>原卷暂时无法读取。</p><button disabled={busy} onClick={retryRecognition}>重试读取原卷</button>
    </div> : image ? <div role="alert">
      <p>{paper.failure === 'OCR_NOT_CONFIGURED' ? '图片识别服务尚未配置。配置后可重试。' : '图片识别失败，可以重试。'}</p>
      {paper.modelAvailable !== false && <button disabled={busy} onClick={retryRecognition}>重试识别</button>}
    </div> : <p role="alert">提取失败。请检查 PDF 能否正常打开、未加密且不超过 30 页。</p>)}
    {paper && <section className="panel padded">
      <h2>科目与卷名</h2>
      <p>识别科目 {paper.recognizedSubject || (active(paper) || pendingPages.some(active) ? '识别中' : '待确认')} · 卷名 {paper.title}</p>
      {paper.courseId ? <><p>归档课程 {archivedCourse ? archivedCourse.name + ' · ' + archivedCourse.term : '已归档'}</p>
        <button type="button" className="link" onClick={() => onPrediction(paper.courseId)}>查看整套预测卷</button></>
        : !active(paper) && !pendingPages.some(active) && <form className="pc-fields" onSubmit={assign}>
          <p>{automatic && '未能唯一匹配已有课程。'}请选择归档课程。如需新课程，请先在学习进展添加。</p>
          <label>归档课程<select required value={assignment} onChange={event => setAssignment(event.target.value)}>
            <option value="">请选择课程</option>
            {courses.map(course => <option key={course.id} value={course.id}>{course.name} · {course.term}</option>)}
          </select></label>
          <button type="submit" className="primary" disabled={busy || !assignment}>确认归档</button>
        </form>}
    </section>}
    {result?.closedBook && <p role="status">本卷正在闭卷练习。交卷后可查看原卷与核对记录。</p>}
    {paper?.status === 'review' && !result.closedBook && <section className="panel padded">
      <h2>试卷整理进度</h2>
      {paper.modelAvailable && result.questions.length > 0 && <p role="status">
        原卷答案已就绪 {solutionsReady} / {result.questions.length} 题{solutionsPending > 0 && ` · ${solutionsPending} 题生成中`}
      </p>}
      <p role="status">{result.questions.length} 道可练题 · {pendingPages.length} 页{automatic ? '待处理' : '待核对'}{paper.missingPages ? ' · 仍有缺页' : ''}</p>
      {noQuestions && <p>{!modelUploads ? '自动识别暂未开放，原卷已保留。' : paper.modelAvailable ?
        '本卷未找到可练题。可核对原卷或上传更清晰的 PDF。' : '本卷未授权自动识别，原卷已保留。'}
        {paper.courseId ? '可对照下方原卷手动补录。' : '选择归档课程后可手动补录。'}</p>}
      {!recallConfirmed && !image && paper.courseId && pageOrder.length > 0 && !pendingPages.some(active) && <details>
        <summary>手动补录题目</summary>
        <form className="pc-fields" onSubmit={addQuestion}>
          <label>来源页<select name="pageNumber" required>
            {pageOrder.map((number, index) => <option key={number} value={number}>第 {index + 1} 页</option>)}
          </select></label>
          <label>题干与选项<textarea name="stem" required maxLength={8000} /></label>
          <button type="submit" disabled={busy}>保存题目</button>
        </form>
      </details>}
      {!recallConfirmed && paper.courseId && result.questions.length > 0 && <button className="primary" type="button"
        onClick={() => setRecallConfirmed(true)}>{automatic ? '先练已识别题' : '先练已确认题'}</button>}
      {!recallConfirmed && pendingPages.length > 0 && <button type="button" disabled={busy} onClick={() => {
        const next = pendingPages.find(item => item.status === 'failed') ?? pendingPages[0];
        document.getElementById('recognized-page-' + next.page)?.scrollIntoView({ block: 'start' });
      }}>{pendingPages.some(item => item.status === 'failed') ? '查看失败页' : '核对下一待处理页'}</button>}
    </section>}
    {recallConfirmed && !result?.closedBook && <QuestionRecall papers={[{ id: paperId, title: paper?.title }]}
      api={api} csrf={csrf} onExpired={onExpired} onMistakes={onMistakes} onBack={() => setRecallConfirmed(false)} />}
    {paper?.status === 'review' && !result.closedBook && !recallConfirmed &&
      <section className="pc-full-recognition" aria-label="整套试卷预览" id="paper-review-workspace">
        <div className="panel padded pc-full-recognition-head">
          <h2>整套试卷预览</h2>
          <p>共 {pageOrder.length} 页。每页左侧展示原卷，右侧展示试题识别预览。</p>
          {paper.missingPages && <p role="status">试卷标记为缺页。已确认的题目可按题型练习，核对卷面后可整套开练。</p>}
          {!automatic && pendingPages.length > 0 && <p role="status">第 {pendingPages.map(item => item.page).join('、')} 页待核对。确认后可整套开练。</p>}
          {result.questions.length > 0 && <button className="primary" type="button" disabled={!paper.courseId || paper.missingPages || pendingPages.length > 0}
            onClick={() => onPractice(paperId)}>整套背诵本卷</button>}
          <div className="chips" aria-label="跳转页码">{pageOrder.map((number, index) =>
            <button type="button" key={number} onClick={() => document.getElementById('recognized-page-' + number)?.scrollIntoView({ block: 'start' })}>第 {index + 1} 页</button>)}</div>
        </div>
        {pageOrder.map((page, pagePosition) => {
          const text = paper.pages[page - 1] ?? '';
          const pageReview = result.pageReviews?.find(item => item.page === page);
          const recognition = image ? paper.recognition : pageReview?.recognition;
          const offset = (page - 1) * 100;
          const allCandidatesReviewed = (recognition?.stems ?? []).every((_, index) => reviews.has(offset + index));
          const displayedQuestions = result.questions.filter(question => question.pageNumber === page);
          const recognitionBoxes = new Map((recognition?.stems ?? []).map((stem, index) => [stem, recognition.questionBoxes?.[index]]));
          const src = '/api/v1' + path + '/pages/' + page;
          return <div className="pc-review-grid pc-aligned-paper pc-full-page" id={'recognized-page-' + page} key={page}>
            <section className="panel padded">
              <div className="pc-paper-preview-header">
              <h2>原卷预览 · 第 {pagePosition + 1} 页</h2>
              {page !== pagePosition + 1 && <p>原文件第 {page} 页</p>}
              {printedPages.get(page) && <p>印刷第 {printedPages.get(page)} 页</p>}
              {!image && <div className="pc-page-actions">
                {pageOrder.length > 1 && <>
                  <span>卷面顺序 {pagePosition + 1}/{pageOrder.length}</span>
                  {needsPageOrderReview && <p role="status">部分印刷页码无法确认，保留当前页序。</p>}
                  <button type="button" disabled={busy || pagePosition < 1} onClick={() => movePage(pagePosition, -1)}>上移此页</button>
                  <button type="button" disabled={busy || pagePosition >= pageOrder.length - 1} onClick={() => movePage(pagePosition, 1)}>下移此页</button>
                </>}
                <button type="button" disabled={busy} onClick={() => savePaperReview(!paper.missingPages)}>
                  {paper.missingPages ? '确认卷面齐全' : '标记试卷缺页'}
                </button>
              </div>}
              </div>
              <PaperPageImage key={src} src={src} alt={'试卷原图第 ' + page + ' 页'} />
            </section>
            <section className="panel padded">
              <div className="pc-paper-preview-header">
                <h2>试题识别预览 · 第 {pagePosition + 1} 页</h2>
                <p>已定位的试题可通过题目框查看。</p>
                {automatic && <>
                {pageReview && <p role="status">本页{pageReview.reviewedAt ? '已完成识别' : status[pageReview.status]}</p>}
                {pageReview?.status === 'failed' && <p role="alert">
                  {pageFailure[pageReview.failure] ?? '本页识别失败。'}
                  <button type="button" disabled={busy} onClick={() => changePageReview(page, 'recognition')}>重试本页</button>
                </p>}
                </>}
              </div>
              <RecognizedPage src={src} page={page} questions={displayedQuestions} boxes={recognitionBoxes} />
              <div>
              {!automatic && <>
              {!image && <>
                <details><summary>第 {page} 页提取文本（可复制）</summary>
                  <pre className="pc-extracted">{text || '本页没有可提取的文本。'}</pre>
                </details>
                {pageReview && <p role="status">本页{pageReview.reviewedAt ? '已核对' : status[pageReview.status]}</p>}
                {pageReview?.status === 'failed' && !pageReview.reviewedAt && <p role="alert">
                  {pageFailure[pageReview.failure] ?? '本页识别失败。'}
                  {paper.modelAvailable !== false && <button type="button" disabled={busy} onClick={() => changePageReview(page, 'recognition')}>重试本页</button>}
                </p>}
              </>}
              {(image || recognition) && <>
                <p>对照第 {page} 页原图，逐条确认、修改或标记误识别。</p>
                {!recognition?.stems.length && <p>本页暂无识别结果。</p>}
                {image && paper.failure && paper.modelAvailable && !result.questions.length &&
                  <button type="button" disabled={busy} onClick={retryRecognition}>重试识别</button>}
                {recognition?.stems.map((original, index) => <RecognitionCandidate key={offset + index}
                  original={original} index={offset + index} page={page} review={reviews.get(offset + index)} api={api} path={path} csrf={csrf}
                  figures={recognition.figures?.[index]} initialContext={recognition.visualContexts?.[index]}
                  onExpired={onExpired} onSaved={() => setReload(value => value + 1)} />)}
              </>}
              {pageReview && !pageReview.reviewedAt && (paper.modelAvailable === false || ['review', 'failed'].includes(pageReview.status)) &&
                <button type="button" disabled={busy || !allCandidatesReviewed} onClick={() => changePageReview(page, 'confirm')}>
                  确认本页已核对
                </button>}
              </>}
              <div>
              <h2 className="pc-confirmed-title">{automatic ? '本页题干与解析' : '已确认题目'}（{displayedQuestions.length}）</h2>
              {!displayedQuestions.length && <p>本页暂无可练习题目。</p>}
              <ol className={automatic ? 'pc-page-transcript' : undefined}>{displayedQuestions.map(question => <li key={question.id} id={'recognized-' + question.id} tabIndex={-1}>
                <small className="pc-page-links">{(question.sourcePages ?? [question.pageNumber]).map(number =>
                  <a key={number} href={'/api/v1' + path + '/pages/' + number} target="_blank" rel="noreferrer">原卷第 {number} 页</a>)}
                  {result.reviews?.some(review => review.questionId === question.id && (image ? paper.recognition : result.pageReviews?.find(item => item.page === question.pageNumber)?.recognition)
                    ?.figures?.[review.candidateIndex % 100]?.length > 0)
                    && <button type="button" disabled={busy} onClick={() => {
                      requestAnimationFrame(() => document.getElementById('recognition-' +
                        result.reviews.find(review => review.questionId === question.id).candidateIndex)?.scrollIntoView());
                    }}>图表核对记录</button>}
                </small><PaperText text={question.stem} />
                {!automatic && <label>题型<select value={question.kind} onChange={async event => {
                  const kind = event.target.value;
                  try {
                    await api(path + '/questions/' + question.id + '/kind', { data: { kind }, csrf });
                    setReload(value => value + 1);
                  } catch (failure) {
                    if (failure.status === 401) onExpired();
                    else setError(failure.message);
                  }
                }}>{Object.entries(questionKinds).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>}
                <PaperSolution question={question} />
                {paper.modelAvailable && (!question.solutionStatus || question.solutionStatus === 'failed') &&
                  <button type="button" disabled={busy} onClick={() => requestSolution(question.id)}>
                    {question.solutionStatus === 'failed' ? '重试模型识别' : '识别知识点和参考答案'}
                  </button>}
                {!automatic && <EquivalenceReview api={api} csrf={csrf} onExpired={onExpired} path={path + '/questions/' + question.id + '/equivalences'} />}
              </li>)}</ol>
              </div>
              </div>
            </section>
          </div>;
        })}
      </section>}
  </main>;
}

function PaperPageImage({ src, alt }) {
  const [retry, setRetry] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!unavailable || retry >= 3) return;
    const timer = setTimeout(() => {
      setRetry(value => value + 1);
      setUnavailable(false);
    }, 450 * (retry + 1));
    return () => clearTimeout(timer);
  }, [retry, unavailable]);
  if (unavailable && retry >= 3) return <p role="alert">原页暂时无法加载。</p>;
  return <img loading="lazy" className="pc-paper-preview" src={src + (retry ? '?previewRetry=' + retry : '')}
    alt={alt} onError={() => setUnavailable(true)} />;
}

function RecognizedPage({ src, page, questions, boxes }) {
  return <div className="pc-recognized-page">
    <PaperPageImage key={src} src={src} alt={'试卷识别第 ' + page + ' 页，保留原卷版式'} />
    {questions.map((question, index) => {
      const box = boxes.get(question.stem);
      if (!box) return null;
      const [left, top, right, bottom] = box;
      const modelAnswer = question.modelSolution?.answer?.trim().normalize('NFKC');
      const choiceAnswer = /^[A-D]$/i.test(modelAnswer ?? '') ? modelAnswer.toUpperCase() : null;
      return <button key={question.id} className="pc-question-box" type="button"
        aria-label={'查看识别题目 ' + (question.stem.match(/^\d+/)?.[0] ?? index + 1) + (choiceAnswer ? '，模型参考答案 ' + choiceAnswer : '')}
        style={{ left: left / 10 + '%', top: top / 10 + '%', width: (right - left) / 10 + '%', height: (bottom - top) / 10 + '%' }}
        onClick={() => {
          const item = document.getElementById('recognized-' + question.id);
          const details = item?.querySelector('details');
          if (details) details.open = true;
          item?.scrollIntoView({ block: 'start' });
          item?.focus({ preventScroll: true });
        }}>{choiceAnswer && <span className="pc-question-answer-badge" title="模型参考答案">{choiceAnswer}</span>}</button>;
    })}
  </div>;
}

function PaperSolution({ question }) {
  return <>
  {question.reference && <div className="pc-model-answer">
    <strong>已核验参考答案</strong>
    <PaperText text={question.reference.answers.join('、')} />
    {question.reference.explanation && <details open>
      <summary>答案解析</summary>
      <PaperText text={question.reference.explanation} />
    </details>}
  </div>}
  {question.modelSolution && <>
    {question.modelSolution.answer
      ? <div className="pc-model-answer">
        <strong>模型参考答案</strong>
        <PaperText text={question.modelSolution.answer} />
      </div>
      : <p>模型无法确定答案。</p>}
    <details open>
      <summary>知识点与解析</summary>
      <p>知识点：{question.modelSolution.knowledgePoints?.join('、') || '模型未能确定'}</p>
      <PaperText text={question.modelSolution.explanation} />
    </details>
  </>}
  {active({ status: question.solutionStatus }) && <p role="status">正在识别知识点和参考答案…</p>}
  {question.solutionStatus === 'failed' && <p>{({
    MODEL_BUDGET_LIMIT: '本日模型额度已用完。',
    MODEL_RATE_LIMIT: '模型请求过多，请稍后重试。',
    SOLUTION_TIMEOUT: '解析超时，请稍后重试。',
    SOLUTION_OUTPUT_TRUNCATED: '模型输出不完整，请重试。'
  })[question.solutionFailure] ?? '模型处理失败。'}</p>}
  </>;
}

function EquivalenceReview({ api, csrf, onExpired, path }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>核对跨卷等价题</summary>
    {open && <EquivalenceLinks api={api} csrf={csrf} onExpired={onExpired} path={path} />}
  </details>;
}

function EquivalenceLinks({ api, csrf, onExpired, path }) {
  const [result, setResult] = useState(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api(path + '?' + new URLSearchParams({ query: filter }), { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setResult(value); setError(''); }
    }).catch(failure => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    });
    return () => controller.abort();
  }, [api, filter, path, reload, onExpired]);

  async function save(data) {
    setBusy(true);
    setError('');
    try {
      await api(path, { data, csrf });
      setReload(value => value + 1);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally { setBusy(false); }
  }

  const active = result?.links.filter(link => !link.revokedAt) ?? [];
  return <div className="pc-fields">
    <p>确认两题内容和评分要求等价后，可共享背题进度并合并错题条目。原作答分别保留。</p>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={event => { event.preventDefault(); setFilter(query.trim()); }}>
      <label>搜索同科原卷题干<input value={query} maxLength={120} onChange={event => setQuery(event.target.value)} /></label>
      <button disabled={busy}>搜索</button>
    </form>
    {result?.links.map(link => <div key={link.id} className="pc-page-links">
      <span>{link.title} · 第 {link.pageNumber} 页 {link.revokedAt ? ' · 已撤销' : ''}</span>
      {!link.revokedAt && <button type="button" disabled={busy} onClick={() => save({ revokeId: link.id })}>撤销等价</button>}
    </div>)}
    {result && !result.candidates.length && <p>没有找到符合条件的其他题目。</p>}
    {result?.candidates.filter(item => !active.some(link => item.id === link.memberId || item.id === link.anchorId)).map(item => <div key={item.id}>
      <small>{item.title} · 第 {item.pageNumber} 页</small>
      <p className="pc-confirmed-stem">{item.stem}</p>
      <button type="button" disabled={busy} onClick={() => save({ memberId: item.id })}>确认等价</button>
    </div>)}
  </div>;
}

const outcomes = { confirmed: '已确认', corrected: '已修改', rejected: '已标记误识别' };

function RecognitionCandidate({ original, index, page, review, figures = [], initialContext, api, path, csrf, onExpired, onSaved }) {
  const outcome = review?.outcome;
  const [stem, setStem] = useState(original);
  const [visualReview, setVisualReview] = useState('');
  const needsReview = figures.some(figure => figure.status === 'needs_review');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(reviewedStem) {
    setBusy(true);
    setError('');
    try {
      await api(path + '/recognition-review', { data: { candidateIndex: index, stem: reviewedStem,
        ...(reviewedStem && needsReview ? { visualReview: visualReview.trim() } : {}) }, csrf });
      onSaved();
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <section id={'recognition-' + index} className="pc-recognition-item">
    <label className="pc-fields">识别题目 {index % 100 + 1}
      <textarea value={review?.reviewedStem ?? stem} maxLength={8000} disabled={busy || Boolean(outcome)}
        onChange={event => setStem(event.target.value)} />
    </label>
    {(stem !== original || outcome === 'corrected') && <details>
      <summary>查看原始识别结果</summary><PaperText text={original} />
    </details>}
    {figures.map((figure, figureIndex) => <FigureReview key={figureIndex} figure={figure}
      initialContext={initialContext} canReread={!outcome && !figure.manualReread} api={api} csrf={csrf} onSaved={onSaved} page={page} pageUrl={'/api/v1' + path + '/pages/' + page}
      cropPath={path + '/recognition/' + index + '/figures/' + figureIndex} />)}
    {needsReview && !outcome && <label className="pc-fields">人工核对后的图表内容
      <textarea value={visualReview} maxLength={8000} disabled={busy}
        placeholder="对照原图填写箭头方向、边权、父子节点或表格内容"
        onChange={event => setVisualReview(event.target.value)} />
    </label>}
    {review?.visualReview && <details><summary>人工核对结论</summary>
      <p className="pc-confirmed-stem">{review.visualReview}</p></details>}
    {error && <p role="alert">{error}</p>}
    {outcome ? <p role="status">{outcomes[outcome]}</p> : <div className="pc-dialog-actions">
      <button type="button" disabled={busy} onClick={() => save(null)}>标记误识别</button>
      <button type="button" className="primary" disabled={busy || !stem.trim() || (needsReview && !visualReview.trim())}
        onClick={() => save(stem.trim())}>{stem.trim() === original ? '确认识别' : '保存修改'}</button>
    </div>}
  </section>;
}

const figureReasons = {
  location: '裁片位置或题目归属待核对',
  budget: '本页达到自动重读上限，请人工核对',
  unreadable: '裁片重读无法确认，请人工核对',
  conflict: '两次读数不一致，请人工核对',
  structure: '节点关系与搜索树顺序冲突，请人工核对',
  manual: '已按新框重读，请确认图表内容'
};

function describeFigure(reading) {
  if (!reading) return '';
  return [reading.nodes?.length ? '节点 ' + reading.nodes.join('、') : '',
    ...(reading.edges ?? []).map(edge =>
      `${edge.from} ${reading.kind === 'undirected' ? '—' : '→'} ${edge.to}${edge.label ? `（${edge.label}）` : ''}`),
    reading.description].filter(Boolean).join('\n');
}

function FigureReview({ figure, initialContext, page, pageUrl, cropPath, canReread, api, csrf, onSaved }) {
  const [open, setOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [start, setStart] = useState(null);
  const [box, setBox] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function point(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (offset, length) => Math.max(0, Math.min(1000, Math.round(1000 * offset / length)));
    return [ratio(event.clientX - rect.left, rect.width), ratio(event.clientY - rect.top, rect.height)];
  }
  function move(event) {
    if (!start) return;
    const end = point(event);
    setBox([Math.min(start[0], end[0]), Math.min(start[1], end[1]),
      Math.max(start[0], end[0]), Math.max(start[1], end[1])]);
  }
  async function reread() {
    setBusy(true);
    setError('');
    try {
      await api(cropPath + '/reread', { data: { box }, csrf });
      setSelecting(false);
      onSaved();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{figure.status === 'consistent' ? '图表两次读数一致' : figureReasons[figure.reason]}</summary>
    <p><a href={pageUrl} target="_blank" rel="noreferrer">打开原卷第 {page} 页</a></p>
    {open && figure.box && <img key={figure.box.join(',')} className="pc-paper-preview"
      src={'/api/v1' + cropPath} alt="原页图表裁片" />}
    <p>整页读数</p><p className="pc-confirmed-stem">{describeFigure(figure.initial) || initialContext || '没有可用读数'}</p>
    <p>裁片读数{figure.inferredSides ? `（${figure.inferredSides} 条边的左右由搜索树键值推导）` : ''}</p>
    <p className="pc-confirmed-stem">{describeFigure(figure.reread) || '没有可用读数'}</p>
    {figure.previous && <details><summary>查看重新框选前的记录</summary>
      <p>原框坐标 {figure.previous.box?.join('、') ?? '未定位'}</p>
      <p className="pc-confirmed-stem">{describeFigure(figure.previous.reread) || '没有可用的自动重读结果'}</p>
    </details>}
    {canReread && <button type="button" disabled={busy} onClick={() => {
      setSelecting(!selecting);
      setBox(figure.box ?? [0, 0, 1000, 1000]);
    }}>{selecting ? '取消框选' : '在原页重新框选'}</button>}
    {selecting && <>
      <p>在原图上拖出区域，或填写 0–1000 的边界坐标。每张图可手动重读一次。</p>
      <div style={{ position: 'relative' }}>
        <img className="pc-paper-preview" src={pageUrl} alt="用于框选的试卷原页" draggable={false}
          style={{ display: 'block', touchAction: 'none', cursor: 'crosshair' }}
          onPointerDown={event => {
            if (busy) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            setStart(point(event));
          }} onPointerMove={move} onPointerUp={event => { move(event); setStart(null); }}
          onPointerCancel={() => setStart(null)} />
        {box && <div aria-hidden="true" style={{ position: 'absolute', pointerEvents: 'none',
          border: '2px solid #265ce8', left: box[0] / 10 + '%', top: box[1] / 10 + '%',
          width: (box[2] - box[0]) / 10 + '%', height: (box[3] - box[1]) / 10 + '%' }} />}
      </div>
      <div className="pc-fields">
        {['左', '上', '右', '下'].map((label, coordinate) => <label key={label}>{label}
          <input type="number" min={0} max={1000} step={1} value={box?.[coordinate] ?? 0} disabled={busy}
            onChange={event => setBox(current => current.map((value, index) =>
              index === coordinate ? Math.max(0, Math.min(1000, Number(event.target.value))) : value))} />
        </label>)}
      </div>
      <button type="button" disabled={busy || !box || box[2] - box[0] < 10 || box[3] - box[1] < 10}
        onClick={reread}>{busy ? '正在重读…' : '用此裁片重读'}</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
