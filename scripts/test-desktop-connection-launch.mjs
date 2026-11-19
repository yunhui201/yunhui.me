/** Closed-port desktop launch regressions. All host operations use trusted private runtimes.
 * --renderer additionally starts our private Electron fixture and performs the real CDP handshake.
 * It models the package activation boundary; it never registers or activates an actual MSIX app.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-connection-launch-')));
const require = createRequire(import.meta.url);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const selected = path.join(scratch, "WindowsApps", "OpenAI.ChatGPT_fixture", "client 'quoted'", 'ChatGPT.exe');
const config = path.join(scratch, 'clients', '.codex', 'config.toml');
fs.mkdirSync(path.dirname(config), { recursive: true });
fs.writeFileSync(config, 'model_provider = "preserve-fixture"\n', 'utf8');
const original = fs.readFileSync(config), originalMtime = fs.statSync(config).mtimeMs;
let checks = 0;
const test = async (label, run) => { await run(); checks++; console.log('PASS ' + label); };
const fakeCdp = { connected: true, target: { title: 'private fixture', url: 'app://-/index.html' }, close() {} };

function fixture(extra = {}) {
  const state = { open: false, now: 0, calls: [], delays: 0, portCalls: 0 };
  const detected = { installed: true, executable: selected, exePath: selected,
    supportsCodexConfig: true, evidence: ['private fixture'] };
  const runtime = {
    platform: 'win32',
    detect: async (...args) => { state.calls.push(['detect', ...args]); return detected; },
    running: async paths => { state.calls.push(['running', paths]); return []; },
    portOpen: async port => { assert(++state.portCalls <= 120, 'Port readiness must be bounded'); state.calls.push(['portOpen', port]); return state.open; },
    launchPackaged: async (executable, port) => { state.calls.push(['launchPackaged', executable, port]); state.open = true; return { packaged: true, pid: 4321 }; },
    launchProcess: async (command, args) => { state.calls.push(['launchProcess', command, args]); state.open = true; },
    connect: async port => { state.calls.push(['connect', port]); return fakeCdp; },
    delay: async ms => { assert(Number.isFinite(ms) && ms >= 0); state.delays++; state.now += ms; assert(state.delays <= 120, 'Launch retries must be bounded'); },
    now: () => state.now,
    ...extra,
  };
  return { runtime, state, detected, calls: name => state.calls.filter(call => call[0] === name) };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

try {
  const bundle = path.join(scratch, 'api.cjs');
  await build({ stdin: { contents: "export { openDesktopConnection, DesktopCdp, debugPortOpen } from './src/core/injector.ts';", resolveDir: root, loader: 'ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = require(bundle);
  const options = { port: 9333, exePath: selected, launch: true };

  await test('Closed-port packaged Windows launch activates the selected path and never starts its bare executable', async () => {
    const f = fixture(), opened = await api.openDesktopConnection(options, f.runtime);
    assert.equal(opened.launched, true); assert.equal(opened.cdp, fakeCdp);
    assert.deepEqual(f.calls('detect'), [['detect', selected, true]]);
    assert.deepEqual(f.calls('running'), [['running', [selected]]]);
    assert.deepEqual(f.calls('launchPackaged'), [['launchPackaged', selected, options.port]]);
    assert.equal(f.calls('launchProcess').length, 0); assert.equal(f.calls('connect').length, 1);
    assert.equal(f.state.calls[0][0], 'portOpen');
    assert(f.state.calls.findIndex(call => call[0] === 'launchPackaged') < f.state.calls.findIndex(call => call[0] === 'connect'));
  });

  await test('Package activation failure propagates immediately without bare executable fallback or CDP connection', async () => {
    const f = fixture(), failure = new Error('fixture package activation failed');
    f.runtime.launchPackaged = async () => { throw failure; };
    await assert.rejects(api.openDesktopConnection(options, f.runtime), error => error === failure);
    assert.equal(f.calls('launchProcess').length, 0); assert.equal(f.calls('connect').length, 0); assert.equal(f.state.delays, 0);
  });

  await test('Package-context activation without a trusted PID succeeds only after port readiness and compatible CDP', async () => {
    const f = fixture(); let started = false, portProbes = 0, connected = 0;
    f.runtime.launchPackaged = async () => { started = true; return { packaged: true }; };
    f.runtime.portOpen = async () => started && ++portProbes >= 3;
    f.runtime.connect = async () => { assert(started && portProbes >= 3); connected++; return fakeCdp; };
    const opened = await api.openDesktopConnection(options, f.runtime);
    assert.equal(opened.launched, true); assert.equal(opened.cdp, fakeCdp); assert.equal(connected, 1);
    assert(f.state.delays >= 2); assert.equal(f.calls('launchProcess').length, 0);
  });

  await test('Package-context activation without a trusted PID cannot bypass readiness or fall back to bare execution', async () => {
    const noPort = fixture({ launchPackaged: async () => ({ packaged: true }) });
    await assert.rejects(api.openDesktopConnection(options, noPort.runtime), /调试端口未开启/);
    assert.equal(noPort.calls('connect').length, 0); assert.equal(noPort.calls('launchProcess').length, 0);
    const incompatible = fixture(); let attempts = 0;
    incompatible.runtime.launchPackaged = async () => { incompatible.state.open = true; return { packaged: true }; };
    incompatible.runtime.connect = async () => { attempts++; throw new Error('fixture package-context has no compatible renderer'); };
    await assert.rejects(api.openDesktopConnection(options, incompatible.runtime), /no compatible renderer/);
    assert(attempts > 0 && attempts <= 40); assert.equal(incompatible.calls('launchProcess').length, 0);
  });

  await test('Ordinary Windows applications receive only the selected loopback debugging arguments', async () => {
    const f = fixture();
    const ordinary = path.join(scratch, "Programs", "ChatGPT 'quoted'", 'ChatGPT.exe');
    f.detected.executable = ordinary;
    f.runtime.launchPackaged = async (exe, port) => { f.state.calls.push(['launchPackaged', exe, port]); return { packaged: false }; };
    const opened = await api.openDesktopConnection({ ...options, exePath: ordinary }, f.runtime);
    assert.equal(opened.launched, true);
    assert.deepEqual(f.calls('launchProcess'), [['launchProcess', ordinary, ['--remote-debugging-port=9333', '--remote-debugging-address=127.0.0.1']]]);
    assert.deepEqual(f.calls('launchPackaged'), [['launchPackaged', ordinary, 9333]]);
  });

  await test('A normal executable launch error is not mistaken for a connected client', async () => {
    const f = fixture(); f.runtime.launchPackaged = async () => ({ packaged: false });
    f.runtime.launchProcess = async () => { throw new Error('fixture executable launch failed'); };
    await assert.rejects(api.openDesktopConnection(options, f.runtime), /fixture executable launch failed/);
    assert.equal(f.calls('connect').length, 0);
  });

  await test('macOS launches the full app bundle with arguments and never calls Windows package activation', async () => {
    const f = fixture({ platform: 'darwin' });
    f.detected.bundlePath = "/Applications/ChatGPT 'Fixture'.app";
    f.detected.executable = f.detected.bundlePath + '/Contents/MacOS/Desktop Main';
    const opened = await api.openDesktopConnection(options, f.runtime);
    assert.equal(opened.launched, true); assert.equal(f.calls('launchPackaged').length, 0);
    assert.deepEqual(f.calls('launchProcess'), [['launchProcess', '/usr/bin/open', ['-n', '-a', f.detected.bundlePath,
      '--args', '--remote-debugging-port=9333', '--remote-debugging-address=127.0.0.1']]]);
  });

  await test('An unverified native macOS chat client cannot be launched as an Electron coding client', async () => {
    const f = fixture({ platform: 'darwin' });
    f.detected.bundlePath = '/Applications/ChatGPT.app'; f.detected.supportsCodexConfig = false;
    await assert.rejects(api.openDesktopConnection(options, f.runtime), /原生聊天版|编程桌面/);
    assert.equal(f.calls('launchPackaged').length, 0); assert.equal(f.calls('launchProcess').length, 0); assert.equal(f.calls('connect').length, 0);
  });

  await test('An already open debugging endpoint connects without detection, package activation or process launch', async () => {
    const f = fixture(); f.state.open = true;
    const opened = await api.openDesktopConnection({ ...options, launch: false }, f.runtime);
    assert.equal(opened.launched, false); assert.equal(opened.cdp, fakeCdp);
    assert.deepEqual(f.state.calls, [['portOpen', 9333], ['connect', 9333]]);
  });

  await test('Launching is explicit and a running client with no debugging port blocks every launch strategy', async () => {
    const noLaunch = fixture();
    await assert.rejects(api.openDesktopConnection({ ...options, launch: false }, noLaunch.runtime), /调试端口/);
    assert.deepEqual(noLaunch.state.calls, [['portOpen', 9333]]);
    const running = fixture({ running: async () => ['ChatGPT.exe'] });
    await assert.rejects(api.openDesktopConnection(options, running.runtime), /正在运行|退出/);
    assert.equal(running.calls('launchPackaged').length, 0); assert.equal(running.calls('launchProcess').length, 0); assert.equal(running.calls('connect').length, 0);
  });

  await test('Missing installation and invalid ports fail before either launch strategy runs', async () => {
    const missing = fixture({ detect: async () => ({ installed: false, evidence: [], supportsCodexConfig: false, detectionError: 'fixture missing client' }) });
    await assert.rejects(api.openDesktopConnection(options, missing.runtime), /fixture missing client/);
    assert.equal(missing.calls('launchPackaged').length, 0); assert.equal(missing.calls('launchProcess').length, 0);
    for (const port of [0, 1023, 65536, NaN, 9333.5]) {
      const invalid = fixture();
      await assert.rejects(api.openDesktopConnection({ ...options, port }, invalid.runtime), /调试端口/);
      assert.equal(invalid.state.calls.length, 0);
    }
  });

  await test('Package activation without a ready debugging port times out and never reports a connection', async () => {
    const f = fixture({ launchPackaged: async () => ({ packaged: true, pid: 4321 }) });
    await assert.rejects(api.openDesktopConnection(options, f.runtime), /端口|连接|超时/);
    assert(f.state.delays > 0 && f.state.now <= 60000);
    assert.equal(f.calls('connect').length, 0); assert.equal(f.calls('launchProcess').length, 0);
  });

  await test('An incompatible page after activation fails after bounded retries without another launch', async () => {
    const f = fixture(); let attempts = 0; const budgets = [];
    f.runtime.connect = async (_port, timeoutMs) => { attempts++; budgets.push(timeoutMs); throw new Error('fixture page is incompatible'); };
    await assert.rejects(api.openDesktopConnection(options, f.runtime), /fixture page is incompatible/);
    assert(attempts > 0 && attempts <= 40); assert(f.state.now <= 60000);
    assert(budgets.every((budget, index) => budget > 0 && budget <= 15000 && (!index || budget < budgets[index - 1])));
    assert.equal(f.calls('launchPackaged').length, 1); assert.equal(f.calls('launchProcess').length, 0);
  });

  await test('A newly launched renderer may become compatible later without repeating package activation', async () => {
    const f = fixture(); let attempts = 0;
    f.runtime.connect = async () => { if (++attempts < 3) throw new Error('fixture renderer not ready'); return fakeCdp; };
    const opened = await api.openDesktopConnection(options, f.runtime);
    assert.equal(opened.launched, true); assert.equal(opened.cdp, fakeCdp); assert.equal(attempts, 3);
    assert.equal(f.calls('launchPackaged').length, 1); assert.equal(f.calls('launchProcess').length, 0);
  });

  await test('An existing incompatible endpoint does not trigger a replacement application launch', async () => {
    const f = fixture(); f.state.open = true; let attempts = 0;
    f.runtime.connect = async () => { attempts++; throw new Error('fixture unrelated browser'); };
    await assert.rejects(api.openDesktopConnection(options, f.runtime), /fixture unrelated browser/);
    assert.equal(attempts, 1); assert.equal(f.calls('detect').length, 0); assert.equal(f.calls('launchPackaged').length, 0); assert.equal(f.calls('launchProcess').length, 0);
  });

  await test('A transport failure returns a customer-facing recovery action instead of raw fetch diagnostics', async () => {
    const f = fixture(); f.state.open = true;
    f.runtime.connect = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(api.openDesktopConnection(options, f.runtime), error =>
      /重新连接/.test(error.message) && !/fetch failed/.test(error.message));
    assert.equal(f.calls('launchPackaged').length, 0); assert.equal(f.calls('launchProcess').length, 0);
  });

  if (process.argv.includes('--renderer')) await test('Closed-port simulated package activation skips failed candidates and completes a real isolated Electron CDP handshake', async () => {
    const port = await freePort(), folder = path.join(scratch, 'renderer'); fs.mkdirSync(folder);
    const main = path.join(folder, 'main.cjs'), preload = path.join(folder, 'preload.cjs'), stop = path.join(folder, 'stop');
    const browserData = path.join(folder, 'user-data');
    fs.writeFileSync(preload, 'window.electronBridge={fixture:true};window.__yunhuiPrivateLaunchFixture="private-launch";');
    fs.writeFileSync(main, `const {app,BrowserWindow,protocol}=require('electron');const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(browserData)});app.disableHardwareAcceleration();
if(app.commandLine.getSwitchValue('remote-debugging-port')!==${JSON.stringify(String(port))}||app.commandLine.getSwitchValue('remote-debugging-address')!=='127.0.0.1')app.exit(3);
protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true}}]);
app.whenReady().then(async()=>{protocol.handle('app',()=>new Response('<html><title>Private launch fixture</title><body>Private launch</body></html>',{headers:{'Content-Type':'text/html'}}));
const win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:false,nodeIntegration:false,sandbox:false}});await win.loadURL('app://-/index.html');});
setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))app.quit();},100);setTimeout(()=>app.exit(4),45000);`);
    const environment = { ...process.env, AURORA_CLIENT_HOME: path.join(scratch, 'clients'),
      AURORA_HOME: path.join(folder, 'data'), YUNHUI_HOME: path.join(folder, 'data'),
      APPDATA: path.join(folder, 'appdata'), LOCALAPPDATA: path.join(folder, 'localappdata'), YUNHUI_TEST_ISOLATED: '1' };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'AURORA_DEV', 'AURORA_UI_URL', 'AURORA_SHOT', 'AURORA_PAGE']) delete environment[key];
    let child, cdp, childExit, output = '', activations = 0;
    const executable = require('electron');
    const nativeFetch = globalThis.fetch, NativeWebSocket = globalThis.WebSocket;
    const failedPeers = [];
    class FailedCandidate extends EventTarget {
      constructor(kind) {
        super(); this.kind = kind; this.closed = false; failedPeers.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event(kind === 'socket-error' ? 'error' : 'open')));
      }
      send(raw) {
        const request = JSON.parse(raw);
        // A protocol error rejects send(). An evaluation exceptionDetails reply
        // merely yields no identity and would not reproduce candidate rejection.
        queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
          id: request.id, error: { message: 'Private fixture execution context was destroyed' },
        }) })));
      }
      close() { if (!this.closed) { this.closed = true; this.dispatchEvent(new Event('close')); } }
    }
    try {
      assert.equal(await api.debugPortOpen(port), false, 'The test must exercise the closed-port launch branch');
      globalThis.fetch = async (url, ...args) => {
        const response = await nativeFetch(url, ...args);
        if (String(url) !== `http://127.0.0.1:${port}/json/list` || !response.ok) return response;
        const pages = await response.json();
        const failed = kind => ({ type: 'page', title: 'Private failed candidate', url: 'app://-/fixture-' + kind,
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/fixture-${kind}` });
        return new Response(JSON.stringify([failed('socket-error'), failed('protocol-error'), ...pages]), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      };
      globalThis.WebSocket = function (url, ...args) {
        const kind = /\/fixture-(socket-error|protocol-error)$/.exec(String(url))?.[1];
        return kind ? new FailedCandidate(kind) : new NativeWebSocket(url, ...args);
      };
      const f = fixture({
        portOpen: api.debugPortOpen, connect: (targetPort, timeoutMs) => api.DesktopCdp.connect(targetPort, 'main', timeoutMs), delay, now: Date.now,
        launchPackaged: async (candidate, debugPort) => {
          assert.equal(candidate, selected); assert.equal(debugPort, port); activations++;
          child = spawn(executable, [main, `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1'],
            { cwd: folder, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
          child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); });
          child.stderr.on('data', chunk => { output = (output + chunk).slice(-12000); });
          childExit = new Promise(resolve => child.once('exit', code => resolve(code)));
          await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          return { packaged: true, pid: child.pid };
        },
        launchProcess: async () => { throw new Error('A packaged application must never fall back to plain launch'); },
      });
      const opened = await api.openDesktopConnection({ ...options, port }, f.runtime); cdp = opened.cdp;
      assert.equal(opened.launched, true); assert.equal(activations, 1); assert.equal(cdp.connected, true);
      assert.equal(cdp.target.url, 'app://-/index.html');
      assert.equal(await cdp.evaluate('window.__yunhuiPrivateLaunchFixture'), 'private-launch');
      await cdp.evaluate('window.__yunhuiLaunchVerified=true');
      assert.equal(await cdp.evaluate('window.__yunhuiLaunchVerified'), true);
      assert(failedPeers.some(peer => peer.kind === 'socket-error') && failedPeers.some(peer => peer.kind === 'protocol-error'));
      assert(failedPeers.every(peer => peer.closed), 'Failed candidates must be closed before advancing');
    } catch (error) {
      if (output) console.error('Private Electron output:', output);
      throw error;
    } finally {
      globalThis.fetch = nativeFetch; globalThis.WebSocket = NativeWebSocket;
      cdp?.close(); fs.writeFileSync(stop, 'exit');
      if (child && child.exitCode === null) {
        const exited = await Promise.race([childExit.then(() => true), delay(5000).then(() => false)]);
        if (!exited) { child.kill(); await Promise.race([childExit, delay(3000)]); }
      }
    }
  });

  assert.deepEqual(fs.readFileSync(config), original); assert.equal(fs.statSync(config).mtimeMs, originalMtime);
  console.log(`${checks} desktop connection launch checks passed; no real client or user configuration accessed`);
} finally {
  const resolved = fs.realpathSync(scratch);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert(path.basename(resolved).startsWith('yunhui-connection-launch-'));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
