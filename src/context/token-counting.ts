/**
 * nanocode Token Counting
 *
 * Fast token estimation functions using character-based heuristics.
 * These are NOT exact — they use the rule of thumb that:
 *   - Natural language text: ~4 characters per token
 *   - JSON/structured data: ~2 characters per token (more punctuation/keys)
 *
 * For precise counting, use a tokenizer like tiktoken. These estimates
 * are sufficient for compaction thresholds and budget calculations.
 */

import type { Message, ContentBlock, SystemPromptBlock } from '../core/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Average characters per token for natural language text.
 * English text averages ~4 chars/token with cl100k_base.
 */
export const CHARS_PER_TOKEN = 4

/**
 * Average characters per token for JSON-structured data.
 * JSON has many short keys, braces, and quotes, leading to ~2 chars/token.
 */
export const JSON_CHARS_PER_TOKEN = 2

// ---------------------------------------------------------------------------
// Core estimation functions
// ---------------------------------------------------------------------------

/**
 * Estimate token count for a plain text string.
 *
 * Uses the heuristic: tokens ≈ ceil(characters / 4)
 *
 * @param text The text to estimate
 * @returns Estimated token count (minimum 0)
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) {
    return 0
  }
  return Math.round(text.length / CHARS_PER_TOKEN)
}

/**
 * Estimate token count for an arbitrary JSON-serializable object.
 *
 * Uses the heuristic: tokens ≈ ceil(JSON.stringify(obj).length / 2)
 * JSON is denser than natural language because of structural characters.
 *
 * @param obj The object to estimate
 * @returns Estimated token count (minimum 0)
 */
export function estimateJsonTokens(obj: unknown): number {
  if (obj === null || obj === undefined) {
    return 0
  }
  try {
    const json = JSON.stringify(obj)
    return Math.round(json.length / JSON_CHARS_PER_TOKEN)
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Content block estimation
// ---------------------------------------------------------------------------

/**
 * Estimate tokens for a single content block.
 */
function estimateBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTokens(block.text)

    case 'tool_use':
      // Tool name + input JSON
      return (
        estimateTokens(block.name) +
        estimateTokens(block.id) +
        estimateJsonTokens(block.input)
      )

    case 'tool_result': {
      if (typeof block.content === 'string') {
        return estimateTokens(block.content)
      }
      if (Array.isArray(block.content)) {
        return block.content.reduce(
          (sum, b) => sum + estimateBlockTokens(b),
          0,
        )
      }
      return 0
    }

    case 'thinking':
      return estimateTokens(block.thinking)

    case 'redacted_thinking':
      // Redacted thinking has opaque data, estimate conservatively
      return estimateTokens(block.data)

    case 'image':
      // Images are typically 1-2K tokens depending on size
      // Use a fixed estimate since we can't easily determine from base64
      return 1_500

    default:
      return 0
  }
}

// ---------------------------------------------------------------------------
// Message-level estimation
// ---------------------------------------------------------------------------

/**
 * Estimate total tokens for a single message (role + all content blocks).
 *
 * Includes a small overhead for the message structure itself (role, etc.).
 */
export function estimateSingleMessageTokens(message: Message): number {
  // Overhead for message structure (role label, separators)
  const structureOverhead = 4

  if (!message.content || !Array.isArray(message.content)) {
    return structureOverhead
  }

  const contentTokens = message.content.reduce(
    (sum, block) => sum + estimateBlockTokens(block),
    0,
  )

  return structureOverhead + contentTokens
}

/**
 * Estimate total tokens for an array of messages.
 *
 * @param messages Array of messages to estimate
 * @returns Total estimated token count
 */
export function estimateMessageTokens(messages: Message[]): number {
  if (!messages || messages.length === 0) {
    return 0
  }

  return messages.reduce(
    (sum, msg) => sum + estimateSingleMessageTokens(msg),
    0,
  )
}

// ---------------------------------------------------------------------------
// System prompt estimation
// ---------------------------------------------------------------------------

/**
 * Estimate tokens for system prompt blocks.
 */
export function estimateSystemPromptTokens(
  blocks: SystemPromptBlock[],
): number {
  if (!blocks || blocks.length === 0) {
    return 0
  }

  return blocks.reduce((sum, block) => sum + estimateTokens(block.text), 0)
}

// ---------------------------------------------------------------------------
// Budget utilities
// ---------------------------------------------------------------------------

/**
 * Check if adding content would exceed a token budget.
 */
export function wouldExceedBudget(
  currentTokens: number,
  additionalText: string,
  budget: number,
): boolean {
  return currentTokens + estimateTokens(additionalText) > budget
}

/**
 * Truncate text to fit within a token budget.
 * Cuts at the nearest word boundary.
 */
export function truncateToTokenBudget(
  text: string,
  maxTokens: number,
): string {
  const currentTokens = estimateTokens(text)
  if (currentTokens <= maxTokens) {
    return text
  }

  const targetChars = maxTokens * CHARS_PER_TOKEN
  const truncated = text.slice(0, targetChars)

  // Find last space or newline for clean cut
  const lastBreak = Math.max(
    truncated.lastIndexOf('\n'),
    truncated.lastIndexOf(' '),
  )

  if (lastBreak > targetChars * 0.8) {
    return truncated.slice(0, lastBreak) + '\n...[truncated]'
  }

  return truncated + '...[truncated]'
}
