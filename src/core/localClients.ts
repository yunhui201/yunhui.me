import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import type { AuroraStore, Provider } from './store/index.js';
import type { ProtocolName } from './types.js';
import { atomicWrite, readText } from './agents/configFiles.js';
import { CLAUDE_DESKTOP_PROFILE, resolveClaudeDesktopConfig } from './claudeDesktopPaths.js';
import { isValidContextWindow } from './modelContext.js';

export type LocalSourceStatus = 'imported' | 'updated' | 'unchanged' | 'linked' | 'modified' | 'ignored' | 'missing-key' | 'unsupported' | 'missing-file';
export interface LocalClientSource {
  id: string; clientId: string; label: string; path: string; status: LocalSourceStatus;
  providerId?: string; message?: string; canRestore?: boolean;
}
export interface LocalAccount {
  id: string; kind: 'claude' | 'chatgpt' | 'copilot' | 'gemini'; label: string; source: string;
  authKind: 'oauth'; importable: false; found: true; format: ProtocolName;
  credentialStatus: 'present' | 'expired' | 'record-only' | 'unknown'; expiresAt?: string;
  email?: string; plan?: string; note: string;
}
export interface LocalClientsSnapshot {
  ok: boolean; checkedAt: string; sources: LocalClientSource[]; accounts: LocalAccount[];
  added: number; updated: number; warnings: string[];
}
export interface LocalClientOptions {
  /** A refresh never overrides manual edits or deletion tombstones. */
  force?: boolean; gatewayUrl?: string;
  /** Trusted main-process/test options, never populated from an RPC body. */
  home?: string; environment?: Record<string, string | undefined>; platform?: NodeJS.Platform;
}
interface Candidate { source: LocalClientSource; name: string; format: ProtocolName; baseUrl: string; key: string; models: string[]; context?: { modelId: string; value: number } }
interface RecordEntry {
  source: Pick<LocalClientSource, 'id' | 'clientId' | 'label' | 'path'>;
  providerId?: string; managedHash?: string; candidateHash?: string; owned?: boolean; suppressed?: boolean;
}
interface Ledger { version: 1; sources: Record<string, RecordEntry>; snapshot: LocalClientsSnapshot }
interface Context { home: string; environment: Record<string, string | undefined>; platform: NodeJS.Platform; isolated: boolean; gatewayUrls: string[]; gatewayToken: string }
const LEDGER = 'local-client-imports.json';
const lastSuccessfulScan = new WeakMap<AuroraStore, number>();
const emptySnapshot = (): LocalClientsSnapshot => ({ ok: true, checkedAt: '', sources: [], accounts: [], added: 0, updated: 0, warnings: [] });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const textValue = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined;
const dynamic = (v: string) => /\$\{|\$\(|`|\{(?:env|file):|^\$[A-Za-z_]/.test(v);
const validKey = (v: unknown): v is string => typeof v === 'string' && v.length >= 8 && v.length <= 8192
  && !/[\s\u0000-\u001f]/.test(v) && !dynamic(v) && !/^(?:your[-_]?|replace[-_]?|example|placeholder|undefined|null|sk-ant-oat)/i.test(v)
  && !/^eyJ[^.]+\.[^.]+\.[^.]+$/.test(v);
const modelId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 300 && !/[\s\u0000-\u001f]/.test(v) && !dynamic(v);

function codexStaticHeadersSupported(value: unknown): boolean {
  if (value === undefined) return true;
  if (!object(value)) return false;
  const entries = Object.entries(value);
  // Sub2API's Codex API-key template uses this exact non-credential marker.
  // Ignore it during import: it is neither an API key nor an imported capability.
  // Requiring one entry also rejects duplicate names with different casing.
  return entries.length === 0 || (entries.length === 1
    && entries[0][0].toLowerCase() === 'x-openai-actor-authorization'
    && entries[0][1] === 'local-image-extension');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function managedHash(provider: Provider): string {
  const { createdAt, updatedAt, quota, ...configuration } = provider;
  return hash(canonical({ ...configuration, apiKeys: provider.apiKeys.map(({ lastUsedAt, lastError, cooldownUntil, ...key }) => key) }));
}
function candidateHash(candidate: Candidate): string {
  return hash(canonical({ name: candidate.name, format: candidate.format, baseUrl: candidate.baseUrl, key: candidate.key, models: candidate.models, context: candidate.context }));
}
function loadLedger(store: AuroraStore): Ledger {
  const file = path.join(store.dir, LEDGER);
  if (!fs.existsSync(file)) return { version: 1, sources: {}, snapshot: emptySnapshot() };
  try {
    const parsed = JSON.parse(readText(file));
    if (parsed?.version !== 1 || !object(parsed.sources) || !object(parsed.snapshot)) throw new Error();
    for (const [id, value] of Object.entries(parsed.sources)) {
      if (!/^local_[a-f0-9]{28}$/.test(id) || !object(value) || !object(value.source) || value.source.id !== id
        || !['clientId', 'label', 'path'].every(key => typeof value.source[key] === 'string')
        || typeof value.providerId !== 'string' || typeof value.owned !== 'boolean'
        || (value.suppressed !== undefined && typeof value.suppressed !== 'boolean')
        || !/^[a-f0-9]{64}$/.test(value.candidateHash)
        || (value.owned && !/^[a-f0-9]{64}$/.test(value.managedHash))) throw new Error();
    }
    if (!Array.isArray(parsed.snapshot.sources) || !Array.isArray(parsed.snapshot.accounts) || !Array.isArray(parsed.snapshot.warnings)
      || typeof parsed.snapshot.checkedAt !== 'string' || typeof parsed.snapshot.ok !== 'boolean') throw new Error();
    return parsed;
  } catch { throw new Error('本地客户端来源记录损坏，已停止自动导入。请恢复该记录，避免重复创建已删除的供应商。'); }
}
function saveLedger(store: AuroraStore, ledger: Ledger): void {
  atomicWrite(path.join(store.dir, LEDGER), JSON.stringify(ledger, null, 2) + '\n');
}
function context(store: AuroraStore, options: LocalClientOptions): Context {
  const isolated = options.home !== undefined || !!process.env.AURORA_CLIENT_HOME;
  const environment = options.environment ?? (isolated ? {} : process.env);
  const home = path.resolve(options.home || process.env.AURORA_CLIENT_HOME || os.homedir());
  const settings = store.getSettings();
  const gatewayUrls = [options.gatewayUrl, `http://127.0.0.1:${settings.gatewayPort}`, `http://localhost:${settings.gatewayPort}`, `http://[::1]:${settings.gatewayPort}`,
    `http://${settings.gatewayHost}:${settings.gatewayPort}`].filter((url): url is string => !!url);
  return { home, environment, platform: options.platform ?? process.platform, isolated, gatewayUrls, gatewayToken: settings.gatewayToken };
}
function source(clientId: string, label: string, file: string, slot = ''): LocalClientSource {
  return { id: 'local_' + hash(`${clientId}\n${path.resolve(file)}\n${slot}`).slice(0, 28), clientId, label, path: path.resolve(file), status: 'unchanged' };
}
function endpoint(value: unknown, protocol: ProtocolName): string | undefined {
  if (typeof value !== 'string' || dynamic(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    if (['openai-chat', 'openai-responses'].includes(protocol) && url.pathname === '/') url.pathname = '/v1';
    return url.toString().replace(/\/+$/, '');
  } catch { return undefined; }
}
function ownGateway(url: string, key: string, ctx: Context): boolean {
  if (key && key === ctx.gatewayToken) return true;
  const parsed = new URL(url);
  return ctx.gatewayUrls.some(candidate => {
    try {
      const gateway = new URL(candidate);
      const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', '[::]'].includes(host);
      return parsed.protocol === gateway.protocol && parsed.port === gateway.port && (parsed.hostname === gateway.hostname || (loopback(parsed.hostname) && loopback(gateway.hostname)));
    } catch { return false; }
  });
}

/** Only known on-disk schemas are inspected. No keychain, command, helper, shell or network is invoked. */
function discover(ctx: Context): { candidates: Candidate[]; sources: LocalClientSource[]; accounts: LocalAccount[]; warnings: string[] } {
  const candidates: Candidate[] = [], sources: LocalClientSource[] = [], accounts: LocalAccount[] = [], warnings: string[] = [];
  const note = (s: LocalClientSource, status: LocalSourceStatus, message: string) => { s.status = status; s.message = message; sources.push(s); };
  const read = (file: string, label: string): string | undefined => {
    if (!fs.existsSync(file)) return undefined;
    try {
      const actualParent = fs.realpathSync(path.dirname(file));
      const expectedParent = path.resolve(path.dirname(file));
      if ((ctx.platform === 'win32' ? actualParent.toLowerCase() !== expectedParent.toLowerCase() : actualParent !== expectedParent)) throw new Error();
      return readText(file);
    } catch { warnings.push(`${label}：配置不是可安全读取的普通文件，已跳过。`); return undefined; }
  };
  const json = (file: string, label: string): Record<string, any> | undefined => {
    const raw = read(file, label); if (raw === undefined) return undefined;
    try { const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); if (!object(parsed)) throw new Error(); return parsed; }
    catch { warnings.push(`${label}：JSON 配置无效，已跳过；没有改写源文件。`); return undefined; }
  };
  const add = (s: LocalClientSource, name: string, format: ProtocolName, base: unknown, key: unknown, models: unknown[], context?: Candidate['context']): void => {
    const baseUrl = endpoint(base, format);
    if (!baseUrl) return note(s, 'unsupported', '接口地址不明确、包含动态值或不受支持，需手动确认。');
    if (!validKey(key)) return note(s, 'missing-key', '没有明确可用的静态 API Key；OAuth、占位符和动态命令均不作为 API Key 导入。');
    if (ownGateway(baseUrl, key, ctx)) return note(s, 'ignored', '这是云汇自己的网关配置，已跳过以避免循环调用。');
    const uniqueModels = [...new Set(models.filter(modelId))];
    candidates.push({ source: s, name, format, baseUrl, key, models: uniqueModels, ...(context && uniqueModels.includes(context.modelId) && isValidContextWindow(context.value) ? { context } : {}) });
  };
  const account = (kind: LocalAccount['kind'], label: string, file: string, format: ProtocolName, credential: unknown, metadata: Record<string, any> = {}): void => {
    const rawExpiry = metadata.expiresAt ?? metadata.expires_at ?? metadata.expiry_date;
    const time = typeof rawExpiry === 'number' ? rawExpiry * (rawExpiry < 1e12 ? 1000 : 1) : typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : NaN;
    const expiresAt = Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : undefined;
    const present = typeof credential === 'string' && credential.length > 0;
    const credentialStatus = present ? (expiresAt && time <= Date.now() ? 'expired' : 'present') : 'record-only';
    const email = textValue(metadata.email ?? metadata.emailAddress);
    accounts.push({ id: `local-${kind}-${hash(file).slice(0, 12)}`, kind, label, source: file, format, authKind: 'oauth', importable: false, found: true,
      credentialStatus, expiresAt, ...(email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? { email } : {}),
      ...(textValue(metadata.subscriptionType ?? metadata.plan) ? { plan: textValue(metadata.subscriptionType ?? metadata.plan) } : {}),
      note: '仅识别本机登录记录，未验证在线有效性。登录和续期由官方客户端管理，OAuth 不会导入为通用 API Key。' });
  };

  const codexDir = ctx.environment.CODEX_HOME || path.join(ctx.home, '.codex');
  const codexFile = path.join(codexDir, 'config.toml'), authFile = path.join(codexDir, 'auth.json');
  const auth = json(authFile, 'Codex 登录记录');
  const hasCodexOauth = !!(auth?.auth_mode === 'chatgpt' || textValue(auth?.tokens?.access_token) || textValue(auth?.tokens?.id_token) || textValue(auth?.tokens?.refresh_token));
  if (hasCodexOauth) account('chatgpt', 'ChatGPT 官方账号（Codex 登录记录）', authFile, 'openai-responses', auth?.tokens?.access_token ?? auth?.tokens?.id_token ?? auth?.access_token, auth?.tokens ?? auth);
  const codexText = read(codexFile, 'Codex / ChatGPT 配置');
  let codex: Record<string, any> = {};
  let codexValid = true;
  if (codexText !== undefined) {
    try { codex = parseToml(codexText) as Record<string, any>; }
    catch { codexValid = false; note(source('codex-cli', 'Codex / ChatGPT 配置', codexFile), 'unsupported', 'TOML 解析失败，已跳过所有供应商，避免误读密钥所属接口。'); }
  }
  if (codexValid) {
    const profiles = object(codex.profiles) ? codex.profiles : {};
    const selectedProfile = typeof codex.profile === 'string' && object(profiles[codex.profile]) ? profiles[codex.profile] : {};
    const currentId = textValue(selectedProfile.model_provider ?? codex.model_provider) ?? 'openai';
    const currentModel = selectedProfile.model ?? codex.model;
    const currentWindow = selectedProfile.model_context_window ?? codex.model_context_window;
    const currentContext = modelId(currentModel) && isValidContextWindow(currentWindow) ? { modelId: currentModel, value: currentWindow } : undefined;
    const providers = { ...(object(codex.model_providers) ? codex.model_providers : {}) };
    if (object(selectedProfile.model_providers)) for (const [id, override] of Object.entries(selectedProfile.model_providers)) {
      if (object(override)) providers[id] = { ...(object(providers[id]) ? providers[id] : {}), ...override };
    }
    const openaiBase = selectedProfile.openai_base_url ?? codex.openai_base_url ?? ctx.environment.OPENAI_BASE_URL;
    const authKey = auth?.auth_mode === 'chatgpt' || (hasCodexOauth && auth?.auth_mode !== 'apikey') ? undefined : auth?.OPENAI_API_KEY;
    for (const [id, p] of Object.entries(providers)) {
      if (!object(p)) continue;
      const s = source('codex-cli', `Codex / ChatGPT · ${textValue(p.name) || id}`, codexFile, id);
      if (id === 'yunhui' || id === 'aurora') { note(s, 'ignored', '云汇管理的 provider 不重复导入。'); continue; }
      if (p.wire_api !== undefined && !['responses', 'chat'].includes(p.wire_api)) { note(s, 'unsupported', '此 provider 使用的接口协议暂不支持自动导入。'); continue; }
      if (p.api_key_helper || p.apiKeyHelper || !codexStaticHeadersSupported(p.http_headers)
        || (p.env_http_headers !== undefined && (!object(p.env_http_headers) || Object.keys(p.env_http_headers).length))) {
        note(s, 'unsupported', '此 provider 使用自定义认证头或动态助手，请手动配置，未执行任何命令。'); continue;
      }
      let key: unknown = p.experimental_bearer_token;
      if (p.env_key !== undefined) {
        if (typeof p.env_key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.env_key)) { note(s, 'missing-key', '环境变量名称无效，未解析或执行动态值。'); continue; }
        if (key !== undefined && key !== ctx.environment[p.env_key]) { note(s, 'unsupported', '静态密钥与环境密钥同时存在且不一致，需手动确认。'); continue; }
        key = ctx.environment[p.env_key];
      }
      if (key === undefined && p.env_key === undefined && id === currentId && (p.requires_openai_auth === true || id === 'openai')) key = authKey;
      const models = [id === currentId ? currentModel : undefined, ...Object.values(profiles).filter(object).filter(v => v.model_provider === id).map(v => v.model)];
      const base = id === 'openai' ? openaiBase ?? p.base_url ?? 'https://api.openai.com/v1' : p.base_url;
      add(s, s.label, p.wire_api === 'chat' ? 'openai-chat' : 'openai-responses', base, key, models, id === currentId ? currentContext : undefined);
    }
    if (currentId === 'openai' && authKey !== undefined && !Object.hasOwn(providers, 'openai')) {
      add(source('codex-cli', 'Codex / ChatGPT · API 登录配置', authFile, 'openai-api'), 'Codex API · 本机配置', 'openai-responses', openaiBase ?? 'https://api.openai.com/v1', authKey, [currentModel], currentContext);
    } else if (authKey !== undefined && currentId !== 'openai' && !Object.hasOwn(providers, currentId)) {
      note(source('codex-cli', 'Codex / ChatGPT · API 登录配置', authFile, 'unresolved-api'), 'unsupported', '当前自定义 provider 没有明确接口地址，未将其密钥误当作 OpenAI 官方密钥。');
    }
  }

  const claudeDir = ctx.environment.CLAUDE_CONFIG_DIR || path.join(ctx.home, '.claude');
  const claudeFile = path.join(claudeDir, 'settings.json'), claude = json(claudeFile, 'Claude Code');
  if (claude) {
    const s = source('claude-code', 'Claude Code · 用户配置', claudeFile);
    if (claude.apiKeyHelper || claude.api_key_helper) note(s, 'unsupported', 'API Key 由动态助手提供，未执行助手。');
    else {
      const env = object(claude.env) ? claude.env : {};
      if (env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY) note(s, 'unsupported', '当前使用云平台身份认证，请按对应平台手动配置。');
      else if (env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_API_KEY && env.ANTHROPIC_AUTH_TOKEN !== env.ANTHROPIC_API_KEY) note(s, 'unsupported', '同时存在不同认证字段，需手动确认密钥优先级。');
      else if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_BASE_URL) add(s, 'Claude Code · 本机配置', 'anthropic', env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN,
        [env.ANTHROPIC_MODEL, env.ANTHROPIC_DEFAULT_OPUS_MODEL, env.ANTHROPIC_DEFAULT_SONNET_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL]);
    }
  }
  const claudeCredentialsFile = path.join(claudeDir, '.credentials.json');
  const claudeCredentials = json(claudeCredentialsFile, 'Claude 官方登录记录');
  const claudeOAuth = object(claudeCredentials?.claudeAiOauth) ? claudeCredentials.claudeAiOauth : undefined;
  if (claudeOAuth) account('claude', 'Claude 官方账号', claudeCredentialsFile, 'anthropic', claudeOAuth.accessToken ?? claudeOAuth.access_token, claudeOAuth);
  else {
    const accountFile = path.join(ctx.home, '.claude.json');
    const record = json(accountFile, 'Claude 本地账号记录');
    if (object(record?.oauthAccount)) account('claude', 'Claude 官方账号', accountFile, 'anthropic', undefined, record.oauthAccount);
  }

  const desktop = resolveClaudeDesktopConfig(ctx);
  if (!desktop.root) warnings.push(desktop.reason);
  const profileDir = desktop.root && path.join(desktop.root, 'Claude-3p', 'configLibrary');
  if (profileDir && fs.existsSync(profileDir)) {
    try {
      const entries = fs.readdirSync(profileDir).filter(n => /^[A-Za-z0-9_-]{1,120}\.json$/.test(n) && n !== '_meta.json');
      if (entries.length > 50) warnings.push('Claude 桌面配置超过50个，已限制本次扫描范围。');
      for (const entry of entries.slice(0, 50)) {
        const file = path.join(profileDir, entry), profile = json(file, 'Claude 桌面 profile');
        if (!profile) continue;
        const s = source('claude-desktop', `Claude 桌面 · ${textValue(profile.name) || entry.replace(/\.json$/, '')}`, file);
        if (entry === `${CLAUDE_DESKTOP_PROFILE}.json`) { note(s, 'ignored', '云汇管理的桌面 profile 不重复导入。'); continue; }
        if (profile.inferenceProvider !== 'gateway' || !['bearer', 'api-key', 'x-api-key'].includes(profile.inferenceGatewayAuthScheme)) {
          note(s, 'unsupported', '此 profile 的认证协议不明确，需手动配置。'); continue;
        }
        const models = Array.isArray(profile.inferenceModels) ? profile.inferenceModels.map((m: unknown) => object(m) ? m.name : m) : [];
        add(s, s.label, 'anthropic', profile.inferenceGatewayBaseUrl, profile.inferenceGatewayApiKey, models);
      }
    } catch { warnings.push('Claude 桌面 profile 目录无法安全读取，已跳过。'); }
  }

  const envFile = (file: string, label: string): Record<string, string> | undefined => {
    const raw = read(file, label); if (raw === undefined) return undefined;
    const values: Record<string, string> = {};
    try {
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match || Object.hasOwn(values, match[1])) throw new Error();
        let value = match[2];
        if (value.startsWith('"')) { const quoted = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(value); if (!quoted) throw new Error(); value = JSON.parse(quoted[1]); }
        else if (value.startsWith("'")) { const quoted = /^'([^']*)'\s*(?:#.*)?$/.exec(value); if (!quoted) throw new Error(); value = quoted[1]; }
        else { if (/[#\s]/.test(value)) throw new Error(); }
        values[match[1]] = value;
      }
      return values;
    } catch { warnings.push(`${label}：环境文件包含重复、复杂或不明确的值，已跳过。`); return undefined; }
  };
  const geminiDir = path.join(ctx.home, '.gemini'), geminiEnvFile = path.join(geminiDir, '.env');
  const geminiEnv = envFile(geminiEnvFile, 'Gemini CLI');
  const geminiSettings = json(path.join(geminiDir, 'settings.json'), 'Gemini CLI 设置');
  if (geminiEnv) add(source('gemini-cli', 'Gemini CLI · 本机环境配置', geminiEnvFile), 'Gemini CLI · 本机配置', 'gemini', geminiEnv.GOOGLE_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com', geminiEnv.GEMINI_API_KEY, [geminiEnv.GEMINI_MODEL ?? geminiSettings?.model?.name]);
  const geminiOauthFile = path.join(geminiDir, 'oauth_creds.json'), geminiOauth = json(geminiOauthFile, 'Gemini 官方登录记录');
  if (geminiOauth && (geminiOauth.access_token || geminiOauth.refresh_token)) account('gemini', 'Google 官方账号（Gemini CLI）', geminiOauthFile, 'gemini', geminiOauth.access_token ?? geminiOauth.refresh_token, geminiOauth);

  const qwenFile = path.join(ctx.home, '.qwen', '.env'), qwenEnv = envFile(qwenFile, 'Qwen Code');
  if (qwenEnv) add(source('qwen-code', 'Qwen Code · 本机环境配置', qwenFile), 'Qwen Code · 本机配置', 'openai-chat', qwenEnv.OPENAI_BASE_URL, qwenEnv.OPENAI_API_KEY, [qwenEnv.OPENAI_MODEL]);
  const openCodeFile = path.join(ctx.environment.XDG_CONFIG_HOME || path.join(ctx.home, '.config'), 'opencode', 'opencode.json');
  const openCode = json(openCodeFile, 'OpenCode');
  if (object(openCode?.provider)) for (const [id, value] of Object.entries(openCode.provider)) {
    if (!object(value)) continue;
    const s = source('opencode', `OpenCode · ${textValue(value.name) || id}`, openCodeFile, id);
    const format: ProtocolName | undefined = value.npm === '@ai-sdk/openai-compatible' ? 'openai-chat' : value.npm === '@ai-sdk/anthropic' ? 'anthropic' : undefined;
    if (!format) { note(s, 'unsupported', '仅自动读取明确声明的 OpenAI 兼容或 Anthropic provider。'); continue; }
    add(s, s.label, format, value.options?.baseURL, value.options?.apiKey, object(value.models) ? Object.keys(value.models) : []);
  }
  const copilotRoot = ctx.platform === 'win32' ? ctx.environment.APPDATA || path.join(ctx.home, 'AppData', 'Roaming')
    : ctx.environment.XDG_CONFIG_HOME || path.join(ctx.home, '.config');
  const copilotFile = path.join(copilotRoot, 'github-copilot', 'hosts.json');
  const copilot = json(copilotFile, 'GitHub Copilot 登录记录');
  const copilotAccount = copilot && Object.values(copilot).find(v => object(v) && typeof v.oauth_token === 'string');
  if (copilotAccount) account('copilot', 'GitHub Copilot 官方账号', copilotFile, 'openai-chat', copilotAccount.oauth_token);
  return { candidates, sources, accounts, warnings };
}

