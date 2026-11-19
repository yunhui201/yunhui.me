import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

type OwnedJson = 'claude-onboarding-v1';
export interface PermissionScope { kind: 'codex-execution-v1' | 'claude-execution-v1'; profile?: string }
export interface PlannedFile { path: string; before: string; after: string; existed: boolean; ownedJson?: OwnedJson; permissionScope?: PermissionScope | null }
interface BackupEntry { path: string; backup: string | null; installedHash: string; originalHash?: string; originalAbsent?: true; ownedJson?: OwnedJson; permissionScope?: PermissionScope }
interface BackupManifest { format: 'aurora-client-backup-v1'; agentId: string; files: BackupEntry[] }

export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export class UnverifiedOriginalBackupError extends Error {
  constructor() { super('旧版备份缺少原始配置校验记录，无法确认首次接入前的权限；未单独恢复权限。请先核对原始备份并在客户端中手动设置权限。'); }
}
export function readText(file: string): string {
  if (!fs.existsSync(file)) return '';
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`配置路径不是普通文件：${file}`);
  if (stat.size > 4 * 1024 * 1024) throw new Error(`配置文件超过 4 MB，请手动检查：${file}`);
  return fs.readFileSync(file, 'utf8');
}
export function jsonObject(file: string): Record<string, any> {
  const text = readText(file);
  if (!text && !fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error(`配置不是有效的 JSON 对象，已停止写入：${file}`); }
}
export function planned(file: string, after: string): PlannedFile {
  return { path: file, before: readText(file), after, existed: fs.existsSync(file) };
}
export function plannedJson(file: string, value: unknown): PlannedFile {
  return planned(file, JSON.stringify(value, null, 2) + '\n');
}
export function atomicWrite(file: string, content: string, expected?: { existed: boolean; content: string }): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.aurora-${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (expected && (fs.existsSync(file) !== expected.existed || readText(file) !== expected.content)) throw new Error('配置在写入期间被其他程序修改，已停止替换');
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function backupRoot(paths: string[]): string { return path.join(path.dirname(paths[0]), '.aurora-backups'); }
function isWithin(root: string, file: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
function checkBackupDirectory(root: string): void {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`备份目录不能是链接或普通文件：${root}`);
}
function checkBackupFile(root: string, file: string): void {
  if (!isWithin(root, file)) throw new Error('备份路径不属于此客户端目录');
  checkBackupDirectory(root);
  if (fs.existsSync(file) && !isWithin(fs.realpathSync(root), fs.realpathSync(file))) throw new Error('备份文件实际位置不属于此客户端目录');
}
function validateOwnership(agentId: string, file: { path: string; ownedJson?: OwnedJson }, allowed: string[]): void {
  if (file.ownedJson === undefined) return;
  if (file.ownedJson !== 'claude-onboarding-v1' || agentId !== 'claude-code'
    || path.basename(allowed[0]) !== 'settings.json' || path.basename(file.path) !== '.claude.json'
    || !allowed.some(candidate => path.resolve(candidate) === path.resolve(file.path))) throw new Error('备份中的受管字段范围无效');
  const directory = path.dirname(allowed[0]);
  const candidates = [path.join(directory, '.claude.json'), ...(path.basename(directory) === '.claude' ? [path.join(path.dirname(directory), '.claude.json')] : [])];
  if (!candidates.some(candidate => path.resolve(candidate) === path.resolve(file.path))) throw new Error('引导设置不属于此 Claude 配置目录');
}
function validatePermissionScope(agentId: string, file: { path: string; permissionScope?: PermissionScope | null }, allowed: string[]): void {
  const scope = file.permissionScope;
  if (scope == null) return;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).some(key => !['kind', 'profile'].includes(key))
    || path.resolve(file.path) !== path.resolve(allowed[0])
    || (scope.profile !== undefined && (typeof scope.profile !== 'string' || !scope.profile || scope.profile.length > 200 || /[\u0000-\u001f]/.test(scope.profile)))
    || !(agentId === 'codex-cli' && path.basename(file.path) === 'config.toml' && scope.kind === 'codex-execution-v1'
      || agentId === 'claude-code' && path.basename(file.path) === 'settings.json' && scope.kind === 'claude-execution-v1' && scope.profile === undefined))
    throw new Error('备份中的执行权限范围无效');
}
function onboardingObject(text: string): Record<string, any> {
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error('Claude 引导配置不是有效的 JSON 对象，已停止修改'); }
}
function withoutOnboarding(value: Record<string, any>): Record<string, any> { const { hasCompletedOnboarding: _, ...rest } = value; return rest; }
function installedMatches(entry: BackupEntry, current: string): boolean {
  return entry.ownedJson ? onboardingObject(current).hasCompletedOnboarding === true : digest(current) === entry.installedHash;
}
function restoredContent(entry: BackupEntry, current: string): string | null {
  const originalText = entry.backup ? readText(entry.backup) : null;
  if (entry.originalHash && digest(originalText!) !== entry.originalHash) throw new Error('原始配置备份校验失败，已停止恢复');
  if (!entry.ownedJson) return originalText;
  const value = onboardingObject(current), original = originalText === null ? {} : onboardingObject(originalText);
  if (value.hasCompletedOnboarding !== true) throw new Error('Claude 引导标记已被其他程序修改，已停止恢复');
  // If no unrelated fields changed, preserve the first original bytes exactly.
  if (JSON.stringify(withoutOnboarding(value)) === JSON.stringify(withoutOnboarding(original))) return originalText;
  if (Object.hasOwn(original, 'hasCompletedOnboarding')) value.hasCompletedOnboarding = original.hasCompletedOnboarding;
  else delete value.hasCompletedOnboarding;
  if (originalText === null && !Object.keys(value).length) return null;
  return JSON.stringify(value, null, 2) + '\n';
}
function loadManifest(file: string, agentId: string, allowed: string[]): BackupManifest {
  const root = backupRoot(allowed);
  checkBackupFile(root, file);
  let manifest: BackupManifest;
  try { manifest = JSON.parse(readText(file)); } catch { throw new Error(`无法读取有效的配置备份，请检查备份文件：${file}`); }
  if (!manifest || manifest.format !== 'aurora-client-backup-v1' || manifest.agentId !== agentId || !Array.isArray(manifest.files) || !manifest.files.length)
    throw new Error('备份格式不匹配；请手动检查旧版备份');
  for (const e of manifest.files) {
    if (!e || typeof e.path !== 'string' || !/^[a-f0-9]{64}$/.test(e.installedHash) || (e.originalHash !== undefined && (e.backup === null || !/^[a-f0-9]{64}$/.test(e.originalHash))) || (e.backup !== null && typeof e.backup !== 'string') || !allowed.some(p => path.resolve(p) === path.resolve(e.path)) || (e.backup !== null && !isWithin(root, e.backup)))
      throw new Error('备份包含不属于此客户端的文件');
    if (e.originalAbsent !== undefined && (e.originalAbsent !== true || e.backup !== null)) throw new Error('备份中的原始配置不存在记录无效');
    if (e.backup !== null) checkBackupFile(root, e.backup);
    validateOwnership(agentId, e, allowed);
    validatePermissionScope(agentId, e, allowed);
  }
  if (new Set(manifest.files.map(e => path.resolve(e.path))).size !== manifest.files.length) throw new Error('备份存在重复路径');
  return manifest;
}

