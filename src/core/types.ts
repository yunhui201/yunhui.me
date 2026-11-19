/**
 * 云汇AI 工具箱 · 领域模型
 * ------------------------------------------------------------
 * 一切协议（Anthropic Messages / OpenAI Chat / OpenAI Responses / Gemini）
 * 先解析为统一的 IR，再由目标协议编码器写出。所有棘手的兼容问题
 * （thinking 回传、tool_calls 合并、fc_/ctc_ id 前缀、图片格式）
 * 都集中在协议层处理，网关只关心 IR。
 */

export type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; source: 'base64' | 'url' }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: Block[]; isError?: boolean }
  | { type: 'thinking'; text: string; signature?: string }
  | { type: 'redacted_thinking'; data: string };

export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  role: Role;
  blocks: Block[];
}

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema */
  parameters: Record<string, any>;
}

export type ToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'none' }
  | { type: 'tool'; name: string };

export type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'error';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** 统一请求：无论来自哪个客户端协议 */
export interface IRRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolDef[];
  toolChoice: ToolChoice;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  stream: boolean;
  reasoning?: 'off' | 'low' | 'medium' | 'high';
  /** 客户端原始 body，插件中间件可以看到 */
  raw?: unknown;
  /** 客户端会话指纹，用于把同一会话钉在同一账号上（缓存命中） */
  sessionKey?: string;
}

export interface IRResponse {
  id: string;
  model: string;
  blocks: Block[];
  stopReason: StopReason;
  usage: Usage;
}

/* ---------------- 流式事件 ---------------- */

export type StreamEvent =
  | { type: 'start'; id: string; model: string }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'thinking_delta'; index: number; text: string; signature?: string }
  | { type: 'tool_start'; index: number; id: string; name: string }
  | { type: 'tool_delta'; index: number; json: string }
  | { type: 'block_stop'; index: number }
  | { type: 'stop'; stopReason: StopReason }
  | { type: 'usage'; usage: Partial<Usage> }
  | { type: 'error'; message: string; code?: string }
  | { type: 'ping' };

/** 协议适配器：一个协议 = 一组编解码器 */
export interface ProtocolCodec {
  /** 把上游原始 SSE 行转成 IR 事件（有状态） */
  decodeUpstream(line: string): StreamEvent[] | null;
  /** 判断上游流是否已结束 */
  isDone(line: string): boolean;
}

export type ProtocolName = 'anthropic' | 'openai-chat' | 'openai-responses' | 'gemini';

export interface EncoderContext {
  requestId: string;
  model: string;
  /** 客户端要求的模型名（编码时回填，避免客户端报 unknown model） */
  clientModel: string;
}

