import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import * as zlib from 'node:zlib';
import { parse } from 'smol-toml';
import { codexHome } from '../codex.js';
import { applyContextDefaults, defaultAutoCompactTokenLimit, isValidContextWindow } from '../modelContext.js';
import type { AuroraStore } from '../store/index.js';
import { parseCodexHistoryRoute, type CodexHistoryTarget } from './historyRoute.js';

/** Official identity and inference routing are separate. This module never writes or refreshes OAuth. */
export const CODEX_COEXIST_BASE_PATH = '/codex-coexist/v1';
export const CODEX_OFFICIAL_MODEL_PREFIX = 'official/';
export const CODEX_OFFICIAL_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export type CoexistEndpoint = 'models' | 'responses' | 'compact';
export interface OfficialCodexIdentity {
  available: boolean;
  status: 'signed-in' | 'expired' | 'missing' | 'invalid';
  accountKnown: boolean;
  expiresAt?: string;
  message: string;
}
interface Credential { accessToken: string; accountId: string; accountScope: string; generation: string; expiresAt?: number }
export interface CoexistModel {
  id: string; upstreamModel: string; providerId: string; providerName: string;
  displayName: string; official: boolean; contextWindow?: number;
}
export interface CoexistCatalog {
  identity: OfficialCodexIdentity;
  models: CoexistModel[];
  nativeCatalog: { models: Record<string, any>[] };
  officialModelCount: number;
  officialModelSource: 'native-cache' | 'saved-cache' | 'none';
  warnings: string[];
}
export interface CodexCoexistAuthorization { readonly authenticated: true }
const authorizations = new WeakMap<CodexCoexistAuthorization, Credential>();
export type CoexistAuthResult = { ok: true; authorization: CodexCoexistAuthorization }
  | { ok: false; status: number; message: string };
export type CodexCoexistPlan = {
  kind: 'official'; method: 'POST'; url: string; headers: Record<string, string>; body: string; model: string;
} | {
  kind: 'gateway'; path: '/v1/responses'; headers: Record<string, string>; body: Record<string, any>; model: string;
  historyTarget?: CodexHistoryTarget;
};
export class CodexCoexistError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'CodexCoexistError'; }
}

/** Modern native Codex sends zstd. Decode before JSON parsing, with both compressed and expanded bounds. */
export async function readCodexCoexistBody(req: IncomingMessage): Promise<unknown> {
  const encoding = String(req.headers['content-encoding'] || 'identity').trim().toLowerCase();
  if (!['identity', 'zstd', 'gzip'].includes(encoding)) throw new CodexCoexistError(415, '共存接口不支持此请求压缩格式');
  const chunks: Buffer[] = []; let bytes = 0; const limit = 32 * 1024 * 1024;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > limit) throw new CodexCoexistError(413, '共存请求体超过32MB');
    chunks.push(data);
  }
  let body: Buffer<ArrayBufferLike> = Buffer.concat(chunks);
  if (encoding !== 'identity') {
    const decompress = encoding === 'gzip' ? zlib.gunzip : (zlib as any).zstdDecompress;
    if (!decompress) throw new CodexCoexistError(415, '当前运行环境不支持此请求压缩，请更新桌面运行环境');
    try {
      body = await new Promise<Buffer>((resolve, reject) => decompress(body, { maxOutputLength: limit }, (error: Error | null, value: Buffer) => error ? reject(error) : resolve(value)));
    } catch { throw new CodexCoexistError(400, '压缩请求无效或解压后超过32MB'); }
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new CodexCoexistError(400, '请求体不是合法 UTF-8 JSON'); }
}

