#!/usr/bin/env node
/**
 * index.ts — Native Agent Client Protocol (ACP) Adapter for DeepSeek reasoning and chat models.
 * Implements:
 * - Line-delimited JSON-RPC over stdin/stdout (initialize, session/new, session/cancel, session/prompt).
 * - Stdio hygiene (all logging redirected to stderr; stdout strictly reserved for JSON-RPC).
 * - In-memory secret loading and sanitization (strips API key from process.env immediately).
 * - Safe stream parsing and synthetic error injection on token limit truncation (finish_reason === 'length').
 * - Transactional state checkpointing and rollback on session/cancel.
 * - Dynamic iteration limits and circuit breaker (abort if 2 identical tool errors occur in a row), then a wrap-up in
 *   which the model tells the person why the turn stopped (src/turn-stop.ts).
 * - Full Model Context Protocol (MCP) tool execution, each tool call reported as ACP tool_call / tool_call_update.
 */

import fs from 'node:fs';
import readline from 'node:readline';
import { format } from 'node:util';
import { StreamAccumulator, parseSSEStream } from './sse-parser.js';
import { McpClient, type OpenAIFunctionTool } from './mcp-client.js';
import {
  PRESERVED_DEEPSEEK_CONFIG,
  describeReasoning,
  resolveIterationLimit,
  resolveReasoningParams,
  resolveRequestTimeoutMs,
  resolveWrapupIterations
} from './config.js';
import {
  extractPostedEventId,
  initTelemetry,
  registerSecret,
  parseNostrContext,
  type LlmSpanHandle,
  type LlmSpanOptions,
  type TelemetryService,
  type TurnSpanHandle
} from './telemetry.js';
import { describeTraceSettings, resolveTraceSettings } from './trace-config.js';
import {
  ToolErrorBreaker,
  breakerStop,
  describeTurnStop,
  isRepeatOfFailedCall,
  refusedToolError,
  stopMessageOf,
  stopReasonOf,
  wrapupNotice,
  type TurnStop
} from './turn-stop.js';
import type {
  ChatMessage,
  JSONRPCRequest,
  JSONRPCResponse,
  JSONRPCNotification,
  ToolCall
} from './types.js';

// ============================================================================
// 1. STDIO HYGIENE
// Redirect all console output to process.stderr so process.stdout is 100%
// dedicated to ACP JSON-RPC frames. Any stray write to stdout corrupts JSON-RPC.
// ============================================================================
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

// eslint-disable-next-line no-console
console.log = (...args: unknown[]) => {
  originalStderrWrite(`[deepseek-acp:INFO] ${format(...args)}\n`);
};
// eslint-disable-next-line no-console
console.info = console.log;
console.warn = (...args: unknown[]) => {
  originalStderrWrite(`[deepseek-acp:WARN] ${format(...args)}\n`);
};
console.error = (...args: unknown[]) => {
  originalStderrWrite(`[deepseek-acp:ERROR] ${format(...args)}\n`);
};