/** Validated snapshots for selective edits. Contents stay in the main process. */
export function managedPlanSnapshot(agentId: string, backup: string, allowed: string[]): { revision: string; files: Array<PlannedFile & { original: string | null }> } {
  const manifestText = readText(backup), manifest = loadManifest(backup, agentId, allowed);
  const files = manifest.files.map(entry => {
    if (entry.backup === null ? entry.originalAbsent !== true : !entry.originalHash) throw new UnverifiedOriginalBackupError();
    const before = readText(entry.path);
    if (!fs.existsSync(entry.path) || !installedMatches(entry, before)) throw new Error('客户端配置已被其他程序修改，请先处理冲突；未恢复权限');
    if (entry.backup && !fs.existsSync(entry.backup)) throw new Error('首次接入前备份已丢失，无法单独恢复权限');
    const original = entry.backup ? readText(entry.backup) : null;
    if (entry.originalHash && digest(original!) !== entry.originalHash) throw new Error('原始配置备份校验失败，未恢复权限');
    return { path: entry.path, before, after: before, existed: true, original, ...(entry.ownedJson ? { ownedJson: entry.ownedJson } : {}), ...(entry.permissionScope ? { permissionScope: entry.permissionScope } : {}) };
  });
  return { revision: digest(JSON.stringify([manifestText, files])), files };
}

/** Read only validated managed paths when an optional file must remain restorable. */
export function backupPlanFiles(agentId: string, backup: string, allowed: string[]): Pick<BackupEntry, 'path' | 'ownedJson'>[] {
  return loadManifest(backup, agentId, allowed).files.map(({ path, ownedJson }) => ({ path, ownedJson }));
}

