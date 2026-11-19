import type { ActionDeps } from './actions.js';
import { getAdapter } from './agents/adapters.js';
import { buildUpstreamHttp, parseClientRequest, parseUpstreamJson } from './protocol/index.js';
import { openUpstream, readAll } from './gateway/upstream.js';
import { Router } from './gateway/router.js';
import type { ProtocolName } from './types.js';
import type { AuroraStore, Provider } from './store/index.js';

export interface ClientConnectionTestRequest {
  requestId: string;
  target: 'upstream' | 'local';
  agentId: string;
  providerId: string;
  model: string;
  authMode?: 'api' | 'coexist';
}
export interface ClientConnectionTestResult {
  ok: boolean;
  requestId: string;
  target: 'upstream' | 'local';
  agentId: string;
  providerId: string;
  model: string;
  protocol: ProtocolName | '';
  status?: number;
  latencyMs: number;
  message: string;
  canceled?: boolean;
  reason?: string;
}
interface TestEntry {
  signature: string;
  agentId: string;
  controller: AbortController;
  cancelReason?: 'canceled' | 'superseded' | 'timeout';
  promise: Promise<ClientConnectionTestResult>;
  finishedAt?: number;
}
interface TestRegistry { requests: Map<string, TestEntry>; agents: Map<string, TestEntry> }
const registries = new WeakMap<AuroraStore, TestRegistry>();
const REQUEST_FIELDS = new Set(['requestId', 'target', 'agentId', 'providerId', 'model', 'authMode']);
const PROTOCOLS = new Set<ProtocolName>(['openai-chat', 'openai-responses', 'anthropic', 'gemini']);
const TEST_TIMEOUT_MS = 30_000;
const TEST_OUTPUT_TOKENS = 1024;
const MAX_BODY_BYTES = 512 * 1024;
const idValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
// Existing model IDs may include Chinese names, namespaces, spaces and suffixes such as [1m].
// They are matched to stored models, sent as JSON, and encoded as one segment for Gemini.
const modelValid = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const localHost = (hostname: string) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname.toLowerCase());

function registryFor(store: AuroraStore): TestRegistry {
  let registry = registries.get(store);
  if (!registry) { registry = { requests: new Map(), agents: new Map() }; registries.set(store, registry); }
  // Retain recently completed IDs so repeated IPC delivery does not repeat a billable request.
  for (const [id, entry] of registry.requests) {
    if (entry.finishedAt && (Date.now() - entry.finishedAt > 5 * 60_000 || registry.requests.size >= 128)) registry.requests.delete(id);
  }
  return registry;
}

