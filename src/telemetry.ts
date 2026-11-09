/**
 * telemetry.ts — OpenTelemetry and Arize Phoenix tracing for deepseek-agent-acp.
 * Implements OpenInference GenAI semantic conventions:
 * - AGENT root span (agent_turn) representing complete ACP turn.
 * - LLM child spans (llm:<model>) per iteration tracking streaming deltas & token usage.
 * - TOOL child spans (tool:<name>) for MCP tool execution with duration, output bytes, and status.
 * - Special extraction of `nostr.posted_event_id` for buzz-trace topological thread linking.
 * - Opt-in capture (src/trace-config.ts): the exact messages each LLM call sent and the model's answer
 *   (OTEL_CAPTURE_LLM_MESSAGES), and chosen tools' outputs (OTEL_CAPTURE_TOOL_OUTPUT). Off, spans are 0.3.0's.
 * - Two-tier secret redaction (exact match, then linear-time token patterns) before any cut, and fail-open design.
 * - Strict stdio hygiene: zero writes to stdout (all diagnostics redirected to stderr).
 */

import { trace, context, SpanStatusCode, type Attributes, type Span } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PAYLOAD_MAX_CHARS,
  PAYLOAD_TRUNCATION_MARKER,
  resolveTraceSettings,
  toolOutputMatcher,
  type TraceSettings
} from './trace-config.js';
import type { ChatMessage, DeepSeekUsage } from './types.js';

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
  /1\/\/[0-9a-zA-Z_-]+/g
];

/**
 * JWT, `\beyJ<10+ base64url>.eyJ<10+ base64url>.<1+ base64url>`, read in linear time. A token that starts inside a run of
 * base64url characters must end that run with `.eyJ…`, so when the run's leftmost `eyJ` does not start a token, no later
 * `eyJ` of the same run can: the second alternative then consumes the run. The single pattern this replaces re-scanned
 * the run from every `eyJ` in it (0.2 s for 32 KB of `eyJ-eyJ-…`, 0.9 s for 64 KB) and redacts exactly the same tokens.
 */
const JWT_OR_RUN = /(\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+)|\beyJ[a-zA-Z0-9_-]*/g;

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
    'ANTHROPIC_API_KEY',
    // A meeting or mail agent's own gate token: its tools' outputs and the messages sent to the model are traced.
    'MEETING_GATE_TOKEN',
    'MAIL_GATE_TOKEN'
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
 * Truncate a payload to maximum character length. trace-config.ts sizes the span value limit from this cut and marker.
 */
