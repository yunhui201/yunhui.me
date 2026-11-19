import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { AgentId, Provider } from '../store/types.js';
import { nowIso } from '../util.js';
import { defaultAutoCompactTokenLimit, isValidContextWindow } from '../modelContext.js';
import { detectCodingDesktop, clearDesktopDetectionCache, type CodingDesktopDetection } from '../desktopDetection.js';
import { cliCandidates, desktopCandidates, type ClientPathContext } from '../clientPaths.js';
import { CLAUDE_DESKTOP_PROFILE, claudeDesktopConfigFiles, claudeDesktopRestorePaths, resolveClaudeDesktopConfig } from '../claudeDesktopPaths.js';
import { readOfficialCodexIdentity, codexCoexistBaseUrl, CODEX_COEXIST_BASE_PATH } from '../gateway/coexist.js';
import { codexHistoryBasePath } from '../gateway/historyRoute.js';
import { nativeDirectParameters } from './directConnection.js';
import { discoverHistoryProviderIds, detachManagedHistoryProviders, withHistoryProviderAliases, clearManagedHistoryTarget } from './historyProviders.js';
import { applyPlan, restorePlan, backupPlanFiles, jsonObject, planned, plannedJson, readText, patchToml, patchEnv, redactConfig, digest, type PlannedFile } from './configFiles.js';

export interface ConnectContext {
  provider: Provider;
  model: string;
  modelMap?: Record<string, string>;
  gatewayUrl: string;
  mode: 'gateway' | 'direct';
  globalProxy?: string;
  token?: string;
  previousBackup?: string;
  expectedRevision?: string;
  authMode?: 'api' | 'coexist';
  permissionMode?: 'preserve' | 'full-access';
  skipOnboarding?: boolean;
  modelCatalogPath?: string;
  /** Trusted read-only worker result supplied by the action layer, never copied from renderer payload. */
  desktopDetection?: CodingDesktopDetection;
  /** Trusted main-process preview snapshot, never copied from renderer fields. */
  historyProviderIds?: readonly string[];
}
export interface ConnectResult { ok: boolean; path?: string; backup?: string; message: string; restartRequired?: boolean; extraFiles?: string[] }
export interface ConnectPreview { ok: boolean; message: string; files: PlannedFile[]; warnings: string[]; requiresRestart: boolean; revision?: string; manual?: { baseUrl: string; apiKey: string; model: string } }
export interface AgentDetection { installed: boolean; configured: boolean; command?: string; configPath?: string; version?: string; productName?: string; supportsCodexConfig?: boolean; evidence?: string[]; detectionError?: string; detecting?: boolean; desktopDetails?: CodingDesktopDetection }
export interface AgentAdapter {
  id: AgentId; name: string; vendor: string; description: string; needsInstall: boolean; protocol: string; hotSwitch: boolean;
  support: 'automatic' | 'manual' | 'unsupported'; category: 'cli' | 'desktop' | 'service'; supportNote: string; docsUrl: string;
  configPaths(): string[];
  restorePaths?(backupPath?: string): string[];
  matchesConfiguration?(ctx: ConnectContext): boolean;
  preview(ctx: ConnectContext): ConnectPreview;
  connect(ctx: ConnectContext): ConnectResult;
  disconnect(backupPath?: string): ConnectResult;
  detect(): AgentDetection;
  launchHint(model: string): string;
}

// Isolated client profile for portable deployments and integration tests.
function home(...parts: string[]): string { return path.join(process.env.AURORA_CLIENT_HOME || os.homedir(), ...parts); }
function envDir(name: string, fallback: string): string { return process.env.AURORA_CLIENT_HOME ? fallback : process.env[name] || fallback; }
function pathContext(): ClientPathContext { return { platform: process.platform, home: home(), environment: process.env, isolated: !!process.env.AURORA_CLIENT_HOME }; }
function cliPath(command: string): string | undefined {
  for (const candidate of cliCandidates(command, pathContext())) {
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* continue */ }
  }
  return undefined;
}
function desktopPath(names: string | readonly string[]): string | undefined {
  return desktopCandidates(typeof names === 'string' ? [names] : names, pathContext()).find(candidate => {
    try { return process.platform === 'darwin' ? fs.statSync(candidate).isDirectory() : fs.statSync(candidate).isFile(); }
    catch { return false; }
  });
}
function codexConfig(): string { return path.join(envDir('CODEX_HOME', home('.codex')), 'config.toml'); }
function claudeCodeConfig(): string { return path.join(envDir('CLAUDE_CONFIG_DIR', home('.claude')), 'settings.json'); }
function claudeOnboardingConfig(): string {
  const dir = envDir('CLAUDE_CONFIG_DIR', home('.claude'));
  return path.resolve(dir) === path.resolve(home('.claude')) ? home('.claude.json') : path.join(dir, '.claude.json');
}
function claudeCodePaths(): string[] { return [claudeCodeConfig(), claudeOnboardingConfig()]; }
let desktopExecutable: string | undefined;
export function configureDesktopPath(value?: string): void { if (desktopExecutable !== value) { desktopExecutable = value; detectReset(); } }
function desktopDetection() { return detectCodingDesktop(desktopExecutable); }

