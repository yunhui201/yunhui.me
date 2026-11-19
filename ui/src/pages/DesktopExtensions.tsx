import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Btn, Empty, Field, Ico, Modal, Toggle, useToast } from '../components/ui';
import { call } from '../lib/api';
import { extensionSnapshot, type ExtensionItem } from '../lib/extensionSnapshot';
import '../styles/extension-connection-recovery.css';

type MarketSource = 'public' | 'full';
interface MarketRefreshResult {
  source: MarketSource; ok: boolean; sourceType: 'remote' | 'cache' | 'builtin';
  message?: string; count?: number; fetchedAt?: string;
}
interface MarketRefreshResponse { ok: boolean; message?: string; warning?: string; results?: MarketRefreshResult[] }
interface MarketSyncState { source?: MarketSource; pending: boolean; complete: boolean; message: string; warning?: string; results: MarketRefreshResult[] }
const SOURCES: Record<string, string> = { all: '全部插件', builtin: '内置增强', bundled: '官方拓展包', public: '公开市场', full: '完整索引', installed: '已安装' };
const STATUS: Record<string, string> = { available: '可安装', installed: '已安装', active: '已生效', 'needs-connection': '等待连接', unsupported: '暂不兼容', error: '运行异常' };
const packageLimitations = (id: string) => id === 'bundled:agent-pet' ? '支持随附图片、动图与音效。自定义音效导入、大肥鱼余额及专项统计尚未接入。' : '';
const PACKAGE_DESCRIPTIONS: Record<string, string> = {
  'bundled:agent-pet': '在桌面客户端显示图片或动图桌宠，支持按压互动与内置音效。',
  'bundled:proxy-request-status': '请求经过云汇网关时，在桌面客户端输入框上方显示发送、等待、重试和生成进度。停用后不再显示或查询请求状态。',
};
const packageDescription = (item: ExtensionItem) => PACKAGE_DESCRIPTIONS[item.id] || item.description;
const unsupportedPetField = (key: string) => /^codexAppWhaleBalance/.test(key) || ['customSoundPress', 'customSoundRelease'].includes(key);
function syncMessage(value: unknown): string {
  const message = typeof value === 'string' ? value : value instanceof Error ? value.message : '';
  if (/[\u3400-\u9fff]/.test(message)) return message;
  if (/timeout|timed out|超时/i.test(message)) return '连接插件市场超时，请检查网络或代理后重试。';
  if (/abort/i.test(message)) return '同步请求已中断，请稍后重试。';
  if (/fetch failed|failed to fetch|network error|ECONN|ENOTFOUND/i.test(message)) return '暂时无法连接插件市场，请检查网络或代理后重试。';
  return message || '暂时无法更新插件市场，请稍后重试。';
}

