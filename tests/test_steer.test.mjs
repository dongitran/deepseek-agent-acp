/**
 * End-to-end: where a steered message (`_session/steering`) lands in the history. A meeting twin runs with
 * turn_handling steer and spends most of a call inside meeting_wait, so a thread mention usually arrives while a tool
 * call runs. v0.5.1 appended it at once, between the assistant's tool_calls and their results, and the DeepSeek API
 * refuses that history (checked against api.deepseek.com on 2026-11-15: HTTP 400 "An assistant message with
 * 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'."): the turn failed with `error`
 * and buzz-acp respawned the adapter. Steers now wait for the next model call and go in right before it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdapter, sse, text, toolCalls, waitFor, SESSION_ID } from './helpers/acp.mjs';

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
const STEER_HEADER = '[New message — arrived while you were working]';
const NOTICE_HEADER = '[deepseek-agent-acp: this turn is being stopped]';

/** The DeepSeek API's rule: an assistant message with tool_calls is followed at once by a tool message for each id. */
function orderError(messages) {
  for (const [at, message] of messages.entries()) {
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      continue;
    }
    const unanswered = new Set(message.tool_calls.map((call) => call.id));
    for (const next of messages.slice(at + 1)) {
      if (next.role !== 'tool') {
        break;
      }
      unanswered.delete(next.tool_call_id);
    }
    if (unanswered.size > 0) {
      return "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)";
    }
  }
  return null;
}

/** A mock DeepSeek that refuses what the real API refuses, with its status and message, and otherwise runs `reply`. */
function strict(reply) {
  return (res, n, body) => {
    const error = orderError(body.messages);
    if (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error, type: 'invalid_request_error', code: 'invalid_request_error' } }));
      return;
    }
    reply(res, n, body);
  };
}

/** Each message as its role, `assistant(tool_calls)` for an answer that calls tools. */
const shape = (messages) => messages.map((m) => (m.role === 'assistant' && m.tool_calls?.length ? 'assistant(tool_calls)' : m.role));

/** Sends a steer once `ready(stdout)` holds and waits until the adapter has answered it; resolves to that answer. */
async function steerWhen(ready, { send, stdout }, words, id = 50) {
  await waitFor(() => ready(stdout()), 10000, 'the moment to steer');
  send({ jsonrpc: '2.0', id, method: '_session/steering', params: { sessionId: SESSION_ID, prompt: words } });
  await waitFor(() => stdout().includes(`"id":${id},`), 10000, 'the steer to be answered');
}

const steerAnswer = (run, id = 50) => run.messages.find((message) => message.id === id)?.result;

test('a steer that arrives while a tool call runs goes in after its result, and the next call sees it', async () => {
  const run = await runAdapter({
    env: { MOCK_MCP_SLOW_TOOLS: 'meeting_wait:1000' },
    reply: strict((res, n) => sse(res, n === 1 ? toolCalls([{ id: 'call_1', name: 'meeting_wait', args: '{}' }]) : text('Yes.'))),
    onPrompt: (index, io) => steerWhen((out) => out.includes('"sessionUpdate":"tool_call"'), io, 'Are you there?')
  });
  assert.equal(steerAnswer(run).outcome, 'injected');
  assert.equal(run.responses[0].result.stopReason, 'end_turn', 'v0.5.1: HTTP 400 from the API, then `error`');
  assert.equal(run.requests.length, 2);
  const next = run.requests[1].messages;
  assert.deepEqual(shape(next), ['system', 'user', 'assistant(tool_calls)', 'tool', 'user']);
  assert.equal(next.at(-1).content, `${STEER_HEADER}\nAre you there?`);
});

