/** Explicit native permissions and optional first-run state, entirely in disposable homes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { parse } from 'smol-toml';
import ts from 'typescript';
import { runInNewContext } from 'node:vm';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-permissions-')));
const priorHome = process.env.AURORA_CLIENT_HOME;
const read = file => fs.readFileSync(file, 'utf8');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
let checks = 0;
const test = async (name, body) => { await body(); checks++; console.log('PASS ' + name); };
try {
  const bundle = path.join(root, 'core.cjs');
  await build({ stdin: { contents: "export * from './src/core/agents/adapters.ts';export * from './src/core/store/index.ts';export * from './src/core/actions.ts';", loader: 'ts', resolveDir: path.resolve(import.meta.dirname, '..') }, outfile: bundle, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  function fixture(name, id = 'codex-cli', original = '') {
    const client = path.join(root, name, 'client'); process.env.AURORA_CLIENT_HOME = client;
    const adapter = api.getAdapter(id), config = adapter.configPaths()[0];
    if (original) write(config, original);
    const store = new api.AuroraStore(path.join(root, name, 'store'));
    const provider = store.saveProvider({ name: 'Fixture', format: id === 'claude-code' ? 'anthropic' : 'openai-responses', baseUrl: 'https://fixture.invalid/v1', enabled: true,
      models: [{ id: 'fixture-model' }], apiKeys: [{ id: 'fixture', key: 'fixture-private-api-key', enabled: true, weight: 1 }] });
    const context = { provider, model: 'fixture-model', mode: 'gateway', authMode: 'api', gatewayUrl: 'http://127.0.0.1:3425', token: 'fixture-gateway-key' };
    return { client, adapter, config, original, store, context };
  }
  function preview(f, patch = {}) { const result = f.adapter.preview({ ...f.context, ...patch }); assert.equal(result.ok, true, result.message); assert(!JSON.stringify(result).includes('fixture-private-api-key')); return result; }
  function apply(f, patch = {}) { const p = preview(f, patch); const result = f.adapter.connect({ ...f.context, ...patch, expectedRevision: p.revision }); assert.equal(result.ok, true, result.message); return result; }
  const codexOriginal = '# original permissions\nprofile = "work.v2"\napproval_policy = "on-request"\ndefault_permissions = "locked"\nforced_login_method = "chatgpt"\n[permissions.locked.filesystem]\n":workspace_roots" = "read"\n[profiles."work.v2"]\napproval_policy = "on-request"\ndefault_permissions = "locked"\nforced_login_method = "chatgpt"\nmodel_reasoning_effort = "high"\n[profiles.other]\napproval_policy = "on-request"\nsandbox_mode = "read-only"\n[mcp_servers.keep]\ncommand = "fixture"\n';
  await test('default API setup preserves native permissions, removes only user forced ChatGPT login and creates no account', () => {
    const f = fixture('default', 'codex-cli', codexOriginal), auth = path.join(f.client, '.codex', 'auth.json');
    const result = apply(f), parsed = parse(read(f.config)), before = parse(codexOriginal);
    for (const key of ['approval_policy', 'default_permissions', 'permissions']) assert.deepEqual(parsed[key], before[key]);
    assert.equal(parsed.sandbox_mode, undefined); assert.equal(parsed.forced_login_method, undefined);
    assert.equal(parsed.profiles['work.v2'].forced_login_method, undefined);
    assert.equal(parsed.profiles['work.v2'].approval_policy, 'on-request');
    assert.equal(fs.existsSync(auth), false); assert.equal(parsed.model_providers.yunhui.requires_openai_auth, false);
    assert(f.adapter.disconnect(result.backup).ok); assert.equal(read(f.config), codexOriginal);
  });
  await test('explicit full access updates root and active profile while retaining named and inactive policies', () => {
    const f = fixture('full', 'codex-cli', codexOriginal), p = preview(f, { permissionMode: 'full-access' });
    assert.equal(read(f.config), codexOriginal); assert(p.warnings.some(message => message.includes('不再逐项请求批准')));
    const result = apply(f, { permissionMode: 'full-access' }), parsed = parse(read(f.config));
    for (const layer of [parsed, parsed.profiles['work.v2']]) { assert.equal(layer.approval_policy, 'never'); assert.equal(layer.sandbox_mode, 'danger-full-access'); assert.equal(layer.default_permissions, undefined); }
    assert.deepEqual(parsed.permissions, parse(codexOriginal).permissions); assert.deepEqual(parsed.profiles.other, parse(codexOriginal).profiles.other);
    assert.equal(parsed.mcp_servers.keep.command, 'fixture'); assert(f.adapter.disconnect(result.backup).ok); assert.equal(read(f.config), codexOriginal);
  });
  await test('changing permission mode invalidates an already reviewed client configuration', () => {
    const f = fixture('revision', 'codex-cli', codexOriginal), before = preview(f);
    const result = f.adapter.connect({ ...f.context, permissionMode: 'full-access', expectedRevision: before.revision });
    assert.equal(result.ok, false); assert.match(result.message, /预览后已变化/); assert.equal(read(f.config), codexOriginal);
  });
  await test('unsupported permission and onboarding selections are rejected without writes', () => {
    const f = fixture('unsupported');
    for (const patch of [{ permissionMode: 'invalid' }, { skipOnboarding: true }, { skipOnboarding: 'true' }]) assert.equal(f.adapter.preview({ ...f.context, ...patch }).ok, false);
    assert.equal(api.getAdapter('workbuddy').preview({ ...f.context, permissionMode: 'full-access' }).ok, false);
    assert.equal(fs.existsSync(f.config), false);
  });
  const claudeOriginal = JSON.stringify({ env: { CUSTOM: 'keep' }, permissions: { defaultMode: 'plan', deny: ['Bash(rm:*)'] }, mcpServers: { keep: { command: 'fixture' } } }, null, 2) + '\n';
  await test('Claude default setup touches only settings and preserves permissions and account state', () => {
    const f = fixture('claude-default', 'claude-code', claudeOriginal), global = f.adapter.configPaths()[1];
    const p = preview(f); assert.equal(p.files.length, 1); assert.equal(fs.existsSync(global), false);
    const result = apply(f), parsed = JSON.parse(read(f.config));
    assert.deepEqual(parsed.permissions, JSON.parse(claudeOriginal).permissions); assert.equal(parsed.skipDangerousModePermissionPrompt, undefined);
    assert.equal(parsed.env.ANTHROPIC_AUTH_TOKEN, f.context.token); assert.equal(fs.existsSync(global), false);
    assert(f.adapter.disconnect(result.backup).ok); assert.equal(read(f.config), claudeOriginal);
  });
  await test('Claude full access preserves deny rules and native first-use confirmation', () => {
    const f = fixture('claude-full', 'claude-code', claudeOriginal), result = apply(f, { permissionMode: 'full-access' });
    const parsed = JSON.parse(read(f.config)); assert.equal(parsed.permissions.defaultMode, 'bypassPermissions');
    assert.deepEqual(parsed.permissions.deny, ['Bash(rm:*)']); assert.equal(parsed.skipDangerousModePermissionPrompt, undefined);
    assert(f.adapter.disconnect(result.backup).ok); assert.equal(read(f.config), claudeOriginal);
  });
  await test('Claude restrictions fail clearly without removing configured policy or cloud authentication', () => {
    for (const [name, value] of Object.entries({ permission: { permissions: { disableBypassPermissionsMode: 'disable' } }, malformed: { permissions: [] }, login: { forceLoginMethod: 'claudeai' }, organization: { forceLoginOrgUUID: 'fixture-org' }, cloud: { env: { CLAUDE_CODE_USE_BEDROCK: '1' } } })) {
      const original = JSON.stringify(value), f = fixture('restricted-' + name, 'claude-code', original);
      for (const operation of ['preview', 'connect']) { const result = f.adapter[operation]({ ...f.context, permissionMode: 'full-access' }); assert.equal(result.ok, false); }
      assert.equal(read(f.config), original);
    }
  });
  await test('optional Claude onboarding is previewed, backed up, redacted and restored without altering account fields', () => {
    const f = fixture('onboarding', 'claude-code', claudeOriginal), global = f.adapter.configPaths()[1];
    const original = '{\r\n"hasCompletedOnboarding":false,"oauthAccount":{"accountUuid":"fixture-account"},"mcpServers":{"keep":{"env":{"TOKEN":"fixture-account-secret"}}}\r\n}';
    write(global, original);
    const p = preview(f, { skipOnboarding: true }); assert.equal(p.files.length, 2); assert(!JSON.stringify(p).includes('fixture-account-secret')); assert.equal(read(global), original);
    const result = apply(f, { skipOnboarding: true }), parsed = JSON.parse(read(global));
    assert.equal(parsed.hasCompletedOnboarding, true); delete parsed.hasCompletedOnboarding;
    const before = JSON.parse(original); delete before.hasCompletedOnboarding; assert.deepEqual(parsed, before);
    assert(f.adapter.disconnect(result.backup).ok); assert.equal(read(global), original); assert.equal(read(f.config), claudeOriginal);
  });
  await test('old single-file backups grow to include onboarding and retain both originals when the option is later cleared', () => {
    const f = fixture('upgrade', 'claude-code', claudeOriginal), global = f.adapter.configPaths()[1];
    const first = apply(f); assert.equal(JSON.parse(read(first.backup)).files.length, 1);
    const second = apply(f, { skipOnboarding: true, previousBackup: first.backup }); assert.equal(JSON.parse(read(second.backup)).files.length, 2);
    assert.equal(JSON.parse(read(global)).hasCompletedOnboarding, true);
    const before = fs.statSync(global).mtimeMs;
    const third = apply(f, { skipOnboarding: false, previousBackup: second.backup });
    assert.equal(JSON.parse(read(third.backup)).files.length, 2); assert.equal(fs.statSync(global).mtimeMs, before);
    assert(f.adapter.disconnect(third.backup).ok); assert.equal(fs.existsSync(global), false); assert.equal(read(f.config), claudeOriginal);
  });
  await test('malformed or externally changed onboarding files are not silently overwritten', () => {
    const f = fixture('onboarding-conflict', 'claude-code', claudeOriginal), global = f.adapter.configPaths()[1];
    write(global, '{ broken'); assert.equal(f.adapter.preview({ ...f.context, skipOnboarding: true }).ok, false); assert.equal(read(global), '{ broken');
    write(global, '{}'); const first = apply(f, { skipOnboarding: true });
    write(global, '{"hasCompletedOnboarding":false,"newNativeState":true}');
    const second = f.adapter.connect({ ...f.context, skipOnboarding: false, previousBackup: first.backup });
    assert.equal(second.ok, false); assert.equal(f.adapter.disconnect(first.backup).ok, false); assert.equal(JSON.parse(read(global)).newNativeState, true);
  });
  await test('native Claude runtime fields survive supplier switches and managed-field restoration for new and existing files', () => {
    for (const original of [null, '{"hasCompletedOnboarding":false,"oauthAccount":{"id":"original"},"numStartups":1}\n', '{"oauthAccount":{"id":"original"}}\n']) {
      const f = fixture('runtime-' + checks + '-' + String(original?.length), 'claude-code', claudeOriginal), global = f.adapter.configPaths()[1];
      if (original !== null) write(global, original);
      const first = apply(f, { skipOnboarding: true });
      const native = { ...JSON.parse(read(global)), numStartups: 7, projects: { '/fixture/project': { trusted: true } }, oauthAccount: { id: 'native-updated-account' } };
      write(global, JSON.stringify(native) + '\n');
      const next = apply(f, { skipOnboarding: false, previousBackup: first.backup }); assert.deepEqual(JSON.parse(read(global)), native);
      const restored = f.adapter.disconnect(next.backup); assert(restored.ok, restored.message);
      const expected = { ...native }; if (original && Object.hasOwn(JSON.parse(original), 'hasCompletedOnboarding')) expected.hasCompletedOnboarding = JSON.parse(original).hasCompletedOnboarding; else delete expected.hasCompletedOnboarding;
      assert.deepEqual(JSON.parse(read(global)), expected); assert.equal(read(f.config), claudeOriginal);
    }
  });
  await test('legacy whole-file onboarding backups remain strict and ownership markers cannot apply to settings', () => {
    const f = fixture('legacy-global', 'claude-code', claudeOriginal), global = f.adapter.configPaths()[1];
    const first = apply(f, { skipOnboarding: true }), manifest = JSON.parse(read(first.backup));
    delete manifest.files[1].ownedJson; write(first.backup, JSON.stringify(manifest));
    const native = { hasCompletedOnboarding: true, numStartups: 2 }; write(global, JSON.stringify(native));
    assert.equal(f.adapter.connect({ ...f.context, skipOnboarding: true, previousBackup: first.backup }).ok, false);
    assert.equal(f.adapter.disconnect(first.backup).ok, false); assert.deepEqual(JSON.parse(read(global)), native);
    manifest.files[0].ownedJson = 'claude-onboarding-v1'; write(first.backup, JSON.stringify(manifest));
    assert.equal(f.adapter.disconnect(first.backup).ok, false); assert.deepEqual(JSON.parse(read(global)), native);
  });
  await test('runtime-field edits after preview reject the old revision before any write', () => {
    const f = fixture('runtime-stale', 'claude-code', claudeOriginal), global = f.adapter.configPaths()[1];
    const first = apply(f, { skipOnboarding: true }), p = preview(f, { skipOnboarding: true, previousBackup: first.backup });
    const config = read(f.config); write(global, '{"hasCompletedOnboarding":true,"numStartups":2}');
    const result = f.adapter.connect({ ...f.context, skipOnboarding: true, previousBackup: first.backup, expectedRevision: p.revision });
    assert.equal(result.ok, false); assert.match(result.message, /预览后已变化/); assert.equal(read(f.config), config); assert.equal(JSON.parse(read(global)).numStartups, 2);
  });
  await test('Claude global onboarding path follows both default and custom configuration directories', () => {
    const home = path.join(root, 'path-user'), custom = path.join(root, 'custom-claude');
    fs.mkdirSync(home, { recursive: true });
    for (const [dir, expected] of [[undefined, path.join(home, '.claude.json')], [path.join(home, '.claude'), path.join(home, '.claude.json')], [custom, path.join(custom, '.claude.json')]]) {
      const env = { HOME: home, USERPROFILE: home, SYSTEMROOT: process.env.SYSTEMROOT || '' };
      if (dir) env.CLAUDE_CONFIG_DIR = dir;
      const result = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).getAdapter("claude-code").configPaths()))', bundle], { env, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), [path.join(dir || path.join(home, '.claude'), 'settings.json'), expected]);
    }
  });
  await test('action apply, diagnostics and restore share optional-file and permission choices', async () => {
    const f = fixture('action-options', 'claude-code', claudeOriginal);
    const deps = { store: f.store, dataDir: f.store.dir, gatewayStatus: () => ({ running: true }), gatewayUrl: () => f.context.gatewayUrl };
    const selection = { agentId: 'claude-code', providerId: f.context.provider.id, model: f.context.model, mode: 'gateway', permissionMode: 'full-access', skipOnboarding: true };
    const p = await api.runAction(deps, 'agent.preview', selection); assert(p.ok, p.message);
    const result = await api.runAction(deps, 'agent.connect', { ...selection, revision: p.revision }); assert(result.ok, result.message);
    const state = f.store.listAgents()['claude-code']; assert.equal(state.permissionMode, 'full-access'); assert.equal(state.skipOnboarding, true);
    let diagnostic = await api.runAction(deps, 'agent.diagnose', { agentId: 'claude-code' });
    assert.equal(diagnostic.checks.find(check => check.id === 'parameters').status, 'ok');
    const installed = read(f.config), external = JSON.parse(installed); external.permissions.defaultMode = 'plan'; write(f.config, JSON.stringify(external, null, 2) + '\n');
    diagnostic = await api.runAction(deps, 'agent.diagnose', { agentId: 'claude-code' });
    assert.equal(diagnostic.checks.find(check => check.id === 'parameters').status, 'warning');
    write(f.config, installed);
    const restored = await api.runAction(deps, 'agent.disconnect', { agentId: 'claude-code' }); assert(restored.ok, restored.message);
    assert.equal(read(f.config), claudeOriginal); assert.equal(fs.existsSync(f.adapter.configPaths()[1]), false);
  });
  await test('optional onboarding files roll back with settings when persisting agent state fails', async () => {
    const f = fixture('action-state-failure', 'claude-code', claudeOriginal);
    const deps = { store: f.store, dataDir: f.store.dir, gatewayStatus: () => ({ running: true }), gatewayUrl: () => f.context.gatewayUrl };
    f.store.saveAgents = () => { throw new Error('fixture-state-failure-secret'); };
    const result = await api.runAction(deps, 'agent.connect', { agentId: 'claude-code', providerId: f.context.provider.id, model: f.context.model, permissionMode: 'full-access', skipOnboarding: true });
    assert.equal(result.ok, false); assert(!JSON.stringify(result).includes('fixture-state-failure-secret'));
    assert.equal(read(f.config), claudeOriginal); assert.equal(fs.existsSync(f.adapter.configPaths()[1]), false);
  });
  await test('diagnostics and failed disconnect preserve native runtime updates with an owned onboarding marker', async () => {
    const f = fixture('runtime-action-restore', 'claude-code', claudeOriginal), global = f.adapter.configPaths()[1];
    const deps = { store: f.store, dataDir: f.store.dir, gatewayStatus: () => ({ running: true }), gatewayUrl: () => f.context.gatewayUrl };
    const selection = { agentId: 'claude-code', providerId: f.context.provider.id, model: f.context.model, skipOnboarding: true };
    const first = await api.runAction(deps, 'agent.connect', selection); assert(first.ok, first.message);
    const installed = read(f.config), native = '{"hasCompletedOnboarding":true,"numStartups":4,"oauthAccount":{"id":"native-account"}}\n'; write(global, native);
    const diagnostic = await api.runAction(deps, 'agent.diagnose', { agentId: 'claude-code' });
    for (const id of ['parameters', 'backup', 'drift']) assert.equal(diagnostic.checks.find(check => check.id === id).status, 'ok', id);
    const save = f.store.saveAgents.bind(f.store); f.store.saveAgents = () => { throw new Error('fixture-failure-after-merged-restore'); };
    const failed = await api.runAction(deps, 'agent.disconnect', { agentId: 'claude-code' });
    assert.equal(failed.ok, false); assert.equal(read(f.config), installed); assert.equal(read(global), native); assert.equal(f.store.listAgents()['claude-code'].connected, true);
    f.store.saveAgents = save; const restored = await api.runAction(deps, 'agent.disconnect', { agentId: 'claude-code' });
    assert(restored.ok, restored.message); assert.deepEqual(JSON.parse(read(global)), { numStartups: 4, oauthAccount: { id: 'native-account' } }); assert.equal(read(f.config), claudeOriginal);
  });
  await test('failed repeated application keeps current runtime fields and the original managed-field backup', async () => {
    const f = fixture('runtime-action-apply', 'claude-code', claudeOriginal), global = f.adapter.configPaths()[1];
    write(global, '{"hasCompletedOnboarding":false,"numStartups":1}\n');
    const deps = { store: f.store, dataDir: f.store.dir, gatewayStatus: () => ({ running: true }), gatewayUrl: () => f.context.gatewayUrl };
    const selection = { agentId: 'claude-code', providerId: f.context.provider.id, model: f.context.model, skipOnboarding: true };
    const first = await api.runAction(deps, 'agent.connect', selection); assert(first.ok, first.message);
    const installed = read(f.config), native = '{"hasCompletedOnboarding":true,"numStartups":9}\n'; write(global, native);
    f.store.saveAgents = () => { throw new Error('fixture-repeat-state-failure'); };
    const result = await api.runAction(deps, 'agent.connect', { ...selection, permissionMode: 'full-access' });
    assert.equal(result.ok, false); assert.equal(read(f.config), installed); assert.equal(read(global), native); assert.equal(f.store.listAgents()['claude-code'].backupPath, first.backup);
    const restored = f.adapter.disconnect(first.backup); assert(restored.ok, restored.message); assert.deepEqual(JSON.parse(read(global)), { hasCompletedOnboarding: false, numStartups: 9 });
  });
  await test('an external native edit during restore wins the full-file compare-and-swap', () => {
    const f = fixture('runtime-cas', 'claude-code', claudeOriginal), global = f.adapter.configPaths()[1];
    const first = apply(f, { skipOnboarding: true }), installed = read(f.config), external = '{"hasCompletedOnboarding":true,"numStartups":11}\n';
    write(global, '{"hasCompletedOnboarding":true,"numStartups":10}\n');
    const rename = fs.renameSync; let injected = false;
    fs.renameSync = (from, to) => { const result = rename(from, to); if (to === f.config && !injected) { injected = true; write(global, external); } return result; };
    let result; try { result = f.adapter.disconnect(first.backup); } finally { fs.renameSync = rename; }
    assert.equal(result.ok, false); assert.equal(read(global), external); assert.equal(read(f.config), installed);
  });
  await test('native changes while preparing a temporary replacement are rechecked before rename', () => {
    const f = fixture('runtime-pre-rename', 'claude-code', claudeOriginal), global = f.adapter.configPaths()[1];
    write(global, '{"hasCompletedOnboarding":false,"numStartups":1}\n');
    const external = '{"hasCompletedOnboarding":false,"numStartups":22}\n', writeFile = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = (file, ...args) => { const result = writeFile(file, ...args); if (String(file).startsWith(global + '.aurora-') && !injected) { injected = true; writeFile(global, external); } return result; };
    let result; try { result = f.adapter.connect({ ...f.context, skipOnboarding: true }); } finally { fs.writeFileSync = writeFile; }
    assert.equal(result.ok, false); assert.equal(injected, true); assert.equal(read(global), external); assert.equal(read(f.config), claudeOriginal);
    assert(!fs.readdirSync(path.dirname(global)).some(name => name.endsWith('.tmp')));
  });
  await test('import retains reviewed options without applying client files and rejects malformed option types', () => {
    const f = fixture('import', 'claude-code', claudeOriginal), original = f.store.exportAll();
    const backup = { ...original, agents: { 'claude-code': { id: 'claude-code', connected: true, permissionMode: 'full-access', skipOnboarding: true, authMode: 'api' } } };
    f.store.importAll(backup); const imported = f.store.listAgents()['claude-code'];
    assert.equal(imported.connected, false); assert.equal(imported.permissionMode, 'full-access'); assert.equal(imported.skipOnboarding, true);
    assert.equal(read(f.config), claudeOriginal); assert.equal(fs.existsSync(f.adapter.configPaths()[1]), false);
    for (const patch of [{ permissionMode: 'invalid' }, { skipOnboarding: 'true' }]) assert.throws(() => f.store.importAll({ ...backup, agents: { 'claude-code': { ...backup.agents['claude-code'], ...patch } } }));
  });
  await test('tray supplier switches retain active and imported permission choices without reviving disconnected options', async () => {
    // Execute the actual handler with only its collaborators stubbed. Never
    // import Electron startup or create a real tray, client process or store.
    const source = ts.createSourceFile('index.ts', read(path.join(import.meta.dirname, '../src/main/index.ts')), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const handler = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'trayConnect'); assert(handler);
    const code = ts.transpileModule(handler.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    for (const [agentId, states, expected] of [
      ['claude-code', { 'claude-code': { connected: true, authMode: 'api', permissionMode: 'full-access', skipOnboarding: true } }, { authMode: 'api', permissionMode: 'full-access', skipOnboarding: true }],
      ['claude-code', { 'claude-code': { connected: false, pendingReapply: true, permissionMode: 'full-access', skipOnboarding: true } }, { authMode: 'api', permissionMode: 'full-access', skipOnboarding: true }],
      ['codex-cli', { 'chatgpt-desktop': { connected: true, authMode: 'coexist', permissionMode: 'full-access' } }, { authMode: 'coexist', permissionMode: 'full-access', skipOnboarding: false }],
      ['claude-code', { 'claude-code': { connected: false, permissionMode: 'full-access', skipOnboarding: true } }, { authMode: 'api', permissionMode: 'preserve', skipOnboarding: false }],
      ['claude-code', {}, { authMode: 'api', permissionMode: 'preserve', skipOnboarding: false }],
    ]) {
      const calls = [], errors = [], dependencies = {};
      const trayConnect = runInNewContext(code + '\ntrayConnect;', { store: { listAgents: () => states }, deps: () => dependencies,
        runAction: async (deps, action, payload) => { assert.equal(deps, dependencies); calls.push({ action, payload: JSON.parse(JSON.stringify(payload)) }); return { ok: true }; }, dialog: { showErrorBox: (...args) => errors.push(args) } });
      await trayConnect(agentId, 'fixture-new-supplier', 'fixture-new-model');
      assert.deepEqual(errors, []); assert.deepEqual(calls, [{ action: 'agent.connect', payload: { agentId, providerId: 'fixture-new-supplier', model: 'fixture-new-model', mode: 'gateway', ...expected } }]);
    }
  });
  console.log(`Client permissions and onboarding: ${checks} checks passed.`);
} finally {
  if (priorHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = priorHome;
  assert.equal(fs.realpathSync(path.dirname(root)), fs.realpathSync(os.tmpdir())); assert(path.basename(root).startsWith('yunhui-permissions-'));
  fs.rmSync(root, { recursive: true, force: true });
}
