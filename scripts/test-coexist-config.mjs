/** Configuration coexistence regressions. Uses only isolated fixture files. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { parse as parseNativeToml } from 'smol-toml';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-coexist-config-'));
const clientHome = path.join(scratch, 'client');
const originalClientHome = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = clientHome;
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const read = file => fs.readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));
const codexDir = path.join(clientHome, '.codex');
const authFile = path.join(codexDir, 'auth.json');
const cacheFile = path.join(codexDir, 'models_cache.json');
const configFile = path.join(codexDir, 'config.toml');
const jwt = (exp = Math.floor(Date.now() / 1000) + 3600) => `${Buffer.from('{"alg":"fixture"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`;
const accessToken = jwt();
const authText = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: accessToken, refresh_token: 'fixture-refresh', account_id: 'fixture-account' }, last_refresh: '2026-11-15T00:00:00Z' });
const originalConfig = `# keep this comment\nprofile = "work.v2"\nmodel = "old-model"\nmodel_provider = "old-provider"\nopenai_base_url = "https://old.invalid/v1"\nmodel_catalog_json = "C:/old/catalog.json"\nforced_login_method = "api"\nauthorization = """\nmultiline-private-first\nmultiline-private-second\n"""\nnotes = """\n[model_providers.aurora]\nbase_url = "fake-table-value"\n"""\n\n["profiles"."work.v2"]\n"model_provider" = "profile-old"\n"openai_base_url" = "https://profile-old.invalid/v1"\n"model_catalog_json" = "C:/profile-old/catalog.json"\npermissions = ["read", "write"]\n\n[mcp_servers.keep]\ncommand = "fixture"\nargs = ["--preserve"]\n`;

fs.mkdirSync(codexDir, { recursive: true });
write(authFile, authText);
write(cacheFile, JSON.stringify({ models: [
  { slug: 'gpt-fixture', display_name: 'GPT Fixture', context_window: 123456, visibility: 'list', model_messages: { instructions_template: 'Native instructions' }, supports_parallel_tool_calls: true },
  { slug: 'hidden-fixture', visibility: 'hide' },
] }));
write(configFile, 'model_provider = "openai"\n');

let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`PASS ${label}`); };
const parseToml = file => {
  const result = spawnSync('python', ['-X', 'utf8', '-c', 'import sys,tomllib,json; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: read(file), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

try {
  const bundle = path.join(scratch, 'core.cjs');
  await build({ stdin: { contents: [
    "export * from './src/core/agents/adapters.ts';",
    "export * from './src/core/agents/historyProviders.ts';",
    "export * from './src/core/store/index.ts';",
    "export * from './src/core/actions.ts';",
    "export * from './src/core/gateway/coexist.ts';",
    "export * from './src/core/gateway/security.ts';",
  ].join('\n'), resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  const store = new api.AuroraStore(path.join(scratch, 'store'));
  store.saveSettings({ gatewayHost: '127.0.0.1', gatewayPort: 3425, gatewayToken: 'fixture-gateway-token', maskSecrets: false });
  const supplier = store.saveProvider({ name: 'Fixture API', format: 'openai-responses', baseUrl: 'https://supplier.invalid/v1', enabled: true,
    apiKeys: [{ id: 'key-fixture', label: 'fixture', key: 'fixture-api-secret', enabled: true, weight: 1 }], models: [{ id: 'relay-model', contextWindow: 65536 }] });
  const deps = { store, dataDir: store.dir, gatewayStatus: () => ({ running: true }), gatewayUrl: () => 'http://127.0.0.1:3425',
    historyContext: { home: codexDir, sqliteHome: codexDir, blockingProcesses: async () => [] } };
  const authBefore = read(authFile);
  const catalogFile = path.join(store.dir, 'codex-model-catalog.json');

  check('official identity and native cache stay local and redacted', () => {
    const identity = api.readOfficialCodexIdentity(); assert.equal(identity.available, true); assert.equal(identity.accountKnown, true);
    const text = JSON.stringify(identity); for (const secret of [accessToken, 'fixture-account', 'fixture-refresh']) assert(!text.includes(secret));
    const catalog = api.getCoexistCatalog(store); assert.equal(catalog.officialModelCount, 1); assert.deepEqual(catalog.models.map(x => x.id), ['official/gpt-fixture', `${supplier.id}/relay-model`]);
    assert.equal(catalog.nativeCatalog.models[0].base_instructions, 'Native instructions'); assert(!JSON.stringify(catalog).includes('fixture-api-secret'));
  });

  write(configFile, originalConfig);

  const apiPreview = await api.runAction(deps, 'agent.preview', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist' });
  check('API supplier coexist preview is read-only and hides every secret', () => {
    assert(apiPreview.ok, apiPreview.message); assert(apiPreview.revision); assert.equal(read(configFile), originalConfig); for (const secret of ['fixture-gateway-token', 'multiline-private-first', 'multiline-private-second']) assert(!JSON.stringify(apiPreview).includes(secret));
    assert(apiPreview.files[0].after.includes('model_provider = "openai"')); assert(apiPreview.files[0].after.includes('model_catalog_json'));
  });
  const apiConnected = await api.runAction(deps, 'agent.connect', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist', revision: apiPreview.revision });
  check('API supplier coexist writes local routing and preserves profile, MCP and OAuth files', () => {
    assert(apiConnected.ok, apiConnected.message); const parsed = parseToml(configFile);
    assert.equal(parsed.model_provider, 'openai'); assert.equal(parsed.model, `${supplier.id}/relay-model`); assert.equal(parsed.openai_base_url, 'http://127.0.0.1:3425/codex-coexist/v1'); assert.equal(parsed.model_catalog_json, path.join(store.dir, 'codex-model-catalog.json'));
    assert.equal(parsed.profiles['work.v2'].model_provider, 'openai'); assert.deepEqual(parsed.profiles['work.v2'].permissions, ['read', 'write']); assert.equal(parsed.mcp_servers.keep.command, 'fixture');
    assert.equal(parsed.forced_login_method, undefined); assert.equal(parsed.profiles['work.v2'].openai_base_url, undefined); assert.equal(parsed.profiles['work.v2'].model_catalog_json, undefined);
    assert.equal(parsed.notes, '\n[model_providers.aurora]\nbase_url = "fake-table-value"\n'.slice(1)); assert.equal(parsed.authorization, 'multiline-private-first\nmultiline-private-second\n'); assert(read(configFile).includes('# keep this comment'));
    assert.deepEqual(Object.keys(parsed.model_providers).sort(), ['old-provider', 'profile-old', api.getManagedHistoryTarget(read(configFile))].sort());
    for (const alias of Object.values(parsed.model_providers)) {
      assert.equal(alias.base_url, 'http://127.0.0.1:3425/codex-coexist/history/' + Buffer.from(supplier.id + '/relay-model').toString('base64url') + '/v1');
      assert.equal(alias.name, '云汇历史兼容'); assert.equal(alias.requires_openai_auth, true); assert.equal(alias.experimental_bearer_token, undefined); assert.equal(alias.env_key, undefined);
    }
    assert.equal(read(authFile), authBefore); assert.equal(json(path.join(store.dir, 'codex-model-catalog.json')).models.length, 2);
    assert(store.listAgents()['codex-cli'].connected); assert(store.listAgents()['chatgpt-desktop'].connected); assert.equal(store.listAgents()['codex-cli'].authMode, 'coexist');
  });

  const officialPreview = await api.runAction(deps, 'agent.preview', { agentId: 'codex-cli', providerId: 'official', model: 'gpt-fixture', authMode: 'coexist' });
  check('official account selection previews the same coexistence contract', () => { assert(officialPreview.ok, officialPreview.message); assert(officialPreview.files[0].after.includes('model = "official/gpt-fixture"')); assert.equal(read(authFile), authBefore); });
  const officialConnected = await api.runAction(deps, 'agent.connect', { agentId: 'codex-cli', providerId: 'official', model: 'gpt-fixture', authMode: 'coexist', revision: officialPreview.revision });
  check('official selection switches model while retaining active profile permissions', () => { assert(officialConnected.ok, officialConnected.message); const parsed = parseToml(configFile); assert.equal(parsed.model, 'official/gpt-fixture'); assert.equal(parsed.profiles['work.v2'].model, 'official/gpt-fixture'); assert.deepEqual(parsed.profiles['work.v2'].permissions, ['read', 'write']); assert.equal(read(authFile), authBefore); });

  const apiAgain = await api.runAction(deps, 'agent.connect', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist' });
  check('repeated API and official switches retain the first backup', () => { assert(apiAgain.ok, apiAgain.message); assert.equal(json(apiAgain.backup).files[0].backup, json(apiConnected.backup).files[0].backup); assert.equal(json(officialConnected.backup).files[0].backup, json(apiConnected.backup).files[0].backup); const parsed = parseToml(configFile); assert.equal(parsed.model, `${supplier.id}/relay-model`); assert.equal(read(authFile), authBefore); });

  const exitPreview = await api.runAction(deps, 'agent.preview', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'api' });
  const exited = await api.runAction(deps, 'agent.connect', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'api', revision: exitPreview.revision });
  check('leaving coexistence removes only coexist routing and keeps the API provider', () => { assert(exited.ok, exited.message); const parsed = parseToml(configFile); assert.equal(parsed.model_provider, 'yunhui'); assert.equal(parsed.model, `${supplier.id}/relay-model`); assert.equal(parsed.profiles['work.v2'].model_provider, 'yunhui'); assert.equal(parsed.profiles['work.v2'].permissions[0], 'read'); assert.equal(parsed.openai_base_url, undefined); assert.equal(parsed.model_catalog_json, undefined); assert.equal(parsed.profiles['work.v2'].openai_base_url, undefined); assert.equal(parsed.profiles['work.v2'].model_catalog_json, undefined); assert.equal(parsed.model_providers.yunhui.base_url, 'http://127.0.0.1:3425/v1'); assert.equal(read(authFile), authBefore); });
  const restored = await api.runAction(deps, 'agent.disconnect', { agentId: 'codex-desktop' });
  check('disconnect restores the original config byte for byte', () => { assert(restored.ok, restored.message); assert.equal(read(configFile), originalConfig); assert.equal(read(authFile), authBefore); });

  write(configFile, originalConfig);
  const stale = await api.runAction(deps, 'agent.preview', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist' });
  write(configFile, originalConfig + '\n# external edit after preview\n');
  const staleResult = await api.runAction(deps, 'agent.connect', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist', revision: stale.revision });
  check('stale preview cannot overwrite an external config edit', () => { assert.equal(staleResult.ok, false); assert(read(configFile).includes('external edit after preview')); assert.equal(read(authFile), authBefore); });

  const windowConfig = 'model_context_window = 65536\nmodel_auto_compact_token_limit = 58982\n' + originalConfig;
  write(configFile, windowConfig);
  const windowPayload = { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist' };
  const windowPreview = await api.runAction(deps, 'agent.preview', windowPayload);
  assert(windowPreview.ok, windowPreview.message);
  const windowCatalogBefore = read(catalogFile), windowStatesBefore = JSON.stringify(store.listAgents());
  store.saveProvider({ id: supplier.id, models: [{ id: 'relay-model', contextWindow: 131072 }], apiKeys: supplier.apiKeys });
  const staleWindow = await api.runAction(deps, 'agent.connect', { ...windowPayload, revision: windowPreview.revision });
  check('a changed coexist model window rejects the old preview before any client or catalog write', () => {
    assert.equal(staleWindow.ok, false); assert.match(staleWindow.message, /预览后已变化/);
    assert.equal(read(configFile), windowConfig); assert.equal(read(authFile), authBefore); assert.equal(read(catalogFile), windowCatalogBefore); assert.equal(JSON.stringify(store.listAgents()), windowStatesBefore);
  });
  const refreshedWindowPreview = await api.runAction(deps, 'agent.preview', windowPayload);
  check('catalog-only changes produce a new revision while preserving the same redacted client preview', () => {
    assert(refreshedWindowPreview.ok, refreshedWindowPreview.message); assert.notEqual(refreshedWindowPreview.revision, windowPreview.revision);
    assert.deepEqual(refreshedWindowPreview.files, windowPreview.files);
    assert.equal(read(configFile), windowConfig); assert.equal(read(authFile), authBefore); assert.equal(read(catalogFile), windowCatalogBefore);
    for (const secret of [accessToken, 'fixture-refresh', 'fixture-api-secret', 'fixture-gateway-token']) assert(!JSON.stringify(refreshedWindowPreview).includes(secret));
  });
  const appliedWindow = await api.runAction(deps, 'agent.connect', { ...windowPayload, revision: refreshedWindowPreview.revision });
  check('a refreshed coexist preview applies the new per-model window and 90 percent threshold without global overrides', () => {
    assert(appliedWindow.ok, appliedWindow.message);
    const catalogModel = json(catalogFile).models.find(model => model.slug === `${supplier.id}/relay-model`);
    assert.equal(catalogModel.context_window, 131072); assert.equal(catalogModel.auto_compact_token_limit, 117964);
    const parsed = parseNativeToml(read(configFile)); assert.equal(parsed.model_context_window, undefined); assert.equal(parsed.model_auto_compact_token_limit, undefined);
    assert.equal(read(authFile), authBefore); assert.equal(store.listAgents()['codex-cli'].connected, true);
  });
  const restoredWindow = await api.runAction(deps, 'agent.disconnect', { agentId: 'codex-cli' });
  assert(restoredWindow.ok, restoredWindow.message); assert.equal(read(configFile), windowConfig); assert.equal(read(authFile), authBefore);
  store.saveProvider({ id: supplier.id, models: supplier.models, apiKeys: supplier.apiKeys });

  write(configFile, originalConfig);
  const cleanPreview = await api.runAction(deps, 'agent.preview', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist' });
  const catalogBeforeStale = fs.existsSync(path.join(store.dir, 'codex-model-catalog.json')) ? read(path.join(store.dir, 'codex-model-catalog.json')) : '';
  store.saveProvider({ id: supplier.id, models: [...supplier.models, { id: 'changed-model' }], apiKeys: supplier.apiKeys });
  write(configFile, originalConfig + '\n# external edit with catalog drift\n');
  const staleCatalog = await api.runAction(deps, 'agent.connect', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist', revision: cleanPreview.revision });
  check('stale preview does not write a model catalog before rejection', () => { assert.equal(staleCatalog.ok, false); const current = fs.existsSync(path.join(store.dir, 'codex-model-catalog.json')) ? read(path.join(store.dir, 'codex-model-catalog.json')) : ''; assert.equal(current, catalogBeforeStale); });
  store.saveProvider({ id: supplier.id, models: supplier.models, apiKeys: supplier.apiKeys });

  write(configFile, originalConfig);
  const apiOnly = await api.runAction(deps, 'agent.connect', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'api' });
  check('normal API mode preserves unrelated active-profile endpoint and catalog', () => { assert(apiOnly.ok, apiOnly.message); const parsed = parseToml(configFile); assert.equal(parsed.openai_base_url, 'https://old.invalid/v1'); assert.equal(parsed.model_catalog_json, 'C:/old/catalog.json'); assert.equal(parsed.profiles['work.v2'].openai_base_url, 'https://profile-old.invalid/v1'); assert.equal(parsed.profiles['work.v2'].model_catalog_json, 'C:/profile-old/catalog.json'); });
  const installedConfig = read(configFile);
  const externallyEdited = installedConfig + '\n# external edit since the stored backup\n';
  write(configFile, externallyEdited);
  store.saveProvider({ id: supplier.id, models: [...supplier.models, { id: 'later-model' }] });
  const currentPreview = await api.runAction(deps, 'agent.preview', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist' });
  const oldCatalog = read(catalogFile), oldStates = JSON.stringify(store.listAgents());
  const backupConflict = await api.runAction(deps, 'agent.connect', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist', revision: currentPreview.revision });
  check('backup conflict rolls back a replaced catalog without changing config or agent state', () => { assert(currentPreview.ok, currentPreview.message); assert.equal(backupConflict.ok, false); assert.equal(read(catalogFile), oldCatalog); assert.equal(read(configFile), externallyEdited); assert.equal(JSON.stringify(store.listAgents()), oldStates); assert.equal(read(authFile), authBefore); });
  fs.unlinkSync(catalogFile);
  const noCatalogPreview = await api.runAction(deps, 'agent.preview', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist' });
  const noCatalogConflict = await api.runAction(deps, 'agent.connect', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist', revision: noCatalogPreview.revision });
  check('backup conflict removes a newly created catalog on rollback', () => { assert.equal(noCatalogConflict.ok, false); assert.equal(fs.existsSync(catalogFile), false); assert.equal(read(configFile), externallyEdited); assert.equal(read(authFile), authBefore); });
  write(configFile, installedConfig);
  const afterConflictRestore = await api.runAction(deps, 'agent.disconnect', { agentId: 'codex-cli' });
  assert(afterConflictRestore.ok, afterConflictRestore.message);
  assert.equal(read(configFile), originalConfig);
  const stopped = await api.runAction({ ...deps, gatewayStatus: () => ({ running: false }) }, 'agent.connect', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist' });
  const direct = await api.runAction(deps, 'agent.connect', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist', mode: 'direct' });
  check('stopped gateway and direct coexistence requests leave configuration untouched', () => { assert.equal(stopped.ok, false); assert.equal(direct.ok, false); assert.equal(read(configFile), originalConfig); assert.equal(fs.existsSync(catalogFile), false); assert.equal(read(authFile), authBefore); });

  for (const mode of ['gateway', 'direct']) {
    const profileOriginal = originalConfig + '\n[profiles."work.v2".model_providers.yunhui]\nname = "Stale managed provider"\nbase_url = "https://stale.invalid/v1"\nwire_api = "responses"\nexperimental_bearer_token = "fixture-stale-profile-key"\nenv_key = "FIXTURE_STALE_PROFILE_KEY"\nrequires_openai_auth = true\nrequest_max_retries = 7\n\n[profiles.inactive.model_providers.yunhui]\nbase_url = "https://inactive.invalid/v1"\nexperimental_bearer_token = "fixture-inactive-profile-key"\n';
    write(configFile, profileOriginal);
    const adapter = api.getAdapter('codex-cli'), context = { provider: supplier, model: 'relay-model', mode, gatewayUrl: deps.gatewayUrl(), token: store.getSettings().gatewayToken, authMode: 'api' };
    const preview = adapter.preview(context);
    assert(preview.ok, preview.message);
    assert.equal(read(configFile), profileOriginal);
    for (const secret of ['fixture-stale-profile-key', 'fixture-inactive-profile-key', 'fixture-api-secret', 'fixture-gateway-token']) assert(!JSON.stringify(preview).includes(secret));
    const applied = adapter.connect({ ...context, expectedRevision: preview.revision });
    check(`${mode} API transport overrides stale same-name active-profile URL and credentials`, () => {
      assert(applied.ok, applied.message);
      const parsed = parseToml(configFile), rootProvider = parsed.model_providers.yunhui, profile = parsed.profiles['work.v2'];
      const effectiveProvider = { ...rootProvider, ...profile.model_providers.yunhui };
      assert.equal(effectiveProvider.base_url, mode === 'gateway' ? deps.gatewayUrl() + '/v1' : supplier.baseUrl);
      assert.equal(effectiveProvider.experimental_bearer_token, mode === 'gateway' ? store.getSettings().gatewayToken : supplier.apiKeys[0].key);
      assert.equal(effectiveProvider.env_key, undefined); assert.equal(effectiveProvider.requires_openai_auth, false); assert.equal(effectiveProvider.wire_api, 'responses');
      assert.equal(profile.model, mode === 'gateway' ? `${supplier.id}/relay-model` : 'relay-model');
      assert.equal(profile.model_providers.yunhui.request_max_retries, 7);
      assert.deepEqual(profile.permissions, ['read', 'write']);
      assert.deepEqual(parsed.profiles.inactive.model_providers.yunhui, { base_url: 'https://inactive.invalid/v1', experimental_bearer_token: 'fixture-inactive-profile-key' });
      assert.equal(parsed.mcp_servers.keep.command, 'fixture'); assert.equal(read(authFile), authBefore);
      assert(adapter.matchesConfiguration(context));
      assert(adapter.disconnect(applied.backup).ok); assert.equal(read(configFile), profileOriginal);
    });
  }
  write(configFile, originalConfig);

  for (const table of ['model_providers.yunhui', 'profiles."work.v2".model_providers.yunhui']) {
    for (const authSection of ['auth', 'aws']) {
      const conflicting = originalConfig + `\n[${table}.${authSection}]\nsecret = "fixture-conflicting-auth-secret"\n`;
      write(configFile, conflicting);
      const adapter = api.getAdapter('codex-cli');
      for (const mode of ['gateway', 'direct']) {
        const context = { provider: supplier, model: 'relay-model', mode, gatewayUrl: deps.gatewayUrl(), token: store.getSettings().gatewayToken, authMode: 'api' };
        for (const result of [adapter.preview(context), adapter.connect(context)]) {
          assert.equal(result.ok, false); assert.match(result.message, /auth.*aws/); assert(!JSON.stringify(result).includes('fixture-conflicting-auth-secret'));
        }
      }
      assert.equal(read(configFile), conflicting); assert.equal(read(authFile), authBefore);
    }
  }
  check('conflicting auth or AWS settings in the root or active managed provider reject preview and apply without deleting credentials', () => {});
  write(configFile, originalConfig);

  for (const mode of ['gateway', 'direct']) {
    const legacyTables = '\n[model_providers.aurora]\nname = "Legacy Aurora"\nbase_url = "https://legacy.invalid/v1"\nwire_api = "responses"\nrequest_max_retries = 9\n\n[model_providers.aurora.auth]\nsecret = "fixture-legacy-auth-secret"\n\n[profiles."work.v2".model_providers.aurora]\nname = "Legacy profile"\nbase_url = "https://legacy-profile.invalid/v1"\n\n[profiles."work.v2".model_providers.aurora.aws]\nsecret = "fixture-legacy-aws-secret"\n\n[model_providers.provider0029]\nname = "Other provider"\nbase_url = "https://unrelated.invalid/v1"\n';
    const legacyConfig = originalConfig.replace('model_provider = "old-provider"', 'model_provider = "aurora"').replace('"model_provider" = "profile-old"', '"model_provider" = "aurora"') + legacyTables;
    write(configFile, legacyConfig);
    const before = parseToml(configFile), adapter = api.getAdapter('codex-cli');
    const context = { provider: supplier, model: 'relay-model', mode, gatewayUrl: deps.gatewayUrl(), token: store.getSettings().gatewayToken, authMode: 'api' };
    const preview = adapter.preview(context);
    assert(preview.ok, preview.message); assert.equal(read(configFile), legacyConfig);
    assert(preview.warnings.some(message => message.includes('先保存客户端配置') && message.includes('历史备份与整理随后尝试') && message.includes('不影响保存')));
    for (const secret of ['fixture-legacy-auth-secret', 'fixture-legacy-aws-secret']) assert(!JSON.stringify(preview).includes(secret));
    const applied = adapter.connect({ ...context, expectedRevision: preview.revision });
    check(`${mode} API moves the active aurora selection to yunhui while preserving legacy tables and exact restore`, () => {
      assert(applied.ok, applied.message);
      const parsed = parseToml(configFile);
      assert.equal(parsed.model_provider, 'yunhui'); assert.equal(parsed.profiles['work.v2'].model_provider, 'yunhui');
      assert.equal(parsed.model_providers.yunhui.base_url, mode === 'gateway' ? deps.gatewayUrl() + '/v1' : supplier.baseUrl);
      assert.equal(parsed.model_providers.yunhui.experimental_bearer_token, mode === 'gateway' ? store.getSettings().gatewayToken : supplier.apiKeys[0].key);
      assert.equal(parsed.profiles['work.v2'].model_providers.yunhui, undefined);
      assert.deepEqual(parsed.model_providers.aurora, before.model_providers.aurora);
      assert.deepEqual(parsed.profiles['work.v2'].model_providers.aurora, before.profiles['work.v2'].model_providers.aurora);
      assert.deepEqual(parsed.model_providers.provider0029, before.model_providers.provider0029);
      assert(read(configFile).includes(legacyTables)); assert.deepEqual(parsed.mcp_servers, before.mcp_servers);
      assert.equal(read(authFile), authBefore); assert(adapter.matchesConfiguration(context));
      assert(adapter.disconnect(applied.backup).ok); assert.equal(read(configFile), legacyConfig);
    });
  }
  write(configFile, originalConfig);

  check('automatic history protection is explained for both API and coexistence configuration', () => {
    const adapter = api.getAdapter('codex-cli');
    const apiContext = { provider: supplier, model: 'relay-model', mode: 'gateway', gatewayUrl: deps.gatewayUrl(), token: store.getSettings().gatewayToken, authMode: 'api' };
    const notice = preview => preview.warnings.some(message => message.includes('先保存客户端配置') && message.includes('历史备份与整理随后尝试'));
    for (const before of [
      originalConfig.replace('model_provider = "old-provider"', 'model_provider = "aurora"'),
      originalConfig.replace('"model_provider" = "profile-old"', '"model_provider" = "aurora"'),
      originalConfig + '\n[model_providers.aurora]\nname = "Legacy root provider"\n',
      originalConfig + '\n[profiles."work.v2".model_providers.aurora]\nname = "Legacy active provider"\n',
    ]) {
      write(configFile, before);
      const apiPreview = adapter.preview(apiContext); assert(apiPreview.ok, apiPreview.message); assert(notice(apiPreview));
      const coexistPreview = adapter.preview({ ...apiContext, authMode: 'coexist', modelCatalogPath: catalogFile });
      assert(coexistPreview.ok, coexistPreview.message); assert(notice(coexistPreview)); assert.equal(read(configFile), before);
    }
    for (const before of [originalConfig, originalConfig + '\n[profiles.inactive]\nmodel_provider = "aurora"\n[profiles.inactive.model_providers.aurora]\nname = "Inactive legacy provider"\n']) {
      write(configFile, before); const preview = adapter.preview(apiContext); assert(preview.ok, preview.message); assert(notice(preview)); assert.equal(read(configFile), before);
    }
  });
  write(configFile, originalConfig);

  const payload = { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist' };
  const dangerousOverrides = ['base_url = "https://override.invalid/v1"', 'env_key = "FIXTURE_OPENAI_KEY"', 'experimental_bearer_token = "fixture-openai-override-secret"'];
  for (const table of ['model_providers.openai', 'profiles."work.v2".model_providers.openai']) {
    for (const override of dangerousOverrides) {
      const configuration = originalConfig + `\n[${table}]\n${override}\n`;
      write(configFile, configuration);
      for (const action of ['agent.preview', 'agent.connect']) {
        const rejected = await api.runAction(deps, action, payload);
        assert.equal(rejected.ok, false); assert(rejected.message.includes('重定义')); assert(!JSON.stringify(rejected).includes('fixture-openai-override-secret'));
      }
      assert.equal(read(configFile), configuration); assert.equal(read(authFile), authBefore); assert.equal(fs.existsSync(catalogFile), false);
    }
  }
  check('root and active-profile built-in OpenAI endpoint or credential overrides fail closed', () => {});
  write(configFile, originalConfig + '\n[model_providers.openai]\nname = "Official display name"\n');
  const harmlessOverride = await api.runAction(deps, 'agent.preview', payload);
  check('display-name-only OpenAI customization still permits a coexistence preview', () => { assert(harmlessOverride.ok, harmlessOverride.message); assert.equal(read(authFile), authBefore); });

  const badToml = '[model_providers.fixture]\nexperimental_bearer_token = "fixture-malformed-secret" trailing-invalid\n';
  assert.throws(() => parseNativeToml(badToml), error => String(error).includes('fixture-malformed-secret'));
  write(configFile, badToml);
  for (const action of ['agent.preview', 'agent.connect']) {
    const rejected = await api.runAction(deps, action, payload);
    assert.equal(rejected.ok, false); assert(!JSON.stringify(rejected).includes('fixture-malformed-secret')); assert(!JSON.stringify(api.redactRemoteResult(rejected)).includes('fixture-malformed-secret'));
  }
  check('invalid TOML never discloses nearby secrets through local or remote error messages', () => { assert.equal(read(configFile), badToml); assert.equal(read(authFile), authBefore); });
  write(configFile, originalConfig);

  const childEnvironment = { ...process.env, CODEX_HOME: codexDir, OPENAI_BASE_URL: 'https://fixture-environment-override.invalid/private-endpoint' };
  delete childEnvironment.AURORA_CLIENT_HOME;
  const child = spawnSync(process.execPath, ['-e', `const api=require(process.argv[1]);const context=JSON.parse(process.argv[2]);const adapter=api.getAdapter('codex-cli');process.stdout.write(JSON.stringify([adapter.preview(context),adapter.connect(context)]));`, bundle, JSON.stringify({ provider: store.getProvider(supplier.id), model: 'relay-model', mode: 'gateway', gatewayUrl: deps.gatewayUrl(), token: store.getSettings().gatewayToken, authMode: 'coexist', modelCatalogPath: catalogFile })], { env: childEnvironment, encoding: 'utf8' });
  check('a real process endpoint override blocks coexistence without exposing its value', () => { assert.equal(child.status, 0, child.stderr); const rejected = JSON.parse(child.stdout); assert(rejected.every(result => !result.ok && result.message.includes('OPENAI_BASE_URL'))); assert(!child.stdout.includes('fixture-environment-override.invalid')); assert.equal(read(configFile), originalConfig); assert.equal(read(authFile), authBefore); });

  const cacheBefore = read(cacheFile);
  write(cacheFile, '{"models":[]}');
  const emptyStore = new api.AuroraStore(path.join(scratch, 'without-model-cache'));
  const emptySupplier = emptyStore.saveProvider({ ...supplier, id: undefined });
  const emptyDeps = { ...deps, store: emptyStore, dataDir: emptyStore.dir };
  const noModelsPreview = await api.runAction(emptyDeps, 'agent.preview', { ...payload, providerId: emptySupplier.id });
  const noModelsConnect = await api.runAction(emptyDeps, 'agent.connect', { ...payload, providerId: emptySupplier.id });
  check('missing native model metadata rejects coexistence without writing a partial setup', () => { assert.equal(noModelsPreview.ok, false); assert.equal(noModelsConnect.ok, false); assert.equal(read(configFile), originalConfig); assert.equal(read(authFile), authBefore); assert(!fs.existsSync(path.join(emptyStore.dir, 'codex-model-catalog.json'))); });
  write(cacheFile, cacheBefore);

  write(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: jwt(Math.floor(Date.now() / 1000) - 60), refresh_token: 'fixture-expired-refresh' } }));
  const expiredAuth = read(authFile);
  const expired = await api.runAction(deps, 'agent.connect', { agentId: 'codex-cli', providerId: supplier.id, model: 'relay-model', authMode: 'coexist' });
  check('expired official credentials fail without rewriting or refreshing auth', () => { assert.equal(expired.ok, false); assert.equal(read(authFile), expiredAuth); assert.equal(read(configFile), originalConfig); assert.equal(fs.existsSync(catalogFile), false); });
  console.log(`\nCoexistence configuration: ${passed} checks passed.`);
} finally {
  if (originalClientHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = originalClientHome;
  const target = path.resolve(scratch); if (target.startsWith(path.join(os.tmpdir(), 'aurora-coexist-config-'))) fs.rmSync(target, { recursive: true, force: true });
}
