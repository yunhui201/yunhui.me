/**
 * Optional native SDK compatibility check. No requests leave this process.
 * Install @anthropic-ai/sdk and @google/genai into a separate temporary prefix
 * with --ignore-scripts --no-save --package-lock=false, then point
 * AURORA_NATIVE_SDKS at that prefix before running this script.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

if (!process.env.AURORA_NATIVE_SDKS) throw new Error('Set AURORA_NATIVE_SDKS to the isolated prefix containing @anthropic-ai/sdk and @google/genai.');
const sdkRoot = path.resolve(process.env.AURORA_NATIVE_SDKS);
const sdkRequire = createRequire(path.join(sdkRoot, '__native_sdk_fixture__.cjs'));
const workspace = path.resolve(import.meta.dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yunhui-native-sdk-check-'));
const origin = 'http://127.0.0.1:43217'; // Never contacted: fetch is replaced with an in-memory response.
const key = 'native-sdk-fake-key', model = 'fixture-model';
const calls = [];
let passed = 0;
const originalFetch = globalThis.fetch, originalHttp = http.request, originalHttps = https.request;
function sdkVersion(packageName) {
  let directory = path.dirname(sdkRequire.resolve(packageName));
  while (true) {
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file)) {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (metadata.name === packageName) return metadata.version;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate metadata for ${packageName}`);
    directory = parent;
  }
}
async function sdkFetch(input, options) {
  const request = new Request(input, options), url = new URL(request.url);
  assert.equal(url.origin, origin, 'An SDK attempted to use a non-fixture origin');
  assert.equal(request.method, 'POST');
  const body = JSON.parse(await request.text());
  calls.push({ url: url.href, headers: request.headers, body });
  if (url.pathname.endsWith('/messages')) return new Response(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 3, output_tokens: 1 } }),
    { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'fixture-request' } });
  const answer = { candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } };
  if (url.pathname.endsWith(':streamGenerateContent')) return new Response(`data: ${JSON.stringify(answer)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  assert(url.pathname.endsWith(':generateContent'), 'Unexpected SDK endpoint');
  return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
}

try {
  globalThis.fetch = sdkFetch;
  http.request = https.request = () => { throw new Error('Native SDK regression forbids network access'); };
  const anthropicModule = await import(pathToFileURL(sdkRequire.resolve('@anthropic-ai/sdk')).href);
  const geminiModule = await import(pathToFileURL(sdkRequire.resolve('@google/genai')).href);
  const Anthropic = anthropicModule.Anthropic || anthropicModule.default?.Anthropic || anthropicModule.default;
  const GoogleGenAI = geminiModule.GoogleGenAI || geminiModule.default?.GoogleGenAI;
  console.log(`Native SDK versions: @anthropic-ai/sdk ${sdkVersion('@anthropic-ai/sdk')}; @google/genai ${sdkVersion('@google/genai')}`);
  const bundle = path.join(scratch, 'urls.cjs');
  await build({ stdin: { contents: "export * from './src/core/agents/directConnection.ts'; export * from './src/core/protocol/index.ts';", resolveDir: workspace, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  const { nativeDirectParameters, buildUpstreamHttp, parseClientRequest } = createRequire(import.meta.url)(bundle);
  async function verify(protocol, suffix, stream = false) {
    const baseUrl = origin + suffix, parameters = nativeDirectParameters(baseUrl, protocol), before = calls.length;
    const ir = parseClientRequest('openai-chat', { model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 1024, stream });
    const expected = buildUpstreamHttp(ir, { baseUrl, format: protocol, apiKey: key, model, maxTokens: 1024 }, protocol);
    if (protocol === 'anthropic') {
      const client = new Anthropic({ apiKey: key, authToken: null, baseURL: parameters.baseUrl, fetch: sdkFetch, maxRetries: 0 });
      const response = await client.messages.create({ model, messages: [{ role: 'user', content: 'Reply OK.' }], max_tokens: 1024 });
      assert.equal(response.content[0].text, 'OK');
    } else {
      const client = new GoogleGenAI({ apiKey: key, apiVersion: parameters.apiVersion, httpOptions: { baseUrl: parameters.baseUrl } });
      const request = { model, contents: 'Reply OK.', config: { maxOutputTokens: 1024 } };
      if (stream) {
        const chunks = [];
        for await (const chunk of await client.models.generateContentStream(request)) chunks.push(chunk.text);
        assert.equal(chunks.join(''), 'OK');
      } else assert.equal((await client.models.generateContent(request)).text, 'OK');
    }
    assert.equal(calls.length, before + 1, 'SDK retried a mock request');
    const sent = calls.at(-1);
    assert.equal(sent.url, expected.url, `${protocol} native URL differs from gateway for ${suffix || '/'}`);
    const credential = protocol === 'anthropic'
      ? sent.headers.get('x-api-key') || sent.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      : sent.headers.get('x-goog-api-key');
    assert.equal(credential, key);
    assert.equal(protocol === 'anthropic' ? sent.body.max_tokens : sent.body.generationConfig.maxOutputTokens, 1024);
    passed++; console.log(`PASS ${protocol}${stream ? ' stream' : ''} ${suffix || '/'} reproduces the gateway URL`);
  }
  for (const suffix of ['', '/', '/proxy', '/proxy/', '/v1', '/proxy/v1', '/proxy/v1/']) await verify('anthropic', suffix);
  for (const suffix of ['', '/', '/proxy', '/proxy/', '/v1', '/v1beta', '/proxy/v1', '/proxy/v1beta', '/proxy/v1beta/']) await verify('gemini', suffix);
  for (const suffix of ['/proxy/v1', '/proxy/v1beta']) await verify('gemini', suffix, true);
  console.log(`\n${passed} native SDK URL checks passed; ${calls.length} in-memory requests; no network requests.`);
} finally {
  globalThis.fetch = originalFetch; http.request = originalHttp; https.request = originalHttps;
  assert.equal(fs.realpathSync(path.dirname(scratch)), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(scratch).startsWith('yunhui-native-sdk-check-'));
  fs.rmSync(scratch, { recursive: true, force: true });
}
