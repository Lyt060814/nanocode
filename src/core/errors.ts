/**
 * nanocode Error Classification & Retry Logic
 *
 * Maps API/network errors to typed errors with retry strategies.
 * Key patterns from Claude Code: withRetry.ts, PTL recovery.
 */

// ---------------------------------------------------------------------------
// Error Classes
// ---------------------------------------------------------------------------

export class nanocodeError extends Error {
  constructor(message: string, public readonly cause?: Error) {
    super(message)
    this.name = 'nanocodeError'
  }
}

export class PromptTooLongError extends nanocodeError {
  constructor(
    message: string,
    public readonly tokenCount?: number,
    public readonly maxTokens?: number,
  ) {
    super(message)
    this.name = 'PromptTooLongError'
  }
}

export class RateLimitError extends nanocodeError {
  constructor(
    message: string,
    public readonly retryAfterMs: number,
  ) {
    super(message)
    this.name = 'RateLimitError'
  }
}

export class OverloadedError extends nanocodeError {
  public consecutiveCount: number = 1
  constructor(message: string) {
    super(message)
    this.name = 'OverloadedError'
  }
}

export class AuthenticationError extends nanocodeError {
  constructor(message: string) {
    super(message)
    this.name = 'AuthenticationError'
  }
}

export class NetworkError extends nanocodeError {
  constructor(message: string, cause?: Error) {
    super(message, cause)
    this.name = 'NetworkError'
  }
}

export class ToolExecutionError extends nanocodeError {
  constructor(
    message: string,
    public readonly toolName: string,
    cause?: Error,
  ) {
    super(message, cause)
    this.name = 'ToolExecutionError'
  }
}

export class AbortError extends nanocodeError {
  constructor(message: string = 'Operation aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

export function classifyError(error: unknown): nanocodeError {
  if (error instanceof nanocodeError) return error

  if (error instanceof Error) {
    const msg = error.message.toLowerCase()
    const anyError = error as any

    // Anthropic SDK errors
    if (anyError.status === 401 || anyError.status === 403) {
      return new AuthenticationError(
        `Authentication failed (${anyError.status}): ${error.message}`,
      )
    }

    if (anyError.status === 429) {
      const retryAfter = parseRetryAfter(anyError.headers)
      return new RateLimitError(
        `Rate limited: ${error.message}`,
        retryAfter,
      )
    }

    if (anyError.status === 529) {
      return new OverloadedError(`API overloaded: ${error.message}`)
    }

    if (
      msg.includes('prompt is too long') ||
      msg.includes('prompt_too_long') ||
      anyError.error?.type === 'prompt_too_long'
    ) {
      return new PromptTooLongError(error.message)
    }

    if (
      msg.includes('network') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('fetch failed') ||
      msg.includes('socket hang up')
    ) {
      return new NetworkError(error.message, error)
    }

    return new nanocodeError(error.message, error)
  }

  return new nanocodeError(String(error))
}

// ---------------------------------------------------------------------------
// Retry Logic
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  backoffFactor?: number
  abortSignal?: AbortSignal
  onRetry?: (error: nanocodeError, attempt: number, delayMs: number) => void
}

const DEFAULT_RETRY: Required<Omit<RetryOptions, 'abortSignal' | 'onRetry'>> = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
  backoffFactor: 2,
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_RETRY, ...options }
  let lastError: nanocodeError | undefined
  let consecutive529 = 0

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    if (options.abortSignal?.aborted) {
      throw new AbortError()
    }

    try {
      return await fn(attempt)
    } catch (raw) {
      lastError = classifyError(raw)

      // Non-retryable errors
      if (lastError instanceof AuthenticationError) throw lastError
      if (lastError instanceof PromptTooLongError) throw lastError
      if (lastError instanceof AbortError) throw lastError

      // Last attempt
      if (attempt >= opts.maxRetries) throw lastError

      // Calculate delay
      let delayMs: number

      if (lastError instanceof RateLimitError) {
        delayMs = lastError.retryAfterMs || opts.initialDelayMs
      } else if (lastError instanceof OverloadedError) {
        consecutive529++
        if (consecutive529 >= 3) throw lastError
        delayMs = opts.initialDelayMs * Math.pow(opts.backoffFactor, attempt)
      } else {
        consecutive529 = 0
        delayMs = opts.initialDelayMs * Math.pow(opts.backoffFactor, attempt)
      }

      delayMs = Math.min(delayMs, opts.maxDelayMs)

      // Jitter: +/- 20%
      delayMs = delayMs * (0.8 + Math.random() * 0.4)

      opts.onRetry?.(lastError, attempt + 1, delayMs)

      await sleep(delayMs, options.abortSignal)
    }
  }

  throw lastError!
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRetryAfter(headers: any): number {
  if (!headers) return 5000
  const retryAfter = headers?.['retry-after'] || headers?.get?.('retry-after')
  if (!retryAfter) return 5000
  const seconds = parseFloat(retryAfter)
  if (isNaN(seconds)) return 5000
  return Math.max(1000, seconds * 1000)
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError())
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new AbortError())
    }, { once: true })
  })
}

/**
 * Check if an error is retryable (for callers that want to handle retry themselves)
 */
export function isRetryable(error: nanocodeError): boolean {
  return (
    error instanceof RateLimitError ||
    error instanceof OverloadedError ||
    error instanceof NetworkError
  )
}
