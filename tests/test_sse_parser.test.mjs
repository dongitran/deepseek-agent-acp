import test from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser, StreamAccumulator, parseSSEStream } from '../dist/sse-parser.js';

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
