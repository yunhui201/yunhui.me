import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

// These tests mock macOS system APIs. Passing on another OS is not native macOS validation.
const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-macos-lifecycle-')));
let checks = 0;
const check = async (name, run) => { await run(); checks++; console.log(`PASS ${name}`); };
try {
  const output = path.join(temporary, 'mac.cjs');
  await build({ stdin: { contents: "export * from './src/main/clientLifecycleMac.ts'; export { resolveMacApplication } from './src/core/desktopDetection.ts'; export { getAdapter } from './src/core/agents/adapters.ts';", resolveDir: process.cwd(), loader: 'ts' }, outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(output);
  const definition = { kind: 'desktop', name: 'Claude', binaries: ['Claude'] };
  let sequence = 0;
  function fixture(changes = {}) {
    const home = path.join(temporary, `home ${++sequence} ' quoted`); fs.mkdirSync(home);
    const bundle = path.join(home, 'Applications', 'Claude.app'), executable = path.join(bundle, 'Contents', 'MacOS', 'ClaudeLauncher'), infoPlist = path.join(bundle, 'Contents', 'Info.plist');
    fs.mkdirSync(path.dirname(executable), { recursive: true }); fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 }); fs.writeFileSync(infoPlist, 'fixture-metadata');
    const metadata = { CFBundleExecutable: 'ClaudeLauncher', CFBundleIdentifier: 'io.yunhui.fixture.claude', CFBundleVersion: '1' };
    const state = { calls: [], candidates: [], processes: [], uncertain: false, closeResult: 'requested', terminalResult: true, failure: null };
    const host = {
      home: () => home, isolatedHome: () => home, ownExecutable: () => process.execPath, uid: () => 501, pid: () => 987700,
      terminalPath: () => '/System/Applications/Utilities/Terminal.app',
      resolveApplication: candidate => { state.candidates.push(candidate); return api.resolveMacApplication(candidate, { readPlist: () => metadata, canExecute: () => true }); },
      run: async (file, args) => {
        state.calls.push({ file, args }); if (state.failure) throw state.failure;
        if (file === '/usr/bin/open') return '';
        assert.equal(file, '/usr/bin/osascript'); assert.deepEqual(args.slice(0, 4), ['-l', 'JavaScript', '-e', args[3]]);
        const payload = JSON.parse(args.at(-1));
        if (payload.mode === 'list') return JSON.stringify({ processes: state.processes, uncertain: state.uncertain });
        if (payload.mode === 'close') return JSON.stringify({ result: state.closeResult });
        if (payload.mode === 'terminal') return JSON.stringify({ submitted: state.terminalResult });
        throw new Error('Unexpected test operation');
      }, ...changes,
    };
    const driver = api.createMacClientLifecycle(host);
    const row = target => ({ pid: 987701, executable: target.executable, bundlePath: target.bundlePath, bundleId: target.bundleId, started: '1794776400.123456|Sun Nov 15 13:00:00 2026', ownerSid: 'uid:501', sessionId: 0, hasWindow: false, protected: false });
    return { driver, host, state, home, bundle, executable, infoPlist, metadata, row };
  }
  await check('Bundle discovery uses isolated Applications and the declared executable identity', async () => {
    const f = fixture(); const target = await f.driver.resolveTarget('claude-desktop', definition, { installed: false, configured: false });
    assert.equal(target.bundlePath, fs.realpathSync.native(f.bundle)); assert.equal(target.executable, fs.realpathSync.native(f.executable)); assert.equal(target.bundleId, f.metadata.CFBundleIdentifier); assert.equal(f.driver.validateTarget(target), true);
    assert(f.state.candidates.every(candidate => candidate.startsWith(f.home))); assert.equal(f.state.calls.length, 0);
    const exact = await f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: f.executable }); assert.equal(exact.identity, target.identity);
  });
  await check('Missing and non-client bundles never become an arbitrary launch target', async () => {
    const f = fixture(); assert.equal(await f.driver.resolveTarget('claude-desktop', { ...definition, binaries: ['Missing'] }, { installed: false, configured: false }), null);
    await assert.rejects(() => f.driver.resolveTarget('chatgpt-desktop', { ...definition, binaries: ['ChatGPT'] }, { installed: true, configured: false, command: f.bundle }), /不匹配/);
    await assert.rejects(() => f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: 'Claude.app' }), /路径无效/);
    const outside = fixture(); await assert.rejects(() => f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: outside.bundle }), /隔离目录/);
  });
  await check('Missing bundle identifiers and invalid main executable metadata fail closed', async () => {
    const f = fixture(); delete f.metadata.CFBundleIdentifier;
    await assert.rejects(() => f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: f.bundle }), /CFBundleIdentifier/);
    f.metadata.CFBundleIdentifier = 'io.yunhui.fixture'; f.metadata.CFBundleExecutable = '../outside';
    await assert.rejects(() => f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: f.bundle }), /Info.plist/);
  });
  await check('Both executable and Info.plist changes invalidate a previously resolved target', async () => {
    const f = fixture(); const target = await f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: f.bundle });
    fs.appendFileSync(f.infoPlist, ' changed'); assert.equal(f.driver.validateTarget(target), false); await assert.rejects(() => f.driver.startDesktop(target), /已变化/); assert.equal(f.state.calls.length, 0);
    const fresh = await f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: f.bundle }); fs.appendFileSync(f.executable, '# changed\n'); assert.equal(f.driver.validateTarget(fresh), false);
  });
  await check('Process enumeration preserves UID, PID and launch identity without requiring a window', async () => {
    const f = fixture(); const target = await f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: f.bundle }); f.state.processes = [f.row(target)];
    const found = await f.driver.listProcesses(target); assert.equal(found.uncertain, false); assert.equal(found.processes.length, 1); assert.equal(found.processes[0].hasWindow, false);
    const payload = JSON.parse(f.state.calls[0].args.at(-1)); assert.equal(payload.ownerUid, 501); assert.equal(payload.ownerPid, 987700); assert.equal(payload.target.bundlePath, target.bundlePath);
    assert(!f.state.calls[0].args[3].includes(f.home), 'paths are data, not JavaScript source');
  });
  await check('Native force termination uses the exact no-window app and normalized aliases', async () => {
    const f = fixture(); const target = await f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: f.bundle });
    await f.driver.listProcesses(target); const source = f.state.calls[0].args[3];
    const original = { executable: '/private/var/fixture/Claude.app/Contents/MacOS/Claude', bundlePath: '/private/var/fixture/Claude.app', bundleId: 'io.yunhui.fixture.claude' };
    const aliases = new Map([[original.executable, '/var/fixture/Claude.app/Contents/MacOS/Claude'], [original.bundlePath, '/var/fixture/Claude.app']]);
    const url = value => ({ URLByResolvingSymlinksInPath: { path: aliases.get(value) ?? value } });
    let forcedQuits = 0, allowed = true, uid = 501, protectedPid = 0, present = true;
    const app = { processIdentifier: 1234, executableURL: url(original.executable), bundleURL: url(original.bundlePath), bundleIdentifier: original.bundleId, launchDate: { timeIntervalSince1970: 1234567.5 }, isTerminated: false,
      get terminate() { throw new Error('Restart must bypass ordinary quit and unsaved-work callbacks'); },
      get forceTerminate() { forcedQuits++; return allowed; } };
    const execute = (mode, overrides = {}) => JSON.parse(vm.runInNewContext(source + '\nprocessInfo = function () { return { uid: fixtureUid, parent: 1, started: "native-start" }; }; protectedIds = function () { var ids = {}; if (fixtureProtectedPid) ids[fixtureProtectedPid] = true; return ids; }; run(argv);', {
      ObjC: { import() {}, unwrap: value => value },
      $: { NSURL: { fileURLWithPath: url }, NSWorkspace: { sharedWorkspace: { runningApplications: { count: 1, objectAtIndex: () => app } } }, NSRunningApplication: { runningApplicationWithProcessIdentifier: () => present ? app : null } },
      fixtureUid: uid, fixtureProtectedPid: protectedPid,
      argv: [JSON.stringify({ mode, target: original, ownerUid: 501, ownerPid: 987700, ...overrides })],
    }));
    const listed = execute('list'); assert.equal(listed.uncertain, false); assert.equal(listed.processes.length, 1); assert.equal(listed.processes[0].executable, original.executable); assert.equal(listed.processes[0].bundlePath, original.bundlePath);
    assert.equal(listed.processes[0].hasWindow, false);
    assert.equal(execute('close', { process: listed.processes[0] }).result, 'requested'); assert.equal(forcedQuits, 1);
    assert.equal(execute('close', { process: { ...listed.processes[0], started: 'different-start' } }).result, 'changed'); assert.equal(forcedQuits, 1);
    uid = 502; assert.equal(execute('close', { process: listed.processes[0] }).result, 'changed'); assert.equal(forcedQuits, 1); uid = 501;
    protectedPid = 1234; assert.equal(execute('close', { process: listed.processes[0] }).result, 'changed'); assert.equal(forcedQuits, 1); protectedPid = 0;
    app.bundleIdentifier = 'io.yunhui.fixture.other'; assert.equal(execute('close', { process: listed.processes[0] }).result, 'changed'); assert.equal(forcedQuits, 1); app.bundleIdentifier = original.bundleId;
    allowed = false; assert.equal(execute('close', { process: listed.processes[0] }).result, 'blocked'); assert.equal(forcedQuits, 2); allowed = true;
    app.isTerminated = true; assert.equal(execute('close', { process: listed.processes[0] }).result, 'gone'); assert.equal(forcedQuits, 2); app.isTerminated = false;
    present = false; assert.equal(execute('close', { process: listed.processes[0] }).result, 'gone'); assert.equal(forcedQuits, 2); present = true;
    app.bundleURL = url('/var/different/Claude.app');
    assert.equal(execute('list').uncertain, true); assert.equal(execute('close', { process: listed.processes[0] }).result, 'changed'); assert.equal(forcedQuits, 2);
    aliases.set(original.executable, ''); assert.deepEqual(execute('list'), { processes: [], uncertain: true });
  });
  await check('Wrong-owner or incomplete native records are never treated as a trusted process', async () => {
    const f = fixture(); const target = await f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: f.bundle });
    for (const patch of [{ ownerSid: 'uid:502' }, { started: '' }, { bundlePath: '/Applications/Other.app' }, { bundleId: 'different.id' }, { pid: 0 }]) {
      f.state.processes = [{ ...f.row(target), ...patch }]; const result = await f.driver.listProcesses(target); assert.equal(result.uncertain, true); assert.equal(result.processes.length, 0);
    }
  });
  await check('Force termination carries the complete expected identity and protects own processes', async () => {
    const f = fixture(); const target = await f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: f.bundle }); const row = f.row(target);
    assert.equal(await f.driver.closeProcess(target, row), 'requested'); const payload = JSON.parse(f.state.calls[0].args.at(-1)); assert.equal(payload.process.started, row.started); assert.equal(payload.process.ownerSid, row.ownerSid); assert.equal(payload.target.bundleId, target.bundleId);
    for (const patch of [{ protected: true }, { pid: 987700 }, { ownerSid: 'uid:502' }, { executable: '/bin/sh' }]) assert.equal(await f.driver.closeProcess(target, { ...row, ...patch }), 'changed');
    assert.equal(f.state.calls.length, 1); f.state.closeResult = 'blocked'; assert.equal(await f.driver.closeProcess(target, row), 'blocked');
  });
  await check('LaunchServices opens the absolute bundle without a shell or client arguments', async () => {
    const f = fixture(); const target = await f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: f.bundle });
    await f.driver.startDesktop(target); assert.deepEqual(f.state.calls, [{ file: '/usr/bin/open', args: ['-n', '-a', target.bundlePath] }]);
  });
  await check('Terminal receives literal paths and the isolated native configuration directory', async () => {
    const f = fixture(); const command = path.join(f.home, 'codex'); fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const target = await f.driver.resolveTarget('codex-cli', { kind: 'cli', name: 'Codex', binaries: ['codex'] }, { installed: true, configured: false, command });
    await f.driver.openTerminal(target, f.home); const request = JSON.parse(f.state.calls[0].args.at(-1)); assert.equal(request.terminal, '/System/Applications/Utilities/Terminal.app'); assert.equal(request.command, api.macTerminalCommand(fs.realpathSync.native(command), f.home, { CODEX_HOME: path.join(f.home, '.codex') }));
    assert(request.command.includes("'\"'\"'")); assert(!request.command.includes('kill')); assert(!request.command.includes('--resume'));
    assert.equal(api.macTerminalCommand('/tmp/a;$(touch bad)/codex', '/tmp/a b'), "cd -- '/tmp/a b' && '/tmp/a;$(touch bad)/codex'");
    assert.throws(() => api.macTerminalCommand('/tmp/codex\nwhoami', f.home));
  });
  await check('Terminal pins custom and default config directories without exposing credentials or unrelated overrides', async () => {
    for (const [agentId, binary, key, folder] of [['codex-cli', 'codex', 'CODEX_HOME', '.codex'], ['claude-code', 'claude', 'CLAUDE_CONFIG_DIR', '.claude']]) {
      const f = fixture({ isolatedHome: () => undefined });
      const command = path.join(f.home, binary); fs.writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const target = await f.driver.resolveTarget(agentId, { kind: 'cli', name: binary, binaries: [binary] }, { installed: true, configured: false, command });
      const custom = path.join(f.home, "custom ' config; $(touch no) `id`");
      f.host.configurationEnvironment = () => ({ [key]: custom, OPENAI_API_KEY: 'fixture-secret-api-key', ANTHROPIC_AUTH_TOKEN: 'fixture-secret-auth', GEMINI_CLI_HOME: '/unrelated/gemini' });
      await f.driver.openTerminal(target, f.home);
      let request = JSON.parse(f.state.calls.at(-1).args.at(-1));
      assert.equal(request.command, api.macTerminalCommand(fs.realpathSync.native(command), f.home, { ...(agentId === 'claude-code' ? { HOME: f.home } : {}), [key]: custom }));
      assert(!request.command.includes('fixture-secret')); assert(!request.command.includes('GEMINI_CLI_HOME'));
      f.host.configurationEnvironment = () => ({}); await f.driver.openTerminal(target, f.home);
      request = JSON.parse(f.state.calls.at(-1).args.at(-1));
      assert.equal(request.command, api.macTerminalCommand(fs.realpathSync.native(command), f.home, agentId === 'claude-code' ? { HOME: f.home, CLAUDE_CONFIG_DIR: undefined } : { [key]: path.join(f.home, folder) }));
      if (agentId === 'claude-code') {
        for (const isolated of [undefined, f.home]) {
          f.host.isolatedHome = () => isolated; f.host.configurationEnvironment = () => ({ CLAUDE_CONFIG_DIR: isolated ? custom : path.join(f.home, '.claude') });
          await f.driver.openTerminal(target, f.home); const defaultRequest = JSON.parse(f.state.calls.at(-1).args.at(-1));
          assert.equal(defaultRequest.command, api.macTerminalCommand(fs.realpathSync.native(command), f.home, { HOME: f.home, CLAUDE_CONFIG_DIR: undefined }));
          const adapterEnvironment = { HOME: f.home, USERPROFILE: f.home, ...(isolated ? { AURORA_CLIENT_HOME: isolated, CLAUDE_CONFIG_DIR: custom } : { CLAUDE_CONFIG_DIR: path.join(f.home, '.claude') }) };
          const adapterPaths = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).getAdapter("claude-code").configPaths()))', output], { env: adapterEnvironment, encoding: 'utf8', windowsHide: true });
          assert.equal(adapterPaths.status, 0, adapterPaths.stderr);
          assert.deepEqual(JSON.parse(adapterPaths.stdout), [path.join(f.home, '.claude', 'settings.json'), path.join(f.home, '.claude.json')]);
        }
        f.host.isolatedHome = () => undefined;
        const customPaths = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1]).getAdapter("claude-code").configPaths()))', output], { env: { HOME: f.home, USERPROFILE: f.home, CLAUDE_CONFIG_DIR: custom }, encoding: 'utf8', windowsHide: true });
        assert.equal(customPaths.status, 0, customPaths.stderr);
        assert.deepEqual(JSON.parse(customPaths.stdout), [path.join(custom, 'settings.json'), path.join(custom, '.claude.json')]);
      }
      f.host.configurationEnvironment = () => ({ [key]: 'relative-private-path' }); const count = f.state.calls.length;
      await assert.rejects(() => f.driver.openTerminal(target, f.home), error => /配置目录无效/.test(error.message) && !error.message.includes('private'));
      assert.equal(f.state.calls.length, count);
    }
    assert.equal(api.macTerminalCommand('/tmp/codex', '/tmp/a b', { CODEX_HOME: "/tmp/config ' quoted;$(id)" }), "cd -- '/tmp/a b' && /usr/bin/env 'CODEX_HOME=/tmp/config '\"'\"' quoted;$(id)' '/tmp/codex'");
    for (const configuration of [{ OPENAI_API_KEY: '/must-not-export' }, { CODEX_HOME: '/tmp/line\nbreak' }, { CLAUDE_CONFIG_DIR: 'relative' }]) assert.throws(() => api.macTerminalCommand('/tmp/codex', '/tmp', configuration));
  });
  await check('Automation denial is explicit and never exposes native exception content', async () => {
    const f = fixture(); const command = path.join(f.home, 'codex'); fs.writeFileSync(command, '#!/bin/sh\n', { mode: 0o700 });
    const target = await f.driver.resolveTarget('codex-cli', { kind: 'cli', name: 'Codex', binaries: ['codex'] }, { installed: true, configured: false, command });
    f.state.failure = Object.assign(new Error('fixture-private-details'), { automationDenied: true });
    await assert.rejects(() => f.driver.openTerminal(target, f.home), error => /自动化/.test(error.message) && !error.message.includes('fixture-private'));
    f.state.failure = null; f.state.terminalResult = false; await assert.rejects(() => f.driver.openTerminal(target, f.home), /未确认/);
  });
  await check('The helper refuses its own application executable and invalid UID discovery', async () => {
    const f = fixture(); f.host.ownExecutable = () => f.executable;
    await assert.rejects(() => f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: f.bundle }), /云汇自身/);
    f.host.ownExecutable = () => process.execPath; const target = await f.driver.resolveTarget('claude-desktop', definition, { installed: true, configured: false, command: f.bundle }); f.host.uid = () => -1;
    await assert.rejects(() => f.driver.listProcesses(target), /用户身份/); assert.equal(f.state.calls.length, 0);
  });
  console.log(`macOS lifecycle simulation: ${checks} checks passed (native macOS not exercised)`);
} finally {
  if (path.dirname(fs.realpathSync.native(temporary)) === fs.realpathSync.native(os.tmpdir()) && path.basename(temporary).startsWith('yunhui-macos-lifecycle-')) fs.rmSync(temporary, { recursive: true, force: true });
}