test('a steer that arrives while the model writes its last answer gets one more call, so this turn answers it', async () => {
  let release;
  const steered = new Promise((resolve) => {
    release = resolve;
  });
  const run = await runAdapter({
    reply: strict((res, n) => {
      if (n === 1) {
        res.writeHead(200, SSE_HEADERS);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Bye' } }] })}\n\n`);
        void steered.then(() => {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '.' }, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      sse(res, text('Yes, still here.'));
    }),
    onPrompt: async (index, io) => {
      await steerWhen((out) => out.includes('Bye'), io, 'Wait, one more question');
      release();
    }
  });
  assert.equal(steerAnswer(run).outcome, 'injected');
  assert.equal(run.requests.length, 2, 'v0.5.1 ended the turn on "Bye." and the steer waited for the next prompt');
  const next = run.requests[1].messages;
  assert.deepEqual(shape(next), ['system', 'user', 'assistant', 'user']);
  assert.equal(next[2].content, 'Bye.');
  assert.equal(next[3].content, `${STEER_HEADER}\nWait, one more question`);
  assert.equal(run.responses[0].result.stopReason, 'end_turn');
  assert.equal(run.responses[0].result.message.content, 'Yes, still here.');
});

test('a steer during the final answer of the last allowed call: the turn still ends finished, the steer waits', async () => {
  let release;
  const steered = new Promise((resolve) => {
    release = resolve;
  });
  const run = await runAdapter({
    env: { ACP_MAX_ITERATIONS: '1' },
    prompts: ['Join the call', 'Hello again'],
    reply: strict((res, n) => {
      if (n === 1) {
        res.writeHead(200, SSE_HEADERS);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Bye' } }] })}\n\n`);
        void steered.then(() => {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '.' }, finish_reason: 'stop' }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      sse(res, text('Hi again.'));
    }),
    onPrompt: async (index, io) => {
      if (index !== 0) {
        return;
      }
      await steerWhen((out) => out.includes('Bye'), io, 'Wait, one more question');
      release();
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'end_turn', 'not max_turn_requests: the model had finished');
  assert.equal(run.responses[0].result.message.content, 'Bye.');
  assert.doesNotMatch(run.stderr, /\[ITERATION LIMIT\]|\[WRAP-UP\]/);
  const next = run.requests[1].messages;
  assert.deepEqual(shape(next), ['system', 'user', 'assistant', 'user', 'user'], 'the kept steer, then the next prompt');
  assert.equal(next[3].content, `${STEER_HEADER}\nWait, one more question`);
  assert.equal(next[4].content, 'Hello again');
});

test("a steer that arrives during the breaker's last tool call reaches the wrap-up, before the notice", async () => {
  const join = (n) => toolCalls([{ id: `call_${n}`, name: 'meeting_join', args: '{"url":"https://meet.google.com/abc-defg-hij"}' }]);
  let joins = 0;
  const run = await runAdapter({
    env: { MOCK_MCP_EXTRA_TOOLS: 'meeting_join', MOCK_MCP_SLOW_TOOLS: 'meeting_join:600' },
    reply: strict((res, n) => sse(res, n <= 2 ? join(n) : text('Sorry.'))),
    onPrompt: (index, io) =>
      steerWhen(
        (out) => {
          joins = (out.match(/"sessionUpdate":"tool_call",/g) ?? []).length;
          return joins === 2;
        },
        io,
        'Did it work?'
      )
  });
  assert.equal(steerAnswer(run).outcome, 'injected');
  assert.equal(run.requests.length, 3, 'two joins, then the wrap-up call (v0.5.1: refused with HTTP 400)');
  const wrapup = run.requests[2].messages;
  assert.deepEqual(shape(wrapup).slice(-4), ['assistant(tool_calls)', 'tool', 'user', 'user']);
  assert.equal(wrapup.at(-2).content, `${STEER_HEADER}\nDid it work?`);
  assert.ok(wrapup.at(-1).content.startsWith(NOTICE_HEADER), 'the notice stays the last word');
  assert.equal(run.responses[0].result.stopReason, 'end_turn');
});

test('a steer of a turn that is cancelled before its next call is dropped with the turn', async () => {
  const run = await runAdapter({
    env: { MOCK_MCP_SLOW_TOOLS: 'meeting_wait:3000' },
    prompts: ['Join the call', 'Hello again'],
    reply: strict((res, n) => sse(res, n === 1 ? toolCalls([{ id: 'call_1', name: 'meeting_wait', args: '{}' }]) : text('Hi.'))),
    onPrompt: async (index, io) => {
      if (index !== 0) {
        return;
      }
      await steerWhen((out) => out.includes('"sessionUpdate":"tool_call"'), io, 'Are you there?');
      io.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION_ID } });
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'cancelled');
  const next = run.requests[1].messages;
  assert.deepEqual(shape(next), ['system', 'user'], 'the next turn starts from the checkpoint, as before');
  assert.equal(next[1].content, 'Hello again');
});
