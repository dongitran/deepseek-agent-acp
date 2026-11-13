/**
 * End-to-end: a turn the adapter stops itself (circuit breaker, iteration limit) gets a wrap-up — more model calls in
 * which the model tells the person why — instead of ending in silence (agent-infra #49). The real adapter runs against
 * a mock DeepSeek and the mock MCP server, whose meeting_join fails as the meeting gate did on 2026-11-13.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdapter, sse, sseHanging, text, toolCalls, waitFor, SESSION_ID } from './helpers/acp.mjs';

const HEADER = '[deepseek-agent-acp: this turn is being stopped]';
const JOIN_FAILS = { MOCK_MCP_EXTRA_TOOLS: 'meeting_join' };
const join = (n) => toolCalls([{ id: `call_${n}`, name: 'meeting_join', args: '{"url":"https://meet.google.com/abc-defg-hij"}' }]);
const wait = (n) => toolCalls([{ id: `call_${n}`, name: 'meeting_wait', args: '{}' }]);
const REPLY_ARGS = JSON.stringify({
  reply_to: 'a'.repeat(64),
  text: 'Em chưa vào được cuộc họp: dịch vụ họp từ chối yêu cầu. Anh thử lại sau một phút nhé.'
});
const reply = (n) => toolCalls([{ id: `call_${n}`, name: 'reply', args: REPLY_ARGS }]);

const toolNames = (request) => (request.tools ?? []).map((tool) => tool.function.name);
const isNotice = (message) => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(HEADER);

test('breaker on meeting_join: one more call without meeting_join, and its reply is posted', async () => {
  const run = await runAdapter({
    env: JOIN_FAILS,
    reply: (res, n) => sse(res, n <= 2 ? join(n) : n === 3 ? reply(n) : text('Done.'))
  });
  assert.equal(run.requests.length, 3, 'two joins, then one wrap-up call whose reply was posted');
  const wrapup = run.requests[2];
  const notice = wrapup.messages.at(-1);
  assert.ok(isNotice(notice), 'the wrap-up call ends with the adapter\'s notice');
  assert.ok(notice.content.includes('Your tool `meeting_join`'));
  assert.deepEqual(toolNames(wrapup), ['meeting_wait', 'thread_read', 'reply'], 'everything but the failed tool');
  assert.deepEqual(toolNames(run.requests[0]), ['meeting_wait', 'thread_read', 'reply', 'meeting_join']);
  assert.deepEqual(run.calls, ['meeting_join', 'meeting_join', 'reply'], 'the reply really ran');
  const [response] = run.responses;
  assert.equal(response.result.stopReason, 'end_turn');
  assert.match(response.result.message.content, /repetitive tool errors/);
});

test('a call to the tool that tripped the breaker is refused unrun', async () => {
  const run = await runAdapter({
    env: JOIN_FAILS,
    reply: (res, n) => sse(res, n <= 3 ? join(n) : text('Sorry.'))
  });
  assert.deepEqual(run.calls, ['meeting_join', 'meeting_join'], 'the third meeting_join never reached the server');
  assert.equal(run.requests.length, 4);
  const refused = run.requests[3].messages.find((message) => message.role === 'tool' && message.tool_call_id === 'call_3');
  assert.ok(refused, 'the refused call still has its tool result');
  assert.match(refused.content, /was not run/);
});

test('the wrap-up never makes more than ACP_WRAPUP_ITERATIONS calls', async () => {
  for (const [setting, expected] of [[undefined, 4], ['1', 3]]) {
    const run = await runAdapter({
      env: { ...JOIN_FAILS, ...(setting === undefined ? {} : { ACP_WRAPUP_ITERATIONS: setting }) },
      reply: (res, n) => sse(res, n <= 2 ? join(n) : wait(n))
    });
    assert.equal(run.requests.length, expected, `ACP_WRAPUP_ITERATIONS=${setting ?? '(default 2)'}`);
    assert.equal(run.responses[0].result.stopReason, 'end_turn');
  }
});

test('ACP_WRAPUP_ITERATIONS=0 stops exactly as 0.4.0 did', async () => {
  const run = await runAdapter({
    env: { ...JOIN_FAILS, ACP_WRAPUP_ITERATIONS: '0' },
    reply: (res, n) => sse(res, n <= 2 ? join(n) : reply(n))
  });
  assert.equal(run.requests.length, 2);
  assert.equal(run.responses[0].result.stopReason, 'end_turn');
  assert.deepEqual(run.calls, ['meeting_join', 'meeting_join']);
});

test('after the iteration limit the wrap-up offers every tool and the turn still ends max_turn_requests', async () => {
  const run = await runAdapter({
    env: { ACP_MAX_ITERATIONS: '2' },
    reply: (res, n) => sse(res, n <= 2 ? wait(n) : n === 3 ? reply(n) : text('Done.'))
  });
  assert.equal(run.requests.length, 3);
  const notice = run.requests[2].messages.at(-1);
  assert.ok(isNotice(notice));
  assert.match(notice.content, /all of its 2 steps/);
  assert.deepEqual(toolNames(run.requests[2]), ['meeting_wait', 'thread_read', 'reply']);
  assert.deepEqual(run.calls, ['meeting_wait', 'meeting_wait', 'reply']);
  assert.equal(run.responses[0].result.stopReason, 'max_turn_requests');
});

test('the wrap-up request failing leaves the turn as the breaker ended it', async () => {
  const run = await runAdapter({
    env: JOIN_FAILS,
    prompts: ['Join the call', 'Are you there?'],
    reply: (res, n) => {
      if (n === 3) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('upstream exploded');
        return;
      }
      sse(res, n <= 2 ? join(n) : text('Yes.'));
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'end_turn', 'never `error`: buzz-acp would respawn the adapter');
  const next = run.requests[3];
  assert.ok(!next.messages.some(isNotice), 'no notice is left without an answer after it');
  const joinResults = next.messages.filter((message) => message.role === 'tool' && /No valid session ID/.test(message.content));
  assert.equal(joinResults.length, 2, 'the stopped turn was committed');
  assert.match(run.stderr, /\[WRAP-UP\] .*the wrap-up failed/);
});

test('a cancel during the wrap-up rolls the whole turn back', async () => {
  const run = await runAdapter({
    env: JOIN_FAILS,
    prompts: ['Join the call', 'Hello again'],
    reply: (res, n) => (n === 3 ? sseHanging(res, 'Partial') : sse(res, n <= 2 ? join(n) : text('Hi.'))),
    onPrompt: async (index, { send, stdout }) => {
      if (index === 0) {
        await waitFor(() => stdout().includes('Partial'), 10000, 'the wrap-up call to start streaming');
        send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION_ID } });
      }
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'error', 'the cancel path answers as it always has');
  const next = run.requests[3];
  assert.ok(!next.messages.some((message) => message.role === 'tool'), 'no tool result of the cancelled turn is kept');
  assert.ok(!next.messages.some(isNotice));
});

// ---------------------------------------------------------------------------
// Traces: a stopped turn is a failed turn (agent-infra #49: Phoenix showed these turns as OK)
// ---------------------------------------------------------------------------

const POSTED_ID = '40738780fa35899d341c45daeda99e609aff92c6d3cb44c54e06e7290e7bb38b';
const SPAN_ERROR = 2;
const SPAN_OK = 1;

function spanNamed(spans, name) {
  const found = spans.find((span) => span.name === name);
  assert.ok(found, `no span ${name} among ${spans.map((span) => span.name).join(', ')}`);
  return found;
}

const llmSpans = (spans) =>
  spans.filter((span) => span.name === 'llm:deepseek-flash').sort((a, b) => a.attributes['llm.iteration'] - b.attributes['llm.iteration']);

test("a breaker turn is an ERROR span with error.kind circuit_breaker, and the wrap-up's reply is linked", async () => {
  const run = await runAdapter({
    env: JOIN_FAILS,
    trace: true,
    reply: (res, n) => sse(res, n <= 2 ? join(n) : n === 3 ? reply(n) : text('Done.'))
  });
  const turn = spanNamed(run.spans, 'agent_turn');
  assert.equal(turn.status.code, SPAN_ERROR);
  assert.equal(turn.attributes['error.kind'], 'circuit_breaker');
  assert.match(turn.attributes['error.message'], /2 identical tool errors in a row from meeting_join/);
  assert.equal(turn.attributes['deepseek.wrapup.iterations'], 1);
  assert.equal(turn.attributes['nostr.posted_event_id'], POSTED_ID, 'buzz-trace links the reply to this turn');
  assert.deepEqual(
    llmSpans(run.spans).map((span) => [span.attributes['llm.iteration'], span.attributes['deepseek.wrapup']]),
    [[1, undefined], [2, undefined], [3, true]]
  );
});

test('an iteration-limit turn is an ERROR span with error.kind iteration_limit', async () => {
  const run = await runAdapter({
    env: { ACP_MAX_ITERATIONS: '2' },
    trace: true,
    reply: (res, n) => sse(res, n <= 2 ? wait(n) : n === 3 ? reply(n) : text('Done.'))
  });
  const turn = spanNamed(run.spans, 'agent_turn');
  assert.equal(turn.status.code, SPAN_ERROR);
  assert.equal(turn.attributes['error.kind'], 'iteration_limit');
  assert.match(turn.attributes['error.message'], /iteration limit/);
  assert.equal(turn.attributes['deepseek.wrapup.iterations'], 1);
});

test('a turn the model finishes stays OK, with no wrap-up attribute anywhere', async () => {
  const run = await runAdapter({
    env: JOIN_FAILS,
    trace: true,
    reply: (res, n) => sse(res, n === 1 ? wait(n) : text('Chào bạn!'))
  });
  const turn = spanNamed(run.spans, 'agent_turn');
  assert.equal(turn.status.code, SPAN_OK);
  for (const span of run.spans) {
    for (const key of Object.keys(span.attributes)) {
      assert.doesNotMatch(key, /wrapup|^error\./, `${span.name} ${key}`);
    }
  }
});
