/** Isolated local diagnostics: real configs/backups, no client processes or model requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-diagnostics-')));
const originalHome = process.env.AURORA_CLIENT_HOME, originalOverride = process.env.ANTHROPIC_AUTH_TOKEN;
const secrets = ['PRIVATE-KEY-SENTINEL', 'PRIVATE-GATEWAY-SENTINEL', 'PRIVATE-ACCOUNT-SENTINEL', 'PRIVATE-FAULT-SENTINEL'];
const write = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
try {
  const bundle = path.join(scratch, 'diagnostics.cjs');
  await build({ stdin: { contents: "export * from './src/core/actions.ts'; export * from './src/core/store/index.ts'; export * from './src/core/agents/adapters.ts'; export * from './src/core/gateway/security.ts';", resolveDir: workspace, loader: 'ts' }, bundle: true, outfile: bundle, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  function fixture(name, agentId = 'claude-code') {
    process.env.AURORA_CLIENT_HOME = path.join(scratch, name, 'client');
    const store = new api.AuroraStore(path.join(scratch, name, 'store'));
    store.saveSettings({ gatewayToken: secrets[1], gatewayPort: 3425 });
    const provider = store.saveProvider({ name: secrets[2], enabled: true, format: 'anthropic', baseUrl: 'https://fixture.invalid', models: [{ id: 'fixture-model' }], apiKeys: [{ id: 'key', key: secrets[0], enabled: true, weight: 1 }] });
    const historyHome = path.join(scratch, name, 'client', '.codex');
    const deps = { store, dataDir: store.dir, version: '0.6.0', gatewayStatus: () => ({ running: true }), gatewayUrl: () => 'http://127.0.0.1:3425',
      historyContext: { home: historyHome, sqliteHome: historyHome, blockingProcesses: async () => [] } };
    const adapter = api.getAdapter(agentId), file = adapter.configPaths()[0];
    if (file) write(file, file.endsWith('.toml') ? '# original\n' : '{}\n');
    const call = (action, data = { agentId }) => api.runAction(deps, action, data);
    const connect = () => call('agent.connect', { agentId, providerId: provider.id, model: 'fixture-model' });
    return { store, provider, deps, adapter, file, call, connect, agentId };
  }
  async function diagnose(f) {
    const blocked = [], restores = [];
    const forbid = (object, key) => { const original = object[key]; object[key] = () => { blocked.push(key); throw new Error(secrets[3]); }; restores.push(() => object[key] = original); };
    for (const key of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'chmodSync']) forbid(fs, key);
    forbid(http, 'request'); forbid(https, 'request'); forbid(globalThis, 'fetch');
    let result;
    try { result = await f.call('agent.diagnose'); } finally { restores.reverse().forEach(restore => restore()); }
    assert.deepEqual(blocked, [], 'Diagnostic attempted a write or network request');
    assert.equal(result.ok, true);
    for (const marker of [...secrets, scratch, 'fixture.invalid', f.provider.id]) assert(!JSON.stringify(result).includes(marker), 'Private value escaped diagnosis: ' + marker);
    assert.equal(result.agentId, f.agentId);
    return new Map(result.checks.map(item => [item.id, item]));
  }
  await check('unmanaged official/manual configuration is not treated as a broken connection', async () => {
    const f = fixture('unmanaged'); const checks = await diagnose(f);
    assert.equal(checks.get('connection').status, 'info'); assert.equal(checks.has('credential'), false); assert.equal(checks.has('gateway'), false);
    assert.equal(fs.readdirSync(path.dirname(f.file)).length, 1);
  });
  await check('applied configuration, original backup and current connection parameters are verified', async () => {
    const f = fixture('connected'); assert.equal((await f.connect()).ok, true);
    const checks = await diagnose(f);
    for (const id of ['format', 'connection', 'models', 'credential', 'parameters', 'gateway', 'backup-location', 'backup', 'drift']) assert.equal(checks.get(id)?.status, 'ok', id);
    assert.equal(fs.existsSync(f.adapter.configPaths()[1]), false, 'Default API setup must not create Claude first-run state');
  });
  await check('token and port changes are detected even when applied file hash is unchanged', async () => {
    const f = fixture('settings'); assert.equal((await f.connect()).ok, true);
    f.store.saveSettings({ gatewayToken: 'replacement-private-key' });
    let checks = await diagnose(f); assert.equal(checks.get('parameters').status, 'warning'); assert.equal(checks.get('drift').status, 'ok');
    f.store.saveSettings({ gatewayToken: secrets[1] }); f.deps.gatewayUrl = () => 'http://127.0.0.1:4444';
    checks = await diagnose(f); assert.equal(checks.get('parameters').status, 'warning');
  });
  await check('external modifications stay untouched and are separately reported from current parameters', async () => {
    const f = fixture('external'); assert.equal((await f.connect()).ok, true);
    const parsed = JSON.parse(fs.readFileSync(f.file, 'utf8')); parsed.env.ANTHROPIC_MODEL = 'external-model';
    const bytes = JSON.stringify(parsed); write(f.file, bytes);
    const checks = await diagnose(f); assert.equal(checks.get('drift').status, 'warning'); assert.equal(checks.get('parameters').status, 'warning');
    assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
  });
  await check('invalid JSON does not expose parser fragments or credentials', async () => {
    const f = fixture('invalid'); assert.equal((await f.connect()).ok, true);
    write(f.file, '{"token":"' + secrets[0]); const checks = await diagnose(f);
    assert.equal(checks.get('format').status, 'error'); assert.equal(checks.get('parameters').status, 'error');
  });
  await check('disabled providers, absent models/keys and stopped gateway have actionable statuses', async () => {
    const f = fixture('dependencies'); assert.equal((await f.connect()).ok, true);
    f.store.saveProvider({ ...f.provider, enabled: false, models: [], apiKeys: [] }); f.deps.gatewayStatus = () => ({ running: false });
    const checks = await diagnose(f);
    for (const id of ['provider', 'credential', 'gateway']) assert.equal(checks.get(id).status, 'error');
    assert.equal(checks.get('models').status, 'warning');
    f.store.saveAgent({ ...f.store.listAgents()[f.agentId], providerId: 'removed-provider' });
    assert.equal((await diagnose(f)).get('provider').status, 'error');
  });
  await check('deleted original backup is distinguished from an unchanged installed configuration', async () => {
    const f = fixture('missing-backup'); assert.equal((await f.connect()).ok, true);
    const backup = f.store.listAgents()[f.agentId].backupPath;
    const manifest = JSON.parse(fs.readFileSync(backup, 'utf8')); fs.unlinkSync(manifest.files[0].backup);
    const checks = await diagnose(f); assert.equal(checks.get('backup').status, 'error'); assert.equal(checks.get('drift').status, 'ok');
  });
  await check('wrong-root manifests are rejected and imported connections remain pending', async () => {
    const f = fixture('wrong-root'); assert.equal((await f.connect()).ok, true);
    f.store.saveAgent({ ...f.store.listAgents()[f.agentId], backupPath: path.join(scratch, 'outside.json'), pendingReapply: true });
    const checks = await diagnose(f); assert.equal(checks.get('backup').status, 'error'); assert.equal(checks.get('connection').status, 'warning');
  });
  await check('only known environment variable names appear, never their values', async () => {
    const f = fixture('env'); process.env.ANTHROPIC_AUTH_TOKEN = secrets[0];
    try { const checks = await diagnose(f); assert.equal(checks.get('environment').status, 'warning'); assert(checks.get('environment').detail.includes('ANTHROPIC_AUTH_TOKEN')); }
    finally { if (originalOverride === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = originalOverride; }
  });
  await check('legacy settings with a missing token are inspected without migrations or token generation', async () => {
    const f = fixture('legacy'); assert.equal((await f.connect()).ok, true);
    f.store.settings.write({ ...f.store.settings.read(), gatewayToken: '', updateUrl: 'https://legacy.invalid', autoSyncModels: false });
    const before = fs.readFileSync(path.join(f.store.dir, 'settings.json'), 'utf8');
    const checks = await diagnose(f); assert.equal(checks.get('parameters').status, 'error');
    assert.equal(fs.readFileSync(path.join(f.store.dir, 'settings.json'), 'utf8'), before);
  });
  await check('shared Codex configuration validates its canonical manifest and official coexistence remains read-only', async () => {
    const f = fixture('codex', 'codex-cli');
    const auth = path.join(path.dirname(f.file), 'auth.json');
    const token = 'fixture.' + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now()/1000) + 3600 })).toString('base64url') + '.fixture';
    write(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, account_id: secrets[2] } }));
    write(path.join(path.dirname(f.file), 'models_cache.json'), JSON.stringify({ models: [{ slug: 'official-fixture', visibility: 'list', base_instructions: '' }] }));
    const connected = await f.call('agent.connect', { agentId: f.agentId, providerId: 'official', model: 'official-fixture', authMode: 'coexist', mode: 'gateway' });
    assert(connected.ok, connected.message);
    const snapshot = path.join(f.store.dir, 'codex-official-models.json'); if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot);
    let checks = await diagnose(f); assert.equal(checks.get('official').status, 'ok'); assert.equal(checks.get('backup').status, 'ok'); assert.equal(checks.get('parameters').status, 'ok'); assert.equal(checks.get('coexist-catalog').status, 'ok');
    assert.equal(fs.existsSync(snapshot), false);
    const catalog = path.join(f.store.dir, 'codex-model-catalog.json'); fs.unlinkSync(catalog);
    checks = await diagnose(f); assert.equal(checks.get('coexist-catalog').status, 'warning'); assert.equal(fs.existsSync(catalog), false);
    write(catalog, '{"secret":"' + secrets[0]); assert.equal((await diagnose(f)).get('coexist-catalog').status, 'error');
    write(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'opaque-fixture-token', account_id: secrets[2] } }));
    checks = await diagnose(f); assert(checks.get('official').detail.includes('未发现已知过期'));
  });
  await check('payload path injection and remote RPC diagnostics are disallowed', async () => {
    const f = fixture('payload');
    for (const payload of [null, [], { agentId: 'claude-code', path: scratch }, { agentId: 'not-a-client' }]) assert.equal((await f.call('agent.diagnose', payload)).ok, false);
    assert.equal(api.REMOTE_ACTIONS.has('agent.diagnose'), false);
  });
  console.log(`\nClient diagnostics: ${passed} checks passed.`);
} finally {
  if (originalHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = originalHome;
  if (originalOverride === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = originalOverride;
  assert(path.basename(scratch).startsWith('yunhui-diagnostics-'));
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
