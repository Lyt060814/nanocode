import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  NanoCodeError,
  PromptTooLongError,
  RateLimitError,
  OverloadedError,
  AuthenticationError,
  NetworkError,
  ToolExecutionError,
  AbortError,
  classifyError,
  withRetry,
  sleep,
  isRetryable,
} from '../../src/core/errors'

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe('classifyError', () => {
  it('returns the same error if already a NanoCodeError', () => {
    const err = new NanoCodeError('already typed')
    expect(classifyError(err)).toBe(err)
  })

  it('maps status 401 to AuthenticationError', () => {
    const err = Object.assign(new Error('bad key'), { status: 401 })
    const result = classifyError(err)
    expect(result).toBeInstanceOf(AuthenticationError)
    expect(result.message).toContain('401')
  })

  it('maps status 403 to AuthenticationError', () => {
    const err = Object.assign(new Error('forbidden'), { status: 403 })
    const result = classifyError(err)
    expect(result).toBeInstanceOf(AuthenticationError)
    expect(result.message).toContain('403')
  })

  it('maps status 429 to RateLimitError with retry-after header', () => {
    const err = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': '10' },
    })
    const result = classifyError(err)
    expect(result).toBeInstanceOf(RateLimitError)
    expect((result as RateLimitError).retryAfterMs).toBe(10_000)
  })

  it('maps status 429 with no headers to default retryAfterMs of 5000', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 })
    const result = classifyError(err)
    expect(result).toBeInstanceOf(RateLimitError)
    expect((result as RateLimitError).retryAfterMs).toBe(5000)
  })

  it('maps status 529 to OverloadedError', () => {
    const err = Object.assign(new Error('overloaded'), { status: 529 })
    const result = classifyError(err)
    expect(result).toBeInstanceOf(OverloadedError)
  })

  it('maps "prompt is too long" message to PromptTooLongError', () => {
    const err = new Error('The prompt is too long for this model')
    const result = classifyError(err)
    expect(result).toBeInstanceOf(PromptTooLongError)
  })

  it('maps error.type prompt_too_long to PromptTooLongError', () => {
    const err = Object.assign(new Error('error'), {
      error: { type: 'prompt_too_long' },
    })
    const result = classifyError(err)
    expect(result).toBeInstanceOf(PromptTooLongError)
  })

  it('maps "prompt_too_long" in message to PromptTooLongError', () => {
    const err = new Error('prompt_too_long')
    const result = classifyError(err)
    expect(result).toBeInstanceOf(PromptTooLongError)
  })

  it('maps network-related messages to NetworkError', () => {
    const messages = [
      'network error occurred',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'fetch failed',
      'socket hang up',
    ]
    for (const msg of messages) {
      const result = classifyError(new Error(msg))
      expect(result).toBeInstanceOf(NetworkError)
    }
  })

  it('maps generic Error to NanoCodeError', () => {
    const err = new Error('something unknown')
    const result = classifyError(err)
    expect(result).toBeInstanceOf(NanoCodeError)
    expect(result).not.toBeInstanceOf(AuthenticationError)
    expect(result).not.toBeInstanceOf(NetworkError)
  })

  it('maps non-Error values to NanoCodeError with String()', () => {
    const result = classifyError('just a string')
    expect(result).toBeInstanceOf(NanoCodeError)
    expect(result.message).toBe('just a string')
  })

  it('maps non-Error number to NanoCodeError', () => {
    const result = classifyError(42)
    expect(result).toBeInstanceOf(NanoCodeError)
    expect(result.message).toBe('42')
  })

  it('passes through NanoCodeError subclasses unchanged', () => {
    const err = new RateLimitError('rate', 3000)
    expect(classifyError(err)).toBe(err)
  })
})

// ---------------------------------------------------------------------------
// parseRetryAfter (tested indirectly via classifyError)
// ---------------------------------------------------------------------------

describe('parseRetryAfter (via classifyError)', () => {
  it('parses numeric retry-after header in seconds', () => {
    const err = Object.assign(new Error(''), {
      status: 429,
      headers: { 'retry-after': '30' },
    })
    const result = classifyError(err) as RateLimitError
    expect(result.retryAfterMs).toBe(30_000)
  })

  it('handles headers with .get() method (Headers-like)', () => {
    const headers = {
      get: (key: string) => (key === 'retry-after' ? '7' : null),
    }
    const err = Object.assign(new Error(''), { status: 429, headers })
    const result = classifyError(err) as RateLimitError
    expect(result.retryAfterMs).toBe(7000)
  })

  it('returns 5000 for missing retry-after', () => {
    const err = Object.assign(new Error(''), { status: 429, headers: {} })
    const result = classifyError(err) as RateLimitError
    expect(result.retryAfterMs).toBe(5000)
  })

  it('returns 5000 for non-numeric retry-after', () => {
    const err = Object.assign(new Error(''), {
      status: 429,
      headers: { 'retry-after': 'not-a-number' },
    })
    const result = classifyError(err) as RateLimitError
    expect(result.retryAfterMs).toBe(5000)
  })

  it('enforces minimum of 1000ms', () => {
    const err = Object.assign(new Error(''), {
      status: 429,
      headers: { 'retry-after': '0.5' },
    })
    const result = classifyError(err) as RateLimitError
    expect(result.retryAfterMs).toBe(1000)
  })
})

// ---------------------------------------------------------------------------
// isRetryable
// ---------------------------------------------------------------------------

