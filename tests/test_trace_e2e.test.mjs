/**
 * End-to-end: the real adapter process, a mock DeepSeek, a mock MCP server (tests/fixtures/mock-mcp-server.mjs) and a
 * mock Phoenix that decodes the OTLP protobuf it receives (tests/helpers/otlp.mjs). Covers every way index.ts ends an
 * LLM span, with message and tool-output capture on and off.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startCollector } from './helpers/otlp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(__dirname, '../dist/index.js');
const MOCK_MCP = path.resolve(__dirname, 'fixtures/mock-mcp-server.mjs');
const API_KEY = 'sk-e2e-capture-0123456789abcdef0123';
const WAIT_OUTPUT = '{"event":"addressed","addressed":[{"text":"Chào cậu nhớ!","speaker":"Elio"}]}';
// Longer than 0.3.0's 8192-character value limit, as Elio Twin's (11,828 B).
const SYSTEM_PROMPT = `You are Elio Twin.${' Speak Vietnamese.'.repeat(700)}`;
const SYSTEM_PROMPT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-e2e-')), 'system-prompt.md');
fs.writeFileSync(SYSTEM_PROMPT_FILE, SYSTEM_PROMPT);

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
const USAGE = { choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } };

function sse(res, chunks) {
  res.writeHead(200, SSE_HEADERS);
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

function text(content) {
  return [{ choices: [{ delta: { content }, finish_reason: 'stop' }] }, USAGE];
}

function toolCalls(calls, finishReason = 'tool_calls') {
  const deltas = calls.map((call, index) => ({
    index,
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.args }
  }));
  return [
    { choices: [{ delta: { tool_calls: deltas } }] },
    { choices: [{ delta: {}, finish_reason: finishReason }] },
    USAGE
  ];
}

const WAIT_THEN_ANSWER = (res, n) =>
  sse(
    res,
    n === 1
      ? toolCalls([
          { id: 'call_w', name: 'meeting_wait', args: '{"timeout_s":40}' },
          { id: 'call_t', name: 'thread_read', args: '{}' }
        ])
      : text('Chào bạn!')
  );

async function startDeepSeek(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      requests.push(JSON.parse(raw));
      reply(res, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

/** Host variables that could change what is traced or which tools exist; each test sets its own. */
const HOST_SETTINGS = /^(OTEL_|PHOENIX_|ACP_|BUZZ_|DEEPSEEK_|MCP_TOOL_TIMEOUT_MS$)/;

function adapterEnv(extra) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!HOST_SETTINGS.test(name)) {
      env[name] = value;
    }
  }
  return { ...env, ...extra };
}

async function waitFor(find, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const found = find();
    if (found) {
      return found;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for the adapter');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * One session/prompt through the adapter; returns its answer, the spans Phoenix received, stderr and the requests.
 * `during({ send, stdout })` runs after the prompt is sent, before its answer is awaited (e.g. to cancel it).
 */
async function runAdapter({ env = {}, prompt = 'Join the call', reply, during }) {
  const deepseek = await startDeepSeek(reply);
  const phoenix = await startCollector();
  const child = spawn(process.execPath, [INDEX_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: adapterEnv({
      DEEPSEEK_API_KEY: API_KEY,
      DEEPSEEK_BASE_URL: deepseek.baseUrl,
      DEEPSEEK_MODEL: 'deepseek-flash',
      DEEPSEEK_THINKING: 'disabled',
      ACP_MCP_COMMAND: MOCK_MCP,
      ACP_SYSTEM_PROMPT_FILE: SYSTEM_PROMPT_FILE,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: phoenix.url,
      OTEL_SERVICE_NAME: 'e2e-twin',
      PHOENIX_PROJECT_NAME: 'ba',
      ...env
    })
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve) => child.on('close', resolve));
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 'e2e', prompt } });
  try {
    if (during) {
      await during({ send, stdout: () => stdout });
    }
    const response = await waitFor(
      () =>
        stdout
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((message) => message.id === 1),
      15000
    );
    child.stdin.end();
    await closed;
    return { response, spans: phoenix.spans, stderr, requests: deepseek.requests };
  } finally {
    child.kill();
    await phoenix.close();
    await deepseek.close();
  }
}

function llmSpans(spans) {
  return spans
    .filter((span) => span.name === 'llm:deepseek-flash')
    .sort((a, b) => a.attributes['llm.iteration'] - b.attributes['llm.iteration']);
}

function spanNamed(spans, name) {
  const found = spans.find((span) => span.name === name);
  assert.ok(found, `no span ${name} among ${spans.map((s) => s.name).join(', ')}`);
  return found;
}

// ---------------------------------------------------------------------------
// Capture on
// ---------------------------------------------------------------------------

