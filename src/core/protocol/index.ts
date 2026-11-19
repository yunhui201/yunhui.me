/**
 * 协议注册表：客户端说 A，上游说 B，这里完成 A→IR→B 与 B→IR→A 的往返。
 */
import type { IRRequest, IRResponse, ProtocolName, StreamEvent } from '../types.js';
import {
  AnthropicStreamDecoder,
  AnthropicStreamEncoder,
  encodeAnthropicRequest,
  parseAnthropicRequest,
  parseAnthropicResponse,
} from './anthropic.js';
import {
  OpenAIChatStreamDecoder,
  OpenAIChatStreamEncoder,
  buildOpenAIChatResponse,
  encodeOpenAIChatRequest,
  parseOpenAIChatRequest,
  parseOpenAIChatResponse,
} from './openaiChat.js';
import {
  ResponsesStreamDecoder,
  ResponsesStreamEncoder,
  buildResponsesResponse,
  encodeResponsesRequest,
  parseResponsesRequest,
  parseResponsesResponse,
} from './openaiResponses.js';
import {
  GeminiStreamDecoder,
  GeminiStreamEncoder,
  buildGeminiResponse,
  encodeGeminiRequest,
  parseGeminiRequest,
  parseGeminiResponse,
} from './gemini.js';

export * from './anthropic.js';
export * from './openaiChat.js';
export * from './openaiResponses.js';
export * from './gemini.js';

export interface UpstreamTarget {
  baseUrl: string;
  apiKey: string;
  format: ProtocolName;
  model: string;
  maxTokens?: number;
  /** 上游是否支持思考 */
  supportsThinking?: boolean;
  /** 上游是否支持图片 */
  supportsImages?: boolean;
  extraHeaders?: Record<string, string>;
  /** 参数风格：deepseek 系需要 enable_thinking */
  thinkingField?: 'reasoning_effort' | 'enable_thinking' | 'none';
}

export interface UpstreamHttp {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function joinBase(base: string): string {
  let b = (base || '').trim().replace(/\/+$/, '');
  return b;
}

function hasVersionSuffix(base: string): boolean {
  return /\/v\d+[a-z0-9]*$/i.test(base);
}

export function buildUpstreamHttp(
  ir: IRRequest,
  target: UpstreamTarget,
  clientProto: ProtocolName,
): UpstreamHttp {
  const base = joinBase(target.baseUrl);
  const maxTokens = target.maxTokens && ir.maxTokens ? Math.min(target.maxTokens, ir.maxTokens) : ir.maxTokens ?? target.maxTokens;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: ir.stream ? 'text/event-stream' : 'application/json',
    'user-agent': 'yunhui-gateway/0.1',
  };

  let url = base;
  let body: any;

  switch (target.format) {
    case 'anthropic': {
      url = hasVersionSuffix(base) ? `${base}/messages` : `${base}/v1/messages`;
      headers['anthropic-version'] = '2023-06-01';
      headers['x-api-key'] = target.apiKey;
      if (/^sk-ant-|^sk-/.test(target.apiKey)) headers.authorization = `Bearer ${target.apiKey}`;
      body = encodeAnthropicRequest(ir, {
        model: target.model,
        maxTokens,
        supportThinking: target.supportsThinking,
      });
      break;
    }
    case 'openai-responses': {
      url = hasVersionSuffix(base) ? `${base}/responses` : `${base}/v1/responses`;
      headers.authorization = `Bearer ${target.apiKey}`;
      body = encodeResponsesRequest(ir, {
        model: target.model,
        maxTokens,
        supportReasoning: target.supportsThinking,
      });
      break;
    }
    case 'gemini': {
      const action = ir.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
      const prefix = hasVersionSuffix(base) ? base : `${base}/v1beta`;
      url = `${prefix}/models/${encodeURIComponent(target.model)}:${action}`;
      headers['x-goog-api-key'] = target.apiKey;
      body = encodeGeminiRequest(ir, { model: target.model, maxTokens });
      break;
    }
    case 'openai-chat':
    default: {
      url = hasVersionSuffix(base)
        ? `${base}/chat/completions`
        : `${base}/v1/chat/completions`;
      headers.authorization = `Bearer ${target.apiKey}`;
      body = encodeOpenAIChatRequest(ir, {
        model: target.model,
        maxTokens,
        thinkingField: target.thinkingField ?? 'reasoning_effort',
        dropImages: target.supportsImages === false,
      });
      break;
    }
  }

  Object.assign(headers, target.extraHeaders ?? {});
  return { url, headers, body: JSON.stringify(body) };
}

