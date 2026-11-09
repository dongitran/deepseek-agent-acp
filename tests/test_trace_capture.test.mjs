/**
 * Span-level tests of what the tracing records, through initTelemetry's test seam: an InMemorySpanExporter behind a
 * SimpleSpanProcessor replaces the OTLP export, and the trace settings come from resolveTraceSettings(env).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { initTelemetry } from '../dist/telemetry.js';
import { resolveTraceSettings } from '../dist/trace-config.js';

const ON = { OTEL_CAPTURE_LLM_MESSAGES: 'true' };
const MODEL = 'deepseek-flash';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'meeting_wait',
      description: 'Wait for the next words addressed to you in the call.',
      parameters: { type: 'object', properties: { timeout_s: { type: 'integer' } } }
    }
  },
  {
    type: 'function',
    function: { name: 'thread_read', description: 'Read the thread.', parameters: { type: 'object', properties: {} } }
  }
];

function tracing(env = {}, secrets = []) {
  const exporter = new InMemorySpanExporter();
  const service = initTelemetry({
    secrets,
    trace: resolveTraceSettings(env).settings,
    spanProcessor: new SimpleSpanProcessor(exporter)
  });
  assert.ok(service, 'with a span processor the seam always returns a service');
  return { service, spans: () => exporter.getFinishedSpans() };
}

/** The request body exactly as the adapter sends it (src/index.ts). */
function requestBody(messages, extra = {}) {
  return {
    model: MODEL,
    messages,
    tools: TOOLS,
    temperature: 0,
    thinking: { type: 'disabled' },
    stream: true,
    stream_options: { include_usage: true },
    ...extra
  };
}

/** One turn with one model call that answers `answer`; returns the LLM span. */
function oneCall(env, body, { prompt = 'hello', secrets = [] } = {}) {
  const { service, spans } = tracing(env, secrets);
  const turn = service.startTurnSpan('sess-1', prompt, MODEL, {});
  const llm = turn.startLlmSpan(MODEL, 1);
  llm.recordRequest(body);
  llm.recordUsage({ prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 });
  llm.recordOutput({ content: 'answer' });
  llm.end('answer');
  turn.end('OK', 'answer');
  const found = spans().filter((s) => s.name === `llm:${MODEL}`);
  assert.equal(found.length, 1);
  return { span: found[0], all: spans() };
}

function chat(count, contentOf = (i) => `m${i}`) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({ role: i === 0 ? 'system' : i % 2 ? 'user' : 'assistant', content: contentOf(i) });
  }
  return messages;
}

function roleKeys(span) {
  return Object.keys(span.attributes).filter((k) => /^llm\.input_messages\.\d+\.message\.role$/.test(k));
}

// ---------------------------------------------------------------------------
// Capture on: what was sent
// ---------------------------------------------------------------------------

test('capture on: a 12,000-character system prompt and 300 messages are recorded whole, no attribute dropped', () => {
  const system = `${'S'.repeat(11999)}!`;
  const messages = chat(300);
  messages[0] = { role: 'system', content: system };
  const { span } = oneCall(ON, requestBody(messages));
  assert.equal(span.droppedAttributesCount, 0);
  assert.equal(span.attributes['llm.input_messages.0.message.role'], 'system');
  assert.equal(span.attributes['llm.input_messages.0.message.content'], system);
  assert.equal(span.attributes['llm.input_messages.299.message.content'], 'm299');
  assert.equal(roleKeys(span).length, 300);
  assert.equal(span.attributes['llm.input_messages_total'], 300);
  assert.equal(span.attributes['llm.input_messages_omitted'], undefined);
  assert.equal(span.attributes['llm.input_messages_trimmed'], undefined);
});

