/**
 * nanocode Context Compaction
 *
 * When the conversation grows too large for the context window, compaction
 * summarizes older messages into a single summary message while preserving
 * recent turns. This keeps the agent functional in long sessions.
 *
 * The process:
 * 1. Check if compaction is needed (token estimate vs threshold)
 * 2. Find compact boundary (start after any previous compaction)
 * 3. Split messages into summarize-set and preserve-set
 * 4. Ask Claude to summarize the older messages using COMPACT_PROMPT
 * 5. Replace older messages with a single summary message
 * 6. Insert a compact boundary marker for future compactions
 */

import type {
  Message,
  ContentBlock,
  TextBlock,
  ModelConfig,
  SystemPromptBlock,
} from '../core/types.js'
import {
  estimateTokens,
  estimateMessageTokens,
} from './token-counting.js'
import {
  COMPACT_PROMPT,
  COMPACT_SYSTEM_INSTRUCTION,
  COMPACT_BOUNDARY_MARKER,
  formatCompactSummary,
  serializeMessagesForCompact,
} from '../prompt/compact-prompt.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Number of recent turns (user+assistant pairs) to preserve from compaction.
 * These are kept verbatim so the model has immediate conversational context.
 */
const PRESERVE_RECENT_TURNS = 3

/**
 * Safety margin in tokens subtracted from the context window when
 * calculating the compaction threshold.
 */
const SAFETY_MARGIN = 13_000

/**
 * Maximum tokens to spend on the compaction summary itself.
 */
const MAX_SUMMARY_TOKENS = 8_000

// ---------------------------------------------------------------------------
// Compact boundary detection
// ---------------------------------------------------------------------------

/**
 * Find the index of the last compact boundary in the message array.
 * Returns -1 if no previous compaction has occurred.
 */
function findLastCompactBoundary(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (
          block.type === 'text' &&
          (block as TextBlock).text.includes(COMPACT_BOUNDARY_MARKER)
        ) {
          return i
        }
      }
    }
  }
  return -1
}

// ---------------------------------------------------------------------------
// Message splitting
// ---------------------------------------------------------------------------

/**
 * Count the number of complete turns (user→assistant pairs) from the end.
 */
function countTurnsFromEnd(messages: Message[]): number[] {
  const indices: number[] = []
  let turnCount = 0
  let expectRole: 'assistant' | 'user' = 'assistant'

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]

    if (expectRole === 'assistant' && msg.role === 'assistant') {
      expectRole = 'user'
    } else if (expectRole === 'user' && msg.role === 'user') {
      turnCount++
      expectRole = 'assistant'
    }

    if (turnCount <= PRESERVE_RECENT_TURNS) {
      indices.unshift(i)
    }

    if (turnCount >= PRESERVE_RECENT_TURNS) {
      break
    }
  }

  return indices
}

/**
 * Split messages into two groups:
 * - toSummarize: older messages that will be compacted
 * - toPreserve: recent turns that are kept verbatim
 *
 * @param messages Full message array
 * @param afterIndex Start after this index (previous compact boundary)
 */
function splitMessages(
  messages: Message[],
  afterIndex: number,
): { toSummarize: Message[]; toPreserve: Message[] } {
  const startFrom = afterIndex + 1
  const relevantMessages = messages.slice(startFrom)

  if (relevantMessages.length <= PRESERVE_RECENT_TURNS * 2) {
    // Not enough messages to compact — preserve everything
    return {
      toSummarize: [],
      toPreserve: relevantMessages,
    }
  }

  // Find the split point: preserve the last N turns
  const preserveIndices = countTurnsFromEnd(relevantMessages)
  const splitPoint =
    preserveIndices.length > 0 ? preserveIndices[0] : relevantMessages.length

  return {
    toSummarize: relevantMessages.slice(0, splitPoint),
    toPreserve: relevantMessages.slice(splitPoint),
  }
}

// ---------------------------------------------------------------------------
// Compact execution
// ---------------------------------------------------------------------------

export interface CompactParams {
  /** API key for making the summarization call */
  apiKey: string
  /** Model to use for summarization */
  model: string
  /** System prompt blocks (needed for token estimation) */
  systemPromptBlocks?: SystemPromptBlock[]
  /** Custom summary prompt override */
  customPrompt?: string
  /** Abort signal */
  abortSignal?: AbortSignal
}

