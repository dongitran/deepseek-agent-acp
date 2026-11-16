/**
 * turn-stop.ts — Pure rules for a turn the adapter stops before the model has finished it: the circuit breaker, what
 * such a turn reports, and the wrap-up that lets the model tell the person why.
 *
 * Why a wrap-up: a client such as buzz-acp relays nothing an agent writes as text. A Buzz agent reaches people only
 * through its tools (a meeting twin's `reply` or `meeting_speak`, a shell agent's `buzz messages send`), so a turn the
 * breaker ends without one more model call ends in silence: the person who asked never learns why (agent-infra #49).
 *
 * Side-effect-free (no logging, no environment), like config.ts, so every rule is unit-testable without the adapter.
 */

/** The same tool failing with the same error this many times in a row stops a turn. */
export const BREAKER_THRESHOLD = 2;

/**
 * Tool errors in a row, whatever their tools and texts, that stop a turn: the bound on a loop over different failing
 * calls (a dead MCP server fails every tool alike), which the repeat rule does not see.
 */
export const BREAKER_ERRORS_IN_A_ROW = 5;

/** The breaker rule that stopped a turn: a repeat (BREAKER_THRESHOLD) or errors in a row (BREAKER_ERRORS_IN_A_ROW). */
export type BreakerRule = 'repeat' | 'errors_in_a_row';

/** A tool call that failed: its tool and its arguments in canonical form (canonicalArgs). */
export interface FailedCall {
  readonly name: string;
  readonly args: string;
}

/**
 * Tool-call arguments in one comparable form: JSON with its keys sorted (array order kept), `{}` for none, and any text
 * that is not JSON as it is, trimmed. The same call written with other spacing or key order is the same call.
 */
