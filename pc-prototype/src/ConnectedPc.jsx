import { Predictions } from './Predictions.jsx';
import { Mistakes } from './Mistakes.jsx';
import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, ChartBar, CheckCircle, ClipboardText, FileText, Plus, Sparkle } from '@phosphor-icons/react';
import { Practice } from './Practice.jsx';
import { PaperLibrary } from './PaperLibrary.jsx';
import './connected-pc.css';

const messages = {
  ADMIN_REQUIRED: '当前账号没有开通权限。',
  ACCOUNT_EXISTS: '该邮箱已经开通账号，可直接登录。',
  AUTH_REQUIRED: '登录已过期，请重新登录。',
  INVALID_CREDENTIALS: '邮箱或密码不正确。',
  RECOVERY_NOT_CONFIGURED: '密码重设邮件服务尚未启用。',
  RECOVERY_LINK_UNAVAILABLE: '重设链接无效、已过期或已使用，请重新申请。',
  INVITATION_UNAVAILABLE: '邀请码无效、已使用，或与邮箱不匹配。',
  SUBJECT_LIMIT_REACHED: '已达账号的学科上限。请联系管理员调整。',
  COURSE_NOT_FOUND: '该科目不可用，请刷新后重试。',
  INVALID_EXAM_TIME: '请输入有效的考试日期和时间。',
  INVALID_SCHOOL: '请输入核验后的学校全称。', 
  SCHOOL_SHARING_NOT_AUTHORIZED: '校内共享需要已核验的学校身份及脱敏授权。',
  INVALID_COURSE: '请检查科目名称和学期。',
  INVALID_REQUEST: '请检查填写的内容。',
  PAGE_REVIEW_REQUIRED: '本卷还有待核对页。请先在试卷库完成核对。',
  PAPER_REVIEW_CONFLICT: '卷面状态已在另一窗口更新，请重新读取。',
  INVALID_PAGE_ORDER: '页序需包含原卷每一页，请重新读取。',
  INVALID_SOURCE_PAGES: '请选择本卷有效的关联原页。',
  EQUIVALENCE_CONFLICT: '这道题已参与其他等价关系，请先检查现有关系。',
  EQUIVALENCE_KIND_MISMATCH: '请先核对两道题的题型。',
  PRACTICE_NOT_FOUND: '本卷题目还未就绪，请在题目背诵查看处理状态。',
  PRACTICE_CONFLICT: '另一窗口已更新草稿，请合并后再保存。',
  CLOSED_BOOK_ACTIVE: '本卷正在闭卷练习。交卷后可以查看原页与答案。',
  PRACTICE_SUBMITTED: '这份作答已提交，请重新载入查看。',
  PREDICTION_NO_EVIDENCE: '请先上传试卷，等待题目自动整理完成。',
  PREDICTION_NOT_RELEASED: '预测卷生成尚未开放。',
  PREDICTION_LOCKED: '学完本科目全部原卷后解锁预测卷。',
  PREDICTION_SOURCES_UNCONFIRMED: '请先在试卷库确认本科目的原卷已传齐。',
  PREDICTION_SOURCES_CHANGED: '本科目的原卷列表已变化，请刷新后重新确认。',
  INVALID_PAPER_UPLOAD: '请检查学校、试卷名称和文件大小。',
  INVALID_PAPER_OBJECT: '文件校验失败，请重新选择并上传。',
  MODEL_CONSENT_UNAVAILABLE: '使用百炼前，请先移除个人信息并确认授权。',
  PAPER_ALREADY_ARCHIVED: '该科目已归档相同试卷，可在试卷库查看。',
  PAPER_ASSIGNMENT_BUSY: '试卷仍在识别或已归档，请刷新查看最新状态。',
  PAPER_UPLOAD_BUSY: '正在处理其他上传，请稍后重试。',
  PAPER_UPLOAD_EXPIRED: '本次上传已过期，请重新提交文件。',
  INVALID_REFERENCE: '请检查参考答案是否符合所选评分方式。',
  INVALID_IMAGE: '请选择有效的 JPG 或 PNG 图片。',
  INVALID_FIGURE_BOX: '请框选一个有效的图表区域。',
  FIGURE_REREAD_UNAVAILABLE: '该裁片已经重读或题目已经确认。',
  FIGURE_REVIEW_REQUIRED: '请对照原图核对图表并填写确认后的内容。',
  REVIEW_ALREADY_SAVED: '这条识别结果已核对，请重新读取。',
  MODEL_RECOVERY_REQUIRED: '模型处理已暂停，请先恢复原卷处理，再整理题目。',
  OCR_NOT_CONFIGURED: '识别服务尚未配置，请联系服务方；原图已保留。',
  MODEL_NOT_CONFIGURED: '模型服务尚未配置，请联系服务方。',
  MODEL_PAYMENT_REQUIRED: '模型服务余额不足，请联系服务方。',
  MODEL_SERVICE_NOT_ENABLED: '模型服务尚未开通，请联系服务方。',
  MODEL_AUTHENTICATION_FAILED: '模型认证失败，请联系服务方。',
  MODEL_ACCESS_DENIED: '模型服务权限不足，请联系服务方。',
  MODEL_BUDGET_LIMIT: '当前模型处理额度已用完，请稍后再试。',
  RECOGNITION_UNAVAILABLE: '识别结果暂不可用，请刷新。',
  PDF_ONLY: '试卷库只接收 PDF。请先将纸质试卷扫描成 PDF。',
  INVALID_PDF: '请选择有效的 PDF，并填写试卷名称。',
  QUESTION_VERSION_CONFLICT: '题目已在其他窗口更新，请重新打开后再修改。',
  INVALID_QUESTION: '请输入有效题干。',
  PAPER_NOT_FOUND: '试卷或原页不可用。',
  RATE_LIMITED: '操作过于频繁，请稍后重试。'
};

