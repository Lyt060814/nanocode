import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  createFileHistoryState,
  trackEdit,
  makeSnapshot,
  rewind,
  getDiffStats,
} from '../../src/files/history'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string
let sessionId: string
let historyBase: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nanocode-history-test-'))
  sessionId = `test-session-${Date.now()}-${Math.random().toString(36).slice(2)}`
  historyBase = join(homedir(), '.nanocode', 'file-history', sessionId)
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  // Clean up history directory
  try {
    rmSync(historyBase, { recursive: true, force: true })
  } catch {
    // May not exist
  }
})

// ---------------------------------------------------------------------------
// createFileHistoryState
// ---------------------------------------------------------------------------

describe('createFileHistoryState', () => {
  it('returns initial state with empty fields', () => {
    const state = createFileHistoryState()
    expect(state.snapshots).toEqual([])
    expect(state.trackedFiles).toBeInstanceOf(Set)
    expect(state.trackedFiles.size).toBe(0)
    expect(state.snapshotSequence).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// trackEdit
// ---------------------------------------------------------------------------

describe('trackEdit', () => {
  it('creates backup file in history directory', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'test.ts')
    writeFileSync(filePath, 'original content')

    await trackEdit(state, filePath, sessionId)

    // File should be tracked
    expect(state.trackedFiles.has(join(tempDir, 'test.ts'))).toBe(true)
  })

  it('adds file to tracked files set', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'test.ts')
    writeFileSync(filePath, 'content')

    await trackEdit(state, filePath, sessionId)
    expect(state.trackedFiles.size).toBe(1)
  })

  it('handles non-existent file gracefully', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'nonexistent.ts')

    // Should not throw
    await expect(trackEdit(state, filePath, sessionId)).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// makeSnapshot
// ---------------------------------------------------------------------------

describe('makeSnapshot', () => {
  it('creates a snapshot with tracked files', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'test.ts')
    writeFileSync(filePath, 'snapshot content')

    state.trackedFiles.add(filePath)

    const snap = await makeSnapshot(state, 'msg-001', sessionId)

    expect(snap.messageId).toBe('msg-001')
    expect(snap.trackedFileBackups).toBeInstanceOf(Map)
    expect(snap.trackedFileBackups.has(filePath)).toBe(true)
    expect(snap.timestamp).toBeInstanceOf(Date)
  })

  it('increments snapshotSequence', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'test.ts')
    writeFileSync(filePath, 'content')
    state.trackedFiles.add(filePath)

    expect(state.snapshotSequence).toBe(0)
    await makeSnapshot(state, 'msg-001', sessionId)
    expect(state.snapshotSequence).toBe(1)
    await makeSnapshot(state, 'msg-002', sessionId)
    expect(state.snapshotSequence).toBe(2)
  })

  it('adds snapshot to state.snapshots', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'test.ts')
    writeFileSync(filePath, 'content')
    state.trackedFiles.add(filePath)

    await makeSnapshot(state, 'msg-001', sessionId)
    expect(state.snapshots).toHaveLength(1)

    await makeSnapshot(state, 'msg-002', sessionId)
    expect(state.snapshots).toHaveLength(2)
  })

  it('handles deleted files (backupFileName is null)', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'deleted.ts')
    // Track a file that does not exist
    state.trackedFiles.add(filePath)

    const snap = await makeSnapshot(state, 'msg-001', sessionId)
    const backup = snap.trackedFileBackups.get(filePath)
    expect(backup).toBeDefined()
    expect(backup!.backupFileName).toBeNull()
  })

  it('evicts oldest snapshots when exceeding MAX_SNAPSHOTS (100)', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'test.ts')
    writeFileSync(filePath, 'content')
    state.trackedFiles.add(filePath)

    // Create 102 snapshots
    for (let i = 0; i < 102; i++) {
      writeFileSync(filePath, `content-${i}`)
      await makeSnapshot(state, `msg-${i}`, sessionId)
    }

    expect(state.snapshots.length).toBeLessThanOrEqual(100)
    // Oldest snapshots should have been evicted
    expect(state.snapshots[0].messageId).not.toBe('msg-0')
  })
})

