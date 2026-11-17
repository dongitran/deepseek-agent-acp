/**
 * End-to-end: a request DeepSeek holds in its queue (issue #6). DeepSeek admits a request it cannot serve yet with HTTP
 * 200 and sends only `: keep-alive` comments, for up to 10 minutes (about 15 were seen on 14 Sep 2026); since 0.5.2
 * each comment re-armed DEEPSEEK_REQUEST_TIMEOUT_MS, so one model call could wait 30–45 minutes. A meeting twin's whole
 * call is one turn: it sat silent, the meeting gate ended the call after 600 s, and an `error` made buzz-acp respawn it.
 * Now the first useful event has its own deadline, and DEEPSEEK_FALLBACK_MODEL takes the stalled call and the calls
 * after it while the primary model cools down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAdapter, sse, text, toolCalls, waitFor, SESSION_ID } from './helpers/acp.mjs';

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
const ROLE_ONLY = { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
const FALLBACK = { DEEPSEEK_FALLBACK_MODEL: 'deepseek-v4-pro' };

/** DeepSeek holding a request in its queue: HTTP 200, then a `: keep-alive` every 50 ms until the client goes. */
function hold(res) {
  res.writeHead(200, SSE_HEADERS);
  const timer = setInterval(() => res.write(': keep-alive\n\n'), 50);
  res.on('close', () => clearInterval(timer));
}

/** Records when each request arrived, then answers it with `reply(res, n, body)`. */
function timed(reply) {
  const arrivals = [];
  return {
    arrivals,
    reply: (res, n, body) => {
      arrivals.push(Date.now());
      reply(res, n, body);
    }
  };
}

test('a request held with keep-alives is cut at DEEPSEEK_FIRST_EVENT_TIMEOUT_MS and sent again', async () => {
  const deepseek = timed((res, n) => (n === 1 ? hold(res) : sse(res, text('Here.'))));
  const run = await runAdapter({ env: { DEEPSEEK_FIRST_EVENT_TIMEOUT_MS: '300' }, reply: deepseek.reply });
  assert.equal(run.responses[0].result.stopReason, 'end_turn', '0.5.2 waited for as long as DeepSeek held it');
  assert.equal(run.responses[0].result.message.content, 'Here.');
  assert.deepEqual(run.requests.map((request) => request.model), ['deepseek-flash', 'deepseek-flash']);
  const gap = deepseek.arrivals[1] - deepseek.arrivals[0];
  // Taken at the mock server: the first request's connection setup is in it, hence the slack under load.
  assert.ok(gap >= 1000 && gap < 3000, `sent again ${gap} ms later: the 300 ms deadline, then the 1 s backoff`);
  assert.match(run.stderr, /\[RETRY\] .*DEEPSEEK_FIRST_EVENT_TIMEOUT_MS/);
  assert.match(run.stderr, /\[STREAM\] deepseek-flash: \d+ keep-alive/);
});

test('with a fallback, the retry of a stalled call goes to it at once and nothing else changes', async () => {
  const deepseek = timed((res, n) => (n === 1 ? hold(res) : sse(res, text('Here.'))));
  const run = await runAdapter({ env: { DEEPSEEK_FIRST_EVENT_TIMEOUT_MS: '300', ...FALLBACK }, reply: deepseek.reply });
  assert.equal(run.responses[0].result.stopReason, 'end_turn');
  assert.equal(run.responses[0].result.message.content, 'Here.');
  assert.deepEqual(run.requests.map((request) => request.model), ['deepseek-flash', 'deepseek-v4-pro']);
  const { model: _first, ...first } = run.requests[0];
  const { model: _second, ...second } = run.requests[1];
  assert.deepEqual(second, first, 'the same messages, tools and parameters');
  const gap = deepseek.arrivals[1] - deepseek.arrivals[0];
  assert.ok(gap < 1000, `sent to the fallback ${gap} ms later: no backoff, another model's queue`);
  assert.match(run.stderr, /\[FALLBACK\] deepseek-flash stalled .*calls go to deepseek-v4-pro for the next 60 s/);
});

