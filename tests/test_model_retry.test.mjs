/**
 * End-to-end: one failed model call no longer ends the turn. A meeting twin's whole call is one ACP turn of hundreds of
 * model calls; any one of them failing (HTTP 429/5xx, a reset connection, a timeout) used to roll the whole call back
 * and answer stopReason `error`, which buzz-acp answers by respawning the adapter: the twin left the call and lost its
 * context. A call that fails before any of its text reached the client is now sent again, up to DEEPSEEK_MAX_RETRIES
 * times, and DEEPSEEK_REQUEST_TIMEOUT_MS bounds the wait for the response and each silence in its stream, not the
 * whole stream.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelEmptyStreamError,
  ModelHttpError,
  ModelTimeoutError,
  isRetryableModelError,
  isRetryableStatus,
  isStall,
  retryDelayMs
} from '../dist/model-retry.js';
import { FirstEventTimeoutError, StreamReadTimeoutError } from '../dist/sse-parser.js';
import { runAdapter, sse, text, toolCalls, waitFor, SESSION_ID } from './helpers/acp.mjs';

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };

/** An API error as DeepSeek writes it: 429 rate limit, 500 server error, 503 overloaded. */
function apiError(res, status) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `HTTP ${status} from the mock`, type: 'server_error' } }));
}

