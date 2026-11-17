import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FirstEventTimeoutError,
  SSEParser,
  StreamAccumulator,
  StreamReadTimeoutError,
  parseSSEStream
} from '../dist/sse-parser.js';

test('SSEParser handles single event and [DONE]', () => {
  const parser = new SSEParser();
  const chunk = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n';
  const events = parser.feed(chunk);

  assert.equal(events.length, 2);
  assert.equal(events[0].done, false);
  assert.equal(events[0].data.choices[0].delta.content, 'Hello');
  assert.equal(events[1].done, true);
});

test('SSEParser handles multi-event buffer and comments', () => {
  const parser = new SSEParser();
  const chunk = ': ping\n\ndata: {"id":"1"}\n\n: comment\ndata: {"id":"2"}\n\n';
  const events = parser.feed(chunk);

  assert.equal(events.length, 2);
  assert.equal(events[0].data.id, '1');
  assert.equal(events[1].data.id, '2');
});

test('SSEParser handles split / partial chunk reconstruction across network frames', () => {
  const parser = new SSEParser();
  const chunk1 = 'data: {"choices":[{"delta":{"reason';
  const chunk2 = 'ing_content":"Thinking..."}}]}\n\n';

  const events1 = parser.feed(chunk1);
  assert.equal(events1.length, 0);

  const events2 = parser.feed(chunk2);
  assert.equal(events2.length, 1);
  assert.equal(events2[0].data.choices[0].delta.reasoning_content, 'Thinking...');
});

test('StreamAccumulator handles 3-phase streaming: reasoning_content, content, and tool_calls', () => {
  const accumulator = new StreamAccumulator();

  // Phase 1: reasoning_content
  const chunk1 = {
    choices: [{
      delta: { reasoning_content: 'Let me think about this.' },
      finish_reason: null
    }]
  };
  const res1 = accumulator.processChunk(chunk1);
  assert.equal(res1.reasoningDelta, 'Let me think about this.');
  assert.equal(accumulator.reasoningContent, 'Let me think about this.');

  // Phase 2: content
  const chunk2 = {
    choices: [{
      delta: { content: 'Here is the answer.' },
      finish_reason: null
    }]
  };
  const res2 = accumulator.processChunk(chunk2);
  assert.equal(res2.contentDelta, 'Here is the answer.');
  assert.equal(accumulator.content, 'Here is the answer.');

  // Phase 3: tool_calls
  const chunk3 = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_abc123',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":' }
        }]
      },
      finish_reason: null
    }]
  };
  accumulator.processChunk(chunk3);

  const chunk4 = {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          function: { arguments: '"foo.txt"}' }
        }]
      },
      finish_reason: 'tool_calls'
    }]
  };
  const res4 = accumulator.processChunk(chunk4);
  assert.equal(res4.finishReason, 'tool_calls');
  assert.equal(accumulator.finishReason, 'tool_calls');

  const validTools = accumulator.getValidToolCalls();
  assert.equal(validTools.length, 1);
  assert.equal(validTools[0].id, 'call_abc123');
  assert.equal(validTools[0].function.name, 'read_file');
  assert.equal(validTools[0].function.arguments, '{"path":"foo.txt"}');
  assert.equal(accumulator.isTruncated(), false);
});

test('StreamAccumulator detects finish_reason length (truncation)', () => {
  const accumulator = new StreamAccumulator();
  accumulator.processChunk({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call_cut',
          function: { name: 'write_file', arguments: '{"content":"partial' }
        }]
      },
      finish_reason: 'length'
    }]
  });

  assert.equal(accumulator.isTruncated(), true);
  assert.equal(accumulator.finishReason, 'length');
});

test('parseSSEStream async generator processes chunks from async iterable', async () => {
  async function* mockStream() {
    yield 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
    yield 'data: {"choices":[{"delta":{"content":" World"},"finish_reason":"stop"}]}\n\n';
    yield 'data: [DONE]\n\n';
  }

  const chunks = [];
  let finalAccumulator = null;

  for await (const event of parseSSEStream(mockStream())) {
    if (event.type === 'delta' && event.contentDelta) {
      chunks.push(event.contentDelta);
    }
    if (event.type === 'done') {
      finalAccumulator = event.accumulator;
    }
  }

  assert.deepEqual(chunks, ['Hello', ' World']);
  assert.equal(finalAccumulator.content, 'Hello World');
  assert.equal(finalAccumulator.finishReason, 'stop');
});

// ---------------------------------------------------------------------------
// Stream bounds: only useful events are progress (issue #6). DeepSeek admits a request it cannot serve yet with
// HTTP 200 and keeps it open with `: keep-alive` comments; every DeepSeek stream opens with a role-only chunk.
// ---------------------------------------------------------------------------

