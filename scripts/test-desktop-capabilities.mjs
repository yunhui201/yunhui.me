/** Static desktop resources only. Fixture executables and scripts are never launched. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-desktop-capabilities-')));
const priorHome = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = temporary;
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const strong = 'const home=process.env.CODEX_HOME; const method="thread/start"; const field="model_provider";';
let passed = 0;

function archive(file, files, mutate = () => {}) {
  const tree = { files: {} }, bodies = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const segments = name.split('/'); let node = tree;
    for (const segment of segments.slice(0, -1)) node = node.files[segment] ||= { files: {} };
    const entry = typeof content === 'string' || Buffer.isBuffer(content) ? { data: Buffer.from(content) } : content;
    node.files[segments.at(-1)] = entry.link ? { link: entry.link } : { size: entry.data.length, ...(entry.unpacked ? { unpacked: true } : { offset: String(offset) }) };
    if (!entry.link && !entry.unpacked) { bodies.push(entry.data); offset += entry.data.length; }
    if (entry.unpacked) write(path.join(file + '.unpacked', ...segments), entry.data);
  }
  mutate(tree);
  const json = Buffer.from(JSON.stringify(tree)), padding = (4 - json.length % 4) % 4;
  const headerSize = 8 + json.length + padding;
  const prefix = Buffer.alloc(16); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(headerSize, 4); prefix.writeUInt32LE(headerSize - 4, 8); prefix.writeUInt32LE(json.length, 12);
  write(file, Buffer.concat([prefix, json, Buffer.alloc(padding), ...bodies]));
}
function installation(label, name = 'ChatGPT.exe') {
  const exe = path.join(temporary, label, name), resources = path.join(path.dirname(exe), 'resources');
  write(exe, 'NEVER EXECUTE THIS PRIVATE FIXTURE'); fs.mkdirSync(resources, { recursive: true });
  return { exe, resources, asar: path.join(resources, 'app.asar') };
}
// Cache and adapter entrypoints use the actual host platform, without test options.
// Supply a real private bundle on macOS so its native plist and permission checks run.
function hostInstallation(label, create = true) {
  const bundle = process.platform === 'darwin' ? path.join(temporary, label, 'ChatGPT.app') : undefined;
  const exe = bundle ? path.join(bundle, 'Contents', 'MacOS', 'Private Main') : path.join(temporary, label, 'ChatGPT.exe');
  const resources = bundle ? path.join(bundle, 'Contents', 'Resources') : path.join(path.dirname(exe), 'resources');
  if (create) {
    write(exe, 'NEVER EXECUTE THIS PRIVATE FIXTURE'); fs.mkdirSync(resources, { recursive: true });
    if (bundle) {
      write(path.join(bundle, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Private Main</string><key>CFBundleName</key><string>ChatGPT</string><key>CFBundleIdentifier</key><string>io.aurora.private.capabilities-fixture</string></dict></plist>');
      fs.chmodSync(exe, 0o700);
    }
  }
  return { exe, resources, asar: path.join(resources, 'app.asar') };
}
function desktopArchive(app, main = 'require("electron");', rest = {}) {
  archive(app.asar, { 'package.json': JSON.stringify({ name: 'private-desktop-fixture', main: '.vite/build/main-abc123.js' }), '.vite/build/main-abc123.js': main, ...rest });
}

try {
  const bundle = path.join(temporary, 'api.cjs');
  await build({ stdin: { contents: "export * from './src/core/desktopDetection.ts'; export {configureDesktopPath, detectReset, getAdapter} from './src/core/agents/adapters.ts'; export {desktopDebugLaunch, DesktopCdp} from './src/core/injector.ts';", resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  const inspect = app => api.inspectCodingDesktop(app.exe, { platform: 'win32', isolatedHome: temporary });
  const test = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };

  test('ASAR hashed main and referenced local chunks prove capabilities from actual code', () => {
    const app = installation('hashed'); desktopArchive(app, 'require("electron");require("./chunks/d7f19");', { '.vite/build/chunks/d7f19.js': strong });
    const found = inspect(app); assert.equal(found.installed, true); assert.equal(found.supportsCodexConfig, true);
    assert(found.evidence.some(item => item.includes('桌面入口')));
  });
  test('unpacked ASAR entrypoints and ordinary unpacked Electron app layouts are inspected', () => {
    const asar = installation('unpacked-entry'); archive(asar.asar, { 'package.json': '{"main":"main.cjs"}', 'main.cjs': { unpacked: true, data: Buffer.from(strong) } });
    assert.equal(inspect(asar).supportsCodexConfig, true);
    const app = installation('unpacked-app'); write(path.join(app.resources, 'app', 'package.json'), '{"main":"index.js"}');
    write(path.join(app.resources, 'app', 'index.js'), strong); assert.equal(inspect(app).supportsCodexConfig, true);
  });
  test('trusted nested helper locations require a desktop runtime beside them', () => {
    for (const folder of ['bin', 'cli', 'app.asar.unpacked/bin']) {
      const app = installation('nested-' + folder.replaceAll('/', '-')); write(path.join(app.resources, folder, 'codex.exe'), 'private helper fixture');
      assert.equal(inspect(app).supportsCodexConfig, false); desktopArchive(app); assert.equal(inspect(app).supportsCodexConfig, true);
    }
  });
  test('Codex CLI executable names and product names alone never imply a desktop runtime', () => {
    const cli = installation('cli-cache', 'Codex.exe'); assert.equal(inspect(cli).supportsCodexConfig, false);
    write(path.join(cli.resources, 'codex.exe'), 'CLI child'); assert.equal(inspect(cli).supportsCodexConfig, false);
    const plain = installation('plain-chat'); desktopArchive(plain); assert.equal(inspect(plain).supportsCodexConfig, false);
  });
  test('unreferenced assets, misleading filenames and single generic markers cannot grant capability', () => {
    const app = installation('unrelated'); desktopArchive(app, 'require("electron");', { 'docs/codex-client.md': strong, 'unused/app-server-client.js': strong });
    assert.equal(inspect(app).supportsCodexConfig, false);
    for (const [label, code] of [['generic', 'const name="codex";'], ['protocol', 'const method="thread/start";'], ['config', 'const home=process.env.CODEX_HOME;']]) {
      const partial = installation(label); desktopArchive(partial, code); assert.equal(inspect(partial).supportsCodexConfig, false);
    }
  });
  test('malformed and truncated archives, bad offsets and archive links cannot grant capability', () => {
    const broken = installation('broken'); const bytes = Buffer.alloc(80); bytes.writeUInt32LE(40, 12); bytes.write('codex-client app-server-client', 16); write(broken.asar, bytes);
    assert.equal(inspect(broken).supportsCodexConfig, false);
    const truncated = installation('truncated'); desktopArchive(truncated, strong); fs.truncateSync(truncated.asar, fs.statSync(truncated.asar).size - 5); assert.equal(inspect(truncated).supportsCodexConfig, false);
    const offset = installation('offset'); archive(offset.asar, { 'package.json': '{"main":"main.js"}', 'main.js': strong }, tree => { tree.files['main.js'].offset = '9007199254740991'; });
    assert.equal(inspect(offset).supportsCodexConfig, false);
    const link = installation('link-entry'); archive(link.asar, { 'package.json': '{"main":"main.js"}', 'main.js': { link: '../outside.js' } }); assert.equal(inspect(link).supportsCodexConfig, false);
  });
  test('native helper and unpacked app directory links cannot escape the resource boundary', () => {
    const outside = path.join(temporary, 'outside'); write(path.join(outside, 'codex.exe'), 'outside CLI'); write(path.join(outside, 'package.json'), '{"main":"index.js"}'); write(path.join(outside, 'index.js'), strong);
    const helper = installation('escaped-helper'); desktopArchive(helper); fs.symlinkSync(outside, path.join(helper.resources, 'bin'), process.platform === 'win32' ? 'junction' : 'dir'); assert.equal(inspect(helper).supportsCodexConfig, false);
    const unpacked = installation('escaped-app'); fs.symlinkSync(outside, path.join(unpacked.resources, 'app'), process.platform === 'win32' ? 'junction' : 'dir'); assert.equal(inspect(unpacked).supportsCodexConfig, false);
    const escapedRoot = installation('escaped-resources'); fs.rmdirSync(escapedRoot.resources); fs.symlinkSync(outside, escapedRoot.resources, process.platform === 'win32' ? 'junction' : 'dir'); assert.equal(inspect(escapedRoot).supportsCodexConfig, false);
  });
  test('oversized resources remain bounded and produce an installed but unconfirmed result', () => {
    const app = installation('large-entry'); desktopArchive(app, Buffer.alloc(8 * 1024 * 1024 + 1, 'a'));
    const found = inspect(app); assert.equal(found.installed, true); assert.equal(found.supportsCodexConfig, false);
    const header = installation('large-header'), bytes = Buffer.alloc(16); bytes.writeUInt32LE(4, 0); bytes.writeUInt32LE(40 * 1024 * 1024, 4); write(header.asar, bytes);
    assert.equal(inspect(header).supportsCodexConfig, false);
  });
  test('macOS bundles share structured resource inspection and retain main-executable validation', () => {
    const app = path.join(temporary, 'mac', 'ChatGPT.app'), main = path.join(app, 'Contents', 'MacOS', 'Private Main'), resources = path.join(app, 'Contents', 'Resources');
    write(main, 'private executable'); write(path.join(app, 'Contents', 'Info.plist'), JSON.stringify({ CFBundleExecutable: 'Private Main', CFBundleName: 'Codex' }));
    const options = { platform: 'darwin', isolatedHome: temporary, readPlist: file => JSON.parse(readFile(file)), canExecute: () => true };
    function readFile(file) { return fs.readFileSync(file, 'utf8'); }
    assert.equal(api.inspectCodingDesktop(app, options).supportsCodexConfig, false);
    archive(path.join(resources, 'app.asar'), { 'package.json': '{"main":"entry.mjs"}', 'entry.mjs': strong });
    assert.equal(api.inspectCodingDesktop(app, options).supportsCodexConfig, true);
    const helper = path.join(app, 'Contents', 'MacOS', 'Helper'); write(helper, 'private helper');
    assert.throws(() => api.inspectCodingDesktop(helper, options), /辅助进程/);
  });
  test('short caches cover unconfirmed and confirmed capabilities and explicit refresh clears both', () => {
    const app = hostInstallation('cache'); api.clearDesktopDetectionCache();
    const pending = api.detectCodingDesktop(app.exe); assert.equal(pending.installed, true); assert.equal(pending.supportsCodexConfig, false); desktopArchive(app, strong);
    assert.equal(api.detectCodingDesktop(app.exe), pending); api.detectReset();
    assert.equal(api.detectCodingDesktop(app.exe).supportsCodexConfig, true);
    desktopArchive(app, 'require("electron");'); assert.equal(api.detectCodingDesktop(app.exe).supportsCodexConfig, true); api.detectReset();
    assert.equal(api.detectCodingDesktop(app.exe).supportsCodexConfig, false);
    const absent = hostInstallation('cache-absent', false).exe, missing = api.detectCodingDesktop(absent);
    assert.equal(missing.installed, false); hostInstallation('cache-absent');
    assert.equal(api.detectCodingDesktop(absent), missing); api.detectReset(); assert.equal(api.detectCodingDesktop(absent).installed, true);
  });
  test('shared configuration preview and backup work without confirmed desktop capability', () => {
    const adapter = api.getAdapter('chatgpt-desktop'), absent = hostInstallation('absent', false).exe;
    const context = { provider: { id: 'test', name: 'Fixture', enabled: true, format: 'openai-responses', baseUrl: 'https://example.com/v1', models: [{ id: 'model-one' }], apiKeys: [{ enabled: true, key: 'private-fixture-key' }] }, model: 'model-one', mode: 'direct', gatewayUrl: 'http://127.0.0.1:3425' };
    const file = adapter.configPaths()[0], auth = path.join(path.dirname(file), 'auth.json'), original = '# private fixture\nmodel="old"\n';
    write(file, original); write(auth, '{"fixture":"keep"}');
    api.configureDesktopPath(absent); const missing = adapter.preview(context); assert.equal(missing.ok, true, missing.message);
    assert(missing.warnings.some(item => /尚未确认桌面程序位置/.test(item) && /可以继续保存共享编程配置/.test(item)));
    assert.equal(fs.readFileSync(file, 'utf8'), original); assert.equal(missing.files[0].path, file);
    assert.throws(() => api.desktopDebugLaunch(api.detectCodingDesktop(absent), 9222), /未找到桌面程序/);
    const saved = adapter.connect({ ...context, expectedRevision: missing.revision }); assert.equal(saved.ok, true, saved.message);
    assert.match(saved.message, /共享编程配置已保存并备份/); assert.match(saved.message, /桌面版本尚未完成实际请求验证/); assert(saved.backup);
    assert.equal(fs.readFileSync(auth, 'utf8'), '{"fixture":"keep"}'); assert.equal(adapter.disconnect(saved.backup).ok, true); assert.equal(fs.readFileSync(file, 'utf8'), original);
    const plain = hostInstallation('preview-plain'); desktopArchive(plain); api.configureDesktopPath(plain.exe);
    const unsupported = adapter.preview(context); assert.equal(unsupported.ok, true, unsupported.message);
    assert(unsupported.warnings.some(item => /已找到桌面程序/.test(item) && /尚未确认它是否读取 Codex 配置/.test(item)));
    assert.equal(api.detectCodingDesktop(plain.exe).supportsCodexConfig, false);
    assert.equal(adapter.preview({ ...context, model: 'missing-model' }).ok, false);
    api.configureDesktopPath(undefined);
  });
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => [{ type: 'page', url: 'https://chatgpt.com', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/fixture' }] });
    await assert.rejects(api.DesktopCdp.connect(9222), /未找到兼容的 ChatGPT\/Codex 桌面页面/);
    passed++; console.log('PASS saving shared configuration does not permit injection into an unrelated chat page');
  } finally { globalThis.fetch = originalFetch; }
  test('real Electron reads external ASAR bytes without virtual filesystem interception or launching the client', () => {
    const app = installation('electron-runtime'); desktopArchive(app, strong);
    const script = path.join(temporary, 'electron-review.cjs'), output = path.join(temporary, 'electron-result.json');
    write(script, `const {app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temporary, 'electron-profile'))});const api=require(${JSON.stringify(bundle)});const fs=require('original-fs');try{const value=api.inspectCodingDesktop(${JSON.stringify(app.exe)},{platform:'win32',isolatedHome:${JSON.stringify(temporary)}});fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({installed:value.installed,supportsCodexConfig:value.supportsCodexConfig,evidence:value.evidence}));app.exit(0);}catch(error){fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({error:String(error.message)}));app.exit(1);}`);
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
    execFileSync(createRequire(import.meta.url)('electron'), [script], { env: environment, windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(fs.readFileSync(output, 'utf8')); assert.equal(result.installed, true); assert.equal(result.supportsCodexConfig, true, JSON.stringify(result));
  });
  console.log(`Desktop capabilities: ${passed} tests passed; no fixture program was executed`);
} finally {
  if (priorHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = priorHome;
  const relative = path.relative(fs.realpathSync(os.tmpdir()), temporary);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  fs.rmSync(temporary, { recursive: true, force: true });
}