test('capture on: roles, tool_call_id and tool calls are recorded; null content and reasoning_content are not', () => {
  const messages = [
    { role: 'system', content: 'You are Elio Twin.' },
    { role: 'user', content: 'Join the call' },
    {
      role: 'assistant',
      content: null,
      reasoning_content: 'private chain of thought',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'meeting_wait', arguments: '{"timeout_s":40}' } },
        { id: 'call_2', type: 'function', function: { name: 'thread_read', arguments: '{}' } }
      ]
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"event":"addressed","addressed":[{"text":"Chào cậu nhớ!"}]}' },
    { role: 'tool', tool_call_id: 'call_2', content: 'the thread' },
    { role: 'assistant', content: 'Chào bạn!' }
  ];
  const a = oneCall(ON, requestBody(messages)).span.attributes;
  assert.equal(a['llm.input_messages.1.message.role'], 'user');
  assert.equal(a['llm.input_messages.1.message.content'], 'Join the call');
  assert.equal(a['llm.input_messages.2.message.role'], 'assistant');
  assert.equal('llm.input_messages.2.message.content' in a, false, 'a null content is omitted');
  assert.equal(a['llm.input_messages.2.message.tool_calls.0.tool_call.id'], 'call_1');
  assert.equal(a['llm.input_messages.2.message.tool_calls.0.tool_call.function.name'], 'meeting_wait');
  assert.equal(a['llm.input_messages.2.message.tool_calls.0.tool_call.function.arguments'], '{"timeout_s":40}');
  assert.equal(a['llm.input_messages.2.message.tool_calls.1.tool_call.function.name'], 'thread_read');
  assert.equal(a['llm.input_messages.3.message.role'], 'tool');
  assert.equal(a['llm.input_messages.3.message.tool_call_id'], 'call_1');
  assert.equal(a['llm.input_messages.3.message.content'], '{"event":"addressed","addressed":[{"text":"Chào cậu nhớ!"}]}');
  assert.equal(a['llm.input_messages.4.message.tool_call_id'], 'call_2');
  assert.equal(a['llm.input_messages.5.message.content'], 'Chào bạn!');
  assert.equal(a['llm.input_messages_total'], 6);
  for (const [key, value] of Object.entries(a)) {
    assert.ok(!key.includes('reasoning'), key);
    assert.ok(!String(value).includes('private chain of thought'), key);
  }
});

test('capture on: llm.invocation_parameters is the request body without messages and tools', () => {
  const a = oneCall(ON, requestBody(chat(2))).span.attributes;
  assert.deepEqual(JSON.parse(a['llm.invocation_parameters']), {
    model: 'deepseek-flash',
    temperature: 0,
    thinking: { type: 'disabled' },
    stream: true,
    stream_options: { include_usage: true }
  });
});

test('capture on: each tool sent is named; descriptions and schemas only with OTEL_CAPTURE_LLM_TOOL_SCHEMAS=true', () => {
  const names = oneCall(ON, requestBody(chat(2))).span.attributes;
  assert.equal(names['llm.tools.0.tool.name'], 'meeting_wait');
  assert.equal(names['llm.tools.1.tool.name'], 'thread_read');
  assert.equal(names['llm.tools.2.tool.name'], undefined);
  assert.equal(names['llm.tools.0.tool.description'], undefined);
  assert.equal(names['llm.tools.0.tool.json_schema'], undefined);

  const full = oneCall({ ...ON, OTEL_CAPTURE_LLM_TOOL_SCHEMAS: 'true' }, requestBody(chat(2))).span.attributes;
  assert.equal(full['llm.tools.0.tool.description'], 'Wait for the next words addressed to you in the call.');
  assert.deepEqual(JSON.parse(full['llm.tools.0.tool.json_schema']), TOOLS[0]);
  assert.deepEqual(JSON.parse(full['llm.tools.1.tool.json_schema']), TOOLS[1]);
});

test('capture on: input.value stays the turn prompt that buzz-trace reads', () => {
  const a = oneCall(ON, requestBody(chat(5)), { prompt: 'Event ID: abc\nJoin the call' }).span.attributes;
  assert.equal(a['input.value'], 'Event ID: abc\nJoin the call');
  assert.equal(a['input.mime_type'], 'text/plain');
});

// ---------------------------------------------------------------------------
// Capture on: limits
// ---------------------------------------------------------------------------

