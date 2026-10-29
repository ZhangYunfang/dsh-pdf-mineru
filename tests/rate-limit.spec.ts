import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RATE_LIMIT,
  RateLimitError,
  RateLimiter,
  rateLimitPolicyFromEnv,
  rateLimiterFor,
  resetRateLimiters,
} from '../src/providers/http/rate-limit.js'

function fakeClock(start = 0) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => { now += ms },
    /** Sleeping advances the clock instead of really waiting. */
    sleep: async (ms: number, _signal: AbortSignal) => { now += ms },
  }
}

describe('rate limiter', () => {
  it('allows up to the window budget and then waits for the oldest slot', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ policy: { submitPerMinute: 2, pollPerMinute: 5 }, now: clock.now, sleep: clock.sleep })
    const signal = new AbortController().signal
    await limiter.acquire('submit', signal)
    await limiter.acquire('submit', signal)
    expect(limiter.waitFor('submit')).toBe(60_000)
    clock.advance(30_000)
    expect(limiter.waitFor('submit')).toBe(30_000)
    // The third call sleeps exactly until the oldest stamp expires.
    await limiter.acquire('submit', signal)
    expect(clock.now()).toBe(60_000)
    expect(limiter.snapshot()).toMatchObject({ submitRemaining: 1 })
  })

  it('refuses to wait past the caller deadline instead of hanging', async () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ policy: { submitPerMinute: 1, pollPerMinute: 1 }, now: clock.now, sleep: clock.sleep })
    const signal = new AbortController().signal
    await limiter.acquire('submit', signal)
    await expect(limiter.acquire('submit', signal, 5_000)).rejects.toBeInstanceOf(RateLimitError)
  })

  it('meters submissions and polls separately', () => {
    const clock = fakeClock()
    const limiter = new RateLimiter({ policy: { submitPerMinute: 1, pollPerMinute: 2 }, now: clock.now, sleep: clock.sleep })
    expect(limiter.tryAcquire('submit')).toBe(true)
    expect(limiter.tryAcquire('submit')).toBe(false)
    expect(limiter.tryAcquire('poll')).toBe(true)
    expect(limiter.tryAcquire('poll')).toBe(true)
    expect(limiter.tryAcquire('poll')).toBe(false)
  })

  it('enforces the daily submission quota and resets at local midnight', async () => {
    const clock = fakeClock(new Date('2026-10-29T10:00:00').getTime())
    const limiter = new RateLimiter({
      policy: { submitPerMinute: 100, pollPerMinute: 100, dailySubmits: 2 },
      now: clock.now, sleep: clock.sleep,
    })
    const signal = new AbortController().signal
    await limiter.acquire('submit', signal)
    await limiter.acquire('submit', signal)
    expect(limiter.snapshot()).toMatchObject({ dailyUsed: 2, dailyLimit: 2 })
    await expect(limiter.acquire('submit', signal, 60_000)).rejects.toBeInstanceOf(RateLimitError)
    // The next local day restores the quota.
    clock.advance(24 * 60 * 60 * 1000)
    await limiter.acquire('submit', signal)
    expect(limiter.snapshot()).toMatchObject({ dailyUsed: 1 })
  })

  it('shares one limiter per endpoint and reports what is left', async () => {
    resetRateLimiters()
    const first = rateLimiterFor('http://127.0.0.1:8000')
    const second = rateLimiterFor('http://127.0.0.1:8000')
    expect(second).toBe(first)
    await first.acquire('submit', new AbortController().signal)
    expect(second.snapshot().submitRemaining).toBe(DEFAULT_RATE_LIMIT.submitPerMinute - 1)
    expect(rateLimiterFor('http://other:8000')).not.toBe(first)
    resetRateLimiters()
  })

  it('reads an operator override from the environment and ignores junk values', () => {
    expect(rateLimitPolicyFromEnv({ MINERU_RATE_SUBMIT_PER_MINUTE: '3', MINERU_RATE_POLL_PER_MINUTE: 'abc' }))
      .toMatchObject({ submitPerMinute: 3, pollPerMinute: DEFAULT_RATE_LIMIT.pollPerMinute })
    expect(rateLimitPolicyFromEnv({})).toEqual(DEFAULT_RATE_LIMIT)
  })

  it('propagates cancellation from the caller instead of swallowing it', async () => {
    const controller = new AbortController()
    const limiter = new RateLimiter({
      policy: { submitPerMinute: 1, pollPerMinute: 1 },
      now: () => 0,
      sleep: async (_ms, signal) => { signal.throwIfAborted() },
    })
    await limiter.acquire('submit', controller.signal)
    // Deadline above one window so the call parks in sleep() instead of failing fast.
    const pending = limiter.acquire('submit', controller.signal, 120_000)
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow(/cancelled/)
  })
})
