/** Durable history/config coordination against private files only. Crash cases
 * terminate their own test worker; every process guard is an isolated fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { mode: 0o600 }); };
const read = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const decode = file => JSON.parse(read(file));
const beforeConfig = 'model_provider = "old"\nsecret = "fixture-private-key"\n';
const afterConfig = 'model_provider = "new"\nsecret = "fixture-new-key"\n';
const beforeState = { 'codex-cli': { providerId: 'old' }, 'chatgpt-desktop': { providerId: 'old' } };
const afterState = { 'codex-cli': { providerId: 'new' }, 'chatgpt-desktop': { providerId: 'new' } };
const json = value => JSON.stringify(value);
function fixture(root, api, hooks = {}, initialize = true) {
  const home = path.join(root, 'client'), dataDir = path.join(root, 'data');
  const config = path.join(home, 'config.toml'), catalog = path.join(dataDir, 'catalog.json');
  const historyFile = path.join(home, 'sessions', 'private.jsonl'), stateFile = path.join(dataDir, 'state.json');
  if (initialize) {
    write(config, beforeConfig); write(catalog, '{"model":"old"}');
    write(historyFile, 'private history before\n'); write(stateFile, json(beforeState));
  }
  const events = [];
  const ctx = { home, sqliteHome: home, blockingProcesses: async () => hooks.running?.() || [] };
  const snapshot = { files: [
    { path: config, before: beforeConfig, after: afterConfig, existed: true },
    { path: catalog, before: '{"model":"old"}', after: '{"model":"new"}', existed: true },
  ], stateBefore: beforeState, stateAfter: afterState };
  const currentStateAllowed = saved => {
    const actual = read(stateFile);
    if (actual !== json(saved.stateBefore) && actual !== json(saved.stateAfter)) throw new Error('fixture-store-conflict-private');
  };
  function createHistoryService(onPrepared, reservation) {
    const backup = id => path.join(home, '.aurora-history-repair', 'provider-backups', id);
    const manifest = id => path.join(backup(id), 'manifest.json');
    return {
      async apply(input) {
        assert.equal(input.revision, 'fixture-revision');
        assert(fs.existsSync(path.join(home, '.aurora-history-repair', 'repair.lock')), 'Coordinator owns shared history lock');
        assert.equal(read(config), beforeConfig, 'History migration precedes config switching');
        events.push('history-apply');
        if (hooks.crash === 'reserved') process.exit(76);
        const id = reservation.backupId;
        assert.equal(backup(id), reservation.backup);
        if (hooks.noHistory) return { ok: true, updated: 0 };
        if (hooks.crash === 'empty-directory') { fs.mkdirSync(backup(id), { recursive: true }); process.exit(78); }
        if (hooks.crash === 'initial-temp') {
          write(path.join(backup(id), 'manifest.json.aurora-abcdef012345.tmp'), json({ format: 'aurora-history-provider-v1', id,
            home, sqliteHome: home, status: 'prepared', files: [], databases: [], rows: [] })); process.exit(79);
        }
        write(manifest(id), json({ format: 'aurora-history-provider-v1', id, home, sqliteHome: home, status: 'prepared' }));
        if (hooks.crash === 'unlinked') process.exit(77);
        await onPrepared({ backupId: id, backup: backup(id) });
        if (hooks.crash === 'prepared') process.exit(73);
        write(historyFile, 'private history after\n');
        write(manifest(id), json({ ...decode(manifest(id)), status: 'complete' }));
        await hooks.afterHistory?.();
        return { ok: true, backupId: id, backup: backup(id), updated: 1, summary: { selected: 1 } };
      },
      async restorePreview({ backupId }) {
        events.push('history-preview');
        assert(fs.existsSync(path.join(home, '.aurora-history-repair', 'repair.lock')));
        const content = read(historyFile);
        return { ok: ['private history before\n', 'private history after\n'].includes(content), revision: 'fixture-restore',
          message: 'fixture-history-conflict-private' };
      },
      async restore({ backupId, revision }) {
        assert.equal(revision, 'fixture-restore'); events.push('history-restore');
        write(historyFile, 'private history before\n');
        write(manifest(backupId), json({ ...decode(manifest(backupId)), status: 'restored' }));
        if (hooks.crash === 'restored') process.exit(75);
        return { ok: true };
      },
    };
  }
  async function rollbackConfig(saved) {
    events.push('config-rollback'); currentStateAllowed(saved);
    for (const file of saved.files) {
      const actual = read(file.path), before = file.existed ? file.before : null, after = file.afterExisted === false ? null : file.after;
      if (actual !== before && actual !== after) return { ok: false };
    }
    for (const file of saved.files) { if (file.existed) write(file.path, file.before); else fs.unlinkSync(file.path); }
    write(stateFile, json(saved.stateBefore)); return { ok: true };
  }
  const recovery = { ctx, dataDir, createHistoryService, rollbackConfig,
    revalidateRecovery: async saved => { events.push('recovery-guard'); currentStateAllowed(saved); } };
  const options = { ...recovery, snapshot, historyRevision: 'fixture-revision',
    revalidate: async () => {
      events.push('revalidate'); assert.equal(read(config), beforeConfig); assert.equal(read(stateFile), json(beforeState));
      await hooks.revalidate?.();
    },
    commit: async control => {
      events.push('commit'); assert.equal(read(historyFile), hooks.noHistory ? 'private history before\n' : 'private history after\n');
      for (const file of snapshot.files) { if (file.afterExisted === false) fs.unlinkSync(file.path); else write(file.path, file.after); }
      let state = afterState;
      if (hooks.dynamicState) { state = { ...afterState, backupPath: 'private-generated-backup' }; control.setStateAfter(state); }
      write(stateFile, json(state));
      if (hooks.crash === 'committing') process.exit(74);
      if (hooks.failCommit) throw new Error('fixture-commit-secret-must-not-escape');
      return { ok: true, fixture: 'committed' };
    } };
  return { root, home, dataDir, config, catalog, historyFile, stateFile, events, options, recovery,
    original() { assert.equal(read(config), beforeConfig); assert.equal(read(catalog), '{"model":"old"}'); assert.equal(read(historyFile), 'private history before\n'); assert.deepEqual(decode(stateFile), beforeState); } };
}

if (process.argv[2] === '--crash-worker') {
  const api = createRequire(import.meta.url)(process.argv[3]);
  const mode = process.argv[5];
  const f = fixture(process.argv[4], api, { crash: mode === 'configuration-commit' ? 'committing' : mode, noHistory: mode === 'configuration-commit', dynamicState: mode === 'committing' || mode === 'configuration-commit', failCommit: mode === 'restored' }, false);
  if (mode === 'configuration-commit') f.options.configurationOnly = true;
  await api.runClientHistorySwitch(f.options);
  throw new Error('Crash fixture unexpectedly returned');
}

const originalTemp = fs.realpathSync.native(os.tmpdir());
const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(originalTemp, 'yunhui-history-switch-test-')));
let passed = 0, sequence = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
try {
  const bundle = path.join(scratch, 'coordinator.cjs');
  await build({ entryPoints: ['src/core/clientHistorySwitch.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  const make = hooks => fixture(path.join(scratch, 'case-' + sequence++), api, hooks);
  const clean = result => { for (const secret of ['fixture-private-key', 'fixture-new-key', 'fixture-commit-secret', 'fixture-store-conflict-private']) assert(!json(result).includes(secret)); };
  await check('History backup is durable before config commit and successful journal retains private original snapshots', async () => {
    const f = make(), result = await api.runClientHistorySwitch(f.options);
    assert.equal(result.ok, true); clean(result);
    const saved = decode(result.journalPath);
    assert.equal(saved.status, 'complete'); assert.equal(saved.snapshot.files[0].before, beforeConfig);
    assert.equal(saved.history.backupId, saved.historyReserved.backupId);
    assert(f.events.indexOf('history-apply') < f.events.indexOf('commit'));
    assert.equal(read(f.config), afterConfig);
    assert(!fs.existsSync(path.join(f.home, '.aurora-history-repair', 'repair.lock')));
    if (process.platform !== 'win32') assert.equal(fs.statSync(result.journalPath).mode & 0o777, 0o600);
  });
  await check('Configuration-only transactions bypass running-client checks and history locks without invoking history services', async () => {
    const f = make({ noHistory: true, running: () => ['private-running-client'] });
    write(path.join(f.home, '.aurora-history-repair', 'repair.lock'), json({ pid: process.pid, nonce: 'unrelated-history-writer', at: new Date().toISOString() }));
    const result = await api.runClientHistorySwitch({ ...f.options, configurationOnly: true }); assert(result.ok, result.message); assert.equal(read(f.config), afterConfig); assert.equal(read(f.historyFile), 'private history before\n'); assert(!f.events.includes('history-apply')); assert(result.journalPath.includes('client-configuration-switches')); assert.equal(decode(result.journalPath).historyAbsent, true);
  });
  await check('A configuration-only worker crash recovers config catalog and shared state while a client runs and history is locked', async () => {
    const f = make({ noHistory: true, running: () => ['private-running-client'] });
    write(path.join(f.home, '.aurora-history-repair', 'repair.lock'), json({ pid: process.pid, nonce: 'unrelated-history-writer', at: new Date().toISOString() }));
    const child = spawnSync(process.execPath, [import.meta.filename, '--crash-worker', bundle, f.root, 'configuration-commit'], { windowsHide: true, timeout: 10000, encoding: 'utf8' }); assert.equal(child.status, 74, child.stderr);
    assert.equal(read(f.config), afterConfig); const recovered = await api.recoverClientHistorySwitches({ ...f.recovery, configurationOnly: true }); assert(recovered.ok, recovered.message); assert.equal(recovered.recovered, 1); f.original(); assert(!f.events.includes('history-restore')); assert.equal(decode(path.join(f.home, '.aurora-history-repair', 'repair.lock')).nonce, 'unrelated-history-writer');
  });
  await check('Commit failure restores history before config and never exposes secrets from callbacks or snapshots', async () => {
    const f = make({ failCommit: true }), result = await api.runClientHistorySwitch(f.options);
    assert.equal(result.ok, false); assert.equal(result.rolledBack, true); clean(result); f.original();
    assert(f.events.indexOf('history-restore') < f.events.indexOf('config-rollback'));
    assert.equal(decode(result.journalPath).status, 'rolled-back');
  });
  await check('External config modification after migration preserves both histories and conflict contents until safe recovery', async () => {
    let f; f = make({ afterHistory: () => write(f.config, 'external-private-config') });
    const result = await api.runClientHistorySwitch(f.options);
    assert.equal(result.recoveryRequired, true); assert.equal(read(f.config), 'external-private-config');
    assert.equal(read(f.historyFile), 'private history after\n'); assert(!f.events.includes('config-rollback'));
    write(f.config, beforeConfig);
    const recovered = await api.recoverClientHistorySwitches(f.recovery);
    assert.equal(recovered.ok, true); assert.equal(recovered.recovered, 1); f.original();
  });
  await check('External store slice conflicts are detected before history restore', async () => {
    let f; f = make({ afterHistory: () => write(f.stateFile, '{"external":true}') });
    const result = await api.runClientHistorySwitch(f.options);
    assert.equal(result.recoveryRequired, true); assert.equal(read(f.historyFile), 'private history after\n');
    assert(!f.events.includes('history-restore')); clean(result);
  });
  await check('History restore conflicts never invoke configuration rollback', async () => {
    let f; f = make({ failCommit: true, afterHistory: () => write(f.historyFile, 'externally appended conversation') });
    const result = await api.runClientHistorySwitch(f.options);
    assert.equal(result.recoveryRequired, true); assert.equal(read(f.historyFile), 'externally appended conversation');
    assert(!f.events.includes('config-rollback'));
  });
  await check('Running clients block initial writes and a client appearing after backup prevents commit and rollback writes', async () => {
    const before = make({ running: () => ['private-client'] });
    const result = await api.runClientHistorySwitch(before.options);
    assert.equal(result.code, 'CLIENT_HISTORY_BUSY'); assert(!fs.existsSync(path.join(before.dataDir, 'client-history-switches'))); before.original();
    let started = false;
    const during = make({ running: () => started ? ['private-client'] : [], afterHistory: () => { started = true; } });
    const second = await api.runClientHistorySwitch(during.options);
    assert.equal(second.recoveryRequired, true); assert(!during.events.includes('commit')); assert(!during.events.includes('history-restore'));
    started = false; assert.equal((await api.recoverClientHistorySwitches(during.recovery)).ok, true); during.original();
  });
  for (const mode of ['reserved', 'empty-directory', 'initial-temp', 'unlinked', 'prepared', 'committing', 'restored']) await check(`A real worker crash at ${mode} is recovered using only the linked batch and shared stale lock`, async () => {
    const f = make();
    const child = spawnSync(process.execPath, [import.meta.filename, '--crash-worker', bundle, f.root, mode],
      { windowsHide: true, timeout: 10000, encoding: 'utf8' });
    assert.equal(child.status, { prepared: 73, committing: 74, restored: 75, reserved: 76, unlinked: 77, 'empty-directory': 78, 'initial-temp': 79 }[mode], child.stderr);
    const result = await api.recoverClientHistorySwitches(f.recovery);
    assert.equal(result.ok, true, result.message); assert.equal(result.recovered, 1); assert.equal(result.pending, 0); f.original();
    assert.equal((await api.recoverClientHistorySwitches(f.recovery)).recovered, 0);
  });
  await check('Disconnect snapshots support restoring an originally absent config after a failed deletion commit', async () => {
    const f = make({ failCommit: true });
    f.options.snapshot.files[0].after = ''; f.options.snapshot.files[0].afterExisted = false;
    const result = await api.runClientHistorySwitch(f.options);
    assert.equal(result.rolledBack, true); f.original();
  });
  await check('Zero-history commits can roll back config without inventing a history backup batch', async () => {
    const f = make({ noHistory: true, failCommit: true });
    const result = await api.runClientHistorySwitch(f.options);
    assert.equal(result.rolledBack, true, result.message); assert(!f.events.includes('history-restore')); f.original();
  });
  await check('First connection creates only the trusted missing history directory before applying a new configuration', async () => {
    const f = make({ noHistory: true });
    const absent = path.join(f.root, 'new-client', '.codex'), config = path.join(absent, 'config.toml');
    f.options.ctx = { home: absent, sqliteHome: absent, blockingProcesses: async () => [] };
    f.options.snapshot.files = [{ path: config, before: '', after: afterConfig, existed: false }];
    f.options.revalidate = async () => { assert(!fs.existsSync(config)); };
    f.options.createHistoryService = () => ({ apply: async () => ({ ok: true, updated: 0 }),
      restorePreview: async () => { throw new Error('No history batch'); }, restore: async () => { throw new Error('No history batch'); } });
    f.options.commit = async () => { write(config, afterConfig); return { ok: true }; };
    const result = await api.runClientHistorySwitch(f.options);
    assert.equal(result.ok, true, result.message); assert.equal(read(config), afterConfig);
    assert.equal(fs.realpathSync(absent), absent);
  });
  await check('Recovery with only completed journals or no history home does not inspect running clients or create files', async () => {
    const f = make(); assert.equal((await api.runClientHistorySwitch(f.options)).ok, true);
    f.recovery.ctx.blockingProcesses = async () => { throw new Error('Must not probe'); };
    assert.equal((await api.recoverClientHistorySwitches(f.recovery)).ok, true);
    const missing = path.join(scratch, 'absent-home');
    const empty = await api.recoverClientHistorySwitches({ ...f.recovery, ctx: { home: missing, sqliteHome: missing,
      blockingProcesses: async () => { throw new Error('Must not probe absent context'); } }, dataDir: path.join(scratch, 'absent-store') });
    assert.equal(empty.ok, true); assert(!fs.existsSync(missing)); assert(!fs.existsSync(path.join(scratch, 'absent-store')));
  });
  await check('Tampered durable snapshots and history paths are refused without restoring arbitrary files', async () => {
    const f = make();
    const child = spawnSync(process.execPath, [import.meta.filename, '--crash-worker', bundle, f.root, 'committing'], { windowsHide: true, timeout: 10000 });
    assert.equal(child.status, 74);
    const journalRoot = path.join(f.dataDir, 'client-history-switches');
    const contextDir = path.join(journalRoot, fs.readdirSync(journalRoot)[0]);
    const journalFile = path.join(contextDir, fs.readdirSync(contextDir).find(name => name.endsWith('.json')));
    const record = decode(journalFile); record.snapshot.files[0].before = 'forged'; write(journalFile, json(record));
    const result = await api.recoverClientHistorySwitches(f.recovery);
    assert.equal(result.ok, false); assert.equal(read(f.config), afterConfig); assert(!f.events.includes('history-restore'));
  });
} finally {
  const target = fs.realpathSync.native(scratch);
  assert.equal(path.dirname(target), originalTemp); assert(path.basename(target).startsWith('yunhui-history-switch-test-'));
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log(`Client history switch coordinator: ${passed} checks passed`);
