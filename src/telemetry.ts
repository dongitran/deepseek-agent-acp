/**
 * telemetry.ts — OpenTelemetry and Arize Phoenix tracing for deepseek-agent-acp.
 * Implements OpenInference GenAI semantic conventions:
 * - AGENT root span (agent_turn) representing complete ACP turn.
 * - LLM child spans (llm:<model>) per iteration tracking streaming deltas & token usage.
 * - TOOL child spans (tool:<name>) for MCP tool execution with duration, output bytes, and status.
 * - Special extraction of `nostr.posted_event_id` for buzz-trace topological thread linking.
 * - Two-tier secret redaction (32KB pre-truncation, exact-match, bounded regexes) and fail-open design.
 * - Strict stdio hygiene: zero writes to stdout (all diagnostics redirected to stderr).
 */

import { trace, context, SpanStatusCode, type Span } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DeepSeekUsage } from './types.js';

// ============================================================================
// 1. SECRET HYGIENE & REDACTION
// ============================================================================

const PREFIXED_PATTERNS = [
  /nsec1[0-9a-z]{58}/gi,
  /sk-[a-zA-Z0-9_\-.]{20,64}/g,
  /sk-ant-[a-zA-Z0-9_.-]+/g,
  /\bgl(pat|rt|dt|ptt|cbt|oas)-[0-9a-zA-Z_-]+/g,
  /\bgh[pousr]_[0-9a-zA-Z]{36}\b/g,
  /ya29\.[0-9a-zA-Z_-]+/g,
  /1\/\/[0-9a-zA-Z_-]+/g,
  /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+/g
];

const explicitSecrets = new Set<string>();
let cachedProcessSecrets: string[] | null = null;

export function _resetProcessSecretsCache(): void {
  cachedProcessSecrets = null;
  explicitSecrets.clear();
}

/**
 * Register a secret string for exact-match redaction (e.g. DEEPSEEK_API_KEY before env deletion).
 */
export function registerSecret(secret: string | undefined | null): void {
  if (!secret || typeof secret !== 'string' || secret.length < 8) {
    return;
  }
  explicitSecrets.add(secret);
  try {
    const b64 = Buffer.from(secret).toString('base64');
    if (b64.length >= 8) {
      explicitSecrets.add(b64);
    }
  } catch {
    // Ignore base64 conversion errors
  }
  cachedProcessSecrets = null;
}

function getProcessSecrets(): string[] {
  if (cachedProcessSecrets !== null) {
    return cachedProcessSecrets;
  }
  const secrets = new Set<string>(explicitSecrets);
  const sensitiveKeys = [
    'DEEPSEEK_API_KEY',
    'BUZZ_PRIVATE_KEY',
    'GITLAB_TOKEN',
    'PHOENIX_API_KEY',
    'AGY_OAUTH_TOKEN_B64',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY'
  ];

  for (const key of sensitiveKeys) {
    const val = process.env[key];
    if (val && typeof val === 'string' && val.length >= 8) {
      secrets.add(val);
      try {
        const b64 = Buffer.from(val).toString('base64');
        if (b64.length >= 8) {
          secrets.add(b64);
        }
      } catch {
        // Ignore base64 conversion errors
      }
    }
  }

  // Deduplicate and sort descending by length to replace longer strings first
  cachedProcessSecrets = Array.from(secrets).sort((a, b) => b.length - a.length);
  return cachedProcessSecrets;
}

/**
 * Truncate a payload to maximum character length.
 */
