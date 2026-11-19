import React, { useEffect, useMemo, useRef, useState } from 'react';
import PresetPicker from '../components/PresetPicker';
import ClientRestart from '../components/ClientRestart';
import ClientPermissions from '../components/ClientPermissions';
import ManualClientGuide from '../components/ManualClientGuide';
import ClientDiagnostics from '../components/ClientDiagnostics';
import ClientConnectionTests from '../components/ClientConnectionTests';
import DesktopSetupRecovery from '../components/DesktopSetupRecovery';
import ContextCompactHint from '../components/ContextCompactHint';
import ClientConnectionOverview from '../components/ClientConnectionOverview';
import { applyContextDefaults } from '../../../src/core/modelContext';
import { nativeDirectParameters } from '../../../src/core/agents/directConnection';
import type { PageProps } from '../App';
import { Btn, Empty, Field, Ico, Modal, useToast } from '../components/ui';
import { AgentCatalogItem, AgentDetection, CloudCatalog, Preset, Provider, PROTOCOL_TEXT, call, fmtCtx } from '../lib/api';

const BRANDS: Record<string, { mark: string; color: string; bg: string }> = {
  'claude-code': { mark: '✳', color: '#ae6a48', bg: '#fbf0e9' }, 'claude-desktop': { mark: '✳', color: '#ae6a48', bg: '#fbf0e9' },
  'codex-cli': { mark: '>_', color: '#262e3c', bg: '#edf0f4' }, 'codex-desktop': { mark: 'C', color: '#262e3c', bg: '#edf0f4' },
  'chatgpt-desktop': { mark: '◎', color: '#16866e', bg: '#eaf7f2' }, 'gemini-cli': { mark: '✦', color: '#5273df', bg: '#edf2ff' },
  deepseek: { mark: 'D', color: '#4368dc', bg: '#edf2ff' }, workbuddy: { mark: 'W', color: '#725ad2', bg: '#f1edfc' },
  'qwen-code': { mark: 'Q', color: '#7459d2', bg: '#f1edfc' }, 'kimi-code': { mark: 'K', color: '#333e55', bg: '#eef0f5' },
};
const ORDER = ['claude-code', 'claude-desktop', 'codex-cli', 'chatgpt-desktop', 'workbuddy', 'deepseek', 'gemini-cli'];
const FILTERS = [['all', '全部客户端'], ['desktop', '桌面应用'], ['cli', '命令行工具'], ['service', 'API / 服务'], ['connected', '已接入']];
export function ClientMark({ id, name }: { id: string; name: string }) { const b = BRANDS[id] || { mark: name.charAt(0), color: '#586781', bg: '#eff2f7' }; return <span className="client-mark" style={{ color: b.color, background: b.bg }}>{b.mark}</span>; }