export default function DesktopExtensions() {
  const store = extensionSnapshot();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const state = snapshot.data, loading = snapshot.loading, listError = snapshot.error;
  const [source, setSource] = useState('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [recoveryError, setRecoveryError] = useState('');
  const [resetError, setResetError] = useState('');
  const [connectionNotice, setConnectionNotice] = useState('');
  const [resetConnectionOpen, setResetConnectionOpen] = useState(false);
  const [sync, setSync] = useState<MarketSyncState | null>(null);
  const [busy, setBusy] = useState('');
  const blocked = !!busy || snapshot.mutating;
  const operation = useRef('');
  const alive = useRef(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [path, setPath] = useState('');
  const [port, setPort] = useState(9222);
  const [editing, setEditing] = useState<ExtensionItem | null>(null);
  const [config, setConfig] = useState('');
  const [detail, setDetail] = useState<ExtensionItem | null>(null);
  const [visibleCount, setVisibleCount] = useState(60);
  const [acknowledgeVersion, setAcknowledgeVersion] = useState(false);
  const desktop = !!window.aurora;
  const toast = useToast();
  async function load(clearError = true, force = true) {
    const result = await store.refresh(force);
    if (alive.current && result && clearError) setError('');
    return result;
  }
  useEffect(() => { alive.current = true; void store.refresh(); return () => { alive.current = false; }; }, [store]);
  useEffect(() => setVisibleCount(60), [source, query]);
  useEffect(() => setAcknowledgeVersion(false), [state?.client?.version]);
  async function action(name: string, payload: any = {}, id = name) {
    if (!desktop || operation.current || !alive.current) return;
    operation.current = id;
    setBusy(id); setError('');
    try {
      const r = await store.mutate(name, payload);
      if (!alive.current) return null;
      if (r?.ok === false) throw new Error(r.message || '操作未完成');
      if (name === 'extension.connect') { setConnectionError(''); setRecoveryError(''); setConnectionNotice(''); }
      await load(false, false);
      if (alive.current) toast.push(r.message || '操作已保存，请查看插件状态', 'ok'); return alive.current ? r : null;
    } catch (e: any) { if (!alive.current) return null; const message = e.message || String(e); await load(false, false); if (!alive.current) return null; if (name === 'extension.connect') setConnectionError(message); else setError(message); return null; }
    finally { operation.current = ''; if (alive.current) setBusy(''); }
  }
  async function refreshMarkets(target?: MarketSource) {
    if (operation.current || !alive.current) return;
    operation.current = 'extension.refresh'; setBusy('extension.refresh');
    setSync({ source: target, pending: true, complete: false, message: `正在同步${target ? SOURCES[target] : '公开市场与完整索引'}…`, results: [] });
    try {
      const response = await store.mutate('extension.refresh', target ? { source: target } : {}) as MarketRefreshResponse;
      if (!alive.current) return;
      const results = Array.isArray(response.results) ? response.results : [];
      const expected: MarketSource[] = target ? [target] : ['public', 'full'];
      const complete = response.ok === true && !response.warning && expected.every(source => results.some(result => result.source === source && result.ok && result.sourceType === 'remote'));
      const updated = results.some(result => result.ok && result.sourceType === 'remote');
      setSync({ source: target, pending: false, complete, results,
        message: complete ? '市场索引已同步' : updated ? '部分市场索引已更新' : '市场索引暂未更新',
        warning: !complete && !results.length ? '未收到完整同步结果，已保留当前插件列表。' : response.warning ? syncMessage(response.warning) : !complete && response.message ? syncMessage(response.message) : undefined });
      const loaded = await load(false, false);
      if (alive.current && complete && loaded) toast.push('市场索引已同步', 'ok');
    } catch (e: unknown) {
      if (alive.current) setSync({ source: target, pending: false, complete: false, message: '市场索引同步失败', warning: syncMessage(e), results: [] });
    } finally { operation.current = ''; if (alive.current) setBusy(''); }
  }
  const list = useMemo(() => (state?.items || []).filter(i => (source === 'all' || source === 'installed' ? source !== 'installed' || i.installed : i.source === source) && `${i.name} ${i.description} ${i.id} ${(i.tags || []).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => Number(b.id === 'builtin:plugin-market-unlock') - Number(a.id === 'builtin:plugin-market-unlock')), [state, source, query]);
  const counts = (state?.items || []).reduce<Record<string, number>>((v, i) => { v[i.source] = (v[i.source] || 0) + 1; if (i.installed) v.installed = (v.installed || 0) + 1; return v; }, {});
  const detecting = !state || loading || !!listError || snapshot.mutating || !!state.client.detecting || !!state.runtime.checking;
  const detectionLabel = listError && !loading && !snapshot.mutating ? '连接状态待确认' : '正在检测连接';
  const connected = !detecting && !!state?.runtime?.connected;
  const unlock = state?.items.find(item => item.id === 'builtin:plugin-market-unlock');
  const errors = detecting ? [] : state?.runtime?.errors || [];
  const runtimeConnectionError = errors.find(item => typeof item !== 'string' && item.id === 'runtime');
  const connectionProblem = connectionError || (runtimeConnectionError ? runtimeConnectionError.message || runtimeConnectionError.error || '桌面增强连接异常' : '')
    || (!detecting && !connected && state && (!state.client.installed || state.client.compatible === false) ? state.client.message || '尚未找到可连接的桌面客户端，请选择已安装的程序。' : '');
  const needsVersionConfirmation = !!state?.client?.versionChanged && !acknowledgeVersion;
  async function chooseProgram() {
    if (!desktop || operation.current) return;
    operation.current = 'agent.desktop.select'; setBusy(operation.current);
    try {
      const result = await store.mutate('agent.desktop.select', { agentId: 'chatgpt-desktop' });
      if (!alive.current) return;
      if (result?.canceled) return;
      if (!result?.ok) throw new Error(result?.message || '程序选择未完成，请重新选择桌面主程序。');
      if (connectionProblem) setConnectionError(connectionProblem);
      setRecoveryError('');
      const refreshed = await load(false, false);
      if (!alive.current) return;
      if (refreshed) setPath(refreshed.connection.exePath || '');
      setConnectionNotice('程序路径已保存。请保存桌面客户端中的工作，再点击重新连接。');
    } catch (e: any) { if (alive.current) { setRecoveryError(e.message || '无法选择程序，请重试。'); await load(false, false); } }
    finally { operation.current = ''; if (alive.current) setBusy(''); }
  }
  async function restoreConnectionDefaults() {
    if (!desktop || operation.current) return;
    operation.current = 'extension.configure'; setBusy(operation.current);
    try {
      const result = await store.mutate('extension.configure', { exePath: '', port: 9222 });
      if (!alive.current) return;
      if (!result?.ok) throw new Error(result?.message || '默认连接设置未能保存，请重试。');
      if (connectionProblem) setConnectionError(connectionProblem);
      setPath(''); setPort(9222); setRecoveryError(''); setResetError(''); setResetConnectionOpen(false);
      await load(false, false);
      if (!alive.current) return;
      setConnectionNotice('已恢复自动检测程序，调试端口为 9222。请保存桌面客户端中的工作，再点击重新连接。');
    } catch (e: any) { if (alive.current) { setResetError(e.message || '无法恢复默认连接设置，请重试。'); await load(false, false); } }
    finally { operation.current = ''; if (alive.current) setBusy(''); }
  }
  function reconnect() {
    if (!desktop || operation.current || detecting || needsVersionConfirmation) return;
    void action('extension.connect', { launch: true, acknowledgeVersion });
  }
  function editConfig(item: ExtensionItem) { setError(''); setEditing(item); setConfig(JSON.stringify(item.config || {}, null, 2)); }
  function changeConfig(key: string, value: any) { try { setConfig(JSON.stringify({ ...JSON.parse(config), [key]: value }, null, 2)); } catch { toast.push('请先修正 JSON 配置格式', 'bad'); } }
  async function chooseImage(key: string) {
    setError('');
    try { const result = await call('app.chooseImage'); if (!alive.current) return; if (result.ok) changeConfig(key, result.path); else if (result.message) throw new Error(result.message); }
    catch (e: any) { if (alive.current) setError(e.message || '无法选择图片，请重试'); }
  }
  async function connectUnlock() {
    if (!unlock || operation.current || detecting || unlock.status === 'unsupported') return;
    if (!unlock.installed && !await action('extension.install', { id: unlock.id }, unlock.id)) return;
    if (!unlock.enabled && !await action('extension.toggle', { id: unlock.id, enabled: true }, unlock.id)) return;
    if (!connected) await action('extension.connect', { launch: true, acknowledgeVersion });
    else await load();
  }
  return <>
    {!desktop ? <div className="notice"><Ico name="puzzle" size={20} /><div><b>请在电脑上管理桌面插件</b><p>桌面插件会在 ChatGPT 桌面版运行，安装、启用与连接需要电脑端操作。</p></div></div> : <>
      {unlock && <section className="extension-banner market-unlock-feature" aria-label="插件市场解锁快捷入口">
        <div className="grow"><div className="row wrap"><h3>插件市场解锁</h3><span className={`chip ${!detecting && unlock.status === 'active' ? 'ok' : ''}`}>{detecting ? detectionLabel : STATUS[unlock.status] || unlock.status}</span></div><p>{detecting ? '插件目录已就绪，正在确认桌面连接与兼容性。可先浏览和搜索插件。' : unlock.status === 'active' ? '桌面插件入口已生效，可以浏览市场并安装需要的插件。' : unlock.status === 'unsupported' ? unlock.reason || '此客户端版本暂不兼容，请查看下方兼容提示。' : unlock.enabled ? '开关已开启。连接桌面客户端后才会生效；请保存工作并退出已运行的客户端，再点击启动并连接。' : '启用后连接桌面客户端，开放插件入口并浏览公开市场与完整索引。'}</p><p>插件需要的服务账号由对应服务授权。</p></div>
        <div className="connection-buttons"><Btn variant="primary" disabled={blocked || detecting || unlock.status === 'unsupported' || (!connected && !!state?.client?.versionChanged && !acknowledgeVersion)} onClick={() => { if (unlock.status === 'active') { setQuery(''); setSource('public'); } else void connectUnlock(); }}>{detecting ? detectionLabel : unlock.status === 'active' ? '浏览插件市场' : connected ? '启用插件市场' : unlock.enabled ? '启动并连接' : '启用并连接'}</Btn></div>
      </section>}
      <div className="desktop-connection">
        <div className="desktop-connection-icon"><Ico name="puzzle" size={28} /></div>
        <div className="grow"><div className="row"><h2>ChatGPT 桌面版插件</h2><span className={`chip ${connected ? 'ok' : ''}`}>{detecting ? detectionLabel : connected ? '已连接桌面' : state?.client?.installed ? '已发现客户端' : '等待检测'}</span></div><p>{detecting ? listError ? '连接状态暂时无法确认，可继续浏览插件并刷新重试。' : '正在后台确认客户端与插件状态，可继续浏览或切换页面。' : state?.client?.message || (connected ? '已连接本机桌面客户端，可挂载扩展与解锁插件入口。' : '自动识别 ChatGPT、ChatGPT Beta 及原 Codex 桌面版。连接后启用插件。')}</p><div className="row wrap"><span className="hint">{state?.client?.version ? `客户端 ${state.client.version}` : '版本待检测'}</span>{state?.client?.exePath && <span className="mono ellipsis hint" style={{ maxWidth: 440 }} title={state.client.exePath}>{state.client.exePath}</span>}</div></div>
        <div className="connection-buttons"><Btn size="sm" disabled={blocked} onClick={() => { setError(''); setPath(state?.connection?.exePath || state?.client?.exePath || ''); setPort(state?.connection?.port || 9222); setSettingsOpen(true); }}><Ico name="gear" size={13} />连接设置</Btn><Btn variant="primary" disabled={blocked || detecting || (!connected && !!state?.client?.versionChanged && !acknowledgeVersion)} onClick={() => action(connected ? 'extension.disconnect' : 'extension.connect', { launch: true, acknowledgeVersion })}><Ico name={connected ? 'stop' : 'plug'} size={14} />{busy === 'extension.connect' ? '连接中…' : detecting ? detectionLabel : connected ? '断开连接' : '启动并连接'}</Btn></div>
      </div>
      {!detecting && state?.client?.versionChanged && (!connected || !!connectionProblem) && <div className="notice warning"><label className="checkbox-label"><input type="checkbox" disabled={blocked} checked={acknowledgeVersion} onChange={e => setAcknowledgeVersion(e.target.checked)} />客户端已更新到 {state.client.version}。确认重新检测插件兼容性并连接此版本。</label></div>}
      {(connectionProblem || recoveryError || connectionNotice) && <section className="extension-connection-recovery notice warning" aria-label="桌面插件连接处理">
        <div className="grow"><b>{connectionProblem ? '桌面插件尚未连接成功' : recoveryError ? '连接设置需要处理' : '连接设置已更新'}</b>{connectionProblem && <p role="alert">{connectionProblem}</p>}
          {recoveryError && !resetConnectionOpen && <p role="alert">{recoveryError}</p>}{connectionNotice && <p role="status">{connectionNotice}</p>}
          <p className="hint">Windows 请选择 .exe 主程序，macOS 请选择完整 .app 应用包。重连前请保存工作；如果客户端正在普通模式运行，请先完全退出。</p>
        </div>
        <div className="extension-recovery-actions"><Btn size="sm" disabled={blocked} onClick={() => { void chooseProgram(); }}><Ico name="search" size={13} />{busy === 'agent.desktop.select' ? '选择中…' : '选择程序'}</Btn>
          <Btn size="sm" variant="primary" disabled={blocked || detecting || needsVersionConfirmation} onClick={reconnect}><Ico name="refresh" size={13} />{busy === 'extension.connect' ? '连接中…' : '重新连接'}</Btn>
          <Btn size="sm" disabled={blocked} onClick={() => { setResetError(''); setResetConnectionOpen(true); }}>恢复默认连接设置</Btn>
        </div>
      </section>}
      {error && !editing && !settingsOpen && !detail && <div className="notice warning" role="alert">{error}<div className="grow" /><Btn size="sm" disabled={blocked} onClick={load}>重新检测</Btn></div>}
      {listError && <div className="notice warning" role="alert">插件列表刷新失败：{listError}<div className="grow" /><Btn size="sm" disabled={blocked || loading} onClick={() => load(false)}>刷新列表</Btn></div>}
      {errors.length > 0 && <details className="notice warning" style={{ display: 'block' }}><summary>有 {errors.length} 个扩展未能生效，查看原因</summary>{errors.map((e, i) => <p key={i}>{typeof e === 'string' ? e : `${e.id || e.name || ''}：${e.message || e.error || '运行失败'}`}</p>)}</details>}
      <div className="extension-banner"><div><div className="eyebrow">云汇桌面扩展</div><h3>为你的桌面工作空间添加更多能力</h3><p>管理内置增强、拓展包与市场插件，查看兼容状态和实际运行结果。</p></div><div className="extension-totals"><div><strong>{counts.builtin || 0}</strong><small>内置增强</small></div><div><strong>{counts.bundled || 0}</strong><small>拓展包</small></div><div><strong>{counts.installed || 0}</strong><small>已安装</small></div></div></div>
      <div className="filter-bar"><div className="segments">{Object.entries(SOURCES).map(([id, label]) => <button key={id} className={source === id ? 'selected' : ''} onClick={() => setSource(id)}>{label}{id !== 'all' && counts[id] ? ` ${counts[id]}` : ''}</button>)}</div></div>
      <div className="repair-toolbar"><div className="search-input"><Ico name="search" size={14} /><input aria-label="搜索桌面插件" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索插件名称、功能或标签…" style={{ width: 240 }} /></div><span className="muted">{list.length} 项</span><div className="grow" /><Btn size="sm" disabled={blocked} onClick={() => refreshMarkets(source === 'full' || source === 'public' ? source : undefined)}><Ico name="cloud" size={13} />{busy === 'extension.refresh' ? '同步中…' : '同步市场索引'}</Btn><Btn size="sm" disabled={blocked || loading} onClick={load}><Ico name="refresh" size={13} />刷新状态</Btn></div>
      {sync && <div className={`notice ${!sync.pending && !sync.complete ? 'warning' : ''}`} role={!sync.pending && !sync.complete ? 'alert' : 'status'} aria-label="市场同步状态" style={{ alignItems: 'flex-start' }}>
        <div className="grow"><b>{sync.source ? SOURCES[sync.source] : '公开市场与完整索引'} · {sync.message}</b>{sync.warning && <p>{sync.warning}</p>}
          {sync.results.map(result => <p key={result.source}><b>{SOURCES[result.source]}：</b>{result.ok && result.sourceType === 'remote' ? '已更新远端索引' : result.sourceType === 'cache' ? '使用本地缓存' : result.sourceType === 'builtin' ? '使用随附离线索引' : '暂未更新'}{typeof result.count === 'number' ? ` · ${result.count} 项` : ''}{result.fetchedAt && Number.isFinite(Date.parse(result.fetchedAt)) ? ` · 缓存时间 ${new Date(result.fetchedAt).toLocaleString('zh-CN', { hour12: false })}` : ''}{result.message ? ` · ${syncMessage(result.message)}` : ''}</p>)}
          {!sync.complete && <p>{sync.pending ? '同步期间可继续浏览当前插件列表。' : '已保留可用的本地索引和当前插件列表，可继续浏览已有条目。'}</p>}
        </div>
        {!sync.pending && !sync.complete && <Btn size="sm" disabled={blocked} onClick={() => refreshMarkets(sync.source)}>重试同步</Btn>}
      </div>}
      {loading && !state ? <div className="client-grid">{[1, 2, 3].map(i => <div className="skeleton" style={{ height: 230 }} key={i} />)}</div> : <div className="client-grid extension-grid">{list.slice(0, visibleCount).map(item => <article className={`extension-card ${item.enabled ? 'enabled' : ''}`} key={item.id}>
        <div className="row"><span className={`extension-icon source-${item.source}`}><Ico name={item.source === 'builtin' ? 'bolt' : item.source === 'bundled' ? 'puzzle' : 'cube'} size={23} /></span><div className="grow" /><span className={`chip ${detecting ? '' : item.status === 'active' ? 'ok' : item.status === 'error' || item.status === 'unsupported' ? 'warn' : ''}`}>{detecting ? item.enabled ? '状态待确认' : item.installed ? '已安装' : '目录可用' : STATUS[item.status] || item.status}</span></div>
        <h3>{item.name}</h3><p className="extension-description" title={packageDescription(item)}>{packageDescription(item) || '暂无插件描述'}</p>
        <div className="tag-list"><span className="chip">{SOURCES[item.source]}</span>{item.version && <span className="chip">v{item.version}</span>}{item.updateAvailable && <span className="chip accent">可更新至 {item.availableVersion || '新版本'}</span>}{item.catalogMissing && <span className="chip">目录已下架</span>}{item.missingFiles && <span className="chip warn">文件缺失</span>}{item.requiresAuth && <span className="chip">需服务授权</span>}{item.requiresRestart && <span className="chip">重启生效</span>}</div>
        {!detecting && item.reason && <p className="extension-reason">{item.reason}</p>}
        {!detecting && item.id === 'builtin:plugin-market-unlock' && item.status === 'needs-connection' && <p className="extension-reason">已开启，尚未连接桌面；使用页面顶部的“启动并连接”完成应用。</p>}
        {packageLimitations(item.id) && <p className="extension-reason">{packageLimitations(item.id)}</p>}
        <div className="extension-card-actions"><button className="text-button" disabled={blocked} onClick={() => { setError(''); setDetail(item); }}>详情与来源 ↗</button><div className="grow" />{item.installed ? <>
          {(item.updateAvailable || item.missingFiles) && !item.catalogMissing && <Btn size="sm" disabled={blocked || detecting} onClick={() => action('extension.install', { id: item.id }, item.id)}>{busy === item.id ? '安装中…' : item.missingFiles ? '修复安装' : '更新'}</Btn>}
          <Btn size="sm" disabled={blocked || item.status === 'unsupported'} onClick={() => { if (item.source === 'public' || item.source === 'full') { setError(''); setDetail(item); } else editConfig(item); }}>{item.source === 'public' || item.source === 'full' ? '管理' : '设置'}</Btn><Toggle title={`启用 ${item.name}`} disabled={blocked || detecting || ((item.status === 'unsupported' || item.missingFiles) && !item.enabled)} on={item.enabled} onChange={enabled => action('extension.toggle', { id: item.id, enabled }, item.id)} /></> : <Btn variant="primary" size="sm" disabled={blocked || detecting || item.status === 'unsupported' || item.catalogMissing} onClick={() => action('extension.install', { id: item.id }, item.id)}><Ico name="plus" size={12} />{busy === item.id ? '安装中…' : '安装'}</Btn>}</div>
      </article>)}</div>}
      {!loading && state && !listError && !list.length && <Empty icon="⌕" title="没有匹配的插件" hint="试试功能名称，或同步市场索引。" />}
      {list.length > visibleCount && <div className="page-footnote"><Btn onClick={() => setVisibleCount(v => v + 60)}>加载更多（剩余 {list.length - visibleCount} 项）</Btn></div>}
    </>}
    {settingsOpen && <Modal title="连接 ChatGPT 桌面版" sub="仅连接本机桌面客户端的调试接口。应用版本更新后会重新检测兼容性。" onClose={() => !blocked && setSettingsOpen(false)} foot={<>
      <Btn disabled={blocked} onClick={() => setSettingsOpen(false)}>取消</Btn>
      <Btn disabled={blocked} variant="primary" onClick={async () => { if (await action('extension.configure', { exePath: path.trim(), port: Number(port) })) setSettingsOpen(false); }}>保存连接设置</Btn>
    </>}>
      {error && <div className="notice warning" role="alert">{error}</div>}
      {recoveryError && <div className="notice warning" role="alert">{recoveryError}</div>}
      <Field label="客户端程序路径" hint="留空自动识别。通过选择器选中的程序路径会立即保存；Windows 选择 .exe，macOS 选择完整 .app 应用包。"><div className="row"><input className="input mono grow" aria-label="桌面客户端路径" disabled={blocked} value={path} onChange={e => setPath(e.target.value)} placeholder="自动检测" /><Btn disabled={blocked} onClick={() => { void chooseProgram(); }}>选择程序</Btn></div></Field>
      <Field label="本机调试端口"><input className="input" aria-label="桌面调试端口" type="number" min={1024} max={65535} disabled={blocked} value={port} onChange={e => setPort(Number(e.target.value))} /></Field>
      <div className="notice">如果客户端正在以普通方式运行，请先保存工作并完全退出，再点击「启动并连接」。连接成功不代表所有版本都兼容每一项增强，具体状态会显示在插件卡片上。</div>
    </Modal>}
    {resetConnectionOpen && desktop && <Modal title="恢复默认连接设置" sub="将程序路径改为自动检测，并将本机调试端口恢复为 9222。" onClose={() => !blocked && setResetConnectionOpen(false)} foot={<>
      <Btn disabled={blocked} onClick={() => setResetConnectionOpen(false)}>取消</Btn>
      <Btn variant="primary" disabled={blocked} onClick={() => { void restoreConnectionDefaults(); }}>{busy === 'extension.configure' ? '恢复中…' : '确认恢复'}</Btn>
    </>}>
      <p>已安装插件、插件配置、账号和客户端文件都会保留。当前增强连接会断开，桌面程序不会自动退出或重新启动。</p>
      <p className="hint">保存后请先保存桌面客户端中的工作，再点击重新连接。</p>
      {resetError && <div className="notice warning" role="alert">{resetError}</div>}
    </Modal>}
    {editing && <Modal title={`${editing.name} · 插件设置`} sub={editing.source === 'builtin' ? '保存后应用设置。内置增强可以停用，不能移除。' : '保存后应用设置；移除会停用此拓展包。'} onClose={() => !blocked && setEditing(null)} foot={<>
      {editing.source !== 'builtin' && <Btn variant="danger" disabled={blocked} onClick={async () => { if (!confirm(`移除插件「${editing.name}」？`)) return; if (await action('extension.remove', { id: editing.id }, editing.id)) setEditing(null); }}>移除插件</Btn>}
      <div className="grow" /><Btn disabled={blocked} onClick={() => setEditing(null)}>取消</Btn>
      <Btn variant="primary" disabled={blocked} onClick={async () => {
        try {
          const value = JSON.parse(config);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('配置必须是 JSON 对象');
          if (await action('extension.config', { id: editing.id, config: value }, editing.id)) setEditing(null);
        } catch (e: any) { setError(e instanceof SyntaxError ? '配置不是有效 JSON，请检查引号、逗号和括号。' : e.message); }
      }}>保存设置</Btn>
    </>}>
      {error && <div className="notice warning" role="alert">{error}</div>}
      {packageLimitations(editing.id) && <div className="notice">{packageLimitations(editing.id)}</div>}
      {Object.entries(editing.configSchema || {}).filter(([key]) => editing.id !== 'bundled:agent-pet' || !unsupportedPetField(key)).map(([key, rawField]: [string, any]) => {
        const field = editing.id === 'bundled:agent-pet' && key === 'soundSet' ? { ...rawField, type: 'select', options: [{ value: 'duck', label: '鸭子音效' }, { value: 'fx1', label: '特效音效' }] } : rawField;
        const label = field.title || field.label || key;
        let value: any; try { value = JSON.parse(config)[key] ?? field.default; } catch { value = field.default; }
        return <Field key={key} label={label} hint={field.description}>
          {field.type === 'boolean' || field.type === 'bool' ? <Toggle disabled={blocked} title={label} on={!!value} onChange={v => changeConfig(key, v)} />
            : field.type === 'select' ? <select className="select" aria-label={label} disabled={blocked} value={String(value ?? '')} onChange={e => changeConfig(key, e.target.value)}>
              {(field.options || []).map((o: any) => <option key={typeof o === 'string' ? o : o.value} value={typeof o === 'string' ? o : o.value}>{typeof o === 'string' ? o : o.label || o.value}</option>)}
            </select> : <div className="row">
              <input className="input grow" aria-label={label} disabled={blocked} type={field.type === 'number' ? 'number' : 'text'} step={field.type === 'number' ? 'any' : undefined} min={field.min} max={field.max} value={value ?? ''} onChange={e => changeConfig(key, field.type === 'number' ? Number(e.target.value) : e.target.value)} />
              {(field.type === 'file' || field.format === 'file') && <Btn size="sm" disabled={blocked} onClick={() => chooseImage(key)}>选择图片</Btn>}
            </div>}
        </Field>;
      })}
      <details><summary>高级 JSON 配置</summary><Field label="插件配置（JSON）"><textarea className="textarea mono" aria-label="桌面插件配置" disabled={blocked} rows={10} value={config} onChange={e => setConfig(e.target.value)} /></Field></details>
      {editing.configSchema && <details><summary>查看插件配置说明</summary><pre className="extension-schema">{JSON.stringify(editing.configSchema, null, 2)}</pre></details>}
    </Modal>}
    {detail && <Modal title={detail.name} sub={packageDescription(detail)} onClose={() => !blocked && setDetail(null)} foot={<>
      {detail.installed && (detail.source === 'public' || detail.source === 'full') && <Btn variant="danger" disabled={blocked} onClick={async () => { if (confirm(`移除插件「${detail.name}」？`) && await action('extension.remove', { id: detail.id }, detail.id)) setDetail(null); }}>移除插件</Btn>}
      <Btn disabled={blocked} onClick={() => setDetail(null)}>关闭</Btn>
    </>}>
      {error && <div className="notice warning" role="alert">{error}</div>}
      <div className="kv"><span className="k">来源</span><span className="v">{SOURCES[detail.source]}</span><span className="k">标识</span><code className="v">{detail.id}</code><span className="k">{detail.installed ? '安装版本' : '目录版本'}</span><span className="v">{detail.version || '未标注'}</span><span className="k">许可证</span><span className="v">{detail.license || '请查看该插件源码中的许可声明'}</span><span className="k">状态</span><span className="v">{detecting ? '状态待确认' : STATUS[detail.status] || detail.status}</span></div>
      {detail.updateAvailable && <p className="notice">目录提供 {detail.availableVersion || '新的包内容'}，可关闭详情后点击更新。</p>}
      {detail.catalogMissing && <p className="notice">当前市场目录已不再收录此插件。已安装的版本仍可停用或移除。</p>}
      {(detail.source === 'public' || detail.source === 'full') && <p className="muted">插件的服务授权和具体设置请在 ChatGPT 桌面版中完成；启停或移除后重启客户端生效。移除会撤销客户端注册，下载的源码与许可证缓存会保留。</p>}
      {packageLimitations(detail.id) && <p className="notice">{packageLimitations(detail.id)}</p>}
      {!detecting && detail.reason && <div className="notice warning" style={{ marginTop: 16 }}>{detail.reason}</div>}
    </Modal>}
  </>;
}
