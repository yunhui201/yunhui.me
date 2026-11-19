import React, { useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Empty, Field, Ico, Modal, Toggle, useToast } from '../components/ui';
import { PluginRecord, call, isWebMode } from '../lib/api';
import DesktopExtensions from './DesktopExtensions';

function MiddlewareStatus({ enabled, result }: { enabled: boolean; result?: { status: 'ok' | 'error' | 'blocked'; checkedAt: string; message?: string } }) {
  if (!enabled) return null;
  if (!result) return <p className="hint middleware-status">等待请求验证</p>;
  const date = new Date(result.checkedAt);
  const label = { ok: '最近运行正常', error: '最近运行失败', blocked: '最近请求被拦截' }[result.status];
  return <div className="middleware-status" style={{ marginTop: 10 }}><div className="row wrap"><span className={`chip ${result.status === 'ok' ? 'ok' : 'warn'}`}>{label}</span>{!Number.isNaN(date.valueOf()) && <time className="hint" dateTime={result.checkedAt}>最近验证：{date.toLocaleString('zh-CN')}</time>}</div>{result.message && <p className="hint" style={{ overflowWrap: 'anywhere' }}>{result.message}</p>}</div>;
}

export default function Plugins(props: PageProps) {
  const [tab, setTab] = useState<'desktop' | 'gateway'>('desktop');
  return <>
    <div className="filter-bar"><div className="segments"><button className={tab === 'desktop' ? 'selected' : ''} onClick={() => setTab('desktop')}>桌面插件与市场</button><button className={tab === 'gateway' ? 'selected' : ''} onClick={() => setTab('gateway')}>网关中间件</button></div><Btn onClick={() => props.go('codex')}>MCP / Skills / 提示词 →</Btn></div>
    {tab === 'desktop' ? <><div className="page-head"><div><div className="eyebrow">EXTENSIONS</div><h1>插件中心</h1><p>解锁桌面插件入口，安装增强，查看每一项的实际运行状态。</p></div></div><DesktopExtensions /></> : <GatewayPlugins {...props} />}
  </>;
}

