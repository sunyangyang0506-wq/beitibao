import React, { useState } from 'react';
import { BookOpen, Key, ShieldCheck } from '@phosphor-icons/react';
import { App, useSaved } from './App.jsx';

const inviteLifetime = 24 * 60 * 60 * 1000;
const phonePattern = '1[0-9]{10}';
const mask = phone => phone.slice(0, 3) + '****' + phone.slice(-4);

async function passwordDigest(phone, password) {
  const bytes = new TextEncoder().encode(phone + ':' + password);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).join('.');
}

export function PrototypeAccess() {
  const [registry, setRegistry] = useSaved('prototype-registry-v1', { accounts: {}, invitations: [] });
  const [active, setActive] = useSaved('prototype-session-v1', '');
  const [view, setView] = useState(() => new URLSearchParams(location.search).has('admin') ? 'admin' : 'workspace');
  const [message, setMessage] = useState('');
  const [issued, setIssued] = useState(null);
  const [phoneHint, setPhoneHint] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const { accounts, invitations } = registry;
  const account = accounts[active];
  const navigate = next => {
    setView(next);
    setMessage('');
    window.scrollTo(0, 0);
  };

  function issue(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const phone = data.get('phone').trim();
    const limit = Number(data.get('limit'));
    if (accounts[phone]) {
      setIssued(null);
      setMessage('该手机号已开通，请在已开通账号中修改上限。');
      return;
    }
    const item = { phone, limit, code: crypto.randomUUID().slice(0, 8).toUpperCase(), expiresAt: Date.now() + inviteLifetime };
    setRegistry(old => ({
      ...old, invitations: [item, ...old.invitations.filter(invite => invite.phone !== phone || invite.used)]
    }));
    setIssued(item);
    setPhoneHint(phone);
    setMessage('');
  }

  async function authenticate(event) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const phone = data.get('phone').trim();
    const password = data.get('password');
    setBusy(true);
    setMessage('');
    try {
      if (view === 'activate') {
        const invite = invitations.find(item => item.phone === phone && item.code === data.get('code').trim().toUpperCase());
        if (accounts[phone]) return setMessage('该手机号已开通，请直接登录。');
        if (!invite || invite.used || invite.expiresAt <= Date.now()) return setMessage('邀请码无效、已使用或已过期。请核对手机号与邀请码。');
        if (password !== data.get('confirm')) return setMessage('两次输入的密码不一致。');
        const digest = await passwordDigest(phone, password);
        setRegistry(old => ({
          accounts: { ...old.accounts, [phone]: { phone, digest, limit: invite.limit } },
          invitations: old.invitations.map(item => item.code === invite.code ? { ...item, code: null, used: true } : item),
        }));
        setIssued(null);
        setPhoneHint(phone);
        navigate('login');
        setMessage('账号已开通，请使用手机号和刚设置的密码登录。');
      } else {
        if (!accounts[phone] || accounts[phone].digest !== await passwordDigest(phone, password)) {
          return setMessage('手机号或密码有误，请检查后重试。');
        }
        setActive(phone);
        navigate('workspace');
      }
    } catch {
      setMessage('当前浏览器无法完成演示登录，请使用本机预览地址。');
    } finally {
      setBusy(false);
    }
  }

  if (view === 'workspace') return <App key={account?.phone ?? 'sample'} account={account}
    onAdmin={() => navigate('admin')} onLogin={() => navigate('login')}
    onLogout={() => { setActive(''); navigate('login'); }} />;

  const activating = view === 'activate';
  return <div className="access-shell">
    <header className="top access-top">
      <div className="brand access-brand"><div className="brand-icon"><BookOpen size={21} weight="bold" /></div><div>背题宝<small>PC 复习工作区</small></div></div>
      <div className="top-actions"><span className="badge blue">交互原型</span>
        {view !== 'admin' && <button onClick={() => navigate('admin')}>账号管理</button>}
        <button onClick={() => navigate('workspace')}>{account ? '返回学员端' : '浏览示例工作区'}</button></div>
    </header>
    {view === 'admin' ? <main className="content access-admin">
      <div className="intro"><div className="eyebrow"><ShieldCheck size={17} /> 管理员演示</div><h1>账号管理</h1><p>通过手机号开通学员账号，独立设置每个账号的学科上限。</p></div>
      <div className="prototype-pair">
        <form className="panel padded form" onSubmit={issue}>
          <h2>开通账号</h2>
          <label>学员手机号<input name="phone" type="tel" pattern={phonePattern} required placeholder="11 位演示手机号" /></label>
          <label>学科上限<input name="limit" type="number" min="1" max="100" defaultValue="5" required /></label>
          <button className="primary">生成邀请码</button>
          {issued && <div className="invite-card"><strong>邀请码</strong><output>{issued.code}</output><small>{mask(issued.phone)} · 上限 {issued.limit} 门 · 24 小时内可用一次</small>
            <button type="button" onClick={() => navigate('activate')}>前往学员端接受邀请</button></div>}
          {message && <p role="status">{message}</p>}
        </form>
        <section className="panel padded form"><h2>已开通账号</h2><p>同名学科跨学期只计一次。调低上限后，已有课程仍可使用。</p>
          <label>按手机号查找<input type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
          {Object.values(accounts).filter(item => item.phone.includes(search.trim())).map(item => <form key={item.phone + ':' + item.limit} className="admin-account" onSubmit={event => {
            event.preventDefault();
            const limit = Number(new FormData(event.currentTarget).get('limit'));
            setRegistry(old => ({ ...old, accounts: { ...old.accounts, [item.phone]: { ...item, limit } } }));
            setMessage('已保存 ' + mask(item.phone) + ' 的学科上限。');
          }}>
            <strong>{mask(item.phone)}</strong><label>学科上限<input name="limit" type="number" min="1" max="100" defaultValue={item.limit} required /></label><button>保存上限</button>
          </form>)}
          {!Object.values(accounts).some(item => item.phone.includes(search.trim())) && <div className="empty">暂无匹配的已开通账号。</div>}
        </section>
      </div>
      <section className="panel padded access-invitations"><h2>最近邀请</h2>
        {invitations.length ? invitations.slice(0, 50).map(item => <div className="paper-row" key={item.phone + item.expiresAt}><strong className="grow">{mask(item.phone)}</strong><span>上限 {item.limit} 门</span><span className="badge">{item.used ? '已使用' : item.expiresAt <= Date.now() ? '已过期' : '待使用'}</span></div>) : <p>生成的邀请会显示在这里。</p>}
      </section>
    </main> : <main className="content access-landing">
      <section className="access-intro"><div className="eyebrow">学员端 · 期末复习</div><h1>从一份原卷开始复习</h1><p>上传 PDF 后自动归属科目，在题目背诵查看题目与参考答案，并练习整套预测卷。交卷后，按题型和错题时间回到需要复习的题。</p></section>
      <form className="panel padded form" key={view} onSubmit={authenticate}>
        <div className="metric-icon"><Key size={23} /></div>
        <h2>{activating ? '接受邀请' : '手机号登录'}</h2>
        <p>{activating ? '输入管理员发给你的邀请码，设置账号密码。' : '使用已开通的演示手机号和密码。'}</p>
        <label>手机号<input name="phone" type="tel" autoComplete="username" pattern={phonePattern} defaultValue={phoneHint} required /></label>
        {activating && <label>邀请码<input name="code" autoComplete="off" required /></label>}
        <label>{activating ? '设置密码' : '密码'}<input name="password" type="password" minLength={8} autoComplete={activating ? 'new-password' : 'current-password'} required /></label>
        {activating && <label>确认密码<input name="confirm" type="password" minLength={8} autoComplete="new-password" required /></label>}
        {message && <p role="status">{message}</p>}
        <button className="primary" disabled={busy}>{activating ? '开通账号' : '登录'}</button>
        <button className="link" type="button" onClick={() => navigate(activating ? 'login' : 'activate')}>{activating ? '已有账号，去登录' : '有邀请码？接受邀请'}</button>
        <small>演示数据保存在本浏览器，请使用测试手机号和密码。</small>
      </form>
    </main>}
  </div>;
}
