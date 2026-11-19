import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-claude-desktop-sessions-')));
const previous = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = temporary;
let checks = 0, sequence = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; }
function fixture(platform = 'win32') {
  const home = path.join(temporary, `profile-${++sequence}`); fs.mkdirSync(home);
  const base = platform === 'win32' ? path.join(home, 'AppData', 'Local') : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : path.join(home, '.config');
  const options = { home, platform, isolated: true };
  const file = (directory = base, name = 'Claude', account = 'account', org = 'org', id = 'shared') => path.join(directory, name, 'claude-code-sessions', account, org, `local_${id}.json`);
  return { home, base, options, file };
}
try {
  const output = path.join(temporary, 'module.cjs');
  await build({ entryPoints: ['src/core/claudeDesktopSessions.ts'], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(output);
  check('Windows standard Local and Roaming stores retain per-directory, account and organization identity', () => {
    const f = fixture(), roaming = path.join(f.home, 'AppData', 'Roaming');
    for (const [base, directory, account, org] of [[f.base, 'Claude', 'a', 'o'], [f.base, 'Claude-3p', 'a', 'o'], [roaming, 'Claude', 'a', 'o'], [f.base, 'Claude', 'other', 'o'], [f.base, 'Claude', 'a', 'other']]) write(f.file(base, directory, account, org), { title: 'same id', cliSessionId: 'same-cli' });
    const found = api.scanClaudeDesktopSessions(f.options);
    assert.equal(found.length, 5); assert.equal(new Set(found.map(record => record.id)).size, 1); assert.equal(new Set(found.map(record => record.sourceScope)).size, 5);
    assert(found.some(record => record.sourceLabel === 'Claude-3p · 第三方网关')); assert(found.some(record => record.sourceLabel === 'Claude · 默认目录'));
    for (const record of found) assert.deepEqual(api.readClaudeDesktopSession(record.path, f.options), record);
  });
  check('Both supported MSIX package names include LocalCache Local and Roaming but reject lookalikes', () => {
    const f = fixture();
    for (const packageName of ['Claude_123456789abcd', 'AnthropicPBC.Claude_123456789abcd', 'Claude_123', 'Other_123456789abcd', 'Claude_123456789abcd-extra']) {
      for (const location of ['Local', 'Roaming']) write(f.file(path.join(f.base, 'Packages', packageName, 'LocalCache', location)), { title: packageName });
    }
    const found = api.scanClaudeDesktopSessions(f.options); assert.equal(found.length, 4);
    assert(found.every(record => /(?:Claude|AnthropicPBC\.Claude)_123456789abcd[\\/]LocalCache/.test(record.path)));
  });
  check('macOS and Linux use their own user data layouts', () => {
    for (const platform of ['darwin', 'linux']) {
      const f = fixture(platform); write(f.file(), { title: platform, createdAt: '2026-11-16T00:00:00Z' });
      const found = api.scanClaudeDesktopSessions(f.options); assert.equal(found.length, 1); assert.equal(found[0].title, platform); assert.equal(found[0].createdAtMs, Date.parse('2026-11-16T00:00:00Z'));
    }
  });
  check('Trusted Windows environment roots and Linux XDG_CONFIG_HOME are honored outside isolation', () => {
    delete process.env.AURORA_CLIENT_HOME;
    try {
      for (const platform of ['win32', 'linux']) {
        const f = fixture(platform), base = path.join(f.home, 'custom-data'); write(f.file(base), { title: platform });
        const environment = platform === 'win32' ? { localappdata: base, appdata: base } : { XDG_CONFIG_HOME: base };
        const found = api.scanClaudeDesktopSessions({ ...f.options, isolated: false, environment }); assert.equal(found.length, 1);
      }
    } finally { process.env.AURORA_CLIENT_HOME = temporary; }
  });
  check('AURORA_CLIENT_HOME prevents actual environment roots even with isolated:false', () => {
    const f = fixture(), foreign = fixture(); write(f.file(), { title: 'isolated' }); write(foreign.file(), { title: 'foreign' });
    const found = api.scanClaudeDesktopSessions({ ...f.options, isolated: false, environment: { LOCALAPPDATA: foreign.base, APPDATA: foreign.base, XDG_CONFIG_HOME: foreign.base } });
    assert.deepEqual(found.map(record => record.title), ['isolated']);
    assert.throws(() => api.readClaudeDesktopSession(foreign.file(), f.options), /只能读取/);
  });
  check('Only bounded metadata fields are exported, with all current, unarchived and prior CLI IDs', () => {
    const f = fixture(), file = write(f.file(), { sessionId: 'forged-id', title: '  Hello\n world  ', cwd: '/workspace/project', createdAt: 1700000000,
      lastActivityAt: 1700000000123, isArchived: true, cliSessionId: ' current ', unarchivedCliSessionId: 'unarchived',
      priorCliSessionIds: ['before', 'current', 'before', '../escape', { token: 'never-return-this' }], apiKey: 'secret-test-value', messages: [{ text: 'never-return-body' }] });
    const original = fs.readFileSync(file), record = api.readClaudeDesktopSession(file, f.options);
    assert.equal(record.id, 'local_shared'); assert.equal(record.title, 'Hello world'); assert.equal(record.cwd, '/workspace/project'); assert.equal(record.createdAtMs, 1700000000000); assert.equal(record.updatedAtMs, 1700000000123); assert.equal(record.isArchived, true);
    assert.deepEqual(record.cliIds, ['current', 'unarchived', 'before']); assert.deepEqual(record.priorCliSessionIds, ['before', 'current']);
    assert(!JSON.stringify(record).includes('secret-test-value')); assert(!JSON.stringify(record).includes('never-return')); assert(!('modelProvider' in record)); assert.equal(record.size, original.length);
    api.scanClaudeDesktopSessions(f.options); assert.deepEqual(fs.readFileSync(file), original);
  });
  check('Malformed and oversized files do not suppress unrelated valid histories', () => {
    const f = fixture(); write(f.file(f.base, 'Claude', 'a', 'o', 'good'), { title: 'valid' });
    for (const [id, body] of [['bad', '{'], ['null', 'null'], ['array', '[]'], ['large', 'x'.repeat(2048)]]) write(f.file(f.base, 'Claude', 'a', 'o', id), body);
    const options = { ...f.options, maxRecordBytes: 1024 };
    assert.deepEqual(api.scanClaudeDesktopSessions(options).map(record => record.title), ['valid']);
    assert.throws(() => api.readClaudeDesktopSession(f.file(f.base, 'Claude', 'a', 'o', 'bad'), options), /JSON/);
    assert.throws(() => api.readClaudeDesktopSession(f.file(f.base, 'Claude', 'a', 'o', 'large'), options), /过大/);
  });
  check('Working-directory identity is never rewritten or truncated into a different project', () => {
    const f = fixture();
    for (const cwd of ['/project\nother', '/project\tother', 'x'.repeat(4097)]) {
      write(f.file(), { cwd }); assert.equal(api.readClaudeDesktopSession(f.file(), f.options).cwd, '');
    }
    write(f.file(), { cwd: '/project with spaces ' }); assert.equal(api.readClaudeDesktopSession(f.file(), f.options).cwd, '/project with spaces ');
  });
  check('deleted_UUID tombstones suppress only the corresponding record in that exact organization', () => {
    const f = fixture(), deleted = write(f.file(), { title: 'deleted' });
    write(path.join(path.dirname(deleted), 'deleted_shared'), 'not JSON');
    write(f.file(f.base, 'Claude', 'other', 'org'), { title: 'still present' });
    assert.deepEqual(api.scanClaudeDesktopSessions(f.options).map(record => record.title), ['still present']);
    assert.throws(() => api.readClaudeDesktopSession(deleted, f.options), /已删除/);
  });
  check('Untrusted read paths must fit the exact root/account/organization/local-ID layout', () => {
    const f = fixture(), file = write(f.file(), { title: 'safe' });
    const extra = write(path.join(path.dirname(file), 'nested', 'local_other.json'), {}), arbitrary = write(path.join(f.home, 'local_outside.json'), {});
    const traversed = path.dirname(file) + path.sep + '..' + path.sep + 'org' + path.sep + path.basename(file);
    for (const rejected of [arbitrary, extra, traversed, 'local_relative.json', file + '\n', file.replace('local_shared', 'other')]) assert.throws(() => api.readClaudeDesktopSession(rejected, f.options));
    assert.equal(api.scanClaudeDesktopSessions(f.options).length, 1);
  });
  check('Directory junctions/symlinks and linked package roots never escape trusted history roots', () => {
    const f = fixture(), foreign = fixture(); write(foreign.file(), { title: 'foreign' });
    const sessions = path.join(f.base, 'Claude', 'claude-code-sessions'); fs.mkdirSync(sessions, { recursive: true });
    const accountLink = path.join(sessions, 'linked-account'); fs.symlinkSync(path.join(foreign.base, 'Claude', 'claude-code-sessions', 'account'), accountLink, process.platform === 'win32' ? 'junction' : 'dir');
    const packages = path.join(f.base, 'Packages'); fs.mkdirSync(packages, { recursive: true });
    fs.symlinkSync(foreign.home, path.join(packages, 'Claude_123456789abcd'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(api.scanClaudeDesktopSessions(f.options).length, 0);
    assert.throws(() => api.readClaudeDesktopSession(path.join(accountLink, 'org', 'local_shared.json'), f.options), /链接|重定向/);
    assert.deepEqual(JSON.parse(fs.readFileSync(foreign.file())), { title: 'foreign' });
  });
  check('Linked metadata files are rejected when native symlink creation is available', () => {
    const f = fixture(), actual = write(path.join(f.home, 'external.json'), { title: 'outside' });
    fs.mkdirSync(path.dirname(f.file()), { recursive: true });
    try { fs.symlinkSync(actual, f.file(), 'file'); }
    catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') { console.log('INFO file symlink requires Windows Developer Mode; directory junction test exercised'); return; } throw error; }
    assert.equal(api.scanClaudeDesktopSessions(f.options).length, 0); assert.throws(() => api.readClaudeDesktopSession(f.file(), f.options), /链接|普通文件/);
  });
  check('File, directory and metadata limits bound scanning and ID arrays without opening JSONL bodies', () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) write(f.file(f.base, 'Claude', 'account', 'org', String(i)), { title: String(i), priorCliSessionIds: Array.from({ length: 200 }, (_, n) => `cli-${n}`) });
    write(path.join(f.home, '.claude', 'projects', 'project', 'cli-0.jsonl'), 'never-read-transcript');
    assert.equal(api.scanClaudeDesktopSessions({ ...f.options, maxFiles: 3 }).length, 3);
    assert.equal(api.scanClaudeDesktopSessions({ ...f.options, maxDirectories: 1 }).length, 0);
    const record = api.readClaudeDesktopSession(f.file(f.base, 'Claude', 'account', 'org', '0'), f.options); assert.equal(record.priorCliSessionIds.length, 128);
    assert.equal(fs.readFileSync(path.join(f.home, '.claude', 'projects', 'project', 'cli-0.jsonl'), 'utf8'), 'never-read-transcript');
  });
  console.log(`Claude Desktop metadata: ${checks} checks passed`);
} finally {
  if (previous === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = previous;
  if (path.dirname(temporary) === fs.realpathSync.native(os.tmpdir()) && path.basename(temporary).startsWith('yunhui-claude-desktop-sessions-')) fs.rmSync(temporary, { recursive: true, force: true });
}
