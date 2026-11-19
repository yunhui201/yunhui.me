import React, { useEffect, useRef, useState } from 'react';
import HistoryRepair from '../components/HistoryRepair';
import ContextCompactHint from '../components/ContextCompactHint';
import { defaultAutoCompactTokenLimit } from '../../../src/core/modelContext';
import type { PageProps } from '../App';
import { Btn, Empty, Field, Ico, Modal, Toggle, useToast } from '../components/ui';
import { call, isWebMode } from '../lib/api';

interface Asset { id: string; kind: 'plugin' | 'skill' | 'prompt' | 'mcp'; name: string; path?: string; description?: string; enabled: boolean; mutable?: boolean; }
interface Flag { key: string; label: string; type: string; hint: string; options?: string[]; }
const kinds = { skill: { label: 'Skills 技能', icon: 'bolt', hint: '发现本机已安装的 Codex 技能。', docs: 'https://github.com/openai/skills' }, mcp: { label: 'MCP 服务器', icon: 'plug', hint: '查看 Codex 已配置的工具服务。', docs: 'https://developers.openai.com/codex/mcp/' }, prompt: { label: '全局提示词', icon: 'chat', hint: '维护 AGENTS.md 中的工作约定。', docs: 'https://developers.openai.com/codex/guides/agents-md/' }, plugin: { label: '客户端插件', icon: 'puzzle', hint: '查看本机 ChatGPT / Codex 插件目录。', docs: 'https://developers.openai.com/codex/' } };

