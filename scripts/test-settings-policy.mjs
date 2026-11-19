/** Application-owned update/model-sync settings survive legacy reads, saves and imports. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-settings-policy-')));
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`PASS ${label}`); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
try {
  const bundle = path.join(scratch, 'api.cjs');
  await build({ stdin: { contents: "export * from './src/core/store/index.ts'; export * from './src/core/releaseSources.ts';", resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { AuroraStore, GITHUB_RELEASE_API } = createRequire(import.meta.url)(bundle);
  const fresh = new AuroraStore(path.join(scratch, 'fresh'));
  check('New stores persist the GitHub release API and automatic model sync immediately', () => {
    const settings = fresh.getSettings(), disk = read(path.join(fresh.dir, 'settings.json'));
    assert.equal(settings.updateUrl, GITHUB_RELEASE_API); assert.equal(settings.autoSyncModels, true);
    assert.equal(disk.updateUrl, GITHUB_RELEASE_API); assert.equal(disk.autoSyncModels, true);
  });
  const legacyDir = path.join(scratch, 'legacy'); fs.mkdirSync(legacyDir);
  const token = 'fixture-existing-gateway-token', catalog = 'http://127.0.0.1:43001/test-catalog';
  fs.writeFileSync(path.join(legacyDir, 'settings.json'), JSON.stringify({ gatewayToken: token, gatewayPort: 4401, theme: 'dark', updateUrl: 'https://yunhui.me/pub.php?action=update', autoSyncModels: false, catalogUrl: catalog }));
  const legacy = new AuroraStore(legacyDir); let writes = 0;
  const save = legacy.settings.write.bind(legacy.settings);
  legacy.settings.write = value => { writes++; save(value); };
  check('Legacy website update settings migrate once without changing tokens or catalog configuration', () => {
    const current = legacy.getSettings(); legacy.getSettings();
    assert.equal(current.updateUrl, GITHUB_RELEASE_API); assert.equal(current.autoSyncModels, true); assert.equal(writes, 1);
    assert.equal(current.gatewayToken, token); assert.equal(current.gatewayPort, 4401); assert.equal(current.theme, 'dark'); assert.equal(current.catalogUrl, catalog);
    const reopened = new AuroraStore(legacyDir).getSettings(); assert.equal(reopened.updateUrl, GITHUB_RELEASE_API); assert.equal(reopened.autoSyncModels, true); assert.equal(reopened.gatewayToken, token);
  });
  check('Settings saves cannot restore a custom update source or disable the hidden automatic sync policy', () => {
    const settings = legacy.saveSettings({ updateUrl: 'invalid legacy value', autoSyncModels: false, catalogUrl: catalog + '/alternate', closeToTray: false });
    assert.equal(settings.updateUrl, GITHUB_RELEASE_API); assert.equal(settings.autoSyncModels, true); assert.equal(settings.catalogUrl, catalog + '/alternate'); assert.equal(settings.closeToTray, false);
    const disk = read(path.join(legacyDir, 'settings.json')); assert.equal(disk.updateUrl, GITHUB_RELEASE_API); assert.equal(disk.autoSyncModels, true);
  });
  check('Imported legacy backups normalize both policies and export durable normalized values', () => {
    const backup = legacy.exportAll(); backup.settings.updateUrl = 'https://third-party.invalid/update'; backup.settings.autoSyncModels = false; backup.settings.catalogUrl = catalog;
    legacy.importAll(backup);
    const exported = legacy.exportAll().settings, reopened = new AuroraStore(legacyDir).getSettings();
    assert.equal(exported.updateUrl, GITHUB_RELEASE_API); assert.equal(exported.autoSyncModels, true); assert.equal(exported.catalogUrl, catalog);
    assert.equal(reopened.updateUrl, GITHUB_RELEASE_API); assert.equal(reopened.autoSyncModels, true); assert.equal(reopened.gatewayToken, token);
  });
  check('Invalid imports still leave all existing configuration unchanged', () => {
    const original = fs.readFileSync(path.join(legacyDir, 'settings.json'), 'utf8');
    const backup = legacy.exportAll(); backup.settings.autoSyncModels = false; backup.settings.updateUrl = 'https://third-party.invalid/update'; backup.settings.gatewayPort = -1;
    assert.throws(() => legacy.importAll(backup), /网关端口/);
    assert.equal(fs.readFileSync(path.join(legacyDir, 'settings.json'), 'utf8'), original);
  });
  check('A settings object written by an older integration is normalized on the next read', () => {
    legacy.settings.write({ ...legacy.getSettings(), updateUrl: '', autoSyncModels: false });
    const current = legacy.getSettings(); assert.equal(current.updateUrl, GITHUB_RELEASE_API); assert.equal(current.autoSyncModels, true);
    assert.equal(read(path.join(legacyDir, 'settings.json')).autoSyncModels, true);
  });
  const NativeDate = Date;
  function at(stamp, task) {
    globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [stamp])); } static now() { return NativeDate.parse(stamp); } };
    try { return task(); } finally { globalThis.Date = NativeDate; }
  }
  check('Display and logging settings preserve connection evidence; supplied timestamps cannot override the revision', () => {
    const store = at('2026-01-01T00:00:00.000Z', () => new AuroraStore(path.join(scratch, 'connection-display')));
    const before = store.getSettings().connectionUpdatedAt;
    const saved = at('2026-01-02T00:00:00.000Z', () => store.saveSettings({ theme: 'dark', accent: '#112233', logRequests: false, connectionUpdatedAt: '2099-01-01T00:00:00.000Z' }));
    assert.equal(saved.updatedAt, '2026-01-02T00:00:00.000Z'); assert.equal(saved.connectionUpdatedAt, before);
    assert.equal(new AuroraStore(store.dir).getSettings().connectionUpdatedAt, before);
  });
  check('Only actual connection field changes advance the connection revision', () => {
    const changes = { gatewayHost: '0.0.0.0', gatewayPort: 4444, gatewayToken: 'new-fixture-gateway-token', proxy: 'http://127.0.0.1:8800', lanShare: true, maskSecrets: true, autoTrimContext: false };
    for (const [key, value] of Object.entries(changes)) {
      const store = at('2026-02-01T00:00:00.000Z', () => new AuroraStore(path.join(scratch, 'connection-' + key)));
      const first = at('2026-02-02T00:00:00.000Z', () => store.saveSettings({ [key]: value, connectionUpdatedAt: '2000-01-01T00:00:00.000Z' }));
      assert.equal(first.connectionUpdatedAt, '2026-02-02T00:00:00.000Z', key);
      const second = at('2026-02-03T00:00:00.000Z', () => store.saveSettings({ [key]: value }));
      assert.equal(second.connectionUpdatedAt, first.connectionUpdatedAt, key);
    }
  });
  check('Legacy connection revisions migrate once using stored update time and survive reads and restarts', () => {
    const store = new AuroraStore(path.join(scratch, 'connection-legacy')), stamp = '2025-01-01T00:00:00.000Z';
    const initial = { ...store.getSettings(), updatedAt: stamp }; delete initial.connectionUpdatedAt;
    store.settings.write(initial); let count = 0; const persist = store.settings.write.bind(store.settings);
    store.settings.write = value => { count++; persist(value); };
    const first = at('2026-03-01T00:00:00.000Z', () => store.getSettings());
    const again = at('2026-03-02T00:00:00.000Z', () => store.getSettings());
    assert.equal(first.connectionUpdatedAt, stamp); assert.equal(again.connectionUpdatedAt, stamp); assert.equal(count, 1);
    assert.equal(at('2026-03-03T00:00:00.000Z', () => new AuroraStore(store.dir).getSettings()).connectionUpdatedAt, stamp);
  });
  check('Missing or invalid legacy timestamps get one durable baseline instead of moving on every read', () => {
    for (const invalid of [undefined, 'not-a-date']) {
      const store = new AuroraStore(path.join(scratch, 'connection-no-stamp-' + String(invalid)));
      store.settings.write({ ...store.getSettings(), connectionUpdatedAt: invalid, updatedAt: invalid });
      const first = at('2026-04-01T00:00:00.000Z', () => store.getSettings());
      assert.equal(first.connectionUpdatedAt, '2026-04-01T00:00:00.000Z'); assert.equal(first.updatedAt, first.connectionUpdatedAt);
      assert.equal(at('2026-04-02T00:00:00.000Z', () => new AuroraStore(store.dir).getSettings()).connectionUpdatedAt, first.connectionUpdatedAt);
    }
  });
  check('Import advances the connection baseline regardless of imported timestamp or unchanged endpoint', () => {
    const store = at('2026-05-01T00:00:00.000Z', () => new AuroraStore(path.join(scratch, 'connection-import')));
    const backup = store.exportAll(); backup.settings.connectionUpdatedAt = '2000-01-01T00:00:00.000Z';
    at('2026-05-02T00:00:00.000Z', () => store.importAll(backup));
    assert.equal(store.getSettings().connectionUpdatedAt, '2026-05-02T00:00:00.000Z');
    assert.equal(new AuroraStore(store.dir).getSettings().connectionUpdatedAt, store.getSettings().connectionUpdatedAt);
  });
  check('Failed connection setting writes retain the previous durable revision', () => {
    const store = new AuroraStore(path.join(scratch, 'connection-failure')), before = store.getSettings(), file = path.join(store.dir, 'settings.json'), bytes = fs.readFileSync(file, 'utf8');
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === file) throw Error('fixture-write-failure'); return rename(from, to); };
    try { assert.throws(() => store.saveSettings({ gatewayPort: 4555 })); }
    finally { fs.renameSync = rename; }
    assert.equal(store.getSettings().connectionUpdatedAt, before.connectionUpdatedAt); assert.equal(store.getSettings().gatewayPort, before.gatewayPort); assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  });
  check('Deleting agents.json between snapshot read and validation rejects stale state and clears the cache', () => {
    const store = new AuroraStore(path.join(scratch, 'snapshot-delete'));
    store.saveAgent({ id: 'codex-cli', connected: true, providerId: 'fixture' });
    const file = path.join(store.dir, 'agents.json'), originalRead = store.agents.read.bind(store.agents);
    let removed = false;
    store.agents.read = () => { const result = originalRead(); if (!removed) { removed = true; fs.unlinkSync(file); } return result; };
    try { assert.throws(() => store.readAgentSnapshot(), /读取期间已变化/); }
    finally { store.agents.read = originalRead; }
    assert.equal(fs.existsSync(file), false); assert.deepEqual(store.listAgents(), {});
    assert.deepEqual(store.readAgentSnapshot(), { states: {}, revision: null });
  });
  check('Creating agents.json during an initially absent snapshot is detected without erasing the new client', () => {
    const store = new AuroraStore(path.join(scratch, 'snapshot-create')), file = path.join(store.dir, 'agents.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const originalRead = store.agents.read.bind(store.agents), external = { 'gemini-cli': { id: 'gemini-cli', connected: true } };
    store.agents.read = () => { const result = originalRead(); fs.writeFileSync(file, JSON.stringify(external)); return result; };
    try { assert.throws(() => store.readAgentSnapshot(), /配置已变化|读取期间已变化/); }
    finally { store.agents.read = originalRead; }
    assert.deepEqual(read(file), external); assert.deepEqual(store.listAgents(), external);
  });
  check('A consistently absent agent file yields an empty snapshot that can commit through CAS', () => {
    const store = new AuroraStore(path.join(scratch, 'snapshot-absent')), file = path.join(store.dir, 'agents.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const snapshot = store.readAgentSnapshot(); assert.deepEqual(snapshot, { states: {}, revision: null });
    store.saveAgentsIfUnchanged([{ id: 'claude-code', connected: false }], snapshot);
    assert.equal(read(file)['claude-code'].connected, false);
  });
  console.log(`\nSettings policy: ${passed} checks passed.`);
} finally {
  assert(path.basename(scratch).startsWith('aurora-settings-policy-'));
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
