import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  initTelemetry,
  registerSecret,
  redactSecrets,
  truncatePayload,
  computeOutputBytes,
  parseNostrContext,
  extractPostedEventId,
  _resetProcessSecretsCache
} from '../dist/telemetry.js';
import { StreamAccumulator } from '../dist/sse-parser.js';

test('Secret Redaction: redacts registered secrets and common token patterns while preserving English words', () => {
  _resetProcessSecretsCache();

  // Test registerSecret with explicit key
  const mockApiKey = 'sk-1234567890abcdef1234567890abcdef12';
  registerSecret(mockApiKey);

  const sensitiveSample = `Here is my key: ${mockApiKey} and nostr: nsec1vl029mgpspedva04g90vltkh6fvh240eqtv9xx0q2kn798chje9s52hv75 and gitlab: glpat-abcdef1234567890_xyz and github: ghp_123456789012345678901234567890123456`;
  const redacted = redactSecrets(sensitiveSample);

  assert.ok(!redacted.includes(mockApiKey), 'Must not contain raw API key');
  assert.ok(!redacted.includes('nsec1vl029mgpspedva04g90vltkh6fvh240eqtv9xx0q2kn798chje9s52hv75'), 'Must not contain nsec1 key');
  assert.ok(!redacted.includes('glpat-abcdef1234567890_xyz'), 'Must not contain GitLab token');
  assert.ok(!redacted.includes('ghp_123456789012345678901234567890123456'), 'Must not contain GitHub token');
  assert.ok(redacted.includes('[REDACTED]'), 'Must contain [REDACTED] replacement');

  // Verify normal English words containing 's' and 'k' are NOT corrupted (P0 Adversarial Check)
  const englishSample = 'Please ask the agent to complete the task with minimal risk to the sky.';
  const englishRedacted = redactSecrets(englishSample);
  assert.equal(englishRedacted, englishSample, 'Normal English text with s and k must remain completely untouched');
});

test('Secret Redaction: Base64 secret variant is also redacted', () => {
  _resetProcessSecretsCache();
  const rawSecret = 'supersecret_token_12345';
  registerSecret(rawSecret);

  const b64 = Buffer.from(rawSecret).toString('base64');
  const textWithB64 = `Authorization: Basic ${b64}`;
  const redacted = redactSecrets(textWithB64);

  assert.ok(!redacted.includes(b64), 'Base64 encoded secret must be redacted');
  assert.ok(redacted.includes('[REDACTED]'));
});

// The 0.3.0 patterns, copied verbatim: redactSecrets must keep giving exactly their result.
const PATTERNS_0_3_0 = [
  /nsec1[0-9a-z]{58}/gi,
  /sk-[a-zA-Z0-9_\-.]{20,64}/g,
  /sk-ant-[a-zA-Z0-9_.-]+/g,
  /\bgl(pat|rt|dt|ptt|cbt|oas)-[0-9a-zA-Z_-]+/g,
  /\bgh[pousr]_[0-9a-zA-Z]{36}\b/g,
  /ya29\.[0-9a-zA-Z_-]+/g,
  /1\/\/[0-9a-zA-Z_-]+/g,
  /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+/g
];

function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('Secret Redaction: redactSecrets redacts exactly what the 0.3.0 patterns redacted (JWT-like text, 20,000 cases)', () => {
  _resetProcessSecretsCache();
  const pieces = [
    'eyJ', 'eyJabcdefghij', 'eyJ0123456789_-', 'abcdefghijk', '-', '_', '.', 'x', ' ', '"', '=', 'é',
    'eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    'eyJ-', '.eyJ', 'sk-', 'sk-ant-', 'Bearer ', 'glpat-', 'ya29.'
  ];
  const random = mulberry32(64);
  let redactedCases = 0;
  for (let n = 0; n < 20000; n++) {
    let text = '';
    const count = 1 + Math.floor(random() * 14);
    for (let i = 0; i < count; i++) {
      text += pieces[Math.floor(random() * pieces.length)];
    }
    const expected = PATTERNS_0_3_0.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), text);
    if (expected !== text) {
      redactedCases++;
    }
    assert.equal(redactSecrets(text), expected, JSON.stringify(text));
  }
  assert.ok(redactedCases > 1000, `the cases must exercise the patterns (only ${redactedCases} redacted)`);
});

test('Secret Redaction: a long run of eyJ-eyJ-… is redacted in linear time (0.3.0 took ~0.2 s for 32 KB)', () => {
  _resetProcessSecretsCache();
  const run = 'eyJ-'.repeat(8192);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const started = process.hrtime.bigint();
  const redacted = redactSecrets(`${run.slice(0, 32000)} ${jwt}`);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 100, `redacting 32 KB took ${elapsedMs.toFixed(1)} ms`);
  assert.ok(redacted.endsWith(' [REDACTED]'), 'the token after the run is still redacted');
});

