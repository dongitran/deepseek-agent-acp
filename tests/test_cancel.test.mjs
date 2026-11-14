/**
 * End-to-end: session/cancel. ACP says the agent MUST answer the pending session/prompt with the stop reason
 * `cancelled`, catching the errors its aborted operations throw, and SHOULD stop model requests and tool calls as soon
 * as possible. buzz-acp sends the cancel as a notification, then waits 5 s (CONTROL_CANCEL_GRACE) for that answer: a
 * stop reason outside its set (`error`) or no answer in time both make it respawn the adapter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { McpClient } from '../dist/mcp-client.js';
import { runAdapter, sse, sseHanging, text, toolCalls, waitFor, MOCK_MCP, SESSION_ID } from './helpers/acp.mjs';

/** buzz-acp's StopReason::from_str accepts exactly these; anything else is a protocol error and a respawn. */
const BUZZ_ACP_STOP_REASONS = ['end_turn', 'cancelled', 'max_tokens', 'max_turn_requests', 'refusal'];
/** buzz-acp's CONTROL_CANCEL_GRACE: the time it waits for the cancelled turn's answer. */
const CANCEL_GRACE_MS = 5000;

const wait = (n) => toolCalls([{ id: `call_${n}`, name: 'meeting_wait', args: '{}' }]);

/** Sends session/cancel once `ready(stdout)` holds; resolves to the ms from the cancel to the first prompt's answer. */
function cancelWhen(ready, timing) {
  return async (index, { send, stdout }) => {
    if (index !== 0) {
      return;
    }
    await waitFor(() => ready(stdout()), 10000, 'the moment to cancel');
    const at = Date.now();
    send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION_ID } });
    await waitFor(() => stdout().includes('"id":1,'), 15000, 'the cancelled turn to answer');
    timing.ms = Date.now() - at;
  };
}

test('a cancel while the model streams answers stopReason cancelled, and the next turn starts clean', async () => {
  const timing = {};
  const run = await runAdapter({
    prompts: ['hello', 'again'],
    reply: (res, n) => (n === 1 ? sseHanging(res, 'Partial') : sse(res, text('Hi.'))),
    onPrompt: cancelWhen((out) => out.includes('Partial'), timing)
  });
  const { stopReason } = run.responses[0].result;
  assert.equal(stopReason, 'cancelled');
  assert.ok(BUZZ_ACP_STOP_REASONS.includes(stopReason));
  assert.ok(timing.ms < CANCEL_GRACE_MS);
  const next = run.requests[1].messages;
  assert.ok(!next.some((m) => m.role === 'user' && m.content === 'hello'), 'the cancelled turn is rolled back');
});

test('a cancel while a tool call runs is answered at once, within the 5 s buzz-acp waits, not when the tool returns', async () => {
  const timing = {};
  const run = await runAdapter({
    env: { MOCK_MCP_SLOW_TOOLS: 'meeting_wait:8000' },
    reply: (res, n) => sse(res, n === 1 ? wait(n) : text('Done.')),
    onPrompt: cancelWhen((out) => out.includes('"sessionUpdate":"tool_call"'), timing)
  });
  assert.equal(run.responses[0].result.stopReason, 'cancelled');
  assert.ok(timing.ms < 2000, `answered ${timing.ms} ms after the cancel; the tool alone takes 8000 ms`);
  const answeredAt = run.messages.findIndex((m) => m.id === 1);
  const late = run.messages.slice(answeredAt + 1).filter((m) => m.method === 'session/update');
  assert.deepEqual(late, [], 'ACP: no session/update for the turn after its answer');
});

test("after a cancel, the rest of the answer's tool calls never run", async () => {
  const timing = {};
  const run = await runAdapter({
    env: { MOCK_MCP_SLOW_TOOLS: 'meeting_wait:8000' },
    reply: (res, n) =>
      sse(
        res,
        n === 1
          ? toolCalls([
              { id: 'call_w', name: 'meeting_wait', args: '{}' },
              { id: 'call_r', name: 'reply', args: JSON.stringify({ reply_to: 'a'.repeat(64), text: 'late' }) }
            ])
          : text('Done.')
      ),
    onPrompt: cancelWhen((out) => out.includes('"toolCallId":"call_w"'), timing)
  });
  assert.equal(run.responses[0].result.stopReason, 'cancelled');
  assert.deepEqual(run.calls, ['meeting_wait'], 'nothing is posted after the person stopped the turn');
  assert.ok(!run.messages.some((m) => m.params?.update?.toolCallId === 'call_r'), 'the skipped call is not reported');
});

