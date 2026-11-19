import fs from 'node:fs';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ActionDeps } from './actions.js';
import { getAdapter, type ConnectContext } from './agents/adapters.js';
import { inspectAppliedPlan, jsonObject, readText } from './agents/configFiles.js';
import { readOfficialCodexIdentity, getCoexistCatalog } from './gateway/coexist.js';

export interface ClientDiagnosticCheck {
  id: string;
  status: 'ok' | 'warning' | 'error' | 'info';
  title: string;
  detail: string;
}
export interface ClientDiagnosticReport {
  ok: true;
  agentId: string;
  checkedAt: string;
  checks: ClientDiagnosticCheck[];
  report: string;
}
const ENVIRONMENT: Record<string, string[]> = {
  'claude-code': ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
  'codex-cli': ['CODEX_HOME', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
  'chatgpt-desktop': ['CODEX_HOME', 'OPENAI_BASE_URL', 'OPENAI_API_KEY'],
  'gemini-cli': ['GOOGLE_GEMINI_BASE_URL', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI'],
};

/** Desktop IPC only. Strict payload; reads host-selected files, never renderer-supplied paths. */
export function diagnoseClient(deps: ActionDeps, payload: unknown): ClientDiagnosticReport | { ok: false; message: string } {
  try { return inspectClient(deps, payload); }
  catch { return { ok: false, message: '无法读取本机连接记录，请检查配置文件与权限后重试；本次未改写文件' }; }
}
function inspectClient(deps: ActionDeps, payload: unknown): ClientDiagnosticReport | { ok: false; message: string } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => key !== 'agentId') || typeof (payload as any).agentId !== 'string')
    return { ok: false, message: '请选择要诊断的客户端' };
  const adapter = getAdapter((payload as { agentId: string }).agentId);
  if (!adapter) return { ok: false, message: '未知客户端' };
  const checks: ClientDiagnosticCheck[] = [];
  const add = (id: string, status: ClientDiagnosticCheck['status'], title: string, detail: string) => checks.push({ id, status, title, detail });
  const states = deps.store.listAgents();
  const shared = ['codex-cli', 'chatgpt-desktop'].includes(adapter.id);
  const state = states[adapter.id] || (shared ? states['codex-cli'] || states['chatgpt-desktop'] || states['codex-desktop'] : undefined);
  let paths: string[] = [], automatic = false;
  try {
    const detected = adapter.detect();
    const sharedDesktop = adapter.id === 'chatgpt-desktop';
    add('installation', detected.installed || !adapter.needsInstall ? 'ok' : sharedDesktop && detected.configured ? 'info' : 'warning', '客户端安装', detected.installed || !adapter.needsInstall ? '已检测到客户端或此入口无需安装。' : sharedDesktop ? '尚未确认桌面程序位置。可继续保存与 Codex CLI 共享的编程配置；程序启动与桌面增强需另行确认安装位置。' : '未找到客户端程序。可先安装，再点击“检测本地客户端”；已有配置不代表程序已安装。');
    paths = adapter.configPaths();
    automatic = adapter.support === 'automatic';
    add('support', automatic ? 'ok' : 'info', '配置方式', sharedDesktop && automatic ? '可自动备份并写入用户级共享编程配置，遵循 CODEX_HOME；官方登录文件保持不变。' : automatic ? '此客户端提供自动配置适配。' : '此版本需要在客户端内配置，或尚未支持自动接入；请查看接入说明。');
    if (sharedDesktop) add('desktop-capability', detected.supportsCodexConfig ? 'ok' : 'warning', '桌面程序能力', detected.supportsCodexConfig ? '已从桌面安装资源确认 Codex 配置能力；重启后客户端按配置的接口地址、认证和模型发送请求，实际请求仍需验证。' : '尚未确认桌面版本及其读取的配置。可先保存共享配置，再选择实际程序，并在重启后核对请求去向。');
    const locationError = (!sharedDesktop && detected.detectionError) || (automatic && !paths.length);
    add('location', locationError ? 'error' : paths.length ? 'ok' : 'info', '配置位置', locationError ? '无法唯一确认配置目录。请检查是否存在多个版本／配置目录，再重新检测；本次未改写文件。' : paths.length ? '已按当前系统和客户端配置规则确定检查位置。' : '此入口没有已验证的自动配置位置，请在客户端内核对手动配置。');
  } catch {
    add('location', 'error', '配置位置', '无法安全检测客户端或读取配置位置，请检查安装目录与文件权限后重试。');
  }
  if (paths.length) {
    let present = 0, invalid = false;
    for (const file of paths) {
      try {
        if (!fs.existsSync(file)) continue;
        present++;
        if (path.extname(file) === '.json') jsonObject(file);
        else if (path.extname(file) === '.toml') parseToml(readText(file).replace(/^\uFEFF/, ''));
        else readText(file);
      } catch { invalid = true; }
    }
    add('format', invalid ? 'error' : present ? 'ok' : 'info', '配置可读性', invalid ? '配置无法读取、格式无效或不是普通文件。请先修复原配置与权限，再重新预览。' : present ? '已存在的受支持配置文件可以读取，JSON／TOML 格式检查通过；未验证客户端所有扩展字段。' : '尚无受支持的用户级配置，可通过配置向导创建。');
  }
  add('connection', state?.pendingReapply ? 'warning' : state?.connected ? 'ok' : 'info', '云汇连接记录', state?.pendingReapply ? '导入的设置尚未应用到此电脑，请重新预览并应用客户端配置。' : state?.connected ? '存在已应用的连接记录，继续核对配置与依赖。' : '未记录云汇自动接入；客户端可能正在使用原有官方账号或手动配置。');
  if (state?.connected || state?.pendingReapply) {
    let provider = state.providerId ? deps.store.getProvider(state.providerId) : undefined;
    const official = shared && state.authMode === 'coexist' && state.providerId === 'official';
    if (official) {
      const catalog = getCoexistCatalog(deps.store, false);
      provider = { id: 'official', name: 'ChatGPT 官方账号', format: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api/codex', apiKeys: [], models: catalog.models.filter(m => m.official).map(m => ({ id: m.upstreamModel })), enabled: true, priority: 0, createdAt: '', updatedAt: '' };
    }
    add('provider', provider?.enabled ? 'ok' : 'error', '所选供应商', provider?.enabled ? '所选供应商仍存在且已启用。' : '所选供应商已删除或停用，请到供应商页启用，或重新选择供应商。');
    if (provider) {
      const selected = [state.model, ...Object.values(state.modelMap || {})].filter(Boolean);
      const modelsValid = selected.length > 0 && selected.every(id => provider!.models.some(model => model.id === id));
      add('models', modelsValid ? 'ok' : 'warning', '所选模型', modelsValid ? '默认模型与已设置的角色映射均在当前供应商模型列表中。' : '部分所选模型不在当前列表，请同步模型后重新配置；列表缺失不代表上游一定不可用。');
      let local = false;
      try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(provider.baseUrl).hostname); } catch { /* invalid handled by configuration check */ }
      add('credential', official || local || provider.apiKeys.some(key => key.enabled && key.key) ? 'ok' : 'error', '凭据配置', official ? '当前选择使用本机官方登录，下方单独检查登录记录。' : local && !provider.apiKeys.some(key => key.enabled && key.key) ? '本地服务未设置 API Key，请确认服务允许匿名访问。' : provider.apiKeys.some(key => key.enabled && key.key) ? '至少存在一个已启用的 API Key；有效性与额度需在供应商页手动测试。' : '没有已启用且非空的 API Key，请在供应商页补全。');
      if (automatic && adapter.matchesConfiguration) {
        try {
          const context: ConnectContext = { provider, model: state.model || '', modelMap: state.modelMap, mode: state.mode || 'gateway', authMode: state.authMode || 'api', permissionMode: state.permissionMode || 'preserve', skipOnboarding: state.skipOnboarding, previousBackup: state.backupPath, gatewayUrl: deps.gatewayUrl(), token: deps.store.settings.read().gatewayToken, globalProxy: deps.store.settings.read().proxy, modelCatalogPath: path.join(deps.store.dir, 'codex-model-catalog.json') };
          const matches = adapter.matchesConfiguration(context);
          add('parameters', matches ? 'ok' : 'warning', '连接参数一致性', matches ? '受管理配置与当前供应商、模型、地址及凭据选择一致。' : '本地配置与当前选择不同，可能已更改端口、令牌或供应商。请重新预览；有外部编辑时先处理冲突。');
        } catch { add('parameters', 'error', '连接参数一致性', '无法按当前选择生成有效配置，请检查供应商、模型与配置目录，再重新预览。'); }
      }
    }
    if (state.mode !== 'direct' || state.authMode === 'coexist') {
      const running = deps.gatewayStatus().running;
      add('gateway', running ? 'ok' : 'error', '本地网关', running ? '网关正在运行；使用网关接入期间请保持云汇运行。' : '网关未运行，请在系统设置中启动网关，然后重试。');
    }
    if (state.authMode === 'coexist' && shared) {
      const identity = readOfficialCodexIdentity();
      add('official', identity.available ? 'ok' : 'warning', '官方账号共存', identity.available ? '本机登录记录可读且未发现已知过期；尚未向官方服务验证。' : '未检测到可用的本机官方登录，请在官方客户端完成登录或刷新登录状态。');
      try {
        const catalog = jsonObject(path.join(deps.store.dir, 'codex-model-catalog.json'));
        const listed = Array.isArray(catalog.models) && catalog.models.some((model: any) => model?.slug === `${state.providerId}/${state.model}`);
        add('coexist-catalog', listed ? 'ok' : 'warning', '共存模型目录', listed ? '本机共存目录包含当前所选模型。' : '本机共存目录缺失或不包含所选模型，请重新预览并应用共存配置。');
      } catch { add('coexist-catalog', 'error', '共存模型目录', '共存模型目录无法安全读取，请检查云汇数据目录权限后重新应用配置。'); }
    }
    if (state.backupPath) {
      try {
        const restorePaths = adapter.restorePaths?.(state.backupPath) ?? paths;
        const sameRoot = paths.length === restorePaths.length && paths.every((file, index) => path.resolve(file) === path.resolve(restorePaths[index]));
        add('backup-location', sameRoot ? 'ok' : 'warning', '备份所属位置', sameRoot ? '备份属于当前配置位置。' : '备份属于此前的配置位置，当前检测到的安装位置已变化；恢复只处理原位置，请核对后再接入新位置。');
        const inspected = inspectAppliedPlan(shared ? 'codex-cli' : adapter.id, state.backupPath, restorePaths);
        add('backup', inspected.backupReadable ? 'ok' : 'error', '原始备份', inspected.backupReadable ? '接入前备份可以读取。' : '接入前的部分备份缺失或不可读，请检查备份目录与权限。');
        add('drift', inspected.unchanged ? 'ok' : 'warning', '外部配置变更', inspected.unchanged ? '受管理文件与上次应用时的内容一致。' : '受管理文件在应用后被修改或删除。请先检查差异，云汇不会在诊断时覆盖这些变更。');
      } catch { add('backup', 'error', '原始备份', '备份记录无法安全核验。请检查原配置位置和备份文件；诊断不会删除或覆盖配置。'); }
    } else add('backup', 'warning', '原始备份', '没有可核验的自动接入备份，请重新预览配置；手动配置需自行保留原始文件。');
  }
  const names = (ENVIRONMENT[adapter.id] || []).filter(name => !!process.env[name]);
  add('environment', names.length ? 'warning' : 'info', '环境变量与项目覆盖', names.length ? `云汇进程检测到 ${names.join('、')}。这里只列变量名；其他终端、项目配置与启动参数仍可能覆盖用户配置，请在实际使用环境核对。` : '云汇进程未发现已知覆盖变量；其他终端、项目配置与启动参数仍需在实际使用环境核对。');
  add('runtime', 'info', '运行与上游验证', '本次只检查本机配置，不发起模型请求。配置正常不代表运行中的客户端已加载；应用后请重新启动客户端，并在供应商页按需手动测试连接。');
  const platform = ['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'unknown';
  const version = /^\d+\.\d+\.\d+$/.test(deps.version || '') ? deps.version : 'unknown';
  // Every exported line is allowlisted metadata or a static check message. Never serialize store/detection/error objects.
  const report = ['云汇 AI 本机连接诊断', `client=${adapter.id}`, `platform=${platform}`, `version=${version}`, ...checks.map(check => `[${check.status}] ${check.id}: ${check.title} — ${check.detail}`)].join('\n');
  return { ok: true, agentId: adapter.id, checkedAt: new Date().toISOString(), checks, report };
}