test('more than OTEL_LLM_MESSAGES_MAX messages: the first 2 and the last MAX-2 are recorded, numbered 0…MAX-1', () => {
  const a = oneCall({ ...ON, OTEL_LLM_MESSAGES_MAX: '10' }, requestBody(chat(25))).span.attributes;
  const recorded = [];
  for (let i = 0; i < 12; i++) {
    recorded.push(a[`llm.input_messages.${i}.message.content`]);
  }
  assert.deepEqual(recorded, ['m0', 'm1', 'm17', 'm18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24', undefined, undefined]);
  assert.equal(a['llm.input_messages_total'], 25);
  assert.equal(a['llm.input_messages_omitted'], 15);
});

test('over OTEL_LLM_MESSAGES_MAX_TOTAL_CHARS: the oldest middle contents are cut first, never the first 2 or last 4', () => {
  // 10 messages of 200 characters = 2000 > 1500. Each cut saves 200 - 19 = 181: three cuts reach 1457.
  const messages = chat(10, (i) => String(i).repeat(200).slice(0, 200));
  const a = oneCall({ ...ON, OTEL_LLM_MESSAGES_MAX_TOTAL_CHARS: '1500' }, requestBody(messages)).span.attributes;
  const content = (i) => a[`llm.input_messages.${i}.message.content`];
  for (const i of [2, 3, 4]) {
    assert.equal(content(i), '…[omitted for size]', `message ${i}`);
  }
  for (const i of [0, 1, 5, 6, 7, 8, 9]) {
    assert.equal(content(i), messages[i].content, `message ${i}`);
  }
  assert.equal(a['llm.input_messages_trimmed'], 3);
  assert.equal(a['llm.input_messages.3.message.role'], 'user', 'a cut message keeps its role');

  // Too much even with every middle message cut: the first 2 and the last 4 still stay whole.
  const tight = oneCall({ ...ON, OTEL_LLM_MESSAGES_MAX_TOTAL_CHARS: '100' }, requestBody(messages)).span.attributes;
  assert.equal(tight['llm.input_messages_trimmed'], 4);
  assert.equal(tight['llm.input_messages.1.message.content'], messages[1].content);
  assert.equal(tight['llm.input_messages.6.message.content'], messages[6].content);
});

test('OTEL_LLM_MESSAGE_MAX_CHARS: a longer content or arguments string ends with …[truncated N chars] within the cap', () => {
  const messages = chat(2);
  messages[1] = { role: 'user', content: 'x'.repeat(5000) };
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'reply', arguments: 'y'.repeat(3000) } }]
  });
  const a = oneCall({ ...ON, OTEL_LLM_MESSAGE_MAX_CHARS: '1000' }, requestBody(messages)).span.attributes;
  // "…[truncated 4023 chars]" is 23 characters: 977 kept + 23 = 1000.
  assert.equal(a['llm.input_messages.1.message.content'], `${'x'.repeat(977)}…[truncated 4023 chars]`);
  assert.equal(
    a['llm.input_messages.2.message.tool_calls.0.tool_call.function.arguments'],
    `${'y'.repeat(977)}…[truncated 2023 chars]`
  );
});

test('the per-message cut never splits a surrogate pair', () => {
  const messages = chat(2);
  messages[1] = { role: 'user', content: `${'a'.repeat(976)}😀${'b'.repeat(5000)}` };
  const a = oneCall({ ...ON, OTEL_LLM_MESSAGE_MAX_CHARS: '1000' }, requestBody(messages)).span.attributes;
  // Cutting at 977 would keep half of the emoji (code units 976-977): the cut moves back to 976.
  assert.equal(a['llm.input_messages.1.message.content'], `${'a'.repeat(976)}…[truncated 5002 chars]`);
});

test('a lower attribute count limit drops the oldest middle messages, never the token counts or the answer', () => {
  const { span } = oneCall({ ...ON, OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT: '200' }, requestBody(chat(300)));
  const a = span.attributes;
  assert.equal(span.droppedAttributesCount, 0);
  assert.equal(a['llm.token_count.prompt'], 120);
  assert.equal(a['output.value'], 'answer');
  const kept = roleKeys(span).length;
  assert.ok(kept >= 3 && kept < 300, `kept ${kept}`);
  assert.equal(a['llm.input_messages_omitted'], 300 - kept);
  assert.equal(a['llm.input_messages.0.message.content'], 'm0');
  assert.equal(a['llm.input_messages.1.message.content'], 'm1');
  assert.equal(a[`llm.input_messages.${kept - 1}.message.content`], 'm299');
});

