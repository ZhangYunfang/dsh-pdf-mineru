/**
 * Client-side call budget for one Provider endpoint.
 *
 * MinerU's official limits are per user (`50` submissions/minute including
 * batch uploads, `1000` queries/minute, and a daily submission quota), and a
 * self-hosted deployment is usually smaller still. Exceeding them costs a
 * round trip that comes back `429`, so the Provider layer spends tokens before
 * sending instead of relying on the retry loop: retry still handles an
 * unexpected `429` (with `Retry-After`), but the common case never gets there.
 *
 * One limiter instance is shared per endpoint, because a single endpoint is
 * metered as a whole and several provider profiles may point at it.
 *
 * @module dsh-pdf-mineru/providers/http/rate-limit
 */

/** The kind of upstream call a token is spent on. */
export type RateLimitKind = 'submit' | 'poll'

export interface RateLimitPolicy {
  /** Non-polling requests per rolling minute. */
  readonly submitPerMinute: number
  /** Status/result queries per rolling minute. */
  readonly pollPerMinute: number
  /** Submissions per calendar day; `undefined` disables the daily cap. */
  readonly dailySubmits?: number
}

export interface RateLimitSnapshot {
  readonly submitRemaining: number
  readonly pollRemaining: number
  readonly submitResetMs: number
  readonly pollResetMs: number
  readonly dailyUsed?: number
  readonly dailyLimit?: number
  readonly dailyResetMs?: number
}

const MINUTE_MS = 60_000

/** MinerU's documented ceilings, tightened for the daily quota. */
export const DEFAULT_RATE_LIMIT: RateLimitPolicy = Object.freeze({
  submitPerMinute: 50,
  pollPerMinute: 600,
  dailySubmits: 2_000,
})

/** Raised when a caller would have to wait longer than its own deadline. */
export class RateLimitError extends Error {
  constructor(readonly waitMs: number) {
    super(`MinerU rate limit reached; retry in ${String(Math.ceil(waitMs / 1000))}s`)
    this.name = 'RateLimitError'
  }
}

interface Window {
  readonly stamps: number[]
  committed: number
}

export interface RateLimiterOptions {
  readonly policy?: RateLimitPolicy
  readonly now?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Sliding-window limiter with a daily submission counter.
 *
 * A request either waits for the window to slide (bounded by the caller's
 * deadline) or fails with {@link RateLimitError}: silent unbounded waiting
 * would deadlock a background job behind its own timeout.
 */
export class RateLimiter {
  private readonly policy: RateLimitPolicy
  private readonly now: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly windows: Record<'submit' | 'poll', Window> = {
    submit: { stamps: [], committed: 0 },
    poll: { stamps: [], committed: 0 },
  }
  private day = { stamps: [] as number[], dayStart: 0 }

