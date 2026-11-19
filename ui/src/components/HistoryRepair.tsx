import React, { useEffect, useState } from 'react';
import { Btn, Empty, Field, Ico, Modal, useToast } from './ui';
import { call, fmtTime } from '../lib/api';

interface RepairItem {
  id: string; title?: string; path?: string; archived?: boolean;
  beforeProvider?: string; metadataProvider?: string; targetProvider?: string;
  changes?: string[]; status?: string; reason?: string;
}
interface RepairPreview {
  ok: boolean; message?: string; revision?: string; options?: any;
  summary?: Record<string, number>; items?: RepairItem[]; warnings?: string[];
  currentProvider?: string; dbPath?: string;
}
interface RepairBackup { id: string; createdAt: string; targetProvider?: string; sessions?: number; restoredAt?: string; path?: string; status?: string; }
interface ProviderRegions {
  ok: boolean; message?: string; currentProvider: string;
  targets: Array<{ id: string; name: string; current: boolean }>;
  sources: Array<{ id: string; count: number; active: number; archived: number }>;
  warnings?: string[];
}

export default function HistoryRepair({ onClose, onRepaired, initialSource = '' }: { onClose: () => void; onRepaired: () => void; initialSource?: string }) {
  const [kind, setKind] = useState<'provider' | 'index'>('provider');
  const [tab, setTab] = useState<'repair' | 'backups'>('repair');
  const [scope, setScope] = useState('all');
  const [targetProvider, setTargetProvider] = useState('');
  const [sourceProvider, setSourceProvider] = useState(initialSource);
  const [regions, setRegions] = useState<ProviderRegions | null>(null);
  const [regionsLoading, setRegionsLoading] = useState(true);
  const [regionsError, setRegionsError] = useState('');
  const [fixPaths, setFixPaths] = useState(true);
  const [preview, setPreview] = useState<RepairPreview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [backups, setBackups] = useState<RepairBackup[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<any>(null);
  const [query, setQuery] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [restore, setRestore] = useState<any>(null);
  const [restoreId, setRestoreId] = useState('');
  const toast = useToast();
  const prefix = kind === 'provider' ? 'codex.repair' : 'codex.indexRepair';
  const options = { scope, targetProvider: targetProvider.trim() || undefined, sourceProvider: sourceProvider.trim() || undefined, fixPaths };
  const items = preview?.items || [];
  const ready = items.filter(i => i.status === 'ready');
  const visible = items.filter(i => `${i.title || ''} ${i.id} ${i.beforeProvider || ''} ${i.path || ''}`.toLowerCase().includes(query.toLowerCase()));
  const visibleReady = visible.filter(i => i.status === 'ready');
  const selectedTarget = targetProvider || regions?.currentProvider || '';
  async function loadRegions() {
    setRegionsLoading(true); setRegionsError('');
    try {
      const r = await call<ProviderRegions>('codex.repair.providers');
      if (!r.ok) throw new Error(r.message || '无法读取本机历史区域');
      setRegions(r);
    } catch (e: any) { setRegionsError(e.message || '无法读取本机历史区域'); }
    finally { setRegionsLoading(false); }
  }
  useEffect(() => { void loadRegions(); }, []);
  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  }
  function reset() { setPreview(null); setResult(null); setPicked(new Set()); setConfirmed(false); setRestore(null); setError(''); }
  useEffect(reset, [kind, scope, targetProvider, sourceProvider, fixPaths]);
  async function scan() {
    const r = await call<RepairPreview>(`${prefix}.preview`, options);
    if (!r.ok) throw new Error(r.message || '无法生成修复预览');
    setPreview(r); setPicked(new Set((r.items || []).filter(i => i.status === 'ready').map(i => i.id))); setResult(null); setConfirmed(false);
  }
  async function loadBackups() {
    const r = await call(`${prefix}.backups`, {});
    if (!r.ok) throw new Error(r.message || '无法读取备份');
    setBackups(r.backups || []);
  }
  async function apply() {
    const ids = [...picked];
    const current = await call<RepairPreview>(`${prefix}.preview`, options);
    if (!current.ok || current.revision !== preview?.revision) throw new Error('会话文件或索引已发生变化，请重新扫描并确认修复方案。');
    const selected = await call<RepairPreview>(`${prefix}.preview`, { ...options, ids });
    if (!selected?.ok || !selected.revision) throw new Error(selected?.message || '请重新扫描修复方案');
    const expected = new Map((preview?.items || []).map(item => [item.id, item]));
    if (selected.items?.length !== ids.length || selected.items.some(item => !picked.has(item.id) || JSON.stringify(expected.get(item.id)) !== JSON.stringify(item))) throw new Error('所选会话在确认后发生变化，请重新扫描。');
    const r = await call(`${prefix}.apply`, { ...options, ...selected.options, ids, revision: selected.revision });
    if (!r.ok) throw new Error(r.message || '批量修复未完成');
    setResult(r); setPreview(null); setPicked(new Set()); setConfirmed(false); onRepaired(); void loadRegions();
    toast.push(r.message || '批量修复完成，备份已保留', 'ok');
  }
  async function prepareRestore(id: string) {
    const r = await call(`${prefix}.restorePreview`, { backupId: id });
    if (!r.ok) throw new Error(r.message || '无法恢复此备份');
    setRestore(r); setRestoreId(id);
  }
  async function restoreBackup() {
    const r = await call(`${prefix}.restore`, { backupId: restoreId, revision: restore.revision });
    if (!r.ok) throw new Error(r.message || '恢复失败');
    setRestore(null); setResult(r); await loadBackups(); onRepaired(); void loadRegions(); toast.push(r.message || '已恢复本批次修改', 'ok');
  }
  const summary = preview?.summary || {};
  return <Modal title="历史会话 · 批量修复" sub="ChatGPT 桌面版 / 原 Codex 的本地会话修复，先预览，再备份与执行。" onClose={() => !busy && onClose()} width={1040} foot={<>
    <Btn disabled={busy} onClick={onClose}>关闭</Btn>
    {tab === 'repair' && <Btn disabled={busy || (kind === 'provider' && (regionsLoading || !!regionsError || !regions?.targets.some(t => t.id === selectedTarget)))} onClick={() => run(scan)}><Ico name="search" size={14} />{busy ? '处理中…' : preview ? '重新扫描' : '扫描并预览'}</Btn>}
    {tab === 'repair' && preview && <Btn variant="primary" disabled={busy || !picked.size || !confirmed} onClick={() => run(apply)}><Ico name="shield" size={14} />{kind === 'provider' ? '备份并迁移所选' : '备份并修复所选'} ({picked.size})</Btn>}
    {tab === 'backups' && restore && <Btn variant="primary" disabled={busy || !!restore.conflicts?.length} onClick={() => run(restoreBackup)}>恢复本批次修改</Btn>}
  </>}>
    <div className="repair-toolbar"><div className="segments"><button className={kind === 'provider' ? 'selected' : ''} disabled={busy} onClick={() => { setKind('provider'); setTab('repair'); }}>供应商区域迁移</button><button className={kind === 'index' ? 'selected' : ''} disabled={busy} onClick={() => { setKind('index'); setTab('repair'); }}>原生会话索引</button></div><div className="grow" /><Btn size="sm" variant={tab === 'backups' ? 'primary' : 'default'} disabled={busy} onClick={() => { setTab(tab === 'backups' ? 'repair' : 'backups'); setRestore(null); if (tab !== 'backups') run(loadBackups); }}><Ico name="refresh" size={13} />{tab === 'backups' ? '返回修复' : '修复备份与恢复'}</Btn></div>
    {error && <div className="notice warning" role="alert">{error}</div>}
    {result && <div className="notice"><Ico name="check" size={18} /><div><b>{result.message || '操作已完成'}</b>{result.backup && <p className="mono">备份：{typeof result.backup === 'string' ? result.backup : result.backup.path || result.backup.id}</p>}</div></div>}
    {tab === 'repair' ? <>
      <div className="notice"><Ico name="chat" size={20} /><div><b>{kind === 'provider' ? '把不同 model_provider 的历史迁移到指定供应商区域' : '补全原生桌面会话的消息索引'}</b><p>{kind === 'provider' ? '选择来源和目标区域，同步会话文件、原生 threads 索引与本机目录。迁移后，在使用目标区域的客户端中查看；原对话内容、文件位置和归档状态保留。' : '根据本地对话中的完成事件与轮次信息修复索引；证据不足、未完成或格式不兼容的会话会跳过。'}</p></div></div>
      {kind === 'provider' && <>
        <div className="repair-toolbar"><b>本机历史区域</b><span className="hint">按原生索引归属统计 · 当前区域：{regions?.currentProvider || '读取中…'}</span><div className="grow" /><Btn size="sm" disabled={busy || regionsLoading} onClick={() => { reset(); void loadRegions(); }}>{regionsLoading ? '读取中…' : '刷新区域'}</Btn></div>
        {regionsError && <div className="notice warning" role="alert">{regionsError}</div>}
        {regions?.warnings?.map((w, i) => <div className="notice warning" key={i}>{w}</div>)}
        <div className="row wrap history-regions">{regions?.sources.map(s => <button key={s.id} disabled={busy || regionsLoading} className={`chip ${sourceProvider === s.id ? 'accent' : ''}`} onClick={() => setSourceProvider(s.id)} title={`未归档 ${s.active} · 已归档 ${s.archived}`}>{s.id} · {s.count}</button>)}</div>
      </>}
      <fieldset disabled={busy} className="repair-fields">
        <Field label="扫描范围"><select className="select" aria-label="修复扫描范围" value={scope} onChange={e => setScope(e.target.value)}><option value="all">全部历史（含归档）</option><option value="active">仅未归档</option><option value="archived">仅已归档</option></select></Field>
        {kind === 'provider' && <><Field label="从哪个区域迁移" hint="按原生索引筛选，已删除配置的旧区域也可迁出。"><select aria-label="原供应商筛选" className="select mono" disabled={regionsLoading || !!regionsError} value={sourceProvider} onChange={e => setSourceProvider(e.target.value)}><option value="">全部来源区域</option>{sourceProvider && !regions?.sources.some(s => s.id === sourceProvider) && <option value={sourceProvider}>{sourceProvider} · 暂无索引记录</option>}{regions?.sources.map(s => <option key={s.id} value={s.id}>{s.id} · {scope === 'active' ? s.active : scope === 'archived' ? s.archived : s.count} 个会话</option>)}</select></Field><Field label="迁移到哪个区域" hint="目标来自客户端配置中的 model_provider，不是模型名或云汇供应商 ID。"><select aria-label="目标供应商标识" className="select mono" disabled={regionsLoading || !!regionsError} value={targetProvider} onChange={e => setTargetProvider(e.target.value)}><option value="">当前区域{regions ? ` · ${regions.currentProvider}` : ''}</option>{targetProvider && !regions?.targets.some(t => t.id === targetProvider) && <option value={targetProvider} disabled>{targetProvider} · 已不在配置中</option>}{regions?.targets.map(t => <option key={t.id} value={t.id}>{t.name && t.name !== t.id ? `${t.name} · ` : ''}{t.id}{t.current ? '（当前）' : ''}</option>)}</select></Field><label className="checkbox-label"><input type="checkbox" checked={fixPaths} onChange={e => setFixPaths(e.target.checked)} />检查并修复失效的会话路径</label></>}
      </fieldset>
      {kind === 'provider' && selectedTarget && <p className="hint">计划：{sourceProvider || '全部来源区域'} → <b>{selectedTarget}</b>。{selectedTarget === 'openai' ? 'openai 也用于官方账号与中转共存，会话在该区域统一显示。' : '迁移不会自动切换客户端当前配置。'} 扫描后仍可逐条勾选。</p>}
      {preview && <>
        <div className="repair-stats">{[['scanned', '已扫描'], ['repairable', '可修复'], ['metadataChanges', '会话文件'], ['indexChanges', '索引记录'], ['pathChanges', '路径修复'], ['blocked', '需检查']].filter(([key]) => summary[key] !== undefined).map(([key, label]) => <div key={key}><strong>{summary[key]}</strong><small>{label}</small></div>)}</div>
        {preview.warnings?.map((w, i) => <div className="notice warning" key={i}>{w}</div>)}
        <div className="repair-toolbar"><label className="checkbox-label"><input type="checkbox" checked={visibleReady.length > 0 && visibleReady.every(i => picked.has(i.id))} disabled={!visibleReady.length || busy} onChange={e => { const checked = e.target.checked; setPicked(previous => { const next = new Set(previous); for (const item of visibleReady) { if (checked) next.add(item.id); else next.delete(item.id); } return next; }); }} />选择当前结果中的可处理会话</label><span className="muted">已选 {picked.size} / {ready.length}{picked.size > visibleReady.filter(i => picked.has(i.id)).length ? `（含 ${picked.size - visibleReady.filter(i => picked.has(i.id)).length} 个搜索外的会话）` : ''}</span><Btn size="sm" disabled={busy || !picked.size} onClick={() => { setPicked(new Set()); setConfirmed(false); }}>清空选择</Btn><div className="grow" /><input className="input" style={{ width: 250 }} aria-label="搜索修复会话" placeholder="搜索标题、ID、路径…" value={query} onChange={e => setQuery(e.target.value)} /></div>
        <div className="repair-table"><table className="tbl"><thead><tr><th style={{ width: 32 }} /><th>会话</th><th>当前归属</th>{kind === 'provider' && <th>迁移目标</th>}<th>计划修改</th><th>状态</th></tr></thead><tbody>{visible.map((item, index) => <tr key={item.id + index}><td><input type="checkbox" aria-label={`修复 ${item.title || item.id}`} checked={picked.has(item.id)} disabled={item.status !== 'ready' || busy} onChange={e => setPicked(v => { const n = new Set(v); e.target.checked ? n.add(item.id) : n.delete(item.id); return n; })} /></td><td><b>{item.title || item.id}</b><small className="repair-path" title={item.path}>{item.path || item.id}</small>{item.archived && <span className="chip">归档</span>}</td><td className="mono">{item.beforeProvider || item.metadataProvider || '—'}{item.beforeProvider && item.metadataProvider && item.beforeProvider !== item.metadataProvider && <small className="repair-path">文件记录：{item.metadataProvider}</small>}</td>{kind === 'provider' && <td className="mono">→ {item.targetProvider || selectedTarget}</td>}<td>{item.changes?.join(' · ') || '无需修改'}{item.reason && <small className="repair-path">{item.reason}</small>}</td><td><span className={`chip ${item.status === 'ready' ? 'ok' : item.status === 'blocked' ? 'warn' : ''}`}>{item.status === 'ready' ? '可修复' : item.status === 'blocked' ? '跳过' : '正常'}</span></td></tr>)}</tbody></table>{!visible.length && <Empty icon="✓" title="没有需要修复的会话" hint="可以调整扫描范围，或检查客户端的本地数据目录。" />}</div>
        <label className="checkbox-label repair-confirm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已保存工作并退出 ChatGPT 桌面版及使用此会话库的命令行客户端。</label>
      </>}
      {!preview && !result && <div className="repair-start"><Ico name="shield" size={29} /><h3>先看看哪些会话需要修复</h3><p>扫描只读。你可以勾选会话；执行前自动备份，修复后可按批次恢复。</p><span className="hint">此功能不解密其他账号的上下文，也不补回已经丢失的对话文件。</span></div>}
    </> : <>
      <div className="notice">只回退所选批次的修改。修复之后又被其他程序改动的文件会列为冲突，保留现状。</div>
      {!backups.length ? <Empty icon="↶" title="还没有修复备份" hint="每次批量修复前会自动创建一个备份批次。" /> : <div className="list">{backups.map(b => <div className="list-row" key={b.id}><div className="grow"><b>{fmtTime(b.createdAt)}</b><div className="hint">{b.sessions ?? '—'} 个会话 · {b.targetProvider || '会话索引'} · {b.id}</div></div><span className={`chip ${b.status === 'restored' ? 'ok' : ''}`}>{b.status === 'restored' || b.restoredAt ? '已恢复' : b.status === 'interrupted' ? '中断批次' : '已备份'}</span><Btn size="sm" disabled={busy || !!b.restoredAt || b.status === 'restored'} onClick={() => run(() => prepareRestore(b.id))}>预览恢复</Btn></div>)}</div>}
      {restore && <div className="card" style={{ marginTop: 18 }}><div className="card-title">恢复预览</div><p>{restore.message || `将撤回备份 ${restoreId} 对应的修改。`}</p>{restore.conflicts?.length ? <div className="notice warning">检测到冲突：{restore.conflicts.map((v: any) => typeof v === 'string' ? v : v.path || v.reason || v.id).join('；')}</div> : <div className="notice">没有检测到冲突，可以恢复本批次。</div>}</div>}
    </>}
  </Modal>;
}
