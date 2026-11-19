import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { parse } from 'smol-toml';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..'), scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-history-alias-'))), previousHome = process.env.AURORA_CLIENT_HOME;
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = file => fs.readFileSync(file, 'utf8'), json = file => JSON.parse(read(file));
let passed = 0;
async function check(name, run) { await run(); passed++; console.log('PASS', name); }
try {
  const bundle = path.join(scratch, 'core.cjs');
  await build({ stdin: { contents: ["export * from './src/core/agents/historyProviders.ts';", "export * from './src/core/agents/adapters.ts';", "export * from './src/core/agents/configFiles.ts';", "export * from './src/core/store/index.ts';", "export * from './src/core/actions.ts';"].join('\n'), resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  function fixture(name, before = 'model_provider="missing-prior"\nmodel="old-model"\n') {
    const client = path.join(scratch, name), home = path.join(client, '.codex'), file = path.join(home, 'config.toml'); process.env.AURORA_CLIENT_HOME = client; write(file, before);
    const auth = path.join(home, 'auth.json'), token = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
    const authBytes = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'fixture-private-refresh', account_id: 'fixture-private-account' } }); write(auth, authBytes);
    write(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'official/native-fixture', display_name: 'Official fixture', context_window: 64000, visibility: 'list', base_instructions: 'Fixture' }] }));
    const store = new api.AuroraStore(path.join(client, 'store')); store.saveSettings({ gatewayPort: 3456, gatewayHost: '127.0.0.1', gatewayToken: 'fixture-gateway-secret' });
    const provider = store.saveProvider({ name: 'Fixture', baseUrl: 'https://fixture.invalid/v1', format: 'openai-responses', enabled: true, models: [{ id: 'chosen/model', contextWindow: 272000 }], apiKeys: [{ id: 'key', label: 'Fixture', key: 'fixture-provider-secret', enabled: true, weight: 1 }] });
    const context = { provider, model: 'chosen/model', mode: 'gateway', authMode: 'api', gatewayUrl: 'http://127.0.0.1:3456', token: 'fixture-gateway-secret', modelCatalogPath: path.join(store.dir, 'codex-model-catalog.json') };
    const deps = { store, dataDir: store.dir, gatewayStatus: () => ({ running: true }), gatewayUrl: () => context.gatewayUrl, historyContext: { home, sqliteHome: home, blockingProcesses: async () => ['isolated-running-client'] } };
    const payload = { agentId: 'codex-cli', providerId: provider.id, model: context.model, mode: 'gateway', authMode: 'api' };
    return { home, file, before, auth, authBytes, store, provider, context, deps, payload };
  }
  function database(file, statements, providers = []) { fs.mkdirSync(path.dirname(file), { recursive: true }); const db = new DatabaseSync(file); try { db.exec(statements); for (const provider of providers) db.prepare('INSERT INTO threads(model_provider) VALUES(?)').run(provider); } finally { db.close(); } }
  await check('Exact case-sensitive IDs come from config active profiles all readable databases and BOM-prefixed first metadata lines', async () => {
    const f = fixture('evidence', 'model_provider="Root.Legacy"\nprofile="工作"\n[profiles."工作"]\nmodel_provider="Profile Legacy"\n');
    database(path.join(f.home, 'state_5.sqlite'), 'CREATE TABLE threads(model_provider TEXT)', ['codex_plus_managed', 'CodexPlusPlus', 'OpenAI', 'azure', 'azure-openai', 'openai', 'ollama', 'lmstudio', 'amazon-bedrock', 'amazon-bedrock-runtime', 'gcp', 'ollama-chat', 'yunhui', '', ' bad ', 'bad\nkey']);
    write(path.join(f.home, 'state_9.sqlite'), 'corrupt private database');
    database(path.join(f.home, 'sqlite', 'catalog.db'), "CREATE TABLE local_thread_catalog(model_provider TEXT); INSERT INTO local_thread_catalog VALUES('只在索引'),('Name.With.Dot');");
    write(path.join(f.home, 'sessions', 'log.jsonl'), '\ufeff' + JSON.stringify({ type: 'session_meta', payload: { model_provider: '只在日志' } }) + '\r\nnot read');
    write(path.join(f.home, 'archived_sessions', 'archived.jsonl'), JSON.stringify({ type: 'session_meta', payload: { model_provider: 'Archived Exact' } }) + '\n');
    write(path.join(f.home, 'sessions', 'too-long.jsonl'), 'x'.repeat(70 * 1024) + '\n' + JSON.stringify({ type: 'session_meta', payload: { model_provider: 'DoNotGuess' } }));
    assert.deepEqual(new Set(api.discoverHistoryProviderIds(f.before, f.home)), new Set(['Root.Legacy', 'Profile Legacy', 'codex_plus_managed', 'CodexPlusPlus', 'OpenAI', 'azure', 'azure-openai', '只在索引', 'Name.With.Dot', '只在日志', 'Archived Exact']));
    const planned = parse(api.codexPlan(f.context)[0].after); for (const id of ['Root.Legacy', 'Profile Legacy', 'codex_plus_managed', 'CodexPlusPlus', 'OpenAI', 'azure', 'azure-openai', '只在日志']) assert(planned.model_providers[id]);
    for (const id of ['openai', 'ollama', 'lmstudio', 'amazon-bedrock', 'amazon-bedrock-runtime', 'gcp', 'ollama-chat']) assert.equal(planned.model_providers[id], undefined); assert.equal(read(f.auth), f.authBytes);
  });
  await check('Managed aliases bind the chosen provider and model and update on subsequent API direct and coexist switches', async () => {
    const f = fixture('managed'), ids = ['codex_plus_managed', '旧厂商."精确"']; let currentBackup, originalBackup;
    const choices = [{ ...f.context }, { ...f.context, model: 'next-model' }, { ...f.context, authMode: 'coexist' }, { ...f.context, mode: 'direct' }, { ...f.context, authMode: 'coexist' }];
    for (const context of choices) {
      const plan = api.codexPlan({ ...context, historyProviderIds: ids }); currentBackup = api.applyPlan('codex-cli', plan, currentBackup);
      originalBackup ||= json(currentBackup).files[0].backup; assert.equal(json(currentBackup).files[0].backup, originalBackup);
      const config = parse(read(f.file)), encoded = Buffer.from(`${context.provider.id}/${context.model}`).toString('base64url');
      const historyTarget = api.getManagedHistoryTarget(read(f.file)); assert(historyTarget); assert.notEqual(historyTarget, config.model_provider);
      assert.deepEqual(config.model_providers[historyTarget], config.model_providers[ids[0]]);
      for (const id of ids) {
        const alias = config.model_providers[id]; assert(alias, id); assert.equal(alias.wire_api, 'responses');
        if (context.authMode === 'coexist') { assert.equal(alias.base_url, `${context.gatewayUrl}/codex-coexist/history/${encoded}/v1`); assert.equal(alias.requires_openai_auth, true); assert.equal(alias.experimental_bearer_token, undefined); assert.equal(alias.env_key, undefined); }
        else { assert.equal(alias.base_url, context.mode === 'direct' ? f.provider.baseUrl : `${context.gatewayUrl}/codex-history/${encoded}/v1`); assert.equal(alias.experimental_bearer_token, context.mode === 'direct' ? 'fixture-provider-secret' : 'fixture-gateway-secret'); assert.equal(alias.requires_openai_auth, false); }
      }
      assert.equal(read(f.auth), f.authBytes);
      // Reapplying uses no new evidence but still updates existing owned blocks.
      const stablePlan = api.codexPlan({ ...context, historyProviderIds: [] })[0].after;
      assert.equal(stablePlan, read(f.file), 'reapplying the same connection keeps an identical preview revision');
      const noEvidence = parse(stablePlan); assert.deepEqual(noEvidence.model_providers[ids[0]], config.model_providers[ids[0]]);
    }
    const prior = parse(read(f.file)), unsupportedAlias = api.codexPlan({ ...f.context, model: 'x'.repeat(401), historyProviderIds: ids })[0].after;
    const unsupportedConfig = parse(unsupportedAlias); assert.equal(unsupportedConfig.model, `${f.provider.id}/${'x'.repeat(401)}`);
    assert.equal(api.getManagedHistoryTarget(unsupportedAlias), undefined, 'an unavailable new binding cannot retain a trusted old automatic target');
    for (const id of ids) assert.deepEqual(unsupportedConfig.model_providers[id], prior.model_providers[id], 'optional route failure preserves previous aliases');
    api.restorePlan('codex-cli', currentBackup, [f.file]); assert.equal(read(f.file), f.before);
  });
  await check('Existing independent providers active-profile overrides and user-edited managed aliases remain untouched', async () => {
    const before = 'profile="work"\nmodel_provider="legacy"\n[model_providers.legacy]\nname="User owned"\nbase_url="https://old.invalid/v1"\n[profiles.work]\nmodel_provider="profile-only"\n[profiles.work.model_providers."profile-only"]\nname="Profile user provider"\nbase_url="https://profile.invalid/v1"\n';
    const f = fixture('user-tables', before), planned = api.codexPlan({ ...f.context, historyProviderIds: ['legacy', 'profile-only', 'openai', 'ollama', 'lmstudio', 'owned'] })[0].after, parsed = parse(planned), original = parse(before);
    assert.deepEqual(parsed.model_providers.legacy, original.model_providers.legacy); assert.deepEqual(parsed.profiles.work.model_providers, original.profiles.work.model_providers); assert.equal(parsed.model_providers['profile-only'], undefined);
    const changed = planned.replaceAll('name = "云汇历史兼容"', 'name = "Customer edited alias"'); write(f.file, changed);
    const later = parse(api.codexPlan({ ...f.context, model: 'another', historyProviderIds: ['owned'] })[0].after); assert.deepEqual(later.model_providers.owned, parse(changed).model_providers.owned);
  });
  await check('Automatic history targets avoid user table collisions and require intact purpose hash and active-profile identity', async () => {
    for (const profileOverride of [false, true]) {
      const before = 'model_provider="legacy"\n' + (profileOverride ? 'profile="work"\n[profiles.work.model_providers.yunhui-history]\n' : '[model_providers.yunhui-history]\n') + 'name="User table"\nbase_url="https://customer.invalid/v1"\n';
      const f = fixture('collision-' + profileOverride, before), first = api.codexPlan({ ...f.context, historyProviderIds: [] })[0].after, target = api.getManagedHistoryTarget(first), config = parse(first);
      assert.equal(target, 'yunhui-history-2'); assert.equal(config.model_provider, 'yunhui');
      assert.deepEqual(profileOverride ? config.profiles.work.model_providers['yunhui-history'] : config.model_providers['yunhui-history'], profileOverride ? parse(before).profiles.work.model_providers['yunhui-history'] : parse(before).model_providers['yunhui-history']);
      write(f.file, first); const switched = api.codexPlan({ ...f.context, authMode: 'coexist', historyProviderIds: [] })[0].after;
      assert.equal(api.getManagedHistoryTarget(switched), target); assert.equal(parse(switched).model_provider, 'openai');
      assert.equal(api.getManagedHistoryTarget(switched.replace('# yunhui-history-target:v1', '# customer edited target')), undefined);
      const shadowed = switched + `\n[profiles.work.model_providers."${target}"]\nname="Customer override"\nbase_url="https://override.invalid/v1"\n`;
      const shadowedActive = profileOverride ? shadowed : 'profile="work"\n' + shadowed;
      assert.equal(api.getManagedHistoryTarget(shadowedActive), undefined);
      write(f.file, shadowedActive); const afterShadow = api.codexPlan({ ...f.context, historyProviderIds: [] })[0].after;
      assert.equal(api.getManagedHistoryTarget(afterShadow), 'yunhui-history-3'); assert.equal(parse(afterShadow).profiles.work.model_providers[target].name, 'Customer override');
    }
  });
  await check('Marker-looking text inside multiline notes cannot claim ownership of an independent provider', async () => {
    const f = fixture('marker-notes'), generated = api.codexPlan({ ...f.context, historyProviderIds: ['legacy'] })[0].after;
    const block = generated.slice(generated.indexOf('# yunhui-history-provider:v1:'));
    write(f.file, `model_provider="yunhui"\nnotes='''\n${block}'''\n[model_providers.legacy]\nname="Independent"\nbase_url="https://customer.invalid/v1"\n`);
    const after = parse(api.codexPlan({ ...f.context, historyProviderIds: ['legacy'] })[0].after); assert.equal(after.model_providers.legacy.name, 'Independent'); assert.equal(after.notes, block);
  });
  await check('Optional aliases cannot block valid coexistence with inline providers and multiline quote endings keep owned aliases updatable', async () => {
    const before = 'model_provider="old-inline"\nmodel_providers={independent={name="Keep",base_url="https://customer.invalid/v1"}}\n';
    const f = fixture('inline-coexist', before); f.deps.historyContext.blockingProcesses = async () => [];
    const dbPath = path.join(f.home, 'state_5.sqlite'); database(dbPath, 'CREATE TABLE threads(model_provider TEXT)', ['old-inline']); const databaseBefore = fs.readFileSync(dbPath);
    const result = await api.runAction(f.deps, 'agent.connect', { ...f.payload, authMode: 'coexist' });
    assert(result.ok, result.message); const config = parse(read(f.file)); assert.equal(config.model_provider, 'openai');
    assert.equal(result.history.status, 'deferred'); assert.equal(result.history.code, 'CLIENT_HISTORY_TARGET_UNAVAILABLE'); assert.deepEqual(fs.readFileSync(dbPath), databaseBefore);
    assert.deepEqual(config.model_providers, parse(before).model_providers); assert.equal(read(f.auth), f.authBytes);
    const restored = await api.runAction(f.deps, 'agent.disconnect', { agentId: 'codex-cli' }); assert(restored.ok, restored.message); assert.equal(read(f.file), before);
    write(f.file, 'model_provider="legacy"\nnotes="""A quoted ending""""\n');
    const first = api.codexPlan({ ...f.context, historyProviderIds: ['legacy'] })[0].after; write(f.file, first);
    const switched = parse(api.codexPlan({ ...f.context, model: 'another', historyProviderIds: [] })[0].after);
    assert.equal(switched.notes, 'A quoted ending"'); assert.equal(switched.model_providers.legacy.base_url, `${f.context.gatewayUrl}/codex-history/${Buffer.from(f.provider.id + '/another').toString('base64url')}/v1`);
  });
  await check('Main-process preview snapshots freeze discovered IDs and ignore renderer alias injection while a client runs', async () => {
    const f = fixture('snapshot'), dbPath = path.join(f.home, 'state_5.sqlite'); database(dbPath, 'CREATE TABLE threads(model_provider TEXT)', ['legacy-database']);
    const dbBefore = fs.readFileSync(dbPath), preview = await api.runAction(f.deps, 'agent.preview', { ...f.payload, historyProviderIds: ['renderer-attack'] }); assert(preview.ok, preview.message); assert(!JSON.stringify(preview).includes('fixture-gateway-secret')); assert.equal(read(f.file), f.before);
    const db = new DatabaseSync(dbPath); db.prepare('INSERT INTO threads VALUES(?)').run('arrived-after-preview'); db.close(); const afterArrival = fs.readFileSync(dbPath);
    write(path.join(f.home, 'sessions', 'arrived-broken.jsonl'), '{broken metadata after preview\n');
    const realNow = Date.now, advanced = realNow() + 20 * 60 * 1000; let result;
    try { Date.now = () => advanced; result = await api.runAction(f.deps, 'agent.connect', { ...f.payload, revision: preview.revision, historyProviderIds: ['renderer-attack'] }); }
    finally { Date.now = realNow; }
    assert(result.ok, result.message); assert.equal(result.history.status, 'deferred');
    let parsed = parse(read(f.file)); assert(parsed.model_providers['legacy-database']); assert.equal(parsed.model_providers['arrived-after-preview'], undefined); assert.equal(parsed.model_providers['renderer-attack'], undefined); assert.deepEqual(fs.readFileSync(dbPath), afterArrival); assert.equal(read(f.auth), f.authBytes);
    const next = await api.runAction(f.deps, 'agent.preview', f.payload); assert(next.ok, next.message); const reapplied = await api.runAction(f.deps, 'agent.connect', { ...f.payload, revision: next.revision }); assert(reapplied.ok, reapplied.message); parsed = parse(read(f.file)); assert(parsed.model_providers['arrived-after-preview']);
    const restored = await api.runAction(f.deps, 'agent.disconnect', { agentId: 'codex-cli' }); assert(restored.ok, restored.message); assert.equal(read(f.file), f.before); assert.equal(read(f.auth), f.authBytes); assert.deepEqual(fs.readFileSync(dbPath), afterArrival); assert.notDeepEqual(dbBefore, afterArrival);
  });
  await check('Discovery failures do not block saving configuration and evidence is capped to a bounded number of aliases', async () => {
    const f = fixture('limits'), unavailable = path.join(f.home, 'state_5.sqlite'); write(unavailable, 'not SQLite');
    database(path.join(f.home, 'state_8.sqlite'), 'CREATE TABLE threads(model_provider TEXT)', Array.from({ length: 200 }, (_, i) => 'legacy-' + i));
    const ids = api.discoverHistoryProviderIds(f.before, f.home); assert.equal(ids.length, 128);
    const lstat = fs.lstatSync; fs.lstatSync = function(file, ...args) { if (String(file).endsWith('.sqlite') || String(file).endsWith('sessions')) throw Object.assign(new Error('fixture unreadable evidence'), { code: 'EACCES' }); return lstat.call(this, file, ...args); };
    try { const result = await api.runAction(f.deps, 'agent.connect', f.payload); assert(result.ok, result.message); assert.equal(parse(read(f.file)).model_provider, 'yunhui'); } finally { fs.lstatSync = lstat; }
  });
  console.log(`History provider aliases: ${passed} isolated checks passed`);
} finally {
  if (previousHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = previousHome;
  assert.equal(path.dirname(scratch), fs.realpathSync(os.tmpdir())); assert(path.basename(scratch).startsWith('yunhui-history-alias-')); fs.rmSync(scratch, { recursive: true, force: true });
}
