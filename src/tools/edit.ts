/**
 * Edit Tool — Surgical file editing
 *
 * Applies find-and-replace edits with full validation chain:
 * 1. No-op check (old_string !== new_string)
 * 2. File existence (empty old_string → create)
 * 3. Read-before-edit (must have read the file first)
 * 4. Staleness check (file not modified since last read)
 * 5. Match finding (exact match required)
 * 6. Uniqueness check (single match unless replace_all)
 *
 * Key patterns from Claude Code: edit.ts validation chain, atomic writes.
 */

import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext, FileState } from '../core/types.js'

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  file_path: z.string().describe(
    'The file to edit. Absolute or relative to working directory.',
  ),
  old_string: z.string().describe(
    'The exact text to find and replace. Empty string to create a new file with new_string as content.',
  ),
  new_string: z.string().describe(
    'The replacement text. Empty string to delete the old_string.',
  ),
  replace_all: z.boolean().optional().describe(
    'If true, replace all occurrences. Default: false (requires unique match).',
  ),
})

type EditInput = z.infer<typeof inputSchema>

// ---------------------------------------------------------------------------
// Diff Snippet Generator
// ---------------------------------------------------------------------------

function generateDiffSnippet(
  oldContent: string,
  newContent: string,
  oldString: string,
  newString: string,
): string {
  const contextLines = 3
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')

  // Find the first line where the change starts
  const oldIdx = oldContent.indexOf(oldString)
  if (oldIdx < 0) return '' // Shouldn't happen

  const linesBefore = oldContent.slice(0, oldIdx).split('\n').length - 1
  const oldStringLines = oldString.split('\n').length
  const newStringLines = newString.split('\n').length

  const startLine = Math.max(0, linesBefore - contextLines)
  const endLineOld = Math.min(oldLines.length, linesBefore + oldStringLines + contextLines)
  const endLineNew = Math.min(newLines.length, linesBefore + newStringLines + contextLines)

  const parts: string[] = []
  parts.push(`@@ -${startLine + 1},${endLineOld - startLine} +${startLine + 1},${endLineNew - startLine} @@`)

  // Context before
  for (let i = startLine; i < linesBefore; i++) {
    parts.push(` ${oldLines[i] ?? ''}`)
  }

  // Removed lines
  for (let i = linesBefore; i < linesBefore + oldStringLines; i++) {
    parts.push(`-${oldLines[i] ?? ''}`)
  }

  // Added lines
  for (let i = linesBefore; i < linesBefore + newStringLines; i++) {
    parts.push(`+${newLines[i] ?? ''}`)
  }

  // Context after
  for (let i = linesBefore + newStringLines; i < endLineNew; i++) {
    parts.push(` ${newLines[i] ?? ''}`)
  }

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Count Occurrences
// ---------------------------------------------------------------------------

function countOccurrences(content: string, search: string): number {
  if (!search) return 0
  let count = 0
  let idx = 0
  while (true) {
    idx = content.indexOf(search, idx)
    if (idx < 0) break
    count++
    idx += search.length
  }
  return count
}

// ---------------------------------------------------------------------------
// Atomic Write
// ---------------------------------------------------------------------------

function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })

  // Write to temp file in same directory (for same-filesystem rename)
  const tempPath = join(dir, `.nanocode-tmp-${randomUUID()}`)
  try {
    writeFileSync(tempPath, content, 'utf-8')
    renameSync(tempPath, filePath)
  } catch (err) {
    // Clean up temp file on failure
    try {
      const { unlinkSync } = require('node:fs')
      unlinkSync(tempPath)
    } catch {
      // Ignore cleanup errors
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const editToolDef: ToolDef<EditInput> = {
  name: 'Edit',

  description: 'Make a targeted edit to a file by specifying the exact text to find and replace. For creating new files, use empty old_string.',

  inputSchema,

  async call(input: EditInput, context: ToolContext): Promise<ToolResult> {
    const anyInput = input as any
    const rawPath: string = input.file_path || anyInput.path || anyInput.filePath || ''
    if (!rawPath) {
      return { result: 'Error: file_path parameter is required.', isError: true }
    }
    const { old_string, new_string, replace_all } = input
    const cwd = context.cwd || process.cwd()
    const filePath = rawPath.startsWith('/') ? rawPath : resolve(cwd, rawPath)

    // -----------------------------------------------------------------------
    // 1. No-op check
    // -----------------------------------------------------------------------
    if (old_string === new_string) {
      return {
        result: 'Error: old_string and new_string are identical. No changes needed.',
        isError: true,
      }
    }

    // -----------------------------------------------------------------------
    // 2. File existence check — empty old_string means create
    // -----------------------------------------------------------------------
    const fileExists = existsSync(filePath)

    if (old_string === '' && !fileExists) {
      // Create new file with new_string content
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        atomicWriteFileSync(filePath, new_string)

        // Track in file history
        context.modifiedFiles.add(filePath)
        context.fileHistory.trackedFiles.add(filePath)

        // Update readFileState cache
        const mtime = statSync(filePath).mtimeMs
        context.readFileState.set(filePath, {
          content: new_string,
          timestamp: mtime,
        })

        const lineCount = new_string.split('\n').length
        return {
          result: `Created new file: ${filePath} (${lineCount} lines)`,
          isError: false,
        }
      } catch (err: any) {
        return {
          result: `Error creating file: ${err.message}`,
          isError: true,
        }
      }
    }

    if (!fileExists) {
      return {
        result: `Error: file not found: ${filePath}. To create a new file, use empty old_string with the file content as new_string.`,
        isError: true,
      }
    }

    // -----------------------------------------------------------------------
    // 3. Read-before-edit check
    // -----------------------------------------------------------------------
    const cachedState = context.readFileState.get(filePath)

    if (!cachedState) {
      return {
        result: `Error: you must Read the file before editing it. Use the Read tool first to view ${filePath}.`,
        isError: true,
      }
    }

    // If the file was only partially viewed, warn
    if (cachedState.isPartialView) {
      // Allow edit if the old_string is within the cached content
      if (!cachedState.content.includes(old_string)) {
        return {
          result: `Error: the file was only partially read (lines ${cachedState.offset ?? 1}-${(cachedState.offset ?? 1) + (cachedState.limit ?? 2000) - 1}). Read the full file or the relevant section before editing.`,
          isError: true,
        }
      }
    }

    // -----------------------------------------------------------------------
    // 4. Staleness check — file modified since last read?
    // -----------------------------------------------------------------------
    let currentMtime: number
    try {
      currentMtime = statSync(filePath).mtimeMs
    } catch (err: any) {
      return { result: `Error checking file: ${err.message}`, isError: true }
    }

    if (currentMtime > cachedState.timestamp + 1000) {
      // File was modified externally. Re-read is needed.
      return {
        result: `Error: file has been modified since you last read it (cached: ${new Date(cachedState.timestamp).toISOString()}, current: ${new Date(currentMtime).toISOString()}). Please Read the file again before editing.`,
        isError: true,
      }
    }

    // -----------------------------------------------------------------------
    // 5. Read current content and find old_string
    // -----------------------------------------------------------------------
    let content: string
    try {
      content = readFileSync(filePath, 'utf-8')
    } catch (err: any) {
      return { result: `Error reading file: ${err.message}`, isError: true }
    }

    if (!content.includes(old_string)) {
      // Provide helpful error
      const trimmedSearch = old_string.trim()
      if (trimmedSearch && content.includes(trimmedSearch)) {
        return {
          result: `Error: exact match not found, but a match was found ignoring leading/trailing whitespace. Ensure old_string matches exactly, including whitespace and indentation.`,
          isError: true,
        }
      }

      return {
        result: `Error: old_string not found in ${filePath}. Make sure the text matches exactly, including whitespace and line breaks.`,
        isError: true,
      }
    }

    // -----------------------------------------------------------------------
    // 6. Uniqueness check
    // -----------------------------------------------------------------------
    const matchCount = countOccurrences(content, old_string)

    if (matchCount > 1 && !replace_all) {
      return {
        result: `Error: found ${matchCount} matches for old_string. To replace all occurrences, set replace_all: true. Otherwise, provide more context in old_string to uniquely identify the target.`,
        isError: true,
      }
    }

    // -----------------------------------------------------------------------
    // Apply the edit
    // -----------------------------------------------------------------------
    let newContent: string
    if (replace_all) {
      newContent = content.split(old_string).join(new_string)
    } else {
      const idx = content.indexOf(old_string)
      newContent = content.slice(0, idx) + new_string + content.slice(idx + old_string.length)
    }

    // Atomic write
    try {
      atomicWriteFileSync(filePath, newContent)
    } catch (err: any) {
      return { result: `Error writing file: ${err.message}`, isError: true }
    }

    // Track in history
    context.modifiedFiles.add(filePath)
    context.fileHistory.trackedFiles.add(filePath)

    // Update readFileState cache
    const newMtime = statSync(filePath).mtimeMs
    context.readFileState.set(filePath, {
      content: newContent,
      timestamp: newMtime,
    })

    // Generate diff snippet
    const diff = generateDiffSnippet(content, newContent, old_string, new_string)
    const replacements = replace_all ? matchCount : 1

    return {
      result: `Edited ${filePath} (${replacements} replacement${replacements > 1 ? 's' : ''}):\n\n${diff}`,
      isError: false,
    }
  },

  prompt(): string {
    return [
      'Make targeted edits to files using find-and-replace.',
      '',
      'Guidelines:',
      '- ALWAYS Read the file before editing.',
      '- old_string must match EXACTLY (whitespace matters).',
      '- Include enough context in old_string for a unique match.',
      '- To create a new file: use empty old_string with content as new_string.',
      '- To delete text: use empty new_string.',
      '- Prefer Edit over Write for modifying existing files.',
    ].join('\n')
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  maxResultSizeChars: 30_000,

  userFacingName(input: EditInput): string {
    return `Edit: ${input.file_path}`
  },
}