describe('isRetryable', () => {
  it('returns true for RateLimitError', () => {
    expect(isRetryable(new RateLimitError('rate', 1000))).toBe(true)
  })

  it('returns true for OverloadedError', () => {
    expect(isRetryable(new OverloadedError('overloaded'))).toBe(true)
  })

  it('returns true for NetworkError', () => {
    expect(isRetryable(new NetworkError('network'))).toBe(true)
  })

  it('returns false for AuthenticationError', () => {
    expect(isRetryable(new AuthenticationError('auth'))).toBe(false)
  })

  it('returns false for PromptTooLongError', () => {
    expect(isRetryable(new PromptTooLongError('ptl'))).toBe(false)
  })

  it('returns false for generic NanoCodeError', () => {
    expect(isRetryable(new NanoCodeError('generic'))).toBe(false)
  })

  it('returns false for AbortError', () => {
    expect(isRetryable(new AbortError())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, { maxRetries: 3 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith(0)
  })

  it('retries on retryable errors and eventually succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new NetworkError('fail'))
      .mockResolvedValueOnce('success')

    const promise = withRetry(fn, { maxRetries: 3, initialDelayMs: 100 })
    // Advance timers to allow sleep to resolve
    await vi.runAllTimersAsync()
    const result = await promise
    expect(result).toBe('success')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('throws immediately on AuthenticationError (non-retryable)', async () => {
    const fn = vi.fn().mockRejectedValue(
      Object.assign(new Error('bad key'), { status: 401 }),
    )
    await expect(withRetry(fn, { maxRetries: 5 })).rejects.toThrow(AuthenticationError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws immediately on PromptTooLongError (non-retryable)', async () => {
    const fn = vi.fn().mockRejectedValue(new PromptTooLongError('too long'))
    await expect(withRetry(fn, { maxRetries: 5 })).rejects.toThrow(PromptTooLongError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws immediately on AbortError', async () => {
    const fn = vi.fn().mockRejectedValue(new AbortError())
    await expect(withRetry(fn, { maxRetries: 5 })).rejects.toThrow(AbortError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('respects maxRetries and throws after exhausting attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new NetworkError('fail'))
    const promise = withRetry(fn, { maxRetries: 2, initialDelayMs: 10 })
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toThrow(NetworkError)
    // initial attempt + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('handles abort signal that is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const fn = vi.fn().mockResolvedValue('ok')
    await expect(
      withRetry(fn, { maxRetries: 3, abortSignal: controller.signal }),
    ).rejects.toThrow(AbortError)
    expect(fn).not.toHaveBeenCalled()
  })

  it('calls onRetry callback on each retry', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new NetworkError('fail'))
      .mockResolvedValueOnce('ok')

    const onRetry = vi.fn()
    const promise = withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 100,
      onRetry,
    })
    await vi.runAllTimersAsync()
    await promise
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith(
      expect.any(NetworkError),
      1,
      expect.any(Number),
    )
  })

  it('throws OverloadedError after 3 consecutive 529 errors', async () => {
    const fn = vi.fn().mockRejectedValue(new OverloadedError('overloaded'))
    const promise = withRetry(fn, { maxRetries: 10, initialDelayMs: 10 })
    await vi.runAllTimersAsync()
    await expect(promise).rejects.toThrow(OverloadedError)
    // attempt 0 => 529 (consecutive529=1), attempt 1 => 529 (consecutive529=2), attempt 2 => 529 (consecutive529=3, throw)
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('uses RateLimitError retryAfterMs for delay', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new RateLimitError('rate', 5000))
      .mockResolvedValueOnce('ok')

    const onRetry = vi.fn()
    const promise = withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 100,
      onRetry,
    })
    await vi.runAllTimersAsync()
    await promise

    // The delay should be based on retryAfterMs (5000) with jitter
    const reportedDelay = onRetry.mock.calls[0]![2] as number
    // 5000 * 0.8 = 4000, 5000 * 1.2 = 6000
    expect(reportedDelay).toBeGreaterThanOrEqual(4000)
    expect(reportedDelay).toBeLessThanOrEqual(6000)
  })
})

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves after the given time', async () => {
    const p = sleep(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toBeUndefined()
  })

  it('rejects with AbortError if signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sleep(1000, controller.signal)).rejects.toThrow(AbortError)
  })

  it('rejects with AbortError when signal is aborted during sleep', async () => {
    const controller = new AbortController()
    const p = sleep(5000, controller.signal)
    controller.abort()
    await expect(p).rejects.toThrow(AbortError)
  })
})

// ---------------------------------------------------------------------------
// Error class basics
// ---------------------------------------------------------------------------

describe('Error classes', () => {
  it('NanoCodeError has correct name and cause', () => {
    const cause = new Error('original')
    const err = new NanoCodeError('wrapper', cause)
    expect(err.name).toBe('NanoCodeError')
    expect(err.cause).toBe(cause)
    expect(err.message).toBe('wrapper')
  })

  it('ToolExecutionError stores toolName', () => {
    const err = new ToolExecutionError('fail', 'Bash')
    expect(err.toolName).toBe('Bash')
    expect(err.name).toBe('ToolExecutionError')
  })

  it('OverloadedError tracks consecutiveCount', () => {
    const err = new OverloadedError('overloaded')
    expect(err.consecutiveCount).toBe(1)
    err.consecutiveCount = 5
    expect(err.consecutiveCount).toBe(5)
  })

  it('AbortError has default message', () => {
    const err = new AbortError()
    expect(err.message).toBe('Operation aborted')
  })
})
