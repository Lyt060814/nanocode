import { describe, it, expect } from 'vitest'
import { createCostTracker } from '../../src/utils/cost'
import type { ModelConfig, TokenUsage } from '../../src/core/types'

const TEST_CONFIG: ModelConfig = {
  model: 'claude-sonnet-4-20250514',
  contextWindow: 200_000,
  maxOutputTokens: 16_384,
  supportsThinking: false,
  supportsCaching: true,
  pricePerInputToken: 0.003 / 1000,   // $3 per 1M input tokens
  pricePerOutputToken: 0.015 / 1000,   // $15 per 1M output tokens
  pricePerCacheRead: 0.0003 / 1000,    // $0.30 per 1M cache-read tokens
  pricePerCacheWrite: 0.00375 / 1000,  // $3.75 per 1M cache-write tokens
}

function usage(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): TokenUsage {
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }
}

describe('CostTracker', () => {
  // -------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------
  describe('initial state', () => {
    it('starts with all zeros', () => {
      const tracker = createCostTracker()
      expect(tracker.totalInputTokens).toBe(0)
      expect(tracker.totalOutputTokens).toBe(0)
      expect(tracker.totalCacheReadTokens).toBe(0)
      expect(tracker.totalCacheCreationTokens).toBe(0)
      expect(tracker.turns).toBe(0)
    })

    it('initial cost is zero', () => {
      const tracker = createCostTracker()
      expect(tracker.totalCostUSD(TEST_CONFIG)).toBe(0)
    })
  })

  // -------------------------------------------------------------------
  // add() accumulates correctly
  // -------------------------------------------------------------------
  describe('add()', () => {
    it('accumulates a single usage', () => {
      const tracker = createCostTracker()
      tracker.add(usage(1000, 500))
      expect(tracker.totalInputTokens).toBe(1000)
      expect(tracker.totalOutputTokens).toBe(500)
      expect(tracker.turns).toBe(1)
    })

    it('accumulates multiple adds', () => {
      const tracker = createCostTracker()
      tracker.add(usage(1000, 200, 100, 50))
      tracker.add(usage(2000, 300, 200, 100))
      expect(tracker.totalInputTokens).toBe(3000)
      expect(tracker.totalOutputTokens).toBe(500)
      expect(tracker.totalCacheReadTokens).toBe(300)
      expect(tracker.totalCacheCreationTokens).toBe(150)
      expect(tracker.turns).toBe(2)
    })
  })

  // -------------------------------------------------------------------
  // totalCostUSD calculation
  // -------------------------------------------------------------------
  describe('totalCostUSD', () => {
    it('calculates correctly with known prices', () => {
      const tracker = createCostTracker()
      // 1000 input tokens at $3/1M = $0.003
      // 500 output tokens at $15/1M = $0.0075
      // total = $0.0105
      tracker.add(usage(1000, 500))
      const cost = tracker.totalCostUSD(TEST_CONFIG)
      expect(cost).toBeCloseTo(0.0105, 6)
    })

    it('includes cache costs', () => {
      const tracker = createCostTracker()
      // 1000 input at $3/1M = $0.003
      // 500 output at $15/1M = $0.0075
      // 2000 cache-read at $0.30/1M = $0.0006
      // 1000 cache-write at $3.75/1M = $0.00375
      // total = $0.01485
      tracker.add(usage(1000, 500, 2000, 1000))
      const cost = tracker.totalCostUSD(TEST_CONFIG)
      expect(cost).toBeCloseTo(0.01485, 6)
    })
  })

  // -------------------------------------------------------------------
  // summary() format
  // -------------------------------------------------------------------
  describe('summary()', () => {
    it('returns formatted string with turn count and costs', () => {
      const tracker = createCostTracker()
      tracker.add(usage(1500, 400))
      const s = tracker.summary(TEST_CONFIG)
      expect(s).toContain('Turn 1')
      expect(s).toContain('1.5K in')
      expect(s).toContain('400 out')
      expect(s).toContain('$')
    })

    it('includes cache stats when present', () => {
      const tracker = createCostTracker()
      tracker.add(usage(1000, 500, 3000, 1000))
      const s = tracker.summary(TEST_CONFIG)
      expect(s).toContain('cache')
      expect(s).toContain('3.0K read')
      expect(s).toContain('1.0K write')
    })

    it('omits cache stats when no cache usage', () => {
      const tracker = createCostTracker()
      tracker.add(usage(1000, 500))
      const s = tracker.summary(TEST_CONFIG)
      expect(s).not.toContain('cache')
    })
  })
})
