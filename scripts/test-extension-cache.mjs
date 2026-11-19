import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { build } from 'esbuild';

// All stores, desktop discovery and network responses are fixtures. No client is launched.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-extension-cache-'));
const require = createRequire(import.meta.url), childProcess = require('node:child_process'), workerThreads = require('node:worker_threads');
const original = { readFileSync: fs.readFileSync, execFile: childProcess.execFile, execFileSync: childProcess.execFileSync, Worker: workerThreads.Worker, fetch: globalThis.fetch };
const environment = Object.fromEntries(['AURORA_CLIENT_HOME', 'AURORA_EXTENSION_ASSETS'].map(key => [key, process.env[key]]));
const reads = new Map();
const readFailures = new Map();
let passed = 0, sequence = 0, processProbes = 0, workerProbes = 0, fetches = 0, evaluations = 0;
let detections = {}, fetchResponse;
const counts = () => ({ processProbes, workerProbes, fetches, evaluations });
const check = async (label, work) => { await work(); passed++; console.log('PASS ' + label); };
const fileKey = file => typeof file === 'string' || Buffer.isBuffer(file) ? path.resolve(String(file)) : '';
const readCount = file => reads.get(fileKey(file)) || 0;

try {
  const bundle = path.join(scratch, 'api.cjs');
  await build({ stdin: { contents: "export * from './src/core/extensions/market.ts';export * from './src/core/extensions/index.ts';export * from './src/core/extensions/runtime.ts';export * from './src/core/extensions/catalog.ts';export {AuroraStore} from './src/core/store/index.ts';export {AGENT_ADAPTERS} from './src/core/agents/adapters.ts';", resolveDir: process.cwd(), loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  process.env.AURORA_CLIENT_HOME = path.join(scratch, 'clients');
  process.env.AURORA_EXTENSION_ASSETS = path.resolve('third_party', 'codexplusplus');
  fs.readFileSync = function (file, ...args) {
    const key = fileKey(file);
    if (/extension-catalog-(?:public|full)\.json$|[\\/]catalog[\\/](?:public|full)\.json$/.test(key)) reads.set(key, (reads.get(key) || 0) + 1);
    if (readFailures.has(key)) { const error = readFailures.get(key); readFailures.delete(key); throw error; }
    return original.readFileSync.call(this, file, ...args);
  };
  const execFixture = () => { processProbes++; throw new Error('Unexpected callback process probe'); };
  execFixture[promisify.custom] = async () => { processProbes++; return { stdout: '', stderr: '' }; };
  childProcess.execFile = execFixture;
  childProcess.execFileSync = () => { processProbes++; throw new Error('Unexpected synchronous process probe'); };
  workerThreads.Worker = class extends EventEmitter {
    constructor(file) {
      super(); workerProbes++;
      queueMicrotask(() => this.emit('message', path.basename(String(file)) === 'detection-worker.cjs'
        ? { type: 'complete', data: structuredClone(detections) }
        : { ok: true, value: structuredClone(detections['chatgpt-desktop'].desktopDetails) }));
    }
    terminate() { return Promise.resolve(0); }
  };
  globalThis.fetch = async (...args) => {
    fetches++;
    if (!fetchResponse) throw new Error('Unexpected network request');
    return fetchResponse(...args);
  };
  const api = require(bundle);
  detections = Object.fromEntries(api.AGENT_ADAPTERS.map(agent => [agent.id, { installed: false, configured: false }]));
  detections['chatgpt-desktop'] = { installed: true, configured: false, desktopDetails: { installed: true, supportsCodexConfig: true, executable: path.join(scratch, 'never-launched-desktop'), productName: 'Fixture Coding Desktop', version: '1.2.3', evidence: ['fixture capability'] } };
  const fresh = () => new api.AuroraStore(path.join(scratch, `store-${++sequence}`));
  const cacheFile = (store, source) => path.join(store.dir, `extension-catalog-${source}.json`);
  const index = (source, revision = 'a', count = 1) => ({ schemaVersion: 1, repository: api.REPOSITORIES[source], revision: revision.repeat(40), updatedAt: '2026-11-16T00:00:00Z', plugins: Array.from({ length: count }, (_, number) => ({ id: `fixture-${number}`, name: `fixture-${number}`, displayName: `Fixture ${number}`, description: 'Local fixture', version: '1.0.0', author: 'Fixture', tags: ['fixture'], license: 'MIT', path: `plugins/fixture-${number}`, tree: 'f'.repeat(40), bytes: 1, skills: 0, requiresAuth: false })) });
  const writeCache = (store, source, value) => fs.writeFileSync(cacheFile(store, source), JSON.stringify(value));

  await check('Repeated local catalogs reuse parsed content without reading catalog files again', async () => {
    const store = fresh(), before = counts();
    for (const source of ['public', 'full']) {
      const value = api.loadIndex(store, source), file = path.join(api.resourceRoot(), 'catalog', source + '.json');
      const localReads = readCount(cacheFile(store, source)), bundledReads = readCount(file);
      assert(value.plugins.length > 0);
      for (let repeat = 0; repeat < 3; repeat++) assert.deepEqual(api.loadIndex(store, source), value);
      assert.equal(readCount(cacheFile(store, source)), localReads);
      assert.equal(readCount(file), bundledReads);
    }
    assert.deepEqual(counts(), before);
  });

  await check('Catalog caches remain isolated by store and source, and returned values cannot poison later reads', async () => {
    const first = fresh(), second = fresh();
    writeCache(first, 'public', index('public', 'a', 1));
    writeCache(first, 'full', index('full', 'b', 2));
    writeCache(second, 'public', index('public', 'c', 3));
    for (const [store, source, revision, count] of [[first, 'public', 'a', 1], [first, 'full', 'b', 2], [second, 'public', 'c', 3]]) {
      const value = api.loadIndex(store, source), before = readCount(cacheFile(store, source));
      assert.equal(value.revision, revision.repeat(40)); assert.equal(value.plugins.length, count);
      try { value.plugins[0].tags.push('poisoned'); } catch { /* Frozen shared values are an allowed cache contract. */ }
      try { value.plugins[0].name = 'poisoned'; } catch { /* A clone is also acceptable if the cache stays intact. */ }
      const again = api.loadIndex(store, source);
      assert.equal(again.plugins[0].name, 'fixture-0'); assert.deepEqual(again.plugins[0].tags, ['fixture']);
      assert.equal(readCount(cacheFile(store, source)), before);
    }
  });

  await check('External edits invalidate cached catalogs immediately, including equal-length and preserved-mtime edits', async () => {
    const store = fresh(), file = cacheFile(store, 'public');
    writeCache(store, 'public', index('public', 'a'));
    assert.equal(api.loadIndex(store, 'public').revision, 'a'.repeat(40));
    const first = fs.statSync(file), before = readCount(file);
    writeCache(store, 'public', index('public', 'b'));
    fs.utimesSync(file, first.atime, new Date(first.mtimeMs + 2000));
    assert.equal(fs.statSync(file).size, first.size);
    assert.equal(api.loadIndex(store, 'public').revision, 'b'.repeat(40)); assert(readCount(file) > before);
    const second = fs.statSync(file), expanded = index('public', 'c', 2);
    writeCache(store, 'public', expanded); fs.utimesSync(file, second.atime, second.mtime);
    assert.notEqual(fs.statSync(file).size, second.size);
    assert.equal(api.loadIndex(store, 'public').plugins.length, 2);
    assert.equal(api.loadIndex(store, 'public').revision, expanded.revision);
  });

  await check('Corrupt or deleted catalogs fall back locally and repaired files become visible on the next read', async () => {
    const store = fresh(), file = cacheFile(store, 'public');
    const bundled = api.loadIndex(store, 'public');
    writeCache(store, 'public', index('public', 'a')); assert.equal(api.loadIndex(store, 'public').plugins.length, 1);
    fs.writeFileSync(file, '{invalid fixture JSON');
    assert.equal(api.loadIndex(store, 'public').revision, bundled.revision);
    const brokenReads = readCount(file);
    assert.equal(api.loadIndex(store, 'public').revision, bundled.revision); assert.equal(readCount(file), brokenReads);
    writeCache(store, 'public', index('public', 'b', 2)); assert.equal(api.loadIndex(store, 'public').plugins.length, 2);
    fs.unlinkSync(file); assert.equal(api.loadIndex(store, 'public').revision, bundled.revision);
    writeCache(store, 'public', index('public', 'c', 3)); assert.equal(api.loadIndex(store, 'public').plugins.length, 3);
  });

  await check('An atomic replacement with the same size and modification time invalidates the previous catalog', async () => {
    const store = fresh(), file = cacheFile(store, 'public'), replacement = file + '.replacement';
    writeCache(store, 'public', index('public', 'a'));
    assert.equal(api.loadIndex(store, 'public').revision, 'a'.repeat(40));
    const previous = fs.statSync(file);
    fs.writeFileSync(replacement, JSON.stringify(index('public', 'b')));
    fs.utimesSync(replacement, previous.atime, previous.mtime);
    assert.equal(fs.statSync(replacement).size, previous.size);
    fs.renameSync(replacement, file);
    assert.equal(api.loadIndex(store, 'public').revision, 'b'.repeat(40));
  });

  await check('A transient read error falls back once without hiding an unchanged readable cache afterwards', async () => {
    const store = fresh(), file = cacheFile(store, 'public'), bundled = api.loadIndex(fresh(), 'public');
    writeCache(store, 'public', index('public', 'e', 2));
    const before = fs.statSync(file);
    readFailures.set(fileKey(file), Object.assign(new Error('Fixture file temporarily unavailable'), { code: 'EACCES' }));
    assert.equal(api.loadIndex(store, 'public').revision, bundled.revision);
    assert.equal(api.loadIndex(store, 'public').revision, 'e'.repeat(40));
    const after = fs.statSync(file);
    for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[field], before[field]);
  });

  await check('Explicit market refresh replaces a warm cache while other stores and sources stay unchanged', async () => {
    const store = fresh(), other = fresh();
    writeCache(store, 'public', index('public', 'a')); writeCache(store, 'full', index('full', 'b'));
    writeCache(other, 'public', index('public', 'c'));
    api.loadIndex(store, 'public'); api.loadIndex(store, 'full'); api.loadIndex(other, 'public');
    const before = fetches, remote = index('public', 'd', 4);
    fetchResponse = async url => {
      assert.equal(String(url), `https://raw.githubusercontent.com/${api.REPOSITORIES.public}/main/plugin-index.json`);
      return new Response(JSON.stringify(remote));
    };
    try {
      const result = await api.refreshIndex(store, 'public');
      assert.equal(result.revision, remote.revision); assert.equal(fetches - before, 1);
      assert.equal(api.loadIndex(store, 'public').revision, remote.revision); assert.equal(api.loadIndex(store, 'public').plugins.length, 4);
      assert.equal(api.loadIndex(store, 'full').revision, 'b'.repeat(40)); assert.equal(api.loadIndex(other, 'public').revision, 'c'.repeat(40));
    } finally { fetchResponse = undefined; }
  });

  const listedStore = fresh(), runtime = api.runtimeFor(listedStore);
  const completeCount = api.BUILTINS.length + api.BUNDLED.length + api.loadIndex(listedStore, 'public').plugins.length + api.loadIndex(listedStore, 'full').plugins.length;
  await check('Fast plugin listing returns the complete inventory without desktop, process, CDP or network probes', async () => {
    const before = counts();
    const result = await api.runExtensionAction({ store: listedStore }, 'extension.list', { probeClient: false });
    assert.equal(result.ok, true); assert.equal(result.total, completeCount); assert.equal(result.items.length, completeCount);
    assert.equal(result.client.detecting, true); assert.equal(result.client.connected, false); assert.equal(result.client.compatible, false);
    assert.deepEqual(result.runtime.applied, []); assert(!result.items.some(item => item.status === 'active'));
    assert.deepEqual(counts(), before);
  });

  await check('A live CDP connection is retained by a fast snapshot without inventing applied plugins', async () => {
    runtime.cdp = { connected: true, target: { title: 'Fixture', url: 'app://-/index.html' }, evaluate: async () => { evaluations++; throw new Error('Fast listing must never inspect CDP'); } };
    const before = counts();
    const result = await api.listExtensions(listedStore, { probeClient: false });
    assert.equal(result.client.connected, true); assert.equal(result.client.compatible, true); assert.equal(result.runtime.connected, true);
    assert.deepEqual(result.runtime.applied, []); assert(!result.items.some(item => item.status === 'active'));
    assert.deepEqual(counts(), before);
  });

  await check('Default listing still performs actual diagnostic requests and reports observed active plugins', async () => {
    runtime.cdp.evaluate = async () => { evaluations++; return { ready: true, error: '', scripts: [{ key: 'bundled:typing-effects', status: 'loaded' }], builtins: [{ id: 'paste-fix', active: true }] }; };
    fetchResponse = async url => { assert.match(String(url), /^http:\/\/127\.0\.0\.1:9222\/json\/version$/); return new Response('{}'); };
    const before = counts();
    try {
      const result = await api.listExtensions(listedStore);
      assert.equal(result.total, completeCount); assert.equal(result.client.installed, true); assert.equal(result.client.debugPortOpen, true);
      assert.equal(result.client.productName, 'Fixture Coding Desktop');
      assert(result.runtime.applied.includes('bundled:typing-effects')); assert(result.runtime.applied.includes('builtin:paste-fix'));
      assert.equal(result.items.find(item => item.id === 'builtin:paste-fix').status, 'active');
      assert(workerProbes > before.workerProbes); assert(processProbes > before.processProbes); assert(fetches > before.fetches); assert(evaluations > before.evaluations);
    } finally { fetchResponse = undefined; }
  });

  await check('Fast snapshots after a successful probe never retain stale active status or a disconnected transport', async () => {
    runtime.cdp.connected = false;
    runtime.cdp.evaluate = async () => { evaluations++; throw new Error('Fast listing must never inspect disconnected CDP'); };
    const before = counts(), result = await api.listExtensions(listedStore, { probeClient: false });
    assert.equal(result.runtime.connected, false); assert.equal(result.client.connected, false);
    assert.deepEqual(result.runtime.applied, []); assert(!result.items.some(item => item.status === 'active'));
    assert.deepEqual(counts(), before);
  });

  await check('A changed connection discards the previous desktop identity without probing on the fast path', async () => {
    const state = api.loadState(listedStore);
    state.connection = { port: 9333, exePath: path.join(scratch, 'another-never-launched-desktop') };
    api.saveState(listedStore, state);
    const before = counts(), result = await api.listExtensions(listedStore, { probeClient: false });
    assert.equal(result.client.detecting, true); assert.equal(result.client.installed, false);
    assert.equal(result.client.compatible, false); assert.equal(result.client.productName, undefined);
    assert.deepEqual(counts(), before);
  });

  console.log(`Extension cache: ${passed} tests passed`);
} finally {
  fs.readFileSync = original.readFileSync;
  childProcess.execFile = original.execFile; childProcess.execFileSync = original.execFileSync;
  workerThreads.Worker = original.Worker; globalThis.fetch = original.fetch;
  for (const [key, value] of Object.entries(environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const cleanup = path.resolve(scratch);
  if (path.dirname(cleanup) !== path.resolve(os.tmpdir()) || !path.basename(cleanup).startsWith('yunhui-extension-cache-')) throw new Error('Refusing cleanup outside the isolated test directory');
  fs.rmSync(cleanup, { recursive: true, force: true });
}