// ---------------------------------------------------------------------------
// Capture on: redaction
// ---------------------------------------------------------------------------

test('redaction: the API key never appears in any attribute, wherever it was in the request', () => {
  const key = 'dskey9f8e7d6c5b4a3210fedcba98';
  const keyB64 = Buffer.from(key).toString('base64');
  const messages = [
    { role: 'system', content: `system knows ${key}` },
    { role: 'user', content: `user pasted ${key} and ${keyB64}` },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'reply', arguments: `{"text":"${key}"}` } }]
    },
    { role: 'tool', tool_call_id: 'c1', content: `echo ${key} sk-abcdefghijklmnopqrstuvwxyz012345` }
  ];
  const { all } = oneCall(ON, requestBody(messages, { user: key }), { prompt: `prompt ${key}`, secrets: [key] });
  let checked = 0;
  for (const span of all) {
    for (const [name, value] of Object.entries(span.attributes)) {
      checked++;
      for (const secret of [key, keyB64, 'sk-abcdefghijklmnopqrstuvwxyz012345']) {
        assert.ok(!String(value).includes(secret), `${span.name} ${name} leaks a secret`);
      }
    }
  }
  assert.ok(checked > 20);
  const a = all.find((s) => s.name === `llm:${MODEL}`).attributes;
  assert.equal(a['llm.input_messages.1.message.content'], 'user pasted [REDACTED] and [REDACTED]');
});

test('redaction of a long message stays fast: 256 KB of eyJ-eyJ-… is recorded in well under a second', () => {
  const messages = chat(2);
  messages[1] = { role: 'user', content: 'eyJ-'.repeat(65536) };
  const started = process.hrtime.bigint();
  const a = oneCall(ON, requestBody(messages)).span.attributes;
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 500, `recording took ${elapsedMs.toFixed(0)} ms`);
  assert.match(a['llm.input_messages.1.message.content'], /…\[truncated \d+ chars\]$/);
});

// ---------------------------------------------------------------------------
// Capture on: the model's answer, on every way an LLM span ends
// ---------------------------------------------------------------------------

/** Starts a turn and one model call with a short request; `finish(llm, turn)` ends it. Returns the LLM span. */
function callEndingWith(finish, env = ON, secrets = []) {
  const { service, spans } = tracing(env, secrets);
  const turn = service.startTurnSpan('sess-2', 'hello', MODEL, {});
  const llm = turn.startLlmSpan(MODEL, 1);
  llm.recordRequest(requestBody(chat(2)));
  finish(llm, turn);
  const found = spans().filter((s) => s.name === `llm:${MODEL}`);
  assert.equal(found.length, 1, 'the LLM span ended');
  return found[0];
}

const TOOL_CALLS = [
  { id: 'call_7', type: 'function', function: { name: 'meeting_speak', arguments: '{"text":"Chào cậu!"}' } },
  { id: 'call_8', type: 'function', function: { name: 'meeting_wait', arguments: '{"timeout_s":40}' } }
];

test('answer with text: llm.output_messages.0 is the assistant message', () => {
  const span = callEndingWith((llm, turn) => {
    llm.recordOutput({ content: 'Chào bạn!' });
    llm.end('Chào bạn!');
    turn.end('OK', 'Chào bạn!');
  });
  assert.equal(span.attributes['llm.output_messages.0.message.role'], 'assistant');
  assert.equal(span.attributes['llm.output_messages.0.message.content'], 'Chào bạn!');
  assert.equal(span.attributes['output.value'], 'Chào bạn!', 'output.value is unchanged');
});

