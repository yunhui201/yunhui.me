/** Protocol/escaping regression checks for copy-only client recipes. No real files or requests. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { parse } from 'smol-toml';

const result = await build({ entryPoints: ['src/core/agents/manualGuides.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const { buildManualGuide: guide, manualChatEndpoint, manualGuideVariants, manualGuideParameters, MANUAL_TOKEN_PLACEHOLDER: placeholder } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const base = { protocol: 'openai-chat', platform: 'win32', parameters: { baseUrl: 'http://127.0.0.1:3425/v1', model: 'fixture-provider/qwen-3' } };
const make = (agentId, extra = {}, token) => guide({ ...base, agentId, ...extra }, token);
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };

check('WorkBuddy uses a verified visual custom-provider flow and complete Chat URL', () => {
  const g = make('workbuddy');
  assert.equal(g.fields[0].value, 'http://127.0.0.1:3425/v1/chat/completions');
  assert.equal(g.path, undefined); assert.equal(g.document, undefined);
  assert(g.steps.some(step => step.includes('Custom')));
  assert(!manualGuideParameters(g).includes('fixture-secret'));
  assert(manualGuideParameters(g).includes(placeholder));
  for (const url of ['http://localhost:3425/v1/', 'http://localhost:3425/v1/chat/completions', 'http://localhost:3425/v1/chat/completions/']) assert.equal(manualChatEndpoint(url), 'http://localhost:3425/v1/chat/completions');
});
check('CodeBuddy variants preserve exact model routing, paths, and optional capabilities', () => {
  for (const variant of ['codebuddy-cli', 'codebuddy-ide']) {
    const g = make('workbuddy', { variant }), config = JSON.parse(g.document.content);
    assert.equal(g.path, '%USERPROFILE%\\.codebuddy\\models.json');
    assert.equal(config.models[0].id, base.parameters.model);
    assert.equal(config.models[0].url, base.parameters.baseUrl + '/chat/completions');
    assert.equal(config.models[0].apiKey, placeholder);
    assert(!('availableModels' in config));
    assert(!('supportsToolCall' in config.models[0]));
    assert(g.steps.some(step => step.includes('availableModels')));
    assert.equal(make('workbuddy', { variant, platform: 'darwin' }).path, '~/.codebuddy/models.json');
  }
});
check('Kimi requires known context and uses current Chat provider type and explicit config file', () => {
  for (const contextWindow of [undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '128000']) {
    const g = make('kimi-code', { contextWindow }); assert(g.blockingReason); assert.equal(g.document, undefined);
  }
  const g = make('kimi-code', { contextWindow: 128000 });
  const config = parse(g.document.content);
  assert.equal(config.providers.yunhui.type, 'openai_legacy');
  assert.equal(config.providers.yunhui.base_url, base.parameters.baseUrl);
  assert.equal(config.models.yunhui.max_context_size, 128000);
  assert.equal(config.models.yunhui.model, base.parameters.model);
  assert.equal(config.providers.yunhui.api_key, placeholder);
  assert.equal(g.command.content, 'kimi --config-file "$env:USERPROFILE\\.kimi\\yunhui.toml"');
  assert.equal(make('kimi-code', { platform: 'darwin', contextWindow: 128000 }).command.content, 'kimi --config-file "$HOME/.kimi/yunhui.toml"');
  assert(make('kimi-code', { contextWindow: 32000 }).notices.some(note => note.includes('reserved_context_size')));
});
check('OpenCode V1 and V2 map a safe selector to the full upstream model ID', () => {
  const v1 = JSON.parse(make('opencode').document.content);
  assert.equal(v1.model, 'yunhui/current'); assert.equal(v1.provider.yunhui.npm, '@ai-sdk/openai-compatible');
  assert.equal(v1.provider.yunhui.models.current.id, base.parameters.model);
  assert.equal(v1.provider.yunhui.options.apiKey, placeholder); assert.equal(v1.providers, undefined);
  const v2 = JSON.parse(make('opencode', { variant: 'opencode-v2' }).document.content);
  assert.equal(v2.providers.yunhui.package, '@opencode/ai/providers/openai-compatible');
  assert.equal(v2.providers.yunhui.models.current.modelID, base.parameters.model);
  assert.equal(v2.providers.yunhui.settings.baseURL, base.parameters.baseUrl); assert.equal(v2.provider, undefined);
});
check('Qwen explicitly selects Chat Completions and its credential environment key', () => {
  const c = JSON.parse(make('qwen-code').document.content);
  const model = c.modelProviders.openai[0];
  assert.equal(model.wireApi, 'chat-completions'); assert.equal(model.id, base.parameters.model);
  assert.equal(c.security.auth.selectedType, 'openai'); assert.equal(c.model.name, model.id);
  assert.equal(c.env[model.envKey], placeholder);
});
check('JSON and TOML values round-trip punctuation without executable shell interpolation', () => {
  const model = '厂商/a"b\\c\'d`$([payload])🙂';
  const token = 'fixture-"token\\\'`$(never-run)🙂';
  const extra = { parameters: { ...base.parameters, model }, contextWindow: 64000 };
  for (const agentId of ['kimi-code', 'qwen-code', 'opencode']) {
    const g = make(agentId, extra, token);
    if (agentId === 'kimi-code') {
      const c = parse(g.document.content); assert.equal(c.providers.yunhui.api_key, token); assert.equal(c.models.yunhui.model, model);
    } else {
      const c = JSON.parse(g.document.content);
      assert.equal(agentId === 'qwen-code' ? c.env.YUNHUI_API_KEY : c.provider.yunhui.options.apiKey, token);
    }
    assert(!g.command.content.includes(token)); assert(!g.command.content.includes(model));
    assert(!JSON.stringify(make(agentId, extra)).includes(token));
  }
});
check('Unsupported protocols, invalid fields, and cross-client variants fail without leaking input', () => {
  for (const protocol of ['anthropic', 'openai-responses', 'gemini', 'unknown']) assert.throws(() => make('kimi-code', { protocol }), /Chat Completions/);
  for (const baseUrl of ['file:///tmp/private', 'https://user:secret@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#secret', 'http://localhost/\nsecret']) {
    assert.throws(() => make('workbuddy', { parameters: { baseUrl, model: 'model' } }), error => !error.message.includes('secret'));
  }
  assert.throws(() => make('workbuddy', { variant: 'opencode-v2' }), /版本不匹配/);
  assert.throws(() => make('kimi-code', { parameters: { ...base.parameters, model: 'bad\nsecret' } }), /模型 ID无效/);
  assert.throws(() => make('opencode', {}, 'bad\nsecret'), /访问令牌无效/);
  assert.deepEqual(manualGuideVariants('zcode'), []);
  const generic = make('deepseek'); assert.equal(generic.document, undefined);
  assert(generic.notices.some(note => note.includes('不会替换 DeepSeek 官方网页')));
});
console.log(`${passed} manual guide checks passed`);
