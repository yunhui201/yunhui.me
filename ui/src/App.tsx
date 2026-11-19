import React, { memo, startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { AppState, UpdateInfo, call } from './lib/api';
import { Btn, Ico, Modal, ToastHost, WindowControls, useToast } from './components/ui';
import Overview from './pages/Overview';
import Providers from './pages/Providers';
import Catalog from './pages/Catalog';
import Models from './pages/Models';
import Groups from './pages/Groups';
import Agents from './pages/Agents';
import Accounts from './pages/Accounts';
import CodexEnhance from './pages/CodexEnhance';
import Plugins from './pages/Plugins';
import Sessions from './pages/Sessions';
import Usage from './pages/Usage';
import SettingsPage from './pages/Settings';
import Membership from './pages/Membership';
import UpdateActions from './components/UpdateActions';
import { reconcileWorkspaceSnapshot } from './lib/workspaceSnapshot';

export type PageId = 'overview' | 'agents' | 'catalog' | 'providers' | 'models' | 'groups' | 'accounts' | 'codex' | 'plugins' | 'sessions' | 'usage' | 'settings' | 'membership';
export interface PageProps { state: AppState; reload: () => Promise<void>; go: (p: PageId) => void; }
const NAV: Array<{ group: string; items: Array<{ id: PageId; label: string; icon: string; hint: string }> }> = [
  { group: '工作空间', items: [
    { id: 'agents', label: '客户端接入', icon: 'robot', hint: '选择客户端，连接你的 AI' },
    { id: 'overview', label: '运行概览', icon: 'chart', hint: '网关状态与最近请求' },
    { id: 'sessions', label: '历史会话', icon: 'chat', hint: '查找、阅读与恢复本地会话' },
    { id: 'membership', label: '云汇会员', icon: 'user', hint: '绑定会员，领取新客平台额度' },
  ] },
  { group: '模型与连接', items: [
    { id: 'providers', label: '我的供应商', icon: 'plug', hint: 'API 密钥、端点与连接测试' },
    { id: 'catalog', label: '厂商目录', icon: 'cloud', hint: '从云端发现国内外模型服务' },
    { id: 'models', label: '模型管理', icon: 'cube', hint: '模型能力、价格与上下文' },
    { id: 'groups', label: '路由分组', icon: 'route', hint: '故障转移与模型调度' },
  ] },
  { group: '能力扩展', items: [
    { id: 'plugins', label: '插件中心', icon: 'puzzle', hint: '管理请求处理插件' },
    { id: 'codex', label: '桌面工作台', icon: 'bolt', hint: '会话诊断、Skills 与配置' },
    { id: 'accounts', label: '本地账号', icon: 'user', hint: '查看客户端本地登录状态' },
    { id: 'usage', label: '用量与账单', icon: 'chart', hint: '请求、Token 与估算费用' },
  ] },
];
const ALL_NAV = [...NAV.flatMap(g => g.items), { id: 'settings' as PageId, label: '系统设置', icon: 'gear', hint: '外观、网络、数据与更新' }];
const PAGES = { agents: Agents, overview: Overview, catalog: Catalog, providers: Providers, models: Models, groups: Groups, accounts: Accounts, codex: CodexEnhance, plugins: Plugins, sessions: Sessions, usage: Usage, settings: SettingsPage, membership: Membership };
const PageContent = memo(function PageContent({ page, ...props }: PageProps & { page: PageId }) {
  const Page = PAGES[page];
  return <Page {...props} />;
});

function Shell() {
  const initial = window.location.hash.slice(1).split('-')[0] as PageId;
  const [page, setPage] = useState<PageId>(initial in PAGES ? initial : 'agents');
  const [state, setState] = useState<AppState | null>(null);
  const [err, setErr] = useState('');
  const [token, setToken] = useState('');
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const refreshFlight = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef(false);
  const lifecycle = useRef(0);
  const alive = useRef(true);
  const toast = useToast();
  const go = useCallback((p: PageId) => { setPage(p); window.history.replaceState(null, '', `#${p}`); setSearchOpen(false); }, []);
  const refresh = useCallback((afterChange = false): Promise<void> => {
    if (!alive.current) return Promise.resolve();
    if (refreshFlight.current) {
      // A save/detection event needs a snapshot taken after that change; timer ticks can share a read.
      if (afterChange) refreshQueued.current = true;
      return refreshFlight.current;
    }
    const epoch = lifecycle.current;
    const flight = (async () => {
      do {
        refreshQueued.current = false;
        try {
          const next = await call<AppState>('state.get');
          if (!alive.current || epoch !== lifecycle.current) return;
          if (refreshQueued.current) continue;
          startTransition(() => setState(previous => reconcileWorkspaceSnapshot(previous, next)));
          setErr('');
        } catch (e: any) {
          if (!alive.current || epoch !== lifecycle.current) return;
          if (!refreshQueued.current) setErr(e.message || String(e));
        }
      } while (refreshQueued.current);
    })().finally(() => { if (refreshFlight.current === flight) refreshFlight.current = null; });
    refreshFlight.current = flight;
    return flight;
  }, []);
  const reload = useCallback(() => refresh(true), [refresh]);
  useEffect(() => {
    alive.current = true;
    void refresh();
    const off = window.aurora?.onGateway(() => { void refresh(true); });
    const refreshVisible = () => { if (!document.hidden) void refresh(); };
    const timer = setInterval(refreshVisible, 15000);
    document.addEventListener('visibilitychange', refreshVisible);
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(v => !v); } };
    window.addEventListener('keydown', onKey);
    return () => { alive.current = false; lifecycle.current++; refreshFlight.current = null; refreshQueued.current = false; off?.(); clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); window.removeEventListener('keydown', onKey); };
  }, [refresh]);
  useEffect(() => {
    if (!window.aurora || !state?.settings.autoCheckUpdate) return;
    let alive = true;
    call<UpdateInfo>('update.check', {}).then(r => { if (alive && r.ok && r.hasUpdate) setUpdate(r); }).catch(() => {});
    return () => { alive = false; };
  }, [state?.settings.autoCheckUpdate]);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const theme = state?.settings.theme ?? 'dark';
    const apply = () => { document.documentElement.dataset.theme = theme === 'dark' || (theme === 'system' && media.matches) ? 'dark' : 'light'; };
    apply(); media.addEventListener('change', apply);
    document.documentElement.style.setProperty('--accent', state?.settings.accent || '#4f66e8');
    return () => media.removeEventListener('change', apply);
  }, [state?.settings.theme, state?.settings.accent]);

  if (!state || err === 'AUTH_REQUIRED') return <div className="login-screen">
    <div className="welcome-logo"><Ico name="route" size={28} /></div>
    <h1>云汇 AI <span className="muted">/ yunhui.me</span></h1>
    {err === 'AUTH_REQUIRED' ? <form className="login-panel" onSubmit={e => { e.preventDefault(); sessionStorage.setItem('aurora.gatewayToken', token); reload(); }}>
      <h2>连接你的工作空间</h2><p>输入桌面端「系统设置 → 网关」中的访问令牌。</p>
      <input autoFocus aria-label="网关访问令牌" className="input" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="访问令牌" />
      <button className="btn primary" type="submit">连接工作空间</button>
    </form> : err ? <div className="login-panel"><p role="alert">无法连接应用：{err}</p><Btn onClick={reload}>重新连接</Btn></div> : <p className="muted">正在打开工作空间…</p>}
  </div>;
  const active = ALL_NAV.find(i => i.id === page)!;
  return <div className="app" data-platform={window.aurora ? state.platform : 'web'}>
    <header className="titlebar">
      <div className="brand"><span className="brand-symbol"><Ico name="route" size={18} /></span><span>云汇 AI</span><span className="brand-en">yunhui.me</span></div>
      <div className="titlebar-crumb">个人工作空间 <span>/</span> {active.label}</div>
      <div className="spacer" />
      <button className="quick-search" onClick={() => { setSearchOpen(true); setQuery(''); }}><Ico name="search" size={14} /><span>搜索功能</span><kbd>{(state.platform === 'darwin' || (!window.aurora && /Mac|iPhone|iPad/.test(navigator.platform))) ? '⌘ K' : 'Ctrl K'}</kbd></button>
      <button className="icon-button" title="切换浅色 / 深色" onClick={async () => { try { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; if (window.aurora) { await call('settings.save', { theme }); await reload(); } else document.documentElement.dataset.theme = theme; } catch (e: any) { toast.push(e.message, 'bad'); } }}><Ico name="cube" size={16} /></button>
      <WindowControls platform={state.platform} />
    </header>
    <div className="body">
      <aside className="sidebar">
        <div className="workspace-card"><span className="workspace-avatar">云</span><div><b>我的 AI 工作空间</b><small>连接模型，专注创造</small></div><span className="workspace-dot" /></div>
        <nav aria-label="主导航">{NAV.map(g => <div className="nav-group" key={g.group}><div className="nav-group-label">{g.group}</div>{g.items.map(it => <button key={it.id} aria-label={it.label} className={`nav-item ${page === it.id ? 'active' : ''}`} aria-current={page === it.id ? 'page' : undefined} onClick={() => go(it.id)}><Ico name={it.icon} size={17} /><span>{it.label}</span>{it.id === 'providers' && state.providers.length > 0 && <span className="badge">{state.providers.length}</span>}</button>)}</div>)}</nav>
        <div className="sidebar-bottom">
          <div className="gateway-mini"><span className={`dot ${state.gateway.running ? 'on' : 'off'}`} /><div><b>{state.gateway.running ? '本地网关运行中' : '本地网关已停止'}</b><small>{state.gatewayUrl.replace('http://', '')}</small></div><button className="icon-button" title="网关设置" onClick={() => go('settings')}><Ico name="ext" size={13} /></button></div>
          <button aria-label="系统设置" className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => go('settings')}><Ico name="gear" size={17} /><span>系统设置</span><small className="version" title={state.build?.id}>v{state.version}{state.build?.channel === 'local' ? ' 调试' : ''}</small></button>
        </div>
      </aside>
      <main className="main" id="main-content">
        {err && <div className="notice warning" role="alert">连接暂时中断：{err}<Btn size="sm" onClick={reload}>重试</Btn></div>}
        {update && <div className="notice" style={{ flexWrap: 'wrap' }}><Ico name="download" /><span className="grow">新版本 v{update.version} 已发布 · {update.source === 'website' ? '官网备用' : 'GitHub'}</span><UpdateActions key={`${update.source}:${update.version}`} update={update} /><Btn variant="ghost" size="sm" onClick={() => setUpdate(null)}>稍后</Btn></div>}
        <PageContent page={page} state={state} reload={reload} go={go} />
      </main>
    </div>
    {searchOpen && <Modal title="前往工作空间" sub="输入功能名称，快速打开对应页面" onClose={() => setSearchOpen(false)} width={560}><input autoFocus aria-label="搜索功能" className="input" placeholder="客户端、供应商、会话、插件…" value={query} onChange={e => setQuery(e.target.value)} /><div className="command-list">{ALL_NAV.filter(it => `${it.label}${it.hint}`.toLowerCase().includes(query.toLowerCase())).map(it => <button key={it.id} onClick={() => go(it.id)}><Ico name={it.icon} size={20} /><div><b>{it.label}</b><small>{it.hint}</small></div><span>↗</span></button>)}</div></Modal>}
  </div>;
}
export default function App() { return <ToastHost><Shell /></ToastHost>; }
