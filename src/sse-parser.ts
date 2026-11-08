/**
 * sse-parser.ts — Robust Server-Sent Events parser for DeepSeek / OpenAI streaming.
 * Handles 3-phase streaming:
 *   1. reasoning_content (DeepSeek-R1 CoT tokens)
 *   2. content (response text tokens)
 *   3. tool_calls (function name and argument chunks)
 */

import type {
  SSEEvent,
  SSEChunkData,
  ProcessedChunkResult,
  ToolCall,
  StreamYieldEvent
} from './types.js';

export class SSEParser {
  private buffer = '';

  /**
   * Feed a raw text chunk into the buffer.
   * Returns array of parsed SSE events.
   */
  feed(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];

    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }

      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) {
        continue;
      }

      if (trimmed.startsWith('data:')) {
        const rawData = trimmed.slice(5).trim();
        if (rawData === '[DONE]') {
          events.push({ done: true });
        } else {
          try {
            const parsed = JSON.parse(rawData) as SSEChunkData;
            events.push({ done: false, data: parsed });
          } catch {
            // Malformed chunk ignored
          }
        }
      }
    }

    return events;
  }

  reset(): void {
    this.buffer = '';
  }
}

export class StreamAccumulator {
  public reasoningContent = '';
  public content = '';
  public toolCalls: ToolCall[] = [];
  public finishReason: string | null = null;

  /**
   * Process a parsed SSE chunk data object.
   */
  processChunk(chunkData?: SSEChunkData): ProcessedChunkResult {
    if (!chunkData?.choices || !Array.isArray(chunkData.choices) || chunkData.choices.length === 0) {
      return {
        reasoningDelta: null,
        contentDelta: null,
        toolCallChunks: null,
        finishReason: this.finishReason
      };
    }

    const choice = chunkData.choices[0];
    if (!choice) {
      return {
        reasoningDelta: null,
        contentDelta: null,
        toolCallChunks: null,
        finishReason: this.finishReason
      };
    }

    if (choice.finish_reason) {
      this.finishReason = choice.finish_reason;
    }

    const delta = choice.delta ?? {};
    let reasoningDelta: string | null = null;
    let contentDelta: string | null = null;
    let toolCallChunks: Array<{
      index?: number;
      id?: string;
      type?: string;
      function?: {
        name?: string;
        arguments?: string;
      };
    }> | null = null;

    // Phase 1: Reasoning content (DeepSeek-R1 CoT)
    if (delta.reasoning_content) {
      this.reasoningContent += delta.reasoning_content;
      reasoningDelta = delta.reasoning_content;
    }

    // Phase 2: Response text content
    if (delta.content) {
      this.content += delta.content;
      contentDelta = delta.content;
    }

    // Phase 3: Tool calls streaming
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      toolCallChunks = [];
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const existing = this.toolCalls[idx];
        if (!existing) {
          this.toolCalls[idx] = {
            id: tc.id ?? `call_${Date.now().toString()}_${idx.toString()}`,
            type: tc.type ?? 'function',
            function: {
              name: tc.function?.name ?? '',
              arguments: tc.function?.arguments ?? ''
            }
          };
        } else {
          if (tc.id) {
            existing.id = tc.id;
          }
          if (tc.type) {
            existing.type = tc.type;
          }
          if (tc.function?.name) {
            existing.function.name += tc.function.name;
          }
          if (tc.function?.arguments) {
            existing.function.arguments += tc.function.arguments;
          }
        }
        toolCallChunks.push(tc);
      }
    }

    return {
      reasoningDelta,
      contentDelta,
      toolCallChunks,
      finishReason: this.finishReason
    };
  }

  getValidToolCalls(): ToolCall[] {
    return this.toolCalls.filter((tc): tc is ToolCall => Boolean(tc?.function?.name));
  }

  isTruncated(): boolean {
    return this.finishReason === 'length';
  }
}

/**
 * Async generator to parse streaming response bodies into delta events.
 */
export async function* parseSSEStream(
  stream: unknown,
  chunkTimeoutMs = 60000
): AsyncGenerator<StreamYieldEvent, void, unknown> {
  const parser = new SSEParser();
  const accumulator = new StreamAccumulator();
  const decoder = new TextDecoder('utf-8');

  interface StreamReader {
    read(): Promise<{ done: boolean; value?: Uint8Array | string }>;
    releaseLock(): void;
  }

  const streamWithReader = stream as { getReader?: () => StreamReader } | null;
  const reader: StreamReader | null =
    typeof streamWithReader?.getReader === 'function' ? streamWithReader.getReader() : null;

  const readWithTimeout = (r: StreamReader, ms: number) => {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<{ done: boolean; value?: Uint8Array | string }>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Stream chunk read timed out after ${ms.toString()}ms`));
      }, ms);
    });
    return Promise.race([r.read(), timeoutPromise]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
  };

  try {
    if (reader) {
      while (true) {
        const { done, value } = await readWithTimeout(reader, chunkTimeoutMs);
        if (done) {
          break;
        }
        const text = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
        const events = parser.feed(text);
        for (const ev of events) {
          if (ev.done) {
            yield { type: 'done', accumulator };
            return;
          }
          const deltaResult = accumulator.processChunk(ev.data);
          yield { type: 'delta', ...deltaResult, accumulator };
        }
      }
    } else if (stream && typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
      for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        const events = parser.feed(text);
        for (const ev of events) {
          if (ev.done) {
            yield { type: 'done', accumulator };
            return;
          }
          const deltaResult = accumulator.processChunk(ev.data);
          yield { type: 'delta', ...deltaResult, accumulator };
        }
      }
    }
  } finally {
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        // Ignored
      }
    }
  }

  yield { type: 'done', accumulator };
}