export function parseClientRequest(proto: ProtocolName, body: any): IRRequest {
  switch (proto) {
    case 'anthropic':
      return parseAnthropicRequest(body);
    case 'openai-responses':
      return parseResponsesRequest(body);
    case 'gemini':
      return parseGeminiRequest(body);
    case 'openai-chat':
    default:
      return parseOpenAIChatRequest(body);
  }
}

export function parseUpstreamJson(format: ProtocolName, json: any): IRResponse {
  if (!json || typeof json !== 'object' || json.error) {
    throw new Error(typeof json?.error?.message === 'string' ? json.error.message : '上游返回了错误或空响应');
  }
  const valid = format === 'anthropic' ? Array.isArray(json.content)
    : format === 'openai-responses' ? Array.isArray(json.output) && !['failed', 'cancelled'].includes(json.status)
    : format === 'gemini' ? Array.isArray(json.candidates) && json.candidates.length > 0
    : Array.isArray(json.choices) && json.choices.length > 0;
  if (!valid) throw new Error('上游响应与所选协议不一致，请检查供应商的协议设置');
  switch (format) {
    case 'anthropic':
      return parseAnthropicResponse(json);
    case 'openai-responses':
      return parseResponsesResponse(json);
    case 'gemini':
      return parseGeminiResponse(json);
    default:
      return parseOpenAIChatResponse(json);
  }
}

export interface StreamCodecPair {
  decode(line: { event?: string; data: string }): StreamEvent[] | null;
  isDone(data: string): boolean;
}

export function createDecoder(format: ProtocolName): StreamCodecPair {
  if (format === 'anthropic') {
    const d = new AnthropicStreamDecoder();
    return { decode: (l) => d.push(l.event, l.data), isDone: (data) => data === '[DONE]' };
  }
  if (format === 'openai-responses') {
    const d = new ResponsesStreamDecoder();
    return { decode: (l) => d.push(l.event, l.data), isDone: (data) => data === '[DONE]' };
  }
  if (format === 'gemini') {
    const d = new GeminiStreamDecoder();
    return { decode: (l) => d.push(l.event, l.data), isDone: (data) => data === '[DONE]' };
  }
  const d = new OpenAIChatStreamDecoder();
  return { decode: (l) => d.push(l.event, l.data), isDone: (data) => data === '[DONE]' };
}

export interface StreamEncoderPair {
  push(e: StreamEvent): string;
  end(): string;
  contentType: string;
}

export function createEncoder(
  proto: ProtocolName,
  ctx: { requestId: string; model: string; clientModel: string; upstreamFormat?: ProtocolName },
): StreamEncoderPair {
  const contentType = 'text/event-stream; charset=utf-8';
  const wrap = (enc: { push(e: StreamEvent): string; end(): string }): StreamEncoderPair => ({
    push: (e) => enc.push(e),
    end: () => enc.end(),
    contentType,
  });
  switch (proto) {
    case 'anthropic':
      return wrap(new AnthropicStreamEncoder({ ...ctx, preserveThinking: ctx.upstreamFormat === 'anthropic' }));
    case 'openai-responses':
      return wrap(new ResponsesStreamEncoder(ctx));
    case 'gemini':
      return wrap(new GeminiStreamEncoder(ctx));
    default:
      return wrap(new OpenAIChatStreamEncoder(ctx));
  }
}

export function buildClientJson(
  proto: ProtocolName,
  res: IRResponse,
  ctx: { requestId: string; model: string; clientModel: string; upstreamFormat?: ProtocolName },
): any {
  switch (proto) {
    case 'anthropic':
      return {
        id: res.id,
        type: 'message',
        role: 'assistant',
        model: ctx.clientModel || res.model,
        content: res.blocks
          .filter((b) => b.type !== 'thinking' || (ctx.upstreamFormat === 'anthropic' && !!b.signature))
          .map((b) =>
            b.type === 'text'
              ? { type: 'text', text: b.text }
              : b.type === 'thinking'
                ? { type: 'thinking', thinking: b.text, signature: b.signature }
              : b.type === 'tool_use'
                ? { type: 'tool_use', id: b.id, name: b.name, input: b.input }
                : { type: 'text', text: '' },
          )
          .filter((b: any) => b.type !== 'text' || b.text),
        stop_reason: res.stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: res.usage.inputTokens,
          output_tokens: res.usage.outputTokens,
        },
      };
    case 'openai-responses':
      return buildResponsesResponse(res, ctx);
    case 'gemini':
      return buildGeminiResponse(res);
    default:
      return buildOpenAIChatResponse(res, ctx);
  }
}

export const PROTOCOL_LABEL: Record<ProtocolName, string> = {
  anthropic: 'Anthropic Messages',
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  gemini: 'Gemini Native',
};