export default function Agents({ state, reload, go }: PageProps) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<AgentCatalogItem | null>(null);
  const [restoring, setRestoring] = useState<AgentCatalogItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [detectError, setDetectError] = useState('');
  const toast = useToast();
  const clients = useMemo(() => [...state.agentCatalog].sort((a, b) => (ORDER.indexOf(a.id) < 0 ? 99 : ORDER.indexOf(a.id)) - (ORDER.indexOf(b.id) < 0 ? 99 : ORDER.indexOf(b.id))).filter(a => (filter === 'all' || (filter === 'connected' ? state.agents[a.id]?.connected : a.category === filter)) && `${a.name} ${a.vendor} ${a.description}`.toLowerCase().includes(query.toLowerCase())), [state, filter, query]);
  const connected = state.agentCatalog.filter(a => state.agents[a.id]?.connected).length;
  async function detect() {
    setBusy(true); setDetectError('');
    try {
      const scanned = window.aurora ? await call('localClients.scan') : null;
      await call('agent.detect'); await reload();
      if (scanned?.ok === false) throw new Error(scanned.warnings?.join('；') || '部分本机配置未能读取，请检查扫描详情后重试。');
      toast.push('本地客户端与已有供应商配置已更新', 'ok');
    } catch (e: any) { setDetectError(e.message || '检测未完成，请重试'); }
    finally { setBusy(false); }
  }
  return <>
    <div className="page-head"><div><div className="eyebrow">YOUR AI, CONNECTED</div><h1>连接你的 AI 客户端<span className="heading-dot">.</span></h1><p>中转站一键配置：选择客户端、填入 API 地址与密钥，应用后重启即可开始。</p></div><div className="actions"><Btn disabled={busy} onClick={detect}><Ico name="refresh" size={14} />{busy ? '正在检测…' : '检测本地客户端'}</Btn></div></div>
    {detectError && <div className="notice warning" role="alert">{detectError}<Btn size="sm" onClick={() => go('providers')}>查看本机扫描详情</Btn></div>}
    {!state.providers.length && !!window.aurora && <div className="notice"><Ico name="bolt" /><span className="grow">第一次使用云汇？绑定平台会员，查看新客活动与可领取额度。</span><Btn size="sm" onClick={() => go('membership')}>查看会员活动 →</Btn></div>}
    {Object.values(state.detected).some(item => item.detecting) && <p className="hint" role="status">正在后台检测已安装的客户端，你可以先选择客户端并预览配置。</p>}
    <ClientConnectionOverview state={state} go={go} onConfigure={setSelected} />
    {connected === 0 && <section className="connect-hero">
      <div className="hero-copy"><span className="hero-label"><span className="dot on" />一个工作空间，连接更多可能</span><h2>喜欢的客户端，<br />配上合适的模型。</h2><p>国内、国际、本地模型，统一管理。<br />从下面选择一个客户端，开始你的第一次连接。</p><div className="hero-facts"><span><Ico name="shield" size={14} />配置自动备份</span><span><Ico name="route" size={14} />多供应商切换</span><span><Ico name="chat" size={14} />本地会话管理</span></div></div>
      <div className="connection-map" aria-hidden="true"><div className="map-label">你的工具</div><div className="map-clients"><span>✳ Claude</span><span>〉_ Codex</span><span>W WorkBuddy</span></div><div className="map-lines"><i /><i /><i /></div><div className="map-hub"><Ico name="route" size={25} /><b>云汇 AI</b></div><div className="map-lines right"><i /><i /><i /></div><div className="map-providers"><span><i style={{ background: '#566cda' }} />DeepSeek</span><span><i style={{ background: '#21947c' }} />OpenAI</span><span><i style={{ background: '#a77654' }} />Anthropic</span></div><div className="map-caption">客户端 · 供应商 · 模型</div></div>
    </section>}
    <div className="onboarding-path"><div className="current"><span>1</span><div><b>选择客户端</b><small>你想使用什么工具</small></div></div><i>→</i><div><span>2</span><div><b>连接供应商</b><small>选择已有服务或添加新服务</small></div></div><i>→</i><div><span>3</span><div><b>选择模型</b><small>按能力和需求自由选择</small></div></div><i>→</i><div><span>4</span><div><b>应用并重启</b><small>自动备份，加载新配置</small></div></div></div>
    <div className="section-heading"><h2>选择一个客户端 <span>{state.agentCatalog.length}</span></h2><span className="muted">已接入 {connected} 个 · 已启用 {state.providers.filter(p => p.enabled).length} 家供应商</span></div>
    <div className="filter-bar"><div className="segments">{FILTERS.map(([id, name]) => <button className={filter === id ? 'selected' : ''} key={id} onClick={() => setFilter(id)}>{name}</button>)}</div><div className="search-input"><Ico name="search" size={15} /><input aria-label="搜索客户端" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索客户端…" /></div></div>
    <div className="client-grid">{clients.map(a => {
      const st = state.agents[a.id]; const found = state.detected[a.id];
      return <article className={`client-card ${st?.connected ? 'is-connected' : ''}`} key={a.id}>
        <div className="client-card-top"><ClientMark id={a.id} name={a.name} /><span className={`client-state ${st?.connected ? 'connected' : ''}`}><span className={`dot ${st?.connected ? 'on' : 'off'}`} />{st?.connected ? '已接入' : found?.installed ? '已检测到' : found?.configured ? '发现本地配置' : found?.detecting ? '正在检测' : a.category === 'service' ? 'API 服务' : '待配置'}</span></div>
        <h3>{a.name}</h3>{found?.productName && <small className="hint">识别为 {found.productName}{found.version ? ` · ${found.version}` : ''}</small>}<div className="client-vendor">{a.vendor}<span>·</span>{a.category === 'desktop' ? '桌面应用' : a.category === 'cli' ? '命令行工具' : 'API / 服务'}</div>
        <p className="client-description">{a.description}</p>
        <div className="tag-list"><span className={`chip ${a.support === 'automatic' ? 'accent' : ''}`}>{a.support === 'automatic' ? '自动配置' : a.support === 'unsupported' ? '官方账号登录' : '手动接入'}</span>{st?.connected && <span className="chip ok ellipsis" title={st.model}>{st.model}</span>}{a.protocol && a.support !== 'unsupported' && <span className="chip">{PROTOCOL_TEXT[a.protocol] || a.protocol}</span>}</div>
        <div className="client-card-actions"><button className="text-button" onClick={() => a.docsUrl ? call('app.openExternal', { url: a.docsUrl }) : setSelected(a)}>接入说明 <span>↗</span></button><div className="grow" />{st?.connected && <Btn variant="ghost" size="sm" onClick={() => setRestoring(a)}>恢复</Btn>}<Btn variant={a.support === 'unsupported' ? 'default' : 'primary'} size="sm" onClick={() => setSelected(a)}>{a.support === 'unsupported' ? '查看说明' : st?.connected ? '更换配置' : '开始配置'} <span>→</span></Btn></div>
        <div className="client-tools"><ClientRestart agent={a} /><ClientDiagnostics agent={a} />{st?.connected && <ClientPermissions agent={a} onRestored={reload} />}</div>
      </article>;
    })}</div>
    {!clients.length && <Empty icon="⌕" title="没有匹配的客户端" hint="调整筛选条件，或搜索 Claude、Codex、WorkBuddy。" />}
    <div className="page-footnote"><Ico name="cloud" size={15} /><span>还没有模型服务？从厂商目录发现国内外供应商。</span><button className="text-button" onClick={() => go('catalog')}>浏览厂商目录 →</button></div>
    {selected && <ConnectWizard agent={state.agentCatalog.find(agent => agent.id === selected.id) || selected} state={state} reload={reload} onClose={() => setSelected(null)} />}
    {restoring && <Modal title={`恢复 ${restoring.name} 的原配置`} sub="恢复接入前保存的配置备份。此操作会退出云汇的网关配置。" onClose={() => { if (!busy) setRestoring(null); }} foot={<><Btn disabled={busy} onClick={() => setRestoring(null)}>取消</Btn><Btn variant="primary" disabled={busy} onClick={async () => { setBusy(true); try { const r = await call('agent.disconnect', { agentId: restoring.id }); if (!r.ok) throw new Error(r.message); await reload(); setRestoring(null); toast.push(r.message || '原配置已恢复，重启客户端后生效', 'ok'); } catch (e: any) { toast.push(e.message, 'bad'); } finally { setBusy(false); } }}>{busy ? '正在恢复配置…' : '恢复原配置'}</Btn></>}><div className="notice">{['codex-cli', 'chatgpt-desktop', 'codex-desktop'].includes(restoring.id) ? '先恢复原配置，再尝试整理对应历史。客户端运行中或历史处理暂未完成，都不影响配置恢复；保存工作并重启客户端后生效。' : '恢复后，请重启对应客户端。你的历史会话不受此操作影响。'}</div></Modal>}
  </>;
}