test('while the primary cools down the next prompt goes straight to the fallback', async () => {
  const run = await runAdapter({
    prompts: ['hello', 'again'],
    env: { DEEPSEEK_FIRST_EVENT_TIMEOUT_MS: '300', ...FALLBACK },
    reply: (res, n) => (n === 1 ? hold(res) : sse(res, text(`Answer ${n}.`)))
  });
  assert.deepEqual(
    run.responses.map((response) => response.result.stopReason),
    ['end_turn', 'end_turn']
  );
  assert.deepEqual(run.requests.map((request) => request.model), ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-pro']);
});

test('headers then total silence are cut at DEEPSEEK_REQUEST_TIMEOUT_MS, not at the first-event deadline', async () => {
  // A half-open connection: headers, then not one byte. 0.5.2 cut it at the request timeout; PR #7 waited the deadline.
  // Silence is no stall: the retry stays on the same model, after the usual backoff.
  const deepseek = timed((res, n) => {
    if (n === 1) {
      res.writeHead(200, SSE_HEADERS);
      res.flushHeaders();
      return;
    }
    sse(res, text('Here.'));
  });
  const run = await runAdapter({
    env: { DEEPSEEK_REQUEST_TIMEOUT_MS: '400', DEEPSEEK_FIRST_EVENT_TIMEOUT_MS: '5000', ...FALLBACK },
    reply: deepseek.reply
  });
  assert.equal(run.responses[0].result.stopReason, 'end_turn');
  assert.deepEqual(run.requests.map((request) => request.model), ['deepseek-flash', 'deepseek-flash']);
  const gap = deepseek.arrivals[1] - deepseek.arrivals[0];
  assert.ok(gap < 2500, `sent again ${gap} ms later: 400 ms of silence and the 1 s backoff, not the 5 s deadline`);
});

test('a complete answer followed by keep-alives without [DONE] is taken after the grace', async () => {
  const run = await runAdapter({
    env: { DEEPSEEK_REQUEST_TIMEOUT_MS: '1000' },
    reply: (res) => {
      // The whole answer (its finish_reason and usage), then keep-alives instead of [DONE] (deepseek-harness#6959).
      hold(res);
      for (const chunk of text('Done.')) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'end_turn', 'PR #7 failed it with a read timeout');
  assert.equal(run.responses[0].result.message.content, 'Done.');
  assert.equal(run.requests.length, 1);
  assert.match(run.stderr, /\[STREAM\] deepseek-flash: .*finish_reason/);
});

test('a tool-call answer followed by keep-alives without [DONE] still runs its tool, once', async () => {
  // A meeting twin answers with tool calls, and the finish_reason comes in a chunk of its own.
  const run = await runAdapter({
    env: { DEEPSEEK_REQUEST_TIMEOUT_MS: '1000' },
    reply: (res, n) => {
      if (n > 1) {
        sse(res, text('Done.'));
        return;
      }
      hold(res);
      for (const chunk of toolCalls([{ id: 'call_1', name: 'meeting_wait', args: '{}' }])) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'end_turn');
  assert.deepEqual(run.calls, ['meeting_wait'], 'the answer was taken and its tool ran, not sent again');
  assert.equal(run.requests.length, 2);
});

test('a stream with only the role chunk and [DONE] is sent again, never taken as an empty answer', async () => {
  const run = await runAdapter({
    reply: (res, n) => {
      if (n === 1) {
        res.writeHead(200, SSE_HEADERS);
        res.write(`data: ${JSON.stringify(ROLE_ONLY)}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      sse(res, text('Here.'));
    }
  });
  assert.equal(run.responses[0].result.message.content, 'Here.', '0.5.2 ended the turn with an empty answer');
  assert.equal(run.requests.length, 2);
});

test('no headers within the first-event deadline is a stall: the retry goes to the fallback', async () => {
  const deepseek = timed((res, n) => {
    if (n > 1) {
      sse(res, text('Here.'));
    }
    // The first request gets nothing at all.
  });
  const run = await runAdapter({
    env: { DEEPSEEK_FIRST_EVENT_TIMEOUT_MS: '300', DEEPSEEK_REQUEST_TIMEOUT_MS: '5000', ...FALLBACK },
    reply: deepseek.reply
  });
  assert.equal(run.responses[0].result.stopReason, 'end_turn');
  assert.deepEqual(run.requests.map((request) => request.model), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.ok(deepseek.arrivals[1] - deepseek.arrivals[0] < 1500, 'cut at the 300 ms deadline, not the 5 s request timeout');
});

test('with DEEPSEEK_MAX_RETRIES=0 a stall ends the call, and the next prompt goes to the fallback', async () => {
  const run = await runAdapter({
    prompts: ['hello', 'again'],
    env: { DEEPSEEK_FIRST_EVENT_TIMEOUT_MS: '300', DEEPSEEK_MAX_RETRIES: '0', ...FALLBACK },
    reply: (res, n) => (n === 1 ? hold(res) : sse(res, text('Here.')))
  });
  assert.equal(run.responses[0].result.stopReason, 'error');
  assert.match(run.responses[0].result.message.content, /DEEPSEEK_FIRST_EVENT_TIMEOUT_MS/);
  assert.equal(run.responses[1].result.stopReason, 'end_turn');
  assert.deepEqual(run.requests.map((request) => request.model), ['deepseek-flash', 'deepseek-v4-pro']);
});

test('a cancel while the fallback attempt is held answers cancelled at once', async () => {
  const timing = {};
  const deepseek = timed((res, n) => (n <= 2 ? hold(res) : sse(res, text('Hi.'))));
  const run = await runAdapter({
    prompts: ['hello', 'again'],
    env: { DEEPSEEK_FIRST_EVENT_TIMEOUT_MS: '300', ...FALLBACK },
    reply: deepseek.reply,
    onPrompt: async (index, { send, stdout }) => {
      if (index !== 0) {
        return;
      }
      await waitFor(() => deepseek.arrivals.length === 2, 10000, 'the fallback attempt');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const at = Date.now();
      send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION_ID } });
      await waitFor(() => stdout().includes('"id":1,'), 10000, 'the cancelled turn to answer');
      timing.ms = Date.now() - at;
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'cancelled');
  assert.ok(timing.ms < 500, `answered ${timing.ms} ms after the cancel`);
  assert.equal(run.requests[1].model, 'deepseek-v4-pro');
  assert.ok(!run.requests[2].messages.some((message) => message.content === 'hello'), 'the cancelled turn is rolled back');
});

test('the spans say how each attempt went: keep-alives, the bound that ended it, the time to its first event, the fallback', async () => {
  const run = await runAdapter({
    trace: true,
    prompts: ['hello', 'again'],
    env: { DEEPSEEK_FIRST_EVENT_TIMEOUT_MS: '300', ...FALLBACK },
    reply: (res, n) => (n === 1 ? hold(res) : sse(res, text(`Answer ${n}.`)))
  });
  const llm = run.spans.filter((span) => span.name.startsWith('llm:'));
  assert.deepEqual(
    llm.map((span) => span.name),
    ['llm:deepseek-flash', 'llm:deepseek-v4-pro', 'llm:deepseek-v4-pro'],
    'each span is named after the model that was asked'
  );
  const [held, stalled, cooled] = llm;
  assert.equal(held.status.code, 2, 'the held attempt is an ERROR span');
  assert.equal(held.attributes['deepseek.stream_end'], 'first_event');
  assert.ok(held.attributes['deepseek.keepalives'] >= 1, `${held.attributes['deepseek.keepalives']} keep-alives`);
  assert.equal(held.attributes['deepseek.first_event_ms'], undefined, 'no useful event came');
  assert.equal(held.attributes['deepseek.fallback'], undefined);
  assert.equal(stalled.attributes['deepseek.fallback'], true);
  assert.equal(stalled.attributes['deepseek.fallback_reason'], 'stall');
  assert.equal(stalled.attributes['deepseek.retry'], 1);
  assert.equal(stalled.attributes['deepseek.stream_end'], 'done');
  assert.equal(stalled.attributes['deepseek.keepalives'], 0);
  assert.ok(stalled.attributes['deepseek.first_event_ms'] >= 0);
  assert.equal(cooled.attributes['deepseek.fallback_reason'], 'cooldown');
  assert.equal(cooled.attributes['deepseek.retry'], undefined, 'the next prompt went straight to the fallback');
});

test('a request with no headers by the first-event deadline is recorded as ended by that bound', async () => {
  const run = await runAdapter({
    trace: true,
    env: { DEEPSEEK_FIRST_EVENT_TIMEOUT_MS: '300', DEEPSEEK_REQUEST_TIMEOUT_MS: '5000', ...FALLBACK },
    reply: (res, n) => (n > 1 ? sse(res, text('Here.')) : undefined)
  });
  const [first] = run.spans.filter((span) => span.name.startsWith('llm:'));
  assert.equal(first.attributes['deepseek.stream_end'], 'first_event');
  assert.equal(first.attributes['deepseek.keepalives'], 0);
});
