#!/usr/bin/env node
/**
 * A stdio MCP server for end-to-end tests (ACP_MCP_COMMAND): three tools that answer like Elio Twin's — meeting_wait
 * (the meeting gate's JSON), thread_read (text) and reply (a posting tool with the posted event id).
 * MOCK_MCP_EXTRA_TOOLS (comma-separated) adds:
 *   meeting_join — always fails, as the meeting gate did on 2026-11-13 (agent-infra #49);
 *   shell        — like buzz-dev-mcp's shell for a shell agent: `buzz messages send …` posts, anything else times out.
 * MOCK_MCP_SLOW_TOOLS=<name>:<ms>,… holds those calls that long before answering.
 * MOCK_MCP_CALL_LOG=<file> appends the name of every tool called, one per line, so a test sees what really ran.
 */
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const OUTPUTS = {
  meeting_wait: '{"event":"addressed","addressed":[{"text":"Chào cậu nhớ!","speaker":"Elio"}]}',
  thread_read: 'Thread: Elio: Chào cậu nhớ!',
  reply: 'posted (14 characters) · event_id 40738780fa35899d341c45daeda99e609aff92c6d3cb44c54e06e7290e7bb38b'
};

const ok = (text) => ({ content: [{ type: 'text', text }] });
const failed = (text) => ({ isError: true, content: [{ type: 'text', text }] });

const EXTRA_TOOLS = {
  meeting_join: () =>
    failed('MCP error 400: Streamable HTTP error: Error POSTing to endpoint: Bad Request: No valid session ID provided'),
  shell: (args) =>
    String(args?.command ?? '').startsWith('buzz messages send')
      ? ok('{"accepted":true,"event_id":"9f3c1b7a2e4d6f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708"}')
      : failed('Tool execution timed out after 60000ms')
};
const EXTRA = (process.env.MOCK_MCP_EXTRA_TOOLS ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name in EXTRA_TOOLS);
const SLOW = Object.fromEntries(
  (process.env.MOCK_MCP_SLOW_TOOLS ?? '')
    .split(',')
    .map((entry) => entry.trim().split(':'))
    .filter(([name, ms]) => name && Number(ms) > 0)
    .map(([name, ms]) => [name, Number(ms)])
);
const CALL_LOG = process.env.MOCK_MCP_CALL_LOG;

const server = new Server({ name: 'mock-meeting-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [...Object.keys(OUTPUTS), ...EXTRA].map((name) => ({
    name,
    description: `Mock ${name}`,
    inputSchema: { type: 'object', properties: {} }
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (CALL_LOG) {
    appendFileSync(CALL_LOG, `${name}\n`);
  }
  if (SLOW[name]) {
    await new Promise((resolve) => setTimeout(resolve, SLOW[name]));
  }
  if (EXTRA.includes(name)) {
    return EXTRA_TOOLS[name](args);
  }
  const text = OUTPUTS[name];
  if (text === undefined) {
    return failed(`unknown tool ${name}`);
  }
  return ok(text);
});

await server.connect(new StdioServerTransport());
