/** Selective permission recovery: disposable client homes, no client processes or network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { parse } from 'smol-toml';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-permission-restore-')));
const priorHome = process.env.AURORA_CLIENT_HOME, read = file => fs.readFileSync(file, 'utf8');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const aliases = ['codex-cli', 'chatgpt-desktop', 'codex-desktop'];
const codexOriginal = '# Keep comments\nprofile = "work.v2"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\ndefault_permissions = "locked"\n[permissions.locked.filesystem]\n":workspace_roots" = "read"\n[profiles."work.v2"]\napproval_policy = "untrusted"\nmodel_reasoning_effort = "high"\n[profiles.other]\nsandbox_mode = "read-only"\n[mcp_servers.keep]\ncommand = "fixture"\n';
const claudeOriginal = JSON.stringify({ permissions: { defaultMode: 'plan', deny: ['Bash(rm:*)'] }, env: { OTHER: 'keep' }, mcpServers: { private: { env: { TOKEN: 'fixture-mcp-private' } } } }, null, 2) + '\n';
const secrets = ['fixture-key-private', 'fixture-gateway-private', 'fixture-auth-private', 'fixture-mcp-private', 'fixture-error-private'];
const assertSafe = result => { for (const secret of secrets) assert(!JSON.stringify(result).includes(secret)); };
let passed = 0;
const check = async (label, fn) => { await fn(); passed++; console.log('PASS ' + label); };
try {
  const bundle = path.join(root, 'api.cjs');
  await build({ stdin: { contents: "export * from './src/core/actions.ts';export * from './src/core/agents/adapters.ts';export * from './src/core/agents/configFiles.ts';export * from './src/core/store/index.ts';export {REMOTE_ACTIONS} from './src/core/gateway/security.ts';", resolveDir: path.resolve(import.meta.dirname, '..'), loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  async function fixture(name, agentId = 'codex-cli', original = codexOriginal, connectPatch = {}) {
    const client = path.join(root, name, 'client'); process.env.AURORA_CLIENT_HOME = client;
    const adapter = api.getAdapter(agentId), config = adapter.configPaths()[0], store = new api.AuroraStore(path.join(root, name, 'store'));
    if (original !== null) write(config, original);
    const auth = path.join(client, '.codex', 'auth.json'); write(auth, '{"token":"fixture-auth-private"}');
    store.saveSettings({ gatewayToken: 'fixture-gateway-private' });
    const provider = store.saveProvider({ name: 'Fixture', format: agentId === 'claude-code' ? 'anthropic' : 'openai-responses', baseUrl: 'https://fixture.invalid/proxy/v1', enabled: true,
      models: [{ id: 'one' }, { id: 'two' }], apiKeys: [{ id: 'key', key: 'fixture-key-private', enabled: true, weight: 1 }] });
    const historyHome = path.join(client, '.codex');
    const deps = { store, dataDir: store.dir, platform: 'win32', gatewayStatus: () => ({ running: true }), gatewayUrl: () => 'http://127.0.0.1:3425',
      historyContext: { home: historyHome, sqliteHome: historyHome, blockingProcesses: async () => [] } };
    const call = (action, patch = {}) => api.runAction(deps, action, { agentId, ...patch });
    const connect = (patch = {}) => call('agent.connect', { providerId: provider.id, model: 'one', permissionMode: 'full-access', ...connectPatch, ...patch });
    const result = await connect(); assert.equal(result.ok, true, result.message);
    const preview = async (patch = {}) => { const p = await call('agent.permissions.preview', patch); assertSafe(p); return p; };
    const restore = (p, patch = {}) => call('agent.permissions.restore', { revision: p.revision, confirmed: true, ...patch });
    return { adapter, client, config, auth, original, store, provider, deps, call, connect, result, preview, restore };
  }
  const states = f => JSON.stringify(f.store.listAgents());
  const originalBackup = f => JSON.parse(read(f.store.listAgents()[f.adapter.id].backupPath)).files[0];
  const transport = f => f.adapter.id === 'claude-code' ? JSON.parse(read(f.config)).env : parse(read(f.config)).model_providers;
  const unchangedAuth = f => assert.equal(read(f.auth), '{"token":"fixture-auth-private"}');

  await check('Codex restores root and quoted active-profile permissions while preserving transport, other profiles and comments', async () => {
    const f = await fixture('codex'), before = read(f.config), endpoint = transport(f), first = originalBackup(f), p = await f.preview();
    assert(p.ok, p.message); assert.equal(p.changes.length, 6); assert.equal(read(f.config), before);
    const result = await f.restore(p); assert(result.ok, result.message); assertSafe(result);
    const value = parse(read(f.config)), old = parse(codexOriginal);
    for (const key of ['approval_policy', 'sandbox_mode', 'default_permissions']) { assert.equal(value[key], old[key]); assert.equal(value.profiles['work.v2'][key], old.profiles['work.v2'][key]); }
    assert.deepEqual(value.permissions, old.permissions); assert.deepEqual(value.profiles.other, old.profiles.other); assert(read(f.config).includes('# Keep comments')); assert.deepEqual(transport(f), endpoint); unchangedAuth(f);
    for (const id of aliases) { const state = f.store.listAgents()[id]; assert(state.connected); assert.equal(state.providerId, f.provider.id); assert.equal(state.permissionMode, 'preserve'); assert.equal(state.backupPath, f.store.listAgents()['codex-cli'].backupPath); }
    const next = originalBackup(f); assert.equal(next.backup, first.backup); assert.equal(next.originalHash, first.originalHash); assert.equal(next.installedHash, api.digest(read(f.config))); assert.equal(next.permissionScope, undefined);
    assert.equal((await f.connect({ model: 'two', permissionMode: 'preserve' })).ok, true);
    assert.equal(parse(read(f.config)).approval_policy, old.approval_policy);
    assert.equal((await f.call('agent.disconnect', { agentId: 'codex-desktop' })).ok, true); assert.equal(read(f.config), codexOriginal);
  });
  await check('New Codex file loses only managed permission keys and full restore still removes the new file', async () => {
    const f = await fixture('new-codex', 'codex-cli', null), endpoint = transport(f), p = await f.preview();
    assert.equal(originalBackup(f).originalAbsent, true);
    assert(p.ok); assert(p.changes.every(change => change.after.startsWith('未设置'))); assert((await f.restore(p)).ok);
    const value = parse(read(f.config)); for (const key of ['approval_policy', 'sandbox_mode', 'default_permissions']) assert.equal(value[key], undefined);
    assert.deepEqual(transport(f), endpoint); assert.equal((await f.call('agent.disconnect')).ok, true); assert.equal(fs.existsSync(f.config), false);
  });
  await check('Claude restores only defaultMode while preserving deny rules, supplier and onboarding runtime state', async () => {
    const f = await fixture('claude', 'claude-code', claudeOriginal, { skipOnboarding: true }), endpoint = transport(f), global = f.adapter.configPaths()[1];
    write(global, JSON.stringify({ ...JSON.parse(read(global)), runtimeCounter: 3, oauthAccount: { id: 'local-account' } }));
    const globalBefore = read(global), p = await f.preview(); assert(p.ok, p.message); assert.equal(p.changes.length, 1); assert.equal(p.changes[0].after, 'plan');
    assert.equal((await f.restore(p)).ok, true); const value = JSON.parse(read(f.config));
    assert.deepEqual(value.permissions, JSON.parse(claudeOriginal).permissions); assert.deepEqual(value.mcpServers, JSON.parse(claudeOriginal).mcpServers); assert.deepEqual(transport(f), endpoint); assert.equal(read(global), globalBefore); unchangedAuth(f);
    assert.equal((await f.connect({ permissionMode: 'preserve', model: 'two' })).ok, true);
    assert.equal((await f.call('agent.disconnect')).ok, true); assert.equal(read(f.config), claudeOriginal);
    assert.deepEqual(JSON.parse(read(global)), { runtimeCounter: 3, oauthAccount: { id: 'local-account' } });
  });
  await check('Absent Claude defaultMode is removed without removing existing deny rules or inventing a policy', async () => {
    for (const [name, original] of [['none', '{}'], ['deny', '{"permissions":{"deny":["Bash(rm:*)"]}}']]) {
      const f = await fixture('claude-' + name, 'claude-code', original), p = await f.preview(); assert(p.ok); assert((await f.restore(p)).ok);
      assert.deepEqual(JSON.parse(read(f.config)).permissions, JSON.parse(original).permissions);
      assert.equal((await f.call('agent.disconnect')).ok, true); assert.equal(read(f.config), original);
    }
  });
  await check('Original full access is reported honestly and can finish management without lowering native policy', async () => {
    for (const [name, agentId, original] of [['codex', 'codex-cli', 'approval_policy="never"\nsandbox_mode="danger-full-access"\n'], ['claude', 'claude-code', '{"permissions":{"defaultMode":"bypassPermissions"}}']]) {
      const f = await fixture('already-' + name, agentId, original), before = read(f.config), p = await f.preview();
      assert(p.ok); assert.equal(p.alreadyOriginal, true); assert(p.warnings.some(w => /不保证降低|仍会保留/.test(w)));
      const result = await f.restore(p); assert(result.ok); assert.match(result.message, /未降低/); assert.equal(read(f.config), before); assert.equal(f.store.listAgents()[agentId].permissionMode, 'preserve');
    }
  });
  await check('Permission ownership survives a later preserve switch and restoration through the desktop alias', async () => {
    const f = await fixture('preserve'); assert((await f.connect({ permissionMode: 'preserve', model: 'two' })).ok);
    assert.equal(f.store.listAgents()['codex-cli'].permissionMode, 'preserve'); assert.equal(originalBackup(f).permissionScope.kind, 'codex-execution-v1');
    const p = await f.preview({ agentId: 'codex-desktop' }); assert(p.ok, p.message);
    assert((await f.restore(p, { agentId: 'codex-desktop' })).ok); assert.equal(parse(read(f.config)).approval_policy, 'on-request');
    assert.equal((await f.preview()).ok, false, 'Already restored permissions cannot be claimed as managed again');
  });
  await check('Hash-verified older manifests require the saved full-access choice and exact installed policies', async () => {
    const f = await fixture('legacy'), backup = f.store.listAgents()['codex-cli'].backupPath, manifest = JSON.parse(read(backup));
    delete manifest.files[0].permissionScope; write(backup, JSON.stringify(manifest));
    const p = await f.preview(); assert(p.ok, p.message); assert((await f.restore(p)).ok);
    const denied = await fixture('legacy-preserve', 'codex-cli', codexOriginal, { permissionMode: 'preserve' }); assert.equal((await denied.preview()).ok, false);
  });
  await check('Unverified legacy originals refuse selective restore even after supplier switches, while full restore remains compatible', async () => {
    for (const original of [codexOriginal, null]) {
      const f = await fixture('unverified-' + String(original === null), 'codex-cli', original), p = await f.preview(); assert(p.ok);
      const backup = f.store.listAgents()['codex-cli'].backupPath, manifest = JSON.parse(read(backup));
      delete manifest.files[0].originalHash; delete manifest.files[0].originalAbsent; delete manifest.files[0].permissionScope;
      write(backup, JSON.stringify(manifest));
      const before = read(f.config), beforeStates = states(f), beforeManifest = read(backup);
      for (const result of [await f.preview(), await f.restore(p)]) {
        assert.equal(result.ok, false); assert.match(result.message, /旧版备份缺少原始配置校验记录/); assertSafe(result);
      }
      assert.equal(read(f.config), before); assert.equal(states(f), beforeStates); assert.equal(read(backup), beforeManifest);
      assert((await f.connect({ model: 'two', permissionMode: 'preserve' })).ok);
      const afterSwitch = originalBackup(f); assert.equal(afterSwitch.originalHash, undefined); assert.equal(afterSwitch.originalAbsent, undefined);
      const denied = await f.preview(); assert.equal(denied.ok, false); assert.match(denied.message, /旧版备份缺少原始配置校验记录/);
      assert.equal((await f.call('agent.disconnect')).ok, true);
      if (original === null) assert.equal(fs.existsSync(f.config), false); else assert.equal(read(f.config), original);
    }
  });
  await check('An unverified original cannot be silently blessed as an original full-access policy', async () => {
    const f = await fixture('unverified-edited'), backup = f.store.listAgents()['codex-cli'].backupPath, manifest = JSON.parse(read(backup));
    delete manifest.files[0].originalHash; write(backup, JSON.stringify(manifest));
    write(manifest.files[0].backup, 'approval_policy="never"\nsandbox_mode="danger-full-access"\n');
    const before = read(f.config), p = await f.preview();
    assert.equal(p.ok, false); assert.match(p.message, /无法确认首次接入前的权限/); assert.equal(read(f.config), before);
    manifest.files[0].originalAbsent = true; write(backup, JSON.stringify(manifest));
    assert.equal((await f.preview()).ok, false, 'An absence marker cannot certify an existing original file');
  });
  await check('External permission or unrelated config edits are never overwritten', async () => {
    for (const kind of ['permission', 'unrelated']) {
      const f = await fixture('external-' + kind), p = await f.preview(); assert(p.ok);
      const changed = kind === 'permission' ? read(f.config).replace('approval_policy = "never"', 'approval_policy = "on-request"') : read(f.config) + '\n# edited elsewhere\n';
      write(f.config, changed); const beforeStates = states(f), result = await f.restore(p); assert.equal(result.ok, false); assertSafe(result); assert.equal(read(f.config), changed); assert.equal(states(f), beforeStates);
    }
  });
  await check('State and backup changes invalidate preview; tampered original bytes fail checksum checks', async () => {
    const f = await fixture('stale-state'), p = await f.preview(), before = read(f.config);
    f.store.saveAgent({ ...f.store.listAgents()['codex-cli'], model: 'two' }); assert.equal((await f.restore(p)).ok, false); assert.equal(read(f.config), before);
    const g = await fixture('bad-backup'), q = await g.preview(), original = originalBackup(g), installed = read(g.config);
    write(original.backup, read(original.backup).replace('on-request', 'never')); assert.equal((await g.restore(q)).ok, false); assert.equal(read(g.config), installed);
  });
  await check('Disk connection-record changes invalidate the preview and preserve unrelated client records', async () => {
    const f = await fixture('external-state'), p = await f.preview(), before = read(f.config), agentFile = path.join(f.store.dir, 'agents.json');
    const external = JSON.parse(read(agentFile));
    external['gemini-cli'] = { id: 'gemini-cli', connected: true, providerId: 'external-provider', model: 'external-model' };
    external['codex-cli'].model = 'two';
    const externalText = JSON.stringify(external, null, 2); write(agentFile, externalText);
    const result = await f.restore(p); assert.equal(result.ok, false); assert.match(result.message, /预览后已变化/); assertSafe(result);
    assert.equal(read(f.config), before); assert.equal(read(agentFile), externalText); assert.deepEqual(f.store.listAgents(), external);
    const next = await f.preview(); assert(next.ok, next.message); assert((await f.restore(next)).ok);
    const saved = JSON.parse(read(agentFile)); assert.deepEqual(saved['gemini-cli'], external['gemini-cli']); assert.equal(saved['codex-cli'].model, 'two');
  });
  await check('An agents-file edit after config writes triggers CAS rollback without erasing the external record', async () => {
    const f = await fixture('state-after-apply'), p = await f.preview(), before = read(f.config), agentFile = path.join(f.store.dir, 'agents.json');
    const external = { ...JSON.parse(read(agentFile)), 'gemini-cli': { id: 'gemini-cli', connected: true, model: 'external-model' } };
    const externalText = JSON.stringify(external, null, 2), save = f.store.saveAgentsIfUnchanged;
    let sawAppliedConfig = false;
    f.store.saveAgentsIfUnchanged = function (...args) { sawAppliedConfig = read(f.config) !== before; write(agentFile, externalText); return save.apply(this, args); };
    try {
      const result = await f.restore(p); assert.equal(result.ok, false); assert.match(result.message, /已撤回/); assertSafe(result); assert(sawAppliedConfig);
      assert.equal(read(f.config), before); assert.equal(read(agentFile), externalText); assert.deepEqual(f.store.listAgents(), external);
    } finally { f.store.saveAgentsIfUnchanged = save; }
    assert((await f.restore(await f.preview())).ok); assert.equal((await f.call('agent.disconnect')).ok, true); assert.equal(read(f.config), codexOriginal);
  });
  await check('An agents-file edit during temporary-state write is detected immediately before rename', async () => {
    const f = await fixture('state-temp-race'), p = await f.preview(), before = read(f.config), agentFile = path.join(f.store.dir, 'agents.json');
    const external = { ...JSON.parse(read(agentFile)), 'gemini-cli': { id: 'gemini-cli', connected: true, model: 'external-model' } };
    const externalText = JSON.stringify(external, null, 2), rawWrite = fs.writeFileSync;
    let injected = false;
    fs.writeFileSync = (file, ...args) => { const result = rawWrite(file, ...args); if (String(file).startsWith(agentFile + '.') && String(file).endsWith('.tmp')) { injected = true; rawWrite(agentFile, externalText); } return result; };
    try {
      const result = await f.restore(p); assert.equal(result.ok, false); assert.match(result.message, /已撤回/); assertSafe(result); assert(injected);
      assert.equal(read(f.config), before); assert.equal(read(agentFile), externalText); assert.deepEqual(f.store.listAgents(), external);
    } finally { fs.writeFileSync = rawWrite; }
  });
  await check('Missing originals, foreign backup paths and unsupported clients refuse recovery', async () => {
    const f = await fixture('missing-original'); fs.unlinkSync(originalBackup(f).backup); assert.equal((await f.preview()).ok, false);
    const g = await fixture('foreign-backup'), before = read(g.config), external = path.join(root, 'foreign.json'); write(external, '{}');
    g.store.saveAgent({ ...g.store.listAgents()['codex-cli'], backupPath: external }); assert.equal((await g.preview()).ok, false); assert.equal(read(g.config), before);
    assert.equal((await g.preview({ agentId: 'workbuddy' })).ok, false);
  });
  await check('Confirmation, revision, desktop-only policy and payload allowlist cannot be bypassed', async () => {
    const f = await fixture('policy'), p = await f.preview(), before = read(f.config), beforeStates = states(f);
    for (const patch of [{ confirmed: false }, { confirmed: undefined }, { revision: undefined }, { revision: '0'.repeat(64) }, { path: f.config }, { permissionMode: 'full-access' }]) assert.equal((await f.restore(p, patch)).ok, false);
    assert.equal((await api.runAction({ ...f.deps, platform: 'web' }, 'agent.permissions.preview', { agentId: 'codex-cli' })).ok, false);
    for (const action of ['agent.permissions.preview', 'agent.permissions.restore']) assert(!api.REMOTE_ACTIONS.has(action));
    assert.equal(read(f.config), before); assert.equal(states(f), beforeStates);
  });
  await check('Failed atomic connection-state save restores exact config and leaves all shared aliases unchanged', async () => {
    const f = await fixture('state-failure'), p = await f.preview(), before = read(f.config), beforeStates = states(f), beforeManifest = read(f.store.listAgents()['codex-cli'].backupPath);
    const agentFile = path.join(f.store.dir, 'agents.json'), rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === agentFile) throw new Error('fixture-error-private'); return rename(from, to); };
    try { const result = await f.restore(p); assert.equal(result.ok, false); assert.match(result.message, /已撤回/); assertSafe(result); assert.equal(read(f.config), before); assert.equal(states(f), beforeStates); assert.equal(read(f.store.listAgents()['codex-cli'].backupPath), beforeManifest); }
    finally { fs.renameSync = rename; }
    assert((await f.restore(await f.preview())).ok); assert.equal((await f.call('agent.disconnect')).ok, true); assert.equal(read(f.config), codexOriginal);
  });
  await check('Rollback does not erase an external edit made during a failed state save', async () => {
    const f = await fixture('rollback-race'), p = await f.preview(), beforeStates = states(f), save = f.store.saveAgentsIfUnchanged;
    const external = '# other process\nmodel="fixture-external"\n';
    f.store.saveAgentsIfUnchanged = () => { write(f.config, external); throw new Error('fixture-error-private'); };
    try { const result = await f.restore(p); assert.equal(result.ok, false); assert.match(result.message, /其他程序修改|无法回滚/); assertSafe(result); assert.equal(read(f.config), external); assert.equal(states(f), beforeStates); }
    finally { f.store.saveAgentsIfUnchanged = save; }
  });
  await check('Config write failure preserves the original active manifest, full permissions and connection state', async () => {
    const f = await fixture('write-failure'), p = await f.preview(), before = read(f.config), beforeStates = states(f), rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === f.config) throw new Error('fixture-error-private'); return rename(from, to); };
    try { const result = await f.restore(p); assert.equal(result.ok, false); assertSafe(result); assert.equal(read(f.config), before); assert.equal(states(f), beforeStates); }
    finally { fs.renameSync = rename; }
  });
  await check('An edit while preparing the replacement is detected before rename and survives', async () => {
    const f = await fixture('prepare-race'), p = await f.preview(), beforeStates = states(f), rawWrite = fs.writeFileSync;
    const external = read(f.config) + '\n# external concurrent edit\n';
    fs.writeFileSync = (file, ...args) => { const result = rawWrite(file, ...args); if (String(file).startsWith(f.config + '.aurora-')) rawWrite(f.config, external); return result; };
    try { const result = await f.restore(p); assert.equal(result.ok, false); assertSafe(result); assert.equal(read(f.config), external); assert.equal(states(f), beforeStates); }
    finally { fs.writeFileSync = rawWrite; }
  });
  console.log(`\n${passed} selective permission recovery checks passed.`);
} finally {
  if (priorHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = priorHome;
  assert.equal(fs.realpathSync(path.dirname(root)), fs.realpathSync(os.tmpdir())); assert(path.basename(root).startsWith('yunhui-permission-restore-'));
  fs.rmSync(root, { recursive: true, force: true });
}