/** The action layer uses the same validated manifest and merged restore bytes as the adapter. */
export function expectedPlanFiles(agentId: string, backup: string | undefined, files: { path: string; existed: boolean; content: string }[], restoring = false): Map<string, { existed: boolean; hash: string }> {
  if (!backup || !files.length) throw new Error('缺少可核验的客户端备份');
  const manifest = loadManifest(backup, agentId, files.map(file => file.path));
  const expected = new Map(files.map(file => [file.path, { existed: file.existed, hash: digest(file.content) }]));
  for (const entry of manifest.files) {
    const file = files.find(file => path.resolve(file.path) === path.resolve(entry.path))!;
    if (restoring) {
      if (entry.backup !== null && !fs.existsSync(entry.backup)) throw new Error('客户端原始备份丢失');
      const content = restoredContent(entry, file.content);
      expected.set(file.path, { existed: content !== null, hash: digest(content ?? '') });
    } else expected.set(file.path, { existed: true, hash: entry.installedHash });
  }
  if (!restoring && manifest.files.length !== files.length) throw new Error('客户端备份记录不完整');
  return expected;
}

/** Back up every file before writing any file, and preserve the first connection's originals. */
export function applyPlan(agentId: string, files: PlannedFile[], previousBackup?: string): string {
  if (!files.length) throw new Error('没有可应用的配置');
  const allowed = files.map(f => f.path);
  for (const file of files) {
    validateOwnership(agentId, file, allowed);
    validatePermissionScope(agentId, file, allowed);
    if (file.ownedJson) {
      const before = file.existed ? onboardingObject(file.before) : {}, after = onboardingObject(file.after);
      if (after.hasCompletedOnboarding !== true || JSON.stringify(withoutOnboarding(before)) !== JSON.stringify(withoutOnboarding(after))) throw new Error('引导设置计划只能更新 hasCompletedOnboarding 字段');
    }
  }
  const previous = previousBackup ? loadManifest(previousBackup, agentId, allowed) : undefined;
  const root = backupRoot(allowed);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  checkBackupDirectory(root);
  // mkdir's mode is ignored for existing directories. Credentials must also
  // stay private when a directory was created by an older build or a user.
  if (process.platform !== 'win32') fs.chmodSync(root, 0o700);
  const stamp = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const manifest: BackupManifest = { format: 'aurora-client-backup-v1', agentId, files: [] };
  // Detect edits since preview/build, before creating backups or changing the configuration.
  for (const f of files) {
    if (fs.existsSync(f.path) !== f.existed || readText(f.path) !== f.before) throw new Error('配置刚被其他程序修改，请重新预览');
    const old = previous?.files.find(e => e.path === f.path);
    if (old && (!f.existed || !installedMatches(old, f.before))) throw new Error(`配置在上次接入后有外部修改，请先处理冲突：${f.path}`);
    if (old?.ownedJson && f.ownedJson !== old.ownedJson) throw new Error('不能丢弃引导设置的受管字段备份');
    let backup = old?.backup;
    let originalHash = old?.originalHash;
    let originalAbsent = old?.originalAbsent;
    if (old && backup !== null) {
      if (!backup || !fs.existsSync(backup)) throw new Error('首次接入前的备份已丢失，已停止切换');
      const original = readText(backup);
      if (originalHash && digest(original) !== originalHash) throw new Error('首次接入前备份校验失败，已停止切换');
      // Legacy originals remain usable for full restore, but reading them now
      // cannot establish that they still contain the first connection's bytes.
    }
    if (!old) {
      backup = f.existed ? path.join(root, `${stamp}-${manifest.files.length}.original`) : null;
      if (backup) { fs.writeFileSync(backup, f.before, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); originalHash = digest(f.before); }
      else originalAbsent = true;
    }
    const permissionScope = f.permissionScope === undefined ? old?.permissionScope : f.permissionScope;
    manifest.files.push({ path: f.path, backup: backup ?? null, installedHash: digest(f.after), ...(originalHash ? { originalHash } : {}), ...(originalAbsent ? { originalAbsent } : {}), ...(f.ownedJson ? { ownedJson: f.ownedJson } : {}), ...(permissionScope ? { permissionScope } : {}) });
  }
  const manifestPath = path.join(root, `${agentId}-${stamp}.json`);
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
  const written: PlannedFile[] = [];
  let attempted = '';
  try {
    for (const f of files) {
      attempted = f.path;
      if (fs.existsSync(f.path) !== f.existed || readText(f.path) !== f.before) throw new Error('配置刚被其他程序修改，请重新预览');
      if (f.existed && f.before === f.after) continue;
      atomicWrite(f.path, f.after, { existed: f.existed, content: f.before }); written.push(f);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const f of written.reverse()) {
      try {
        const exists = fs.existsSync(f.path), current = readText(f.path);
        if (exists === f.existed && current === f.before) continue;
        if (!exists || digest(current) !== digest(f.after)) { rollbackErrors.push(f.path); continue; }
        if (f.existed) atomicWrite(f.path, f.before, { existed: true, content: current }); else fs.unlinkSync(f.path);
      }
      catch { rollbackErrors.push(f.path); }
    }
    throw new Error(`配置写入失败或遇到外部修改：${attempted}；配置备份：${manifestPath}${rollbackErrors.length ? `；以下路径已被修改或无法回滚，请手动检查：${rollbackErrors.join('、')}` : '；已撤回本次写入'}`);
  }
  return manifestPath;
}

