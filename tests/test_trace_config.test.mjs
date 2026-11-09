import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { resolveTraceSettings, toolOutputMatcher, describeTraceSettings } = await import(
  path.resolve(__dirname, '../dist/trace-config.js')
);

// 0.3.0's provider and exporter settings (src/telemetry.ts at v0.3.0). While nothing is captured they must not move.
const LEGACY_SPAN_LIMITS = { attributeValueLengthLimit: 8192 };
const LEGACY_EXPORTER = { timeoutMillis: 1500 };
const LEGACY_BATCH = { maxQueueSize: 2048, maxExportBatchSize: 128, scheduledDelayMillis: 5000, exportTimeoutMillis: 1500 };

const ON = { OTEL_CAPTURE_LLM_MESSAGES: 'true' };

// ---------------------------------------------------------------------------
// Defaults: everything off, 0.3.0's provider and exporter
// ---------------------------------------------------------------------------

test('resolveTraceSettings: nothing set captures nothing and keeps 0.3.0 limits, exporter and batches', () => {
  const { settings, warnings } = resolveTraceSettings({});
  assert.deepEqual(warnings, []);
  assert.equal(settings.captureLlmMessages, false);
  assert.equal(settings.captureLlmToolSchemas, false);
  assert.deepEqual(settings.toolOutput, { mode: 'none' });
  assert.equal(settings.llmMessageMaxChars, 65536);
  assert.equal(settings.llmMessagesMax, 400);
  assert.equal(settings.llmMessagesMaxTotalChars, 524288);
  assert.deepEqual(settings.spanLimits, LEGACY_SPAN_LIMITS);
  assert.deepEqual(settings.exporter, LEGACY_EXPORTER);
  assert.deepEqual(settings.batch, LEGACY_BATCH);
});

test('resolveTraceSettings: limit and timeout variables do not move anything while nothing is captured', () => {
  const { settings } = resolveTraceSettings({
    OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: '9000',
    OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: '99999',
    OTEL_EXPORTER_OTLP_TIMEOUT: '30000',
    OTEL_CAPTURE_LLM_MESSAGES: 'false',
    OTEL_CAPTURE_TOOL_OUTPUT: 'false'
  });
  assert.deepEqual(settings.spanLimits, LEGACY_SPAN_LIMITS);
  assert.deepEqual(settings.exporter, LEGACY_EXPORTER);
  assert.deepEqual(settings.batch, LEGACY_BATCH);
});

// ---------------------------------------------------------------------------
// OTEL_CAPTURE_LLM_MESSAGES / OTEL_CAPTURE_LLM_TOOL_SCHEMAS
// ---------------------------------------------------------------------------

test('OTEL_CAPTURE_LLM_MESSAGES=true (any case, spaces ignored) turns message capture on', () => {
  for (const raw of ['true', 'TRUE', ' True ']) {
    const { settings, warnings } = resolveTraceSettings({ OTEL_CAPTURE_LLM_MESSAGES: raw });
    assert.equal(settings.captureLlmMessages, true, `"${raw}"`);
    assert.deepEqual(warnings, []);
  }
});

test('OTEL_CAPTURE_LLM_MESSAGES=false or empty leaves it off without a warning', () => {
  for (const raw of ['false', 'FALSE', '', '   ']) {
    const { settings, warnings } = resolveTraceSettings({ OTEL_CAPTURE_LLM_MESSAGES: raw });
    assert.equal(settings.captureLlmMessages, false, `"${raw}"`);
    assert.deepEqual(warnings, []);
  }
});

test('OTEL_CAPTURE_LLM_MESSAGES: any other value is ignored with a warning that names the variable', () => {
  for (const raw of ['yes', '1', 'on', 'enabled']) {
    const { settings, warnings } = resolveTraceSettings({ OTEL_CAPTURE_LLM_MESSAGES: raw });
    assert.equal(settings.captureLlmMessages, false, `"${raw}" must not turn capture on`);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /OTEL_CAPTURE_LLM_MESSAGES/);
  }
});

