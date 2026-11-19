import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AuroraStore, Provider } from './store/index.js';
import type { BalanceAdapter, ProviderBalanceEntry, ProviderBalanceItem, ProviderBalanceQuery, ProviderBalanceResult } from './providerBalanceTypes.js';
import { balancePath, balanceUrl, validateBalanceHeaders, validateBalanceQuery } from './providerBalanceValidation.js';
import { openUpstream, readAll, type OpenOptions, type OpenResult } from './gateway/upstream.js';

type Transport = (url: string, options: OpenOptions) => Promise<OpenResult>;
type Cached = { fingerprint: string; item: ProviderBalanceItem };
type CacheFile = { version: 1; items: Record<string, Cached> };
type Target = { id: string; label: string; secret: string };
const FILE = 'provider-balances.json', jobs = new Map<string, Promise<ProviderBalanceItem>>();
const attempted = new Map<string, number>();
let active = 0;
const waiting: Array<() => void> = [];
async function acquire(): Promise<() => void> {
  if (active >= 3) await new Promise<void>(resolve => waiting.push(resolve)); else active++;
  return () => { const next = waiting.shift(); if (next) next(); else active--; };
}
class BalanceError extends Error {}
const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^-?(?:\d+\.?\d*|\.\d+)$/.test(value.trim()) && Number.isFinite(Number(value)) ? Number(value) : undefined;
const amount = (value: unknown): number => { const number = numeric(value); if (number === undefined) throw new BalanceError('余额接口未返回有效金额，未将缺失值当作零'); return number; };
const date = (value: unknown): string | undefined => { const stamp = typeof value === 'number' ? value > 0 ? value * 1000 : NaN : typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(stamp) ? new Date(stamp).toISOString() : undefined; };
const unit = (value: unknown, fallback = 'UNKNOWN') => typeof value === 'string' && /^[A-Z][A-Z0-9 _-]{0,15}$/i.test(value) ? value.toUpperCase() : fallback;
function ownPath(data: unknown, field: string): unknown { let value: any = data; for (const key of balancePath(field)) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined; value = value[key]; } return value; }
function entry(label: string, scope: ProviderBalanceEntry['scope'], currency: string, values: Partial<ProviderBalanceEntry>): ProviderBalanceEntry { return { label, scope, currency, ...values }; }

export function detectBalanceAdapter(provider: Pick<Provider, 'baseUrl' | 'balanceQuery'>): BalanceAdapter {
  const selected = provider.balanceQuery?.adapter || 'auto';
  if (selected !== 'auto') return selected;
  let hostname: string; try { hostname = new URL(provider.baseUrl).hostname; } catch { return 'auto'; }
  return ({ 'api.deepseek.com': 'deepseek', 'api.moonshot.cn': 'moonshot', 'api.moonshot.ai': 'moonshot', 'openrouter.ai': 'openrouter', 'api.stepfun.com': 'stepfun', 'api.novita.ai': 'novita', 'api.yunhui.me': 'sub2api' } as Record<string, BalanceAdapter>)[hostname] || 'auto';
}

