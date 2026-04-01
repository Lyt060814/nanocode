/**
 * nanocode Cache Boundary
 *
 * Handles splitting system prompt blocks into static (cacheable) and
 * dynamic (per-session) parts, and applying cache_control markers.
 *
 * The Anthropic API supports prompt caching via cache_control: { type: 'ephemeral' }
 * on system prompt blocks. Static content (behavioral instructions) should be
 * cached to avoid re-processing on every turn. Dynamic content (env, git, memory)
 * changes per session and should NOT be cached.
 */

import type { SystemPromptBlock } from '../core/types.js'

// ---------------------------------------------------------------------------
// Boundary marker
// ---------------------------------------------------------------------------

/**
 * Sentinel string used to separate static and dynamic system prompt blocks.
 * Blocks before this marker are cacheable; blocks after are per-session.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

// ---------------------------------------------------------------------------
// Split system blocks
// ---------------------------------------------------------------------------

export interface SplitResult {
  /** Blocks before the boundary — behavioral instructions, cacheable. */
  static: SystemPromptBlock[]
  /** Blocks after the boundary — session context, not cached. */
  dynamic: SystemPromptBlock[]
}

/**
 * Split an array of system prompt blocks at the dynamic boundary marker.
 *
 * The boundary block itself is excluded from both halves.
 * If no boundary is found, all blocks are treated as static.
 */
export function splitSystemBlocks(blocks: SystemPromptBlock[]): SplitResult {
  const boundaryIndex = blocks.findIndex(
    (b) => b.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  )

  if (boundaryIndex === -1) {
    // No boundary found — treat everything as static
    return {
      static: [...blocks],
      dynamic: [],
    }
  }

  return {
    static: blocks.slice(0, boundaryIndex),
    dynamic: blocks.slice(boundaryIndex + 1),
  }
}

// ---------------------------------------------------------------------------
// Apply cache control
// ---------------------------------------------------------------------------

/**
 * Apply cache_control: { type: 'ephemeral' } to static system prompt blocks.
 *
 * Returns a new array of blocks where:
 * - Static blocks get cache_control added (the LAST static block gets it,
 *   as the API caches up to the last block with cache_control)
 * - The boundary marker block is removed
 * - Dynamic blocks are passed through unchanged
 *
 * This follows the Anthropic prompt caching best practice: mark the end
 * of the stable prefix so the API can cache everything up to that point.
 */
export function applyCache(blocks: SystemPromptBlock[]): SystemPromptBlock[] {
  const { static: staticBlocks, dynamic: dynamicBlocks } =
    splitSystemBlocks(blocks)

  if (staticBlocks.length === 0) {
    return dynamicBlocks
  }

  // Apply cache_control to the last static block
  const cachedStatic = staticBlocks.map((block, index) => {
    if (index === staticBlocks.length - 1) {
      return {
        ...block,
        cache_control: { type: 'ephemeral' as const },
      }
    }
    return { ...block }
  })

  return [...cachedStatic, ...dynamicBlocks]
}

/**
 * Check whether a block array contains the dynamic boundary marker.
 */
export function hasBoundary(blocks: SystemPromptBlock[]): boolean {
  return blocks.some((b) => b.text === SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
}

/**
 * Remove the boundary marker from a block array without applying cache.
 * Useful when caching is not supported by the target model.
 */
export function stripBoundary(
  blocks: SystemPromptBlock[],
): SystemPromptBlock[] {
  return blocks.filter((b) => b.text !== SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
}
