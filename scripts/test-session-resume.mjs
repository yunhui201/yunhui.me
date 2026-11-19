import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { parse } from 'smol-toml';

const workspace = path.resolve(import.meta.dirname, '..');
const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-session-resume-')));
const clients = path.join(temporary, 'clients'), previous = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = clients;
const id = '10000000-0000-4000-8000-000000000001';
const summary = { id, agent: 'Codex', path: 'never-read', title: 'Fixture' };
let passed = 0;
const test = (name, run) => { run(); passed++; console.log(`PASS ${name}`); };
const posixQuote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const powershellQuote = value => `'${value.replace(/'/g, "''")}'`;
const resultFile = path.join(temporary, 'argv.json'), recorder = path.join(temporary, 'record-argv.cjs');
fs.writeFileSync(recorder, "require('node:fs').writeFileSync(process.env.YUNHUI_ARGV_REPORT, JSON.stringify(process.argv.slice(2)));\n");
const shellEnv = { ...process.env, YUNHUI_ARGV_REPORT: resultFile, MSYS2_ARG_CONV_EXCL: '*' };

function nativeArguments(shell, command, platform) {
  fs.rmSync(resultFile, { force: true });
  // Git Bash exposes POSIX argv before its separate Windows-native argv bridge.
  // Use its builtin printf for that cross-platform check; real Windows shells
  // and native POSIX hosts both execute the Node recorder as a native process.
  const posixOnWindows = process.platform === 'win32' && platform !== 'win32';
  const invocation = posixOnWindows ? "printf '%s\\0'" : platform === 'win32'
    ? `& ${powershellQuote(process.execPath)} ${powershellQuote(recorder)}`
    : `${posixQuote(process.execPath.replaceAll('\\', '/'))} ${posixQuote(recorder.replaceAll('\\', '/'))}`;
  assert.ok(command.startsWith('codex '));
  const script = command.replace(/^codex/, invocation);
  const scriptFile = path.join(temporary, 'argv.sh');
  if (platform !== 'win32') fs.writeFileSync(scriptFile, script + '\n');
  const args = platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
    : [scriptFile.replaceAll('\\', '/')];
  const child = spawnSync(shell, args, { cwd: temporary, env: shellEnv, encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(child.error, undefined, `${shell}: ${child.error}`);
  assert.equal(child.status, 0, `${shell}: ${child.stderr}`);
  if (posixOnWindows) { assert.ok(child.stdout.endsWith('\0')); return child.stdout.slice(0, -1).split('\0'); }
  assert.ok(fs.existsSync(resultFile), `Native argv recorder did not run: ${shell}`);
  return JSON.parse(fs.readFileSync(resultFile, 'utf8'));
}

try {
  const bundle = path.join(temporary, 'bundle.cjs');
  await build({ stdin: { contents: "export {scanSessions, resumeCommand} from './src/core/sessions.ts';", resolveDir: workspace, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);

  test('sessions without provider metadata keep the original commands on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      assert.equal(api.resumeCommand(summary, platform), `codex resume ${id}`);
      assert.equal(api.resumeCommand({ ...summary, provider: 'display-label-only' }, platform), `codex resume ${id}`);
      assert.equal(api.resumeCommand({ ...summary, agent: 'Claude Code', modelProvider: 'ignored' }, platform), `claude --resume ${id}`);
      assert.equal(api.resumeCommand({ ...summary, agent: 'Gemini CLI', modelProvider: 'ignored' }, platform), `gemini --resume ${id}`);
    }
  });
  test('desktop, disabled, subagent and invalid identity guards remain intact', () => {
    for (const fields of [{ canResume: false }, { isSubagent: true }, { sourceKind: 'desktop' }, { id: 'x; exit' }, { id: '--last' }, { id: '' }, { agent: 'unknown' }]) {
      for (const platform of ['win32', 'darwin']) assert.equal(api.resumeCommand({ ...summary, modelProvider: 'yunhui-history-route', ...fields }, platform), '');
    }
    assert.equal(api.resumeCommand(null), '');
  });
  test('malformed present provider metadata cannot silently select the current provider', () => {
    for (const provider of [null, 123, {}, '', ' spaced', 'trailing ', 'x'.repeat(201), 'x\n-c bad', 'x\0bad', 'x\tbad', '\u007f', '\ud800']) {
      for (const platform of ['win32', 'darwin']) assert.equal(api.resumeCommand({ ...summary, modelProvider: provider }, platform), '');
    }
    for (const provider of ['x"y', "x'''y", 'x\u2018y', 'x\u2019y', 'x\u201cy']) assert.equal(api.resumeCommand({ ...summary, modelProvider: provider }, 'win32'), '');
  });

  const common = ['yunhui-history-route-abc123', 'openai', 'OpenAI', 'azure', 'true', '123', '供應商 / 分组:α😀',
    'path\\provider', "single'quote", "'leading", "trailing'", "''leading", "trailing''", "x'; exit 99; #", 'x$(exit 99)`exit 99`;&|<>%TEMP%'];
  const shells = [];
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    assert.ok(fs.existsSync(powershell), 'Native Windows PowerShell 5 is required for argv validation');
    shells.push({ name: 'Windows PowerShell 5', shell: powershell, platform: 'win32', providers: common });
    if (!spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true, timeout: 10000 }).error)
      shells.push({ name: 'PowerShell 7', shell: 'pwsh.exe', platform: 'win32', providers: common });
    const bash = process.env.YUNHUI_TEST_BASH || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    if (fs.existsSync(bash)) shells.push({ name: 'Git Bash POSIX', shell: bash, platform: 'darwin', providers: [...common, 'x"y', "x'''y", 'x\u2019y'] });
    else console.log('SKIP POSIX shell execution: Git Bash is not installed on this Windows host');
  } else shells.push({ name: 'POSIX sh', shell: '/bin/sh', platform: process.platform, providers: [...common, 'x"y', "x'''y", 'x\u2019y'] });
  for (const { name, shell, platform, providers } of shells) {
    test(`${name} delivers the exact TOML provider and session ID as process arguments`, () => {
      for (const provider of providers) {
        const command = api.resumeCommand({ ...summary, modelProvider: provider }, platform);
        assert.ok(command, `Missing command for ${JSON.stringify(provider)}`);
        const argv = nativeArguments(shell, command, platform);
        assert.deepEqual([argv[0], ...argv.slice(2)], ['-c', 'resume', id]);
        assert.deepEqual({ ...parse(argv[1]) }, { model_provider: provider }, `${name} changed ${JSON.stringify(provider)}`);
      }
    });
  }
  test('scanning a migrated session uses its exact provider without modifying configuration or history', () => {
    const home = path.join(clients, '.codex'), sessions = path.join(home, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const file = path.join(sessions, 'persisted.jsonl'), config = path.join(home, 'config.toml');
    const provider = 'yunhui-history-route-fixture';
    fs.writeFileSync(config, 'model_provider="openai"\nmodel="unrelated-current-model"\n');
    fs.writeFileSync(file, [{ type: 'session_meta', payload: { id, model_provider: provider, source: 'cli', cwd: temporary } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'Persisted fixture' } }].map(JSON.stringify).join('\n') + '\n');
    const before = new Map([file, config].map(name => [name, { bytes: fs.readFileSync(name), mtime: fs.statSync(name).mtimeMs }]));
    const item = api.scanSessions().find(value => value.path === file);
    assert.ok(item); assert.equal(item.modelProvider, provider);
    assert.equal(api.resumeCommand(item), api.resumeCommand({ ...summary, modelProvider: provider }, process.platform));
    for (const [name, expected] of before) { assert.deepEqual(fs.readFileSync(name), expected.bytes); assert.equal(fs.statSync(name).mtimeMs, expected.mtime); }
  });
  console.log(`Session resume: ${passed} checks passed`);
} finally {
  if (previous === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = previous;
  const relative = path.relative(fs.realpathSync(os.tmpdir()), temporary);
  assert.ok(relative.startsWith('yunhui-session-resume-') && !relative.includes(path.sep));
  fs.rmSync(temporary, { recursive: true, force: true });
}
