/**
 * Runs the real adapter (dist/index.js) end to end: a mock DeepSeek that records every request body, the mock MCP
 * server (tests/fixtures/mock-mcp-server.mjs, its calls logged to a file) and, when asked, a mock Phoenix
 * (tests/helpers/otlp.mjs). Prompts go one after another on one session; every stdout line is kept.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startCollector } from './otlp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(__dirname, '../../dist/index.js');
export const MOCK_MCP = path.resolve(__dirname, '../fixtures/mock-mcp-server.mjs');
export const API_KEY = 'sk-e2e-wrapup-0123456789abcdef01234';
export const SESSION_ID = 'e2e-wrapup';

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
const USAGE = { choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } };

/** Writes a whole SSE answer: each chunk, then [DONE]. */
export function sse(res, chunks) {
  res.writeHead(200, SSE_HEADERS);
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Starts an SSE answer and never ends it: the model is "still thinking" after `content`. */
export function sseHanging(res, content) {
  res.writeHead(200, SSE_HEADERS);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
}

/** The chunks of a text answer. */
export function text(content) {
  return [{ choices: [{ delta: { content }, finish_reason: 'stop' }] }, USAGE];
}

/** The chunks of an answer that calls tools: `calls` is [{ id, name, args }] with args as a JSON string. */
export function toolCalls(calls, finishReason = 'tool_calls') {
  const deltas = calls.map((call, index) => ({
    index,
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.args }
  }));
  return [{ choices: [{ delta: { tool_calls: deltas } }] }, { choices: [{ delta: {}, finish_reason: finishReason }] }, USAGE];
}

/** Host variables that could change what is traced or which tools exist; each run sets its own. */
const HOST_SETTINGS = /^(OTEL_|PHOENIX_|ACP_|BUZZ_|DEEPSEEK_|MOCK_MCP_|MCP_TOOL_TIMEOUT_MS$)/;

export async function waitFor(find, timeoutMs, what = 'the adapter') {
  const started = Date.now();
  for (;;) {
    const found = find();
    if (found) {
      return found;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Runs `prompts` in order on one session. `reply(res, n, body)` answers the n-th chat-completions request (1-based).
 * `onPrompt(index, { send, stdout })` runs after a prompt is sent and before its response is awaited.
 * Returns the responses (in prompt order), every notification, the request bodies, the tools the MCP server ran,
 * stderr, and — with `trace: true` — the spans Phoenix received.
 */
export async function runAdapter({ env = {}, prompts = ['Join the call'], reply, onPrompt, trace = false }) {
  const requests = [];
  const deepseek = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      reply(res, requests.length, body);
    });
  });
  await new Promise((resolve) => deepseek.listen(0, '127.0.0.1', resolve));
  const phoenix = trace ? await startCollector() : null;
  const callLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-wrapup-')), 'calls.log');

  const childEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!HOST_SETTINGS.test(name)) {
      childEnv[name] = value;
    }
  }
  const child = spawn(process.execPath, [INDEX_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...childEnv,
      DEEPSEEK_API_KEY: API_KEY,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${deepseek.address().port}`,
      DEEPSEEK_MODEL: 'deepseek-flash',
      DEEPSEEK_THINKING: 'disabled',
      ACP_MCP_COMMAND: MOCK_MCP,
      MOCK_MCP_CALL_LOG: callLog,
      ...(phoenix ? { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: phoenix.url, OTEL_SERVICE_NAME: 'e2e-wrapup' } : {}),
      ...env
    }
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
  const messages = () =>
    stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  try {
    const responses = [];
    for (const [index, prompt] of prompts.entries()) {
      const id = index + 1;
      send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: SESSION_ID, prompt } });
      if (onPrompt) {
        await onPrompt(index, { send, stdout: () => stdout });
      }
      responses.push(
        await waitFor(() => messages().find((message) => message.id === id), 15000, `the response to prompt ${id}`)
      );
    }
    child.stdin.end();
    await closed;
    const calls = fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : [];
    return {
      responses,
      notifications: messages().filter((message) => message.method),
      requests,
      calls,
      stderr,
      spans: phoenix ? phoenix.spans : []
    };
  } finally {
    child.kill();
    if (phoenix) {
      await phoenix.close();
    }
    deepseek.closeAllConnections();
    await new Promise((resolve) => deepseek.close(resolve));
  }
}