// ============================================================================
// 2. SECRET LOADING & IN-MEMORY SANITIZATION
// Loads key into in-memory constant and immediately deletes environment variables.
// ============================================================================
export function loadSecretKey(secretsPath = '/run/agent-secrets/env'): string {
  let key = process.env.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_AUTH_TOKEN ?? '';
  if (!key && fs.existsSync(secretsPath)) {
    try {
      const fileData = fs.readFileSync(secretsPath, 'utf-8');
      for (const line of fileData.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }
        const [k, ...vParts] = trimmed.split('=');
        const v = vParts.join('=');
        if (k && (k.toUpperCase().startsWith('DEEPSEEK_') || k.toUpperCase() === 'API_KEY')) {
          key = Buffer.from(v, 'base64').toString('utf-8').trim();
          if (key) {
            break;
          }
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Could not read ${secretsPath}: ${msg}`);
    }
  }

  // Delete secret keys from environment immediately (in-memory sanitization)
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_AUTH_TOKEN;
  delete process.env.DEEPSEEK_TOKEN;
  delete process.env.DEEPSEEK_SECRET;
  // Default-deny: any DEEPSEEK_* variable that is not a documented setting could be a secret.
  for (const envKey of Object.keys(process.env)) {
    if (/^DEEPSEEK_/i.test(envKey) && !PRESERVED_DEEPSEEK_CONFIG.has(envKey)) {
      delete process.env[envKey];
    }
  }

  return key;
}

const DEEPSEEK_API_KEY = loadSecretKey();
if (!DEEPSEEK_API_KEY) {
  console.warn('DEEPSEEK_API_KEY is not set. Ensure secrets are provided in environment or secrets file.');
}
registerSecret(DEEPSEEK_API_KEY);

// OpenTelemetry & Arize Phoenix Telemetry Service. What it records beyond 0.3.0 is opt-in (src/trace-config.ts).
const TRACE = resolveTraceSettings(process.env);
const telemetryService: TelemetryService | null = initTelemetry({
  secrets: DEEPSEEK_API_KEY ? [DEEPSEEK_API_KEY] : [],
  trace: TRACE.settings
});

// Configuration
const BASE_URL = (process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
const TEMPERATURE = parseFloat(process.env.DEEPSEEK_TEMPERATURE ?? '0.0');
const MCP_COMMAND = process.env.ACP_MCP_COMMAND ?? process.env.BUZZ_ACP_MCP_COMMAND ?? 'buzz-dev-mcp';

// Resolved once at start-up (after the secret purge, so every setting listed in PRESERVED_DEEPSEEK_CONFIG is intact).
const REASONING = resolveReasoningParams(process.env);
const ITERATION_LIMIT = resolveIterationLimit(process.env, MODEL);
const REQUEST_TIMEOUT = resolveRequestTimeoutMs(process.env);
const WRAPUP = resolveWrapupIterations(process.env);
for (const warning of [
  ...REASONING.warnings,
  ...ITERATION_LIMIT.warnings,
  ...REQUEST_TIMEOUT.warnings,
  ...WRAPUP.warnings
]) {
  console.warn(warning);
}
console.info(
  `[config] model=${MODEL} thinking=${describeReasoning(REASONING.params)} ` +
    `max_iterations=${ITERATION_LIMIT.limit.toString()} (${ITERATION_LIMIT.source}) ` +
    `request_timeout_ms=${REQUEST_TIMEOUT.timeoutMs.toString()} wrapup_iterations=${WRAPUP.iterations.toString()}`
);
// The trace settings matter only when spans are exported (an OTLP endpoint is set).
if (telemetryService) {
  for (const warning of TRACE.warnings) {
    console.warn(warning);
  }
  console.info(`[config] tracing ${describeTraceSettings(TRACE.settings)}`);
}

/** What the model had answered when its stream stopped half-way; nothing when nothing had arrived. */
function recordPartialAnswer(llmSpan: LlmSpanHandle | undefined, partial: StreamAccumulator | null): void {
  if (partial && (partial.content || partial.toolCalls.length > 0)) {
    llmSpan?.recordOutput({ content: partial.content || null, tool_calls: partial.toolCalls });
  }
}

// ============================================================================
// 3. PROMPT ADAPTATION LAYER
// ============================================================================
function adaptSystemPrompt(rawPrompt: string, model: string): string {
  let prompt = rawPrompt
    .replace(/\/home\/agent\/\.claude[a-zA-Z0-9_/.-]*/g, '')
    .replace(/CLAUDE\.md/g, 'AGENTS.md')
    .replace(/claude-agent-acp/g, 'deepseek-agent-acp')
    .replace(/MAX_THINKING_TOKENS[^\n]*/g, '')
    .replace(/Use the `Skill tool`[^\n]*/g, 'Consult domain instructions when available.')
    .replace(/Claude Code/g, 'DeepSeek Autonomous Engine')
    .trim();

  if (model.includes('reasoner') || model.includes('r1')) {
    prompt += `\n\n[SYSTEM ADAPTATION: DEEPSEEK-R1 ENFORCEMENT]
- Be concise and direct in your reasoning. Avoid repetitive philosophical deliberation.
- Do not invent tools. Use ONLY the provided tools.
- Structure your final response using clean GitHub-flavored Markdown.`;
  }
  return prompt;
}

function getSystemPrompt(model: string): string {
  const filePath = process.env.ACP_SYSTEM_PROMPT_FILE ?? process.env.BUZZ_ACP_SYSTEM_PROMPT_FILE ?? './system-prompt.md';
  let raw = 'You are an autonomous AI software engineer.';
  if (fs.existsSync(filePath)) {
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`Could not read system prompt file: ${msg}`);
    }
  }
  return adaptSystemPrompt(raw, model);
}

// ============================================================================
// 4. SESSION & TRANSACTIONAL STATE MANAGER
// ============================================================================
class Session {
  public sessionId: string;
  public messages: ChatMessage[];
  public checkpoint: ChatMessage[];
  public abortController: AbortController | null = null;
  public activePromptId: string | number | null = null;
  public activeTurnHandle: TurnSpanHandle | null = null;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    const sysPrompt = getSystemPrompt(MODEL);
    this.messages = [{ role: 'system', content: sysPrompt }];
    this.checkpoint = [{ role: 'system', content: sysPrompt }];
  }

  takeSnapshot(): void {
    this.checkpoint = JSON.parse(JSON.stringify(this.messages)) as ChatMessage[];
  }

  commit(): void {
    this.checkpoint = JSON.parse(JSON.stringify(this.messages)) as ChatMessage[];
  }

  rollback(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.messages = JSON.parse(JSON.stringify(this.checkpoint)) as ChatMessage[];
    console.info(`[TRANSACTION] Rolled back session ${this.sessionId} to previous checkpoint.`);
  }
}

// ============================================================================
// 5. ACP PROTOCOL ENGINE
// ============================================================================
const sessions = new Map<string, Session>();
const mcpClient = new McpClient(MCP_COMMAND);

// Initialize MCP client in background
mcpClient.init().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`MCP client initial connection failed: ${msg}. Will retry on tool access.`);
});

function sendRpc(obj: JSONRPCRequest | JSONRPCResponse | JSONRPCNotification): void {
  originalStdoutWrite(`${JSON.stringify(obj)}\n`);
}

function sendResponse(id?: string | number, result?: unknown, error?: { code: number; message: string; data?: unknown }): void {
  if (id === undefined || id === null) {
    return;
  }
  const res: JSONRPCResponse = { jsonrpc: '2.0', id };
  if (error) {
    res.error = error;
  } else {
    res.result = result !== undefined ? result : {};
  }
  sendRpc(res);
}

function sendNotification(method: string, params: Record<string, unknown>): void {
  sendRpc({ jsonrpc: '2.0', method, params });
}

/**
 * Handle incoming ACP JSON-RPC message.
 */
async function handleRpcMessage(rpc: JSONRPCRequest): Promise<void> {
  if (!rpc || typeof rpc !== 'object') {
    return;
  }
  const { id, method, params } = rpc;

  try {
    switch (method) {
      case 'initialize': {
        sendResponse(id, {
          protocolVersion: 1,
          agentInfo: {
            name: 'deepseek-agent-acp',
            version: '1.0.0'
          },
          capabilities: {
            streaming: true,
            tools: true,
            sessionCancellation: true
          },
          _meta: {
            steering: {
              supported: true
            }
          }
        });
        break;
      }

      case 'session/new': {
        const sessionId = (params?.sessionId as string) || `session-${Date.now().toString()}`;
        sessions.set(sessionId, new Session(sessionId));
        sendResponse(id, { sessionId });
        break;
      }

      case 'session/cancel': {
        const sessionId = params?.sessionId as string | undefined;
        const session = sessionId ? sessions.get(sessionId) : undefined;
        if (session) {
          session.rollback();
          sendResponse(id, { cancelled: true });
        } else {
          sendResponse(id, { cancelled: false, reason: 'Session not found' });
        }
        break;
      }

      case 'session/prompt': {
        await handleSessionPrompt(id, params);
        break;
      }

      case '_session/steering': {
        handleSessionSteering(id, params);
        break;
      }

      default: {
        console.warn(`Unhandled method: ${method}`);
        if (id !== undefined && id !== null) {
          sendResponse(id, null, {
            code: -32601,
            message: `Method not found: ${method}`
          });
        }
        break;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error handling method ${method}: ${msg}`);
    if (id !== undefined && id !== null) {
      sendResponse(id, null, {
        code: -32000,
        message: msg
      });
    }
  }
}

/**
 * Extract clean prompt text from ACP params supporting string, ContentBlock[], or nested structures.
 */
export function extractPromptText(params?: Record<string, unknown>): string {
  if (!params) {
    return '';
  }
  const prompt = params.prompt ?? params.message ?? params.text;
  if (typeof prompt === 'string') {
    return prompt;
  }
  if (Array.isArray(prompt)) {
    return prompt
      .map((block: unknown) => {
        if (typeof block === 'string') {
          return block;
        }
        if (block && typeof block === 'object') {
          const rec = block as Record<string, unknown>;
          if (typeof rec.text === 'string') {
            return rec.text;
          }
          if (typeof rec.content === 'string') {
            return rec.content;
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (prompt && typeof prompt === 'object') {
    const rec = prompt as Record<string, unknown>;
    if (typeof rec.text === 'string') {
      return rec.text;
    }
    if (typeof rec.content === 'string') {
      return rec.content;
    }
  }
  return '';
}

// ============================================================================
// 5.1 ONE TURN, STEP BY STEP
// A turn is model calls (callModel) and the tool calls each answer asks for (executeToolCalls), until the model answers
// without a tool call, the circuit breaker trips, or the iteration limit is reached.
// ============================================================================

/** What the steps of one turn share: the request being answered, its session and its trace. */
interface TurnContext {
  id: string | number | undefined;
  sessionId: string;
  session: Session;
  turnHandle: TurnSpanHandle | undefined;
}

/** One model call's answer: what streamed in, the assistant message built from it, and its LLM span, still open. */
interface ModelAnswer {
  accumulator: StreamAccumulator;
  assistantMsg: ChatMessage;
  llmSpan: LlmSpanHandle | undefined;
}

/** session/cancel aborts the turn's controller and clears it. */
function wasCancelled(session: Session): boolean {
  return Boolean(session.abortController?.signal?.aborted) || !session.abortController;
}

/** A cancelled turn makes no further call. */
function throwIfCancelled(session: Session): void {
  if (wasCancelled(session)) {
    throw new Error('Turn was aborted by cancellation signal.');
  }
}

/**
 * One streamed chat-completions call on the session's messages. Text and reasoning deltas go out as session/update.
 * Throws when the key is missing, the API refuses the request, or the stream breaks or is cancelled.
 */
async function callModel(
  ctx: TurnContext,
  tools: OpenAIFunctionTool[],
  iteration: number,
  options?: LlmSpanOptions
): Promise<ModelAnswer> {
  const { session, sessionId, turnHandle } = ctx;
  const llmSpan = turnHandle?.startLlmSpan(MODEL, iteration, options);

  // Prepare messages for DeepSeek API: preserve reasoning_content (CoT Invariant)
  const messagesPayload = session.messages.map((m) => {
    const msg: ChatMessage = {
      role: m.role,
      content: m.content
    };
    if (m.reasoning_content) {
      msg.reasoning_content = m.reasoning_content;
    }
    if (m.tool_calls) {
      msg.tool_calls = m.tool_calls;
    }
    if (m.tool_call_id) {
      msg.tool_call_id = m.tool_call_id;
    }
    return msg;
  });

  if (!DEEPSEEK_API_KEY) {
    throw new Error('DEEPSEEK_API_KEY is missing or empty. Cannot authenticate with DeepSeek API.');
  }

  // Call DeepSeek Chat Completions with Streaming (request timeout: DEEPSEEK_REQUEST_TIMEOUT_MS, default 90s)
  const requestTimeoutMs = REQUEST_TIMEOUT.timeoutMs;
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  const combinedSignal = session.abortController
    ? AbortSignal.any([session.abortController.signal, timeoutSignal])
    : timeoutSignal;

  const requestBody = {
    model: MODEL,
    messages: messagesPayload,
    tools: tools && tools.length > 0 ? tools : undefined,
    temperature: TEMPERATURE,
    // thinking / reasoning_effort: only present when DEEPSEEK_THINKING / DEEPSEEK_REASONING_EFFORT are set.
    ...REASONING.params,
    stream: true,
    stream_options: { include_usage: true }
  };
  // OTEL_CAPTURE_LLM_MESSAGES: recorded before the request, so a failed request still shows what was sent.
  llmSpan?.recordRequest(requestBody);

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify(requestBody),
    signal: combinedSignal
  });

  if (!response.ok) {
    const errorText = await response.text();
    llmSpan?.end(undefined, `DeepSeek API error (HTTP ${response.status.toString()}): ${errorText}`);
    throw new Error(`DeepSeek API error (HTTP ${response.status.toString()}): ${errorText}`);
  }

  // Stream accumulator for 3-phase events
  let accumulator: StreamAccumulator | null = null;

  try {
    for await (const event of parseSSEStream(response.body, requestTimeoutMs)) {
      if (session.abortController?.signal?.aborted || !session.abortController) {
        recordPartialAnswer(llmSpan, event.accumulator as StreamAccumulator);
        llmSpan?.end(undefined, 'Stream aborted by client cancellation.');
        throw new Error('Stream aborted by client cancellation.');
      }

      if (event.type === 'delta') {
        if (event.reasoningDelta) {
          sendNotification('session/update', {
            sessionId,
            delta: {
              type: 'thought',
              text: event.reasoningDelta
            }
          });
        }
        if (event.contentDelta) {
          sendNotification('session/update', {
            sessionId,
            delta: {
              type: 'text',
              text: event.contentDelta
            }
          });
        }
      }
      if (event.accumulator) {
        accumulator = event.accumulator as StreamAccumulator;
      }
    }
  } catch (streamErr: unknown) {
    // The stream broke half-way (read timeout, reset): the turn's end closes this span; keep what had arrived.
    recordPartialAnswer(llmSpan, accumulator);
    throw streamErr;
  }

  if (!accumulator) {
    accumulator = new StreamAccumulator();
  }

  if (accumulator.usage) {
    llmSpan?.recordUsage(accumulator.usage);
    turnHandle?.recordUsage(accumulator.usage);
  }

  // Build assistant message
  const assistantMsg: ChatMessage = {
    role: 'assistant',
    content: accumulator.content || null
  };

  if (accumulator.reasoningContent) {
    assistantMsg.reasoning_content = accumulator.reasoningContent;
  }
  return { accumulator, assistantMsg, llmSpan };
}

/**
 * Truncated Stream / Synthetic Tool Error: the answer stopped at the token limit (finish_reason === 'length') in the
 * middle of its tool calls. None of them runs; each gets an error result so the model can self-correct.
 */
function recordTruncatedToolCalls(ctx: TurnContext, answer: ModelAnswer): void {
  const { accumulator, assistantMsg, llmSpan } = answer;
  console.warn(`[SAFE STREAM] finish_reason === 'length' on tool call. Injecting synthetic tool error.`);
  llmSpan?.recordOutput({ content: accumulator.content || null, tool_calls: accumulator.toolCalls });
  llmSpan?.end(undefined, 'Tool execution truncated due to token limits.');
  assistantMsg.tool_calls = accumulator.toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function',
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments
    }
  }));
  ctx.session.messages.push(assistantMsg);

  for (const tc of accumulator.toolCalls) {
    ctx.session.messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify({
        error: 'Tool execution truncated due to token limits. Do not execute partial command; please simplify or break down your request.'
      })
    });
  }

  sendNotification('session/update', {
    sessionId: ctx.sessionId,
    delta: {
      type: 'text',
      text: '\n\n*(Notice: Output reached max token length. Incomplete tool parameters have been safeguarded.)*'
    }
  });
}