test('Secret Redaction: the meeting and mail gate tokens in the environment are redacted', () => {
  const saved = { meeting: process.env.MEETING_GATE_TOKEN, mail: process.env.MAIL_GATE_TOKEN };
  process.env.MEETING_GATE_TOKEN = 'mgt-0f3c9a7e5d2b4c6a8e1f';
  process.env.MAIL_GATE_TOKEN = 'mlt-7d1e3b5a9c2f4e6d8a0b';
  try {
    _resetProcessSecretsCache();
    const redacted = redactSecrets('gate said: Bearer mgt-0f3c9a7e5d2b4c6a8e1f and mail mlt-7d1e3b5a9c2f4e6d8a0b');
    assert.ok(!redacted.includes('mgt-0f3c9a7e5d2b4c6a8e1f'), redacted);
    assert.ok(!redacted.includes('mlt-7d1e3b5a9c2f4e6d8a0b'), redacted);
  } finally {
    for (const [name, value] of [['MEETING_GATE_TOKEN', saved.meeting], ['MAIL_GATE_TOKEN', saved.mail]]) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    _resetProcessSecretsCache();
  }
});

test('truncatePayload: truncates long text cleanly', () => {
  const shortText = 'Hello World';
  assert.equal(truncatePayload(shortText, 50), 'Hello World');

  const longText = 'a'.repeat(100);
  const truncated = truncatePayload(longText, 20);
  assert.equal(truncated.length, 20 + '... [TRUNCATED]'.length);
  assert.ok(truncated.endsWith('... [TRUNCATED]'));
});

test('computeOutputBytes: computes correct byte lengths across string, object, array and buffer', () => {
  assert.equal(computeOutputBytes(null), 0);
  assert.equal(computeOutputBytes(undefined), 0);
  assert.equal(computeOutputBytes('hello'), 5);
  assert.equal(computeOutputBytes(Buffer.from('hello world')), 11);
  assert.equal(computeOutputBytes({ ok: true }), Buffer.byteLength(JSON.stringify({ ok: true })));
  assert.equal(computeOutputBytes(['a', 'b']), Buffer.byteLength(JSON.stringify(['a', 'b'])));
});

test('parseNostrContext: correctly parses thread root, event id, channel, sender and isolates active envelope', () => {
  const sample = `[Nostr context:
Thread root: 38e3b2faf1bf7376a02d1c18c77c2cae9207d2f4a682ddad3a43ee1d15e12c53
Event ID: f0ae0c8b5dc1f5e0b22275c362dceacbc72a71dc91b7f699899343162bbbb1a6
Channel: brainstorm (#c06880bc-9779-4615-85f0-b74d61cbdd03)
From: Kent (npub: npub1kent..., hex: 214f9e60aab5b373d2d7c429045ea72639af0bf396b8e7ed6f791acb574b3e15)
parent=212193a2b1bf7376a02d1c18c77c2cae9207d2f4a682ddad3a43ee1d15e12c53
]
Please write a report on OpenTelemetry tracing.`;

  const meta = parseNostrContext(sample);
  assert.equal(meta.threadRootId, '38e3b2faf1bf7376a02d1c18c77c2cae9207d2f4a682ddad3a43ee1d15e12c53');
  assert.equal(meta.eventId, 'f0ae0c8b5dc1f5e0b22275c362dceacbc72a71dc91b7f699899343162bbbb1a6');
  assert.equal(meta.channelId, 'c06880bc-9779-4615-85f0-b74d61cbdd03');
  assert.equal(meta.channelName, 'brainstorm');
  assert.equal(meta.replyToId, '212193a2b1bf7376a02d1c18c77c2cae9207d2f4a682ddad3a43ee1d15e12c53');
  assert.equal(meta.senderName, 'Kent');
  assert.equal(meta.senderPubkey, '214f9e60aab5b373d2d7c429045ea72639af0bf396b8e7ed6f791acb574b3e15');
});

