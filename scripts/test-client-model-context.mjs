/** Selected model windows and their 90% compaction trigger are applied together. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { parse } from 'smol-toml';

const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-client-model-context-')));
const previousHome = process.env.AURORA_CLIENT_HOME;
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const read = file => fs.readFileSync(file, 'utf8');
const original = '# Original client preferences\nmodel = "previous"\nmodel_provider = "previous-provider"\nmodel_context_window = 272000\nmodel_auto_compact_token_limit = 244800\nmodel_post_turn_compact_threshold_percent = 75\nmodel_auto_compact_token_limit_scope = "body_after_prefix"\n[mcp_servers.keep]\ncommand = "fixture-tool"\n';
const policy = object => Object.fromEntries(['model_post_turn_compact_threshold_percent', 'model_auto_compact_token_limit_scope'].map(key => [key, object[key]]));
let passed = 0;

try {
  const bundle = path.join(scratch, 'adapters.cjs');
  await build({ stdin: { contents: "export {getAdapter} from './src/core/agents/adapters.ts';", resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const api = createRequire(import.meta.url)(bundle);
  const adapter = api.getAdapter('codex-cli');
  function fixture(label, text = original, contextWindow = 64000) {
    const client = path.join(scratch, label, 'client');
    process.env.AURORA_CLIENT_HOME = client;
    const config = path.join(client, '.codex', 'config.toml');
    if (text !== null) write(config, text);
    const provider = { id: 'fixture-provider', name: 'Fixture', format: 'openai-responses', baseUrl: 'https://fixture.invalid/v1', enabled: true,
      apiKeys: [{ id: 'fixture-key', label: 'Fixture', key: 'fixture-api-secret', enabled: true, weight: 1 }],
      models: [{ id: 'unselected-model', contextWindow: 1000000 }, { id: 'selected-model', ...(contextWindow === undefined ? {} : { contextWindow }) }] };
    const ctx = { provider, model: 'selected-model', gatewayUrl: 'http://127.0.0.1:3425', token: 'fixture-gateway-token', mode: 'gateway', authMode: 'api', modelCatalogPath: path.join(scratch, label, 'catalog.json') };
    return { config, client, ctx, original: text };
  }
  const preview = f => { const p = adapter.preview(f.ctx); assert.equal(p.ok, true, p.message); return p; };
  const connect = f => { const result = adapter.connect(f.ctx); assert.equal(result.ok, true, result.message); return result; };
  const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };

  check('API preview applies the selected window and 90% trigger without writing the file', () => {
    const f = fixture('preview'), p = preview(f), next = parse(p.files[0].after);
    assert.equal(read(f.config), original); assert.equal(next.model_context_window, 64000);
    assert.equal(next.model_auto_compact_token_limit, 57600);
    assert.deepEqual(policy(next), policy(parse(p.files[0].before))); assert.equal(next.mcp_servers.keep.command, 'fixture-tool');
    assert(p.warnings.some(warning => /上下文窗口/.test(warning) && /90%/.test(warning) && /重启/.test(warning)));
    assert(!JSON.stringify(p).includes('fixture-api-secret')); assert(!JSON.stringify(p).includes('fixture-gateway-token'));
  });
  check('both gateway and direct API modes update the trigger while preserving independent policies', () => {
    for (const mode of ['gateway', 'direct']) {
      const f = fixture(`apply-${mode}`); f.ctx.mode = mode; connect(f);
      const next = parse(read(f.config)); assert.equal(next.model_context_window, 64000);
      assert.equal(next.model_auto_compact_token_limit, 57600);
      assert.deepEqual(policy(next), policy(parse(original)));
      assert.equal(next.model, mode === 'gateway' ? 'fixture-provider/selected-model' : 'selected-model');
    }
  });
  check('default and custom context windows produce 90% triggers without applying an extra 95% factor', () => {
    for (const [window, limit] of [[272000, 244800], [200000, 180000], [128000, 115200], [70001, 63000], [1, 1]]) {
      const f = fixture(`ratio-${window}`, original, window); connect(f);
      const next = parse(read(f.config)); assert.equal(next.model_context_window, window); assert.equal(next.model_auto_compact_token_limit, limit);
    }
  });
  check('active profiles keep supported selections but never receive unsupported context fields', () => {
    const text = 'profile = "work.v2"\n' + original + '\n[profiles."work.v2"]\nmodel = "old-profile-model"\nmodel_provider = "old-profile-provider"\nmodel_reasoning_effort = "high"\n';
    const f = fixture('profile', text); connect(f); const next = parse(read(f.config));
    assert.equal(next.model_context_window, 64000); assert.equal(next.profiles['work.v2'].model, 'fixture-provider/selected-model');
    assert.equal(next.model_auto_compact_token_limit, 57600); assert.equal(next.profiles['work.v2'].model_auto_compact_token_limit, undefined);
    assert.equal(next.profiles['work.v2'].model_provider, 'yunhui'); assert.equal(next.profiles['work.v2'].model_reasoning_effort, 'high');
    assert.equal(next.profiles['work.v2'].model_context_window, undefined); assert.deepEqual(policy(next.profiles['work.v2']), policy({}));
    assert.deepEqual(policy(next), policy(parse(text)));
  });
  check('legacy active-profile window and trigger overrides are removed without changing other profiles', () => {
    const text = 'profile="work"\n' + original + '\n[profiles.work]\nmodel_context_window=8000\nmodel_auto_compact_token_limit=6000\nmodel_reasoning_effort="high"\n[profiles.other]\nmodel_context_window=12000\nmodel_auto_compact_token_limit=10000\n';
    const f = fixture('profile-overrides', text); connect(f); const next = parse(read(f.config));
    assert.equal(next.model_context_window, 64000); assert.equal(next.model_auto_compact_token_limit, 57600);
    assert.equal(next.profiles.work.model_context_window, undefined); assert.equal(next.profiles.work.model_auto_compact_token_limit, undefined);
    assert.equal(next.profiles.work.model_reasoning_effort, 'high'); assert.deepEqual(next.profiles.other, parse(text).profiles.other);
  });
  check('unknown or invalid selected model windows preserve existing values without borrowing another model limit', () => {
    for (const [index, value] of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '64000', null, NaN, Infinity].entries()) {
      const f = fixture(`unknown-${index}`); f.ctx.provider.models[1].contextWindow = value;
      const next = parse(preview(f).files[0].after); assert.equal(next.model_context_window, 272000); assert.equal(next.model_auto_compact_token_limit, 244800);
    }
  });
  check('new known configurations get a paired trigger; unknown windows do not invent either value', () => {
    const known = fixture('new-known', null); connect(known); const next = parse(read(known.config));
    assert.equal(next.model_context_window, 64000); assert.deepEqual(policy(next), policy({}));
    assert.equal(next.model_auto_compact_token_limit, 57600);
    const unknown = fixture('new-unknown', null); delete unknown.ctx.provider.models[1].contextWindow;
    connect(unknown); assert.equal(parse(read(unknown.config)).model_context_window, undefined);
    assert.equal(parse(read(unknown.config)).model_auto_compact_token_limit, undefined);
  });
  check('coexistence removes stale global overrides so catalog models use their own windows and triggers', () => {
    const f = fixture('coexist'); f.ctx.authMode = 'coexist';
    const auth = path.join(f.client, '.codex', 'auth.json');
    const token = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
    const originalAuth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'fixture-refresh-private', account_id: 'fixture-account' } });
    write(auth, originalAuth); const p = preview(f); assert.equal(parse(p.files[0].after).model_context_window, undefined);
    connect(f); const next = parse(read(f.config)); assert.equal(next.model_context_window, undefined); assert.equal(next.model_auto_compact_token_limit, undefined);
    assert.deepEqual(policy(next), policy(parse(original))); assert.equal(read(auth), originalAuth);
    assert.equal(next.model_provider, 'openai'); assert.equal(next.model_catalog_json, f.ctx.modelCatalogPath);
  });
  check('a selected window change after preview invalidates the reviewed revision before any write', () => {
    const f = fixture('stale-preview'), p = preview(f);
    f.ctx.expectedRevision = p.revision; f.ctx.provider.models[1].contextWindow = 128000;
    const result = adapter.connect(f.ctx); assert.equal(result.ok, false); assert.match(result.message, /预览后已变化/);
    assert.equal(read(f.config), original);
  });
  check('reconfiguration keeps the first backup and disconnect restores exact original context and policy bytes', () => {
    const f = fixture('restore'), first = connect(f);
    f.ctx.previousBackup = first.backup; f.ctx.provider.models[1].contextWindow = 128000;
    const second = connect(f); assert.equal(parse(read(f.config)).model_context_window, 128000);
    assert.equal(parse(read(f.config)).model_auto_compact_token_limit, 115200);
    const result = adapter.disconnect(second.backup); assert.equal(result.ok, true, result.message);
    assert.equal(read(f.config), original);
  });
  console.log(`Client model context: ${passed} tests passed`);
} finally {
  if (previousHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = previousHome;
  const relative = path.relative(fs.realpathSync(os.tmpdir()), scratch);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  fs.rmSync(scratch, { recursive: true, force: true });
}
