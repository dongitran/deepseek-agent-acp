/**
 * types.ts — Type definitions for Agent Client Protocol (ACP) and DeepSeek Streaming.
 */

export interface ToolCallFunction {
  name: string;
  arguments: string;
}

export interface ToolCall {
  id: string;
  type: string;
  function: ToolCallFunction;
  index?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface SSEChoiceDelta {
  reasoning_content?: string;
  content?: string;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

export interface SSEChoice {
  index?: number;
  delta?: SSEChoiceDelta;
  finish_reason?: 'stop' | 'tool_calls' | 'length' | null;
}

export interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export interface SSEChunkData {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices: SSEChoice[];
  usage?: DeepSeekUsage;
}

export interface SSEEvent {
  done: boolean;
  data?: SSEChunkData;
}

export interface ProcessedChunkResult {
  reasoningDelta: string | null;
  contentDelta: string | null;
  toolCallChunks: Array<{
    index?: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }> | null;
  finishReason: string | null;
}

export interface StreamYieldEvent {
  type: 'delta' | 'done';
  reasoningDelta?: string | null;
  contentDelta?: string | null;
  toolCallChunks?: Array<unknown> | null;
  finishReason?: string | null;
  accumulator: {
    reasoningContent: string;
    content: string;
    toolCalls: ToolCall[];
    finishReason: string | null;
    usage: DeepSeekUsage | null;
    isTruncated: () => boolean;
    getValidToolCalls: () => ToolCall[];
  };
}

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JSONRPCNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}