test('e2e capture on: the LLM span holds the exact messages, parameters and tools sent, and the answer', async () => {
  const run = await runAdapter({
    env: { OTEL_CAPTURE_LLM_MESSAGES: 'true' },
    prompt: `Hello, my key is ${API_KEY}`,
    reply: (res) => sse(res, text('Chào bạn!'))
  });
  assert.equal(run.response.result.stopReason, 'end_turn');
  const [llm] = llmSpans(run.spans);
  const a = llm.attributes;
  assert.equal(llm.droppedAttributesCount, 0);
  assert.equal(a['llm.input_messages.0.message.role'], 'system');
  assert.equal(a['llm.input_messages.0.message.content'], SYSTEM_PROMPT, 'the whole system prompt');
  assert.equal(a['llm.input_messages.1.message.role'], 'user');
  assert.equal(a['llm.input_messages.1.message.content'], 'Hello, my key is [REDACTED]');
  assert.equal(a['llm.input_messages_total'], 2);
  assert.deepEqual(JSON.parse(a['llm.invocation_parameters']), {
    model: 'deepseek-flash',
    temperature: 0,
    thinking: { type: 'disabled' },
    stream: true,
    stream_options: { include_usage: true }
  });
  assert.deepEqual(
    [0, 1, 2, 3].map((k) => a[`llm.tools.${k}.tool.name`]),
    ['meeting_wait', 'thread_read', 'reply', undefined]
  );
  assert.equal(a['llm.output_messages.0.message.role'], 'assistant');
  assert.equal(a['llm.output_messages.0.message.content'], 'Chào bạn!');
  assert.equal(a['input.value'], 'Hello, my key is [REDACTED]', 'input.value is the prompt preview, as before');
  for (const span of run.spans) {
    for (const [name, value] of Object.entries(span.attributes)) {
      assert.ok(!String(value).includes(API_KEY), `${span.name} ${name} leaks the API key`);
    }
  }
});

test('e2e capture on: tool calls and their results reach the next call; meeting_* outputs reach their spans', async () => {
  const run = await runAdapter({
    env: { OTEL_CAPTURE_LLM_MESSAGES: 'true', OTEL_CAPTURE_TOOL_OUTPUT: 'meeting_*' },
    reply: WAIT_THEN_ANSWER
  });
  assert.equal(run.response.result.message.content, 'Chào bạn!');
  const [first, second] = llmSpans(run.spans);
  const a = first.attributes;
  assert.equal('llm.output_messages.0.message.content' in a, false);
  assert.equal(a['llm.output_messages.0.message.tool_calls.0.tool_call.function.name'], 'meeting_wait');
  assert.equal(a['llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments'], '{"timeout_s":40}');
  assert.equal(a['llm.output_messages.0.message.tool_calls.1.tool_call.id'], 'call_t');

  const b = second.attributes;
  assert.equal(b['llm.input_messages_total'], 5);
  assert.equal(b['llm.input_messages.2.message.role'], 'assistant');
  assert.equal(b['llm.input_messages.2.message.tool_calls.0.tool_call.id'], 'call_w');
  assert.equal(b['llm.input_messages.3.message.role'], 'tool');
  assert.equal(b['llm.input_messages.3.message.tool_call_id'], 'call_w');
  assert.equal(b['llm.input_messages.3.message.content'], WAIT_OUTPUT);
  assert.equal(b['llm.input_messages.4.message.tool_call_id'], 'call_t');
  assert.equal(b['llm.input_messages.4.message.content'], 'Thread: Elio: Chào cậu nhớ!');
  assert.equal(b['llm.output_messages.0.message.content'], 'Chào bạn!');

  const wait = spanNamed(run.spans, 'tool:meeting_wait').attributes;
  assert.equal(wait['output.value'], WAIT_OUTPUT);
  assert.equal(wait['output.mime_type'], 'application/json');
  assert.equal(spanNamed(run.spans, 'tool:thread_read').attributes['output.value'], undefined);
});

test('e2e capture on: a tool call cut at the token limit keeps its partial call on the failed span', async () => {
  const run = await runAdapter({
    env: { OTEL_CAPTURE_LLM_MESSAGES: 'true' },
    reply: (res, n) =>
      sse(res, n === 1 ? toolCalls([{ id: 'call_s', name: 'meeting_speak', args: '{"text":"Chào' }], 'length') : text('Recovered.'))
  });
  assert.equal(run.response.result.message.content, 'Recovered.');
  const [first] = llmSpans(run.spans);
  assert.equal(first.status.code, 2);
  assert.equal(first.status.message, 'Tool execution truncated due to token limits.');
  assert.equal(first.attributes['llm.output_messages.0.message.tool_calls.0.tool_call.function.name'], 'meeting_speak');
  assert.equal(first.attributes['llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments'], '{"text":"Chào');
});

