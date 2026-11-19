import type { AgentCatalogItem, AgentState, AppState, Provider, UsageRecord } from './api';

export interface ClientConnectionRow {
  id: string;
  agents: AgentCatalogItem[];
  connection: AgentState;
  provider?: Provider;
  providerName: string;
  model: string;
  status: 'pending' | 'success' | 'warning';
  label: string;
  detail: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  shared: boolean;
}

const codingIds = new Set(['codex-cli', 'codex-desktop', 'chatgpt-desktop']);
const timestamp = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const successful = (request: UsageRecord) => request.status >= 200 && request.status < 300 && !request.error;

function belongsToClient(record: UsageRecord, agent: AgentCatalogItem): boolean {
  const name = record.agent.toLowerCase().trim();
  // Test traffic must never validate a client. Unknown agents cannot prove identity.
  if (!name || /yunhui|aurora|云汇|test|测试/.test(name)) return false;
  if (codingIds.has(agent.id)) return ['codex', 'codex cli', 'codex / chatgpt 桌面版', 'chatgpt-desktop', 'codex-cli', 'codex-desktop'].includes(name);
  if (agent.id === 'claude-code') return ['claude code', 'claude-code'].includes(name);
  // The gateway currently labels Claude desktop traffic as Claude Code. Do not
  // assign that ambiguous record to the desktop application's saved settings.
  if (agent.id === 'claude-desktop') return ['claude desktop', 'claude-desktop'].includes(name);
  if (agent.id === 'gemini-cli') return ['gemini cli', 'gemini-cli'].includes(name);
  if (agent.id === 'workbuddy') return ['workbuddy', 'codebuddy'].includes(name);
  return name === agent.id || name === agent.name.toLowerCase();
}

function failureReason(record: UsageRecord): string {
  // Old logs and upstream errors can contain private content. Show an actionable
  // category rather than rendering untrusted error text or stored credentials.
  if ([401, 403].includes(record.status)) return '认证或权限被拒绝，请检查供应商密钥和模型权限。';
  if (record.status === 404) return '接口或模型不存在，请核对 API 地址和模型 ID。';
  if (record.status === 429) return '请求受限或额度不足，请查看供应商状态和余额。';
  if (record.status >= 500) return '上游或网关请求失败，请打开连接测试定位原因。';
  if (!record.status) return '网络连接未完成，请检查服务地址、网络和代理。';
  return '最近一次请求未成功，请查看请求记录并重新测试连接。';
}

/** Read-only presentation of saved configuration and observed, matching gateway traffic. */
export function clientConnectionRows(state: AppState, records: UsageRecord[], now = Date.now()): ClientConnectionRow[] {
  const rows: ClientConnectionRow[] = [];
  const seen = new Set<string>();
  for (const agent of state.agentCatalog) {
    const connection = state.agents[agent.id];
    if (!connection || (!connection.connected && !connection.pendingReapply) || seen.has(agent.id)) continue;
    const agents = [agent]; seen.add(agent.id);
    if (codingIds.has(agent.id)) {
      for (const candidate of state.agentCatalog) {
        const next = state.agents[candidate.id];
        if (seen.has(candidate.id) || !codingIds.has(candidate.id) || !next) continue;
        if ((next.connected || next.pendingReapply) && JSON.stringify([next.providerId, next.model, next.mode, next.authMode, next.pendingReapply, next.configPath])
          === JSON.stringify([connection.providerId, connection.model, connection.mode, connection.authMode, connection.pendingReapply, connection.configPath])) {
          agents.push(candidate); seen.add(candidate.id);
        }
      }
    }
    const provider = state.providers.find(item => item.id === connection.providerId);
    const official = connection.providerId === 'official' && connection.authMode === 'coexist';
    const baseline = Math.max(...agents.map(item => timestamp(state.agents[item.id]?.lastSyncAt)), timestamp(provider?.updatedAt), timestamp(state.settings.connectionUpdatedAt ?? state.settings.updatedAt));
    const row: ClientConnectionRow = { id: agent.id, agents, connection, provider,
      providerName: official ? 'ChatGPT 官方账号' : provider?.name || '供应商已删除', model: connection.model || '未选择模型',
      status: 'pending', label: '配置已保存 · 待验证', detail: '重启客户端并发起一条对话，成功请求会显示在这里。', shared: agents.length > 1 };
    if (connection.pendingReapply) { row.label = '待应用到本机'; row.detail = '导入的连接尚未写入本机客户端，请重新预览并应用。'; }
    else if (!official && !provider) { row.status = 'warning'; row.label = '供应商已删除'; row.detail = '重新选择供应商后应用配置。'; }
    else if (provider && !provider.enabled) { row.status = 'warning'; row.label = '供应商已停用'; row.detail = '启用供应商或为客户端更换连接。'; }
    else if (connection.mode === 'direct') { row.label = '直连配置 · 待客户端验证'; row.detail = '直连请求不经过云汇；请在原客户端确认对话和模型可用。'; }
    else {
      const matching = records.filter(record => {
        const time = timestamp(record.ts);
        // Logs are dated when requests finish. A request already in flight when
        // configuration changed cannot verify the new connection.
        const started = Number.isFinite(record.latencyMs) && record.latencyMs >= 0 ? time - record.latencyMs : 0;
        return baseline > 0 && started >= baseline && time <= now && time >= now - 7 * 86400_000
          && record.providerId === connection.providerId && record.model === connection.model
          && agents.some(item => belongsToClient(record, item));
      }).sort((a, b) => timestamp(b.ts) - timestamp(a.ts));
      const recent = matching[0], success = matching.find(successful);
      row.lastSuccessAt = success?.ts;
      if (!state.gateway.running) { row.status = 'warning'; row.label = '本地网关已停止'; row.detail = '打开网关设置启动服务，再使用客户端。'; }
      else if (connection.authMode === 'coexist' && !state.codexCoexist?.identity.available) { row.status = 'warning'; row.label = '官方登录需检查'; row.detail = '请在原客户端检查官方账号登录，再验证共存连接。'; }
      else if (recent && !successful(recent)) { row.status = 'warning'; row.label = '最近请求失败'; row.detail = failureReason(recent); row.lastFailureAt = recent.ts; }
      else if (success) {
        if (success.agent.toLowerCase().trim() === 'claude code') {
          row.label = 'Claude 请求成功 · 待客户端核验';
          row.detail = '该供应商和模型已有 Claude 类客户端的成功请求，记录无法区分桌面与 CLI；请在原客户端核对。';
        } else {
          row.status = 'success'; row.label = '近期请求成功';
          row.detail = codingIds.has(agent.id) ? '共享编程配置已有成功请求，记录不区分桌面端、CLI 或共存入口；请在原客户端核对。' : '所选供应商和模型已有来自此客户端标识的成功网关请求。';
        }
      }
      else if (state.settings.logRequests === false) row.detail = '请求记录已关闭；本页打开期间可显示新请求，历史成功时间不可查询。';
      else if (!baseline) row.detail = '旧连接没有可核验的应用时间，请重新应用后在客户端发起对话。';
    }
    rows.push(row);
  }
  return rows;
}
