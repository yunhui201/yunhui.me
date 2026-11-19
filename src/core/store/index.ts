import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { JsonFile, JsonLines } from './jsonFile.js';
import type {
  AgentState,
  PluginRecord,
  Provider,
  RoutingGroup,
  Settings,
  UsageRecord,
} from './types.js';
import { catalogPresets } from '../catalog.js';
import { GITHUB_RELEASE_API } from '../releaseSources.js';
import { newId, nowIso, dayKey } from '../util.js';
import { validatePluginConfiguration, clearMiddlewareStatus, clearAllMiddlewareStatus } from '../plugins/middleware.js';
import { validateBalanceQuery } from '../providerBalanceValidation.js';
import { applyContextDefaults, isValidContextWindow } from '../modelContext.js';

export * from './types.js';
export { JsonFile, JsonLines } from './jsonFile.js';

export interface AgentStateSnapshot { states: Record<string, AgentState>; revision: string | null }

const CONNECTION_SETTINGS = ['gatewayHost', 'gatewayPort', 'gatewayToken', 'proxy', 'lanShare', 'maskSecrets', 'autoTrimContext'] as const;
const validTimestamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

function validateProvider(provider: Provider): Provider {
  if (!provider || typeof provider.name !== 'string' || !provider.name.trim()) throw new Error('供应商名称不能为空');
  if (typeof provider.baseUrl !== 'string' || typeof provider.enabled !== 'boolean' || !Number.isFinite(provider.priority)) throw new Error('供应商地址、启用状态或优先级无效');
  if (provider.rateMultiplier !== undefined && (!Number.isFinite(provider.rateMultiplier) || provider.rateMultiplier < 0)) throw new Error('供应商倍率必须为非负数字');
  if (!['anthropic', 'openai-chat', 'openai-responses', 'gemini'].includes(provider.format)) throw new Error('不支持的供应商协议');
  if (provider.baseUrl) {
    let url: URL;
    try { url = new URL(provider.baseUrl); } catch { throw new Error('供应商接口地址格式不正确'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('供应商接口必须使用 HTTP(S)，且不能包含账号、查询参数或片段');
  }
  if (!Array.isArray(provider.models) || !Array.isArray(provider.apiKeys)) throw new Error('供应商模型和密钥必须是列表');
  if (provider.models.some(m => !m || typeof m.id !== 'string' || !m.id.trim() || /[\r\n\u0000]/.test(m.id))) throw new Error('模型 ID 不能为空或包含换行');
  if (new Set(provider.models.map(m => m.id)).size !== provider.models.length) throw new Error('同一供应商的模型 ID 不能重复');
  if (provider.apiKeys.some(k => !k || typeof k.key !== 'string' || /[\r\n]/.test(k.key))) throw new Error('API Key 格式不正确');
  if (provider.apiKeys.some(k => typeof k.id !== 'string' || !k.id || typeof k.enabled !== 'boolean' || !Number.isFinite(k.weight) || k.weight < 0)
      || new Set(provider.apiKeys.map(k => k.id)).size !== provider.apiKeys.length) throw new Error('密钥标识不能重复，启用状态和权重必须有效');
  for (const model of provider.models) {
    if (model.contextWindow !== undefined && !isValidContextWindow(model.contextWindow)) throw new Error(`模型 ${model.id} 的上下文必须是正安全整数`);
    for (const field of ['maxOutput', 'inputPrice', 'outputPrice', 'cacheReadPrice', 'cacheWritePrice'] as const) {
      const value = model[field];
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error(`模型 ${model.id} 的 ${field} 必须是非负数字`);
    }
  }
  validateBalanceQuery(provider.balanceQuery, provider.baseUrl);
  return { ...provider, models: provider.models.map(applyContextDefaults) };
}

function validateGroup(group: RoutingGroup, providers: Provider[]): RoutingGroup {
  if (!group || typeof group.name !== 'string' || !group.name.trim() || !['order', 'rotate', 'weight', 'usage', 'pace', 'smart'].includes(group.mode)
      || typeof group.enabled !== 'boolean' || !Number.isInteger(group.retries) || group.retries < 0 || group.retries > 10 || !Array.isArray(group.members)) throw new Error('分组名称、路由策略或重试次数无效（重试为 0–10 次）');
  if (group.name.trim().length > 80 || /[\\/?#\u0000-\u001f\u007f]/.test(group.name)) throw new Error('分组名称最多 80 字，不能包含斜线、问号、井号或控制字符');
  if (group.members.some(member => !member || !providers.some(p => p.id === member.providerId) || !Number.isInteger(member.weight) || member.weight < 0 || member.weight > 1000
      || (member.model !== null && member.model !== undefined && (typeof member.model !== 'string' || !member.model.trim() || /[\u0000-\u001f\u007f]/.test(member.model))))) throw new Error('分组引用了不存在的供应商，或模型、权重无效（权重为 0–1000 的整数）');
  // Catalogs may change after a group was saved. Keep such groups editable and
  // switchable; routing excludes removed explicit models until they are fixed.
  return { ...group, name: group.name.trim() };
}

function uniqueGroupNames(groups: RoutingGroup[]): void {
  const names = new Set<string>();
  for (const group of groups) {
    const name = group.name.trim().toLowerCase();
    if (names.has(name) || groups.some(other => other.id !== group.id && other.id.toLowerCase() === name)) throw new Error('分组名称已存在或与其他分组 ID 冲突，请使用不同名称');
    names.add(name);
  }
}

function validUsageRecord(record: any): record is UsageRecord {
  return !!record && typeof record === 'object'
    && ['ts', 'agent', 'providerId', 'providerName', 'model', 'requestId'].every(field => typeof record[field] === 'string')
    && /^\d{4}-\d{2}-\d{2}T/.test(record.ts)
    && ['status', 'inputTokens', 'outputTokens', 'cacheRead', 'cacheWrite', 'cost', 'latencyMs', 'attempts']
      .every(field => typeof record[field] === 'number' && Number.isFinite(record[field]) && record[field] >= 0);
}

/** Recover all committed files after a write failure, even when one rollback also fails. */
function commitStoreFiles(changes: Array<{ file: JsonFile<any>; before: any; after: any }>): void {
  const revisions = changes.map(change => change.file.revision(change.before));
  const committed: typeof changes = [];
  try {
    for (const [index, change] of changes.entries()) { change.file.writeIfUnchanged(change.after, revisions[index]); committed.push(change); }
  } catch (error) {
    const failed: string[] = [];
    for (const change of committed.reverse()) {
      try { change.file.restoreIfUnchanged(change.before, change.after); }
      catch (error) { failed.push(String((error as Error).message)); }
    }
    const conflict = /配置已变化/.test(String((error as Error).message)) ? '检测到外部配置修改，已保留；' : '';
    throw new Error(failed.length ? `保存失败，部分配置无法恢复；请使用操作前备份检查：${failed.join('；')}` : `${conflict}保存失败，已撤回本次配置变更；请检查数据目录的空间和权限`);
  }
}

export const DEFAULT_SETTINGS = (): Settings => ({
  language: 'zh-CN',
  theme: 'dark',
  accent: '#4f66e8',
  gatewayHost: '127.0.0.1',
  gatewayPort: 3425,
  autoStartGateway: true,
  launchAtLogin: false,
  closeToTray: true,
  proxy: '',
  maskSecrets: false,
  autoTrimContext: true,
  maxRetries: 2,
  requestTimeoutMs: 600000,
  usageRetentionDays: 90,
  lanShare: false,
  gatewayToken: randomBytes(24).toString('hex'),
  webdavUrl: '',
  webdavUser: '',
  webdavPass: '',
  firstByteTimeoutMs: 120000,
  logRequests: true,
  catalogUrl: 'https://yunhui.me/pub.php?action=catalog',
  updateUrl: GITHUB_RELEASE_API,
  autoCheckUpdate: true,
  adminUrl: 'https://yunhui.me/',
  autoSyncModels: true,
  connectionUpdatedAt: nowIso(),
  updatedAt: nowIso(),
});

export function defaultDataDir(): string {
  const env = process.env.YUNHUI_HOME || process.env.AURORA_HOME;
  if (env) return path.resolve(env);
  const home = os.homedir();
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME ?? path.join(home, '.config');

  const current = path.join(base, process.platform === 'linux' ? 'yunhui' : 'YunHuiAI');
  const legacy = path.join(base, process.platform === 'linux' ? 'aurora' : 'Aurora');

  // 老版本（极光 Aurora）的数据目录平滑迁移，避免升级后"什么都没有了"
  try {
    if (!fs.existsSync(current) && fs.existsSync(legacy)) {
      fs.cpSync(legacy, current, { recursive: true });
    }
  } catch {
    /* 迁移失败就继续用新目录，用户还可以手动指过去 */
  }
  return current;
}

export class AuroraStore {
  readonly dir: string;
  readonly providers: JsonFile<Provider[]>;
  readonly groups: JsonFile<RoutingGroup[]>;
  readonly settings: JsonFile<Settings>;
  readonly plugins: JsonFile<PluginRecord[]>;
  readonly agents: JsonFile<Record<string, AgentState>>;
  readonly overrides: JsonFile<Record<string, { priceIn?: number; priceOut?: number; contextWindow?: number }>>;
  private usageDir: string;

  constructor(dir = defaultDataDir()) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.providers = new JsonFile<Provider[]>(path.join(dir, 'providers.json'), () => []);
    this.groups = new JsonFile<RoutingGroup[]>(path.join(dir, 'groups.json'), () => []);
    this.settings = new JsonFile<Settings>(path.join(dir, 'settings.json'), DEFAULT_SETTINGS);
    this.plugins = new JsonFile<PluginRecord[]>(path.join(dir, 'plugins.json'), () => []);
    this.agents = new JsonFile<Record<string, AgentState>>(path.join(dir, 'agents.json'), () => ({}));
    this.overrides = new JsonFile(path.join(dir, 'pricing.json'), () => ({}));
    this.usageDir = path.join(dir, 'usage');
    fs.mkdirSync(this.usageDir, { recursive: true });
    // Persist the generated token before any client configuration can refer to it.
    if (!fs.existsSync(path.join(dir, 'settings.json'))) this.settings.write(this.settings.read());
  }

  /* ---------------------------- providers ---------------------------- */

  listProviders(): Provider[] {
    return this.providers.read();
  }

  getProvider(id: string): Provider | undefined {
    return this.providers.read().find((p) => p.id === id);
  }

  saveProvider(input: Partial<Provider> & { id?: string }): Provider {
    const list = [...this.providers.read()];
    if (input.id) {
      const idx = list.findIndex((p) => p.id === input.id);
      if (idx >= 0) {
        list[idx] = validateProvider({ ...list[idx], ...input, updatedAt: nowIso() } as Provider);
        this.providers.write([...list]);
        return list[idx];
      }
      throw new Error('供应商已被删除，请刷新列表后重新添加');
    }
    const preset = catalogPresets(this).find(p => p.id === input.presetId);
    const created: Provider = {
      id: newId('prov_', 8),
      name: input.name ?? preset?.nameZh ?? preset?.name ?? '自定义供应商',
      presetId: input.presetId,
      format: input.format ?? preset?.format ?? 'openai-chat',
      baseUrl: input.baseUrl ?? preset?.baseUrl ?? '',
      apiKeys: input.apiKeys ?? [{ id: newId('key_', 6), label: '默认', key: '', enabled: true, weight: 1 }],
      models: input.models ?? preset?.models ?? [],
      enabled: input.enabled ?? true,
      priority: input.priority ?? 10,
      color: input.color ?? preset?.color ?? '#6d8cff',
      icon: input.icon ?? preset?.icon ?? '◆',
      headers: input.headers,
      proxy: input.proxy,
      notes: input.notes,
      rateMultiplier: input.rateMultiplier ?? 1,
      balanceQuery: input.balanceQuery,
      official: input.official,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const validated = validateProvider(created);
    this.providers.write([...list, validated]);
    return validated;
  }

  deleteProvider(id: string): void {
    const providers = this.listProviders(), provider = providers.find(p => p.id === id);
    if (!provider) throw new Error('供应商不存在，请刷新列表');
    const references = Object.values(this.listAgents()).filter(agent => {
      if (!agent.connected && !agent.pendingReapply) return false;
      if (agent.providerId === id) return true;
      return [agent.model, ...Object.values(agent.modelMap || {})].some(model => {
        if (!model || this.getProvider(agent.providerId || '')?.models.some(item => item.id === model)) return false;
        if (model.indexOf('/') <= 0) return false;
        const prefix = model.slice(0, model.indexOf('/'));
        return prefix === id || prefix.toLowerCase() === provider.name.toLowerCase() || prefix.toLowerCase() === provider.presetId?.toLowerCase();
      });
    });
    if (references.length) throw new Error(`客户端 ${references.map(agent => agent.id).join('、')} 仍引用此供应商，请先更换或恢复客户端配置`);
    const groups = this.listGroups();
    commitStoreFiles([
      { file: this.providers, before: providers, after: providers.filter(p => p.id !== id) },
      { file: this.groups, before: groups, after: groups.map(g => ({ ...g, members: g.members.filter(m => m.providerId !== id) })) },
    ]);
  }

  /* ---------------------------- groups ---------------------------- */

  listGroups(): RoutingGroup[] {
    return this.groups.read();
  }

  saveGroup(input: Partial<RoutingGroup> & { id?: string }): RoutingGroup {
    const list = [...this.groups.read()];
    if (input.id) {
      const idx = list.findIndex((g) => g.id === input.id);
      if (idx >= 0) {
        list[idx] = validateGroup({ ...list[idx], ...input } as RoutingGroup, this.listProviders());
        uniqueGroupNames(list);
        this.groups.write([...list]);
        return list[idx];
      }
      throw new Error('路由分组已被删除，请刷新列表后重新添加');
    }
    const created: RoutingGroup = {
      id: newId('grp_', 8),
      name: input.name ?? '新分组',
      mode: input.mode ?? 'order',
      members: input.members ?? [],
      enabled: input.enabled ?? true,
      retries: input.retries ?? 2,
      notes: input.notes,
      createdAt: nowIso(),
    };
    const valid = validateGroup(created, this.listProviders());
    uniqueGroupNames([...list, valid]);
    this.groups.write([...list, valid]);
    return valid;
  }

  deleteGroup(id: string): void {
    this.groups.write(this.groups.read().filter((g) => g.id !== id));
  }

  /* ---------------------------- settings ---------------------------- */

  getSettings(): Settings {
    const stored = this.settings.read();
    const settings = { ...DEFAULT_SETTINGS(), ...stored, updateUrl: GITHUB_RELEASE_API, autoSyncModels: true };
    let migrated = stored.updateUrl !== GITHUB_RELEASE_API || stored.autoSyncModels !== true;
    if (!validTimestamp(stored.connectionUpdatedAt)) {
      settings.connectionUpdatedAt = validTimestamp(stored.updatedAt) ? stored.updatedAt : nowIso();
      migrated = true;
    }
    if (!validTimestamp(stored.updatedAt)) { settings.updatedAt = settings.connectionUpdatedAt!; migrated = true; }
    if (typeof stored.gatewayToken !== 'string' || !stored.gatewayToken.trim()) {
      settings.gatewayToken = randomBytes(24).toString('hex');
      settings.connectionUpdatedAt = nowIso();
      migrated = true;
    }
    if (migrated) this.settings.write(settings);
    return settings;
  }

  saveSettings(patch: Partial<Settings>): Settings {
    const before = this.getSettings();
    const next = { ...before, ...patch, updateUrl: GITHUB_RELEASE_API, autoSyncModels: true, updatedAt: nowIso() };
    // This revision is application-owned; an IPC payload cannot reuse old
    // successes by backdating it or invalidate connections with a theme change.
    next.connectionUpdatedAt = CONNECTION_SETTINGS.some(key => next[key] !== before[key]) ? next.updatedAt : before.connectionUpdatedAt;
    this.validateSettings(next);
    this.settings.write(next);
    return next;
  }

  private validateSettings(next: Settings): void {
    if (!['light', 'dark', 'system'].includes(next.theme)) throw new Error('请选择有效主题');
    if (!/^#[a-fA-F0-9]{6}$/.test(next.accent)) throw new Error('主题色应为六位十六进制颜色');
    if (!Number.isInteger(next.gatewayPort) || next.gatewayPort < 1024 || next.gatewayPort > 65535) throw new Error('网关端口必须在 1024–65535 之间');
    if (!isIP(next.gatewayHost) && next.gatewayHost !== 'localhost') throw new Error('网关监听地址必须是有效 IP 或 localhost');
    if (typeof next.gatewayToken !== 'string' || next.gatewayToken.length < 16 || /[\r\n]/.test(next.gatewayToken)) throw new Error('网关访问令牌至少 16 个字符，不能留空');
    for (const key of ['autoStartGateway', 'launchAtLogin', 'closeToTray', 'maskSecrets', 'autoTrimContext', 'lanShare', 'logRequests', 'autoCheckUpdate', 'autoSyncModels'] as const) {
      if (typeof next[key] !== 'boolean') throw new Error(`${key} 必须为开关值`);
    }
    for (const [key, min, max] of [['maxRetries', 0, 10], ['requestTimeoutMs', 1000, 1800000], ['firstByteTimeoutMs', 1000, 600000], ['usageRetentionDays', 1, 3650]] as const) {
      if (!Number.isInteger(next[key]) || next[key] < min || next[key] > max) throw new Error(`${key} 必须在 ${min}–${max} 之间`);
    }
    for (const key of ['catalogUrl', 'updateUrl', 'adminUrl', 'proxy'] as const) {
      if (!next[key]) continue;
      let url: URL;
      try { url = new URL(next[key]); } catch { throw new Error(`${key} 不是有效地址`); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${key} 仅支持 HTTP(S)`);
    }
  }

  /* ---------------------------- agents ---------------------------- */

  listAgents(): Record<string, AgentState> {
    return this.agents.read();
  }

  saveAgent(state: AgentState): AgentState {
    return this.saveAgents([state])[0];
  }

  /** Shared clients must commit all connection records in the same atomic write. */
  saveAgents(states: AgentState[]): AgentState[] {
    const all = { ...this.agents.read() };
    const lastSyncAt = nowIso();
    for (const state of states) all[state.id] = { ...all[state.id], ...state, lastSyncAt };
    this.agents.write(all);
    return states.map(state => all[state.id]);
  }

  /** Read a fresh disk snapshot for reviewed client operations, including other clients. */
  readAgentSnapshot(): AgentStateSnapshot {
    const initialRevision = this.agents.revision();
    this.agents.invalidate();
    const states = structuredClone(this.agents.read());
    // Validate that the parsed snapshot still describes the complete file.
    // A concurrent edit invalidates the cache and stops the caller's preview.
    const revision = this.agents.revision(states);
    if (revision !== initialRevision) {
      this.agents.invalidate();
      throw new Error('客户端连接记录在读取期间已变化，请重新预览');
    }
    return { states, revision };
  }

  /** Selective permission recovery must never overwrite another client's new state. */
  saveAgentsIfUnchanged(states: AgentState[], snapshot: AgentStateSnapshot): AgentState[] {
    const all = { ...snapshot.states }, lastSyncAt = nowIso();
    for (const state of states) all[state.id] = { ...all[state.id], ...state, lastSyncAt };
    this.agents.writeIfUnchanged(all, snapshot.revision);
    return states.map(state => all[state.id]);
  }

  /* ---------------------------- plugins ---------------------------- */

  listPlugins(): PluginRecord[] {
    return this.plugins.read();
  }

  savePlugin(p: Partial<PluginRecord> & { id?: string }): PluginRecord {
    const list = [...this.plugins.read()];
    const builtin = ['model-map', 'system-prompt', 'word-guard', 'param-override', 'token-budget'].includes(p.id || '');
    if (p.builtin && !builtin) throw new Error('未知的内置插件');
    if (p.id) {
      const idx = list.findIndex((x) => x.id === p.id);
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...p, builtin, updatedAt: nowIso() } as PluginRecord;
        // A legacy invalid plugin must remain possible to disable without first editing its code.
        if (!(p.enabled === false && Object.keys(p).every(key => ['id', 'enabled'].includes(key)))) validatePluginConfiguration(list[idx]);
        this.plugins.write([...list]);
        clearMiddlewareStatus(this, list[idx].id);
        return list[idx];
      }
    }
    const rec: PluginRecord = {
      id: builtin ? p.id! : newId('plg_', 8),
      name: p.name ?? '未命名插件',
      description: p.description,
      code: p.code,
      enabled: p.enabled ?? false,
      builtin,
      options: p.options,
      updatedAt: nowIso(),
    };
    validatePluginConfiguration(rec);
    this.plugins.write([...list, rec]);
    clearMiddlewareStatus(this, rec.id);
    return rec;
  }

  deletePlugin(id: string): void {
    this.plugins.write(this.plugins.read().filter((p) => p.id !== id));
    clearMiddlewareStatus(this, id);
  }

  /* ---------------------------- usage ---------------------------- */

  recordUsage(rec: UsageRecord): void {
    const file = path.join(this.usageDir, `${dayKey()}.jsonl`);
    new JsonLines(file).append(rec);
  }

  readUsage(days = 14): UsageRecord[] {
    days = Math.max(1, Math.min(3650, Math.floor(Number(days) || 14)));
    const out: UsageRecord[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const file = path.join(this.usageDir, `${dayKey(d)}.jsonl`);
      if (!fs.existsSync(file)) continue;
      for (const record of new JsonLines(file).read(0, validUsageRecord)) out.push(record);
    }
    return out;
  }

  recentRequests(limit = 200): UsageRecord[] {
    const maximum = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 200)));
    const out: UsageRecord[] = [];
    for (let i = 0; i < 7 && out.length < maximum; i++) {
      const file = path.join(this.usageDir, `${dayKey(new Date(Date.now() - i * 86400000))}.jsonl`);
      if (fs.existsSync(file)) out.push(...new JsonLines(file).read(maximum - out.length, validUsageRecord).reverse());
    }
    return out;
  }

  usageDirPath(): string {
    return this.usageDir;
  }

  readExtra<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  writeExtra(name: string, data: unknown): void {
    if (path.basename(name) !== name || name === '.' || name === '..') throw new Error('配置文件名无效');
    new JsonFile<unknown>(path.join(this.dir, name), () => null).write(data);
  }

  exportAll(): Record<string, unknown> {
    return structuredClone({
      version: 1,
      exportedAt: nowIso(),
      providers: this.listProviders(),
      groups: this.listGroups(),
      settings: this.getSettings(),
      plugins: this.listPlugins(),
      agents: this.listAgents(),
    });
  }

  importAll(data: any): void {
    if (!data || data.version !== 1 || !Array.isArray(data.providers) || !Array.isArray(data.groups) || !Array.isArray(data.plugins) || !data.settings || typeof data.settings !== 'object') throw new Error('这不是受支持的云汇配置备份');
    const providers = data.providers.map((p: Provider) => validateProvider(p));
    const validId = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id);
    if (providers.some((p: Provider) => !validId(p.id)) || new Set(providers.map((p: Provider) => p.id)).size !== providers.length) throw new Error('备份中的供应商 ID 无效或重复');
    const groups = data.groups as RoutingGroup[];
    if (new Set(groups.map(group => group?.id)).size !== groups.length) throw new Error('备份中的分组 ID 重复');
    for (const group of groups) {
      if (!group || !validId(group.id) || !['order', 'rotate', 'weight', 'usage', 'pace', 'smart'].includes(group.mode) || !Array.isArray(group.members)) throw new Error('备份中的路由分组无效');
      if (group.members.some(m => !m || !providers.some((p: Provider) => p.id === m.providerId) || !Number.isFinite(m.weight) || m.weight < 0)) throw new Error('路由分组引用了不存在的供应商或权重无效');
      validateGroup(group, providers);
    }
    uniqueGroupNames(groups);
    const importedAt = nowIso();
    const settings: Settings = { ...DEFAULT_SETTINGS(), ...data.settings, updateUrl: GITHUB_RELEASE_API, autoSyncModels: true, connectionUpdatedAt: importedAt, updatedAt: importedAt };
    if (!settings.gatewayToken) settings.gatewayToken = randomBytes(24).toString('hex');
    this.validateSettings(settings);
    const plugins = data.plugins as PluginRecord[];
    if (new Set(plugins.map(plugin => plugin?.id)).size !== plugins.length) throw new Error('备份中的插件 ID 重复');
    for (const plugin of plugins) {
      if (!plugin || !validId(plugin.id) || typeof plugin.name !== 'string' || typeof plugin.enabled !== 'boolean' || (plugin.code !== undefined && typeof plugin.code !== 'string')) throw new Error('备份中的插件配置无效');
      if (plugin.builtin && !['model-map', 'system-prompt', 'word-guard', 'param-override', 'token-budget'].includes(plugin.id)) throw new Error('备份包含未知的内置插件');
    }
    // Importing settings does not write client files. Keep bindings for reapplication, without claiming they are live.
    const localAgents = this.listAgents();
    const agents: Record<string, AgentState> = Object.fromEntries(Object.entries(localAgents).map(([id, value]) => [id, { ...value, connected: false, pendingReapply: !!(value.backupPath && (value.connected || value.pendingReapply)) }]));
    for (const [id, value] of Object.entries(data.agents || {})) {
      const state = value as AgentState;
      if (!validId(id) || !state || typeof state !== 'object') throw new Error('备份中的客户端信息无效');
      if (state.permissionMode !== undefined && state.permissionMode !== 'preserve' && state.permissionMode !== 'full-access') throw new Error('备份中的客户端权限模式无效');
      if (state.skipOnboarding !== undefined && typeof state.skipOnboarding !== 'boolean') throw new Error('备份中的首次登录引导选项无效');
      const local = localAgents[id];
      agents[id] = { id: id as AgentState['id'], connected: false, providerId: state.providerId, model: state.model, modelMap: state.modelMap, mode: state.mode, authMode: state.authMode, permissionMode: state.permissionMode, skipOnboarding: state.skipOnboarding,
        backupPath: local?.backupPath, configPath: local?.configPath, pendingReapply: !!(local?.backupPath && (local.connected || local.pendingReapply)) };
    }
    const before = this.exportAll();
    commitStoreFiles([
      { file: this.providers, before: before.providers, after: providers },
      { file: this.groups, before: before.groups, after: groups },
      { file: this.settings, before: before.settings, after: settings },
      { file: this.plugins, before: before.plugins, after: plugins },
      { file: this.agents, before: before.agents, after: agents },
    ]);
    clearAllMiddlewareStatus(this);
  }
}

let singleton: AuroraStore | null = null;
export function getStore(): AuroraStore {
  if (!singleton) singleton = new AuroraStore();
  return singleton;
}
export function setDataDir(dir: string): void {
  singleton = new AuroraStore(dir);
}