async function api(path, { data, file, mediaType, csrf, signal } = {}) {
  const response = await fetch('/api/v1' + path, {
    credentials: 'same-origin',
    signal,
    ...((data || file) && {
      method: 'POST',
      headers: { 'Content-Type': file ? mediaType : 'application/json', ...(csrf && { 'X-CSRF-Token': csrf }) },
      body: file ?? JSON.stringify(data)
    })
  });
  if (response.status === 204) return null;
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) {
    const error = new Error(messages[result?.code] ?? '服务暂时不可用，请稍后重试。');
    error.status = response.status;
    error.code = result?.code;
    throw error;
  }
  return result;
}

function Brand() {
  return <div className="brand">
    <div className="brand-icon"><BookOpen size={21} weight="bold" /></div>
    <div>背题宝<small>PC 复习工作区</small></div>
  </div>;
}

function SignIn({ onSession, notice }) {
  const [register, setRegister] = useState(false);
  const [recover, setRecover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    const { identity, ...fields } = Object.fromEntries(new FormData(event.currentTarget));
    const value = identity.trim();
    const data = { ...fields, ...(value.includes('@') ? { email: value } : { phone: value }) };
    setBusy(true);
    setError('');
    try {
      onSession(await api(register ? '/auth/register' : '/auth/login', { data }));
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  if (recover) return <PasswordRecovery onBack={() => setRecover(false)} />;
  return <main className="pc-login">
    <section className="panel padded pc-login-card" aria-labelledby="auth-heading">
      <Brand />
      <h1 id="auth-heading">{register ? '接受邀请' : '登录背题宝'}</h1>
      <p>{register ? '使用收到邀请的手机号或邮箱创建账号。' : '登录后查看个人科目与复习进展。'}</p>
      {notice && <p role="status">{notice}</p>}
      <form className="pc-fields" onSubmit={submit}>
        <label>手机号或邮箱<input name="identity" autoComplete="username" maxLength={254} required /></label>
        <label>密码<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={12} maxLength={128} required /></label>
        {register && <label>邀请码<input name="invite" autoComplete="off" pattern={'[A-Za-z0-9_\\-]{43}'} required /></label>}
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>{busy ? '请稍候…' : register ? '创建账号' : '登录'}</button>
        <button type="button" className="link" disabled={busy} onClick={() => { setError(''); setRegister(!register); }}>
          {register ? '已有账号，返回登录' : '我有邀请码'}
        </button>
        {!register && <button type="button" className="link" disabled={busy} onClick={() => setRecover(true)}>忘记密码</button>}
      </form>
    </section>
  </main>;
}

function PasswordRecovery({ token, onBack, onReset }) {
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try {
      if (token) {
        await api('/auth/recovery/complete', { data: { password: data.password, token } });
        onReset();
      } else {
        await api('/auth/recovery/request', { data });
        setAccepted(true);
      }
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="pc-login"><section className="panel padded pc-login-card" aria-labelledby="recovery-title">
    <Brand />
    <h1 id="recovery-title">{token ? '设置新密码' : '重设密码'}</h1>
    {accepted ? <p role="status">如果此邮箱已注册，将收到一封密码重设邮件。</p> : <form className="pc-fields" onSubmit={submit}>
      {token ? <label>新密码<input name="password" type="password" autoComplete="new-password" minLength={12} maxLength={128} required /></label>
        : <label>注册邮箱<input name="email" type="email" autoComplete="email" maxLength={254} required /></label>}
      {error && <p role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{token ? '保存新密码' : '发送重设链接'}</button>
    </form>}
    <button type="button" className="link" disabled={busy} onClick={onBack}>返回登录</button>
  </section></main>;
}

function CourseDialog({ onSave, onClose, onExpired, csrf }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try {
      const result = await api('/courses', { data, csrf });
      onSave(result);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return <dialog className="pc-course-dialog" ref={element => {
    if (element && !element.open) element.showModal();
  }} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="course-title">
    <h2 id="course-title">添加科目</h2>
    <form className="pc-fields" onSubmit={submit}>
      <label>科目名称<input name="name" maxLength={100} required autoFocus /></label>
      <label>任课教师（选填）<input name="teacher" maxLength={100} /></label>
      <label>学期<input name="term" maxLength={80} placeholder="例如 2026 秋" required /></label>
      {error && <p role="alert">{error}</p>}
      <div className="pc-dialog-actions">
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : '保存科目'}</button>
      </div>
    </form>
  </dialog>;
}

function ExamTimeDialog({ course, csrf, onClose, onSaved, onExpired }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(examAt) {
    setBusy(true);
    setError('');
    try {
      const result = await api('/courses/' + course.id + '/exam-time', { data: { examAt }, csrf });
      onSaved(result);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return <dialog className="pc-dialog" aria-labelledby="exam-time-title"
    ref={element => { if (element && !element.open) element.showModal(); }}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <form className="pc-fields" onSubmit={event => {
      event.preventDefault();
      void save(new FormData(event.currentTarget).get('examAt'));
    }}>
      <h2 id="exam-time-title">考试时间</h2>
      <p>{course.name} · {course.term}</p>
      <label>日期和时间（北京时间）<input type="datetime-local" name="examAt" defaultValue={course.examAt ?? ''} required /></label>
      {error && <p role="alert">{error}</p>}
      <div className="pc-dialog-actions">
        {course.examAt && <button type="button" className="link" disabled={busy} onClick={() => save(null)}>清除考试时间</button>}
        <button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="submit" className="primary" disabled={busy}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </form>
  </dialog>;
}

const metrics = [['科目总数', 'total', BookOpen], ['背题完成', 'completed', CheckCircle], ['尚未完成', 'incomplete', ChartBar]];

function Progress({ session, onExpired }) {
  const [progress, setProgress] = useState(null);
  const [examCourse, setExamCourse] = useState(null);
  const [progressFilter, setProgressFilter] = useState('all');
  const [libraryCourse, setLibraryCourse] = useState(null);
  const guideKey = 'beitibao-upload-guide:' + (session.phone ?? session.email);
  const [firstGuide, setFirstGuide] = useState(() => {
    try { return localStorage.getItem(guideKey) !== 'seen'; } catch { return true; }
  });
  const [guidedLibrary, setGuidedLibrary] = useState(false);

  function dismissGuide() {
    try { localStorage.setItem(guideKey, 'seen'); } catch {}
    setFirstGuide(false);
  }

  function startUploadGuide() {
    openPractice(null);
    setGuidedLibrary(true);
    setLibraryCourse('auto');
    dismissGuide();
  }

  const [browseId, setBrowseId] = useState('');
  const [practice, setPractice] = useState(() => {
    const paperId = new URL(location.href).searchParams.get('practice');
    return paperId === null ? null : { paperId };
  });

  const [showMistakes, setShowMistakes] = useState(false);
  const [showPrediction, setShowPrediction] = useState(false);
  const [predictionCourse, setPredictionCourse] = useState('');
  function openPrediction(courseId = '') {
    openPractice(null);
    setLibraryCourse(null);
    setPredictionCourse(courseId);
    setShowPrediction(true);
  }

  function openBrowse(paperId) {
    openPractice(''); setBrowseId(paperId); reload();
  }

  const openPractice = useCallback((paperId, durationMinutes, { courseId } = {}) => {
    setBrowseId('');
    setShowMistakes(false);
    setShowPrediction(false);
    const url = new URL(location.href);
    if (durationMinutes) url.searchParams.set('duration', String(durationMinutes));
    else url.searchParams.delete('duration');
    if (paperId) url.searchParams.set('practice', paperId);
    else url.searchParams.delete('practice');
    history.replaceState(null, '', url);
    setPractice(current => paperId === null ? null : { paperId, courseId: courseId ?? current?.courseId });
  }, []);

  function openMistakes() {
    openPractice(null);
    setLibraryCourse(null);
    setShowMistakes(true);
  }
  const [refresh, setRefresh] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    api('/progress', { signal: controller.signal }).then(setProgress).catch(failure => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    });
    return () => controller.abort();
  }, [refresh, onExpired]);

  function reload() {
    setError('');
    setRefresh(current => current + 1);
  }

  function openProgress() {
    openPractice(null);
    setLibraryCourse(null);
    setProgress(null);
    reload();
  }

  async function logout() {
    setSigningOut(true);
    setError('');
    try {
      await api('/auth/logout', { data: {}, csrf: session.csrfToken });
      onExpired();
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setSigningOut(false);
    }
  }

  return <div className="app">
    <aside className="sidebar">
      <Brand />
      <div className="nav-label">复习工作区</div>
      <button className={showPrediction || showMistakes || libraryCourse || practice !== null ? "nav" : "nav active"} aria-current={showPrediction || showMistakes || libraryCourse || practice !== null ? undefined : "page"} onClick={openProgress}><ChartBar size={21} />学习进展</button>
      <button className={practice !== null ? "nav active" : "nav"} aria-current={practice !== null ? "page" : undefined}
        onClick={() => { openPractice(''); reload(); }}><BookOpen size={21} />题目背诵</button>
      <button className={showMistakes ? "nav active" : "nav"} aria-current={showMistakes ? "page" : undefined}
        onClick={openMistakes}><ClipboardText size={21} />错题本</button>
      <button className={showPrediction ? "nav active" : "nav"} aria-current={showPrediction ? "page" : undefined}
        aria-describedby="prediction-nav-hint" onClick={() => openPrediction()}><Sparkle size={21} />考题预测</button>
      <small className="prediction-nav-hint" id="prediction-nav-hint">学完整科后解锁</small>
      <button className={libraryCourse && practice === null ? "nav active" : "nav"} aria-current={libraryCourse && practice === null ? "page" : undefined}
        onClick={() => { openPractice(null); setGuidedLibrary(false); setLibraryCourse('auto'); }}><FileText size={21} />试卷库</button>
      <div className="sidebar-foot"><strong>当前账号</strong><small>{(session.phone ?? session.email)}</small></div>
    </aside>
    <div className="main">
      <header className="top">
        <div className="top-title">{showPrediction ? "考题预测" : showMistakes ? "错题本" : practice !== null ? "题目背诵" : libraryCourse ? "试卷库" : "学习进展"}</div>
        <div className="top-actions">
          {session.isAdmin && <a href="/?admin=1">账号管理</a>}
          <button disabled={signingOut} onClick={logout}>退出登录</button>
          {!showPrediction && !showMistakes && !libraryCourse && practice === null && <button className="primary" onClick={() => { setNotice(''); setShowAdd(true); }}><Plus size={17} />添加科目</button>}
        </div>
      </header>
      {showPrediction ? <Predictions initialCourseId={predictionCourse} api={api} csrf={session.csrfToken} courses={progress?.courses ?? []}
        onOpen={openPractice} onPractice={courseId => openPractice('', undefined, { courseId })}
        onLibrary={courseId => { openPractice(null); setGuidedLibrary(false); setLibraryCourse(courseId); }} onExpired={onExpired} />
      : showMistakes ? <Mistakes onPractice={() => openPractice('')} api={api} csrf={session.csrfToken} onExpired={onExpired} />
      : practice !== null ? <Practice onMistakes={openMistakes} key={practice.paperId} paperId={practice.paperId}
        initialCourseId={practice.courseId} api={api} csrf={session.csrfToken}
        courses={progress?.courses ?? []} browseId={browseId} onUpload={startUploadGuide} onOpen={openPractice} onExpired={onExpired} />
      : libraryCourse ? <PaperLibrary onMistakes={openMistakes} onPrediction={openPrediction} api={api} csrf={session.csrfToken}
        onBrowse={openBrowse} guided={guidedLibrary} courses={progress?.courses ?? []} courseId={libraryCourse} onCourse={setLibraryCourse} onExpired={onExpired} onPractice={openPractice} />
      : <main className="content">
        <div className="intro"><div className="eyebrow">复习总览</div><h1>学习进展</h1><p>查看每门科目的原卷复习状态。</p></div>
        {notice && <p className="pc-status" role="status">{notice}</p>}
        {error && <div className="pc-status" role="alert">{error} <button onClick={reload}>重试</button></div>}
        {firstGuide && <section className="panel padded pc-first-upload" aria-labelledby="first-upload-title">
          <button id="first-upload-title" type="button" className="primary" disabled={!progress} onClick={startUploadGuide}>
            上传试卷
          </button>
          <p>上传 PDF 到试卷库，预览原卷并查看识别状态。有可用题目后即可开始练习。</p>
        </section>}
        <div className="metrics">{metrics.map(([label, key, Icon]) => <div className="metric" key={key}>
          <div className="metric-icon"><Icon size={23} /></div><div><span>{label}</span><div><strong>{progress?.[key] ?? '–'}</strong> 门</div></div>
        </div>)}</div>
        <section className="panel table-panel">
          <div className="panel-head"><div><h2>科目进展</h2><p>原卷背题按套统计，预测卷单独记录。</p></div>
            <div className="segments" aria-label="科目完成状态">{[['all','全部'],['pending','未完成'],['completed','已完成']].map(([value,label])=><button key={value} type="button" className={progressFilter === value ? 'selected' : ''} aria-pressed={progressFilter === value} onClick={() => setProgressFilter(value)}>{label}</button>)}</div>
          </div>
          <table><thead><tr><th>科目</th><th>原卷背题进展</th><th>剩余套数</th><th>考题预测</th></tr></thead>
            <tbody>
              {progress?.courses.filter(course => progressFilter === 'all' || (progressFilter === 'completed') === (course.status === 'completed')).map(course => <tr key={course.id}>
                <td><strong>{course.name}</strong><small>{course.teacher || '教师未填写'} · {course.term}</small>
                  <button className="link prototype-exam-time" onClick={() => setExamCourse(course)} aria-label={'考试时间 · ' + course.name}>{course.examAt ? '考试 ' + course.examAt.replace('T', ' ') : '考试时间'}</button></td>
                <td>已完成 {course.completedPapers} / {course.totalPapers} 套</td>
                <td>{course.remainingPapers} 套</td>
                <td>{course.status === 'completed' ? <button className="link" onClick={() => openPrediction(course.id)}>查看预测卷</button>
                  : <span className="prediction-locked-label">学完整科后解锁</span>}</td>
              </tr>)}
              {!progress?.courses.length && <tr><td colSpan={4}>
                {progress ? '还没有科目，上传试卷后会自动识别并创建。也可手动添加。' : error ? '暂未获取到进展。' : '正在读取学习进展…'}
              </td></tr>}
            </tbody>
          </table>
        </section>
      </main>}
    </div>
    {examCourse && <ExamTimeDialog key={examCourse.id} course={examCourse} csrf={session.csrfToken}
      onClose={() => setExamCourse(null)} onExpired={onExpired} onSaved={({ id, examAt }) => {
        setProgress(current => ({ ...current, courses: current.courses.map(course => course.id === id ? { ...course, examAt } : course) }));
        setExamCourse(null);
      }} />}
    {showAdd && <CourseDialog csrf={session.csrfToken} onExpired={onExpired} onClose={() => setShowAdd(false)}
      onSave={({ course, reused }) => {
        setShowAdd(false);
        setNotice(reused ? '已复用「' + course.name + '」。' : '已添加「' + course.name + '」。');
        reload();
      }} />}
  </div>;
}

function AccountAdmin({ session, onExpired }) {
  const [access, setAccess] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [invitation, setInvitation] = useState(null);
  const [history, setHistory] = useState(null);
  const [reload, setReload] = useState(0);
  const [accounts, setAccounts] = useState([]);
  const [search, setSearch] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api('/admin/invitations', { signal: controller.signal }),
      api('/admin/accounts?' + new URLSearchParams({ email: search }), { signal: controller.signal })
    ]).then(([invites, listed]) => {
      if (!controller.signal.aborted) {
        setHistory(invites.invitations);
        setAccounts(listed.accounts);
        setAccess(true);
      }
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  }, [reload, search]);

  async function createInvitation(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const phone = form.get('phone').trim();
    const subjectLimit = Number(form.get('subjectLimit'));
    setError('');
    setInvitation(null);
    setBusy(true);
    try {
      setInvitation(await api('/admin/invitations', { data: { phone, subjectLimit }, csrf: session.csrfToken }));
      setReload(value => value + 1);
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveLimit(event, account) {
    event.preventDefault();
    const subjectLimit = Number(new FormData(event.currentTarget).get('subjectLimit'));
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const updated = await api('/admin/accounts/' + account.id + '/subject-limit', {
        data: { subjectLimit }, csrf: session.csrfToken
      });
      setAccounts(current => current.map(item => item.id === account.id ? { ...item, ...updated } : item));
      setSaved('已保存 ' + (account.phone ?? account.email) + ' 的学科上限。');
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveSchool(event, account) {
    event.preventDefault();
    const schoolName = new FormData(event.currentTarget).get('schoolName').trim() || null;
    setBusy(true);
    setError('');
    setSaved('');
    try {
      const updated = await api('/admin/accounts/' + account.id + '/school', {
        data: { schoolName }, csrf: session.csrfToken
      });
      setAccounts(current => current.map(item => item.id === account.id ? { ...item, ...updated } : item));
      setSaved(schoolName ? '学校已绑定。' : '已解除学校绑定和原有共享授权。');
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    try {
      await api('/auth/logout', { data: {}, csrf: session.csrfToken });
      onExpired();
    } catch (failure) {
      if (failure.status === 401) onExpired();
      else setError(failure.message);
    }
  }

  return <main className="pc-login"><section className="panel padded pc-login-card pc-account-admin">
    <Brand />
    <h1>账号管理</h1>
    <p>管理员 · {(session.phone ?? session.email)}</p>
    {error && <p role="alert">{error}</p>}
    {access ? <form className="pc-fields" onSubmit={createInvitation}>
      <h2>开通账号</h2>
      <label>学员手机号<input type="tel" name="phone" inputMode="numeric" autoComplete="off"
        pattern="1[3-9][0-9]{9}" maxLength={11} placeholder="11 位中国大陆手机号" required /></label>
      <label>学科上限<input type="number" name="subjectLimit" min={0} max={1000} step={1} defaultValue={5} required /></label>
      <button className="primary" disabled={busy}>{busy ? '生成中…' : '生成邀请码'}</button>
    </form> : !error && <p role="status">正在验证管理员权限…</p>}
    {invitation && <div className="notice" role="status">
      <p>请将邀请码发给 {invitation.phone ?? invitation.email}。学员在登录页选择「接受邀请」，填写手机号、邀请码并设置自己的密码。</p>
      <label>一次性邀请码<input readOnly value={invitation.invite} onFocus={event => event.currentTarget.select()} /></label>
      <p>有效至 {new Date(invitation.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）</p>
    </div>}
    {access && <section>
      <h2>已开通账号</h2>
      <p>同名学科跨学期只计一次。调低上限后，已有学科仍可使用。</p>
      <form className="pc-fields" onSubmit={event => {
        event.preventDefault();
        setSearch(new FormData(event.currentTarget).get('email').trim());
      }}>
        <label>按手机号或邮箱查找<input name="email" type="search" maxLength={254} /></label>
        <button type="submit">查找账号</button>
      </form>
      {saved && <p role="status">{saved}</p>}
      {!accounts.length && <p>没有匹配的账号。</p>}
      {accounts.map(account => <div className="pc-account-row" key={account.id}>
        <strong>{account.phone ?? account.email}</strong>
        <form className="pc-fields" onSubmit={event => saveLimit(event, account)}>
          <label>学科上限<input name="subjectLimit" type="number" min={0} max={1000} step={1}
            key={account.subjectLimit} defaultValue={account.subjectLimit ?? ''} placeholder="当前未限制" required /></label>
          <button type="submit" disabled={busy}>保存上限</button>
        </form>
        <form className="pc-fields" key={account.schoolName ?? ''} onSubmit={event => saveSchool(event, account)}>
          <label>已核验学校<input name="schoolName" defaultValue={account.schoolName ?? ''} maxLength={120} placeholder="学校全称，留空可解除绑定" /></label>
          <label className="pc-check"><input type="checkbox" required />确认已核验学员身份，或确认解除绑定。</label>
          <button type="submit" disabled={busy}>保存学校</button>
        </form>
      </div>)}
    </section>}
    {history && <section><h2>最近邀请</h2>
      <button type="button" onClick={() => setReload(value => value + 1)}>刷新状态</button>
      {!history.length && <p>还没有邀请记录。</p>}
      <ul>{history.map((item, index) => <li key={(item.phone ?? item.email) + item.expiresAt + index}>
        {item.phone ?? item.email} · {({ pending: '待使用', used: '已使用', expired: '已过期' })[item.status]} · 学科上限 {item.subjectLimit ?? '未限制'}
        <small>{new Date(item.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} 到期</small>
      </li>)}</ul>
    </section>}
    <p><a href="/">返回工作台</a> <button className="link" onClick={logout}>退出登录</button></p>
  </section></main>;
}

export function ConnectedPc() {
  const [session, setSession] = useState(undefined);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [recoveryToken, setRecoveryToken] = useState(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('reset');
    return /^[A-Za-z0-9_-]{43}$/.test(token ?? '') ? token : null;
  });
  const [notice, setNotice] = useState('');
  const clearSession = React.useCallback(() => setSession(null), []);

  useEffect(() => {
    if (location.hash.startsWith('#reset=')) history.replaceState(null, '', location.pathname + location.search);
  }, []);

  useEffect(() => {
    if (recoveryToken) return;
    const controller = new AbortController();
    api('/auth/session', { signal: controller.signal }).then(setSession).catch(failure => {
      if (controller.signal.aborted) return;
      if (failure.status === 401) setSession(null);
      else setError(failure.message);
    });
    return () => controller.abort();
  }, [retry, recoveryToken]);

  if (recoveryToken) return <PasswordRecovery token={recoveryToken} onBack={() => setRecoveryToken(null)}
    onReset={() => { setRecoveryToken(null); clearSession(); setNotice('密码已更新，请用新密码登录。'); }} />;

  if (session === undefined) return <main className="pc-login">
    <section className="panel padded pc-login-card">
      <Brand />
      <p role={error ? 'alert' : 'status'}>{error || '正在恢复会话…'}</p>
      {error && <button onClick={() => { setError(''); setRetry(value => value + 1); }}>重试</button>}
    </section>
  </main>;
  if (session && (location.hash === '#admin' || new URLSearchParams(location.search).get('admin') === '1')) {
    return <AccountAdmin session={session} onExpired={clearSession} />;
  }
  return session ? <Progress session={session} onExpired={clearSession} /> : <SignIn onSession={setSession} notice={notice} />;
}