function boundedJson(file: string, limit: number): any {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('Unsupported local file');
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid local object');
  return value;
}
function jwtClaims(token: string): any {
  try { const part = token.split('.')[1]; if (!part || part.length > 48 * 1024) return {}; return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); }
  catch { return {}; }
}
function credential(): Credential | undefined {
  const auth = boundedJson(path.join(codexHome(), 'auth.json'), 256 * 1024);
  if (auth.auth_mode && auth.auth_mode !== 'chatgpt') return undefined;
  const accessToken = auth.tokens?.access_token;
  if (typeof accessToken !== 'string' || !accessToken.trim() || /[\r\n]/.test(accessToken)) return undefined;
  const claims = jwtClaims(accessToken), idClaims = typeof auth.tokens?.id_token === 'string' ? jwtClaims(auth.tokens.id_token) : {};
  const account = auth.tokens?.account_id || claims['https://api.openai.com/auth']?.chatgpt_account_id || idClaims['https://api.openai.com/auth']?.chatgpt_account_id;
  const accountId = typeof account === 'string' && account.length < 512 && !/[\r\n]/.test(account) ? account : '';
  const subject = claims['https://api.openai.com/auth']?.chatgpt_user_id || idClaims['https://api.openai.com/auth']?.chatgpt_user_id || claims.sub || idClaims.sub;
  const accountScope = accountId ? `${accountId}\0${typeof subject === 'string' ? subject.slice(0, 512) : ''}` : '';
  const expiresAt = typeof claims.exp === 'number' && Number.isFinite(claims.exp) && claims.exp > 0 && claims.exp < 8.64e12 ? claims.exp * 1000 : undefined;
  return { accessToken: accessToken.trim(), accountId, accountScope, expiresAt, generation: createHash('sha256').update(accessToken).update('\0').update(accountId).digest('hex') };
}
/** Safe to expose through desktop IPC: no token, account ID, email or refresh credential. */
export function readOfficialCodexIdentity(): OfficialCodexIdentity {
  try {
    const value = credential();
    if (!value) return { available: false, status: 'missing', accountKnown: false, message: '请先在官方 ChatGPT / Codex 客户端登录' };
    const expired = value.expiresAt !== undefined && value.expiresAt <= Date.now();
    return { available: !expired, status: expired ? 'expired' : 'signed-in', accountKnown: !!value.accountId,
      ...(value.expiresAt ? { expiresAt: new Date(value.expiresAt).toISOString() } : {}),
      message: expired ? '官方登录已过期，请让官方客户端刷新或重新登录；云汇不会轮换其登录凭据' : '使用本机官方登录，凭据由官方客户端维护' };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { available: false, status: missing ? 'missing' : 'invalid', accountKnown: false,
      message: missing ? '尚未检测到官方 ChatGPT / Codex 登录' : '官方登录文件无法安全读取，未修改原文件' };
  }
}
export const officialCodexStatus = readOfficialCodexIdentity;

