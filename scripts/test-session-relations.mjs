import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-session-relations-'));
const previous = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = path.join(temporary, 'clients');
const originals = new Map();
const rootId = '10000000-0000-4000-8000-000000000001';
let passed = 0;
const write = (relative, records) => {
  const file = path.join(process.env.AURORA_CLIENT_HOME, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
  originals.set(file, { bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs });
  return file;
};
const codex = (id, metadata = {}, filename = id) => write(`.codex/sessions/${filename}.jsonl`, [
  { type: 'session_meta', payload: { id, source: 'cli', ...metadata } },
  { type: 'event_msg', payload: { type: 'user_message', message: `提问 ${id}` } },
]);
const claude = (relative, sessionId, extra = {}, remaining = []) => write(`.claude/projects/project/${relative}.jsonl`, [
  { type: 'user', sessionId, cwd: '/fixture/project', message: { role: 'user', content: `提问 ${relative}` }, ...extra }, ...remaining,
]);
try {
  await build({ stdin: { contents: "export {scanSessions, readSession, resumeCommand} from './src/core/sessions.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(temporary, 'bundle.cjs'), logLevel: 'silent' });
  const api = createRequire(import.meta.url)(path.join(temporary, 'bundle.cjs'));
  const scan = file => { const summary = api.scanSessions().find(s => s.path === file); assert.ok(summary, `Session remains visible: ${file}`); return summary; };
  const test = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };

  const parent = codex(rootId);
  test('native nested spawn metadata identifies the actual parent, including nested subagents', () => {
    const child = codex('thread-child', { source: { subagent: { thread_spawn: { parent_thread_id: rootId, depth: 1 } } } });
    const grandchild = codex('thread-grandchild', { source: { subagent: { thread_spawn: { parent_thread_id: 'thread-child', depth: 2 } } } });
    assert.equal(scan(child).isSubagent, true); assert.equal(scan(child).parentSessionId, rootId);
    assert.equal(scan(grandchild).parentSessionId, 'thread-child'); assert.equal(scan(parent).isSubagent, undefined);
    assert.equal(api.readSession(child)[0].text, '提问 thread-child'); assert.equal(api.resumeCommand(scan(child)), '');
    assert.equal(api.resumeCommand(scan(parent)), `codex resume ${rootId}`);
  });
  test('top-level parent and native source variants work without deriving identities from display text', () => {
    assert.equal(scan(codex('top-parent', { parent_thread_id: rootId })).parentSessionId, rootId);
    for (const source of [{ subagent: 'review' }, { subagent: 'compact' }, { subagent: 'memory_consolidation' }, { subagent: { other: 'custom-task' } }, 'subagent_review']) {
      const item = scan(codex(`variant-${originals.size}`, { source })); assert.equal(item.isSubagent, true); assert.equal(item.parentSessionId, undefined);
    }
    assert.equal(scan(codex('classified', { thread_source: 'subagent' })).isSubagent, true);
    assert.equal(scan(codex('serialized', { source: `subagent_thread_spawn_${rootId}_d2` })).parentSessionId, rootId);
  });
  test('ordinary forks, names, prompts, exec and unknown source values stay in main history', () => {
    const files = [codex('forked', { forked_from_id: rootId }), codex('plain-subagent-name', { source: { custom: 'subagent research' } }, 'agent-subagent'), codex('exec', { source: 'exec' }), codex('future', { source: { future: { parent_thread_id: rootId } } }), codex('invalid-parent', { parent_thread_id: '../../outside', source: null }), codex('self-parent', { parent_thread_id: 'self-parent' })];
    for (const file of files) { assert.equal(scan(file).isSubagent, undefined); assert.equal(scan(file).parentSessionId, undefined); }
  });
  const claudeParent = claude(rootId, rootId);
  test('Claude standard subagent layout identifies root and agent even with shared sessionId', () => {
    const file = claude(`${rootId}/subagents/agent-a1`, rootId);
    const nested = claude(`${rootId}/subagents/workflows/run-1/agent-a2`, rootId);
    for (const [item, id] of [[scan(file), 'a1'], [scan(nested), 'a2']]) { assert.equal(item.isSubagent, true); assert.equal(item.parentSessionId, rootId); assert.equal(item.subagentId, id); assert.equal(api.resumeCommand(item), ''); }
    assert.equal(scan(claudeParent).isSubagent, undefined); assert.equal(api.resumeCommand(scan(claudeParent)), `claude --resume ${rootId}`);
  });
  test('Claude sidechain marker recognizes legacy transcripts but later child messages never hide a main session', () => {
    const legacy = claude('legacy-agent', rootId, { isSidechain: true, agentId: 'a3' });
    assert.equal(scan(legacy).isSubagent, true); assert.equal(scan(legacy).parentSessionId, rootId); assert.equal(scan(legacy).subagentId, 'a3');
    const mixed = claude('mixed', 'mixed', { isSidechain: false }, [{ type: 'assistant', isSidechain: true, agentId: 'other', message: { role: 'assistant', content: '子任务消息' } }]);
    assert.equal(scan(mixed).isSubagent, undefined); assert.equal(api.readSession(mixed).length, 2);
  });
  test('Claude arbitrary agent filenames, directories and nonboolean sidechain flags remain main', () => {
    for (const file of [claude('agent-ordinary', 'ordinary'), claude('arbitrary/subagents/agent-fake', 'fake'), claude(`${rootId}/other/agent-fake`, 'fake-2'), claude('string-marker', 'string-marker', { isSidechain: 'true' })]) assert.equal(scan(file).isSubagent, undefined);
  });
  test('missing parent files and malformed optional metadata never remove readable child history', () => {
    const missing = scan(codex('orphan', { parent_thread_id: 'parent-unavailable' })); assert.equal(missing.isSubagent, true); assert.equal(missing.parentSessionId, 'parent-unavailable');
    const unknown = scan(codex('malformed', { source: { subagent: null }, parent_thread_id: [] })); assert.equal(unknown.isSubagent, undefined);
    const file = write('.codex/archived_sessions/old.jsonl', [null, { type: 'session_meta', payload: { id: 'old', source: { subagent: 'review' } } }, { type: 'event_msg', payload: { type: 'user_message', message: '已归档子代理' } }]);
    assert.equal(scan(file).archived, true); assert.equal(scan(file).isSubagent, true);
    assert.equal(api.readSession(file)[0].text, '已归档子代理');
  });
  test('classification preserves every scanned file, contents and modification times', () => {
    assert.equal(api.scanSessions().length, originals.size);
    for (const [file, original] of originals) { assert.deepEqual(fs.readFileSync(file), original.bytes); assert.equal(fs.statSync(file).mtimeMs, original.mtime); }
  });
  console.log(`Session relations: ${passed} tests passed`);
} finally {
  if (previous === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = previous;
  assert.ok(path.relative(os.tmpdir(), temporary).startsWith('yunhui-session-relations-'));
  fs.rmSync(temporary, { recursive: true, force: true });
}