/** An answer without tool calls: the model's last word in the turn. */
function recordFinalAnswer(ctx: TurnContext, answer: ModelAnswer): void {
  const { accumulator, assistantMsg, llmSpan } = answer;
  llmSpan?.recordOutput({ content: accumulator.content || null });
  llmSpan?.end(accumulator.content || undefined);
  ctx.session.messages.push(assistantMsg);
}

/** An answer with tool calls: close its LLM span before the tools run. */
function recordToolCallAnswer(ctx: TurnContext, answer: ModelAnswer, toolCalls: ToolCall[]): void {
  const { accumulator, assistantMsg, llmSpan } = answer;
  llmSpan?.recordOutput({ content: accumulator.content || null, tool_calls: toolCalls });
  llmSpan?.end(accumulator.content || undefined);
  assistantMsg.tool_calls = toolCalls;
  ctx.session.messages.push(assistantMsg);
}

/** The breaker tripped on `toolName`: say so on stderr and in the update stream. */
function reportBreakerTrip(ctx: TurnContext, toolName: string, breaker: ToolErrorBreaker): void {
  console.warn(`[CIRCUIT BREAKER] Aborting turn: 2 identical tool errors in a row for '${toolName}'.`);
  sendNotification('session/update', {
    sessionId: ctx.sessionId,
    delta: {
      type: 'text',
      text: `\n\n*(Notice: Tool execution loop aborted because 2 identical tool errors occurred in a row: ${breaker.lastError ?? ''})*`
    }
  });
}

