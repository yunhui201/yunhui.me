/** Explicit connection tests use isolated state, real loopback gateways and fake model servers only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-connection-'));
const oldClientHome = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = path.join(scratch, 'client');
const servers = [], gateways = [], requests = [], proxyRequests = [], aborted = new Set();
const secrets = ['MOCK-UPSTREAM-PRIVATE', 'MOCK-GATEWAY-PRIVATE', 'MOCK-OAUTH-PRIVATE', 'MOCK-ERROR-PRIVATE'];
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
const waitUntil = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Timed out waiting for local mock event');
};
const listen = async (server, host = '127.0.0.1') => { servers.push(server); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); }); return `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`; };
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const modelNames = ['ok', 'slow', 'trickle', 'empty', 'badjson', 'error', 'redirect', 'oversized', 'incomplete', 'budget', 'thought-only', 'thought-and-answer', 'reasoning-budget', 'org/model:1', '通义千问-最新版', 'claude-opus-4.6 [1m]'];
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const geminiModel = /\/models\/(.*):generateContent$/.exec(req.url)?.[1];
  const model = body.model || (geminiModel && decodeURIComponent(geminiModel));
  const record = { path: req.url, model, body, headers: req.headers };
  requests.push(record);
  res.on('close', () => { if (!res.writableEnded) aborted.add(record); });
  if (model === 'slow') return;
  if (model === 'trickle') {
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"padding":"');
    const timer = setInterval(() => res.write(' '), 25);
    res.once('close', () => clearInterval(timer)); return;
  }
  if (model === 'badjson') { res.end(`<html>${secrets.join(' ')}</html>`); return; }
  if (model === 'error') { json(res, { error: { message: secrets.join(' ') } }, 401); return; }
  if (model === 'redirect') { res.writeHead(302, { location: 'https://must-never-follow.invalid/' }); res.end(); return; }
  if (model === 'oversized') { res.end(' '.repeat(512 * 1024 + 1)); return; }
  const noAnswer = ['empty', 'budget', 'thought-only', 'reasoning-budget'].includes(model);
  const text = noAnswer ? '' : `OK ${secrets.join(' ')}`;
  if (req.url.endsWith('/responses')) {
    json(res, { id: 'resp-mock', status: ['incomplete', 'budget'].includes(model) ? 'incomplete' : 'completed', model,
      ...(model === 'budget' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Thinking only' }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 3, output_tokens: noAnswer ? 1024 : 1, output_tokens_details: { reasoning_tokens: ['reasoning-budget', 'budget'].includes(model) ? 1024 : 0 } } });
  } else if (req.url.endsWith('/messages')) {
    json(res, { id: 'msg-mock', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: model === 'budget' ? 'max_tokens' : 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } });
  } else if (geminiModel) {
    const thoughts = ['thought-only', 'thought-and-answer', 'budget', 'reasoning-budget'].includes(model) ? [{ text: 'Thinking only', thought: true }] : [];
    json(res, { candidates: [{ content: { role: 'model', parts: [...thoughts, { text }] }, finishReason: model === 'budget' ? 'MAX_TOKENS' : 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, thoughtsTokenCount: model === 'reasoning-budget' ? 1024 : 0 } });
  } else {
    json(res, { id: 'chat-mock', model, choices: [{ message: { role: 'assistant', content: text, ...(noAnswer ? { reasoning_content: 'Thinking only' } : {}) }, finish_reason: model === 'budget' ? 'length' : 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: noAnswer ? 1024 : 1, completion_tokens_details: { reasoning_tokens: model === 'reasoning-budget' ? 1024 : 0 } } });
  }
});
let api, store, deps, gateway, providers;
try {
  const bundle = path.join(scratch, 'connection.cjs');
  await build({ stdin: { contents: "export * from './src/core/actions.ts'; export * from './src/core/store/index.ts'; export * from './src/core/gateway/server.ts'; export * from './src/core/gateway/security.ts';", resolveDir: workspace, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  api = createRequire(import.meta.url)(bundle);
  const mockUrl = await listen(mock);
  fs.mkdirSync(path.join(process.env.AURORA_CLIENT_HOME, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(process.env.AURORA_CLIENT_HOME, '.claude'), { recursive: true });
  const originals = new Map([
    [path.join(process.env.AURORA_CLIENT_HOME, '.codex', 'auth.json'), JSON.stringify({ token: secrets[2] })],
    [path.join(process.env.AURORA_CLIENT_HOME, '.codex', 'config.toml'), '# original codex\n'],
    [path.join(process.env.AURORA_CLIENT_HOME, '.claude', 'settings.json'), '{"original":true}'],
    [path.join(process.env.AURORA_CLIENT_HOME, '.claude.json'), '{"hasCompletedOnboarding":false}'],
  ]);
  for (const [file, body] of originals) fs.writeFileSync(file, body);
  store = new api.AuroraStore(path.join(scratch, 'store'));
  store.providers.write([]); store.plugins.write([]);
  store.saveSettings({ gatewayToken: secrets[1], maskSecrets: false, logRequests: false, maxRetries: 0 });
  providers = Object.fromEntries(['openai-chat', 'openai-responses', 'anthropic', 'gemini'].map(format => [format, store.saveProvider({ name: `Mock ${format}`, enabled: true, format, baseUrl: mockUrl, priority: 0,
    apiKeys: [{ id: 'mock-key', key: secrets[0], enabled: true, weight: 1 }], headers: { 'x-mock-supplier': format }, models: modelNames.map(id => ({ id })) })]));
  const decoy = store.saveProvider({ name: 'Same model decoy', enabled: true, format: 'openai-chat', baseUrl: mockUrl, priority: 999,
    apiKeys: [{ id: 'decoy-key', key: 'MOCK-WRONG-PROVIDER', enabled: true, weight: 1 }], models: [{ id: 'ok' }] });
  gateway = new api.GatewayServer({ store, actions: (action, payload) => api.runAction(deps, action, payload) }); gateways.push(gateway);
  const status = await gateway.start('127.0.0.1', 0);
  deps = { store, dataDir: store.dir, platform: 'win32', gatewayStatus: () => gateway.getStatus(), gatewayUrl: () => `http://127.0.0.1:${status.port}` };
  const call = (overrides = {}, customDeps = deps) => api.runAction(customDeps, 'agent.test', { requestId: randomUUID(), target: 'upstream', agentId: 'workbuddy', providerId: providers['openai-chat'].id, model: 'ok', ...overrides });
  const assertPrivate = result => { for (const marker of [...secrets, scratch, mockUrl]) assert(!JSON.stringify(result).includes(marker), 'Private response escaped'); assert(!('sample' in result)); };
  const protocols = [['workbuddy', 'openai-chat', '/v1/chat/completions'], ['codex-cli', 'openai-responses', '/v1/responses'], ['claude-code', 'anthropic', '/v1/messages'], ['gemini-cli', 'gemini', '/v1beta/models/ok:generateContent']];

  await check('direct tests make exactly one real model request in each supplier protocol', async () => {
    for (const [agentId, format, endpoint] of protocols) {
      const before = requests.length;
      const result = await call({ agentId, providerId: providers[format].id });
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.protocol, format); assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1).path, endpoint); assert.equal(requests.at(-1).model, 'ok');
      assert.equal(requests.at(-1).headers['x-mock-supplier'], format); assertPrivate(result);
      const body = requests.at(-1).body;
      assert.equal(body.max_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens, 1024);
      assert.equal(body.stream ?? false, false);
    }
  });
  await check('local tests traverse all client protocols and bind the selected supplier over a higher priority decoy', async () => {
    for (const [agentId, format] of protocols) {
      const before = requests.length;
      const result = await call({ target: 'local', agentId, providerId: providers['openai-chat'].id });
      assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.protocol, format); assert.equal(requests.length, before + 1);
      assert.equal(requests.at(-1).model, 'ok'); assert.equal(requests.at(-1).headers.authorization, `Bearer ${secrets[0]}`);
      assert(!JSON.stringify(requests.at(-1)).includes(secrets[1])); assertPrivate(result);
    }
    assert.equal(store.getProvider(decoy.id).apiKeys[0].key, 'MOCK-WRONG-PROVIDER');
  });
  await check('local native Gemini requests safely encode qualified and namespaced model IDs', async () => {
    for (const model of ['org/model:1', '通义千问-最新版', 'claude-opus-4.6 [1m]']) {
      for (const target of ['upstream', 'local']) {
        const result = await call({ target, agentId: 'gemini-cli', providerId: providers.gemini.id, model });
        assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(requests.at(-1).model, model);
      }
    }
  });
  await check('a routing group cannot redirect the selected supplier test to another account', async () => {
    const originalGroups = structuredClone(store.listGroups());
    const input = { name: `${providers['openai-chat'].id}/ok`, enabled: true, mode: 'order', members: [{ providerId: decoy.id, model: 'ok', weight: 1 }] };
    assert.throws(() => store.saveGroup(input), /分组名称/);
    assert.deepEqual(store.listGroups(), originalGroups);
    try {
      // Older saved profiles can contain aliases that new writes now reject.
      // Preserve the independent request-time protection against those profiles.
      store.groups.write([...originalGroups, { ...input, id: 'legacy-conflicting-group', retries: 2, createdAt: new Date().toISOString() }]);
      const before = requests.length;
      assert.equal((await call({ target: 'local' })).reason, 'route_mismatch'); assert.equal(requests.length, before);
    } finally { store.groups.write(originalGroups); }
  });
  await check('upstream tests work with gateway stopped, while local tests make no request', async () => {
    const stopped = { ...deps, gatewayStatus: () => ({ running: false }) };
    assert.equal((await call({}, stopped)).ok, true);
    const before = requests.length;
    assert.equal((await call({ target: 'local' }, stopped)).reason, 'gateway_stopped'); assert.equal(requests.length, before);
  });
  await check('remote callers, arbitrary URLs/paths, invalid IDs and unsaved models cannot dispatch requests', async () => {
    const before = requests.length;
    assert.equal((await call({}, { ...deps, platform: 'web' })).reason, 'desktop_only');
    for (const patch of [{ url: mockUrl }, { path: 'auth.json' }, { token: secrets[1] }, { headers: {} }, { model: '../secret' }, { model: 'https://fixture.invalid' }, { model: 'ok\n' }, { requestId: '../../secret' }, { agentId: 'unknown' }, { model: 'not-saved' }, { target: 'health' }, { authMode: 'unknown' }]) assert.equal((await call(patch)).ok, false);
    assert.equal(requests.length, before);
    assert.equal(api.REMOTE_ACTIONS.has('agent.test'), false); assert.equal(api.REMOTE_ACTIONS.has('agent.test.cancel'), false);
    const response = await fetch(deps.gatewayUrl() + '/api/rpc', { method: 'POST', headers: { authorization: `Bearer ${secrets[1]}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'agent.test', payload: { requestId: randomUUID() } }) });
    assert.equal(response.status, 403);
  });
  await check('official account tests are refused and coexist only tests API routing without reading OAuth', async () => {
    const read = fs.readFileSync; const forbidden = [];
    fs.readFileSync = function(file, ...args) { if (String(file).includes(process.env.AURORA_CLIENT_HOME)) { forbidden.push(file); throw new Error(secrets[2]); } return read.call(this, file, ...args); };
    try {
      const before = requests.length;
      assert.equal((await call({ agentId: 'codex-cli', providerId: 'official', authMode: 'coexist' })).reason, 'official_unsupported');
      assert.equal(requests.length, before);
      for (const target of ['local', 'upstream']) {
        const result = await call({ target, agentId: 'codex-cli', authMode: 'coexist' });
        assert.equal(result.ok, true); assert.match(result.message, /仅测试第三方 API 通道/); assertPrivate(result);
      }
      assert.equal(forbidden.length, 0);
    } finally { fs.readFileSync = read; }
  });
  await check('empty, HTML, API errors, redirects, oversized and incomplete responses fail without private output', async () => {
    for (const model of ['empty', 'badjson', 'error', 'redirect', 'oversized']) {
      const result = await call({ model }); assert.equal(result.ok, false, model); assertPrivate(result);
    }
    const result = await call({ agentId: 'codex-cli', providerId: providers['openai-responses'].id, model: 'incomplete' });
    assert.equal(result.reason, 'invalid_response'); assertPrivate(result);
    assert.equal((await call({ target: 'local', model: 'empty' })).reason, 'no_text_response');
  });
  await check('all native protocols distinguish output budget exhaustion without automatic retries', async () => {
    for (const [agentId, format] of protocols) {
      for (const target of ['upstream', 'local']) {
        const before = requests.length;
        const result = await call({ target, agentId, providerId: providers[format].id, model: 'budget' });
        assert.equal(result.ok, false); assert.equal(result.reason, 'budget_exhausted', JSON.stringify(result));
        assert.match(result.message, /不一定是连接配置错误/); assert.equal(requests.length, before + 1); assertPrivate(result);
      }
    }
  });
  await check('reasoning-only exhausted responses are distinct from protocol errors even without a finish marker', async () => {
    for (const [agentId, format] of protocols.filter(([, format]) => format !== 'anthropic')) {
      const before = requests.length;
      const result = await call({ agentId, providerId: providers[format].id, model: 'reasoning-budget' });
      assert.equal(result.reason, 'budget_exhausted', JSON.stringify(result)); assert.equal(requests.length, before + 1); assertPrivate(result);
    }
  });
  await check('Gemini thought-only responses cannot pass, while visible text alongside thoughts can', async () => {
    for (const target of ['upstream', 'local']) {
      const before = requests.length;
      const thoughts = await call({ target, agentId: 'gemini-cli', providerId: providers.gemini.id, model: 'thought-only' });
      assert.equal(thoughts.ok, false); assert.equal(thoughts.reason, 'no_text_response'); assert.equal(requests.length, before + 1); assertPrivate(thoughts);
      const answer = await call({ target, agentId: 'gemini-cli', providerId: providers.gemini.id, model: 'thought-and-answer' });
      assert.equal(answer.ok, true); assertPrivate(answer);
    }
  });
  await check('Gemini thoughts never become a successful final answer after conversion to Claude, Responses or Chat', async () => {
    for (const agentId of ['claude-code', 'codex-cli', 'workbuddy']) {
      const before = requests.length;
      const thoughts = await call({ target: 'local', agentId, providerId: providers.gemini.id, model: 'thought-only' });
      assert.equal(thoughts.ok, false); assert.equal(thoughts.reason, 'no_text_response'); assert.equal(requests.length, before + 1); assertPrivate(thoughts);
      const answer = await call({ target: 'local', agentId, providerId: providers.gemini.id, model: 'thought-and-answer' });
      assert.equal(answer.ok, true); assertPrivate(answer);
    }
  });
  await check('duplicate request IDs share a request and cached result, changed parameters require a new ID', async () => {
    const requestId = randomUUID(), before = requests.length;
    const [a, b] = await Promise.all([call({ requestId }), call({ requestId })]);
    assert.deepEqual(a, b); assert.equal(a.ok, true); assert.equal(requests.length, before + 1);
    assert.deepEqual(await call({ requestId }), a); assert.equal(requests.length, before + 1);
    assert.equal((await call({ requestId, model: 'empty' })).reason, 'duplicate_request'); assert.equal(requests.length, before + 1);
  });
  await check('superseding requests cancel upstream sockets, and stale cancel cannot affect the next request', async () => {
    const requestId = randomUUID(), before = requests.length;
    const first = call({ requestId, model: 'slow' }); await waitUntil(() => requests.length > before); const record = requests.at(-1);
    const second = call();
    assert.equal((await api.runAction(deps, 'agent.test.cancel', { requestId })).canceled, false);
    assert.equal((await first).reason, 'superseded'); assert.equal((await second).ok, true);
    await waitUntil(() => aborted.has(record));
  });
  await check('explicit cancellation also propagates through local gateway to upstream socket', async () => {
    const requestId = randomUUID(), before = requests.length;
    const pending = call({ requestId, target: 'local', model: 'slow' }); await waitUntil(() => requests.length > before); const record = requests.at(-1);
    assert.equal((await api.runAction(deps, 'agent.test.cancel', { requestId })).canceled, true);
    const result = await pending; assert.equal(result.canceled, true); assert.equal(result.reason, 'canceled'); assertPrivate(result);
    await waitUntil(() => aborted.has(record));
  });
  await check('global and supplier proxies apply upstream, but the local gateway hop bypasses them', async () => {
    const makeProxy = label => http.createServer((req, res) => {
      const url = new URL(req.url); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, String(mock.address().port), 'Local gateway request was incorrectly proxied');
      proxyRequests.push({ label, url: url.href });
      const outgoing = http.request(url, { method: req.method, headers: req.headers }, incoming => { res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res); });
      outgoing.on('error', () => res.destroy()); req.pipe(outgoing);
    });
    const globalUrl = await listen(makeProxy('global')), providerUrl = await listen(makeProxy('provider'));
    store.saveSettings({ proxy: globalUrl });
    for (const target of ['upstream', 'local']) {
      const before = proxyRequests.length; assert.equal((await call({ target })).ok, true);
      assert.equal(proxyRequests.length, before + 1); assert.equal(proxyRequests.at(-1).label, 'global');
    }
    store.saveProvider({ ...store.getProvider(providers['openai-chat'].id), proxy: providerUrl });
    for (const target of ['upstream', 'local']) {
      const before = proxyRequests.length; assert.equal((await call({ target })).ok, true);
      assert.equal(proxyRequests.length, before + 1); assert.equal(proxyRequests.at(-1).label, 'provider');
    }
    store.saveSettings({ proxy: '' }); store.saveProvider({ ...store.getProvider(providers['openai-chat'].id), proxy: '' });
  });
  await check('local test ignores gateway URL callbacks and refuses external listening addresses', async () => {
    assert.equal((await call({ target: 'local' }, { ...deps, gatewayUrl: () => 'https://never-contact.invalid' })).ok, true);
    const before = requests.length;
    const external = { ...deps, gatewayStatus: () => ({ ...gateway.getStatus(), host: 'external.invalid' }) };
    assert.equal((await call({ target: 'local' }, external)).reason, 'invalid_gateway'); assert.equal(requests.length, before);
  });
  await check('an HTTP 200 from a different local service cannot pass gateway route verification', async () => {
    const other = await listen(http.createServer((req, res) => json(res, { choices: [{ message: { content: 'OK' } }] })));
    const wrong = { ...deps, gatewayStatus: () => ({ ...gateway.getStatus(), port: Number(new URL(other).port) }) };
    assert.equal((await call({ target: 'local' }, wrong)).reason, 'route_mismatch');
  });
  await check('IPv6 loopback gateway works without forwarding its token to supplier', async () => {
    const ipv6 = new api.GatewayServer({ store }); gateways.push(ipv6);
    let ipv6Status;
    try { ipv6Status = await ipv6.start('::1', 0); } catch (error) { if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { console.log('SKIP IPv6 unavailable on this host'); return; } throw error; }
    const result = await call({ target: 'local' }, { ...deps, gatewayStatus: () => ipv6Status });
    assert.equal(result.ok, true, JSON.stringify(result)); assert(!JSON.stringify(requests.at(-1)).includes(secrets[1]));
  });
  await check('absolute deadline aborts a continuously trickling response after 30 seconds', async () => {
    const before = requests.length, started = Date.now();
    const pending = call({ model: 'trickle' }); await waitUntil(() => requests.length > before); const record = requests.at(-1);
    const result = await pending;
    assert.equal(result.reason, 'timeout'); assert.equal(result.ok, false); assert(Date.now() - started < 33_000); assertPrivate(result);
    await waitUntil(() => aborted.has(record));
  });
  await check('connection tests never change native configuration, OAuth files or managed client state', async () => {
    for (const [file, body] of originals) assert.equal(fs.readFileSync(file, 'utf8'), body);
    assert.deepEqual(store.listAgents(), {});
    assert.equal(fs.existsSync(path.join(process.env.AURORA_CLIENT_HOME, '.codex', '.aurora-backups')), false);
  });
  console.log(`\n${passed} client connection checks passed.`);
} finally {
  for (const gateway of gateways) await gateway.stop();
  for (const server of servers) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  if (oldClientHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = oldClientHome;
  fs.rmSync(scratch, { recursive: true, force: true });
}
