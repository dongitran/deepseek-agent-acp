import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.resolve(__dirname, '../dist/index.js');
const NODE_MODULES_PATH = path.resolve(__dirname, '../node_modules');

function spawnAdapter(env = {}) {
  const child = spawn(process.execPath, [INDEX_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_PATH: NODE_MODULES_PATH,
      DEEPSEEK_API_KEY: 'sk-test-mock-key-12345678901234567890',
      DEEPSEEK_MODEL: 'deepseek-chat',
      ...env
    }
  });

  const responses = [];
  const notifications = [];
  let buffer = '';
  let stderrText = '';

  child.stderr.on('data', (chunk) => {
    stderrText += chunk.toString();
  });

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) {
        continue;
      }
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && msg.id !== null) {
          responses.push(msg);
        } else if (msg.method) {
          notifications.push(msg);
        }
      } catch (_) {}
    }
  });

  const send = (obj) => {
    child.stdin.write(JSON.stringify(obj) + '\n');
  };

  const waitResponse = (id, timeoutMs = 5000) => {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        const found = responses.find((r) => r.id === id);
        if (found) {
          clearInterval(interval);
          resolve(found);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          reject(new Error(`Timeout waiting for response id ${id}`));
        }
      }, 20);
    });
  };

  return { child, send, waitResponse, responses, notifications, getStderr: () => stderrText };
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive'
};

/**
 * Starts a mock /chat/completions endpoint that records every parsed request body.
 * `onRequest(body, res, callNumber)` writes the reply.
 */
async function startMockCompletions(onRequest) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.url !== '/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      onRequest(body, res, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function replyText(res, text) {
  res.writeHead(200, SSE_HEADERS);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

/** A tool call whose arguments are not JSON; every call n yields a different error text (no circuit breaker). */
function replyUnparsableToolCall(res, n) {
  res.writeHead(200, SSE_HEADERS);
  const delta = {
    tool_calls: [{ index: 0, id: `call_${n}`, type: 'function', function: { name: 'bad_tool', arguments: `BAD_${n}` } }]
  };
  res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}

async function promptOnce(adapter, id, text = 'hello') {
  adapter.send({
    jsonrpc: '2.0',
    id,
    method: 'session/prompt',
    params: { sessionId: `sess-${id}`, prompt: text }
  });
  return adapter.waitResponse(id, 5000);
}

test('ACP initialize returns protocolVersion 1 and capabilities', async () => {
  const { child, send, waitResponse } = spawnAdapter();
  try {
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } });
    const res = await waitResponse(1);

    assert.equal(res.id, 1);
    assert.equal(res.result.protocolVersion, 1);
    assert.equal(res.result.agentInfo.name, 'deepseek-agent-acp');
    assert.equal(res.result.capabilities.streaming, true);
    assert.equal(res.result.capabilities.tools, true);
    assert.equal(res.result._meta?.steering?.supported, true);
  } finally {
    child.kill();
  }
});

test('ACP session/new initializes a session', async () => {
  const { child, send, waitResponse } = spawnAdapter();
  try {
    send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { sessionId: 'test-sess-1' } });
    const res = await waitResponse(2);

    assert.equal(res.id, 2);
    assert.equal(res.result.sessionId, 'test-sess-1');
  } finally {
    child.kill();
  }
});

test('ACP session/cancel triggers transactional rollback', async () => {
  const { child, send, waitResponse } = spawnAdapter();
  try {
    send({ jsonrpc: '2.0', id: 3, method: 'session/new', params: { sessionId: 'test-sess-cancel' } });
    await waitResponse(3);

    send({ jsonrpc: '2.0', id: 4, method: 'session/cancel', params: { sessionId: 'test-sess-cancel' } });
    const cancelRes = await waitResponse(4);

    assert.equal(cancelRes.id, 4);
    assert.equal(cancelRes.result.cancelled, true);
  } finally {
    child.kill();
  }
});