export function restorePlan(agentId: string, backup: string | undefined, allowed: string[]): void {
  if (!backup) throw new Error('没有接入前备份，未修改客户端配置');
  const manifest = loadManifest(backup, agentId, allowed);
  const before = manifest.files.map(e => {
    const current = readText(e.path);
    if (!fs.existsSync(e.path) || !installedMatches(e, current)) throw new Error(`配置在接入后有修改，已停止恢复以保留你的改动：${e.path}`);
    if (e.backup && !fs.existsSync(e.backup)) throw new Error(`原始备份丢失：${e.backup}`);
    return { entry: e, current, restored: restoredContent(e, current) };
  });
  const restored: typeof before = [];
  let attempted = '';
  try {
    for (const f of before) {
      attempted = f.entry.path;
      if (!fs.existsSync(f.entry.path) || readText(f.entry.path) !== f.current) throw new Error('恢复过程中配置被其他程序修改');
      if (f.restored === null) fs.unlinkSync(f.entry.path);
      else atomicWrite(f.entry.path, f.restored, { existed: true, content: f.current });
      restored.push(f);
    }
  } catch (error) {
    const failures: string[] = [];
    for (const f of restored.reverse()) {
      try {
        const exists = fs.existsSync(f.entry.path), current = readText(f.entry.path);
        if (exists && current === f.current) continue;
        if (exists !== (f.restored !== null) || current !== (f.restored ?? '')) { failures.push(f.entry.path); continue; }
        atomicWrite(f.entry.path, f.current, { existed: exists, content: current });
      } catch { failures.push(f.entry.path); }
    }
    throw new Error(`恢复配置失败或遇到外部修改：${attempted}；原始备份仍保留：${backup}${failures.length ? `；以下路径已被修改或无法回滚，请手动检查：${failures.join('、')}` : '；已撤回本次恢复写入'}`);
  }
}

/** Full restoration uses the same validated bytes as restorePlan, including supported legacy backups. */
export function restorePlanSnapshot(agentId: string, backup: string, allowed: string[]): { revision: string; files: Array<PlannedFile & { afterExisted: boolean }> } {
  const manifestText = readText(backup), manifest = loadManifest(backup, agentId, allowed);
  const files = manifest.files.map(entry => {
    const before = readText(entry.path);
    if (!fs.existsSync(entry.path) || !installedMatches(entry, before)) throw new Error('客户端配置在接入后已变化，未恢复');
    if (entry.backup && !fs.existsSync(entry.backup)) throw new Error('原始配置备份已丢失');
    const after = restoredContent(entry, before);
    return { path: entry.path, before, after: after ?? '', existed: true, afterExisted: after !== null };
  });
  return { revision: digest(JSON.stringify([manifestText, files])), files };
}

/** Read-only verification. No config content, credentials or paths escape this result. */
export function inspectAppliedPlan(agentId: string, backup: string, allowed: string[]): { backupReadable: boolean; unchanged: boolean } {
  if (!allowed.length) throw new Error('无法确定配置目录');
  const manifest = loadManifest(backup, agentId, allowed);
  let backupReadable = true, unchanged = true;
  for (const entry of manifest.files) {
    try {
      if (entry.backup !== null) {
        if (!fs.existsSync(entry.backup)) backupReadable = false;
        else { const original = readText(entry.backup); if (entry.originalHash && digest(original) !== entry.originalHash) backupReadable = false; if (entry.ownedJson) onboardingObject(original); }
      }
    } catch { backupReadable = false; }
    try {
      if (!fs.existsSync(entry.path) || !installedMatches(entry, readText(entry.path))) unchanged = false;
    } catch { unchanged = false; }
  }
  return { backupReadable, unchanged };
}