/**
 * ACP `tool_call`: a tool call starts. buzz-acp restarts its idle clock on it — a turn that only calls tools (a meeting
 * call's meeting_wait loop) wrote nothing else to stdout — and records an agent step for the owner. Title only: the
 * arguments never leave the adapter this way.
 */
function sendToolCallStarted(sessionId: string, toolCallId: string, name: string): void {
  sendNotification('session/update', {
    sessionId,
    update: { sessionUpdate: 'tool_call', toolCallId, title: name.slice(0, 64), kind: 'other', status: 'in_progress' }
  });
}

/** ACP `tool_call_update`: the call ended, `failed` when its result is an error or it did not run. */
function sendToolCallFinished(sessionId: string, toolCallId: string, failed: boolean): void {
  sendNotification('session/update', {
    sessionId,
    update: { sessionUpdate: 'tool_call_update', toolCallId, status: failed ? 'failed' : 'completed' }
  });
}

/** A tool call that does not run (malformed arguments, a tool the wrap-up does not offer): a failed span and result. */
function recordUnrunCall(ctx: TurnContext, tc: ToolCall, errorMsg: string): void {
  sendToolCallStarted(ctx.sessionId, tc.id, tc.function.name);
  ctx.turnHandle?.startToolSpan(tc.id, tc.function.name, tc.function.arguments);
  ctx.turnHandle?.endToolSpan(tc.id, JSON.stringify({ error: errorMsg }), true, tc.function.name);
  ctx.session.messages.push({
    role: 'tool',
    tool_call_id: tc.id,
    content: JSON.stringify({ error: errorMsg })
  });
  sendToolCallFinished(ctx.sessionId, tc.id, true);
}

