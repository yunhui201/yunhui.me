/** Background detection: disposable profiles, mocked delays and isolated Electron. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url), base = path.resolve(import.meta.dirname, '..');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-async-detection-')));
const previousEnvironment = { ...process.env }, write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const read = file => fs.readFileSync(file, 'utf8');
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
try {
  const application = path.join(root, 'application'), bundle = path.join(application, 'detector-api.cjs'), worker = path.join(application, 'detection-worker.cjs');
  await build({ stdin: { contents: "export * from './src/core/agents/detectionAsync.ts';export {configureDesktopPath,detectReset,AGENT_ADAPTERS} from './src/core/agents/adapters.ts';export {runAction} from './src/core/actions.ts';export {AuroraStore} from './src/core/store/index.ts';", resolveDir: base, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  await build({ entryPoints: [path.join(base, 'src/core/agents/detectionWorker.ts')], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const home = path.join(root, 'clients'), executable = path.join(home, 'AppData', 'Local', 'Programs', 'ChatGPT', 'ChatGPT.exe');
  write(executable, 'fixture program, never execute');
  write(path.join(home, '.codex', 'config.toml'), 'model="fixture-model"\n');
  const cliName = process.platform === 'win32' ? 'gemini.cmd' : 'gemini';
  write(path.join(root, 'bin', cliName), 'fixture program, never execute');
  if (process.platform !== 'win32') fs.chmodSync(path.join(root, 'bin', cliName), 0o700);
  process.env.AURORA_CLIENT_HOME = home; process.env.AURORA_HOME = path.join(root, 'store'); process.env.YUNHUI_HOME = path.join(root, 'store');
  if (process.platform === 'win32') { delete process.env.PATH; process.env.Path = path.join(root, 'bin'); }
  else process.env.PATH = path.join(root, 'bin');
  process.env.APPDATA = path.join(root, 'appdata'); process.env.LOCALAPPDATA = path.join(root, 'localappdata');
  delete process.env.ELECTRON_RUN_AS_NODE;
  const api = require(bundle), fallback = () => ({ 'codex-cli': { installed: false, configured: true }, 'chatgpt-desktop': { installed: false, configured: true } });
  const complete = marker => ({ 'codex-cli': { installed: true, configured: true, version: marker }, 'chatgpt-desktop': { installed: true, configured: true, version: marker } });
  class FakeWorker extends EventEmitter { terminated = 0; terminate() { this.terminated++; return Promise.resolve(0); } }
  function fixture(extra = {}) {
    let context = { revision: 0, exePath: 'fixture-a' }, now = 0;
    const workers = [];
    const scheduler = new api.AsyncDetectionScheduler({ context: () => context, fallback, now: () => now, worker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; }, timeoutMs: 1000, ...extra });
    return { scheduler, workers, context: value => { context = value; }, now: value => { now = value; } };
  }
  await check('Background reads return immediately; concurrent foreground requests share one scan and one notification', async () => {
    const f = fixture(); let notifications = 0; const off = f.scheduler.subscribe(() => { notifications++; });
    const initial = await f.scheduler.read({ background: true }); assert(initial['codex-cli'].detecting); assert(initial['codex-cli'].configured);
    const first = f.scheduler.read(), second = f.scheduler.read(); assert.equal(f.workers.length, 1);
    f.workers[0].emit('message', { type: 'complete', data: complete('first') });
    assert.deepEqual(await first, await second); assert.equal(notifications, 1);
    const cached = await f.scheduler.read(); cached['codex-cli'].version = 'mutated';
    assert.equal((await f.scheduler.read())['codex-cli'].version, 'first'); assert.equal(f.workers.length, 1); assert.equal(notifications, 1);
    f.now(60_001); const renewed = f.scheduler.read(); assert.equal(f.workers.length, 2);
    off(); f.workers[1].emit('message', { type: 'complete', data: complete('renewed') }); await renewed; assert.equal(notifications, 1);
  });
  await check('Generation and selected-path changes supersede replies and redirect old awaiting callers', async () => {
    const f = fixture(); let notifications = 0; f.scheduler.subscribe(() => { notifications++; });
    const first = f.scheduler.read(), staleListener = f.workers[0].listeners('message')[0];
    f.context({ revision: 1, exePath: 'fixture-b' }); const latest = f.scheduler.read();
    assert.equal(f.workers.length, 2); assert.equal(f.workers[0].terminated, 1);
    staleListener({ type: 'complete', data: complete('stale') }); f.workers[0].emit('error', new Error('fixture-secret'));
    f.workers[1].emit('message', { type: 'complete', data: complete('latest') });
    assert.equal((await first)['codex-cli'].version, 'latest'); assert.equal((await latest)['codex-cli'].version, 'latest'); assert.equal(notifications, 1);
    f.context({ revision: 1, exePath: 'fixture-c' }); const changedPath = f.scheduler.read(); assert.equal(f.workers.length, 3);
    f.workers[2].emit('message', { type: 'complete', data: complete('changed-path') }); assert.equal((await changedPath)['codex-cli'].version, 'changed-path');
  });
  await check('Invalidation without another request still rejects the completed stale worker result', async () => {
    const f = fixture(), first = f.scheduler.read(); f.context({ revision: 2, exePath: 'fixture-new' });
    f.workers[0].emit('message', { type: 'complete', data: complete('stale') }); assert.equal(f.workers.length, 2);
    f.workers[1].emit('message', { type: 'complete', data: complete('current') }); assert.equal((await first)['codex-cli'].version, 'current');
  });
  await check('Worker failures are sanitized, briefly cached and cannot create a notification/reload loop', async () => {
    const f = fixture(); let notifications = 0; f.scheduler.subscribe(() => { notifications++; void f.scheduler.read({ background: true }); });
    const pending = f.scheduler.read(); f.workers[0].emit('error', new Error('fixture-secret')); const failed = await pending;
    assert(failed['codex-cli'].detectionError); assert.equal(failed['codex-cli'].detecting, false); assert(!JSON.stringify(failed).includes('fixture-secret'));
    for (let i = 0; i < 5; i++) await f.scheduler.read(); assert.equal(f.workers.length, 1); assert.equal(notifications, 1);
    f.now(30_001); const retry = f.scheduler.read(); assert.equal(f.workers.length, 2); f.workers[1].emit('message', { type: 'complete', data: complete('recovered') }); await retry;
  });
  await check('A hard timeout keeps completed clients and returns without waiting for worker termination', async () => {
    const workers = [], f = fixture({ timeoutMs: 35, worker: () => { const worker = new FakeWorker(); worker.terminate = () => new Promise(() => {}); workers.push(worker); return worker; } });
    let ticks = 0; const heartbeat = setInterval(() => { ticks++; }, 3), started = performance.now();
    try {
      const pending = f.scheduler.read(); workers[0].emit('message', { type: 'progress', id: 'codex-cli', detection: complete('partial')['codex-cli'] });
      const result = await pending; assert.equal(result['codex-cli'].version, 'partial'); assert(result['chatgpt-desktop'].detectionError); assert(ticks >= 2); assert(performance.now() - started < 1000);
    } finally { clearInterval(heartbeat); }
  });
  await check('A blocked actual worker leaves main-thread timers responsive', async () => {
    const slow = path.join(root, 'slow-worker.cjs');
    write(slow, `const {parentPort}=require('node:worker_threads');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,240);parentPort.postMessage({type:'complete',data:${JSON.stringify(complete('slow'))}});`);
    const f = fixture({ worker: () => new Worker(slow), timeoutMs: 5000 }); let ticks = 0;
    const heartbeat = setInterval(() => { ticks++; }, 10);
    try { const first = await f.scheduler.read({ background: true }); assert(first['codex-cli'].detecting); const final = await f.scheduler.read(); assert.equal(final['codex-cli'].version, 'slow'); assert(ticks >= 5); }
    finally { clearInterval(heartbeat); }
  });
  await check('Worker startup failure is a safe detection result, not a rejected state request', async () => {
    const f = fixture({ worker: () => { throw new Error('fixture-secret'); } });
    const result = await f.scheduler.read({ background: true }); assert(result['codex-cli'].detectionError); assert(!JSON.stringify(result).includes('fixture-secret'));
  });
  await check('state.get and explicit detection use the isolated real worker without executing main-thread adapters', async () => {
    const store = new api.AuroraStore(path.join(root, 'actions-store')), before = read(path.join(home, '.codex', 'config.toml'));
    const httpGet = http.get, httpsGet = https.get;
    http.get = https.get = () => { throw new Error('Fixture prohibits all network requests'); };
    const detects = api.AGENT_ADAPTERS.map(adapter => adapter.detect);
    api.AGENT_ADAPTERS.forEach(adapter => { adapter.detect = () => { throw new Error('Main thread must not inspect installations'); }; });
    try {
      api.detectReset();
      const deps = { store, dataDir: store.dir, platform: process.platform, gatewayStatus: () => ({ running: false }), gatewayUrl: () => 'http://127.0.0.1:3425' };
      const initial = await api.runAction(deps, 'state.get', {}); assert(Object.values(initial.detected).some(value => value.detecting));
      const final = await api.detectAllAsync(); assert.equal(final['gemini-cli'].installed, true); assert.equal(final['codex-cli'].configured, true);
      assert(!Object.values(final).some(value => value.detecting)); assert.equal(read(path.join(home, '.codex', 'config.toml')), before);
      const explicit = await api.runAction(deps, 'agent.detect', {}); assert.equal(explicit['gemini-cli'].installed, true); assert.equal(explicit['codex-cli'].configured, true);
    } finally { http.get = httpGet; https.get = httpsGet; api.AGENT_ADAPTERS.forEach((adapter, index) => { adapter.detect = detects[index]; }); }
  });
  await check('Real Electron loads the worker beside its main bundle inside a packaged ASAR', async () => {
    const output = path.join(root, 'electron-result.json'), profile = path.join(root, 'electron-profile');
    write(path.join(application, 'package.json'), JSON.stringify({ name: 'isolated-detection-fixture', version: '1.0.0', main: 'main.cjs' }));
    write(path.join(application, 'main.cjs'), `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});const fs=require('original-fs');const api=require('./detector-api.cjs');app.whenReady().then(async()=>{try{const initial=await api.detectAllAsync({background:true});const final=await api.detectAllAsync();fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({initialPending:Object.values(initial).some(v=>v.detecting),codexConfigured:final['codex-cli'].configured,geminiInstalled:final['gemini-cli'].installed,unresolved:Object.values(final).filter(v=>v.detecting).length,errors:Object.values(final).filter(v=>v.detectionError).length}));app.exit(0);}catch{fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({error:'isolated electron detection failed'}));app.exit(1);}});`);
    const builderRequire = createRequire(require.resolve('electron-builder')), appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
    const archive = path.join(root, 'app.asar'); await appBuilderRequire('@electron/asar').createPackage(application, archive);
    execFileSync(require('electron'), [archive], { windowsHide: true, timeout: 20000, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(read(output)); assert.equal(result.initialPending, true); assert.equal(result.codexConfigured, true); assert.equal(result.geminiInstalled, true); assert.equal(result.unresolved, 0); assert.equal(result.errors, 0);
  });
  console.log(`Async client detection: ${passed} checks passed.`);
} finally {
  for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, previousEnvironment);
  assert.equal(fs.realpathSync(path.dirname(root)), fs.realpathSync(os.tmpdir())); assert(path.basename(root).startsWith('yunhui-async-detection-'));
  fs.rmSync(root, { recursive: true, force: true });
}
