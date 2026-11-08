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

  return { child, send, waitResponse, responses, notifications };
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
    assert.equal(res.result.stopReason, 'loop_aborted');

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
    assert.equal(res.result.stopReason, 'loop_aborted');

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
