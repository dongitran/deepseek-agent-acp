/**
 * model-route.ts — Pure rules for which model an attempt of a model call goes to (issue #6).
 *
 * DeepSeek admits a request it cannot serve yet and holds it with keep-alive comments. On 14 Sep 2026 deepseek-flash
 * held every request for ~900 s for about three hours, while deepseek-v4-pro answered in under 2 s on the same key:
 * sending a stalled call to the same model again only queues it again. With DEEPSEEK_FALLBACK_MODEL set, the attempt
 * after a stall goes to the fallback model, and so does every call of the process until the primary has cooled down,
 * so a meeting twin waits for the stall once, not on every call. After the cooldown the next call tries the primary
 * again: its answer ends the cooldown, another stall doubles it.
 *
 * Side-effect-free (no logging, no environment, no timers: the caller passes the clock), like turn-stop.ts.
 */

/** The first cooldown of the primary model after it stalls. */
export const FALLBACK_COOLDOWN_MS = 60_000;

/** Cooldowns double at each stall of the primary in a row, up to this. */
export const MAX_FALLBACK_COOLDOWN_MS = 600_000;

/**
 * The least an attempt on the fallback model waits for its first useful event: that model's prompt cache starts cold
 * (deepseek-v4-pro took 5.8 s to its first token for a 64K-token prompt it had not seen, under 1 s once cached).
 */
export const FALLBACK_MIN_FIRST_EVENT_MS = 60_000;

/** Where one attempt goes: the model, and why it is the fallback (null for the primary). */
export interface Route {
  model: string;
  fallback: 'stall' | 'cooldown' | null;
}

export class ModelRouter {
  private cooldownMs = 0;
  private stalledUntil = 0;

  constructor(
    readonly primary: string,
    readonly fallback: string | null
  ) {}

  /**
   * The model for an attempt at `now`. `stalledOn` is the model the previous attempt of this call stalled on, null for
   * a first attempt or after another failure (which keeps its model).
   */
  route(now: number, stalledOn: string | null): Route {
    if (this.fallback === null || stalledOn === this.fallback) {
      return { model: this.primary, fallback: null };
    }
    if (stalledOn === this.primary) {
      return { model: this.fallback, fallback: 'stall' };
    }
    return now < this.stalledUntil ? { model: this.fallback, fallback: 'cooldown' } : { model: this.primary, fallback: null };
  }

  /** An attempt on `model` stalled at `now`: the primary cools down. Returns that cooldown (ms), 0 when none starts. */
  noteStall(model: string, now: number): number {
    if (this.fallback === null || model !== this.primary) {
      return 0;
    }
    this.cooldownMs = this.cooldownMs > 0 ? Math.min(MAX_FALLBACK_COOLDOWN_MS, this.cooldownMs * 2) : FALLBACK_COOLDOWN_MS;
    this.stalledUntil = now + this.cooldownMs;
    return this.cooldownMs;
  }

  /** An attempt on `model` answered: an answer from the primary ends its cooldown. True when it ended one. */
  noteAnswer(model: string): boolean {
    if (model !== this.primary || this.cooldownMs === 0) {
      return false;
    }
    this.cooldownMs = 0;
    this.stalledUntil = 0;
    return true;
  }

  /** The first-event deadline of an attempt on `route`, from DEEPSEEK_FIRST_EVENT_TIMEOUT_MS (`timeoutMs`). */
  firstEventTimeoutMs(route: Route, timeoutMs: number): number {
    return route.fallback === null ? timeoutMs : Math.max(timeoutMs, FALLBACK_MIN_FIRST_EVENT_MS);
  }
}