export function truncatePayload(text: string, maxLen = PAYLOAD_MAX_CHARS): string {
  if (!text) {
    return '';
  }
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, maxLen)}${PAYLOAD_TRUNCATION_MARKER}`;
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

  return redactText(text);
}

/**
 * Redact a whole string, however long: every rule reads it in linear time. Message capture uses it directly, so a
 * message is redacted in full before it is cut to its cap (a secret across the cut is never half kept).
 */
function redactText(input: string): string {
  let text = input;

  // 1. Exact match against known process secrets
  const secrets = getProcessSecrets();
  for (const secret of secrets) {
    if (text.includes(secret)) {
      text = text.split(secret).join('[REDACTED]');
    }
  }

  // 2. Prefixed patterns (Nostr, DeepSeek, Anthropic, GitLab, GitHub, Google OAuth), then JWT
  for (const pattern of PREFIXED_PATTERNS) {
    text = text.replace(pattern, '[REDACTED]');
  }
  return text.replace(JWT_OR_RUN, (match: string, jwt: string | undefined) => (jwt === undefined ? match : '[REDACTED]'));
}

/** A JSON object or array (what a tool such as meeting_wait returns), as opposed to plain text. */
function isJsonText(text: string): boolean {
  const start = text.trimStart()[0];
  if (start !== '{' && start !== '[') {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
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
// 1b. MESSAGE CAPTURE (OTEL_CAPTURE_LLM_MESSAGES) — OpenInference llm.input_messages / llm.tools
// ============================================================================

/** What the adapter POSTs to /chat/completions: `messages`, `tools`, and the parameters (every other field). */
export interface LlmRequestBody {
  messages: readonly ChatMessage[];
  tools?: readonly LlmToolDefinition[];
  [parameter: string]: unknown;
}

/** An OpenAI function tool as sent in `tools`. */
export interface LlmToolDefinition {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

const OMITTED_FOR_SIZE = '…[omitted for size]';
/** Attributes left free on an LLM span for what it records besides its messages and tool names: the span's own,
 *  invocation parameters, counts, token usage, output value and the answer's tool calls. */
const RESERVED_LLM_ATTRIBUTES = 64;
/** llm.invocation_parameters, llm.input_messages_total, _omitted, _trimmed. */
const REQUEST_SUMMARY_ATTRIBUTES = 4;

function truncationMarker(removed: number): string {
  return `…[truncated ${removed.toString()} chars]`;
}

/** At most `maxChars` characters, marker included; the cut never splits a surrogate pair. */
function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  let keep = Math.max(0, maxChars - truncationMarker(text.length).length);
  const last = text.charCodeAt(keep - 1);
  if (keep > 0 && last >= 0xd800 && last <= 0xdbff) {
    keep -= 1;
  }
  return `${text.slice(0, keep)}${truncationMarker(text.length - keep)}`;
}

/** A message field as text: strings as they are, other values as JSON, nothing for null/undefined. */
function textOf(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

interface CapturedToolCall {
  id?: string;
  name?: string;
  args?: string;
}

interface CapturedMessage {
  role: string;
  content?: string;
  toolCallId?: string;
  toolCalls: CapturedToolCall[];
}

function toolCallsOf(message: unknown): Array<Record<string, unknown>> {
  const calls = (message as { tool_calls?: unknown }).tool_calls;
  return Array.isArray(calls)
    ? calls.filter((call): call is Record<string, unknown> => Boolean(call) && typeof call === 'object')
    : [];
}

function functionOf(call: Record<string, unknown>): Record<string, unknown> {
  const fn = call.function;
  return fn && typeof fn === 'object' ? (fn as Record<string, unknown>) : {};
}

/** How many attributes a message becomes, from its shape alone (nothing is redacted to count). */
function attributeCountOf(message: ChatMessage): number {
  let count = 1 + (message.content === null || message.content === undefined ? 0 : 1);
  count += message.tool_call_id === null || message.tool_call_id === undefined ? 0 : 1;
  for (const call of toolCallsOf(message)) {
    const fn = functionOf(call);
    count += (call.id === undefined ? 0 : 1) + (fn.name === undefined ? 0 : 1) + (fn.arguments === undefined ? 0 : 1);
  }
  return count;
}

function capturedMessage(message: ChatMessage, record: (raw: string) => string): CapturedMessage {
  const content = textOf(message.content);
  const toolCallId = textOf(message.tool_call_id);
  return {
    role: textOf(message.role) ?? 'unknown',
    ...(content === undefined ? {} : { content: record(content) }),
    ...(toolCallId === undefined ? {} : { toolCallId: record(toolCallId) }),
    toolCalls: toolCallsOf(message).map((call) => {
      const fn = functionOf(call);
      const [id, name, args] = [textOf(call.id), textOf(fn.name), textOf(fn.arguments)];
      return {
        ...(id === undefined ? {} : { id: record(id) }),
        ...(name === undefined ? {} : { name: record(name) }),
        ...(args === undefined ? {} : { args: record(args) })
      };
    })
  };
}

function capturedSize(message: CapturedMessage): number {
  return message.toolCalls.reduce((size, call) => size + (call.args?.length ?? 0), message.content?.length ?? 0);
}

/** Replace a message's content and arguments by OMITTED_FOR_SIZE; false when there was nothing longer to cut. */
function omitForSize(message: CapturedMessage): boolean {
  let cut = false;
  if (message.content !== undefined && message.content.length > OMITTED_FOR_SIZE.length) {
    message.content = OMITTED_FOR_SIZE;
    cut = true;
  }
  for (const call of message.toolCalls) {
    if (call.args !== undefined && call.args.length > OMITTED_FOR_SIZE.length) {
      call.args = OMITTED_FOR_SIZE;
      cut = true;
    }
  }
  return cut;
}

function setMessageAttributes(attributes: Attributes, prefix: string, message: CapturedMessage): void {
  attributes[`${prefix}.message.role`] = message.role;
  if (message.content !== undefined) {
    attributes[`${prefix}.message.content`] = message.content;
  }
  if (message.toolCallId !== undefined) {
    attributes[`${prefix}.message.tool_call_id`] = message.toolCallId;
  }
  message.toolCalls.forEach((call, j) => {
    const at = `${prefix}.message.tool_calls.${j.toString()}.tool_call`;
    if (call.id !== undefined) {
      attributes[`${at}.id`] = call.id;
    }
    if (call.name !== undefined) {
      attributes[`${at}.function.name`] = call.name;
    }
    if (call.args !== undefined) {
      attributes[`${at}.function.arguments`] = call.args;
    }
  });
}

/**
 * The attributes of an LLM span that say exactly what was sent: OpenInference llm.input_messages.<i>.message.*,
 * llm.invocation_parameters (the body without messages and tools), llm.tools.<k>.tool.*, and how many messages were
 * sent, left out (over OTEL_LLM_MESSAGES_MAX or the span's attribute count) or cut (over the total budget).
 */
function llmRequestAttributes(body: LlmRequestBody, settings: TraceSettings, record: (raw: string) => string): Attributes {
  const { messages, tools, ...parameters } = body;
  const sent: readonly ChatMessage[] = Array.isArray(messages) ? (messages as readonly ChatMessage[]) : [];
  const toolList: readonly LlmToolDefinition[] = Array.isArray(tools) ? (tools as readonly LlmToolDefinition[]) : [];
  const attributes: Attributes = {
    'llm.invocation_parameters': record(JSON.stringify(parameters)),
    'llm.input_messages_total': sent.length
  };

  // Attribute budget: what the span may hold minus what it records besides the messages.
  let free = Math.max(
    0,
    (settings.spanLimits.attributeCountLimit ?? 128) - RESERVED_LLM_ATTRIBUTES - REQUEST_SUMMARY_ATTRIBUTES
  );
  const perTool = settings.captureLlmToolSchemas ? 3 : 1;
  const toolCount = Math.min(toolList.length, Math.floor(free / perTool));
  free -= toolCount * perTool;

  // Which messages: the first 2 and the newest MAX-2; then, while over the attribute budget, the oldest of the middle.
  const max = settings.llmMessagesMax;
  let kept = sent.map((_, i) => i);
  if (sent.length > max) {
    kept = [0, 1, ...kept.slice(sent.length - (max - 2))];
  }
  let attributeCount = kept.reduce((n, i) => n + attributeCountOf(sent[i] as ChatMessage), 0);
  while (attributeCount > free && kept.length > 0) {
    const at = kept.length > 3 ? 2 : kept.length === 3 ? 1 : 0;
    attributeCount -= attributeCountOf(sent[kept[at] as number] as ChatMessage);
    kept.splice(at, 1);
  }

  // Total budget: cut the oldest middle messages (never the first 2 or the last 4) until the contents fit.
  const captured = kept.map((i) => capturedMessage(sent[i] as ChatMessage, record));
  let size = captured.reduce((n, message) => n + capturedSize(message), 0);
  let trimmed = 0;
  for (let i = 2; i < captured.length - 4 && size > settings.llmMessagesMaxTotalChars; i++) {
    const message = captured[i] as CapturedMessage;
    const before = capturedSize(message);
    if (omitForSize(message)) {
      size -= before - capturedSize(message);
      trimmed++;
    }
  }

  if (sent.length > kept.length) {
    attributes['llm.input_messages_omitted'] = sent.length - kept.length;
  }
  if (trimmed > 0) {
    attributes['llm.input_messages_trimmed'] = trimmed;
  }
  captured.forEach((message, i) => {
    setMessageAttributes(attributes, `llm.input_messages.${i.toString()}`, message);
  });
  toolList.slice(0, toolCount).forEach((tool, k) => {
    const fn: NonNullable<LlmToolDefinition['function']> = (tool && typeof tool === 'object' ? tool.function : undefined) ?? {};
    const at = `llm.tools.${k.toString()}.tool`;
    attributes[`${at}.name`] = record(textOf(fn.name) ?? '');
    if (settings.captureLlmToolSchemas) {
      attributes[`${at}.description`] = record(textOf(fn.description) ?? '');
      attributes[`${at}.json_schema`] = record(JSON.stringify(tool));
    }
  });
  return attributes;
}

let captureErrorCount = 0;

/** Capture must never break or stop a turn: a failure is logged (the first, then every 100th) and the span goes on. */
function logCaptureError(err: unknown): void {
  captureErrorCount++;
  if (captureErrorCount === 1 || captureErrorCount % 100 === 0) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[deepseek-acp:TELEMETRY] Message capture failed (#${captureErrorCount.toString()}): ${msg}`);
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
 * Regex matching posted Nostr event ID across text, JSON, and escaped JSON formats:
 * - buzz messages send / relay stdout: {"accepted":true,"event_id":"<64 hex>",...}
 * - escaped JSON stdout: {\"accepted\":true,\"event_id\":\"<64 hex>\"}
 * - reply tools: `posted (N characters) · event_id <64 hex>`
 * - shell assignments: `event_id=<64 hex>` or `event_id: <64 hex>`
 */
export const POSTED_OUTPUT_PATTERN =
  /\bevent_id\\?["']?\s*[:=]?\s*\\?["']?([0-9a-f]{64})(?![0-9a-f])/i;

/**
 * Extract the posted Buzz event ID from a reply tool result or shell output.
 */
export function extractPostedEventId(output: unknown): string | undefined {
  let text = '';
  if (typeof output === 'string') {
    text = output;
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      if (parsed && typeof parsed.stdout === 'string') {
        text += ` ${parsed.stdout}`;
      }
    } catch {
      // Ignored
    }
  } else if (output && typeof output === 'object') {
    const rec = output as Record<string, unknown>;
    text = JSON.stringify(output);
    if (typeof rec.stdout === 'string') {
      text += ` ${rec.stdout}`;
    }
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
  /**
   * With OTEL_CAPTURE_LLM_MESSAGES=true, record exactly what is about to be sent (call it right before the request, so a
   * failed request still shows it). Otherwise nothing. Never throws.
   */
  recordRequest(body: LlmRequestBody): void;
  /**
   * With OTEL_CAPTURE_LLM_MESSAGES=true, record the model's answer as llm.output_messages.0 — on every path that ends
   * the span, including a stream that broke half-way (what had arrived). The first call wins; nothing after the span
   * ended. Never throws.
   */
  recordOutput(message: LlmOutputMessage): void;
  end(outputValue?: string, errorMessage?: string): void;
}

/** The assistant message the model returned (or had returned when the stream stopped). */
export interface LlmOutputMessage {
  content: string | null;
  tool_calls?: readonly unknown[];
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

export interface TelemetryOptions {
  /** Redacted by exact match (and as base64) wherever they appear, e.g. DEEPSEEK_API_KEY read before the env purge. */
  secrets?: string[];
  /** What to record and how to size the provider and exporter; resolveTraceSettings(process.env) when omitted. */
  trace?: TraceSettings;
  /**
   * Test seam: a span processor that replaces the OTLP export (tests pass a SimpleSpanProcessor over an
   * InMemorySpanExporter). With it no endpoint is needed and nothing is registered globally.
   */
  spanProcessor?: SpanProcessor;
}

export function initTelemetry(options?: TelemetryOptions): TelemetryService | null {
  if (options?.secrets) {
    for (const s of options.secrets) {
      registerSecret(s);
    }
  }

  const tracesEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const injectedProcessor = options?.spanProcessor;
  if (!tracesEndpoint && !injectedProcessor) {
    return null;
  }

  try {
    const settings = options?.trace ?? resolveTraceSettings(process.env).settings;
    const serviceName = process.env.OTEL_SERVICE_NAME ?? 'deepseek-agent';
    const projectName = process.env.PHOENIX_PROJECT_NAME ?? 'default';
    const apiKey = process.env.PHOENIX_API_KEY;

    const headers: Record<string, string> = {
      'x-project-name': projectName
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    // Without capture these are 0.3.0's settings (trace-config.ts); capture raises the limits and the export timeout.
    const spanProcessor =
      injectedProcessor ??
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: tracesEndpoint,
          headers,
          timeoutMillis: settings.exporter.timeoutMillis
        }),
        { ...settings.batch }
      );

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      'openinference.project.name': projectName
    });

    const provider = new NodeTracerProvider({
      resource,
      spanProcessors: [spanProcessor],
      spanLimits: { ...settings.spanLimits }
    });

    if (!injectedProcessor) {
      provider.register();
    }
    const tracer = provider.getTracer('deepseek-agent-acp', getPackageVersion());
    const capturesToolOutput = toolOutputMatcher(settings.toolOutput);

    return {
      startTurnSpan(
        sessionId: string,
        promptText: string,
        modelName?: string,
        nostrMeta?: NostrMetadata
      ): TurnSpanHandle {
        // Extract the event message block if present for cleaner prompt preview in Phoenix & buzz-trace
        let promptForSpan = promptText;
        if (promptText.includes('\n') && promptText.includes('Event ID:')) {
          const blocks = promptText.split(/\n{2,}/);
          const eventBlock = blocks.find((b) => b.includes('Event ID:'));
          if (eventBlock) {
            promptForSpan = eventBlock;
          }
        }
        const sanitizedPrompt = truncatePayload(redactSecrets(promptForSpan), 8192);
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

        // Message capture: every model call of a turn re-sends the whole history (a call is one turn of up to an
        // hour), so each distinct string is redacted and capped once per turn. Holds only the latest request's strings.
        let capturedStrings = new Map<string, string>();

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
            let requestRecorded = false;
            let outputRecorded = false;

            return {
              recordRequest(body: LlmRequestBody): void {
                if (!settings.captureLlmMessages || requestRecorded || !llmSpan.isRecording()) {
                  return;
                }
                requestRecorded = true;
                try {
                  const previous = capturedStrings;
                  const current = new Map<string, string>();
                  const record = (raw: string): string => {
                    let value = current.get(raw) ?? previous.get(raw);
                    if (value === undefined) {
                      value = capText(redactText(raw), settings.llmMessageMaxChars);
                    }
                    current.set(raw, value);
                    return value;
                  };
                  llmSpan.setAttributes(llmRequestAttributes(body, settings, record));
                  capturedStrings = current;
                } catch (err: unknown) {
                  logCaptureError(err);
                }
              },

              recordOutput(message: LlmOutputMessage): void {
                if (!settings.captureLlmMessages || outputRecorded || !llmSpan.isRecording()) {
                  return;
                }
                outputRecorded = true;
                try {
                  const answer = { role: 'assistant', content: message.content, tool_calls: message.tool_calls };
                  const captured = capturedMessage(answer as ChatMessage, (raw) =>
                    capText(redactText(raw), settings.llmMessageMaxChars)
                  );
                  const attributes: Attributes = {};
                  setMessageAttributes(attributes, 'llm.output_messages.0', captured);
                  llmSpan.setAttributes(attributes);
                } catch (err: unknown) {
                  logCaptureError(err);
                }
              },

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
            let hasPostedId = false;
            if (!isError) {
              const postedId = extractPostedEventId(output);
              if (postedId) {
                hasPostedId = true;
                toolSpan.setAttribute('nostr.posted_event_id', postedId);
                rootSpan.setAttribute('nostr.posted_event_id', postedId);
                // Ensure output.value and tool.output are captured on the posting span for trace fidelity
                const rawStr = typeof output === 'string' ? output : JSON.stringify(output);
                const sanitizedOut = truncatePayload(redactSecrets(rawStr), 8192);
                toolSpan.setAttribute('output.value', sanitizedOut);
                toolSpan.setAttribute('tool.output', sanitizedOut);
                toolSpan.setAttribute('output.mime_type', 'text/plain');
              }
            }

            // OTEL_CAPTURE_TOOL_OUTPUT (true, or names/globs such as meeting_*). The MIME type describes the recorded
            // value: JSON cut at 8 KB is no longer JSON. buzz-trace reads posted ids only from posting tools' outputs.
            if (capturesToolOutput(entry.toolName) && output !== undefined && !hasPostedId) {
              const sanitizedOut = truncatePayload(redactSecrets(output), 8192);
              toolSpan.setAttribute('output.value', sanitizedOut);
              toolSpan.setAttribute('output.mime_type', isJsonText(sanitizedOut) ? 'application/json' : 'text/plain');
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
