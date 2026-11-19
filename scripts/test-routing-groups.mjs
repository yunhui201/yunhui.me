/** Real HTTP routing integration. Every upstream is a local mock; no client files or paid requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-routing-groups-')));
const priorHome = process.env.AURORA_CLIENT_HOME; process.env.AURORA_CLIENT_HOME = path.join(root, 'clients');
const records = [], behaviors = new Map();
let api, passed = 0, sequence = 0, active;
const upstream = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), slot = req.url.split('/')[1];
  const behavior = behaviors.get(slot) || {}, format = behavior.format || 'openai-chat';
  const model = format === 'gemini' ? decodeURIComponent(/\/models\/(.+):(?:generateContent|streamGenerateContent)/.exec(req.url)?.[1] || '') : body.model;
  const record = { slot, model, key: req.headers.authorization || req.headers['x-api-key'] || req.headers['x-goog-api-key'], body, path: req.url };
  records.push(record);
  const status = typeof behavior.status === 'function' ? behavior.status(record) : behavior.status;
  if (behavior.reset) { res.destroy(); return; }
  if (status) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture upstream failure' } })); return; }
  if (behavior.invalidJson) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('invalid JSON fixture'); return; }
  const stream = body.stream || /:streamGenerateContent/.test(req.url), text = '来自 ' + slot + ' 的测试回答';
  if (stream) {
    const encoder = api.createEncoder(format, { requestId: 'fixture-request', model, clientModel: model, upstreamFormat: format });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encoder.push({ type: 'start', id: 'fixture-request', model }));
    res.write(encoder.push({ type: 'text_delta', index: 0, text }));
    if (!behavior.truncated) {
      res.write(encoder.push({ type: 'usage', usage: { inputTokens: 12, outputTokens: 6 } }));
      res.write(encoder.push({ type: 'stop', stopReason: 'end_turn' })); res.write(encoder.end());
    }
    res.end(); return;
  }
  const usage = { inputTokens: 12, outputTokens: 6 };
  const result = api.buildClientJson(format, { id: 'fixture-request', model, blocks: [{ type: 'text', text }], stopReason: 'end_turn', usage },
    { requestId: 'fixture-request', model, clientModel: model, upstreamFormat: format });
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
try {
  const bundle = path.join(root, 'api.cjs');
  await build({ stdin: { contents: "export * from './src/core/actions.ts';export * from './src/core/store/index.ts';export * from './src/core/gateway/server.ts';export * from './src/core/protocol/index.ts';", resolveDir: path.resolve(import.meta.dirname, '..'), loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  api = createRequire(import.meta.url)(bundle);
  async function check(label, fn) {
    records.length = 0; behaviors.clear();
    const store = new api.AuroraStore(path.join(root, 'store-' + ++sequence));
    store.saveSettings({ gatewayToken: 'fixture-gateway-token', maskSecrets: false, logRequests: true, maxRetries: 0, requestTimeoutMs: 5000, firstByteTimeoutMs: 2000 });
    const gateway = active = new api.GatewayServer({ store }); await gateway.start('127.0.0.1', 0);
    const url = `http://127.0.0.1:${gateway.getStatus().port}`, deps = { store, dataDir: store.dir, platform: process.platform, gatewayStatus: () => gateway.getStatus(), gatewayUrl: () => url };
    const provider = (slot, options = {}) => {
      behaviors.set(slot, { format: options.format || 'openai-chat', ...options.behavior });
      const saved = store.saveProvider({ name: slot, format: options.format || 'openai-chat', baseUrl: upstreamUrl + '/' + slot + '/v1', enabled: true,
        apiKeys: Array.from({ length: options.keys || 1 }, (_, index) => ({ id: slot + '-' + index, key: 'fixture-' + slot + '-' + index, enabled: true, weight: 1 })),
        models: [{ id: 'model-' + slot, inputPrice: 10, outputPrice: 20 }], ...options, behavior: undefined, keys: undefined });
      return options.quota ? store.saveProvider({ id: saved.id, quota: options.quota }) : saved;
    };
    const group = (members, options = {}) => api.runAction(deps, 'group.save', { name: 'coding', mode: 'order', enabled: true, retries: 2,
      members: members.map(member => member.providerId ? member : { providerId: member.id, model: null, weight: 1 }), ...options });
    const request = async (model = 'group/coding', options = {}) => {
      const protocol = options.protocol || 'openai-chat', stream = !!options.stream;
      const endpoint = protocol === 'anthropic' ? '/v1/messages' : protocol === 'openai-responses' ? '/v1/responses'
        : protocol === 'gemini' ? '/v1beta/models/' + encodeURIComponent(model) + (stream ? ':streamGenerateContent' : ':generateContent') : '/v1/chat/completions';
      const body = protocol === 'openai-responses' ? { model, input: 'hello', stream }
        : protocol === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }
        : { model, messages: [{ role: 'user', content: 'hello' }], max_tokens: 32, stream };
      const response = await fetch(url + endpoint, { method: 'POST', headers: { authorization: 'Bearer fixture-gateway-token', 'content-type': 'application/json', 'x-aurora-agent': 'Codex' }, body: JSON.stringify(body) });
      const text = await response.text(); let json; try { json = JSON.parse(text); } catch {}
      return { status: response.status, text, json, headers: response.headers };
    };
    try { await fn({ store, gateway, deps, provider, group, request, url }); passed++; console.log('PASS ' + label); }
    finally { await gateway.stop(); active = undefined; }
  }
  await check('Saved group alias selects its explicit member model and returns a stable JSON model name', async f => {
    const a = f.provider('a', { models: [{ id: 'default-a' }, { id: 'selected-a' }] }), b = f.provider('b');
    const g = await f.group([{ providerId: a.id, model: 'selected-a', weight: 1 }, b]);
    const result = await f.request(); assert.equal(result.status, 200, result.text); assert.equal(records[0].slot, 'a'); assert.equal(records[0].model, 'selected-a');
    assert.equal(result.json.model, 'group/coding'); assert.equal(decodeURIComponent(result.headers.get('x-aurora-provider')), 'a');
    const byId = await f.request('group/' + g.id); assert.equal(byId.status, 200); assert.equal(records.at(-1).slot, 'a');
    const listed = await fetch(f.url + '/v1/models', { headers: { authorization: 'Bearer fixture-gateway-token' } }).then(response => response.json());
    assert(listed.data.some(model => model.id === 'group/coding'));
  });
  await check('Order follows the member list while bare-model priority follows provider priority', async f => {
    const a = f.provider('a', { priority: 1, models: [{ id: 'shared' }] }), b = f.provider('b', { priority: 99, models: [{ id: 'shared' }] });
    await f.group([a, b]); assert.equal((await f.request()).status, 200); assert.equal(records.at(-1).slot, 'a');
    assert.equal((await f.request('shared')).status, 200); assert.equal(records.at(-1).slot, 'b');
  });
  await check('Round robin selects members equally regardless of their number of API keys', async f => {
    const a = f.provider('a', { keys: 3 }), b = f.provider('b'); await f.group([a, b], { mode: 'rotate' });
    for (let i = 0; i < 6; i++) assert.equal((await f.request()).status, 200);
    assert.deepEqual(records.map(record => record.slot), ['a', 'b', 'a', 'b', 'a', 'b']); assert.equal(new Set(records.filter(record => record.slot === 'a').map(record => record.key)).size, 3);
  });
  await check('Weighted HTTP routing honors the configured ratio independently of key count', async f => {
    const a = f.provider('a', { keys: 3 }), b = f.provider('b');
    await f.group([{ providerId: a.id, model: null, weight: 1 }, { providerId: b.id, model: null, weight: 2 }], { mode: 'weight' });
    for (let i = 0; i < 9; i++) assert.equal((await f.request()).status, 200);
    assert.equal(records.filter(record => record.slot === 'a').length, 3); assert.equal(records.filter(record => record.slot === 'b').length, 6);
  });
  await check('Zero-weight members receive no requests under the weight strategy', async f => {
    const a = f.provider('a'), b = f.provider('b');
    await f.group([{ providerId: a.id, model: null, weight: 0 }, { providerId: b.id, model: null, weight: 1 }], { mode: 'weight' });
    for (let i = 0; i < 3; i++) assert.equal((await f.request()).status, 200);
    assert(records.every(record => record.slot === 'b'));
  });
  await check('Disabled suppliers and disabled or cooling API keys are not called', async f => {
    const a = f.provider('a', { enabled: false }), b = f.provider('b', { apiKeys: [{ id: 'disabled', key: 'fixture-disabled', enabled: false, weight: 1 }] });
    const c = f.provider('c', { apiKeys: [{ id: 'cooling', key: 'fixture-cooling', enabled: true, weight: 1, cooldownUntil: new Date(Date.now() + 60000).toISOString() }] }), d = f.provider('d');
    await f.group([a, b, c, d]); assert.equal((await f.request()).status, 200); assert.deepEqual(records.map(record => record.slot), ['d']);
  });
  await check('Missing, disabled and empty explicit groups never fall through to wildcard providers', async f => {
    const a = f.provider('a', { models: [] }); await f.group([a], { enabled: false });
    for (const model of ['group/coding', 'group/missing', 'group/']) assert.equal((await f.request(model)).status, 400);
    assert.equal(records.length, 0);
  });
  await check('An explicitly removed member model is skipped instead of sent upstream', async f => {
    const a = f.provider('a'), b = f.provider('b'); const saved = await f.group([{ providerId: a.id, model: 'model-a', weight: 1 }, b]);
    f.store.saveProvider({ id: a.id, models: [{ id: 'replacement-a' }] }); assert.equal((await f.request()).status, 200); assert.deepEqual(records.map(record => record.slot), ['b']);
    await api.runAction(f.deps, 'group.save', { id: saved.id, enabled: false }); assert.equal((await f.request()).status, 400);
  });
  await check('HTTP failures switch suppliers within the group retry budget even when global retries are zero', async f => {
    const a = f.provider('a', { behavior: { status: 503 } }), b = f.provider('b'); await f.group([a, b], { retries: 1 });
    const result = await f.request(); assert.equal(result.status, 200, result.text); assert.deepEqual(records.map(record => record.slot), ['a', 'b']);
    assert.equal(f.store.recentRequests(1)[0].attempts, 2);
  });
  await check('Retries zero sends exactly one request and preserves the upstream failure status', async f => {
    const a = f.provider('a', { behavior: { status: 503 } }), b = f.provider('b'); await f.group([a, b], { retries: 0 });
    assert.equal((await f.request()).status, 503); assert.deepEqual(records.map(record => record.slot), ['a']);
  });
  await check('Every extra key attempt consumes the configured budget and final failures identify the last supplier', async f => {
    const a = f.provider('a', { keys: 2, behavior: { status: 503 } }), b = f.provider('b', { behavior: { status: 502 } });
    const saved = await f.group([a, b], { retries: 1 }); assert.equal((await f.request()).status, 503); assert.deepEqual(records.map(record => record.slot), ['a', 'a']);
    records.length = 0; await api.runAction(f.deps, 'group.save', { id: saved.id, retries: 2 });
    assert.equal((await f.request()).status, 502); assert.deepEqual(records.map(record => record.slot), ['a', 'a', 'b']);
    const last = f.store.recentRequests(1)[0]; assert.equal(last.providerId, b.id); assert.equal(last.model, 'model-b'); assert.equal(last.attempts, 3);
  });
  await check('Key authentication failure switches keys then excludes the failed key on the next request', async f => {
    const a = f.provider('a', { keys: 2, behavior: { status: record => record.key.endsWith('-0') ? 401 : undefined } }), b = f.provider('b'); await f.group([a, b], { retries: 1 });
    assert.equal((await f.request()).status, 200); assert.deepEqual(records.map(record => record.key), ['Bearer fixture-a-0', 'Bearer fixture-a-1']);
    assert.equal((await f.request()).status, 200); assert.equal(records.at(-1).key, 'Bearer fixture-a-1'); assert(records.every(record => record.slot === 'a'));
    assert(f.store.getProvider(a.id).apiKeys[0].cooldownUntil);
  });
  await check('Rate limits fail over and cooling suppliers stay excluded until cooldown expires', async f => {
    const a = f.provider('a', { behavior: { status: 429 } }), b = f.provider('b'); await f.group([a, b], { retries: 1 });
    assert.equal((await f.request()).status, 200); assert.equal((await f.request()).status, 200); assert.deepEqual(records.map(record => record.slot), ['a', 'b', 'b']);
    f.gateway.router.resetCooldowns(); behaviors.set('a', {}); assert.equal((await f.request()).status, 200); assert.equal(records.at(-1).slot, 'a');
  });
  await check('Transport failure before an accepted response can switch suppliers', async f => {
    const a = f.provider('a', { behavior: { reset: true } }), b = f.provider('b'); await f.group([a, b], { retries: 1 });
    assert.equal((await f.request()).status, 200); assert.deepEqual(records.map(record => record.slot), ['a', 'b']);
  });
  await check('Usage strategy balances successful requests over the running gateway session', async f => {
    const a = f.provider('a'), b = f.provider('b'); await f.group([a, b], { mode: 'usage' });
    for (let i = 0; i < 4; i++) assert.equal((await f.request()).status, 200);
    assert.deepEqual(records.map(record => record.slot), ['a', 'b', 'a', 'b']);
  });
  await check('Quota strategy prefers lower peak reported utilization and places unknown quotas last', async f => {
    const a = f.provider('a', { quota: { windows: [{ label: 'day', usedPercent: 10 }, { label: 'month', usedPercent: 90 }] } });
    const b = f.provider('b', { quota: { windows: [{ label: 'day', usedPercent: 40 }] } }), c = f.provider('c', { priority: 999 });
    await f.group([c, a, b], { mode: 'pace' }); assert.equal((await f.request()).status, 200); assert.deepEqual(records.map(record => record.slot), ['b']);
  });
  await check('Health strategy remembers server failures and prefers a working supplier on the next request', async f => {
    const a = f.provider('a', { priority: 100, behavior: { status: 503 } }), b = f.provider('b', { priority: 1 }); await f.group([a, b], { mode: 'smart', retries: 1 });
    assert.equal((await f.request()).status, 200); assert.equal((await f.request()).status, 200); assert.deepEqual(records.map(record => record.slot), ['a', 'b', 'b']);
  });
  await check('Invalid accepted responses are not retried or counted as successful usage', async f => {
    const a = f.provider('a', { behavior: { invalidJson: true } }), b = f.provider('b'); await f.group([a, b], { mode: 'usage', retries: 1 });
    assert.equal((await f.request()).status, 502); assert.deepEqual(records.map(record => record.slot), ['a']);
    assert.equal(f.store.getProvider(a.id).apiKeys[0].lastUsedAt, undefined);
  });
  await check('Groups fail over across protocols and translate Anthropic requests to OpenAI responses', async f => {
    const a = f.provider('a', { format: 'anthropic', behavior: { status: 503 } }), b = f.provider('b'); await f.group([a, b], { retries: 1 });
    const result = await f.request(undefined, { protocol: 'anthropic' }); assert.equal(result.status, 200, result.text); assert.equal(result.json.type, 'message');
    assert(result.json.content.some(item => item.text?.includes('来自 b'))); assert.deepEqual(records.map(record => record.slot), ['a', 'b']); assert.equal(records[1].model, 'model-b');
  });
  await check('Cross-protocol streamed failover returns real text and a completed client stream', async f => {
    const a = f.provider('a', { behavior: { status: 503 } }), b = f.provider('b', { format: 'anthropic' }); await f.group([a, b], { retries: 1 });
    const result = await f.request(undefined, { stream: true }); assert.equal(result.status, 200, result.text); assert(result.text.includes('来自 b')); assert(result.text.includes('[DONE]'));
    assert.deepEqual(records.map(record => record.slot), ['a', 'b']); assert.equal(f.store.recentRequests(1)[0].attempts, 2);
  });
  await check('A stream that already emitted text is never retried or marked successful', async f => {
    const a = f.provider('a', { behavior: { truncated: true } }), b = f.provider('b'); await f.group([a, b], { retries: 1 });
    const result = await f.request(undefined, { stream: true }); assert.equal(result.status, 200); assert(result.text.includes('来自 a')); assert.deepEqual(records.map(record => record.slot), ['a']);
    assert.equal(f.store.recentRequests(1)[0].status, 502); assert.equal(f.store.getProvider(a.id).apiKeys[0].lastUsedAt, undefined);
  });
  await check('Group alias routes a Responses client to Gemini using the correct upstream URL model', async f => {
    const a = f.provider('a', { format: 'gemini', models: [{ id: 'native-model:free' }] }); await f.group([a]);
    const result = await f.request(undefined, { protocol: 'openai-responses' }); assert.equal(result.status, 200, result.text); assert.equal(records[0].model, 'native-model:free');
    assert(result.json.output.some(item => item.content?.some(content => content.text?.includes('来自 a'))));
  });
  await check('Group billing uses the selected native model prices and supplier multiplier', async f => {
    const a = f.provider('a', { rateMultiplier: 2, models: [{ id: 'priced', inputPrice: 10, outputPrice: 20 }] }); await f.group([a]);
    assert.equal((await f.request()).status, 200); const usage = f.store.recentRequests(1)[0]; assert.equal(usage.costKnown, true); assert(Math.abs(usage.cost - 0.00048) < 1e-10);
    assert.equal(usage.model, 'priced'); assert.equal(usage.requestModel, 'group/coding');
  });
  await check('Group names cannot ambiguously select a duplicate name and invalid weights never reach storage', async f => {
    const a = f.provider('a'); await f.group([a]); const before = JSON.stringify(f.store.listGroups());
    await assert.rejects(() => f.group([a]), /名称|重名|存在/);
    for (const weight of [-1, 0.5, 1001]) await assert.rejects(() => f.group([{ providerId: a.id, model: null, weight }], { name: 'bad-' + String(weight) }), /权重/);
    assert.equal(JSON.stringify(f.store.listGroups()), before);
  });
  await check('Renames and imported backups cannot create duplicate aliases or shadow another group ID', async f => {
    const a = f.provider('a'), first = await f.group([a]), second = await f.group([a], { name: 'secondary' });
    const before = JSON.stringify(f.store.listGroups());
    await assert.rejects(() => api.runAction(f.deps, 'group.save', { id: second.id, name: ' CODING ' }), /名称/);
    await assert.rejects(() => f.group([a], { name: first.id }), /名称|ID/);
    const backup = f.store.exportAll(); backup.groups[1].name = 'coding'; assert.throws(() => f.store.importAll(backup), /名称/);
    for (const name of ['bad/name', 'bad?name', 'bad#name', 'bad\nname']) await assert.rejects(() => f.group([a], { name }), /名称/);
    assert.equal(JSON.stringify(f.store.listGroups()), before);
  });
  console.log(`Routing groups over real HTTP: ${passed} checks passed.`);
} finally {
  await active?.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  if (priorHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = priorHome;
  assert.equal(fs.realpathSync(path.dirname(root)), fs.realpathSync(os.tmpdir())); assert(path.basename(root).startsWith('yunhui-routing-groups-')); fs.rmSync(root, { recursive: true, force: true });
}
