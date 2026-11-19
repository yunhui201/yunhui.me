import type { AuroraStore, PluginRecord } from '../store/index.js';
import type { IRRequest } from '../types.js';
import { Script, createContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { promiseHooks } from 'node:v8';

export interface MiddlewareContext {
  agent: string;
  protocol: string;
  requestId: string;
}

export interface MiddlewareResult {
  ir: IRRequest;
  blocked?: { status: number; message: string };
  notes: string[];
}
interface MiddlewareStatus { status: 'ok' | 'error' | 'blocked'; checkedAt: string; message?: string }
const runtimeStates = new WeakMap<AuroraStore, Record<string, MiddlewareStatus>>();
export function getMiddlewareStatus(store: AuroraStore): Record<string, MiddlewareStatus> { return structuredClone(runtimeStates.get(store) || {}); }
export function clearMiddlewareStatus(store: AuroraStore, id: string): void { const states = runtimeStates.get(store); if (states) delete states[id]; }
export function clearAllMiddlewareStatus(store: AuroraStore): void { runtimeStates.delete(store); }
function recordMiddlewareStatus(store: AuroraStore, id: string, status: MiddlewareStatus['status'], message?: string): void {
  const states = runtimeStates.get(store) || Object.create(null);
  states[id] = { status, checkedAt: new Date().toISOString(), ...(message ? { message } : {}) };
  runtimeStates.set(store, states);
}

type Hook = (ir: IRRequest, ctx: MiddlewareContext, options?: any) => IRRequest | void | { block: string };

/** 内置中间件：不写代码也能用的常用能力 */
export const BUILTIN_MIDDLEWARE: Array<{
  id: string;
  name: string;
  description: string;
  defaultOptions: Record<string, unknown>;
  hook: Hook;
}> = [
  {
    id: 'model-map',
    name: '模型别名',
    description: '把客户端模型别名映射到已有供应商的模型，填写实际的供应商 ID / 模型 ID',
    defaultOptions: { mapping: {} },
    hook: (ir, _ctx, options) => {
      const map = (options?.mapping ?? {}) as Record<string, string>;
      if (Object.hasOwn(map, ir.model)) ir.model = map[ir.model];
    },
  },
  {
    id: 'system-prompt',
    name: '统一系统提示',
    description: '给每个请求追加一段系统提示词（团队规范、输出语言等）',
    defaultOptions: { text: '始终使用简体中文回答。' },
    hook: (ir, _ctx, options) => {
      const text = String(options?.text ?? '').trim();
      if (text) ir.system = ir.system ? `${text}\n\n${ir.system}` : text;
    },
  },
  {
    id: 'word-guard',
    name: '敏感词拦截',
    description: '检查系统提示、消息文本与工具输入；命中词表时拒绝，或将所有命中词替换成 ***',
    defaultOptions: { words: [], action: 'block' },
    hook: (ir, _ctx, options) => {
      const words = (options?.words ?? []) as string[];
      if (!words.length) return;
      const texts: string[] = [ir.system];
      mapMessageText(ir.messages, text => { texts.push(text); return text; });
      const hit = words.find(w => texts.some(text => text.includes(w)));
      if (!hit) return;
      if (options?.action === 'mask') {
        const ordered = [...words].sort((a, b) => b.length - a.length);
        const expression = new RegExp(ordered.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
        const replace = (text: string) => text.replace(expression, '***');
        ir.system = replace(ir.system);
        mapMessageText(ir.messages, replace);
        return;
      }
      return { block: `请求包含被拦截的词：${hit}` };
    },
  },
  {
    id: 'param-override',
    name: '参数覆盖',
    description: '强制设置 temperature / maxTokens / reasoning 等字段',
    defaultOptions: { temperature: 0.3 },
    hook: (ir, _ctx, options) => {
      if (typeof options?.temperature === 'number') ir.temperature = options.temperature;
      if (typeof options?.maxTokens === 'number') ir.maxTokens = options.maxTokens;
      if (typeof options?.reasoning === 'string') ir.reasoning = options.reasoning;
    },
  },
  {
    id: 'token-budget',
    name: '上下文裁剪',
    description: '超过上限时丢弃最早的对话轮次，避免因超出窗口被上游拒绝',
    defaultOptions: { maxTokens: 180000 },
    hook: (ir, _ctx, options) => {
      const budget = Number(options?.maxTokens ?? 180000);
      const est = (m: any) => JSON.stringify(m).length / 3.2;
      if (JSON.stringify(ir.messages).length / 3.2 <= budget) return;
      const { messages } = trimMessages(ir.messages, budget, est);
      ir.messages = messages;
    },
  },
];

function mapMessageText(messages: IRRequest['messages'], transform: (text: string) => string): void {
  const values = (value: any): any => {
    if (typeof value === 'string') return transform(value);
    if (Array.isArray(value)) return value.map(values);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, values(entry)]));
    return value;
  };
  const blocks = (items: IRRequest['messages'][number]['blocks']) => {
    for (const block of items) {
      if (block.type === 'text' || block.type === 'thinking') block.text = transform(block.text);
      else if (block.type === 'tool_use') block.input = values(block.input);
      else if (block.type === 'tool_result') blocks(block.content);
    }
  };
  for (const message of messages) blocks(message.blocks);
}