const KEEPALIVE = ': keep-alive\n\n';
const sse = (chunk) => `data: ${JSON.stringify(chunk)}\n\n`;
const ROLE_ONLY = sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
const text = (content, finish = null) => sse({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] });
const reasoning = (piece) => sse({ choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }] });
const newStats = () => ({ keepAlives: 0, firstEventMs: null, usefulEvents: 0, end: null });

/**
 * A response body read one step at a time: `{ delay, text }` gives `text` after `delay` ms (`repeat` times),
 * `{ delay, done: true }` ends the body, and once the steps run out a read never resolves (a silent connection).
 */
function scriptedBody(steps) {
  const queue = steps.flatMap((step) => Array.from({ length: step.repeat ?? 1 }, () => step));
  const reader = {
    read() {
      const step = queue.shift();
      if (!step) {
        return new Promise(() => {});
      }
      return new Promise((resolve) => {
        setTimeout(() => resolve(step.done ? { done: true, value: undefined } : { done: false, value: step.text }), step.delay);
      });
    },
    releaseLock() {}
  };
  return { getReader: () => reader };
}

/** Runs the parser to its end: the events, the error it threw (or null), and how long it took. */
async function drain(body, chunkTimeoutMs, bounds) {
  const started = Date.now();
  const events = [];
  try {
    for await (const event of parseSSEStream(body, chunkTimeoutMs, bounds)) {
      events.push(event);
    }
    return { events, error: null, ms: Date.now() - started };
  } catch (error) {
    return { events, error, ms: Date.now() - started };
  }
}

test('keep-alives only end at the first-event deadline, with what the stream did', async () => {
  const stats = newStats();
  const run = await drain(scriptedBody([{ delay: 20, text: KEEPALIVE, repeat: 1000 }]), 1000, {
    firstEventTimeoutMs: 150,
    stats
  });
  assert.ok(run.error instanceof FirstEventTimeoutError, String(run.error));
  assert.ok(run.ms >= 140 && run.ms < 400, `ended after ${run.ms} ms`);
  assert.match(run.error.message, /150 ms.*DEEPSEEK_FIRST_EVENT_TIMEOUT_MS/);
  assert.equal(stats.end, 'first_event');
  assert.ok(stats.keepAlives >= 5, `${stats.keepAlives} keep-alives`);
  assert.equal(stats.firstEventMs, null);
  assert.equal(stats.usefulEvents, 0);
});

test('keep-alives keep the connection alive but never pass the first-event deadline', async () => {
  // Each keep-alive comes well within the 50 ms silence bound; the 200 ms deadline still ends the wait.
  const run = await drain(scriptedBody([{ delay: 20, text: KEEPALIVE, repeat: 1000 }]), 50, { firstEventTimeoutMs: 200 });
  assert.ok(run.error instanceof FirstEventTimeoutError, String(run.error));
  assert.ok(run.ms >= 190, `ended after ${run.ms} ms, before the deadline`);
});

test('headers then total silence end at the silence bound, not the first-event deadline', async () => {
  // A half-open connection or a stuck gateway: not one byte. 0.5.2 cut it at DEEPSEEK_REQUEST_TIMEOUT_MS; so must this.
  const stats = newStats();
  const run = await drain(scriptedBody([]), 80, { firstEventTimeoutMs: 5000, stats });
  assert.ok(run.error instanceof StreamReadTimeoutError, String(run.error));
  assert.ok(run.ms >= 70 && run.ms < 400, `ended after ${run.ms} ms`);
  assert.equal(stats.end, 'silence');
});

test('a role-only chunk is not progress: keep-alives after it still end at the deadline', async () => {
  const stats = newStats();
  const body = scriptedBody([{ delay: 10, text: ROLE_ONLY }, { delay: 20, text: KEEPALIVE, repeat: 1000 }]);
  const run = await drain(body, 1000, { firstEventTimeoutMs: 150, stats });
  assert.ok(run.error instanceof FirstEventTimeoutError, String(run.error));
  assert.equal(stats.usefulEvents, 0);
});

test('after the first useful event, keep-alives do not hold the stream open', async () => {
  const stats = newStats();
  const body = scriptedBody([{ delay: 10, text: text('Partial') }, { delay: 20, text: KEEPALIVE, repeat: 1000 }]);
  const run = await drain(body, 100, { stats });
  assert.ok(run.error instanceof StreamReadTimeoutError, String(run.error));
  assert.ok(run.ms >= 90 && run.ms < 400, `ended after ${run.ms} ms`);
  assert.equal(stats.end, 'silence');
  assert.notEqual(stats.firstEventMs, null);
  assert.equal(stats.usefulEvents, 1);
});

