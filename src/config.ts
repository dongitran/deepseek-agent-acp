/**
 * config.ts — Pure, side-effect-free resolution of the adapter's non-secret settings from the environment.
 *
 * Every function takes the environment as an argument and returns the resolved value together with the
 * warnings the caller should log, so the rules are unit-testable without spawning the adapter.
 * Invalid input never throws: it falls back to the documented default and produces a warning that names
 * the offending variable (a silently ignored setting is how a "zero thinking" agent kept thinking).
 */

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * DEEPSEEK_* variables that are settings, not secrets. loadSecretKey() purges every other DEEPSEEK_* variable
 * from process.env (default-deny, so an unknown variable is never exposed to child processes); a new setting
 * must be listed here to survive that purge.
 */
export const PRESERVED_DEEPSEEK_CONFIG: ReadonlySet<string> = new Set([
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_TEMPERATURE',
  'DEEPSEEK_THINKING',
  'DEEPSEEK_REASONING_EFFORT',
  'DEEPSEEK_REQUEST_TIMEOUT_MS',
  'DEEPSEEK_MAX_RETRIES'
]);

// ============================================================================
// Thinking / reasoning effort
// ============================================================================

const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** Fields merged into the chat-completions request body. Empty means "leave the API default". */
export interface ReasoningRequestParams {
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: ReasoningEffort;
}

export interface ReasoningResolution {
  params: ReasoningRequestParams;
  warnings: string[];
}