/**
 * Runs one answer's tool calls in order through MCP, each result appended as a tool message. Circuit breaker: when a
 * result makes 2 identical tool errors in a row, the rest do not run and get a synthetic error result instead (every
 * tool call must have a result), and `tripped` is true. In a wrap-up, a call `refuse` matches (a repeat of a call that
 * tripped the breaker) does not run. `executed` counts the calls MCP ran; `posted` says one of them posted a Buzz message.
 */
async function executeToolCalls(
  ctx: TurnContext,
  toolCalls: ToolCall[],
  breaker: ToolErrorBreaker,
  refuse: ((tc: ToolCall) => boolean) | null = null
): Promise<{ tripped: boolean; executed: number; posted: boolean }> {
  const { session, sessionId, turnHandle } = ctx;
  let tripped = false;
  let executed = 0;
  let posted = false;
  const executedToolCallIds = new Set<string>();

  for (const tc of toolCalls) {
    if (refuse?.(tc)) {
      console.warn(`[WRAP-UP] Not running ${tc.function.name}: the same call already failed twice in a row.`);
      const errorMsg = refusedToolError(tc.function.name);
      recordUnrunCall(ctx, tc, errorMsg);
      executedToolCallIds.add(tc.id);
      if (breaker.record(tc.function.name, tc.function.arguments, errorMsg)) {
        reportBreakerTrip(ctx, tc.function.name, breaker);
        tripped = true;
        break;
      }
      continue;
    }

    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
    } catch (parseErr: unknown) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      console.warn(`JSON parse error on tool arguments for ${tc.function.name}: ${msg}`);
      const errorMsg = `Tool execution truncated due to token limits: malformed JSON arguments (${msg})`;
      recordUnrunCall(ctx, tc, errorMsg);
      executedToolCallIds.add(tc.id);

      if (breaker.record(tc.function.name, tc.function.arguments, errorMsg)) {
        reportBreakerTrip(ctx, tc.function.name, breaker);
        tripped = true;
        break;
      }
      continue;
    }

    const argsPreview = JSON.stringify(parsedArgs).slice(0, 150);
    console.info(`Executing tool via MCP: ${tc.function.name} args: ${argsPreview}`);
    sendToolCallStarted(sessionId, tc.id, tc.function.name);
    turnHandle?.startToolSpan(tc.id, tc.function.name, parsedArgs);
    const toolResult = await mcpClient.callTool(tc.function.name, parsedArgs);
    console.info(`Tool ${tc.function.name} output: ${toolResult.slice(0, 150).replace(/\n/g, ' ')}`);
    executed++;

    session.messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: toolResult
    });
    executedToolCallIds.add(tc.id);

    // Check if output represents a tool error
    let errorString: string | null = null;
    try {
      const parsedOut = JSON.parse(toolResult) as { error?: unknown };
      if (parsedOut && parsedOut.error) {
        errorString = typeof parsedOut.error === 'string' ? parsedOut.error : JSON.stringify(parsedOut.error);
      }
    } catch {
      // Ignored
    }

    turnHandle?.endToolSpan(tc.id, toolResult, Boolean(errorString), tc.function.name);
    sendToolCallFinished(sessionId, tc.id, Boolean(errorString));
    if (!errorString && extractPostedEventId(toolResult)) {
      posted = true;
    }

    if (breaker.record(tc.function.name, tc.function.arguments, errorString)) {
      reportBreakerTrip(ctx, tc.function.name, breaker);
      tripped = true;
      break;
    }
  }

  if (tripped) {
    // Ensure any remaining unexecuted tool calls have synthetic error responses injected
    for (const tc of toolCalls) {
      if (!executedToolCallIds.has(tc.id)) {
        session.messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({
            error: 'Tool execution aborted: loop breaker stopped execution before this tool could run. (circuit breaker stopped execution before this tool could run)'
          })
        });
        executedToolCallIds.add(tc.id);
      }
    }
    console.warn(`Circuit breaker triggered for session ${sessionId}. Ending turn.`);
  }
  return { tripped, executed, posted };
}