export function canonicalArgs(raw: string): string {
  const text = raw.trim();
  if (text === '') {
    return '{}';
  }
  try {
    return JSON.stringify(JSON.parse(text), (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value
    );
  } catch {
    return text;
  }
}

function addOnce(calls: FailedCall[], call: FailedCall): void {
  if (!calls.some((known) => known.name === call.name && known.args === call.args)) {
    calls.push(call);
  }
}

/**
 * The circuit breaker. A streak is one tool failing with one error text in a row: the same error text from another tool
 * starts a new streak (a timeout or "Not connected" reads alike from every tool), and a success ends it. Separately,
 * every error in a row counts, whatever its tool, and a success sets that count back to 0.
 */
export class ToolErrorBreaker {
  private tool: string | null = null;
  private error: string | null = null;
  private count = 0;
  private calls: FailedCall[] = [];
  private errors = 0;
  private failed: FailedCall[] = [];
  private tripped: BreakerRule | null = null;

  /**
   * Records one tool result (`error` null or empty for a success) of the call `toolName` with its raw `args`; true when
   * it makes BREAKER_THRESHOLD identical errors of one tool in a row, or BREAKER_ERRORS_IN_A_ROW errors in a row.
   */
  record(toolName: string, args: string, error: string | null): boolean {
    if (!error) {
      this.tool = null;
      this.error = null;
      this.count = 0;
      this.calls = [];
      this.errors = 0;
      this.failed = [];
      this.tripped = null;
      return false;
    }
    if (toolName === this.tool && error === this.error) {
      this.count++;
    } else {
      this.tool = toolName;
      this.error = error;
      this.count = 1;
      this.calls = [];
    }
    this.errors++;
    const call = { name: toolName, args: canonicalArgs(args) };
    addOnce(this.calls, call);
    addOnce(this.failed, call);
    if (this.count >= BREAKER_THRESHOLD) {
      this.tripped = 'repeat';
    } else if (this.errors >= BREAKER_ERRORS_IN_A_ROW) {
      this.tripped = 'errors_in_a_row';
    }
    return this.tripped !== null;
  }

  /** The rule that tripped the breaker; null while it has not. */
  get rule(): BreakerRule | null {
    return this.tripped;
  }

  /** The error of the current streak; null after a success. */
  get lastError(): string | null {
    return this.error;
  }

  /** The calls that make up the current streak (one tool), each once, in the order they failed. */
  get streakCalls(): readonly FailedCall[] {
    return this.calls;
  }

  /** The tools of those calls, each once. */
  get streakTools(): readonly string[] {
    return [...new Set(this.calls.map((call) => call.name))];
  }

  /** Every call of the current errors in a row, each once, in the order they failed. */
  get failedCalls(): readonly FailedCall[] {
    return this.failed;
  }
}

/** Why the adapter stopped a turn the model had not finished. */
export type TurnStop =
  | {
      readonly reason: 'circuit_breaker';
      readonly rule: BreakerRule;
      readonly tools: readonly string[];
      readonly calls: readonly FailedCall[];
      readonly error: string;
    }
  | { readonly reason: 'iteration_limit'; readonly limit: number };

/**
 * The stop a tripped breaker makes: its rule, the calls that failed (a repeat's streak, or every call of the errors in
 * a row), their tools and the last error.
 */
export function breakerStop(breaker: ToolErrorBreaker): TurnStop {
  const rule = breaker.rule ?? 'repeat';
  const calls = rule === 'errors_in_a_row' ? breaker.failedCalls : breaker.streakCalls;
  return {
    reason: 'circuit_breaker',
    rule,
    tools: [...new Set(calls.map((call) => call.name))],
    calls: [...calls],
    error: breaker.lastError ?? ''
  };
}

/** What tripped the breaker, as the log and the client's notice say it. */
export function describeBreakerRule(rule: BreakerRule | null | undefined): string {
  return rule === 'errors_in_a_row'
    ? `${BREAKER_ERRORS_IN_A_ROW.toString()} tool errors in a row`
    : `${BREAKER_THRESHOLD.toString()} identical tool errors in a row`;
}

/** One line for the log and the turn span's error.message. */
export function describeTurnStop(stop: TurnStop): string {
  if (stop.reason === 'iteration_limit') {
    return `iteration limit: all ${stop.limit.toString()} model calls of the turn were used (ACP_MAX_ITERATIONS)`;
  }
  const from = stop.tools.length > 0 ? stop.tools.join(', ') : 'a tool';
  return `circuit breaker: ${describeBreakerRule(stop.rule)} from ${from}`;
}

/** The ACP stop reason: buzz-acp answers a value outside the ACP set by respawning the adapter. */
export function stopReasonOf(stop: TurnStop): 'end_turn' | 'max_turn_requests' {
  return stop.reason === 'iteration_limit' ? 'max_turn_requests' : 'end_turn';
}

/** The session/prompt result's text, as 0.4.0 wrote it. */
export function stopMessageOf(stop: TurnStop): string {
  return stop.reason === 'iteration_limit'
    ? `Turn stopped after ${stop.limit.toString()} model iterations (ACP_MAX_ITERATIONS). Send a new message to continue.`
    : 'Turn execution stopped because repetitive tool errors occurred.';
}

// ============================================================================
// The wrap-up
// ============================================================================

/**
 * A wrap-up call that does not run: a repeat — the same tool, the same arguments — of a call that tripped the breaker.
 * Every tool stays offered: the one that failed may be how the agent answers (a shell agent posts with its shell, and
 * the adapter's own tool timeout fails any command the same way), so only the call that failed is barred.
 */
export function isRepeatOfFailedCall(stop: TurnStop, name: string, args: string): boolean {
  if (stop.reason !== 'circuit_breaker') {
    return false;
  }
  const key = canonicalArgs(args);
  return stop.calls.some((call) => call.name === name && call.args === key);
}

/** Opens the notice: the model must read it as the adapter speaking, not as the person. */
export const WRAPUP_NOTICE_HEADER = '[deepseek-agent-acp: this turn is being stopped]';

/** A tool name the notice may quote: a model-made name with anything else in it stays out of a user message. */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

const SEND_IT =
  'Send it the way you normally answer them (for example with your reply tool, or out loud if you are in a call). ' +
  'Do not start any other work. After that message, stop.';

function quoted(names: readonly string[]): string {
  const list = names.map((name) => `\`${name}\``);
  return list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1) ?? ''}`;
}

function breakerSentence(stop: Extract<TurnStop, { reason: 'circuit_breaker' }>): string {
  const safe = stop.tools.filter((name) => SAFE_TOOL_NAME.test(name));
  const dontRepeat = 'The turn is being stopped, so do not repeat them: the same calls will not run again.';
  if (stop.rule === 'errors_in_a_row') {
    const which = safe.length > 0 ? ` (your ${quoted(safe)} calls)` : '';
    return (
      `Your last ${BREAKER_ERRORS_IN_A_ROW.toString()} tool calls failed${which}, one after another (see their ` +
      `results). ${dontRepeat}`
    );
  }
  const which = safe.length > 0 ? `Your ${quoted(safe)} calls` : 'Two of your tool calls';
  return `${which} returned the same error twice in a row (see their last results). ${dontRepeat}`;
}

/**
 * The user-role message the wrap-up adds to the turn. It never quotes the error: that is a tool's output, which must
 * stay data in its tool message and not become an instruction from the user (the model reads it there).
 */
export function wrapupNotice(stop: TurnStop): string {
  if (stop.reason === 'iteration_limit') {
    return [
      WRAPUP_NOTICE_HEADER,
      `This turn has used all of its ${stop.limit.toString()} steps.`,
      'Before the turn ends, tell the person who asked you in one short message in the language of the conversation ' +
        'what you have done so far, what is still left, and that they can send a new message to continue.',
      SEND_IT
    ].join('\n');
  }
  return [
    WRAPUP_NOTICE_HEADER,
    breakerSentence(stop),
    'Before the turn ends, tell the person who asked you what happened, in one short message in the language of the ' +
      'conversation: what you could not do, the reason in plain words, and what they can do now (for example, try ' +
      'again in a few minutes).',
    SEND_IT
  ].join('\n');
}

/** The result of a wrap-up call that did not run because it repeats a call that tripped the breaker under `rule`. */
export function refusedToolError(name: string, rule: BreakerRule = 'repeat'): string {
  const tool = name.slice(0, 64);
  return rule === 'errors_in_a_row'
    ? `Tool ${tool} was not run: the same call already failed, and the turn is being stopped after ` +
        `${BREAKER_ERRORS_IN_A_ROW.toString()} tool errors in a row.`
    : `Tool ${tool} was not run: the same call already failed twice in a row, and the turn is being stopped.`;
}