export function codexCoexistEndpoint(pathname: string): CoexistEndpoint | null {
  const history = parseCodexHistoryRoute(pathname);
  if (history?.mode === 'coexist') return history.endpoint;
  const pathOnly = pathname.split('?')[0];
  if (pathOnly === `${CODEX_COEXIST_BASE_PATH}/models`) return 'models';
  if (pathOnly === `${CODEX_COEXIST_BASE_PATH}/responses`) return 'responses';
  if (pathOnly === `${CODEX_COEXIST_BASE_PATH}/responses/compact`) return 'compact';
  return null;
}
export function codexCoexistBaseUrl(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('共存网关端口无效');
  return `http://127.0.0.1:${port}${CODEX_COEXIST_BASE_PATH}`;
}
export function isCodexCoexistConfigured(store: AuroraStore): boolean {
  try {
    const file = path.join(codexHome(), 'config.toml'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return false;
    const config: any = parse(fs.readFileSync(file, 'utf8'));
    const profile = typeof config.profile === 'string' ? config.profiles?.[config.profile] : undefined;
    const modelProvider = profile?.model_provider ?? config.model_provider;
    const endpoint = profile?.openai_base_url ?? config.openai_base_url;
    const overridden = [config.model_providers?.openai, profile?.model_providers?.openai].some(table => table && typeof table === 'object'
      && Object.keys(table).some(key => ['base_url', 'env_key', 'experimental_bearer_token', 'requires_openai_auth', 'http_headers', 'env_http_headers', 'wire_api'].includes(key)));
    const agents = store.listAgents(), connected = [agents['chatgpt-desktop'], agents['codex-desktop'], agents['codex-cli']]
      .some(agent => agent?.connected && agent.mode === 'gateway' && agent.authMode === 'coexist');
    return connected && !overridden && modelProvider === 'openai' && typeof endpoint === 'string'
      && endpoint.replace(/\/$/, '') === codexCoexistBaseUrl(store.getSettings().gatewayPort);
  } catch { return false; }
}
function loopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}
/** This credential is accepted only on the dedicated native endpoint, never on generic RPC or LAN. */
export function authorizeCodexCoexistRequest(req: IncomingMessage, store: AuroraStore): CoexistAuthResult {
  if (!codexCoexistEndpoint(req.url || '')) return { ok: false, status: 404, message: '未知的官方共存接口' };
  let host: URL;
  try { host = new URL(`http://${req.headers.host}`); } catch { return { ok: false, status: 403, message: '共存接口只允许本机请求' }; }
  if (!loopback(req.socket.remoteAddress) || !['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)
    || host.username || host.password || Number(host.port || 80) !== store.getSettings().gatewayPort
    || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
    return { ok: false, status: 403, message: '共存接口只允许本机原生客户端请求' };
  }
  if (!isCodexCoexistConfigured(store)) return { ok: false, status: 409, message: '请先在客户端页应用官方账号共存配置' };
  try {
    const live = credential();
    const supplied = typeof req.headers.authorization === 'string' ? /^Bearer ([^\r\n]+)$/i.exec(req.headers.authorization)?.[1] : undefined;
    if (!live || !supplied || (live.expiresAt !== undefined && live.expiresAt <= Date.now())) return { ok: false, status: 401, message: '官方登录不可用，请在官方客户端重新登录' };
    const expectedBytes = Buffer.from(live.accessToken), suppliedBytes = Buffer.from(supplied);
    if (expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) return { ok: false, status: 401, message: '请求与当前官方客户端登录不匹配' };
    const authorization = Object.freeze({ authenticated: true as const });
    authorizations.set(authorization, live);
    return { ok: true, authorization };
  } catch { return { ok: false, status: 401, message: '无法读取官方登录，请在官方客户端检查登录状态' }; }
}

function cleanModelMetadata(value: any, depth = 0): any {
  if (depth > 20) return null;
  if (Array.isArray(value)) return value.map(item => cleanModelMetadata(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/^(authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|tokens|account[_-]?id|email|password|__proto__|constructor|prototype)$/i.test(key))
    .map(([key, item]) => [key, cleanModelMetadata(item, depth + 1)]));
  return value;
}
function bareCacheIsOfficial(store: AuroraStore, persist = true): boolean {
  try {
    const configPath = path.join(codexHome(), 'config.toml');
    if (!fs.existsSync(configPath)) return true;
    const stat = fs.lstatSync(configPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return false;
    const config: any = parse(fs.readFileSync(configPath, 'utf8'));
    const profile = typeof config.profile === 'string' ? config.profiles?.[config.profile] : undefined;
    const provider = profile?.model_provider ?? config.model_provider;
    const endpoint = profile?.openai_base_url ?? config.openai_base_url;
    const catalog = profile?.model_catalog_json ?? config.model_catalog_json;
    if (config.model_providers?.openai || profile?.model_providers?.openai) return false;
    return (!provider || provider === 'openai') && (!endpoint || endpoint.replace(/\/$/, '') === codexCoexistBaseUrl((persist ? store.getSettings() : store.settings.read()).gatewayPort))
      && (!catalog || (typeof catalog === 'string' && path.resolve(codexHome(), catalog) === path.join(store.dir, 'codex-model-catalog.json')));
  } catch { return false; }
}
function normalizeOfficialModels(rawModels: any[], permitBare: boolean): Record<string, any>[] {
  const seen = new Set<string>();
  return rawModels.slice(0, 1000).flatMap((raw: any) => {
      if (!raw || typeof raw.slug !== 'string') return [];
      const aliased = raw.slug.startsWith(CODEX_OFFICIAL_MODEL_PREFIX), slug = aliased ? raw.slug.slice(CODEX_OFFICIAL_MODEL_PREFIX.length) : raw.slug;
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(slug) || seen.has(slug) || raw.visibility === 'hide'
        || (!aliased && !permitBare)) return [];
      seen.add(slug);
      const model = cleanModelMetadata(raw);
      model.slug = slug;
      if (aliased && typeof model.display_name === 'string') model.display_name = model.display_name.replace(/^官方 · /, '');
      model.base_instructions = typeof raw.base_instructions === 'string' ? raw.base_instructions
        : typeof raw.model_messages?.instructions_template === 'string' ? raw.model_messages.instructions_template : '';
      return [model];
    });
}
function officialNativeModels(store: AuroraStore, persist = true): { models: Record<string, any>[]; source: CoexistCatalog['officialModelSource'] } {
  let identity = '';
  try { const live = credential(); if (!live) return { models: [], source: 'none' };
    if (live.accountScope) identity = createHash('sha256').update(live.accountScope).digest('hex');
  } catch { return { models: [], source: 'none' }; }
  const snapshotFile = 'codex-official-models.json';
  let previous: Record<string, any>[] = [];
  try { const saved = boundedJson(path.join(store.dir, snapshotFile), 12 * 1024 * 1024);
    if (identity && saved.schema === 1 && saved.identity === identity && Array.isArray(saved.models)) previous = normalizeOfficialModels(saved.models, true);
  } catch { /* The managed snapshot is optional; it is never a credential backup. */ }
  try {
    const cache = boundedJson(path.join(codexHome(), 'models_cache.json'), 12 * 1024 * 1024);
    const models = Array.isArray(cache.models) ? normalizeOfficialModels(cache.models, bareCacheIsOfficial(store, persist)) : [];
    if (models.length) {
      if (persist && identity && JSON.stringify(models) !== JSON.stringify(previous)) {
        try { store.writeExtra(snapshotFile, { schema: 1, identity, models }); } catch { /* A read-only catalog still works for this run. */ }
      }
      return { models, source: 'native-cache' };
    }
  } catch { /* Missing/rebuilt native caches can recover from the same-account metadata snapshot. */ }
  return { models: previous, source: previous.length ? 'saved-cache' : 'none' };
}
/** Native cache metadata is a local discovery source, not proof of remote model entitlement.
 * persist=false also bypasses settings migrations, keeping diagnostic discovery strictly read-only.
 */
export function getCoexistCatalog(store: AuroraStore, persist = true): CoexistCatalog {
  const identity = readOfficialCodexIdentity(), discovered = officialNativeModels(store, persist), native = discovered.models, models: CoexistModel[] = [], nativeModels: Record<string, any>[] = [];
  for (const model of native) {
    const contextWindow = applyContextDefaults({ id: model.slug, ...(isValidContextWindow(model.context_window) ? { contextWindow: model.context_window } : {}) }).contextWindow;
    const id = `${CODEX_OFFICIAL_MODEL_PREFIX}${model.slug}`, displayName = `官方 · ${String(model.display_name || model.slug)}`;
    models.push({ id, upstreamModel: model.slug, providerId: 'official', providerName: 'ChatGPT 官方账号', displayName, official: true,
      ...(contextWindow !== undefined ? { contextWindow } : {}) });
    nativeModels.push({ ...model, ...(contextWindow !== undefined ? { context_window: contextWindow, auto_compact_token_limit: defaultAutoCompactTokenLimit(contextWindow) } : {}), slug: id, display_name: displayName, prefer_websockets: false });
  }
  for (const provider of store.listProviders()) {
    let local = false;
    try { const hostname = new URL(provider.baseUrl).hostname.replace(/^\[|\]$/g, ''); local = hostname === 'localhost' || hostname === '::1' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname); } catch { /* invalid URLs are not exposed */ }
    if (!provider.enabled || provider.id === 'official' || !provider.apiKeys.some(key => key.enabled && (key.key || local))) continue;
    for (const model of provider.models) {
      if (!model.id || model.id.length > 400 || /[\r\n\0]/.test(model.id)) continue;
      const contextWindow = applyContextDefaults({ id: model.id, ...(isValidContextWindow(model.contextWindow) ? { contextWindow: model.contextWindow } : {}) }).contextWindow;
      const id = `${provider.id}/${model.id}`, displayName = `${provider.name} · ${model.displayName || model.id}`;
      models.push({ id, upstreamModel: model.id, providerId: provider.id, providerName: provider.name, displayName, official: false, contextWindow });
      // Keep the actual local client's schema, but do not advertise capabilities merely inherited from an official model.
      const template = native[0] ? structuredClone(native[0]) : {};
      for (const key of ['multi_agent_version', 'use_responses_lite', 'supports_image_detail_original']) delete template[key];
      nativeModels.push({ ...template, slug: id, display_name: displayName, description: `${provider.name} / ${model.id}`,
        base_instructions: '', model_messages: null, priority: 1000 + nativeModels.length, visibility: 'list', supported_in_api: true,
        default_reasoning_level: 'none', supported_reasoning_levels: [{ effort: 'none', description: '使用供应商默认行为' }],
        additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null,
        supports_parallel_tool_calls: false, supports_reasoning_summaries: false, support_verbosity: false,
        experimental_supported_tools: [], supports_search_tool: false, supports_tool_search: false,
        input_modalities: model.capabilities?.vision ? ['text', 'image'] : ['text'],
        context_window: contextWindow ?? 32768, max_context_window: contextWindow ?? null,
        effective_context_window_percent: 95, auto_compact_token_limit: defaultAutoCompactTokenLimit(contextWindow ?? 32768),
        prefer_websockets: false, shell_type: 'shell_command', truncation_policy: { mode: 'tokens', limit: 10000 } });
    }
  }
  const warnings = native.length ? [] : ['未找到官方客户端模型缓存；请先在官方客户端登录并加载模型列表后重新应用共存配置'];
  if (discovered.source === 'saved-cache') warnings.push('官方列表使用同一账号上次读取的本机目录；实际可用模型以官方服务响应为准');
  if (!identity.available) warnings.push(identity.message);
  return { identity, models, nativeCatalog: { models: nativeModels }, officialModelCount: native.length, officialModelSource: discovered.source, warnings };
}

