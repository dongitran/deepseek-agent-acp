#!/usr/bin/env node
/**
 * A stdio MCP server for end-to-end tests (ACP_MCP_COMMAND): three tools that answer like Elio Twin's — meeting_wait
 * (the meeting gate's JSON), thread_read (text) and reply (a posting tool with the posted event id).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const OUTPUTS = {
  meeting_wait: '{"event":"addressed","addressed":[{"text":"Chào cậu nhớ!","speaker":"Elio"}]}',
  thread_read: 'Thread: Elio: Chào cậu nhớ!',
  reply: 'posted (14 characters) · event_id 40738780fa35899d341c45daeda99e609aff92c6d3cb44c54e06e7290e7bb38b'
};

const server = new Server({ name: 'mock-meeting-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: Object.keys(OUTPUTS).map((name) => ({
    name,
    description: `Mock ${name}`,
    inputSchema: { type: 'object', properties: {} }
  }))
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const text = OUTPUTS[request.params.name];
  if (text === undefined) {
    return { isError: true, content: [{ type: 'text', text: `unknown tool ${request.params.name}` }] };
  }
  return { content: [{ type: 'text', text }] };
});

await server.connect(new StdioServerTransport());
