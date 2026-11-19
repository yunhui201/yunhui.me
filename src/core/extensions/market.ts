import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import type { AuroraStore } from '../store/index.js';
import { applyPlan, patchToml, planned, readText } from '../agents/configFiles.js';
import { openUpstream } from '../gateway/upstream.js';

export type MarketSource = 'public' | 'full';
export interface MarketEntry { id: string; name: string; displayName: string; description: string; version: string; author: string; tags: string[]; license: string; path: string; tree: string; bytes: number; skills: number; requiresAuth: boolean; catalogMissing?: boolean }
export interface MarketIndex { schemaVersion: number; repository: string; revision: string; updatedAt: string; plugins: MarketEntry[]; fetchedAt?: string; remoteBlobSha?: string; cacheContentSha256?: string }
export interface MarketRefreshResult { source: MarketSource; ok: boolean; sourceType: 'remote' | 'cache' | 'builtin'; message: string; count: number; fetchedAt?: string }
export interface NativeInstall { source: MarketSource; id: string; name: string; version: string; tree: string; revision: string; enabled: boolean; installedAt: string; license: string }
export const REPOSITORIES = { public: 'BigPizzaV3/CodexPlusPlusPluginCache', full: 'BigPizzaV3/CodexPlusPlusFullPluginCache' };
export function resourceRoot(): string {
  const resourcePath = (process as any).resourcesPath;
  const roots = [process.env.AURORA_EXTENSION_ASSETS, resourcePath && path.join(resourcePath, 'codexplusplus'), path.join(process.cwd(), 'third_party', 'codexplusplus')].filter(Boolean) as string[];
  const root = roots.find(p => fs.existsSync(path.join(p, 'UPSTREAM.json'))); if (!root) throw new Error('未找到桌面扩展资源，请重新安装云汇'); return root;
}
export function safeRelative(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\\x00-\x1f:*?"<>|]/.test(value) || value.startsWith('/') || value.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s) || s.toLowerCase() === '.git')) throw new Error('插件包含不安全的文件路径');
  if (value.split('/').some(s => /^\.env(?:\.|$)/i.test(s) && !/\.(?:example|sample|template)$/i.test(s))) throw new Error('插件包不能包含环境密钥文件');
  return value;
}
export function validateIndex(value: any, source: MarketSource): MarketIndex {
  if (!value || value.schemaVersion !== 1 || value.repository !== REPOSITORIES[source] || !/^[a-f0-9]{40}$/.test(value.revision) || !Array.isArray(value.plugins) || value.plugins.length > 20_000) throw new Error('插件目录格式或来源无效');
  const ids = new Set<string>();
  for (const p of value.plugins) {
    if (!p || typeof p.id !== 'string' || !/^[a-zA-Z0-9._~-]{1,150}$/.test(p.id) || ids.has(p.id) || !/^[a-zA-Z0-9._-]{1,150}$/.test(p.name) || !/^[a-zA-Z0-9._+-]{1,150}$/.test(p.version) || !/^[a-f0-9]{40}$/.test(p.tree)) throw new Error('插件目录包含无效或重复项目');
    safeRelative(p.name); safeRelative(p.version); safeRelative(p.path); ids.add(p.id);
  }
  return value;
}
class MarketDownloadError extends Error {}
function marketError(error: unknown): string {
  if (error instanceof MarketDownloadError) return error.message;
  if (/timeout|timed out|abort|cancel/i.test(String((error as Error)?.message) + String((error as Error)?.name))) return '连接插件市场超时，请检查网络或在系统设置中配置 HTTP(S) 代理后重试';
  return '无法连接插件市场，请检查网络或系统设置中的 HTTP(S) 代理后重试';
}
async function download(store: AuroraStore, url: string, max: number, options: { signal?: AbortSignal; accept?: string; timeoutMs?: number } = {}): Promise<Buffer> {
  const u = new URL(url); if (u.protocol !== 'https:' || u.username || u.password || !['raw.githubusercontent.com', 'api.github.com'].includes(u.hostname)) throw new MarketDownloadError('插件来源必须是配置的 GitHub 公开仓库');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45000);
  const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const headers = { 'User-Agent': 'YunHui-Desktop-Extensions', Accept: options.accept || 'application/vnd.github+json' };
  let dispose: (() => void) | undefined;
  try {
    const proxy = store.getSettings().proxy;
    let status: number, length: string | undefined | null, body: AsyncIterable<Uint8Array> | null;
    if (proxy) {
      // Explicit proxy settings must also cover CONNECT, response streaming and cancellation.
      const response = await openUpstream(url, { method: 'GET', proxy, headers, signal: controller.signal, timeoutMs: options.timeoutMs ?? 45000 });
      status = response.status; length = response.headers['content-length']; body = response.raw;
      dispose = () => response.raw.destroy();
    } else {
      const response = await fetch(u, { signal: controller.signal, redirect: 'error', headers });
      status = response.status; length = response.headers.get('content-length'); body = response.body as unknown as AsyncIterable<Uint8Array> | null;
      dispose = () => { void response.body?.cancel().catch(() => {}); };
    }
    if (status < 200 || status >= 300) throw new MarketDownloadError(`插件下载失败：HTTP ${status}${[403, 429].includes(status) ? '，GitHub 公开 API 可能达到速率限制，请稍后重试' : status === 407 ? '，请检查代理认证设置' : ''}`);
    if (Number(length) > max) throw new MarketDownloadError('插件文件超过大小限制');
    if (!body) throw new MarketDownloadError('插件下载为空');
    const chunks: Buffer[] = []; let total = 0;
    for await (const chunk of body) { total += chunk.length; if (total > max) throw new MarketDownloadError('插件文件超过大小限制'); chunks.push(Buffer.from(chunk)); }
    return Buffer.concat(chunks);
  } catch (error) { throw new MarketDownloadError(marketError(error)); }
  finally { dispose?.(); clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
}
function cacheContentHash(index: MarketIndex): string {
  const { fetchedAt, remoteBlobSha, cacheContentSha256, ...content } = index;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
type LocalIndex = { index: MarketIndex; sourceType: 'cache' | 'builtin'; blobSha: string };
const localIndexes = new Map<string, { cacheStamp: string; builtinFile?: string; builtinStamp?: string; value: LocalIndex }>();
function indexCacheKey(store: AuroraStore, source: MarketSource): string { return JSON.stringify([path.resolve(store.dir), source]); }
function fileStamp(file: string): string {
  try { const stat = fs.statSync(file); return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
  catch { return 'unavailable'; }
}
function rememberIndex(key: string, entry: { cacheStamp: string; builtinFile?: string; builtinStamp?: string; value: LocalIndex }): LocalIndex {
  // These shared values are read-only. Installation and configuration state are still read afresh.
  for (const plugin of entry.value.index.plugins) { if (Array.isArray(plugin.tags)) Object.freeze(plugin.tags); Object.freeze(plugin); }
  Object.freeze(entry.value.index.plugins); Object.freeze(entry.value.index);
  localIndexes.delete(key); localIndexes.set(key, entry);
  if (localIndexes.size > 32) localIndexes.delete(localIndexes.keys().next().value!);
  return entry.value;
}
function localIndex(store: AuroraStore, source: MarketSource): LocalIndex {
  if (!Object.hasOwn(REPOSITORIES, source)) throw new Error('未知插件市场');
  const file = path.join(store.dir, `extension-catalog-${source}.json`), stamp = fileStamp(file), key = indexCacheKey(store, source);
  const previous = localIndexes.get(key);
  if (previous?.cacheStamp === stamp && previous.value.sourceType === 'cache') return previous.value;
  let builtinFile: string | undefined, builtinStamp: string | undefined;
  if (previous?.cacheStamp === stamp && previous.value.sourceType === 'builtin') {
    builtinFile = path.join(resourceRoot(), 'catalog', `${source}.json`); builtinStamp = fileStamp(builtinFile);
    if (previous.builtinFile === builtinFile && previous.builtinStamp === builtinStamp) return previous.value;
  }
  let cached: any, cachedBytes: Buffer | undefined;
  try { cachedBytes = fs.readFileSync(file); cached = JSON.parse(cachedBytes.toString('utf8')); } catch { /* Use the packaged snapshot. */ }
  if (cached) try {
    const index = validateIndex(cached, source);
    const blobSha = /^[a-f0-9]{40}$/.test(index.remoteBlobSha || '') && index.cacheContentSha256 === cacheContentHash(index)
      ? index.remoteBlobSha! : gitBlobHash(cachedBytes!);
    return rememberIndex(key, { cacheStamp: stamp, value: { index, sourceType: 'cache', blobSha } });
  } catch { /* Packaged snapshot remains available. */ }
  builtinFile ??= path.join(resourceRoot(), 'catalog', `${source}.json`); builtinStamp ??= fileStamp(builtinFile);
  const bytes = fs.readFileSync(builtinFile);
  const value: LocalIndex = { index: validateIndex(JSON.parse(bytes.toString('utf8')), source), sourceType: 'builtin', blobSha: gitBlobHash(bytes) };
  // A transient read failure must not hide a still-existing cache until its contents change.
  if (stamp !== 'unavailable' && !cachedBytes) return value;
  return rememberIndex(key, { cacheStamp: stamp, builtinFile, builtinStamp, value });
}
export function loadIndex(store: AuroraStore, source: MarketSource): MarketIndex { return localIndex(store, source).index; }
const refreshJobs = new Map<string, Promise<MarketIndex>>();
const INDEX_LIMIT = 24 * 1024 * 1024;
// A changed full catalog can exceed 4 MB. Bound the complete operation, including the body.
const REFRESH_TIMEOUT_MS = 120000;
function parseIndex(bytes: Buffer, source: MarketSource): MarketIndex {
  try { return { ...validateIndex(JSON.parse(bytes.toString('utf8')), source), remoteBlobSha: gitBlobHash(bytes) }; }
  catch { throw new MarketDownloadError('远端插件目录格式或来源校验失败，已保留本地目录'); }
}
async function fetchIndex(store: AuroraStore, source: MarketSource): Promise<MarketIndex> {
  const previous = localIndex(store, source), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  const options = { signal: controller.signal, timeoutMs: REFRESH_TIMEOUT_MS };
  let startAlternate!: () => void;
  const alternateReady = new Promise<void>(resolve => { startAlternate = resolve; });
  const alternateTimer = setTimeout(startAlternate, 1000);
  // Begin with raw; a blocked raw host must not delay the independent GitHub API route.
  const primary = download(store, `https://raw.githubusercontent.com/${REPOSITORIES[source]}/main/plugin-index.json`, INDEX_LIMIT, { ...options, timeoutMs: 8000 })
    .then(bytes => parseIndex(bytes, source)).catch(error => { startAlternate(); throw error; });
  const alternate = (async () => {
    await alternateReady;
    if (controller.signal.aborted) throw new MarketDownloadError('插件同步请求已取消');
    const url = `https://api.github.com/repos/${REPOSITORIES[source]}/contents/plugin-index.json?ref=main`;
    // GitHub embeds base64 content for files below 1 MB, so JSON can exceed 1 MB.
    const bytes = await download(store, url, 2 * 1024 * 1024, options);
    let metadata: { type: string; path: string; sha: string; size: number; encoding?: string; content?: string };
    try { metadata = JSON.parse(bytes.toString('utf8')); } catch { throw new MarketDownloadError('GitHub 插件目录元数据格式无效'); }
    if (!metadata || metadata.type !== 'file' || metadata.path !== 'plugin-index.json' || !/^[a-f0-9]{40}$/.test(metadata.sha) || !Number.isSafeInteger(metadata.size) || metadata.size < 1) throw new MarketDownloadError('GitHub 插件目录元数据无效');
    if (metadata.size > INDEX_LIMIT) throw new MarketDownloadError('插件文件超过大小限制');
    // The digest belongs to bytes previously validated locally, never an arbitrary download_url.
    if (metadata.sha === previous.blobSha) return { ...previous.index, remoteBlobSha: metadata.sha };
    const data = metadata.encoding === 'base64' && typeof metadata.content === 'string' && metadata.size <= 1024 * 1024
      ? Buffer.from(metadata.content, 'base64')
      : await download(store, url, INDEX_LIMIT, { ...options, accept: 'application/vnd.github.raw+json' });
    if (data.length !== metadata.size || gitBlobHash(data) !== metadata.sha) throw new MarketDownloadError('远端插件目录文件校验失败，请稍后重试');
    return parseIndex(data, source);
  })();
  let index: MarketIndex;
  try { index = await Promise.any([primary, alternate]); }
  catch (error) {
    const messages = error instanceof AggregateError ? [...new Set(error.errors.map(marketError))] : [marketError(error)];
    throw new MarketDownloadError(messages.join('；'));
  } finally { clearTimeout(timer); clearTimeout(alternateTimer); controller.abort(); startAlternate(); }
  index = { ...index, fetchedAt: new Date().toISOString(), cacheContentSha256: cacheContentHash(index) };
  // Persistence is outside the network attempts: a failed write must not trigger another download.
  try { store.writeExtra(`extension-catalog-${source}.json`, index); localIndexes.delete(indexCacheKey(store, source)); }
  catch { throw new MarketDownloadError('已连接远端，但无法保存插件目录，请检查本地磁盘空间和目录权限后重试'); }
  return index;
}
export function refreshIndex(store: AuroraStore, source: MarketSource): Promise<MarketIndex> {
  if (!Object.hasOwn(REPOSITORIES, source)) return Promise.reject(new Error('未知插件市场'));
  const key = `${path.resolve(store.dir)}:${source}`, pending = refreshJobs.get(key); if (pending) return pending;
  const job = fetchIndex(store, source).finally(() => refreshJobs.delete(key)); refreshJobs.set(key, job); return job;
}
export async function refreshMarkets(store: AuroraStore, sources: MarketSource[]): Promise<{ ok: boolean; message: string; warning?: string; results: MarketRefreshResult[] }> {
  if (!sources.length || sources.some(source => !Object.hasOwn(REPOSITORIES, source))) throw new Error('未知插件市场');
  const results = await Promise.all([...new Set(sources)].map(async (source): Promise<MarketRefreshResult> => {
    try {
      const index = await refreshIndex(store, source);
      return { source, ok: true, sourceType: 'remote', count: index.plugins.length, fetchedAt: index.fetchedAt, message: '已与远端核对，当前目录为最新版本' };
    } catch (error) {
      const local = localIndex(store, source);
      return { source, ok: false, sourceType: local.sourceType, count: local.index.plugins.length, fetchedAt: local.index.fetchedAt,
        message: `${marketError(error)}；继续使用${local.sourceType === 'cache' ? '本地缓存' : '随附离线目录'}` };
    }
  }));
  const ok = results.every(result => result.ok), some = results.some(result => result.ok);
  return { ok, message: ok ? '插件市场索引已同步' : some ? '部分市场索引已更新，其余继续使用本地目录' : '插件市场暂未更新，继续使用本地目录',
    ...(ok ? {} : { warning: '请查看各市场结果；检查网络或代理后可重试同步。' }), results };
}
export function gitBlobHash(data: Buffer): string { return createHash('sha1').update(Buffer.from(`blob ${data.length}\0`)).update(data).digest('hex'); }
export interface GitEntry { path: string; mode: string; type: string; sha: string; size?: number }
export function verifyTree(entries: GitEntry[], expected: string): GitEntry[] {
  const seen = new Set<string>(); let total = 0;
  if (entries.length > 5000) throw new Error('插件文件过多');
  for (const e of entries) {
    safeRelative(e.path); const fold = e.path.toLowerCase(); if (seen.has(fold)) throw new Error('插件路径存在大小写冲突'); seen.add(fold);
    if (!/^[a-f0-9]{40}$/.test(e.sha) || !((e.type === 'blob' && ['100644', '100755'].includes(e.mode)) || (e.type === 'tree' && e.mode === '040000'))) throw new Error('插件包含符号链接、子模块或未知文件类型');
    if (e.type === 'blob') { if (!Number.isSafeInteger(e.size) || e.size! < 0 || e.size! > 16 * 1024 * 1024) throw new Error('插件文件大小无效'); total += e.size!; }
  }
  if (total > 64 * 1024 * 1024) throw new Error('插件包超过 64 MB 限制');
  function treeHash(prefix: string): string {
    const children = entries.filter(e => path.posix.dirname(e.path) === (prefix || '.')).sort((a, b) => Buffer.compare(Buffer.from(path.posix.basename(a.path) + (a.type === 'tree' ? '/' : '')), Buffer.from(path.posix.basename(b.path) + (b.type === 'tree' ? '/' : ''))));
    const records = children.map(e => { const sha = e.type === 'tree' ? treeHash(e.path) : e.sha; if (sha !== e.sha) throw new Error('插件目录校验失败'); return Buffer.concat([Buffer.from(`${e.type === 'tree' ? '40000' : e.mode} ${path.posix.basename(e.path)}\0`), Buffer.from(sha, 'hex')]); });
    const data = Buffer.concat(records); return createHash('sha1').update(Buffer.from(`tree ${data.length}\0`)).update(data).digest('hex');
  }
  for (const e of entries) { const parent = path.posix.dirname(e.path); if (parent !== '.' && !entries.some(p => p.type === 'tree' && p.path === parent)) throw new Error('插件目录缺少父节点'); }
  if (treeHash('') !== expected) throw new Error('插件目录哈希与索引不一致'); return entries.filter(e => e.type === 'blob');
}
function codexHome(): string { return process.env.AURORA_CLIENT_HOME ? path.join(process.env.AURORA_CLIENT_HOME, '.codex') : process.env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
export function marketName(source: MarketSource, id: string): string { return `aurora-plugin-${createHash('sha256').update(`${source}:${id}`).digest('hex').slice(0, 16)}`; }
function marketRoot(store: AuroraStore, source: MarketSource, id: string): string { return path.join(store.dir, 'extensions', 'native', marketName(source, id)); }
export function packageRoot(store: AuroraStore, p: NativeInstall): string { return path.join(marketRoot(store, p.source, p.id), 'packages', p.name, p.version); }
/** Presence is separate from installation records; content integrity is rechecked during install. */
export function packagePresent(store: AuroraStore, p: NativeInstall): boolean {
  try {
    const root = packageRoot(store, p);
    const dir = fs.lstatSync(root); if (!dir.isDirectory() || dir.isSymbolicLink()) return false;
    return ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json'].some(relative => {
      const file = path.join(root, relative); if (!fs.existsSync(file)) return false;
      const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return false;
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')); return manifest.name === p.name && String(manifest.version) === p.version;
    });
  } catch { return false; }
}
export function installedPlugins(store: AuroraStore): Record<string, NativeInstall> {
  const file=path.join(store.dir,'extension-native.json');
  let value:Record<string,NativeInstall>;
  try{value=fs.existsSync(file)?JSON.parse(readText(file)):{};}catch{throw new Error('本地插件安装记录无法读取，已停止修改；请检查 extension-native.json');}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('本地插件安装记录无效，请检查 extension-native.json');
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || !Object.hasOwn(REPOSITORIES, entry.source) || key !== nativeKey(entry.source, entry.id) || !/^[a-zA-Z0-9._~-]{1,150}$/.test(entry.id) || !/^[a-f0-9]{40}$/.test(entry.tree) || !/^[a-f0-9]{40}$/.test(entry.revision) || typeof entry.enabled!=='boolean') throw new Error('本地插件安装记录无效，请检查 extension-native.json');
    safeRelative(entry.name); safeRelative(entry.version);
    if (entry.name.includes('/') || entry.version.includes('/')) throw new Error('本地插件安装路径无效');
  }
  return value;
}
export function nativeKey(source: MarketSource, id: string): string { return `${source}:${id}`; }
function patchRegistration(store: AuroraStore, entry: NativeInstall, enabled: boolean, remove = false, marketManifest?: unknown): void {
  const market = marketName(entry.source, entry.id); const file = path.join(codexHome(), 'config.toml');
  const all = installedPlugins(store), key = nativeKey(entry.source, entry.id), previous = all[key];
  const plan = planned(file, '');
  let config = plan.before; config = patchToml(config, `marketplaces.${market}`, { source_type: remove ? null : 'local', source: remove ? null : marketRoot(store, entry.source, entry.id) });
  if (previous && previous.name !== entry.name) config = patchToml(config, `plugins.${JSON.stringify(`${previous.name}@${market}`)}`, { enabled: null });
  config = patchToml(config, `plugins.${JSON.stringify(`${entry.name}@${market}`)}`, { enabled: remove ? null : enabled });
  plan.after = config;
  const files = [plan];
  if (marketManifest) files.push(planned(path.join(marketRoot(store, entry.source, entry.id), '.agents', 'plugins', 'marketplace.json'), JSON.stringify(marketManifest, null, 2)));
  if (remove) delete all[key]; else all[key] = { ...entry, enabled };
  files.push(planned(path.join(store.dir, 'extension-native.json'), JSON.stringify(all, null, 2)));
  applyPlan(`plugin-${market}`, files);
}
const installJobs = new Map<string, Promise<NativeInstall>>();
const installFailures = new Map<string, string>();
const jobKey = (store: AuroraStore, source: MarketSource, id: string) => `${store.dir}:${source}:${id}`;
export function installNative(store: AuroraStore, source: MarketSource, id: string): Promise<NativeInstall> {
  const key = jobKey(store, source, id); const existing = installJobs.get(key); if (existing) return existing;
  installFailures.delete(key);
  const job = doInstallNative(store, source, id).catch(error => { installFailures.set(key, (error as Error).message); throw error; }).finally(() => installJobs.delete(key));
  installJobs.set(key, job); return job;
}
export function nativeInstallStatus(store: AuroraStore, source: MarketSource, id: string): any {
  const key = jobKey(store, source, id),busy = installJobs.has(key),record = installedPlugins(store)[nativeKey(source,id)];
  const failure = installFailures.get(key);
  const present = !!record && packagePresent(store, record);
  return { status: failure || (!busy && !present) ? 'failed' : 'ok', source, id, busy, stage: busy ? 'downloading' : failure || !present ? 'failed' : 'complete', message: failure || (record ? present ? '插件已安装，可在云汇启用后重启客户端' : '插件文件缺失或清单无效，请重新安装' : '没有安装记录'), installedVersion: record?.version,
    plugin: record ? { ...record, installed: true, installedVersion: record.version } : undefined, nativeResult: record ? { appsNeedingAuth: [], authPolicy: 'ON_USE' } : undefined, restartRequired: true };
}
async function doInstallNative(store: AuroraStore, source: MarketSource, id: string): Promise<NativeInstall> {
  const index = loadIndex(store, source); const p = index.plugins.find(x => x.id === id); if (!p) throw new Error('目录中没有此插件');
  const current = installedPlugins(store); const key = nativeKey(source, id);
  const tree = JSON.parse((await download(store, `https://api.github.com/repos/${index.repository}/git/trees/${p.tree}?recursive=1`, 8 * 1024 * 1024)).toString('utf8'));
  if (tree.truncated || tree.sha !== p.tree || !Array.isArray(tree.tree)) throw new Error('GitHub 返回了不完整的插件树');
  const files = verifyTree(tree.tree, p.tree);
  const root = marketRoot(store, source, id); fs.mkdirSync(root, { recursive: true });
  const temp = path.join(root, `.download-${randomBytes(6).toString('hex')}`); fs.mkdirSync(temp);
  const record: NativeInstall = { source, id, name: p.name, version: p.version, tree: p.tree, revision: index.revision, enabled: current[key]?.enabled || false, installedAt: new Date().toISOString(), license: p.license || '未声明许可' };
  let cursor = 0;
  try {
    const downloads = await Promise.allSettled(Array.from({ length: Math.min(8, files.length) }, async () => {
      while (cursor < files.length) { const e = files[cursor++]; const suffix = `${p.path}/${e.path}`.split('/').map(encodeURIComponent).join('/'); const data = await download(store, `https://raw.githubusercontent.com/${index.repository}/${index.revision}/${suffix}`, 16 * 1024 * 1024);
        if (data.length !== e.size || gitBlobHash(data) !== e.sha) throw new Error(`插件文件校验失败：${e.path}`);
        const destination = path.join(temp, ...e.path.split('/')); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, data, { mode: e.mode === '100755' ? 0o700 : 0o600, flag: 'wx' });
      }
    }));
    const failure = downloads.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
    const manifestFile = ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json'].map(f => path.join(temp, f)).find(f => fs.existsSync(f));
    if (!manifestFile) throw new Error('插件没有有效的清单文件'); const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.name !== p.name || String(manifest.version) !== p.version) throw new Error('插件清单名称或版本与目录不一致');
    const dest = packageRoot(store, record); fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      if (fs.lstatSync(dest).isSymbolicLink() || !fs.lstatSync(dest).isDirectory()) throw new Error('插件缓存不是普通目录');
      const actual: string[] = [];
      const walk = (dir: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isSymbolicLink()) throw new Error('缓存包含符号链接'); if (e.isDirectory()) walk(f); else if (e.isFile()) actual.push(path.relative(dest, f).replace(/\\/g, '/')); else throw new Error('缓存包含未知文件类型'); } };
      walk(dest);
      if (actual.length !== files.length || files.some(e => !actual.includes(e.path) || gitBlobHash(fs.readFileSync(path.join(dest, ...e.path.split('/')))) !== e.sha)) throw new Error('同版本插件缓存与目录校验不一致，请手动检查缓存目录');
    } else fs.renameSync(temp, dest);
    const marketManifest = { name: marketName(source, id), interface: { displayName: `云汇插件 · ${p.displayName || p.name}` }, plugins: [{ name: p.name, source: { source: 'local', path: dest }, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' }] };
    patchRegistration(store, record, record.enabled, false, marketManifest); return record;
  } finally {
    // Only remove this operation's random staging directory, never client packages or user files.
    const resolved = path.resolve(temp); if (resolved.startsWith(path.resolve(root) + path.sep) && path.basename(resolved).startsWith('.download-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
}
export function toggleNative(store: AuroraStore, source: MarketSource, id: string, enabled: boolean): NativeInstall {
  if (installJobs.has(jobKey(store, source, id))) throw new Error('插件正在安装，请等待完成');
  const all = installedPlugins(store); const record = all[nativeKey(source, id)]; if (!record) throw new Error('请先安装此插件');
  if (enabled && !packagePresent(store, record)) throw new Error('插件文件已丢失或清单无效，请重新安装');
  patchRegistration(store, record, enabled); return { ...record, enabled };
}
export function removeNative(store: AuroraStore, source: MarketSource, id: string): void {
  if (installJobs.has(jobKey(store, source, id))) throw new Error('插件正在安装，请等待完成');
  const all = installedPlugins(store); const key = nativeKey(source, id); const record = all[key]; if (!record) return;
  patchRegistration(store, record, false, true);
  // Retain downloaded source and its licenses for audit/recovery; no arbitrary package hooks execute.
}
export function nativeAliases(index: MarketIndex): Map<string, string> {
  const counts = new Map<string, number>(); for (const p of index.plugins) counts.set(p.name, (counts.get(p.name) || 0) + 1);
  return new Map(index.plugins.map(p => [p.id, counts.get(p.name)! > 1 ? `${p.name}-${createHash('sha256').update(p.id).digest('hex').slice(0, 10)}` : p.name]));
}
/** An upstream delisting must not hide a user's existing local installation. */
export function managedIndex(store: AuroraStore, source: MarketSource, index = loadIndex(store, source)): MarketIndex {
  const ids = new Set(index.plugins.map(p => p.id));
  const retained = Object.values(installedPlugins(store)).filter(p => p.source === source && !ids.has(p.id)).map(p => ({ id: p.id, name: p.name, displayName: p.name, description: '此插件已从当前目录下架，保留本地安装管理', version: p.version, author: '', tags: [], license: p.license, path: '', tree: p.tree, bytes: 0, skills: 0, requiresAuth: false, catalogMissing: true }));
  return { ...index, plugins: [...index.plugins, ...retained] };
}
export function nativeSummary(store: AuroraStore, source: MarketSource, p: MarketEntry, index?: MarketIndex, installs?: Record<string, NativeInstall>, alias?: string): any {
  const record = (installs || installedPlugins(store))[nativeKey(source, p.id)];
  return { id: `${p.name}@${marketName(source, p.id)}`, name: alias || p.name, codexPlusIndexId: p.id, source: p.catalogMissing && record ? { type: 'local', path: packageRoot(store, record) } : { type: 'git', url: `https://github.com/${REPOSITORIES[source]}.git`, path: p.path, sha: (index || loadIndex(store, source)).revision }, installed: !!record, enabled: record?.enabled || false, catalogMissing: p.catalogMissing === true,
    version: p.version, localVersion: record?.version || null, installedVersion: record?.version || null, updateAvailable: !p.catalogMissing && !!record && record.tree !== p.tree, authPolicy: 'ON_USE', installPolicy: 'AVAILABLE', availability: 'AVAILABLE', disabledReason: record && !packagePresent(store, record) ? '本地插件文件已丢失，请在云汇管理安装' : p.catalogMissing ? '目录已下架；请在云汇管理本地启停和移除' : null, keywords: p.tags || [], mustShowInstallationInterstitial: false,
    interface: { displayName: p.displayName || p.name, shortDescription: p.description, longDescription: p.description, developerName: p.author, category: 'Productivity', capabilities: [], screenshots: [], logo: null, logoDark: null, composerIcon: null } };
}
export async function nativeRequest(store: AuroraStore, payload: any): Promise<any> {
  const method = String(payload.method || ''); const params = payload.params || {};
  const source: MarketSource = payload.source === 'public' || /virtual-public|index-public/.test(String(params.marketplacePath || params.localMarketplaceName || '')) ? 'public' : 'full';
  if (['plugin/list', 'list-plugins', 'search-plugins', 'installed-plugins', 'plugin/installed'].includes(method)) {
    const installedOnly = /installed/.test(method); const query = String(params.query || '').toLowerCase();
    const index = managedIndex(store, source); const all = installedPlugins(store), aliases = nativeAliases(index);
    const plugins = index.plugins.filter(p => (!query || `${p.name} ${p.displayName} ${p.description}`.toLowerCase().includes(query)) && (!installedOnly || all[nativeKey(source, p.id)])).map(p => nativeSummary(store, source, p, index, all, aliases.get(p.id)));
    return { marketplaces: [{ name: `codex-plus-index-${source}`, path: path.join(store.dir, 'codex-plus-plugin-market', `virtual-${source}`, '.agents', 'plugins', 'marketplace.json'), interface: { displayName: `云汇插件 · ${source === 'full' ? '完整库' : '公开库'}` }, plugins }], marketplaceLoadErrors: [], featuredPluginIds: [] };
  }
  const index = managedIndex(store, source), aliases = nativeAliases(index); const item = index.plugins.find(p => p.id === params.codexPlusIndexId || p.id === params.id || aliases.get(p.id) === params.pluginName || `${p.name}@${marketName(source, p.id)}` === params.pluginId);
  if (!item) throw new Error('插件目录中没有找到此项目');
  if (['plugin/install', 'install-plugin'].includes(method)) { await installNative(store, source, item.id); return { appsNeedingAuth: [], authPolicy: 'ON_USE' }; }
  if (['plugin/read', 'read-plugin'].includes(method)) return { plugin: { summary: nativeSummary(store, source, item, index, undefined, aliases.get(item.id)), marketplaceName: `codex-plus-index-${source}`, description: item.description, skills: [], mcpServers: [], hooks: [], apps: [], appTemplates: [] } };
  throw new Error(`尚未适配此原生插件操作：${method}`);
}