const SAFE_SESSION_HEADERS = ['user-agent', 'session-id', 'thread-id', 'x-thread-id', 'x-codex-thread-id', 'x-codex-beta-features',
  'x-codex-window-id', 'x-codex-parent-thread-id', 'x-client-request-id'] as const;
/** Rebuild, never copy, outbound headers. No authorization/cookies/account/actor fields reach a supplier. */
export function coexistSessionHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of SAFE_SESSION_HEADERS) {
    const value = headers[key];
    if (typeof value === 'string' && value.length <= 4096 && !/[\r\n]/.test(value)) safe[key] = value;
  }
  return safe;
}
export function prepareCodexCoexistRequest(authorization: CodexCoexistAuthorization, store: AuroraStore,
  pathname: string, body: unknown, incomingHeaders: IncomingMessage['headers'] = {}): CodexCoexistPlan {
  const authenticated = authorizations.get(authorization), endpoint = codexCoexistEndpoint(pathname);
  if (!authenticated) throw new CodexCoexistError(401, '缺少有效的官方客户端认证');
  let current: Credential | undefined;
  try { current = credential(); } catch { /* fail closed if the native file changed */ }
  if (!current || current.generation !== authenticated.generation) throw new CodexCoexistError(409, '官方登录刚刚更新，请重新发送请求');
  if (current.expiresAt !== undefined && current.expiresAt <= Date.now()) throw new CodexCoexistError(401, '官方登录已过期，请让官方客户端刷新或重新登录');
  if (endpoint !== 'responses' && endpoint !== 'compact') throw new CodexCoexistError(404, '此接口不接受模型生成请求');
  const history = parseCodexHistoryRoute(pathname);
  if (!body || typeof body !== 'object' || Array.isArray(body) || (!history && typeof (body as any).model !== 'string')) throw new CodexCoexistError(400, 'Responses 请求缺少模型');
  const value = history ? { ...(body as Record<string, any>), model: history.target } : body as Record<string, any>, catalog = getCoexistCatalog(store);
  if (history && history.providerId !== 'official') {
    const provider = store.getProvider(history.providerId);
    if (!provider) throw new CodexCoexistError(404, '历史兼容连接指定的供应商已删除，请重新应用配置');
    if (!provider.enabled) throw new CodexCoexistError(409, '历史兼容连接指定的供应商已停用，请启用或重新应用配置');
  }
  const entry = catalog.models.find(model => model.id === value.model)
    || (!history ? catalog.models.find(model => model.official && model.upstreamModel === value.model) : undefined);
  if (!entry) {
    if (history && history.providerId !== 'official' && store.getProvider(history.providerId)?.models.some(model => model.id === history.model))
      throw new CodexCoexistError(503, '历史兼容连接指定的供应商没有可用密钥，请检查供应商设置');
    throw new CodexCoexistError(400, '模型不在当前共存目录中，请重新选择模型并应用配置');
  }
  const headers = coexistSessionHeaders(incomingHeaders);
  if (entry.official) {
    headers.authorization = `Bearer ${authenticated.accessToken}`;
    headers.originator = 'codex_cli_rs';
    headers['content-type'] = 'application/json';
    headers.accept = value.stream ? 'text/event-stream' : 'application/json';
    if (authenticated.accountId) headers['chatgpt-account-id'] = authenticated.accountId;
    return { kind: 'official', method: 'POST', url: `${CODEX_OFFICIAL_BASE_URL}/responses${endpoint === 'compact' ? '/compact' : ''}`,
      headers, body: JSON.stringify({ ...value, model: entry.upstreamModel }), model: entry.upstreamModel };
  }
  if (endpoint === 'compact') throw new CodexCoexistError(501, '该中转尚未适配 Responses compact；未调用供应商或伪造压缩结果');
  // Explicit provider-qualified model prevents same-name fallback to the official account or another supplier.
  return { kind: 'gateway', path: '/v1/responses', headers, body: { ...value, model: entry.id }, model: entry.id,
    ...(history ? { historyTarget: { target: history.target, providerId: history.providerId, model: history.model } } : {}) };
}