/** Validate persisted options without executing user code. */
export function validatePluginConfiguration(p: PluginRecord): void {
  if (typeof p.name !== 'string' || !p.name.trim()) throw new Error('请填写插件名称');
  if (typeof p.enabled !== 'boolean') throw new Error('插件启用状态无效');
  const options = p.options ?? BUILTIN_MIDDLEWARE.find(b => b.id === p.id)?.defaultOptions ?? {};
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('插件参数必须是 JSON 对象');
  if (!p.builtin) {
    if (typeof p.code !== 'string' || !p.code.trim()) throw new Error('请填写中间件代码');
    if (p.code.length > 1024 * 1024) throw new Error('中间件代码不能超过 1 MB');
    try { pluginScript(p); } catch { throw new Error('中间件代码存在语法错误，请检查后保存'); }
    return;
  }
  switch (p.id) {
    case 'model-map':
      if (!options.mapping || typeof options.mapping !== 'object' || Array.isArray(options.mapping) || Object.values(options.mapping).some(value => typeof value !== 'string' || !value.trim() || /[\r\n\u0000]/.test(value))) throw new Error('模型映射 mapping 必须是模型别名到实际模型 ID 的对象');
      break;
    case 'word-guard':
      if (!Array.isArray(options.words) || options.words.length > 1000 || options.words.some(word => typeof word !== 'string' || !word.length || word.length > 1000) || !['block', 'mask'].includes(String(options.action))) throw new Error('词表必须是非空词语的数组（最多 1000 项），action 只能为 block 或 mask');
      break;
    case 'system-prompt':
      if (typeof options.text !== 'string') throw new Error('系统提示 text 必须是文本');
      break;
    case 'param-override':
      if (options.temperature !== undefined && (typeof options.temperature !== 'number' || !Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) throw new Error('temperature 必须是 0 到 2 之间的数字');
      if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || Number(options.maxTokens) <= 0)) throw new Error('maxTokens 必须是正整数');
      if (options.reasoning !== undefined && !['off', 'low', 'medium', 'high'].includes(String(options.reasoning))) throw new Error('reasoning 只能为 off、low、medium 或 high');
      break;
    case 'token-budget':
      if (!Number.isSafeInteger(options.maxTokens) || Number(options.maxTokens) <= 0) throw new Error('上下文预算 maxTokens 必须是正整数');
      break;
    default: throw new Error('未知的内置中间件');
  }
}

