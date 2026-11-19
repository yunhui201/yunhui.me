/** Shared Codex configuration through the full action layer, without any real desktop or profile. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-desktop-config-')));
try {
  const bundle = path.join(scratch, 'api.cjs');
  await build({ stdin: { contents: "export * from './src/core/actions.ts'; export * from './src/core/store/index.ts'; export * from './src/core/agents/adapters.ts'; export { codexHome } from './src/core/codex.ts';", resolveDir: workspace, loader: 'ts' }, bundle: true, outfile: bundle, platform: 'node', format: 'cjs', logLevel: 'silent' });
  for (const [input, output] of [['src/core/readOnlyWorker.ts', 'read-only-worker.cjs'], ['src/core/agents/detectionWorker.ts', 'detection-worker.cjs']]) {
    await build({ entryPoints: [path.join(workspace, input)], outfile: path.join(scratch, output), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', banner: { js: "for(const method of ['execFileSync','execSync','spawnSync','spawn','exec','execFile'])require('node:child_process')[method]=()=>{throw new Error('Fixture blocks host processes')};" } });
  }
  const worker = path.join(scratch, 'worker.cjs');
  fs.writeFileSync(worker, String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
// A missing desktop must not launch a client, enumerate the real host or call an upstream.
for (const method of ['execFileSync', 'execSync', 'spawnSync', 'spawn', 'exec', 'execFile']) childProcess[method] = () => { throw new Error('Fixture blocks host processes'); };
for (const protocol of ['node:http', 'node:https']) require(protocol).request = () => { throw new Error('Fixture blocks network'); };
globalThis.fetch = () => { throw new Error('Fixture blocks network'); };
const api = require(process.argv[2]);
const root = process.argv[3], mode = process.argv[4];
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const read = file => fs.readFileSync(file, 'utf8');
let passed = 0;
const test = async (label, fn) => { await fn(); passed++; console.log('PASS ' + mode + ': ' + label); };
(async () => {
  const expectedHome = mode === 'isolated' ? path.join(process.env.AURORA_CLIENT_HOME, '.codex') : process.env.CODEX_HOME;
  assert.equal(api.codexHome(), expectedHome);
  assert.equal(os.homedir(), process.env.USERPROFILE);
  const desktop = api.getAdapter('chatgpt-desktop'), cli = api.getAdapter('codex-cli');
  const file = path.join(expectedHome, 'config.toml'), authFile = path.join(expectedHome, 'auth.json');
  const untouchedHome = mode === 'isolated' ? process.env.CODEX_HOME : path.join(os.homedir(), '.codex');
  const untouchedFile = path.join(untouchedHome, 'config.toml');
  const untouched = '# unrelated client profile\nmodel = "untouched"\n';
  write(untouchedFile, untouched);
  const original = '# preserve comments\nmodel = "previous-model"\nmodel_provider = "previous"\nmodel_reasoning_effort = "high"\n\n[model_providers.previous]\nbase_url = "https://previous.invalid/v1"\nwire_api = "responses"\n\n[mcp_servers.keep]\ncommand = "fixture-only"\nargs = ["keep"]\n';
  const auth = Buffer.from('{\r\n  "auth_mode": "chatgpt", "tokens": {"access_token":"fixture-only-private-token", "refresh_token":"fixture-refresh-token"}\r\n}\r\n');
  write(file, original); write(authFile, auth);
  const assertPrivateFiles = () => { assert.deepEqual(fs.readFileSync(authFile), auth); assert.equal(read(untouchedFile), untouched); };
  const store = new api.AuroraStore(path.join(root, 'store'));
  store.saveSettings({ gatewayToken: 'fixture-local-gateway-secret', gatewayPort: 3425 });
  const provider = store.saveProvider({ name: 'Fixture', format: 'openai-responses', baseUrl: 'https://fixture.invalid/v1', enabled: true, models: [{ id: 'fixture-model', contextWindow: 123456 }], apiKeys: [{ id: 'fixture-key', key: 'fixture-provider-secret', enabled: true, weight: 1 }] });
  const deps = { store, dataDir: store.dir, version: '0.6.0', gatewayStatus: () => ({ running: true }), gatewayUrl: () => 'http://127.0.0.1:3425',
    historyContext: { home: expectedHome, sqliteHome: expectedHome, blockingProcesses: async () => [] } };
  const selected = { agentId: 'chatgpt-desktop', providerId: provider.id, model: 'fixture-model', mode: 'gateway', authMode: 'api' };
  const call = (action, payload = selected) => api.runAction(deps, action, payload);
  let preview;
  await test('existing shared config is available with no desktop executable', () => {
    assert.equal(desktop.configPaths()[0], file); assert.equal(cli.configPaths()[0], file);
    const detected = desktop.detect(); assert.equal(detected.installed, false); assert.equal(detected.configured, true); assert.equal(detected.supportsCodexConfig, false);
    assert.equal(desktop.support, 'automatic');
  });
  await test('action preview is read-only, redacted and explains unverified desktop support', async () => {
    preview = await call('agent.preview'); assert(preview.ok, preview.message); assert(preview.revision); assert.equal(preview.files.length, 1); assert.equal(preview.files[0].path, file);
    assert(preview.warnings.some(message => message.includes('共享编程配置')));
    const serialized = JSON.stringify(preview); for (const secret of ['fixture-provider-secret', 'fixture-local-gateway-secret', 'fixture-only-private-token']) assert(!serialized.includes(secret));
    assert.equal(read(file), original); assertPrivateFiles(); assert(!fs.existsSync(path.join(expectedHome, '.aurora-backups')));
  });
  await test('action applies config and synchronizes all shared client states without changing auth', async () => {
    const result = await call('agent.connect', { ...selected, revision: preview.revision }); assert(result.ok, result.message);
    const text = read(file); assert(text.includes('model_provider = "yunhui"')); assert(text.includes('model_context_window = 123456')); assert(text.includes('[mcp_servers.keep]')); assert(text.includes('# preserve comments')); assert(text.includes('requires_openai_auth = false'));
    for (const id of ['codex-cli', 'chatgpt-desktop', 'codex-desktop']) { const state = store.listAgents()[id]; assert.equal(state.connected, true); assert.equal(state.configPath, file); assert.equal(state.backupPath, result.backup); }
    const manifest = JSON.parse(read(result.backup)); assert.deepEqual(manifest.files.map(item => item.path), [file]); assertPrivateFiles();
  });
  await test('diagnostics separate missing desktop capability from valid shared configuration', async () => {
    const result = await call('agent.diagnose', { agentId: 'chatgpt-desktop' }); assert(result.ok, result.message);
    const checks = new Map(result.checks.map(item => [item.id, item]));
    for (const id of ['location', 'support', 'format', 'parameters', 'backup', 'drift']) assert.equal(checks.get(id).status, 'ok', id);
    assert.equal(checks.get('installation').status, 'info'); assert.equal(checks.get('desktop-capability').status, 'warning');
    assert(!result.checks.some(item => item.status === 'error')); assertPrivateFiles();
  });
  await test('shared alias restores the exact original config and clears CLI/desktop state', async () => {
    const result = await call('agent.disconnect', { agentId: 'codex-desktop' }); assert(result.ok, result.message); assert.equal(read(file), original);
    for (const id of ['codex-cli', 'chatgpt-desktop', 'codex-desktop']) assert.equal(store.listAgents()[id].connected, false);
    assertPrivateFiles();
  });
  await test('a concurrent config edit rejects a stale action preview without overwriting it', async () => {
    const stale = await call('agent.preview'); assert(stale.ok, stale.message);
    const external = original + '\n# external edit after preview\n'; write(file, external);
    const result = await call('agent.connect', { ...selected, revision: stale.revision }); assert.equal(result.ok, false); assert.match(result.message, /预览后已变化/); assert.equal(read(file), external);
    assert.equal(store.listAgents()['codex-cli'].connected, false); assertPrivateFiles(); write(file, original);
  });
  await test('a new shared config can be created and removed on restore before desktop installation', async () => {
    fs.unlinkSync(file); assert.equal(desktop.detect().configured, false);
    const fresh = await call('agent.preview'); assert(fresh.ok, fresh.message); assert.equal(fs.existsSync(file), false);
    const result = await call('agent.connect', { ...selected, revision: fresh.revision }); assert(result.ok, result.message); assert(fs.existsSync(file));
    const restored = await call('agent.disconnect', { agentId: 'codex-cli' }); assert(restored.ok, restored.message); assert.equal(fs.existsSync(file), false); assertPrivateFiles();
  });
  console.log('RESULT ' + passed);
})().catch(error => { console.error(error); process.exitCode = 1; });
`);
  let passed = 0;
  for (const mode of ['isolated', 'custom-codex-home']) {
    const root = path.join(scratch, mode), home = path.join(root, 'user');
    fs.mkdirSync(home, { recursive: true });
    // Do not inherit secrets, client-home overrides or any real user search paths.
    const env = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(root, 'custom-codex'), APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), ProgramData: path.join(root, 'ProgramData'), ProgramFiles: path.join(root, 'ProgramFiles'), 'ProgramFiles(x86)': path.join(root, 'ProgramFilesX86'), TEMP: root, TMP: root, SystemRoot: process.env.SystemRoot || '', WINDIR: process.env.WINDIR || '', LANG: 'en_US.UTF-8' };
    if (mode === 'isolated') env.AURORA_CLIENT_HOME = path.join(root, 'isolated-client');
    const result = spawnSync(process.execPath, [worker, bundle, root, mode], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    console.log(result.stdout.trim());
    const count = /RESULT (\d+)/.exec(result.stdout); assert(count); passed += Number(count[1]);
  }
  console.log(`\nDesktop shared configuration: ${passed} checks passed.`);
} finally {
  assert(path.basename(scratch).startsWith('aurora-desktop-config-'));
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