// ---------------------------------------------------------------------------
// rewind
// ---------------------------------------------------------------------------

describe('rewind', () => {
  it('restores files to snapshot state', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'test.ts')

    // Initial content
    writeFileSync(filePath, 'version 1')
    state.trackedFiles.add(filePath)
    await makeSnapshot(state, 'snap-0', sessionId)

    // Modify file
    writeFileSync(filePath, 'version 2')
    await makeSnapshot(state, 'snap-1', sessionId)

    // Rewind to snapshot 0
    await rewind(state, 0, sessionId)

    const content = readFileSync(filePath, 'utf-8')
    expect(content).toBe('version 1')
  })

  it('truncates snapshot history after rewind', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'test.ts')
    writeFileSync(filePath, 'v1')
    state.trackedFiles.add(filePath)

    await makeSnapshot(state, 'snap-0', sessionId)
    writeFileSync(filePath, 'v2')
    await makeSnapshot(state, 'snap-1', sessionId)
    writeFileSync(filePath, 'v3')
    await makeSnapshot(state, 'snap-2', sessionId)

    await rewind(state, 1, sessionId)
    // Should only have snapshots 0 and 1
    expect(state.snapshots).toHaveLength(2)
  })

  it('throws for invalid snapshot index (negative)', async () => {
    const state = createFileHistoryState()
    await expect(rewind(state, -1, sessionId)).rejects.toThrow('Invalid snapshot index')
  })

  it('throws for out-of-range snapshot index', async () => {
    const state = createFileHistoryState()
    await expect(rewind(state, 0, sessionId)).rejects.toThrow('Invalid snapshot index')
  })

  it('deletes files that did not exist at snapshot time', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'later.ts')

    // First snapshot: file does not exist
    state.trackedFiles.add(filePath)
    await makeSnapshot(state, 'snap-0', sessionId)

    // Create the file
    writeFileSync(filePath, 'new content')
    await makeSnapshot(state, 'snap-1', sessionId)

    // Rewind to snap-0 where file didn't exist
    await rewind(state, 0, sessionId)
    expect(existsSync(filePath)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// getDiffStats
// ---------------------------------------------------------------------------

describe('getDiffStats', () => {
  it('returns diff stats between two snapshots', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'test.ts')

    writeFileSync(filePath, 'line1\nline2\nline3')
    state.trackedFiles.add(filePath)
    await makeSnapshot(state, 'snap-0', sessionId)

    writeFileSync(filePath, 'line1\nmodified\nline3\nline4')
    await makeSnapshot(state, 'snap-1', sessionId)

    const stats = await getDiffStats(state, 0, 1, sessionId)
    expect(stats).toHaveLength(1)
    expect(stats[0].file).toBe(filePath)
    expect(stats[0].insertions).toBeGreaterThan(0)
    expect(stats[0].deletions).toBeGreaterThan(0)
  })

  it('returns empty array when snapshots are identical', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'test.ts')

    writeFileSync(filePath, 'same content')
    state.trackedFiles.add(filePath)
    await makeSnapshot(state, 'snap-0', sessionId)
    // Don't change the file
    await makeSnapshot(state, 'snap-1', sessionId)

    const stats = await getDiffStats(state, 0, 1, sessionId)
    expect(stats).toHaveLength(0)
  })

  it('throws for invalid snapshot indices', async () => {
    const state = createFileHistoryState()
    await expect(getDiffStats(state, 0, 1, sessionId)).rejects.toThrow(
      'Invalid snapshotA index',
    )
  })

  it('detects new file as all insertions', async () => {
    const state = createFileHistoryState()
    const filePath = join(tempDir, 'new.ts')

    // Snap 0: file doesn't exist
    state.trackedFiles.add(filePath)
    await makeSnapshot(state, 'snap-0', sessionId)

    // Snap 1: file created
    writeFileSync(filePath, 'new line 1\nnew line 2')
    await makeSnapshot(state, 'snap-1', sessionId)

    const stats = await getDiffStats(state, 0, 1, sessionId)
    expect(stats).toHaveLength(1)
    expect(stats[0].insertions).toBe(2)
    expect(stats[0].deletions).toBe(0)
  })
})
