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

import { StreamReadTimeoutError } from './sse-parser.js';

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
 * The response ended before any data: no answer, not even its first chunk. DeepSeek holds a request it cannot serve yet
 * open with keep-alive comments and closes it if inference has not started within 10 minutes; such a close is a failed
 * attempt, not an empty answer.
 */
export class ModelEmptyStreamError extends Error {
  constructor() {
    super('DeepSeek API stream ended before any data');
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
 * A failure that may pass: a retryable HTTP status, no response in time, a stream that went silent or ended before any
 * data, or the connection lost — undici's fetch rejects with `TypeError: fetch failed` before the response and
 * `TypeError: terminated` when the body is cut. Anything else (a missing key, a cancel) is not sent again.
 */
export function isRetryableModelError(err: unknown): boolean {
  if (err instanceof ModelHttpError) {
    return isRetryableStatus(err.status);
  }
  if (
    err instanceof ModelTimeoutError ||
    err instanceof StreamReadTimeoutError ||
    err instanceof ModelEmptyStreamError
  ) {
    return true;
  }
  return err instanceof TypeError && (err.message === 'fetch failed' || err.message === 'terminated');
}

/** The wait (ms) before retry number `retry` (1 for the first). */
export function retryDelayMs(retry: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retry - 1);
}