test('OTEL_CAPTURE_LLM_TOOL_SCHEMAS=true adds the tool schemas only together with message capture', () => {
  const both = resolveTraceSettings({ ...ON, OTEL_CAPTURE_LLM_TOOL_SCHEMAS: 'true' });
  assert.equal(both.settings.captureLlmToolSchemas, true);
  assert.deepEqual(both.warnings, []);

  const alone = resolveTraceSettings({ OTEL_CAPTURE_LLM_TOOL_SCHEMAS: 'true' });
  assert.equal(alone.settings.captureLlmToolSchemas, false);
  assert.equal(alone.warnings.length, 1);
  assert.match(alone.warnings[0], /OTEL_CAPTURE_LLM_TOOL_SCHEMAS/);
  assert.match(alone.warnings[0], /OTEL_CAPTURE_LLM_MESSAGES/);

  const invalid = resolveTraceSettings({ ...ON, OTEL_CAPTURE_LLM_TOOL_SCHEMAS: 'all' });
  assert.equal(invalid.settings.captureLlmToolSchemas, false);
  assert.equal(invalid.warnings.length, 1);
  assert.match(invalid.warnings[0], /OTEL_CAPTURE_LLM_TOOL_SCHEMAS/);
});

// ---------------------------------------------------------------------------
// OTEL_CAPTURE_TOOL_OUTPUT
// ---------------------------------------------------------------------------

test('OTEL_CAPTURE_TOOL_OUTPUT=true captures every tool (its 0.3.0 meaning)', () => {
  const { settings, warnings } = resolveTraceSettings({ OTEL_CAPTURE_TOOL_OUTPUT: 'true' });
  assert.deepEqual(warnings, []);
  const captures = toolOutputMatcher(settings.toolOutput);
  for (const name of ['meeting_wait', 'thread_read', 'reply', 'knowledge_search']) {
    assert.equal(captures(name), true, name);
  }
});

test('OTEL_CAPTURE_TOOL_OUTPUT=false or empty captures no tool, without a warning', () => {
  for (const raw of ['false', '', '  ']) {
    const { settings, warnings } = resolveTraceSettings({ OTEL_CAPTURE_TOOL_OUTPUT: raw });
    assert.deepEqual(warnings, []);
    assert.deepEqual(settings.toolOutput, { mode: 'none' });
    assert.equal(toolOutputMatcher(settings.toolOutput)('meeting_wait'), false);
  }
});

test('OTEL_CAPTURE_TOOL_OUTPUT list: tool names and * globs, case-insensitive, trimmed, matched whole', () => {
  const { settings, warnings } = resolveTraceSettings({ OTEL_CAPTURE_TOOL_OUTPUT: ' Meeting_* , THREAD_READ ' });
  assert.deepEqual(warnings, []);
  const captures = toolOutputMatcher(settings.toolOutput);
  assert.equal(captures('meeting_wait'), true);
  assert.equal(captures('meeting_speak'), true);
  assert.equal(captures('MEETING_JOIN'), true);
  assert.equal(captures('thread_read'), true);
  assert.equal(captures('reply'), false);
  assert.equal(captures('knowledge_search'), false);
  assert.equal(captures('my_meeting_wait'), false, 'a pattern matches the whole name, not a part of it');
  assert.equal(captures('thread_reader'), false, 'a pattern matches the whole name, not a prefix');
});

test('OTEL_CAPTURE_TOOL_OUTPUT: only * is a wildcard; a dot is a dot', () => {
  const captures = toolOutputMatcher(resolveTraceSettings({ OTEL_CAPTURE_TOOL_OUTPUT: 'meeting.wait' }).settings.toolOutput);
  assert.equal(captures('meeting.wait'), true);
  assert.equal(captures('meetingXwait'), false);
  const all = toolOutputMatcher(resolveTraceSettings({ OTEL_CAPTURE_TOOL_OUTPUT: '*' }).settings.toolOutput);
  assert.equal(all('anything_at_all'), true);
});