test('answer with tool calls: each call is recorded, and no content when there was none', () => {
  const span = callEndingWith((llm, turn) => {
    llm.recordOutput({ content: null, tool_calls: TOOL_CALLS });
    llm.end(undefined);
    turn.end('OK', 'done');
  });
  const a = span.attributes;
  assert.equal(a['llm.output_messages.0.message.role'], 'assistant');
  assert.equal('llm.output_messages.0.message.content' in a, false);
  assert.equal(a['llm.output_messages.0.message.tool_calls.0.tool_call.id'], 'call_7');
  assert.equal(a['llm.output_messages.0.message.tool_calls.0.tool_call.function.name'], 'meeting_speak');
  assert.equal(a['llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments'], '{"text":"Chào cậu!"}');
  assert.equal(a['llm.output_messages.0.message.tool_calls.1.tool_call.function.name'], 'meeting_wait');
});

test('an answer cut off by an error still shows what the model had said, and the span is an error', () => {
  const span = callEndingWith((llm, turn) => {
    llm.recordOutput({ content: 'Partial ans', tool_calls: [TOOL_CALLS[0]] });
    llm.end(undefined, 'Tool execution truncated due to token limits.');
    turn.end('OK', 'recovered');
  });
  assert.equal(span.attributes['llm.output_messages.0.message.content'], 'Partial ans');
  assert.equal(span.attributes['llm.output_messages.0.message.tool_calls.0.tool_call.function.name'], 'meeting_speak');
  assert.equal(span.status.code, 2);
});

test('a span the turn closes (stream error, then turn end) keeps the answer recorded before', () => {
  const span = callEndingWith((llm, turn) => {
    llm.recordOutput({ content: 'Half a sent' });
    turn.end('ERROR', undefined, 'turn_failed', 'Stream chunk read timed out after 500ms');
  });
  assert.equal(span.attributes['llm.output_messages.0.message.content'], 'Half a sent');
  assert.equal(span.status.message, 'orphaned_at_turn_end', 'ended by the turn as in 0.3.0');
});

test('the first answer recorded wins, and nothing is added once the span has ended', () => {
  const span = callEndingWith((llm, turn) => {
    llm.recordOutput({ content: 'first' });
    llm.recordOutput({ content: 'second', tool_calls: TOOL_CALLS });
    llm.end('first');
    llm.recordOutput({ content: 'after end' });
    turn.end('OK', 'first');
  });
  assert.equal(span.attributes['llm.output_messages.0.message.content'], 'first');
  assert.equal(span.attributes['llm.output_messages.0.message.tool_calls.0.tool_call.id'], undefined);
});

test('the answer is redacted and capped like the request', () => {
  const key = 'dskey0a1b2c3d4e5f60718293a4b5';
  const span = callEndingWith(
    (llm, turn) => {
      llm.recordOutput({
        content: `the key is ${key}`,
        tool_calls: [{ id: 'c9', type: 'function', function: { name: 'reply', arguments: 'z'.repeat(5000) } }]
      });
      llm.end('x');
      turn.end('OK', 'x');
    },
    { ...ON, OTEL_LLM_MESSAGE_MAX_CHARS: '1000' },
    [key]
  );
  assert.equal(span.attributes['llm.output_messages.0.message.content'], 'the key is [REDACTED]');
  assert.equal(
    span.attributes['llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments'],
    `${'z'.repeat(977)}…[truncated 4023 chars]`
  );
});

test('redaction: a string cut in the middle of a known secret keeps none of that secret', () => {
  const key = 'dskeyfeedbeef0123456789abcdef';
  // An answer cut by the stream or the token limit, half-way through a secret the model was repeating.
  const span = callEndingWith(
    (llm, turn) => {
      llm.recordOutput({
        content: `the token is ${key.slice(0, 14)}`,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'reply', arguments: `{"text":"${key.slice(0, 20)}` } }]
      });
      llm.end(undefined, 'Tool execution truncated due to token limits.');
      turn.end('OK', 'x');
    },
    ON,
    [key]
  );
  assert.equal(span.attributes['llm.output_messages.0.message.content'], 'the token is [REDACTED]');
  assert.equal(
    span.attributes['llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments'],
    '{"text":"[REDACTED]'
  );
  // A tool output that a tool itself cut half-way through the secret.
  const messages = chat(2);
  messages.push({ role: 'tool', tool_call_id: 'c2', content: `log tail ${key.slice(0, 9)}` });
  const a = oneCall(ON, requestBody(messages), { secrets: [key] }).span.attributes;
  assert.equal(a['llm.input_messages.2.message.content'], 'log tail [REDACTED]');
});