export default function CodexEnhance({ go }: PageProps) {
  const toast = useToast();
  const remote = isWebMode();
  const [tab, setTab] = useState<'assets' | 'diagnosis' | 'advanced'>('assets');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [flags, setFlags] = useState<{ flags: Record<string, string | undefined>; schema: Flag[] } | null>(null);
  const [flagDrafts, setFlagDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadingTabs, setLoadingTabs] = useState<Record<string, boolean>>({});
  const loading = !!loadingTabs[tab];
  const loaded = useRef(new Set<string>());
  const flights = useRef(new Map<string, Promise<void>>());
  const lifecycle = useRef(0);
  const alive = useRef(true);
  const [busy, setBusy] = useState('');
  const [search, setSearch] = useState('');
  const [editAgents, setEditAgents] = useState<string | null>(null);
  const [confirmRepair, setConfirmRepair] = useState(false);

  async function load(target = tab) {
    if (remote || !alive.current || target === 'diagnosis') return;
    const existing = flights.current.get(target);
    if (existing) return existing;
    const action = target === 'assets' ? 'codex.assets' : 'codex.flags', epoch = lifecycle.current;
    setLoadingTabs(previous => ({ ...previous, [target]: true }));
    let flight!: Promise<void>;
    flight = (async () => {
      try {
        const result = await call(action);
        if (!alive.current || lifecycle.current !== epoch) return;
        if (result?.ok === false) throw new Error(result.message || '读取失败，请重试');
        if (target === 'assets') setAssets(result.assets || []);
        else { setFlags({ flags: result.flags || {}, schema: result.schema || [] }); setFlagDrafts(Object.fromEntries(Object.entries(result.flags || {}).map(([key, value]) => [key, String(value ?? '')]))); }
        loaded.current.add(target);
        setErrors(previous => { const next = { ...previous }; delete next[action]; return next; });
      } catch (error: any) {
        if (alive.current && lifecycle.current === epoch) setErrors(previous => ({ ...previous, [action]: error.message || '读取失败，请重试' }));
      } finally {
        if (flights.current.get(target) === flight) flights.current.delete(target);
        if (alive.current && lifecycle.current === epoch) setLoadingTabs(previous => ({ ...previous, [target]: false }));
      }
    })();
    flights.current.set(target, flight);
    return flight;
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; lifecycle.current++; flights.current.clear(); loaded.current.clear(); }; }, []);
  useEffect(() => { if (!loaded.current.has(tab)) void load(tab); }, [tab]);
  async function perform(key: string, action: string, payload: unknown = {}, reload = true) {
    if (remote || busy) return;
    setBusy(key);
    try {
      const result = await call(action, payload);
      if (!alive.current) return null;
      if (result?.ok === false) throw new Error(result.message || '操作未完成');
      if (result?.message) toast.push(result.message, 'ok');
      if (reload) await load();
      return result;
    } catch (e: any) { if (alive.current) toast.push(e.message || '操作未完成', 'bad'); return null; }
    finally { if (alive.current) setBusy(''); }
  }
  async function editPrompt() { const r = await perform('prompt-read', 'codex.readAgents', {}, false); if (r) setEditAgents(r.text || ''); }
  async function saveFlag(f: Flag) {
    const value = (flagDrafts[f.key] || '').trim();
    if (value && f.type === 'number' && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) { toast.push('请输入大于 0 的整数，留空可恢复默认', 'bad'); return; }
    await perform(f.key, 'codex.setFlag', { key: f.key, value });
  }
  function flagUnchanged(f: Flag) {
    const draft = flagDrafts[f.key] || '';
    if (draft !== (flags?.flags[f.key] || '')) return false;
    if (f.key !== 'model_context_window') return true;
    const savedLimit = flags?.flags.model_auto_compact_token_limit;
    return draft.trim() ? defaultAutoCompactTokenLimit(Number(draft)) === Number(savedLimit) : !savedLimit?.trim();
  }
  return <>
    <div className="page-head"><div><div className="eyebrow">DESKTOP WORKSPACE</div><h1>桌面工作台</h1><p>管理本机扩展与工作约定，查看会话状态和客户端配置。</p></div><div className="actions"><Btn onClick={() => go('sessions')}><Ico name="chat" size={14} /> 历史会话</Btn><Btn disabled={remote || loading || !!busy || tab === 'diagnosis'} onClick={() => { void load(); }}><Ico name="refresh" size={14} /> {loading ? '检测中…' : '重新检测'}</Btn></div></div>
    {remote ? <div className="card"><Empty icon="⌘" title="在电脑客户端管理本地资源" hint="远程控制台不开放本机插件、提示词和数据库写入。请在电脑上的云汇 AI 打开此页；远程查看会话可使用「历史会话」。" /></div> : <>
      <div className="row" style={{ marginBottom: 20, gap: 8 }}>{([['assets', '资源库', 'puzzle'], ['diagnosis', '会话诊断', 'chat'], ['advanced', '高级设置', 'gear']] as const).map(([id, title, icon]) => <Btn key={id} variant={tab === id ? 'primary' : 'default'} onClick={() => setTab(id)}><Ico name={icon} size={14} /> {title}</Btn>)}</div>
      {tab === 'assets' && <>
        <div className="row" style={{ gap: 12, marginBottom: 18 }}><input className="input grow" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索本机资源名称或说明" aria-label="搜索 Codex 资源" style={{ maxWidth: 390 }} /><div className="grow" /><Btn disabled={!!busy} onClick={editPrompt}><Ico name="plus" size={14} /> 编辑全局提示词</Btn></div>
        {errors['codex.assets'] && <div className="notice warning" role="alert">资源读取失败：{errors['codex.assets']}</div>}
        <div className="grid cols-2">{(Object.entries(kinds) as Array<[Asset['kind'], typeof kinds.skill]>).map(([kind, meta]) => {
          const items = assets.filter(a => a.kind === kind && `${a.name} ${a.description || ''}`.toLowerCase().includes(search.toLowerCase()));
          return <div className="card" key={kind}>
            <div className="card-title"><Ico name={meta.icon} /><span>{meta.label}</span><span className="sub">{items.length} 个</span></div>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>{meta.hint}</p>
            {!items.length ? <div style={{ padding: '14px 0 22px', color: 'var(--muted)', fontSize: 12 }}>{loading ? '正在发现本地资源…' : search ? '没有匹配的资源。' : kind === 'plugin' ? '此处显示原客户端目录中的插件；云汇管理的插件请到插件中心查看。' : kind === 'prompt' ? '尚未创建全局提示词，可从右上角开始。' : '尚未发现已安装资源，可查看官方文档了解安装方式。'}</div> : <div className="list">{items.map(a => <div className="list-row" key={a.id}>
              <div className="grow"><strong className="ellipsis" title={a.name}>{a.name}</strong><div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, overflowWrap: 'anywhere' }}>{a.description || a.path}</div></div>
              {a.kind === 'prompt' ? <Btn size="sm" disabled={!!busy} onClick={editPrompt}>编辑</Btn> : a.mutable ? <fieldset disabled={!!busy} style={{ padding: 0, margin: 0, border: 0 }}><Toggle title={`启用${a.name}`} on={a.enabled} onChange={v => { void perform(a.id, 'codex.toggleAsset', { id: a.id, enabled: v }); }} /></fieldset> : <span className="chip">已发现</span>}
              {a.path && <Btn size="sm" variant="ghost" title="打开本地位置" disabled={!!busy} onClick={() => { void perform(a.id, 'app.openPath', { path: a.path }, false); }}><Ico name="ext" size={12} /></Btn>}
            </div>)}</div>}
            <div className="row wrap" style={{ marginTop: 15 }}><Btn size="sm" variant="ghost" disabled={!!busy} onClick={() => { void perform('docs', 'app.openExternal', { url: meta.docs }, false); }}><Ico name="ext" size={12} /> {kind === 'skill' ? '发现官方技能' : '官方使用文档'}</Btn>{kind === 'plugin' && <><Btn size="sm" disabled={!!busy} onClick={() => go('plugins')}>管理云汇插件 →</Btn><span className="hint">其他插件请在原客户端启停</span></>}</div>
          </div>;
        })}</div>
      </>}
      {tab === 'diagnosis' && <div className="card"><div className="card-title">历史会话批量修复</div><p>检查供应商归属、会话路径与原生消息索引。支持选择会话、预览改动、自动备份和按批次恢复。</p><Btn variant="primary" onClick={() => setConfirmRepair(true)}>打开批量修复</Btn></div>}
      {tab === 'advanced' && <>
        <div className="card" style={{ marginBottom: 18 }}><div className="card-title">Codex 配置<span className="sub">显式保存 · 备份原文件 · 重启后生效</span></div>
          <div className="notice">参数是否支持取决于 Codex 版本和当前模型。留空表示移除覆盖值，使用客户端默认设置。</div>
          {errors['codex.flags'] && <div className="notice warning">{errors['codex.flags']}</div>}
          <div className="grid cols-2">{flags?.schema.map(f => <Field key={f.key} label={f.label} hint={f.hint}><div className="row" style={{ gap: 8 }}>{f.type === 'enum' || f.type === 'bool' ? <select className="select grow" value={flagDrafts[f.key] || ''} onChange={e => setFlagDrafts({ ...flagDrafts, [f.key]: e.target.value })}><option value="">使用默认设置</option>{(f.type === 'bool' ? ['true', 'false'] : f.options || []).map(o => <option key={o} value={o}>{o}</option>)}</select> : <input className="input mono grow" inputMode="numeric" value={flagDrafts[f.key] || ''} onChange={e => setFlagDrafts({ ...flagDrafts, [f.key]: e.target.value })} placeholder="使用默认设置" />}<Btn size="sm" disabled={!!busy || flagUnchanged(f)} onClick={() => saveFlag(f)}>保存</Btn></div>{f.key === 'model_context_window' && <ContextCompactHint value={/^\d+$/.test(flagDrafts[f.key] || '') ? Number(flagDrafts[f.key]) : undefined} id="codex-context-compact-hint" />}</Field>)}</div>
        </div>
        <div className="card"><div className="card-title">桌面插件与市场</div><p>自动识别 ChatGPT 桌面版，连接后启用内置增强、拓展包和插件市场。</p><Btn onClick={() => go('plugins')}>前往插件中心 →</Btn></div>
      </>}
    </>}
    {editAgents !== null && <Modal title="AGENTS.md · 全局提示词" sub="写下团队约定、输出语言和常用命令。已有文件会先备份，作用范围由 Codex 的指令规则决定。" onClose={() => !busy && setEditAgents(null)} width={760} foot={<><Btn disabled={!!busy} onClick={() => setEditAgents(null)}>取消</Btn><Btn variant="primary" disabled={!!busy} onClick={async () => { if (await perform('prompt-save', 'codex.writeAgents', { text: editAgents })) setEditAgents(null); }}>保存提示词</Btn></>}><textarea className="textarea mono" style={{ minHeight: 320 }} value={editAgents} onChange={e => setEditAgents(e.target.value)} placeholder={'# 工作约定\n- 使用简体中文回答\n- 修改代码前先了解项目规范'} /></Modal>}
    {confirmRepair && <HistoryRepair onClose={() => setConfirmRepair(false)} onRepaired={() => load()} />}
  </>;
}