test('e2e capture on: a stream that stops half-way keeps what the model had said on the failed span', async () => {
  const run = await runAdapter({
    env: { OTEL_CAPTURE_LLM_MESSAGES: 'true', DEEPSEEK_REQUEST_TIMEOUT_MS: '500' },
    reply: (res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial ans' } }] })}\n\n`);
      // …and nothing more: the read times out.
    }
  });
  assert.equal(run.response.result.stopReason, 'error');
  const [llm] = llmSpans(run.spans);
  assert.equal(llm.status.code, 2);
  assert.equal(llm.attributes['llm.input_messages.1.message.content'], 'Join the call');
  assert.equal(llm.attributes['llm.output_messages.0.message.content'], 'Partial ans');
});

test('e2e capture on: a turn cancelled mid-answer keeps what the model had said', async () => {
  const run = await runAdapter({
    env: { OTEL_CAPTURE_LLM_MESSAGES: 'true' },
    reply: (res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial ans' } }] })}\n\n`);
    },
    during: async ({ send, stdout }) => {
      await waitFor(() => stdout().includes('Partial ans'), 5000);
      send({ jsonrpc: '2.0', id: 2, method: 'session/cancel', params: { sessionId: 'e2e' } });
    }
  });
  const [llm] = llmSpans(run.spans);
  assert.equal(llm.attributes['llm.output_messages.0.message.content'], 'Partial ans');
  assert.equal(llm.status.code, 2);
});

test('e2e capture on: a refused request still shows what was sent, and no answer', async () => {
  const run = await runAdapter({
    env: { OTEL_CAPTURE_LLM_MESSAGES: 'true' },
    reply: (res) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('upstream exploded');
    }
  });
  assert.equal(run.response.result.stopReason, 'error');
  const [llm] = llmSpans(run.spans);
  assert.equal(llm.status.code, 2);
  assert.match(llm.status.message, /HTTP 500/);
  assert.equal(llm.attributes['llm.input_messages.1.message.content'], 'Join the call');
  assert.equal(llm.attributes['llm.output_messages.0.message.role'], undefined);
});

test('e2e start-up log: one [config] tracing line names what is captured; an invalid value is reported', async () => {
  const run = await runAdapter({
    env: { OTEL_CAPTURE_LLM_MESSAGES: 'true', OTEL_CAPTURE_TOOL_OUTPUT: 'meeting_*', OTEL_LLM_MESSAGES_MAX: 'lots' },
    reply: (res) => sse(res, text('ok'))
  });
  assert.match(
    run.stderr,
    /\[config\] tracing llm_messages=on tool_schemas=off tool_output=meeting_\* .*attribute_count_limit=4096 attribute_value_length_limit=65536 export_timeout_ms=10000 export_batch=32/
  );
  assert.match(run.stderr, /Ignoring OTEL_LLM_MESSAGES_MAX="lots"/);
  assert.equal(run.stderr.match(/\[config\] tracing/g).length, 1);
});

// ---------------------------------------------------------------------------
// Capture off, and what is sent
// ---------------------------------------------------------------------------

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

test('e2e capture off: spans carry exactly 0.3.0 attributes and the log says nothing is captured', async () => {
  const run = await runAdapter({ reply: WAIT_THEN_ANSWER });
  for (const span of run.spans) {
    for (const key of Object.keys(span.attributes)) {
      assert.doesNotMatch(key, /^llm\.(input_messages|output_messages|invocation_parameters|tools)/, span.name);
    }
  }
  const [, second] = llmSpans(run.spans);
  assert.deepEqual(Object.keys(second.attributes).sort(), LLM_KEYS_0_3_0);
  assert.deepEqual(Object.keys(spanNamed(run.spans, 'tool:meeting_wait').attributes).sort(), TOOL_KEYS_0_3_0);
  assert.match(run.stderr, /\[config\] tracing llm_messages=off tool_output=off/);
});

test('e2e: capture changes nothing that is sent to DeepSeek', async () => {
  const on = await runAdapter({
    env: { OTEL_CAPTURE_LLM_MESSAGES: 'true', OTEL_CAPTURE_TOOL_OUTPUT: 'true', OTEL_CAPTURE_LLM_TOOL_SCHEMAS: 'true' },
    reply: WAIT_THEN_ANSWER
  });
  const off = await runAdapter({ reply: WAIT_THEN_ANSWER });
  assert.equal(on.requests.length, 2);
  assert.deepEqual(on.requests, off.requests);
});