test('parseNostrContext: steered multi-event batch isolates active message using lastIndexOf', () => {
  const steeredBatch = `[Old message:
Thread root: 1111111111111111111111111111111111111111111111111111111111111111
Event ID: 2222222222222222222222222222222222222222222222222222222222222222
Channel: general (#11111111-2222-3333-4444-555555555555)
From: OldUser (hex: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
]
Some old question.

[Steered message:
Thread root: 3333333333333333333333333333333333333333333333333333333333333333
Event ID: 4444444444444444444444444444444444444444444444444444444444444444
Channel: brainstorm (#c06880bc-9779-4615-85f0-b74d61cbdd03)
From: NewUser (hex: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)
parent=2222222222222222222222222222222222222222222222222222222222222222
]
Active steered question.`;

  const meta = parseNostrContext(steeredBatch);
  assert.equal(meta.eventId, '4444444444444444444444444444444444444444444444444444444444444444');
  assert.equal(meta.threadRootId, '3333333333333333333333333333333333333333333333333333333333333333');
  assert.equal(meta.replyToId, '2222222222222222222222222222222222222222222222222222222222222222');
  assert.equal(meta.senderName, 'NewUser');
});

test('parseNostrContext: non-string inputs (array, object, null, undefined) safely return empty object', () => {
  assert.deepEqual(parseNostrContext(null), {});
  assert.deepEqual(parseNostrContext(undefined), {});
  assert.deepEqual(parseNostrContext([{ type: 'text', text: 'Event ID: 1234' }]), {});
  assert.deepEqual(parseNostrContext(12345), {});
});

test('extractPostedEventId: extracts 64-hex ID across reply, shell json, and assignment formats', () => {
  // 1. buzz-thread reply format (space-separated)
  const replyOutput = 'posted (128 characters) · event_id 40738780fa35899d341c45daeda99e609aff92c6d3cb44c54e06e7290e7bb38b';
  assert.equal(extractPostedEventId(replyOutput), '40738780fa35899d341c45daeda99e609aff92c6d3cb44c54e06e7290e7bb38b');

  // 2. shell output running `buzz messages send` (raw JSON)
  const shellJsonOutput = '{"accepted":true,"event_id":"5c428ab9b6b608a6214d61412d099613bc8ce200d3afecd91a4523754cdc6142","mention_pubkeys":[]}';
  assert.equal(extractPostedEventId(shellJsonOutput), '5c428ab9b6b608a6214d61412d099613bc8ce200d3afecd91a4523754cdc6142');

  // 3. Object representation
  const objOutput = {
    accepted: true,
    event_id: '5c428ab9b6b608a6214d61412d099613bc8ce200d3afecd91a4523754cdc6142'
  };
  assert.equal(extractPostedEventId(objOutput), '5c428ab9b6b608a6214d61412d099613bc8ce200d3afecd91a4523754cdc6142');

  // 4. Colon separated
  assert.equal(
    extractPostedEventId('event_id: aabbccdd00112233445566778899aabbccdd00112233445566778899aabbccdd'),
    'aabbccdd00112233445566778899aabbccdd00112233445566778899aabbccdd'
  );

  // 5. Equal separated
  assert.equal(
    extractPostedEventId('event_id="aabbccdd00112233445566778899aabbccdd00112233445566778899aabbccdd"'),
    'aabbccdd00112233445566778899aabbccdd00112233445566778899aabbccdd'
  );

  // 6. MCP tool output containing escaped JSON string in stdout
  const mcpWrappedOutput = '{"duration_ms":1852,"exit_code":0,"stdout":"{\\"accepted\\":true,\\"event_id\\":\\"43b6866230ea40328fb176a24978a6417a793f5c01182b6437bc5dc6059e1e6c\\"}\\n"}';
  assert.equal(
    extractPostedEventId(mcpWrappedOutput),
    '43b6866230ea40328fb176a24978a6417a793f5c01182b6437bc5dc6059e1e6c'
  );

  // 7. MCP parsed object containing stdout with JSON
  const mcpObjOutput = {
    duration_ms: 1852,
    exit_code: 0,
    stdout: '{"accepted":true,"event_id":"43b6866230ea40328fb176a24978a6417a793f5c01182b6437bc5dc6059e1e6c"}'
  };
  assert.equal(
    extractPostedEventId(mcpObjOutput),
    '43b6866230ea40328fb176a24978a6417a793f5c01182b6437bc5dc6059e1e6c'
  );

  // 8. Invalid / absent
  const failedReply = 'error: unable to publish event';
  assert.equal(extractPostedEventId(failedReply), undefined);
  assert.equal(extractPostedEventId('event_id: invalid_hex'), undefined);
});