test('ACP session/prompt streams content and returns final message using mock HTTP server', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/chat/completions') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      res.write('data: {"choices":[{"delta":{"content":"Hello "},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"from DeepSeek!"},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockBaseUrl = `http://127.0.0.1:${port}`;

  const { child, send, waitResponse, notifications } = spawnAdapter({
    DEEPSEEK_BASE_URL: mockBaseUrl
  });

  try {
    send({
      jsonrpc: '2.0',
      id: 10,
      method: 'session/prompt',
      params: { sessionId: 'stream-sess', prompt: 'Say hello' }
    });

    const res = await waitResponse(10, 5000);
    assert.equal(res.id, 10);
    assert.equal(res.result.message.content, 'Hello from DeepSeek!');
    assert.equal(res.result.stopReason, 'end_turn');

    const textUpdates = notifications
      .filter((n) => n.method === 'session/update' && n.params?.delta?.type === 'text')
      .map((n) => n.params.delta.text);
    assert.deepEqual(textUpdates, ['Hello ', 'from DeepSeek!']);
  } finally {
    child.kill();
    server.close();
  }
});

test('ACP session/prompt accepts prompt as array of ContentBlocks (ACP standard format)', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/chat/completions') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write('data: {"choices":[{"delta":{"content":"ACP ContentBlock parsed correctly!"},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  });

  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const mockBaseUrl = `http://127.0.0.1:${port}`;

  const { child, send, waitResponse } = spawnAdapter({
    DEEPSEEK_BASE_URL: mockBaseUrl
  });

  try {
    send({
      jsonrpc: '2.0',
      id: 11,
      method: 'session/prompt',
      params: {
        sessionId: 'contentblock-sess',
        prompt: [
          { type: 'text', text: 'Hello from ACP content block 1\n' },
          { type: 'text', text: 'Event ID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
        ]
      }
    });

    const res = await waitResponse(11, 5000);
    assert.equal(res.id, 11);
    assert.equal(res.result.message.content, 'ACP ContentBlock parsed correctly!');
    assert.equal(res.result.stopReason, 'end_turn');
  } finally {
    child.kill();
    server.close();
  }
});

test('Truncated stream on tool call injects synthetic tool error', async () => {
  let callCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/chat/completions') {
      callCount++;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      if (callCount === 1) {
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_trunc","type":"function","function":{"name":"run_command","arguments":"{\\"cmd\\":\\"incomp"}}]}}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.write('data: {"choices":[{"delta":{"content":"Recovered after truncation."},"finish_reason":"stop"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockBaseUrl = `http://127.0.0.1:${port}`;

  const { child, send, waitResponse } = spawnAdapter({
    DEEPSEEK_BASE_URL: mockBaseUrl
  });

  try {
    send({
      jsonrpc: '2.0',
      id: 20,
      method: 'session/prompt',
      params: { sessionId: 'trunc-sess', prompt: 'Run something' }
    });

    const res = await waitResponse(20, 5000);
    assert.equal(res.id, 20);
    assert.equal(res.result.message.content, 'Recovered after truncation.');
    assert.equal(callCount, 2);
  } finally {
    child.kill();
    server.close();
  }
});

test('Circuit breaker aborts when 2 consecutive identical tool errors occur', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/chat/completions') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_malformed","type":"function","function":{"name":"bad_tool","arguments":"NOT_VALID_JSON"}}]}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockBaseUrl = `http://127.0.0.1:${port}`;

  const { child, send, waitResponse, notifications } = spawnAdapter({
    DEEPSEEK_BASE_URL: mockBaseUrl
  });

  try {
    send({
      jsonrpc: '2.0',
      id: 30,
      method: 'session/prompt',
      params: { sessionId: 'loop-sess', prompt: 'Trigger error loop' }
    });

    const res = await waitResponse(30, 5000);
    assert.equal(res.id, 30);
    // A circuit-breaker stop is a normal, spec-valid end of turn: buzz-acp treats any other value as a protocol error.
    assert.equal(res.result.stopReason, 'end_turn');

    const loopNotice = notifications.find(
      (n) => n.method === 'session/update' && n.params?.delta?.text?.includes('Tool execution loop aborted')
    );
    assert.ok(loopNotice, 'Expected tool loop aborted notice');
  } finally {
    child.kill();
    server.close();
  }
});