export function truncatePayload(text: string, maxLen = 8192): string {
  if (!text) {
    return '';
  }
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}... [TRUNCATED]`;
}

/**
 * Redact sensitive secrets from text or object payloads.
 * Pre-truncates to 32KB to protect against regex catastrophic backtracking.
 */
export function redactSecrets(input: unknown): string {
  if (input === null || input === undefined) {
    return '';
  }
  let text = typeof input === 'string' ? input : JSON.stringify(input);

  // Pre-truncate to 32KB to avoid ReDoS on massive tool payloads
  if (text.length > 32768) {
    text = `${text.slice(0, 32768)}... [PRE_TRUNCATED]`;
  }

  // 1. Exact match against known process secrets
  const secrets = getProcessSecrets();
  for (const secret of secrets) {
    if (text.includes(secret)) {
      text = text.split(secret).join('[REDACTED]');
    }
  }

  // 2. Prefixed patterns (Nostr, DeepSeek, Anthropic, GitLab, GitHub, Google OAuth, JWT)
  for (const pattern of PREFIXED_PATTERNS) {
    text = text.replace(pattern, '[REDACTED]');
  }

  return text;
}

/**
 * Computes byte length of output safely without throwing TypeError
 * when output is an Array, Object, Buffer, or String.
 */
export function computeOutputBytes(output: unknown): number {
  if (output === null || output === undefined) {
    return 0;
  }
  if (typeof output === 'string') {
    return Buffer.byteLength(output, 'utf8');
  }
  if (Buffer.isBuffer(output)) {
    return output.length;
  }
  try {
    return Buffer.byteLength(JSON.stringify(output), 'utf8');
  } catch {
    return 0;
  }
}

// ============================================================================
// 2. NOSTR CONTEXT & BUZZ-TRACE INTEGRATION
// ============================================================================

export interface NostrMetadata {
  threadRootId?: string;
  eventId?: string;
  channelId?: string;
  channelName?: string;
  replyToId?: string;
  senderName?: string;
  senderPubkey?: string;
}

/**
 * Parse Nostr context envelope injected by buzz-acp into prompt text.
 * Isolates the active envelope using lastIndexOf('Event ID:') to prevent
 * capturing cancelled or steered predecessor messages.
 */
export function parseNostrContext(rawText: unknown): NostrMetadata {
  const result: NostrMetadata = {};
  if (typeof rawText !== 'string' || !rawText) {
    return result;
  }

  const lastEventIdx = rawText.lastIndexOf('Event ID:');
  const contextSnippet = lastEventIdx !== -1 ? rawText.slice(Math.max(0, lastEventIdx - 200)) : rawText;

  // 1. Thread Root ID: "Thread root: <64-hex>" or "root=<64-hex>"
  const rootMatch = contextSnippet.match(/Thread root:\s*([a-f0-9]{64})/i) ?? contextSnippet.match(/\broot=([a-f0-9]{64})\b/i);
  if (rootMatch?.[1]) {
    result.threadRootId = rootMatch[1].toLowerCase();
  }

  // 2. Event ID: "Event ID: <64-hex>"
  const eventMatch = contextSnippet.match(/Event ID:\s*([a-f0-9]{64})/i);
  if (eventMatch?.[1]) {
    result.eventId = eventMatch[1].toLowerCase();
    if (!result.threadRootId) {
      result.threadRootId = result.eventId;
    }
  }

  // 3. Channel ID: "(#<UUID>)"
  const channelMatch = contextSnippet.match(/#([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (channelMatch?.[1]) {
    result.channelId = channelMatch[1].toLowerCase();
  }

  // 4. Channel Name: "Channel: <name> (#...)"
  const channelNameMatch = contextSnippet.match(/Channel:\s*([a-zA-Z0-9_\-]+)\s*\(/i);
  if (channelNameMatch?.[1]) {
    result.channelName = channelNameMatch[1];
  }

  // 5. Parent / Reply-To ID: "parent=<64-hex>"
  const parentMatch = contextSnippet.match(/\bparent=([a-f0-9]{64})\b/i);
  if (parentMatch?.[1]) {
    result.replyToId = parentMatch[1].toLowerCase();
  }

  // 6. Sender info: "From: Name (npub: ..., hex: <64-hex>)"
  const fromMatch = contextSnippet.match(/From:\s*([^(]+?)\s*\(.*?hex:\s*([a-f0-9]{64})\)/i);
  if (fromMatch?.[1] && fromMatch[2]) {
    result.senderName = fromMatch[1].trim();
    result.senderPubkey = fromMatch[2].toLowerCase();
  }

  return result;
}

/**
 * Regex matching posted Nostr event ID across text and JSON formats:
 * - buzz messages send / relay stdout: {"accepted":true,"event_id":"<64 hex>",...}
 * - reply tools: `posted (N characters) · event_id <64 hex>`
 * - shell assignments: `event_id=<64 hex>` or `event_id: <64 hex>`
 */
export const POSTED_OUTPUT_PATTERN = /\bevent_id["']?\s*[:=]?\s*["']?([0-9a-f]{64})(?![0-9a-f])/i;

/**
 * Extract the posted Buzz event ID from a reply tool result or shell output.
 */
export function extractPostedEventId(output: unknown): string | undefined {
  let text = '';
  if (typeof output === 'string') {
    text = output;
  } else if (output && typeof output === 'object') {
    text = JSON.stringify(output);
  }
  if (!text) {
    return undefined;
  }
  const match = POSTED_OUTPUT_PATTERN.exec(text.slice(0, 8192));
  return match?.[1] ? match[1].toLowerCase() : undefined;
}

// ============================================================================
// 3. TELEMETRY SERVICE INTERFACES
// ============================================================================

export interface LlmSpanHandle {
  recordUsage(usage: DeepSeekUsage): void;
  end(outputValue?: string, errorMessage?: string): void;
}

export interface SteerSpanParams {
  eventId?: string;
  text: string;
  senderName?: string;
  senderPubkey?: string;
  priority?: 'now' | 'later';
}

export interface TurnSpanHandle {
  startLlmSpan(modelName: string, iteration?: number): LlmSpanHandle;
  startToolSpan(toolCallId: string, toolName: string, toolParams: unknown): void;
  endToolSpan(toolCallId: string, output?: unknown, isError?: boolean, toolName?: string): void;
  recordSteerSpan(params: SteerSpanParams): void;
  recordUsage(usage: DeepSeekUsage): void;
  end(
    status: 'OK' | 'ERROR' | 'CANCELLED',
    outputOrError?: string,
    failureKind?: string,
    errorMessage?: string
  ): void;
}

export interface TelemetryService {
  startTurnSpan(
    sessionId: string,
    promptText: string,
    modelName?: string,
    nostrMeta?: NostrMetadata
  ): TurnSpanHandle;
  backgroundFlush(timeoutMs?: number): Promise<void>;
  shutdown(): Promise<void>;
}

// ============================================================================
// 4. FLUSH COALESCING & ERROR THROTTLING
// ============================================================================

let inFlightFlush: Promise<void> | null = null;
let exportErrorCount = 0;

function logExportError(err: unknown): void {
  exportErrorCount++;
  if (exportErrorCount === 1 || exportErrorCount % 100 === 0) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[deepseek-acp:TELEMETRY] Trace export failed (#${exportErrorCount.toString()}): ${msg}`);
  }
}