export function parseProviderBalance(adapter: BalanceAdapter, data: any, provider: Pick<Provider, 'baseUrl' | 'balanceQuery'>, status?: any): ProviderBalanceEntry[] {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.error || data.success === false || data.status === false || data.isValid === false) throw new BalanceError('余额接口拒绝请求或返回了无效数据');
  if (adapter === 'deepseek') {
    if (!Array.isArray(data.balance_infos) || !data.balance_infos.length || data.balance_infos.length > 20) throw new BalanceError('余额接口未返回钱包信息');
    return data.balance_infos.map((wallet: any) => entry('账户余额', 'account', unit(wallet?.currency), { remaining: amount(wallet?.total_balance) }));
  }
  if (adapter === 'moonshot') return [entry('账户余额', 'account', new URL(provider.baseUrl).hostname === 'api.moonshot.cn' ? 'CNY' : 'USD', { remaining: amount(data.data?.available_balance) })];
  if (adapter === 'openrouter') { const total = amount(data.data?.total_credits), used = amount(data.data?.total_usage); return [entry('账户余额', 'account', 'USD', { total, used, remaining: total - used })]; }
  if (adapter === 'stepfun') return [entry('账户余额', 'account', 'CNY', { remaining: amount(data.balance) })];
  if (adapter === 'novita') return [entry('账户余额', 'account', 'USD', { remaining: amount(data.availableBalance) / 10000 })];
  if (adapter === 'sub2api') {
    const entries: ProviderBalanceEntry[] = [], currency = unit(data.unit, 'USD');
    if (data.mode === 'quota_limited') {
      if (data.quota) entries.push(entry('API Key 总额度', 'key', unit(data.quota.unit, currency), { remaining: amount(data.quota.remaining), total: amount(data.quota.limit), used: amount(data.quota.used) }));
      if (Array.isArray(data.rate_limits)) for (const limit of data.rate_limits.slice(0, 20)) entries.push(entry(`API Key ${['5h', '1d', '7d'].includes(limit?.window) ? limit.window : '周期'}额度`, 'key', currency, { remaining: amount(limit?.remaining), total: amount(limit?.limit), used: amount(limit?.used), resetsAt: date(limit?.reset_at) }));
    } else if (data.mode === 'unrestricted') {
      if (data.subscription && typeof data.subscription === 'object') {
        for (const [field, label] of [['daily', '每日'], ['weekly', '每周'], ['monthly', '每月']]) {
          const total = numeric(data.subscription[`${field}_limit_usd`]), used = numeric(data.subscription[`${field}_usage_usd`]);
          if (total !== undefined && total > 0 && used !== undefined) entries.push(entry(`${label}订阅额度`, 'subscription', 'USD', { total, used, remaining: Math.max(0, total - used) }));
        }
        if (!entries.length && data.remaining === -1) entries.push(entry('订阅额度', 'subscription', currency, { unlimited: true }));
      } else if (numeric(data.balance) !== undefined) entries.push(entry('账户余额', 'account', currency, { remaining: amount(data.balance) }));
    }
    if (!entries.length) throw new BalanceError('接口未提供余额或额度明细，请在供应商控制台查看');
    return entries;
  }
  if (adapter === 'newapi') {
    const token = data.data;
    if (!token || token.object !== 'token_usage' || typeof token.unlimited_quota !== 'boolean') throw new BalanceError('接口没有返回有效的 New API 令牌额度');
    const perUnit = numeric(status?.data?.quota_per_unit), rate = numeric(status?.data?.usd_exchange_rate), display = status?.data?.quota_display_type;
    const known = status?.success !== false && perUnit !== undefined && perUnit > 0;
    const cny = display === 'CNY' && rate !== undefined && rate > 0;
    const currency = known && (display === 'USD' || cny) ? cny ? 'CNY' : 'USD' : 'POINTS';
    const factor = currency === 'POINTS' ? 1 : (cny ? rate! : 1) / perUnit!;
    const convert = (value: unknown) => amount(value) * factor;
    if (token.unlimited_quota) return numeric(token.user_quota?.total_available) !== undefined ? [entry('账户余额', 'account', currency, { remaining: convert(token.user_quota.total_available) })] : [entry('API Key 额度（账户余额未知）', 'key', currency, { unlimited: true })];
    return [entry('API Key 额度', 'key', currency, { remaining: convert(token.total_available), total: convert(token.total_granted), used: convert(token.total_used) })];
  }
  if (adapter === 'custom') {
    const query = provider.balanceQuery!, values: Partial<ProviderBalanceEntry> = {}, factor = query.multiplier ?? 1;
    for (const [field, target] of [['balancePath', 'remaining'], ['totalPath', 'total'], ['usedPath', 'used']] as const) if (query[field]) { const result = amount(ownPath(data, query[field]!)) * factor; if (!Number.isFinite(result)) throw new BalanceError('余额换算结果超出有效范围'); values[target] = result; }
    if (!query.balancePath && values.total !== undefined && values.used !== undefined) {
      values.remaining = values.total - values.used;
      if (!Number.isFinite(values.remaining)) throw new BalanceError('余额换算结果超出有效范围');
    }
    return [entry('自定义查询结果', query.scope || 'account', unit(query.currency), values)];
  }
  throw new BalanceError('该供应商尚无可验证的余额接口');
}

