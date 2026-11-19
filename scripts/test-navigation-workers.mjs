import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const require = createRequire(import.meta.url), base = process.cwd();
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-navigation-workers-')));
const environment = { ...process.env }, childProcess = require('node:child_process');
const originalExecFile = childProcess.execFile, originalExecFileSync = childProcess.execFileSync, originalFetch = globalThis.fetch;
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
function desktopFixture(home, custom = false) {
  if (process.platform === 'darwin') {
    const bundle = path.join(home, 'Applications', custom ? 'Custom Coding.app' : 'ChatGPT.app');
    const executable = path.join(bundle, 'Contents', 'MacOS', 'Fixture Desktop');
    write(path.join(bundle, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Fixture Desktop</string><key>CFBundleIdentifier</key><string>io.yunhui.navigation.fixture</string><key>CFBundleName</key><string>Fixture Desktop</string></dict></plist>');
    write(executable, '#!/bin/sh\nexit 0\n'); fs.chmodSync(executable, 0o700);
    return executable;
  }
  const executable = path.join(home, custom ? 'different' : path.join('AppData', 'Local', 'Programs', 'ChatGPT'), custom ? 'Codex.exe' : 'ChatGPT.exe');
  write(executable, 'fixture executable: never launch'); return executable;
}
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
try {
  const application = path.join(root, 'application'), home = path.join(root, 'clients');
  const bundle = path.join(application, 'api.cjs');
  await build({ stdin: { contents: "export * from './src/core/readOnlyJobs.ts';export {runAction} from './src/core/actions.ts';export {AuroraStore} from './src/core/store/index.ts';export {desktopInfo} from './src/core/injector.ts';export {detectAllAsync,detectDesktopAsync} from './src/core/agents/detectionAsync.ts';export {configureDesktopPath,detectReset} from './src/core/agents/adapters.ts';", resolveDir: base, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  for (const [input, output] of [['src/core/readOnlyWorker.ts', 'read-only-worker.cjs'], ['src/core/agents/detectionWorker.ts', 'detection-worker.cjs']]) {
    await build({ entryPoints: [path.join(base, input)], outfile: path.join(application, output), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  }
  process.env.AURORA_CLIENT_HOME = home;
  process.env.AURORA_HOME = process.env.YUNHUI_HOME = path.join(root, 'store');
  process.env.PATH = path.join(root, 'empty-bin');
  process.env.APPDATA = path.join(root, 'appdata'); process.env.LOCALAPPDATA = path.join(root, 'localappdata');
  const codex = path.join(home, '.codex'), sessions = path.join(codex, 'sessions');
  write(path.join(codex, 'config.toml'), 'model="fixture"\n[mcp_servers.fixture]\ncommand="fixture-never-run"\n');
  write(path.join(codex, 'skills', 'fixture', 'SKILL.md'), '# Fixture skill\nSafe resource fixture');
  const sample = path.join(sessions, 'rollout-0.jsonl');
  for (let i = 0; i < 260; i++) {
    const lines = [{ type: 'session_meta', payload: { id: `fixture-${i}`, cwd: 'D:/fixture' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `用户问题 ${i}` }] } }, { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '回答'.repeat(15000) }] } }];
    write(path.join(sessions, `rollout-${i}.jsonl`), lines.map(JSON.stringify).join('\n'));
  }
  write(path.join(home, '.codex', 'archived_sessions', 'archived.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'archived-fixture', cwd: 'D:/fixture' } }));
  const outside = path.join(root, 'outside.jsonl'); write(outside, JSON.stringify({ text: 'OUTSIDE_SECRET' }));
  const executable = desktopFixture(home);

  let asynchronousProcessProbes = 0;
  const fakeExecFile = () => { throw new Error('Unexpected callback subprocess'); };
  fakeExecFile[promisify.custom] = async () => { asynchronousProcessProbes++; await new Promise(resolve => setTimeout(resolve, 60)); return { stdout: '', stderr: '' }; };
  childProcess.execFile = fakeExecFile;
  childProcess.execFileSync = () => { throw new Error('Main-thread synchronous process probe is prohibited'); };
  globalThis.fetch = async () => ({ ok: false });
  const api = require(bundle);
  const store = new api.AuroraStore(path.join(root, 'actions-store'));
  const deps = { store, dataDir: store.dir, platform: process.platform, gatewayStatus: () => ({ running: false }), gatewayUrl: () => 'http://127.0.0.1:3425',
    historyContext: { home: codex, sqliteHome: codex, blockingProcesses: async () => [] } };

  class FakeWorker extends EventEmitter { terminate() { return Promise.resolve(0); } }
  await check('Concurrent scans coalesce; worker concurrency is bounded and completed reads are refreshed', async () => {
    const workers = [];
    const scheduler = new api.ReadOnlyJobScheduler({ context: () => 'fixture', concurrency: 2, worker: (job, input) => { const worker = new FakeWorker(); workers.push({ worker, job, input }); return worker; } });
    const first = scheduler.run('sessions.scan'), duplicate = scheduler.run('sessions.scan');
    const second = scheduler.run('sessions.read', { path: 'a' }), third = scheduler.run('codex.assets');
    assert.equal(workers.length, 2);
    workers[0].worker.emit('message', { ok: true, value: [{ id: 'same' }] });
    await new Promise(setImmediate);
    assert.equal(workers.length, 3); workers[1].worker.emit('message', { ok: true, value: [] }); workers[2].worker.emit('message', { ok: true, value: [] });
    const a = await first, b = await duplicate; assert.deepEqual(a, b); a[0].id = 'changed'; assert.equal(b[0].id, 'same'); await Promise.all([second, third]);
    const refreshed = scheduler.run('sessions.scan'); assert.equal(workers.length, 4); workers[3].worker.emit('message', { ok: true, value: [] }); await refreshed;
  });
  await check('Timeouts return promptly while slots stay reserved until worker termination', async () => {
    const workers = [], scheduler = new api.ReadOnlyJobScheduler({ context: () => 'fixture', concurrency: 1, timeoutMs: 30, worker: () => { const worker = new FakeWorker(); worker.terminate = () => new Promise(resolve => { worker.release = resolve; }); workers.push(worker); return worker; } });
    await assert.rejects(scheduler.run('sessions.scan'), /超时/);
    const queued = scheduler.run('codex.assets'); assert.equal(workers.length, 1);
    workers[0].release(0); await new Promise(setImmediate);
    assert.equal(workers.length, 2); workers[1].emit('message', { ok: true, value: [] }); await queued;
    workers[1].release(0); await new Promise(setImmediate);
    const failed = assert.rejects(scheduler.run('sessions.scan'), /不可用/); workers[2].emit('error', new Error('SECRET')); await failed;
    workers[2].release(0); await new Promise(setImmediate);
    const exited = assert.rejects(scheduler.run('sessions.scan'), /提前结束/); workers[3].emit('exit', 1); await exited;
    const queueTimeout = assert.rejects(scheduler.run('codex.assets'), /超时/); await queueTimeout;
    workers[3].release(0); await new Promise(setImmediate); assert.equal(workers.length, 4);
  });
  await check('Timed-out synchronous child probes cannot exceed the real live-worker limit', async () => {
    const slow = path.join(root, 'sync-probe-worker.cjs'), marker = path.join(root, 'sync-probe-started');
    write(slow, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'started');require('node:child_process').execFileSync(process.execPath,['-e','Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,700)'],{windowsHide:true,stdio:'ignore',timeout:2000});`);
    let live = 0, maximum = 0; const stopped = [];
    const scheduler = new api.ReadOnlyJobScheduler({ context: () => 'fixture', concurrency: 1, timeoutMs: 250, worker: () => {
      const worker = new Worker(slow); live++; maximum = Math.max(maximum, live);
      const terminate = worker.terminate.bind(worker);
      stopped.push(new Promise(resolve => { worker.terminate = () => terminate().then(code => { live--; resolve(); return code; }); })); return worker;
    } });
    const first = assert.rejects(scheduler.run('sessions.scan'), /超时/);
    for (let i = 0; !fs.existsSync(marker) && i < 40; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert(fs.existsSync(marker), 'Synchronous child probe actually started');
    await Promise.all([first, assert.rejects(scheduler.run('codex.assets'), /超时/), assert.rejects(scheduler.run('sessions.read', { path: 'fixture' }), /超时/)]);
    assert.equal(maximum, 1); assert.equal(live, 1);
    await Promise.all(stopped); assert.equal(live, 0); assert.equal(maximum, 1);
  });
  await check('A genuinely blocked worker leaves main-thread timers and unrelated page actions responsive', async () => {
    const slow = path.join(root, 'slow-worker.cjs'); write(slow, "const {parentPort}=require('node:worker_threads');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);parentPort.postMessage({ok:true,value:[]});");
    const scheduler = new api.ReadOnlyJobScheduler({ context: () => 'fixture', worker: () => new Worker(slow) });
    let ticks = 0; const timer = setInterval(() => { ticks++; }, 10);
    try {
      const pending = scheduler.run('sessions.scan');
      const started = performance.now();
      assert.equal(await api.runAction(deps, 'gateway.url', {}), 'http://127.0.0.1:3425');
      assert(performance.now() - started < 100);
      await pending; assert(ticks >= 12, `Main heartbeat only ran ${ticks} times`);
    } finally { clearInterval(timer); }
  });
  await check('Actual concurrent navigation reads use isolated workers and preserve native history semantics', async () => {
    let ticks = 0; const timer = setInterval(() => { ticks++; }, 5);
    const before = fs.readFileSync(path.join(codex, 'config.toml'), 'utf8');
    try {
      const [scan, duplicate, assets, messages] = await Promise.all([
        api.runAction(deps, 'sessions.scan', {}), api.runAction(deps, 'sessions.scan', {}), api.runAction(deps, 'codex.assets', {}), api.runAction(deps, 'sessions.read', { path: sample }),
      ]);
      assert.equal(scan.length, 261); assert.deepEqual(scan, duplicate); assert(scan.find(item => item.id === 'archived-fixture').archived);
      assert(assets.assets.some(item => item.id === 'skill:fixture')); assert(assets.assets.some(item => item.id === 'mcp:fixture'));
      assert.equal(messages[0].text, '用户问题 0'); assert(ticks >= 3, `Main heartbeat only ran ${ticks} times`);
      const markdown = await api.runAction(deps, 'sessions.export', { summary: scan.find(item => item.id === 'fixture-0') }); assert(markdown.markdown.includes('用户问题 0'));
      assert.equal(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), before);
      write(path.join(sessions, 'fresh.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: 'fresh-fixture' } }));
      assert.equal((await api.scanSessionsAsync()).length, 262);
    } finally { clearInterval(timer); }
  });
  await check('Worker reads retain the session path boundary and reject an unlisted worker operation', async () => {
    await assert.rejects(api.readSessionAsync(outside), /路径|目录/);
    await assert.rejects(api.exportSessionAsync({ summary: { path: outside } }), /路径|目录/);
    const worker = new Worker(path.join(application, 'read-only-worker.cjs'), { workerData: { job: 'sessions.delete', input: { path: sample } } });
    const reply = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    assert.equal(reply.ok, false); assert.match(reply.error, /不支持/); assert(fs.existsSync(sample));
  });
  await check('Plugin desktop status shares client detection and uses asynchronous process probes', async () => {
    api.detectReset();
    const detections = await api.detectAllAsync(); assert.equal(detections['chatgpt-desktop'].installed, true);
    assert.equal(detections['chatgpt-desktop'].desktopDetails.executable, executable);
    const [info, detection] = await Promise.all([api.desktopInfo(), api.detectDesktopAsync()]);
    assert.equal(info.executable, executable); assert.equal(detection.executable, executable); assert.equal(info.running, false); assert(asynchronousProcessProbes >= 1);
    const changed = desktopFixture(home, true);
    assert.equal((await api.detectDesktopAsync(changed)).executable, changed);
    assert.equal((await api.desktopInfo(undefined, changed, 9222, true)).executable, changed);
  });
  await check('Desktop preview and apply use a trusted fresh snapshot without redoing installation probes on main', async () => {
    const provider = store.saveProvider({ name: 'Fixture', format: 'openai-responses', baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'fixture' }], apiKeys: [{ id: 'fixture', key: 'fixture-key', enabled: true, weight: 1 }] });
    // Keep the intentionally simplified scan fixtures intact. Native history
    // switching is tested separately against valid UUIDs and SQLite indexes.
    const actionHome = path.join(root, 'action-client'), actionCodex = path.join(actionHome, '.codex');
    const actionExecutable = desktopFixture(actionHome), originalConfig = fs.readFileSync(path.join(codex, 'config.toml'), 'utf8');
    write(path.join(actionCodex, 'config.toml'), originalConfig);
    const actionDeps = { ...deps, historyContext: { home: actionCodex, sqliteHome: actionCodex, blockingProcesses: async () => [] } };
    process.env.AURORA_CLIENT_HOME = actionHome; api.detectReset();
    const stat = fs.statSync; let mainExecutableReads = 0;
    fs.statSync = function(file, ...args) { if (path.resolve(String(file)) === path.resolve(actionExecutable)) { mainExecutableReads++; throw new Error('Executable probe must run in worker'); } return stat.call(this, file, ...args); };
    try {
      const payload = { agentId: 'chatgpt-desktop', providerId: provider.id, model: 'fixture', mode: 'direct', desktopDetection: { installed: true, supportsCodexConfig: true } };
      const preview = await api.runAction(actionDeps, 'agent.preview', payload); assert.equal(preview.ok, true, preview.message);
      assert(preview.warnings.some(value => value.includes('尚未完成实际请求验证')), 'Untrusted renderer snapshot must not suppress the actual capability notice');
      const connected = await api.runAction(actionDeps, 'agent.connect', { ...payload, revision: preview.revision }); assert.equal(connected.ok, true, connected.message);
      assert.equal(mainExecutableReads, 0); assert(fs.readFileSync(path.join(actionCodex, 'config.toml'), 'utf8').includes('fixture.invalid'));
      assert.equal(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8'), originalConfig);
    } finally { fs.statSync = stat; process.env.AURORA_CLIENT_HOME = home; api.detectReset(); }
  });
  await check('A packaged Electron ASAR loads the read-only worker and keeps history readable', async () => {
    const output = path.join(root, 'electron-result.json'), profile = path.join(root, 'electron-profile');
    write(path.join(application, 'package.json'), JSON.stringify({ name: 'isolated-navigation-fixture', version: '1.0.0', main: 'main.cjs' }));
    write(path.join(application, 'main.cjs'), `const {app}=require('electron');app.setPath('userData',${JSON.stringify(profile)});const fs=require('original-fs'),api=require('./api.cjs');app.whenReady().then(async()=>{try{let ticks=0;const timer=setInterval(()=>ticks++,5);const [sessions,assets]=await Promise.all([api.scanSessionsAsync(),api.listCodexAssetsAsync()]);clearInterval(timer);const messages=await api.readSessionAsync(${JSON.stringify(sample)});fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({count:sessions.length,assets:assets.map(v=>v.id),text:messages[0].text,ticks}));app.exit(0);}catch(e){fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({error:e.message}));app.exit(1);}});`);
    const builderRequire = createRequire(require.resolve('electron-builder')), appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
    const archive = path.join(root, 'app.asar'); await appBuilderRequire('@electron/asar').createPackage(application, archive);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    execFileSync(require('electron'), [archive], { env, windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(fs.readFileSync(output, 'utf8')); assert.equal(result.count, 262); assert(result.assets.includes('skill:fixture')); assert.equal(result.text, '用户问题 0'); assert(result.ticks >= 3);
  });
  console.log(`Navigation read workers: ${passed} checks passed.`);
} finally {
  childProcess.execFile = originalExecFile; childProcess.execFileSync = originalExecFileSync; globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, environment);
  assert.equal(fs.realpathSync(path.dirname(root)), fs.realpathSync(os.tmpdir())); assert(path.basename(root).startsWith('yunhui-navigation-workers-'));
  fs.rmSync(root, { recursive: true, force: true });
}
