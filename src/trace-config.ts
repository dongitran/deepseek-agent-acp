/**
 * trace-config.ts — Pure resolution of what the OpenTelemetry tracing records, and how the provider and the exporter
 * are sized, from the environment. Same rules as config.ts: resolved once at start-up, never throws, and an invalid
 * value falls back to its default with a warning that names the variable.
 *
 * Everything here is opt-in. With no capture variable set the provider and the exporter get exactly 0.3.0's settings,
 * so every span is what 0.3.0 wrote. Capturing raises the SDK's span limits — measured with sdk-trace 2.12.0, the
 * shipped limits keep 128 attributes and silently drop a 12,000-character value — and gives the exporter time for the
 * larger requests.
 */

import { parsePositiveInt, type Env } from './config.js';

export const DEFAULT_LLM_MESSAGE_MAX_CHARS = 65_536;
export const DEFAULT_LLM_MESSAGES_MAX = 400;
export const DEFAULT_LLM_MESSAGES_MAX_TOTAL_CHARS = 524_288;
/** The fewest messages a span may keep: the first two (system prompt, first prompt) and the newest one. */
export const MIN_LLM_MESSAGES_MAX = 3;
/** The smallest per-string cap that still holds its own marker (`…[truncated 1000000000 chars]` is 30 characters). */
export const MIN_LLM_MESSAGE_MAX_CHARS = 64;

/** truncatePayload's cut for tool outputs and previews, and the marker it appends. */
export const PAYLOAD_MAX_CHARS = 8192;
export const PAYLOAD_TRUNCATION_MARKER = '... [TRUNCATED]';
/** The longest string truncatePayload(…, 8192) returns: a value limit below it cuts the marker off. */
export const TOOL_OUTPUT_MAX_RECORDED_CHARS = PAYLOAD_MAX_CHARS + PAYLOAD_TRUNCATION_MARKER.length;

const CAPTURE_ATTRIBUTE_COUNT_LIMIT = 4096;
const CAPTURE_EXPORT_TIMEOUT_MS = 10_000;
/** About 1 MB per export request with messages recorded (~13–30 KB per LLM span). */
const CAPTURE_MAX_EXPORT_BATCH_SIZE = 32;

// 0.3.0's provider and exporter settings, kept while nothing is captured.
const LEGACY_ATTRIBUTE_VALUE_LENGTH_LIMIT = 8192;
const LEGACY_EXPORT_TIMEOUT_MS = 1500;
const LEGACY_MAX_EXPORT_BATCH_SIZE = 128;
const MAX_QUEUE_SIZE = 2048;
const SCHEDULED_DELAY_MS = 5000;

/** Which tool outputs become `output.value`: none, every tool, or the tools whose names match a pattern. */
export type ToolOutputCapture = { mode: 'none' } | { mode: 'all' } | { mode: 'list'; patterns: string[] };

/** Passed to the tracer provider as `spanLimits`. No `attributeCountLimit` leaves the SDK's own default (env or 128). */
export interface SpanLimitSettings {
  attributeCountLimit?: number;
  attributeValueLengthLimit: number;
}

export interface ExporterSettings {
  timeoutMillis: number;
}

export interface BatchSettings {
  maxQueueSize: number;
  maxExportBatchSize: number;
  scheduledDelayMillis: number;
  exportTimeoutMillis: number;
}

export interface TraceSettings {
  /** OTEL_CAPTURE_LLM_MESSAGES: each LLM span records the exact request and the model's answer. */
  captureLlmMessages: boolean;
  /** OTEL_CAPTURE_LLM_TOOL_SCHEMAS: also each tool's description and JSON schema (only with message capture). */
  captureLlmToolSchemas: boolean;
  /** OTEL_CAPTURE_TOOL_OUTPUT */
  toolOutput: ToolOutputCapture;
  /** OTEL_LLM_MESSAGE_MAX_CHARS: the longest recorded content or arguments string, marker included. */
  llmMessageMaxChars: number;
  /** OTEL_LLM_MESSAGES_MAX: the most messages recorded per span (the first two and the newest MAX-2). */
  llmMessagesMax: number;
  /** OTEL_LLM_MESSAGES_MAX_TOTAL_CHARS: the budget for all recorded message contents of one span. */
  llmMessagesMaxTotalChars: number;
  spanLimits: SpanLimitSettings;
  exporter: ExporterSettings;
  batch: BatchSettings;
}

export interface TraceSettingsResolution {
  settings: TraceSettings;
  warnings: string[];
}

