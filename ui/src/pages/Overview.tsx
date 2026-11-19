import React, { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Stat, Ico, copyText, useToast } from '../components/ui';
import { call, fmtCost, fmtNum, fmtTime, UsageRecord, UsageSummary, maskKey } from '../lib/api';

export default function Overview({ state, reload, go }: PageProps) {
  const toast = useToast();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [recent, setRecent] = useState<UsageRecord[]>([]);

  useEffect(() => {
    let alive = true;
    void call<UsageSummary>('usage.summary', { days: 14 }).then(result => { if (alive) setUsage(result); }).catch(() => {});
    void call<UsageRecord[]>('usage.recent').then(result => { if (alive) setRecent(current => [...new Map([...result, ...current].map(record => [record.requestId, record])).values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 12)); }).catch(() => {});
    const off = window.aurora?.onUsage((r) => { if (alive) setRecent((s) => [r, ...s.filter(record => record.requestId !== r.requestId)].slice(0, 12)); });
    return () => { alive = false; off?.(); };
  }, []);

  const enabled = state.providers.filter((p) => p.enabled);
  const connected = state.agentCatalog.flatMap(agent => state.agents[agent.id]?.connected ? [[agent.id, state.agents[agent.id]] as const] : []);
  const today = usage?.byDay?.find(d => d.day === new Date().toISOString().slice(0, 10));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>运行概览</h1>
          <p>查看通过云汇网关的请求、模型用量与连接状态。</p>
        </div>
        <div className="actions">
          <Btn disabled={!window.aurora} onClick={() => call('gateway.restart').then(reload)}>
            <Ico name="refresh" size={13} /> 重启网关
          </Btn>
          <Btn
            variant={state.gateway.running ? 'danger' : 'primary'}
            disabled={!window.aurora}
            onClick={async () => {
              await call(state.gateway.running ? 'gateway.stop' : 'gateway.start');
              await reload();
              toast.push(state.gateway.running ? '网关已停止' : '网关已启动', 'ok');
            }}
          >
            <Ico name={state.gateway.running ? 'stop' : 'play'} size={13} />
            {state.gateway.running ? '停止' : '启动'}
          </Btn>
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 14 }}>
        <div className="card">
          <Stat k="网关状态" v={state.gateway.running ? '运行中' : '已停止'} />
          <div style={{ marginTop: 10 }} className="row">
            <span className={`chip ${state.gateway.running ? 'ok' : 'bad'}`}>
              {state.gatewayUrl.replace('http://', '')}
            </span>
            {state.gateway.errors > 0 && <span className="chip bad">{state.gateway.errors} 次错误</span>}
          </div>
        </div>
        <div className="card">
          <Stat k="已启用供应商" v={enabled.length} unit="家" />
          <div style={{ marginTop: 10 }} className="tag-list">
            {enabled.slice(0, 3).map((p) => (
              <span key={p.id} className="chip">
                {p.icon} {p.name}
              </span>
            ))}
            {enabled.length === 0 && <span className="chip warn">还没有供应商</span>}
          </div>
        </div>
        <div className="card">
          <Stat k="今日已知价格估算（UTC）" v={usage ? fmtCost(today?.cost ?? 0) : '—'} />
          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--muted)' }}>
            今日 {today?.calls ?? 0} 次调用 · {fmtNum(today?.tokens ?? 0)} tokens
            {!!today?.unpricedCalls && <span> · {today.unpricedCalls} 次未计价</span>}
          </div>
        </div>
        <div className="card">
          <Stat k="已接入客户端" v={connected.length} unit="个" />
          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--muted)' }}>
            {connected.length ? connected.map(([id]) => id).join(' · ') : '去「客户端」页一键接入'}
          </div>
        </div>
      </div>

      <div className="split">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <div className="card-title">
              快捷接入 <span className="sub">选一个客户端，立刻用上供应商池</span>
            </div>
            <div className="list">
              {state.agentCatalog.slice(0, 6).map((a) => {
                const st = state.agents[a.id];
                return (
                  <div key={a.id} className="list-row">
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>{a.name}</div>
                      <div className="ellipsis" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        {st?.connected ? `已接入 · ${st.model ?? ''}` : a.vendor}
                      </div>
                    </div>
                    <span className={`chip ${st?.connected ? 'ok' : ''}`}>{st?.connected ? '已接入' : '未接入'}</span>
                    <Btn size="sm" onClick={() => go('agents')}>
                      配置
                    </Btn>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <div className="card-title">
              最近请求 <span className="sub">出问题先看这里</span>
            </div>
            {recent.length === 0 ? (
              <div style={{ color: 'var(--muted)', fontSize: 12, padding: '10px 2px' }}>
                还没有请求。接好客户端后，随便发一句试试。
              </div>
            ) : (
              <div className="list">
                {recent.slice(0, 8).map((r, i) => (
                  <div key={r.requestId + i} className="list-row">
                    <span className={`chip ${r.status < 400 ? 'ok' : 'bad'}`}>{r.status}</span>
                    <div className="grow">
                      <div className="ellipsis" style={{ fontSize: 12 }}>
                        {r.agent} → <b>{r.model}</b>
                      </div>
                      <div className="ellipsis mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                        {r.providerName} · {fmtTime(r.ts)} · {r.latencyMs}ms
                        {r.error ? ` · ${r.error}` : ''}
                      </div>
                    </div>
                    <span className="mono" style={{ fontSize: 11, color: 'var(--text-2)' }}>
                      {fmtNum(r.inputTokens + r.outputTokens)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <div className="card-title">
              最近 14 天用量 <span className="sub">已知价格估算（美元）</span>
            </div>
            <div className="bars">
              {(usage?.byDay ?? []).slice(-14).map((d) => {
                const max = Math.max(0.01, ...(usage?.byDay ?? []).map((x) => x.cost));
                return (
                  <div
                    key={d.day}
                    className="bar"
                    style={{ height: `${Math.max(3, (d.cost / max) * 100)}%` }}
                  >
                    <span>
                      {d.day.slice(5)} · {fmtCost(d.cost)} · {d.calls} 次
                      {!!d.unpricedCalls && <span> · {d.unpricedCalls} 次未计价</span>}
                    </span>
                  </div>
                );
              })}
              {!usage?.byDay?.length && (
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>暂无数据</div>
              )}
            </div>
            <div className="grid cols-3" style={{ marginTop: 16 }}>
              <Stat k="总 tokens" v={fmtNum(usage?.totals.inputTokens ?? 0)} />
              <Stat k="总输出" v={fmtNum(usage?.totals.outputTokens ?? 0)} />
              <Stat k="缓存命中" v={fmtNum(usage?.totals.cacheRead ?? 0)} />
            </div>
          </div>

          <div className="card">
            <div className="card-title">
              网关地址 <span className="sub">复制给任何支持自定义端点的客户端</span>
            </div>
            <div className="row" style={{ marginBottom: 8 }}>
              <input className="input mono" readOnly value={state.gatewayUrl} />
              <Btn
                onClick={() => {
                  copyText(state.gatewayUrl);
                  toast.push('已复制网关地址', 'ok');
                }}
              >
                <Ico name="copy" size={13} />
              </Btn>
            </div>
            <div className="kv">
              <div className="k">Anthropic</div>
              <div className="v mono">{state.gatewayUrl}</div>
              <div className="k">OpenAI 兼容</div>
              <div className="v mono">{state.gatewayUrl}/v1</div>
              <div className="k">Gemini</div>
              <div className="v mono">{state.gatewayUrl}</div>
              <div className="k">令牌</div>
              <div className="v mono">{state.settings.gatewayToken ? maskKey(state.settings.gatewayToken) : '不校验'}</div>
            </div>
          </div>

          <div className="card">
            <div className="card-title">供应商池</div>
            <div className="tag-list">
              {state.providers.map((p) => (
                <span key={p.id} className={`chip ${p.enabled ? 'accent' : ''}`} onClick={() => go('providers')}>
                  {p.icon} {p.name}
                  <span style={{ opacity: 0.6 }}>{p.models.length}</span>
                </span>
              ))}
              {state.providers.length === 0 && <span className="chip warn">空</span>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

