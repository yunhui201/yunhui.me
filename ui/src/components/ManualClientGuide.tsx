import React, { useEffect, useRef, useState } from 'react';
import { buildManualGuide, manualGuideParameters, manualGuideVariants, type ManualGuide, type ManualGuideVariant } from '../../../src/core/agents/manualGuides';
import { call, type AgentCatalogItem } from '../lib/api';
import { Btn, Ico } from './ui';
import '../styles/manual-client-guide.css';

interface Props {
  agent: Pick<AgentCatalogItem, 'id' | 'name' | 'protocol'>;
  preview: { ok: boolean; revision?: string; manual?: { baseUrl: string; model: string; apiKey?: string } };
  selection: { agentId: string; providerId: string; model: string; mode: string; authMode: string; [key: string]: unknown };
  platform: string;
  modelContextWindow?: number;
  onError?: (message: string) => void;
}
type CopyTarget = 'parameters' | 'document' | 'apiKey';
interface FreshParameters { ok: boolean; baseUrl?: string; model?: string; apiKey?: string; }

export default function ManualClientGuide({ agent, preview, selection, platform, modelContextWindow, onError }: Props) {
  const variants = manualGuideVariants(agent.id);
  const [variant, setVariant] = useState<ManualGuideVariant | undefined>(variants[0]?.value);
  const [context, setContext] = useState(modelContextWindow ? String(modelContextWindow) : '');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const active = useRef<symbol | null>(null), alive = useRef(true);
  const baseScope = JSON.stringify([agent.id, agent.protocol, selection, preview.ok, preview.revision, preview.manual?.baseUrl, preview.manual?.model, platform, modelContextWindow]);
  const scope = JSON.stringify([baseScope, variant, context]);
  const currentScope = useRef(scope); currentScope.current = scope;
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current = null; }; }, []);
  useEffect(() => { setVariant(manualGuideVariants(agent.id)[0]?.value); setContext(modelContextWindow ? String(modelContextWindow) : ''); }, [baseScope]);
  useEffect(() => { active.current = null; setBusy(false); setFeedback(null); }, [scope]);
  const selectedVariant = variants.some(item => item.value === variant) ? variant : variants[0]?.value;
  const input = {
    agentId: agent.id, protocol: agent.protocol, platform,
    parameters: { baseUrl: preview.manual?.baseUrl || '', model: preview.manual?.model || '' },
    contextWindow: context.trim() ? Number(context) : undefined, variant: selectedVariant,
  };
  let guide: ManualGuide | undefined, guideError = '';
  try {
    if (!preview.ok || selection.agentId !== agent.id) throw new Error('连接选择已变化，请重新预览。');
    guide = buildManualGuide(input); // Never pass preview.apiKey into a rendered value.
  } catch (error: any) { guideError = error.message || '请重新预览连接参数。'; }

  function report(text: string, error = false) {
    setFeedback({ text, error });
    if (error) onError?.(text);
  }
  async function copyPublic(text: string) {
    const startedScope = scope;
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(text);
      if (alive.current && currentScope.current === startedScope) report('已复制，请按步骤在原客户端使用。');
    } catch { if (alive.current && currentScope.current === startedScope) report('剪贴板暂不可用，请重试或手动复制示例文字。', true); }
  }
  async function copyWithToken(target: CopyTarget) {
    if (!guide || active.current || !window.aurora || !navigator.clipboard?.writeText) {
      if (!navigator.clipboard?.writeText) report('剪贴板暂不可用，请在电脑桌面端重试。', true);
      return;
    }
    const request = Symbol(), startedScope = scope;
    active.current = request; setBusy(true); setFeedback(null);
    const isCurrent = () => alive.current && active.current === request && currentScope.current === startedScope;
    try {
      const fresh = await call<FreshParameters>('agent.parameters', selection);
      if (!isCurrent()) return;
      if (!fresh?.ok || fresh.baseUrl !== input.parameters.baseUrl || fresh.model !== input.parameters.model || typeof fresh.apiKey !== 'string' || !fresh.apiKey.trim()) {
        report('连接参数已变化或无法获取，请重新预览后再复制。', true); return;
      }
      // Token-bearing text only lives in this explicit action. Never use a textarea fallback.
      const privateGuide = buildManualGuide(input, fresh.apiKey);
      const text = target === 'apiKey' ? fresh.apiKey : target === 'document' ? privateGuide.document?.content : manualGuideParameters(privateGuide);
      if (!text || !isCurrent()) return;
      await navigator.clipboard.writeText(text);
      if (isCurrent()) report('已复制含访问令牌的内容，请粘贴到原客户端；复制不代表已配置或已验证。');
    } catch { if (isCurrent()) report('复制未完成，请重新预览并在电脑桌面端重试。', true); }
    finally { if (active.current === request) { active.current = null; if (alive.current) setBusy(false); } }
  }
  if (!guide) return <div className="notice warning" role="alert">{guideError}</div>;
  return <section className="manual-client-guide" aria-label="手动客户端配置指南">
    <div className="manual-guide-heading"><div><span className="manual-guide-eyebrow">手动接入 · 等待在原客户端验证</span><h3>{guide.title}</h3></div><span className="manual-guide-protocol">{guide.protocolLabel}</span></div>
    {variants.length > 0 && <label className="manual-guide-choice">客户端版本<select className="select" aria-label="手动指南版本" value={selectedVariant} onChange={event => setVariant(event.target.value as ManualGuideVariant)}>{variants.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>}
    <ol className="manual-guide-steps">{guide.steps.map((step, index) => <li key={step}><span aria-hidden="true">{index + 1}</span><p>{step}</p></li>)}</ol>
    {guide.path && <div className="manual-guide-path"><span>配置位置</span><code>{guide.path}</code><p className="hint">{guide.pathNote}</p></div>}
    {agent.id === 'kimi-code' && <label className="manual-guide-choice">模型上下文 Token 数<input className="input" aria-label="模型上下文 Token 数" inputMode="numeric" type="number" min="1" step="1" value={context} onChange={event => setContext(event.target.value)} placeholder="填写供应商实际支持的 Token 数" /><span className="hint">仅用于这份手动配置，不修改供应商模型资料。</span></label>}
    {guide.blockingReason && <div className="notice warning" role="alert">{guide.blockingReason}</div>}
    <div className="manual-guide-fields">{guide.fields.map(field => <div className="manual-guide-field" key={field.id}><span>{field.label}</span><code>{field.value}</code><Btn size="sm" disabled={busy || (field.id === 'apiKey' && !window.aurora)} onClick={() => { void (field.id === 'apiKey' ? copyWithToken('apiKey') : copyPublic(field.value)); }}>{field.id === 'apiKey' ? '复制真实令牌' : '复制'}</Btn></div>)}</div>
    {guide.document && <div className="manual-guide-document"><div className="manual-guide-document-title"><strong>{guide.document.label}</strong><span>{guide.document.language}</span></div><pre tabIndex={0}><code>{guide.document.content}</code></pre><div className="row wrap"><Btn size="sm" disabled={busy} onClick={() => { void copyPublic(guide!.document!.content); }}>复制占位示例</Btn><Btn size="sm" variant="primary" disabled={busy || !window.aurora} onClick={() => { void copyWithToken('document'); }}><Ico name="copy" size={14} />复制可用配置（含令牌）</Btn></div><p className="hint">预览只显示占位令牌。已有文件请先备份、再合并；云汇不会写入或覆盖文件。</p></div>}
    {guide.command && <div className="manual-guide-command"><span>{guide.command.label}</span><code>{guide.command.content}</code><Btn size="sm" disabled={busy || !!guide.blockingReason} onClick={() => { void copyPublic(guide!.command!.content); }}>复制命令</Btn></div>}
    <div className="row wrap"><Btn disabled={busy || !window.aurora} onClick={() => { void copyWithToken('parameters'); }}><Ico name="copy" size={14} />{busy ? '正在复制…' : '复制完整连接参数'}</Btn><span className="hint">只复制，不会自动配置客户端。</span></div>
    {!window.aurora && <p className="hint">浏览器和手机仅展示占位示例。含真实访问令牌的内容请在电脑桌面端复制。</p>}
    {feedback && <div className={`notice${feedback.error ? ' warning' : ''}`} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</div>}
    <ul className="manual-guide-notices">{guide.notices.map(note => <li key={note}>{note}</li>)}</ul>
    <div className="manual-guide-docs">{guide.docs.map(doc => <a key={doc.url} href={doc.url} target="_blank" rel="noreferrer">{doc.label}<Ico name="ext" size={12} /></a>)}</div>
  </section>;
}