function validRequest(value: any): value is IRRequest {
  const blocks = (items: any, depth = 0): boolean => depth < 32 && Array.isArray(items) && items.every(block => {
    if (!block || typeof block !== 'object') return false;
    switch (block.type) {
      case 'text': case 'thinking': return typeof block.text === 'string';
      case 'image': return typeof block.data === 'string' && typeof block.mediaType === 'string' && ['base64', 'url'].includes(block.source);
      case 'tool_use': return typeof block.id === 'string' && typeof block.name === 'string' && Object.hasOwn(block, 'input');
      case 'tool_result': return typeof block.toolUseId === 'string' && blocks(block.content, depth + 1);
      case 'redacted_thinking': return typeof block.data === 'string';
      default: return false;
    }
  });
  return !!value && typeof value === 'object' && typeof value.model === 'string' && !!value.model.trim()
    && typeof value.system === 'string' && typeof value.stream === 'boolean'
    && Array.isArray(value.messages) && value.messages.every((m: any) => m && ['user', 'assistant', 'system'].includes(m.role) && blocks(m.blocks))
    && Array.isArray(value.tools) && value.tools.every((t: any) => t && typeof t.name === 'string' && t.parameters && typeof t.parameters === 'object' && !Array.isArray(t.parameters))
    && !!value.toolChoice && ['auto', 'any', 'none', 'tool'].includes(value.toolChoice.type) && (value.toolChoice.type !== 'tool' || typeof value.toolChoice.name === 'string')
    && (value.maxTokens === undefined || Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0)
    && (value.temperature === undefined || typeof value.temperature === 'number' && Number.isFinite(value.temperature) && value.temperature >= 0 && value.temperature <= 2)
    && (value.topP === undefined || typeof value.topP === 'number' && Number.isFinite(value.topP) && value.topP >= 0 && value.topP <= 1)
    && (value.stop === undefined || Array.isArray(value.stop) && value.stop.every((stop: any) => typeof stop === 'string'))
    && (value.reasoning === undefined || ['off', 'low', 'medium', 'high'].includes(value.reasoning))
    && (value.sessionKey === undefined || typeof value.sessionKey === 'string');
}

function trimMessages(messages: any[], budget: number, est: (m: any) => number) {
  if (!Number.isFinite(budget) || budget <= 0) return { messages };
  let total = messages.reduce((a, m) => a + est(m), 0);
  let first = 0;
  // Drop complete user turns, including their tool use/result pairs, and retain the last turn intact.
  while (total > budget) {
    const next = messages.findIndex((m, i) => i > first && m.role === 'user' && !m.blocks?.some((b: any) => b.type === 'tool_result'));
    if (next < 0) break;
    for (let i = first; i < next; i++) total -= est(messages[i]);
    first = next;
  }
  return { messages: messages.slice(first) };
}

/**
 * 应用所有启用的中间件。用户插件是 JS 片段，导出一个
 * `function onRequest(ir, ctx)`；出错不影响主请求（fail-open）。
 */
export function applyMiddleware(
  store: AuroraStore,
  ir: IRRequest,
  ctx: MiddlewareContext,
): MiddlewareResult {
  const notes: string[] = [];
  let current = ir;
  for (const plugin of store.listPlugins()) {
    if (!plugin.enabled) continue;
    try {
      const candidate = structuredClone(current);
      let result: ReturnType<Hook>;
      if (plugin.builtin) {
        const def = BUILTIN_MIDDLEWARE.find((b) => b.id === plugin.id);
        if (!def) throw new Error('未知的内置中间件');
        validatePluginConfiguration(plugin);
        result = def.hook(candidate, ctx, plugin.options ?? def.defaultOptions);
      } else if (plugin.code) {
        const fn = compilePlugin(plugin);
        result = fn(candidate, ctx);
      } else throw new Error('缺少中间件代码');
      if (result && typeof result === 'object' && 'block' in result) {
        if (typeof result.block !== 'string' || !result.block.trim()) throw new Error('拦截原因必须是文本');
        recordMiddlewareStatus(store, plugin.id, 'blocked', '最近请求被此插件规则拦截');
        return { ir: current, blocked: { status: 403, message: result.block.slice(0, 2000) }, notes: [...notes, plugin.id] };
      }
      const next = result === undefined ? candidate : result;
      if (!validRequest(next)) throw new Error('中间件返回了无效的请求结构');
      current = next;
      notes.push(plugin.id);
      recordMiddlewareStatus(store, plugin.id, 'ok');
    } catch (error) {
      const timedOut = (error as any)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
      const message = `${timedOut ? '执行超时（timed out）' : '执行失败或结果无效'}，已保留进入此插件前的请求`;
      notes.push(`${plugin.id}: ${message}`);
      recordMiddlewareStatus(store, plugin.id, 'error', message);
      // fail-open：插件写坏了也不能把用户请求打死
    }
  }
  return { ir: current, notes };
}