test('capture never throws into the turn: malformed input is skipped and the span still ends normally', () => {
  const circular = {};
  circular.self = circular;
  const malformed = [
    (llm) => llm.recordRequest(null),
    (llm) => llm.recordRequest({ messages: [{ role: 'user', content: circular }] }),
    (llm) => llm.recordOutput(undefined),
    (llm) => llm.recordOutput({ content: circular })
  ];
  for (const [n, misuse] of malformed.entries()) {
    const { service, spans } = tracing(ON);
    const turn = service.startTurnSpan('sess-3', 'hello', MODEL, {});
    const llm = turn.startLlmSpan(MODEL, 1);
    assert.doesNotThrow(() => misuse(llm), `case ${n}`);
    llm.end('still fine');
    turn.end('OK', 'still fine');
    const span = spans().find((s) => s.name === `llm:${MODEL}`);
    assert.equal(span.attributes['output.value'], 'still fine', `case ${n}`);
    assert.equal(span.status.code, 1, `case ${n}`);
  }
});

// ---------------------------------------------------------------------------
// Tool output (OTEL_CAPTURE_TOOL_OUTPUT)
// ---------------------------------------------------------------------------

const WAIT_OUTPUT = '{"event":"addressed","addressed":[{"text":"Chào cậu nhớ!","speaker":"Elio"}]}';
const POSTED_ID = '40738780fa35899d341c45daeda99e609aff92c6d3cb44c54e06e7290e7bb38b';
const REPLY_OUTPUT = `posted (14 characters) · event_id ${POSTED_ID}`;

/** Runs tool calls `[name, output, isError?]` in one turn; returns their spans by tool name. */
function toolSpans(env, calls, secrets = []) {
  const { service, spans } = tracing(env, secrets);
  const turn = service.startTurnSpan('sess-4', 'hello', MODEL, {});
  calls.forEach(([name, output, isError = false], i) => {
    turn.startToolSpan(`call_${i}`, name, { timeout_s: 40 });
    turn.endToolSpan(`call_${i}`, output, isError, name);
  });
  turn.end('OK', 'done');
  return Object.fromEntries(spans().filter((s) => s.name.startsWith('tool:')).map((s) => [s.name.slice(5), s]));
}

test('tool output meeting_*: meeting_wait gets its output as JSON, thread_read gets none', () => {
  const spans = toolSpans({ OTEL_CAPTURE_TOOL_OUTPUT: 'meeting_*' }, [
    ['meeting_wait', WAIT_OUTPUT],
    ['thread_read', 'Thread: Chào cậu nhớ!']
  ]);
  assert.equal(spans.meeting_wait.attributes['output.value'], WAIT_OUTPUT);
  assert.equal(spans.meeting_wait.attributes['output.mime_type'], 'application/json');
  assert.equal(spans.thread_read.attributes['output.value'], undefined);
  assert.equal(spans.thread_read.attributes['output.mime_type'], undefined);
});

test('tool output true: every tool gets its output, text as text/plain and JSON as application/json', () => {
  const spans = toolSpans({ OTEL_CAPTURE_TOOL_OUTPUT: 'true' }, [
    ['meeting_wait', WAIT_OUTPUT],
    ['thread_read', 'Thread: Chào cậu nhớ!']
  ]);
  assert.equal(spans.meeting_wait.attributes['output.mime_type'], 'application/json');
  assert.equal(spans.thread_read.attributes['output.value'], 'Thread: Chào cậu nhớ!');
  assert.equal(spans.thread_read.attributes['output.mime_type'], 'text/plain');
});

