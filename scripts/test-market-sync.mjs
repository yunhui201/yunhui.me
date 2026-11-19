import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-market-sync-'));
const previousHome = process.env.AURORA_CLIENT_HOME, originalFetch = globalThis.fetch;
process.env.AURORA_CLIENT_HOME = path.join(scratch, 'client');
globalThis.fetch = async () => { throw new Error('Unmocked external request rejected by market test'); };
let passed = 0, sequence = 0;
const sockets = new Set();
let proxy;
try {
  await build({ stdin: { contents: "export * from './src/core/extensions/market.ts'; export * from './src/core/extensions/runtime.ts'; export * from './src/core/extensions/index.ts'; export {DesktopCdp} from './src/core/injector.ts'; export {AuroraStore} from './src/core/store/index.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(scratch, 'api.cjs'), logLevel: 'silent' });
  const m = createRequire(import.meta.url)(path.join(scratch, 'api.cjs'));
  const fresh = () => new m.AuroraStore(path.join(scratch, `store-${++sequence}`));
  const cachePath = (store, source) => path.join(store.dir, `extension-catalog-${source}.json`);
  const index = (source, revision = 'a', count = 1) => ({ schemaVersion: 1, repository: m.REPOSITORIES[source], revision: revision.repeat(40), updatedAt: '2026-11-15T00:00:00Z', plugins: Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, name: `fixture-${i}`, displayName: `Fixture ${i}`, description: 'A local fixture package for market synchronization.', version: '1.0.0', author: 'Fixture', tags: ['fixture'], license: 'MIT', path: `plugins/fixture-${i}`, tree: 'f'.repeat(40), bytes: 1, skills: 0, requiresAuth: false })) });
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const sourceOf = value => String(value).includes(m.REPOSITORIES.full) ? 'full' : 'public';
  const isRaw = value => new URL(value).hostname === 'raw.githubusercontent.com';
  const apiResponse = (url, options, value) => {
    const accept = new Headers(options.headers).get('accept');
    if (!isRaw(url) && accept === 'application/vnd.github+json') { const bytes = Buffer.from(JSON.stringify(value)); return json({ type: 'file', path: 'plugin-index.json', name: 'plugin-index.json', size: bytes.length, sha: m.gitBlobHash(bytes) }); }
    if (!isRaw(url)) assert.equal(accept, 'application/vnd.github.raw+json');
    return json(value);
  };
  const cache = (store, source, value = index(source, 'b')) => { store.writeExtra(`extension-catalog-${source}.json`, value); return fs.readFileSync(cachePath(store, source), 'utf8'); };
  const check = async (label, fn) => { await fn(); passed++; console.log(`PASS ${label}`); };
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const hanging = (signal, onAbort) => new Promise((_, reject) => { const abort = () => { onAbort?.(); reject(signal.reason || new Error('aborted')); }; if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); });
  const failure = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }); };

  await check('A successful raw response persists a verified directory without starting a backup request', async () => {
    const store = fresh(), calls = [];
    globalThis.fetch = async (url, options) => { calls.push(String(url)); assert.equal(options.redirect, 'error'); assert(options.signal); return json(index('public')); };
    const result = await m.refreshIndex(store, 'public');
    assert.equal(result.revision, 'a'.repeat(40)); assert.equal(calls.length, 1); assert(isRaw(calls[0])); assert.equal(m.loadIndex(store, 'public').revision, result.revision);
  });

  await check('Raw failure falls back to raw GitHub contents in the same repository, including files over 1 MB', async () => {
    const store = fresh(), calls = [], large = index('full', 'c', 4000); assert(Buffer.byteLength(JSON.stringify(large)) > 1024 * 1024);
    globalThis.fetch = async (url, options) => {
      const parsed = new URL(url); calls.push(parsed.href);
      if (isRaw(url)) throw new Error('fixture raw transport failed');
      assert.equal(parsed.hostname, 'api.github.com'); assert.equal(parsed.pathname, `/repos/${m.REPOSITORIES.full}/contents/plugin-index.json`); assert.equal(parsed.searchParams.get('ref'), 'main');
      assert.equal(options.redirect, 'error'); return apiResponse(url, options, large);
    };
    const result = await m.refreshIndex(store, 'full'); assert.equal(result.plugins.length, 4000); assert.equal(calls.length, 3); assert.equal(m.loadIndex(store, 'full').revision, 'c'.repeat(40));
  });

  await check('A base64 contents response over 1 MB decodes and verifies its embedded index without another download', async () => {
    const store = fresh(), value = index('public', 'd'); value.plugins[0].description = 'x'.repeat(800 * 1024);
    const bytes = Buffer.from(JSON.stringify(value)), metadata = { type: 'file', path: 'plugin-index.json', size: bytes.length, sha: m.gitBlobHash(bytes), encoding: 'base64', content: bytes.toString('base64'), download_url: 'https://untrusted.invalid/must-not-follow' }; let requests = 0;
    assert(bytes.length < 1024 * 1024); assert(Buffer.byteLength(JSON.stringify(metadata)) > 1024 * 1024);
    globalThis.fetch = async (url, options) => {
      requests++; if (isRaw(url)) throw new Error('raw unavailable');
      assert.equal(new URL(url).hostname, 'api.github.com'); assert.equal(new Headers(options.headers).get('accept'), 'application/vnd.github+json'); return json(metadata);
    };
    const result = await m.refreshIndex(store, 'public'); assert.equal(requests, 2); assert.equal(result.remoteBlobSha, metadata.sha); assert.equal(result.plugins[0].description, value.plugins[0].description); assert.equal(m.loadIndex(store, 'public').revision, value.revision);
  });

  await check('A stalled raw request loses to the delayed backup and is cancelled', async () => {
    const store = fresh(); let rawAborted = false, calls = 0;
    globalThis.fetch = async (url, options) => { calls++; return isRaw(url) ? hanging(options.signal, () => { rawAborted = true; }) : apiResponse(url, options, index('public', 'd')); };
    const result = await m.refreshIndex(store, 'public'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.revision, 'd'.repeat(40)); assert(rawAborted, 'the losing raw transport must be cancelled'); assert.equal(calls, 3);
  });

  await check('An invalid early response cannot win the race or cancel a later valid directory', async () => {
    const store = fresh(); let calls = 0;
    globalThis.fetch = async (url, options) => { calls++; return isRaw(url) ? new Response('<html>fixture interception page</html>', { headers: { 'content-type': 'text/html' } }) : apiResponse(url, options, index('public', 'e')); };
    const result = await m.refreshIndex(store, 'public'); assert.equal(result.revision, 'e'.repeat(40)); assert.equal(calls, 3);
  });

  await check('Matching the actual bundled Git blob avoids downloading the unchanged full directory', async () => {
    const store = fresh(), bytes = fs.readFileSync(path.join(m.resourceRoot(), 'catalog', 'full.json')), expected = JSON.parse(bytes), sha = m.gitBlobHash(bytes); let bodies = 0, cancelled = false;
    globalThis.fetch = async (url, options) => {
      if (isRaw(url)) return hanging(options.signal, () => { cancelled = true; });
      if (new Headers(options.headers).get('accept') === 'application/vnd.github.raw+json') { bodies++; throw new Error('unchanged blob should not download'); }
      return json({ type: 'file', path: 'plugin-index.json', name: 'plugin-index.json', size: bytes.length, sha });
    };
    const result = await m.refreshIndex(store, 'full'); assert.equal(result.revision, expected.revision); assert.equal(result.plugins.length, expected.plugins.length); assert.equal(result.remoteBlobSha, sha); assert(result.fetchedAt); assert.equal(bodies, 0); assert(cancelled);
  });

  await check('Matching a verified cache blob refreshes its timestamp without downloading again', async () => {
    const store = fresh(), value = index('public', 'c'), bytes = Buffer.from(JSON.stringify(value)), sha = m.gitBlobHash(bytes); let bodies = 0;
    globalThis.fetch = async () => new Response(bytes); const verified = await m.refreshIndex(store, 'public');
    cache(store, 'public', { ...verified, fetchedAt: '2000-01-01T00:00:00Z' });
    globalThis.fetch = async (url, options) => {
      if (isRaw(url)) throw new Error('raw unavailable');
      if (new Headers(options.headers).get('accept') === 'application/vnd.github.raw+json') { bodies++; throw new Error('unchanged blob should not download'); }
      return json({ type: 'file', path: 'plugin-index.json', name: 'plugin-index.json', size: bytes.length, sha });
    };
    const result = await m.refreshIndex(store, 'public'); assert.equal(result.revision, value.revision); assert.equal(result.remoteBlobSha, sha); assert.notEqual(result.fetchedAt, '2000-01-01T00:00:00Z'); assert.equal(bodies, 0);
  });

  await check('Modified cache content cannot reuse a previously verified remote blob identity', async () => {
    const store = fresh(), value = index('public', 'c'), bytes = Buffer.from(JSON.stringify(value)); let bodies = 0;
    globalThis.fetch = async () => new Response(bytes); const verified = await m.refreshIndex(store, 'public');
    cache(store, 'public', { ...verified, plugins: [{ ...verified.plugins[0], description: 'Locally modified fixture' }] });
    globalThis.fetch = async (url, options) => {
      if (isRaw(url)) throw new Error('raw unavailable');
      if (new Headers(options.headers).get('accept') === 'application/vnd.github.raw+json') bodies++;
      return apiResponse(url, options, value);
    };
    const result = await m.refreshIndex(store, 'public'); assert.equal(bodies, 1); assert.equal(result.plugins[0].description, value.plugins[0].description);
  });

  await check('Changed metadata followed by a mismatched raw Git blob never replaces the cache', async () => {
    const store = fresh(), before = cache(store, 'public'); let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls++; if (isRaw(url)) throw new Error('raw unavailable');
      if (new Headers(options.headers).get('accept') === 'application/vnd.github+json') return json({ type: 'file', path: 'plugin-index.json', name: 'plugin-index.json', size: Buffer.byteLength(JSON.stringify(index('public', 'c'))), sha: '1'.repeat(40) });
      return json(index('public', 'c'));
    };
    await assert.rejects(() => m.refreshIndex(store, 'public')); assert.equal(calls, 3); assert.equal(fs.readFileSync(cachePath(store, 'public'), 'utf8'), before);
  });

  await check('Transport-derived timestamps and blob identities override untrusted index metadata', async () => {
    const store = fresh(), value = { ...index('public'), fetchedAt: 'untrusted-time', remoteBlobSha: '0'.repeat(40) }, bytes = Buffer.from(JSON.stringify(value));
    globalThis.fetch = async () => new Response(bytes);
    const result = await m.refreshIndex(store, 'public'); assert.notEqual(result.fetchedAt, value.fetchedAt); assert.equal(result.remoteBlobSha, m.gitBlobHash(bytes));
  });

  await check('Concurrent callers sharing a data directory coalesce one source request and one durable write', async () => {
    const store = fresh(), sibling = new m.AuroraStore(store.dir), started = deferred(), release = deferred(); let requests = 0, writes = 0;
    const write = store.writeExtra.bind(store); store.writeExtra = (name, value) => { if (name === 'extension-catalog-public.json') writes++; return write(name, value); };
    globalThis.fetch = async () => { requests++; started.resolve(); await release.promise; return json(index('public')); };
    const first = m.refreshIndex(store, 'public'); await started.promise;
    const others = [m.refreshIndex(store, 'public'), m.refreshIndex(sibling, 'public')]; release.resolve();
    const results = await Promise.all([first, ...others]); assert.equal(requests, 1); assert.equal(writes, 1); assert(results.every(result => result.revision === 'a'.repeat(40)));
  });

  await check('Two sources start independently and report partial success while preserving the failed cache', async () => {
    const store = fresh(), before = cache(store, 'public'), fullStarted = deferred(), releasePublic = deferred(); let publicStarted = false;
    globalThis.fetch = async url => { if (sourceOf(url) === 'full') { fullStarted.resolve(); return json(index('full', 'c')); } publicStarted = true; await releasePublic.promise; return new Response('unavailable', { status: 503 }); };
    const pending = m.refreshMarkets(store, ['public', 'full']);
    let deadline;
    try { await Promise.race([fullStarted.promise, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('full source was blocked by public source')), 2500); })]); }
    finally { clearTimeout(deadline); releasePublic.resolve(); }
    const result = await pending; assert(publicStarted); assert.equal(result.results.length, 2); assert(result.warning); assert.equal(typeof result.message, 'string');
    const publicResult = result.results.find(item => item.source === 'public'), fullResult = result.results.find(item => item.source === 'full');
    assert.equal(publicResult.ok, false); assert.equal(publicResult.sourceType, 'cache'); assert.equal(publicResult.count, 1); assert.equal(fullResult.ok, true); assert.equal(fullResult.sourceType, 'remote'); assert.equal(fullResult.count, 1);
    assert.equal(fs.readFileSync(cachePath(store, 'public'), 'utf8'), before); assert.equal(m.loadIndex(store, 'full').revision, 'c'.repeat(40));
  });

  await check('Total network failure distinguishes durable cache from the bundled snapshot', async () => {
    const store = fresh(), before = cache(store, 'public'); globalThis.fetch = failure;
    const result = await m.refreshMarkets(store, ['public', 'full']); assert.equal(result.ok, false); assert(result.warning); assert.equal(result.results.length, 2); assert(result.results.every(item => !item.ok && item.message));
    assert.equal(result.results.find(item => item.source === 'public').sourceType, 'cache'); assert.equal(result.results.find(item => item.source === 'full').sourceType, 'builtin');
    assert(result.results.find(item => item.source === 'full').count > 0); assert.equal(fs.readFileSync(cachePath(store, 'public'), 'utf8'), before); assert.equal(fs.existsSync(cachePath(store, 'full')), false);
  });

  for (const [label, response] of [
    ['invalid JSON', () => new Response('{"secret":"FIXTURE_REMOTE_SECRET" broken')],
    ['wrong repository', () => json({ ...index('public'), repository: 'untrusted/example' })],
    ['unsafe plugin path', () => json({ ...index('public'), plugins: [{ ...index('public').plugins[0], path: '../outside' }] })],
    ['oversized advertised body', () => new Response('{}', { headers: { 'content-length': String(24 * 1024 * 1024 + 1) } })],
    ['oversized streamed body', () => { let chunks = 0; return new Response(new ReadableStream({ pull(controller) { if (chunks++ < 25) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); } })); }],
  ]) await check(`Both candidates with ${label} cannot replace an existing directory`, async () => {
    const store = fresh(), before = cache(store, 'public'); let requests = 0;
    globalThis.fetch = async () => { requests++; return response(); };
    await assert.rejects(() => m.refreshIndex(store, 'public'), error => !error.message.includes('FIXTURE_REMOTE_SECRET'));
    assert.equal(requests, 2); assert.equal(fs.readFileSync(cachePath(store, 'public'), 'utf8'), before);
  });

  await check('A cache write failure does not trigger another download or replace the previous cache', async () => {
    const store = fresh(), before = cache(store, 'public'), write = store.writeExtra.bind(store); let requests = 0;
    store.writeExtra = (name, value) => { if (name === 'extension-catalog-public.json') throw new Error('fixture cache write failed'); return write(name, value); };
    globalThis.fetch = async () => { requests++; return json(index('public', 'c')); };
    await assert.rejects(() => m.refreshIndex(store, 'public')); await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests, 1); assert.equal(fs.readFileSync(cachePath(store, 'public'), 'utf8'), before);
  });

  await check('A failed shared refresh is removed so a later retry can succeed', async () => {
    const store = fresh(); globalThis.fetch = failure; await assert.rejects(() => m.refreshIndex(store, 'public'));
    let requests = 0; globalThis.fetch = async () => { requests++; return json(index('public')); };
    assert.equal((await m.refreshIndex(store, 'public')).revision, 'a'.repeat(40)); assert.equal(requests, 1);
  });

  await check('Native market refresh returns cached entries and an explicit warning after network failure', async () => {
    const store = fresh(); cache(store, 'public'); globalThis.fetch = failure;
    const result = await m.runtimeFor(store).route('/plugin-market/list', { source: 'public', refresh: true });
    assert.equal(result.status, 'ok'); assert(result.warning); assert.equal(result.warning, result.message); assert.equal(result.cached, true); assert.equal(result.refresh.ok, false); assert.equal(result.refresh.results[0].sourceType, 'cache'); assert.equal(result.repository, m.REPOSITORIES.public); assert.equal(result.plugins.length, 1); assert.equal(result.plugins[0].id, 'fixture-0'); assert.equal(result.revision, 'b'.repeat(40));
  });

  await check('The 120-second absolute deadline covers metadata wait plus a stalled response body', async () => {
    const store = fresh(), before = cache(store, 'public'), metadata = deferred(), value = index('public', 'c');
    const timers = new Map(), originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
    let clock = 0, timerId = 0, metadataStarted = false, bodyStarted = false, bodyAborted = false, settled = false;
    const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
    globalThis.setTimeout = (fn, delay = 0, ...args) => { const id = ++timerId; timers.set(id, { at: clock + Number(delay), fn: () => fn(...args) }); return id; };
    globalThis.clearTimeout = id => { timers.delete(id); };
    const advance = async milliseconds => {
      const end = clock + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        clock = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      clock = end; await flush();
    };
    globalThis.fetch = async (url, options) => {
      if (isRaw(url)) throw new Error('raw unavailable');
      if (new Headers(options.headers).get('accept') === 'application/vnd.github+json') {
        metadataStarted = true; await metadata.promise; return apiResponse(url, options, value);
      }
      bodyStarted = true;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        options.signal.addEventListener('abort', () => { bodyAborted = true; controller.error(new Error('fixture response body aborted')); }, { once: true });
      } }));
    };
    try {
      const outcome = m.refreshIndex(store, 'public').then(result => { settled = true; return { result }; }, error => { settled = true; return { error }; });
      await flush(); assert(metadataStarted);
      await advance(90000); metadata.resolve(); await flush(); assert(bodyStarted); assert.equal(settled, false);
      await advance(29999); assert.equal(settled, false);
      await advance(1); assert.equal(settled, true, 'body download must not restart the overall 120-second deadline');
      const result = await outcome; assert(result.error); assert.match(result.error.message, /超时|取消/); assert(bodyAborted); assert.equal(fs.readFileSync(cachePath(store, 'public'), 'utf8'), before); assert.equal(timers.size, 0);
    } finally { metadata.resolve(); globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
  });

  await check('The generated desktop bridge extends only explicit market refresh requests to 130 seconds', async () => {
    const cdp = Object.create(m.DesktopCdp.prototype), timers = new Map(), sent = [];
    cdp.binding = '__fixtureMarketBinding'; cdp.send = async (method, params) => { assert.equal(method, 'Runtime.addBinding'); assert.equal(params.name, cdp.binding); };
    const source = await cdp.setBridge(async () => ({})), window = {};
    window[cdp.binding] = payload => sent.push(JSON.parse(payload));
    const context = vm.createContext({ window, top: window, location: { href: 'app://-/index.html' }, setTimeout: (callback, delay) => { const id = timers.size + 1; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id) });
    vm.runInContext(source, context);
    for (const [route, payload, expected] of [['/plugin-market/list', { refresh: true }, 130000], ['/plugin-market/list', { refresh: false }, 30000], ['/plugin-market/list', undefined, 30000], ['/plugin-market/list', { refresh: 1 }, 30000], ['/settings/get', { refresh: true }, 30000]]) {
      const pending = window.__codexSessionDeleteBridge(route, payload), request = sent.at(-1);
      assert.equal(timers.size, 1); assert.equal([...timers.values()][0].delay, expected);
      window.__auroraBridgeResolve({ id: request.id, value: { status: 'ok' } }); assert.equal((await pending).status, 'ok'); assert.equal(timers.size, 0);
    }
  });

  await check('An explicit HTTP proxy receives both CONNECT attempts and is never bypassed after rejection', async () => {
    const attempts = [], auth = Buffer.from('fixture-proxy-user:fixture-proxy-password').toString('base64');
    proxy = http.createServer(); proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    proxy.on('connect', (req, socket) => { attempts.push({ target: req.url, auth: req.headers['proxy-authorization'], originAuth: req.headers.authorization }); socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const store = fresh(), before = cache(store, 'public'); store.saveSettings({ proxy: `http://fixture-proxy-user:fixture-proxy-password@127.0.0.1:${proxy.address().port}` });
    let directFetches = 0, directHttps = 0; const request = https.request;
    globalThis.fetch = async () => { directFetches++; throw new Error('Proxy bypass through fetch'); };
    https.request = () => { directHttps++; throw new Error('Proxy bypass through direct HTTPS'); };
    let result; try { result = await m.refreshMarkets(store, ['public']); } finally { https.request = request; }
    assert.equal(result.ok, false); assert.equal(result.results[0].sourceType, 'cache'); assert.equal(directFetches, 0); assert.equal(directHttps, 0); assert.equal(attempts.length, 2);
    assert.deepEqual(attempts.map(item => item.target).sort(), ['api.github.com:443', 'raw.githubusercontent.com:443']); assert(attempts.every(item => item.auth === `Basic ${auth}` && item.originAuth === undefined));
    for (const secret of ['fixture-proxy-user', 'fixture-proxy-password', auth]) assert(!JSON.stringify(result).includes(secret));
    assert.equal(fs.readFileSync(cachePath(store, 'public'), 'utf8'), before);
  });
  console.log(`Market synchronization: ${passed} checks passed`);
} finally {
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = previousHome;
  for (const socket of sockets) socket.destroy();
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  const resolved = path.resolve(scratch);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('yunhui-market-sync-')) fs.rmSync(resolved, { recursive: true, force: true });
}