test('OTEL_CAPTURE_TOOL_OUTPUT: a malformed list captures nothing and warns once, naming the variable', () => {
  for (const raw of ['meeting wait', 'a,,b', ',meeting_*', 'meeting_*,', 'meeting_*;thread_read', 'tool?']) {
    const { settings, warnings } = resolveTraceSettings({ OTEL_CAPTURE_TOOL_OUTPUT: raw });
    assert.deepEqual(settings.toolOutput, { mode: 'none' }, `"${raw}" must not capture anything`);
    assert.equal(warnings.length, 1, `"${raw}"`);
    assert.match(warnings[0], /OTEL_CAPTURE_TOOL_OUTPUT/);
  }
});

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

test('the three message caps accept positive integers', () => {
  const { settings, warnings } = resolveTraceSettings({
    ...ON,
    OTEL_LLM_MESSAGE_MAX_CHARS: '1000',
    OTEL_LLM_MESSAGES_MAX: '50',
    OTEL_LLM_MESSAGES_MAX_TOTAL_CHARS: ' 20000 '
  });
  assert.deepEqual(warnings, []);
  assert.equal(settings.llmMessageMaxChars, 1000);
  assert.equal(settings.llmMessagesMax, 50);
  assert.equal(settings.llmMessagesMaxTotalChars, 20000);
});

test('an invalid message cap falls back to its default with a warning that names it', () => {
  const defaults = {
    OTEL_LLM_MESSAGE_MAX_CHARS: ['llmMessageMaxChars', 65536],
    OTEL_LLM_MESSAGES_MAX: ['llmMessagesMax', 400],
    OTEL_LLM_MESSAGES_MAX_TOTAL_CHARS: ['llmMessagesMaxTotalChars', 524288]
  };
  for (const [name, [field, fallback]] of Object.entries(defaults)) {
    for (const bad of ['abc', '0', '-1', '1.5', '10k', '1e3']) {
      const { settings, warnings } = resolveTraceSettings({ ...ON, [name]: bad });
      assert.equal(settings[field], fallback, `${name}="${bad}"`);
      assert.equal(warnings.length, 1, `${name}="${bad}"`);
      assert.match(warnings[0], new RegExp(name));
    }
  }
});

test('OTEL_LLM_MESSAGES_MAX keeps the first two messages and at least the last one, so it is 3 or more', () => {
  const two = resolveTraceSettings({ ...ON, OTEL_LLM_MESSAGES_MAX: '2' });
  assert.equal(two.settings.llmMessagesMax, 400);
  assert.equal(two.warnings.length, 1);
  assert.match(two.warnings[0], /OTEL_LLM_MESSAGES_MAX/);
  assert.equal(resolveTraceSettings({ ...ON, OTEL_LLM_MESSAGES_MAX: '3' }).settings.llmMessagesMax, 3);
});

// ---------------------------------------------------------------------------
// Span limits and exporter while something is captured
// ---------------------------------------------------------------------------

test('message capture raises the span limits to 4096 attributes and values as long as the message cap', () => {
  const { settings } = resolveTraceSettings(ON);
  assert.deepEqual(settings.spanLimits, { attributeCountLimit: 4096, attributeValueLengthLimit: 65536 });
});

test('the value limit follows a larger message cap, and never drops below a whole truncated tool output (8207)', () => {
  assert.equal(
    resolveTraceSettings({ ...ON, OTEL_LLM_MESSAGE_MAX_CHARS: '100000' }).settings.spanLimits.attributeValueLengthLimit,
    100000
  );
  // A tool output is cut at 8192 characters plus "... [TRUNCATED]" (15): the marker must survive the SDK's own cut.
  assert.equal(
    resolveTraceSettings({ ...ON, OTEL_LLM_MESSAGE_MAX_CHARS: '1000' }).settings.spanLimits.attributeValueLengthLimit,
    8207
  );
});

