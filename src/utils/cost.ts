/**
 * nanocode — Cost Tracker
 *
 * Tracks API token usage and computes cost estimates based on
 * per-token pricing from the model configuration.
 */

import type { CostTracker, ModelConfig, TokenUsage } from '../core/types.js'

/**
 * Format a number into a compact human-readable string.
 * e.g., 1234 → "1.2K", 1_500_000 → "1.5M"
 */
function formatTokenCount(n: number): string {
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(1) + 'M'
  }
  if (n >= 1_000) {
    return (n / 1_000).toFixed(1) + 'K'
  }
  return String(n)
}

/**
 * Format a USD cost value.
 * Shows more precision for small amounts.
 */
function formatUSD(amount: number): string {
  if (amount < 0.001) {
    return '$' + amount.toFixed(5)
  }
  if (amount < 0.01) {
    return '$' + amount.toFixed(4)
  }
  if (amount < 1) {
    return '$' + amount.toFixed(3)
  }
  return '$' + amount.toFixed(2)
}

/**
 * Create a new CostTracker instance.
 *
 * Accumulates token usage across multiple API calls and computes
 * running cost estimates.
 */
export function createCostTracker(): CostTracker {
  const tracker: CostTracker = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    turns: 0,

    /**
     * Add token usage from a single API call.
     */
    add(usage: TokenUsage): void {
      tracker.totalInputTokens += usage.inputTokens
      tracker.totalOutputTokens += usage.outputTokens
      tracker.totalCacheReadTokens += usage.cacheReadTokens
      tracker.totalCacheCreationTokens += usage.cacheCreationTokens
      tracker.turns++
    },

    /**
     * Calculate total cost in USD based on the model's pricing.
     */
    totalCostUSD(config: ModelConfig): number {
      return (
        tracker.totalInputTokens * config.pricePerInputToken +
        tracker.totalOutputTokens * config.pricePerOutputToken +
        tracker.totalCacheReadTokens * config.pricePerCacheRead +
        tracker.totalCacheCreationTokens * config.pricePerCacheWrite
      )
    },

    /**
     * Generate a one-line summary of usage and cost.
     *
     * Format: "Turn N | 1.2K in / 500 out | $0.012"
     */
    summary(config: ModelConfig): string {
      const inStr = formatTokenCount(tracker.totalInputTokens)
      const outStr = formatTokenCount(tracker.totalOutputTokens)
      const cost = formatUSD(tracker.totalCostUSD(config))
      const parts = [`Turn ${tracker.turns}`, `${inStr} in / ${outStr} out`, cost]

      // Include cache stats if any
      if (tracker.totalCacheReadTokens > 0 || tracker.totalCacheCreationTokens > 0) {
        const cacheRead = formatTokenCount(tracker.totalCacheReadTokens)
        const cacheWrite = formatTokenCount(tracker.totalCacheCreationTokens)
        parts.splice(2, 0, `cache: ${cacheRead} read / ${cacheWrite} write`)
      }

      return parts.join(' | ')
    },
  }

  return tracker
}