const compiled = new Map<string, Hook>();
function pluginScript(p: PluginRecord): Script {
  return new Script(
    `"use strict";
     const module = { exports: {} };
     const options = JSON.parse(optionsJson);
     const ir = JSON.parse(irJson);
     const ctx = JSON.parse(ctxJson);
     ${p.code}
     const fn = typeof onRequest === 'function' ? onRequest :
       typeof module.exports === 'function' ? module.exports : module.exports.onRequest;
     if (typeof fn !== 'function') throw new Error('插件缺少 onRequest 函数');
     const result = fn(ir, ctx);
     if (result && typeof result.then === 'function') {
       Promise.resolve(result).catch(() => {});
       throw new Error('中间件必须为同步函数');
     }
     JSON.stringify(result === undefined ? ir : result);`,
    { filename: 'yunhui-middleware.js' },
  );
}
function compilePlugin(p: PluginRecord): Hook {
  const cacheKey = createHash('sha256').update(JSON.stringify([p.id, p.code, p.options])).digest('hex');
  const cached = compiled.get(cacheKey);
  if (cached) return cached;
  const script = pluginScript(p);
  const hook: Hook = (ir, ctx) => {
    const context = createContext({ irJson: JSON.stringify(ir), ctxJson: JSON.stringify(ctx), optionsJson: JSON.stringify(p.options ?? {}) },
      { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
    const { prototype, species } = new Script('({prototype:Promise.prototype,species:Object.freeze({__proto__:null,[Symbol.species]:Promise})})').runInContext(context);
    let asynchronous = false, observing = false;
    // A synchronous hook can create detached rejected promises too. Observe only this VM's
    // promises while it runs; attach a rejection handler without swallowing host rejections.
    const stop = promiseHooks.createHook({ init(promise) {
      if (observing || !Object.prototype.isPrototypeOf.call(prototype, promise)) return;
      asynchronous = true; observing = true;
      const descriptor = Object.getOwnPropertyDescriptor(promise, 'constructor');
      try {
        // Avoid executing a user-defined Promise subclass constructor while adding the handler.
        Object.defineProperty(promise, 'constructor', { value: species, configurable: true });
        Promise.prototype.then.call(promise, undefined, () => {});
      } finally {
        if (descriptor) Object.defineProperty(promise, 'constructor', descriptor); else Reflect.deleteProperty(promise, 'constructor');
        observing = false;
      }
    } });
    try {
      const result = script.runInContext(context, { timeout: 100 });
      if (asynchronous) throw new Error('中间件必须是同步函数，不支持 Promise 或异步任务');
      return JSON.parse(result);
    } finally { stop(); }
  };
  // This timeout protects against accidental loops; user scripts must still be locally trusted.
  if (compiled.size >= 128) compiled.clear();
  compiled.set(cacheKey, hook);
  return hook;
}

export const SAMPLE_PLUGIN = `// 云汇AI中间件示例：把 <think>...</think> 从请求里剥掉
function onRequest(ir, ctx) {
  for (const m of ir.messages) {
    for (const b of m.blocks) {
      if (b.type === 'text' && b.text && b.text.includes('<think>')) {
        b.text = b.text.replace(/<think>[\\s\\S]*?<\\/think>/g, '').trim();
      }
    }
  }
  return ir;
}`;

