import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-client-lifecycle-')));
const previousClientHome = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = temporary;
let checks = 0;
const check = async (name, run) => { await run(); checks++; console.log(`PASS ${name}`); };
try {
  const bundle = path.join(temporary, 'lifecycle.cjs');
  await build({ entryPoints: ['src/main/clientLifecycle.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  const processEntry = (patch = {}) => ({ pid: 987651, executable: 'C:\\Apps\\Claude\\Claude.exe', started: '638989000000000000', ownerSid: 'S-1-5-21-fixture', sessionId: 2, hasWindow: true, ...patch });
  function fixture(overrides = {}) {
    let now = 0;
    const target = { agentId: 'claude-desktop', kind: 'desktop', executable: 'C:\\Apps\\Claude\\Claude.exe', identity: 'fixture-version' };
    const state = { processes: [], uncertain: false, detected: 0, resolved: 0, starts: [], terminals: [], closes: [], delayCount: 0, validateCount: 0 };
    const runtime = {
      platform: 'win32', home: () => 'C:\\Users\\Fixture User',
      detect: () => { state.detected++; return { installed: true, configured: true, command: target.executable }; },
      resolveTarget: async (id) => { state.resolved++; return { ...target, agentId: id, kind: id.endsWith('-cli') || id === 'claude-code' ? 'cli' : 'desktop' }; },
      validateTarget: () => { state.validateCount++; return true; },
      listProcesses: async () => ({ processes: [...state.processes], uncertain: state.uncertain }),
      closeProcess: async (_target, process) => { state.closes.push({ ...process }); state.processes = state.processes.filter(entry => entry.pid !== process.pid); return 'requested'; },
      startDesktop: async target => { state.starts.push({ ...target }); state.processes = [processEntry()]; },
      openTerminal: async (target, cwd) => { state.terminals.push({ target, cwd }); },
      now: () => now,
      delay: async ms => { now += ms; state.delayCount++; },
      ...overrides,
    };
    return { ...api.createClientLifecycle(runtime), runtime, state, target };
  }

  await check('Only a trusted client ID crosses the lifecycle boundary', async () => {
    const f = fixture();
    for (const payload of [null, [], {}, { agentId: 'unknown' }, { agentId: '__proto__' }, { agentId: 'claude-desktop', path: 'C:\\evil.exe' }, { agentId: 'claude-desktop', command: 'calc' }, { agentId: 'claude-desktop', pid: 1 }, { agentId: 'claude-desktop', args: [] }, { agentId: 'claude-desktop', confirmed: true }]) {
      await assert.rejects(() => f.describeClientLifecycle(payload)); await assert.rejects(() => f.restartClient(payload));
    }
    assert.equal(f.state.detected, 0); assert.equal(f.state.starts.length, 0);
  });
  await check('Services and unsupported platforms never invoke native lifecycle operations', async () => {
    const f = fixture(); const service = await f.describeClientLifecycle({ agentId: 'deepseek' });
    assert.equal(service.kind, 'service'); assert.equal(service.supported, false); assert.equal((await f.restartClient({ agentId: 'deepseek' })).operation, 'unsupported'); assert.equal(f.state.detected, 0);
    for (const platform of ['linux']) {
      const other = fixture({ platform }); assert.equal((await other.describeClientLifecycle({ agentId: 'claude-desktop' })).supported, false); assert.equal((await other.restartClient({ agentId: 'claude-desktop' })).operation, 'unsupported'); assert.equal(other.state.resolved, 0);
    }
  });
  await check('Missing clients and changed executable identities stop before process operations', async () => {
    const missing = fixture({ resolveTarget: async () => null }); assert.equal((await missing.describeClientLifecycle({ agentId: 'claude-desktop' })).installed, false); assert.equal((await missing.restartClient({ agentId: 'claude-desktop' })).ok, false); assert.equal(missing.state.starts.length, 0);
    const changed = fixture({ validateTarget: () => false }); assert.match((await changed.restartClient({ agentId: 'claude-desktop' })).message, /程序已变化/); assert.equal(changed.state.closes.length, 0);
  });
  await check('A stopped desktop is started with its detected target and verified as running', async () => {
    const f = fixture(); const info = await f.describeClientLifecycle({ agentId: 'claude-desktop' }); assert.equal(info.supported, true); assert.equal(f.state.starts.length, 0);
    const result = await f.restartClient({ agentId: 'claude-desktop' }); assert.equal(result.operation, 'started'); assert.equal(result.ok, true); assert.equal(f.state.starts.length, 1); assert.equal(f.state.closes.length, 0); assert.equal(f.state.resolved, 2);
  });
  await check('Desktop restart terminates every matched process and waits for all of them to exit', async () => {
    const f = fixture(); f.state.processes = [processEntry(), processEntry({ pid: 987652, hasWindow: false })];
    let polls = 0;
    f.runtime.closeProcess = async (_target, process) => { f.state.closes.push(process); return 'requested'; };
    f.runtime.listProcesses = async () => {
      polls++; if (polls === 3) f.state.processes = [];
      return { processes: [...f.state.processes], uncertain: false };
    };
    const result = await f.restartClient({ agentId: 'claude-desktop' }); assert.equal(result.operation, 'restarted'); assert.equal(f.state.closes.length, 2); assert(f.state.delayCount > 0); assert.equal(f.state.starts.length, 1);
  });
  await check('Tray-only clients are terminated and reopened exactly once', async () => {
    const f = fixture(); f.state.processes = [processEntry({ hasWindow: false })];
    const result = await f.restartClient({ agentId: 'claude-desktop' }); assert.equal(result.ok, true); assert.equal(result.operation, 'restarted'); assert.equal(f.state.closes.length, 1); assert.equal(f.state.starts.length, 1); assert.equal(f.state.processes.length, 1);
  });
  await check('macOS apps without Windows handles are terminated before relaunch', async () => {
    const f = fixture({ platform: 'darwin' }); f.state.processes = [processEntry({ hasWindow: false })];
    assert.equal((await f.describeClientLifecycle({ agentId: 'claude-desktop' })).supported, true);
    const result = await f.restartClient({ agentId: 'claude-desktop' }); assert.equal(result.ok, true); assert.equal(result.operation, 'restarted'); assert.equal(f.state.closes.length, 1); assert.equal(f.state.starts.length, 1);
    const blocked = fixture({ platform: 'darwin', closeProcess: async () => 'blocked' }); blocked.state.processes = [processEntry({ hasWindow: false })];
    assert.equal((await blocked.restartClient({ agentId: 'claude-desktop' })).ok, false); assert.equal(blocked.state.starts.length, 0);
  });
  await check('Incomplete identity checks never assume the app has stopped', async () => {
    const f = fixture(); f.state.uncertain = true;
    const result = await f.restartClient({ agentId: 'claude-desktop' }); assert.equal(result.ok, false); assert.match(result.message, /进程身份/); assert.equal(f.state.closes.length, 0); assert.equal(f.state.starts.length, 0);
  });
  await check('Current, parent and ancestor processes are protected even with a matching client path', async () => {
    for (const process of [processEntry({ pid: globalThis.process.pid }), processEntry({ pid: globalThis.process.ppid }), processEntry({ protected: true })]) {
      const f = fixture(); f.state.processes = [process]; const result = await f.restartClient({ agentId: 'claude-desktop' }); assert.equal(result.ok, false); assert.match(result.message, /云汇自身或启动云汇/); assert.equal(f.state.closes.length, 0); assert.equal(f.state.starts.length, 0);
    }
  });
  await check('A reused process identity or rejected termination prevents relaunch', async () => {
    for (const outcome of ['changed', 'blocked']) {
      const f = fixture({ closeProcess: async () => outcome }); f.state.processes = [processEntry()]; const result = await f.restartClient({ agentId: 'claude-desktop' }); assert.equal(result.ok, false); assert.equal(f.state.starts.length, 0);
    }
  });
  await check('A client that refuses to exit is left running after the bounded wait', async () => {
    const f = fixture({ closeProcess: async () => 'requested' }); f.state.processes = [processEntry()];
    const result = await f.restartClient({ agentId: 'claude-desktop' }); assert.equal(result.ok, false); assert.match(result.message, /尚未完全结束/); assert.equal(f.state.starts.length, 0); assert.equal(f.state.processes.length, 1); assert(f.state.delayCount <= 34);
  });
  await check('New background instances discovered during shutdown are terminated before launch', async () => {
    const f = fixture(); f.state.processes = [processEntry()];
    f.runtime.closeProcess = async (_target, process) => {
      f.state.closes.push(process);
      f.state.processes = f.state.closes.length === 1 ? [processEntry({ pid: 987652, hasWindow: false })] : [];
      return 'requested';
    };
    const result = await f.restartClient({ agentId: 'claude-desktop' });
    assert.equal(result.ok, true); assert.deepEqual(f.state.closes.map(entry => entry.pid), [987651, 987652]); assert.equal(f.state.starts.length, 1);
  });
  await check('Uncertain or protected processes appearing during shutdown stop further termination and launch', async () => {
    for (const protectedProcess of [false, true]) {
      const f = fixture(); f.state.processes = [processEntry()];
      f.runtime.closeProcess = async (_target, process) => {
        f.state.closes.push(process); f.state.processes = [processEntry({ pid: 987652, protected: protectedProcess })];
        f.state.uncertain = !protectedProcess; return 'requested';
      };
      const result = await f.restartClient({ agentId: 'claude-desktop' });
      assert.equal(result.ok, false); assert.equal(f.state.closes.length, 1); assert.equal(f.state.starts.length, 0);
    }
  });
  await check('An executable replaced during exit is not launched', async () => {
    const f = fixture(); f.state.processes = [processEntry()]; let validations = 0; f.runtime.validateTarget = () => ++validations === 1;
    const result = await f.restartClient({ agentId: 'claude-desktop' }); assert.equal(result.ok, false); assert.match(result.message, /退出期间已变化/); assert.equal(f.state.starts.length, 0);
  });
  await check('An app appearing between detection and launch is not started a second time', async () => {
    let polls = 0; const f = fixture({ listProcesses: async () => ({ processes: ++polls === 1 ? [] : [processEntry()], uncertain: false }) });
    assert.equal((await f.restartClient({ agentId: 'claude-desktop' })).ok, false); assert.equal(f.state.starts.length, 0);
  });
  await check('MSIX activation uses the trusted target and still requires a matching running process', async () => {
    const f = fixture(); f.runtime.resolveTarget = async () => ({ ...f.target, aumid: 'Claude_fixture!App' });
    assert.equal((await f.restartClient({ agentId: 'claude-desktop' })).ok, true); assert.equal(f.state.starts[0].aumid, 'Claude_fixture!App');
    const never = fixture({ startDesktop: async () => {} }); const result = await never.restartClient({ agentId: 'claude-desktop' }); assert.equal(result.ok, false); assert.match(result.message, /未检测到客户端运行/); assert(never.state.delayCount <= 34);
  });
  await check('CLI actions only open a new terminal in the home directory', async () => {
    const f = fixture({ listProcesses: async () => { throw new Error('must not enumerate CLI processes'); }, closeProcess: async () => { throw new Error('must not close CLI'); } });
    const result = await f.restartClient({ agentId: 'codex-cli' }); assert.equal(result.operation, 'opened-terminal'); assert.equal(result.ok, true); assert.match(result.message, /查看启动结果/); assert.match(result.message, /原终端会话仍保留/); assert.equal(f.state.terminals[0].cwd, 'C:\\Users\\Fixture User'); assert.equal(f.state.closes.length, 0); assert.equal(f.state.starts.length, 0);
  });
  await check('A terminal that does not confirm launch cannot report CLI success or stop existing sessions', async () => {
    const f = fixture({ openTerminal: async () => { throw new Error('fixture-private-terminal-failure'); }, listProcesses: async () => { throw new Error('must not enumerate CLI processes'); }, closeProcess: async () => { throw new Error('must not close CLI'); } });
    const result = await f.restartClient({ agentId: 'claude-code' });
    assert.equal(result.ok, false); assert.equal(result.operation, 'failed'); assert(!result.message.includes('已打开')); assert(!result.message.includes('fixture-private'));
    assert.equal(f.state.closes.length, 0); assert.equal(f.state.starts.length, 0);
  });
  await check('Duplicate and aliased restart requests share one operation', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; }); const f = fixture(); f.runtime.startDesktop = async target => { f.state.starts.push(target); await gate; f.state.processes = [processEntry()]; };
    const first = f.restartClient({ agentId: 'codex-desktop' }), second = f.restartClient({ agentId: 'chatgpt-desktop' }); await Promise.resolve(); await Promise.resolve(); release();
    const results = await Promise.all([first, second]); assert(results.every(result => result.ok && result.agentId === 'chatgpt-desktop')); assert.equal(f.state.starts.length, 1);
  });
  await check('Native helper failures are sanitized and do not become false success', async () => {
    const f = fixture({ startDesktop: async () => { throw new Error('fixture-private-network-token'); } });
    const result = await f.restartClient({ agentId: 'claude-desktop' }); assert.equal(result.ok, false); assert(!JSON.stringify(result).includes('fixture-private'));
  });
  if (process.platform === 'win32') await check('Native target validation rejects arbitrary executables and treats npm command shims as literal files', async () => {
    const dir = path.join(temporary, "path with spaces and ' quote"); fs.mkdirSync(dir); const shim = path.join(dir, 'codex.cmd'); fs.writeFileSync(shim, '@rem isolated non-executed fixture\r\n');
    const target = await api.nativeClientLifecycleRuntime.resolveTarget('codex-cli', { installed: true, configured: false, command: shim.slice(0, -4) }); assert.equal(target.executable, fs.realpathSync.native(shim)); assert.equal(api.nativeClientLifecycleRuntime.validateTarget(target), true);
    fs.appendFileSync(shim, '@rem changed\r\n'); assert.equal(api.nativeClientLifecycleRuntime.validateTarget(target), false);
    for (const command of [process.execPath, 'C:\\Windows\\System32\\cmd.exe', 'powershell.exe', 'C:\\Apps\\Claude.exe\nwhoami']) await assert.rejects(() => api.nativeClientLifecycleRuntime.resolveTarget('claude-desktop', { installed: true, configured: false, command }));
  });
  console.log(`Client lifecycle: ${checks} checks passed`);
} finally {
  if (previousClientHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = previousClientHome;
  if (path.dirname(temporary) === fs.realpathSync.native(os.tmpdir()) && path.basename(temporary).startsWith('yunhui-client-lifecycle-')) fs.rmSync(temporary, { recursive: true, force: true });
}