type TomlValue = string | number | boolean | null;
function toml(value: Exclude<TomlValue, null>): string { return typeof value === 'string' ? JSON.stringify(value) : String(value); }
function tableIdentity(section: string): string {
  if (!section) return '';
  let value: any = parseToml(`[${section}]\n__yunhui_edit_marker = true`);
  const parts: string[] = [];
  while (value && typeof value === 'object' && value.__yunhui_edit_marker !== true) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || Array.isArray(value[keys[0]])) throw new Error('不支持修改此 TOML 表');
    parts.push(keys[0]); value = value[keys[0]];
  }
  return JSON.stringify(parts);
}
/** Edits only the named table; unrelated tables and comments retain their original text. */
export function patchToml(src: string, section: string, values: Record<string, TomlValue>): string {
  try { parseToml(src.replace(/^\uFEFF/, '')); } catch { throw new Error('原配置不是有效的 TOML，已停止修改'); }
  const lines = src.replace(/^\uFEFF/, '').split(/\r?\n/);
  const out: string[] = [];
  const target = tableIdentity(section);
  let current = '';
  let found = section === '';
  const written = new Set<string>();
  let multiline = '', depth = 0, skipping = false;
  const scan = (line: string) => {
    for (let i = 0; i < line.length; i++) {
      if (multiline) {
        if (multiline === '"' && line[i] === '\\') { i++; continue; }
        if (line.slice(i, i + 3) === multiline.repeat(3)) {
          const quote = multiline; multiline = ''; i += 2;
          while (line[i + 1] === quote) i++;
        }
        continue;
      }
      const c = line[i];
      if (c === '#') break;
      if (c === '"' || c === "'") {
        if (line.slice(i, i + 3) === c.repeat(3)) { multiline = c; i += 2; continue; }
        for (i++; i < line.length; i++) {
          if (c === '"' && line[i] === '\\') { i++; continue; }
          if (line[i] === c) break;
        }
      } else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
    }
  };
  const appendMissing = () => {
    for (const [key, value] of Object.entries(values)) {
      if (!written.has(key) && value !== null) out.push(`${key} = ${toml(value)}`);
      written.add(key);
    }
  };
  for (const line of lines) {
    const continuation = !!multiline || depth > 0;
    const headerText = line.replace(/("(?:[^"\\]|\\.)*"|'[^']*')|#.*/g, (match, quoted) => quoted || '');
    const header = !continuation && /^\s*\[(.+)\]\s*$/.exec(headerText);
    if (header) {
      if (current === target) appendMissing();
      current = header[1].startsWith('[') ? '@array:' + header[1] : tableIdentity(header[1].trim());
      if (current === target) found = true;
    }
    const assignment = !continuation && /^\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')\s*=/.exec(line);
    const key = assignment ? Object.keys(parseToml(`${assignment[1]} = true`))[0] : undefined;
    const replace = current === target && key !== undefined && Object.hasOwn(values, key);
    if (replace) {
      if (!written.has(key) && values[key] !== null) out.push(`${key} = ${toml(values[key]!)}`);
      written.add(key);
    } else if (!skipping) out.push(line);
    scan(line);
    skipping = (skipping || replace) && (!!multiline || depth > 0);
  }
  if (current === target) appendMissing();
  if (!found) { out.push('', `[${section}]`); appendMissing(); }
  const result = out.join('\n').trimEnd() + '\n';
  try { parseToml(result); } catch { throw new Error('此 TOML 结构无法安全修改，原配置已保留，请检查内联表或重复键'); }
  return result;
}

export function patchEnv(src: string, values: Record<string, string>): string {
  const lines = src.split(/\r?\n/);
  const written = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (m && Object.hasOwn(values, m[1])) {
      if (!written.has(m[1])) out.push(`${m[1]}=${JSON.stringify(values[m[1]])}`);
      written.add(m[1]);
    } else out.push(line);
  }
  for (const [key, value] of Object.entries(values)) if (!written.has(key)) out.push(`${key}=${JSON.stringify(value)}`);
  return out.join('\n').trim() + '\n';
}

/** Preview must not disclose previous provider credentials or arbitrary MCP env secrets. */
export function redactConfig(text: string): string {
    const visit = (v: any, key = ''): any => {
      if (typeof v === 'string' && /key|token|secret|password|authorization|credential/i.test(key)) return v ? '••••••••' : '';
      if (Array.isArray(v)) return v.map(x => visit(x, key));
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x, k)]));
      return v;
    };
  try {
    return JSON.stringify(visit(JSON.parse(text)), null, 2);
  } catch {
    try { return stringifyToml(visit(parseToml(text))); } catch { /* Legacy env snippets use the line fallback below. */ }
    return text.replace(/^(\s*[\w-]*(?:key|token|secret|password|authorization|credential)[\w-]*\s*=).*$/gim, '$1 "••••••••"');
  }
}