/**
 * The wrap-up of a turn the adapter stopped (src/turn-stop.ts): up to ACP_WRAPUP_ITERATIONS more model calls after a
 * notice that says why, so the model tells the person who asked. Every tool stays offered, but a repeat of a call that
 * tripped the breaker does not run; it ends at the budget, on an answer without tool calls, on a posted message or when
 * its own breaker trips. A failed call ends it and keeps what already ran; a cancel goes to the turn's cancel path.
 */
async function runWrapup(
  ctx: TurnContext,
  stop: TurnStop,
  tools: OpenAIFunctionTool[],
  iteration: number
): Promise<{ iterations: number; toolCalls: number }> {
  const budget = WRAPUP.iterations;
  if (budget === 0) {
    return { iterations: 0, toolCalls: 0 };
  }
  const { session, sessionId } = ctx;
  const refuse = (tc: ToolCall): boolean => isRepeatOfFailedCall(stop, tc.function.name, tc.function.arguments);
  const notice: ChatMessage = { role: 'user', content: wrapupNotice(stop) };
  session.messages.push(notice);
  console.info(
    `[WRAP-UP] Session ${sessionId}: ${describeTurnStop(stop)}; giving the model up to ${budget.toString()} call(s) ` +
      'to tell the person.'
  );

  const breaker = new ToolErrorBreaker();
  let calls = 0;
  let toolCalls = 0;
  let posted = false;
  try {
    while (calls < budget) {
      throwIfCancelled(session);
      calls++;
      console.info(`Wrap-up call ${calls.toString()}/${budget.toString()} for session ${sessionId}`);
      const answer = await callModel(ctx, tools, iteration + calls, { wrapup: true });

      if (answer.accumulator.isTruncated() && answer.accumulator.toolCalls.length > 0) {
        recordTruncatedToolCalls(ctx, answer);
        continue;
      }
      const validToolCalls: ToolCall[] = answer.accumulator.getValidToolCalls();
      if (validToolCalls.length === 0) {
        recordFinalAnswer(ctx, answer);
        break;
      }
      recordToolCallAnswer(ctx, answer, validToolCalls);
      const run = await executeToolCalls(ctx, validToolCalls, breaker, refuse);
      toolCalls += run.executed;
      if (run.posted) {
        // The person has been told: another call could only post twice.
        posted = true;
        break;
      }
      if (run.tripped) {
        break;
      }
    }
  } catch (err: unknown) {
    if (wasCancelled(session)) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[WRAP-UP] Session ${sessionId}: the wrap-up failed (${msg}); ending the turn without it.`);
    // A notice nothing answered would stay a user message that the next prompt follows: take it out.
    const at = session.messages.indexOf(notice);
    if (at !== -1 && !session.messages.slice(at + 1).some((message) => message.role === 'assistant')) {
      session.messages.splice(at, 1);
    }
  }
  console.info(
    `[WRAP-UP] Session ${sessionId}: ended after ${calls.toString()} call(s), ${toolCalls.toString()} tool call(s)` +
      `${posted ? ', posted' : ''}.`
  );
  return { iterations: calls, toolCalls };
}

/**
 * Ends a turn the adapter stopped: committed, answered with an ACP stop reason, and traced as failed — the model did not
 * finish it, whatever the wrap-up said (agent-infra #49: these turns showed as OK in Phoenix).
 */
function endStoppedTurn(ctx: TurnContext, stop: TurnStop, wrapup: { iterations: number }): void {
  const { id, session, sessionId, turnHandle } = ctx;
  // A cancel that came while the last tool call ran (the turn's or the wrap-up's) must roll the turn back, not commit
  // the result that call pushed onto the restored history: the turn's catch does that.
  throwIfCancelled(session);
  session.commit();
  const content = stopMessageOf(stop);
  turnHandle?.recordWrapup(wrapup.iterations);
  turnHandle?.end('ERROR', content, stop.reason, describeTurnStop(stop));
  void telemetryService?.backgroundFlush();

  // Only ACP stop reasons are valid here: buzz-acp answers any other value ("unknown stopReason") with a
  // protocol error that kills and respawns this process. An exhausted iteration budget is `max_turn_requests`;
  // a circuit-breaker stop is a normal, committed end of turn.
  sendResponse(id, {
    sessionId,
    message: {
      role: 'assistant',
      content
    },
    stopReason: stopReasonOf(stop)
  });
  sendNotification('session/turnComplete', { sessionId });
}

/**
 * Handle ACP session/prompt execution with multi-turn tool loops.
 */
async function handleSessionPrompt(id?: string | number, params?: Record<string, unknown>): Promise<void> {
  const sessionId = (params?.sessionId as string) || `session-${Date.now().toString()}`;
  const promptText = extractPromptText(params);

  let session = sessions.get(sessionId);
  if (!session) {
    session = new Session(sessionId);
    sessions.set(sessionId, session);
  }

  // Guard against concurrent session/prompt calls on the same session
  if (session.activePromptId) {
    sendResponse(id, null, {
      code: -32000,
      message: `Session ${sessionId} is busy processing prompt ${String(session.activePromptId)}`
    });
    return;
  }

  // Transactional Snapshot BEFORE prompt execution
  session.takeSnapshot();
  session.abortController = new AbortController();
  session.activePromptId = id ?? null;

  session.messages.push({ role: 'user', content: promptText });

  const nostrMeta = parseNostrContext(promptText);
  const turnHandle: TurnSpanHandle | undefined = telemetryService?.startTurnSpan(
    sessionId,
    promptText,
    MODEL,
    nostrMeta
  );
  session.activeTurnHandle = turnHandle ?? null;
  const ctx: TurnContext = { id, sessionId, session, turnHandle };

  const maxIterations = ITERATION_LIMIT.limit;
  let iteration = 0;
  // Set when the breaker stops the loop; a loop that ends otherwise has used every iteration.
  let stop: TurnStop | null = null;

  try {
    const tools = await mcpClient.getTools();
    // Circuit breaker: 2 identical tool errors in a row, counted across the turn's iterations.
    const breaker = new ToolErrorBreaker();

    while (iteration < maxIterations) {
      throwIfCancelled(session);

      iteration++;
      console.info(`Turn iteration ${iteration.toString()}/${maxIterations.toString()} for session ${sessionId}`);
      const answer = await callModel(ctx, tools, iteration);

      if (answer.accumulator.isTruncated() && answer.accumulator.toolCalls.length > 0) {
        // Let model self-correct on next turn iteration
        recordTruncatedToolCalls(ctx, answer);
        continue;
      }

      const validToolCalls: ToolCall[] = answer.accumulator.getValidToolCalls();

      // No tool calls means the model produced its final response text
      if (validToolCalls.length === 0) {
        recordFinalAnswer(ctx, answer);
        session.commit();

        const content = answer.accumulator.content || '';
        turnHandle?.end('OK', content);
        void telemetryService?.backgroundFlush();

        sendResponse(id, {
          sessionId,
          message: {
            role: 'assistant',
            content
          },
          stopReason: 'end_turn'
        });
        sendNotification('session/turnComplete', { sessionId });
        return;
      }

      // Tool calls were produced: close current iteration's LLM span before executing tools
      recordToolCallAnswer(ctx, answer, validToolCalls);
      const { tripped } = await executeToolCalls(ctx, validToolCalls, breaker);
      if (tripped) {
        stop = breakerStop(breaker);
        break;
      }
    }

    // The model did not finish the turn: the breaker stopped it, or it used every iteration of it.
    const stopped: TurnStop = stop ?? { reason: 'iteration_limit', limit: maxIterations };
    if (stopped.reason === 'iteration_limit') {
      console.warn(
        `[ITERATION LIMIT] Session ${sessionId} used all ${maxIterations.toString()} iterations of the turn. ` +
          'Ending it with stopReason max_turn_requests.'
      );
      sendNotification('session/update', {
        sessionId,
        delta: {
          type: 'text',
          text: `\n\n*(Notice: iteration limit of ${maxIterations.toString()} reached; the turn was stopped.)*`
        }
      });
    }
    const wrapup = await runWrapup(ctx, stopped, tools, iteration);
    endStoppedTurn(ctx, stopped, wrapup);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Turn execution error in session ${sessionId}: ${msg}`);

    // Rollback session state on error
    session.rollback();

    const isCancelled =
      session.abortController?.signal?.aborted ||
      (err instanceof Error && (err.name === 'AbortError' || err.message.includes('cancellation')));

    if (isCancelled) {
      turnHandle?.end('CANCELLED');
    } else {
      turnHandle?.end('ERROR', undefined, 'turn_failed', msg);
    }
    void telemetryService?.backgroundFlush();

    sendNotification('session/update', {
      sessionId,
      delta: {
        type: 'text',
        text: `⚠️ **DeepSeek Agent Notice:** Encountered an error during processing: ${msg}. Conversation state has been restored to last stable checkpoint.`
      }
    });

    // Known deviation, left as is: `error` is not an ACP stop reason. buzz-acp treats it as a protocol error and
    // answers by respawning this process and re-queueing the prompt with backoff, which is the retry that transient
    // API failures (HTTP 429/5xx, timeouts) currently get. Moving to a JSON-RPC error needs that retry decided first.
    sendResponse(id, {
      sessionId,
      message: {
        role: 'assistant',
        content: `Error: ${msg}`
      },
      stopReason: 'error'
    });
    sendNotification('session/turnComplete', { sessionId });
  } finally {
    session.abortController = null;
    session.activePromptId = null;
    session.activeTurnHandle = null;
  }
}

