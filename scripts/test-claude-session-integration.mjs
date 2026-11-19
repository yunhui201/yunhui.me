import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-claude-history-')));
const saved = process.env.AURORA_CLIENT_HOME;
let count = 0;
try {
  for (const platform of ['win32', 'darwin']) {
    const root = path.join(temporary, platform);
    fs.mkdirSync(root);
    process.env.AURORA_CLIENT_HOME = root;
    const output = path.join(temporary, platform + '.cjs');
    await build({ stdin: { contents: "export * from './src/core/sessions.ts'", loader: 'ts', resolveDir: process.cwd() },
      bundle: true, platform: 'node', format: 'cjs', outfile: output, define: { 'process.platform': JSON.stringify(platform) }, logLevel: 'silent' });
    const api = createRequire(import.meta.url)(output);
    const base = platform === 'win32' ? path.join(root, 'AppData', 'Local') : path.join(root, 'Library', 'Application Support');
    const originals = new Map();
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
      originals.set(file, { bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs });
      return file;
    };
    const transcript = (id, project = 'one', cwd = '/project', message = `Message ${id}`) => write(path.join(root, '.claude', 'projects', project, `${id}.jsonl`), [
      { type: 'user', sessionId: id, cwd, message: { role: 'user', content: message } },
      { type: 'assistant', sessionId: id, message: { role: 'assistant', model: 'claude-fixture', content: [{ type: 'text', text: 'Answer' }] } },
    ].map(JSON.stringify).join('\n') + '\n');
    const desktop = (id, metadata, directory = 'Claude-3p', org = 'org') => write(path.join(base, directory, 'claude-code-sessions', 'account', org, `local_${id}.json`), JSON.stringify(metadata));
    const item = file => { const found = api.scanSessions().find(s => s.path === file); assert(found, file); return found; };
    const test = (name, fn) => { fn(); count++; console.log(`PASS ${platform}: ${name}`); };

    const cli = transcript('linked');
    const linked = desktop('linked', { title: 'Desktop title', cwd: '/project', cliSessionId: 'linked', isArchived: true });
    test('CLI supplier stays unknown and Desktop metadata links by exact ID and project without hiding the CLI', () => {
      const code = item(cli), value = item(linked);
      assert.equal(code.modelProvider, undefined); assert.equal(code.sourceLabel, '.claude · 默认目录');
      assert.equal(code.model, 'claude-fixture'); assert.equal(api.resumeCommand(code), 'claude --resume linked');
      assert.equal(value.agent, 'Claude Desktop'); assert.equal(value.sourceLabel, 'Claude-3p · 第三方网关');
      assert.equal(value.modelProvider, undefined); assert.equal(value.contentStatus, 'available'); assert(value.archived);
      assert.equal(value.messageCount, 2); assert.equal(api.readSession(linked)[0].text, 'Message linked');
      assert.equal(api.resumeCommand(value), ''); assert.equal(api.scanSessions().length, 2);
      assert.match(api.exportSessionMarkdown(value), /Desktop title[\s\S]*第三方网关[\s\S]*Message linked/);
    });
    test('missing or different project evidence remains metadata-only and can still be exported honestly', () => {
      for (const [id, cwd] of [['different', '/elsewhere'], ['missing', undefined]]) {
        const file = desktop(id, { title: 'Metadata only', cwd, cliSessionId: 'linked' });
        assert.equal(item(file).contentStatus, 'metadata-only'); assert.deepEqual(api.readSession(file), []);
        assert.match(api.exportSessionMarkdown(item(file)), /仅有会话记录，正文未定位/);
      }
    });
    test('shared transcript references in another Desktop profile are ambiguous, never silently merged', () => {
      const duplicate = desktop('linked', { cwd: '/project', cliSessionId: 'linked' }, 'Claude', 'other-org');
      assert.notEqual(item(duplicate).sourceScope, item(linked).sourceScope);
      assert.equal(item(linked).contentStatus, 'ambiguous'); assert.deepEqual(api.readSession(linked), []);
      assert.equal(item(duplicate).sourceLabel, 'Claude · 默认目录'); assert.equal(item(duplicate).modelProvider, undefined);
      assert.equal(api.readSession(cli)[0].text, 'Message linked');
    });
    test('duplicate CLI IDs in different projects cannot be selected by directory enumeration order', () => {
      transcript('duplicate', 'first'); transcript('duplicate', 'second');
      const file = desktop('duplicate', { cwd: '/project', cliSessionId: 'duplicate' });
      assert.equal(item(file).contentStatus, 'ambiguous'); assert.deepEqual(api.readSession(file), []);
      const matches = api.scanSessions().filter(s => s.agent === 'Claude Code' && s.id === 'duplicate');
      assert.equal(matches.length, 2); assert.notEqual(matches[0].sourceScope, matches[1].sourceScope);
    });
    test('prior transcript fallback explicitly identifies a historical fragment', () => {
      transcript('prior');
      const file = desktop('prior', { cwd: '/project', cliSessionId: 'current-absent', priorCliSessionIds: ['prior'] });
      assert.equal(item(file).contentStatus, 'available'); assert.match(item(file).contentNote, /历史片段/);
      assert.equal(api.readSession(file)[0].text, 'Message prior');
      transcript('unarchived');
      const old = desktop('unarchived', { cwd: '/project', unarchivedCliSessionId: 'unarchived' });
      assert.equal(item(old).contentStatus, 'available'); assert.match(item(old).contentNote, /历史片段/);
    });
    test('metadata IDs and paths never become executable resume commands or arbitrary read targets', () => {
      const file = desktop('malicious', { title: 'Keep metadata', cwd: '/project', cliSessionId: '../outside', priorCliSessionIds: ['bad;command'] });
      assert.equal(item(file).contentStatus, 'metadata-only'); assert.equal(api.resumeCommand(item(file)), '');
      const outside = write(path.join(root, 'outside', 'local_outside.json'), JSON.stringify({ messages: [{ role: 'user', content: 'private' }] }));
      assert.throws(() => api.readSession(outside), /只能读取|路径|目录/);
      assert.throws(() => api.exportSessionMarkdown({ ...item(file), path: outside }), /只能读取|路径|目录/);
    });
    test('scanning, reading and exporting leave original history bytes and timestamps untouched', () => {
      for (const [file, original] of originals) {
        assert.deepEqual(fs.readFileSync(file), original.bytes); assert.equal(fs.statSync(file).mtimeMs, original.mtime);
      }
    });
    test('a redirected default CLI directory is not evidence that it owns Desktop conversations', () => {
      const isolated = path.join(temporary, `${platform}-junction`);
      const external = path.join(temporary, `${platform}-foreign-transcripts`);
      const originalHome = process.env.AURORA_CLIENT_HOME;
      fs.mkdirSync(path.join(isolated, '.claude'), { recursive: true });
      const body = path.join(external, 'project', 'external.jsonl');
      write(body, JSON.stringify({ type: 'user', sessionId: 'external', cwd: '/project', message: { role: 'user', content: 'Must not be associated' } }) + '\n');
      fs.symlinkSync(external, path.join(isolated, '.claude', 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
      const store = platform === 'win32' ? path.join(isolated, 'AppData', 'Local') : path.join(isolated, 'Library', 'Application Support');
      const metadata = write(path.join(store, 'Claude-3p', 'claude-code-sessions', 'account', 'org', 'local_external.json'), JSON.stringify({ cwd: '/project', cliSessionId: 'external' }));
      process.env.AURORA_CLIENT_HOME = isolated;
      try {
        const value = api.scanSessions().find(s => s.path === metadata);
        assert.equal(value.contentStatus, 'metadata-only'); assert.deepEqual(api.readSession(metadata), []);
      } finally {
        process.env.AURORA_CLIENT_HOME = originalHome;
        fs.unlinkSync(path.join(isolated, '.claude', 'projects'));
      }
    });
  }
  console.log(`Claude history integration: ${count} checks passed`);
} finally {
  if (saved === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = saved;
  assert(path.basename(temporary).startsWith('yunhui-claude-history-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