test('StreamAccumulator: captures usage metrics even when choices array is empty', () => {
  const acc = new StreamAccumulator();

  // Standard delta with content
  acc.processChunk({
    choices: [
      {
        index: 0,
        delta: { content: 'Hello ' }
      }
    ]
  });

  // Final chunk with empty choices but full usage metrics
  acc.processChunk({
    choices: [],
    usage: {
      prompt_tokens: 150,
      completion_tokens: 42,
      total_tokens: 192,
      prompt_cache_hit_tokens: 64,
      completion_tokens_details: {
        reasoning_tokens: 20
      }
    }
  });

  assert.equal(acc.content, 'Hello ');
  assert.ok(acc.usage !== null, 'Usage must not be null');
  assert.equal(acc.usage.prompt_tokens, 150);
  assert.equal(acc.usage.completion_tokens, 42);
  assert.equal(acc.usage.total_tokens, 192);
  assert.equal(acc.usage.prompt_cache_hit_tokens, 64);
  assert.equal(acc.usage.completion_tokens_details?.reasoning_tokens, 20);
});

test('Fail-open: initTelemetry returns null if OTel endpoint is not configured', () => {
  const origEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const origFallback = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  try {
    const service = initTelemetry();
    assert.equal(service, null, 'Must return null when OTel endpoint is omitted');
  } finally {
    if (origEndpoint) {
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = origEndpoint;
    }
    if (origFallback) {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = origFallback;
    }
  }
});

test('End-to-End Tracing: ACP agent emits OTLP traces to mock Phoenix collector and preserves stdout hygiene', async () => {
  const traceRequests = [];

  // 1. Mock Phoenix OTLP HTTP receiver
  const mockPhoenix = http.createServer((req, res) => {
    let body = Buffer.alloc(0);
    req.on('data', chunk => {
      body = Buffer.concat([body, chunk]);
    });
    req.on('end', () => {
      traceRequests.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        bodyLength: body.length
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise(resolve => mockPhoenix.listen(0, '127.0.0.1', resolve));
  const phoenixPort = mockPhoenix.address().port;
  const phoenixUrl = `http://127.0.0.1:${phoenixPort}/v1/traces`;

  // 2. Mock DeepSeek API server
  const mockDeepSeek = http.createServer((req, res) => {
    if (req.url === '/chat/completions') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write('data: {"choices":[{"delta":{"content":"Tracing verified."}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise(resolve => mockDeepSeek.listen(0, '127.0.0.1', resolve));
  const deepseekPort = mockDeepSeek.address().port;

  // 3. Spawn deepseek-agent-acp child process with telemetry enabled
  const child = spawn('node', ['dist/index.js'], {
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'sk-test-key-for-telemetry-verification-12345678',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${deepseekPort}`,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: phoenixUrl,
      OTEL_SERVICE_NAME: 'test-deepseek-agent',
      PHOENIX_PROJECT_NAME: 'ba'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let rawStdout = '';
  child.stdout.on('data', chunk => {
    rawStdout += chunk.toString();
  });

  const send = obj => {
    child.stdin.write(JSON.stringify(obj) + '\n');
  };

  // Run ACP exchange
  send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { sessionId: 'test-otel-session' } });
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: {
      sessionId: 'test-otel-session',
      prompt: '[Nostr context:\nThread root: aa11bb22cc33dd44aa11bb22cc33dd44aa11bb22cc33dd44aa11bb22cc33dd44\nEvent ID: bb22cc33dd44aa11bb22cc33dd44aa11bb22cc33dd44aa11bb22cc33dd44aa11\nChannel: brainstorm (#a04c7b7e-b2d3-4881-b870-dd14b1e1c206)\nFrom: TestUser (hex: cc33dd44aa11bb22cc33dd44aa11bb22cc33dd44aa11bb22cc33dd44aa11bb22)\n]\nHello from testing.'
    }
  });

  // Await response to prompt id 3
  await new Promise(resolve => {
    const interval = setInterval(() => {
      const lines = rawStdout.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 3) {
            clearInterval(interval);
            resolve();
          }
        } catch {
          // Keep waiting
        }
      }
    }, 100);
  });

  // Close stdin to trigger graceful shutdown and trace flush
  child.stdin.end();

  await new Promise(resolve => child.on('close', resolve));
  await new Promise(resolve => mockPhoenix.close(resolve));
  await new Promise(resolve => mockDeepSeek.close(resolve));

  // 4. Assertions on Stdio Hygiene
  const lines = rawStdout.trim().split('\n');
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `Every line on stdout must be valid JSON-RPC! Found invalid line: ${line}`);
  }

  // 5. Assertions on OTLP Trace Delivery
  assert.ok(traceRequests.length > 0, 'Mock Phoenix receiver must have received at least one trace export request');
  const traceReq = traceRequests[0];
  assert.equal(traceReq.url, '/v1/traces');
  assert.equal(traceReq.headers['x-project-name'], 'ba');
  assert.ok(traceReq.bodyLength > 0, 'Protobuf trace payload must be non-empty');
});