test('a finish_reason then keep-alives without [DONE]: the answer is taken after the grace', async () => {
  const stats = newStats();
  const body = scriptedBody([{ delay: 10, text: text('Done.', 'stop') }, { delay: 20, text: KEEPALIVE, repeat: 1000 }]);
  const run = await drain(body, 1000, { finishGraceMs: 100, stats });
  assert.equal(run.error, null, String(run.error));
  assert.ok(run.ms < 400, `ended after ${run.ms} ms`);
  const last = run.events.at(-1);
  assert.equal(last.type, 'done');
  assert.equal(last.accumulator.content, 'Done.');
  assert.equal(last.accumulator.finishReason, 'stop');
  assert.equal(stats.end, 'finish_grace');
});

test('the finish chunk DeepSeek sends (empty content, finish_reason, usage) then keep-alives: taken after the grace', async () => {
  // DeepSeek ends every answer with {"delta":{"content":""},"finish_reason":…,"usage":…}: the finish alone is progress.
  const stats = newStats();
  const finish = sse({
    choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
  });
  const body = scriptedBody([
    { delay: 5, text: text('Done.') },
    { delay: 5, text: finish },
    { delay: 20, text: KEEPALIVE, repeat: 1000 }
  ]);
  const run = await drain(body, 1000, { finishGraceMs: 100, stats });
  assert.equal(run.error, null, String(run.error));
  assert.equal(stats.end, 'finish_grace');
  assert.equal(stats.usefulEvents, 2, 'the text and the finish');
  assert.equal(run.events.at(-1).accumulator.usage.total_tokens, 12);
});

test('the first-event deadline counts from sentAt, not from when parsing starts', async () => {
  // The wait for the response headers counts against it: (retries + 1) × D bounds a call.
  const run = await drain(scriptedBody([{ delay: 20, text: KEEPALIVE, repeat: 1000 }]), 5000, {
    sentAt: Date.now() - 1000,
    firstEventTimeoutMs: 1100
  });
  assert.ok(run.error instanceof FirstEventTimeoutError, String(run.error));
  assert.ok(run.ms < 600, `ended ${run.ms} ms into the stream, not 1100`);
});

test('a finish_reason of insufficient_system_resource alone is no progress', async () => {
  const stats = newStats();
  const overloaded = sse({ choices: [{ index: 0, delta: { content: '' }, finish_reason: 'insufficient_system_resource' }] });
  const body = scriptedBody([{ delay: 5, text: ROLE_ONLY }, { delay: 5, text: overloaded }, { delay: 5, text: 'data: [DONE]\n\n' }]);
  const run = await drain(body, 1000, { stats });
  assert.equal(run.error, null, String(run.error));
  assert.equal(stats.usefulEvents, 0);
  assert.equal(run.events.at(-1).accumulator.finishReason, 'insufficient_system_resource');
});

test('a long answer that started before the first-event deadline runs past it', async () => {
  const stats = newStats();
  const body = scriptedBody([
    { delay: 30, text: reasoning('thinking… '), repeat: 14 },
    { delay: 10, text: text('42', 'stop') },
    { delay: 5, text: 'data: [DONE]\n\n' }
  ]);
  const run = await drain(body, 200, { firstEventTimeoutMs: 100, stats });
  assert.equal(run.error, null, String(run.error));
  assert.ok(run.ms > 400, `the answer streamed for ${run.ms} ms, past the 100 ms deadline`);
  assert.equal(stats.end, 'done');
  assert.ok(stats.usefulEvents >= 10, `${stats.usefulEvents} useful events`);
});

test('a role-only chunk then [DONE]: the stream completes with no useful event', async () => {
  const stats = newStats();
  const run = await drain(scriptedBody([{ delay: 5, text: ROLE_ONLY }, { delay: 5, text: 'data: [DONE]\n\n' }]), 1000, {
    stats
  });
  assert.equal(run.error, null, String(run.error));
  assert.equal(stats.usefulEvents, 0);
  assert.equal(stats.end, 'done');
});

test('a body that ends without [DONE] is a server close; the first useful event is timed from sentAt', async () => {
  const stats = newStats();
  const sentAt = Date.now() - 1000;
  const run = await drain(scriptedBody([{ delay: 5, text: text('Hi', 'stop') }, { delay: 5, done: true }]), 1000, {
    sentAt,
    stats
  });
  assert.equal(run.error, null, String(run.error));
  assert.equal(stats.end, 'server_close');
  assert.ok(stats.firstEventMs >= 1000, `first event after ${stats.firstEventMs} ms`);
});

test('an async-iterable body gets the same bounds', async () => {
  async function* keepAlivesForever() {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield KEEPALIVE;
    }
  }
  const run = await drain(keepAlivesForever(), 1000, { firstEventTimeoutMs: 150 });
  assert.ok(run.error instanceof FirstEventTimeoutError, String(run.error));
  assert.ok(run.ms < 400, `ended after ${run.ms} ms`);
});