function GatewayPlugins({ state, reload, go }: PageProps) {
  const toast = useToast();
  const remote = isWebMode();
  const [editing, setEditing] = useState<Partial<PluginRecord> | null>(null);
  const [optionsText, setOptionsText] = useState('{}');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [deleting, setDeleting] = useState<PluginRecord | null>(null);
  const [search, setSearch] = useState('');
  const builtinInstalled = (id: string) => state.plugins.find(p => p.id === id && p.builtin);
  const matches = (p: { name: string; description?: string }) => `${p.name} ${p.description || ''}`.toLowerCase().includes(search.toLowerCase());
  const custom = state.plugins.filter(p => !p.builtin && matches(p));

  async function mutate(key: string, action: string, payload: unknown, message?: string) {
    if (remote || busy) return;
    setBusy(key); setError('');
    try {
      const result = await call(action, payload);
      if (result?.ok === false) throw new Error(result.message || '操作未完成');
      await reload();
      if (message) toast.push(message, 'ok');
      return true;
    } catch (e: any) { const message = e.message || '操作未完成'; setError(message); toast.push(message, 'bad'); return false; }
    finally { setBusy(''); }
  }
  function edit(record: Partial<PluginRecord>) {
    setEditing(record); setOptionsText(JSON.stringify(record.options || {}, null, 2)); setError('');
  }
  async function save() {
    if (!editing || remote) return;
    try {
      const options = JSON.parse(optionsText);
      if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('参数应为 JSON 对象，例如 { "text": "使用中文回答" }');
      if (!editing.name?.trim()) throw new Error('请填写插件名称');
      if (!editing.builtin && !editing.code?.trim()) throw new Error('请填写中间件代码');
      setError('');
      if (await mutate('save', 'plugin.save', { ...editing, name: editing.name.trim(), options }, editing.enabled ? '插件已保存' : '已保存，当前保持停用')) setEditing(null);
    } catch (e: any) { setError(e instanceof SyntaxError ? '参数不是有效 JSON，请检查引号、逗号和括号。' : e.message); }
  }

  return <>
    <div className="page-head">
      <div><div className="eyebrow">EXTENSIONS</div><h1>插件中心</h1><p>为经过云汇网关的请求添加能力，按需要开启。</p></div>
      <div className="actions">
        <Btn onClick={() => go('codex')}><Ico name="cube" size={14} /> MCP / Skills / 提示词</Btn>
        <Btn variant="primary" disabled={remote || !!busy} onClick={async () => {
          setBusy('sample');
          try { edit({ name: '我的中间件', code: await call<string>('plugin.sample'), enabled: false, options: {} }); }
          catch (e: any) { toast.push(e.message, 'bad'); }
          finally { setBusy(''); }
        }}><Ico name="plus" size={14} /> 新建插件</Btn>
      </div>
    </div>
    {remote && <div className="notice"><Ico name="shield" /><span>远程模式可查看插件状态。安装、启停与脚本编辑请在电脑上的云汇客户端完成。</span></div>}
    <div className="notice"><Ico name="puzzle" /><span>这里管理网关中间件。客户端自己的 MCP、Skills 与全局提示词在「桌面工作台」中管理。</span></div>
    <div className="row" style={{ marginBottom: 18, gap: 12 }}>
      <div className="grow"><input className="input" style={{ maxWidth: 360 }} value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索插件名称或功能" aria-label="搜索插件" /></div>
      <span className="chip ok">{state.plugins.filter(p => p.enabled).length} 个已启用</span><span className="chip">{state.builtinMiddleware.length} 个内置能力</span>
    </div>
    <div className="grid cols-2">
      {state.builtinMiddleware.filter(matches).map(b => {
        const installed = builtinInstalled(b.id);
        const record = installed || { id: b.id, name: b.name, description: b.description, builtin: true, enabled: false, options: b.defaultOptions };
        return <div className="card" key={b.id}>
          <div className="card-title"><Ico name={b.id === 'model-map' ? 'route' : b.id === 'system-prompt' ? 'chat' : 'puzzle'} /><span>{b.name}</span><span className="sub"><span className="chip">内置</span></span></div>
          <p style={{ fontSize: 12, lineHeight: 1.8, color: 'var(--text-2)', minHeight: 44 }}>{b.description}</p>
          {b.id === 'token-budget' && <p className="hint" style={{ marginTop: 8 }}>裁剪会移除较早轮次；重要上下文请先保留摘要。</p>}
          <MiddlewareStatus enabled={!!installed?.enabled} result={state.middlewareStatus?.[b.id]} />
          <div className="row" style={{ marginTop: 18 }}>
            <span className={`chip ${installed?.enabled ? 'ok' : ''}`}>{installed?.enabled ? '已启用' : '未启用'}</span>
            <div className="grow" />
            <Btn size="sm" disabled={remote || !!busy} onClick={() => edit(record)}>配置</Btn>
            {!remote && <fieldset disabled={!!busy} style={{ border: 0, padding: 0, margin: 0 }}><Toggle title={`启用${b.name}`} on={!!installed?.enabled} onChange={v => { void mutate(b.id, 'plugin.save', installed ? { id: installed.id, enabled: v } : { ...record, enabled: v }); }} /></fieldset>}
          </div>
        </div>;
      })}
    </div>
    <div className="card" style={{ marginTop: 20 }}>
      <div className="card-title">自定义插件<span className="sub">新建插件默认停用，检查代码后再启用</span></div>
      {!custom.length ? <Empty icon="◇" title={search ? '没有匹配的自定义插件' : '把你的工作习惯，变成一个插件'} hint={search ? '换个关键词试试。' : '从可编辑模板开始，为请求添加自己的处理逻辑。'} /> : <div className="list">
        {custom.map(p => <div className="list-row" key={p.id}>
          <div className="grow"><strong>{p.name}</strong><div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>{p.description || '本地 JavaScript 中间件'}</div><MiddlewareStatus enabled={p.enabled} result={state.middlewareStatus?.[p.id]} /></div>
          {remote ? <span className={`chip ${p.enabled ? 'ok' : ''}`}>{p.enabled ? '已启用' : '已停用'}</span> : <fieldset disabled={!!busy} style={{ border: 0, padding: 0, margin: 0 }}><Toggle on={p.enabled} title={`启用${p.name}`} onChange={v => { void mutate(p.id, 'plugin.save', { id: p.id, enabled: v }); }} /></fieldset>}
          <Btn size="sm" disabled={remote || !!busy} onClick={() => edit(p)}>编辑</Btn>
          <Btn size="sm" variant="ghost" disabled={remote || !!busy} title={`删除${p.name}`} onClick={() => { setError(''); setDeleting(p); }}><Ico name="trash" size={13} /></Btn>
        </div>)}
      </div>}
    </div>
    {editing && <Modal title={editing.builtin ? `${editing.name} · 配置` : '编辑自定义插件'} sub={editing.builtin ? '保存配置后，启用状态保持不变。' : '定义同步 function onRequest(ir, ctx)。参数通过 options 对象读取，返回 ir 或 { block: "原因" }。'} onClose={() => !busy && setEditing(null)} width={740} foot={<><Btn variant="ghost" disabled={!!busy} onClick={() => setEditing(null)}>取消</Btn><Btn variant="primary" disabled={!!busy} onClick={save}>{busy === 'save' ? '保存中…' : '保存配置'}</Btn></>}>
      {!editing.builtin && <><Field label="名称"><input className="input" aria-label="插件名称" disabled={!!busy} value={editing.name || ''} onChange={e => setEditing({ ...editing, name: e.target.value })} /></Field><Field label="说明"><input className="input" aria-label="插件说明" disabled={!!busy} value={editing.description || ''} onChange={e => setEditing({ ...editing, description: e.target.value })} /></Field><Field label="JavaScript 代码" hint="插件处理的是模型请求内容，请只启用你信任的代码。"><textarea className="textarea mono" aria-label="中间件代码" disabled={!!busy} style={{ minHeight: 240 }} value={editing.code || ''} onChange={e => setEditing({ ...editing, code: e.target.value })} spellCheck={false} /></Field></>}
      <Field label="参数（JSON 对象）"><textarea className="textarea mono" aria-label="中间件参数" disabled={!!busy} style={{ minHeight: editing.builtin ? 210 : 100 }} value={optionsText} onChange={e => setOptionsText(e.target.value)} spellCheck={false} /></Field>
      {error && <div className="notice warning" role="alert">{error}</div>}
    </Modal>}
    {deleting && <Modal title={`删除「${deleting.name}」？`} sub="该插件的代码与参数会从云汇移除，其他插件不受影响。" onClose={() => !busy && setDeleting(null)} foot={<><Btn disabled={!!busy} onClick={() => setDeleting(null)}>取消</Btn><Btn variant="danger" disabled={!!busy} onClick={async () => { if (await mutate('delete', 'plugin.delete', { id: deleting.id }, '插件已删除')) setDeleting(null); }}>删除插件</Btn></>}><p style={{ color: 'var(--muted)' }}>需要保留时，可以先停用或复制代码。</p>{error && <div className="notice warning" role="alert">{error}</div>}</Modal>}
  </>;
}