test('Secret Hygiene deletes DEEPSEEK_API_KEY from process.env, and preserves required client tokens in MCP env', async () => {
  const mcpClientPath = path.resolve(__dirname, '../dist/mcp-client.js');
  const verifyCode = `
    import { sanitizeSubprocessEnv } from '${mcpClientPath}';
    import { loadSecretKey } from '${INDEX_PATH}';

    // 1. Verify loadSecretKey deletes keys from process.env
    process.env.DEEPSEEK_API_KEY = 'secret-to-be-deleted';
    process.env.DEEPSEEK_AUTH_TOKEN = 'token-to-be-deleted';
    const loadedKey = loadSecretKey();
    if (loadedKey !== 'secret-to-be-deleted') {
      console.error('loadSecretKey did not return expected key');
      process.exit(1);
    }
    if (process.env.DEEPSEEK_API_KEY !== undefined || process.env.DEEPSEEK_AUTH_TOKEN !== undefined) {
      console.error('DEEPSEEK_API_KEY or DEEPSEEK_AUTH_TOKEN remained in process.env');
      process.exit(2);
    }

    // 2. Verify sanitizeSubprocessEnv preserves client tokens and signing keys while stripping admin credentials
    const rawEnv = {
      PATH: '/bin:/usr/bin',
      USER_TOKEN: 'user-token-keep-me',
      CLIENT_AUTH_KEY: 'auth-key-keep-me',
      AUTH_TAG: 'auth-tag-keep-me',
      BUZZ_PRIVATE_KEY: 'buzz-key-keep-me',
      BUZZ_AUTH_TAG: 'buzz-auth-keep-me',
      DEEPSEEK_API_KEY: 'strip-me',
      DEEPSEEK_AUTH_TOKEN: 'strip-me-too',
      ADMIN_TOKEN: 'strip-admin',
      TOKEN_ADMIN: 'strip-token-admin'
    };
    const clean = sanitizeSubprocessEnv(rawEnv);

    if (clean.USER_TOKEN !== 'user-token-keep-me') {
      console.error('USER_TOKEN was erroneously stripped from MCP environment');
      process.exit(3);
    }
    if (clean.BUZZ_PRIVATE_KEY !== 'buzz-key-keep-me' || clean.BUZZ_AUTH_TAG !== 'buzz-auth-keep-me') {
      console.error('BUZZ_PRIVATE_KEY or BUZZ_AUTH_TAG was erroneously stripped from MCP environment');
      process.exit(4);
    }
    if (clean.DEEPSEEK_API_KEY !== undefined || clean.ADMIN_TOKEN !== undefined) {
      console.error('Sensitive secrets were not stripped from MCP environment');
      process.exit(5);
    }

    process.exit(0);
  `;

  const child = spawn(process.execPath, ['--input-type=module', '-e', verifyCode], {
    env: {
      ...process.env,
      NODE_PATH: NODE_MODULES_PATH
    }
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const exitCode = await new Promise((res) => child.on('exit', res));
  assert.equal(exitCode, 0, `Secret hygiene verification failed with code ${exitCode}: ${stderr}`);
});

test('Session concurrency: concurrent session/prompt calls reject with error code -32000 (Session busy)', async () => {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    setTimeout(() => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write('data: {"choices":[{"delta":{"content":"Slow response"},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }, 200);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockBaseUrl = `http://127.0.0.1:${port}`;

  const { child, send, waitResponse } = spawnAdapter({
    DEEPSEEK_BASE_URL: mockBaseUrl
  });

  try {
    send({
      jsonrpc: '2.0',
      id: 101,
      method: 'session/prompt',
      params: { sessionId: 'busy-sess', prompt: 'First prompt in-flight' }
    });

    send({
      jsonrpc: '2.0',
      id: 102,
      method: 'session/prompt',
      params: { sessionId: 'busy-sess', prompt: 'Second prompt concurrent' }
    });

    const res2 = await waitResponse(102, 5000);
    assert.equal(res2.id, 102);
    assert.ok(res2.error, 'Expected error for concurrent prompt');
    assert.equal(res2.error.code, -32000);
    assert.match(res2.error.message, /busy processing prompt 101/);

    const res1 = await waitResponse(101, 5000);
    assert.equal(res1.id, 101);
    assert.equal(res1.result.message.content, 'Slow response');
  } finally {
    child.kill();
    server.close();
  }
});

test('Circuit breaker: injects synthetic tool error for remaining unexecuted tool calls', async () => {
  let receivedTurnMessages = [];
  let callCount = 0;

  const server = http.createServer((req, res) => {
    if (req.url === '/chat/completions') {
      callCount++;
      let bodyStr = '';
      req.on('data', (d) => { bodyStr += d.toString(); });
      req.on('end', () => {
        try {
          const body = JSON.parse(bodyStr);
          receivedTurnMessages = body.messages;
        } catch (_) {}

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });

        if (callCount === 1) {
          res.write('data: {"choices":[{"delta":{"tool_calls":[' +
            '{"index":0,"id":"call_bad_0","type":"function","function":{"name":"bad_tool","arguments":"NOT_VALID_JSON"}}' +
            ']}}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"tool_calls":[' +
            '{"index":0,"id":"call_bad_1","type":"function","function":{"name":"bad_tool","arguments":"NOT_VALID_JSON"}},' +
            '{"index":1,"id":"call_unexecuted_2","type":"function","function":{"name":"other_tool","arguments":"{}"}}' +
            ']}}]}\n\n');
        }
        res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockBaseUrl = `http://127.0.0.1:${port}`;

  const { child, send, waitResponse } = spawnAdapter({
    DEEPSEEK_BASE_URL: mockBaseUrl
  });

  try {
    send({
      jsonrpc: '2.0',
      id: 40,
      method: 'session/prompt',
      params: { sessionId: 'multi-tool-loop-sess', prompt: 'Trigger multi-tool loop' }
    });

    const res = await waitResponse(40, 5000);
    assert.equal(res.id, 40);
    assert.equal(res.result.stopReason, 'end_turn');

    send({
      jsonrpc: '2.0',
      id: 41,
      method: 'session/prompt',
      params: { sessionId: 'multi-tool-loop-sess', prompt: 'Second prompt to inspect history' }
    });

    await waitResponse(41, 5000);

    const toolMsg1 = receivedTurnMessages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_bad_1');
    const toolMsg2 = receivedTurnMessages.find((m) => m.role === 'tool' && m.tool_call_id === 'call_unexecuted_2');

    assert.ok(toolMsg1, 'Expected tool message for call_bad_1');
    assert.ok(toolMsg2, 'Expected tool message for call_unexecuted_2 to prevent orphan tool call');
    assert.ok(toolMsg2.content.includes('circuit breaker stopped execution before this tool could run'));
  } finally {
    child.kill();
    server.close();
  }
});

test('CoT Invariant unconditionally preserves reasoning_content regardless of model name', async () => {
  let receivedTurnMessages = [];

  const server = http.createServer((req, res) => {
    if (req.url === '/chat/completions') {
      let bodyStr = '';
      req.on('data', (d) => { bodyStr += d.toString(); });
      req.on('end', () => {
        try {
          const body = JSON.parse(bodyStr);
          receivedTurnMessages = body.messages;
        } catch (_) {}

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        });

        if (receivedTurnMessages.length <= 2) {
          res.write('data: {"choices":[{"delta":{"reasoning_content":"Step 1: thinking thoroughly..."},"finish_reason":null}]}\n\n');
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_r1_cot","type":"function","function":{"name":"test_tool","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n');
        } else {
          res.write('data: {"choices":[{"delta":{"content":"Final answer after reasoning."},"finish_reason":"stop"}]}\n\n');
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockBaseUrl = `http://127.0.0.1:${port}`;

  const { child, send, waitResponse } = spawnAdapter({
    DEEPSEEK_BASE_URL: mockBaseUrl,
    DEEPSEEK_MODEL: 'deepseek-chat'
  });

  try {
    send({
      jsonrpc: '2.0',
      id: 50,
      method: 'session/prompt',
      params: { sessionId: 'cot-sess', prompt: 'Perform reasoning' }
    });

    const res = await waitResponse(50, 5000);
    assert.equal(res.id, 50);

    const assistantMsg = receivedTurnMessages.find(
      (m) => m.role === 'assistant' && m.reasoning_content === 'Step 1: thinking thoroughly...'
    );
    assert.ok(assistantMsg, 'Expected reasoning_content to be unconditionally preserved in assistant message');
  } finally {
    child.kill();
    server.close();
  }
});

test('ACP _session/steering returns promptRequired when session is idle', async () => {
  const { child, send, waitResponse } = spawnAdapter();
  try {
    send({
      jsonrpc: '2.0',
      id: 60,
      method: '_session/steering',
      params: { sessionId: 'idle-test-sess', prompt: 'Mid-turn steer message' }
    });
    const res = await waitResponse(60);
    assert.equal(res.id, 60);
    assert.equal(res.result.outcome, 'promptRequired');
    assert.equal(res.result.reason, 'noRunningTurn');
  } finally {
    child.kill();
  }
});

test('ACP _session/steering injects follow-up into running turn', async () => {
  let callCount = 0;
  const receivedBodies = [];

  const server = http.createServer((req, res) => {
    if (req.url === '/chat/completions') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        callCount++;
        receivedBodies.push(JSON.parse(body));

        if (callCount === 1) {
          // Simulate tool call with delay to allow mid-turn steering injection
          setTimeout(() => {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive'
            });
            res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"shell","arguments":"{\\"command\\":\\"echo test\\"}"}}]}}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          }, 300);
        } else {
          // Final reply acknowledging steer
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          });
          res.write('data: {"choices":[{"delta":{"content":"Steered reply completed."}}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const mockBaseUrl = `http://127.0.0.1:${port}`;

  const { child, send, waitResponse } = spawnAdapter({
    DEEPSEEK_BASE_URL: mockBaseUrl
  });

  try {
    // 1. Send initial prompt
    send({
      jsonrpc: '2.0',
      id: 70,
      method: 'session/prompt',
      params: { sessionId: 'steer-active-sess', prompt: 'Initial prompt text' }
    });

    // 2. Wait 50ms so prompt turn starts, then send mid-turn steer
    await new Promise((r) => setTimeout(r, 50));
    send({
      jsonrpc: '2.0',
      id: 71,
      method: '_session/steering',
      params: { sessionId: 'steer-active-sess', prompt: 'Urgent steer directive' }
    });

    // 3. Steer response must arrive with injected outcome
    const steerRes = await waitResponse(71, 3000);
    assert.equal(steerRes.id, 71);
    assert.equal(steerRes.result.outcome, 'injected');

    // 4. Initial prompt turn completes
    const promptRes = await waitResponse(70, 5000);
    assert.equal(promptRes.id, 70);

    // 5. Verify the second call to DeepSeek included the injected steered message
    assert.ok(receivedBodies.length >= 2, 'Expected at least 2 chat completion calls');
    const secondCallMessages = receivedBodies[1].messages;
    const hasSteeredMessage = secondCallMessages.some(
      (m) => m.role === 'user' && m.content.includes('Urgent steer directive')
    );
    assert.ok(hasSteeredMessage, 'Expected second call messages to include injected steer directive');
  } finally {
    child.kill();
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Thinking control: DEEPSEEK_THINKING / DEEPSEEK_REASONING_EFFORT must reach the request
// (they used to be purged from process.env at start-up and never read).
// ---------------------------------------------------------------------------

test('Request carries no thinking or reasoning_effort when nothing is configured', async () => {
  const mock = await startMockCompletions((body, res) => replyText(res, 'ok'));
  const adapter = spawnAdapter({ DEEPSEEK_BASE_URL: mock.baseUrl });
  try {
    await promptOnce(adapter, 60);
    assert.equal(mock.requests.length, 1);
    assert.equal('thinking' in mock.requests[0], false);
    assert.equal('reasoning_effort' in mock.requests[0], false);
  } finally {
    adapter.child.kill();
    mock.server.close();
  }
});

test('DEEPSEEK_THINKING=disabled is sent as thinking.type=disabled', async () => {
  const mock = await startMockCompletions((body, res) => replyText(res, 'ok'));
  const adapter = spawnAdapter({ DEEPSEEK_BASE_URL: mock.baseUrl, DEEPSEEK_THINKING: 'disabled' });
  try {
    await promptOnce(adapter, 61);
    assert.deepEqual(mock.requests[0].thinking, { type: 'disabled' });
    assert.equal('reasoning_effort' in mock.requests[0], false);
  } finally {
    adapter.child.kill();
    mock.server.close();
  }
});

test('DEEPSEEK_REASONING_EFFORT=none disables thinking', async () => {
  const mock = await startMockCompletions((body, res) => replyText(res, 'ok'));
  const adapter = spawnAdapter({ DEEPSEEK_BASE_URL: mock.baseUrl, DEEPSEEK_REASONING_EFFORT: 'none' });
  try {
    await promptOnce(adapter, 62);
    assert.deepEqual(mock.requests[0].thinking, { type: 'disabled' });
    assert.equal('reasoning_effort' in mock.requests[0], false);
  } finally {
    adapter.child.kill();
    mock.server.close();
  }
});

test('DEEPSEEK_REASONING_EFFORT=max is sent as reasoning_effort', async () => {
  const mock = await startMockCompletions((body, res) => replyText(res, 'ok'));
  const adapter = spawnAdapter({ DEEPSEEK_BASE_URL: mock.baseUrl, DEEPSEEK_REASONING_EFFORT: 'max' });
  try {
    await promptOnce(adapter, 63);
    assert.equal(mock.requests[0].reasoning_effort, 'max');
    assert.equal('thinking' in mock.requests[0], false);
  } finally {
    adapter.child.kill();
    mock.server.close();
  }
});

test('An invalid DEEPSEEK_THINKING value is ignored and reported on stderr', async () => {
  const mock = await startMockCompletions((body, res) => replyText(res, 'ok'));
  const adapter = spawnAdapter({ DEEPSEEK_BASE_URL: mock.baseUrl, DEEPSEEK_THINKING: 'banana' });
  try {
    await promptOnce(adapter, 64);
    assert.equal('thinking' in mock.requests[0], false);
    assert.match(adapter.getStderr(), /DEEPSEEK_THINKING/);
  } finally {
    adapter.child.kill();
    mock.server.close();
  }
});

test('The start-up log states the effective model, reasoning mode and iteration limit', async () => {
  const mock = await startMockCompletions((body, res) => replyText(res, 'ok'));
  const adapter = spawnAdapter({
    DEEPSEEK_BASE_URL: mock.baseUrl,
    DEEPSEEK_MODEL: 'deepseek-flash',
    DEEPSEEK_THINKING: 'disabled',
    ACP_MAX_ITERATIONS: '10000'
  });
  try {
    await promptOnce(adapter, 65);
    const log = adapter.getStderr();
    assert.match(log, /\[config\] model=deepseek-flash/);
    assert.match(log, /thinking=disabled/);
    assert.match(log, /max_iterations=10000/);
    assert.match(log, /Turn iteration 1\/10000/);
  } finally {
    adapter.child.kill();
    mock.server.close();
  }
});

// ---------------------------------------------------------------------------
// Settings that used to be purged together with the secrets
// ---------------------------------------------------------------------------

test('DEEPSEEK_REQUEST_TIMEOUT_MS is honoured (the secret purge must not remove it)', async () => {
  const hanging = http.createServer(() => {
    /* never answers */
  });
  await new Promise((resolve) => hanging.listen(0, '127.0.0.1', resolve));
  const adapter = spawnAdapter({
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${hanging.address().port}`,
    DEEPSEEK_REQUEST_TIMEOUT_MS: '400'
  });
  try {
    adapter.send({
      jsonrpc: '2.0',
      id: 66,
      method: 'session/prompt',
      params: { sessionId: 'timeout-sess', prompt: 'hello' }
    });
    const res = await adapter.waitResponse(66, 4000);
    assert.match(res.result.message.content, /timeout|aborted/i);
  } finally {
    adapter.child.kill();
    hanging.closeAllConnections();
    hanging.close();
  }
});

test('loadSecretKey purges secrets and unknown DEEPSEEK_* variables but keeps every documented setting', async () => {
  const verifyCode = `
    import { loadSecretKey } from '${INDEX_PATH}';
    process.env.DEEPSEEK_API_KEY = 'secret';
    process.env.DEEPSEEK_SOMETHING_ELSE = 'unknown-might-be-a-secret';
    process.env.DEEPSEEK_THINKING = 'disabled';
    process.env.DEEPSEEK_REASONING_EFFORT = 'none';
    process.env.DEEPSEEK_REQUEST_TIMEOUT_MS = '1234';
    loadSecretKey();
    const gone = ['DEEPSEEK_API_KEY', 'DEEPSEEK_SOMETHING_ELSE'].filter((k) => process.env[k] !== undefined);
    const kept = {
      DEEPSEEK_THINKING: 'disabled',
      DEEPSEEK_REASONING_EFFORT: 'none',
      DEEPSEEK_REQUEST_TIMEOUT_MS: '1234'
    };
    const lost = Object.keys(kept).filter((k) => process.env[k] !== kept[k]);
    if (gone.length || lost.length) {
      console.error(JSON.stringify({ notPurged: gone, lostSettings: lost }));
      process.exit(1);
    }
    process.exit(0);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', verifyCode], {
    env: { ...process.env, NODE_PATH: NODE_MODULES_PATH }
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  const exitCode = await new Promise((res) => child.on('exit', res));
  assert.equal(exitCode, 0, `purge check failed: ${stderr}`);
});

// ---------------------------------------------------------------------------
// Iteration limit
// ---------------------------------------------------------------------------

test('Iteration limit ends the turn with the ACP stop reason max_turn_requests and a fixed notice', async () => {
  const mock = await startMockCompletions((body, res, n) => replyUnparsableToolCall(res, n));
  // No wrap-up: this pins the limit itself (tests/test_wrapup.test.mjs covers the calls after it).
  const adapter = spawnAdapter({ DEEPSEEK_BASE_URL: mock.baseUrl, ACP_MAX_ITERATIONS: '3', ACP_WRAPUP_ITERATIONS: '0' });
  try {
    const res = await promptOnce(adapter, 67, 'keep calling tools');
    // buzz-acp rejects any stop reason outside the ACP set ("unknown stopReason") by respawning the agent.
    assert.equal(res.result.stopReason, 'max_turn_requests');
    assert.equal(mock.requests.length, 3, 'exactly ACP_MAX_ITERATIONS model calls');
    assert.match(res.result.message.content, /3/, 'the notice names the limit');
    assert.doesNotMatch(res.result.message.content, /malformed JSON|BAD_/, 'raw tool output must not be returned as the answer');
    const notice = adapter.notifications.find(
      (n) => n.method === 'session/update' && /iteration limit/i.test(n.params?.delta?.text ?? '')
    );
    assert.ok(notice, 'Expected an iteration limit notice in the update stream');
    assert.match(adapter.getStderr(), /Turn iteration 3\/3/);
  } finally {
    adapter.child.kill();
    mock.server.close();
  }
});

test('A circuit-breaker stop on the last allowed iteration is reported as a breaker stop, not as the limit', async () => {
  // Two identical failing calls: the breaker fires on iteration 2, which is also ACP_MAX_ITERATIONS.
  const mock = await startMockCompletions((body, res) => {
    res.writeHead(200, SSE_HEADERS);
    const delta = {
      tool_calls: [{ index: 0, id: 'call_same', type: 'function', function: { name: 'bad_tool', arguments: 'NOT_VALID_JSON' } }]
    };
    res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const adapter = spawnAdapter({ DEEPSEEK_BASE_URL: mock.baseUrl, ACP_MAX_ITERATIONS: '2' });
  try {
    const res = await promptOnce(adapter, 68, 'loop');
    assert.equal(res.result.stopReason, 'end_turn');
    assert.match(res.result.message.content, /repetitive tool errors/);
  } finally {
    adapter.child.kill();
    mock.server.close();
  }
});
