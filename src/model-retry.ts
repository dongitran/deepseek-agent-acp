/**
 * model-retry.ts — Pure rules for sending a failed model call again.
 *
 * A meeting twin's whole call is one ACP turn of hundreds of model calls. A turn that fails is rolled back and answered
 * `error`, which buzz-acp answers by respawning the adapter: the twin leaves the call and loses its context. So a call
 * that fails in a way that may pass (the API busy or down, the connection lost, no answer in time) is sent again, a
 * few times, after a short wait — but only while nothing of it has reached the client. Nothing a failed call returned
 * is applied (its tool calls run only once its stream has ended), so a retry never repeats a tool call or a message;
 * text it had streamed has been shown, and a retry would show it twice.
 *
 * Side-effect-free (no logging, no environment, no timers), like config.ts and turn-stop.ts.
 */

import { FirstEventTimeoutError, StreamReadTimeoutError } from './sse-parser.js';

/** The wait before the first retry; each next one waits twice as long (1 s, 2 s, 4 s, …). */
export const RETRY_BASE_DELAY_MS = 1_000;

/** The API refused or failed the request: its HTTP status and the error text it sent. */
export class ModelHttpError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ModelHttpError';
    this.status = status;
  }
}

/** No response headers came within DEEPSEEK_REQUEST_TIMEOUT_MS. */
export class ModelTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`DeepSeek API request timeout: no response within ${timeoutMs.toString()} ms (DEEPSEEK_REQUEST_TIMEOUT_MS)`);
    this.name = 'ModelTimeoutError';
  }
}

/**
 * The response ended before any useful event: no text, reasoning, tool call or finish, at most metadata (every
 * DeepSeek stream opens with a role-only chunk) and keep-alive comments. DeepSeek closes a request it held this way if
 * inference has not started within 10 minutes; such a close is a failed attempt, never an empty answer.
 */
export class ModelEmptyStreamError extends Error {
  constructor() {
    super('DeepSeek API stream ended before any data of an answer (no text, reasoning, tool call or finish_reason)');
    this.name = 'ModelEmptyStreamError';
  }
}

/**
 * Statuses worth another try: 408 (request timeout), 429 (rate limit) and 5xx (DeepSeek's 500 server error and 503
 * overloaded, and a gateway's 502 or 504). A 400, 401, 402 or 422 is about the request or the account: the same request
 * fails the same way again.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * A failure that may pass: a retryable HTTP status, no response in time, a stream that went silent, gave no useful
 * event in time or ended before one, or the connection lost — undici's fetch rejects with `TypeError: fetch failed`
 * before the response and `TypeError: terminated` when the body is cut. Anything else (a missing key, a cancel) is not
 * sent again.
 */
export function isRetryableModelError(err: unknown): boolean {
  if (err instanceof ModelHttpError) {
    return isRetryableStatus(err.status);
  }
  if (
    err instanceof ModelTimeoutError ||
    err instanceof StreamReadTimeoutError ||
    err instanceof FirstEventTimeoutError ||
    err instanceof ModelEmptyStreamError
  ) {
    return true;
  }
  return err instanceof TypeError && (err.message === 'fetch failed' || err.message === 'terminated');
}

/**
 * A stall: the model never started — no useful event within DEEPSEEK_FIRST_EVENT_TIMEOUT_MS, or a stream that ended
 * without one. Unlike a lost connection or an HTTP error, sending it to the same model again only queues it again:
 * src/model-route.ts sends it to DEEPSEEK_FALLBACK_MODEL when one is set.
 */
export function isStall(err: unknown): boolean {
  return err instanceof FirstEventTimeoutError || err instanceof ModelEmptyStreamError;
}

/** The wait (ms) before retry number `retry` (1 for the first). */
export function retryDelayMs(retry: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retry - 1);
}
