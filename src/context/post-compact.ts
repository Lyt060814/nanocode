/**
 * NanoCode Post-Compaction File Attachments
 *
 * After context compaction, the model loses its detailed knowledge of
 * recently-read files. This module re-reads the most recently accessed
 * files and attaches truncated versions as supplementary context, so the
 * model can continue working without re-reading everything from scratch.
 *
 * Budget constraints:
 * - MAX_FILES: at most 5 files are re-attached
 * - TOKEN_BUDGET: total token budget across all attachments (50K tokens)
 * - MAX_PER_FILE: each file is truncated to 5K tokens
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type {
  Message,
  TextBlock,
  FileStateCache,
  FileState,
} from '../core/types.js'
import { estimateTokens } from './token-counting.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of files to re-attach after compaction. */
export const MAX_FILES = 5

/** Total token budget for all post-compact attachments combined. */
export const TOKEN_BUDGET = 50_000

/** Maximum tokens per individual file attachment. */
export const MAX_PER_FILE = 5_000

// ---------------------------------------------------------------------------
// File collection and sorting
// ---------------------------------------------------------------------------

interface FileEntry {
  path: string
  timestamp: number
  state: FileState
}

/**
 * Collect file paths from the readFileState cache, sorted by most
 * recently accessed first.
 */
function collectRecentFiles(readFileState: FileStateCache): FileEntry[] {
  const entries: FileEntry[] = []

  for (const path of readFileState.keys()) {
    const state = readFileState.get(path)
    if (state) {
      entries.push({
        path,
        timestamp: state.timestamp,
        state,
      })
    }
  }

  // Sort by timestamp descending (most recent first)
  entries.sort((a, b) => b.timestamp - a.timestamp)

  return entries
}

// ---------------------------------------------------------------------------
// File re-reading
// ---------------------------------------------------------------------------

/**
 * Attempt to re-read a file from disk. Returns null if the file cannot
 * be read (deleted, permissions, etc.).
 */
async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf-8')
    return content
  } catch {
    return null
  }
}

/**
 * Truncate file content to fit within a token budget.
 * Truncates at line boundaries to avoid cutting mid-line.
 */
function truncateToTokens(content: string, maxTokens: number): string {
  const currentTokens = estimateTokens(content)

  if (currentTokens <= maxTokens) {
    return content
  }

  // Estimate character limit from token limit
  const charLimit = maxTokens * 4 // CHARS_PER_TOKEN = 4
  const truncated = content.slice(0, charLimit)

  // Find the last newline to avoid cutting mid-line
  const lastNewline = truncated.lastIndexOf('\n')
  if (lastNewline > 0) {
    return truncated.slice(0, lastNewline) + '\n...[truncated]'
  }

  return truncated + '...[truncated]'
}

// ---------------------------------------------------------------------------
// Attachment creation
// ---------------------------------------------------------------------------

/**
 * Format a single file as an attachment text block.
 */
function formatFileAttachment(filePath: string, content: string): string {
  return `<file path="${filePath}">
${content}
</file>`
}

/**
 * Create post-compaction file attachment messages.
 *
 * After compaction, the model loses its knowledge of recently-read files.
 * This function:
 * 1. Collects file paths from the pre-compact readFileState
 * 2. Sorts by timestamp (most recent first)
 * 3. Re-reads top MAX_FILES files from disk
 * 4. Truncates each to MAX_PER_FILE tokens
 * 5. Returns them as attachment messages within TOKEN_BUDGET
 *
 * @param preservedMessages Messages kept after compaction (for context)
 * @param readFileState The file state cache from before compaction
 * @param contextBudget Optional override for total token budget
 * @returns Array of messages containing file attachments
 */
export async function createPostCompactAttachments(
  preservedMessages: Message[],
  readFileState: FileStateCache,
  contextBudget: number = TOKEN_BUDGET,
): Promise<Message[]> {
  if (readFileState.size === 0) {
    return []
  }

  // Collect and sort files by recency
  const recentFiles = collectRecentFiles(readFileState)

  // Take top MAX_FILES
  const candidates = recentFiles.slice(0, MAX_FILES)

  if (candidates.length === 0) {
    return []
  }

  // Collect file paths that are already referenced in preserved messages
  // to avoid duplicate content
  const preservedPaths = new Set<string>()
  for (const msg of preservedMessages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          const textBlock = block as TextBlock
          // Simple heuristic: check if a file path appears in preserved text
          for (const candidate of candidates) {
            if (textBlock.text.includes(candidate.path)) {
              preservedPaths.add(candidate.path)
            }
          }
        }
      }
    }
  }

  // Re-read files from disk and build attachments
  const attachments: string[] = []
  let totalTokens = 0
  const perFileLimit = Math.min(
    MAX_PER_FILE,
    Math.floor(contextBudget / Math.min(candidates.length, MAX_FILES)),
  )

  for (const candidate of candidates) {
    // Skip files already referenced in preserved messages
    if (preservedPaths.has(candidate.path)) {
      continue
    }

    // Check budget
    if (totalTokens >= contextBudget) {
      break
    }

    // Re-read from disk (file may have changed since last read)
    const content = await tryReadFile(candidate.path)
    if (content === null) {
      continue
    }

    // Truncate to per-file limit
    const remainingBudget = contextBudget - totalTokens
    const effectiveLimit = Math.min(perFileLimit, remainingBudget)
    const truncated = truncateToTokens(content, effectiveLimit)

    // Track tokens
    const attachmentTokens = estimateTokens(truncated)
    totalTokens += attachmentTokens

    attachments.push(formatFileAttachment(candidate.path, truncated))
  }

  if (attachments.length === 0) {
    return []
  }

  // Build a single user message with all file attachments
  const attachmentText = `\
[Post-compaction context refresh]

The following files were recently accessed in this session. They are \
provided here as context after conversation compaction so you don't need \
to re-read them unless you need the latest version.

${attachments.join('\n\n')}`

  const message: Message = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: attachmentText,
      } as TextBlock,
    ],
  }

  return [message]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all unique file paths from a readFileState, sorted by timestamp.
 * Useful for debugging and logging.
 */
export function listRecentFiles(
  readFileState: FileStateCache,
  limit: number = MAX_FILES,
): string[] {
  return collectRecentFiles(readFileState)
    .slice(0, limit)
    .map((e) => e.path)
}

/**
 * Estimate how many tokens the post-compact attachments will use,
 * without actually reading the files.
 */
export function estimateAttachmentTokens(
  readFileState: FileStateCache,
): number {
  const entries = collectRecentFiles(readFileState).slice(0, MAX_FILES)
  let total = 0

  for (const entry of entries) {
    // Use cached content size as estimate
    const contentTokens = estimateTokens(entry.state.content)
    total += Math.min(contentTokens, MAX_PER_FILE)
  }

  return Math.min(total, TOKEN_BUDGET)
}