test('span limits honour OTEL_SPAN_ATTRIBUTE_* first, then OTEL_ATTRIBUTE_*, then the capture defaults', () => {
  const count = (env) => resolveTraceSettings({ ...ON, ...env }).settings.spanLimits.attributeCountLimit;
  const value = (env) => resolveTraceSettings({ ...ON, ...env }).settings.spanLimits.attributeValueLengthLimit;
  assert.equal(count({ OTEL_ATTRIBUTE_COUNT_LIMIT: '5000' }), 5000);
  assert.equal(count({ OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: '6000', OTEL_ATTRIBUTE_COUNT_LIMIT: '5000' }), 6000);
  assert.equal(value({ OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: '20000' }), 20000);
  assert.equal(value({ OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT: '30000', OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT: '20000' }), 30000);
});

test('an invalid limit variable is skipped with a warning and the next one in the chain applies', () => {
  const { settings, warnings } = resolveTraceSettings({
    ...ON,
    OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: 'lots',
    OTEL_ATTRIBUTE_COUNT_LIMIT: '5000'
  });
  assert.equal(settings.spanLimits.attributeCountLimit, 5000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT/);
});

test('capture gives the exporter 10 s and batches of 32 spans; the OTLP timeout variables override the 10 s', () => {
  const { settings } = resolveTraceSettings(ON);
  assert.deepEqual(settings.exporter, { timeoutMillis: 10000 });
  assert.deepEqual(settings.batch, {
    maxQueueSize: 2048,
    maxExportBatchSize: 32,
    scheduledDelayMillis: 5000,
    exportTimeoutMillis: 10000
  });
  const generic = resolveTraceSettings({ ...ON, OTEL_EXPORTER_OTLP_TIMEOUT: '20000' }).settings;
  assert.equal(generic.exporter.timeoutMillis, 20000);
  assert.equal(generic.batch.exportTimeoutMillis, 20000);
  const specific = resolveTraceSettings({
    ...ON,
    OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '15000',
    OTEL_EXPORTER_OTLP_TIMEOUT: '20000'
  }).settings;
  assert.equal(specific.exporter.timeoutMillis, 15000);
  assert.equal(specific.batch.exportTimeoutMillis, 15000);
});

test('tool-output capture alone also raises the limits and the export timeout', () => {
  const { settings } = resolveTraceSettings({ OTEL_CAPTURE_TOOL_OUTPUT: 'meeting_*' });
  assert.equal(settings.captureLlmMessages, false);
  assert.deepEqual(settings.spanLimits, { attributeCountLimit: 4096, attributeValueLengthLimit: 65536 });
  assert.deepEqual(settings.exporter, { timeoutMillis: 10000 });
  assert.equal(settings.batch.maxExportBatchSize, 32);
});

// ---------------------------------------------------------------------------
// Start-up log
// ---------------------------------------------------------------------------

test('describeTraceSettings: says what is captured and, when something is, the effective limits', () => {
  const off = describeTraceSettings(resolveTraceSettings({}).settings);
  assert.match(off, /llm_messages=off/);
  assert.match(off, /tool_output=off/);

  const on = describeTraceSettings(
    resolveTraceSettings({ ...ON, OTEL_CAPTURE_TOOL_OUTPUT: 'meeting_*,thread_read' }).settings
  );
  for (const part of [
    /llm_messages=on/,
    /tool_schemas=off/,
    /tool_output=meeting_\*,thread_read/,
    /message_max_chars=65536/,
    /messages_max=400/,
    /messages_max_total_chars=524288/,
    /attribute_count_limit=4096/,
    /attribute_value_length_limit=65536/,
    /export_timeout_ms=10000/,
    /export_batch=32/
  ]) {
    assert.match(on, part);
  }
  assert.match(describeTraceSettings(resolveTraceSettings({ OTEL_CAPTURE_TOOL_OUTPUT: 'true' }).settings), /tool_output=all/);
});
