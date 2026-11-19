/** Native picker boundary with isolated files and injected dialog/disconnect; never launches a client. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-desktop-select-')));
const root = path.resolve(import.meta.dirname, '..'), originalHome = process.env.AURORA_CLIENT_HOME;
const original = { connection: { port: 9333, lastVersion: '1.0' }, entries: { fixture: { installed: true, enabled: false } }, settings: { fixturePreference: true } };
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
try {
  const bundle = path.join(scratch, 'api.cjs');
  await build({ stdin: { contents: "export * from './src/main/clientDesktopSelection.ts'; export * from './src/core/store/index.ts'; export * from './src/core/gateway/security.ts';", loader: 'ts', resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  let serial = 0;
  function fixture(platform = 'win32') {
    const folder = path.join(scratch, String(++serial)); fs.mkdirSync(folder);
    process.env.AURORA_CLIENT_HOME = folder;
    const store = new api.AuroraStore(path.join(folder, 'store')); store.writeExtra('extensions.json', original);
    const own = path.join(folder, 'yunhui.exe'), executable = path.join(folder, 'ChatGPT.exe');
    fs.writeFileSync(own, 'self'); fs.writeFileSync(executable, 'fixture program; never execute');
    const selected = platform === 'darwin' ? path.join(folder, 'ChatGPT.app') : executable;
    if (platform === 'darwin') fs.mkdirSync(selected);
    let calls = 0, disconnects = 0, options;
    const runtime = { platform, ownExecutable: own, choose: async request => { calls++; options = request; return { canceled: false, filePaths: [selected] }; },
      inspect: file => ({ installed: true, executable, exePath: file, supportsCodexConfig: true, productName: 'ChatGPT', version: '1.2', evidence: ['Fixture desktop resources'] }),
      disconnect: async () => { disconnects++; } };
    const snapshot = () => fs.readFileSync(path.join(store.dir, 'extensions.json'), 'utf8');
    return { folder, store, executable, selected, runtime, snapshot, calls: () => calls, disconnects: () => disconnects, options: () => options };
  }
  await check('renderer paths, process IDs and non-desktop clients are rejected before opening a dialog', async () => {
    const f = fixture(), before = f.snapshot();
    for (const payload of [null, [], { agentId: 'codex-cli' }, { agentId: 'chatgpt-desktop', path: f.executable }, { agentId: 'chatgpt-desktop', pid: 1 }])
      assert.equal((await api.selectClientDesktop(f.store, payload, f.runtime)).ok, false);
    assert.equal(f.calls(), 0); assert.equal(f.snapshot(), before); assert.equal(api.REMOTE_ACTIONS.has('agent.desktop.select'), false);
  });
  await check('cancel does not disconnect, persist or inspect anything', async () => {
    const f = fixture(), before = f.snapshot();
    f.runtime.choose = async () => ({ canceled: true, filePaths: [] });
    f.runtime.inspect = () => { throw new Error('must not inspect'); };
    assert.deepEqual(await api.selectClientDesktop(f.store, { agentId: 'chatgpt-desktop' }, f.runtime), { ok: false, canceled: true });
    assert.equal(f.disconnects(), 0); assert.equal(f.snapshot(), before);
  });
  await check('native selection stores one shared path, preserving plugin choices and requiring a later preview', async () => {
    const f = fixture();
    const result = await api.selectClientDesktop(f.store, { agentId: 'chatgpt-desktop' }, f.runtime);
    assert(result.ok); assert.equal(result.detected.command, f.executable); assert.equal(result.detected.supportsCodexConfig, true);
    const state = JSON.parse(f.snapshot()); assert.equal(state.connection.exePath, f.selected); assert.equal(state.connection.port, 9333); assert.equal(state.connection.lastVersion, undefined);
    assert.deepEqual(state.entries, original.entries); assert.deepEqual(state.settings, original.settings);
    assert.equal(f.disconnects(), 1); assert.equal(fs.existsSync(path.join(f.folder, '.codex', 'config.toml')), false);
    assert.deepEqual(f.options().filters[0].extensions, ['exe']);
    await api.selectClientDesktop(f.store, { agentId: 'chatgpt-desktop' }, f.runtime); assert.equal(f.disconnects(), 1);
  });
  await check('macOS picker accepts the .app bundle as a single file without selecting an internal helper', async () => {
    const f = fixture('darwin');
    assert((await api.selectClientDesktop(f.store, { agentId: 'codex-desktop' }, f.runtime)).ok);
    assert.deepEqual(f.options().properties, ['openFile']); assert.deepEqual(f.options().filters[0].extensions, ['app']);
    const before = f.snapshot(); f.runtime.choose = async () => ({ canceled: false, filePaths: [f.executable] });
    assert.equal((await api.selectClientDesktop(f.store, { agentId: 'chatgpt-desktop' }, f.runtime)).ok, false); assert.equal(f.snapshot(), before);
  });
  await check('own application, missing programs and inspection failures keep the original selection', async () => {
    for (const mode of ['self', 'missing', 'fault']) {
      const f = fixture(), before = f.snapshot();
      f.runtime.inspect = file => {
        if (mode === 'fault') throw new Error('PRIVATE-INTERNAL-FAULT');
        return { installed: mode !== 'missing', executable: mode === 'self' ? f.runtime.ownExecutable : f.executable, exePath: file, supportsCodexConfig: false, evidence: [] };
      };
      const result = await api.selectClientDesktop(f.store, { agentId: 'chatgpt-desktop' }, f.runtime);
      assert.equal(result.ok, false); assert(!JSON.stringify(result).includes('PRIVATE-INTERNAL-FAULT')); assert.equal(f.snapshot(), before); assert.equal(f.disconnects(), 0);
    }
  });
  await check('installed but unconfirmed capabilities are reported honestly without applying config', async () => {
    const f = fixture(); const inspect = f.runtime.inspect; f.runtime.inspect = file => ({ ...inspect(file), supportsCodexConfig: false, evidence: [] });
    const result = await api.selectClientDesktop(f.store, { agentId: 'chatgpt-desktop' }, f.runtime);
    assert.equal(result.ok, true); assert.equal(result.detected.supportsCodexConfig, false); assert.match(result.message, /未应用/);
    assert.equal(fs.existsSync(path.join(f.folder, '.codex', 'config.toml')), false);
  });
  await check('failed persistence preserves stored choices and does not claim success', async () => {
    const f = fixture(), before = f.snapshot(); f.store.writeExtra = () => { throw new Error('PRIVATE-WRITE-FAULT'); };
    const result = await api.selectClientDesktop(f.store, { agentId: 'chatgpt-desktop' }, f.runtime);
    assert.equal(result.ok, false); assert(!JSON.stringify(result).includes('PRIVATE-WRITE-FAULT')); assert.equal(f.snapshot(), before);
  });
  await check('parallel selection cannot open a second picker or interleave extension writes', async () => {
    const f = fixture(); let release; f.runtime.choose = () => new Promise(resolve => { release = resolve; });
    const first = api.selectClientDesktop(f.store, { agentId: 'chatgpt-desktop' }, f.runtime);
    await assert.rejects(api.selectClientDesktop(f.store, { agentId: 'chatgpt-desktop' }, f.runtime), /另一个扩展操作/);
    release({ canceled: true, filePaths: [] }); assert.equal((await first).canceled, true);
  });
  console.log(`Desktop selection: ${passed} checks passed.`);
} finally {
  if (originalHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = originalHome;
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir())); assert(path.basename(scratch).startsWith('yunhui-desktop-select-'));
  fs.rmSync(scratch, { recursive: true, force: true });
}
