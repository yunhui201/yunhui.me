/** Opt-in real Codex binary integration: fake OAuth, disposable homes, loopback-only services. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

const workspace = path.resolve(import.meta.dirname, '..');
const candidates = process.env.AURORA_NATIVE_CODEX ? [process.env.AURORA_NATIVE_CODEX] : (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'));
const cli = candidates.find(file => fs.existsSync(file) && fs.statSync(file).isFile());
assert.ok(cli, 'Set AURORA_NATIVE_CODEX to an installed Codex executable; this optional test never downloads or installs one.');
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-coexist-native-')));
const clientHome = path.join(scratch, 'client'), codexHome = path.join(clientHome, '.codex'), work = path.join(scratch, 'work');
for (const dir of [codexHome, work, path.join(clientHome, 'AppData', 'Roaming'), path.join(clientHome, 'AppData', 'Local')]) fs.mkdirSync(dir, { recursive: true });
const originalClientHome = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = clientHome;
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())));
Object.assign(childEnv, { CODEX_HOME: codexHome, USERPROFILE: clientHome, HOME: clientHome, APPDATA: path.join(clientHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(clientHome, 'AppData', 'Local'), TEMP: scratch, TMP: scratch });
const blocked = [], supplierCalls = [], officialCalls = [];
const denyProxy = http.createServer((req, res) => { blocked.push(String(req.url).split('?')[0]); res.writeHead(403); res.end('External network blocked by isolated test'); });
denyProxy.on('connect', (req, socket) => { blocked.push(String(req.url)); socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); });
await new Promise(resolve => denyProxy.listen(0, '127.0.0.1', resolve));
const proxy = `http://127.0.0.1:${denyProxy.address().port}`;
Object.assign(childEnv, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' });
const version = spawnSync(cli, ['--version'], { cwd: work, env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 15000 });
assert.equal(version.status, 0, version.stderr); console.log(version.stdout.trim());
let gateway;
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const claims = { sub: 'fixture-user', email: 'fixture@example.test', exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_user_id: 'fixture-user', chatgpt_plan_type: 'pro' } };
const fakeToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.fixture-signature`;
const authFile = path.join(codexHome, 'auth.json');
const authText = JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: fakeToken, access_token: fakeToken, refresh_token: 'fixture-refresh-not-valid', account_id: 'fixture-account' }, last_refresh: new Date().toISOString() });
fs.writeFileSync(authFile, authText);
const nativeModel = { slug: 'gpt-fixture', display_name: 'Fixture Model', description: 'Isolated fixture model', base_instructions: 'Return the fixture response. Do not call tools.', default_reasoning_level: 'none', supported_reasoning_levels: [{ effort: 'none', description: 'Fixture' }], shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1, additional_speed_tiers: [], service_tiers: [], availability_nux: null, upgrade: null, support_verbosity: false, default_verbosity: null, truncation_policy: { mode: 'tokens', limit: 10000 }, context_window: 65536, max_context_window: 65536, effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ['text'], supports_search_tool: false, supports_parallel_tool_calls: false, supports_reasoning_summaries: false, prefer_websockets: false, available_in_plans: ['pro'] };
fs.writeFileSync(path.join(codexHome, 'models_cache.json'), JSON.stringify({ fetched_at: new Date().toISOString(), client_version: version.stdout.trim().replace(/^codex-cli /, ''), models: [nativeModel] }));
const sendResponse = (res, model, answer) => {
  const response = { id: 'resp_fixture', object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'in_progress', output: [] };
  const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: answer, annotations: [] }] };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = value => res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
  event({ type: 'response.created', response });
  event({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
  event({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  event({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer });
  event({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: answer });
  event({ type: 'response.content_part.done', item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  event({ type: 'response.output_item.done', output_index: 0, item });
  event({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, input_tokens_details: { cached_tokens: 0 } } } });
  res.end();
};
const mock = (calls, answer) => http.createServer(async (req, res) => { try { const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); calls.push({ path: req.url, headers: req.headers, body }); sendResponse(res, body.model, answer); } catch { res.writeHead(400); res.end(); } });
const supplierMock = mock(supplierCalls, 'RELAY_NATIVE_OK'), officialMock = mock(officialCalls, 'OFFICIAL_NATIVE_OK');
await Promise.all([new Promise(resolve => supplierMock.listen(0, '127.0.0.1', resolve)), new Promise(resolve => officialMock.listen(0, '127.0.0.1', resolve))]);
let invocation = 0;
const runCli = async (model, { profile, allowFailure = false } = {}) => {
  const output = path.join(scratch, `answer-${++invocation}.txt`);
  const args = ['exec', '--strict-config', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '--sandbox', 'read-only', '--json', '--color', 'never', '--cd', work, ...(profile ? ['--profile', profile] : []), ...(model ? ['-m', model] : []), '--output-last-message', output, 'Return the fixture answer without using any tools.'];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd: work, env: childEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Native CLI timed out: ${stderr.slice(-5000)}`)); }, 45000);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-100000); }); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-100000); });
    child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  if (allowFailure && result.code !== 0) return { ...result, answer: '' };
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.ok(fs.existsSync(output), JSON.stringify(result)); return { ...result, answer: fs.readFileSync(output, 'utf8').trim() };
};
try {
  const bundle = path.join(scratch, 'core.cjs');
  await build({ stdin: { contents: ['gateway/coexist', 'gateway/server', 'gateway/upstream', 'store/index', 'agents/adapters'].map(file => `export * from './src/core/${file}.ts';`).join('\n'), resolveDir: workspace, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  const m = createRequire(import.meta.url)(bundle), store = new m.AuroraStore(path.join(scratch, 'store'));
  store.saveSettings({ gatewayHost: '127.0.0.1', gatewayToken: 'fixture-native-gateway-token', maskSecrets: false, maxRetries: 0 });
  const supplier = store.saveProvider({ name: 'Native Fixture Relay', baseUrl: `http://127.0.0.1:${supplierMock.address().port}/v1`, format: 'openai-responses', enabled: true, models: [{ id: 'gpt-fixture', contextWindow: 65536 }], apiKeys: [{ id: 'fixture', label: 'Fixture', key: 'fixture-supplier-key', enabled: true, weight: 1 }] });
  store.saveAgent({ id: 'codex-cli', connected: true, mode: 'gateway', authMode: 'coexist', providerId: supplier.id, model: 'gpt-fixture' });
  gateway = new m.GatewayServer({ store, officialTransport: (url, options) => { assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses'); return m.openUpstream(`http://127.0.0.1:${officialMock.address().port}/responses`, options); } });
  await gateway.start('127.0.0.1', 0); store.saveSettings({ gatewayPort: gateway.getStatus().port });
  const catalog = m.getCoexistCatalog(store), catalogFile = path.join(store.dir, 'codex-model-catalog.json');
  fs.writeFileSync(catalogFile, JSON.stringify(catalog.nativeCatalog));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n');
  const adapter = m.getAdapter('codex-cli'), context = { provider: supplier, model: 'gpt-fixture', gatewayUrl: `http://127.0.0.1:${gateway.getStatus().port}`, token: store.getSettings().gatewayToken, mode: 'gateway', authMode: 'coexist', modelCatalogPath: catalogFile };
  // Exercise API mode through the same adapter used by the desktop wizard.
  // No CLI model, endpoint or authentication override is supplied: the binary
  // must load all three from the generated config.toml without any saved
  // official login. Both upstreams remain loopback-only.
  fs.unlinkSync(authFile);
  const apiContext = { ...context, authMode: 'api' };
  const apiPreview = adapter.preview(apiContext); assert.equal(apiPreview.ok, true, apiPreview.message);
  const apiApplied = adapter.connect({ ...apiContext, expectedRevision: apiPreview.revision }); assert.equal(apiApplied.ok, true, apiApplied.message);
  const apiConfig = parseToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
  assert.equal(apiConfig.model_provider, 'yunhui'); assert.ok(apiConfig.model_providers.yunhui); assert.equal(apiConfig.model_providers.aurora, undefined);
  const gatewayResult = await runCli();
  assert.equal(gatewayResult.answer, 'RELAY_NATIVE_OK'); assert.equal(supplierCalls.length, 1); assert.equal(officialCalls.length, 0);
  assert.equal(supplierCalls[0].path, '/v1/responses'); assert.equal(supplierCalls[0].body.model, 'gpt-fixture');
  assert.equal(supplierCalls[0].headers.authorization, 'Bearer fixture-supplier-key');
  assert.ok(!JSON.stringify(supplierCalls).includes(fakeToken)); assert.ok(!JSON.stringify(supplierCalls).includes(context.token));
  assert.equal(fs.existsSync(authFile), false);
  assert.equal(adapter.disconnect(apiApplied.backup).ok, true);
  console.log('PASS real CLI without auth.json loads API gateway URL, key and default model from generated config; relay receives only its own key');
  supplierCalls.length = 0;

  const directContext = { ...apiContext, mode: 'direct', provider: { ...supplier, baseUrl: `http://127.0.0.1:${supplierMock.address().port}/proxy` } };
  const directPreview = adapter.preview(directContext); assert.equal(directPreview.ok, true, directPreview.message);
  const directApplied = adapter.connect({ ...directContext, expectedRevision: directPreview.revision }); assert.equal(directApplied.ok, true, directApplied.message);
  const directConfig = parseToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
  assert.equal(directConfig.model_provider, 'yunhui'); assert.equal(directConfig.model_providers.yunhui.base_url, directContext.provider.baseUrl + '/v1');
  const gatewayPort = gateway.getStatus().port;
  await gateway.stop();
  const directResult = await runCli();
  assert.equal(directResult.answer, 'RELAY_NATIVE_OK'); assert.equal(supplierCalls.length, 1); assert.equal(officialCalls.length, 0);
  assert.equal(supplierCalls[0].path, '/proxy/v1/responses'); assert.equal(supplierCalls[0].body.model, 'gpt-fixture');
  assert.equal(supplierCalls[0].headers.authorization, 'Bearer fixture-supplier-key');
  assert.ok(!JSON.stringify(supplierCalls).includes(fakeToken)); assert.ok(!JSON.stringify(supplierCalls).includes(context.token));
  assert.equal(fs.existsSync(authFile), false);
  assert.equal(adapter.disconnect(directApplied.backup).ok, true);
  console.log('PASS real CLI without auth.json loads supplier URL, key and default model from generated direct config while the gateway is stopped');
  supplierCalls.length = 0;
  await gateway.start('127.0.0.1', gatewayPort);
  fs.writeFileSync(authFile, authText);

  const preview = adapter.preview(context); assert.equal(preview.ok, true, preview.message);
  const applied = adapter.connect({ ...context, expectedRevision: preview.revision }); assert.equal(applied.ok, true, applied.message);
  const relay = await runCli(`${supplier.id}/gpt-fixture`);
  assert.equal(relay.answer, 'RELAY_NATIVE_OK'); assert.equal(supplierCalls.length, 1); assert.equal(officialCalls.length, 0); assert.equal(supplierCalls[0].body.model, 'gpt-fixture'); assert.equal(supplierCalls[0].headers.authorization, 'Bearer fixture-supplier-key'); assert.ok(!JSON.stringify(supplierCalls).includes(fakeToken)); assert.ok(!JSON.stringify(supplierCalls).includes('fixture-account'));
  console.log('PASS real CLI accepts adapter-generated strict config and routes relay model through Aurora without OAuth leakage');
  const official = await runCli('official/gpt-fixture');
  assert.equal(official.answer, 'OFFICIAL_NATIVE_OK'); assert.equal(officialCalls.length, 1); assert.equal(supplierCalls.length, 1); assert.equal(officialCalls[0].body.model, 'gpt-fixture'); assert.equal(officialCalls[0].headers.authorization, `Bearer ${fakeToken}`);
  console.log('PASS real CLI switches to the official model branch using only the loopback mock transport');
  assert.equal(fs.readFileSync(authFile, 'utf8'), authText); assert.equal(fs.readFileSync(catalogFile, 'utf8'), JSON.stringify(catalog.nativeCatalog));
  console.log('PASS fake OAuth file and managed model catalog remain unchanged');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\nprofile = "work.v2"\n[profiles."work.v2"]\nmodel = "stale-profile-model"\nmodel_provider = "stale-profile-provider"\nopenai_base_url = "http://127.0.0.1:9"\n');
  const profilePreview = adapter.preview(context); assert.equal(profilePreview.ok, true, profilePreview.message);
  const profileApplied = adapter.connect({ ...context, expectedRevision: profilePreview.revision }); assert.equal(profileApplied.ok, true, profileApplied.message);
  const profileConfig = parseToml(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
  assert.equal(profileConfig.profiles['work.v2'].openai_base_url, undefined); assert.equal(profileConfig.profiles['work.v2'].model_catalog_json, undefined);
  // Probe the old nested catalog field independently; no real account or network is involved.
  profileConfig.profiles['work.v2'].model_catalog_json = catalogFile;
  fs.writeFileSync(path.join(codexHome, 'config.toml'), stringifyToml(profileConfig));
  const nestedCatalog = await runCli(undefined, { allowFailure: true });
  if (nestedCatalog.code !== 0) assert.match(nestedCatalog.stderr, /unknown configuration field `profiles\.work\.v2\.model_catalog_json`|legacy `profile = .*config is no longer supported/);
  delete profileConfig.profiles['work.v2'].model_catalog_json;
  fs.writeFileSync(path.join(codexHome, 'config.toml'), stringifyToml(profileConfig));
  const profileRun = await runCli(undefined, { allowFailure: true });
  let checks = 4;
  if (profileRun.code !== 0) {
    assert.match(profileRun.stderr, /legacy `profile = .*config is no longer supported/);
    console.log('LIMITATION this CLI rejects legacy active-profile tables; no native inference was attempted for that configuration');
    const profileValue = profileConfig.profiles['work.v2']; delete profileConfig.profile; delete profileConfig.profiles;
    fs.writeFileSync(path.join(codexHome, 'config.toml'), stringifyToml(profileConfig));
    fs.writeFileSync(path.join(codexHome, 'work.config.toml'), stringifyToml(profileValue));
    const modernProfile = await runCli(undefined, { profile: 'work' }); assert.equal(modernProfile.answer, 'RELAY_NATIVE_OK');
    console.log('PASS actual CLI file-based profile inherits the root coexistence transport and model catalog');
    fs.writeFileSync(path.join(codexHome, 'config.toml'), stringifyToml({ cli_auth_credentials_store: 'file', model: `${supplier.id}/gpt-fixture`, model_provider: 'fixture-direct', model_catalog_json: catalogFile,
      model_providers: { 'fixture-direct': { name: 'Root fixture provider', base_url: `http://127.0.0.1:${supplierMock.address().port}/v1`, wire_api: 'responses', requires_openai_auth: true } } }));
    fs.writeFileSync(path.join(codexHome, 'work.config.toml'), stringifyToml({ model_providers: { 'fixture-direct': { name: 'Profile fixture provider', requires_openai_auth: false } } }));
    const mergedProfile = await runCli(undefined, { profile: 'work' }); assert.equal(mergedProfile.answer, 'RELAY_NATIVE_OK');
    assert.equal(supplierCalls.at(-1).headers.authorization, undefined); assert.equal(supplierCalls.at(-1).body.model, `${supplier.id}/gpt-fixture`);
    console.log('PASS modern profile provider fields merge: root base_url survives, profile requires_openai_auth=false prevents OAuth forwarding');
    checks++;
  } else { assert.equal(profileRun.answer, 'RELAY_NATIVE_OK'); console.log('PASS actual CLI accepts legacy quoted active profile after root-only transport/catalog correction'); }
  assert.equal(supplierCalls.length, checks - 2); assert.equal(officialCalls.length, 1);
  assert.equal(fs.readFileSync(authFile, 'utf8'), authText);
  console.log(`Native client routing: ${checks + 2} checks passed (API gateway, direct and coexistence); denied external background connections: ${blocked.length}`);
} finally {
  if (gateway) await gateway.stop();
  for (const server of [supplierMock, officialMock, denyProxy]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (originalClientHome === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = originalClientHome;
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir())); assert.ok(path.basename(scratch).startsWith('aurora-coexist-native-'));
  fs.rmSync(scratch, { recursive: true, force: true });
}