/** Desktop-only, explicit user action. Payload cannot supply URLs, files, headers or credentials. */
export async function testClientConnection(deps: ActionDeps, payload: unknown): Promise<ClientConnectionTestResult> {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const base: ClientConnectionTestResult = {
    ok: false, requestId: idValid(input.requestId) ? input.requestId : '', target: input.target === 'local' ? 'local' : 'upstream',
    agentId: '', providerId: '', model: '', protocol: '', latencyMs: 0, message: '',
  };
  const fail = (reason: string, message: string) => ({ ...base, reason, message });
  if (deps.platform === 'web') return fail('desktop_only', '请在电脑桌面端点击连接测试');
  if (Object.keys(input).some(key => !REQUEST_FIELDS.has(key)) || !idValid(input.requestId) || !idValid(input.agentId)
    || !idValid(input.providerId) || !modelValid(input.model) || !['upstream', 'local'].includes(String(input.target))
    || (input.authMode !== undefined && input.authMode !== 'api' && input.authMode !== 'coexist'))
    return fail('invalid_request', '测试参数无效，请重新选择客户端、供应商和模型');
  const request = input as unknown as ClientConnectionTestRequest;
  const adapter = getAdapter(request.agentId);
  if (!adapter || adapter.support === 'unsupported' || !PROTOCOLS.has(adapter.protocol as ProtocolName))
    return fail('unsupported_client', '此客户端尚未提供可验证的连接协议');
  Object.assign(base, { agentId: request.agentId, providerId: request.providerId, model: request.model });
  if (request.authMode === 'coexist' && !['codex-cli', 'chatgpt-desktop'].includes(adapter.id))
    return fail('unsupported_auth', '此客户端不支持官方账号共存模式');
  if (request.providerId === 'official') return fail('official_unsupported', '官方账号请在原客户端验证；连接测试不会读取或使用官方登录凭据');

  // A request ID names one immutable operation, even if the stored supplier changes later.
  const registry = registryFor(deps.store);
  const signature = JSON.stringify([request.target, request.agentId, request.providerId, request.model, request.authMode || 'api']);
  const duplicate = registry.requests.get(request.requestId);
  if (duplicate) return duplicate.signature === signature ? duplicate.promise : fail('duplicate_request', '测试编号已用于另一组参数，请重新发起测试');
  try {
    const provider = deps.store.getProvider(request.providerId);
    if (!provider || provider.official) return fail('provider_unavailable', '请选择有效的 API 供应商；官方订阅通道请在原客户端验证');
    if (!provider.enabled) return fail('provider_disabled', '请先启用所选供应商');
    if (!PROTOCOLS.has(provider.format)) return fail('invalid_protocol', '供应商协议无效，请检查供应商设置');
    if (!provider.models.some(model => model.id === request.model)) return fail('model_unavailable', '请先将所选模型保存到供应商的模型列表');
    base.protocol = request.target === 'local' ? adapter.protocol as ProtocolName : provider.format;
    let baseUrl: string;
    try {
      const url = new URL(provider.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      baseUrl = url.href.replace(/\/$/, '');
    } catch { return fail('invalid_provider_url', '供应商 API 地址无效，请检查地址和协议设置'); }
    const key = provider.apiKeys.find(item => item.enabled && !!item.key.trim());
    if (!key && !localHost(new URL(baseUrl).hostname)) return fail('missing_key', '所选供应商没有已启用的 API Key');
    const settings = deps.store.getSettings();
    let token = key?.key || '';
    let proxy = provider.proxy || settings.proxy || undefined;
    let model = request.model;
    if (request.target === 'local') {
      const gateway = deps.gatewayStatus();
      if (!gateway.running) return fail('gateway_stopped', '本地网关未运行，请先启动网关');
      if (!Number.isInteger(gateway.port) || gateway.port < 1 || gateway.port > 65535
        || !['127.0.0.1', 'localhost', '0.0.0.0', '::', '::1', '[::1]'].includes(gateway.host))
        return fail('invalid_gateway', '本地网关监听信息无效，请在系统设置中选择本机或局域网监听');
      // Never consume a renderer URL or proxy the local hop, even with a global proxy enabled.
      baseUrl = `http://${gateway.host === '::1' || gateway.host === '[::1]' ? '[::1]' : '127.0.0.1'}:${gateway.port}`;
      token = settings.gatewayToken;
      if (!token) return fail('missing_gateway_token', '本地网关缺少访问令牌，请检查系统设置');
      proxy = undefined;
      model = `${provider.id}/${request.model}`;
      const route = new Router(deps.store).resolveModel(model);
      if (!route.candidates.length) return fail('no_local_route', '所选供应商没有可用的本地路由，请检查密钥、冷却状态和模型设置');
      if (route.candidates.some(candidate => candidate.provider.id !== provider.id || candidate.model !== request.model))
        return fail('route_mismatch', '路由分组或供应商名称覆盖了所选模型，请检查路由设置后重试');
    }
    const previous = registry.agents.get(adapter.id);
    if (previous) { previous.cancelReason = 'superseded'; previous.controller.abort(); }
    const entry: TestEntry = { signature, agentId: adapter.id, controller: new AbortController(), promise: undefined! };
    registry.agents.set(adapter.id, entry);
    registry.requests.set(request.requestId, entry);
    entry.promise = performTest(base, request, provider, { baseUrl, token, proxy, model }, entry).finally(() => {
      entry.finishedAt = Date.now();
      if (registry.agents.get(adapter.id) === entry) registry.agents.delete(adapter.id);
    });
    return entry.promise;
  } catch { return fail('settings_unavailable', '无法读取连接设置，请刷新供应商和网关设置后重试'); }
}

async function performTest(base: ClientConnectionTestResult, request: ClientConnectionTestRequest, provider: Provider,
  connection: { baseUrl: string; token: string; proxy?: string; model: string }, entry: TestEntry): Promise<ClientConnectionTestResult> {
  const started = Date.now();
  let status: number | undefined;
  const result = (ok: boolean, reason: string, message: string, canceled = false): ClientConnectionTestResult => ({
    ...base, ok, reason, message, latencyMs: Date.now() - started, ...(status ? { status } : {}), ...(canceled ? { canceled: true } : {}),
  });
  const timer = setTimeout(() => { entry.cancelReason = 'timeout'; entry.controller.abort(); }, TEST_TIMEOUT_MS);
  try {
    const ir = parseClientRequest('openai-chat', { model: connection.model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: TEST_OUTPUT_TOKENS, stream: false });
    const selected = provider.models.find(model => model.id === request.model);
    const http = buildUpstreamHttp(ir, { baseUrl: connection.baseUrl, apiKey: connection.token, model: connection.model,
      format: base.protocol as ProtocolName, maxTokens: TEST_OUTPUT_TOKENS, supportsThinking: false,
      ...(request.target === 'upstream' ? { extraHeaders: provider.headers, thinkingField: selected?.thinkingField } : {}),
    }, base.protocol as ProtocolName);
    // Only this marker is added to local requests; stored supplier headers never reach the gateway.
    if (request.target === 'local') http.headers['x-aurora-agent'] = 'yunhui-connection-test';
    const response = await openUpstream(http.url, { method: 'POST', headers: http.headers, body: http.body, proxy: connection.proxy,
      timeoutMs: TEST_TIMEOUT_MS, signal: entry.controller.signal });
    if (entry.controller.signal.aborted) { response.raw.destroy(); throw new Error(); }
    status = response.status;
    if (status < 200 || status >= 300) {
      response.raw.destroy();
      const detail = status === 401 || status === 403 ? '认证失败，请检查 API Key 或网关令牌'
        : status === 404 ? '接口或模型不存在，请核对 API 地址、协议和模型 ID'
        : status === 429 ? '请求限流或额度不足，请检查供应商状态后重试'
        : status >= 300 && status < 400 ? '接口返回了重定向，请填写最终 API 地址'
        : '接口未能完成模型请求，请检查供应商和网关状态';
      return result(false, 'http_error', `${detail}（HTTP ${status}）`);
    }
    const body = await readAll(response.stream, MAX_BODY_BYTES);
    if (entry.controller.signal.aborted) throw new Error();
    if (request.target === 'local' && (response.headers['x-aurora-provider'] !== encodeURIComponent(provider.name)
      || response.headers['x-aurora-model'] !== encodeURIComponent(request.model)))
      return result(false, 'route_mismatch', '本地网关响应未确认所选供应商和模型，请检查路由设置');
    let parsed, json;
    try {
      json = JSON.parse(body);
      parsed = parseUpstreamJson(base.protocol as ProtocolName, json);
    } catch { return result(false, 'invalid_response', '接口已响应，但内容不符合所选模型协议或返回了模型错误；请检查协议和模型权限'); }
    // Thought parts are not final answers; require visible text in Gemini's wire response too.
    const hasText = base.protocol === 'gemini'
      ? json.candidates?.[0]?.content?.parts?.some((part: any) => part && !part.thought && typeof part.text === 'string' && part.text.trim())
      : parsed.blocks.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim());
    const reasoningTokens = Number(parsed.usage.reasoningTokens) || 0;
    const tokensUsed = (Number(parsed.usage.outputTokens) || 0) + (base.protocol === 'gemini' ? reasoningTokens : 0);
    const exhausted = parsed.stopReason === 'max_tokens'
      || (base.protocol === 'openai-responses' && json.status === 'incomplete' && json.incomplete_details?.reason === 'max_output_tokens')
      || (!hasText && reasoningTokens > 0 && Math.max(tokensUsed, reasoningTokens) >= TEST_OUTPUT_TOKENS);
    if (exhausted) return result(false, 'budget_exhausted', '接口已响应，但测试输出预算已用完，尚未验证完整文本输出；这不一定是连接配置错误，请在原客户端进一步验证。本次不会自动重试。');
    if (parsed.stopReason === 'error' || (base.protocol === 'openai-responses' && json.status !== undefined && json.status !== 'completed'))
      return result(false, 'invalid_response', '接口已响应，但模型请求未正常完成；请检查供应商状态和模型权限');
    if (!hasText) return result(false, 'no_text_response', '接口已响应，但尚未返回可见模型文本；模型可能仍在推理，请在原客户端进一步验证。本次不会自动重试。');
    return result(true, 'success', `${request.target === 'upstream' ? '上游模型响应正常' : '本地网关已完成所选客户端协议与模型路由测试'}${request.authMode === 'coexist' ? '；本次仅测试第三方 API 通道，官方账号通道需在原客户端验证' : ''}`);
  } catch {
    if (entry.cancelReason === 'timeout') return result(false, 'timeout', '测试超过 30 秒，已终止等待；请检查网络或供应商响应速度');
    if (entry.controller.signal.aborted) return result(false, entry.cancelReason || 'canceled', '测试已取消；已发送的请求仍可能产生少量用量', true);
    return result(false, 'network_error', '连接或响应读取失败，请检查网络、API 地址、代理和供应商状态');
  } finally { clearTimeout(timer); }
}

export function cancelClientConnectionTest(deps: ActionDeps, payload: unknown): { ok: boolean; canceled: boolean; message?: string } {
  if (deps.platform === 'web') return { ok: false, canceled: false, message: '请在电脑桌面端操作连接测试' };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'requestId')
    || !idValid((payload as any).requestId)) return { ok: false, canceled: false, message: '测试编号无效' };
  const entry = registries.get(deps.store)?.requests.get((payload as { requestId: string }).requestId);
  if (!entry || entry.finishedAt || entry.controller.signal.aborted) return { ok: true, canceled: false };
  entry.cancelReason = 'canceled'; entry.controller.abort();
  return { ok: true, canceled: true };
}
