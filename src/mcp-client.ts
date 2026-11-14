/**
 * mcp-client.ts — Stdio Model Context Protocol (MCP) Client for tool execution.
 * Design Invariant: Stdio NDJSON hygiene:
 * Ensures subprocess stderr is piped to process.stderr (never stdout) so ACP NDJSON on stdout is never corrupted.
 * Provides init(), getTools(), callTool(name, args), and close().
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Sanitize environment passed to MCP child process.
 * Strips model API keys and administrative credentials from child process environment.
 * Preserves workspace tokens, signing keys, and communication credentials required by tool subprocesses.
 */
export function sanitizeSubprocessEnv(sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) {
      continue;
    }
    const upper = key.toUpperCase();

    // Preserve communication and client credentials required by tools
    if (
      upper === 'BUZZ_PRIVATE_KEY' ||
      upper === 'BUZZ_AUTH_TAG' ||
      upper === 'GITLAB_TOKEN' ||
      upper === 'USER_TOKEN' ||
      upper === 'AUTH_TAG' ||
      upper === 'CLIENT_AUTH_KEY'
    ) {
      cleanEnv[key] = value;
      continue;
    }

    // Strip sensitive model keys and administrative credentials
    if (
      upper.startsWith('DEEPSEEK_') ||
      upper.startsWith('OPENAI_') ||
      upper.startsWith('ANTHROPIC_') ||
      upper.includes('ADMIN') ||
      upper.includes('NSEC') ||
      upper.startsWith('IDENTITY__') ||
      upper.endsWith('_SECRET')
    ) {
      continue;
    }

    cleanEnv[key] = value;
  }
  return cleanEnv;
}

/**
 * A controller for one MCP request that follows the turn's `signal`. The SDK adds an abort listener to the signal it is
 * given and never removes it, so it gets this throwaway one; `release` detaches the forwarding from the turn's signal.
 */
function requestController(signal?: AbortSignal): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const forward = (): void => {
    controller.abort(signal?.reason);
  };
  signal?.addEventListener('abort', forward, { once: true });
  return { signal: controller.signal, release: () => signal?.removeEventListener('abort', forward) };
}

/**
 * Waits for `work` or for `signal` to abort, whichever comes first; true when the abort came first. `work` goes on
 * either way: a connect is shared (init's own guard), and the next caller finds it done.
 */
