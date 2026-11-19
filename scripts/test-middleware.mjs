/** Plugin failures must not corrupt a request or leak its content. All stores are isolated. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-middleware-')));
const workspace = path.resolve(import.meta.dirname, '..');
let count = 0;
const check = (name, fn) => { fn(); count++; console.log(`PASS ${name}`); };
try {
  const bundle = path.join(root, 'api.cjs');
  await build({ stdin: { contents: "export * from './src/core/plugins/middleware.ts'; export * from './src/core/store/index.ts';", resolveDir: workspace }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { applyMiddleware, getMiddlewareStatus, AuroraStore } = createRequire(import.meta.url)(bundle);
  const request = () => ({ model: 'fixture-model', system: '', messages: [{ role: 'user', blocks: [{ type: 'text', text: 'original' }] }], tools: [], toolChoice: { type: 'auto' }, stream: false });
  const custom = (code, options = {}) => ({ id: 'same-id', name: 'Fixture', enabled: true, updatedAt: 'same-time', code, options });
  const run = (plugins, ir = request()) => applyMiddleware({ listPlugins: () => plugins }, ir, { agent: 'fixture', protocol: 'openai-chat', requestId: 'fixture' });
  const store = new AuroraStore(path.join(root, 'store'));

  check('invalid script syntax is rejected before modifying persistent plugin state', () => {
    const before = JSON.stringify(store.listPlugins());
    assert.throws(() => store.savePlugin({ name: 'bad', code: 'function onRequest( {' }), /语法/);
    assert.equal(JSON.stringify(store.listPlugins()), before);
  });
  check('built-in options are validated before a plugin can be enabled', () => {
    for (const [id, options] of [['word-guard', { words: [''], action: 'mask' }], ['param-override', { maxTokens: -1 }], ['token-budget', { maxTokens: '20' }], ['model-map', { mapping: { fast: 12 } }], ['system-prompt', { text: [] }]]) {
      assert.throws(() => store.savePlugin({ id, name: id, builtin: true, enabled: true, options }));
    }
    assert.equal(store.listPlugins().length, 0);
  });
  check('legacy invalid scripts can still be disabled', () => {
    const legacyRoot = path.join(root, 'legacy'); fs.mkdirSync(legacyRoot);
    fs.writeFileSync(path.join(legacyRoot, 'plugins.json'), JSON.stringify([custom('function broken(')]));
    const legacy = new AuroraStore(legacyRoot);
    legacy.savePlugin({ id: 'same-id', enabled: false });
    assert.equal(new AuroraStore(legacyRoot).listPlugins()[0].enabled, false);
  });
  check('void hook mutations are accepted while caller-owned input stays unchanged', () => {
    const original = request();
    const result = run([custom('function onRequest(ir){ir.model="changed";}')], original);
    assert.equal(result.ir.model, 'changed'); assert.equal(original.model, 'fixture-model');
  });
  check('malformed hook results fail open using the last valid request', () => {
    for (const body of ['return null;', 'return false;', 'return "bad";', 'return {};', 'ir.messages=[{}];return ir;', 'ir.tools=[null];return ir;', 'ir.toolChoice=null;return ir;', 'return {block: {secret:"private"}};']) {
      const result = run([custom(`function onRequest(ir){ir.model="partial";${body}}`)]);
      assert.deepEqual(result.ir, request()); assert(result.notes[0].includes('执行失败'));
    }
  });
  check('invalid optional protocol parameters cannot be marked successful or sent upstream', () => {
    for (const change of ['ir.maxTokens=-1', 'ir.maxTokens=1.5', 'ir.stop="invalid"', 'ir.stop=[3]', 'ir.reasoning={}', 'ir.temperature=9', 'ir.topP=-1', 'ir.sessionKey=[]']) {
      const result = run([custom(`function onRequest(ir){${change};return ir;}`)]);
      assert.deepEqual(result.ir, request()); assert(result.notes[0].includes('执行失败'));
    }
  });
  check('throwing after modifying input leaves the previous plugin result intact and hides exception content', () => {
    const result = run([custom('function onRequest(ir){ir.system="kept";return ir;}'), { ...custom('function onRequest(ir){ir.system="lost";throw new Error("fixture-secret-request");}'), id: 'thrower' }]);
    assert.equal(result.ir.system, 'kept'); assert(!JSON.stringify(result.notes).includes('fixture-secret-request'));
  });
  check('legacy syntax errors are reported rather than silently treated as active', () => {
    const result = run([custom('function missing(')]);
    assert.deepEqual(result.ir, request()); assert(result.notes[0].includes('执行失败'));
  });
  check('code and options changes invalidate cache even if IDs and timestamps are equal', () => {
    const code = 'function onRequest(ir){ir.system=options.text;return ir;}';
    assert.equal(run([custom(code, { text: 'first' })]).ir.system, 'first');
    assert.equal(run([custom(code, { text: 'second' })]).ir.system, 'second');
    assert.equal(run([custom('function onRequest(ir){ir.system="third";return ir;}')]).ir.system, 'third');
  });
  check('synchronous infinite loops have a bounded execution time', () => {
    const started = Date.now(); const result = run([custom('function onRequest(){while(true){}}')]);
    assert(Date.now() - started < 3000); assert(result.notes[0].includes('timed out')); assert.deepEqual(result.ir, request());
  });
  check('promise microtasks remain inside the same execution timeout', () => {
    const started = Date.now(); const result = run([custom('function onRequest(ir){Promise.resolve().then(()=>{while(true){}});return ir;}')]);
    assert(Date.now() - started < 3000); assert(result.notes[0].includes('timed out'));
  });
  check('async hooks are rejected and cannot replace requests with promises', () => {
    assert.deepEqual(run([custom('async function onRequest(ir){ir.model="bad";return ir;}')]).ir, request());
  });
  let unhandled = false;
  const rejected = () => { unhandled = true; };
  process.on('unhandledRejection', rejected);
  const rejectedResult = run([custom('async function onRequest(){throw new Error("fixture-private-error");}')]);
  await new Promise(resolve => setImmediate(resolve));
  process.removeListener('unhandledRejection', rejected);
  check('rejected async hook errors are consumed without crashing the gateway process', () => {
    assert.equal(unhandled, false); assert.deepEqual(rejectedResult.ir, request());
  });
  unhandled = false; process.on('unhandledRejection', rejected);
  for (const expression of [
    'Promise.reject(new Error("fixture-detached-private"));',
    '(async()=>{throw new Error("fixture-detached-private")})();',
    'class LocalPromise extends Promise{};LocalPromise.reject(new Error("fixture-detached-private"));',
    'Promise.resolve().then(()=>{throw new Error("fixture-detached-private")});',
  ]) {
    const result = run([custom(`function onRequest(ir){${expression}return ir;}`)]);
    assert.deepEqual(result.ir, request()); assert(result.notes[0].includes('执行失败')); assert(!JSON.stringify(result.notes).includes('fixture-detached-private'));
  }
  await new Promise(resolve => setImmediate(resolve)); process.removeListener('unhandledRejection', rejected);
  check('detached promises and promise subclasses are rejected and cannot leak unhandled rejections', () => assert.equal(unhandled, false));
  check('valid blocks stop subsequent plugins and return an explicit reason', () => {
    const result = run([custom('function onRequest(){return {block:"fixture blocked"};}'), custom('function onRequest(ir){ir.model="never";}')]);
    assert.equal(result.blocked.status, 403); assert.equal(result.blocked.message, 'fixture blocked'); assert.equal(result.notes.length, 1);
  });
  check('word masking covers all literal matches without corrupting JSON, IDs or tool keys', () => {
    const ir = request(); ir.system = 'first secret';
    ir.messages[0].blocks = [{ type: 'text', text: 'first and second and "quoted" a.b' }, { type: 'tool_use', id: 'first', name: 'second', input: { first: 'second', nested: ['first'] } }, { type: 'tool_result', toolUseId: 'first', content: [{ type: 'text', text: 'second' }] }];
    const result = run([{ id: 'word-guard', name: 'Guard', builtin: true, enabled: true, options: { words: ['first', 'second', '"quoted"', 'a.b'], action: 'mask' } }], ir);
    assert.equal(result.ir.system, '*** secret'); assert.equal(result.ir.messages[0].blocks[0].text, '*** and *** and *** ***');
    assert.equal(result.ir.messages[0].blocks[1].id, 'first'); assert.equal(result.ir.messages[0].blocks[1].name, 'second');
    assert.deepEqual(result.ir.messages[0].blocks[1].input, { first: '***', nested: ['***'] });
    assert.equal(result.ir.messages[0].blocks[2].content[0].text, '***');
    assert.equal(ir.system, 'first secret');
  });
  check('structural field names are not treated as user content by word guard', () => {
    assert.equal(run([{ id: 'word-guard', name: 'Guard', builtin: true, enabled: true, options: { words: ['role', 'blocks'], action: 'block' } }]).blocked, undefined);
  });
  check('model alias lookup does not treat inherited Object properties as aliases', () => {
    const ir = request(); ir.model = 'toString';
    assert.equal(run([{ id: 'model-map', name: 'Map', builtin: true, enabled: true, options: { mapping: {} } }], ir).ir.model, 'toString');
  });
  check('disabled invalid plugins leave requests untouched', () => {
    const result = run([{ ...custom('syntax('), enabled: false }]); assert.deepEqual(result.ir, request()); assert.deepEqual(result.notes, []);
  });
  check('actual runtime status is isolated per store, redacted and cleared when edited', () => {
    const plugin = store.savePlugin({ name: 'Failure', code: 'function onRequest(){throw new Error("fixture-sensitive-payload");}', enabled: true });
    applyMiddleware(store, request(), { agent: 'test', protocol: 'openai-chat', requestId: 'fixture' });
    const status = getMiddlewareStatus(store);
    assert.equal(status[plugin.id].status, 'error'); assert(status[plugin.id].checkedAt);
    assert(!JSON.stringify(status).includes('fixture-sensitive-payload'));
    assert.deepEqual(getMiddlewareStatus(new AuroraStore(path.join(root, 'other'))), {});
    store.savePlugin({ id: plugin.id, code: 'function onRequest(ir){return ir;}' });
    assert.equal(getMiddlewareStatus(store)[plugin.id], undefined);
    applyMiddleware(store, request(), { agent: 'test', protocol: 'openai-chat', requestId: 'fixture' });
    assert.equal(getMiddlewareStatus(store)[plugin.id].status, 'ok');
    store.deletePlugin(plugin.id); assert.equal(getMiddlewareStatus(store)[plugin.id], undefined);
  });
  check('importing replacement plugin code clears old verification only after successful import', () => {
    const plugin = store.savePlugin({ name: 'Import fixture', code: 'function onRequest(ir){return ir;}', enabled: true });
    applyMiddleware(store, request(), { agent: 'test', protocol: 'openai-chat', requestId: 'fixture' });
    assert.equal(getMiddlewareStatus(store)[plugin.id].status, 'ok');
    const before = getMiddlewareStatus(store), invalid = structuredClone(store.exportAll()); invalid.version = 0;
    assert.throws(() => store.importAll(invalid)); assert.deepEqual(getMiddlewareStatus(store), before);
    const backup = structuredClone(store.exportAll()); backup.plugins[0].code = 'function onRequest(){throw new Error("fixture-new-code");}';
    store.importAll(backup); assert.deepEqual(getMiddlewareStatus(store), {});
    applyMiddleware(store, request(), { agent: 'test', protocol: 'openai-chat', requestId: 'fixture' });
    assert.equal(getMiddlewareStatus(store)[plugin.id].status, 'error');
  });
  console.log(`\nMiddleware: ${count} checks passed.`);
} finally {
  assert(path.basename(root).startsWith('yunhui-middleware-'));
  assert.equal(fs.realpathSync(path.dirname(root)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
}