/** Safe for state.get: snapshot only, never the import candidates or API credentials. */
export function getLocalClientsSnapshot(store: AuroraStore): LocalClientsSnapshot {
  try { return JSON.parse(JSON.stringify(loadLedger(store).snapshot)); }
  catch { return { ...emptySnapshot(), ok: false, warnings: ['本地客户端来源记录损坏，自动导入已暂停；现有供应商保持不变。'] }; }
}

/** Synchronous and local-only: callers must not expose this mutating operation through the remote RPC. */
export function syncLocalClients(store: AuroraStore, options: LocalClientOptions = {}): LocalClientsSnapshot {
  const ledger = loadLedger(store);
  const previousScan = lastSuccessfulScan.get(store);
  if (!options.force && previousScan !== undefined && Date.now() - previousScan < 5000) {
    return JSON.parse(JSON.stringify({ ...ledger.snapshot, added: 0, updated: 0 }));
  }
  const ctx = context(store, options), scanned = discover(ctx);
  const snapshot: LocalClientsSnapshot = { ...emptySnapshot(), checkedAt: new Date().toISOString(), accounts: scanned.accounts, sources: scanned.sources, warnings: scanned.warnings };
  const seen = new Set(scanned.sources.map(s => s.id));
  for (const candidate of scanned.candidates) {
    const s = { ...candidate.source }; seen.add(s.id);
    let record = ledger.sources[s.id];
    const providers = store.listProviders();
    if (record?.suppressed || (record?.providerId && !providers.some(p => p.id === record.providerId))) {
      record.suppressed = true; s.status = 'ignored'; s.canRestore = true; s.message = '此来源的导入项已被删除，不会自动恢复。可明确选择重新导入。';
      snapshot.sources.push(s); continue;
    }
    const existing = record?.providerId ? providers.find(p => p.id === record.providerId) : undefined;
    if (existing) {
      s.providerId = existing.id;
      if (!record!.owned) {
        const matches = existing.format === candidate.format && endpoint(existing.baseUrl, existing.format) === candidate.baseUrl && existing.apiKeys.some(k => k.key === candidate.key);
        s.status = matches ? 'linked' : 'modified';
        s.message = matches ? '已关联现有相同供应商，自动扫描不会改写该供应商。' : '本机来源已变化，现有供应商由用户管理，未覆盖其设置。';
      }
      else if (managedHash(existing) !== record!.managedHash) { s.status = 'modified'; s.message = '供应商已被手动修改，保留当前设置，未覆盖密钥或模型。'; }
      else if (candidateHash(candidate) === record!.candidateHash) s.status = 'unchanged';
      else {
        const updated = store.saveProvider({ ...existing, name: candidate.name, baseUrl: candidate.baseUrl, format: candidate.format,
          apiKeys: [{ id: existing.apiKeys[0]?.id || 'local_' + s.id, label: '本机已有 API Key', key: candidate.key, enabled: true, weight: 1 }],
          // Switching a client to another provider removes its current-model association, not the
          // original provider's supported models. Discovery may append evidence, never erase it.
          models: [...existing.models, ...candidate.models.filter(id => !existing.models.some(model => model.id === id)).map(id => ({ id }))]
            .map(model => candidate.context?.modelId === model.id ? { ...model, contextWindow: candidate.context.value } : model) });
        record!.managedHash = managedHash(updated); record!.candidateHash = candidateHash(candidate);
        s.status = 'updated'; s.message = '本机来源配置已变化，已更新未被手动修改的导入项。'; snapshot.updated++;
      }
    } else {
      const presetId = 'local-client-' + s.id;
      const linked = providers.find(p => p.presetId === presetId) || providers.find(p => p.format === candidate.format && endpoint(p.baseUrl, p.format) === candidate.baseUrl && p.apiKeys.some(k => k.key === candidate.key));
      if (linked) {
        record = { source: s, providerId: linked.id, owned: false, candidateHash: candidateHash(candidate) };
        s.providerId = linked.id; s.status = 'linked'; s.message = '已关联现有相同供应商，没有重复创建或覆盖原配置。';
      } else {
        const imported = store.saveProvider({ name: candidate.name, presetId, format: candidate.format, baseUrl: candidate.baseUrl,
          apiKeys: [{ id: 'key_' + s.id, label: '本机已有 API Key', key: candidate.key, enabled: true, weight: 1 }],
          models: candidate.models.map(id => ({ id, ...(candidate.context?.modelId === id ? { contextWindow: candidate.context.value } : {}) })), enabled: true, priority: 10, official: false,
          notes: `自动发现来源：${s.label}\n配置文件：${s.path}\n仅读取本机已有 API 配置，未联网验证。源客户端和官方登录记录保持不变。` });
        record = { source: s, providerId: imported.id, owned: true, managedHash: managedHash(imported), candidateHash: candidateHash(candidate) };
        s.providerId = imported.id; s.status = 'imported'; s.message = '已从本机已有 API 配置导入，尚未联网验证。'; snapshot.added++;
      }
      ledger.sources[s.id] = record;
    }
    snapshot.sources.push(s);
  }
  // Missing/invalid source files never erase imported providers. Deleted providers remain tombstoned.
  for (const [id, record] of Object.entries(ledger.sources)) {
    const provider = record.providerId ? store.getProvider(record.providerId) : undefined;
    if (record.providerId && !provider) record.suppressed = true;
    if (!seen.has(id)) snapshot.sources.push({ ...record.source, providerId: provider?.id, status: record.suppressed ? 'ignored' : 'missing-file', ...(record.suppressed ? { canRestore: true } : {}), message: record.suppressed ? '已删除的导入项不会自动恢复。' : '当前未发现原配置来源，现有供应商保持不变。' });
    else {
      const item = snapshot.sources.find(s => s.id === id);
      if (item && !item.providerId && provider) item.providerId = provider.id;
      if (item && record.suppressed) { item.status = 'ignored'; item.canRestore = true; item.message = '已删除的导入项不会自动恢复，可明确选择重新导入。'; }
    }
  }
  ledger.snapshot = snapshot; saveLedger(store, ledger);
  lastSuccessfulScan.set(store, Date.now());
  return JSON.parse(JSON.stringify(snapshot));
}

/** Only an explicit user restore clears a deletion tombstone; manual provider edits are never reset. */
export function restoreIgnoredLocalSource(store: AuroraStore, sourceId: string, options: LocalClientOptions = {}): LocalClientsSnapshot {
  const ledger = loadLedger(store), record = ledger.sources[sourceId];
  if (!record || (!record.suppressed && (!record.providerId || store.getProvider(record.providerId)))) throw new Error('该来源没有可恢复的删除记录。');
  if (record.providerId && store.getProvider(record.providerId)) throw new Error('此来源仍关联现有供应商，不会覆盖手工配置。');
  delete ledger.sources[sourceId]; saveLedger(store, ledger);
  return syncLocalClients(store, { ...options, force: true });
}