export function connectionParameters(ctx: ConnectContext, protocol: string): { baseUrl: string; apiKey: string; model: string; apiVersion?: string } {
  const url = new URL(ctx.mode === 'gateway' ? ctx.gatewayUrl : ctx.provider.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('接口地址必须是 HTTP(S) URL，且不能包含账号密码');
  let baseUrl = url.toString().replace(/\/+$/, '');
  let apiVersion = protocol === 'gemini' ? 'v1beta' : undefined;
  if (ctx.mode === 'direct') {
    if (Object.keys(ctx.provider.headers || {}).length || ctx.provider.proxy?.trim() || ctx.globalProxy?.trim()) throw new Error('供应商自定义请求头或代理设置需要通过本地网关接入；直连不会使用这些设置');
    ({ baseUrl, apiVersion } = nativeDirectParameters(baseUrl, protocol));
  } else if (protocol === 'openai-chat' || protocol === 'openai-responses') {
    baseUrl += '/v1';
  }
  const apiKey = ctx.mode === 'gateway' ? ctx.token || '' : ctx.provider.apiKeys.find(k => k.enabled && k.key)?.key || '';
  if (ctx.mode === 'gateway' && !apiKey) throw new Error('本地网关令牌尚未生成，请先启动网关');
  if (/\r|\n/.test(apiKey) || /[\r\n\u0000]/.test(ctx.model)) throw new Error('密钥或模型名不能包含换行符');
  return { baseUrl, apiKey, model: ctx.mode === 'gateway' ? `${ctx.provider.id}/${ctx.model}` : ctx.model, ...(apiVersion ? { apiVersion } : {}) };
}
function validate(ctx: ConnectContext, adapter: AgentAdapter): void {
  if (ctx.mode !== 'gateway' && ctx.mode !== 'direct') throw new Error('不支持的接入模式');
  if (ctx.permissionMode !== undefined && ctx.permissionMode !== 'preserve' && ctx.permissionMode !== 'full-access') throw new Error('不支持的客户端权限模式');
  if (ctx.permissionMode === 'full-access' && !['codex-cli', 'chatgpt-desktop', 'claude-code'].includes(adapter.id)) throw new Error('此客户端暂不支持自动配置执行权限，请在客户端内设置');
  if (ctx.skipOnboarding !== undefined && typeof ctx.skipOnboarding !== 'boolean') throw new Error('首次登录引导选项必须是布尔值');
  if (ctx.skipOnboarding && adapter.id !== 'claude-code') throw new Error('此客户端不支持跳过 Claude 首次登录引导');
  if (!ctx.model?.trim()) throw new Error('请选择模型');
  if (!ctx.provider.enabled) throw new Error('请先启用供应商');
  const officialChoice = ctx.authMode === 'coexist' && ctx.provider.id === 'official';
  if (ctx.authMode === 'coexist') {
    if (!['codex-cli', 'chatgpt-desktop'].includes(adapter.id) || ctx.mode !== 'gateway') throw new Error('官方账号共存需要通过本地网关连接 ChatGPT / Codex');
    const identity = readOfficialCodexIdentity();
    if (!identity.available) throw new Error(identity.message);
    if (!ctx.modelCatalogPath) throw new Error('缺少本地共存模型目录');
  }
  const providerHost = new URL(ctx.provider.baseUrl).hostname;
  if (!officialChoice && !ctx.provider.apiKeys.some(k => k.enabled && k.key) && !['localhost', '127.0.0.1', '[::1]'].includes(providerHost)) throw new Error('请先填写并启用供应商 API Key');
  if (!ctx.provider.models.some(m => m.id === ctx.model)) throw new Error('此模型不在所选供应商的模型列表中');
  if (ctx.mode === 'direct' && ctx.provider.format !== adapter.protocol) throw new Error('直连模式要求供应商与客户端协议一致；请选择本地网关接入');
  for (const [role, model] of Object.entries(ctx.modelMap || {})) {
    if (!['sonnet', 'opus', 'haiku'].includes(role) || !ctx.provider.models.some(m => m.id === model)) throw new Error('模型映射必须使用当前供应商已有的模型');
  }
  connectionParameters(ctx, adapter.protocol);
}
export function planRevision(files: PlannedFile[]): string { return digest(JSON.stringify(files.map(f => [f.path, f.existed, digest(f.before), digest(f.after), f.ownedJson, f.permissionScope]))); }

type AdapterSpec = Pick<AgentAdapter, 'id' | 'name' | 'vendor' | 'description' | 'protocol' | 'support' | 'category' | 'supportNote' | 'docsUrl'> & {
  paths?: () => string[]; command?: string; desktop?: string | readonly string[]; hint?: string; plan?: (ctx: ConnectContext) => PlannedFile[]; warnings?: string[];
  previewWarnings?: (ctx: ConnectContext, files: PlannedFile[]) => string[];
};
function makeAdapter(spec: AdapterSpec): AgentAdapter {
  const adapter: AgentAdapter = {
    ...spec, needsInstall: spec.category !== 'service', hotSwitch: false,
    configPaths: spec.paths || (() => []), launchHint: () => spec.hint || `完全退出并重新启动 ${spec.name}`,
    detect() {
      const command = spec.command ? cliPath(spec.command) : spec.desktop ? desktopPath(spec.desktop) : undefined;
      return { installed: !!command, configured: this.configPaths().some(p => fs.existsSync(p)), command, configPath: this.configPaths()[0] };
    },
    preview(ctx) {
      const base = { files: [], warnings: [...(spec.warnings || [])], requiresRestart: spec.support === 'automatic' };
      if (spec.support === 'unsupported') return { ...base, ok: false, message: spec.supportNote };
      try {
        validate(ctx, this);
        if (ctx.permissionMode === 'full-access') base.warnings.push('已选择完全访问：客户端可执行命令和修改文件，操作前不再逐项请求批准。组织策略、工作区信任与客户端首次确认仍由客户端执行。');
        if (spec.support === 'manual') return { ...base, ok: true, message: spec.supportNote, manual: { ...connectionParameters(ctx, this.protocol), apiKey: '••••••••' } };
        const files = spec.plan!(ctx);
        return { ...base, warnings: [...base.warnings, ...(spec.previewWarnings?.(ctx, files) || [])], ok: true, message: '将先备份现有配置，再应用以下变更。预览中的密钥已隐藏。', revision: planRevision(files), files: files.map(f => ({ ...f, before: redactConfig(f.before), after: redactConfig(f.after) })) };
      } catch (error) { return { ...base, ok: false, message: String((error as Error).message) }; }
    },
    connect(ctx) {
      if (spec.support !== 'automatic') return { ok: false, message: spec.supportNote };
      try {
        validate(ctx, this);
        const files = spec.plan!(ctx);
        if (ctx.expectedRevision && ctx.expectedRevision !== planRevision(files)) throw new Error('配置或连接参数在预览后已变化，请重新预览再应用');
        const backup = applyPlan(this.id.startsWith('codex-') || this.id === 'chatgpt-desktop' ? 'codex-cli' : this.id, files, ctx.previousBackup);
        detectReset();
        return { ok: true, path: files[0].path, backup, extraFiles: files.slice(1).map(f => f.path), restartRequired: true, message: `${spec.name} 配置已保存并备份。${this.launchHint(ctx.model)}。` };
      } catch (error) { return { ok: false, message: String((error as Error).message) }; }
    },
    disconnect(backup) {
      if (spec.support !== 'automatic') return { ok: false, message: '此客户端没有由云汇写入的配置' };
      try { restorePlan(this.id.startsWith('codex-') || this.id === 'chatgpt-desktop' ? 'codex-cli' : this.id, backup, this.restorePaths?.(backup) ?? this.configPaths()); detectReset(); return { ok: true, message: `已恢复首次接入前的 ${spec.name} 配置，请重新启动客户端。`, restartRequired: true }; }
      catch (error) { return { ok: false, message: String((error as Error).message) }; }
    },
  };
  if (spec.support === 'automatic') adapter.matchesConfiguration = ctx => {
    if (adapter.support !== 'automatic') return false;
    validate(ctx, adapter);
    return spec.plan!(ctx).every(file => file.existed && file.before === file.after);
  };
  return adapter;
}

const claudeCode = makeAdapter({
  id: 'claude-code', name: 'Claude Code', vendor: 'Anthropic', category: 'cli', support: 'automatic', protocol: 'anthropic',
  description: 'Anthropic 编程助手，支持国内外模型通过本地网关接入。', supportNote: '写入用户级 settings.json 的端点、密钥和模型；保留权限、MCP、插件等设置。',
  docsUrl: 'https://code.claude.com/docs/en/llm-gateway', command: 'claude', paths: claudeCodePaths, hint: '新开终端或重新启动 Claude Code',
  warnings: ['项目级配置、系统环境变量和组织策略可能覆盖用户级设置；正在运行的会话请重启后验证。'],
  previewWarnings: ctx => ctx.skipOnboarding ? ['已选择跳过 Claude Code 首次登录引导：仅写入本机初始化标记，仍需有效的供应商 API Key；不会创建官方登录或订阅。工作区信任与权限首次确认仍由客户端处理。'] : [],
  plan(ctx) {
    const file = claudeCodeConfig(), settings = jsonObject(file), ep = connectionParameters(ctx, 'anthropic');
    if (settings.env && (typeof settings.env !== 'object' || Array.isArray(settings.env))) throw new Error('Claude Code env 必须是对象');
    if (settings.forceLoginMethod || settings.forceLoginOrgUUID) throw new Error('Claude Code 当前配置限制了官方或组织登录，可能阻止供应商 API 接入。请先在原客户端核对登录策略；原配置未修改');
    if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(key => ['1', 'true'].includes(String(settings.env?.[key]).toLowerCase()))) throw new Error('Claude Code 当前启用了云平台认证，无法同时使用供应商 API 接入。请先在原客户端关闭相应云平台模式；原配置未修改');
    if (ctx.permissionMode === 'full-access') {
      if (settings.permissions && (typeof settings.permissions !== 'object' || Array.isArray(settings.permissions))) throw new Error('Claude Code permissions 必须是对象');
      if (settings.permissions?.disableBypassPermissionsMode === 'disable') throw new Error('Claude Code 当前配置禁止跳过权限确认，请先在原客户端检查权限策略；原配置未修改');
      settings.permissions = { ...(settings.permissions || {}), defaultMode: 'bypassPermissions' };
    }
    settings.env = { ...(settings.env || {}), ANTHROPIC_BASE_URL: ep.baseUrl, ANTHROPIC_AUTH_TOKEN: ep.apiKey, ANTHROPIC_MODEL: ep.model };
    delete settings.env.ANTHROPIC_API_KEY;
    for (const role of ['opus', 'sonnet', 'haiku']) { const model = ctx.modelMap?.[role] || ctx.model; settings.env[`ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`] = ctx.mode === 'gateway' ? `${ctx.provider.id}/${model}` : model; }
    const files: PlannedFile[] = [{ ...plannedJson(file, settings), ...(ctx.permissionMode === 'full-access' ? { permissionScope: { kind: 'claude-execution-v1' as const } } : {}) }], onboarding = claudeOnboardingConfig();
    const previousOnboarding = ctx.previousBackup ? backupPlanFiles('claude-code', ctx.previousBackup, claudeCodePaths()).find(entry => entry.path === onboarding) : undefined;
    if (previousOnboarding?.ownedJson && jsonObject(onboarding).hasCompletedOnboarding !== true) throw new Error('Claude 引导标记已被其他程序修改，请先核对后重新预览');
    if (ctx.skipOnboarding) {
      const global = jsonObject(onboarding);
      if (global.hasCompletedOnboarding === true) files.push({ ...planned(onboarding, readText(onboarding)), ownedJson: 'claude-onboarding-v1' });
      else { global.hasCompletedOnboarding = true; files.push({ ...plannedJson(onboarding, global), ownedJson: 'claude-onboarding-v1' }); }
    } else if (previousOnboarding) {
      // Keep the first original in the transaction after turning off future
      // onboarding changes. Native startup state is only reset by full restore.
      files.push({ ...planned(onboarding, readText(onboarding)), ...(previousOnboarding.ownedJson ? { ownedJson: previousOnboarding.ownedJson } : {}) });
    }
    return files;
  },
});
export function codexPlan(ctx: ConnectContext): PlannedFile[] {
  const file = codexConfig(), ep = connectionParameters(ctx, 'openai-responses');
  const before = readText(file);
  let current: any;
  try { current = parseToml(before.replace(/^\uFEFF/, '')); }
  catch { throw new Error('原 Codex 配置不是有效的 TOML，已停止修改；请在原客户端检查配置。'); }
  const coexist = ctx.authMode === 'coexist';
  if (!coexist) {
    const profile = typeof current.profile === 'string' ? current.profiles?.[current.profile] : undefined;
    if ([current.model_providers?.yunhui, profile?.model_providers?.yunhui].some(value => value && typeof value === 'object' && (Object.hasOwn(value, 'auth') || Object.hasOwn(value, 'aws')))) {
      throw new Error('当前 yunhui 供应商包含 auth 或 aws 认证设置，不能与 API Bearer 令牌同时使用。请先在原客户端移除这些认证设置或改名为独立供应商，再重新预览；原配置未修改。');
    }
  }
  if (coexist) {
    const profile = typeof current.profile === 'string' ? current.profiles?.[current.profile] : undefined;
    if ([current.model_providers?.openai, profile?.model_providers?.openai].some(value => value && typeof value === 'object' && Object.keys(value).some(key => key !== 'name'))) {
      throw new Error('当前配置重定义了内置 openai 供应商。请先在原客户端移除该覆盖或改名为独立供应商，再开启官方账号共存；也可继续使用 API 模式。');
    }
    if (!process.env.AURORA_CLIENT_HOME && process.env.OPENAI_BASE_URL) throw new Error('当前进程存在 OPENAI_BASE_URL 环境覆盖，请先清除该变量并重启云汇，再启用共存模式。');
  }
  const selection = { model: ep.model, model_provider: coexist ? 'openai' : 'yunhui' };
  const endpoint = codexCoexistBaseUrl(Number(new URL(ctx.gatewayUrl).port) || 80);
  const ownEndpoint = (value: unknown) => { try { const url = new URL(String(value)); return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname.replace(/\/$/, '') === CODEX_COEXIST_BASE_PATH; } catch { return false; } };
  const routing: Record<string, string | number | null> = { ...selection };
  if (ctx.permissionMode === 'full-access') Object.assign(routing, { approval_policy: 'never', sandbox_mode: 'danger-full-access', default_permissions: null });
  const contextWindow = ctx.provider.models.find(model => model.id === ctx.model)?.contextWindow;
  if (coexist) {
    routing.openai_base_url = endpoint;
    routing.model_catalog_json = ctx.modelCatalogPath!;
    if (current.forced_login_method === 'api') routing.forced_login_method = null;
    // Each catalog entry supplies its own window and 90% trigger. A global
    // override would pin every model in the menu to the previously selected size.
    routing.model_context_window = null;
    routing.model_auto_compact_token_limit = null;
  } else {
    if (current.forced_login_method === 'chatgpt') routing.forced_login_method = null;
    // Context limits are root-level Codex settings, not ConfigProfile fields.
    if (isValidContextWindow(contextWindow)) {
      routing.model_context_window = contextWindow;
      routing.model_auto_compact_token_limit = defaultAutoCompactTokenLimit(contextWindow)!;
    }
    if (ownEndpoint(current.openai_base_url)) routing.openai_base_url = null;
    if (current.model_catalog_json === ctx.modelCatalogPath) routing.model_catalog_json = null;
  }
  const detached = detachManagedHistoryProviders(before);
  let text = patchToml(detached.text, '', routing);
  if (typeof current.profile === 'string') {
    if (!current.profiles?.[current.profile] || typeof current.profiles[current.profile] !== 'object') throw new Error('当前 Codex profile 不存在，请先检查原客户端配置');
    const profile = current.profiles[current.profile];
    const values: Record<string, string | null> = { ...selection };
    if (ctx.permissionMode === 'full-access') Object.assign(values, { approval_policy: 'never', sandbox_mode: 'danger-full-access', default_permissions: null });
    // These transport/catalog fields belong at the root; legacy profile schemas reject them.
    if (profile.openai_base_url !== undefined && (coexist || ownEndpoint(profile.openai_base_url))) values.openai_base_url = null;
    if (profile.model_catalog_json !== undefined && (coexist || profile.model_catalog_json === ctx.modelCatalogPath)) values.model_catalog_json = null;
    if (coexist && profile.forced_login_method === 'api') values.forced_login_method = null;
    if (!coexist && profile.forced_login_method === 'chatgpt') values.forced_login_method = null;
    if (coexist || isValidContextWindow(contextWindow)) {
      if (profile.model_context_window !== undefined) values.model_context_window = null;
      if (profile.model_auto_compact_token_limit !== undefined) values.model_auto_compact_token_limit = null;
    }
    text = patchToml(text, `profiles.${JSON.stringify(current.profile)}`, values);
  }
  if (!coexist) {
    const transport = { name: '云汇 AI', base_url: ep.baseUrl, wire_api: 'responses', experimental_bearer_token: ep.apiKey, env_key: null, requires_openai_auth: false, stream_idle_timeout_ms: 300000 };
    text = patchToml(text, 'model_providers.yunhui', transport);
    // An existing active-profile provider is merged over the root provider by
    // supporting clients. Keep its managed transport in sync so it cannot
    // silently restore an old endpoint, credential, or official-auth mode.
    if (typeof current.profile === 'string' && current.profiles?.[current.profile]?.model_providers?.yunhui !== undefined) {
      text = patchToml(text, `profiles.${JSON.stringify(current.profile)}.model_providers.yunhui`, transport);
    }
  }
  // Reattach the original owned blocks before optional alias work so a failed
  // discovery or generation also preserves previously working history routes.
  if (detached.blocks.length) text = text.trimEnd() + '\n\n' + detached.blocks.join('\n');
  // Alias discovery is optional evidence; it can never fail the user's chosen
  // configuration or rewrite native history while another client is running.
  try {
    const ids = ctx.historyProviderIds ?? discoverHistoryProviderIds(before, path.dirname(file), process.env.AURORA_CLIENT_HOME ? path.dirname(file) : process.env.CODEX_SQLITE_HOME || path.dirname(file));
    const aliasBaseUrl = ctx.mode === 'direct' ? ep.baseUrl : coexist
      ? new URL(endpoint).origin + codexHistoryBasePath(`${ctx.provider.id}/${ctx.model}`, 'coexist')
      : ctx.gatewayUrl.replace(/\/+$/, '') + codexHistoryBasePath(`${ctx.provider.id}/${ctx.model}`);
    const aliasTransport: Record<string, string | number | boolean> = coexist ? { name: '云汇历史兼容', base_url: aliasBaseUrl, wire_api: 'responses', requires_openai_auth: true, stream_idle_timeout_ms: 300000 }
      : { name: '云汇历史兼容', base_url: aliasBaseUrl, wire_api: 'responses', experimental_bearer_token: ep.apiKey, requires_openai_auth: false, stream_idle_timeout_ms: 300000 };
    text = withHistoryProviderAliases(text, [...detached.ids, ...ids], aliasTransport, true);
  } catch { text = clearManagedHistoryTarget(text); }
  return [{ ...planned(file, text), ...(ctx.permissionMode === 'full-access' ? { permissionScope: { kind: 'codex-execution-v1' as const, ...(typeof current.profile === 'string' ? { profile: current.profile } : {}) } } : {}) }];
}
const CODEX_CONTEXT_WARNING = '应用上下文窗口时，自动压缩阈值同步设为其 90%（向下取整，至少 1 Token），修改后需重启客户端。共存模式按模型目录分别设置，并清除旧的全局窗口和阈值覆盖，让切换模型时使用各自的设置。';
const CODEX_PROVIDER_WARNING = '先保存客户端配置，并为可确认的旧会话供应商补充兼容配置；历史备份与整理随后尝试，客户端运行中或个别历史异常都不影响保存。保存工作后重启客户端加载新配置。';
function codexProviderWarnings(): string[] {
  return [CODEX_PROVIDER_WARNING];
}
const codexCli = makeAdapter({
  id: 'codex-cli', name: 'Codex CLI', vendor: 'OpenAI', category: 'cli', support: 'automatic', protocol: 'openai-responses', description: 'OpenAI 终端编程助手，使用 Responses 协议。',
  supportNote: '配置独立的 yunhui provider，保留账号登录态和其他 TOML 配置。', docsUrl: 'https://developers.openai.com/codex/config-reference', command: 'codex', paths: () => [codexConfig()], hint: '完全退出后重新运行 codex', plan: codexPlan,
  warnings: ['Codex CLI 与 Codex 桌面共享用户级配置；当前 profile 或项目配置可能覆盖此设置。', '部分新版 CLI 已停用 config.toml 内的旧 profile 表，改用 --profile 名称和独立配置文件；请先确认原配置可由当前 CLI 正常读取，云汇不会自动迁移这些文件。', CODEX_CONTEXT_WARNING], previewWarnings: codexProviderWarnings,
});
const codexDesktop = makeAdapter({
  id: 'chatgpt-desktop', name: 'ChatGPT 桌面版', vendor: 'OpenAI', category: 'desktop', support: 'automatic', protocol: 'openai-responses', description: '配置与 Codex CLI 共享的编程模型，另行识别桌面程序以支持重启和增强。',
  supportNote: '备份并写入 .codex/config.toml（遵循 CODEX_HOME）；网关模式通过本地地址与令牌路由到所选供应商，直连模式使用供应商地址与密钥。保留官方登录文件。', docsUrl: 'https://developers.openai.com/codex/config-reference', desktop: 'ChatGPT', paths: () => [codexConfig()], hint: '完全退出支持编程配置的 ChatGPT / Codex 桌面版（包括托盘）后重新打开', plan: codexPlan,
  warnings: ['此变更也会影响使用同一配置的 Codex CLI。', CODEX_CONTEXT_WARNING], previewWarnings: codexProviderWarnings,
});
const desktopPreview = codexDesktop.preview.bind(codexDesktop), desktopConnect = codexDesktop.connect.bind(codexDesktop);
codexDesktop.detect = () => { const detected = desktopDetection(); return { installed: detected.installed, configured: fs.existsSync(codexConfig()), command: detected.executable, version: detected.version, configPath: codexConfig(), productName: detected.productName, supportsCodexConfig: detected.supportsCodexConfig, evidence: detected.evidence, detectionError: detected.detectionError, desktopDetails: detected }; };
function desktopConfigurationNotice(snapshot?: CodingDesktopDetection): string | undefined {
  let status = '尚未确认桌面程序位置。';
  try {
    const detected = snapshot || desktopDetection();
    if (detected.supportsCodexConfig) return undefined;
    if (detected.installed) status = '已找到桌面程序，尚未确认它是否读取 Codex 配置。';
  } catch { /* Optional installation diagnostics must not break a configuration transaction. */ }
  return `${status}可以继续保存共享编程配置中的地址、认证与模型路由。当前桌面版本尚未完成实际请求验证；重启或桌面增强可另行选择程序。`;
}
// Configuration is shared with the CLI and can be prepared before discovering a
// desktop executable. Program discovery and runtime checks remain separate.
codexDesktop.preview = ctx => {
  const preview = desktopPreview(ctx);
  if (!preview.ok) return preview;
  const notice = desktopConfigurationNotice(ctx.desktopDetection);
  const warnings = [...preview.warnings];
  if (ctx.authMode !== 'coexist') warnings.push('普通 API 模式保留 auth.json 登录文件，但部分桌面版本的官方聊天和云功能可能暂不可用。需要同时使用官方账号与第三方模型时，请选择官方账号共存。');
  if (notice) warnings.push(notice);
  return { ...preview, warnings };
};
codexDesktop.connect = ctx => {
  const result = desktopConnect(ctx);
  if (!result.ok) return result;
  const notice = desktopConfigurationNotice(ctx.desktopDetection);
  return notice ? { ...result, message: `共享编程配置已保存并备份。${notice}` } : result;
};
const DESKTOP_PROFILE = CLAUDE_DESKTOP_PROFILE;
function desktopConfigPaths(): string[] {
  const selected = resolveClaudeDesktopConfig();
  return selected.root ? claudeDesktopConfigFiles(selected.root) : [];
}
const claudeDesktop = makeAdapter({
  id: 'claude-desktop', name: 'Claude 桌面版', vendor: 'Anthropic', category: 'desktop', support: 'automatic', protocol: 'anthropic', description: '通过支持第三方配置的 Claude Desktop 版本接入模型网关。',
  supportNote: '使用 Claude Desktop 的 3P profile；Sonnet、Opus、Haiku 可映射为国内外模型。需要支持 Gateway 的新版客户端。',
  docsUrl: 'https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/zh/2-providers/2.6-claude-desktop.md', desktop: 'Claude', paths: desktopConfigPaths,
  warnings: ['仅适用于支持 3P / Gateway 的 Claude Desktop 版本；旧版不会读取此配置。', '模型映射模式使用期间需保持云汇网关运行。客户端功能也取决于上游模型能力。'],
  plan(ctx) {
    const selected = resolveClaudeDesktopConfig();
    if (!selected.root) throw new Error(selected.reason);
    const [normal, thirdParty, metaFile, profileFile] = claudeDesktopConfigFiles(selected.root), ep = connectionParameters(ctx, 'anthropic');
    if (ctx.mode === 'direct' && !/^(?:anthropic\/)?claude-(?:sonnet|opus|haiku)-/.test(ctx.model)) throw new Error('Claude Desktop 直连需要可识别的 Claude 角色模型；其他模型请选择网关接入');
    const main = jsonObject(normal); main.deploymentMode = '3p';
    const third = jsonObject(thirdParty); third.deploymentMode = '3p';
    const meta = jsonObject(metaFile);
    if (meta.entries && !Array.isArray(meta.entries)) throw new Error('Claude Desktop profile 索引 entries 不是数组');
    meta.entries = (meta.entries || []).filter((x: any) => x?.id !== DESKTOP_PROFILE); meta.entries.push({ id: DESKTOP_PROFILE, name: '云汇 AI' }); meta.appliedId = DESKTOP_PROFILE;
    const profile = jsonObject(profileFile);
    Object.assign(profile, { inferenceProvider: 'gateway', inferenceGatewayBaseUrl: ctx.mode === 'gateway' ? ep.baseUrl + '/claude-desktop' : ep.baseUrl, inferenceGatewayAuthScheme: 'bearer', inferenceGatewayApiKey: ep.apiKey,
      inferenceModels: ctx.mode === 'gateway' ? ['sonnet', 'opus', 'haiku'].map(role => ({ name: `claude-${role}-aurora`, labelOverride: `${ctx.provider.name} · ${ctx.modelMap?.[role] || ctx.model}` })) : [ctx.model] });
    return [plannedJson(normal, main), plannedJson(thirdParty, third), plannedJson(metaFile, meta), plannedJson(profileFile, profile)];
  },
});
claudeDesktop.restorePaths = backup => claudeDesktopRestorePaths(backup);
claudeDesktop.detect = () => {
  const selected = resolveClaudeDesktopConfig(), files = selected.root ? claudeDesktopConfigFiles(selected.root) : [];
  const command = desktopPath('Claude');
  return { installed: !!command, configured: files.some(file => fs.existsSync(file)), command, configPath: files[0],
    evidence: [selected.reason, ...selected.candidates.filter(candidate => candidate.existing).map(candidate => candidate.root)],
    ...(selected.status !== 'resolved' ? { detectionError: selected.reason } : {}) };
};
const geminiCli = makeAdapter({
  id: 'gemini-cli', name: 'Gemini CLI', vendor: 'Google', category: 'cli', support: 'automatic', protocol: 'gemini', description: 'Google 终端助手，通过 Gemini 原生 API 或网关使用模型。',
  supportNote: '写入官方支持的用户级 .gemini/.env 与 API Key 身份设置。', docsUrl: 'https://geminicli.com/docs/reference/configuration/', command: 'gemini', paths: () => [home('.gemini', 'settings.json'), home('.gemini', '.env')],
  warnings: ['当前终端已有环境变量或项目 .env 可能覆盖用户级 .env；接入后请新开终端。'],
  plan(ctx) {
    const [file, envFile] = [home('.gemini', 'settings.json'), home('.gemini', '.env')], settings = jsonObject(file), ep = connectionParameters(ctx, 'gemini');
    settings.security = { ...(settings.security || {}), auth: { ...(settings.security?.auth || {}), selectedType: 'gemini-api-key' } }; settings.model = { ...(settings.model || {}), name: ep.model };
    return [plannedJson(file, settings), planned(envFile, patchEnv(readText(envFile), { GOOGLE_GEMINI_BASE_URL: ep.baseUrl, GOOGLE_GENAI_API_VERSION: ep.apiVersion!, GEMINI_API_KEY: ep.apiKey, GEMINI_MODEL: ep.model }))];
  },
});
const manualSpecs: AdapterSpec[] = [
  { id: 'workbuddy', name: 'WorkBuddy / CodeBuddy', vendor: '腾讯', category: 'desktop', protocol: 'openai-chat', support: 'manual', desktop: ['WorkBuddy', 'CodeBuddy'], description: '腾讯 AI 工作助手，提供适配供应商的连接参数。', supportNote: '不同版本的自定义模型入口和协议支持有差异。请在客户端支持的自定义模型页面填写参数，云汇不写入未经验证的配置字段。', docsUrl: 'https://www.codebuddy.ai/' },
  { id: 'deepseek', name: 'DeepSeek API / 兼容客户端', vendor: '深度求索', category: 'service', protocol: 'openai-chat', support: 'manual', description: '为支持 OpenAI 兼容接口的客户端生成 DeepSeek 等模型的连接参数。', supportNote: 'DeepSeek 是模型服务。可把参数填入支持自定义接口的应用；不会替换 DeepSeek 官方网页或 App 的模型。', docsUrl: 'https://api-docs.deepseek.com/' },
  { id: 'qwen-code', name: 'Qwen Code', vendor: '阿里云', category: 'cli', protocol: 'openai-chat', support: 'manual', command: 'qwen', description: '通义千问终端编程助手，提供 OpenAI 兼容接入参数。', supportNote: '按下方指南合并 settings.json 中的模型、认证和令牌设置，重新启动后选择对应模型。', docsUrl: 'https://qwenlm.github.io/qwen-code-docs/' },
  { id: 'kimi-code', name: 'Kimi Code', vendor: '月之暗面', category: 'cli', protocol: 'openai-chat', support: 'manual', command: 'kimi', description: 'Kimi 编程助手，可按官方模型配置接入。', supportNote: '按下方指南生成独立 TOML 配置，填写实际上下文容量，并通过 --config-file 指定；原有官方登录配置保留。', docsUrl: 'https://moonshotai.github.io/kimi-cli/' },
  { id: 'opencode', name: 'OpenCode', vendor: 'OpenCode', category: 'cli', protocol: 'openai-chat', support: 'manual', command: 'opencode', description: '开放的编程助手，可使用自定义 OpenAI 兼容供应商。', supportNote: '先核对 OpenCode 版本，再在下方选择 V1 或 V2 配置格式；合并到原有 JSON/JSONC 文件并重启验证。', docsUrl: 'https://opencode.ai/docs/providers/' },
  { id: 'zcode', name: 'ZCode', vendor: 'ZCode', category: 'cli', protocol: 'openai-chat', support: 'manual', command: 'zcode', description: '提供标准 API 连接参数，由客户端自定义模型入口接入。', supportNote: '该客户端版本和配置格式尚未验证，云汇只生成参数，不自动改写配置。', docsUrl: '' },
  { id: 'antigravity', name: 'Antigravity', vendor: 'Google', category: 'desktop', protocol: 'gemini', support: 'unsupported', desktop: 'Antigravity', description: 'Google 编程产品。', supportNote: '尚未验证其第三方网关配置机制，不能把 Gemini CLI 环境变量当作该产品支持的配置。', docsUrl: 'https://antigravity.google/' },
];
export const AGENT_ADAPTERS: AgentAdapter[] = [claudeCode, claudeDesktop, codexCli, codexDesktop, geminiCli, ...manualSpecs.map(makeAdapter)];
export function getAdapter(id: string): AgentAdapter | undefined { return AGENT_ADAPTERS.find(a => a.id === (id === 'codex-desktop' ? 'chatgpt-desktop' : id)); }
let detectCache: { at: number; data: Record<string, AgentDetection> } | null = null;
let detectionRevision = 0;
/** Background discovery uses the same trusted selection and invalidation generation. */
export function getDetectionContext(): { revision: number; exePath?: string } { return { revision: detectionRevision, exePath: desktopExecutable }; }
export function detectAll(_fast = false): Record<string, AgentDetection> {
  if (detectCache && Date.now() - detectCache.at < 60_000) return detectCache.data;
  const data: Record<string, AgentDetection> = {};
  for (const adapter of AGENT_ADAPTERS) { try { data[adapter.id] = adapter.detect(); } catch { data[adapter.id] = { installed: false, configured: false }; } }
  detectCache = Object.values(data).some(item => item.detectionError) ? null : { at: Date.now(), data }; return data;
}
export function detectReset(): void { detectionRevision++; detectCache = null; clearDesktopDetectionCache(); }
export function exportEnvScript(ctx: ConnectContext, protocol: string, platform: NodeJS.Platform = process.platform): string {
  const ep = connectionParameters(ctx, protocol);
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const prefix = platform === 'win32' ? '$env:' : 'export ';
  const literal = platform === 'win32' ? (value: string) => `'${value.replace(/'/g, "''")}'` : quote;
  const values: Record<string, string> = protocol === 'anthropic' ? { ANTHROPIC_BASE_URL: ep.baseUrl, ANTHROPIC_AUTH_TOKEN: ep.apiKey, ANTHROPIC_MODEL: ep.model } : protocol === 'gemini' ? { GOOGLE_GEMINI_BASE_URL: ep.baseUrl, GOOGLE_GENAI_API_VERSION: ep.apiVersion!, GEMINI_API_KEY: ep.apiKey, GEMINI_MODEL: ep.model } : { OPENAI_BASE_URL: ep.baseUrl, OPENAI_API_KEY: ep.apiKey, OPENAI_MODEL: ep.model };
  return [`# 云汇 AI · 当前终端环境变量 (${nowIso()})`, ...Object.entries(values).map(([key, value]) => `${prefix}${key}=${literal(value)}`)].join('\n');
}
