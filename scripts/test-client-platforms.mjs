import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-client-platforms-')));
const bundle = path.join(scratch, 'platforms.cjs');
await build({ stdin: { contents: `export * from './src/core/clientPaths.ts'; export { getAdapter, exportEnvScript } from './src/core/agents/adapters.ts';`, resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const api = createRequire(import.meta.url)(bundle);
let passed = 0;
const check = (label, fn) => { fn(); passed++; console.log(`PASS ${label}`); };
const original = Object.fromEntries(['AURORA_CLIENT_HOME', 'PATH', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'LOCALAPPDATA', 'APPDATA'].map(key => [key, process.env[key]]));
const write = file => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); };

try {
  for (const platform of ['win32', 'darwin']) {
    const windows = platform === 'win32', p = windows ? path.win32 : path.posix;
    const home = windows ? 'C:\\Users\\云汇 用户' : '/Users/云汇 用户';
    const custom = windows ? 'D:\\工具目录' : '/custom tools/bin';
    const ctx = { platform, home, environment: { PATH: custom } };
    check(`${platform}: explicit PATH keeps priority and uses native extensions`, () => {
      const candidates = api.cliCandidates('codex', ctx);
      assert.equal(candidates[0], p.join(custom, 'codex'));
      assert.equal(candidates.includes(p.join(custom, 'codex.cmd')), windows);
      assert.equal(candidates.includes('/opt/homebrew/bin/codex'), !windows);
      assert.equal(candidates.includes('/usr/local/bin/codex'), !windows);
    });
    check(`${platform}: desktop discovery includes both Tencent names with native paths`, () => {
      const candidates = api.desktopCandidates(['WorkBuddy', 'CodeBuddy'], ctx);
      assert(candidates.includes(windows ? p.join(home, 'AppData', 'Local', 'Programs', 'CodeBuddy', 'CodeBuddy.exe') : '/Applications/CodeBuddy.app'));
      assert(candidates.includes(windows ? p.join(home, 'AppData', 'Local', 'Programs', 'WorkBuddy', 'WorkBuddy.exe') : '/Applications/WorkBuddy.app'));
      assert(candidates.every(value => windows ? !value.endsWith('.app') : value.endsWith('.app')));
    });
    check(`${platform}: isolated home avoids ambient application/config roots`, () => {
      const candidates = api.desktopCandidates(['Claude'], { ...ctx, isolated: true, environment: { ...ctx.environment, LOCALAPPDATA: 'Q:\\foreign-local', APPDATA: 'Q:\\foreign-roaming' } });
      assert(candidates.every(value => value.startsWith(home)));
      assert(!api.cliCandidates('codex', { ...ctx, isolated: true }).includes('/opt/homebrew/bin/codex'));
    });
  }
  check('Finder PATH fallback includes native, Homebrew and configured npm/nvm installations', () => {
    const candidates = api.cliCandidates('claude', { platform: 'darwin', home: '/Users/a', environment: { PATH: '/usr/bin:/bin', npm_config_prefix: '/Users/a/npm custom', HOMEBREW_PREFIX: '/opt/custom-brew', NVM_BIN: '/Users/a/.nvm/versions/node/v22.0.0/bin' } });
    for (const prefix of ['/Users/a/.local/bin', '/Users/a/.npm-global/bin', '/Users/a/.volta/bin', '/opt/homebrew/bin', '/usr/local/bin', '/Users/a/npm custom/bin', '/opt/custom-brew/bin', '/Users/a/.nvm/versions/node/v22.0.0/bin']) assert(candidates.includes(`${prefix}/claude`));
    assert(candidates.indexOf('/usr/bin/claude') < candidates.indexOf('/opt/homebrew/bin/claude'));
  });
  check('Windows worker environment preserves case-insensitive path and application-root lookup', () => {
    const ctx = { platform: 'win32', home: 'C:\\Users\\fixture', environment: { Path: 'D:\\Tools', LocalAppData: 'E:\\Local', AppData: 'E:\\Roaming' } };
    assert(api.cliCandidates('gemini', ctx).includes('D:\\Tools\\gemini.cmd'));
    const candidates = api.desktopCandidates(['Claude'], ctx);
    assert(candidates.includes('E:\\Local\\Programs\\Claude\\Claude.exe'));
    assert(candidates.includes('E:\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Claude.lnk'));
    assert(!api.cliCandidates('gemini', { ...ctx, platform: 'darwin', home: '/Users/fixture', isolated: true, environment: { Path: '/mixed-case' } }).includes('/mixed-case/gemini'));
  });
  check('PATH ignores empty/relative entries and deduplicates Windows directories case-insensitively', () => {
    assert.deepEqual(api.cliCandidates('codex', { platform: 'win32', home: 'C:\\Users\\a', environment: { PATH: ';.;relative;"C:\\Tools";c:\\tools;' } }), ['C:\\Tools\\codex', 'C:\\Tools\\codex.exe', 'C:\\Tools\\codex.cmd', 'C:\\Tools\\codex.bat']);
    const candidates = api.cliCandidates('codex', { platform: 'darwin', home: '/Users/a', isolated: true, environment: { PATH: ':.:relative:/custom/bin:/custom/bin:' } });
    assert.equal(candidates.filter(value => value === '/custom/bin/codex').length, 1);
    assert(candidates.every(value => value.startsWith('/')));
  });
  check('session project labels handle Windows, UNC and POSIX history on either host', () => {
    for (const cwd of ['C:\\work\\中文项目\\', 'C:/work/中文项目/', '\\\\server\\share\\中文项目\\', '/Users/a/中文项目/']) assert.equal(api.sessionProjectName(cwd), '中文项目');
    assert.equal(api.sessionProjectName('/Users/a/project\\with-backslash'), 'project\\with-backslash');
  });

  const secret = "sk-fixture'$(echo SHOULD_NOT_EXECUTE);`literal`";
  const ctx = { mode: 'direct', gatewayUrl: 'http://127.0.0.1:3425', model: "model'quoted", provider: { id: 'fixture', baseUrl: 'https://fixture.test/v1', apiKeys: [{ enabled: true, key: secret }] } };
  for (const platform of ['win32', 'darwin']) check(`${platform}: exported terminal credentials remain literal`, () => {
    const script = api.exportEnvScript(ctx, 'openai-chat', platform);
    const expected = platform === 'win32' ? `$env:OPENAI_API_KEY='${secret.replace(/'/g, "''")}'` : `export OPENAI_API_KEY='${secret.replace(/'/g, `'"'"'`)}'`;
    assert(script.split('\n').includes(expected));
  });
  check(`native ${process.platform} shell evaluates exported credentials without substitution`, () => {
    const script = api.exportEnvScript(ctx, 'openai-chat');
    const windows = process.platform === 'win32';
    const command = windows ? `${script}\n[Console]::Write($env:OPENAI_API_KEY)` : `${script}\nprintf '%s' "$OPENAI_API_KEY"`;
    const result = windows
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8' })
      : spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, secret);
  });

  process.env.AURORA_CLIENT_HOME = scratch;
  process.env.PATH = path.join(scratch, 'bin');
  process.env.CODEX_HOME = path.join(scratch, 'foreign-codex');
  process.env.CLAUDE_CONFIG_DIR = path.join(scratch, 'foreign-claude');
  process.env.LOCALAPPDATA = path.join(scratch, 'foreign-local');
  process.env.APPDATA = path.join(scratch, 'foreign-roaming');
  check('native isolated adapter paths ignore ambient profile environment variables', () => {
    assert.equal(api.getAdapter('codex-cli').configPaths()[0], path.join(scratch, '.codex', 'config.toml'));
    assert.equal(api.getAdapter('claude-code').configPaths()[0], path.join(scratch, '.claude', 'settings.json'));
    const desktopRoot = process.platform === 'win32' ? path.join(scratch, 'AppData', 'Local') : process.platform === 'darwin' ? path.join(scratch, 'Library', 'Application Support') : path.join(scratch, '.config');
    assert(api.getAdapter('claude-desktop').configPaths().every(file => file.startsWith(desktopRoot + path.sep)));
  });
  check(process.platform === 'win32' ? 'native Windows CLI discovery resolves cmd entry points' : 'native Unix CLI discovery rejects files without executable permission', () => {
    const executable = path.join(scratch, 'bin', process.platform === 'win32' ? 'codex.cmd' : 'codex');
    write(executable);
    if (process.platform !== 'win32') {
      fs.chmodSync(executable, 0o600); assert.equal(api.getAdapter('codex-cli').detect().installed, false);
      fs.chmodSync(executable, 0o700);
    }
    assert.equal(api.getAdapter('codex-cli').detect().command, executable);
  });
  check(`native ${process.platform} CodeBuddy-only installation is detected`, () => {
    const candidate = process.platform === 'darwin' ? path.join(scratch, 'Applications', 'CodeBuddy.app')
      : process.platform === 'win32' ? path.join(scratch, 'AppData', 'Local', 'Programs', 'CodeBuddy', 'CodeBuddy.exe') : path.join(scratch, '.local', 'bin', 'codebuddy');
    if (process.platform === 'darwin') fs.mkdirSync(candidate, { recursive: true }); else write(candidate);
    assert.equal(api.getAdapter('workbuddy').detect().command, candidate);
  });
  console.log(`\nClient platform paths: ${passed} checks passed. Path parameterization covers Windows/macOS; filesystem and shell checks ran on ${process.platform}.`);
} finally {
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert(path.basename(scratch).startsWith('aurora-client-platforms-'));
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(scratch, { recursive: true, force: true });
}