function requestSpec(provider: Provider, adapter: BalanceAdapter, target: Target): { url: string; options: OpenOptions; statusUrl?: string } {
  const query = provider.balanceQuery, base = balanceUrl(adapter === 'custom' ? query!.url! : provider.baseUrl), prefix = base.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  let url: string;
  if (adapter === 'custom') url = balanceUrl(query!.url!).href;
  else {
    const suffix = ({ deepseek: '/user/balance', moonshot: '/v1/users/me/balance', openrouter: '/api/v1/credits', stepfun: '/v1/accounts', novita: '/openapi/v1/billing/balance/detail' } as Record<string, string>)[adapter];
    url = suffix ? new URL(suffix, base.origin).href : `${base.origin}${prefix}${adapter === 'newapi' ? '/api/usage/token/' : '/v1/usage'}`;
  }
  const custom = adapter === 'custom', headers: Record<string, string> = { accept: 'application/json' };
  const configured = custom ? query?.headers : provider.headers;
  if (configured) { validateBalanceHeaders(configured); for (const [name, value] of Object.entries(configured)) headers[name.toLowerCase()] = value; }
  // A separate query token must never inherit the inference provider's authentication headers.
  if (!custom || query?.auth !== 'none') headers[custom ? (query?.authHeader || 'authorization').toLowerCase() : 'authorization'] = `${custom && query?.authScheme === 'raw' ? '' : 'Bearer '}${target.secret}`;
  if (custom && query?.body) headers['content-type'] = 'application/json';
  return { url, options: { method: custom ? query?.method || 'GET' : 'GET', headers, ...(custom && query?.body ? { body: query.body } : {}) }, ...(adapter === 'newapi' ? { statusUrl: `${base.origin}${prefix}/api/status` } : {}) };
}
function targets(provider: Provider): Target[] {
  const query = provider.balanceQuery;
  if (query?.adapter === 'custom' && query.auth === 'token') return [{ id: 'query-token', label: '独立查询令牌', secret: query.token || '' }];
  if (query?.adapter === 'custom' && query.auth === 'none') return [{ id: 'query-public', label: '公开查询', secret: '' }];
  return provider.apiKeys.filter(key => key.enabled).map(key => ({ id: key.id, label: key.label || key.id, secret: key.key }));
}
function fingerprint(store: AuroraStore, provider: Provider, target: Target): string { return createHash('sha256').update(JSON.stringify({ baseUrl: provider.baseUrl, format: provider.format, headers: provider.headers, proxy: provider.proxy || store.getSettings().proxy, query: provider.balanceQuery || { adapter: 'auto' }, enabled: provider.enabled, key: target })).digest('hex'); }
function current(store: AuroraStore, id: string): Provider | undefined { store.providers.invalidate(); store.settings.invalidate(); return store.getProvider(id); }
function readCache(store: AuroraStore): CacheFile {
  try { const file = path.join(store.dir, FILE); if (fs.statSync(file).size > 8 * 1024 * 1024) return { version: 1, items: {} }; const value = JSON.parse(fs.readFileSync(file, 'utf8')); if (value.version === 1 && value.items && typeof value.items === 'object' && !Array.isArray(value.items)) return value; } catch { /* A missing or invalid cache never supplies a balance. */ }
  return { version: 1, items: {} };
}
function validCachedItem(item: ProviderBalanceItem | undefined): item is ProviderBalanceItem {
  const validStamp = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now();
  if (!item || !['ok', 'error'].includes(item.status) || typeof item.keyId !== 'string' || typeof item.keyLabel !== 'string' || !Array.isArray(item.entries) || item.entries.length > 64 || !validStamp(item.checkedAt)) return false;
  if ((item.status === 'ok' || item.entries.length > 0) && (!validStamp(item.updatedAt) || !item.entries.length)) return false;
  if (item.updatedAt !== undefined && !validStamp(item.updatedAt)) return false;
  return !item.entries.some(e => !e || !['account', 'key', 'subscription'].includes(e.scope) || typeof e.label !== 'string' || typeof e.currency !== 'string'
    || (e.unlimited !== undefined && typeof e.unlimited !== 'boolean')
    || ['remaining', 'total', 'used'].some(key => e[key as keyof ProviderBalanceEntry] !== undefined && (typeof e[key as keyof ProviderBalanceEntry] !== 'number' || !Number.isFinite(e[key as keyof ProviderBalanceEntry]))));
}
function cachedItem(store: AuroraStore, cacheKey: string, digest: string): ProviderBalanceItem | undefined {
  const cached = readCache(store).items[cacheKey];
  if (cached?.fingerprint !== digest || !validCachedItem(cached.item)) return undefined;
  return cached.item;
}
function pruneCache(store: AuroraStore, cache: CacheFile, keep: string): CacheFile {
  const existing = new Map<string, string>();
  for (const provider of store.listProviders()) for (const target of targets(provider)) existing.set(JSON.stringify([provider.id, target.id]), fingerprint(store, provider, target));
  const entries = Object.entries(cache.items).filter(([key, cached]) => existing.get(key) === cached?.fingerprint && validCachedItem(cached?.item));
  entries.sort(([left, a], [right, b]) => left === keep ? -1 : right === keep ? 1 : Date.parse(b.item.checkedAt!) - Date.parse(a.item.checkedAt!));
  return { version: 1, items: Object.fromEntries(entries.slice(0, 1000)) };
}
async function queryOne(store: AuroraStore, provider: Provider, target: Target, adapter: BalanceAdapter, force: boolean, transport: Transport): Promise<ProviderBalanceItem> {
  const digest = fingerprint(store, provider, target), cacheKey = JSON.stringify([provider.id, target.id]), jobKey = JSON.stringify([path.resolve(store.dir), cacheKey, digest]);
  const previous = cachedItem(store, cacheKey, digest), now = Date.now();
  const pending = jobs.get(jobKey); if (pending) return pending;
  const last = Math.max(attempted.get(jobKey) || 0, Date.parse(previous?.checkedAt || '') || 0), ttl = previous?.status === 'ok' ? 300000 : 30000;
  if (previous && (now - last < 10000 || (!force && now - last < ttl))) return { ...previous, keyLabel: target.label, cached: true };
  if (now - last < 10000) return { keyId: target.id, keyLabel: target.label, status: 'error', entries: [], cached: true, message: '查询过于频繁，请稍后再试' };
  const run = (async (): Promise<ProviderBalanceItem> => {
    const release = await acquire();
    const changed = () => { const latest = current(store, provider.id); const item = latest && targets(latest).find(key => key.id === target.id); return !latest || !item || fingerprint(store, latest, item) !== digest; };
    const discarded = (): ProviderBalanceItem => ({ keyId: target.id, keyLabel: target.label, status: 'unconfigured', entries: [], message: '供应商或余额查询配置已变化，本次结果已丢弃' });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    let item: ProviderBalanceItem;
    try {
      if (changed()) return discarded();
      attempted.set(jobKey, Date.now()); if (attempted.size > 10000) attempted.delete(attempted.keys().next().value!);
      const checkedAt = new Date().toISOString(), spec = requestSpec(provider, adapter, target);
      const get = async (url: string, options: OpenOptions): Promise<any> => {
        let response: OpenResult | undefined;
        try {
          response = await transport(url, { ...options, proxy: provider.proxy || store.getSettings().proxy || undefined, timeoutMs: 15000, signal: controller.signal });
          if (response.status >= 300 && response.status < 400) throw new BalanceError('余额接口发生重定向，已停止请求以保护查询凭据');
          if (response.status < 200 || response.status >= 300) throw new BalanceError(response.status === 401 || response.status === 403 ? '余额接口拒绝认证，请核对查询权限或令牌' : response.status === 429 ? '余额接口请求过于频繁，请稍后重试' : '余额接口暂不可用，请稍后重试');
          if (Number(response.headers['content-length']) > 1048576) throw new BalanceError('余额接口响应超过大小限制');
          return JSON.parse(await readAll(response.stream, 1048576));
        } finally { response?.raw.destroy(); }
      };
      const data = await get(spec.url, spec.options);
      let status: any;
      if (spec.statusUrl) try { status = await get(spec.statusUrl, { method: 'GET', headers: { accept: 'application/json' } }); } catch { /* Without a verified conversion unit, report points. */ }
      const entries = parseProviderBalance(adapter, data, provider, status);
      if (entries.some(e => ['remaining', 'total', 'used'].some(key => e[key as keyof ProviderBalanceEntry] !== undefined && !Number.isFinite(e[key as keyof ProviderBalanceEntry])))) throw new BalanceError('余额金额超出有效范围');
      item = { keyId: target.id, keyLabel: target.label, status: 'ok', entries, updatedAt: new Date().toISOString(), checkedAt };
    } catch (error) {
      item = { keyId: target.id, keyLabel: target.label, status: 'error', entries: previous?.entries || [], updatedAt: previous?.updatedAt, checkedAt: new Date().toISOString(), stale: !!previous?.entries.length,
        message: controller.signal.aborted ? '余额查询超时，请检查网络或代理设置' : error instanceof BalanceError ? error.message : '余额查询失败，请检查接口配置、网络或返回格式' };
    } finally { clearTimeout(timer); release(); }
    if (changed()) return discarded();
    try { const cache = readCache(store); cache.items[cacheKey] = { fingerprint: digest, item }; store.writeExtra(FILE, pruneCache(store, cache, cacheKey)); }
    catch { item = { ...item, message: `${item.message ? item.message + '；' : ''}余额结果未能保存到本地缓存，请检查磁盘空间和权限` }; }
    return item;
  })();
  jobs.set(jobKey, run);
  try { return await run; } finally { if (jobs.get(jobKey) === run) jobs.delete(jobKey); }
}