function normalized(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * DEEPSEEK_THINKING        `enabled` | `disabled`          → thinking: { type }
 * DEEPSEEK_REASONING_EFFORT `none` | minimal … max | ultra  → `none` disables thinking, any other level is
 *                                                            sent as reasoning_effort
 *
 * Nothing is sent unless it is configured, so endpoints that reject unknown fields keep working. Disabling
 * thinking always wins over an effort level (a disabled model has no effort to set).
 */
export function resolveReasoningParams(env: Env): ReasoningResolution {
  const warnings: string[] = [];
  const thinkingRaw = normalized(env.DEEPSEEK_THINKING);
  const effortRaw = normalized(env.DEEPSEEK_REASONING_EFFORT);

  let thinking: 'enabled' | 'disabled' | undefined;
  if (thinkingRaw === 'enabled' || thinkingRaw === 'disabled') {
    thinking = thinkingRaw;
  } else if (thinkingRaw !== '') {
    warnings.push(
      `Ignoring DEEPSEEK_THINKING="${thinkingRaw}": expected "enabled" or "disabled"; the API default applies.`
    );
  }

  let effort: ReasoningEffort | 'none' | undefined;
  if (effortRaw === 'none' || isReasoningEffort(effortRaw)) {
    effort = effortRaw;
  } else if (effortRaw !== '') {
    warnings.push(
      `Ignoring DEEPSEEK_REASONING_EFFORT="${effortRaw}": expected "none" or one of ${REASONING_EFFORTS.join(', ')}; the API default applies.`
    );
  }

  if (thinking === 'disabled' || effort === 'none') {
    if (thinking === 'enabled' && effort === 'none') {
      warnings.push('DEEPSEEK_THINKING=enabled conflicts with DEEPSEEK_REASONING_EFFORT=none; thinking stays disabled.');
    }
    if (thinking === 'disabled' && effort !== undefined && effort !== 'none') {
      warnings.push(`DEEPSEEK_REASONING_EFFORT=${effort} is ignored because DEEPSEEK_THINKING=disabled.`);
    }
    return { params: { thinking: { type: 'disabled' } }, warnings };
  }

  const params: ReasoningRequestParams = {};
  if (thinking === 'enabled') {
    params.thinking = { type: 'enabled' };
  }
  if (effort !== undefined) {
    params.reasoning_effort = effort;
  }
  return { params, warnings };
}

/** Short, log-friendly summary of what the request will say about thinking, e.g. `disabled` or `api-default`. */
export function describeReasoning(params: ReasoningRequestParams): string {
  const parts: string[] = [];
  if (params.thinking) {
    parts.push(params.thinking.type);
  }
  if (params.reasoning_effort) {
    parts.push(`effort:${params.reasoning_effort}`);
  }
  return parts.length > 0 ? parts.join('+') : 'api-default';
}

// ============================================================================
// Positive-integer settings
// ============================================================================

/** Strict positive decimal integer; rejects "10abc", "1.5", "1e3", "0" and "-5" that parseInt would half-accept. */
export function parsePositiveInt(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export const DEFAULT_ITERATION_LIMIT = 15;
export const CODER_ITERATION_LIMIT = 25;

export interface IterationLimitResolution {
  limit: number;
  source: 'ACP_MAX_ITERATIONS' | 'BUZZ_MAX_ITERATIONS' | 'default';
  warnings: string[];
}

/**
 * Maximum model calls (tool-loop iterations) in one session/prompt turn.
 * ACP_MAX_ITERATIONS wins over BUZZ_MAX_ITERATIONS; without either the default is 25 for coder/builder
 * agents and 15 otherwise. A long-lived loop such as a meeting call spends one iteration per tool call, so
 * agents that stay in one turn for minutes must raise it.
 */
export function resolveIterationLimit(env: Env, model: string): IterationLimitResolution {
  const warnings: string[] = [];
  for (const name of ['ACP_MAX_ITERATIONS', 'BUZZ_MAX_ITERATIONS'] as const) {
    const raw = (env[name] ?? '').trim();
    if (raw === '') {
      continue;
    }
    const value = parsePositiveInt(raw);
    if (value !== null) {
      return { limit: value, source: name, warnings };
    }
    warnings.push(`Ignoring ${name}="${raw}": expected a positive integer.`);
  }
  const isCoder = model.includes('coder') || env.AGENT_ROLE === 'coder' || env.AGENT_ROLE === 'builder';
  return { limit: isCoder ? CODER_ITERATION_LIMIT : DEFAULT_ITERATION_LIMIT, source: 'default', warnings };
}

/** The longest delay a Node.js timer takes: a longer one fires after 1 ms instead (TimeoutOverflowWarning). */
export const MAX_TIMER_MS = 2_147_483_647;

export interface TimeoutResolution {
  timeoutMs: number;
  warnings: string[];
}

/** A timeout setting in ms: a positive integer a timer can hold, else `fallback` and a warning naming `name`. */
function resolveTimeoutMs(env: Env, name: string, fallback: number): TimeoutResolution {
  const raw = (env[name] ?? '').trim();
  if (raw === '') {
    return { timeoutMs: fallback, warnings: [] };
  }
  const value = parsePositiveInt(raw);
  if (value === null || value > MAX_TIMER_MS) {
    return {
      timeoutMs: fallback,
      warnings: [
        `Ignoring ${name}="${raw}": expected a positive integer up to ${MAX_TIMER_MS.toString()}; ` +
          `using ${fallback.toString()} ms.`
      ]
    };
  }
  return { timeoutMs: value, warnings: [] };
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

/**
 * DEEPSEEK_REQUEST_TIMEOUT_MS: how long one chat-completions call may wait for its response (ms), and then for each
 * next piece of its stream. It bounds silence, not the whole answer: a stream that keeps coming, keep-alive comments
 * included, is never cut, and DeepSeek holds a request open with keep-alives while it is busy.
 */
export function resolveRequestTimeoutMs(env: Env): TimeoutResolution {
  return resolveTimeoutMs(env, 'DEEPSEEK_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS);
}

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/**
 * MCP_TOOL_TIMEOUT_MS: how long one MCP tool call may run (ms). At that bound the call ends with an error and the MCP
 * server is told to stop it (notifications/cancelled). It is the MCP request's own timeout: the SDK ends a request it
 * is given without one at its default of 60 s, which used to cut every longer setting to 60 s.
 */
export function resolveToolTimeoutMs(env: Env): TimeoutResolution {
  return resolveTimeoutMs(env, 'MCP_TOOL_TIMEOUT_MS', DEFAULT_TOOL_TIMEOUT_MS);
}

export const DEFAULT_MAX_RETRIES = 2;
export const MAX_MAX_RETRIES = 5;

export interface MaxRetriesResolution {
  retries: number;
  warnings: string[];
}

/**
 * DEEPSEEK_MAX_RETRIES: how many more times one model call is sent after a failure that may pass (src/model-retry.ts)
 * and that came before any of its text reached the client. 0 turns retries off, as in 0.5.1; at most 5.
 */
export function resolveMaxRetries(env: Env): MaxRetriesResolution {
  const raw = (env.DEEPSEEK_MAX_RETRIES ?? '').trim();
  if (raw === '') {
    return { retries: DEFAULT_MAX_RETRIES, warnings: [] };
  }
  const value = raw === '0' ? 0 : parsePositiveInt(raw);
  if (value === null || value > MAX_MAX_RETRIES) {
    return {
      retries: DEFAULT_MAX_RETRIES,
      warnings: [
        `Ignoring DEEPSEEK_MAX_RETRIES="${raw}": expected an integer from 0 to ${MAX_MAX_RETRIES.toString()}; ` +
          `using ${DEFAULT_MAX_RETRIES.toString()}.`
      ]
    };
  }
  return { retries: value, warnings: [] };
}

export const DEFAULT_WRAPUP_ITERATIONS = 2;
export const MAX_WRAPUP_ITERATIONS = 5;

export interface WrapupIterationsResolution {
  iterations: number;
  warnings: string[];
}

/**
 * ACP_WRAPUP_ITERATIONS: the model calls a turn still gets after the adapter stopped it (circuit breaker, iteration
 * limit), so the model can tell the person why (src/turn-stop.ts). 0 turns the wrap-up off; at most 5, since the
 * wrap-up is a last word, not more work. Two leave room for reading the thread, then replying.
 */
export function resolveWrapupIterations(env: Env): WrapupIterationsResolution {
  const raw = (env.ACP_WRAPUP_ITERATIONS ?? '').trim();
  if (raw === '') {
    return { iterations: DEFAULT_WRAPUP_ITERATIONS, warnings: [] };
  }
  const value = raw === '0' ? 0 : parsePositiveInt(raw);
  if (value === null || value > MAX_WRAPUP_ITERATIONS) {
    return {
      iterations: DEFAULT_WRAPUP_ITERATIONS,
      warnings: [
        `Ignoring ACP_WRAPUP_ITERATIONS="${raw}": expected an integer from 0 to ${MAX_WRAPUP_ITERATIONS.toString()}; ` +
          `using ${DEFAULT_WRAPUP_ITERATIONS.toString()}.`
      ]
    };
  }
  return { iterations: value, warnings: [] };
}
