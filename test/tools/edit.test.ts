import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { editToolDef } from '../../src/tools/edit'
import type { ToolContext, FileState, FileStateCache } from '../../src/core/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string

function makeFileStateCache(): FileStateCache {
  const map = new Map<string, FileState>()
  return {
    get: (p: string) => map.get(p),
    set: (p: string, s: FileState) => map.set(p, s),
    has: (p: string) => map.has(p),
    delete: (p: string) => map.delete(p),
    keys: () => map.keys(),
    clone: () => makeFileStateCache(),
    merge: () => {},
    get size() { return map.size },
  }
}

function makeContext(cwd?: string): ToolContext {
  return {
    cwd: cwd ?? tempDir,
    readFileState: makeFileStateCache(),
    fileHistory: { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 },
    modifiedFiles: new Set(),
    sessionId: 'test',
    permissionMode: 'bypassPermissions',
    onPermissionRequest: async () => ({ behavior: 'allow' as const }),
  }
}

/**
 * Write a file and populate the readFileState cache (simulating a Read-before-Edit).
 */
function writeAndCache(
  ctx: ToolContext,
  filePath: string,
  content: string,
): void {
  writeFileSync(filePath, content, 'utf-8')
  const mtime = statSync(filePath).mtimeMs
  ctx.readFileState.set(filePath, {
    content,
    timestamp: mtime,
  })
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nanocode-edit-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Basic replacement
// ---------------------------------------------------------------------------

describe('Edit tool — basic replacement', () => {
  it('replaces a unique string', async () => {
    const filePath = join(tempDir, 'basic.txt')
    const ctx = makeContext()
    writeAndCache(ctx, filePath, 'hello world\ngoodbye world\n')

    const result = await editToolDef.call({
      file_path: filePath,
      old_string: 'hello world',
      new_string: 'hi world',
    }, ctx)

    expect(result.isError).toBe(false)
    expect(result.result).toContain('Edited')
    expect(readFileSync(filePath, 'utf-8')).toBe('hi world\ngoodbye world\n')
  })

  it('deletes text when new_string is empty', async () => {
    const filePath = join(tempDir, 'delete.txt')
    const ctx = makeContext()
    writeAndCache(ctx, filePath, 'keep this\nremove this\nkeep too\n')

    const result = await editToolDef.call({
      file_path: filePath,
      old_string: 'remove this\n',
      new_string: '',
    }, ctx)

    expect(result.isError).toBe(false)
    expect(readFileSync(filePath, 'utf-8')).toBe('keep this\nkeep too\n')
  })
})

// ---------------------------------------------------------------------------
// Read-before-edit validation
// ---------------------------------------------------------------------------

describe('Edit tool — read-before-edit', () => {
  it('rejects edit if file was not read first', async () => {
    const filePath = join(tempDir, 'unread.txt')
    writeFileSync(filePath, 'content')
    const ctx = makeContext()
    // Do NOT populate readFileState

    const result = await editToolDef.call({
      file_path: filePath,
      old_string: 'content',
      new_string: 'new content',
    }, ctx)

    expect(result.isError).toBe(true)
    expect(result.result).toContain('must Read the file before editing')
  })
})

// ---------------------------------------------------------------------------
// No-op check
// ---------------------------------------------------------------------------

describe('Edit tool — no-op check', () => {
  it('rejects when old_string === new_string', async () => {
    const filePath = join(tempDir, 'noop.txt')
    const ctx = makeContext()
    writeAndCache(ctx, filePath, 'same text')

    const result = await editToolDef.call({
      file_path: filePath,
      old_string: 'same text',
      new_string: 'same text',
    }, ctx)

    expect(result.isError).toBe(true)
    expect(result.result).toContain('identical')
  })
})

// ---------------------------------------------------------------------------
// Multiple matches
// ---------------------------------------------------------------------------

describe('Edit tool — multiple matches', () => {
  it('rejects multiple matches without replace_all', async () => {
    const filePath = join(tempDir, 'multi.txt')
    const ctx = makeContext()
    writeAndCache(ctx, filePath, 'foo bar foo baz foo\n')

    const result = await editToolDef.call({
      file_path: filePath,
      old_string: 'foo',
      new_string: 'qux',
    }, ctx)

    expect(result.isError).toBe(true)
    expect(result.result).toContain('3 matches')
    expect(result.result).toContain('replace_all')
  })

  it('replaces all occurrences with replace_all: true', async () => {
    const filePath = join(tempDir, 'replaceall.txt')
    const ctx = makeContext()
    writeAndCache(ctx, filePath, 'foo bar foo baz foo\n')

    const result = await editToolDef.call({
      file_path: filePath,
      old_string: 'foo',
      new_string: 'qux',
      replace_all: true,
    }, ctx)

    expect(result.isError).toBe(false)
    expect(result.result).toContain('3 replacement')
    expect(readFileSync(filePath, 'utf-8')).toBe('qux bar qux baz qux\n')
  })
})

// ---------------------------------------------------------------------------
// File creation
// ---------------------------------------------------------------------------

describe('Edit tool — file creation', () => {
  it('creates a new file when old_string is empty and file does not exist', async () => {
    const filePath = join(tempDir, 'newfile.txt')
    const ctx = makeContext()

    const result = await editToolDef.call({
      file_path: filePath,
      old_string: '',
      new_string: 'brand new content\nwith lines\n',
    }, ctx)

    expect(result.isError).toBe(false)
    expect(result.result).toContain('Created new file')
    expect(readFileSync(filePath, 'utf-8')).toBe('brand new content\nwith lines\n')
  })

  it('creates intermediate directories', async () => {
    const filePath = join(tempDir, 'deep', 'nested', 'dir', 'file.txt')
    const ctx = makeContext()

    const result = await editToolDef.call({
      file_path: filePath,
      old_string: '',
      new_string: 'deep content',
    }, ctx)

    expect(result.isError).toBe(false)
    expect(readFileSync(filePath, 'utf-8')).toBe('deep content')
  })

  it('tracks created file in modifiedFiles and fileHistory', async () => {
    const filePath = join(tempDir, 'tracked.txt')
    const ctx = makeContext()

    await editToolDef.call({
      file_path: filePath,
      old_string: '',
      new_string: 'tracked',
    }, ctx)

    expect(ctx.modifiedFiles.has(filePath)).toBe(true)
    expect(ctx.fileHistory.trackedFiles.has(filePath)).toBe(true)
  })

  it('updates readFileState after creation', async () => {
    const filePath = join(tempDir, 'cached-create.txt')
    const ctx = makeContext()

    await editToolDef.call({
      file_path: filePath,
      old_string: '',
      new_string: 'new content',
    }, ctx)

    const state = ctx.readFileState.get(filePath)
    expect(state).toBeDefined()
    expect(state!.content).toBe('new content')
  })
})

// ---------------------------------------------------------------------------
// Nonexistent file (non-create case)
// ---------------------------------------------------------------------------

describe('Edit tool — nonexistent file', () => {
  it('returns error for nonexistent file with non-empty old_string', async () => {
    const ctx = makeContext()
    const result = await editToolDef.call({
      file_path: join(tempDir, 'missing.txt'),
      old_string: 'something',
      new_string: 'else',
    }, ctx)

    expect(result.isError).toBe(true)
    expect(result.result).toContain('file not found')
  })
})

// ---------------------------------------------------------------------------
// Staleness check (mtime)
// ---------------------------------------------------------------------------

describe('Edit tool — staleness check', () => {
  it('rejects edit if file was modified since last read', async () => {
    const filePath = join(tempDir, 'stale.txt')
    const ctx = makeContext()
    writeAndCache(ctx, filePath, 'original content')

    // Simulate external modification: set mtime far in the future
    const futureTime = new Date(Date.now() + 60_000)
    utimesSync(filePath, futureTime, futureTime)

    const result = await editToolDef.call({
      file_path: filePath,
      old_string: 'original content',
      new_string: 'updated content',
    }, ctx)

    expect(result.isError).toBe(true)
    expect(result.result).toContain('modified since you last read')
  })
})

// ---------------------------------------------------------------------------
// old_string not found
// ---------------------------------------------------------------------------

describe('Edit tool — match not found', () => {
  it('returns error when old_string is not in the file', async () => {
    const filePath = join(tempDir, 'nomatch.txt')
    const ctx = makeContext()
    writeAndCache(ctx, filePath, 'actual content')

    const result = await editToolDef.call({
      file_path: filePath,
      old_string: 'nonexistent string',
      new_string: 'replacement',
    }, ctx)

    expect(result.isError).toBe(true)
    expect(result.result).toContain('not found')
  })

  it('hints about whitespace mismatch', async () => {
    const filePath = join(tempDir, 'whitespace.txt')
    const ctx = makeContext()
    // The content has the text without extra spaces, but old_string has leading/trailing spaces
    writeAndCache(ctx, filePath, 'some indented content here')

    const result = await editToolDef.call({
      file_path: filePath,
      old_string: '  indented content  ',
      new_string: 'new',
    }, ctx)

    expect(result.isError).toBe(true)
    expect(result.result).toContain('whitespace')
  })
})

// ---------------------------------------------------------------------------
// Updates after edit
// ---------------------------------------------------------------------------

describe('Edit tool — post-edit state', () => {
  it('updates readFileState after successful edit', async () => {
    const filePath = join(tempDir, 'update-cache.txt')
    const ctx = makeContext()
    writeAndCache(ctx, filePath, 'before edit')

    await editToolDef.call({
      file_path: filePath,
      old_string: 'before edit',
      new_string: 'after edit',
    }, ctx)

    const state = ctx.readFileState.get(filePath)
    expect(state).toBeDefined()
    expect(state!.content).toBe('after edit')
  })

  it('adds file to modifiedFiles set', async () => {
    const filePath = join(tempDir, 'modified.txt')
    const ctx = makeContext()
    writeAndCache(ctx, filePath, 'content')

    await editToolDef.call({
      file_path: filePath,
      old_string: 'content',
      new_string: 'new content',
    }, ctx)

    expect(ctx.modifiedFiles.has(filePath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe('Edit tool — metadata', () => {
  it('isReadOnly returns false', () => {
    expect(editToolDef.isReadOnly!(undefined as any)).toBe(false)
  })

  it('isConcurrencySafe returns false', () => {
    expect(editToolDef.isConcurrencySafe!(undefined as any)).toBe(false)
  })

  it('has correct name', () => {
    expect(editToolDef.name).toBe('Edit')
  })
})
