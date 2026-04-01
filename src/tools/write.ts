/**
 * Write Tool — Full file creation/overwrite
 *
 * Creates new files or completely overwrites existing ones.
 * Includes read-before-write safety check for existing files.
 * Uses atomic writes (temp → rename) to prevent corruption.
 */

import { readFileSync, writeFileSync, statSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext } from '../core/types.js'

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  file_path: z.string().describe(
    'The file to write. Absolute or relative to working directory.',
  ),
  content: z.string().describe(
    'The complete content to write to the file.',
  ),
})

type WriteInput = z.infer<typeof inputSchema>

// ---------------------------------------------------------------------------
// Atomic Write
// ---------------------------------------------------------------------------

function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })

  const tempPath = join(dir, `.nanocode-tmp-${randomUUID()}`)
  try {
    writeFileSync(tempPath, content, 'utf-8')
    renameSync(tempPath, filePath)
  } catch (err) {
    try {
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

export const writeToolDef: ToolDef<WriteInput> = {
  name: 'Write',

  description: 'Write content to a file, creating it if it does not exist or overwriting if it does. For targeted edits to existing files, prefer the Edit tool instead.',

  inputSchema,

  async call(input: WriteInput, context: ToolContext): Promise<ToolResult> {
    const anyInput = input as any
    const rawPath: string = input.file_path || anyInput.path || anyInput.filePath || ''
    if (!rawPath) {
      return { result: 'Error: file_path parameter is required.', isError: true }
    }
    const { content } = input
    const cwd = context.cwd || process.cwd()
    const filePath = rawPath.startsWith('/') ? rawPath : resolve(cwd, rawPath)

    // -----------------------------------------------------------------------
    // Read-before-write check for existing files
    // -----------------------------------------------------------------------
    if (existsSync(filePath)) {
      const cachedState = context.readFileState.get(filePath)
      if (!cachedState) {
        return {
          result: `Error: file already exists at ${filePath}. You must Read the file before overwriting it. Use the Read tool first, or use the Edit tool for targeted changes.`,
          isError: true,
        }
      }

      // Staleness check
      let currentMtime: number
      try {
        currentMtime = statSync(filePath).mtimeMs
      } catch (err: any) {
        return { result: `Error checking file: ${err.message}`, isError: true }
      }

      if (currentMtime > cachedState.timestamp + 1000) {
        return {
          result: `Error: file has been modified since you last read it. Please Read the file again before writing.`,
          isError: true,
        }
      }
    }

    // -----------------------------------------------------------------------
    // Write the file
    // -----------------------------------------------------------------------
    try {
      atomicWriteFileSync(filePath, content)
    } catch (err: any) {
      if (err.code === 'EACCES') {
        return { result: `Error: permission denied writing to ${filePath}`, isError: true }
      }
      return { result: `Error writing file: ${err.message}`, isError: true }
    }

    // Track in history
    context.modifiedFiles.add(filePath)
    context.fileHistory.trackedFiles.add(filePath)

    // Update readFileState cache
    let mtime: number
    try {
      mtime = statSync(filePath).mtimeMs
    } catch {
      mtime = Date.now()
    }

    context.readFileState.set(filePath, {
      content,
      timestamp: mtime,
    })

    const lineCount = content.split('\n').length

    return {
      result: `Written: ${filePath} (${lineCount} lines)`,
      isError: false,
    }
  },

  prompt(): string {
    return [
      'Write complete file contents to disk.',
      '',
      'Guidelines:',
      '- Use for creating new files or complete rewrites.',
      '- For targeted edits, use the Edit tool instead.',
      '- You must Read existing files before overwriting them.',
      '- Parent directories are created automatically.',
      '- Writes are atomic (temp file → rename) to prevent corruption.',
    ].join('\n')
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  maxResultSizeChars: 30_000,

  userFacingName(input: WriteInput): string {
    return `Write: ${input.file_path}`
  },
}