/** Answers `content` in small pieces `gapMs` apart, after `keepAlives` SSE keep-alive comments as far apart. */
function drip(res, content, gapMs, keepAlives = 0) {
  res.writeHead(200, SSE_HEADERS);
  const writes = [
    ...Array.from({ length: keepAlives }, () => ': keep-alive\n\n'),
    ...content.match(/.{1,3}/g).map((piece) => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n'
  ];
  let at = 0;
  const next = () => {
    if (res.destroyed) {
      return;
    }
    res.write(writes[at++]);
    if (at < writes.length) {
      setTimeout(next, gapMs);
    } else {
      res.end();
    }
  };
  next();
}

const wait = (n) => toolCalls([{ id: `call_${n}`, name: 'meeting_wait', args: '{}' }]);

test('a model call answered 503 is sent again, and the turn ends with the answer instead of error', async () => {
  const run = await runAdapter({
    trace: true,
    reply: (res, n) => (n === 1 ? apiError(res, 503) : sse(res, text('Hi.')))
  });
  assert.equal(run.responses[0].result.stopReason, 'end_turn', 'not `error`: buzz-acp would respawn the adapter');
  assert.equal(run.responses[0].result.message.content, 'Hi.');
  assert.equal(run.requests.length, 2);
  assert.deepEqual(run.requests[1].messages, run.requests[0].messages, 'the retry sends exactly what the failed call sent');
  assert.match(run.stderr, /\[RETRY\] .*HTTP 503/);
  const llm = run.spans.filter((span) => span.name === 'llm:deepseek-flash');
  assert.deepEqual(
    llm.map((span) => [span.attributes['llm.iteration'], span.status.code]),
    [[1, 2], [1, 1]],
    'the failed attempt is an ERROR span of its own; the retry is the OK one'
  );
  assert.match(llm[0].status.message, /HTTP 503/);
  assert.equal(llm[0].attributes['deepseek.retry'], undefined);
  assert.equal(llm[1].attributes['deepseek.retry'], 1, 'Phoenix tells a retry from a first attempt');
});

test('a 429, then a connection reset before any byte, are both sent again', async () => {
  const run = await runAdapter({
    reply: (res, n, body) => {
      if (n === 1) {
        return apiError(res, 429);
      }
      if (n === 2) {
        return res.socket.destroy();
      }
      return sse(res, text(`Answered after ${body.messages.length} messages.`));
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'end_turn');
  assert.equal(run.requests.length, 3);
});

test('a retry never runs tool calls again: the call after a tool call fails once, the tool ran once', async () => {
  const run = await runAdapter({
    reply: (res, n) => (n === 1 ? sse(res, wait(1)) : n === 2 ? apiError(res, 500) : sse(res, text('Done.')))
  });
  assert.equal(run.responses[0].result.stopReason, 'end_turn');
  assert.deepEqual(run.calls, ['meeting_wait'], 'the tool ran once');
  assert.deepEqual(run.requests[2].messages, run.requests[1].messages, 'nothing was added twice');
  const roles = run.requests[2].messages.map((message) => message.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool']);
});

test('a request that never answers is sent again after DEEPSEEK_REQUEST_TIMEOUT_MS', async () => {
  const run = await runAdapter({
    env: { DEEPSEEK_REQUEST_TIMEOUT_MS: '400' },
    reply: (res, n) => {
      if (n > 1) {
        sse(res, text('Here.'));
      }
      // The first request gets nothing at all, not even headers.
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'end_turn');
  assert.equal(run.requests.length, 2);
  assert.match(run.stderr, /\[RETRY\] .*timeout/i);
});

test('DEEPSEEK_REQUEST_TIMEOUT_MS bounds each silence of the stream, not the whole stream', async () => {
  // DeepSeek holds a busy request open with keep-alive comments, then streams: 2.5 s in all, every chunk 100 ms apart.
  const answer = 'A long answer that streams in many small pieces.';
  const run = await runAdapter({
    env: { DEEPSEEK_REQUEST_TIMEOUT_MS: '500', DEEPSEEK_MAX_RETRIES: '0' },
    reply: (res) => drip(res, answer, 100, 6)
  });
  assert.equal(run.responses[0].result.stopReason, 'end_turn', 'v0.5.1 cut the stream at 500 ms: error');
  assert.equal(run.responses[0].result.message.content, answer);
  assert.equal(run.requests.length, 1);
});

test('silence after text reached the client still fails the call, and it is not sent again', async () => {
  const run = await runAdapter({
    env: { DEEPSEEK_REQUEST_TIMEOUT_MS: '400' },
    reply: (res) => {
      res.writeHead(200, SSE_HEADERS);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Partial ans' } }] })}\n\n`);
      // …and nothing more.
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'error');
  assert.equal(run.requests.length, 1, 'the client already has "Partial ans": a retry would send it twice');
});

test('a 400 is not sent again: the request itself is wrong', async () => {
  const run = await runAdapter({ reply: (res) => apiError(res, 400) });
  assert.equal(run.responses[0].result.stopReason, 'error');
  assert.equal(run.requests.length, 1);
  assert.doesNotMatch(run.stderr, /\[RETRY\]/);
});

test('after DEEPSEEK_MAX_RETRIES retries the turn fails as before; 0 turns retries off', async () => {
  for (const [setting, attempts] of [['1', 2], ['0', 1]]) {
    const run = await runAdapter({ env: { DEEPSEEK_MAX_RETRIES: setting }, reply: (res) => apiError(res, 503) });
    assert.equal(run.responses[0].result.stopReason, 'error', `DEEPSEEK_MAX_RETRIES=${setting}`);
    assert.equal(run.requests.length, attempts, `DEEPSEEK_MAX_RETRIES=${setting}`);
  }
});

test('a cancel during the wait before a retry answers cancelled at once, and nothing is sent again', async () => {
  let failed = false;
  const timing = {};
  const run = await runAdapter({
    prompts: ['hello', 'again'],
    reply: (res, n) => {
      if (n === 1) {
        failed = true;
        return apiError(res, 503);
      }
      return sse(res, text('Hi.'));
    },
    onPrompt: async (index, { send, stdout }) => {
      if (index !== 0) {
        return;
      }
      await waitFor(() => failed, 10000, 'the first call to fail');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const at = Date.now();
      send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION_ID } });
      await waitFor(() => stdout().includes('"id":1,'), 10000, 'the cancelled turn to answer');
      timing.ms = Date.now() - at;
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'cancelled');
  assert.ok(timing.ms < 500, `answered ${timing.ms} ms after the cancel`);
  assert.equal(run.requests.length, 2, 'the failed call was not sent again; the second request is the next prompt');
  assert.ok(!run.requests[1].messages.some((m) => m.content === 'hello'), 'the cancelled turn is rolled back');
});

test('an error response whose body never ends: the timeout cuts it, and its status decides the retry', async () => {
  const hanging = (status) => (res, n) => {
    if (n === 1) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.write('{"error":');
      return;
    }
    sse(res, text('ok'));
  };
  const busy = await runAdapter({ env: { DEEPSEEK_REQUEST_TIMEOUT_MS: '400' }, reply: hanging(503) });
  assert.equal(busy.responses[0].result.stopReason, 'end_turn');
  assert.equal(busy.requests.length, 2);
  assert.match(busy.stderr, /\[RETRY\] .*HTTP 503.*did not arrive.*timeout/);
  const refused = await runAdapter({ env: { DEEPSEEK_REQUEST_TIMEOUT_MS: '400' }, reply: hanging(400) });
  assert.equal(refused.responses[0].result.stopReason, 'error');
  assert.equal(refused.requests.length, 1, 'a 400 is not sent again, even when its body never came');
  assert.match(refused.responses[0].result.message.content, /HTTP 400/);
});

test('a response that ends before any data is sent again, never taken as an empty answer', async () => {
  // DeepSeek holds a request it cannot serve yet with keep-alive comments, and closes it if inference has not started
  // within 10 minutes.
  const closedAfterKeepAlives = (res) => {
    res.writeHead(200, SSE_HEADERS);
    res.write(': keep-alive\n\n');
    res.end();
  };
  const run = await runAdapter({ reply: (res, n) => (n === 1 ? closedAfterKeepAlives(res) : sse(res, text('Here.'))) });
  assert.equal(run.responses[0].result.stopReason, 'end_turn');
  assert.equal(run.responses[0].result.message.content, 'Here.');
  assert.equal(run.requests.length, 2);
  const once = await runAdapter({ env: { DEEPSEEK_MAX_RETRIES: '0' }, reply: closedAfterKeepAlives });
  assert.equal(once.responses[0].result.stopReason, 'error', 'v0.5.1 ended the turn end_turn, with an empty answer');
  assert.match(once.responses[0].result.message.content, /ended before any data/);
});

test('a finished call leaves its connection to the next one: one connection for a whole turn', async () => {
  // The body's last bytes come a moment after [DONE], as over a real network.
  const finishLate = (res, chunks) => {
    res.writeHead(200, SSE_HEADERS);
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    setTimeout(() => res.end(), 30);
  };
  const run = await runAdapter({
    env: { MOCK_MCP_SLOW_TOOLS: 'meeting_wait:150' },
    reply: (res, n) => finishLate(res, n <= 3 ? wait(n) : text('Done.'))
  });
  assert.equal(run.responses[0].result.stopReason, 'end_turn');
  assert.equal(run.requests.length, 4);
  assert.equal(run.connections, 1, 'every call reused the connection of the call before it');
});

test('a cancel while the call waits for its response answers cancelled at once, and nothing is sent again', async () => {
  let arrived = false;
  const timing = {};
  const run = await runAdapter({
    prompts: ['hello', 'again'],
    reply: (res, n) => {
      if (n === 1) {
        arrived = true;
        return;
      }
      sse(res, text('Hi.'));
    },
    onPrompt: async (index, { send, stdout }) => {
      if (index !== 0) {
        return;
      }
      await waitFor(() => arrived, 10000, 'the first request');
      const at = Date.now();
      send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: SESSION_ID } });
      await waitFor(() => stdout().includes('"id":1,'), 10000, 'the cancelled turn to answer');
      timing.ms = Date.now() - at;
    }
  });
  assert.equal(run.responses[0].result.stopReason, 'cancelled');
  assert.ok(timing.ms < 500, `answered ${timing.ms} ms after the cancel`);
  assert.equal(run.requests.length, 2, 'the second request is the next prompt');
});

test('a steer that arrives while a failed call waits for its retry is answered in this turn', async () => {
  let failed = false;
  const run = await runAdapter({
    reply: (res, n) => {
      if (n === 1) {
        failed = true;
        return apiError(res, 503);
      }
      return sse(res, text(n === 2 ? 'First answer.' : 'Answer to the steer.'));
    },
    onPrompt: async (index, { send, stdout }) => {
      await waitFor(() => failed, 10000, 'the first call to fail');
      send({ jsonrpc: '2.0', id: 9, method: '_session/steering', params: { sessionId: SESSION_ID, prompt: 'One more thing' } });
      await waitFor(() => stdout().includes('"id":9,'), 10000, 'the steer to be answered');
    }
  });
  assert.equal(run.requests.length, 3);
  assert.deepEqual(run.requests[1].messages, run.requests[0].messages, 'the retry sends what the failed call sent');
  assert.match(run.requests[2].messages.at(-1).content, /One more thing/);
  assert.equal(run.responses[0].result.message.content, 'Answer to the steer.');
});

// ---------------------------------------------------------------------------
// The pure rules (src/model-retry.ts)
// ---------------------------------------------------------------------------

test('isRetryableStatus: 408, 429 and 5xx may pass; 400, 401, 402, 404 and 422 will fail the same way again', () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableStatus(status), true, String(status));
  }
  for (const status of [400, 401, 402, 403, 404, 422, 200, 600]) {
    assert.equal(isRetryableStatus(status), false, String(status));
  }
});

