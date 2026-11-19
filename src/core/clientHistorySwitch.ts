import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { PlannedFile } from './agents/configFiles.js';
import { acquireHistoryLock, assertClientsStopped, historyLocation, normalizeHistoryContext, repairRoot, historyStorageFailure, historyStorageMessages, type HistoryStorageCode, type HistoryContext } from './historyRepairIO.js';

export interface ClientHistorySwitchSnapshot { files: Array<PlannedFile & { afterExisted?: boolean }>; stateBefore: unknown; stateAfter: unknown }
export interface ClientHistoryBackup { backupId: string; backup: string }
export interface ClientHistoryApplyReply { ok: boolean; failureCode?: HistoryStorageCode; backupId?: string; backup?: string; rolledBack?: boolean; updated?: number; backedUp?: number; indexBackedUp?: number; preserved?: number; skipped?: number; summary?: unknown; message?: string }
export interface ClientHistorySwitchService {
  apply(input: Record<string, unknown> & { revision: string }): Promise<ClientHistoryApplyReply>;
  restorePreview(input: { backupId: string }): Promise<{ ok: boolean; revision?: string; message?: string }>;
  restore(input: { backupId: string; revision: string }): Promise<{ ok: boolean; message?: string }>;
}
export type CreateClientHistoryService = (onPrepared: (backup: ClientHistoryBackup) => Promise<void>, reservation?: ClientHistoryBackup) => ClientHistorySwitchService;
export interface ClientHistorySwitchRecoveryOptions {
  ctx: HistoryContext;
  dataDir: string;
  /** Main-process configuration transaction; never accepted from renderer input. */
  configurationOnly?: boolean;
  /** Called while the shared history lock is held. The service must use lockHeld:true. */
  createHistoryService: CreateClientHistoryService;
  /** Read-only CAS guard for managed store state; runs before any rollback write. */
  revalidateRecovery(snapshot: ClientHistorySwitchSnapshot): void | Promise<void>;
  /** Must CAS both config/catalog and the managed store slice against before/after. */
  rollbackConfig(snapshot: ClientHistorySwitchSnapshot): Promise<{ ok: boolean; message?: string }>;
}
export interface ClientHistorySwitchOptions<T extends { ok: boolean }> extends ClientHistorySwitchRecoveryOptions {
  snapshot: ClientHistorySwitchSnapshot;
  historyRevision: string;
  historyInput?: Record<string, unknown>;
  revalidate(): void | Promise<void>;
  commit(control: { setStateAfter(stateAfter: unknown): void }): Promise<T>;
}
export interface ClientHistorySwitchResult<T = unknown> {
  ok: boolean; code?: 'CLIENT_HISTORY_BUSY' | 'CLIENT_HISTORY_CONFLICT' | 'CLIENT_HISTORY_RECOVERY_REQUIRED' | 'CLIENT_HISTORY_FAILED' | HistoryStorageCode;
  transactionId?: string; journalPath?: string; history?: ClientHistoryApplyReply; result?: T;
  rolledBack?: boolean; recoveryRequired?: boolean; message: string;
}
export interface ClientHistorySwitchRecoveryResult extends ClientHistorySwitchResult { recovered: number; pending: number }
type Status = 'prepared' | 'history-prepared' | 'history-applied' | 'committing' | 'complete' | 'rolling-back' | 'rolled-back' | 'needs-recovery';
interface Journal {
  format: 'yunhui-client-history-switch-v1'; id: string; home: string; sqliteHome: string; dataDir: string;
  createdAt: string; updatedAt: string; status: Status; snapshot: ClientHistorySwitchSnapshot; snapshotHash: string;
  historyRevision: string; history?: ClientHistoryBackup; historyReserved?: ClientHistoryBackup; historyAbsent?: boolean; historyRestored?: boolean; historyUntracked?: boolean;
}
interface OwnedJournal { value: Journal; file: string; text: string }
interface Context { ctx: HistoryContext; dataDir: string; root: string; configurationOnly?: boolean }
const MAX_BYTES = 40 * 1024 * 1024;
const statuses: Status[] = ['prepared', 'history-prepared', 'history-applied', 'committing', 'complete', 'rolling-back', 'rolled-back', 'needs-recovery'];
const complete = (status: Status) => status === 'complete' || status === 'rolled-back';
const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
class SwitchError extends Error {
  constructor(public readonly code: NonNullable<ClientHistorySwitchResult['code']>, message: string) { super(message); }
}
const conflict = () => new SwitchError('CLIENT_HISTORY_CONFLICT', '配置、供应商状态或事务记录已被其他操作修改，已保留当前内容和备份。');
function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
function ordinary(file: string, limit = MAX_BYTES): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw conflict();
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > limit) throw conflict();
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.length) { const count = fs.readSync(fd, content, offset, content.length - offset, offset); if (!count) throw conflict(); offset += count; }
    if (fs.fstatSync(fd).size !== opened.size) throw conflict();
    return content;
  } finally { fs.closeSync(fd); }
}
/** No links below a caller-owned canonical root, including nonexistent leaves. */
function safePath(root: string, file: string): void {
  if (!within(root, file)) throw conflict();
  let current = root;
  const parts = path.relative(root, file).split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw conflict();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (key(historyLocation(file)) !== key(file)) throw conflict();
}
function directory(file: string): void {
  try { fs.mkdirSync(file, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw conflict();
}
function context(options: ClientHistorySwitchRecoveryOptions, requireExisting = true): Context {
  const ctx = normalizeHistoryContext(options.configurationOnly ? { ...options.ctx, sqliteHome: options.ctx.home } : options.ctx), dataDir = historyLocation(options.dataDir);
  if (requireExisting && (!fs.statSync(ctx.home).isDirectory() || !fs.statSync(dataDir).isDirectory())) throw conflict();
  const base = path.join(dataDir, options.configurationOnly ? 'client-configuration-switches' : 'client-history-switches');
  safePath(dataDir, base);
  return { ctx, dataDir, root: path.join(base, hash([key(ctx.home), key(ctx.sqliteHome)]).slice(0, 32)), configurationOnly: options.configurationOnly };
}
function prepareDirectories(c: Context): void {
  directory(path.dirname(c.root)); directory(c.root);
}
function prepareHistoryHome(c: Context): void {
  const missing: string[] = [];
  let ancestor = c.ctx.home;
  while (!fs.existsSync(ancestor)) {
    missing.unshift(ancestor);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw conflict();
    ancestor = parent;
  }
  const base = fs.lstatSync(ancestor);
  if (!base.isDirectory() || base.isSymbolicLink() || key(historyLocation(ancestor)) !== key(ancestor)) throw conflict();
  for (const candidate of missing) {
    safePath(ancestor, candidate); directory(candidate);
  }
  if (key(historyLocation(c.ctx.home)) !== key(c.ctx.home) || !fs.statSync(c.ctx.home).isDirectory()) throw conflict();
}
function canonicalSnapshot(c: Context, input: ClientHistorySwitchSnapshot): ClientHistorySwitchSnapshot {
  const copy = JSON.parse(JSON.stringify(input)) as ClientHistorySwitchSnapshot;
  if (!copy || !Array.isArray(copy.files) || !copy.files.length || copy.files.length > 16) throw conflict();
  for (const file of copy.files) {
    if (!file || typeof file.path !== 'string' || !path.isAbsolute(file.path) || /[\x00-\x1f\x7f]/.test(file.path)
      || typeof file.before !== 'string' || typeof file.after !== 'string' || typeof file.existed !== 'boolean'
      || (file.afterExisted !== undefined && typeof file.afterExisted !== 'boolean') || (file.afterExisted === false && file.after !== '')
      || Buffer.byteLength(file.before) > 4 * 1024 * 1024 || Buffer.byteLength(file.after) > 4 * 1024 * 1024
      || (!file.existed && file.before !== '')) throw conflict();
    file.path = historyLocation(file.path);
    const root = within(c.ctx.home, file.path) ? c.ctx.home : within(c.dataDir, file.path) ? c.dataDir : '';
    if (!root) throw conflict();
    safePath(root, file.path);
  }
  if (new Set(copy.files.map(file => key(file.path))).size !== copy.files.length || Buffer.byteLength(JSON.stringify(copy)) > MAX_BYTES - 8192) throw conflict();
  return copy;
}
function checkFiles(c: Context, snapshot: ClientHistorySwitchSnapshot, beforeOnly: boolean, afterOnly = false): void {
  for (const file of snapshot.files) {
    safePath(within(c.ctx.home, file.path) ? c.ctx.home : c.dataDir, file.path);
    let content: string | null;
    try { content = ordinary(file.path, 4 * 1024 * 1024).toString('utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; content = null; }
    const original = file.existed ? file.before : null;
    const expected = file.afterExisted === false ? null : file.after;
    if (afterOnly ? content !== expected : content !== original && (beforeOnly || content !== expected)) throw conflict();
  }
}
function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch { /* Directory fsync is unsupported by Windows. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function save(c: Context, owned: OwnedJournal): void {
  safePath(c.dataDir, owned.file);
  const current = fs.existsSync(owned.file) ? ordinary(owned.file).toString('utf8') : '';
  if (current !== owned.text) throw conflict();
  owned.value.updatedAt = new Date().toISOString();
  const text = JSON.stringify(owned.value, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_BYTES) throw conflict();
  const temporary = path.join(c.root, `${owned.value.id}.${randomBytes(8).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    if ((fs.existsSync(owned.file) ? ordinary(owned.file).toString('utf8') : '') !== owned.text) throw conflict();
    fs.renameSync(temporary, owned.file); syncDirectory(c.root); owned.text = text;
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch { } }
}
function load(c: Context): OwnedJournal[] {
  if (!fs.existsSync(c.root)) return [];
  safePath(c.dataDir, c.root);
  const entries = fs.readdirSync(c.root, { withFileTypes: true });
  if (entries.length > 2048) throw new SwitchError('CLIENT_HISTORY_RECOVERY_REQUIRED', '配置切换记录过多，请先检查备份目录。');
  return entries.filter(entry => entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name)).map(entry => {
    if (!/^switch-\d+-[a-f0-9]{16}\.json$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw conflict();
    const file = path.join(c.root, entry.name), text = ordinary(file).toString('utf8');
    const value = JSON.parse(text) as Journal;
    if (value.format !== 'yunhui-client-history-switch-v1' || value.id + '.json' !== entry.name || !statuses.includes(value.status)
      || key(value.home) !== key(c.ctx.home) || key(value.sqliteHome) !== key(c.ctx.sqliteHome) || key(value.dataDir) !== key(c.dataDir)
      || hash(value.snapshot) !== value.snapshotHash || typeof value.historyRevision !== 'string') throw conflict();
    if (c.configurationOnly && (value.history || value.historyReserved || value.historyUntracked || value.historyAbsent !== true)) throw conflict();
    const snapshot = canonicalSnapshot(c, value.snapshot);
    if (hash(snapshot) !== value.snapshotHash) throw conflict();
    if (value.historyReserved) validateBackupPath(c, value.historyReserved);
    if (value.history && !complete(value.status)) validateBackup(c, value.history);
    return { value, file, text };
  });
}
function validateBackupPath(c: Context, value: ClientHistoryBackup): void {
  if (!value || !/^provider-\d+-[a-f0-9]{12}$/.test(value.backupId) || typeof value.backup !== 'string'
    || key(value.backup) !== key(path.join(repairRoot(c.ctx), 'provider-backups', value.backupId))) throw conflict();
  safePath(c.ctx.home, path.join(value.backup, 'manifest.json'));
}
function validateBackup(c: Context, value: ClientHistoryBackup): void {
  validateBackupPath(c, value);
  const manifest = JSON.parse(ordinary(path.join(value.backup, 'manifest.json')).toString('utf8'));
  if (manifest.format !== 'aurora-history-provider-v1' || manifest.id !== value.backupId
    || key(manifest.home) !== key(c.ctx.home) || key(manifest.sqliteHome) !== key(c.ctx.sqliteHome)) throw conflict();
}
function alreadyRestored(c: Context, value: ClientHistoryBackup): boolean {
  validateBackup(c, value);
  return JSON.parse(ordinary(path.join(value.backup, 'manifest.json')).toString('utf8')).status === 'restored';
}
function removeUnstartedReservation(c: Context, reserved: ClientHistoryBackup): void {
  validateBackupPath(c, reserved);
  if (!fs.existsSync(reserved.backup)) return;
  const entries = fs.readdirSync(reserved.backup, { withFileTypes: true });
  // Initial atomic manifest writes can leave a private temporary after a crash.
  // Accept only a fully readable empty prepared journal for this exact batch.
  for (const entry of entries) {
    if (!/^manifest\.json\.aurora-[a-f0-9]{12}\.tmp$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw conflict();
    const file = path.join(reserved.backup, entry.name);
    const manifest = JSON.parse(ordinary(file).toString('utf8'));
    if (manifest.format !== 'aurora-history-provider-v1' || manifest.id !== reserved.backupId || manifest.status !== 'prepared'
      || key(manifest.home) !== key(c.ctx.home) || key(manifest.sqliteHome) !== key(c.ctx.sqliteHome)
      || !Array.isArray(manifest.files) || manifest.files.length || !Array.isArray(manifest.databases) || manifest.databases.length
      || !Array.isArray(manifest.rows) || manifest.rows.length) throw conflict();
  }
  for (const entry of entries) fs.unlinkSync(path.join(reserved.backup, entry.name));
  fs.rmdirSync(reserved.backup);
}
async function stopped(c: Context): Promise<void> {
  if (c.configurationOnly) return;
  try { await assertClientsStopped(c.ctx); }
  catch { throw new SwitchError('CLIENT_HISTORY_BUSY', '请先完全退出 ChatGPT / Codex 桌面客户端和 CLI，再切换配置或恢复历史。'); }
}
function lock(c: Context): () => void {
  if (c.configurationOnly) {
    // Configuration ownership is independent from native session maintenance.
    // Reuse the proven PID lock implementation in a separate private directory.
    const lockHome = path.join(c.dataDir, 'client-configuration-locks'); directory(lockHome);
    return acquireHistoryLock({ home: lockHome, sqliteHome: lockHome });
  }
  safePath(c.ctx.home, repairRoot(c.ctx));
  try { return acquireHistoryLock(c.ctx); }
  catch (error) { if (historyStorageFailure(error)) throw error; throw new SwitchError('CLIENT_HISTORY_BUSY', '已有历史修复、恢复或配置切换正在执行，请稍后重试。'); }
}
async function recoverOne(c: Context, options: ClientHistorySwitchRecoveryOptions, owned: OwnedJournal): Promise<boolean> {
  try {
    if (owned.value.historyUntracked) throw conflict();
    await stopped(c); checkFiles(c, owned.value.snapshot, false);
    await options.revalidateRecovery(owned.value.snapshot);
    if (!owned.value.history && owned.value.historyReserved) {
      const reserved = owned.value.historyReserved;
      validateBackupPath(c, reserved);
      if (fs.existsSync(path.join(reserved.backup, 'manifest.json'))) {
        validateBackup(c, reserved); owned.value.history = reserved;
      } else {
        if (!owned.value.historyAbsent && owned.value.status !== 'prepared' && owned.value.status !== 'needs-recovery' && owned.value.status !== 'rolling-back') throw conflict();
        removeUnstartedReservation(c, reserved);
      }
      // No source write is permitted before onPrepared. A reservation whose
      // initial manifest was never created has no history mutation to undo.
    }
    owned.value.status = 'rolling-back'; save(c, owned);
    if (owned.value.history && !owned.value.historyRestored) {
      const backup = owned.value.history;
      if (!alreadyRestored(c, backup)) {
        const service = options.createHistoryService(async () => { throw conflict(); });
        const preview = await service.restorePreview({ backupId: backup.backupId });
        if (!preview.ok || !preview.revision) throw conflict();
        await stopped(c); checkFiles(c, owned.value.snapshot, false);
        await options.revalidateRecovery(owned.value.snapshot);
        const restored = await service.restore({ backupId: backup.backupId, revision: preview.revision });
        if (!restored.ok) throw conflict();
      }
      owned.value.historyRestored = true; save(c, owned);
    }
    await stopped(c); checkFiles(c, owned.value.snapshot, false);
    await options.revalidateRecovery(owned.value.snapshot);
    if (!(await options.rollbackConfig(owned.value.snapshot)).ok) throw conflict();
    checkFiles(c, owned.value.snapshot, true);
    owned.value.status = 'rolled-back'; save(c, owned);
    return true;
  } catch {
    owned.value.status = 'needs-recovery';
    try { save(c, owned); } catch { /* Preserve an externally modified journal. */ }
    return false;
  }
}
function failure(error: unknown, configurationOnly = false): ClientHistorySwitchResult {
  const storage = historyStorageFailure(error); if (storage) return { ok: false, code: storage, message: configurationOnly ? historyStorageMessages[storage].replaceAll('历史', '配置').replace('请完全退出客户端后重试', '请检查配置文件占用后重试') : historyStorageMessages[storage] };
  return { ok: false, code: error instanceof SwitchError ? error.code : 'CLIENT_HISTORY_FAILED',
    message: error instanceof SwitchError ? error.message : '客户端配置切换未完成，已保留当前配置和备份，请检查后重试。' };
}

/** Durable history-first transaction. This module never starts or terminates a client. */
export async function runClientHistorySwitch<T extends { ok: boolean }>(options: ClientHistorySwitchOptions<T>): Promise<ClientHistorySwitchResult<T>> {
  let release: (() => void) | undefined, c: Context | undefined, owned: OwnedJournal | undefined, history: ClientHistoryApplyReply | undefined;
  try {
    c = context(options, false);
    if (!fs.statSync(c.dataDir).isDirectory()) throw conflict();
    await stopped(c); prepareHistoryHome(c); release = lock(c);
    if (load(c).some(record => !complete(record.value.status))) throw new SwitchError('CLIENT_HISTORY_RECOVERY_REQUIRED', '存在未完成的配置和历史切换，请先恢复该批次再重试。');
    if (!options.historyRevision || options.historyRevision.length > 256) throw conflict();
    const snapshot = canonicalSnapshot(c, options.snapshot);
    checkFiles(c, snapshot, true); await options.revalidate(); await stopped(c);
    prepareDirectories(c);
    const id = `switch-${Date.now()}-${randomBytes(8).toString('hex')}`, at = new Date().toISOString();
    const historyId = `provider-${Date.now()}-${randomBytes(6).toString('hex')}`;
    const reservation = { backupId: historyId, backup: path.join(repairRoot(c.ctx), 'provider-backups', historyId) };
    if (!c.configurationOnly) { validateBackupPath(c, reservation); if (fs.existsSync(reservation.backup)) throw conflict(); }
    owned = { file: path.join(c.root, id + '.json'), text: '', value: { format: 'yunhui-client-history-switch-v1', id,
      home: c.ctx.home, sqliteHome: c.ctx.sqliteHome, dataDir: c.dataDir, createdAt: at, updatedAt: at,
      status: 'prepared', snapshot, snapshotHash: hash(snapshot), historyRevision: options.historyRevision, ...(c.configurationOnly ? { historyAbsent: true } : { historyReserved: reservation }) } };
    save(c, owned);
    if (!c.configurationOnly) {
    const service = options.createHistoryService(async backup => {
      validateBackup(c!, backup);
      if (backup.backupId !== reservation.backupId || key(backup.backup) !== key(reservation.backup)) throw conflict();
      if (owned!.value.history && (owned!.value.history.backupId !== backup.backupId || key(owned!.value.history.backup) !== key(backup.backup))) throw conflict();
      owned!.value.history = { backupId: backup.backupId, backup: backup.backup };
      owned!.value.status = 'history-prepared'; save(c!, owned!);
    }, reservation);
    history = await service.apply({ ...options.historyInput, revision: options.historyRevision });
    if (history.backupId || history.backup) {
      const backup = { backupId: history.backupId || '', backup: history.backup || '' };
      validateBackup(c, backup);
      if (!owned.value.history) { owned.value.history = backup; save(c, owned); throw conflict(); }
      if (owned.value.history.backupId !== backup.backupId || key(owned.value.history.backup) !== key(backup.backup)) throw conflict();
    }
    if (!history.ok) {
      if (history.rolledBack && owned.value.history && alreadyRestored(c, owned.value.history)) { owned.value.historyRestored = true; save(c, owned); }
      if (history.failureCode && Object.hasOwn(historyStorageMessages, history.failureCode)) throw new SwitchError(history.failureCode, historyStorageMessages[history.failureCode]);
      throw new SwitchError('CLIENT_HISTORY_FAILED', '历史备份或迁移未完成，未提交新的客户端配置。请重新预览后重试。');
    }
    if ((history.updated || 0) > 0 && !owned.value.history) { owned.value.historyUntracked = true; save(c, owned); throw conflict(); }
    if (!owned.value.history) { owned.value.historyAbsent = true; save(c, owned); }
    }
    owned.value.status = 'history-applied'; save(c, owned);
    await stopped(c); checkFiles(c, snapshot, true); await options.revalidate();
    owned.value.status = 'committing'; save(c, owned);
    const result = await options.commit({ setStateAfter(stateAfter) {
      if (owned!.value.status !== 'committing') throw conflict();
      const next = canonicalSnapshot(c!, { ...owned!.value.snapshot, stateAfter });
      owned!.value.snapshot = next; owned!.value.snapshotHash = hash(next); save(c!, owned!);
    } });
    if (!result?.ok) throw new SwitchError('CLIENT_HISTORY_FAILED', '客户端配置保存失败，正在恢复本次历史和配置修改。');
    checkFiles(c, owned.value.snapshot, false, true);
    owned.value.status = 'complete'; save(c, owned);
    return { ok: true, result, transactionId: id, journalPath: owned.file, history,
      message: c.configurationOnly ? '客户端配置已保存，重新启动客户端后生效。' : '客户端配置和历史迁移已完成，原始历史与配置备份已保存。' };
  } catch (error) {
    const outcome = failure(error, options.configurationOnly) as ClientHistorySwitchResult<T>;
    if (!c || !owned || !owned.text) return outcome;
    const rolledBack = await recoverOne(c, options, owned);
    return { ...outcome, transactionId: owned.value.id, journalPath: owned.file, history, rolledBack, recoveryRequired: !rolledBack,
      ...(!rolledBack ? { code: 'CLIENT_HISTORY_RECOVERY_REQUIRED' as const, message: options.configurationOnly ? '配置保存遇到外部修改或读写故障，原始备份已保留。请检查配置文件与目录权限后重试。' : '本次配置或历史切换未完成，存在冲突或客户端仍在运行。备份和事务记录已保留，请退出客户端后重试恢复。' } : {}) };
  } finally { release?.(); }
}

export async function recoverClientHistorySwitches(options: ClientHistorySwitchRecoveryOptions): Promise<ClientHistorySwitchRecoveryResult> {
  let release: (() => void) | undefined, recovered = 0, pending = 0;
  try {
    const c = context(options, false);
    if (!fs.existsSync(c.root)) return { ok: true, recovered: 0, pending: 0, message: '没有需要恢复的配置切换。' };
    if (!load(c).some(record => !complete(record.value.status))) return { ok: true, recovered: 0, pending: 0, message: '没有需要恢复的配置切换。' };
    if (!fs.existsSync(c.ctx.home) || !fs.statSync(c.ctx.home).isDirectory()) throw conflict();
    await stopped(c); release = lock(c);
    const records = load(c).filter(record => !complete(record.value.status)); pending = records.length;
    for (const record of records) {
      if (!await recoverOne(c, options, record)) return { ok: false, recovered, pending, recoveryRequired: true,
        code: 'CLIENT_HISTORY_RECOVERY_REQUIRED', transactionId: record.value.id, journalPath: record.file,
        message: '检测到未完成的配置切换及外部修改，已保留历史、配置和备份，未覆盖冲突内容。' };
      recovered++; pending--;
    }
    return { ok: true, recovered, pending, message: recovered ? '已恢复上次中断的配置和历史切换，可以继续配置。' : '没有需要恢复的配置切换。' };
  } catch (error) { return { ...failure(error, options.configurationOnly), recovered, pending, recoveryRequired: true }; }
  finally { release?.(); }
}
