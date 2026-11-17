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
  StreamYieldEvent,
  DeepSeekUsage
} from './types.js';

/**
 * A stream that went quiet for longer than its chunk timeout: before its first useful event not one byte came (a
 * keep-alive proves the connection alive there), after it no useful event came (keep-alives no longer count).
 */
export class StreamReadTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Stream chunk read timed out after ${timeoutMs.toString()}ms`);
    this.name = 'StreamReadTimeoutError';
  }
}

/**
 * No useful event (text, reasoning, a tool call or a finish) within DEEPSEEK_FIRST_EVENT_TIMEOUT_MS of sending the
 * request, whatever came before: DeepSeek admits a request it cannot serve yet with HTTP 200 and then sends only
 * `: keep-alive` comments, for up to 10 minutes.
 */
export class FirstEventTimeoutError extends Error {
  constructor(timeoutMs: number, keepAlives: number) {
    super(
      `No useful event within ${timeoutMs.toString()} ms of sending the request (DEEPSEEK_FIRST_EVENT_TIMEOUT_MS): ` +
        `${keepAlives.toString()} keep-alive comment(s), no text, reasoning or tool call`
    );
    this.name = 'FirstEventTimeoutError';
  }
}

/** How a stream ended: [DONE], the end of the body, the grace after a finish_reason, or the bound that cut it. */
export type StreamEnd = 'done' | 'server_close' | 'finish_grace' | 'first_event' | 'silence';

/** What one stream did, filled in as it goes: for the log and the LLM span. */
export interface StreamStats {
  /** SSE comment lines (`: keep-alive`). */
  keepAlives: number;
  /** From sending the request to the first useful event (ms); null while none came. */
  firstEventMs: number | null;
  usefulEvents: number;
  end: StreamEnd | null;
}

/** The bounds of one stream beyond its chunk timeout (parseSSEStream). */
export interface StreamBounds {
  /** When the request was sent (Date.now()): the first-event deadline and firstEventMs count from it. Default: now. */
  sentAt?: number;
  /** The most time from sentAt to the first useful event, whatever comes before it. Default: no such bound. */
  firstEventTimeoutMs?: number;
  /** After a chunk with a finish_reason, the most time spent on [DONE] or the end. Default: min(5000, chunk timeout). */
  finishGraceMs?: number;
  /** Filled in as the stream goes. */
  stats?: StreamStats;
}

/** The grace after a finish_reason: DeepSeek sends usage with the finish and [DONE] right after it. */
export const DEFAULT_FINISH_GRACE_MS = 5_000;

export class SSEParser {
  private buffer = '';
  /** SSE comment lines seen so far (DeepSeek's `: keep-alive` while it holds a request). */
  public comments = 0;

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
      if (!trimmed) {
        continue;
      }
      if (trimmed.startsWith(':')) {
        this.comments++;
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
  public usage: DeepSeekUsage | null = null;

  /**
   * Process a parsed SSE chunk data object.
   */
  processChunk(chunkData?: SSEChunkData): ProcessedChunkResult {
    if (chunkData?.usage) {
      this.usage = chunkData.usage;
    }

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

/** The longest delay a Node.js timer takes (config.ts MAX_TIMER_MS): a longer one would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** Progress: a chunk with text, reasoning or tool-call pieces, or with a finish_reason of its own. */
function isUsefulChunk(data: SSEChunkData | undefined, result: ProcessedChunkResult): boolean {
  return Boolean(
    result.reasoningDelta ||
      result.contentDelta ||
      (result.toolCallChunks && result.toolCallChunks.length > 0) ||
      data?.choices?.[0]?.finish_reason
  );
}

interface BodyChunk {
  done: boolean;
  value?: Uint8Array | string;
}

/** A response body read one chunk at a time, a ReadableStream's reader or an async iterable's iterator alike. */
interface BodyReader {
  read(): Promise<BodyChunk>;
  release(): void;
}

function openBody(stream: unknown): BodyReader | null {
  const withReader = stream as { getReader?: () => { read(): Promise<BodyChunk>; releaseLock(): void } } | null;
  if (typeof withReader?.getReader === 'function') {
    const reader = withReader.getReader();
    return {
      read: () => reader.read(),
      release: () => {
        try {
          reader.releaseLock();
        } catch {
          // Ignored
        }
      }
    };
  }
  if (stream && typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    const iterator = (stream as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]();
    return {
      read: async () => {
        const next = await iterator.next();
        return next.done ? { done: true } : { done: false, value: next.value };
      },
      release: () => {
        // Not awaited: a generator in the middle of an await finishes it first, and a read the bound gave up on may
        // never end.
        try {
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
        } catch {
          // Ignored
        }
      }
    };
  }
  return null;
}

const TIMED_OUT = Symbol('timed out');

/** `read`, or TIMED_OUT once `at` (Date.now() time) has passed, whichever comes first. */
async function readUntil(read: Promise<BodyChunk>, at: number): Promise<BodyChunk | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.min(MAX_TIMER_MS, Math.max(0, at - Date.now())));
  });
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Async generator to parse streaming response bodies into delta events. Only useful events are progress (a chunk
 * with text, reasoning or tool-call pieces, or a finish_reason of its own); SSE comments, empty lines and metadata-only
 * chunks are not. Each read is bounded by the phase the stream is in:
 * - before the first useful event, by `chunkTimeoutMs` after the last byte (any byte, a keep-alive too, proves the
 *   connection alive: StreamReadTimeoutError) and by `bounds.firstEventTimeoutMs` after `bounds.sentAt`, which nothing
 *   extends (FirstEventTimeoutError);
 * - after it, by `chunkTimeoutMs` after the last useful event: keep-alives no longer count (StreamReadTimeoutError);
 * - after a finish_reason, by `bounds.finishGraceMs` for [DONE] or the end; then the answer is taken as it is.
 * `bounds.stats` says how the stream went.
 */
export async function* parseSSEStream(
  stream: unknown,
  chunkTimeoutMs = 60000,
  bounds: StreamBounds = {}
): AsyncGenerator<StreamYieldEvent, void, unknown> {
  const parser = new SSEParser();
  const accumulator = new StreamAccumulator();
  const decoder = new TextDecoder('utf-8');
  const stats: StreamStats = bounds.stats ?? { keepAlives: 0, firstEventMs: null, usefulEvents: 0, end: null };
  const sentAt = bounds.sentAt ?? Date.now();
  const firstEventTimeoutMs = bounds.firstEventTimeoutMs;
  const firstEventDeadline = firstEventTimeoutMs === undefined ? Infinity : sentAt + firstEventTimeoutMs;
  const finishGraceMs = bounds.finishGraceMs ?? Math.min(DEFAULT_FINISH_GRACE_MS, chunkTimeoutMs);

  let lastByteAt = Date.now();
  let lastUsefulAt: number | null = null;
  let finishAt: number | null = null;

  /** Where the next read must end, and what its bound passing means (an error to throw, or null: the answer is done). */
  const nextBound = (): { at: number; passed: () => Error | null } => {
    if (finishAt !== null) {
      return { at: finishAt + finishGraceMs, passed: () => null };
    }
    const silence = {
      at: (lastUsefulAt ?? lastByteAt) + chunkTimeoutMs,
      passed: (): Error => {
        stats.end = 'silence';
        return new StreamReadTimeoutError(chunkTimeoutMs);
      }
    };
    if (lastUsefulAt !== null || firstEventDeadline > silence.at) {
      return silence;
    }
    return {
      at: firstEventDeadline,
      passed: () => {
        stats.end = 'first_event';
        return new FirstEventTimeoutError(firstEventTimeoutMs ?? 0, parser.comments);
      }
    };
  };

  const body = openBody(stream);
  try {
    while (body) {
      const bound = nextBound();
      const chunk = await readUntil(body.read(), bound.at);
      stats.keepAlives = parser.comments;
      if (chunk === TIMED_OUT) {
        const error = bound.passed();
        if (error) {
          throw error;
        }
        stats.end = 'finish_grace';
        break;
      }
      if (chunk.done) {
        stats.end = 'server_close';
        break;
      }
      lastByteAt = Date.now();
      const text = typeof chunk.value === 'string' ? chunk.value : decoder.decode(chunk.value, { stream: true });
      for (const ev of parser.feed(text)) {
        stats.keepAlives = parser.comments;
        if (ev.done) {
          stats.end = 'done';
          yield { type: 'done', accumulator };
          return;
        }
        const deltaResult = accumulator.processChunk(ev.data);
        if (isUsefulChunk(ev.data, deltaResult)) {
          const now = Date.now();
          stats.usefulEvents++;
          stats.firstEventMs ??= now - sentAt;
          lastUsefulAt = now;
          if (finishAt === null && ev.data?.choices?.[0]?.finish_reason) {
            finishAt = now;
          }
        }
        yield { type: 'delta', ...deltaResult, accumulator };
      }
      stats.keepAlives = parser.comments;
    }
  } finally {
    stats.keepAlives = parser.comments;
    body?.release();
  }

  yield { type: 'done', accumulator };
}