export interface CompactResult {
  /** The compacted message array */
  compacted: Message[]
  /** Estimated tokens before compaction */
  oldTokens: number
  /** Estimated tokens after compaction */
  newTokens: number
}

/**
 * Compact a conversation by summarizing older messages.
 *
 * This function:
 * 1. Finds the last compact boundary (if any)
 * 2. Splits messages into a summarize-set and preserve-set
 * 3. Calls the model to generate a summary
 * 4. Returns the compacted conversation
 *
 * The caller is responsible for actually making the API call to generate
 * the summary. This function accepts a `callModel` callback for that purpose.
 */
export async function compact(
  messages: Message[],
  params: CompactParams,
  callModel: (
    systemPrompt: string,
    userMessage: string,
    model: string,
    apiKey: string,
    abortSignal?: AbortSignal,
  ) => Promise<string>,
): Promise<CompactResult> {
  const oldTokens = estimateMessageTokens(messages)

  // Find where previous compaction ended
  const boundaryIndex = findLastCompactBoundary(messages)
  const preCompactMessages = boundaryIndex >= 0
    ? messages.slice(0, boundaryIndex + 1)
    : []

  // Split remaining messages
  const { toSummarize, toPreserve } = splitMessages(messages, boundaryIndex)

  // If nothing to summarize, return as-is
  if (toSummarize.length === 0) {
    return {
      compacted: messages,
      oldTokens,
      newTokens: oldTokens,
    }
  }

  // Serialize messages for the compaction prompt
  const serialized = serializeMessagesForCompact(toSummarize)

  // Build the user message for compaction
  const userMessage = `${params.customPrompt || COMPACT_PROMPT}

Here is the conversation to summarize:

<conversation>
${serialized}
</conversation>

Please produce the summary now, following the 9-section format above.`

  // Call the model to generate the summary
  const summary = await callModel(
    COMPACT_SYSTEM_INSTRUCTION,
    userMessage,
    params.model,
    params.apiKey,
    params.abortSignal,
  )

  // Build the compact summary message
  const summaryMessage: Message = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: formatCompactSummary(summary),
      } as TextBlock,
    ],
  }

  // Assemble the compacted conversation
  const compacted: Message[] = [
    ...preCompactMessages,
    summaryMessage,
    ...toPreserve,
  ]

  const newTokens = estimateMessageTokens(compacted)

  return {
    compacted,
    oldTokens,
    newTokens,
  }
}

// ---------------------------------------------------------------------------
// Auto-compact detection
// ---------------------------------------------------------------------------

/**
 * Determine whether automatic compaction should be triggered.
 *
 * The formula matches Claude Code:
 *   threshold = contextWindow - maxOutputTokens - SAFETY_MARGIN
 *
 * If the estimated token count of the current messages exceeds the threshold,
 * compaction is needed.
 *
 * @param messages Current conversation messages
 * @param contextWindow Total context window size in tokens
 * @param maxOutputTokens Reserved tokens for the model's response
 * @returns true if compaction should be triggered
 */
export function shouldAutoCompact(
  messages: Message[],
  contextWindow: number,
  maxOutputTokens: number,
): boolean {
  const threshold = contextWindow - maxOutputTokens - SAFETY_MARGIN
  if (threshold <= 0) {
    return false
  }

  const currentTokens = estimateMessageTokens(messages)
  return currentTokens >= threshold
}

/**
 * Calculate the compaction threshold for a given model config.
 */
export function compactThreshold(config: ModelConfig): number {
  return config.contextWindow - config.maxOutputTokens - SAFETY_MARGIN
}

// ---------------------------------------------------------------------------
// Quick compact (simplified path for slash commands)
// ---------------------------------------------------------------------------

/**
 * Convenience function that compacts messages using the standard compact
 * prompt. This is the entry point used by the /compact slash command.
 */
export async function quickCompact(
  messages: Message[],
  apiKey: string,
  model: string,
  callModel: (
    systemPrompt: string,
    userMessage: string,
    model: string,
    apiKey: string,
    abortSignal?: AbortSignal,
  ) => Promise<string>,
): Promise<CompactResult> {
  return compact(messages, { apiKey, model }, callModel)
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  PRESERVE_RECENT_TURNS,
  SAFETY_MARGIN,
  MAX_SUMMARY_TOKENS,
  findLastCompactBoundary,
  splitMessages,
}
