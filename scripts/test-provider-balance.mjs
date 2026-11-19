import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-balance-test-'));
let checks = 0, sequence = 0, server;
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`); };
try {
  const bundle = path.join(root, 'balance.cjs');
  await build({ stdin: { contents: "export * from './src/core/providerBalance.ts'; export * from './src/core/providerBalanceValidation.ts'; export * from './src/core/gateway/security.ts'; export * from './src/core/store/index.ts'; export { runAction } from './src/core/actions.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  const m = createRequire(import.meta.url)(bundle), fresh = () => new m.AuroraStore(path.join(root, `store-${++sequence}`));
  const key = (id = 'key-1', secret = `fixture-${id}`) => ({ id, label: `Label ${id}`, key: secret, enabled: true, weight: 1 });
  const provider = (store, changes = {}) => store.saveProvider({ name: 'Fixture supplier', baseUrl: 'https://api.deepseek.com', models: [], apiKeys: [key()], ...changes });
  const response = (data, status = 200, headers = {}) => {
    const raw = new PassThrough(); process.nextTick(() => raw.end(typeof data === 'string' ? data : JSON.stringify(data)));
    return { status, headers, raw, stream: raw };
  };
  const deepseek = value => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: value }] });
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const now = Date.now;
  async function at(milliseconds, fn) { Date.now = () => milliseconds; try { return await fn(); } finally { Date.now = now; } }

  await check('Adapter auto-detection uses exact API hosts and leaves unsupported or disabled providers offline', async () => {
    const store = fresh(); let calls = 0;
    for (const host of ['api.openai.com', 'api.anthropic.com', 'api.siliconflow.cn', 'api.deepseek.com.evil.test', 'relay.test']) {
      const p = provider(store, { baseUrl: `https://${host}`, presetId: 'deepseek' }), result = await m.providerBalance(store, { providerId: p.id }, async () => { calls++; return response(deepseek(0)); });
      assert.equal(result.items[0].status, 'unsupported'); assert.deepEqual(result.items[0].entries, []);
    }
    for (const changes of [{ enabled: false }, { balanceQuery: { adapter: 'disabled' } }, { baseUrl: '' }, { apiKeys: [key('empty', '')] }]) {
      const p = provider(store, changes); await m.providerBalance(store, { providerId: p.id }, async () => { calls++; return response(deepseek(0)); });
    }
    assert.equal(calls, 0);
    assert.equal(m.detectBalanceAdapter({ baseUrl: 'https://api.moonshot.ai/v1' }), 'moonshot'); assert.equal(m.detectBalanceAdapter({ baseUrl: 'https://api.yunhui.me' }), 'sub2api');
  });
  await check('Official balances preserve actual zero, debt and multiple currencies without inferring validity from funds', () => {
    const p = { baseUrl: 'https://api.deepseek.com' }, entries = m.parseProviderBalance('deepseek', { is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '0' }, { currency: 'USD', total_balance: '-2.5' }] }, p);
    assert.deepEqual(entries.map(e => [e.currency, e.remaining]), [['CNY', 0], ['USD', -2.5]]);
    assert.equal(m.parseProviderBalance('moonshot', { data: { available_balance: 0 } }, { baseUrl: 'https://api.moonshot.cn' })[0].currency, 'CNY');
    assert.equal(m.parseProviderBalance('moonshot', { code: 123, status: true, data: { available_balance: 0 } }, { baseUrl: 'https://api.moonshot.ai' })[0].remaining, 0);
    assert.throws(() => m.parseProviderBalance('moonshot', { status: false, data: { available_balance: 0 } }, p), /无效数据/);
    assert.equal(m.parseProviderBalance('moonshot', { data: { available_balance: -3 } }, { baseUrl: 'https://api.moonshot.ai' })[0].currency, 'USD');
    assert.equal(m.parseProviderBalance('stepfun', { balance: -8 }, p)[0].remaining, -8);
    assert.equal(m.parseProviderBalance('novita', { availableBalance: 25000 }, p)[0].remaining, 2.5);
    const openrouter = m.parseProviderBalance('openrouter', { data: { total_credits: 10, total_usage: 12 } }, p)[0]; assert.equal(openrouter.remaining, -2); assert.equal(openrouter.scope, 'account');
    for (const value of [null, undefined, '', ' ', false, 'NaN', 'Infinity', Infinity]) assert.throws(() => m.parseProviderBalance('deepseek', deepseek(value), p), /有效金额/);
    assert.throws(() => m.parseProviderBalance('openrouter', { data: { limit_remaining: 10 } }, p), /有效金额/);
  });
  await check('Sub2API account wallet, key limits and subscription periods remain distinct', () => {
    const p = { baseUrl: 'https://relay.test/prefix/v1' };
    assert.equal(m.parseProviderBalance('sub2api', { mode: 'unrestricted', balance: -1, remaining: -1 }, p)[0].remaining, -1);
    const limits = m.parseProviderBalance('sub2api', { mode: 'quota_limited', quota: { limit: 20, used: 5, remaining: 15 }, rate_limits: [{ window: '5h', limit: 6, used: 5, remaining: 1, reset_at: '2030-01-01T00:00:00Z' }] }, p);
    assert.equal(limits.length, 2); assert(limits.every(e => e.scope === 'key')); assert.equal(limits[1].resetsAt, '2030-01-01T00:00:00.000Z');
    const subscription = m.parseProviderBalance('sub2api', { mode: 'unrestricted', subscription: { daily_limit_usd: 10, daily_usage_usd: 8, weekly_limit_usd: 50, weekly_usage_usd: 20 }, remaining: 2 }, p); assert.equal(subscription.length, 2); assert(subscription.every(e => e.scope === 'subscription'));
    assert.equal(m.parseProviderBalance('sub2api', { mode: 'unrestricted', subscription: {}, remaining: -1 }, p)[0].unlimited, true);
    assert.throws(() => m.parseProviderBalance('sub2api', { mode: 'unrestricted', remaining: 10, usage: { total: { cost: 100 } } }, p), /未提供/);
  });
  await check('New API quota points require verified site units and never masquerade as an account wallet', () => {
    const p = { baseUrl: 'https://relay.test/prefix/v1' }, token = { success: true, data: { object: 'token_usage', unlimited_quota: false, total_available: 1000000, total_granted: 1500000, total_used: 500000 } };
    const points = m.parseProviderBalance('newapi', token, p)[0]; assert.equal(points.currency, 'POINTS'); assert.equal(points.remaining, 1000000); assert.equal(points.scope, 'key');
    const yuan = m.parseProviderBalance('newapi', token, p, { success: true, data: { quota_per_unit: 500000, quota_display_type: 'CNY', usd_exchange_rate: 7 } })[0]; assert.equal(yuan.currency, 'CNY'); assert.equal(yuan.remaining, 14);
    assert.equal(m.parseProviderBalance('newapi', { ...token, data: { ...token.data, unlimited_quota: true } }, p)[0].unlimited, true);
    assert.equal(m.parseProviderBalance('newapi', { ...token, data: { ...token.data, unlimited_quota: true, user_quota: { total_available: -100 } } }, p)[0].scope, 'account');
    assert.throws(() => m.parseProviderBalance('newapi', { ...token, success: false, message: 'fixture-secret' }, p), error => !error.message.includes('fixture-secret'));
  });
  await check('Multiple enabled keys produce separate results and a selected key queries only that credential', async () => {
    const store = fresh(), p = provider(store, { apiKeys: [key('one'), key('two'), { ...key('off'), enabled: false }] }), calls = [];
    const transport = async (url, options) => { calls.push({ url, ...options }); return response(deepseek(options.headers.authorization.endsWith('one') ? 1 : 2)); };
    const result = await m.providerBalance(store, { providerId: p.id }, transport); assert.equal(result.items.length, 2); assert.deepEqual(result.items.map(i => i.entries[0].remaining), [1, 2]); assert.equal(result.balance, undefined);
    assert(calls.every(c => c.method === 'GET' && c.url === 'https://api.deepseek.com/user/balance')); assert.equal(calls.length, 2);
    const selected = await m.providerBalance(store, { providerId: p.id, keyId: 'one' }, transport); assert.equal(selected.items.length, 1); assert.equal(selected.items[0].keyId, 'one'); assert.equal(calls.length, 2);
  });
  await check('Success cache, force throttling, expiration and failed refresh preserve only same-configuration old values', async () => {
    const store = fresh(), p = provider(store); let requests = 0;
    const good = async () => { requests++; return response(deepseek(4)); }, start = Date.now();
    await m.providerBalance(store, { providerId: p.id }, good);
    await at(start + 5000, () => m.providerBalance(store, { providerId: p.id, force: true }, good)); assert.equal(requests, 1);
    await at(start + 20000, () => m.providerBalance(store, { providerId: p.id }, good)); assert.equal(requests, 1);
    await at(start + 20000, () => m.providerBalance(store, { providerId: p.id, force: true }, good)); assert.equal(requests, 2);
    const failure = await at(start + 400000, () => m.providerBalance(store, { providerId: p.id }, async () => { requests++; return response({ error: { message: 'fixture-secret' } }, 401); }));
    assert.equal(failure.items[0].status, 'error'); assert.equal(failure.items[0].stale, true); assert.equal(failure.items[0].entries[0].remaining, 4); assert(!JSON.stringify(failure).includes('fixture-secret'));
    const repeated = await at(start + 400001, () => m.providerBalance(store, { providerId: p.id }, good)); assert.equal(repeated.items[0].cached, true); assert.equal(requests, 3);
  });
  await check('Corrupt snapshots cannot remain fresh through future timestamps or nonnumeric amounts', async () => {
    for (const corrupt of [
      item => { item.checkedAt = '2099-01-01T00:00:00.000Z'; },
      item => { delete item.updatedAt; },
      item => { item.updatedAt = '2099-01-01T00:00:00.000Z'; },
      item => { item.entries[0].remaining = '4'; },
      item => { item.entries[0].remaining = null; },
      item => { item.entries[0].remaining = false; },
      item => { item.entries = []; },
    ]) {
      const store = fresh(), p = provider(store); let calls = 0;
      await m.providerBalance(store, { providerId: p.id }, async () => { calls++; return response(deepseek(4)); });
      const file = path.join(store.dir, 'provider-balances.json'), cache = JSON.parse(fs.readFileSync(file, 'utf8'));
      corrupt(Object.values(cache.items)[0].item); fs.writeFileSync(file, JSON.stringify(cache));
      const result = await at(Date.now() + 20000, () => m.providerBalance(store, { providerId: p.id, force: true }, async () => { calls++; return response({}, 500); }));
      assert.equal(calls, 2); assert.equal(result.items[0].status, 'error'); assert.deepEqual(result.items[0].entries, []); assert.equal(result.items[0].stale, false);
    }
  });
  await check('Saving a snapshot prunes deleted providers, removed keys and old query configurations', async () => {
    const store = fresh(), kept = provider(store, { apiKeys: [key('keep'), key('remove')] }), deleted = provider(store), changed = provider(store);
    for (const p of [kept, deleted, changed]) await m.providerBalance(store, { providerId: p.id }, async () => response(deepseek(1)));
    store.deleteProvider(deleted.id); store.saveProvider({ id: kept.id, apiKeys: [key('keep')] }); store.saveProvider({ id: changed.id, balanceQuery: { adapter: 'disabled' } });
    await at(Date.now() + 20000, () => m.providerBalance(store, { providerId: kept.id, force: true }, async () => response(deepseek(2))));
    const cache = JSON.parse(fs.readFileSync(path.join(store.dir, 'provider-balances.json'), 'utf8'));
    assert.deepEqual(Object.keys(cache.items), [JSON.stringify([kept.id, 'keep'])]); assert.equal(Object.values(cache.items)[0].item.entries[0].remaining, 2);
  });
  await check('Identical refreshes deduplicate and global concurrency never exceeds three', async () => {
    const store = fresh(), p = provider(store, { apiKeys: Array.from({ length: 7 }, (_, i) => key(`many-${i}`)) }); let running = 0, peak = 0, requests = 0;
    const transport = async () => { requests++; peak = Math.max(peak, ++running); await new Promise(resolve => setTimeout(resolve, 15)); running--; return response(deepseek(1)); };
    const results = await Promise.all(Array.from({ length: 3 }, () => m.providerBalance(store, { providerId: p.id, force: true }, transport)));
    assert.equal(requests, 7); assert.equal(peak, 3); assert(results.every(r => r.items.length === 7));
  });
  await check('Delayed responses cannot restore deleted suppliers or retain balances after credentials/endpoints change', async () => {
    for (const change of ['delete', 'key', 'endpoint', 'query']) {
      const store = fresh(), p = provider(store), ready = deferred(), finish = deferred();
      const pending = m.providerBalance(store, { providerId: p.id }, async () => { ready.resolve(); await finish.promise; return response(deepseek(9)); }); await ready.promise;
      if (change === 'delete') store.deleteProvider(p.id);
      else store.saveProvider({ id: p.id, ...(change === 'key' ? { apiKeys: [key('key-1', 'rotated-key')] } : change === 'endpoint' ? { baseUrl: 'https://other.test' } : { balanceQuery: { adapter: 'disabled' } }) });
      finish.resolve(); const result = await pending; assert.equal(result.items[0].status, 'unconfigured'); assert.deepEqual(result.items[0].entries, []); assert.equal(fs.existsSync(path.join(store.dir, 'provider-balances.json')), false);
    }
  });
  await check('A change from another store instance is detected and balance refresh never edits provider data', async () => {
    const store = fresh(), p = provider(store), before = fs.readFileSync(path.join(store.dir, 'providers.json')), ready = deferred(), finish = deferred();
    await m.providerBalance(store, { providerId: p.id }, async () => response(deepseek(1))); assert(fs.readFileSync(path.join(store.dir, 'providers.json')).equals(before));
    const pending = at(Date.now() + 20000, () => m.providerBalance(store, { providerId: p.id, force: true }, async () => { ready.resolve(); await finish.promise; return response(deepseek(5)); })); await ready.promise;
    new m.AuroraStore(store.dir).saveProvider({ id: p.id, apiKeys: [key('key-1', 'external-key')] }); finish.resolve(); const result = await pending; assert.deepEqual(result.items[0].entries, []);
    const freshResult = await m.providerBalance(store, { providerId: p.id }, async () => response('not JSON')); assert.equal(freshResult.items[0].status, 'error'); assert.deepEqual(freshResult.items[0].entries, []);
  });
  await check('HTTP errors, malformed/oversized bodies and redirects return bounded sanitized failures without retry', async () => {
    for (const kind of ['redirect', 'html', 'oversized', 'streamed', 'business']) {
      const store = fresh(), p = provider(store); let calls = 0;
      const result = await m.providerBalance(store, { providerId: p.id }, async () => { calls++;
        if (kind === 'redirect') return response('', 302, { location: 'https://other.test?token=fixture-secret' });
        if (kind === 'oversized') return response('{}', 200, { 'content-length': '1048577' });
        if (kind === 'streamed') return response('x'.repeat(1048577));
        return response(kind === 'html' ? '<html>fixture-secret</html>' : { success: false, message: 'fixture-secret' });
      });
      assert.equal(result.items[0].status, 'error'); assert.deepEqual(result.items[0].entries, []); assert.equal(calls, 1); assert(!JSON.stringify(result).includes('fixture-secret'));
    }
  });
  await check('Sidecar save failure is explicit while the fetched balance remains available', async () => {
    const store = fresh(), p = provider(store); store.writeExtra = () => { throw new Error('fixture-disk-secret'); };
    const result = await m.providerBalance(store, { providerId: p.id }, async () => response(deepseek(0))); assert.equal(result.items[0].status, 'ok'); assert.equal(result.items[0].entries[0].remaining, 0); assert.match(result.items[0].message, /未能保存/); assert(!JSON.stringify(result).includes('fixture-disk-secret'));
  });
  await check('Custom query validation rejects executable code, prototype paths, unsafe URLs and authentication leakage', () => {
    const store = fresh(), base = 'https://provider.test/v1', valid = { adapter: 'custom', url: 'https://provider.test/balance', balancePath: 'data.wallets[0].balance' };
    for (const patch of [{ url: 'http://provider.test/balance' }, { url: 'https://other.test/balance' }, { url: 'https://user:secret@provider.test/balance' }, { url: 'https://provider.test/balance#token' }, { balancePath: '__proto__.balance' }, { balancePath: 'data.constructor.name' }, { balancePath: 'data[expr()]' }, { method: 'DELETE' }, { method: 'POST', body: 'return fetch("evil")' }, { headers: { Host: 'evil.test' } }, { authHeader: 'proxy-authorization' }, { headers: { 'x-test': 'bad\nheader' } }, { multiplier: Infinity }, { adapter: 'unknown' }, { scope: 'invented' }, { script: 'return 1' }]) assert.throws(() => provider(store, { baseUrl: base, balanceQuery: { ...valid, ...patch } }));
    const p = provider(store, { baseUrl: base, balanceQuery: valid }); assert.deepEqual(p.balanceQuery, valid);
    const backup = store.exportAll(); backup.providers[0].balanceQuery = { ...valid, balancePath: 'constructor.prototype' }; assert.throws(() => store.importAll(backup));
  });
  await check('Custom amounts preserve configured scope and derive remaining only from both total and usage', () => {
    const store = fresh();
    for (const scope of ['account', 'key', 'subscription']) {
      const p = provider(store, { balanceQuery: { adapter: 'custom', url: 'https://api.deepseek.com/balance', scope, totalPath: 'data.total', usedPath: 'data.used', multiplier: 0.5 } });
      const result = m.parseProviderBalance('custom', { data: { total: 20, used: 24 } }, p)[0]; assert.equal(result.scope, scope); assert.equal(result.remaining, -2);
    }
    for (const balanceQuery of [{ totalPath: 'total' }, { usedPath: 'used' }]) {
      const result = m.parseProviderBalance('custom', { total: 20, used: 3 }, { baseUrl: 'https://provider.test', balanceQuery: { adapter: 'custom', ...balanceQuery } })[0]; assert.equal(result.remaining, undefined); assert.equal(result.scope, 'account');
    }
    const explicit = m.parseProviderBalance('custom', { total: 20, used: 3, balance: 0 }, { baseUrl: 'https://provider.test', balanceQuery: { adapter: 'custom', balancePath: 'balance', totalPath: 'total', usedPath: 'used' } })[0]; assert.equal(explicit.remaining, 0);
  });
  await check('Remote metadata redacts query credentials/body/URL and RPC accepts only provider/key/force selectors', async () => {
    const store = fresh(), query = { adapter: 'custom', auth: 'token', token: 'fixture-secret', url: 'https://billing.test/balance?key=fixture-secret', method: 'POST', body: '{"token":"fixture-secret"}', headers: { 'x-secret': 'fixture-secret' }, balancePath: 'balance' }, p = provider(store, { balanceQuery: query });
    assert(m.REMOTE_ACTIONS.has('provider.balance')); const redacted = m.redactRemoteResult(p); assert(!JSON.stringify(redacted).includes('fixture-secret')); assert.deepEqual(redacted.balanceQuery, { adapter: 'custom', auth: 'token' });
    for (const patch of [{ url: 'https://evil.test' }, { token: 'evil' }, { key: 'evil' }, { force: 1 }, { keyId: {} }]) await assert.rejects(() => m.providerBalance(store, { providerId: p.id, ...patch }));
  });
  await check('Custom POST and independent tokens use real local HTTP without inheriting inference credentials', async () => {
    const requests = [];
    server = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); requests.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: { wallets: [{ balance: 0, total: 20, used: 3 }] } })); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
    const store = fresh(), p = provider(store, { baseUrl: 'https://inference.test', apiKeys: [key('one'), key('two')], headers: { cookie: 'inference-secret', authorization: 'Bearer inference-secret' }, balanceQuery: { adapter: 'custom', auth: 'token', token: 'query-token-fixture', authHeader: 'X-Billing-Token', authScheme: 'raw', url: base + '/balance', method: 'POST', body: '{"scope":"account"}', balancePath: 'data.wallets[0].balance', totalPath: 'data.wallets[0].total', usedPath: 'data.wallets[0].used', currency: 'CNY', multiplier: 0.5 } });
    const result = await m.providerBalance(store, { providerId: p.id }); assert.equal(result.items.length, 1); assert.equal(result.items[0].keyId, 'query-token'); assert.deepEqual([result.items[0].entries[0].remaining, result.items[0].entries[0].total], [0, 10]);
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'POST'); assert.equal(requests[0].headers['x-billing-token'], 'query-token-fixture'); assert.equal(requests[0].headers.cookie, undefined); assert.equal(requests[0].headers.authorization, undefined); assert.equal(requests[0].body, '{"scope":"account"}');
    const publicProvider = provider(store, { baseUrl: '', apiKeys: [], balanceQuery: { adapter: 'custom', auth: 'none', url: base + '/public', balancePath: 'data.wallets[0].balance' } });
    const publicResult = await m.providerBalance(store, { providerId: publicProvider.id }); assert.equal(publicResult.items[0].keyId, 'query-public'); assert.equal(requests[1].headers.authorization, undefined);
  });
  await check('Relay deployment prefixes and explicit proxies are retained; public unit metadata gets no API credential', async () => {
    const store = fresh(), p = provider(store, { baseUrl: 'https://relay.test/deployed/v1', proxy: 'http://proxy-user:proxy-pass@127.0.0.1:9999', balanceQuery: { adapter: 'newapi' } }), calls = [];
    const result = await m.providerBalance(store, { providerId: p.id }, async (url, options) => { calls.push({ url, options }); return url.endsWith('/api/status') ? response({ data: { quota_per_unit: 500000, quota_display_type: 'USD' } }) : response({ success: true, data: { object: 'token_usage', unlimited_quota: false, total_available: 1000000, total_granted: 1000000, total_used: 0 } }); });
    assert.equal(result.items[0].entries[0].remaining, 2); assert.deepEqual(calls.map(c => c.url), ['https://relay.test/deployed/api/usage/token/', 'https://relay.test/deployed/api/status']); assert(calls.every(c => c.options.proxy === p.proxy)); assert.equal(calls[1].options.headers.authorization, undefined);
    const sub = provider(store, { baseUrl: 'https://relay.test/deployed/v1', balanceQuery: { adapter: 'sub2api' } }); await m.providerBalance(store, { providerId: sub.id }, async url => { assert.equal(url, 'https://relay.test/deployed/v1/usage'); return response({ mode: 'unrestricted', balance: 1 }); });
  });
  await check('Official balance requests follow the current documented endpoints', async () => {
    const store = fresh();
    for (const [baseUrl, endpoint, body] of [
      ['https://api.deepseek.com/v1', '/user/balance', deepseek(0)],
      ['https://api.moonshot.cn/v1', '/v1/users/me/balance', { data: { available_balance: 0 } }],
      ['https://api.moonshot.ai/v1', '/v1/users/me/balance', { data: { available_balance: 0 } }],
      ['https://openrouter.ai/api/v1', '/api/v1/credits', { data: { total_credits: 2, total_usage: 1 } }],
      ['https://api.stepfun.com/v1', '/v1/accounts', { balance: 0 }],
      ['https://api.novita.ai/v3/openai', '/openapi/v1/billing/balance/detail', { availableBalance: 25000 }],
    ]) {
      const p = provider(store, { baseUrl });
      const result = await m.providerBalance(store, { providerId: p.id }, async (url, options) => { assert.equal(url, new URL(endpoint, baseUrl).href); assert.equal(options.method, 'GET'); return response(body); });
      assert.equal(result.items[0].status, 'ok');
      if (baseUrl.includes('novita')) assert.equal(result.items[0].entries[0].remaining, 2.5);
    }
  });
  await check('The complete response body is bounded by the 15-second absolute abort signal', async () => {
    const store = fresh(), p = provider(store), original = globalThis.setTimeout;
    globalThis.setTimeout = (fn, delay, ...args) => original(fn, delay === 15000 ? 20 : delay, ...args);
    try {
      const result = await m.providerBalance(store, { providerId: p.id }, async (_url, options) => {
        const raw = new PassThrough(); options.signal.addEventListener('abort', () => raw.destroy(new Error('fixture-private-network-message')), { once: true }); process.nextTick(() => raw.write('{'));
        return { status: 200, headers: {}, raw, stream: raw };
      });
      assert.equal(result.items[0].status, 'error'); assert.match(result.items[0].message, /超时/); assert(!JSON.stringify(result).includes('fixture-private'));
    } finally { globalThis.setTimeout = original; }
  });
  console.log(`Provider balance: ${checks} checks passed`);
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (path.dirname(path.resolve(root)) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('yunhui-balance-test-')) fs.rmSync(root, { recursive: true, force: true });
}
