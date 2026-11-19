import React, { useEffect, useRef, useState } from 'react';
import { call } from '../lib/api';
import { Btn, Ico } from './ui';
import '../styles/client-connection-tests.css';

type Target = 'upstream' | 'local';
interface TestResult { ok: boolean; message: string; latencyMs?: number; canceled?: boolean; }
interface Props {
  agentId: string; providerId: string; model: string; authMode: string; mode: string;
  disabled?: boolean; selectionRevision?: string; onActiveChange?: (active: boolean) => void;
  prepare?: () => Promise<void>;
}
function requestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export default function ClientConnectionTests(props: Props) {
  const { agentId, providerId, model, authMode, mode, disabled, selectionRevision, onActiveChange } = props;
  const [results, setResults] = useState<Partial<Record<Target, TestResult>>>({});
  const [pending, setPending] = useState<Target | null>(null);
  const active = useRef<string | null>(null);
  const callback = useRef(onActiveChange); callback.current = onActiveChange;
  const scope = JSON.stringify([agentId, providerId, model, authMode, mode, selectionRevision]);
  const currentScope = useRef(scope); currentScope.current = scope;
  useEffect(() => {
    setResults({}); setPending(null); callback.current?.(false);
    return () => {
      const id = active.current; active.current = null;
      if (id) void call('agent.test.cancel', { requestId: id }).catch(() => {});
      callback.current?.(false);
    };
  }, [scope]);
  async function run(target: Target) {
    if (active.current || disabled || !window.aurora || providerId === 'official' || !model) return;
    const id = requestId(), startedScope = scope;
    active.current = id; setPending(target); callback.current?.(true);
    setResults(previous => ({ ...previous, [target]: undefined }));
    try {
      await props.prepare?.();
      if (active.current !== id || currentScope.current !== startedScope) return;
      const result = await call<TestResult>('agent.test', { requestId: id, target, agentId, providerId, model, authMode });
      if (active.current !== id || currentScope.current !== startedScope) return;
      if (!result || typeof result.ok !== 'boolean') throw new Error('未收到有效测试结果，请重试。');
      setResults(previous => ({ ...previous, [target]: result }));
    } catch (error: any) {
      if (active.current === id && currentScope.current === startedScope) setResults(previous => ({ ...previous, [target]: { ok: false, message: error.message || '测试未完成，请重试。' } }));
    } finally {
      if (active.current === id) { active.current = null; setPending(null); callback.current?.(false); }
    }
  }
  async function cancel() {
    const id = active.current, target = pending;
    if (!id || !target) return;
    active.current = null; setPending(null); callback.current?.(false);
    setResults(previous => ({ ...previous, [target]: { ok: false, canceled: true, message: '测试已取消。' } }));
    await call('agent.test.cancel', { requestId: id }).catch(() => {});
  }
  if (providerId === 'official') return <p className="hint">官方账号请在原客户端发起对话确认可用；这里的连接测试用于第三方供应商。</p>;
  return <section className="client-connection-tests" aria-label="连接测试">
    <div className="client-test-options">{(['upstream', 'local'] as const).map(target => <div className="client-test-item" key={target}>
      <Btn size="sm" disabled={disabled || !!pending || !model || !providerId || !window.aurora} onClick={() => { void run(target); }}><Ico name={target === 'upstream' ? 'cloud' : 'route'} size={14} />{pending === target ? '测试中…' : target === 'upstream' ? '上游网关测试' : '本地网关测试'}</Btn>
      <p className="hint">{target === 'upstream' ? '验证供应商地址、密钥和模型是否可用。' : '验证云汇转发到所选模型的完整通路。'}</p>
      {results[target] && <div className={`notice ${results[target]!.ok ? '' : results[target]!.canceled ? '' : 'warning'}`} role="status">{results[target]!.ok ? '✓ ' : ''}{results[target]!.message}{results[target]!.ok && Number.isFinite(results[target]!.latencyMs) ? ` · ${results[target]!.latencyMs} ms` : ''}</div>}
    </div>)}</div>
    <div className="row wrap"><span className="hint">点击测试会发送简短模型请求，可能产生少量费用。{mode === 'direct' ? '直连只需上游测试，本地网关测试可选。' : '使用本地网关时，请保持云汇运行。'}</span>{pending && <Btn size="sm" onClick={() => { void cancel(); }}>取消测试</Btn>}</div>
    {authMode === 'coexist' && <p className="hint">本地测试验证第三方模型通路；官方账号分支请在原客户端验证。</p>}
    {!window.aurora && <p className="hint">请在电脑上的云汇客户端执行连接测试。</p>}
  </section>;
}
