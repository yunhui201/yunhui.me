import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEndpoint, createRpcClient, decodeRpc } from '../src/connection.js';

test('gateway addresses accept LAN and HTTPS prefixes without embedding secrets', () => {
  assert.equal(normalizeEndpoint(' 192.168.1.8:3425/ '), 'http://192.168.1.8:3425');
  assert.equal(normalizeEndpoint('https://gateway.example/aurora/'), 'https://gateway.example/aurora');
  for (const value of ['', 'file:///etc/passwd', 'https://user:secret@example.com', 'https://example.com?token=secret', 'https://example.com#secret']) assert.throws(() => normalizeEndpoint(value));
});

test('mobile RPC sends authentication only in the header and preserves the request contract', async () => {
  let captured;
  const rpc = createRpcClient('https://gateway.example', 'private-token', async request => {
    captured = request;
    return { status: 200, data: { result: { enabled: false } } };
  });
  assert.deepEqual(await rpc('provider.toggle', { id: 'provider-1', enabled: false }), { enabled: false });
  assert.equal(captured.headers.Authorization, 'Bearer private-token');
  assert.equal(captured.url, 'https://gateway.example/api/rpc');
  assert.deepEqual(captured.data, { action: 'provider.toggle', payload: { id: 'provider-1', enabled: false } });
  assert.throws(() => createRpcClient('https://gateway.example', '', () => {}), /访问令牌/);
});

test('authentication, HTTP, malformed JSON and failed actions cannot appear successful', () => {
  assert.throws(() => decodeRpc(401, '<html>Unauthorized</html>'), /令牌/);
  assert.throws(() => decodeRpc(503, {}), /503/);
  assert.throws(() => decodeRpc(200, '<html>not a gateway</html>'), /不是云汇/);
  assert.throws(() => decodeRpc(200, { error: '配置冲突' }), /配置冲突/);
  assert.throws(() => decodeRpc(200, { result: { ok: false, message: '文件变化' } }), /文件变化/);
  assert.throws(() => decodeRpc(200, { ok: true }), /缺少结果/);
  assert.deepEqual(decodeRpc(200, JSON.stringify({ result: [] })), []);
});
