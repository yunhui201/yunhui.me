import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClientLifecycleInfo, ClientLifecycleResult } from '../../../src/main/clientLifecycle';
import { call, type AgentCatalogItem } from '../lib/api';
import { Btn, Ico, Modal } from './ui';

/** A desktop-only action. The host selects the executable and process scope. */
export default function ClientRestart({ agent, onActiveChange, primary = false }: {
  agent: AgentCatalogItem; onActiveChange?: (active: boolean) => void; primary?: boolean;
}) {
  const [checking, setChecking] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const working = useRef(false);
  const sequence = useRef(0);
  const alive = useRef(true);
  const cli = agent.category === 'cli';
  const label = cli ? '新终端打开' : '重新启动客户端';
  const active = checking || executing || confirmation;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; sequence.current++; working.current = false; };
  }, [agent.id]);
  useEffect(() => { onActiveChange?.(active); }, [active, onActiveChange]);
  useEffect(() => () => { onActiveChange?.(false); }, [onActiveChange]);

  if (!window.aurora || !['desktop', 'cli'].includes(agent.category || '')) return null;

  async function check() {
    if (working.current) return;
    working.current = true;
    const request = ++sequence.current;
    setChecking(true); setError(''); setMessage('');
    try {
      const info = await call<ClientLifecycleInfo>('agent.lifecycle', { agentId: agent.id });
      if (!alive.current || request !== sequence.current) return;
      if (!info?.ok || info.agentId !== agent.id || info.kind !== agent.category) throw new Error(info?.message || '无法确认此客户端的启动方式，请重新检查');
      if (!info.supported || !info.installed) throw new Error(info.message || (!info.installed ? '未检测到客户端，请安装后重新检查' : '此客户端暂不支持在云汇中启动'));
      setConfirmation(true);
    } catch (e: any) { if (alive.current && request === sequence.current) setError(e.message || '检查客户端失败，请重试'); }
    finally { if (alive.current && request === sequence.current) { working.current = false; setChecking(false); } }
  }

  async function execute() {
    if (working.current) return;
    working.current = true;
    const request = ++sequence.current;
    setExecuting(true); setError('');
    try {
      const result = await call<ClientLifecycleResult>('agent.restart', { agentId: agent.id });
      if (!alive.current || request !== sequence.current) return;
      const operations = cli ? ['opened-terminal'] : ['started', 'restarted'];
      if (!result?.ok || result.agentId !== agent.id || result.kind !== agent.category || !operations.includes(result.operation)) throw new Error(result?.message || (cli ? '新终端未能打开，请重试' : '客户端未能重新启动，请重试'));
      setConfirmation(false);
      setMessage(result.message || (cli ? '已在新终端打开。原终端仍保留；需要加载新配置时，请先结束旧会话。' : result.operation === 'started' ? '客户端已启动。' : '客户端已重新启动。'));
    } catch (e: any) { if (alive.current && request === sequence.current) setError(e.message || '操作未完成，请重试'); }
    finally { if (alive.current && request === sequence.current) { working.current = false; setExecuting(false); } }
  }

  const close = () => { if (!working.current) setConfirmation(false); };
  return <div className="client-restart">
    <div className="client-restart-row"><Btn size="sm" variant={primary ? 'primary' : 'ghost'} disabled={active} onClick={() => { void check(); }}><Ico name={cli ? 'play' : 'refresh'} size={13} />{checking ? '正在检查…' : label}</Btn>{cli && <span className="hint">保留当前终端与会话</span>}</div>
    {error && !confirmation && <div className="client-restart-error" role="alert"><span>{error}</span><Btn size="sm" disabled={checking || executing} onClick={() => { void check(); }}>重新检查</Btn></div>}
    {message && <p className="client-restart-message" role="status">{message}</p>}
    {confirmation && createPortal(<Modal title={cli ? `在新终端打开 ${agent.name}` : `重新启动 ${agent.name}`} onClose={close} width={460} foot={<>
      <Btn disabled={executing} onClick={close}>取消</Btn>
      <Btn variant="primary" disabled={executing} onClick={() => { void execute(); }}>{executing ? cli ? '正在打开…' : '正在重新启动…' : cli ? '新终端打开' : '确认重新启动'}</Btn>
    </>}>
      <p className="client-restart-explanation">{cli ? '将在新终端打开此工具，原终端和会话会保留。需要加载新配置时，请先结束旧会话，再在新终端继续。' : '将强制结束此客户端的进程（包括托盘和后台进程），确认退出后重新打开；未运行时直接启动。当前会话会中断，未保存的内容可能丢失，请先保存工作。'}</p>
      {error && <div className="notice warning" role="alert">{error}</div>}
    </Modal>, document.body)}
  </div>;
}