test('isRetryableModelError: a retryable status, no response in time, a silent stream or a lost connection', () => {
  assert.equal(isRetryableModelError(new ModelHttpError(503, 'overloaded')), true);
  assert.equal(isRetryableModelError(new ModelHttpError(400, 'bad request')), false);
  assert.equal(isRetryableModelError(new ModelTimeoutError(90000)), true);
  assert.match(new ModelTimeoutError(400).message, /timeout.*400 ms.*DEEPSEEK_REQUEST_TIMEOUT_MS/);
  assert.equal(isRetryableModelError(new StreamReadTimeoutError(90000)), true);
  // undici's fetch: a reset before the response, and a body cut short.
  assert.equal(isRetryableModelError(new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } })), true);
  assert.equal(isRetryableModelError(new TypeError('terminated')), true);
  assert.equal(isRetryableModelError(new TypeError('x is not a function')), false, 'a bug is not a network error');
  assert.equal(isRetryableModelError(new Error('DEEPSEEK_API_KEY is missing or empty.')), false);
  assert.equal(isRetryableModelError(new DOMException('This operation was aborted', 'AbortError')), false, 'a cancel');
});

test('retryDelayMs: 1 s, then twice as long each time', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(retryDelayMs), [1000, 2000, 4000, 8000, 16000]);
});

test('isStall: the model never started (no useful event in time, or a stream that ended without one)', () => {
  assert.equal(isStall(new FirstEventTimeoutError(300000, 287)), true);
  assert.equal(isStall(new ModelEmptyStreamError()), true);
  for (const other of [
    new ModelTimeoutError(90000),
    new StreamReadTimeoutError(90000),
    new ModelHttpError(503, 'overloaded'),
    new TypeError('fetch failed')
  ]) {
    assert.equal(isStall(other), false, other.message);
  }
  assert.equal(isRetryableModelError(new FirstEventTimeoutError(300000, 0)), true, 'a stall may pass: it is sent again');
  assert.match(new ModelEmptyStreamError().message, /ended before any data.*finish_reason/);
});
