import { PaperStudy } from './PaperStudy.jsx';
import { assignmentMessage } from './paper-assignment.js';
import React, { useEffect, useState } from 'react';
import { libraryStatusLabels } from './paper-library-status.js';
import { PdfUpload, PdfScanGuide } from './PdfUpload.jsx';

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

export function PaperLibrary({ api, csrf, courses, courseId, onCourse, onExpired, onPractice, onMistakes, onPrediction, onBrowse, guided = false }) {
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

  if (paperId) return <PaperStudy key={paperId} api={api} csrf={csrf} paperId={paperId}
    onExpired={onExpired} onPractice={onPractice} onBrowse={onBrowse} onMistakes={onMistakes} onPrediction={onPrediction} courses={courses}
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
            unassigned: assignmentMessage(paper),
            needs_review: '题目整理尚未完成，可在题目背诵查看已就绪题目。',
            no_questions: '尚无可练题，请检查原卷是否完整、清晰。',
            missing_pages: '补齐缺页后上传完整 PDF。',
            failed: paper.status === 'failed' ? '查看失败原因，检查 PDF 后重新上传。' : '打开试卷，重试失败页或先练已识别题。',
            ready: '题目已自动整理到题目背诵。'
          }[state];
          return <div className="pc-paper-row" key={paper.id}>
            <div className="pc-paper-row-copy">
              <strong>{paper.title}</strong>
              {paper.schoolReuse && <span className="badge green">{reuseMessage[paper.schoolReuse]}</span>}
              <small>{paper.recognizedSubject && '识别科目 ' + paper.recognizedSubject + ' · '}{courses.find(course => course.id === paper.courseId)?.name && '已归档 · '}{next}</small>
            </div>
            <div className="pc-paper-row-actions">
              <span className={'badge ' + (state === 'ready' ? 'green' : state === 'recognizing' ? 'blue' : 'amber')}>{libraryStatusLabels[state]}</span>
              <button type="button" className="link" aria-label={'查看原卷 ' + paper.title} onClick={() => { setNotice(''); setPaperId(paper.id); }}>查看原卷</button>
              <button type="button" aria-label={'背诵题目 ' + paper.title} onClick={() => onBrowse(paper.id)}>题目背诵</button>
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
          {modelUploads ? <p>授权后自动识别并归属科目，题干、答案与知识点集中到题目背诵。</p>
            : uploadMode && <p role="status">自动识别暂未开放。上传后保留原卷，不生成虚构题目或科目。</p>}
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
            !modelUploads || (uploadMode === 'private' && !modelConsent) ? '上传试卷' : '上传试卷'}</button>
        </form>
      </section>
    </div>
  </main>;
}