  constructor(options: RateLimiterOptions = {}) {
    this.policy = options.policy ?? DEFAULT_RATE_LIMIT
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? (async (ms, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); resolve() }, ms)
        const onAbort = (): void => { cleanup(); reject(signal.reason) }
        const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    })
  }

  /** Milliseconds until the next slot opens, or 0 when a slot is available now. */
  waitFor(kind: RateLimitKind): number {
    const at = this.now()
    const window = this.windows[kind]
    this.prune(window, at)
    const limit = kind === 'submit' ? this.policy.submitPerMinute : this.policy.pollPerMinute
    if (window.stamps.length < limit) return 0
    const oldest = window.stamps[window.stamps.length - limit]!
    return Math.max(0, oldest + MINUTE_MS - at)
  }

  /** Spend one token, waiting inside `deadlineMs` if the window is full. */
  async acquire(kind: RateLimitKind, signal: AbortSignal, deadlineMs = 30_000): Promise<void> {
    for (;;) {
      signal.throwIfAborted()
      const wait = this.waitFor(kind)
      if (wait === 0) {
        this.commit(kind)
        return
      }
      if (wait > deadlineMs) throw new RateLimitError(wait)
      await this.sleep(wait, signal)
    }
  }

  /** Non-blocking attempt; returns false when the caller should not send yet. */
  tryAcquire(kind: RateLimitKind): boolean {
    if (this.waitFor(kind) !== 0) return false
    this.commit(kind)
    return true
  }

  snapshot(): RateLimitSnapshot {
    const at = this.now()
    this.prune(this.windows.submit, at)
    this.prune(this.windows.poll, at)
    this.pruneDay(at)
    const submitReset = this.windows.submit.stamps.length === 0
      ? 0
      : Math.max(0, this.windows.submit.stamps[0]! + MINUTE_MS - at)
    const pollReset = this.windows.poll.stamps.length === 0
      ? 0
      : Math.max(0, this.windows.poll.stamps[0]! + MINUTE_MS - at)
    return {
      submitRemaining: Math.max(0, this.policy.submitPerMinute - this.windows.submit.stamps.length),
      pollRemaining: Math.max(0, this.policy.pollPerMinute - this.windows.poll.stamps.length),
      submitResetMs: submitReset,
      pollResetMs: pollReset,
      ...(this.policy.dailySubmits === undefined ? {} : {
        dailyUsed: this.day.stamps.length,
        dailyLimit: this.policy.dailySubmits,
        dailyResetMs: Math.max(0, this.day.dayStart + 24 * 60 * 60 * 1000 - at),
      }),
    }
  }

  private commit(kind: RateLimitKind): void {
    const at = this.now()
    this.windows[kind].stamps.push(at)
    this.windows[kind].committed += 1
    if (kind === 'submit') {
      this.pruneDay(at)
      const daily = this.policy.dailySubmits
      if (daily !== undefined && this.day.stamps.length >= daily) {
        // Releasing the slot keeps the minute window honest when the day is spent.
        const wait = Math.max(0, this.day.dayStart + 24 * 60 * 60 * 1000 - at)
        throw new RateLimitError(wait)
      }
      this.day.stamps.push(at)
    }
  }

  private prune(window: Window, at: number): void {
    while (window.stamps.length > 0 && window.stamps[0]! <= at - MINUTE_MS) window.stamps.shift()
  }

  private pruneDay(at: number): void {
    const start = localDayStart(at)
    if (this.day.dayStart !== start) {
      this.day = { stamps: [], dayStart: start }
      return
    }
    if (this.day.stamps.length === 0) this.day.dayStart = start
  }
}

function localDayStart(at: number): number {
  const date = new Date(at)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const limiters = new Map<string, RateLimiter>()

/** Process-wide limiter for one endpoint; the endpoint is what the server meters. */
export function rateLimiterFor(endpoint: string, policy: RateLimitPolicy = DEFAULT_RATE_LIMIT): RateLimiter {
  const existing = limiters.get(endpoint)
  if (existing !== undefined) return existing
  const limiter = new RateLimiter({ policy })
  limiters.set(endpoint, limiter)
  return limiter
}

/** Release registered limiters; used by tests and by plugin disposal. */
export function resetRateLimiters(): void {
  limiters.clear()
}

/** Policy from MinerU's documented limits, with an operator override for smaller deployments. */
export function rateLimitPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitPolicy {
  const read = (name: string, fallback: number): number => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const value = Number(raw)
    return Number.isSafeInteger(value) && value > 0 ? value : fallback
  }
  return {
    submitPerMinute: read('MINERU_RATE_SUBMIT_PER_MINUTE', DEFAULT_RATE_LIMIT.submitPerMinute),
    pollPerMinute: read('MINERU_RATE_POLL_PER_MINUTE', DEFAULT_RATE_LIMIT.pollPerMinute),
    dailySubmits: read('MINERU_RATE_DAILY_SUBMITS', DEFAULT_RATE_LIMIT.dailySubmits ?? 0),
  }
}
