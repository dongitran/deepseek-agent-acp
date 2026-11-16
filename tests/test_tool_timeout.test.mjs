/**
 * MCP_TOOL_TIMEOUT_MS bounds the MCP request itself. @modelcontextprotocol/sdk ends a request it is given without a
 * `timeout` at its own default of 60 s (DEFAULT_REQUEST_TIMEOUT_MSEC), whatever the caller waits for: a meeting twin
 * with MCP_TOOL_TIMEOUT_MS=180000 had its meeting_join (the gate waits up to 150 s) end at 60 s with
 * "MCP error -32001: Request timed out" while the gate went on joining, and two such results in a row stopped the call.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpClient } from '../dist/mcp-client.js';
import { runAdapter, sse, text, waitFor, MOCK_MCP } from './helpers/acp.mjs';

function logFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-tool-timeout-')), name);
}

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

/** Runs `fn` with `vars` in process.env: the client reads its settings there, and its MCP server inherits them. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

/** One turn of the event loop that needs no timer: the test below mocks setTimeout, not setImmediate. */
const loopTurn = () => new Promise((resolve) => setImmediate(resolve));

async function untilReal(condition, ms, what) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await loopTurn();
  }
}

test('McpClient: MCP_TOOL_TIMEOUT_MS=180000 lets a tool run past the SDK default of 60 s, and ends it at 180 s', async (t) => {
  const calls = logFile('calls.log');
  const cancels = logFile('cancels.log');
  // The server really holds the call for 5 s; the client's clock is mocked, so 180 s pass in a moment.
  await withEnv(
    { MCP_TOOL_TIMEOUT_MS: '180000', MOCK_MCP_SLOW_TOOLS: 'meeting_join:5000', MOCK_MCP_CALL_LOG: calls, MOCK_MCP_CANCEL_LOG: cancels },
    async () => {
      const client = new McpClient(MOCK_MCP);
      try {
        await client.init();
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let settled = false;
        const call = client.callTool('meeting_join', {}).finally(() => {
          settled = true;
        });
        await untilReal(() => lines(calls).length === 1, 5000, 'the server to start the call');

        t.mock.timers.tick(60_001);
        for (let i = 0; i < 50; i++) {
          await loopTurn();
        }
        assert.equal(settled, false, 'the call still runs after 60 s (v0.5.1 ended it here: MCP error -32001)');

        t.mock.timers.tick(120_000);
        assert.match(JSON.parse(await call).error, /timed out after 180000ms/);
        await untilReal(() => lines(cancels).length === 1, 5000, 'the server to be told the call was cancelled');
      } finally {
        t.mock.timers.reset();
        await client.close();
      }
    }
  );
});

test('McpClient: a call that outlives MCP_TOOL_TIMEOUT_MS is cancelled on the server at that bound, not 60 s later', async () => {
  const calls = logFile('calls.log');
  const cancels = logFile('cancels.log');
  await withEnv(
    { MCP_TOOL_TIMEOUT_MS: '300', MOCK_MCP_SLOW_TOOLS: 'meeting_wait:3000', MOCK_MCP_CALL_LOG: calls, MOCK_MCP_CANCEL_LOG: cancels },
    async () => {
      const client = new McpClient(MOCK_MCP);
      try {
        await client.init();
        const started = Date.now();
        const result = await client.callTool('meeting_wait', {});
        assert.ok(Date.now() - started < 2000, `answered after ${Date.now() - started} ms; the tool takes 3000 ms`);
        assert.match(JSON.parse(result).error, /timed out after 300ms/);
        // v0.5.1 raced its own timer against the SDK request, which ran on to the SDK's 60 s: the server never heard.
        await waitFor(() => lines(cancels).includes('meeting_wait'), 2000, 'the server to be told the call was cancelled');
      } finally {
        await client.close();
      }
    }
  );
});

test('McpClient: a call that ends in time is not cancelled, and the turn signal still cancels a call at once', async () => {
  const cancels = logFile('cancels.log');
  const slow = 'thread_read:300,meeting_wait:4000';
  await withEnv({ MCP_TOOL_TIMEOUT_MS: '5000', MOCK_MCP_SLOW_TOOLS: slow, MOCK_MCP_CANCEL_LOG: cancels }, async () => {
    const client = new McpClient(MOCK_MCP);
    try {
      assert.match(await client.callTool('thread_read', {}), /^Thread:/, 'a 300 ms call well inside the bound');
      const turn = new AbortController();
      const call = client.callTool('meeting_wait', {}, turn.signal);
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = Date.now();
      turn.abort();
      assert.match(await call, /cancelled/);
      assert.ok(Date.now() - started < 500, 'a cancel does not wait for the tool or the timeout');
      await waitFor(() => lines(cancels).includes('meeting_wait'), 2000, 'the server to be told the call was cancelled');
      assert.deepEqual(lines(cancels), ['meeting_wait'], 'only the cancelled call');
    } finally {
      await client.close();
    }
  });
});

test('the start-up log states the tool timeout; an invalid MCP_TOOL_TIMEOUT_MS is reported, not half-parsed', async () => {
  for (const [value, effective, warned] of [
    ['180000', '180000', false],
    ['180s', '60000', true],
    ['abc', '60000', true],
    ['3000000000', '60000', true]
  ]) {
    const run = await runAdapter({ env: { MCP_TOOL_TIMEOUT_MS: value }, reply: (res) => sse(res, text('ok')) });
    assert.match(run.stderr, new RegExp(`\\[config\\] .*tool_timeout_ms=${effective}\\b`), `MCP_TOOL_TIMEOUT_MS=${value}`);
    assert.equal(/Ignoring MCP_TOOL_TIMEOUT_MS=/.test(run.stderr), warned, `MCP_TOOL_TIMEOUT_MS=${value}`);
  }
});
