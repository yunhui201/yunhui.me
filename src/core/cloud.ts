import https from 'node:https';
import http from 'node:http';
import { isValidContextWindow } from './modelContext.js';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import type { AuroraStore, Provider, ProviderModel } from './store/index.js';
import { newId, nowIso } from './util.js';
import { GITHUB_RELEASE_API, GITHUB_RELEASE_PAGE, OFFICIAL_SITE_ORIGIN, OFFICIAL_UPDATE_URL, RELEASE_REPOSITORY } from './releaseSources.js';

/**
 * 云端目录 + 更新检查 + 官方账号导入。
 * 这里所有网络请求都用原生 http(s)，不引第三方库。
 */

export interface CloudProvider {
  key: string;
  name: string;
  vendor?: string;
  format: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini';
  baseUrl: string;
  region?: string;
  color?: string;
  icon?: string;
  docs?: string;
  note?: string;
  tags?: string[];
  official?: boolean;
  customBaseUrl?: boolean;
  sort?: number;
  models?: ProviderModel[];
}

export interface CloudCatalog {
  version: number;
  updatedAt: string;
  providers: CloudProvider[];
  source?: 'remote' | 'cache';
  fetchedAt?: string;
  warning?: string;
}

function webUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error(`${label}格式不正确`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${label}格式不正确`); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error(`${label}仅支持不含密码的 HTTP / HTTPS 地址`);
  }
  return url.href.replace(/\/$/, '');
}

function getJson<T = any>(urlStr: string, timeoutMs = 12000, headers: Record<string, string> = {}, redirects = 0, deadline = Date.now() + timeoutMs): Promise<T> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(webUrl(urlStr, '远端地址'));
    } catch {
      return reject(new Error('远端地址格式不正确，仅支持 HTTP / HTTPS'));
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new Error('请求超时'));
    const lib = u.protocol === 'https:' ? https : http;
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, value?: T) => {
      if (settled) return; settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (error) reject(error); else resolve(value as T);
    };
    const req = lib.get(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { accept: 'application/json', 'user-agent': 'yunhui/0.1', ...headers },
        timeout: remaining,
      },
      (res) => {
        res.on('error', error => finish(error));
        res.on('aborted', () => finish(new Error('远端响应中断')));
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
          res.resume();
          try {
            const next = new URL(res.headers.location, u);
            if (redirects >= 3 || (u.protocol === 'https:' && next.protocol !== 'https:')) throw new Error('远端重定向次数过多或降级到不安全连接');
            getJson<T>(next.href, timeoutMs, {}, redirects + 1, deadline).then(value => finish(undefined, value), error => finish(error));
          } catch { finish(new Error('远端重定向地址无效、次数过多或连接不安全')); }
          return;
        }
        let buf = '';
        let size = 0;
        res.setEncoding('utf8');
        res.on('data', (c) => {
          size += Buffer.byteLength(c);
          if (size > 8 * 1024 * 1024) {
            res.destroy(new Error('远端目录超过 8MB 限制'));
            return;
          }
          buf += c;
        });
        res.on('end', () => {
          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
            return finish(new Error(`目录服务返回 HTTP ${res.statusCode}`));
          }
          try {
            finish(undefined, JSON.parse(buf) as T);
          } catch {
            finish(new Error('远端返回的不是有效 JSON'));
          }
        });
      },
    );
    // Socket inactivity alone cannot bound a peer that keeps sending tiny chunks.
    deadlineTimer = setTimeout(() => { req.destroy(new Error('请求超时')); finish(new Error('请求超时')); }, remaining);
    deadlineTimer.unref?.();
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', error => finish(error));
  });
}

/* ------------------------------ 云端目录 ------------------------------ */

export function validateCloudProvider(raw: unknown): CloudProvider {
  const p = raw as Record<string, any>;
  if (!p || typeof p !== 'object' || typeof p.key !== 'string' || !p.key.trim() || p.key.length > 160
      || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 160
      || !['openai-chat', 'openai-responses', 'anthropic', 'gemini'].includes(p.format)) {
    throw new Error('目录供应商的标识、名称或协议不正确');
  }
  if (p.models != null && (!Array.isArray(p.models) || p.models.length > 10000)) {
    throw new Error(`供应商「${p.name}」的模型列表不正确`);
  }
  const optionalText = (s: unknown, max = 1000) => typeof s === 'string' ? s.slice(0, max) : undefined;
  const number = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
  const seen = new Set<string>();
  const models = (p.models ?? []).map((m: any) => {
    if (!m || typeof m.id !== 'string' || !m.id.trim() || m.id.length > 512) {
      throw new Error(`供应商「${p.name}」存在无效模型名称`);
    }
    return {
      id: m.id.trim(), displayName: optionalText(m.displayName, 160), contextWindow: isValidContextWindow(m.contextWindow) ? m.contextWindow : undefined, maxOutput: number(m.maxOutput), inputPrice: number(m.inputPrice), outputPrice: number(m.outputPrice), cacheReadPrice: number(m.cacheReadPrice), cacheWritePrice: number(m.cacheWritePrice),
      capabilities: {
        tools: typeof m.capabilities?.tools === 'boolean' ? m.capabilities.tools : undefined,
        vision: typeof m.capabilities?.vision === 'boolean' ? m.capabilities.vision : undefined,
        thinking: typeof m.capabilities?.thinking === 'boolean' ? m.capabilities.thinking : undefined,
      },
    };
  }).filter((m: { id: string }) => !seen.has(m.id) && !!seen.add(m.id));
  const customBaseUrl = p.customBaseUrl === true;
  const baseUrl = customBaseUrl && p.baseUrl === '' ? '' : webUrl(p.baseUrl, `供应商「${p.name}」地址`);
  // Clear only the known placeholders shipped in older bundled/remote templates.
  const legacyPlaceholder = customBaseUrl && baseUrl && (new URL(baseUrl).hostname === 'api.example.com'
    || baseUrl === 'https://{resource}.openai.azure.com/openai/deployments/%7Bdeployment%7D');
  return {
    key: p.key.trim(), name: p.name.trim(), format: p.format, baseUrl: legacyPlaceholder ? '' : baseUrl, customBaseUrl,
    vendor: optionalText(p.vendor, 160), region: optionalText(p.region, 40),
    color: typeof p.color === 'string' && /^#[\da-f]{3,8}$/i.test(p.color) ? p.color : undefined,
    icon: optionalText(p.icon, 16), docs: p.docs ? webUrl(p.docs, '文档地址') : undefined,
    note: optionalText(p.note, 4000), tags: Array.isArray(p.tags) ? p.tags.filter((t: unknown) => typeof t === 'string').slice(0, 20) : [],
    official: p.official === true, sort: number(p.sort), models,
  };
}

export function validateCloudCatalog(data: any): CloudCatalog {
  if (!Array.isArray(data?.providers) || data.providers.length > 2000) throw new Error('目录格式不正确（providers 必须为数组且不超过 2000 家）');
  const providers = data.providers.map(validateCloudProvider);
  if (new Set(providers.map((p: CloudProvider) => p.key)).size !== providers.length) throw new Error('目录存在重复的供应商标识');
  return { version: Number.isSafeInteger(data.version) && data.version >= 0 ? data.version : 0,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '', providers };
}

export async function fetchCloudCatalog(url: string, store?: AuroraStore): Promise<CloudCatalog> {
  const endpoint = webUrl(url, '目录地址');
  const cacheName = `catalog-${createHash('sha256').update(endpoint).digest('hex').slice(0, 20)}.json`;
  try {
    const catalog = validateCloudCatalog(await getJson(endpoint));
    const result: CloudCatalog = { ...catalog, source: 'remote', fetchedAt: nowIso() };
    try { store?.writeExtra(cacheName, result); }
    catch { result.warning = '官方目录已更新，但本地缓存保存失败；本次可正常使用，重启后将重新获取。'; }
    return result;
  } catch (error) {
    const cached = store?.readExtra<CloudCatalog | null>(cacheName, null);
    if (cached) {
      try {
        return { ...validateCloudCatalog(cached), source: 'cache', fetchedAt: cached.fetchedAt,
          warning: '远端暂时不可用，显示上次成功同步的本地目录。' };
      } catch { /* invalid cache cannot become a trusted catalog */ }
    }
    throw error;
  }
}

/** 把云端条目转成本地供应商；已存在（按 presetId/name 匹配）就合并模型 */
export function importCloudProviders(
  store: AuroraStore,
  items: CloudProvider[],
): { added: number; merged: number; providers: Provider[] } {
  const existing = store.listProviders();
  let added = 0;
  let merged = 0;
  const touched: Provider[] = [];

  const validated = items.map(validateCloudProvider);
  for (const item of validated) {
    const hit = existing.find(
      (p) => p.presetId === item.key || (p.baseUrl.replace(/\/$/, '') === item.baseUrl && p.format === item.format),
    );
    const models = (item.models ?? []).map((m) => ({
      ...m,
    }));
    if (hit) {
      const map = new Map(hit.models.map((m) => [m.id, m]));
      for (const m of models) if (!map.has(m.id)) map.set(m.id, m);
      const next = store.saveProvider({
        ...hit,
        models: [...map.values()],
        baseUrl: hit.baseUrl || item.baseUrl,
        color: hit.color ?? item.color,
        icon: hit.icon ?? item.icon,
      });
      touched.push(next);
      merged++;
    } else {
      const created = store.saveProvider({
        name: item.name,
        presetId: item.key,
        format: item.format,
        baseUrl: item.baseUrl,
        apiKeys: [{ id: newId('key_', 6), label: '默认', key: '', enabled: true, weight: 1 }],
        models,
        enabled: true,
        priority: 10,
        color: item.color ?? '#6d8cff',
        icon: item.icon ?? '◆',
        notes: item.note,
        official: item.official,
        rateMultiplier: 1,
      });
      touched.push(created);
      existing.push(created);
      added++;
    }
  }
  return { added, merged, providers: touched };
}

/* ------------------------------ 更新 ------------------------------ */

export interface UpdateInfo {
  version: string;
  notes: string;
  mandatory: boolean;
  hasUpdate: boolean;
  url: string;
  publishedAt?: string;
  current: string;
  source: 'github' | 'website';
  fallbackUrl: string;
  releaseUrl: string;
  assetName?: string;
}

export type UpdatePlatform = 'win' | 'mac' | 'linux' | 'ios';
export type UpdateArch = 'x64' | 'arm64' | 'ia32';
export interface UpdateTarget { platform?: UpdatePlatform; arch?: UpdateArch }
export interface UpdateCheckOptions extends UpdateTarget { source?: 'website'; minimumVersion?: string }
type JsonRequest = (url: string) => Promise<any>;

function releaseVersion(value: unknown, stable = false): { text: string; core: number[]; pre: string[] } {
  if (typeof value !== 'string' || value.length > 100 || value.trim() !== value) throw new Error('版本号格式无效');
  const match = /^v?((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/.exec(value);
  if (!match || (stable && match[5])) throw new Error('更新源未提供有效的正式版本');
  const core = [match[2], match[3], match[4]].map(Number), pre = match[5]?.split('.') || [];
  if (core.some(n => !Number.isSafeInteger(n)) || pre.some(p => /^\d+$/.test(p) && (p.length > 1 && p.startsWith('0')))) throw new Error('版本号格式无效');
  return { text: match[1], core, pre };
}

export function compareReleaseVersions(a: string, b: string): number {
  const left = releaseVersion(a), right = releaseVersion(b);
  for (let i = 0; i < 3; i++) if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  if (!left.pre.length || !right.pre.length) return left.pre.length ? -1 : right.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i]; if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn !== yn) return xn ? -1 : 1;
    if (xn && x.length !== y.length) return x.length > y.length ? 1 : -1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function updateTarget(target: UpdateTarget): Required<UpdateTarget> {
  const platform = target.platform || ({ win32: 'win', darwin: 'mac', linux: 'linux' } as const)[process.platform as 'win32' | 'darwin' | 'linux'];
  const arch = target.arch || (platform === 'ios' ? 'arm64' : process.arch);
  if (!['win', 'mac', 'linux', 'ios'].includes(platform) || !['x64', 'arm64', 'ia32'].includes(arch) || (platform === 'ios' && arch !== 'arm64') || (platform === 'mac' && arch === 'ia32')) throw new Error('当前平台或处理器架构暂不支持客户端更新');
  return { platform, arch } as Required<UpdateTarget>;
}

function secureUpdateUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\\]/.test(value)) throw new Error('更新下载地址无效');
  let url: URL; try { url = new URL(value); } catch { throw new Error('更新下载地址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) throw new Error('更新下载地址必须使用 HTTPS 且不能含凭据');
  return url;
}

function githubReleasePage(value: unknown, tag: string): string {
  const url = secureUpdateUrl(value);
  if (url.hostname !== 'github.com' || url.search || decodeURIComponent(url.pathname) !== `/${RELEASE_REPOSITORY}/releases/tag/${tag}`) throw new Error('GitHub 发布页面不属于云汇仓库');
  return url.href;
}

/** Match only actual builder output; source archives, blockmaps and unsigned iOS ZIPs are not installers. */
function clientAssetRank(name: string, version: string, target: Required<UpdateTarget>): number {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = `(?:YunHuiAI|Aurora)-${escaped}-`;
  if (target.platform === 'win') {
    const m = new RegExp(`^${prefix}win-${target.arch}-(setup|portable)\\.exe$`, 'i').exec(name);
    return m ? (m[1].toLowerCase() === 'setup' ? 0 : 1) : -1;
  }
  if (target.platform === 'mac') {
    const m = new RegExp(`^${prefix}mac-(${target.arch}|universal)\\.(dmg|pkg)$`, 'i').exec(name);
    return m ? (m[1].toLowerCase() === 'universal' ? 2 : 0) + (m[2].toLowerCase() === 'pkg' ? 1 : 0) : -1;
  }
  if (target.platform === 'linux') return new RegExp(`^${prefix}linux-${target.arch}\\.AppImage$`, 'i').test(name) ? 0 : -1;
  return -1;
}

function githubAssetUrl(value: unknown, tag: string, name: string): string {
  const url = secureUpdateUrl(value);
  if (url.hostname !== 'github.com' || url.search || decodeURIComponent(url.pathname) !== `/${RELEASE_REPOSITORY}/releases/download/${tag}/${name}`) throw new Error('GitHub 安装包不属于此正式发布');
  return url.href;
}

function publishedAt(value: unknown): string | undefined { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined; }
function result(current: string, version: string, url: string, source: UpdateInfo['source'], notes: unknown, date: unknown, releaseUrl: string, assetName?: string, mandatory = false): UpdateInfo {
  const hasUpdate = compareReleaseVersions(version, current) > 0;
  return { current, version, notes: typeof notes === 'string' ? notes.slice(0, 50000) : '', mandatory: hasUpdate && mandatory, hasUpdate, url: hasUpdate ? url : '', source, fallbackUrl: source === 'website' && hasUpdate ? url : '', releaseUrl, assetName, publishedAt: publishedAt(date) };
}

export function githubUpdate(data: any, current: string, target: Required<UpdateTarget>): UpdateInfo {
  if (!data || data.draft !== false || data.prerelease !== false || !Array.isArray(data.assets) || data.assets.length > 1000) throw new Error('GitHub 未提供正式发布信息');
  const version = releaseVersion(data.tag_name, true).text, releaseUrl = githubReleasePage(data.html_url, data.tag_name);
  const candidates = data.assets.flatMap((asset: any) => {
    if (!asset || typeof asset.name !== 'string' || asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size <= 0) return [];
    const rank = clientAssetRank(asset.name, version, target); if (rank < 0) return [];
    try { return [{ rank, name: asset.name, url: githubAssetUrl(asset.browser_download_url, data.tag_name, asset.name) }]; } catch { return []; }
  }).sort((a: any, b: any) => a.rank - b.rank || a.name.localeCompare(b.name));
  if (!candidates.length) throw new Error('GitHub 正式发布暂未提供当前平台的客户端安装包');
  const selected = candidates[0]; return result(current, version, selected.url, 'github', data.body, data.published_at, releaseUrl, selected.name);
}

export function websiteUpdate(data: any, current: string, target: Required<UpdateTarget>): UpdateInfo {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.prerelease === true || data.draft === true) throw new Error('官网更新信息无效');
  if ((data.platform !== undefined && data.platform !== target.platform) || (data.arch !== undefined && data.arch !== target.arch)) throw new Error('官网安装包的平台或架构不匹配');
  if (data.version === '' && data.url === '' && data.hasUpdate === false) throw new Error('官网尚未发布可用版本');
  const version = releaseVersion(data.version, true).text;
  const url = secureUpdateUrl(data.url); let assetName: string | undefined;
  if (target.platform === 'ios') {
    if (!((url.hostname === 'apps.apple.com' && /\/id\d+(?:\/)?$/.test(url.pathname)) || (url.hostname === 'testflight.apple.com' && /^\/join\/[a-zA-Z0-9]+\/?$/.test(url.pathname)))) throw new Error('当前 iOS 客户端尚无 App Store 或 TestFlight 安装入口');
  } else {
    assetName = decodeURIComponent(url.pathname.split('/').at(-1) || '');
    if (clientAssetRank(assetName, version, target) < 0) throw new Error('官网未提供匹配版本及平台的客户端安装包');
    if (url.hostname === 'github.com') {
      const segments = decodeURIComponent(url.pathname).split('/'); const tag = segments.at(-2) || '';
      if (releaseVersion(tag, true).text !== version) throw new Error('官网安装包版本不匹配');
      githubAssetUrl(url.href, tag, assetName);
    } else if (url.origin !== OFFICIAL_SITE_ORIGIN || url.search || !url.pathname.startsWith('/releases/')) throw new Error('官网安装包地址不属于官方发布源');
  }
  return result(current, version, url.href, 'website', data.notes, data.publishedAt, GITHUB_RELEASE_PAGE, assetName, data.mandatory === true);
}

export async function checkUpdate(current: string, target: UpdateCheckOptions = {}, request: JsonRequest = getJson): Promise<UpdateInfo> {
  const normalized = releaseVersion(current).text, selected = updateTarget(target);
  if (target.source !== undefined && target.source !== 'website') throw new Error('未知更新来源');
  const minimum = target.minimumVersion === undefined ? undefined : releaseVersion(target.minimumVersion, true).text;
  if (target.source !== 'website') try { return githubUpdate(await request(GITHUB_RELEASE_API), normalized, selected); } catch { /* Network, rate limits, malformed metadata or missing platform assets use the official fallback. */ }
  const endpoint = new URL(OFFICIAL_UPDATE_URL); endpoint.searchParams.set('platform', selected.platform); endpoint.searchParams.set('arch', selected.arch); endpoint.searchParams.set('current', normalized);
  try {
    const info = websiteUpdate(await request(endpoint.href), normalized, selected);
    if (minimum && compareReleaseVersions(info.version, minimum) < 0) throw new Error(`官网备用包尚未同步到 ${minimum}，请使用 GitHub 下载或稍后重试`);
    if (target.source === 'website' && compareReleaseVersions(info.version, normalized) < 0) throw new Error('官网备用包版本低于当前客户端，已阻止下载');
    return info;
  } catch (error) { throw new Error(`${target.source === 'website' ? '官网备用检查未完成' : 'GitHub 暂不可用或缺少匹配安装包；官网备用检查未完成'}：${(error as Error).message}`); }
}
