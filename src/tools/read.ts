/**
 * Read Tool — File reading with line numbers
 *
 * Reads files and displays them with line numbers (cat -n style).
 * Handles encoding detection, binary files, and caches state for edit validation.
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext, FileState } from '../core/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 2000
const MAX_RESULT_SIZE_CHARS = 60_000
const BINARY_CHECK_SIZE = 8192

// Image extensions (unsupported in text mode)
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
  '.webp', '.tiff', '.tif', '.psd', '.raw', '.heif', '.heic',
])

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  file_path: z.string().describe(
    'Absolute path to the file to read. Relative paths will be resolved against the working directory.',
  ),
  offset: z.number().optional().describe(
    'Line number to start reading from (1-based). Default: 1.',
  ),
  limit: z.number().optional().describe(
    'Maximum number of lines to read. Default: 2000.',
  ),
})

type ReadInput = z.infer<typeof inputSchema>

// ---------------------------------------------------------------------------
// Encoding Detection
// ---------------------------------------------------------------------------

function detectEncoding(buffer: Buffer): BufferEncoding {
  // Check BOM for UTF-16LE: 0xFF 0xFE
  if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return 'utf16le'
  }
  // Check BOM for UTF-16BE: 0xFE 0xFF
  if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) {
    // Node doesn't have utf16be, read as utf16le after byte-swapping
    // For simplicity, default to utf-8
    return 'utf-8'
  }
  // Check BOM for UTF-8: 0xEF 0xBB 0xBF
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return 'utf-8'
  }
  return 'utf-8'
}

// ---------------------------------------------------------------------------
// Binary Detection
// ---------------------------------------------------------------------------

function isBinaryFile(buffer: Buffer): boolean {
  const checkSize = Math.min(buffer.length, BINARY_CHECK_SIZE)
  for (let i = 0; i < checkSize; i++) {
    const byte = buffer[i]!
    // Null byte is strong indicator of binary
    if (byte === 0) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Line Formatting
// ---------------------------------------------------------------------------

function formatWithLineNumbers(lines: string[], startLine: number): string {
  const maxLineNum = startLine + lines.length - 1
  const padWidth = String(maxLineNum).length
  const formatted: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const lineNum = String(startLine + i).padStart(padWidth, ' ')
    formatted.push(`${lineNum}\t${lines[i]}`)
  }

  return formatted.join('\n')
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const readToolDef: ToolDef<ReadInput> = {
  name: 'Read',

  description: 'Read a file and display its contents with line numbers. Supports text files with various encodings.',

  inputSchema,

  async call(input: ReadInput, context: ToolContext): Promise<ToolResult> {
    const rawPath = (input as any).file_path ?? (input as any).path ?? ''
    if (!rawPath) {
      return { result: 'Error: file_path parameter is required.', isError: true }
    }
    const { offset, limit } = input
    const cwd = context.cwd || process.cwd()
    const filePath = rawPath.startsWith('/') ? rawPath : resolve(cwd, rawPath)
    const lineLimit = limit ?? DEFAULT_LIMIT
    const startOffset = Math.max(1, offset ?? 1)

    // Check for image files
    const ext = extname(filePath).toLowerCase()
    if (IMAGE_EXTENSIONS.has(ext)) {
      return {
        result: `This is an image file (${ext}). Image viewing is not supported in text mode. Use a separate image viewer or the Bash tool with an appropriate command.`,
        isError: false,
      }
    }

    // Read file
    let buffer: Buffer
    try {
      buffer = readFileSync(filePath)
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { result: `Error: file not found: ${filePath}`, isError: true }
      }
      if (err.code === 'EISDIR') {
        return { result: `Error: ${filePath} is a directory, not a file. Use ls or find to list directory contents.`, isError: true }
      }
      if (err.code === 'EACCES') {
        return { result: `Error: permission denied: ${filePath}`, isError: true }
      }
      return { result: `Error reading file: ${err.message}`, isError: true }
    }

    // Check for binary
    if (isBinaryFile(buffer)) {
      const stat = statSync(filePath)
      return {
        result: `This is a binary file (${stat.size} bytes). Use xxd, od, or strings to inspect binary content.`,
        isError: false,
      }
    }

    // Detect encoding and decode
    const encoding = detectEncoding(buffer)
    let content: string
    if (encoding === 'utf16le') {
      // Skip BOM
      content = buffer.slice(2).toString('utf16le')
    } else {
      // Skip UTF-8 BOM if present
      const start = (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) ? 3 : 0
      content = buffer.slice(start).toString('utf-8')
    }

    // Split into lines
    const allLines = content.split('\n')
    const totalLines = allLines.length

    // Apply offset and limit
    const startIdx = startOffset - 1 // Convert 1-based to 0-based
    const endIdx = Math.min(startIdx + lineLimit, totalLines)
    const selectedLines = allLines.slice(startIdx, endIdx)
    const isPartialView = startIdx > 0 || endIdx < totalLines

    // Format with line numbers
    let output = formatWithLineNumbers(selectedLines, startOffset)

    // Add metadata for partial views
    if (isPartialView) {
      const meta: string[] = []
      if (startIdx > 0) {
        meta.push(`(showing from line ${startOffset})`)
      }
      if (endIdx < totalLines) {
        meta.push(`(${totalLines - endIdx} more lines below, ${totalLines} total)`)
      }
      if (meta.length > 0) {
        output += '\n' + meta.join(' ')
      }
    }

    // Get file timestamp for edit validation
    let mtime: number
    try {
      mtime = statSync(filePath).mtimeMs
    } catch {
      mtime = Date.now()
    }

    // Update readFileState cache
    const fileState: FileState = {
      content,
      timestamp: mtime,
      offset: startOffset,
      limit: lineLimit,
      isPartialView,
    }
    context.readFileState.set(filePath, fileState)

    return { result: output, isError: false }
  },

  prompt(): string {
    return [
      'Read files to understand code, configurations, and data.',
      '',
      'Guidelines:',
      '- Always read a file before editing it.',
      '- Use offset and limit for large files to read specific sections.',
      '- The default limit is 2000 lines.',
      '- Line numbers are shown in cat -n format.',
      '- For binary files, use Bash with xxd or strings instead.',
    ].join('\n')
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: MAX_RESULT_SIZE_CHARS,

  userFacingName(input: ReadInput): string {
    return `Read: ${input.file_path}`
  },
}
