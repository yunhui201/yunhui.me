/** Historical provider aliases: actual HTTP, private profiles and local stub suppliers only. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-history-gateway-')));
const originalHome = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = path.join(scratch, 'client');
const home = path.join(process.env.AURORA_CLIENT_HOME, '.codex'); fs.mkdirSync(home, { recursive: true });
const bundle = path.join(scratch, 'core.cjs');
await build({ stdin: { contents: ['store/index', 'gateway/server', 'gateway/coexist', 'gateway/historyRoute', 'gateway/upstream']
  .map(name => `export * from './src/core/${name}.ts';`).join('\n'), resolveDir: root, loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const api = createRequire(import.meta.url)(bundle);
const calls = [], modes = { selected: 'ok', other: 'ok', official: 'ok' };
const mock = kind => http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  calls.push({ kind, path: req.url, headers: req.headers, body });
  if (modes[kind] === 'fail') { res.writeHead(503); res.end('fixture unavailable'); return; }
  const value = { id: `response-${kind}`, object: req.url.endsWith('/compact') ? 'response.compaction' : 'response',
    status: 'completed', model: body.model, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: kind }] }],
    usage: { input_tokens: 4, output_tokens: 1 } };
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
});
const selectedMock = mock('selected'), otherMock = mock('other'), officialMock = mock('official');
const servers = [selectedMock, otherMock, officialMock];
await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
const store = new api.AuroraStore(path.join(scratch, 'store'));
store.saveSettings({ gatewayHost: '127.0.0.1', gatewayToken: 'fixture-gateway-key', maskSecrets: false, maxRetries: 3, logRequests: true });
const supplier = (name, server, secret, priority) => store.saveProvider({ name, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  format: 'openai-responses', enabled: true, priority, models: [{ id: 'chosen-model' }, { id: 'folder/模型-v1' }],
  apiKeys: [{ id: 'key', label: 'fixture', key: secret, enabled: true, weight: 1 }] });
const other = supplier('Other supplier', otherMock, 'fixture-other-secret', 100);
const selected = supplier('Selected supplier', selectedMock, 'fixture-selected-secret', 0);
store.saveProvider({ id: other.id, name: selected.id }); // An existing supplier name collides with the selected ID.
const target = `${selected.id}/chosen-model`;
const jwt = generation => `${Buffer.from('{"alg":"fixture"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600, generation })).toString('base64url')}.fixture`;
let officialToken = jwt(1);
const auth = path.join(home, 'auth.json');
const writeAuth = () => fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: officialToken, account_id: 'fixture-account', refresh_token: 'fixture-refresh-never-forward' } }));
writeAuth();
fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'chosen-model', visibility: 'list', base_instructions: 'fixture' }] }));
store.saveAgent({ id: 'chatgpt-desktop', connected: true, mode: 'gateway', authMode: 'coexist', providerId: selected.id, model: 'chosen-model' });
const gateway = new api.GatewayServer({ store, officialTransport: (url, options) => {
  assert(['https://chatgpt.com/backend-api/codex/responses', 'https://chatgpt.com/backend-api/codex/responses/compact'].includes(url));
  return api.openUpstream(`http://127.0.0.1:${officialMock.address().port}${new URL(url).pathname}`, options);
} });
await gateway.start('127.0.0.1', 0);
const port = gateway.getStatus().port, base = `http://127.0.0.1:${port}`;
store.saveSettings({ gatewayPort: port });
const config = `model_provider = "openai"\nopenai_base_url = "${api.codexCoexistBaseUrl(port)}"\n`;
fs.writeFileSync(path.join(home, 'config.toml'), config);
const apiPath = api.codexHistoryBasePath(target), coexistPath = api.codexHistoryBasePath(target, 'coexist');
const request = (pathname, body, token = 'fixture-gateway-key', headers = {}) => fetch(base + pathname, {
  method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const consume = async response => ({ status: response.status, body: await response.json() });
const snapshotCalls = () => calls.length;
let checks = 0;
const check = async (name, run) => { await run(); checks++; console.log('PASS', name); };
try {
  await check('Canonical paths preserve exact provider IDs and models containing slashes and Unicode', async () => {
    const route = api.codexHistoryBasePath(`${selected.id}/folder/模型-v1`);
    assert.equal(api.parseCodexHistoryRoute(route + '/responses').model, 'folder/模型-v1');
    assert.throws(() => api.codexHistoryBasePath('provider/\ud800'));
    const reply = await consume(await request(route + '/responses', { model: 'retired/old-model', input: 'old chat' }));
    assert.equal(reply.status, 200); assert.equal(calls.at(-1).kind, 'selected'); assert.equal(calls.at(-1).body.model, 'folder/模型-v1');
  });
  await check('API aliases replace unknown old models and stale supplier prefixes with the reviewed binding', async () => {
    for (const model of ['unknown-old-model', 'removed-supplier/old-model', 'official/chosen-model', `${other.id}/chosen-model`]) {
      const reply = await consume(await request(apiPath + '/responses', { model, input: 'continue', metadata: { retained: 'yes' } }));
      assert.equal(reply.status, 200); const sent = calls.at(-1);
      assert.equal(sent.kind, 'selected'); assert.equal(sent.body.model, 'chosen-model'); assert.equal(sent.body.metadata.retained, 'yes');
      assert.equal(sent.headers.authorization, 'Bearer fixture-selected-secret');
    }
  });
  await check('Group collisions and model-map plugins cannot redirect either dedicated route', async () => {
    const group = store.saveGroup({ name: 'fixture-group', members: [{ providerId: other.id, model: 'chosen-model', weight: 1 }] });
    store.groups.write([{ ...group, name: target }]); // A legacy/manual file bypassing current name validation.
    store.savePlugin({ id: 'model-map', name: 'Model map', builtin: true, enabled: true, options: { mapping: { [target]: `${other.id}/chosen-model` } } });
    for (const [pathname, token] of [[apiPath, 'fixture-gateway-key'], [coexistPath, officialToken]]) {
      const reply = await consume(await request(pathname + '/responses', { model: 'retired-model', input: 'test' }, token));
      assert.equal(reply.status, 200); assert.equal(calls.at(-1).kind, 'selected'); assert.equal(calls.at(-1).body.model, 'chosen-model');
    }
    store.plugins.write([]); store.groups.write([]);
  });
  await check('Dedicated API authentication cannot be replaced with OAuth or spoofed client headers', async () => {
    const before = snapshotCalls();
    for (const token of ['', 'wrong', officialToken]) {
      const reply = await consume(await request(apiPath + '/responses', { model: target, input: [] }, token,
        { 'x-aurora-agent': 'Codex', 'x-codex-provider': selected.id, 'x-api-key': 'wrong' }));
      assert.equal(reply.status, 401);
    }
    assert.equal(calls.length, before);
  });
  await check('Raw traversal in historical paths cannot normalize into an ordinary model route', async () => {
    const before = snapshotCalls();
    for (const [pathname, token, status] of [['/codex-history/../../v1/responses', 'fixture-gateway-key', 400],
      ['/codex-coexist/history/../../v1/responses', officialToken, 404]]) {
      const result = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
          res.resume(); res.on('end', () => resolve(res.statusCode));
        }); req.on('error', reject); req.end(JSON.stringify({ model: 'chosen-model', input: [] }));
      });
      assert.equal(result, status);
    }
    assert.equal(calls.length, before);
  });
  await check('Missing, disabled, and keyless API bindings never fall back to a same-name supplier', async () => {
    const before = snapshotCalls();
    assert.equal((await consume(await request(api.codexHistoryBasePath('deleted-supplier/chosen-model') + '/responses', { model: 'chosen-model', input: [] }))).status, 404);
    store.saveProvider({ id: selected.id, enabled: false });
    assert.equal((await consume(await request(apiPath + '/responses', { model: 'chosen-model', input: [] }))).status, 409);
    store.saveProvider({ id: selected.id, enabled: true, apiKeys: selected.apiKeys.map(key => ({ ...key, enabled: false })) });
    assert.equal((await consume(await request(apiPath + '/responses', { model: 'chosen-model', input: [] }))).status, 503);
    assert.equal(calls.length, before); store.saveProvider(selected);
  });
  await check('Supplier failures and cooled keys remain confined to the bound supplier', async () => {
    modes.selected = 'fail'; const before = snapshotCalls();
    const result = await consume(await request(apiPath + '/responses', { model: 'chosen-model', input: [] }));
    assert.equal(result.status, 503); assert(calls.slice(before).every(call => call.kind === 'selected')); modes.selected = 'ok';
    store.saveProvider({ id: selected.id, apiKeys: selected.apiKeys.map(key => ({ ...key, cooldownUntil: new Date(Date.now() + 60000).toISOString() })) });
    const cooled = snapshotCalls(); assert.equal((await request(apiPath + '/responses', { input: [] })).status, 503); assert.equal(calls.length, cooled);
    store.saveProvider(selected);
  });
  await check('Malformed or noncanonical encoded bindings are rejected before any upstream request', async () => {
    const encoded = value => Buffer.from(value).toString('base64url'), valid = encoded(target);
    const invalid = [valid + '=', '%41' + valid.slice(1), 'cC9tYR', Buffer.from([255, 254]).toString('base64url'),
      encoded('/no-provider'), encoded('provider/'), encoded('provider/model\n'), encoded('provider/' + 'm'.repeat(401)), 'A'.repeat(3201)];
    const before = snapshotCalls();
    for (const segment of invalid) {
      assert.equal(api.parseCodexHistoryRoute(`/codex-history/${segment}/v1/responses`), null);
      assert.equal((await request(`/codex-history/${segment}/v1/responses`, { model: 'chosen-model', input: [] })).status, 400);
      assert.equal((await request(`/codex-coexist/history/${segment}/v1/responses`, { model: 'chosen-model', input: [] }, officialToken)).status, 404);
    }
    assert.equal(calls.length, before);
  });
  await check('API models list exposes only the binding and compressed historical bodies retain content', async () => {
    const result = await consume(await request(apiPath + '/models')); assert.equal(result.status, 200);
    assert.deepEqual(result.body.data.map(model => model.id), [target]);
    const reply = await fetch(base + apiPath + '/responses', { method: 'POST', headers: { authorization: 'Bearer fixture-gateway-key', 'content-encoding': 'gzip' },
      body: gzipSync(Buffer.from(JSON.stringify({ model: 'retired', input: '保留正文🌏' }))) });
    assert.equal(reply.status, 200); await reply.json(); assert.equal(calls.at(-1).body.input, '保留正文🌏');
  });
  await check('Coexist aliases keep JWT authentication and send suppliers only their own key', async () => {
    const before = snapshotCalls();
    for (const token of ['', 'wrong', 'fixture-gateway-key']) assert.equal((await request(coexistPath + '/responses', { model: 'old', input: [] }, token)).status, 401);
    assert.equal((await request(coexistPath + '/responses', { model: 'old', input: [] }, officialToken, { origin: base })).status, 403);
    assert.equal(calls.length, before);
    for (const model of ['unknown-old-model', 'deleted-provider/old-model', 'official/chosen-model']) {
      const reply = await consume(await request(coexistPath + '/responses', { model, input: 'continue' }, officialToken,
        { cookie: 'fixture-official-cookie', 'chatgpt-account-id': 'fixture-hostile-account', 'x-openai-actor-authorization': officialToken, 'x-api-key': officialToken }));
      assert.equal(reply.status, 200); const sent = calls.at(-1); assert.equal(sent.kind, 'selected'); assert.equal(sent.body.model, 'chosen-model');
      assert.equal(sent.headers.authorization, 'Bearer fixture-selected-secret');
      for (const secret of [officialToken, 'fixture-official-cookie', 'fixture-account', 'fixture-hostile-account', 'fixture-refresh']) assert(!JSON.stringify(sent).includes(secret));
    }
  });
  await check('Coexist aliases reject unavailable bindings without official or third-party fallback', async () => {
    const before = snapshotCalls(), body = { model: 'chosen-model', input: [] };
    assert.equal((await request(api.codexHistoryBasePath('deleted-supplier/chosen-model', 'coexist') + '/responses', body, officialToken)).status, 404);
    store.saveProvider({ id: selected.id, enabled: false });
    assert.equal((await request(coexistPath + '/responses', body, officialToken)).status, 409);
    store.saveProvider({ id: selected.id, enabled: true, apiKeys: selected.apiKeys.map(key => ({ ...key, enabled: false })) });
    assert.equal((await request(coexistPath + '/responses', body, officialToken)).status, 503);
    store.saveProvider(selected);
    assert.equal((await request(api.codexHistoryBasePath(`${selected.id}/removed-model`, 'coexist') + '/responses', body, officialToken)).status, 400);
    assert.equal(calls.length, before);
  });
  await check('Official history bindings preserve fixed official routing and genuine compact behavior', async () => {
    const officialPath = api.codexHistoryBasePath('official/chosen-model', 'coexist');
    for (const endpoint of ['responses', 'responses/compact']) {
      const reply = await consume(await request(officialPath + '/' + endpoint, { model: `${other.id}/old`, input: [] }, officialToken));
      assert.equal(reply.status, 200); const sent = calls.at(-1); assert.equal(sent.kind, 'official');
      assert.equal(sent.body.model, 'chosen-model'); assert.equal(sent.headers.authorization, `Bearer ${officialToken}`);
      assert.equal(sent.path, '/backend-api/codex/' + endpoint);
    }
    const before = snapshotCalls(); assert.equal((await request(coexistPath + '/responses/compact', { model: 'old', input: [] }, officialToken)).status, 501);
    assert.equal(calls.length, before);
    const models = await consume(await request(coexistPath + '/models', undefined, officialToken));
    assert.equal(models.status, 200); assert.deepEqual(models.body.models.map(model => model.slug), [target]);
  });
  await check('Credential rotation between authorization and request planning rejects stale authorization', async () => {
    const before = snapshotCalls(), pathname = coexistPath + '/responses';
    const authorized = api.authorizeCodexCoexistRequest({ url: pathname, socket: { remoteAddress: '127.0.0.1' }, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${officialToken}` } }, store);
    assert(authorized.ok); const previous = officialToken; officialToken = jwt(2); writeAuth();
    assert.throws(() => api.prepareCodexCoexistRequest(authorized.authorization, store, pathname, { model: 'old', input: [] }), error => error.status === 409);
    assert.equal((await request(pathname, { model: 'old', input: [] }, previous)).status, 401); assert.equal(calls.length, before);
    assert.equal((await request(pathname, { model: 'old', input: [] }, officialToken)).status, 200);
  });
  await check('Ordinary API and coexist routes retain their existing model selection behavior', async () => {
    assert.equal((await request('/v1/responses', { model: 'unknown-old-model', input: [] })).status, 400);
    assert.equal((await request('/v1/responses', { model: 'chosen-model', input: [] })).status, 200); assert.equal(calls.at(-1).kind, 'other');
    assert.equal((await request('/codex-coexist/v1/responses', { model: 'unknown-old-model', input: [] }, officialToken)).status, 400);
    assert.equal((await request('/codex-coexist/v1/responses', { model: 'official/chosen-model', input: [] }, officialToken)).status, 200); assert.equal(calls.at(-1).kind, 'official');
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), config);
    assert.equal(JSON.parse(fs.readFileSync(auth, 'utf8')).tokens.access_token, officialToken);
    const logs = JSON.stringify(store.recentRequests(100)); for (const secret of [officialToken, 'fixture-selected-secret', 'fixture-refresh']) assert(!logs.includes(secret));
  });
  console.log(JSON.stringify({ passed: true, checks, historyGatewayAcceptance: 'bound-provider-model-http' }));
} finally {
  await gateway.stop();
  await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })));
  if (originalHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = originalHome;
  assert.equal(path.dirname(scratch), fs.realpathSync(os.tmpdir())); assert(path.basename(scratch).startsWith('yunhui-history-gateway-'));
  fs.rmSync(scratch, { recursive: true, force: true });
}
