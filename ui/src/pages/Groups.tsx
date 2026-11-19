import React, { useRef, useState } from 'react';
import type { PageProps } from '../App';
import { Btn, Empty, Field, Ico, Modal, Toggle, copyText, useToast } from '../components/ui';
import { MODE_TEXT, RouteMode, RoutingGroup, call } from '../lib/api';

const MODE_HINT: Record<RouteMode, string> = {
  order: '先使用排在前面的成员；请求失败时，在重试次数范围内继续尝试后续密钥和成员。',
  rotate: '按成员轮流分配请求；一家供应商有多个密钥不会增加它的分流份额。',
  weight: '按成员权重比例轮流分配。权重为 0 的成员不接收请求，也不参与本策略的失败切换。',
  usage: '优先使用本次网关运行中成功请求数较少的供应商；重启网关后重新统计。',
  pace: '比较供应商已保存额度窗口的最高使用比例，较低的优先；缺少数据的排在后面。',
  smart: '先排除冷却密钥，再比较本次运行中的失败记录和供应商优先级；成功后清除该供应商的失败计数。',
};

export default function Groups({ state, reload }: PageProps) {
  const toast = useToast();
  const [editing, setEditing] = useState<Partial<RoutingGroup> | null>(null);
  const [connecting, setConnecting] = useState<RoutingGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false);

  async function run(task: () => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    try { await task(); } catch (e: any) { setError(e.message || '操作未完成，请重试'); }
    finally { running.current = false; setBusy(false); }
  }

  async function save(g: Partial<RoutingGroup>) {
    const name = g.name?.trim() || '';
    if (!name || name.length > 80 || /[\\/?#\u0000-\u001f\u007f]/.test(name)) throw new Error('请填写有效分组名：最多 80 字，不能包含斜线、问号或井号。');
    if (state.groups.some(group => group.id !== g.id && group.name.toLowerCase() === name.toLowerCase())) throw new Error('分组名称已存在，请使用不同名称。');
    if (!Number.isInteger(g.retries) || g.retries! < 0 || g.retries! > 10) throw new Error('失败重试次数须为 0–10 的整数。');
    if (g.members?.some(member => !Number.isInteger(member.weight) || member.weight < 0 || member.weight > 1000)) throw new Error('成员权重须为 0–1000 的整数。');
    const saved = await call('group.save', { ...g, name });
    if (saved?.ok === false) throw new Error(saved.message || '分组保存失败');
    setEditing(current => current && saved?.id ? { ...current, id: saved.id } : current);
    await reload();
    setEditing(null);
    toast.push('分组已保存', 'ok');
  }
  const copy = async (value: string, label: string) => { await copyText(value); toast.push(`${label}已复制`, 'ok'); };
  const moveMember = (index: number, direction: number) => {
    if (!editing?.members) return;
    const members = [...editing.members], target = index + direction;
    if (target < 0 || target >= members.length) return;
    [members[index], members[target]] = [members[target], members[index]];
    setEditing({ ...editing, members });
  };
  const gatewayBase = state.gatewayUrl.replace(/\/+$/, '');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>路由分组</h1>
          <p>把多家供应商的模型组成一个入口，由本地网关按策略选择。</p>
        </div>
        <div className="actions">
          <Btn
            variant="primary"
            disabled={!window.aurora || busy}
            onClick={() => { setError(''); setEditing({ name: '', mode: 'order', members: [], enabled: true, retries: 2 }); }}
          >
            <Ico name="plus" size={13} /> 新建分组
          </Btn>
        </div>
      </div>

      {!window.aurora && <div className="notice">当前为只读远程视图，路由分组请在桌面端管理。</div>}
      <div className="notice">保存分组后，请让客户端通过本地网关使用 <code>group/分组名</code>。创建分组不会自动切换现有客户端的供应商连接。</div>
      {error && !editing && <div className="notice warning" role="alert">{error}</div>}
      {state.groups.length === 0 ? (
        <div className="card">
          <Empty
            icon="🛣️"
            title="还没有路由分组"
            hint="把多家提供合适模型的 API 供应商放入同一组，按顺序或权重路由。需要在客户端使用 group/分组名 才会生效。"
          />
        </div>
      ) : (
        <div className="grid cols-2">
          {state.groups.map((g) => (
            <div className="card" key={g.id}>
              <div className="card-title">
                <span className="mono" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>group/{g.name}</span>
                <span className="chip accent">{MODE_TEXT[g.mode]}</span>
                <span className="sub">
                  {g.members.length} 个成员
                  <Toggle
                    title={`启用分组 ${g.name}`}
                    disabled={!window.aurora || busy}
                    on={g.enabled}
                    onChange={(v) => run(async () => {
                      const result = await call('group.save', { id: g.id, enabled: v });
                      if (result?.ok === false) throw new Error(result.message || '分组状态保存失败');
                      await reload();
                    })}
                  />
                </span>
              </div>
              <p className="hint">{MODE_HINT[g.mode]} 最多额外尝试 {g.retries} 次。</p>
              <div className="list">
                {g.members.map((m, i) => {
                  const p = state.providers.find((x) => x.id === m.providerId);
                  return (
                    <div key={i} className="list-row">
                      <span className="chip">{i + 1}</span>
                      <div className="grow">
                        <div>{p ? `${p.icon || ''} ${p.name}${p.enabled ? '' : '（已停用）'}` : '（已删除的供应商）'}</div>
                        <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                          {m.model ?? p?.models[0]?.id ?? '—'}
                        </div>
                        {p && m.model && p.models.length > 0 && !p.models.some(model => model.id === m.model) && <small className="hint">模型已移除，此成员会被跳过</small>}
                      </div>
                      {g.mode === 'weight' && <span className="chip">{m.weight === 0 ? '不分流' : `权重 ${m.weight}`}</span>}
                    </div>
                  );
                })}
                {g.members.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 12 }}>没有成员</div>}
              </div>
              <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                <Btn size="sm" onClick={() => { void copy(`group/${g.name}`, '模型名'); }}>复制模型名</Btn>
                <Btn size="sm" onClick={() => setConnecting(g)}>接入参数</Btn>
                <Btn size="sm" disabled={!window.aurora || busy} onClick={() => { setError(''); setEditing(g); }}>
                  编辑
                </Btn>
                <div style={{ flex: 1 }} />
                <Btn
                  size="sm"
                  variant="ghost"
                  title={`删除分组 ${g.name}`}
                  disabled={!window.aurora || busy}
                  onClick={() => {
                    if (!confirm(`删除分组「${g.name}」？`)) return;
                    void run(async () => { const result = await call('group.delete', { id: g.id }); if (result?.ok === false) throw new Error(result.message || '删除失败'); await reload(); });
                  }}
                >
                  <Ico name="trash" size={12} />
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Modal
          title={editing.id ? '编辑分组' : '新建分组'}
          sub="客户端把模型名写成 group/分组名 就会走这个组。"
          onClose={() => !running.current && setEditing(null)}
          foot={
            <>
              <Btn variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
                取消
              </Btn>
              <Btn variant="primary" disabled={busy} onClick={() => run(() => save(editing))}>
                {busy ? '保存中…' : '保存'}
              </Btn>
            </>
          }
        >
          {error && <div className="notice warning" role="alert">{error}</div>}
          <fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <div className="grid cols-2">
            <Field label="分组名" hint="例如 coding 或 日常编程；最多 80 字，不含斜线、问号或井号。改名后需更新客户端模型名。">
              <input
                className="input mono"
                aria-label="分组名"
                maxLength={80}
                value={editing.name ?? ''}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="coding"
              />
            </Field>
            <Field label="策略">
              <select
                className="select"
                aria-label="路由策略"
                value={editing.mode}
                onChange={(e) => setEditing({ ...editing, mode: e.target.value as RouteMode })}
              >
                {(Object.keys(MODE_TEXT) as RouteMode[]).map((m) => (
                  <option key={m} value={m}>
                    {MODE_TEXT[m]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="hint">{MODE_HINT[editing.mode || 'order']}</p>
          {editing.mode === 'pace' && !(editing.members || []).some(member => state.providers.find(provider => provider.id === member.providerId)?.quota?.windows?.some(window => Number.isFinite(window.usedPercent))) && <div className="notice">这些成员还没有额度窗口数据。当前会按失败记录和供应商优先级选择；余额查询结果不会自动变成额度窗口。</div>}
          <Field label="失败重试次数" hint="0 表示只尝试一次。每次换密钥或换供应商都计入次数；已接受但响应损坏、或已经开始输出的请求不会自动重试。">
            <input className="input" aria-label="失败重试次数" type="number" min={0} max={10} step={1} value={editing.retries ?? 2} onChange={event => setEditing({ ...editing, retries: Number(event.target.value) })} />
          </Field>

          <Field label="成员顺序" hint={editing.mode === 'weight' ? '权重为 0–1000 的整数；0 表示不参与本策略。' : '可用上下箭头调整顺序；只有按权重策略使用成员权重。'}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {(editing.members ?? []).map((m, i) => (
                <div className="row" key={i} style={{ flexWrap: 'wrap' }}>
                  <span className="chip">{i + 1}</span>
                  <select
                    className="select"
                    style={{ width: 190 }}
                    aria-label={`第 ${i + 1} 个成员供应商`}
                    value={m.providerId}
                    onChange={(e) => {
                      const next = [...(editing.members ?? [])];
                      next[i] = { ...m, providerId: e.target.value, model: null };
                      setEditing({ ...editing, members: next });
                    }}
                  >
                    <option value="">选择供应商</option>
                    {state.providers.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}{p.enabled ? '' : '（已停用）'}
                      </option>
                    ))}
                  </select>
                  <select
                    className="select"
                    style={{ minWidth: 120, flex: 1 }}
                    aria-label={`第 ${i + 1} 个成员模型`}
                    value={m.model ?? ''}
                    onChange={(e) => {
                      const next = [...(editing.members ?? [])];
                      next[i] = { ...m, model: e.target.value || null };
                      setEditing({ ...editing, members: next });
                    }}
                  >
                    <option value="">默认模型</option>
                    {m.model && !state.providers.find(provider => provider.id === m.providerId)?.models.some(model => model.id === m.model) && <option value={m.model}>{m.model}（已不在模型列表中）</option>}
                    {(state.providers.find((p) => p.id === m.providerId)?.models ?? []).map((mm) => (
                      <option key={mm.id} value={mm.id}>
                        {mm.id}
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    style={{ width: 70 }}
                    type="number"
                    aria-label={`第 ${i + 1} 个成员权重`}
                    min={0} max={1000} step={1}
                    disabled={editing.mode !== 'weight'}
                    value={m.weight}
                    onChange={(e) => {
                      const next = [...(editing.members ?? [])];
                      next[i] = { ...m, weight: Number(e.target.value) };
                      setEditing({ ...editing, members: next });
                    }}
                  />
                  <Btn size="sm" title={`上移第 ${i + 1} 个成员`} disabled={i === 0} onClick={() => moveMember(i, -1)}>↑</Btn>
                  <Btn size="sm" title={`下移第 ${i + 1} 个成员`} disabled={i === (editing.members?.length || 0) - 1} onClick={() => moveMember(i, 1)}>↓</Btn>
                  <Btn
                    size="sm"
                    variant="ghost"
                    title={`移除第 ${i + 1} 个成员`}
                    onClick={() =>
                      setEditing({ ...editing, members: (editing.members ?? []).filter((_, j) => j !== i) })
                    }
                  >
                    <Ico name="x" size={12} />
                  </Btn>
                </div>
              ))}
              <Btn
                size="sm"
                onClick={() =>
                  setEditing({
                    ...editing,
                    members: [
                      ...(editing.members ?? []),
                      { providerId: state.providers[0]?.id ?? '', model: null, weight: 1 },
                    ],
                  })
                }
              >
                <Ico name="plus" size={12} /> 添加成员
              </Btn>
            </div>
          </Field>
          </fieldset>
        </Modal>
      )}
      {connecting && <Modal title="分组接入参数" sub={`group/${connecting.name}`} onClose={() => setConnecting(null)}>
        <div className="notice">在支持自定义模型的客户端填写以下信息。使用分组时请保持云汇和本地网关运行。</div>
        {!connecting.enabled && <div className="notice warning">此分组已停用，启用后才能接收请求。</div>}
        {!state.gateway.running && <div className="notice warning">本地网关当前未运行，请到系统设置启动后再使用。</div>}
        <Field label="模型名"><code style={{ overflowWrap: 'anywhere' }}>group/{connecting.name}</code><Btn size="sm" onClick={() => { void copy(`group/${connecting.name}`, '模型名'); }}>复制模型名</Btn></Field>
        <Field label="OpenAI 兼容 / Responses 接口地址"><code style={{ overflowWrap: 'anywhere' }}>{gatewayBase}/v1</code><Btn size="sm" onClick={() => { void copy(`${gatewayBase}/v1`, '接口地址'); }}>复制接口地址</Btn></Field>
        <Field label="Claude / Anthropic 接口地址"><code style={{ overflowWrap: 'anywhere' }}>{gatewayBase}</code><span className="hint">请求路径为 /v1/messages；Gemini 原生请求使用 /v1beta/models/模型名:generateContent。</span></Field>
        <Field label="API Key" hint="填写云汇的网关令牌。供应商自己的密钥由云汇转发时使用。">
          <Btn size="sm" disabled={!window.aurora || !state.settings.gatewayToken} onClick={() => { void copy(state.settings.gatewayToken, '网关令牌'); }}>复制网关令牌</Btn>
        </Field>
        <p className="hint">当前客户端接入向导仍按单个供应商配置。请在客户端手动选择或填写以上分组模型；只复制参数不会改写客户端配置。</p>
      </Modal>}
    </>
  );
}
