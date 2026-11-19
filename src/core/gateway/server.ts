import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { AuroraStore } from '../store/index.js';
import type { IRRequest, ProtocolName, StreamEvent, Usage } from '../types.js';
import {
  buildClientJson,
  buildUpstreamHttp,
  createDecoder,
  createEncoder,
  parseClientRequest,
  parseUpstreamJson,
} from '../protocol/index.js';
import { JsonLines } from '../store/jsonFile.js';
import { Router } from './router.js';
import { trackRequest, updateRequest, finishRequest } from './liveUsage.js';
import { fillResponsePhases, ResponsePhaseStream } from './responsePhase.js';
import { openUpstream, readAll } from './upstream.js';
import { applyMiddleware } from '../plugins/middleware.js';
import { Masker } from '../plugins/masking.js';
import { dayKey, estimateTokens, newId, nowIso, SseParser, trimToWindow } from '../util.js';
import type { UsageRecord } from '../store/types.js';
import { allowedHost, allowedOrigin, validGatewayToken, REMOTE_ACTIONS, redactRemoteResult } from './security.js';
import { CODEX_COEXIST_BASE_PATH, authorizeCodexCoexistRequest, codexCoexistEndpoint, getCoexistCatalog,
  prepareCodexCoexistRequest, readCodexCoexistBody, CodexCoexistError, type CodexCoexistPlan } from './coexist.js';
import { CODEX_HISTORY_PREFIX, CODEX_COEXIST_HISTORY_PREFIX, parseCodexHistoryRoute, type CodexHistoryTarget } from './historyRoute.js';

export interface GatewayStatus {
  running: boolean;
  host: string;
  port: number;
  startedAt?: string;
  requests: number;
  errors: number;
  lastError?: string;
}

export interface GatewayDeps {
  store: AuroraStore;
  onStatus?: (s: GatewayStatus) => void;
  onRequest?: (rec: UsageRecord) => void;
  /** Web 控制台静态目录（dist/ui） */
  uiDir?: string;
  /** 与桌面端共用的动作层，供 /api/rpc 使用 */
  actions?: (action: string, payload: any) => Promise<any>;
  /** Injectable transport for isolated official-channel tests; never read from settings or RPC. */
  officialTransport?: typeof openUpstream;
}

const CORS = {
  'access-control-allow-headers': 'Authorization, Content-Type, X-API-Key, X-Goog-API-Key, X-Aurora-Agent, Anthropic-Version',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-expose-headers': 'X-Aurora-Provider, X-Aurora-Model, X-Aurora-Route',
  'x-content-type-options': 'nosniff',
};

export class GatewayServer {
  readonly router: Router;
  private server: http.Server | null = null;
  private status: GatewayStatus = { running: false, host: '127.0.0.1', port: 3425, requests: 0, errors: 0 };

  constructor(private deps: GatewayDeps) {
    this.router = new Router(deps.store);
  }

  getStatus(): GatewayStatus {
    return { ...this.status, ...(this.router.persistenceWarning ? { lastError: this.router.persistenceWarning } : {}) };
  }

