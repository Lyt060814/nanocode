/**
 * nanocode — File Utilities
 *
 * Common file-system helpers: path normalization, encoding detection,
 * binary detection, line formatting, and project boundary checks.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/**
 * Normalize a path to an absolute, canonical form.
 * Resolves relative segments and normalizes separators.
 */
export function normalizePath(p: string): string {
  return path.resolve(path.normalize(p))
}

/**
 * Detect encoding from a buffer by checking for a UTF-16 LE BOM.
 *
 * - Bytes 0xFF 0xFE at the start → 'utf-16le'
 * - Otherwise → 'utf-8'
 */
export function detectEncoding(buffer: Buffer): 'utf-8' | 'utf-16le' {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return 'utf-16le'
  }
  return 'utf-8'
}

/**
 * Replace all Windows-style line endings (\r\n) with Unix-style (\n).
 */
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

/**
 * Check whether a file path is within the project root directory.
 *
 * Used as a security boundary to prevent tools from reading/writing
 * outside the project.
 *
 * Both paths are resolved to absolute form before comparison.
 */
export function isWithinProject(filePath: string, projectRoot: string): boolean {
  const resolved = normalizePath(filePath)
  const root = normalizePath(projectRoot)

  // The file must be equal to or under the project root
  if (resolved === root) return true
  return resolved.startsWith(root + path.sep)
}

/**
 * Heuristic binary file detection.
 *
 * Reads the first 8 KB of a file and checks for null bytes (0x00).
 * Presence of null bytes strongly indicates a binary file.
 *
 * Returns false if the file cannot be read.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  let handle: fs.FileHandle | null = null
  try {
    handle = await fs.open(filePath, 'r')
    const buf = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buf, 0, 8192, 0)

    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0x00) {
        return true
      }
    }

    return false
  } catch {
    return false
  } finally {
    if (handle) {
      await handle.close()
    }
  }
}

/**
 * Format file content with line numbers.
 *
 * Adds "  N\t" prefix to each line, where N is the 1-based line number.
 * If offset is provided, numbering starts from that value.
 *
 * @param content  The file content string
 * @param offset   Starting line number (default: 1)
 */
export function formatLineNumbers(content: string, offset: number = 1): string {
  const lines = content.split('\n')
  const maxDigits = String(offset + lines.length - 1).length
  const formatted = lines.map((line, i) => {
    const lineNum = String(offset + i).padStart(maxDigits, ' ')
    return `  ${lineNum}\t${line}`
  })
  return formatted.join('\n')
}

/**
 * Get the size of a file in bytes.
 * Returns -1 if the file does not exist or cannot be stat'd.
 */
export async function getFileSize(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath)
    return stat.size
  } catch {
    return -1
  }
}
