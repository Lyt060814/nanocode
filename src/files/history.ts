/**
 * nanocode — File History State
 *
 * Tracks file edits with versioned backups and snapshots.
 * Supports rewind-to-snapshot and diff stats between snapshots.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as os from 'node:os'
import type {
  FileHistoryState,
  FileHistorySnapshot,
  FileHistoryBackup,
} from '../core/types.js'

const MAX_SNAPSHOTS = 100

/**
 * Base directory for file history backups.
 */
function historyDir(sessionId: string): string {
  return path.join(os.homedir(), '.nanocode', 'file-history', sessionId)
}

/**
 * Deterministic hash for a file path, used in backup file naming.
 */
function pathHash(filePath: string): string {
  return crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16)
}

/**
 * Read a file safely, returning null if it doesn't exist.
 */
async function safeReadFile(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath)
  } catch {
    return null
  }
}

/**
 * Get mtime of a file, returning 0 if it doesn't exist.
 */
async function safeMtime(filePath: string): Promise<number> {
  try {
    const stat = await fs.stat(filePath)
    return stat.mtimeMs
  } catch {
    return 0
  }
}

/**
 * Create a fresh FileHistoryState.
 */
export function createFileHistoryState(): FileHistoryState {
  return {
    snapshots: [],
    trackedFiles: new Set<string>(),
    snapshotSequence: 0,
  }
}

/**
 * Track an edit to a file: backup the current content before modification.
 *
 * - Generates a hash-based filename: sha256(filePath).slice(0,16) + "@v" + version
 * - Stores backup under ~/.nanocode/file-history/{sessionId}/
 * - Only creates a backup if the file is not already backed up in the latest snapshot
 *   at the same version.
 *
 * @param state   The file history state to mutate
 * @param filePath  Absolute path of the file being edited
 * @param sessionId Current session ID
 */
export async function trackEdit(
  state: FileHistoryState,
  filePath: string,
  sessionId: string,
): Promise<void> {
  const resolved = path.resolve(filePath)

  // Determine current version for this file
  let currentVersion = 0
  // Walk snapshots newest-first to find the latest version
  for (let i = state.snapshots.length - 1; i >= 0; i--) {
    const snap = state.snapshots[i]
    const backup = snap.trackedFileBackups.get(resolved)
    if (backup) {
      currentVersion = backup.version
      break
    }
  }

  const nextVersion = currentVersion + 1

  // Check if already tracked at this version in the latest snapshot
  if (state.snapshots.length > 0) {
    const latest = state.snapshots[state.snapshots.length - 1]
    const existing = latest.trackedFileBackups.get(resolved)
    if (existing && existing.version === nextVersion) {
      // Already backed up at this version in the latest snapshot
      return
    }
  }

  // Read current file content (before the edit overwrites it)
  const content = await safeReadFile(resolved)

  const hash = pathHash(resolved)
  const backupName = `${hash}@v${nextVersion}`
  const dir = historyDir(sessionId)

  await fs.mkdir(dir, { recursive: true })

  if (content !== null) {
    await fs.writeFile(path.join(dir, backupName), content)
  }

  // Mark as tracked
  state.trackedFiles.add(resolved)

  // If there is a latest snapshot, add/update the backup reference there
  // so subsequent snapshots know the latest version
  // (The actual snapshot will be made by makeSnapshot)
}

/**
 * Create a snapshot of all tracked files at a given message boundary.
 *
 * For each tracked file:
 * - Check mtime to skip unchanged files
 * - Create a versioned backup
 * - Record in the snapshot
 *
 * Evicts oldest snapshots when MAX_SNAPSHOTS is exceeded.
 *
 * @param state     The file history state to mutate
 * @param messageId  ID of the message that triggered the snapshot
 * @param sessionId  Current session ID
 */
export async function makeSnapshot(
  state: FileHistoryState,
  messageId: string,
  sessionId: string,
): Promise<FileHistorySnapshot> {
  const dir = historyDir(sessionId)
  await fs.mkdir(dir, { recursive: true })

  const trackedFileBackups = new Map<string, FileHistoryBackup>()
  const now = new Date()

  for (const filePath of state.trackedFiles) {
    // Determine previous version
    let prevVersion = 0
    let prevMtime = 0

    for (let i = state.snapshots.length - 1; i >= 0; i--) {
      const snap = state.snapshots[i]
      const prev = snap.trackedFileBackups.get(filePath)
      if (prev) {
        prevVersion = prev.version
        prevMtime = prev.backupTime.getTime()
        break
      }
    }

    // Check current mtime
    const currentMtime = await safeMtime(filePath)

    // Skip if file hasn't changed since last backup
    if (prevVersion > 0 && currentMtime > 0 && currentMtime <= prevMtime) {
      // Carry forward the previous backup reference
      trackedFileBackups.set(filePath, {
        backupFileName: `${pathHash(filePath)}@v${prevVersion}`,
        version: prevVersion,
        backupTime: new Date(prevMtime),
      })
      continue
    }

    const nextVersion = prevVersion + 1
    const hash = pathHash(filePath)
    const backupName = `${hash}@v${nextVersion}`

    // Read and backup file
    const content = await safeReadFile(filePath)
    if (content !== null) {
      await fs.writeFile(path.join(dir, backupName), content)
      trackedFileBackups.set(filePath, {
        backupFileName: backupName,
        version: nextVersion,
        backupTime: now,
      })
    } else {
      // File was deleted or doesn't exist
      trackedFileBackups.set(filePath, {
        backupFileName: null,
        version: nextVersion,
        backupTime: now,
      })
    }
  }

  state.snapshotSequence++

  const snapshot: FileHistorySnapshot = {
    messageId,
    trackedFileBackups,
    timestamp: now,
  }

  state.snapshots.push(snapshot)

  // Evict oldest if over limit
  while (state.snapshots.length > MAX_SNAPSHOTS) {
    state.snapshots.shift()
  }

  return snapshot
}