/** True when any span records more than 0.3.0 did, which is when the larger limits and export timeout apply. */
export function capturesAnything(settings: TraceSettings): boolean {
  return settings.captureLlmMessages || settings.toolOutput.mode !== 'none';
}

function resolveFlag(env: Env, name: string, warnings: string[]): boolean {
  const raw = (env[name] ?? '').trim();
  const value = raw.toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value !== '' && value !== 'false') {
    warnings.push(`Ignoring ${name}="${raw}": expected "true" or "false"; it stays off.`);
  }
  return false;
}

/** A tool name or a pattern with `*` wildcards; lower-cased before the check. */
const TOOL_NAME_PATTERN = /^[a-z0-9_./*-]+$/;
/** 0.3.0 recorded tool outputs only for "true": these words keep meaning "off" rather than naming a tool. */
const TOOL_OUTPUT_OFF = new Set(['', 'false', '0', 'no', 'off', 'none', 'disabled']);
/** …and these, which look like "every tool", recorded nothing either: off, with a warning that says to write true. */
const TOOL_OUTPUT_ON_LOOKALIKES = new Set(['1', 'yes', 'on', 'enabled', 'all']);

function resolveToolOutput(env: Env, warnings: string[]): ToolOutputCapture {
  const name = 'OTEL_CAPTURE_TOOL_OUTPUT';
  const raw = (env[name] ?? '').trim();
  const value = raw.toLowerCase();
  if (TOOL_OUTPUT_OFF.has(value)) {
    return { mode: 'none' };
  }
  if (value === 'true') {
    return { mode: 'all' };
  }
  if (TOOL_OUTPUT_ON_LOOKALIKES.has(value)) {
    warnings.push(`Ignoring ${name}="${raw}": write "true" to record every tool's output; no tool output is recorded.`);
    return { mode: 'none' };
  }
  const patterns = value.split(',').map((pattern) => pattern.trim());
  if (patterns.some((pattern) => !TOOL_NAME_PATTERN.test(pattern))) {
    warnings.push(
      `Ignoring ${name}="${raw}": expected "true", "false" or a comma-separated list of tool names with * wildcards ` +
        '(e.g. meeting_*,thread_read); no tool output is recorded.'
    );
    return { mode: 'none' };
  }
  return { mode: 'list', patterns };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** Built once at start-up: does this tool's output go into its span? Names compare case-insensitively and whole. */
export function toolOutputMatcher(capture: ToolOutputCapture): (toolName: string) => boolean {
  if (capture.mode === 'none') {
    return () => false;
  }
  if (capture.mode === 'all') {
    return () => true;
  }
  const regexes = capture.patterns.map(
    (pattern) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`, 'i')
  );
  return (toolName: string) => regexes.some((regex) => regex.test(toolName));
}

function resolvePositiveInt(env: Env, name: string, fallback: number, warnings: string[], min = 1): number {
  const raw = (env[name] ?? '').trim();
  if (raw === '') {
    return fallback;
  }
  const value = parsePositiveInt(raw);
  if (value === null || value < min) {
    const expected = min > 1 ? `an integer of ${min.toString()} or more` : 'a positive integer';
    warnings.push(`Ignoring ${name}="${raw}": expected ${expected}; using ${fallback.toString()}.`);
    return fallback;
  }
  return value;
}

/** The first valid positive integer among `names` (in order), else `fallback`; an invalid one is skipped with a warning. */
function firstPositiveInt(env: Env, names: readonly string[], fallback: number, warnings: string[]): number {
  for (const name of names) {
    const raw = (env[name] ?? '').trim();
    if (raw === '') {
      continue;
    }
    const value = parsePositiveInt(raw);
    if (value !== null) {
      return value;
    }
    warnings.push(`Ignoring ${name}="${raw}": expected a positive integer.`);
  }
  return fallback;
}

export function resolveTraceSettings(env: Env): TraceSettingsResolution {
  const warnings: string[] = [];
  const captureLlmMessages = resolveFlag(env, 'OTEL_CAPTURE_LLM_MESSAGES', warnings);
  let captureLlmToolSchemas = resolveFlag(env, 'OTEL_CAPTURE_LLM_TOOL_SCHEMAS', warnings);
  if (captureLlmToolSchemas && !captureLlmMessages) {
    warnings.push('OTEL_CAPTURE_LLM_TOOL_SCHEMAS=true has no effect without OTEL_CAPTURE_LLM_MESSAGES=true.');
    captureLlmToolSchemas = false;
  }
  const toolOutput = resolveToolOutput(env, warnings);
  const llmMessageMaxChars = resolvePositiveInt(
    env,
    'OTEL_LLM_MESSAGE_MAX_CHARS',
    DEFAULT_LLM_MESSAGE_MAX_CHARS,
    warnings,
    MIN_LLM_MESSAGE_MAX_CHARS
  );
  const llmMessagesMax = resolvePositiveInt(
    env,
    'OTEL_LLM_MESSAGES_MAX',
    DEFAULT_LLM_MESSAGES_MAX,
    warnings,
    MIN_LLM_MESSAGES_MAX
  );
  const llmMessagesMaxTotalChars = resolvePositiveInt(
    env,
    'OTEL_LLM_MESSAGES_MAX_TOTAL_CHARS',
    DEFAULT_LLM_MESSAGES_MAX_TOTAL_CHARS,
    warnings
  );

  const settings: TraceSettings = {
    captureLlmMessages,
    captureLlmToolSchemas,
    toolOutput,
    llmMessageMaxChars,
    llmMessagesMax,
    llmMessagesMaxTotalChars,
    spanLimits: { attributeValueLengthLimit: LEGACY_ATTRIBUTE_VALUE_LENGTH_LIMIT },
    exporter: { timeoutMillis: LEGACY_EXPORT_TIMEOUT_MS },
    batch: {
      maxQueueSize: MAX_QUEUE_SIZE,
      maxExportBatchSize: LEGACY_MAX_EXPORT_BATCH_SIZE,
      scheduledDelayMillis: SCHEDULED_DELAY_MS,
      exportTimeoutMillis: LEGACY_EXPORT_TIMEOUT_MS
    }
  };
  if (!capturesAnything(settings)) {
    return { settings, warnings };
  }

  // Something is captured: the SDK must keep every attribute and every value we record, and the exporter must have
  // time to send them. The OpenTelemetry variables keep their usual precedence (span-specific, then general).
  settings.spanLimits = {
    attributeCountLimit: firstPositiveInt(
      env,
      ['OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT', 'OTEL_ATTRIBUTE_COUNT_LIMIT'],
      CAPTURE_ATTRIBUTE_COUNT_LIMIT,
      warnings
    ),
    attributeValueLengthLimit: firstPositiveInt(
      env,
      ['OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT', 'OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT'],
      Math.max(LEGACY_ATTRIBUTE_VALUE_LENGTH_LIMIT, llmMessageMaxChars, TOOL_OUTPUT_MAX_RECORDED_CHARS),
      warnings
    )
  };
  const timeoutMillis = firstPositiveInt(
    env,
    ['OTEL_EXPORTER_OTLP_TRACES_TIMEOUT', 'OTEL_EXPORTER_OTLP_TIMEOUT'],
    CAPTURE_EXPORT_TIMEOUT_MS,
    warnings
  );
  settings.exporter = { timeoutMillis };
  settings.batch = {
    maxQueueSize: MAX_QUEUE_SIZE,
    maxExportBatchSize: CAPTURE_MAX_EXPORT_BATCH_SIZE,
    scheduledDelayMillis: SCHEDULED_DELAY_MS,
    exportTimeoutMillis: timeoutMillis
  };
  return { settings, warnings };
}

/** One log-friendly line: what is captured and, when anything is, the limits the provider and exporter got. */
export function describeTraceSettings(settings: TraceSettings): string {
  const { toolOutput } = settings;
  const parts = [`llm_messages=${settings.captureLlmMessages ? 'on' : 'off'}`];
  if (settings.captureLlmMessages) {
    parts.push(`tool_schemas=${settings.captureLlmToolSchemas ? 'on' : 'off'}`);
  }
  parts.push(
    `tool_output=${toolOutput.mode === 'list' ? toolOutput.patterns.join(',') : toolOutput.mode === 'all' ? 'all' : 'off'}`
  );
  if (settings.captureLlmMessages) {
    parts.push(
      `message_max_chars=${settings.llmMessageMaxChars.toString()}`,
      `messages_max=${settings.llmMessagesMax.toString()}`,
      `messages_max_total_chars=${settings.llmMessagesMaxTotalChars.toString()}`
    );
  }
  if (capturesAnything(settings)) {
    parts.push(
      `attribute_count_limit=${String(settings.spanLimits.attributeCountLimit)}`,
      `attribute_value_length_limit=${settings.spanLimits.attributeValueLengthLimit.toString()}`,
      `export_timeout_ms=${settings.exporter.timeoutMillis.toString()}`,
      `export_batch=${settings.batch.maxExportBatchSize.toString()}`
    );
  }
  return parts.join(' ');
}
