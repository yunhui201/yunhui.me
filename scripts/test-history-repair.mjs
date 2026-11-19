import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
// macOS /var can alias /private/var. Keep fixture paths and filesystem hooks
// consistent with the real paths returned by the history validation helpers.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-history-repair-test-')));
const originalClientHome = process.env.AURORA_CLIENT_HOME;
let count = 0;
function check(label, fn) { fn(); count++; console.log(`PASS ${label}`); }
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = file => fs.readFileSync(file, 'utf8');
const uid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const text = (id, provider = 'old', extra = {}) => [
  JSON.stringify({ timestamp: '2026-11-15T01:00:00Z', type: 'session_meta', payload: { id, model_provider: provider, cwd: 'D:/existing-project', source: 'cli', ...extra } }),
  ' { "type": "event_msg", "payload": {"type":"user_message", "message":"正文 不应改变"} } ',
  JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'opaque-ciphertext-preserve-exactly' } }),
].join('\r\n') + '\r\n';
try {
  const bundle = path.join(root, 'api.cjs');
  await build({ stdin: { contents: "export * from './src/core/historyRepair.ts'; export * from './src/core/sessions.ts';", resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { createHistoryRepairService, runHistoryRepairAction, scanSessions } = createRequire(import.meta.url)(bundle);
  function fixture(name) {
    const home = path.join(root, name, '.codex'); fs.mkdirSync(home, { recursive: true });
    write(path.join(home, 'config.toml'), 'model_provider = "aurora"\n[model_providers.aurora]\nname = "Aurora"\nbase_url = "http://127.0.0.1:3425/v1"\n');
    const dbPath = path.join(home, 'state_5.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT, cwd TEXT, title TEXT, archived INTEGER, untouched TEXT); CREATE TABLE local_thread_catalog_hosts(host_id TEXT PRIMARY KEY, host_kind TEXT); INSERT INTO local_thread_catalog_hosts VALUES('local-machine','local'),('remote-machine','remote'); CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT,model_provider TEXT,display_title TEXT,archived INTEGER,PRIMARY KEY(host_id,thread_id));");
    function add(n, options = {}) {
      const id = uid(n), archived = !!options.archived;
      const file = path.join(home, archived ? 'archived_sessions' : 'sessions', '2026', `rollout-${id}.jsonl`);
      const source = options.content ?? text(id, options.provider || 'old', options.meta || {});
      if (!options.missing) write(file, source);
      if (!options.orphan) db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)').run(id, options.provider || 'old', options.stalePath ? path.join(home, 'moved', path.basename(file)) : file, 'D:/existing-project', `Session ${n}`, archived ? 1 : 0, 'keep-me');
      if (options.catalog) { db.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?,?,?)').run('local-machine', id, 'old', `Local ${n}`, 0); db.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?,?,?)').run('remote-machine', id, 'remote-provider', `Remote ${n}`, 0); }
      return { id, file, source };
    }
    const ctx = { home, sqliteHome: home, blockingProcesses: async () => [] };
    return { home, db, dbPath, add, service: createHistoryRepairService(ctx), ctx };
  }
  const f = fixture('normal');
  const first = f.add(1, { catalog: true }), second = f.add(2, { archived: true, stalePath: true });
  f.add(3, { missing: true }); f.add(4, { meta: { source: { subagent: { parent_thread_id: first.id } } } }); f.add(5, { content: text(uid(5)) + '{partial' }); f.add(6, { orphan: true });
  const initial = await f.service.preview({ scope: 'all', fixPaths: true });
  check('Preview reports repairable and blocked cases without writing', () => { assert(initial.ok, initial.message); assert.equal(initial.summary.repairable, 2); assert.equal(initial.summary.blocked, 4); assert.equal(initial.summary.pathChanges, 1); assert(initial.summary.encrypted >= 2); assert.equal(read(first.file), first.source); assert.equal(f.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(first.id).model_provider, 'old'); });
  const active = await f.service.preview({ scope: 'active', ids: [first.id] });
  check('Explicit IDs and active/archive scopes are honored', () => { assert.equal(active.items.length, 1); assert.equal(active.items[0].id, first.id); });
  const invalidTarget = await f.service.preview({ targetProvider: 'unconfigured' });
  check('Unconfigured provider IDs are rejected before planning', () => assert(!invalidTarget.ok));
  const applied = await f.service.apply({ ...initial.options, revision: initial.revision });
  check('Batch repair changes metadata, canonical index, local catalog and verified stale paths', () => { assert(applied.ok, applied.message); assert.equal(applied.updated, 2); assert.equal(JSON.parse(read(first.file).split('\r\n')[0]).payload.model_provider, 'aurora'); assert.equal(f.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(first.id).model_provider, 'aurora'); assert.equal(f.db.prepare('SELECT rollout_path FROM threads WHERE id=?').get(second.id).rollout_path, second.file); assert.equal(f.db.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=? AND thread_id=?').get('local-machine', first.id).model_provider, 'aurora'); });
  check('Chat body, encrypted content, unrelated fields and remote host catalog remain intact', () => { assert.equal(read(first.file).split('\r\n').slice(1).join('\r\n'), first.source.split('\r\n').slice(1).join('\r\n')); assert.equal(f.db.prepare('SELECT untouched FROM threads WHERE id=?').get(first.id).untouched, 'keep-me'); assert.equal(f.db.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=? AND thread_id=?').get('remote-machine', first.id).model_provider, 'remote-provider'); });
  check('Each modified source has a full original backup and SQLite has a readable consistent snapshot', () => { const manifest = JSON.parse(read(path.join(applied.backup, 'manifest.json'))); assert.equal(manifest.files.length, 2); assert.equal(read(manifest.files[0].original), first.source); const snapshot = new DatabaseSync(manifest.databases[0].backup, { readOnly: true }); assert.equal(snapshot.prepare('SELECT model_provider FROM threads WHERE id=?').get(first.id).model_provider, 'old'); snapshot.close(); });
  const unchanged = await f.service.preview({ ids: [first.id, second.id] });
  check('Repeated repair is idempotent', () => { assert.equal(unchanged.summary.repairable, 0); assert.equal(unchanged.summary.unchanged, 2); });
  const newSession = f.add(7, { provider: 'new-after-repair' });
  const restorePreview = await f.service.restorePreview({ backupId: applied.backupId });
  const restored = await f.service.restore({ backupId: applied.backupId, revision: restorePreview.revision });
  check('Restore puts back exact original files and only changed row fields, preserving new sessions', () => { assert(restored.ok, restored.message); assert.equal(read(first.file), first.source); assert.equal(read(second.file), second.source); assert.equal(f.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(first.id).model_provider, 'old'); assert.equal(f.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(newSession.id).model_provider, 'new-after-repair'); assert(f.service.backups().backups[0].restoredAt); });
  const stale = await f.service.preview({ ids: [first.id] });
  write(first.file, first.source + '\n');
  const staleResult = await f.service.apply({ ...stale.options, revision: stale.revision });
  check('Source changes after preview invalidate the batch revision', () => { assert(!staleResult.ok); assert.equal(f.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(first.id).model_provider, 'old'); });
  write(first.file, first.source);
  const rowPreview = await f.service.preview({ ids: [first.id] });
  f.db.prepare('UPDATE threads SET model_provider=? WHERE id=?').run('external-change', first.id);
  const rowResult = await f.service.apply({ ...rowPreview.options, revision: rowPreview.revision });
  check('Index changes after preview invalidate the batch revision', () => assert(!rowResult.ok));
  f.db.prepare('UPDATE threads SET model_provider=? WHERE id=?').run('old', first.id);
  const selected = await f.service.preview({ ids: [first.id] });
  const selectedApplied = await f.service.apply({ ...selected.options, revision: selected.revision });
  assert(selectedApplied.ok, selectedApplied.message);
  write(first.file, read(first.file) + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'new work' } }) + '\n');
  const conflict = await f.service.restorePreview({ backupId: selectedApplied.backupId });
  check('Restore refuses to overwrite a continued conversation', () => { assert(!conflict.ok); assert(conflict.conflicts.some(x => x.includes('新增或修改'))); assert(read(first.file).includes('new work')); });
  const processService = createHistoryRepairService({ ...f.ctx, blockingProcesses: async () => ['ChatGPT.exe'] });
  const blocked = await processService.apply({ ...selected.options, revision: selected.revision });
  check('Running desktop or CLI blocks writes', () => assert(!blocked.ok && blocked.message.includes('ChatGPT.exe')));
  f.db.close();
  const alternate = fixture('alternate-db');
  const migrated = alternate.add(10);
  alternate.db.close();
  fs.mkdirSync(path.join(alternate.home, 'sqlite'));
  fs.renameSync(alternate.dbPath, path.join(alternate.home, 'sqlite', 'codex-vnext.db'));
  const alternatePlan = await alternate.service.preview({});
  const alternateResult = await alternate.service.apply({ ...alternatePlan.options, revision: alternatePlan.revision });
  check('New sqlite directory layouts are discovered by schema', () => { assert(alternatePlan.ok, alternatePlan.message); assert(alternatePlan.dbPath.endsWith('codex-vnext.db')); assert(alternateResult.ok, alternateResult.message); assert.equal(JSON.parse(read(migrated.file).split('\r\n')[0]).payload.model_provider, 'aurora'); });
  const selectedArchive = await alternate.service.preview({ scope: 'archived' });
  check('Empty scopes are reported honestly without creating backups', () => assert.equal(selectedArchive.summary.selected, 0));

  const renamed = fixture('yunhui-provider');
  const renamedConfig = 'model_provider = "yunhui"\n[model_providers.yunhui]\nname = "云汇 AI"\n[model_providers.aurora]\nname = "Legacy provider"\n';
  write(path.join(renamed.home, 'config.toml'), renamedConfig);
  const legacy = renamed.add(80, { provider: 'aurora', catalog: true });
  const legacyArchived = renamed.add(81, { provider: 'aurora', archived: true });
  const official = renamed.add(82, { provider: 'openai' });
  renamed.db.prepare('UPDATE local_thread_catalog SET model_provider=? WHERE host_id=? AND thread_id=?').run('aurora', 'local-machine', legacy.id);
  const renamedInventory = await renamed.service.providers();
  const renamedPreview = await renamed.service.preview({ sourceProvider: 'aurora', targetProvider: 'yunhui', scope: 'all' });
  check('New yunhui configuration discovers legacy aurora histories without changing them during preview', () => {
    assert(renamedInventory.ok, renamedInventory.message); assert.equal(renamedInventory.currentProvider, 'yunhui');
    assert(renamedInventory.targets.some(t => t.id === 'yunhui' && t.current));
    assert.equal(renamedInventory.sources.find(s => s.id === 'aurora').count, 2);
    assert(renamedPreview.ok, renamedPreview.message); assert.equal(renamedPreview.summary.repairable, 2);
    assert.equal(read(legacy.file), legacy.source); assert.equal(read(legacyArchived.file), legacyArchived.source);
    assert.equal(renamed.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(legacy.id).model_provider, 'aurora');
  });
  const renamedApplied = await renamed.service.apply({ ...renamedPreview.options, revision: renamedPreview.revision });
  check('Explicit aurora to yunhui migration updates active/archive indexes and preserves official history and message bytes', () => {
    assert(renamedApplied.ok, renamedApplied.message); assert.equal(renamedApplied.updated, 2);
    for (const session of [legacy, legacyArchived]) {
      assert.equal(JSON.parse(read(session.file).split('\r\n')[0]).payload.model_provider, 'yunhui');
      assert.equal(read(session.file).split('\r\n').slice(1).join('\r\n'), session.source.split('\r\n').slice(1).join('\r\n'));
      assert.equal(renamed.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(session.id).model_provider, 'yunhui');
    }
    assert.equal(renamed.db.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=? AND thread_id=?').get('local-machine', legacy.id).model_provider, 'yunhui');
    assert.equal(read(official.file), official.source); assert.equal(renamed.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(official.id).model_provider, 'openai');
    assert.equal(read(path.join(renamed.home, 'config.toml')), renamedConfig);
  });
  const renamedRestore = await renamed.service.restorePreview({ backupId: renamedApplied.backupId });
  const renamedRestored = await renamed.service.restore({ backupId: renamedApplied.backupId, revision: renamedRestore.revision });
  check('Provider rename migration restores the exact legacy files and indexes', () => {
    assert(renamedRestored.ok, renamedRestored.message);
    for (const session of [legacy, legacyArchived]) {
      assert.equal(read(session.file), session.source);
      assert.equal(renamed.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(session.id).model_provider, 'aurora');
    }
    assert.equal(renamed.db.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=? AND thread_id=?').get('local-machine', legacy.id).model_provider, 'aurora');
  });
  renamed.db.close();

  const regions = fixture('provider-regions');
  const configFile = path.join(regions.home, 'config.toml');
  const config = `\uFEFFprofile = "工作区"\nmodel_provider = "aurora"\n[model_providers.aurora]\nname = "Aurora"\n[model_providers."国内.中转"]\nname = "国内模型"\n[model_providers.codex_plus_managed]\nname = "Internal"\n[model_providers]\nbroken = "not a provider table"\n[profiles."工作区"]\nmodel_provider = "profile.relay"\n[profiles."工作区".model_providers."profile.relay"]\nname = "工作供应商"\n[profiles.inactive.model_providers.hidden]\nname = "不可选"\n`;
  write(configFile, config);
  const oldActive = regions.add(20, { provider: 'retired-provider', catalog: true });
  const oldArchived = regions.add(21, { provider: 'retired-provider', archived: true });
  const otherRegion = regions.add(22, { provider: 'other-provider', content: text(uid(22), 'retired-provider') });
  const orphan = regions.add(23, { provider: 'retired-provider', orphan: true });
  regions.db.prepare('UPDATE local_thread_catalog SET model_provider=? WHERE host_id=? AND thread_id=?').run('retired-provider', 'local-machine', oldActive.id);
  const inventory = await regions.service.providers();
  check('Provider inventory parses active-profile TOML and keeps retired native source regions', () => {
    assert(inventory.ok, inventory.message); assert.equal(inventory.currentProvider, 'profile.relay');
    assert.deepEqual(new Set(inventory.targets.map(t => t.id)), new Set(['openai', 'aurora', '国内.中转', 'profile.relay']));
    assert.equal(inventory.targets[0].id, 'profile.relay'); assert.equal(inventory.targets[0].name, '工作供应商');
    assert.deepEqual(inventory.sources.find(s => s.id === 'retired-provider'), { id: 'retired-provider', count: 2, active: 1, archived: 1 });
    assert(inventory.warnings.some(w => w.includes('元数据'))); assert(inventory.warnings.some(w => w.includes('没有唯一')));
    assert.equal(read(configFile), config); assert(!fs.existsSync(path.join(regions.home, '.aurora-history-repair')));
  });
  const selectedRegion = await regions.service.preview({ sourceProvider: 'retired-provider', targetProvider: '国内.中转' });
  check('Source filtering uses canonical native provider rather than stale rollout metadata', () => {
    assert(selectedRegion.ok, selectedRegion.message); assert.deepEqual(new Set(selectedRegion.items.map(i => i.id)), new Set([oldActive.id, oldArchived.id]));
    assert(selectedRegion.items.every(i => i.beforeProvider === 'retired-provider' && i.targetProvider === '国内.中转'));
    assert.equal(selectedRegion.summary.repairable, 2); assert.equal(selectedRegion.options.sourceProvider, 'retired-provider');
  });
  const archivedRegion = await regions.service.preview({ sourceProvider: 'retired-provider', targetProvider: '国内.中转', scope: 'archived' });
  check('Native source regions compose with archive scope and explicit selection', () => { assert.deepEqual(archivedRegion.items.map(i => i.id), [oldArchived.id]); });
  const movedRegion = await regions.service.apply({ ...selectedRegion.options, revision: selectedRegion.revision });
  check('Cross-provider migration updates only selected regions and preserves remote rows and original files', () => {
    assert(movedRegion.ok, movedRegion.message);
    for (const session of [oldActive, oldArchived]) { assert(fs.existsSync(session.file)); assert.equal(JSON.parse(read(session.file).split('\r\n')[0]).payload.model_provider, '国内.中转'); assert.equal(regions.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(session.id).model_provider, '国内.中转'); }
    assert.equal(regions.db.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=? AND thread_id=?').get('local-machine', oldActive.id).model_provider, '国内.中转');
    assert.equal(regions.db.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=? AND thread_id=?').get('remote-machine', oldActive.id).model_provider, 'remote-provider');
    assert.equal(read(otherRegion.file), otherRegion.source); assert.equal(read(orphan.file), orphan.source); assert.equal(read(configFile), config);
  });
  process.env.AURORA_CLIENT_HOME = path.dirname(regions.home);
  const listed = scanSessions(), routedInventory = await runHistoryRepairAction('codex.repair.providers', {});
  check('History list and provider discovery action expose native provider regions and archive status', () => {
    assert(routedInventory.ok, routedInventory.message); assert.equal(routedInventory.sources.find(s => s.id === '国内.中转').count, 2);
    assert.equal(listed.find(s => s.id === oldActive.id).modelProvider, '国内.中转'); assert.equal(listed.find(s => s.id === oldActive.id).archived, false);
    assert.equal(listed.find(s => s.id === oldArchived.id).archived, true); assert.equal(listed.find(s => s.id === otherRegion.id).modelProvider, 'other-provider');
    assert.equal(listed.find(s => s.id === orphan.id).modelProvider, 'retired-provider');
  });
  const moveRestorePreview = await regions.service.restorePreview({ backupId: movedRegion.backupId });
  const moveRestored = await regions.service.restore({ backupId: movedRegion.backupId, revision: moveRestorePreview.revision });
  check('Region migration restores original metadata and native region without switching live provider', () => { assert(moveRestored.ok, moveRestored.message); assert.equal(read(oldActive.file), oldActive.source); assert.equal(read(oldArchived.file), oldArchived.source); assert.equal(read(configFile), config); });
  regions.db.prepare('UPDATE local_thread_catalog SET model_provider=? WHERE host_id=? AND thread_id=?').run('third-region', 'local-machine', oldActive.id);
  const catalogConflict = await regions.service.preview({ sourceProvider: 'retired-provider', targetProvider: '国内.中转', ids: [oldActive.id] });
  check('An unrelated local catalog region blocks targeted migration', () => { assert.equal(catalogConflict.items[0].status, 'blocked'); assert(catalogConflict.items[0].reason.includes('索引冲突')); });
  regions.db.prepare('UPDATE local_thread_catalog SET model_provider=? WHERE host_id=? AND thread_id=?').run('retired-provider', 'local-machine', oldActive.id);
  for (const invalid of ['codex_plus_managed', 'broken', 'hidden', 'unknown']) {
    const invalidPreview = await regions.service.preview({ sourceProvider: 'retired-provider', targetProvider: invalid });
    check(`Unresolvable or internal target ${invalid} is rejected`, () => assert.equal(invalidPreview.ok, false));
  }
  write(configFile, 'model_provider = "aurora"\nsecret = "fixture-config-secret" trailing-invalid');
  const malformedInventory = await regions.service.providers(), malformedPreview = await regions.service.preview({ targetProvider: 'openai' });
  check('Malformed TOML refuses even builtin targets without disclosing source credentials', () => { assert.equal(malformedInventory.ok, false); assert.equal(malformedPreview.ok, false); assert(!JSON.stringify([malformedInventory, malformedPreview]).includes('fixture-config-secret')); });
  write(configFile, config);
  const duplicateDb = new DatabaseSync(path.join(regions.home, 'state_6.sqlite'));
  duplicateDb.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,model_provider TEXT,archived INTEGER)'); duplicateDb.prepare('INSERT INTO threads VALUES(?,?,?)').run(oldActive.id, 'retired-provider', 0); duplicateDb.close();
  const ambiguousInventory = await regions.service.providers(), ambiguousPreview = await regions.service.preview({ sourceProvider: 'retired-provider', targetProvider: '国内.中转', ids: [oldActive.id] });
  check('Duplicate canonical identities are excluded from counts and blocked for migration', () => { assert.equal(ambiguousInventory.sources.find(s => s.id === 'retired-provider').count, 1); assert(ambiguousInventory.warnings.some(w => w.includes('重复'))); assert.equal(ambiguousPreview.items[0].status, 'blocked'); });
  regions.db.close();

  const failed = fixture('migration-rollback'), failedSession = failed.add(30, { catalog: true });
  failed.db.exec("CREATE TRIGGER deny_migration BEFORE UPDATE OF model_provider ON local_thread_catalog WHEN NEW.model_provider='aurora' BEGIN SELECT RAISE(FAIL, 'fixture database failure'); END;");
  const failedPreview = await failed.service.preview({ sourceProvider: 'old', targetProvider: 'aurora' });
  const failedApply = await failed.service.apply({ ...failedPreview.options, revision: failedPreview.revision });
  check('SQLite update failure after file rewrite rolls back metadata and canonical/local rows together', () => { assert.equal(failedApply.ok, false); assert.equal(failedApply.rolledBack, true); assert.equal(read(failedSession.file), failedSession.source); assert.equal(failed.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(failedSession.id).model_provider, 'old'); assert.equal(failed.db.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=? AND thread_id=?').get('local-machine', failedSession.id).model_provider, 'old'); assert(fs.existsSync(path.join(failedApply.backup, 'manifest.json'))); });
  failed.db.close();

  const split = fixture('split-native-catalog'), splitSession = split.add(31);
  split.db.exec('DROP TABLE local_thread_catalog; DROP TABLE local_thread_catalog_hosts;');
  const catalogDirectory = path.join(split.home, 'sqlite'); fs.mkdirSync(catalogDirectory);
  const catalogDb = new DatabaseSync(path.join(catalogDirectory, 'desktop-catalog.db'));
  catalogDb.exec("PRAGMA journal_mode=WAL; CREATE TABLE local_thread_catalog_hosts(host_id TEXT PRIMARY KEY,host_kind TEXT); INSERT INTO local_thread_catalog_hosts VALUES('desktop','local'),('remote','remote'); CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT,model_provider TEXT,PRIMARY KEY(host_id,thread_id));");
  catalogDb.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?)').run('desktop', splitSession.id, 'old'); catalogDb.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?)').run('remote', splitSession.id, 'remote');
  const splitPreview = await split.service.preview({ sourceProvider: 'old', targetProvider: 'aurora' }), splitApplied = await split.service.apply({ ...splitPreview.options, revision: splitPreview.revision });
  check('Split native and desktop catalog databases migrate in the same backed-up batch', () => { assert(splitApplied.ok, splitApplied.message); assert.equal(split.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(splitSession.id).model_provider, 'aurora'); assert.equal(catalogDb.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=?').get('desktop').model_provider, 'aurora'); assert.equal(catalogDb.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=?').get('remote').model_provider, 'remote'); assert.equal(JSON.parse(read(path.join(splitApplied.backup, 'manifest.json'))).databases.length, 2); });
  const splitRestorePreview = await split.service.restorePreview({ backupId: splitApplied.backupId }), splitRestored = await split.service.restore({ backupId: splitApplied.backupId, revision: splitRestorePreview.revision });
  check('Split-database restore recovers both original providers and byte-exact source', () => { assert(splitRestored.ok, splitRestored.message); assert.equal(read(splitSession.file), splitSession.source); assert.equal(split.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(splitSession.id).model_provider, 'old'); assert.equal(catalogDb.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=?').get('desktop').model_provider, 'old'); });
  catalogDb.exec("CREATE TRIGGER deny_split BEFORE UPDATE OF model_provider ON local_thread_catalog WHEN NEW.model_provider='aurora' BEGIN SELECT RAISE(FAIL,'split fault'); END;");
  const splitFailedPreview = await split.service.preview({ sourceProvider: 'old', targetProvider: 'aurora' }), splitFailed = await split.service.apply({ ...splitFailedPreview.options, revision: splitFailedPreview.revision });
  check('Failure in a separate catalog database rolls back all databases and source metadata', () => { assert.equal(splitFailed.ok, false); assert.equal(splitFailed.rolledBack, true); assert.equal(read(splitSession.file), splitSession.source); assert.equal(split.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(splitSession.id).model_provider, 'old'); assert.equal(catalogDb.prepare('SELECT model_provider FROM local_thread_catalog WHERE host_id=?').get('desktop').model_provider, 'old'); });
  catalogDb.close(); split.db.close();
  const racedRestore = fixture('restore-external-next-file'), racedFirst = racedRestore.add(60), racedSecond = racedRestore.add(61);
  const racedPlan = await racedRestore.service.preview({}), racedApplied = await racedRestore.service.apply({ ...racedPlan.options, revision: racedPlan.revision }); assert(racedApplied.ok, racedApplied.message);
  const racedPreview = await racedRestore.service.restorePreview({ backupId: racedApplied.backupId }), originalRename = fs.promises.rename;
  let racedResult, externalSecond;
  fs.promises.rename = async (from, to) => { const result = await originalRename(from, to); if (to === racedFirst.file) { externalSecond = read(racedSecond.file) + '\nEXTERNAL_NEW_WORK\n'; write(racedSecond.file, externalSecond); } return result; };
  try { racedResult = await racedRestore.service.restore({ backupId: racedApplied.backupId, revision: racedPreview.revision }); }
  finally { fs.promises.rename = originalRename; racedRestore.db.close(); }
  check('Restore preserves a later file changed while an earlier file is being restored', () => { assert.equal(racedResult.ok, false); assert.equal(read(racedSecond.file), externalSecond); assert(racedResult.message.includes('恢复未全部完成')); assert.equal(read(racedFirst.file), racedFirst.source); });

  const copying = fixture('apply-external-during-copy'), copyingSession = copying.add(62), copyingPlan = await copying.service.preview({}), originalCopy = fs.promises.copyFile;
  let copyingResult, externalCopy;
  fs.promises.copyFile = async (from, to, flags) => { const result = await originalCopy(from, to, flags); if (String(from).endsWith('.repaired.jsonl') && String(to).startsWith(copyingSession.file + '.aurora-repair-')) { externalCopy = read(copyingSession.file) + '\nEXTERNAL_DURING_COPY\n'; write(copyingSession.file, externalCopy); } return result; };
  try { copyingResult = await copying.service.apply({ ...copyingPlan.options, revision: copyingPlan.revision }); }
  finally { fs.promises.copyFile = originalCopy; }
  check('Apply rechecks the source after copying replacement bytes and preserves concurrent writes', () => { assert.equal(copyingResult.ok, false); assert.equal(read(copyingSession.file), externalCopy); assert.equal(copying.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(copyingSession.id).model_provider, 'old'); }); copying.db.close();

  const damagedCopy = fixture('restore-damaged-temporary'), damagedSession = damagedCopy.add(63), damagedPlan = await damagedCopy.service.preview({}), damagedApplied = await damagedCopy.service.apply({ ...damagedPlan.options, revision: damagedPlan.revision }); assert(damagedApplied.ok, damagedApplied.message);
  const damagedBefore = read(damagedSession.file), damagedPreview = await damagedCopy.service.restorePreview({ backupId: damagedApplied.backupId }); let damagedResult;
  fs.promises.copyFile = async (from, to, flags) => { const result = await originalCopy(from, to, flags); if (String(from).endsWith('.original.jsonl') && String(to).startsWith(damagedSession.file + '.aurora-repair-')) write(to, 'DAMAGED_TEMPORARY_COPY'); return result; };
  try { damagedResult = await damagedCopy.service.restore({ backupId: damagedApplied.backupId, revision: damagedPreview.revision }); }
  finally { fs.promises.copyFile = originalCopy; }
  check('Restore verifies replacement bytes before renaming the temporary file', () => { assert.equal(damagedResult.ok, false); assert.equal(read(damagedSession.file), damagedBefore); assert.equal(damagedCopy.db.prepare('SELECT model_provider FROM threads WHERE id=?').get(damagedSession.id).model_provider, 'aurora'); }); damagedCopy.db.close();
  console.log(`\n${count} batch history repair integration checks passed.`);
} finally {
  if (originalClientHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = originalClientHome;
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert(path.basename(resolved).startsWith('aurora-history-repair-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