test('tool output: a failed call is recorded too, and a JSON output cut at 8 KB is no longer JSON (text/plain)', () => {
  const longJson = JSON.stringify({ event: 'addressed', addressed: [{ text: 'x'.repeat(10000) }] });
  const spans = toolSpans({ OTEL_CAPTURE_TOOL_OUTPUT: 'meeting_*' }, [
    ['meeting_wait', '{"error":"meeting gate unreachable"}', true],
    ['meeting_speak', longJson]
  ]);
  assert.equal(spans.meeting_wait.attributes['output.value'], '{"error":"meeting gate unreachable"}');
  assert.equal(spans.meeting_wait.attributes['output.mime_type'], 'application/json');
  assert.equal(spans.meeting_speak.attributes['output.value'], `${longJson.slice(0, 8192)}... [TRUNCATED]`);
  assert.equal(spans.meeting_speak.attributes['output.mime_type'], 'text/plain');
});

test('tool output: a captured output is redacted', () => {
  const key = 'dskeyaa11bb22cc33dd44ee55ff66';
  const spans = toolSpans({ OTEL_CAPTURE_TOOL_OUTPUT: 'meeting_*' }, [['meeting_wait', `{"text":"${key}"}`]], [key]);
  assert.equal(spans.meeting_wait.attributes['output.value'], '{"text":"[REDACTED]"}');
});

test('posting tools keep their 0.3.0 record whatever OTEL_CAPTURE_TOOL_OUTPUT says', () => {
  for (const setting of [undefined, 'meeting_*', 'reply,meeting_*', 'true']) {
    const env = setting === undefined ? {} : { OTEL_CAPTURE_TOOL_OUTPUT: setting };
    const reply = toolSpans(env, [['reply', REPLY_OUTPUT]]).reply.attributes;
    assert.equal(reply['nostr.posted_event_id'], POSTED_ID, String(setting));
    assert.equal(reply['output.value'], REPLY_OUTPUT, String(setting));
    assert.equal(reply['tool.output'], REPLY_OUTPUT, String(setting));
    assert.equal(reply['output.mime_type'], 'text/plain', String(setting));
  }
});

// The tool span of 0.3.0 for a call that posts nothing, with OTEL_CAPTURE_TOOL_OUTPUT unset.
const TOOL_KEYS_0_3_0 = [
  'input.mime_type',
  'input.value',
  'openinference.span.kind',
  'session.id',
  'tool.call_id',
  'tool.is_error',
  'tool.name',
  'tool.output_bytes',
  'tool.parameters'
];

test('tool output off: a meeting tool span has exactly 0.3.0 attributes', () => {
  for (const env of [{}, { OTEL_CAPTURE_TOOL_OUTPUT: 'false' }, { OTEL_CAPTURE_LLM_MESSAGES: 'true' }]) {
    const wait = toolSpans(env, [['meeting_wait', WAIT_OUTPUT]]).meeting_wait;
    assert.deepEqual(Object.keys(wait.attributes).sort(), TOOL_KEYS_0_3_0, JSON.stringify(env));
  }
});

// ---------------------------------------------------------------------------
// Capture off: exactly 0.3.0
// ---------------------------------------------------------------------------

// The LLM span of 0.3.0 for a call with usage and a text answer (src/telemetry.ts at v0.3.0).
const LLM_KEYS_0_3_0 = [
  'input.mime_type',
  'input.value',
  'llm.iteration',
  'llm.model_name',
  'llm.provider',
  'llm.token_count.completion',
  'llm.token_count.prompt',
  'llm.token_count.total',
  'openinference.span.kind',
  'output.mime_type',
  'output.value',
  'session.id'
];

test('capture off: the LLM span has exactly 0.3.0 attributes, however much was sent', () => {
  const { span } = oneCall({}, requestBody(chat(300)));
  assert.deepEqual(Object.keys(span.attributes).sort(), LLM_KEYS_0_3_0);
});

test('capture off keeps 0.3.0 value limit (8192); capture on keeps a whole 8207-character preview', () => {
  const prompt = 'p'.repeat(12000);
  const off = oneCall({}, requestBody(chat(2)), { prompt }).span.attributes['input.value'];
  assert.equal(off.length, 8192, 'the SDK cuts the preview at 0.3.0 limit, as before');
  const on = oneCall(ON, requestBody(chat(2)), { prompt }).span.attributes['input.value'];
  assert.equal(on, `${'p'.repeat(8192)}... [TRUNCATED]`);
});
