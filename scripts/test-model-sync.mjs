/** Real delayed HTTP responses must not overwrite concurrent local provider edits. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-model-sync-')));
const bundle = path.join(scratch, 'core.cjs');
await build({ stdin: { contents: "export { fetchProviderModels } from './src/core/actions.ts'; export { AuroraStore } from './src/core/store/index.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
const { fetchProviderModels, AuroraStore } = createRequire(import.meta.url)(bundle);
let received, reply, requests = 0, passed = 0;
const server = http.createServer((_request, response) => {
  requests++;
  reply = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  received();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const store = new AuroraStore(path.join(scratch, 'data'));
async function check(name, mutate, verify, response = { data: [{ id: 'existing', context_window: 999 }, { id: 'remove-me' }, { id: 'discovered', context_window: 128000 }] }) {
  const provider = store.saveProvider({ name: 'before', baseUrl: endpoint, format: 'openai-chat', models: [{ id: 'existing', inputPrice: 2 }, { id: 'remove-me' }], apiKeys: [{ id: 'fixture', key: 'test-only-not-a-secret', enabled: true, weight: 1, label: 'test' }] });
  const ready = new Promise(resolve => { received = resolve; });
  const pending = fetchProviderModels({ store }, { providerId: provider.id });
  await ready;
  await mutate(provider);
  reply(response);
  const result = await pending;
  verify(result, store.getProvider(provider.id), provider);
  passed++; console.log('PASS', name);
}
try {
  await check('Deleted providers stay deleted after a delayed models response', p => store.deleteProvider(p.id), (result, current) => { assert.equal(result.ok, false); assert.equal(current, undefined); });
  await check('Concurrent model deletion and price/name edits survive synchronization', p => store.saveProvider({ ...p, name: 'edited', models: [{ id: 'existing', inputPrice: 9, capabilities: { tools: true } }] }), (result, current) => {
    assert.equal(result.ok, true); assert.equal(result.added, 1); assert.equal(current.name, 'edited');
    assert.deepEqual(current.models.map(m => m.id), ['existing', 'discovered']);
    assert.equal(current.models[0].inputPrice, 9); assert.equal(current.models[0].contextWindow, undefined); assert.equal(current.models[0].capabilities.tools, true);
  });
  await check('Changing the API endpoint discards the previous service response', p => store.saveProvider({ ...p, baseUrl: endpoint + '/changed' }), (result, current) => { assert.equal(result.ok, false); assert.match(result.message, /连接配置已变化/); assert.equal(current.models.length, 2); });
  await check('Rotating API credentials discards the previous account response', p => store.saveProvider({ ...p, apiKeys: [{ ...p.apiKeys[0], key: 'rotated-test-only-key' }] }), (result, current) => { assert.equal(result.ok, false); assert.equal(current.apiKeys[0].key, 'rotated-test-only-key'); assert.equal(current.models.length, 2); });
  await check('Mixed invalid model records do not discard valid models or save invalid limits', () => {}, (result, current) => {
    assert.equal(result.ok, true); assert.equal(result.added, 2);
    assert.deepEqual(current.models.map(m => m.id), ['existing', 'remove-me', 'good', 'bounded']);
    assert.equal(current.models[2].contextWindow, undefined); assert.equal(current.models[3].contextWindow, 32000);
  }, { data: [null, 5, { id: 12 }, { id: 'bad\nid' }, { id: 'good', context_window: -1 }, { id: 'good' }, { name: 'models/bounded', inputTokenLimit: 32000 }] });
  const original = store.saveProvider.bind(store);
  try {
    await check('Local persistence errors remain explicit without retrying another endpoint', () => { store.saveProvider = () => { throw new Error('fixture full disk'); }; }, (result, current) => {
      assert.equal(result.ok, false); assert.match(result.message, /本地保存失败/); assert.equal(current.models.length, 2);
    });
  } finally { store.saveProvider = original; }
  assert.equal(requests, passed);
  console.log(`Model synchronization: ${passed} checks passed.`);
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  assert(path.basename(scratch).startsWith('yunhui-model-sync-') && fs.realpathSync(path.dirname(scratch)) === fs.realpathSync(os.tmpdir()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
