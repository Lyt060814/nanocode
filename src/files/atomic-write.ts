/**
 * NanoCode — Atomic File Write
 *
 * Writes files atomically by writing to a temporary file in the same
 * directory, then renaming. Falls back to direct write if rename fails.
 * Preserves original file permissions and creates parent directories.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

/**
 * Generate a random temporary filename in the same directory as the target.
 */
function tempPath(filePath: string): string {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath)
  const rand = crypto.randomBytes(8).toString('hex')
  return path.join(dir, `${base}.tmp.${rand}`)
}

/**
 * Get the file mode (permissions) of an existing file.
 * Returns null if the file does not exist.
 */
async function getFileMode(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.stat(filePath)
    return stat.mode
  } catch {
    return null
  }
}

/**
 * Atomically write content to a file.
 *
 * Strategy:
 * 1. Capture original file permissions (if the file exists)
 * 2. Ensure parent directories exist
 * 3. Write content to a temp file in the same directory
 * 4. Rename temp file over the target (atomic on same filesystem)
 * 5. Restore original permissions if applicable
 *
 * If the rename fails (e.g., cross-device), falls back to direct writeFile.
 *
 * @param filePath Absolute path to the target file
 * @param content  String content to write
 */
export async function atomicWrite(
  filePath: string,
  content: string,
): Promise<void> {
  const resolved = path.resolve(filePath)
  const dir = path.dirname(resolved)

  // Ensure parent directory exists
  await fs.mkdir(dir, { recursive: true })

  // Capture original permissions before overwrite
  const originalMode = await getFileMode(resolved)

  const tmp = tempPath(resolved)

  try {
    // Write to temp file
    await fs.writeFile(tmp, content, { encoding: 'utf-8' })

    // Restore permissions on the temp file before rename
    if (originalMode !== null) {
      try {
        await fs.chmod(tmp, originalMode)
      } catch {
        // Best-effort permission preservation
      }
    }

    // Atomic rename
    try {
      await fs.rename(tmp, resolved)
    } catch (renameErr) {
      // Fallback: direct write (not atomic, but functional)
      await fs.writeFile(resolved, content, { encoding: 'utf-8' })

      // Restore permissions on direct write
      if (originalMode !== null) {
        try {
          await fs.chmod(resolved, originalMode)
        } catch {
          // Best-effort
        }
      }

      // Clean up temp file
      try {
        await fs.unlink(tmp)
      } catch {
        // Temp may already be gone
      }
    }
  } catch (err) {
    // Clean up temp file on any error
    try {
      await fs.unlink(tmp)
    } catch {
      // Ignore cleanup errors
    }
    throw err
  }
}