/** Only a stored provider and key selector cross IPC/RPC; callers cannot override the network target. */
export async function providerBalance(store: AuroraStore, payload: { providerId: string; keyId?: string; force?: boolean }, transport: Transport = openUpstream): Promise<ProviderBalanceResult> {
  if (!payload || typeof payload !== 'object' || Object.keys(payload).some(key => !['providerId', 'keyId', 'force'].includes(key)) || typeof payload.providerId !== 'string' || !payload.providerId || payload.providerId.length > 160 || (payload.keyId !== undefined && (typeof payload.keyId !== 'string' || !payload.keyId || payload.keyId.length > 160)) || (payload.force !== undefined && typeof payload.force !== 'boolean')) throw new Error('余额查询参数无效');
  const provider = current(store, payload.providerId);
  if (!provider) return { providerId: payload.providerId, adapter: 'auto', items: [], message: '供应商已不存在，请刷新列表' };
  const adapter = detectBalanceAdapter(provider), base = { providerId: provider.id, adapter };
  let selected = targets(provider); if (payload.keyId) selected = selected.filter(key => key.id === payload.keyId);
  const state = (status: ProviderBalanceItem['status'], message: string): ProviderBalanceResult => ({ ...base, items: selected.map(key => ({ keyId: key.id, keyLabel: key.label, status, entries: [], message })), message });
  if (!provider.enabled || adapter === 'disabled') return state('disabled', '此供应商或余额查询已停用');
  if (!provider.baseUrl && !(adapter === 'custom' && ['token', 'none'].includes(provider.balanceQuery?.auth || ''))) return state('unconfigured', '请先填写供应商接口地址');
  try { validateBalanceQuery(provider.balanceQuery, provider.baseUrl); } catch { return state('unconfigured', '余额查询配置无效，请在供应商设置中修正'); }
  if (adapter === 'auto') return state('unsupported', '该服务没有已验证的通用余额接口，可在控制台查看或配置自定义查询');
  if (!selected.length) return state('unconfigured', '没有可查询的已启用密钥');
  const items = await Promise.all(selected.map(target => !target.secret && !(adapter === 'custom' && provider.balanceQuery?.auth === 'none')
    ? Promise.resolve({ keyId: target.id, keyLabel: target.label, status: 'unconfigured' as const, entries: [], message: '请先填写此密钥或独立查询令牌' })
    : queryOne(store, provider, target, adapter, payload.force === true, transport)));
  return { ...base, items };
}
