import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClientDiagnosticReport } from '../../../src/core/clientDiagnostics';
import { call, type AgentCatalogItem } from '../lib/api';
import { Btn, copyText, Ico, Modal, useToast } from './ui';
import '../styles/client-diagnostics.css';

const STATUS = { ok: '正常', warning: '需检查', error: '待处理', info: '说明' };
export default function ClientDiagnostics({ agent }: { agent: AgentCatalogItem }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ClientDiagnosticReport | null>(null);
  const [error, setError] = useState('');
  const generation = useRef(0), working = useRef(false);
  const toast = useToast();
  useEffect(() => {
    generation.current++; working.current = false;
    setBusy(false); setOpen(false); setResult(null); setError('');
    return () => { generation.current++; working.current = false; };
  }, [agent.id]);
  if (!window.aurora || !['desktop', 'cli'].includes(agent.category || '')) return null;
  function close() {
    generation.current++; working.current = false;
    setOpen(false); setBusy(false); setResult(null); setError('');
  }
  async function diagnose() {
    if (working.current) return;
    const request = ++generation.current;
    working.current = true; setOpen(true); setBusy(true); setError(''); setResult(null);
    try {
      const response = await call('agent.diagnose', { agentId: agent.id });
      if (request !== generation.current) return;
      if (!response?.ok || !Array.isArray(response.checks) || typeof response.report !== 'string') throw new Error();
      setResult(response);
    } catch {
      if (request === generation.current) setError('本机诊断未完成，请重新检查。若仍失败，请重新打开云汇后重试。');
    } finally {
      if (request === generation.current) { setBusy(false); working.current = false; }
    }
  }
  return <div className="client-diagnostics">
    <Btn size="sm" variant="ghost" disabled={busy} onClick={() => { void diagnose(); }}><Ico name="search" size={13} />连接诊断</Btn>
    {open && createPortal(<Modal title={`${agent.name} · 连接诊断`} sub="只读检查本机配置，不发送模型请求。" width={680} onClose={close} foot={<>
      <Btn onClick={close}>关闭</Btn>
      {result && <Btn onClick={async () => { try { await copyText(result.report); toast.push('诊断报告已复制，不包含密钥、账号或本地路径', 'ok'); } catch { toast.push('复制失败，请重试', 'bad'); } }}><Ico name="copy" size={14} />复制诊断报告</Btn>}
      <Btn variant="primary" disabled={busy} onClick={() => { void diagnose(); }}>{busy ? '正在诊断…' : '重新检查'}</Btn>
    </>}>
      {busy && <p role="status">正在检查本机配置与连接依赖…</p>}
      {error && <div className="notice warning" role="alert">{error}</div>}
      {result && <>
        <p className="muted">检查时间：{new Date(result.checkedAt).toLocaleTimeString()} · {result.checks.filter(check => ['warning', 'error'].includes(check.status)).length} 项需要检查</p>
        <ol className="client-diagnostic-checks">{result.checks.map(check => <li key={check.id} data-check-id={check.id} data-status={check.status}>
          <div><strong>{check.title}</strong><span className={`chip ${check.status === 'ok' ? 'ok' : check.status === 'info' ? '' : 'warn'}`}>{STATUS[check.status]}</span></div><p>{check.detail}</p>
        </li>)}</ol>
      </>}
    </Modal>, document.body)}
  </div>;
}
