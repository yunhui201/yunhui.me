/** Isolated fault, routing and storage regressions from the engineering audit. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-engineering-')));
process.env.AURORA_CLIENT_HOME = path.join(scratch, 'clients');
const bundle = path.join(scratch, 'core.cjs');
await build({ stdin: { contents: ['store/index', 'gateway/router', 'gateway/server', 'actions', 'util'].map(file => `export * from './src/core/${file}.ts';`).join('\n'), resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
const { AuroraStore, JsonFile, JsonLines, Router, GatewayServer, summarizeUsage, dayKey, runAction } = createRequire(import.meta.url)(bundle);
let count = 0, sequence = 0, gateway;
const check = async (name, fn) => { await fn(); count++; console.log('PASS', name); };
const fresh = () => new AuroraStore(path.join(scratch, `store-${++sequence}`));
const keys = n => Array.from({ length: n }, (_, i) => ({ id: `key-${i}`, key: `fixture-key-${i}`, enabled: true, label: 'Fixture', weight: 1 }));
const provider = (store, name = 'Supplier', n = 1) => store.saveProvider({ name, baseUrl: 'http://127.0.0.1:4444', models: [{ id: 'model-a' }], apiKeys: keys(n) });
const records = [];
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString()); records.push({ model: body.model, key: req.headers.authorization });
  if (body.model === 'invalid-success') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('invalid fixture JSON'); return; }
  if (body.model === 'reject-first' && req.headers.authorization === 'Bearer fixture-key-0') {
    res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fixture rejection"}}'); return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
});
try {
  await check('Round-robin chooses suppliers equally even when one supplier has three API keys', () => {
    const store = fresh(), a = provider(store, 'A', 3), b = provider(store, 'B');
    const group = store.saveGroup({ name: 'Rotate', mode: 'rotate', members: [a, b].map(p => ({ providerId: p.id, model: 'model-a', weight: 1 })) });
    const router = new Router(store), picks = Array.from({ length: 8 }, () => router.resolveModel(`group/${group.id}`).candidates[0].provider.id);
    assert.equal(picks.filter(id => id === a.id).length, 4); assert.equal(picks.filter(id => id === b.id).length, 4);
  });
  await check('Weighted routing honors member weights independently from key count and preserves failover', () => {
    const store = fresh(), a = provider(store, 'A', 3), b = provider(store, 'B');
    const group = store.saveGroup({ name: 'Weighted', mode: 'weight', members: [{ providerId: a.id, model: 'model-a', weight: 1 }, { providerId: b.id, model: 'model-a', weight: 2 }] });
    const router = new Router(store), routes = Array.from({ length: 9 }, () => router.resolveModel(`group/${group.id}`).candidates);
    assert.equal(routes.filter(items => items[0].provider.id === a.id).length, 3);
    assert(routes.every(items => items.length === 4));
  });
  await check('A failed old key cannot cool down its newly rotated replacement', () => {
    const store = fresh(), p = provider(store), router = new Router(store);
    store.saveProvider({ id: p.id, apiKeys: [{ ...p.apiKeys[0], key: 'fixture-rotated' }] });
    router.markKeyFailure(p.id, p.apiKeys[0].id, 'HTTP 401', 60000, p.apiKeys[0].key);
    assert.equal(router.resolveModel(`${p.id}/model-a`).candidates.length, 1);
    assert.equal(store.getProvider(p.id).apiKeys[0].lastError, undefined);
  });
  await check('Disk failure cannot disable in-memory key cooldowns or conceal the storage warning', () => {
    const store = fresh(), p = provider(store, 'Disk', 2), router = new Router(store);
    store.providers.write = () => { throw new Error('fixture disk full'); };
    router.markKeyFailure(p.id, p.apiKeys[0].id, 'HTTP 401');
    assert(router.persistenceWarning);
    assert.deepEqual(router.resolveModel(`${p.id}/model-a`).candidates.map(item => item.key.id), ['key-1']);
    router.markKeySuccess(p.id, 'key-1');
    assert(router.persistenceWarning);
  });
  await check('Supplier deletion protects active, imported-pending and cross-provider role bindings', () => {
    const store = fresh(), a = provider(store, 'A'), b = provider(store, 'B');
    for (const state of [
      { connected: true, providerId: a.id },
      { connected: false, pendingReapply: true, providerId: a.id },
      { connected: true, pendingReapply: false, providerId: b.id, modelMap: { opus: `${a.id}/model-a` } },
    ]) {
      store.saveAgent({ id: 'claude-code', ...state });
      assert.throws(() => store.deleteProvider(a.id), /请先更换或恢复客户端配置/); assert(store.getProvider(a.id));
    }
  });
  await check('Deleting an unused supplier rolls back if removing its group references fails', () => {
    const store = fresh(), p = provider(store), group = store.saveGroup({ name: 'Group', members: [{ providerId: p.id, model: 'model-a', weight: 1 }] });
    store.groups.write = () => { throw new Error('fixture disk full'); };
    assert.throws(() => store.deleteProvider(p.id), /已撤回/);
    assert.equal(new AuroraStore(store.dir).getProvider(p.id).id, p.id);
    assert.equal(store.listGroups()[0].id, group.id);
    assert.equal(store.listGroups()[0].members.length, 1);
  });
  await check('Late editor saves cannot silently recreate a deleted supplier or group', () => {
    const store = fresh(), p = provider(store), group = store.saveGroup({ name: 'Empty group' });
    store.deleteProvider(p.id); store.deleteGroup(group.id);
    assert.throws(() => store.saveProvider(p), /已被删除/);
    assert.throws(() => store.saveGroup(group), /已被删除/);
    assert.equal(store.listProviders().length, 0); assert.equal(store.listGroups().length, 0);
  });
  await check('Multi-file deletion rechecks every next file and preserves intervening external changes', () => {
    const store = fresh(), p = provider(store), group = store.saveGroup({ name: 'Group', notes: 'before', members: [{ providerId: p.id, model: 'model-a', weight: 1 }] });
    const write = store.providers.write.bind(store.providers);
    store.providers.write = value => { write(value); if (!value.length) fs.writeFileSync(path.join(store.dir, 'groups.json'), JSON.stringify([{ ...group, notes: 'external change' }])); };
    assert.throws(() => store.deleteProvider(p.id), /检测到外部配置修改/);
    assert.equal(store.listGroups()[0].notes, 'external change'); assert(store.getProvider(p.id));
  });
  await check('Invalid keys, negative rates, missing group members and duplicate backup IDs are rejected before writes', () => {
    const store = fresh(), p = provider(store);
    assert.throws(() => store.saveProvider({ id: p.id, apiKeys: [p.apiKeys[0], p.apiKeys[0]] }), /密钥标识/);
    assert.throws(() => store.saveProvider({ id: p.id, rateMultiplier: -1 }), /倍率/);
    assert.throws(() => store.saveGroup({ name: 'Bad', members: [{ providerId: 'missing', model: null, weight: 1 }] }), /不存在的供应商/);
    const group = store.saveGroup({ name: 'Good' }), backup = store.exportAll(); backup.groups.push(group);
    assert.throws(() => store.importAll(backup), /分组 ID 重复/); assert.equal(store.listGroups().length, 1);
  });
  await check('Exported backups are snapshots, so editing a backup cannot mutate the live store', () => {
    const store = fresh(), p = provider(store), backup = store.exportAll();
    backup.providers[0].name = 'edited backup'; backup.providers[0].apiKeys[0].key = 'fixture-edited';
    assert.equal(store.getProvider(p.id).name, p.name); assert.equal(store.getProvider(p.id).apiKeys[0].key, 'fixture-key-0');
  });
  await check('Import rollback continues to restore other files when one rollback write also fails', () => {
    const store = fresh(), p = provider(store), originalSettings = store.getSettings(), backup = store.exportAll();
    backup.providers[0].name = 'changed'; backup.settings.theme = 'dark';
    let rollingBack = false;
    const originalGroupWrite = store.groups.write.bind(store.groups);
    store.groups.write = value => { if (rollingBack) throw Error('fixture-private-error'); originalGroupWrite(value); };
    store.plugins.write = () => { rollingBack = true; throw Error('fixture-private-error'); };
    assert.throws(() => store.importAll(backup), error => error.message.includes('部分配置无法恢复') && !error.message.includes('fixture-private-error'));
    assert.equal(store.getProvider(p.id).name, 'Supplier'); assert.equal(store.getSettings().theme, originalSettings.theme);
  });
  await check('A concurrent external configuration edit survives an import rollback conflict', () => {
    const store = fresh(), p = provider(store), backup = store.exportAll(); backup.providers[0].name = 'imported';
    const external = { ...p, name: 'external change' };
    store.plugins.write = () => { fs.writeFileSync(path.join(store.dir, 'providers.json'), JSON.stringify([external])); throw Error('fixture disk full'); };
    assert.throws(() => store.importAll(backup), /配置已变化/);
    assert.equal(store.getProvider(p.id).name, external.name);
  });
  await check('Invalid JSON errors do not echo configuration credentials', () => {
    const file = path.join(scratch, 'invalid.json'); fs.writeFileSync(file, 'fixture-private-secret-not-json');
    assert.throws(() => new JsonFile(file, () => ({})).read(), error => error.message.includes('JSON 格式无效') && !error.message.includes('fixture-private-secret'));
  });
  await check('Failed gateway restart preserves settings changed by another action while it awaited I/O', async () => {
    const store = fresh(); let restarts = 0;
    const deps = { store, dataDir: store.dir, gatewayStatus: () => ({ running: true }), gatewayUrl: () => 'http://127.0.0.1:3425',
      restartGateway: async () => { if (++restarts === 1) { store.saveSettings({ theme: 'dark', gatewayToken: 'fixture-rotated-gateway-token' }); throw Error('fixture restart failure'); } } };
    await assert.rejects(runAction(deps, 'settings.save', { gatewayPort: 43215 }), /已保留当前文件/);
    assert.equal(store.getSettings().theme, 'dark'); assert.equal(store.getSettings().gatewayToken, 'fixture-rotated-gateway-token'); assert.equal(restarts, 2);
  });
  await check('Tail reads preserve split UTF-8, ignore malformed trailing rows and avoid loading the whole file', () => {
    const file = path.join(scratch, 'large.jsonl');
    const data = Array.from({ length: 20000 }, (_, id) => ({ id, text: '中文🌏'.repeat(8) }));
    fs.writeFileSync(file, data.map(item => JSON.stringify(item)).join('\n') + '\n{invalid\n');
    const originalRead = fs.readSync; let readBytes = 0;
    fs.readSync = (...args) => { const n = originalRead(...args); readBytes += n; return n; };
    try { assert.deepEqual(new JsonLines(file).read(7), data.slice(-7)); }
    finally { fs.readSync = originalRead; }
    assert(readBytes <= 65536, `Tail read loaded ${readBytes} bytes`);
    fs.writeFileSync(file, data.slice(0, 3).map(item => JSON.stringify(item)).join('\r\n'));
    assert.deepEqual(new JsonLines(file).read(50), data.slice(0, 3));
  });
  await check('Recent usage reads only enough newest daily logs and tolerates corrupt record shapes', () => {
    const store = fresh(), record = { ts: new Date().toISOString(), agent: 'fixture', providerId: 'p', providerName: 'p', model: 'm', requestId: 'r', status: 200, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cost: 0, latencyMs: 1, attempts: 1 };
    const today = path.join(store.usageDirPath(), dayKey() + '.jsonl');
    fs.writeFileSync(today, Array.from({ length: 5 }, (_, i) => JSON.stringify({ ...record, requestId: String(i) })).join('\n') + '\n{}\n');
    const yesterday = path.join(store.usageDirPath(), dayKey(new Date(Date.now() - 86400000)) + '.jsonl');
    fs.writeFileSync(yesterday, JSON.stringify({ ...record, requestId: 'yesterday' }) + '\n');
    assert.deepEqual(store.recentRequests(3).map(item => item.requestId), ['4', '3', '2']);
    assert.equal(store.readUsage(2).length, 6);
  });
  await check('A damaged multi-megabyte log line is skipped without hiding valid earlier requests', () => {
    const file = path.join(scratch, 'damaged-tail.jsonl');
    fs.writeFileSync(file, '{"id":1}\n' + 'x'.repeat(3 * 1024 * 1024) + '\n{"id":2}\n');
    assert.deepEqual(new JsonLines(file).read(10), [{ id: 1 }, { id: 2 }]);
  });
  await check('Unknown prices are distinguished from explicitly free models and excluded from known-price totals', () => {
    const store = fresh(), p = provider(store), router = new Router(store);
    assert.equal(router.costKnown(p, p.models[0]), false);
    assert.equal(router.costKnown(p, { id: 'free', inputPrice: 0, outputPrice: 0 }), true);
    assert.equal(router.costKnown(p, { id: 'cache-unknown', inputPrice: 1, outputPrice: 2 }, { cacheRead: 100 }), false);
    const base = { ts: '2026-11-15T00:00:00Z', providerId: p.id, providerName: p.name, model: 'm', agent: 'a', inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0, status: 200 };
    const summary = summarizeUsage([{ ...base, cost: 12, costKnown: false }, { ...base, cost: 2, costKnown: true }, { ...base, cost: 0, status: 0, error: 'connection refused' }]);
    assert.equal(summary.totals.cost, 2); assert.equal(summary.totals.unpricedCalls, 1); assert.equal(summary.totals.errors, 1);
    assert.equal(summary.byProvider[0].unpricedCalls, 1); assert.equal(summary.byDay[0].unpricedCalls, 1);
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const liveStore = fresh(), p = provider(liveStore, 'Live', 2);
  liveStore.saveProvider({ id: p.id, name: 'Fixture\ud800Name', baseUrl: `http://127.0.0.1:${mock.address().port}`, models: [{ id: 'model-a' }, { id: 'reject-first' }, { id: 'invalid-success' }] });
  gateway = new GatewayServer({ store: liveStore, onRequest: () => { throw Error('fixture observer failure'); } });
  await gateway.start('127.0.0.1', 0);
  const post = model => fetch(`http://127.0.0.1:${gateway.getStatus().port}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${liveStore.getSettings().gatewayToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: `${p.id}/${model}`, messages: [{ role: 'user', content: 'Fixture' }] }) });
  await check('Successful upstream responses are delivered exactly once despite metadata and observer write failures', async () => {
    liveStore.providers.write = () => { throw Error('fixture disk full'); };
    const before = records.length, response = await post('model-a');
    assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, 'ok');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(records.length - before, 1); assert(gateway.getStatus().lastError);
    assert.equal(liveStore.recentRequests(1)[0].costKnown, false);
  });
  await check('A malformed successful response never triggers a second billed upstream request', async () => {
    const before = records.length, response = await post('invalid-success');
    assert.equal(response.status, 502); assert((await response.json()).error.message.includes('未自动重试'));
    await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(records.length - before, 1);
  });
  console.log(`\nEngineering regressions: ${count} checks passed.`);
} finally {
  if (gateway) await gateway.stop();
  mock.closeAllConnections(); if (mock.listening) await new Promise(resolve => mock.close(resolve));
  assert(path.basename(scratch).startsWith('yunhui-engineering-'));
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
