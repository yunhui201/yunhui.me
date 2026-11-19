import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// Exercise Windows package layouts on private files; no installed application is launched.
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-claude-paths-')));
const priorHome = process.env.AURORA_CLIENT_HOME;
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
let checks = 0, sequence = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
try {
  const output = path.join(temporary, 'paths.cjs');
  await build({ stdin: { contents: "export * from './src/core/claudeDesktopPaths.ts'; export { getAdapter } from './src/core/agents/adapters.ts'; export { syncLocalClients } from './src/core/localClients.ts'; export { AuroraStore } from './src/core/store/index.ts';", resolveDir: process.cwd(), loader: 'ts' }, outfile: output, bundle: true, platform: 'node', format: 'cjs', define: { 'process.platform': '"win32"' }, logLevel: 'silent' });
  const api = createRequire(import.meta.url)(output);
  const adapter = api.getAdapter('claude-desktop');
  const provider = { id: 'private-fixture', name: 'Fixture', format: 'anthropic', baseUrl: 'https://fixture.invalid', enabled: true, apiKeys: [{ id: 'key', key: 'sk-private-fixture-key', enabled: true }], models: [{ id: 'claude-sonnet-fixture' }] };
  const context = { provider, model: provider.models[0].id, gatewayUrl: 'http://127.0.0.1:3425', token: 'private-gateway-token', mode: 'gateway' };
  const fixture = () => {
    const home = path.join(temporary, `home-${++sequence}`); fs.mkdirSync(home); process.env.AURORA_CLIENT_HOME = home;
    const base = path.join(home, 'AppData', 'Local'), pkg = path.join(base, 'Packages', 'Claude_pzs8sxrjxfjjc');
    return { home, base, pkg, msix: path.join(pkg, 'LocalCache', 'Local'), options: { home, platform: 'win32', isolated: true, environment: {} } };
  };
  const profile = (root, name = 'third-party') => path.join(root, 'Claude-3p', 'configLibrary', `${name}.json`);
  const profileValue = { inferenceProvider: 'gateway', inferenceGatewayAuthScheme: 'bearer', inferenceGatewayBaseUrl: 'https://provider.invalid', inferenceGatewayApiKey: 'sk-import-fixture-key', inferenceModels: [{ name: 'model-fixture' }] };

  check('A fresh isolated profile resolves the standard root without creating directories', () => {
    const f = fixture(); const found = api.resolveClaudeDesktopConfig({ ...f.options, environment: { LOCALAPPDATA: path.join(temporary, 'foreign') } });
    assert.equal(found.status, 'resolved'); assert.equal(found.source, 'standard'); assert.equal(found.root, f.base); assert(!fs.existsSync(f.base));
  });
  check('An existing Store package selects its own LocalCache even before first 3P setup', () => {
    const f = fixture(); fs.mkdirSync(f.pkg, { recursive: true }); const found = api.resolveClaudeDesktopConfig(f.options);
    assert.equal(found.root, f.msix); assert.equal(found.source, 'msix'); assert(!fs.existsSync(f.msix)); assert.equal(adapter.configPaths()[0], api.claudeDesktopConfigFiles(f.msix)[0]);
  });
  check('Unrelated package names and a standard installation do not select a Store root', () => {
    const f = fixture(); fs.mkdirSync(path.join(f.base, 'Packages', 'OtherClaude_pzs8sxrjxfjjc'), { recursive: true }); write(profile(f.base), profileValue);
    const found = api.resolveClaudeDesktopConfig(f.options); assert.equal(found.root, f.base); assert.equal(found.candidates.length, 1);
  });
  check('Normal and Store profiles together report ambiguity and never preview or write a guessed root', () => {
    const f = fixture(); write(profile(f.base), profileValue); write(profile(f.msix), { ...profileValue, inferenceGatewayApiKey: 'sk-other-fixture-key' });
    const before = fs.readFileSync(profile(f.base)), other = fs.readFileSync(profile(f.msix));
    const found = api.resolveClaudeDesktopConfig(f.options); assert.equal(found.status, 'ambiguous'); assert.equal(found.root, undefined); assert.deepEqual(adapter.configPaths(), []); assert.match(adapter.detect().detectionError, /多个/);
    assert.equal(adapter.preview(context).ok, false); assert.equal(adapter.connect(context).ok, false);
    assert.deepEqual(fs.readFileSync(profile(f.base)), before); assert.deepEqual(fs.readFileSync(profile(f.msix)), other); assert(!fs.existsSync(path.join(f.base, 'Claude')));
  });
  check('Multiple Store package identities require a clear target instead of newest-directory guessing', () => {
    const f = fixture(); fs.mkdirSync(f.pkg, { recursive: true }); fs.mkdirSync(path.join(f.base, 'Packages', 'Claude_abcdefghijklm'), { recursive: true });
    assert.equal(api.resolveClaudeDesktopConfig(f.options).status, 'ambiguous'); assert.equal(adapter.connect(context).ok, false);
  });
  check('Preview and application use only the Store root and preserve unrelated profiles', () => {
    const f = fixture(); write(profile(f.msix), profileValue); const files = api.claudeDesktopConfigFiles(f.msix);
    write(files[0], { userPreference: true }); write(files[2], { entries: [{ id: 'third-party', name: 'Existing' }], appliedId: 'third-party' });
    const originals = files.map(file => fs.existsSync(file) ? fs.readFileSync(file) : null), untouched = fs.readFileSync(profile(f.msix));
    const preview = adapter.preview(context); assert.equal(preview.ok, true, preview.message); assert.equal(preview.files.length, 4); assert(preview.files.every(file => file.path.startsWith(f.msix))); assert(!JSON.stringify(preview).includes(context.token));
    const applied = adapter.connect({ ...context, expectedRevision: preview.revision }); assert.equal(applied.ok, true, applied.message); assert.equal(applied.path, files[0]); assert(!fs.existsSync(path.join(f.base, 'Claude')));
    assert.equal(JSON.parse(fs.readFileSync(files[3])).inferenceGatewayApiKey, context.token); assert.deepEqual(fs.readFileSync(profile(f.msix)), untouched);
    const restored = adapter.disconnect(applied.backup); assert.equal(restored.ok, true, restored.message);
    files.forEach((file, i) => originals[i] ? assert.deepEqual(fs.readFileSync(file), originals[i]) : assert(!fs.existsSync(file)));
  });
  check('An install appearing after preview invalidates application without modifying either root', () => {
    const f = fixture(); write(profile(f.base), profileValue); const preview = adapter.preview(context); assert(preview.ok); fs.mkdirSync(f.pkg, { recursive: true });
    const applied = adapter.connect({ ...context, expectedRevision: preview.revision }); assert.equal(applied.ok, false); assert(!fs.existsSync(api.claudeDesktopConfigFiles(f.base)[0])); assert(!fs.existsSync(f.msix));
  });
  check('Read-only configuration checks detect gateway port and token drift without changing files', () => {
    const f = fixture(); fs.mkdirSync(f.pkg, { recursive: true }); const applied = adapter.connect(context); assert(applied.ok, applied.message);
    const files = adapter.configPaths(), before = files.map(file => fs.readFileSync(file));
    assert.equal(adapter.matchesConfiguration(context), true);
    assert.equal(adapter.matchesConfiguration({ ...context, gatewayUrl: 'http://127.0.0.1:3999' }), false);
    assert.equal(adapter.matchesConfiguration({ ...context, token: 'rotated-private-fixture-token' }), false);
    assert.equal(api.getAdapter('workbuddy').matchesConfiguration, undefined);
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
  });
  check('Undo uses the original root when a second installation makes discovery ambiguous', () => {
    const f = fixture(); write(profile(f.base), profileValue); const applied = adapter.connect(context); assert(applied.ok, applied.message);
    write(profile(f.msix), { ...profileValue, name: 'other-installation' }); const other = fs.readFileSync(profile(f.msix));
    assert.equal(api.resolveClaudeDesktopConfig(f.options).status, 'ambiguous'); assert.deepEqual(adapter.restorePaths(applied.backup), api.claudeDesktopConfigFiles(f.base));
    const restored = adapter.disconnect(applied.backup); assert(restored.ok, restored.message); assert.deepEqual(fs.readFileSync(profile(f.msix)), other); assert(!fs.existsSync(api.claudeDesktopConfigFiles(f.base)[3]));
  });
  check('Undo refuses external backup roots and retains external edits to managed configuration', () => {
    const f = fixture(); fs.mkdirSync(f.pkg, { recursive: true }); const applied = adapter.connect(context); assert(applied.ok);
    assert.throws(() => api.claudeDesktopRestorePaths(path.join(temporary, '.aurora-backups', 'forged.json'), f.options), /不属于/);
    const target = api.claudeDesktopConfigFiles(f.msix)[0]; write(target, { editedAfterConnection: true }); assert.equal(adapter.disconnect(applied.backup).ok, false); assert.equal(JSON.parse(fs.readFileSync(target)).editedAfterConnection, true);
  });
  check('Local discovery imports Store profiles but never imports the managed gateway profile', () => {
    const f = fixture(); write(profile(f.msix), profileValue); write(profile(f.msix, api.CLAUDE_DESKTOP_PROFILE), profileValue);
    const store = new api.AuroraStore(path.join(f.home, 'store')); const result = api.syncLocalClients(store, { home: f.home, platform: 'win32', force: true });
    assert.equal(result.added, 1); assert.equal(store.listProviders()[0].apiKeys[0].key, profileValue.inferenceGatewayApiKey); assert(result.sources.some(source => source.status === 'ignored')); assert(result.sources.every(source => source.path.startsWith(f.msix)));
    write(profile(f.base), { ...profileValue, inferenceGatewayApiKey: 'sk-do-not-import-fixture' }); const ambiguous = api.syncLocalClients(store, { home: f.home, platform: 'win32', force: true }); assert.equal(ambiguous.added, 0); assert(ambiguous.warnings.some(warning => warning.includes('多个'))); assert.equal(store.listProviders().length, 1);
  });
  check('Linked package roots cannot escape the private profile or read a foreign credential', () => {
    const f = fixture(), outside = path.join(temporary, 'linked-target'); write(profile(path.join(outside, 'LocalCache', 'Local')), profileValue);
    fs.mkdirSync(path.dirname(f.pkg), { recursive: true }); fs.symlinkSync(outside, f.pkg, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(api.resolveClaudeDesktopConfig(f.options).status, 'blocked'); assert.equal(adapter.connect(context).ok, false);
    const store = new api.AuroraStore(path.join(f.home, 'store')); const result = api.syncLocalClients(store, { home: f.home, platform: 'win32', force: true }); assert.equal(result.added, 0); assert(result.warnings.length);
  });
  check('A linked nested config directory and a non-directory Packages path fail closed', () => {
    const f = fixture(), outside = path.join(temporary, 'nested-target'); fs.mkdirSync(outside); fs.mkdirSync(f.base, { recursive: true }); fs.symlinkSync(outside, path.join(f.base, 'Claude-3p'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(api.resolveClaudeDesktopConfig(f.options).status, 'blocked');
    const g = fixture(); write(path.join(g.base, 'Packages'), 'not a directory'); assert.equal(api.resolveClaudeDesktopConfig(g.options).status, 'blocked');
  });
  check('macOS and Linux resolve native directories without adopting Windows package data', () => {
    const f = fixture(); write(profile(f.msix), profileValue);
    const mac = api.resolveClaudeDesktopConfig({ ...f.options, platform: 'darwin' }); assert.equal(mac.root, path.join(f.home, 'Library', 'Application Support')); assert.equal(mac.candidates.length, 1);
    const linux = api.resolveClaudeDesktopConfig({ ...f.options, platform: 'linux' }); assert.equal(linux.root, path.join(f.home, '.config'));
    const xdg = path.join(f.home, 'custom-config'); const overridden = api.resolveClaudeDesktopConfig({ ...f.options, isolated: false, platform: 'linux', environment: { XDG_CONFIG_HOME: xdg } }); assert.equal(overridden.root, xdg);
    assert.equal(api.resolveClaudeDesktopConfig({ ...f.options, isolated: false, environment: { LOCALAPPDATA: 'relative-config' } }).status, 'blocked');
  });
  console.log(`Claude Desktop configuration roots: ${checks} checks passed (private filesystem fixtures; no application launched)`);
} finally {
  if (priorHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = priorHome;
  if (path.dirname(temporary) === fs.realpathSync(os.tmpdir()) && path.basename(temporary).startsWith('yunhui-claude-paths-')) fs.rmSync(temporary, { recursive: true, force: true });
}