async function abortedFirst(work: Promise<unknown>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await work;
    return false;
  }
  if (signal.aborted) {
    return true;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(true);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work.then(() => false), aborted]);
  } finally {
    if (onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

export class McpClient {
  public mcpCommand: string;
  public args: string[];
  public client: Client | null = null;
  public transport: StdioClientTransport | null = null;
  public cachedTools: OpenAIFunctionTool[] = [];
  public isConnected = false;
  private _initPromise: Promise<void> | null = null;

  constructor(
    mcpCommand: string = process.env.ACP_MCP_COMMAND ?? process.env.BUZZ_ACP_MCP_COMMAND ?? 'buzz-dev-mcp',
    args: string[] = []
  ) {
    this.mcpCommand = mcpCommand;
    this.args = args;
  }

  /**
   * Initialize and connect Stdio MCP Transport.
   * Uses _initPromise to guard against race conditions on concurrent initialization.
   */
  async init(): Promise<void> {
    if (this.isConnected && this.client) {
      return;
    }
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = (async () => {
      try {
        this.transport = new StdioClientTransport({
          command: this.mcpCommand,
          args: this.args,
          env: sanitizeSubprocessEnv(process.env),
          stderr: 'pipe'
        });

        // Stdio Hygiene: Pipe subprocess stderr to process.stderr (never stdout)
        if (this.transport.stderr) {
          this.transport.stderr.on('data', (chunk: Buffer | string) => {
            process.stderr.write(chunk);
          });
        }

        this.client = new Client(
          {
            name: 'deepseek-agent-acp-mcp',
            version: '1.0.0'
          },
          {
            capabilities: {}
          }
        );

        await this.client.connect(this.transport);
        this.isConnected = true;
        process.stderr.write(`[deepseek-acp:INFO] MCP client connected to ${this.mcpCommand}\n`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[deepseek-acp:WARN] MCP client connection to ${this.mcpCommand} failed: ${msg}\n`);
        this.isConnected = false;
        this.client = null;
        this.transport = null;
      } finally {
        this._initPromise = null;
      }
    })();

    return this._initPromise;
  }

  async connect(): Promise<void> {
    return this.init();
  }

  /**
   * List available tools from MCP server converted to OpenAI function calling format. `signal` (the turn's) cuts the
   * wait short, connect included: a cancelled turn gets the last known list at once.
   */
  async getTools(signal?: AbortSignal): Promise<OpenAIFunctionTool[]> {
    if (!this.isConnected || !this.client) {
      if (await abortedFirst(this.init(), signal)) {
        return this.cachedTools;
      }
    }

    if (!this.isConnected || !this.client || signal?.aborted) {
      return this.cachedTools;
    }

    const request = requestController(signal);
    try {
      const response = await this.client.listTools(undefined, { signal: request.signal });
      const tools = response.tools || [];
      this.cachedTools = tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} }
        }
      }));
      return this.cachedTools;
    } catch (err: unknown) {
      if (request.signal.aborted) {
        return this.cachedTools;
      }
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[deepseek-acp:ERROR] Failed to list MCP tools: ${msg}\n`);
      return this.cachedTools;
    } finally {
      request.release();
    }
  }

  async listTools(): Promise<OpenAIFunctionTool[]> {
    return this.getTools();
  }

  /**
   * Call a tool via MCP. Returns result string. `signal` (the turn's) cancels the call: the SDK tells the server
   * (notifications/cancelled) and the call ends at once with an error instead of when the tool finishes — ACP asks an
   * agent to stop its tool calls as soon as a turn is cancelled, and buzz-acp waits only 5 s for the cancelled turn.
   */
  async callTool(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      return JSON.stringify({ error: `Tool execution cancelled: ${name} was not run.` });
    }
    if (!this.isConnected || !this.client) {
      if (await abortedFirst(this.init(), signal)) {
        return JSON.stringify({ error: `Tool execution cancelled: ${name} was not run.` });
      }
    }

    if (!this.isConnected || !this.client) {
      return JSON.stringify({ error: `MCP tool ${name} unavailable: MCP client is not connected.` });
    }
    // The turn may have been cancelled while the client connected: its abort event has fired already, so the listener
    // below would never hear it. Nothing awaits between this check and that listener.
    if (signal?.aborted) {
      return JSON.stringify({ error: `Tool execution cancelled: ${name} was not run.` });
    }

    const timeoutMs = parseInt(process.env.MCP_TOOL_TIMEOUT_MS ?? '60000', 10);
    let timerId: NodeJS.Timeout | null = null;
    // A controller of its own for each call: the turn's signal is shared by every call of a turn (hundreds in a meeting).
    const request = requestController(signal);

    try {
      const callPromise = this.client.callTool(
        {
          name,
          arguments: args
        },
        undefined,
        { signal: request.signal }
      );

      const timeoutPromise = new Promise<never>((_, reject) => {
        timerId = setTimeout(() => {
          reject(new Error(`Tool execution timed out after ${timeoutMs.toString()}ms`));
        }, timeoutMs);
      });

      const response = (await Promise.race([callPromise, timeoutPromise])) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      };

      if (response?.isError) {
        const errorContent = response.content?.map((c) => c.text ?? '').join('\n') || 'Unknown tool error';
        return JSON.stringify({ error: errorContent });
      }

      if (response && Array.isArray(response.content)) {
        return response.content.map((c) => (c.text !== undefined ? c.text : JSON.stringify(c))).join('\n');
      }

      return typeof response === 'string' ? response : JSON.stringify(response);
    } catch (err: unknown) {
      if (request.signal.aborted) {
        return JSON.stringify({ error: `Tool execution cancelled: ${name} was stopped with its turn.` });
      }
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[deepseek-acp:ERROR] MCP tool ${name} call failed: ${msg}\n`);
      return JSON.stringify({ error: `Tool execution error: ${msg}` });
    } finally {
      if (timerId !== null) {
        clearTimeout(timerId);
      }
      request.release();
    }
  }

  /**
   * Close and disconnect MCP client and transport.
   */
  async close(): Promise<void> {
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Ignored
      }
    }
    this.isConnected = false;
    this.client = null;
    this.transport = null;
  }

  async disconnect(): Promise<void> {
    return this.close();
  }
}