/**
 * Handle ACP _session/steering requests (mid-turn follow-up injection).
 */
function handleSessionSteering(id?: string | number, params?: Record<string, unknown>): void {
  const sessionId = (params?.sessionId as string) || '';
  const session = sessionId ? sessions.get(sessionId) : undefined;
  const promptText = extractPromptText(params);

  if (!session || !session.activePromptId) {
    // Session is idle or has no running turn
    sendResponse(id, {
      outcome: 'promptRequired',
      reason: 'noRunningTurn'
    });
    return;
  }

  // Active turn in flight: parse nostr context and record steer child span
  const nostrMeta = parseNostrContext(promptText);
  if (session.activeTurnHandle) {
    session.activeTurnHandle.recordSteerSpan({
      eventId: nostrMeta.eventId,
      text: promptText,
      senderName: nostrMeta.senderName,
      senderPubkey: nostrMeta.senderPubkey,
      priority: 'now'
    });
  }

  // Inject into active turn messages for the model's next iteration
  const steerHeader = '[New message — arrived while you were working]';
  const steerFormatted = `${steerHeader}\n${promptText}`;
  session.messages.push({ role: 'user', content: steerFormatted });

  console.info(`[STEER] Injected steered message into active session ${sessionId} (event: ${nostrMeta.eventId ?? 'unknown'})`);

  sendResponse(id, { outcome: 'injected' });
}

// ============================================================================
// 6. PROCESS STDIN LISTENER
// ============================================================================
const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

rl.on('line', (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  try {
    const rpc = JSON.parse(trimmed) as JSONRPCRequest;
    void handleRpcMessage(rpc);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Invalid JSON-RPC frame: ${msg}`);
  }
});

const shutdown = async (signal?: string): Promise<void> => {
  if (signal) {
    console.info(`Received ${signal}, closing...`);
  } else {
    console.info('Stdin closed. Shutting down adapter...');
  }
  try {
    await mcpClient.close();
  } catch (err: unknown) {
    console.error('Error during MCP client close:', err);
  }
  try {
    if (telemetryService) {
      await telemetryService.shutdown();
    }
  } catch (err: unknown) {
    console.error('Error during telemetry shutdown:', err);
  }
  process.exit(0);
};

rl.on('close', () => {
  void shutdown();
});

// Handle graceful termination signals
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
