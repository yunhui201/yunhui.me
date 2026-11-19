/** Status summaries must not misattribute tests, old routes or shared-client traffic. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-connection-view-'));
let count = 0;
const check = (name, task) => { task(); count++; console.log('PASS ' + name); };
try {
  const bundle = path.join(scratch, 'summary.cjs');
  await build({ entryPoints: [path.join(root, 'ui/src/lib/clientConnections.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  const { clientConnectionRows: rows } = createRequire(import.meta.url)(bundle);
  const now = Date.parse('2026-11-15T12:00:00Z'), stamp = delta => new Date(now + delta).toISOString();
  const fixture = () => ({ agentCatalog: [{ id: 'codex-cli', name: 'Codex CLI' }, { id: 'chatgpt-desktop', name: 'ChatGPT 桌面版' }, { id: 'claude-code', name: 'Claude Code' }],
    agents: { 'codex-cli': { id: 'codex-cli', connected: true, providerId: 'p', model: 'model-a', mode: 'gateway', lastSyncAt: stamp(-10000) } },
    providers: [{ id: 'p', name: 'Supplier', enabled: true, updatedAt: stamp(-20000) }], gateway: { running: true }, settings: { logRequests: true }, codexCoexist: { identity: { available: true } } });
  const record = patch => ({ ts: stamp(-5000), agent: 'Codex', providerId: 'p', model: 'model-a', requestId: 'r1', status: 200, latencyMs: 10, ...patch });
  check('Fresh matching client traffic supplies success time without claiming native installation validation', () => {
    const item = rows(fixture(), [record({})], now)[0]; assert.equal(item.label, '近期请求成功'); assert.equal(item.lastSuccessAt, stamp(-5000));
  });
  check('Toolbox tests, unknown clients, other suppliers/models, old and future traffic cannot validate a connection', () => {
    for (const change of [{ agent: '云汇AI 工具箱' }, { agent: 'yunhui-connection-test' }, { agent: '未知客户端' }, { agent: 'Claude Code' }, { providerId: 'other' }, { model: 'old' }, { ts: stamp(-30000) }, { ts: stamp(1000) }]) {
      const item = rows(fixture(), [record(change)], now)[0]; assert.equal(item.status, 'pending', JSON.stringify(change)); assert.equal(item.lastSuccessAt, undefined);
    }
  });
  check('A new failure preserves last success and gives a safe actionable category without raw error content', () => {
    const item = rows(fixture(), [record({}), record({ ts: stamp(-1000), status: 401, error: 'Bearer PRIVATE_KEY /private/file' })], now)[0];
    assert.equal(item.label, '最近请求失败'); assert.equal(item.lastSuccessAt, stamp(-5000)); assert.match(item.detail, /认证/); assert(!JSON.stringify(item).includes('PRIVATE_KEY'));
    assert.equal(rows(fixture(), [record({ error: 'failed while streaming' })], now)[0].status, 'warning');
  });
  check('Shared Codex routes coalesce aliases but differing client choices remain separate', () => {
    const state = fixture(); state.agents['chatgpt-desktop'] = { ...state.agents['codex-cli'], id: 'chatgpt-desktop' };
    let result = rows(state, [record({})], now); assert.equal(result.length, 1); assert.equal(result[0].agents.length, 2); assert.match(result[0].detail, /不区分/);
    state.agents['chatgpt-desktop'].model = 'model-b'; result = rows(state, [record({})], now); assert.equal(result.length, 2); assert.equal(result[1].status, 'pending');
  });
  check('Direct and imported configurations never inherit unrelated gateway success', () => {
    const state = fixture(); state.agents['codex-cli'].mode = 'direct'; assert.equal(rows(state, [record({})], now)[0].lastSuccessAt, undefined);
    state.agents['codex-cli'].pendingReapply = true; assert.equal(rows(state, [record({})], now)[0].label, '待应用到本机');
  });
  check('Stopped gateway, disabled or removed suppliers and stale official login take priority', () => {
    const state = fixture(); state.gateway.running = false; assert.equal(rows(state, [record({})], now)[0].label, '本地网关已停止');
    state.providers[0].enabled = false; assert.equal(rows(state, [], now)[0].label, '供应商已停用');
    state.providers = []; assert.equal(rows(state, [], now)[0].label, '供应商已删除');
    Object.assign(state.agents['codex-cli'], { providerId: 'official', authMode: 'coexist' }); state.gateway.running = true; state.codexCoexist.identity.available = false;
    assert.equal(rows(state, [], now)[0].providerName, 'ChatGPT 官方账号'); assert.equal(rows(state, [], now)[0].label, '官方登录需检查');
  });
  check('Changed supplier revisions and missing application timestamps cannot reuse previous success', () => {
    const state = fixture(); state.providers[0].updatedAt = stamp(-1000); assert.equal(rows(state, [record({})], now)[0].status, 'pending');
    delete state.providers[0].updatedAt; delete state.agents['codex-cli'].lastSyncAt; assert.equal(rows(state, [record({})], now)[0].status, 'pending');
  });
  check('Gateway configuration changes and pre-change in-flight requests cannot verify a new route', () => {
    const state = fixture(); state.settings.connectionUpdatedAt = stamp(-1000);
    assert.equal(rows(state, [record({})], now)[0].status, 'pending');
    state.settings.connectionUpdatedAt = stamp(-20000);
    assert.equal(rows(state, [record({ latencyMs: 6000 })], now)[0].status, 'pending');
    for (const latencyMs of [undefined, -1, Infinity, NaN]) assert.equal(rows(state, [record({ latencyMs })], now)[0].status, 'pending');
    state.settings.updatedAt = stamp(-1000);
    assert.equal(rows(state, [record({})], now)[0].status, 'success', 'Theme-only edits must not invalidate connectivity');
    state.agents['chatgpt-desktop'] = { ...state.agents['codex-cli'], id: 'chatgpt-desktop', lastSyncAt: stamp(-1000) };
    assert.equal(rows(state, [record({})], now)[0].status, 'pending', 'Use the newest shared configuration timestamp');
  });
  check('Ambiguous Claude traffic is not assigned to desktop; logging disabled is explained', () => {
    const state = fixture(); state.agentCatalog = [{ id: 'claude-desktop', name: 'Claude Desktop' }]; state.agents['claude-desktop'] = state.agents['codex-cli'];
    assert.equal(rows(state, [record({ agent: 'Claude Code' })], now)[0].status, 'pending');
    state.settings.logRequests = false; assert.match(rows(state, [], now)[0].detail, /记录已关闭/);
    assert.equal(rows(state, [record({ agent: 'claude-desktop' })], now)[0].status, 'success');
    state.agentCatalog = [{ id: 'claude-code', name: 'Claude Code' }]; state.agents['claude-code'] = state.agents['codex-cli'];
    const ambiguous = rows(state, [record({ agent: 'Claude Code' })], now)[0];
    assert.equal(ambiguous.status, 'pending'); assert.equal(ambiguous.lastSuccessAt, stamp(-5000)); assert.match(ambiguous.detail, /无法区分/);
  });
  console.log(`Client connection overview: ${count} checks passed.`);
} finally {
  assert.equal(path.dirname(scratch), os.tmpdir()); assert(path.basename(scratch).startsWith('yunhui-connection-view-'));
  fs.rmSync(scratch, { recursive: true, force: true });
}
