/** Context defaults and explicit overrides use private files and a loopback model-list fixture. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-model-context-')));
const previousHome = process.env.AURORA_CLIENT_HOME;
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
let checks = 0, sequence = 0, responseModels = [], pendingResponse, received;
const check = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name); };
const server = http.createServer((_req, res) => { if (received) { received(); pendingResponse = () => res.end(JSON.stringify({ data: responseModels })); } else res.end(JSON.stringify({ data: responseModels })); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const bundle = path.join(scratch, 'context.cjs');
  await build({ stdin: { contents: ['modelContext', 'store/index', 'modelManagement', 'localClients', 'cloud', 'gateway/coexist', 'actions'].map(file => `export * from './src/core/${file}.ts';`).join('\n'), resolveDir: process.cwd(), loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle), fallback = api.DEFAULT_CHATGPT_CONTEXT_WINDOW;
  const fixture = () => {
    const home = path.join(scratch, `home-${++sequence}`); fs.mkdirSync(home); process.env.AURORA_CLIENT_HOME = home;
    const store = new api.AuroraStore(path.join(home, 'store'));
    const save = models => store.saveProvider({ name: 'Private fixture', baseUrl: `http://127.0.0.1:${server.address().port}`, format: 'openai-responses', enabled: true, models, apiKeys: [{ id: 'key', key: 'private-fixture-key', enabled: true, weight: 1 }] });
    return { home, store, save };
  };
  await check('Only explicit GPT/Codex text families receive the recommendation', () => {
    assert.equal(fallback, 272000);
    for (const id of ['gpt-4o', 'gpt-4.1-mini', 'gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.1-codex-max', 'codex', 'codex-mini-latest', 'chatgpt-4o-latest', 'openai/gpt-5', 'official/gpt-6']) assert(api.isChatgptTextModel(id), id);
    for (const id of ['gpt-image-1', 'gpt-4o-audio-preview', 'gpt-4o-mini-tts', 'gpt-4o-realtime-preview', 'gpt-4o-transcribe', 'codex-auto-review', 'codex-classifier', 'codex-safety', 'codex-sandbox', 'codex-tools', 'text-embedding-3-large', 'whisper-1', 'gpt-oss-120b', 'deepseek-chat', 'claude-sonnet', 'gemini-pro', 'other/gpt-5', 'gpt-', 'gpt-5\n']) assert.equal(api.isChatgptTextModel(id), false, id);
    const missing = { id: 'gpt-6' }, explicit = { id: 'gpt-6', contextWindow: 128000 };
    assert.equal(api.applyContextDefaults(missing).contextWindow, fallback); assert.equal(missing.contextWindow, undefined); assert.equal(api.applyContextDefaults(explicit), explicit);
  });
  await check('The 90% trigger uses exact positive integer arithmetic and rejects missing or invalid sizes', () => {
    for (const [window, limit] of [[272000, 244800], [200000, 180000], [128000, 115200], [70001, 63000], [1, 1], [Number.MAX_SAFE_INTEGER, 8106479329266891]]) assert.equal(api.defaultAutoCompactTokenLimit(window), limit);
    for (const invalid of [undefined, null, '272000', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) assert.equal(api.defaultAutoCompactTokenLimit(invalid), undefined);
  });
  await check('Save and restart persist defaults while keeping explicit values and other families untouched', () => {
    const f = fixture(), provider = f.save([{ id: 'gpt-6' }, { id: 'gpt-4o', contextWindow: 128000 }, { id: 'deepseek-chat' }, { id: 'gpt-image-1' }]);
    assert.deepEqual(provider.models.map(model => model.contextWindow), [fallback, 128000, undefined, undefined]);
    assert.deepEqual(new api.AuroraStore(f.store.dir).getProvider(provider.id).models.map(model => model.contextWindow), [fallback, 128000, undefined, undefined]);
    const updated = f.store.saveProvider({ ...provider, models: provider.models.map(model => model.id === 'gpt-6' ? { ...model, contextWindow: 64000 } : model) });
    assert.equal(updated.models[0].contextWindow, 64000);
    assert.equal(f.store.saveProvider({ ...updated, models: updated.models.map(model => model.id === 'gpt-6' ? { ...model, contextWindow: undefined } : model) }).models[0].contextWindow, fallback);
  });
  await check('Reads leave legacy missing values and provider files unchanged', () => {
    const f = fixture(), provider = f.save([{ id: 'gpt-6' }]);
    f.store.providers.write([{ ...provider, models: [{ id: 'gpt-6' }] }]);
    const file = path.join(f.store.dir, 'providers.json'), before = fs.readFileSync(file);
    assert.equal(f.store.getProvider(provider.id).models[0].contextWindow, undefined); assert.equal(f.store.listProviders()[0].models[0].contextWindow, undefined); assert.deepEqual(fs.readFileSync(file), before);
  });
  await check('Invalid explicit limits fail save and batch preview without changing stored models', () => {
    const f = fixture(), provider = f.save([{ id: 'gpt-6' }]), before = fs.readFileSync(path.join(f.store.dir, 'providers.json'));
    for (const value of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '272000', null]) {
      assert.equal(api.isValidContextWindow(value), false);
      assert.throws(() => f.store.saveProvider({ ...provider, models: [{ id: 'gpt-6', contextWindow: value }] }), /正安全整数/);
      assert.throws(() => api.manageModels(f.store, { operation: 'update', items: [{ providerId: provider.id, modelId: 'gpt-6' }], patch: { contextWindow: value } }), /正安全整数/);
    }
    assert.deepEqual(fs.readFileSync(path.join(f.store.dir, 'providers.json')), before);
  });
  await check('Batch preview and apply change only selected models and reject stale revisions', () => {
    const f = fixture(), provider = f.save([{ id: 'gpt-6' }, { id: 'gpt-4o', contextWindow: 128000 }, { id: 'deepseek-chat', contextWindow: 64000 }]);
    const request = { operation: 'update', items: [{ providerId: provider.id, modelId: 'gpt-6' }, { providerId: provider.id, modelId: 'gpt-4o' }], patch: { contextWindow: 300000 } };
    const plan = api.manageModels(f.store, request); assert.deepEqual(f.store.getProvider(provider.id).models.map(model => model.contextWindow), [fallback, 128000, 64000]);
    assert(api.manageModels(f.store, { ...request, revision: plan.revision }, true).ok); assert.deepEqual(f.store.getProvider(provider.id).models.map(model => model.contextWindow), [300000, 300000, 64000]);
    assert.equal(api.manageModels(f.store, { ...request, revision: plan.revision }, true).ok, false);
  });
  await check('Model synchronization preserves user limits and explicit upstream metadata for new IDs', async () => {
    const f = fixture(), provider = f.save([{ id: 'gpt-6', contextWindow: 64000 }]);
    responseModels = [{ id: 'gpt-6', context_window: 1000000 }, { id: 'gpt-5', context_window: 128000 }, { id: 'codex-mini-latest' }, { id: 'gpt-4o', context_window: 0 }, { id: 'gpt-image-1' }, { id: 'deepseek-chat' }];
    const result = await api.fetchProviderModels({ store: f.store }, { providerId: provider.id }); assert(result.ok, result.message);
    assert.deepEqual(result.models.map(model => model.contextWindow), [64000, 128000, fallback, fallback, undefined, undefined]);
    assert.deepEqual(result.models, f.store.getProvider(provider.id).models);
  });
  await check('Legacy GPT metadata can be filled by an explicit sync without overriding concurrent manual edits', async () => {
    const f = fixture(), provider = f.save([{ id: 'gpt-6' }]);
    f.store.providers.write([{ ...provider, models: [{ id: 'gpt-6' }] }]); responseModels = [{ id: 'gpt-6', context_window: 196000 }];
    const first = await api.fetchProviderModels({ store: f.store }, { providerId: provider.id }); assert.equal(first.models[0].contextWindow, 196000);
    let resolveReady; const ready = new Promise(resolve => { resolveReady = resolve; }); received = resolveReady;
    const pending = api.fetchProviderModels({ store: f.store }, { providerId: provider.id }); await ready;
    f.store.saveProvider({ ...f.store.getProvider(provider.id), models: [{ id: 'gpt-6', contextWindow: 96000 }] }); pendingResponse();
    const result = await pending; received = undefined; assert.equal(result.models[0].contextWindow, 96000);
  });
  await check('Cloud imports default missing GPT limits and preserve explicit values across imports', () => {
    const f = fixture(); const item = { key: 'fixture-cloud', name: 'Cloud fixture', format: 'openai-chat', baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'gpt-6' }, { id: 'gpt-5', contextWindow: 128000 }, { id: 'gpt-4o', contextWindow: 1.5 }, { id: 'deepseek-chat' }] };
    const imported = api.importCloudProviders(f.store, [item]).providers[0]; assert.deepEqual(imported.models.map(model => model.contextWindow), [fallback, 128000, fallback, undefined]);
    f.store.saveProvider({ ...imported, models: imported.models.map(model => model.id === 'gpt-6' ? { ...model, contextWindow: 64000 } : model) });
    const again = api.importCloudProviders(f.store, [{ ...item, models: [{ id: 'gpt-6', contextWindow: 1000000 }] }]).providers[0]; assert.equal(again.models[0].contextWindow, 64000);
  });
  await check('Local Codex import uses the selected profile window and protects a later manual edit', () => {
    const f = fixture(), config = path.join(f.home, '.codex', 'config.toml');
    const source = value => `profile="work"\nmodel="gpt-4o"\nmodel_provider="relay"\nmodel_context_window=128000\n[profiles.work]\nmodel="gpt-6"\nmodel_context_window=${value}\n[model_providers.relay]\nbase_url="https://fixture.invalid/v1"\nexperimental_bearer_token="private-local-fixture-key"\n`;
    write(config, source(196000)); api.syncLocalClients(f.store, { home: f.home, force: true }); const provider = f.store.listProviders()[0]; assert.equal(provider.models[0].id, 'gpt-6'); assert.equal(provider.models[0].contextWindow, 196000);
    write(config, source(300000)); api.syncLocalClients(f.store, { home: f.home, force: true }); assert.equal(f.store.getProvider(provider.id).models[0].contextWindow, 300000);
    f.store.saveProvider({ ...f.store.getProvider(provider.id), models: [{ id: 'gpt-6', contextWindow: 64000 }] }); write(config, source(400000));
    const scanned = api.syncLocalClients(f.store, { home: f.home, force: true }); assert.equal(f.store.getProvider(provider.id).models[0].contextWindow, 64000); assert(scanned.sources.some(row => row.status === 'modified'));
  });
  await check('Coexist catalogs preserve official capacity and fill only missing text contexts without persistence', () => {
    const f = fixture(), provider = f.save([{ id: 'gpt-6' }, { id: 'gpt-5', contextWindow: 96000 }, { id: 'deepseek-chat' }]);
    f.store.providers.write([{ ...provider, models: [{ id: 'gpt-6' }, { id: 'gpt-5', contextWindow: 96000 }, { id: 'deepseek-chat' }] }]);
    write(path.join(f.home, '.codex', 'auth.json'), { auth_mode: 'chatgpt', tokens: { access_token: 'fixture-access', account_id: 'fixture-account' } });
    write(path.join(f.home, '.codex', 'models_cache.json'), { models: [{ slug: 'gpt-6', visibility: 'list' }, { slug: 'gpt-4o', visibility: 'list', context_window: 128000 }, { slug: 'codex-auto-review', visibility: 'list' }] });
    const before = fs.readFileSync(path.join(f.store.dir, 'providers.json')); f.store.writeExtra = () => { throw new Error('No diagnostic writes allowed'); };
    const catalog = api.getCoexistCatalog(f.store, false), native = id => catalog.nativeCatalog.models.find(model => model.slug === id);
    assert.equal(native('official/gpt-6').context_window, fallback); assert.equal(native('official/gpt-4o').context_window, 128000); assert.equal(native('official/codex-auto-review').context_window, undefined);
    assert.equal(native('official/gpt-6').auto_compact_token_limit, 244800); assert.equal(native('official/gpt-4o').auto_compact_token_limit, 115200);
    assert.equal(native(`${provider.id}/gpt-6`).context_window, fallback); assert.equal(native(`${provider.id}/gpt-5`).context_window, 96000); assert.equal(native(`${provider.id}/deepseek-chat`).context_window, 32768);
    assert.equal(native(`${provider.id}/gpt-6`).auto_compact_token_limit, 244800); assert.equal(native(`${provider.id}/gpt-5`).auto_compact_token_limit, 86400); assert.equal(native(`${provider.id}/deepseek-chat`).auto_compact_token_limit, 29491);
    assert.deepEqual(fs.readFileSync(path.join(f.store.dir, 'providers.json')), before); assert(!fs.existsSync(path.join(f.store.dir, 'codex-official-models.json')));
  });
  console.log(`Model context policy: ${checks} checks passed.`);
} finally {
  if (previousHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = previousHome;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir())); assert(path.basename(scratch).startsWith('yunhui-model-context-')); fs.rmSync(scratch, { recursive: true, force: true });
}