/**
 * Rewind files to the state captured in a specific snapshot.
 *
 * Reads backup files and writes them back to their original locations.
 * If a backup is null (file didn't exist at that point), the file is deleted.
 *
 * @param state          The file history state
 * @param snapshotIndex  Index into state.snapshots
 * @param sessionId      Current session ID
 */
export async function rewind(
  state: FileHistoryState,
  snapshotIndex: number,
  sessionId: string,
): Promise<void> {
  if (snapshotIndex < 0 || snapshotIndex >= state.snapshots.length) {
    throw new Error(
      `Invalid snapshot index ${snapshotIndex}. Valid range: 0..${state.snapshots.length - 1}`,
    )
  }

  const snapshot = state.snapshots[snapshotIndex]
  const dir = historyDir(sessionId)

  for (const [filePath, backup] of snapshot.trackedFileBackups) {
    if (backup.backupFileName === null) {
      // File didn't exist at that snapshot — remove it
      try {
        await fs.unlink(filePath)
      } catch {
        // Already gone or never existed, fine
      }
      continue
    }

    const backupPath = path.join(dir, backup.backupFileName)
    const content = await safeReadFile(backupPath)

    if (content !== null) {
      // Ensure parent directory exists
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, content)
    }
  }

  // Truncate snapshot history to this point
  state.snapshots = state.snapshots.slice(0, snapshotIndex + 1)
}

/**
 * Compute diff statistics between two snapshots.
 *
 * For each file that differs between snapshotA and snapshotB,
 * returns the number of inserted and deleted lines.
 *
 * @param state      The file history state
 * @param snapshotA  Index of the "before" snapshot
 * @param snapshotB  Index of the "after" snapshot
 * @param sessionId  Current session ID
 */
export async function getDiffStats(
  state: FileHistoryState,
  snapshotA: number,
  snapshotB: number,
  sessionId: string,
): Promise<Array<{ file: string; insertions: number; deletions: number }>> {
  if (snapshotA < 0 || snapshotA >= state.snapshots.length) {
    throw new Error(`Invalid snapshotA index: ${snapshotA}`)
  }
  if (snapshotB < 0 || snapshotB >= state.snapshots.length) {
    throw new Error(`Invalid snapshotB index: ${snapshotB}`)
  }

  const snapA = state.snapshots[snapshotA]
  const snapB = state.snapshots[snapshotB]
  const dir = historyDir(sessionId)

  // Collect all file paths from both snapshots
  const allFiles = new Set<string>([
    ...snapA.trackedFileBackups.keys(),
    ...snapB.trackedFileBackups.keys(),
  ])

  const results: Array<{ file: string; insertions: number; deletions: number }> = []

  for (const filePath of allFiles) {
    const backupA = snapA.trackedFileBackups.get(filePath)
    const backupB = snapB.trackedFileBackups.get(filePath)

    // Read content from each snapshot's backup
    const contentA = await readBackupContent(dir, backupA ?? null)
    const contentB = await readBackupContent(dir, backupB ?? null)

    if (contentA === contentB) continue

    const linesA = contentA ? contentA.split('\n') : []
    const linesB = contentB ? contentB.split('\n') : []

    // Simple line-based diff: count lines in B not in A (insertions)
    // and lines in A not in B (deletions)
    const setA = new Set(linesA)
    const setB = new Set(linesB)

    let insertions = 0
    let deletions = 0

    for (const line of linesB) {
      if (!setA.has(line)) insertions++
    }
    for (const line of linesA) {
      if (!setB.has(line)) deletions++
    }

    results.push({ file: filePath, insertions, deletions })
  }

  return results
}

/**
 * Read the content of a backup file, returning null if the backup
 * doesn't exist or indicates the file was absent.
 */
async function readBackupContent(
  dir: string,
  backup: FileHistoryBackup | null,
): Promise<string | null> {
  if (!backup || backup.backupFileName === null) return null
  const content = await safeReadFile(path.join(dir, backup.backupFileName))
  return content ? content.toString('utf-8') : null
}
