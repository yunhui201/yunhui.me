import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import http from 'node:http';

const workspace = path.resolve(import.meta.dirname, '..');
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-client-test-'));
const originalProfile = process.env.AURORA_CLIENT_HOME;
process.env.AURORA_CLIENT_HOME = isolated;
let passed = 0;
function check(label, fn) { fn(); passed++; console.log(`PASS ${label}`); }
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const read = file => fs.readFileSync(file, 'utf8');
try {
  const bundle = path.join(isolated, 'test-api.cjs');
  await build({ stdin: { contents: `export * from './src/core/agents/adapters.ts'; export * from './src/core/codex.ts'; export * from './src/core/sessions.ts'; export * from './src/core/store/index.ts'; export * from './src/core/actions.ts'; export * from './src/core/protocol/index.ts';`, resolveDir: workspace, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  for (const [input, output] of [['src/core/readOnlyWorker.ts', 'read-only-worker.cjs'], ['src/core/agents/detectionWorker.ts', 'detection-worker.cjs']]) {
    await build({ entryPoints: [path.join(workspace, input)], outfile: path.join(isolated, output), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  }
  const api = createRequire(import.meta.url)(bundle);
  const provider = { id: 'prov_test', name: '测试供应商', format: 'openai-chat', baseUrl: 'https://example.com/v1', enabled: true, priority: 1, apiKeys: [{ id: 'key_test', label: '测试', key: 'sk-original-secret', enabled: true, weight: 1 }], models: [{ id: 'model-one' }, { id: 'model-two' }], createdAt: '', updatedAt: '' };
  const context = { provider, model: 'model-one', mode: 'gateway', gatewayUrl: 'http://127.0.0.1:3425', token: 'gateway-secret-0123456789' };
  const codex = api.getAdapter('codex-cli'), claude = api.getAdapter('claude-code'), desktop = api.getAdapter('claude-desktop'), gemini = api.getAdapter('gemini-cli');
  const codexFile = codex.configPaths()[0];
  const original = '# keep this comment\nmodel = "old"\nmodel_reasoning_effort = "high"\n\n[projects."D:/important"]\ntrust_level = "trusted"\nmodel = "project-model"\n\n[mcp_servers.example]\ncommand = "npx"\nargs = ["example"]\n';
  write(codexFile, original);
  const pre = codex.preview(context);
  check('Codex preview has no write and hides credentials', () => { assert(pre.ok, pre.message); assert.equal(read(codexFile), original); assert(pre.revision); assert(!pre.files[0].after.includes(context.token)); assert(!pre.warnings.some(message => message.includes('旧版供应商配置表与历史会话保留'))); });
  const connected = codex.connect({ ...context, expectedRevision: pre.revision });
  check('Codex keeps top-level values, comments and unrelated tables', () => { assert(connected.ok, connected.message); const text = read(codexFile); assert(text.includes('# keep this comment')); assert(text.includes('model_provider = "yunhui"')); assert(text.indexOf('model_provider = "yunhui"') < text.indexOf('[projects.')); assert(text.includes('model = "project-model"')); assert(text.includes('requires_openai_auth = false')); assert(text.includes('stream_idle_timeout_ms = 300000')); assert(!text.includes('/v1/v1')); });
  const toml = spawnSync('python', ['-c', 'import sys,tomllib,json; print(json.dumps(tomllib.loads(sys.stdin.read())))'], { input: read(codexFile), encoding: 'utf8' });
  check('Generated Codex config parses independently as valid TOML', () => { assert.equal(toml.status, 0, toml.stderr); const value = JSON.parse(toml.stdout); assert.equal(value.model, 'prov_test/model-one'); assert.equal(value.model_provider, 'yunhui'); assert.equal(value.model_providers.yunhui.requires_openai_auth, false); assert.equal(typeof value.model_providers.yunhui.stream_idle_timeout_ms, 'number'); assert.equal(value.projects['D:/important'].model, 'project-model'); });
  const second = codex.connect({ ...context, model: 'model-two', previousBackup: connected.backup });
  check('Repeated switches restore the first original configuration', () => { assert(second.ok, second.message); assert(api.getAdapter('codex-desktop').disconnect(second.backup).ok); assert.equal(read(codexFile), original); });
  const stale = codex.preview(context);
  write(codexFile, original + '\n# edited after preview\n');
  check('A stale preview is rejected without overwriting external changes', () => { const r = codex.connect({ ...context, expectedRevision: stale.revision }); assert(!r.ok); assert(read(codexFile).includes('edited after preview')); });
  write(codexFile, original);
  const beforeExternal = codex.connect(context);
  write(codexFile, read(codexFile) + '\n# another app edited\n');
  check('Restore does not erase later edits', () => { assert(!codex.disconnect(beforeExternal.backup).ok); assert(read(codexFile).includes('another app edited')); });
  write(codexFile, original);
  const claudeFile = claude.configPaths()[0];
  const claudeOriginal = JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] }, env: { OTHER: 'keep', ANTHROPIC_API_KEY: 'old-private-key' }, mcpServers: { keep: { env: { PASSWORD: 'another-secret' } } } });
  write(claudeFile, claudeOriginal);
  check('Preview hides old credentials and MCP secrets', () => { const p = claude.preview(context); assert(p.ok); assert(!JSON.stringify(p).includes('old-private-key')); assert(!JSON.stringify(p).includes('another-secret')); });
  const cc = claude.connect(context);
  check('Claude Code preserves permissions and writes all role mappings', () => { assert(cc.ok, cc.message); const settings = JSON.parse(read(claudeFile)); assert.equal(settings.env.OTHER, 'keep'); assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'prov_test/model-one'); assert(!('ANTHROPIC_API_KEY' in settings.env)); assert.deepEqual(settings.permissions.deny, ['Bash(rm:*)']); });
  check('Claude restores original key and file exactly', () => { assert(claude.disconnect(cc.backup).ok); assert.equal(read(claudeFile), claudeOriginal); });
  write(claudeFile, '{ broken json');
  check('Malformed existing JSON is not silently replaced', () => { const r = claude.connect(context); assert(!r.ok); assert.equal(read(claudeFile), '{ broken json'); });
  write(claudeFile, claudeOriginal);
  check('Direct protocol mismatch is rejected', () => assert(!claude.preview({ ...context, mode: 'direct' }).ok));
  check('Compatible base URL does not double append version', () => { const params = api.connectionParameters({ ...context, mode: 'direct' }, 'openai-chat'); assert.equal(params.baseUrl, 'https://example.com/v1'); });
  check('Native SDK operation paths match upstream tests for roots, prefixes and explicit versions', () => {
    const ir = api.parseClientRequest('openai-chat', { model: 'model-one', messages: [{ role: 'user', content: 'fixture' }], stream: false });
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic', 'gemini']) {
      const paths = protocol === 'gemini' ? ['', '/proxy', '/v1beta', '/proxy/v1beta/', '/proxy/v1', '/proxy/v1alpha'] : ['', '/proxy', '/v1', '/proxy/v1/'];
      for (const pathname of paths) {
        const baseUrl = 'https://fixture.invalid' + pathname;
        const ep = api.connectionParameters({ ...context, mode: 'direct', provider: { ...provider, format: protocol, baseUrl } }, protocol);
        // Actual SDK resource paths: Anthropic /v1/messages; Google SDK
        // baseUrl + apiVersion + models/...; OpenAI appends only the operation.
        const operation = protocol === 'anthropic' ? '/v1/messages' : protocol === 'gemini' ? `/${ep.apiVersion}/models/model-one:generateContent` : protocol === 'openai-responses' ? '/responses' : '/chat/completions';
        assert.equal(ep.baseUrl + operation, api.buildUpstreamHttp(ir, { baseUrl, apiKey: 'fixture', format: protocol, model: 'model-one' }, protocol).url, `${protocol}: ${pathname}`);
      }
    }
  });
  check('Unsupported Claude native versions and URL query or fragment are rejected before writing', () => {
    for (const pathname of ['/proxy/v2', '/proxy/v1beta', '/proxy/V1', '/proxy?key=fixture', '/proxy#fragment']) {
      const bad = { ...context, mode: 'direct', provider: { ...provider, format: 'anthropic', baseUrl: 'https://fixture.invalid' + pathname } };
      assert.equal(claude.preview(bad).ok, false); assert.equal(claude.connect(bad).ok, false);
    }
    assert.equal(read(claudeFile), claudeOriginal);
  });
  check('Adapter and exported parameters reject direct custom headers and proxy settings', () => {
    for (const patch of [{ provider: { ...provider, headers: { 'X-Required': 'fixture' } } }, { provider: { ...provider, proxy: 'http://127.0.0.1:1234' } }, { globalProxy: 'http://127.0.0.1:1234' }]) {
      const direct = { ...context, ...patch, mode: 'direct' };
      assert.throws(() => api.connectionParameters(direct, 'openai-chat'), /本地网关/);
      assert.equal(api.getAdapter('workbuddy').preview(direct).ok, false);
      const native = { ...direct, provider: { ...direct.provider, format: 'openai-responses' } };
      assert.equal(codex.preview(native).ok, false); assert.equal(codex.connect(native).ok, false);
    }
    assert.equal(read(codexFile), original);
  });
  check('Shared programming configuration is independent of desktop discovery; WorkBuddy stays manual', () => { const shared = api.getAdapter('chatgpt-desktop'); assert.equal(shared.support, 'automatic'); const planned = shared.preview(context); assert(planned.ok, planned.message); assert.equal(planned.files[0].path, codexFile); assert(planned.warnings.some(w => w.includes('共享编程配置'))); assert.equal(api.getAdapter('codex-desktop').id, 'chatgpt-desktop'); assert.equal(api.AGENT_ADAPTERS.filter(a => ['codex-desktop', 'chatgpt-desktop'].includes(a.id)).length, 1); const manual = api.getAdapter('workbuddy').preview(context); assert(manual.ok); assert.equal(manual.files.length, 0); assert(manual.manual); assert(!api.getAdapter('workbuddy').connect(context).ok); });
  const desktopPaths = desktop.configPaths();
  write(desktopPaths[0], JSON.stringify({ deploymentMode: '1p', userPreference: true }));
  write(desktopPaths[2], JSON.stringify({ appliedId: 'existing', entries: [{ id: 'existing', name: 'Existing profile' }] }));
  const d = desktop.connect(context);
  check('Claude Desktop writes real 3P profiles and preserves other profiles', () => { assert(d.ok, d.message); const profile = JSON.parse(read(desktopPaths[3])); assert.equal(profile.inferenceProvider, 'gateway'); assert.equal(profile.inferenceGatewayBaseUrl, 'http://127.0.0.1:3425/claude-desktop'); assert(profile.inferenceModels.some(x => x.name === 'claude-sonnet-aurora')); assert.equal(profile.coworkEgressAllowedHosts, undefined); assert(JSON.parse(read(desktopPaths[2])).entries.some(x => x.id === 'existing')); assert(JSON.parse(read(desktopPaths[0])).userPreference); });
  check('Multi-file restore removes only newly created profiles and restores previous selection', () => { assert(desktop.disconnect(d.backup).ok); assert(!fs.existsSync(desktopPaths[1])); assert(!fs.existsSync(desktopPaths[3])); assert.equal(JSON.parse(read(desktopPaths[2])).appliedId, 'existing'); assert.equal(JSON.parse(read(desktopPaths[0])).deploymentMode, '1p'); });
  const [geminiFile, envFile] = gemini.configPaths();
  write(geminiFile, JSON.stringify({ security: { other: true }, model: { maxSessionTurns: 20 } })); write(envFile, 'CUSTOM=preserve\nGEMINI_API_KEY=old-secret\n');
  const g = gemini.connect(context);
  check('Gemini uses supported .env and auth settings while preserving others', () => { assert(g.ok, g.message); assert(read(envFile).includes('CUSTOM=preserve')); assert.match(read(envFile), /GOOGLE_GENAI_API_VERSION="v1beta"/); assert.equal(JSON.parse(read(geminiFile)).security.auth.selectedType, 'gemini-api-key'); assert.equal(JSON.parse(read(geminiFile)).model.maxSessionTurns, 20); assert(gemini.disconnect(g.backup).ok); });
  check('Gemini direct config and exported script pin the requested API version and restore it', () => {
    const before = read(envFile), direct = { ...context, mode: 'direct', provider: { ...provider, format: 'gemini', baseUrl: 'https://fixture.invalid/proxy/v1' } };
    const result = gemini.connect(direct); assert.equal(result.ok, true, result.message);
    assert.match(read(envFile), /GOOGLE_GEMINI_BASE_URL="https:\/\/fixture.invalid\/proxy"/);
    assert.match(read(envFile), /GOOGLE_GENAI_API_VERSION="v1"/);
    assert.match(api.exportEnvScript(direct, 'gemini', 'darwin'), /export GOOGLE_GENAI_API_VERSION='v1'/);
    assert.equal(gemini.disconnect(result.backup).ok, true); assert.equal(read(envFile), before);
  });
  write(codexFile, original);
  const store = new api.AuroraStore(path.join(isolated, 'store'));
  check('New profiles start empty and keep the same token across restarts', () => { assert.equal(store.listProviders().length, 0); assert.equal(new api.AuroraStore(store.dir).getSettings().gatewayToken, store.getSettings().gatewayToken); });
  const legacyDir = path.join(isolated, 'legacy-store');
  write(path.join(legacyDir, 'settings.json'), JSON.stringify({ theme: 'light', gatewayPort: 3499, autoCheckUpdate: false, closeToTray: false }));
  check('Partial legacy settings persist a missing token before returning it', () => { const legacy = new api.AuroraStore(legacyDir); const first = legacy.getSettings().gatewayToken; assert(first); assert.equal(legacy.getSettings().gatewayToken, first); assert.equal(new api.AuroraStore(legacyDir).getSettings().gatewayToken, first); assert.equal(JSON.parse(read(path.join(legacyDir, 'settings.json'))).gatewayToken, first); });
  const savedProvider = store.saveProvider({...provider,id:undefined});
  const historyHome = path.join(isolated, '.codex');
  const deps = { store, dataDir: store.dir, gatewayStatus: () => ({ running: true }), gatewayUrl: () => context.gatewayUrl,
    historyContext: { home: historyHome, sqliteHome: historyHome, blockingProcesses: async () => [] } };
  for (const setting of ['headers', 'providerProxy', 'globalProxy']) {
    const blockedProvider = store.saveProvider({ ...provider, id: undefined, format: 'openai-responses', ...(setting === 'headers' ? { headers: { 'X-Required': 'fixture' } } : setting === 'providerProxy' ? { proxy: 'http://127.0.0.1:1234' } : {}) });
    if (setting === 'globalProxy') store.saveSettings({ proxy: 'http://127.0.0.1:1234' });
    const before = read(codexFile), states = JSON.stringify(store.listAgents());
    for (const action of ['agent.preview', 'agent.parameters', 'agent.connect']) {
      const result = await api.runAction(deps, action, { agentId: 'codex-cli', providerId: blockedProvider.id, model: 'model-one', mode: 'direct', globalProxy: '', proxy: '', headers: {} });
      assert.equal(result.ok, false, action); assert.match(result.message, /本地网关/);
    }
    check(`RPC refuses direct ${setting} without config or state writes despite payload overrides`, () => { assert.equal(read(codexFile), before); assert.equal(JSON.stringify(store.listAgents()), states); });
    store.saveSettings({ proxy: '' });
  }
  const rpcPreview = await api.runAction(deps, 'agent.preview', { agentId: 'codex-cli', providerId: savedProvider.id, model: 'model-one' });
  const rpcConnect = await api.runAction(deps, 'agent.connect', { agentId: 'codex-cli', providerId: savedProvider.id, model: 'model-one', revision: rpcPreview.revision });
  check('Shared RPC keeps Codex CLI and desktop state synchronized', () => { assert(rpcConnect.ok, rpcConnect.message); assert(store.listAgents()['codex-cli'].connected); assert(store.listAgents()['codex-desktop'].connected); });
  const rpcDisconnect = await api.runAction(deps, 'agent.disconnect', { agentId: 'codex-desktop' });
  check('Shared RPC restores across Codex entry points', () => { assert(rpcDisconnect.ok, rpcDisconnect.message); assert(!store.listAgents()['codex-cli'].connected); assert.equal(read(codexFile), original); });
  check('Configuration is durable before save returns and built-in plugin IDs survive', () => { store.saveSettings({ theme: 'light' }); store.savePlugin({ id: 'word-guard', builtin: true, enabled: true, name: 'Guard' }); const loaded = new api.AuroraStore(store.dir); assert.equal(loaded.listPlugins()[0].id, 'word-guard'); assert.equal(loaded.getSettings().theme, 'light'); assert(loaded.getSettings().gatewayToken.length >= 16); assert.throws(() => loaded.saveSettings({ gatewayToken: '' })); });
  check('MCP disable preserves TOML table boundaries and toggles back', () => { assert(api.toggleCodexAsset('mcp:example', false).ok); let text = read(codexFile); assert(text.includes('[mcp_servers.example]')); assert(text.includes('enabled = false')); assert.equal(api.listCodexAssets().find(x => x.id === 'mcp:example').enabled, false); assert(api.toggleCodexAsset('mcp:example', true).ok); assert.equal(api.listCodexAssets().find(x => x.id === 'mcp:example').enabled, true); });
  write(path.join(isolated, '.codex', 'skills', 'test-skill', 'SKILL.md'), '# Test skill');
  check('Skill disable uses supported config and never renames skill folders', () => { assert(api.toggleCodexAsset('skill:test-skill', false).ok); assert(fs.existsSync(path.join(isolated, '.codex', 'skills', 'test-skill', 'SKILL.md'))); assert.equal(api.listCodexAssets().find(x => x.id === 'skill:test-skill').enabled, false); assert(api.toggleCodexAsset('skill:test-skill', true).ok); assert.equal(api.listCodexAssets().find(x => x.id === 'skill:test-skill').enabled, true); });
  check('Codex flags validate type, use the correct table and remove empty values', () => { assert(!api.writeCodexFlag('model_context_window', '0').ok); assert(!api.writeCodexFlag('model_reasoning_effort', 'invented').ok); assert(api.writeCodexFlag('sandbox_workspace_write.network_access', 'true').ok); assert.equal(api.readTomlValue('sandbox_workspace_write.network_access'), 'true'); assert(api.writeCodexFlag('model_reasoning_effort', '').ok); assert.equal(api.readTomlValue('model_reasoning_effort'), undefined); });
  const id = '12345678-1234-4234-8234-123456789abc';
  const sessionFile = path.join(isolated, '.codex', 'sessions', '2026', '11', '15', `rollout-2026-11-15-${id}.jsonl`);
  write(sessionFile, [{ type: 'session_meta', payload: { id, cwd: 'D:/demo' } }, { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build a useful client' }] } }, { type: 'response_item', payload: { type: 'function_call', name: 'read_file', arguments: '{}' } }].map(x => JSON.stringify(x)).join('\n'));
  write(path.join(isolated, '.gemini', 'tmp', 'project', 'chats', 'session-example.json'), JSON.stringify({ sessionId: 'gemini-session-id', messages: [{ type: 'user', content: [{ text: 'Hello Gemini' }] }, { type: 'gemini', content: 'Hello' }] }));
  check('Session metadata supplies the real resume ID and tool calls are readable', () => { const sessions = api.scanSessions(); const s = sessions.find(x => x.agent === 'Codex'); assert.equal(s.id, id); assert.equal(api.resumeCommand(s), `codex resume ${id}`); assert(api.readSession(sessionFile).some(x => x.toolName === 'read_file')); assert(sessions.some(x => x.agent === 'Gemini CLI' && x.title === 'Hello Gemini')); });
  check('History cannot read arbitrary files or emit shell injection in resume commands', () => { const elsewhere = path.join(isolated, 'outside.jsonl'); write(elsewhere, '{"role":"user","content":"private"}'); assert.throws(() => api.readSession(elsewhere)); assert.equal(api.resumeCommand({ id: 'bad; rm file', agent: 'Codex' }), ''); });
  const flags = await api.runAction(deps, 'codex.flags', {});
  check('codex.flags returns its schema rather than falling through to injection', () => { assert(Array.isArray(flags.schema)); assert(!flags.info); });
  const validBackup = store.exportAll();
  check('Invalid backup imports leave existing data unchanged', () => { assert.throws(() => store.importAll({ ...validBackup, providers: [{ id: 'bad', models: 'invalid' }] })); assert.deepEqual(store.listProviders(), validBackup.providers); });
  check('Imported client choices require reapplication and cannot import arbitrary backup paths', () => { store.importAll({ ...validBackup, agents: { 'codex-cli': { id: 'codex-cli', connected: true, providerId: savedProvider.id, model: 'model-one', backupPath: 'C:/private/other-file' } } }); assert.equal(store.listAgents()['codex-cli'].connected, false); assert.equal(store.listAgents()['codex-cli'].backupPath, undefined); });
  // Scan-only fixtures intentionally have no native SQLite index. Exercise the
  // configuration/import workflow in a separate private client installation.
  const configBeforeImport = read(codexFile), importClient = path.join(isolated, 'import-client'), importHome = path.join(importClient, '.codex');
  const importConfig = path.join(importHome, 'config.toml'); write(importConfig, configBeforeImport);
  const importDeps = { ...deps, historyContext: { home: importHome, sqliteHome: importHome, blockingProcesses: async () => [] } };
  process.env.AURORA_CLIENT_HOME = importClient;
  try {
    const connectedBeforeImport = await api.runAction(importDeps, 'agent.connect', { agentId: 'codex-cli', providerId: savedProvider.id, model: 'model-one' });
    assert(connectedBeforeImport.ok, connectedBeforeImport.message);
    const importWithLocalBackup = store.exportAll();
    store.importAll(importWithLocalBackup);
    const reapply = await api.runAction(importDeps, 'agent.connect', { agentId: 'codex-cli', providerId: savedProvider.id, model: 'model-two' });
    assert(reapply.ok, reapply.message);
    const restoredAfterImport = await api.runAction(importDeps, 'agent.disconnect', { agentId: 'codex-desktop' });
    check('Import and reapply retain this computer’s original undo backup', () => { assert(restoredAfterImport.ok, restoredAfterImport.message); assert.equal(read(importConfig), configBeforeImport); assert.equal(read(codexFile), configBeforeImport); });
  } finally { process.env.AURORA_CLIENT_HOME = isolated; }
  const beforePort = store.getSettings().gatewayPort;
  let restarts = 0;
  await assert.rejects(api.runAction({ ...deps, restartGateway: async () => { if (++restarts === 1) throw new Error('address in use'); } }, 'settings.save', { gatewayPort: beforePort + 1 }), /address in use/);
  check('A failed gateway restart restores previous settings and restarts the old listener', () => { assert.equal(store.getSettings().gatewayPort, beforePort); assert.equal(restarts, 2); });
  const listening = [];
  const serialDeps = { ...deps, restartGateway: async () => { const atStart = store.getSettings().gatewayPort; await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(store.getSettings().gatewayPort, atStart); listening.push(atStart); } };
  await Promise.all([api.runAction(serialDeps, 'settings.save', { gatewayPort: beforePort + 2 }), api.runAction(serialDeps, 'settings.save', { gatewayPort: beforePort + 3 })]);
  check('Concurrent settings saves restart serially with consistent settings', () => { assert.deepEqual(listening, [beforePort + 2, beforePort + 3]); });
  let responseMode = 'html';
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    req.resume(); res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') res.end(JSON.stringify({ data: [{ id: 'new-model' }] }));
    else if (req.url === '/v1beta/models') res.end(JSON.stringify({ models: [{ name: 'models/new-gemini', inputTokenLimit: 32768 }] }));
    else if (responseMode === 'html') res.end('<html>Not an AI endpoint</html>');
    else if (responseMode === 'error') res.end(JSON.stringify({ error: { message: 'no credit' } }));
    else res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${upstream.address().port}`;
    const probeProvider = store.saveProvider({ ...provider, id: undefined, baseUrl: endpoint + '/v1', headers: { 'x-test': 'custom' } });
    const htmlResult = await api.testProvider(deps, { providerId: probeProvider.id });
    responseMode = 'error'; const errorResult = await api.testProvider(deps, { providerId: probeProvider.id });
    responseMode = 'valid'; const validResult = await api.testProvider(deps, { providerId: probeProvider.id });
    check('Provider probes reject HTTP 200 HTML and API errors, and accept actual completions', () => { assert(!htmlResult.ok); assert(!errorResult.ok); assert(validResult.ok); });
    const discovered = await api.fetchProviderModels(deps, { providerId: probeProvider.id });
    check('Model discovery uses one protocol auth header and keeps unknown capabilities unknown', () => { assert(discovered.ok); const request = requests.find(x => x.url === '/v1/models'); assert.equal(request.headers.authorization, 'Bearer sk-original-secret'); assert.equal(request.headers['x-test'], 'custom'); assert.equal(request.headers['x-api-key'], undefined); assert.equal(request.headers['x-goog-api-key'], undefined); assert.equal(discovered.models.find(x => x.id === 'new-model').capabilities, undefined); });
    const googleProvider = store.saveProvider({ ...provider, id: undefined, format: 'gemini', baseUrl: endpoint });
    const googleModels = await api.fetchProviderModels(deps, { providerId: googleProvider.id });
    check('Gemini discovery uses the native models endpoint and context field', () => { assert(googleModels.ok); assert.equal(googleModels.models.find(x => x.id === 'new-gemini').contextWindow, 32768); const request = requests.find(x => x.url === '/v1beta/models'); assert.equal(request.headers['x-goog-api-key'], 'sk-original-secret'); assert.equal(request.headers.authorization, undefined); });
  } finally { await new Promise(resolve => upstream.close(resolve)); }
  console.log(`\n${passed} client safety and integration checks passed.`);
} finally {
  if (originalProfile === undefined) delete process.env.AURORA_CLIENT_HOME; else process.env.AURORA_CLIENT_HOME = originalProfile;
  const target = path.resolve(isolated);
  if (target.startsWith(path.join(os.tmpdir(), 'aurora-client-test-'))) fs.rmSync(target, { recursive: true, force: true });
}
