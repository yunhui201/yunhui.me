/** Automatic client/history transactions through runAction. Private files and SQLite only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { parse as parseToml } from 'smol-toml';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-agent-history-switch-')));
const priorClientHome = process.env.AURORA_CLIENT_HOME;
const aliases = ['codex-cli', 'chatgpt-desktop', 'codex-desktop'];
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const uid = value => `30000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const fault = 'fixture-private-state-storage-fault';
const originalConfig = '# Original profile and provider identities\r\nprofile = "工作.默认"\r\nmodel = "original-model"\r\nmodel_provider = "root-provider"\r\napproval_policy = "on-request"\r\n[model_providers."国内.中转"]\r\nname = "Original relay"\r\nbase_url = "https://original.invalid/v1"\r\nexperimental_bearer_token = "fixture-original-provider-key"\r\nwire_api = "responses"\r\n[profiles."工作.默认"]\r\nmodel_provider = "国内.中转"\r\nmodel = "profile-original"\r\n[projects."D:/fixture"]\r\ntrust_level = "trusted"\r\n';
const effective = content => { const value = parseToml(content.replace(/^\uFEFF/, '')); return value.profiles?.[value.profile]?.model_provider ?? value.model_provider ?? 'openai'; };
const filesSnapshot = files => files.map(file => ({ file, content: fs.existsSync(file) ? read(file) : null }));
const assertFiles = files => { for (const { file, content } of files) assert.equal(fs.existsSync(file) ? read(file) : null, content, `Unexpected file change: ${file}`); };
let passed = 0;
const check = async (label, run) => { await run(); passed++; console.log('PASS', label); };

try {
  const bundle = path.join(scratch, 'core.cjs');
  await build({ stdin: { contents: [
    "export * from './src/core/store/index.ts';", "export * from './src/core/actions.ts';",
    "export * from './src/core/agents/adapters.ts';", "export * from './src/core/agents/configFiles.ts';",
    "export * from './src/core/agents/historyProviders.ts';",
  ].join('\n'), resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  for (const [input, output] of [['src/core/readOnlyWorker.ts', 'read-only-worker.cjs'], ['src/core/agents/detectionWorker.ts', 'detection-worker.cjs']]) {
    await build({ entryPoints: [path.join(workspace, input)], outfile: path.join(scratch, output), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  }
  const api = createRequire(import.meta.url)(bundle);
  const historyTarget = content => api.getManagedHistoryTarget(content) || effective(content);
  const plannedTarget = f => api.getManagedHistoryTarget(api.codexPlan({ provider: f.provider, model: f.payload.model, mode: 'gateway', authMode: 'api', gatewayUrl: f.deps.gatewayUrl(), token: f.store.getSettings().gatewayToken })[0].after);

  function fixture(name, original = originalConfig, options = {}) {
    const root = path.join(scratch, name), client = path.join(root, 'client'), home = path.join(client, '.codex');
    process.env.AURORA_CLIENT_HOME = client;
    const config = path.join(home, 'config.toml'), auth = path.join(home, 'auth.json'), database = path.join(home, 'state_5.sqlite');
    if (original !== null && !options.freshHome) write(config, original);
    const token = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
    const authBytes = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'fixture-private-refresh', account_id: 'fixture-account' } }) + '\r\n';
    if (!options.freshHome) write(auth, authBytes);
    // Explicit official prefix retains source identity while the fixture starts
    // from a third-party provider; a bare cache is intentionally not trusted there.
    if (!options.freshHome) write(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'official/official-fixture', display_name: 'Official fixture', visibility: 'list', context_window: 64000, base_instructions: 'fixture instructions' }] }));
    const store = new api.AuroraStore(path.join(root, 'store'));
    store.saveSettings({ gatewayHost: '127.0.0.1', gatewayPort: 3425, gatewayToken: 'fixture-private-gateway-token', maskSecrets: false });
    const provider = store.saveProvider({ name: 'Fixture API', format: 'openai-responses', baseUrl: 'https://supplier.invalid/v1', enabled: true,
      models: [{ id: 'model-one', contextWindow: 272000 }, { id: 'model-two', contextWindow: 128000 }], apiKeys: [{ id: 'key', label: 'Fixture', key: 'fixture-private-provider-key', enabled: true, weight: 1 }] });
    function withDb(run, readOnly = false) { const db = new DatabaseSync(database, { readOnly }); try { return run(db); } finally { db.close(); } }
    const initializeDatabase = () => withDb(db => db.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, rollout_path TEXT, cwd TEXT, title TEXT, archived INTEGER, source TEXT, parent_thread_id TEXT, model TEXT, reasoning_effort TEXT, untouched TEXT); CREATE TABLE local_thread_catalog_hosts(host_id TEXT PRIMARY KEY,host_kind TEXT); INSERT INTO local_thread_catalog_hosts VALUES('local','local'),('remote','remote'); CREATE TABLE local_thread_catalog(host_id TEXT,thread_id TEXT,model_provider TEXT,PRIMARY KEY(host_id,thread_id));"));
    if (!options.noDatabase && !options.freshHome) initializeDatabase();
    const sessions = [], control = { blockers: [] };
    function add(number, options = {}) {
      const id = uid(number), providerId = options.provider || 'older-region', archived = !!options.archived;
      const file = path.join(home, archived ? 'archived_sessions' : 'sessions', '2026', `rollout-${id}.jsonl`);
      const source = options.parent ? { subagent: { thread_spawn: { parent_thread_id: options.parent, depth: 1 } } } : 'cli';
      const content = '\uFEFF' + JSON.stringify({ type: 'session_meta', payload: { id, model_provider: providerId, source, cwd: 'D:/fixture', model: 'historical-model', reasoning_effort: 'high' } }) + '\r\n'
        + ' { "type": "event_msg", "payload": {"type":"user_message", "message":"正文精确保留"} } \r\n'
        + '{"type":"response_item","payload":{"encrypted_content":"fixture-opaque-ciphertext"}}\r\n';
      write(file, content);
      withDb(db => {
        db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, providerId, file, 'D:/fixture', `Thread ${number}`, archived ? 1 : 0, options.parent ? 'subagent' : 'cli', options.parent || null, 'historical-model', 'high', 'keep-me');
        db.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?)').run('local', id, providerId);
        db.prepare('INSERT INTO local_thread_catalog VALUES(?,?,?)').run('remote', id, 'remote-original');
      });
      const item = { id, file, content, provider: providerId, parent: options.parent || null, archived }; sessions.push(item); return item;
    }
    const deps = { store, dataDir: store.dir, gatewayStatus: () => ({ running: true }), gatewayUrl: () => 'http://127.0.0.1:3425',
      historyContext: { home, sqliteHome: home, blockingProcesses: async () => [...control.blockers] } };
    const payload = { agentId: 'codex-cli', providerId: provider.id, model: 'model-one', authMode: 'api', mode: 'gateway' };
    const call = (action, patch = {}) => api.runAction(deps, action, { ...payload, ...patch });
    const preview = async (patch = {}) => { const plan = await call('agent.preview', patch); assert(plan.ok, plan.message); return plan; };
    const connect = async (patch = {}) => { const plan = await preview(patch); return call('agent.connect', { ...patch, revision: plan.revision }); };
    const rows = () => withDb(db => ({ threads: db.prepare('SELECT * FROM threads ORDER BY id').all(), catalog: db.prepare('SELECT * FROM local_thread_catalog ORDER BY host_id,thread_id').all() }), true);
    return { root, client, home, config, auth, authBytes, database, catalog: path.join(store.dir, 'codex-model-catalog.json'), store, provider, original, sessions, control, deps, payload, add, withDb, initializeDatabase, rows, call, preview, connect };
  }
  const snapshot = f => ({ files: filesSnapshot([f.config, f.auth, f.catalog, ...f.sessions.map(s => s.file)]), rows: f.rows(), agents: JSON.stringify(f.store.listAgents()), agentFiles: filesSnapshot([path.join(f.store.dir, 'agents.json')]) });
  const assertSnapshot = (f, before) => { assertFiles(before.files); assert.deepEqual(f.rows(), before.rows); assert.equal(JSON.stringify(f.store.listAgents()), before.agents); assertFiles(before.agentFiles); };
  const noSecrets = result => { const text = JSON.stringify(result); for (const secret of [fault, 'fixture-private-refresh', 'fixture-private-gateway-token', 'fixture-private-provider-key', 'fixture-original-provider-key', 'fixture-external-secret']) assert(!text.includes(secret), 'Result disclosed fixture credentials or storage error'); };
  function aligned(f, target = historyTarget(read(f.config))) {
    for (const session of f.sessions) {
      const content = read(session.file), prior = session.content.split('\r\n'), after = content.split('\r\n');
      assert.deepEqual(after.slice(1), prior.slice(1), 'Conversation body or encrypted bytes changed');
      const metadata = JSON.parse(after[0].replace(/^\uFEFF/, '')), original = JSON.parse(prior[0].replace(/^\uFEFF/, ''));
      assert.deepEqual(metadata, { ...original, payload: { ...original.payload, model_provider: target } });
      const rows = f.rows(), row = rows.threads.find(item => item.id === session.id);
      assert.equal(row.model_provider, target); assert.equal(row.model, 'historical-model'); assert.equal(row.reasoning_effort, 'high');
      assert.equal(row.archived, Number(session.archived)); assert.equal(row.parent_thread_id, session.parent); assert.equal(row.untouched, 'keep-me');
      assert.equal(rows.catalog.find(item => item.host_id === 'local' && item.thread_id === session.id).model_provider, target);
      assert.equal(rows.catalog.find(item => item.host_id === 'remote' && item.thread_id === session.id).model_provider, 'remote-original');
    }
    assert.equal(read(f.auth), f.authBytes);
  }
  function historyBackup(f, result, beforeFiles, beforeRows) {
    assert(result.history?.backupId && result.history.backupPath, 'Missing automatic history backup');
    const manifest = json(path.join(result.history.backupPath, 'manifest.json'));
    assert.equal(manifest.status, 'complete');
    assert.equal(manifest.files.length, f.sessions.length, 'Every JSONL file, including unchanged files, requires a complete backup');
    for (const file of beforeFiles) assert.equal(read(manifest.files.find(entry => entry.path === file.file).original), file.content);
    const dbFile = manifest.databases.find(entry => entry.path === f.database);
    assert(dbFile, 'Native database snapshot missing');
    const db = new DatabaseSync(dbFile.backup, { readOnly: true });
    try { assert.deepEqual(db.prepare('SELECT * FROM threads ORDER BY id').all(), beforeRows.threads); assert.deepEqual(db.prepare('SELECT * FROM local_thread_catalog ORDER BY host_id,thread_id').all(), beforeRows.catalog); }
    finally { db.close(); }
  }
  async function failState(f, operation, during = () => {}) {
    const original = f.store.saveAgentsIfUnchanged; let calls = 0;
    assert.equal(typeof original, 'function');
    f.store.saveAgentsIfUnchanged = (...args) => { calls++; during(...args); throw new Error(fault); };
    try { const result = await operation(); assert.equal(calls, 1, 'Test must reach state commit'); assert.equal(result.ok, false); noSecrets(result); return result; }
    finally { f.store.saveAgentsIfUnchanged = original; }
  }

  await check('First configuration automatically backs up all active/archive/child histories and migrates metadata and local indexes', async () => {
    const f = fixture('first'), empty = await f.preview(), target = plannedTarget(f);
    const parent = f.add(1), child = f.add(2, { parent: parent.id, provider: 'child-region' }); f.add(3, { archived: true, provider: 'archived-region' }); f.add(4, { provider: target });
    const before = snapshot(f), preview = await f.preview();
    assert.equal(preview.history.total, 4); assert.equal(preview.history.repairable, 3); assert.equal(preview.history.unchanged, 1); assert.equal(preview.history.blocked, 0); assert.equal(preview.history.backupRequired, true);
    assertSnapshot(f, before); noSecrets(preview);
    const result = await f.call('agent.connect', { revision: preview.revision }); assert(result.ok, result.message);
    assert.equal(result.history.backedUp, 4); assert.equal(result.history.repaired, 3); assert.equal(result.history.unchanged, 1);
    aligned(f, target); historyBackup(f, result, before.files.filter(file => f.sessions.some(s => s.file === file.file)), before.rows);
    const configBackup = json(result.backup); assert.equal(read(configBackup.files[0].backup), originalConfig);
    assert(aliases.every(id => f.store.listAgents()[id].connected)); assert.equal(f.rows().threads.find(row => row.id === child.id).parent_thread_id, parent.id);
  });

  await check('The reported 108 sessions with 107 missing logs allow configuration, back up one real file, and leave every source-less index untouched through reapply and restore', async () => {
    const f = fixture('one-log-many-indexes'), valid = f.add(300);
    const missing = Array.from({ length: 107 }, (_, i) => f.add(301 + i, { provider: `prior-region-${i % 4}`, archived: i % 2 === 0, parent: i % 3 === 0 ? valid.id : undefined }));
    for (const item of missing) { fs.unlinkSync(item.file); f.sessions.splice(f.sessions.indexOf(item), 1); }
    const before = snapshot(f), preview = await f.preview();
    assert.equal(preview.history.total, 108); assert.equal(preview.history.preserved, 107); assert.equal(preview.history.blocked, 0); assert.equal(preview.history.repairable, 1);
    assert.equal(preview.history.filesToBackUp, 1); assert.equal(preview.history.indexDatabasesToBackUp, 1); assert.deepEqual(preview.history.blockedReasons, []);
    assert.match(preview.history.message, /1 个会话文件和 1 个索引数据库/); assert.match(preview.history.message, /107 条.*原样保留/); assertSnapshot(f, before);
    const preserved = () => ({ threads: f.rows().threads.filter(row => row.id !== valid.id), catalog: f.rows().catalog.filter(row => row.thread_id !== valid.id) });
    const untouched = preserved();
    const first = await f.call('agent.connect', { revision: preview.revision }); assert(first.ok, first.message);
    assert.equal(first.history.backedUp, 1); assert.equal(first.history.indexBackedUp, 1); assert.equal(first.history.preserved, 107); assert.equal(first.history.repaired, 1);
    aligned(f); assert.deepEqual(preserved(), untouched); historyBackup(f, first, before.files.filter(item => item.file === valid.file), before.rows);
    assert.equal(read(f.auth), f.authBytes); assert(aliases.every(id => f.store.listAgents()[id].connected));
    const repeatBefore = snapshot(f), repeated = await f.connect({ model: 'model-two' }); assert(repeated.ok, repeated.message);
    assert.equal(repeated.history.backedUp, 1); assert.equal(repeated.history.preserved, 107); assert.equal(repeated.history.repaired, 0); assert.notEqual(repeated.history.backupId, first.history.backupId);
    assert.equal(json(repeated.backup).files[0].backup, json(first.backup).files[0].backup); aligned(f); assert.deepEqual(preserved(), untouched);
    historyBackup(f, repeated, repeatBefore.files.filter(item => item.file === valid.file), repeatBefore.rows);
    const restoreBefore = snapshot(f), restored = await f.call('agent.disconnect'); assert(restored.ok, restored.message);
    assert.equal(restored.history.backedUp, 1); assert.equal(restored.history.indexBackedUp, 1); assert.equal(restored.history.preserved, 107); assert.equal(read(f.config), originalConfig);
    aligned(f, '国内.中转'); assert.deepEqual(preserved(), untouched); historyBackup(f, restored, restoreBefore.files.filter(item => item.file === valid.file), restoreBefore.rows);
    for (const item of missing) assert(!fs.existsSync(item.file));
  });

  await check('An index-only history can connect switch model and disconnect with complete database backups and zero invented source files', async () => {
    const f = fixture('index-only-connection');
    for (const number of [420, 421, 422]) { const item = f.add(number, { archived: number % 2 === 0 }); fs.unlinkSync(item.file); f.sessions.splice(f.sessions.indexOf(item), 1); }
    const originalRows = f.rows(), preview = await f.preview();
    assert.equal(preview.history.total, 3); assert.equal(preview.history.preserved, 3); assert.equal(preview.history.filesToBackUp, 0); assert.equal(preview.history.indexDatabasesToBackUp, 1); assert(preview.history.backupRequired);
    for (const operation of [() => f.call('agent.connect', { revision: preview.revision }), () => f.connect({ authMode: 'coexist' }), () => f.call('agent.disconnect')]) {
      const result = await operation(); assert(result.ok, result.message); assert.equal(result.history.backedUp, 0); assert.equal(result.history.indexBackedUp, 1); assert.equal(result.history.preserved, 3); assert.equal(result.history.repaired, 0);
      assert.deepEqual(f.rows(), originalRows); historyBackup(f, result, [], originalRows); assert.equal(read(f.auth), f.authBytes);
    }
    assert.equal(read(f.config), originalConfig); assert(aliases.every(id => !f.store.listAgents()[id].connected));
  });

  await check('Cross-database missing-source copies survive failed state commit retry model switch coexist and disconnect with both database snapshots', async () => {
    const f = fixture('cross-database-connection'), valid = f.add(460), missing = [f.add(461), f.add(462, { archived: true })];
    for (const item of missing) { fs.unlinkSync(item.file); f.sessions.splice(f.sessions.indexOf(item), 1); }
    const copyPath = path.join(f.home, 'state_9.sqlite'); f.withDb(db => db.prepare('VACUUM INTO ?').run(copyPath));
    const withCopy = run => { const db = new DatabaseSync(copyPath); try { return run(db); } finally { db.close(); } };
    withCopy(db => {
      db.prepare('DELETE FROM threads WHERE id=?').run(valid.id); db.prepare('DELETE FROM local_thread_catalog WHERE thread_id=?').run(valid.id);
      db.exec("UPDATE threads SET model_provider='retained-copy-region',title='retained copy title'; UPDATE local_thread_catalog SET model_provider='retained-copy-region' WHERE host_id='local'; CREATE TABLE opaque_copy_payload(id INTEGER,value TEXT); INSERT INTO opaque_copy_payload VALUES(1,'retain unrelated table');");
    });
    const copyRows = db => ({ threads: db.prepare('SELECT * FROM threads ORDER BY id').all(), catalog: db.prepare('SELECT * FROM local_thread_catalog ORDER BY host_id,thread_id').all(), opaque: db.prepare('SELECT * FROM opaque_copy_payload').all() });
    const preservedCopy = withCopy(copyRows), original = snapshot(f), originalMissing = original.rows.threads.filter(row => row.id !== valid.id);
    const preview = await f.preview();
    assert.equal(preview.history.total, 3); assert.equal(preview.history.preserved, 2); assert.equal(preview.history.repairable, 1); assert.equal(preview.history.blocked, 0);
    assert.equal(preview.history.filesToBackUp, 1); assert.equal(preview.history.indexDatabasesToBackUp, 2);
    const failed = await failState(f, () => f.call('agent.connect', { revision: preview.revision })); assert(failed.rolledBack); assertSnapshot(f, original); assert.deepEqual(withCopy(copyRows), preservedCopy);
    for (const operation of [() => f.connect(), () => f.connect({ model: 'model-two' }), () => f.connect({ authMode: 'coexist' }), () => f.call('agent.disconnect')]) {
      const before = snapshot(f), result = await operation(); assert(result.ok, result.message); noSecrets(result);
      assert.equal(result.history.backedUp, 1); assert.equal(result.history.indexBackedUp, 2); assert.equal(result.history.preserved, 2);
      historyBackup(f, result, before.files.filter(file => file.file === valid.file), before.rows); aligned(f);
      const manifest = json(path.join(result.history.backupPath, 'manifest.json')); assert.equal(manifest.databases.length, 2); assert(manifest.rows.every(row => row.sessionId === valid.id));
      const backup = new DatabaseSync(manifest.databases.find(entry => entry.path === copyPath).backup, { readOnly: true });
      try { assert.deepEqual(copyRows(backup), preservedCopy); } finally { backup.close(); }
      assert.deepEqual(withCopy(copyRows), preservedCopy); assert.deepEqual(f.rows().threads.filter(row => row.id !== valid.id), originalMissing);
      assert.equal(read(f.auth), f.authBytes); for (const item of missing) assert(!fs.existsSync(item.file));
    }
    assert.equal(read(f.config), originalConfig); assert(aliases.every(id => !f.store.listAgents()[id].connected));
  });

  await check('State failure with preserved indexes rolls back the valid log and configuration without rewriting orphan rows, then explicit retry succeeds once', async () => {
    const f = fixture('preserved-state-failure'), valid = f.add(430), missing = f.add(431); fs.unlinkSync(missing.file); f.sessions.splice(f.sessions.indexOf(missing), 1);
    const before = snapshot(f), result = await failState(f, () => f.connect()); assert(result.rolledBack); assertSnapshot(f, before); assert.equal(read(valid.file), valid.content);
    const retried = await f.connect(); assert(retried.ok, retried.message); assert.equal(retried.history.preserved, 1); assert.equal(retried.history.backedUp, 1); assert.equal(retried.history.repaired, 1); aligned(f);
    const missingBefore = before.rows.threads.find(row => row.id === missing.id); assert.deepEqual(f.rows().threads.find(row => row.id === missing.id), missingBefore); assert(!fs.existsSync(missing.file));
    const manifests = fs.readdirSync(path.dirname(retried.history.backupPath), { withFileTypes: true });
    assert.equal(manifests.length, 1, 'Failed configuration never starts history; only the successful retry creates its backup');
  });

  await check('Real broken logs are backed up and skipped while valid history and client configuration can still be applied', async () => {
    const f = fixture('preserved-plus-broken'), valid = f.add(440), missing = f.add(441), broken = f.add(442);
    fs.unlinkSync(missing.file); f.sessions.splice(f.sessions.indexOf(missing), 1); write(broken.file, broken.content + '{incomplete');
    const before = snapshot(f), preview = await f.preview();
    assert.equal(preview.history.preserved, 1); assert.equal(preview.history.blocked, 0); assert.equal(preview.history.skipped, 1); assert.match(preview.history.skippedReasons[0], /JSON/);
    const result = await f.call('agent.connect', { revision: preview.revision }); assert(result.ok, result.message); assert.equal(result.history.repaired, 1); assert.equal(result.history.skipped, 1);
    assert.equal(read(broken.file), broken.content + '{incomplete'); assert.deepEqual(f.rows().threads.find(row => row.id === broken.id), before.rows.threads.find(row => row.id === broken.id)); assert.notEqual(read(valid.file), valid.content);
    historyBackup(f, result, before.files.filter(file => f.sessions.some(item => item.file === file.file)), before.rows);
  });

  await check('An index-only database backup failure does not undo saved configuration and a later retry handles history', async () => {
    const f = fixture('index-only-backup-failure'), missing = f.add(450); fs.unlinkSync(missing.file); f.sessions.splice(f.sessions.indexOf(missing), 1);
    const before = snapshot(f), preview = await f.preview(), prepare = DatabaseSync.prototype.prepare; let reached = false, result;
    DatabaseSync.prototype.prepare = function(sql) { if (sql === 'VACUUM INTO ?') { reached = true; throw new Error(fault); } return prepare.call(this, sql); };
    try { result = await f.call('agent.connect', { revision: preview.revision }); } finally { DatabaseSync.prototype.prepare = prepare; }
    assert(reached); assert(result.ok, result.message); assert.equal(result.history.status, 'failed'); assert.notEqual(read(f.config), originalConfig); assert.deepEqual(f.rows(), before.rows); assert.equal(read(f.auth), f.authBytes); noSecrets(result);
    const retry = await f.connect(); assert(retry.ok, retry.message); assert.equal(retry.history.backedUp, 0); assert.equal(retry.history.indexBackedUp, 1); assert.equal(retry.history.preserved, 1);
  });

  await check('Already aligned histories still receive full backups on model changes without changing source bytes', async () => {
    const f = fixture('aligned'), plan = await f.preview(), target = plannedTarget(f); f.add(10, { provider: target });
    const first = await f.connect(); assert(first.ok, first.message);
    const before = snapshot(f), result = await f.connect({ model: 'model-two' }); assert(result.ok, result.message);
    assert.equal(result.history.repaired, 0); assert.equal(result.history.unchanged, 1); assert.equal(result.history.backedUp, 1);
    const historyBefore = before.files.filter(file => f.sessions.some(s => s.file === file.file)); assertFiles(historyBefore); historyBackup(f, result, historyBefore, before.rows);
    assert.equal(json(result.backup).files[0].backup, json(first.backup).files[0].backup);
  });

  await check('History backup storage failures remain auxiliary and never undo successfully saved configuration', async () => {
    for (const [code, expected] of [['ENOSPC', 'CLIENT_HISTORY_STORAGE_FULL'], ['EACCES', 'CLIENT_HISTORY_STORAGE_DENIED'], ['EIO', 'CLIENT_HISTORY_STORAGE_IO'], ['SQLITE_BUSY', 'CLIENT_HISTORY_STORAGE_BUSY']]) {
      const f = fixture(`storage-${code}`), broken = f.add(2900); write(broken.file, broken.content + '{partial');
      const before = snapshot(f), preview = await f.preview(), copyFile = fs.promises.copyFile; let failed = false, result;
      fs.promises.copyFile = async function(from, to, ...args) { if (!failed && String(to).endsWith('.original.jsonl')) { failed = true; throw Object.assign(new Error('fixture-private-refresh secret-path'), { code }); } return copyFile.call(this, from, to, ...args); };
      try { result = await f.call('agent.connect', { revision: preview.revision }); } finally { fs.promises.copyFile = copyFile; }
      assert(failed); assert(result.ok, result.message); assert.equal(result.history.status, 'failed'); assert.match(result.history.message, /重试/); noSecrets(result); assert.notEqual(read(f.config), originalConfig); assert.deepEqual(f.rows(), before.rows); assert.equal(read(f.auth), f.authBytes);
      const retry = await f.connect(); assert(retry.ok, retry.message); assert.equal(retry.history.skipped, 1); assert.equal(read(broken.file), broken.content + '{partial');
    }
  });
  await check('State failure after semantic skipping restores configuration and safe history while preserving a later append to untouched invalid history', async () => {
    const f = fixture('skipped-append-state-failure'), safe = f.add(2910), broken = f.add(2911); write(broken.file, broken.content + '{partial');
    const config = read(f.config), rows = f.rows(), result = await failState(f, () => f.connect(), () => fs.appendFileSync(broken.file, 'later external work'));
    assert(result.rolledBack); assert.equal(read(f.config), config); assert.equal(read(safe.file), safe.content); assert.equal(read(broken.file), broken.content + '{partiallater external work'); assert.deepEqual(f.rows(), rows);
  });

  await check('Reapplying an older yunhui configuration repairs original and newly created provider regions without losing its first restore point', async () => {
    const f = fixture('legacy'); f.add(20, { provider: '国内.中转' }); f.add(21, { provider: 'yunhui' });
    let legacy = api.patchToml(originalConfig, '', { model_provider: 'yunhui', model: `${f.provider.id}/model-one` });
    legacy = api.patchToml(legacy, 'profiles."工作.默认"', { model_provider: 'yunhui', model: `${f.provider.id}/model-one` });
    legacy = api.patchToml(legacy, 'model_providers.yunhui', { name: '云汇 AI', base_url: 'http://127.0.0.1:3425/v1', wire_api: 'responses', experimental_bearer_token: 'fixture-private-gateway-token', requires_openai_auth: false });
    const backupPath = api.applyPlan('codex-cli', [api.planned(f.config, legacy)]);
    f.store.saveAgents(aliases.map(id => ({ id, connected: true, providerId: f.provider.id, model: 'model-one', mode: 'gateway', authMode: 'api', permissionMode: 'preserve', configPath: f.config, backupPath })));
    const result = await f.connect(); assert(result.ok, result.message); aligned(f);
    assert.equal(result.history.backedUp, 2); assert.equal(json(result.backup).files[0].backup, json(backupPath).files[0].backup);
    assert.equal(read(json(result.backup).files[0].backup), originalConfig);
  });

  await check('API to coexist to API to disconnect keeps all history visible under each resulting provider and restores exact original config', async () => {
    const f = fixture('round-trip'); f.add(30); f.add(31, { archived: true });
    for (const patch of [{}, { authMode: 'coexist' }, { authMode: 'api', mode: 'direct', model: 'model-two' }]) {
      const result = await f.connect(patch); assert(result.ok, result.message); aligned(f);
      if (patch.authMode === 'coexist') assert.equal(effective(read(f.config)), 'openai');
    }
    f.add(32, { provider: effective(read(f.config)) });
    const restored = await f.call('agent.disconnect'); assert(restored.ok, restored.message);
    assert.equal(read(f.config), originalConfig); aligned(f, '国内.中转');
    assert.equal(restored.history.backedUp, 3); assert(aliases.every(id => !f.store.listAgents()[id].connected));
  });

  await check('Running clients allow configuration writes and defer all history changes until a later safe retry', async () => {
    const f = fixture('busy'); f.add(40); const preview = await f.preview(), before = snapshot(f);
    f.control.blockers = ['private-fixture-Codex'];
    const result = await f.call('agent.connect', { revision: preview.revision }); assert(result.ok, result.message); assert.equal(result.history.status, 'deferred'); assert.notEqual(read(f.config), originalConfig); assert.deepEqual(f.rows(), before.rows); assertFiles(before.files.filter(file => file.file !== f.config && file.file !== f.catalog));
    f.control.blockers = [];
    const retry = await f.connect(); assert(retry.ok, retry.message); aligned(f);
  });
  await check('A client already running at preview can apply reapply and disconnect without reading or modifying history or official auth', async () => {
    const f = fixture('always-running'), session = f.add(3000), before = f.rows(), prepare = DatabaseSync.prototype.prepare; f.control.blockers = ['private-running-client'];
    DatabaseSync.prototype.prepare = function(sql) { if (/sqlite_master|threads|quick_check/.test(sql)) throw new Error('Running history must never be scanned'); return prepare.call(this, sql); };
    try {
      for (const model of ['model-one', 'model-two']) { const preview = await f.preview({ model }); assert.equal(preview.history.status, 'deferred'); const result = await f.call('agent.connect', { model, revision: preview.revision }); assert(result.ok, result.message); assert.equal(result.history.status, 'deferred'); assert.equal(result.history.backedUp, 0); assert.equal(read(session.file), session.content); assert.equal(read(f.auth), f.authBytes); }
      const restored = await f.call('agent.disconnect'); assert(restored.ok, restored.message); assert.equal(restored.history.status, 'deferred'); assert.equal(read(f.config), originalConfig);
    } finally { DatabaseSync.prototype.prepare = prepare; }
    assert.deepEqual(f.rows(), before); assert(!fs.existsSync(path.join(f.home, '.aurora-history-repair')));
  });
  await check('Unreadable histories and an owned history lock do not prevent configuration save and original authentication remains unchanged', async () => {
    for (const kind of ['read-failure', 'history-lock', 'legacy-interrupted', 'sqlite-home-unavailable']) {
      const f = fixture(`auxiliary-${kind}`), session = f.add(3010), before = f.rows();
      const prepare = DatabaseSync.prototype.prepare;
      if (kind === 'read-failure') DatabaseSync.prototype.prepare = function(sql) { if (/sqlite_master|quick_check/.test(sql)) throw Object.assign(new Error('fixture-private-refresh'), { code: 'EACCES' }); return prepare.call(this, sql); };
      else if (kind === 'history-lock') write(path.join(f.home, '.aurora-history-repair', 'repair.lock'), JSON.stringify({ pid: process.pid, nonce: 'fixture-lock', at: new Date().toISOString() }));
      else if (kind === 'legacy-interrupted') write(path.join(f.store.dir, 'client-history-switches', 'legacy', 'switch-1-aaaaaaaaaaaaaaaa.json'), JSON.stringify({ status: 'committing', privateLegacySnapshot: true }));
      else { const unavailable = path.join(f.root, 'not-a-directory'); write(unavailable, 'fixture'); f.deps.historyContext.sqliteHome = unavailable; }
      let first;
      try { const preview = await f.preview(); first = await f.call('agent.connect', { revision: preview.revision }); assert(first.ok, first.message); assert(['deferred', 'failed'].includes(first.history.status), kind); assert.equal(first.history.backedUp, 0); assert.equal(effective(read(f.config)), 'yunhui'); }
      finally { DatabaseSync.prototype.prepare = prepare; }
      assert.equal(read(session.file), session.content); assert.deepEqual(f.rows(), before); assert.equal(read(f.auth), f.authBytes); assert.equal(read(json(first.backup).files[0].backup), originalConfig);
      if (kind === 'legacy-interrupted') { const saved = read(f.config), preview = await f.preview(); assert.equal(read(f.config), saved); assert(preview.ok); assert.equal(json(path.join(f.store.dir, 'client-history-switches', 'legacy', 'switch-1-aaaaaaaaaaaaaaaa.json')).status, 'committing'); }
    }
  });
  await check('Concurrent appends during optional history backups fail only history and keep the saved configuration usable', async () => {
    const f = fixture('optional-history-race'), session = f.add(3020), originalCopy = fs.promises.copyFile; let changed = false;
    fs.promises.copyFile = async function(from, to, ...args) { const copied = await originalCopy.call(this, from, to, ...args); if (!changed && String(from) === session.file) { changed = true; fs.appendFileSync(session.file, '{"type":"event_msg","payload":{"message":"new external work"}}\n'); } return copied; };
    let result; try { result = await f.connect(); } finally { fs.promises.copyFile = originalCopy; }
    assert(changed); assert(result.ok, result.message); assert.equal(result.history.status, 'failed'); assert.equal(effective(read(f.config)), 'yunhui'); assert(read(session.file).includes('new external work')); assert.equal(read(f.auth), f.authBytes);
  });
  await check('Actual configuration backup or write failure still reports failure without touching history or official auth', async () => {
    for (const kind of ['backup', 'write']) {
      const f = fixture(`config-io-${kind}`), session = f.add(3030), before = snapshot(f), writeFile = fs.writeFileSync; let failed = false;
      fs.writeFileSync = function(file, ...args) { if (!failed && typeof file === 'string' && (kind === 'backup' ? file.endsWith('.original') : file.startsWith(f.config + '.aurora-'))) { failed = true; throw Object.assign(new Error('fixture-private-refresh'), { code: 'ENOSPC' }); } return writeFile.call(this, file, ...args); };
      let result; try { result = await f.connect(); } finally { fs.writeFileSync = writeFile; }
      assert(failed); assert.equal(result.ok, false); assertSnapshot(f, before); assert.equal(read(session.file), session.content); noSecrets(result);
      const retry = await f.connect(); assert(retry.ok, retry.message);
    }
  });
  await check('A newer configuration saved while optional history is being rewritten survives and the stale history migration rolls back', async () => {
    const f = fixture('new-config-during-history'), session = f.add(3040), beforeRows = f.rows(), rename = fs.promises.rename; let newerConfig;
    fs.promises.rename = async function(from, to) { const result = await rename.call(this, from, to); if (String(to) === session.file && !newerConfig) { newerConfig = read(f.config) + '\n# newer external configuration\n'; write(f.config, newerConfig); } return result; };
    let result; try { result = await f.connect(); } finally { fs.promises.rename = rename; }
    assert(newerConfig); assert(result.ok, result.message); assert.equal(result.history.status, 'failed'); assert.equal(read(f.config), newerConfig); assert.equal(read(session.file), session.content); assert.deepEqual(f.rows(), beforeRows); assert.equal(read(f.auth), f.authBytes);
  });

  await check('Skipping a semantic conflict keeps full backups and the complete reason list while continuing the safe configuration switch', async () => {
    const f = fixture('blocked'); f.add(50); const broken = f.add(51); write(broken.file, broken.content + '{incomplete');
    const before = snapshot(f), preview = await f.preview(); assert.equal(preview.history.blocked, 0); assert.equal(preview.history.skipped, 1);
    const result = await f.call('agent.connect', { revision: preview.revision }); assert(result.ok, result.message); assert.equal(result.history.skipped, 1);
    historyBackup(f, result, before.files.filter(file => f.sessions.some(item => item.file === file.file)), before.rows);
    const manifest = json(path.join(result.history.backupPath, 'manifest.json')); assert.equal(manifest.skipped[0].id, broken.id); assert.match(manifest.skipped[0].reason, /JSON/); assert.equal(read(broken.file), broken.content + '{incomplete');
  });

  for (const change of ['append', 'new-session', 'index']) await check(`History ${change} after preview does not invalidate configuration and is freshly reviewed after saving`, async () => {
    const f = fixture('stale-' + change), session = f.add(60), preview = await f.preview();
    if (change === 'append') write(session.file, session.content + '{"type":"event_msg","payload":{"message":"new local work"}}\n');
    else if (change === 'new-session') f.add(61, { provider: 'arrived-after-preview' });
    else f.withDb(db => db.prepare('UPDATE threads SET model_provider=? WHERE id=?').run('external-index-region', session.id));
    const result = await f.call('agent.connect', { revision: preview.revision }); assert(result.ok, result.message); assert.equal(result.history.status, 'completed'); assert.equal(effective(read(f.config)), 'yunhui'); if (change === 'append') assert(read(session.file).includes('new local work'));
  });

  await check('A changed shared-client connection record invalidates preview without overwriting the newer selection', async () => {
    const f = fixture('stale-shared-state'); f.add(65); const preview = await f.preview();
    f.store.saveAgents([{ id: 'chatgpt-desktop', connected: false, model: 'external-state-change' }]);
    const before = snapshot(f), result = await f.call('agent.connect', { revision: preview.revision });
    assert.equal(result.ok, false); assertSnapshot(f, before);
  });

  for (const change of ['provider', 'settings']) await check(`Changing ${change} during optional history backup preserves saved configuration and the later settings`, async () => {
    const f = fixture('during-backup-' + change), session = f.add(66), alignedPlan = await f.preview();
    // An unchanged history is still copied into the full snapshot, providing a
    // deterministic pause inside backup without replacing a production service.
    f.add(67, { provider: plannedTarget(f) });
    const before = snapshot(f), preview = await f.preview(), originalCopy = fs.promises.copyFile;
    let changed = false, changedBytes;
    const changedFile = path.join(f.store.dir, change === 'provider' ? 'providers.json' : 'settings.json');
    fs.promises.copyFile = async (source, destination, flags) => {
      const result = await originalCopy(source, destination, flags);
      if (!changed && f.sessions.some(item => item.file === source) && String(destination).endsWith('.original.jsonl')) {
        changed = true;
        if (change === 'provider') f.store.saveProvider({ id: f.provider.id, baseUrl: 'https://new-endpoint.invalid/v1', apiKeys: [{ id: 'new-key', label: 'Changed elsewhere', key: 'fixture-new-private-key', enabled: true, weight: 1 }] });
        else f.store.saveSettings({ gatewayPort: 4343, gatewayToken: 'fixture-new-gateway-token' });
        changedBytes = read(changedFile);
      }
      return result;
    };
    let result;
    try { result = await f.call('agent.connect', { revision: preview.revision }); }
    finally { fs.promises.copyFile = originalCopy; }
    assert(changed, 'Mutation must occur inside full history backup'); assert(result.ok, result.message); assert.equal(effective(read(f.config)), 'yunhui'); assert.equal(read(changedFile), changedBytes);
    assert(!JSON.stringify(result).includes('fixture-new-private-key')); assert(!JSON.stringify(result).includes('fixture-new-gateway-token'));
    assert.equal(f.rows().threads.find(row => row.id === session.id).model_provider, historyTarget(read(f.config)));
  });

  await check('State-commit failure restores complete history, config, catalog and all shared connection records', async () => {
    const f = fixture('failed-first'); f.add(70); f.add(71, { archived: true }); write(f.catalog, '{"models":[],"fixture":"prior-catalog"}\n');
    const before = snapshot(f);
    await failState(f, () => f.connect({ authMode: 'coexist' }), states => assert.deepEqual(states.map(state => state.id), aliases));
    assertSnapshot(f, before); assert.equal(read(f.auth), f.authBytes);
    const retry = await f.connect({ authMode: 'coexist' }); assert(retry.ok, retry.message); aligned(f);
  });

  await check('Failed repeated switch and failed disconnect both restore the immediately preceding config and history', async () => {
    const f = fixture('failed-repeat'); f.add(80); const first = await f.connect(); assert(first.ok, first.message);
    const before = snapshot(f); await failState(f, () => f.connect({ authMode: 'coexist' })); assertSnapshot(f, before);
    await failState(f, () => f.call('agent.disconnect')); assertSnapshot(f, before);
    const result = await f.call('agent.disconnect'); assert(result.ok, result.message); assert.equal(read(f.config), originalConfig); aligned(f, '国内.中转');
  });

  await check('An external config conflict preserves the external bytes and migrated history with an explicit recoverable transaction', async () => {
    const f = fixture('external-config'); f.add(90); const before = snapshot(f), external = '# external config\nsecret="fixture-external-secret"\n';
    let migratedFiles, migratedRows;
    const result = await failState(f, () => f.connect(), () => {
      migratedFiles = filesSnapshot(f.sessions.map(session => session.file)); migratedRows = f.rows(); write(f.config, external);
    });
    assert.equal(read(f.config), external); assert.equal(result.recoveryRequired, true); assert.equal(result.rolledBack, false);
    assert(result.recoveryPath && fs.existsSync(result.recoveryPath)); assert.equal(json(result.recoveryPath).status, 'needs-recovery');
    assertFiles(migratedFiles); assert.deepEqual(f.rows(), migratedRows);
    assert.equal(read(f.auth), f.authBytes); assert.equal(JSON.stringify(f.store.listAgents()), before.agents); assertFiles(before.agentFiles);
    // A user may resolve the conflicting file to the documented before/after
    // bytes. The next preview must finish recovery before preparing new work.
    const transaction = json(result.recoveryPath), configSnapshot = transaction.snapshot.files.find(file => file.path === f.config);
    write(f.config, configSnapshot.after);
    f.store.saveAgents([{ id: 'claude-code', connected: true, providerId: 'unrelated-provider', model: 'external-model' }]);
    const unrelated = structuredClone(f.store.listAgents()['claude-code']);
    const recoveredPreview = await f.preview(); assert(recoveredPreview.ok, recoveredPreview.message);
    assert.equal(json(result.recoveryPath).status, 'rolled-back');
    assertFiles(before.files); assert.deepEqual(f.rows(), before.rows);
    assert(aliases.every(id => !f.store.listAgents()[id]?.connected));
    assert.deepEqual(f.store.listAgents()['claude-code'], unrelated, 'Recovery overwrote another client connection');
    const retry = await f.call('agent.connect', { revision: recoveredPreview.revision }); assert(retry.ok, retry.message); aligned(f);
    assert.deepEqual(f.store.listAgents()['claude-code'], unrelated);
  });

  await check('A continued history edited during rollback is never overwritten and the operation cannot claim success', async () => {
    const f = fixture('external-history'), session = f.add(100); let continued;
    const result = await failState(f, () => f.connect(), () => {
      continued = read(session.file) + '{"type":"event_msg","payload":{"message":"external-work-must-survive"}}\n'; write(session.file, continued);
    });
    assert.equal(read(session.file), continued); assert.equal(result.ok, false); assert.equal(read(f.auth), f.authBytes);
    assert(aliases.every(id => !f.store.listAgents()[id]?.connected));
  });

  await check('An absent original configuration creates a managed config and automatically backs up existing histories', async () => {
    const f = fixture('no-config', null); f.add(110); const result = await f.connect(); assert(result.ok, result.message); aligned(f);
    assert.equal(result.history.backedUp, 1); assert.equal(json(result.backup).files[0].backup, null);
  });

  await check('Zero-history configuration saves while a client is running and creates no history database', async () => {
    const f = fixture('zero-busy', originalConfig, { noDatabase: true }), preview = await f.preview();
    assert.equal(preview.history.total, 0); assert.equal(preview.history.backupRequired, false);
    const tree = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? tree(file) : [{ file: path.relative(f.root, file), content: fs.readFileSync(file).toString('base64') }];
    }).sort((a, b) => a.file.localeCompare(b.file));
    const before = tree(f.root), agents = JSON.stringify(f.store.listAgents());
    f.control.blockers = ['private-zero-history-client'];
    const result = await f.call('agent.connect', { revision: preview.revision });
    assert(result.ok, result.message); assert.equal(result.history.status, 'deferred'); assert.notEqual(read(f.config), originalConfig);
    assert.notEqual(JSON.stringify(f.store.listAgents()), agents); assert.equal(fs.existsSync(f.database), false); noSecrets(result);
  });

  await check('A brand-new absent home can connect, and disconnect removes the originally absent config without creating fake histories', async () => {
    const f = fixture('brand-new-home', null, { freshHome: true }); assert.equal(fs.existsSync(f.home), false);
    const preview = await f.preview(); assert.equal(preview.history.backupRequired, false); assert.equal(fs.existsSync(f.home), false);
    const connected = await f.call('agent.connect', { revision: preview.revision }); assert(connected.ok, connected.message);
    assert.equal(effective(read(f.config)), 'yunhui'); assert.equal(connected.history?.backedUp, 0); assert.equal(connected.history?.backupId, undefined);
    const backup = json(connected.backup); assert.equal(backup.files[0].backup, null); assert.equal(backup.files[0].originalAbsent, true);
    assert.equal(fs.existsSync(f.database), false); assert.equal(fs.existsSync(f.auth), false);
    const disconnected = await f.call('agent.disconnect'); assert(disconnected.ok, disconnected.message);
    assert.equal(fs.existsSync(f.config), false); assert.equal(fs.existsSync(f.database), false); assert.equal(fs.existsSync(f.auth), false);
    assert(aliases.every(id => f.store.listAgents()[id]?.connected === false)); noSecrets(disconnected);
  });

  for (const arrival of ['database', 'session']) await check(`A new ${arrival} after an empty preview does not block saving configuration`, async () => {
    const f = fixture('zero-arrival-' + arrival, originalConfig, { noDatabase: true }), preview = await f.preview();
    assert.equal(preview.history.backupRequired, false); f.initializeDatabase();
    if (arrival === 'session') f.add(120, { provider: 'arrived-after-empty-preview' });
    const before = snapshot(f), result = await f.call('agent.connect', { revision: preview.revision });
    assert(result.ok, result.message); assert.equal(result.history.status, 'completed'); assert.equal(effective(read(f.config)), 'yunhui'); assert.equal(result.history.indexBackedUp, 1);
  });

  for (const setting of ['provider', 'settings']) await check(`Stale cached ${setting} data is rejected after an external disk edit, and refreshed preview applies the new credentials`, async () => {
    const f = fixture('cached-external-' + setting); f.add(130);
    const patch = setting === 'provider' ? { mode: 'direct' } : {}, preview = await f.preview(patch), before = snapshot(f);
    const file = path.join(f.store.dir, setting === 'provider' ? 'providers.json' : 'settings.json');
    if (setting === 'provider') {
      const values = json(file); assert(Array.isArray(values));
      const value = values.find(entry => entry.id === f.provider.id); assert(value);
      value.baseUrl = 'https://externally-updated.invalid/v1';
      value.apiKeys = [{ id: 'external-key', label: 'External', key: 'fixture-disk-new-provider-secret', enabled: true, weight: 1 }];
      write(file, JSON.stringify(values, null, 2));
      assert.equal(f.store.getProvider(f.provider.id).baseUrl, 'https://supplier.invalid/v1', 'Fixture must retain stale cache');
    } else {
      const values = json(file); values.gatewayToken = 'fixture-disk-new-gateway-secret'; write(file, JSON.stringify(values, null, 2));
      assert.equal(f.store.getSettings().gatewayToken, 'fixture-private-gateway-token', 'Fixture must retain stale cache');
    }
    const external = read(file);
    let rejected;
    try { rejected = await f.call('agent.connect', { ...patch, revision: preview.revision }); }
    catch (error) { rejected = { ok: false, message: String(error.message) }; }
    assert.equal(rejected.ok, false); assert.match(rejected.message, /变化|刷新|核验/); assertSnapshot(f, before); assert.equal(read(file), external);
    const refreshed = await f.preview(patch); assert.notEqual(refreshed.revision, preview.revision);
    const connected = await f.call('agent.connect', { ...patch, revision: refreshed.revision }); assert(connected.ok, connected.message);
    const config = parseToml(read(f.config)), transport = config.model_providers.yunhui;
    if (setting === 'provider') {
      assert.equal(transport.base_url, 'https://externally-updated.invalid/v1'); assert.equal(transport.experimental_bearer_token, 'fixture-disk-new-provider-secret');
    } else assert.equal(transport.experimental_bearer_token, 'fixture-disk-new-gateway-secret');
    aligned(f); assert.equal(read(file), external);
    for (const output of [rejected, refreshed, connected]) {
      noSecrets(output); assert(!JSON.stringify(output).includes('fixture-disk-new-provider-secret')); assert(!JSON.stringify(output).includes('fixture-disk-new-gateway-secret'));
    }
  });

  console.log(`Agent history switches: ${passed} isolated checks passed`);
} finally {
  if (priorClientHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = priorClientHome;
  assert.equal(path.dirname(scratch), fs.realpathSync(os.tmpdir())); assert(path.basename(scratch).startsWith('yunhui-agent-history-switch-'));
  fs.rmSync(scratch, { recursive: true, force: true });
}
