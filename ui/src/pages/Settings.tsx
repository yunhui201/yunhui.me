import React, { useEffect, useRef, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Field, Ico, Toggle, copyText, useToast } from '../components/ui';
import { Settings, UpdateInfo, call } from '../lib/api';
import UpdateActions from '../components/UpdateActions';

export default function SettingsPage({ state, reload }: PageProps) {
  const [s, setS] = useState<Settings>(state.settings);
  const [tab, setTab] = useState('appearance');
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState('');
  const changedKeys = useRef(new Set<keyof Settings>());
  const taskRunning = useRef(false);
  const desktop = !!window.aurora;
  const mac = state.platform === 'darwin';
  const platformName = ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux', web: '远程控制台' } as Record<string, string>)[state.platform] || state.platform;
  const toast = useToast();
  useEffect(() => { setS(current => ({ ...state.settings, ...Object.fromEntries([...changedKeys.current].map(key => [key, current[key]])) })); }, [state.settings, dirty]);
  const set = (patch: Partial<Settings>) => { for (const key of Object.keys(patch) as (keyof Settings)[]) changedKeys.current.add(key); setS(v => ({ ...v, ...patch })); setDirty(true); };
  function discard() { changedKeys.current.clear(); setS(state.settings); setDirty(false); }
  async function task(fn: () => Promise<void>) { if (taskRunning.current) return; taskRunning.current = true; setBusy(true); try { await fn(); } catch (e: any) { toast.push(e.message || String(e), 'bad'); } finally { taskRunning.current = false; setBusy(false); } }
  async function save() {
    if (!Number.isInteger(s.gatewayPort) || s.gatewayPort < 1024 || s.gatewayPort > 65535) throw new Error('端口应为 1024–65535 之间的整数');
    if (!s.gatewayToken?.trim()) throw new Error('请生成或填写网关访问令牌');
    const patch = Object.fromEntries([...changedKeys.current].filter(key => s[key] !== state.settings[key]).map(key => [key, s[key]]));
    const result = await call('settings.save', patch); if (result?.ok === false) throw new Error(result.message || '设置保存失败'); changedKeys.current.clear(); setDirty(false); await reload(); toast.push('设置已保存', 'ok');
  }
  const switchField = (label: string, key: keyof Settings, hint: string) => <Field label={label} hint={hint}><div className="row"><Toggle title={label} on={!!s[key]} onChange={v => set({ [key]: v })} /><span className="muted">{s[key] ? '已开启' : '已关闭'}</span></div></Field>;
  return <>
    <div className="page-head"><div><div className="eyebrow">PREFERENCES</div><h1>系统设置</h1><p>让工作空间适应你的习惯。修改后点击保存。</p></div><div className="actions">{dirty && <Btn disabled={busy} onClick={discard}>放弃修改</Btn>}<Btn variant="primary" disabled={!desktop || !dirty || busy} onClick={() => task(save)}><Ico name="check" size={14} />{busy ? '处理中…' : '保存设置'}</Btn></div></div>
    <div className="filter-bar"><div className="segments">{[['appearance', '外观与启动'], ['network', '网关与隐私'], ['cloud', '版本更新'], ['data', '数据与关于']].map(([id, name]) => <button key={id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>{name}</button>)}</div>{dirty && <span className="chip warn">有未保存的修改</span>}</div>
    {!desktop && <div className="notice">当前是远程控制台。系统设置和密钥管理请在电脑上的云汇 AI 桌面端完成。</div>}
    <fieldset disabled={!desktop || busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      {tab === 'appearance' && <div className="grid cols-2">
        <div className="card"><div className="card-title">外观</div><Field label="界面主题"><div className="theme-options">{[['light', '云白'], ['dark', '深夜'], ['system', '跟随系统']].map(([id, label]) => <button className={`theme-choice ${s.theme === id ? 'selected' : ''}`} key={id} onClick={() => set({ theme: id as Settings['theme'] })}><span className={`theme-sample ${id}`}><i /><i /><i /></span><b>{label}</b>{s.theme === id && <Ico name="check" size={13} />}</button>)}</div></Field><Field label="强调色"><div className="row">{['#4f66e8', '#735acb', '#258c83', '#327ead', '#ba7554', '#b85378'].map(color => <button key={color} aria-label={`强调色 ${color}`} aria-pressed={s.accent === color} onClick={() => set({ accent: color })} style={{ width: 29, height: 29, borderRadius: 8, background: color, border: s.accent === color ? '3px solid var(--text)' : '3px solid transparent', cursor: 'pointer' }} />)}</div></Field><Field label="显示语言"><input className="input" readOnly value="简体中文" /></Field></div>
        <div className="card"><div className="card-title">启动与窗口</div>{switchField('开机自动启动', 'launchAtLogin', '登录电脑后启动云汇 AI。')}{switchField('自动启动网关', 'autoStartGateway', '打开应用后启动本地模型网关。')}{switchField(mac ? '关闭窗口后隐藏到菜单栏' : '关闭窗口后保留托盘', 'closeToTray', mac ? '开启后隐藏窗口，关闭后可从 Dock 重新打开。退出应用并停止网关请按 ⌘Q 或使用菜单栏退出。' : '开启后关闭窗口仍保持客户端连接；从托盘菜单退出应用。')}</div>
      </div>}
      {tab === 'network' && <div className="grid cols-2">
        <div className="card"><div className="card-title">本地网关 <span className={`chip ${state.gateway.running ? 'ok' : 'warn'}`}>{state.gateway.running ? '运行中' : '已停止'}</span></div><div className="grid cols-2"><Field label="监听范围"><select className="select" value={s.gatewayHost} onChange={e => set({ gatewayHost: e.target.value, lanShare: e.target.value === '0.0.0.0' })}><option value="127.0.0.1">仅本机</option><option value="0.0.0.0">局域网（连接 iOS）</option></select></Field><Field label="端口"><input aria-label="网关端口" className="input" type="number" min={1024} max={65535} value={s.gatewayPort} onChange={e => set({ gatewayPort: Number(e.target.value) })} /></Field></div><Field label="访问令牌" hint="iOS 配对与网关调用均使用此令牌。更换后需重新配置已接入的客户端。"><div className="row"><input aria-label="网关访问令牌" className="input mono" type={showToken ? 'text' : 'password'} value={s.gatewayToken} onChange={e => set({ gatewayToken: e.target.value })} /><Btn size="sm" onClick={() => setShowToken(v => !v)}>{showToken ? '隐藏' : '显示'}</Btn><Btn size="sm" onClick={async () => { await copyText(s.gatewayToken); toast.push('访问令牌已复制', 'ok'); }}>复制</Btn></div><Btn size="sm" onClick={() => set({ gatewayToken: 'aur-' + Array.from(crypto.getRandomValues(new Uint8Array(24)), x => x.toString(16).padStart(2, '0')).join('') })}>生成新令牌</Btn></Field><Field label="全局上游代理" hint="为空时直接连接，供应商可单独设置代理。"><input className="input mono" value={s.proxy} onChange={e => set({ proxy: e.target.value })} placeholder="http://127.0.0.1:7890" /></Field><div className="notice"><Ico name="user" /><span>iOS 配对：开启局域网监听并保存，在手机填写电脑的局域网 IP、此端口及访问令牌。</span></div></div>
        <div className="card"><div className="card-title">隐私与请求</div>{switchField('隐私遮蔽', 'maskSecrets', '请求发出前替换可识别的敏感文本，可能影响模型理解或工具调用。')}{switchField('记录请求用量', 'logRequests', '将用量记录保存在本机，方便统计与排错。')}<div className="grid cols-2"><Field label="请求超时（秒）"><input className="input" type="number" min={5} max={600} value={s.requestTimeoutMs / 1000} onChange={e => set({ requestTimeoutMs: Number(e.target.value) * 1000 })} /></Field><Field label="失败重试次数"><input className="input" type="number" min={0} max={10} value={s.maxRetries} onChange={e => set({ maxRetries: Number(e.target.value) })} /></Field></div><Btn size="sm" onClick={() => task(async () => { await call('provider.resetCooldown'); toast.push('密钥冷却已清除', 'ok'); })}>清除密钥冷却</Btn></div>
      </div>}
      {tab === 'cloud' && <div className="card" style={{ maxWidth: 900 }}>
        <div className="card-title">版本更新 <span className="chip">当前 v{state.version}</span></div>
        {state.build && <p className="hint" title={state.build.id}>{state.build.channel === 'local' ? '本地调试版' : '构建时间'} · {new Date(state.build.builtAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）</p>}
        <p className="muted">优先从 GitHub 获取最新正式版，连接失败时自动尝试官网。下载较慢时也可选择官网备用。</p>
        {switchField('启动时检查更新', 'autoCheckUpdate', '发现新版本后显示下载入口，由你选择安装。')}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Btn onClick={() => task(async () => { setUpdate(null); setUpdateError(''); try { setUpdate(await call<UpdateInfo>('update.check')); } catch (e: any) { setUpdateError(e.message || String(e)); } })}><Ico name="refresh" size={14} />{busy ? '正在检查…' : '检查更新'}</Btn>
          <Btn variant="ghost" onClick={() => task(async () => { await call('app.openExternal', { url: 'https://github.com/yunhui201/yunhui.me/releases/latest' }); })}>GitHub 发布页 ↗</Btn>
        </div>
        {updateError && <div className="notice warning" role="alert" style={{ marginTop: 24 }}>{updateError}</div>}
        {update && <div style={{ marginTop: 24 }} aria-live="polite">
          {!update.ok ? <div className="notice warning" role="alert">{update.message || '暂时无法检查更新，请稍后重试。'}</div> : <>
            <div className="notice"><Ico name={update.hasUpdate ? 'download' : 'check'} /><div><b>{update.hasUpdate ? `发现新版本 v${update.version}` : '当前版本无需更新'}</b><p>最新正式版 v{update.version} · 来源：{update.source === 'website' ? '官网备用' : 'GitHub'}</p></div></div>
            {update.notes && <p className="muted" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflowY: 'auto' }}>{update.notes}</p>}
            <UpdateActions key={`${update.source}:${update.version}`} update={update} />
          </>}
        </div>}
      </div>}
      {tab === 'data' && <div className="grid cols-2">
        <div className="card"><div className="card-title">本地数据</div><Field label="数据目录"><input className="input mono" readOnly value={state.dataDir} /></Field><Btn size="sm" onClick={() => call('app.openDataDir')}>打开数据目录 ↗</Btn><div className="notice" style={{ marginTop: 20 }}>配置备份包含 API 密钥，请保存在你信任的位置。导入前会自动备份当前配置。</div><div className="row"><Btn onClick={() => task(async () => { const r = await call('app.export'); if (r.ok) toast.push(`已导出：${r.path}`, 'ok'); })}><Ico name="download" size={14} />导出配置</Btn><Btn onClick={() => task(async () => { const r = await call('app.import'); if (r.ok) { changedKeys.current.clear(); setDirty(false); await reload(); toast.push('配置已导入，请重新应用客户端连接', 'ok'); } })}>导入配置</Btn></div></div>
        <div className="card"><div className="card-title">云汇 AI · yunhui.me</div><p className="muted">连接你的客户端、供应商与模型。</p><div className="kv"><span className="k">版本</span><span className="v">{state.version}</span><span className="k">平台</span><span className="v">{platformName}</span><span className="k">网关</span><span className="v mono">{state.gatewayUrl}</span></div><div className="row" style={{ marginTop: 22 }}><Btn onClick={() => task(async () => { await call('gateway.restart'); await reload(); toast.push('网关已重启', 'ok'); })}><Ico name="refresh" size={14} />重启网关</Btn><Btn variant="danger" onClick={() => { if (confirm('退出云汇 AI 并停止本地网关？')) call('app.quit'); }}>退出应用</Btn></div></div>
      </div>}
    </fieldset>
    {tab === 'data' && <div className="page-footnote"><a href="https://github.com/yunhui201/yunhui.me" target="_blank" rel="noopener noreferrer">项目源码 ↗</a><a href="https://github.com/yunhui201/yunhui.me/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">AGPL 许可 ↗</a></div>}
  </>;
}