export function backgroundFlush(
  provider: { forceFlush(): Promise<void> },
  timeoutMs = 1500
): Promise<void> {
  if (inFlightFlush) {
    return inFlightFlush;
  }

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref(); // Prevent timer from pinning event loop
  });

  inFlightFlush = Promise.race([
    provider.forceFlush().catch((err: unknown) => {
      logExportError(err);
    }),
    timeoutPromise
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
    inFlightFlush = null;
  });

  return inFlightFlush;
}

export function getPackageVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(dir, '../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.2.0';
  } catch {
    return '0.2.0';
  }
}

// ============================================================================
// 5. INITIALIZATION & ENGINE IMPLEMENTATION
// ============================================================================

export function initTelemetry(options?: { secrets?: string[] }): TelemetryService | null {
  if (options?.secrets) {
    for (const s of options.secrets) {
      registerSecret(s);
    }
  }

  const tracesEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!tracesEndpoint) {
    return null;
  }

  try {
    const serviceName = process.env.OTEL_SERVICE_NAME ?? 'deepseek-agent';
    const projectName = process.env.PHOENIX_PROJECT_NAME ?? 'default';
    const apiKey = process.env.PHOENIX_API_KEY;

    const headers: Record<string, string> = {
      'x-project-name': projectName
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const exporter = new OTLPTraceExporter({
      url: tracesEndpoint,
      headers,
      timeoutMillis: 1500
    });

    const batchProcessor = new BatchSpanProcessor(exporter, {
      maxQueueSize: 2048,
      maxExportBatchSize: 128,
      scheduledDelayMillis: 5000,
      exportTimeoutMillis: 1500
    });

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      'openinference.project.name': projectName
    });

    const provider = new NodeTracerProvider({
      resource,
      spanProcessors: [batchProcessor],
      spanLimits: {
        attributeValueLengthLimit: 8192
      }
    });

    provider.register();
    const tracer = trace.getTracer('deepseek-agent-acp', getPackageVersion());

    return {
      startTurnSpan(
        sessionId: string,
        promptText: string,
        modelName?: string,
        nostrMeta?: NostrMetadata
      ): TurnSpanHandle {
        const sanitizedPrompt = truncatePayload(redactSecrets(promptText), 8192);
        const resolvedSessionId = nostrMeta?.threadRootId ?? sessionId;

        const rootSpan = tracer.startSpan('agent_turn', {
          attributes: {
            'openinference.span.kind': 'AGENT',
            'session.id': resolvedSessionId,
            'user.id': nostrMeta?.senderPubkey ?? 'anonymous',
            'agent.name': serviceName,
            'input.value': sanitizedPrompt,
            'input.mime_type': 'text/plain',
            ...(nostrMeta?.threadRootId ? { 'nostr.thread_root_id': nostrMeta.threadRootId } : {}),
            ...(nostrMeta?.eventId ? { 'nostr.event_id': nostrMeta.eventId } : {}),
            ...(nostrMeta?.channelId ? { 'nostr.channel_id': nostrMeta.channelId } : {}),
            ...(nostrMeta?.channelName ? { 'nostr.channel_name': nostrMeta.channelName } : {}),
            ...(nostrMeta?.replyToId ? { 'nostr.reply_to_id': nostrMeta.replyToId, 'nostr.reply_to': nostrMeta.replyToId } : {}),
            ...(nostrMeta?.senderName ? { 'nostr.sender_name': nostrMeta.senderName } : {}),
            ...(nostrMeta?.senderPubkey ? { 'nostr.sender_pubkey': nostrMeta.senderPubkey } : {}),
            ...(process.env.AGENT_ID ? { 'agent.id': process.env.AGENT_ID } : {}),
            ...(process.env.AGENT_COMMUNITY ? { 'agent.community': process.env.AGENT_COMMUNITY } : {})
          }
        });

        const rootContext = trace.setSpan(context.active(), rootSpan);
        const activeToolSpans = new Map<string, { span: Span; toolName: string }>();
        const activeLlmSpans = new Set<Span>();
        let hasEnded = false;

        // Cumulative token counters across iterations for rootSpan
        let totalPromptTokens = 0;
        let totalCompletionTokens = 0;
        let totalReasoningTokens = 0;
        let totalCacheHitTokens = 0;

        return {
          startLlmSpan(llmModel: string, iteration = 1): LlmSpanHandle {
            const effectiveModel = llmModel || modelName || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
            const llmSpan = tracer.startSpan(`llm:${effectiveModel}`, {
              attributes: {
                'openinference.span.kind': 'LLM',
                'session.id': resolvedSessionId,
                'llm.model_name': effectiveModel,
                'llm.provider': 'deepseek',
                'llm.iteration': iteration,
                'input.value': sanitizedPrompt,
                'input.mime_type': 'text/plain'
              }
            }, rootContext);

            activeLlmSpans.add(llmSpan);

            return {
              recordUsage(usage: DeepSeekUsage): void {
                const promptTokens = usage.prompt_tokens || 0;
                // In DeepSeek-R1, completion_tokens already includes reasoning_tokens
                const completionTokens = usage.completion_tokens || 0;
                const totalTokens = usage.total_tokens || (promptTokens + completionTokens);
                const cacheHit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
                const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;

                totalPromptTokens += promptTokens;
                totalCompletionTokens += completionTokens;
                totalReasoningTokens += reasoning;
                totalCacheHitTokens += cacheHit;

                llmSpan.setAttributes({
                  'llm.token_count.prompt': promptTokens,
                  'llm.token_count.completion': completionTokens,
                  'llm.token_count.total': totalTokens,
                  ...(cacheHit > 0 ? { 'llm.token_count.prompt_details.cache_read': cacheHit } : {}),
                  ...(reasoning > 0 ? { 'llm.token_count.completion_details.reasoning': reasoning } : {})
                });

                // Update root cumulative counts
                rootSpan.setAttributes({
                  'llm.token_count.prompt': totalPromptTokens,
                  'llm.token_count.completion': totalCompletionTokens,
                  'llm.token_count.total': totalPromptTokens + totalCompletionTokens,
                  ...(totalCacheHitTokens > 0 ? { 'llm.token_count.prompt_details.cache_read': totalCacheHitTokens } : {}),
                  ...(totalReasoningTokens > 0 ? { 'llm.token_count.completion_details.reasoning': totalReasoningTokens } : {})
                });
              },

              end(outputValue?: string, errorMessage?: string): void {
                activeLlmSpans.delete(llmSpan);
                if (outputValue) {
                  const sanitizedOut = truncatePayload(redactSecrets(outputValue), 8192);
                  llmSpan.setAttribute('output.value', sanitizedOut);
                  llmSpan.setAttribute('output.mime_type', 'text/plain');
                }
                if (errorMessage) {
                  llmSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
                  llmSpan.setAttribute('error.message', errorMessage);
                } else {
                  llmSpan.setStatus({ code: SpanStatusCode.OK });
                }
                llmSpan.end();
              }
            };
          },

          startToolSpan(toolCallId: string, toolName: string, toolParams: unknown): void {
            if (activeToolSpans.has(toolCallId)) {
              return;
            }
            const sanitizedParams = truncatePayload(redactSecrets(toolParams), 8192);
            const toolSpan = tracer.startSpan(`tool:${toolName}`, {
              attributes: {
                'openinference.span.kind': 'TOOL',
                'session.id': resolvedSessionId,
                'tool.name': toolName,
                'tool.call_id': toolCallId,
                'tool.parameters': sanitizedParams,
                'input.value': sanitizedParams,
                'input.mime_type': 'application/json'
              }
            }, rootContext);

            activeToolSpans.set(toolCallId, { span: toolSpan, toolName });
          },

          endToolSpan(toolCallId: string, output?: unknown, isError?: boolean, toolName?: string): void {
            const entry = activeToolSpans.get(toolCallId);
            if (!entry) {
              if (toolName) {
                rootSpan.addEvent('unmapped_tool_result', {
                  'tool.call_id': toolCallId,
                  'tool.name': toolName
                });
              }
              return;
            }
            const { span: toolSpan } = entry;
            const outputBytes = computeOutputBytes(output);
            toolSpan.setAttribute('tool.output_bytes', outputBytes);

            // Extract posted_event_id for any posting tool (reply, buzz-thread__reply, shell, etc.)
            if (!isError) {
              const postedId = extractPostedEventId(output);
              if (postedId) {
                toolSpan.setAttribute('nostr.posted_event_id', postedId);
                rootSpan.setAttribute('nostr.posted_event_id', postedId);
              }
            }

            if (process.env.OTEL_CAPTURE_TOOL_OUTPUT === 'true' && output !== undefined) {
              const sanitizedOut = truncatePayload(redactSecrets(output), 8192);
              toolSpan.setAttribute('output.value', sanitizedOut);
              toolSpan.setAttribute('output.mime_type', 'text/plain');
            }

            toolSpan.setAttribute('tool.is_error', Boolean(isError));
            if (isError) {
              toolSpan.setStatus({
                code: SpanStatusCode.ERROR,
                message: 'tool_execution_failed'
              });
            } else {
              toolSpan.setStatus({ code: SpanStatusCode.OK });
            }

            toolSpan.end();
            activeToolSpans.delete(toolCallId);
          },

          recordSteerSpan(steerParams: SteerSpanParams): void {
            const sanitizedText = truncatePayload(redactSecrets(steerParams.text), 8192);
            const steerSpan = tracer.startSpan('steer', {
              attributes: {
                'openinference.span.kind': 'CHAIN',
                'session.id': resolvedSessionId,
                ...(steerParams.eventId ? { 'nostr.event_id': steerParams.eventId.toLowerCase() } : {}),
                'input.value': sanitizedText,
                'input.mime_type': 'text/plain',
                ...(steerParams.senderName ? { 'nostr.sender_name': steerParams.senderName } : {}),
                ...(steerParams.senderPubkey ? { 'nostr.sender_pubkey': steerParams.senderPubkey.toLowerCase() } : {}),
                'steer.priority': steerParams.priority ?? 'now',
                'steer.delivered': true,
                'steer.end_reason': 'echo'
              }
            }, rootContext);

            steerSpan.setStatus({ code: SpanStatusCode.OK });
            steerSpan.end();

            rootSpan.addEvent('steer', {
              ...(steerParams.eventId ? { 'nostr.event_id': steerParams.eventId.toLowerCase() } : {}),
              'input.value': sanitizedText,
              ...(steerParams.senderName ? { 'nostr.sender_name': steerParams.senderName } : {}),
              'steer.priority': steerParams.priority ?? 'now',
              'steer.delivered': true
            });
          },

          recordUsage(usage: DeepSeekUsage): void {
            const promptTokens = usage.prompt_tokens || 0;
            const completionTokens = usage.completion_tokens || 0;
            const cacheHit = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
            const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;

            totalPromptTokens = Math.max(totalPromptTokens, promptTokens);
            totalCompletionTokens = Math.max(totalCompletionTokens, completionTokens);
            totalReasoningTokens = Math.max(totalReasoningTokens, reasoning);
            totalCacheHitTokens = Math.max(totalCacheHitTokens, cacheHit);

            rootSpan.setAttributes({
              'llm.token_count.prompt': totalPromptTokens,
              'llm.token_count.completion': totalCompletionTokens,
              'llm.token_count.total': totalPromptTokens + totalCompletionTokens,
              ...(totalCacheHitTokens > 0 ? { 'llm.token_count.prompt_details.cache_read': totalCacheHitTokens } : {}),
              ...(totalReasoningTokens > 0 ? { 'llm.token_count.completion_details.reasoning': totalReasoningTokens } : {})
            });
          },

          end(
            status: 'OK' | 'ERROR' | 'CANCELLED',
            outputOrError?: string,
            failureKind?: string,
            errorMessage?: string
          ): void {
            if (hasEnded) {
              return;
            }
            hasEnded = true;

            // Turn boundary sweep: close any orphaned tool spans safely
            for (const { span: orphanSpan } of activeToolSpans.values()) {
              orphanSpan.setStatus({
                code: SpanStatusCode.ERROR,
                message: 'orphaned_at_turn_end'
              });
              orphanSpan.setAttribute('error.message', 'orphaned_at_turn_end');
              orphanSpan.setAttribute('tool.is_error', true);
              orphanSpan.end();
            }
            activeToolSpans.clear();

            // Sweep any lingering LLM spans
            for (const orphanLlm of activeLlmSpans) {
              orphanLlm.setStatus({ code: SpanStatusCode.ERROR, message: 'orphaned_at_turn_end' });
              orphanLlm.end();
            }
            activeLlmSpans.clear();

            const outputValue = status === 'OK' ? outputOrError : undefined;
            if (outputValue) {
              const sanitizedOut = truncatePayload(redactSecrets(outputValue), 8192);
              rootSpan.setAttribute('output.value', sanitizedOut);
              rootSpan.setAttribute('output.mime_type', 'text/plain');
            }

            if (status === 'CANCELLED') {
              // Leave status UNSET to preserve SLO Error Budget; record stop_reason
              rootSpan.setAttribute('deepseek.stop_reason', 'cancelled');
            } else if (status === 'ERROR') {
              const errDesc = errorMessage ?? failureKind ?? outputOrError ?? 'turn_failed';
              rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: errDesc });
              if (failureKind) {
                rootSpan.setAttribute('error.kind', failureKind);
              }
              rootSpan.setAttribute('error.message', truncatePayload(errDesc, 1024));
            } else {
              rootSpan.setStatus({ code: SpanStatusCode.OK });
            }

            rootSpan.end();
          }
        };
      },

      backgroundFlush(timeoutMs = 1500): Promise<void> {
        return backgroundFlush(provider, timeoutMs);
      },

      async shutdown(): Promise<void> {
        try {
          await Promise.race([
            provider.shutdown(),
            new Promise<void>((resolve) => {
              const t = setTimeout(resolve, 1500);
              t.unref();
            })
          ]);
        } catch (err: unknown) {
          logExportError(err);
        }
      }
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[deepseek-acp:TELEMETRY] Failed to initialize OpenTelemetry SDK (running fail-open): ${msg}`);
    return null;
  }
}