  async start(host?: string, port?: number): Promise<GatewayStatus> {
    if (this.server) return this.getStatus();
    const s = this.deps.store.getSettings();
    if (!s.gatewayToken) this.deps.store.saveSettings({ gatewayToken: randomBytes(24).toString('hex') });
    this.status.host = host ?? s.gatewayHost;
    this.status.port = port ?? s.gatewayPort;

    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        this.status.errors++;
        this.status.lastError = String(e?.message ?? e);
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'content-type': 'application/json', ...CORS });
            res.end(JSON.stringify({ error: { type: 'gateway_error', message: String(e?.message ?? e) } }));
          } else res.end();
        } catch {
          /* noop */
        }
      });
    });
    server.on('upgrade', (req, socket) => {
      const endpoint = codexCoexistEndpoint(req.url || '');
      const auth = endpoint === 'responses' ? authorizeCodexCoexistRequest(req, this.deps.store) : null;
      const status = !auth ? 404 : !auth.ok ? auth.status : 426;
      const message = !auth ? '未知的升级接口' : !auth.ok ? auth.message : '共存网关使用 HTTP Responses，请回退到 HTTP';
      const body = JSON.stringify({ error: { type: 'upgrade_unavailable', message } });
      socket.on('error', () => {});
      socket.end(`HTTP/1.1 ${status} ${status === 426 ? 'Upgrade Required' : status === 404 ? 'Not Found' : 'Forbidden'}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`);
    });
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 300_000;
    server.requestTimeout = 60_000;

    await new Promise<void>((resolve, reject) => {
      server.once('error', (e: any) => {
        this.status.lastError = e?.code === 'EADDRINUSE' ? `端口 ${this.status.port} 被占用` : String(e?.message ?? e);
        reject(e);
      });
      server.listen(this.status.port, this.status.host, () => resolve());
    });

    this.server = server;
    const address = server.address();
    if (address && typeof address !== 'string') this.status.port = address.port;
    this.status = { ...this.status, running: true, startedAt: nowIso() };
    this.deps.onStatus?.(this.getStatus());
    return this.getStatus();
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.status = { ...this.status, running: false };
    this.deps.onStatus?.(this.getStatus());
    if (s) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); });
  }

  /* ------------------------------------------------------------------ */

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const rawPath = (req.url ?? '/').split('?')[0];

    if (!allowedHost(req, this.status.host) || !allowedOrigin(req)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: '不允许的来源地址' }));
      return;
    }
    if (req.headers.origin) {
      res.setHeader('access-control-allow-origin', req.headers.origin);
      res.setHeader('vary', 'Origin');
    }
    res.setHeader('cache-control', 'no-store');

    if (path === CODEX_COEXIST_BASE_PATH || path.startsWith(CODEX_COEXIST_BASE_PATH + '/')
      || [path, rawPath].some(value => value === CODEX_COEXIST_HISTORY_PREFIX || value.startsWith(CODEX_COEXIST_HISTORY_PREFIX + '/'))) {
      await this.handleCodexCoexist(req, res, rawPath);
      return;
    }
    if ([path, rawPath].some(value => value === CODEX_HISTORY_PREFIX || value.startsWith(CODEX_HISTORY_PREFIX + '/'))) {
      await this.handleCodexHistory(req, res, rawPath);
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    if (path === '/health' || path === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify({ ok: true, running: this.status.running }));
      return;
    }

    // Loopback services also require authentication: websites can otherwise access local secrets.
    const s = this.deps.store.getSettings();
    if (path.startsWith('/api/') || path.startsWith('/v1') || path.startsWith('/claude-desktop/') || this.detectProtocol(path)) {
      if (!validGatewayToken(req, s.gatewayToken)) {
        res.writeHead(401, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: { message: '请提供正确的网关访问令牌', type: 'unauthorized' } }));
        return;
      }
    }

    if (path === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json', ...CORS });
      res.end(
        JSON.stringify({
          status: this.getStatus(),
          providers: this.deps.store.listProviders().map((p) => ({
            id: p.id,
            name: p.name,
            format: p.format,
            enabled: p.enabled,
            models: p.models.map((m) => m.id),
            keyCount: p.apiKeys.length,
          })),
          groups: this.deps.store.listGroups(),
        }),
      );
      return;
    }

    // Web 控制台 / 手机端的统一入口：和桌面端 IPC 走同一套动作
    if (path === '/api/rpc' && req.method === 'POST') {
      const bodyText = await readAll(req, 4 * 1024 * 1024);
      let body: any;
      try {
        body = JSON.parse(bodyText || '{}');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: '请求体不是合法 JSON' }));
        return;
      }
      if (!this.deps.actions) {
        res.writeHead(501, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: '当前运行模式不支持远程控制' }));
        return;
      }
      try {
        if (!body || typeof body !== 'object' || typeof body.action !== 'string' || !REMOTE_ACTIONS.has(body.action)) {
          res.writeHead(403, { 'content-type': 'application/json', ...CORS });
          res.end(JSON.stringify({ error: '此操作需要在电脑桌面端执行' }));
          return;
        }
        if (body.action === 'provider.toggle' || body.action === 'provider.save') {
          const payload = body.payload;
          if (!payload || typeof payload.id !== 'string' || typeof payload.enabled !== 'boolean'
              || Object.keys(payload).some((key) => !['id', 'enabled'].includes(key))) {
            throw new Error('远程端仅支持启用或停用已有供应商，请在桌面端编辑密钥和地址');
          }
          if (!this.deps.store.getProvider(payload.id)) throw new Error('供应商不存在');
          body.action = 'provider.save';
        }
        const result = await this.deps.actions(body.action, body.payload ?? {});
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify({ result: redactRemoteResult(result) }));
      } catch (e: any) {
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: String(e?.message ?? e) }));
      }
      return;
    }

    if (path === '/v1/models' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify(this.modelList()));
      return;
    }

    if (path.startsWith('/claude-desktop/v1/models') && req.method === 'GET') {
      const state = this.deps.store.listAgents()['claude-desktop'];
      const families = ['sonnet', 'opus', 'haiku'];
      const data = state?.connected ? families.map((family) => ({
        id: `claude-${family}-aurora`, type: 'model', display_name: `云汇 · ${family}`, created_at: '2026-01-01T00:00:00Z',
      })) : [];
      const id = path.slice('/claude-desktop/v1/models/'.length);
      const model = data.find((item) => item.id === id);
      if (path !== '/claude-desktop/v1/models' && !model) {
        res.writeHead(404, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: '模型不存在或尚未接入 Claude 桌面端' } }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify(model ?? { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null }));
      }
      return;
    }

    if (path.startsWith('/v1beta/models') && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify(this.geminiModelList()));
      return;
    }

    if (req.method === 'POST') {
      const bodyText = await readAll(req, 32 * 1024 * 1024);
      let body: any;
      try {
        body = JSON.parse(bodyText || '{}');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify({ error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } }));
        return;
      }
      const proto = this.detectProtocol(path);
      if (!proto) {
        res.writeHead(404, { 'content-type': 'application/json', ...CORS });
        res.end(
          JSON.stringify({
            error: {
              message: `未识别的端点 ${path}。支持 /v1/messages、/v1/chat/completions、/v1/responses、/v1beta/models/{model}:generateContent`,
              type: 'not_found',
            },
          }),
        );
        return;
      }
      await this.proxy(proto, body, req, res, path);
      return;
    }

    // Web 控制台静态资源（桌面端不需要，服务器/手机端用）
    if (req.method === 'GET' && this.deps.uiDir) {
      if (this.serveStatic(path, res)) return;
    }

    res.writeHead(404, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify({ error: { message: 'Not Found', type: 'not_found' } }));
  }

  private serveStatic(urlPath: string, res: ServerResponse): boolean {
    const root = this.deps.uiDir!;
    let rel: string;
    try { rel = decodeURIComponent(urlPath); } catch { return false; }
    if (rel === '/' || rel === '') rel = '/index.html';
    if (rel.includes('..')) return false;
    const file = path.resolve(root, '.' + rel);
    const relative = path.relative(path.resolve(root), file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    try {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
      const ext = path.extname(file).toLowerCase();
      const mime =
        {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.json': 'application/json',
          '.woff2': 'font/woff2',
        }[ext] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
      res.end(fs.readFileSync(file));
      return true;
    } catch {
      return false;
    }
  }

  private async handleCodexHistory(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const fail = (status: number, message: string) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: { type: 'codex_history_error', message } }));
    };
    if (!validGatewayToken(req, this.deps.store.getSettings().gatewayToken)) { fail(401, '请提供正确的网关访问令牌'); return; }
    const route = parseCodexHistoryRoute(path);
    if (!route || route.mode !== 'api') { fail(400, '历史兼容连接地址无效，请重新应用配置'); return; }
    if (route.endpoint === 'models' && req.method === 'GET') {
      const provider = this.deps.store.getProvider(route.providerId), resolved = this.router.resolveProviderModel(route.providerId, route.model);
      if (!resolved.candidates.length) { fail(!provider ? 404 : !provider.enabled ? 409 : 503, resolved.reason); return; }
      res.writeHead(200, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify({ object: 'list', data: [{ id: route.target, object: 'model', owned_by: provider!.name }] }));
      return;
    }
    if (route.endpoint === 'compact') { fail(501, '该中转尚未适配 Responses compact；未调用供应商或伪造压缩结果'); return; }
    if (route.endpoint === 'responses' && req.method === 'GET') { fail(426, '历史兼容连接使用 HTTP Responses；请让客户端回退到 HTTP'); return; }
    if (route.endpoint !== 'responses' || req.method !== 'POST') { fail(405, '此历史兼容接口不支持该请求方法'); return; }
    try {
      const body = await readCodexCoexistBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) { fail(400, 'Responses 请求必须是 JSON 对象'); return; }
      await this.proxy('openai-responses', { ...body, model: route.target }, req, res, '/v1/responses', route);
    } catch (error) {
      fail(error instanceof CodexCoexistError ? error.status : 502,
        error instanceof CodexCoexistError ? error.message : '历史兼容请求未能完成，请检查所选供应商及本地网关');
    }
  }

  private async handleCodexCoexist(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const fail = (status: number, message: string) => {
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'codex_coexist_error', message } }));
    };
    const auth = authorizeCodexCoexistRequest(req, this.deps.store);
    if (!auth.ok) { fail(auth.status, auth.message); return; }
    const endpoint = codexCoexistEndpoint(path);
    const history = parseCodexHistoryRoute(path);
    if (endpoint === 'models' && req.method === 'GET') {
      const catalog = getCoexistCatalog(this.deps.store);
      if (history && !catalog.models.some(model => model.id === history.target)) { fail(400, '历史兼容模型已不可用，请重新选择模型并应用配置'); return; }
      const models = history ? catalog.models.filter(model => model.id === history.target) : catalog.models;
      const nativeCatalog = history ? { models: catalog.nativeCatalog.models.filter(model => model.slug === history.target) } : catalog.nativeCatalog;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...nativeCatalog, object: 'list', data: models.map(model => ({
        id: model.id, object: 'model', owned_by: model.providerName, display_name: model.displayName,
      })) }));
      return;
    }
    if (endpoint === 'responses' && req.method === 'GET') { fail(426, '共存网关使用 HTTP Responses；请让客户端回退到 HTTP'); return; }
    if (req.method !== 'POST' || endpoint === 'models') { fail(405, '此共存接口不支持该请求方法'); return; }
    try {
      const body = await readCodexCoexistBody(req);
      const plan = prepareCodexCoexistRequest(auth.authorization, this.deps.store, path, body, req.headers);
      if (plan.kind === 'gateway') {
        // The generic proxy must never see the native OAuth/account/cookie headers.
        req.headers = { ...plan.headers, 'x-aurora-agent': 'Codex / ChatGPT 桌面版' };
        req.rawHeaders = Object.entries(req.headers).flatMap(([key, value]) => [key, String(value)]);
        await this.proxy('openai-responses', plan.body, req, res, plan.path, plan.historyTarget);
      } else {
        await this.proxyOfficialCodex(plan, history ? { ...(body as Record<string, any>), model: history.target } : body as Record<string, any>, req, res);
      }
    } catch (error) {
      fail(error instanceof CodexCoexistError ? error.status : 502,
        error instanceof CodexCoexistError ? error.message : '共存请求未能完成，请检查客户端登录及本地网关状态');
    }
  }

  private async proxyOfficialCodex(plan: Extract<CodexCoexistPlan, { kind: 'official' }>, body: Record<string, any>,
    req: IncomingMessage, res: ServerResponse): Promise<void> {
    const store = this.deps.store, settings = store.getSettings(), startedAt = Date.now(), requestId = newId('resp_', 24);
    const rawThreadId = req.headers['x-codex-thread-id'] || req.headers['x-thread-id'] || req.headers['thread-id'] || body.metadata?.thread_id;
    const threadId = typeof rawThreadId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(rawThreadId) ? rawThreadId : undefined;
    const controller = new AbortController(), cancel = () => controller.abort();
    res.once('close', cancel);
    const agent = 'Codex / ChatGPT 桌面版', providerName = 'ChatGPT 官方账号';
    trackRequest(store, { id: requestId, threadId, agent, phase: 'connecting', model: body.model,
      providerName, startedAtMs: startedAt, attempts: 1, autoRetries: 0 });
    const cand = { model: plan.model, providerModel: { id: plan.model },
      provider: { id: 'official', name: providerName, format: 'openai-responses', apiKeys: [] } };
    let recorded = false;
    try {
      const ir = parseClientRequest('openai-responses', body);
      // The URL comes exclusively from the fixed-host plan. openUpstream never follows redirects.
      const upstream = await (this.deps.officialTransport || openUpstream)(plan.url, {
        method: 'POST', headers: plan.headers, body: plan.body, proxy: settings.proxy || undefined,
        timeoutMs: settings.requestTimeoutMs, firstByteTimeoutMs: settings.firstByteTimeoutMs, signal: controller.signal,
      });
      if (upstream.status < 200 || upstream.status >= 300) {
        (upstream.stream as any).destroy?.();
        const status = upstream.status >= 400 ? upstream.status : 502;
        throw new CodexCoexistError(status, upstream.status === 401
          ? '官方登录已失效，请在官方客户端刷新或重新登录；未向第三方供应商重试'
          : `官方服务返回 HTTP ${upstream.status}；未向第三方供应商重试`);
      }
      this.status.requests++;
      res.setHeader('x-aurora-provider', encodeURIComponent(providerName));
      res.setHeader('x-aurora-model', encodeURIComponent(plan.model));
      res.setHeader('x-aurora-route', encodeURIComponent('官方账号直达官方 Responses'));
      if (ir.stream) await this.pipeStream(upstream.stream, upstream.headers, 'openai-responses', ir, cand,
        requestId, res, startedAt, 1, agent, new Masker(false), true, [plan.headers.authorization.slice(7)]);
      else await this.pipeJson(upstream.stream, 'openai-responses', ir, cand, requestId, res, startedAt, 1, agent, new Masker(false), true);
      recorded = true;
    } catch (error) {
      this.status.errors++;
      const status = controller.signal.aborted ? 499 : error instanceof CodexCoexistError ? error.status : 502;
      const message = controller.signal.aborted ? '客户端已取消官方请求' : error instanceof CodexCoexistError ? error.message : '官方请求连接失败，请检查网络和官方客户端登录';
      this.status.lastError = message;
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'official_upstream_error', message } }));
      } else if (!res.destroyed) res.end();
      this.record({ ts: nowIso(), agent, providerId: 'official', providerName, model: plan.model, requestModel: body.model,
        protocol: 'openai-responses', stream: !!body.stream, status, error: message, inputTokens: 0, outputTokens: 0,
        cacheRead: 0, cacheWrite: 0, cacheReadKnown: false, cacheWriteKnown: false, cost: 0, latencyMs: Date.now() - startedAt,
        attempts: 1, requestId });
      recorded = true;
    } finally {
      res.off('close', cancel);
      if (!recorded) finishRequest(store, requestId);
    }
  }

  private detectProtocol(path: string): ProtocolName | null {
    if (path.endsWith('/v1/messages') || path === '/messages') return 'anthropic';
    if (path.endsWith('/chat/completions')) return 'openai-chat';
    if (path.endsWith('/v1/responses') || path === '/responses') return 'openai-responses';
    if (/:generateContent$/.test(path) || /:streamGenerateContent$/.test(path)) return 'gemini';
    return null;
  }

  private modelList(): any {
    const seen = new Set<string>();
    const data: any[] = [];
    for (const p of this.deps.store.listProviders()) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        data.push({
          id: m.id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: p.name,
          context_window: m.contextWindow,
          pricing: { input: m.inputPrice, output: m.outputPrice },
        });
      }
    }
    for (const g of this.deps.store.listGroups()) {
      if (!g.enabled) continue;
      const id = `group/${g.name}`;
      if (seen.has(id)) continue;
      seen.add(id);
      data.push({ id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'yunhui.me 分组' });
    }
    return { object: 'list', data };
  }

  private geminiModelList(): any {
    const models = this.modelList().data.map((m: any) => ({
      name: `models/${m.id}`,
      displayName: m.id,
      supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
    }));
    return { models };
  }

  /* ------------------------------------------------------------------ */

  private async proxy(
    proto: ProtocolName,
    body: any,
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    historyTarget?: CodexHistoryTarget,
  ): Promise<void> {
    const startedAt = Date.now();
    const requestId = newId(proto === 'anthropic' ? 'msg_' : proto === 'openai-responses' ? 'resp_' : 'chatcmpl-', 24);
    const store = this.deps.store;
    const settings = store.getSettings();
    const controller = new AbortController();
    res.once('close', () => controller.abort());

    let ir: IRRequest;
    try {
      ir = parseClientRequest(proto, body);
    } catch (e: any) {
      res.writeHead(400, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: { message: `请求解析失败: ${e?.message}`, type: 'invalid_request_error' } }));
      return;
    }
    // Gemini 把模型名放在 URL 上
    if (proto === 'gemini' && !ir.model) {
      const mm = /\/models\/(.+):(?:generateContent|streamGenerateContent)$/.exec(path);
      if (mm) ir.model = decodeURIComponent(mm[1]);
    }

    const agentHeader = String(req.headers['x-aurora-agent'] ?? req.headers['user-agent'] ?? 'unknown');
    const agent = this.guessAgent(agentHeader);

    const middleware = applyMiddleware(store, ir, { agent, protocol: proto, requestId });
    if (middleware.blocked) {
      res.writeHead(middleware.blocked.status, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: { type: 'request_blocked', message: middleware.blocked.message } }));
      return;
    }
    ir = middleware.ir;
    // Plugins may change the body, but cannot redirect a fixed historical connection.
    if (historyTarget) ir.model = historyTarget.target;
    if (!ir.model || typeof ir.model !== 'string') {
      res.writeHead(400, { 'content-type': 'application/json', ...CORS });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: '请选择模型' } }));
      return;
    }
    if (proto === 'gemini') ir.stream = /:streamGenerateContent$/.test(path);

    // 隐私遮蔽
    const masker = new Masker(settings.maskSecrets);
    if (settings.maskSecrets) ir = masker.maskRequest(ir);

    let routeModel = ir.model;
    if (path.startsWith('/claude-desktop/')) {
      const state = store.listAgents()['claude-desktop'];
      const family = /^claude-(sonnet|opus|haiku)-aurora$/.exec(ir.model)?.[1];
      const selected = family && state?.connected && state.providerId ? state.modelMap?.[family] || state.model : undefined;
      if (!selected || !state?.providerId) {
        res.writeHead(400, { 'content-type': 'application/json', ...CORS });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '请先在客户端接入中配置 Claude 桌面端的供应商和模型' } }));
        return;
      }
      routeModel = selected.startsWith(`${state.providerId}/`) ? selected : `${state.providerId}/${selected}`;
    }
    const resolved = historyTarget ? this.router.resolveProviderModel(historyTarget.providerId, historyTarget.model) : this.router.resolveModel(routeModel);
    if (!resolved.candidates.length) {
      const boundProvider = historyTarget ? store.getProvider(historyTarget.providerId) : undefined;
      res.writeHead(historyTarget ? !boundProvider ? 404 : !boundProvider.enabled ? 409 : 503 : 400, { 'content-type': 'application/json', ...CORS });
      res.end(
        JSON.stringify({
          error: {
            message: historyTarget ? resolved.reason : `没有可用的供应商能处理模型「${ir.model}」。请到「供应商」页添加并启用至少一家（或检查 Key 是否都在冷却）。`,
            type: 'no_provider',
          },
        }),
      );
      return;
    }

    const rawThreadId = req.headers['x-codex-thread-id'] || req.headers['x-thread-id'] || body?.metadata?.thread_id;
    const threadId = typeof rawThreadId === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(rawThreadId) ? rawThreadId : undefined;
    trackRequest(store, { id: requestId, threadId, agent, phase: 'connecting', model: ir.model, startedAtMs: startedAt, attempts: 0, autoRetries: 0 });
    res.once('close', () => finishRequest(store, requestId));
    let attempt = 0;
    let lastCandidate = resolved.candidates[0];
    let lastErr: { status: number; message: string; raw?: string } | null = null;
    const maxAttempts = Math.min(resolved.candidates.length, 1 + Math.max(0, resolved.retries ?? settings.maxRetries));

    for (const cand of resolved.candidates.slice(0, maxAttempts)) {
      if (controller.signal.aborted || res.destroyed) { finishRequest(store, requestId); return; }
      attempt++;
      lastCandidate = cand;
      updateRequest(store, requestId, { attempts: attempt, autoRetries: attempt - 1, phase: attempt > 1 ? 'retrying' : 'connecting', model: cand.model, providerName: cand.provider.name });
      const supportsImages = cand.providerModel.capabilities?.vision ?? true;
      const target = {
        baseUrl: cand.provider.baseUrl,
        apiKey: cand.key.key,
        format: cand.provider.format,
        model: cand.model,
        maxTokens: cand.providerModel.maxOutput,
        supportsThinking: cand.providerModel.capabilities?.thinking,
        supportsImages,
        thinkingField: cand.providerModel.thinkingField,
        extraHeaders: cand.provider.headers,
      };
      const httpReq = buildUpstreamHttp(ir, target, proto);
      // Native protocols carry opaque tool/reasoning fields that a generic IR cannot recreate.
      const native = cand.provider.format === proto && !settings.maskSecrets && !store.listPlugins().some((plugin) => plugin.enabled);
      if (native) httpReq.body = JSON.stringify(proto === 'gemini' ? body : { ...body, model: cand.model });
      if (native) for (const header of ['anthropic-beta', 'openai-beta']) {
        if (typeof req.headers[header] === 'string' && !httpReq.headers[header]) httpReq.headers[header] = req.headers[header] as string;
      }

      let accepted = false;
      let activeUpstream: NodeJS.ReadableStream | undefined;
      try {
        const upstream = await openUpstream(httpReq.url, {
          method: 'POST',
          headers: httpReq.headers,
          body: httpReq.body,
          proxy: cand.provider.proxy || settings.proxy || undefined,
          timeoutMs: settings.requestTimeoutMs,
          firstByteTimeoutMs: settings.firstByteTimeoutMs,
          signal: controller.signal,
        });
        activeUpstream = upstream.stream;

        if (upstream.status < 200 || upstream.status >= 300) {
          const text = await readAll(upstream.stream, 1024 * 256).catch(() => '');
          lastErr = { status: upstream.status >= 400 ? upstream.status : 502, message: this.redactError(extractError(text)) || `上游返回 ${upstream.status}` };
          if (upstream.status === 401 || upstream.status === 403 || upstream.status === 429) {
            this.router.markKeyFailure(
              cand.provider.id,
              cand.key.id,
              `HTTP ${upstream.status}`,
              upstream.status === 429 ? 30_000 : 120_000,
              cand.key.key,
            );
          } else this.router.markProviderFailure(cand.provider.id);
          continue;
        }

        // 成功：记录并转发
        accepted = true;
        this.status.requests++;
        const header = (value: string) => encodeURIComponent(Buffer.from(value, 'utf8').toString('utf8'));
        res.setHeader('x-aurora-provider', header(cand.provider.name));
        res.setHeader('x-aurora-model', header(cand.model));
        res.setHeader('x-aurora-route', header(resolved.reason));

        if (ir.stream) {
          const complete = await this.pipeStream(upstream.stream, upstream.headers, proto, ir, cand, requestId, res, startedAt, attempt, agent, masker, native);
          if (complete) this.router.markKeySuccess(cand.provider.id, cand.key.id, cand.key.key);
          else this.router.markProviderFailure(cand.provider.id);
        } else {
          await this.pipeJson(upstream.stream, proto, ir, cand, requestId, res, startedAt, attempt, agent, masker, native);
          this.router.markKeySuccess(cand.provider.id, cand.key.id, cand.key.key);
        }
        return;
      } catch (e: any) {
        (activeUpstream as any)?.destroy?.();
        if (controller.signal.aborted || res.destroyed) { finishRequest(store, requestId); return; }
        // A delivered response must never be billed again because local bookkeeping failed.
        if (res.headersSent) {
          controller.abort(); finishRequest(store, requestId);
          this.status.lastError = '响应已发送，但本地记录未完成，请检查数据目录和日志设置';
          if (!res.writableEnded) res.destroy();
          return;
        }
        lastErr = { status: 0, message: this.redactError(String(e?.message ?? e)) };
        this.router.markProviderFailure(cand.provider.id);
        if (accepted) { lastErr.message = `上游已接受请求，但响应未能完成；为避免重复消耗，未自动重试。${lastErr.message}`; break; }
        continue;
      }
    }

    this.status.errors++;
    this.status.lastError = lastErr?.message ?? '未知错误';
    const payload = {
      error: {
        type: 'upstream_error',
        message:
          `所有候选供应商都失败了（尝试 ${attempt} 次）。最后一次：${lastErr?.message ?? '未知'}\n` +
          `路由：${resolved.reason}。建议到「用量 → 请求」查看详细日志，或在供应商详情点「测试」。`,
      },
    };
    res.writeHead(lastErr?.status || 502, { 'content-type': 'application/json', ...CORS });
    res.end(JSON.stringify(payload));
    this.record({
      ts: nowIso(),
      agent,
      providerId: lastCandidate.provider.id,
      providerName: lastCandidate.provider.name,
      model: lastCandidate.model,
      requestModel: ir.model,
      protocol: proto,
      stream: ir.stream,
      status: lastErr?.status ?? 502,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      latencyMs: Date.now() - startedAt,
      error: lastErr?.message,
      attempts: attempt,
      requestId,
    });
  }

  private guessAgent(ua: string): string {
    const s = ua.toLowerCase();
    if (s.includes('claude')) return 'Claude Code';
    if (s.includes('codex')) return 'Codex';
    if (s.includes('gemini')) return 'Gemini CLI';
    if (s.includes('workbuddy')) return 'WorkBuddy';
    if (s.includes('deepseek')) return 'DeepSeek';
    if (s.includes('aurora') || s.includes('yunhui')) return '云汇AI 工具箱';
    return ua.slice(0, 40) || '未知客户端';
  }

  private async pipeJson(
    stream: NodeJS.ReadableStream,
    proto: ProtocolName,
    ir: IRRequest,
    cand: any,
    requestId: string,
    res: ServerResponse,
    startedAt: number,
    attempt: number,
    agent: string,
    masker: Masker,
    native = false,
  ): Promise<void> {
    const text = await readAll(stream, 64 * 1024 * 1024);
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error('上游返回了非 JSON 内容');
    }
    const irRes = parseUpstreamJson(cand.provider.format, json);
    const out = native ? { ...json, ...(json.model ? { model: ir.model } : {}) } : buildClientJson(proto, irRes, {
      requestId,
      model: cand.model,
      clientModel: ir.model,
      upstreamFormat: cand.provider.format,
    });
    const phaseEnabled = proto === 'openai-responses' && /codex|chatgpt/i.test(agent) && this.deps.store.readExtra<any>('extensions.json', {})?.entries?.['builtin:reasoning-collapse']?.enabled;
    const body = JSON.stringify(masker.unmaskValue(phaseEnabled ? fillResponsePhases(out) : out));
    res.writeHead(200, { 'content-type': 'application/json', ...CORS });
    res.end(body);

    const usage = irRes.usage;
    const inputTokens = usage.inputTokens + (cand.provider.format === 'anthropic' ? (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) : 0);
    this.record({
      ts: nowIso(),
      agent,
      providerId: cand.provider.id,
      providerName: cand.provider.name,
      model: cand.model,
      requestModel: ir.model,
      protocol: proto,
      stream: false,
      status: 200,
      inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadKnown: usage.cacheReadTokens !== undefined,
      cacheWriteKnown: usage.cacheWriteTokens !== undefined,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      costKnown: this.router.costKnown(cand.provider, cand.providerModel, { cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens }),
      cost: this.router.costOf(cand.provider, cand.providerModel, {
        input: inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
      }),
      latencyMs: Date.now() - startedAt,
      attempts: attempt,
      requestId,
    });
  }

  private async pipeStream(
    stream: NodeJS.ReadableStream,
    headers: http.IncomingHttpHeaders,
    proto: ProtocolName,
    ir: IRRequest,
    cand: any,
    requestId: string,
    res: ServerResponse,
    startedAt: number,
    attempt: number,
    agent: string,
    masker: Masker,
    native = false,
    extraSecrets: string[] = [],
  ): Promise<boolean> {
    if (!String(headers['content-type'] ?? '').toLowerCase().includes('text/event-stream')) {
      throw new Error('上游没有返回 SSE 流，请检查供应商协议和流式支持');
    }
    const encoder = createEncoder(proto, { requestId, model: cand.model, clientModel: ir.model, upstreamFormat: cand.provider.format });
    const decoder = createDecoder(cand.provider.format);
    const parser = new SseParser();
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let firstByte = 0;
    let reportedInput = false;
    let outputCharacters = 0;
    updateRequest(this.deps.store, requestId, { phase: 'streaming' });
    let streamError: string | undefined;
    let terminal = false;
    const utf8 = new StringDecoder('utf8');
    const channels = new Map<string, StreamEvent>();
    const phase = proto === 'openai-responses' && /codex|chatgpt/i.test(agent) && this.deps.store.readExtra<any>('extensions.json', {})?.entries?.['builtin:reasoning-collapse']?.enabled ? new ResponsePhaseStream() : null;

    res.writeHead(200, {
      'content-type': encoder.contentType,
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...CORS,
    });

    const writeRaw = (s: string) => {
      if (!s || res.destroyed) return;
      if (!res.write(s)) {
        (stream as any).pause?.();
        res.once('drain', () => (stream as any).resume?.());
      }
    };
    const write = (s: string) => writeRaw(phase ? phase.push(s) : s);

    const flushChannels = (index?: number) => {
      for (const [channel, previous] of channels) {
        if (index !== undefined && 'index' in previous && previous.index !== index) continue;
        const text = masker.flush(channel);
        if (text) write(encoder.push(previous.type === 'tool_delta' ? { ...previous, json: text } : { ...previous, text } as StreamEvent));
        channels.delete(channel);
      }
    };

    const processChunk = (chunk: string) => {
      if (native) write(chunk);
      for (const evt of parser.push(chunk)) {
        if (cand.provider.format === 'openai-responses') {
          try {
            const json = JSON.parse(evt.data), raw = json.response?.usage || json.usage;
            const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
            if (raw && typeof raw === 'object') {
              const input = count(raw.input_tokens), output = count(raw.output_tokens), cached = count(raw.input_tokens_details?.cached_tokens), written = count(raw.cache_creation_input_tokens);
              if (input !== undefined) { usage.inputTokens = input; reportedInput = true; }
              if (output !== undefined) usage.outputTokens = output;
              if (cached !== undefined) usage.cacheReadTokens = cached;
              if (written !== undefined) usage.cacheWriteTokens = written;
              updateRequest(this.deps.store, requestId, { inputTokens: reportedInput ? usage.inputTokens : undefined,
                outputTokens: output, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens });
            }
          } catch { /* usage observation must not alter opaque upstream events */ }
        }
        if (decoder.isDone(evt.data)) { terminal = true; continue; }
        const events = decoder.decode(evt);
        if (!events) continue;
        for (let e of events) {
          if (e.type === 'usage') {
            Object.assign(usage, Object.fromEntries(Object.entries(e.usage).filter(([, v]) => v !== undefined)));
            if (e.usage.inputTokens !== undefined) reportedInput = true;
            updateRequest(this.deps.store, requestId, { inputTokens: reportedInput ? usage.inputTokens + (cand.provider.format === 'anthropic' ? (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) : 0) : undefined, outputTokens: e.usage.outputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens });
          }
          if (e.type === 'text_delta' || e.type === 'thinking_delta' || e.type === 'tool_delta') {
            outputCharacters += (e.type === 'tool_delta' ? e.json : e.text).length;
            updateRequest(this.deps.store, requestId, { estimatedOutputTokens: Math.ceil(outputCharacters / 4) });
          }
          if (e.type === 'stop') { terminal = true; flushChannels(); }
          if (e.type === 'error') { terminal = true; streamError = this.redactError(e.message, extraSecrets); e = { ...e, message: streamError }; }
          if (native) continue;
          if (e.type === 'block_stop') flushChannels(e.index);
          if (e.type === 'text_delta' || e.type === 'thinking_delta' || e.type === 'tool_delta') {
            const channel = `${e.type}:${e.index}`;
            channels.set(channel, e);
            e = e.type === 'tool_delta'
              ? { ...e, json: masker.unmaskDelta(e.json, channel, true) }
              : { ...e, text: masker.unmaskDelta(e.text, channel) };
          }
          write(encoder.push(e));
        }
      }
    };

    if (!native) write(encoder.push({ type: 'start', id: requestId, model: ir.model }));

    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        if (!firstByte) firstByte = Date.now() - startedAt;
        try { processChunk(utf8.write(chunk)); } catch (error) { (stream as any).destroy?.(); reject(error); }
      });
      stream.on('end', () => {
        try { processChunk(utf8.end() + '\n\n'); } catch (error) { reject(error); return; }
        if (!terminal) reject(new Error('上游流提前结束，未收到完成事件'));
        else resolve();
      });
      stream.on('error', (e) => reject(e));
      res.on('close', () => {
        (stream as any).destroy?.();
        if (!terminal) streamError = '客户端已断开连接';
        resolve();
      });
    }).catch((e) => {
      streamError = this.redactError(String(e?.message ?? e), extraSecrets);
      write(encoder.push({ type: 'error', message: streamError }));
    });

    flushChannels();
    if (!streamError && !native) write(encoder.end());
    if (phase) writeRaw(phase.end());
    res.end();
    if (streamError) { this.status.errors++; this.status.lastError = streamError; }

    if (!reportedInput) usage.inputTokens = estimateTokens(ir.system + JSON.stringify(ir.messages));
    const inputTokens = usage.inputTokens + (cand.provider.format === 'anthropic' && reportedInput ? (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) : 0);
    this.record({
      ts: nowIso(),
      agent,
      providerId: cand.provider.id,
      providerName: cand.provider.name,
      model: cand.model,
      requestModel: ir.model,
      protocol: proto,
      stream: true,
      estimated: !reportedInput,
      status: streamError ? 502 : 200,
      error: streamError,
      inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadKnown: usage.cacheReadTokens !== undefined,
      cacheWriteKnown: usage.cacheWriteTokens !== undefined,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      costKnown: this.router.costKnown(cand.provider, cand.providerModel, { cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens }),
      cost: this.router.costOf(cand.provider, cand.providerModel, {
        input: inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
      }),
      latencyMs: Date.now() - startedAt,
      firstByteMs: firstByte,
      attempts: attempt,
      requestId,
    });
    return !streamError;
  }

  private record(rec: UsageRecord): void {
    const request = finishRequest(this.deps.store, rec.requestId);
    if (request?.threadId) rec.threadId = request.threadId;
    const settings = this.deps.store.getSettings();
    if (settings.logRequests) this.deps.store.recordUsage(rec);
    this.deps.onRequest?.(rec);
  }

  private redactError(text: string, extraSecrets: string[] = []): string {
    let result = text;
    const secrets = [...extraSecrets, this.deps.store.getSettings().gatewayToken, ...this.deps.store.listProviders().flatMap((provider) => [
      ...provider.apiKeys.map(key => key.key),
      ...Object.values(provider.headers ?? {}).filter((value): value is string => typeof value === 'string').flatMap(value => [
        value, value.trim(), /^(?:Bearer|Basic)\s+(.+)$/i.exec(value.trim())?.[1] || '',
      ]),
    ])];
    // Longest first also hides complete authorization headers before their token substrings.
    // Keep the existing minimum length so short header values do not erase unrelated words.
    for (const key of [...new Set(secrets)].filter(key => key && key.length >= 4).sort((a, b) => b.length - a.length))
      result = result.split(key).join('[已隐藏密钥]');
    return result.slice(0, 2000);
  }
}

function extractError(text: string): string {
  if (!text) return '';
  try {
    const j = JSON.parse(text);
    const m =
      j?.error?.message ??
      j?.message ??
      j?.error?.error?.message ??
      (typeof j?.error === 'string' ? j.error : '') ??
      j?.detail ??
      '';
    if (m) return String(m);
  } catch {
    /* 纯文本 */
  }
  return text.slice(0, 400);
}

/** 供 UI / CLI 复用的单例 */
let instance: GatewayServer | null = null;
export function getGateway(deps: GatewayDeps): GatewayServer {
  if (!instance) instance = new GatewayServer(deps);
  return instance;
}
export function resetGateway(): void {
  instance = null;
}