function ConnectWizard({ agent, state, reload, onClose }: { agent: AgentCatalogItem; state: PageProps['state']; reload: PageProps['reload']; onClose: () => void }) {
  const previous = state.agents[agent.id];
  const codingDesktop = ['chatgpt-desktop', 'codex-desktop'].includes(agent.id);
  const codex = agent.id === 'codex-cli' || codingDesktop;
  const officialAvailable = codex && !!state.codexCoexist?.identity.available;
  const officialModels = (state.codexCoexist?.models || []).filter(m => m.official).map(m => ({ id: m.upstreamModel, displayName: m.displayName, contextWindow: m.contextWindow }));
  const officialProvider: Provider | undefined = officialAvailable ? { id: 'official', name: 'ChatGPT 官方账号', format: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api/codex', apiKeys: [], models: officialModels, enabled: officialModels.length > 0, priority: 0, createdAt: '', updatedAt: '' } : undefined;
  const choices = [...(officialProvider ? [officialProvider] : []), ...state.providers];
  const [step, setStep] = useState(0);
  const [providerId, setProviderId] = useState(previous?.providerId || choices.find(p => p.enabled)?.id || '');
  const [authMode, setAuthMode] = useState<'api' | 'coexist'>(previous?.authMode || (previous?.mode !== 'direct' && officialAvailable && officialModels.length > 0 ? 'coexist' : 'api'));
  const [mode, setMode] = useState<'gateway' | 'direct'>(previous?.mode === 'direct' ? 'direct' : 'gateway');
  const previouslyManaged = !!(previous?.connected || previous?.pendingReapply);
  const [permissionMode, setPermissionMode] = useState<'preserve' | 'full-access'>(previouslyManaged ? previous?.permissionMode || 'preserve' : 'preserve');
  const [skipOnboarding, setSkipOnboarding] = useState(previouslyManaged && previous?.skipOnboarding === true);
  const [model, setModel] = useState(previous?.model || '');
  const [manualModel, setManualModel] = useState(false);
  const [creating, setCreating] = useState(!!window.aurora && !choices.some(p => p.enabled));
  const presets = state.presets;
  const catalogStatus = state.catalog?.syncing ? '正在更新官方目录…' : state.catalog?.warning || `官方目录 · ${state.catalog?.source === 'remote' ? '已同步' : state.catalog?.source === 'cache' ? '本地缓存' : '离线预设'} · ${presets.length} 家`;
  const [draft, setDraft] = useState<Partial<Provider>>({ name: '', baseUrl: '', format: 'openai-chat', models: [] });
  const [key, setKey] = useState('');
  const [modelIds, setModelIds] = useState('');
  const [busy, setBusy] = useState(false);
  const [clientActionActive, setClientActionActive] = useState(false);
  const [connectionTestActive, setConnectionTestActive] = useState(false);
  const running = useRef(false);
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [desktopDetection, setDesktopDetection] = useState<AgentDetection | null>(null);
  const [recoveryOperation, setRecoveryOperation] = useState<'detect' | 'select' | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const detected = desktopDetection || state.detected[agent.id] || (codingDesktop ? state.detected['chatgpt-desktop'] : undefined);
  const support = agent.support;
  const toast = useToast();
  const provider = choices.find(p => p.id === providerId);
  const chosenModel = manualModel ? model : model || provider?.models[0]?.id || '';
  const selectedModel = provider?.models.find(m => m.id === chosenModel);
  const selectedContextWindow = selectedModel || providerId === 'official' ? selectedModel?.contextWindow
    : chosenModel ? applyContextDefaults<{ id: string; contextWindow?: number }>({ id: chosenModel }).contextWindow : undefined;
  const selectedAuthMode = providerId === 'official' ? 'coexist' : codex ? authMode : 'api';
  let directEndpointIssue = '';
  if (provider && agent.protocol) {
    try { nativeDirectParameters(provider.baseUrl, agent.protocol); }
    catch (error: any) { directEndpointIssue = error.message || '此 API 地址暂不支持直连，请使用本地网关。'; }
  }
  const directIssue = selectedAuthMode === 'coexist' ? '官方账号共存通过本地网关按模型分流，请保持云汇运行。'
    : support !== 'automatic' ? '此客户端当前提供手动接入参数，请使用网关接入并在客户端填写。'
    : !provider ? '请先选择供应商。'
    : provider.format !== agent.protocol ? '供应商与客户端协议不同，请使用本地网关转换协议。'
    : Object.keys(provider.headers || {}).length ? '此供应商有自定义请求头，当前直连配置不会写入这些请求头，请使用本地网关。'
    : provider.proxy?.trim() ? '此供应商使用独立代理，当前直连配置不会写入代理设置，请使用本地网关。'
    : state.settings.proxy?.trim() ? '云汇已设置网络代理，当前直连配置不会写入代理设置，请使用本地网关。'
    : directEndpointIssue
      ? directEndpointIssue
    : agent.id === 'claude-desktop' && !/^(?:anthropic\/)?claude-(?:sonnet|opus|haiku)-/.test(chosenModel) ? 'Claude 桌面直连需要 Claude 角色模型；其他模型请通过本地网关映射。'
    : '';
  const connectionMode = directIssue ? 'gateway' : mode;
  const canSetPermissions = codex || agent.id === 'claude-code';
  const payload = { agentId: agent.id, providerId, model: chosenModel, mode: connectionMode, authMode: selectedAuthMode, permissionMode: canSetPermissions ? permissionMode : 'preserve', skipOnboarding: agent.id === 'claude-code' && skipOnboarding };
  const historyPreview = codex ? preview?.history : undefined;
  const preservedHistory = historyPreview?.preserved || 0;
  const skippedHistory = historyPreview?.skipped || 0;
  const historyNotes = [...new Set<string>([...(historyPreview?.skippedReasons || []), ...(historyPreview?.warnings || [])])];
  const testRevision = JSON.stringify([provider?.name, provider?.enabled, provider?.baseUrl, provider?.format, provider?.proxy, provider?.headers, provider?.apiKeys, state.settings.proxy, state.settings.gatewayHost, state.settings.gatewayPort, state.settings.gatewayToken]);
  function clearSelectionFeedback() { setPreview(null); }
  useEffect(() => {
    if (mode === 'direct' && directIssue) {
      setMode('gateway'); setPreview(null);
      setStep(current => current === 2 ? 1 : current);
    }
  }, [mode, directIssue]);
  async function run(task: () => Promise<void>) { if (running.current) return; running.current = true; setBusy(true); setError(''); try { await task(); } catch (e: any) { setError(e.message || String(e)); } finally { running.current = false; setBusy(false); } }
  async function saveNew() {
    if (!draft.name?.trim()) throw new Error('请填写供应商名称');
    try { const u = new URL(draft.baseUrl || ''); if (!['http:', 'https:'].includes(u.protocol)) throw new Error(); } catch { throw new Error('请填写有效的 http(s) API 地址'); }
    const models = modelIds.split(/[\s,，]+/).filter(Boolean).map(id => draft.models?.find(m => m.id === id) || { id });
    const saved = await call<Provider>('provider.save', { ...draft, models, enabled: true, apiKeys: [{ id: crypto.randomUUID(), label: '默认密钥', key: key.trim(), enabled: true, weight: 1 }], priority: 10 });
    // Keep the saved identity even if discovery or the subsequent state refresh fails.
    setDraft(saved);
    let discovered: any = null;
    if (key.trim() || !models.length) {
      try { discovered = await call('provider.models', { providerId: saved.id }); }
      catch (e: any) { discovered = { ok: false, message: e.message || '模型同步失败' }; }
    }
    await reload(); setProviderId(saved.id); setModel(saved.models[0]?.id || discovered?.models?.[0]?.id || ''); setManualModel(false); clearSelectionFeedback(); setCreating(false); setStep(1);
    if (discovered?.ok === false) setError(`供应商已保存，模型列表暂未同步：${discovered.message || '请稍后重试'}。可继续选择已有模型或手动输入模型 ID。`);
  }
  async function ensureSelectedModel() {
    if (providerId !== 'official' && provider && !provider.models.some(m => m.id === chosenModel)) {
      if (!window.aurora) throw new Error('请在电脑端先保存此模型 ID');
      await call('provider.save', { id: provider.id, models: [...provider.models, { id: chosenModel }] });
      await reload();
    }
  }
  async function prepare() {
    await ensureSelectedModel();
    const r = await call('agent.preview', payload); if (!r.ok) throw new Error(r.message || '无法生成配置预览'); setPreview({ ...r, selection: payload }); setStep(2);
  }
  async function recoverDesktop(operation: 'detect' | 'select') {
    const priorError = error;
    setRecoveryOperation(operation); setPreview(null);
    try {
      if (operation === 'select') {
        const response = await call<{ ok: boolean; canceled?: boolean; detected?: AgentDetection; message?: string }>('agent.desktop.select', { agentId: 'chatgpt-desktop' });
        if (!alive.current) return;
        if (response.canceled) { setError(priorError); return; }
        if (response.detected) setDesktopDetection(response.detected);
        if (!response.ok) throw new Error(response.message || '未能选择客户端程序，请重新选择实际安装的主程序');
      } else {
        const response = await call<Record<string, AgentDetection>>('agent.detect');
        if (!alive.current) return;
        const found = response['chatgpt-desktop'] || response[agent.id];
        if (!found || typeof found.installed !== 'boolean') throw new Error('未获得桌面客户端检测结果，请稍后重试');
        setDesktopDetection(found);
      }
      await reload();
      if (alive.current) await prepare();
    } finally { if (alive.current) setRecoveryOperation(null); }
  }
  async function apply() {
    let r: any;
    try {
      r = await call('agent.connect', { ...preview.selection, revision: preview.revision });
      if (!r.ok) throw new Error(r.message || '应用失败');
    }
    catch (error) { setPreview(null); setStep(1); throw error; }
    setResult(r); await reload(); toast.push('客户端配置已保存', 'ok');
  }
  if (support === 'unsupported' && !codingDesktop) return <Modal title={agent.name} sub="客户端兼容性说明" onClose={onClose} foot={<><Btn onClick={onClose}>关闭</Btn>{agent.docsUrl && <Btn variant="primary" onClick={() => call('app.openExternal', { url: agent.docsUrl })}>打开官方说明 ↗</Btn>}</>}><div className="compatibility-info"><ClientMark id={agent.id} name={agent.name} /><h2>通过官方账号使用此客户端</h2><p>{agent.supportNote || agent.description}</p><p>如需自定义供应商，可选择支持自定义 API 的编程客户端或 API 工具。</p></div></Modal>;
  return <Modal title={`配置 ${agent.name}`} sub="选择供应商和模型，预览后再应用到客户端。" onClose={() => { if (!busy && !clientActionActive) onClose(); }} width={800} foot={<div style={{ width: '100%', minWidth: 0 }}>
    <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 }}><Btn variant="ghost" disabled={busy || clientActionActive} onClick={onClose}>{result ? '完成' : '取消'}</Btn>{!result && step > 0 && <Btn disabled={busy} onClick={() => { setStep(step - 1); clearSelectionFeedback(); setError(''); }}>上一步</Btn>}{!result && step === 0 && <Btn variant="primary" disabled={busy || (!creating && !provider?.enabled)} onClick={() => run(async () => { if (creating) await saveNew(); else setStep(1); })}>{busy ? '保存中…' : creating ? '保存并选模型 →' : '下一步：选择模型 →'}</Btn>}{!result && step === 1 && <Btn variant="primary" disabled={busy || connectionTestActive || !chosenModel} onClick={() => run(prepare)}>{busy ? '生成预览…' : '预览配置 →'}</Btn>}{!result && step === 2 && support === 'automatic' && <Btn variant="primary" disabled={busy} onClick={() => run(apply)}>{busy ? '正在保存配置…' : '保存配置'}</Btn>}</div></div>}>
    <div className="wizard-steps">{['连接供应商', '选择模型', '预览并应用'].map((name, i) => <div key={name} className={step === i ? 'active' : step > i ? 'done' : ''}><span>{step > i ? '✓' : i + 1}</span>{name}</div>)}</div>
    {error && <div className="notice warning" role="alert">{error}</div>}
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
    {result ? <div className="connection-success"><span><Ico name="check" size={32} /></span><h2>配置已保存，重启客户端后生效</h2>{result.message && result.message !== '配置已保存，重启客户端后生效' && <p>{result.message}</p>}{codex && result.history && <details className="config-preview" aria-label="历史会话处理结果"><summary>{result.history.status === 'completed' ? '历史处理已完成 · 查看详情' : result.history.status === 'failed' ? '历史处理未完成 · 配置已保存' : '历史稍后处理 · 配置已保存'}</summary><div role="status">
      {result.history.status === 'completed' ? <>
        <p>已备份 {result.history.backedUp} 个会话文件{typeof result.history.indexBackedUp === 'number' ? `和 ${result.history.indexBackedUp} 个索引数据库` : ''}。</p>
        <p>已修复 {result.history.repaired} 个会话，{result.history.unchanged} 个无需修改。</p>
        {result.history.preserved > 0 && <p>{result.history.preserved} 条未找到原文件的会话索引已随数据库备份并原样保留；未补建会话内容。</p>}
        {result.history.skipped > 0 && <p>{result.history.skipped} 个会话未修复，已完整备份并原样保留。</p>}
        {!result.history.skipped && result.history.skippedReasons?.length > 0 && <p>无法核验的历史索引已完整备份并原样保留，未修改其中的会话内容。</p>}
        {result.history.skippedReasons?.length > 0 && <details><summary>查看未修复原因</summary>{result.history.skippedReasons.map((reason: string, index: number) => <p key={index}>{reason}</p>)}</details>}
      </> : <p>{result.history.message || '历史处理暂未完成，已保存的客户端配置不受影响。'}</p>}
      {result.history.backupPath && <details><summary>{result.history.status === 'completed' ? '查看历史备份位置' : '查看历史处理记录位置'}</summary><p className="mono muted">{result.history.backupPath}</p></details>}
    </div></details>}{payload.authMode === 'coexist' && <p>重启客户端后，在模型菜单选择“官方”或对应供应商。切换服务建议新建会话，避免不同供应商的加密上下文不兼容。</p>}<div className="review-summary"><b>{provider?.name}</b><span>→</span><code>{chosenModel}</code></div>{result.path && <p className="mono muted">{result.path}</p>}</div> : <>
      {step === 0 && <>
        {codex && <div className="notice"><Ico name="user" size={18} /><div className="grow"><b>官方账号与第三方模型</b><p>{officialAvailable ? '已检测到官方登录。共存模式保留账号身份，并在同一模型菜单中显示官方与第三方模型。' : state.codexCoexist?.identity.message || '登录官方客户端后，可在这里开启账号与第三方模型共存。'}</p>{officialAvailable && <label className="checkbox-label"><input type="checkbox" aria-label="保留官方账号并与第三方模型共存" checked={authMode === 'coexist' || providerId === 'official'} disabled={providerId === 'official'} onChange={e => { setAuthMode(e.target.checked ? 'coexist' : 'api'); if (e.target.checked) setMode('gateway'); clearSelectionFeedback(); }} />保留官方账号并与第三方模型共存</label>}<p className="hint">{authMode === 'coexist' || providerId === 'official' ? '共存模式保留官方账号身份；第三方服务仅使用你配置的供应商密钥。' : 'API 模式保留官方登录文件，但桌面账号显示可能变化，官方聊天及云功能可能暂不可用；需要这些功能时，请使用共存模式。'}</p></div></div>}
        {codex && authMode === 'coexist' && state.codexCoexist?.warnings.map((message, i) => <div className="notice warning" key={i}>{message}</div>)}
        {!window.aurora && !state.providers.some(p => p.enabled) && <div className="notice">请先在电脑桌面端添加并启用供应商，再从这里选择客户端连接。</div>}
        <div className="wizard-toggle"><button className={!creating ? 'selected' : ''} disabled={!choices.length} onClick={() => setCreating(false)}>使用已有供应商</button><button className={creating ? 'selected' : ''} disabled={!window.aurora} onClick={() => setCreating(true)}><Ico name="plus" size={14} />添加供应商</button></div>
        {creating ? <div className="provider-inline-form">
          <Field label="从厂商预设开始" hint={catalogStatus}><PresetPicker presets={presets} value={draft.presetId} onChange={p => { setKey(''); if (!p) { setDraft({ name: '', baseUrl: '', format: 'openai-chat', models: [] }); setModelIds(''); return; } setDraft({ name: p.nameZh || p.name, presetId: p.id, baseUrl: p.baseUrl, format: p.format, models: p.models, color: p.color, icon: p.icon }); setModelIds(p.models.map(m => m.id).join('\n')); }} /></Field>
          <div className="grid cols-2"><Field label="供应商名称"><input aria-label="供应商名称" className="input" value={draft.name || ''} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：我的 DeepSeek" /></Field><Field label="API 协议"><select aria-label="API 协议" className="select" value={draft.format} onChange={e => setDraft({ ...draft, format: e.target.value as any })}>{Object.entries(PROTOCOL_TEXT).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></Field></div>
          <Field label="API 地址"><input aria-label="API 地址" className="input mono" value={draft.baseUrl || ''} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="填写供应商提供的 API 地址" /></Field>
          <Field label="API Key" hint="密钥只保存在本机；无需认证的本地服务可以留空。"><input aria-label="API Key" className="input mono" type="password" autoComplete="off" value={key} onChange={e => setKey(e.target.value)} placeholder="输入你的 API Key" /></Field>
          <Field label="模型 ID" hint="保存后会尝试同步模型，并保留这里填写的模型。手动填写时每行一个，或用逗号分隔。"><textarea aria-label="模型 ID" className="textarea mono" rows={3} value={modelIds} onChange={e => setModelIds(e.target.value)} placeholder="留空自动读取，或填写实际模型 ID" /></Field>
        </div> : <div className="provider-choices">{choices.map(p => <button className={`provider-choice ${providerId === p.id ? 'selected' : ''}`} key={p.id} disabled={!p.enabled} onClick={() => { setProviderId(p.id); setModel(p.models[0]?.id || ''); setManualModel(false); if (p.id === 'official') { setAuthMode('coexist'); setMode('gateway'); } clearSelectionFeedback(); }}><span className="vendor-avatar" style={{ color: p.color || 'var(--accent)' }}>{p.name.slice(0, 1)}</span><div><b>{p.name}</b><small>{p.id === 'official' ? '使用官方登录 · ' : ''}{p.models.length} 个模型 · {PROTOCOL_TEXT[p.format]}{!p.enabled ? p.id === 'official' ? ' · 请先在官方客户端加载模型' : ' · 已停用' : ''}</small></div><span className="choice-radio">{providerId === p.id ? '●' : '○'}</span></button>)}</div>}
      </>}
      {step === 1 && <>
        {codingDesktop && <DesktopSetupRecovery agent={agent} detected={detected} platform={state.platform} busy={busy} operation={recoveryOperation} canPreview={!!chosenModel} onDetect={() => { void run(() => recoverDesktop('detect')); }} onSelect={() => { void run(() => recoverDesktop('select')); }} />}
        <div className="review-summary"><b>{provider?.name}</b><span className="chip">{PROTOCOL_TEXT[provider?.format || '']}</span><span className="grow" /><Btn size="sm" disabled={busy || providerId === 'official'} onClick={() => run(async () => { const r = await call('provider.models', { providerId }); if (!r.ok) throw new Error(r.message); await reload(); toast.push(`模型已同步，新增 ${r.added || 0} 个`, 'ok'); })}><Ico name="refresh" size={12} />同步模型</Btn></div>
        <Field label="选择模型"><select aria-label="选择模型" className="select" disabled={manualModel} value={chosenModel} onChange={e => { setModel(e.target.value); clearSelectionFeedback(); }}><option value="" disabled>请选择模型</option>{provider?.models.map(m => <option key={m.id} value={m.id}>{m.displayName || m.id}{m.contextWindow ? ` · ${fmtCtx(m.contextWindow)} 上下文` : ''}</option>)}</select></Field>
        {codex && <div><ContextCompactHint value={selectedContextWindow} id="client-context-compact-hint" /><p className="hint">应用时按上下文的 90% 同步默认自动压缩阈值，重启客户端后生效。其他压缩策略与实际触发时机由客户端决定。</p></div>}
        {providerId !== 'official' && <>
          {!!provider?.models.length && <Btn size="sm" onClick={() => { setManualModel(!manualModel); if (manualModel) setModel(provider.models[0]?.id || ''); clearSelectionFeedback(); }}>{manualModel ? '返回模型列表' : '手动输入其他模型 ID'}</Btn>}
          {(manualModel || !provider?.models.length) && <Field label="手动模型 ID" hint="模型不在列表中时，填写供应商提供的准确 ID；预览前会保存到该供应商。"><input className="input mono" aria-label="手动模型 ID" value={model} onChange={e => { setModel(e.target.value.trim()); clearSelectionFeedback(); }} placeholder="填写该服务实际提供的模型 ID" /></Field>}
        </>}
        {chosenModel && <div className="model-feature-row">{Object.entries(provider?.models.find(m => m.id === chosenModel)?.capabilities || {}).filter(([, v]) => v).map(([k]) => <span className="chip" key={k}>{({ tools: '工具调用', vision: '视觉理解', thinking: '深度思考' } as any)[k] || k}</span>)}</div>}
        <Field label="接入方式" hint={directIssue || '协议一致时可直连；需要协议转换、多密钥轮换或网关统计时使用本地网关。'}><select className="select" aria-label="接入方式" value={connectionMode} onChange={e => { setMode(e.target.value as 'gateway' | 'direct'); clearSelectionFeedback(); }}><option value="gateway">本地网关（推荐）</option><option value="direct" disabled={!!directIssue}>直连供应商</option></select></Field>
        <div className="notice"><Ico name="route" size={18} /><div><b>{connectionMode === 'direct' ? '客户端直接请求供应商' : '通过本地网关连接'}</b><p>{connectionMode === 'direct' ? '将供应商 API 地址、首个已启用的 Key 和模型 ID 写入客户端配置。客户端直接请求该供应商，配置加载后无需保持云汇运行。' : selectedAuthMode === 'coexist' ? '配置指向本地共存入口，云汇按模型分别使用官方登录或所选供应商的 Key 发送请求；使用期间保持云汇运行。' : '将本地网关地址和令牌写入客户端配置，云汇再使用所选供应商的 URL 与 Key 转发请求并转换协议；使用期间保持云汇运行。'}</p></div></div>
        {canSetPermissions && <Field label="客户端执行权限" hint={permissionMode === 'full-access' ? '开启后可执行命令并修改沙箱外的文件，不再逐项请求批准。仅对信任的工作内容使用；预览后应用。' : '保留客户端现有的审批与文件访问设置；不会关闭此前开启的高级权限。'}><select className="select" aria-label="客户端执行权限" value={permissionMode} onChange={e => { setPermissionMode(e.target.value as 'preserve' | 'full-access'); clearSelectionFeedback(); }}><option value="preserve">保留现有权限（推荐）</option><option value="full-access">高级权限 · 免逐次批准</option></select></Field>}
        {canSetPermissions && previous?.connected && <ClientPermissions agent={agent} onActiveChange={setClientActionActive} onRestored={async () => { setPermissionMode('preserve'); setPreview(null); await reload(); }} />}
        {selectedAuthMode === 'api' && (codex || agent.id === 'claude-code') && <p className="hint">使用有效 API Key 接入，无需登录官方账号；上游服务仍需有效密钥和可用额度。</p>}
        {agent.id === 'claude-code' && <div><label className="checkbox-label"><input type="checkbox" checked={skipOnboarding} onChange={e => { setSkipOnboarding(e.target.checked); clearSelectionFeedback(); }} />跳过首次登录引导（API 接入）</label><p className="hint">适用于首次启动仍进入登录引导的 Claude Code 版本；应用时备份引导设置。受组织管理的登录要求以客户端策略为准。</p></div>}
      </>}
      {step === 2 && preview && <>
        <div className="review-summary"><b>{agent.name}</b><span>→</span><b>{provider?.name}</b><span>→</span><code>{chosenModel}</code><span className="chip">{preview.selection.mode === 'direct' ? '直连供应商' : '本地网关'}</span></div>
        {historyPreview && <details className="config-preview" aria-label="历史会话辅助处理"><summary>历史会话 · 保存配置后尝试处理</summary>
          <p>先保存并备份客户端配置，再尝试备份和整理历史；客户端运行中或历史处理失败，都不影响配置保存。</p>
          {historyPreview.status === 'deferred' ? <p>{historyPreview.message || '历史将在不影响当前客户端的情况下另行处理。'}</p> : <>
            {typeof historyPreview.total === 'number' && <p>共 {historyPreview.total} 个会话记录 · {historyPreview.repairable} 个可修复 · {historyPreview.unchanged} 个无需修改{preservedHistory ? ` · ${preservedHistory} 条索引原样保留` : ''}{skippedHistory ? ` · ${skippedHistory} 个备份后跳过修复` : ''}。</p>}
            {typeof historyPreview.filesToBackUp === 'number' && <p>预计处理 {historyPreview.filesToBackUp} 个会话文件和 {historyPreview.indexDatabasesToBackUp || 0} 个索引数据库，完成情况以保存后的结果为准。</p>}
            {historyNotes.length > 0 && <details><summary>查看历史说明</summary>{historyNotes.map((note, index) => <p key={index}>{note}</p>)}</details>}
          </>}
        </details>}
        {preview.warnings?.map((w: string, i: number) => <div className="notice warning" key={i}>{w}</div>)}
        {agent.supportNote && <p className="muted">{agent.supportNote}</p>}
        {preview.files?.map((f: any) => <details className="config-preview" key={f.path} open><summary>{f.existed ? '修改' : '新建'} · {f.path}</summary><div className="preview-columns"><div><label>当前配置</label><pre>{f.before || '此文件尚不存在'}</pre></div><div><label>应用后</label><pre>{f.after}</pre></div></div></details>)}
        {support === 'manual' && <ManualClientGuide agent={agent} preview={preview} selection={payload} platform={state.platform} modelContextWindow={provider?.models.find(m => m.id === chosenModel)?.contextWindow} />}
        {support === 'automatic' && <div className="notice"><Ico name="shield" size={17} /><span>应用前自动备份原配置。{preview.requiresRestart ? '完成后请重启客户端。' : '配置生效方式以客户端为准。'}</span></div>}
      </>}
    </>}
    {!result && <div hidden={step !== 1}><ClientConnectionTests {...payload} disabled={busy || !chosenModel} selectionRevision={testRevision} prepare={ensureSelectedModel} onActiveChange={setConnectionTestActive} /></div>}
    </fieldset>
    {result && <div className="client-restart-success"><h3>{agent.category === 'cli' ? '打开新终端，加载新配置' : '最后一步：重新启动客户端'}</h3><p className="hint">{connectionMode === 'gateway' ? '使用期间保持云汇运行。' : '直连供应商，加载配置后无需保持云汇运行。'}{'保存工作后重新启动客户端，即可加载新配置。'}</p><div className="client-tools"><ClientRestart agent={agent} primary onActiveChange={setClientActionActive} /><ClientDiagnostics agent={agent} /><ClientPermissions agent={agent} onActiveChange={setClientActionActive} onRestored={async () => { setPermissionMode('preserve'); await reload(); }} /></div></div>}
  </Modal>;
}
