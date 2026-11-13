#!/usr/bin/env node
/**
 * A stdio MCP server for end-to-end tests (ACP_MCP_COMMAND): three tools that answer like Elio Twin's — meeting_wait
 * (the meeting gate's JSON), thread_read (text) and reply (a posting tool with the posted event id).
 * MOCK_MCP_EXTRA_TOOLS=meeting_join adds a tool that always fails as the gate did on 2026-11-13 (agent-infra #49).
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

const FAILURES = {
  meeting_join:
    'MCP error 400: Streamable HTTP error: Error POSTing to endpoint: Bad Request: No valid session ID provided'
};
const EXTRA = (process.env.MOCK_MCP_EXTRA_TOOLS ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name in FAILURES);
const CALL_LOG = process.env.MOCK_MCP_CALL_LOG;

const server = new Server({ name: 'mock-meeting-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [...Object.keys(OUTPUTS), ...EXTRA].map((name) => ({
    name,
    description: `Mock ${name}`,
    inputSchema: { type: 'object', properties: {} }
  }))
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const { name } = request.params;
  if (CALL_LOG) {
    appendFileSync(CALL_LOG, `${name}\n`);
  }
  if (EXTRA.includes(name)) {
    return { isError: true, content: [{ type: 'text', text: FAILURES[name] }] };
  }
  const text = OUTPUTS[name];
  if (text === undefined) {
    return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
  }
  return { content: [{ type: 'text', text }] };
});

await server.connect(new StdioServerTransport());