test('McpClient: a long-lived turn signal keeps no abort listener once its calls end, however many they are', async () => {
  // Node never warns about AbortSignal listeners, so a leak is silent: count them. The SDK never removes the listener
  // it adds to the signal it is given, which is why each call gets a controller of its own.
  const turn = new AbortController();
  const client = new McpClient(MOCK_MCP);
  try {
    for (let i = 0; i < 12; i++) {
      assert.match(await client.callTool('meeting_wait', {}, turn.signal), /addressed/);
    }
    assert.equal(getEventListeners(turn.signal, 'abort').length, 0);
  } finally {
    await client.close();
  }
});

test('McpClient: a call whose turn is already cancelled never reaches the server', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-cancel-')), 'calls.log');
  process.env.MOCK_MCP_CALL_LOG = log;
  const turn = new AbortController();
  turn.abort();
  const client = new McpClient(MOCK_MCP);
  try {
    assert.match(await client.callTool('reply', { text: 'late' }, turn.signal), /cancelled/);
    assert.equal(fs.existsSync(log), false, 'no tool ran');
  } finally {
    delete process.env.MOCK_MCP_CALL_LOG;
    await client.close();
  }
});

test('McpClient: a turn cancelled while the client connects runs no tool', async () => {
  // The first call connects the client (as when the start-up connect failed or has not finished); the cancel lands
  // during that connect.
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-cancel-')), 'calls.log');
  process.env.MOCK_MCP_CALL_LOG = log;
  const turn = new AbortController();
  const client = new McpClient(MOCK_MCP);
  try {
    const call = client.callTool('reply', { text: 'late' }, turn.signal);
    turn.abort();
    assert.match(await call, /cancelled/);
    assert.equal(fs.existsSync(log), false, 'no tool ran');
  } finally {
    delete process.env.MOCK_MCP_CALL_LOG;
    await client.close();
  }
});

test('a cancel while the turn lists its tools is answered at once', async () => {
  // Each turn starts by listing the MCP tools; a slow server (7 s here) must not hold the cancelled turn's answer. The
  // cancel waits until the server has the list request, so it lands in the listing, not in the start-up connect.
  const listLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-cancel-')), 'lists.log');
  const listed = () => fs.existsSync(listLog) && fs.readFileSync(listLog, 'utf8').includes('tools/list');
  const timing = {};
  const run = await runAdapter({
    env: { MOCK_MCP_SLOW_LIST: '7000', MOCK_MCP_LIST_LOG: listLog },
    reply: (res) => sse(res, text('Done.')),
    onPrompt: cancelWhen(listed, timing)
  });
  assert.equal(run.responses[0].result.stopReason, 'cancelled');
  assert.ok(timing.ms < 2000, `answered ${timing.ms} ms after the cancel; listing the tools takes 7000 ms`);
  assert.equal(run.requests.length, 0, 'the model is never called');
});

test("a cancel during the last allowed iteration's tool call ends the turn as cancelled, not at the iteration limit", async () => {
  const timing = {};
  const run = await runAdapter({
    env: { ACP_MAX_ITERATIONS: '1', MOCK_MCP_SLOW_TOOLS: 'meeting_wait:8000' },
    reply: (res, n) => sse(res, wait(n)),
    onPrompt: cancelWhen((out) => out.includes('"sessionUpdate":"tool_call"'), timing)
  });
  assert.equal(run.responses[0].result.stopReason, 'cancelled');
  assert.ok(!run.messages.some((m) => JSON.stringify(m).includes('iteration limit')), 'no iteration-limit notice');
  assert.doesNotMatch(run.stderr, /\[ITERATION LIMIT\]|\[WRAP-UP\]/);
});

test('a steer that arrives after the cancel is refused, so the client still delivers it', async () => {
  const run = await runAdapter({
    prompts: ['hello'],
    reply: (res) => sseHanging(res, 'Partial'),
    onPrompt: async (index, { send, stdout }) => {
      await waitFor(() => stdout().includes('Partial'), 10000, 'the answer to start');
      send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION_ID } });
      send({ jsonrpc: '2.0', id: 50, method: '_session/steering', params: { sessionId: SESSION_ID, prompt: 'one more thing' } });
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'cancelled');
  const steer = run.messages.find((m) => m.id === 50);
  assert.ok(steer, 'the steer is answered');
  assert.equal(steer.result.outcome, 'promptRequired', 'not `injected`: the rollback would drop it');
});
