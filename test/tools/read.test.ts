import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readToolDef } from '../../src/tools/read'
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

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nanocode-read-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Read existing file
// ---------------------------------------------------------------------------

describe('Read tool — basic reading', () => {
  it('reads an existing file with line numbers', async () => {
    const filePath = join(tempDir, 'hello.txt')
    writeFileSync(filePath, 'line one\nline two\nline three\n')

    const ctx = makeContext()
    const result = await readToolDef.call({ file_path: filePath }, ctx)

    expect(result.isError).toBe(false)
    expect(result.result).toContain('line one')
    expect(result.result).toContain('line two')
    expect(result.result).toContain('line three')
    // Should have line numbers
    expect(result.result).toMatch(/1\t/)
    expect(result.result).toMatch(/2\t/)
  })

  it('reads file with relative path resolved against cwd', async () => {
    const filePath = join(tempDir, 'relative.txt')
    writeFileSync(filePath, 'content here')

    const ctx = makeContext(tempDir)
    const result = await readToolDef.call({ file_path: 'relative.txt' }, ctx)

    expect(result.isError).toBe(false)
    expect(result.result).toContain('content here')
  })
})

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('Read tool — error cases', () => {
  it('returns error for nonexistent file', async () => {
    const ctx = makeContext()
    const result = await readToolDef.call(
      { file_path: join(tempDir, 'nonexistent.txt') },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(result.result).toContain('file not found')
  })

  it('returns error for directory', async () => {
    const dirPath = join(tempDir, 'subdir')
    mkdirSync(dirPath)

    const ctx = makeContext()
    const result = await readToolDef.call({ file_path: dirPath }, ctx)
    expect(result.isError).toBe(true)
    expect(result.result).toContain('directory')
  })

  it('returns error when file_path is empty', async () => {
    const ctx = makeContext()
    const result = await readToolDef.call({ file_path: '' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.result).toContain('file_path parameter is required')
  })
})

// ---------------------------------------------------------------------------
// Offset and limit
// ---------------------------------------------------------------------------

describe('Read tool — offset and limit', () => {
  it('respects offset parameter', async () => {
    const filePath = join(tempDir, 'multiline.txt')
    writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5\n')

    const ctx = makeContext()
    const result = await readToolDef.call(
      { file_path: filePath, offset: 3 },
      ctx,
    )

    expect(result.isError).toBe(false)
    expect(result.result).toContain('line3')
    expect(result.result).toContain('line4')
    // Line numbers should start at 3
    expect(result.result).toMatch(/3\tline3/)
  })

  it('respects limit parameter', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n')
    const filePath = join(tempDir, 'many-lines.txt')
    writeFileSync(filePath, lines)

    const ctx = makeContext()
    const result = await readToolDef.call(
      { file_path: filePath, limit: 5 },
      ctx,
    )

    expect(result.isError).toBe(false)
    expect(result.result).toContain('line1')
    expect(result.result).toContain('line5')
    // Should not contain line6 in the numbered output section
    // But may contain metadata about more lines below
    expect(result.result).toContain('more lines below')
  })

  it('combines offset and limit', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n')
    const filePath = join(tempDir, 'combo.txt')
    writeFileSync(filePath, lines)

    const ctx = makeContext()
    const result = await readToolDef.call(
      { file_path: filePath, offset: 5, limit: 3 },
      ctx,
    )

    expect(result.isError).toBe(false)
    expect(result.result).toMatch(/5\tL5/)
    expect(result.result).toMatch(/7\tL7/)
    expect(result.result).toContain('showing from line 5')
  })
})

// ---------------------------------------------------------------------------
// Binary file detection
// ---------------------------------------------------------------------------

describe('Read tool — binary detection', () => {
  it('detects binary files with null bytes', async () => {
    const filePath = join(tempDir, 'binary.dat')
    const buf = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64])
    writeFileSync(filePath, buf)

    const ctx = makeContext()
    const result = await readToolDef.call({ file_path: filePath }, ctx)

    expect(result.isError).toBe(false)
    expect(result.result).toContain('binary file')
  })
})

// ---------------------------------------------------------------------------
// Image file detection
// ---------------------------------------------------------------------------

describe('Read tool — image detection', () => {
  it.each(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'])
    ('detects image file extension %s', async (ext) => {
      const filePath = join(tempDir, `image${ext}`)
      writeFileSync(filePath, 'fake image data')

      const ctx = makeContext()
      const result = await readToolDef.call({ file_path: filePath }, ctx)

      expect(result.isError).toBe(false)
      expect(result.result).toContain('image file')
    })
})

// ---------------------------------------------------------------------------
// File state cache
// ---------------------------------------------------------------------------

describe('Read tool — file state cache', () => {
  it('updates readFileState after successful read', async () => {
    const filePath = join(tempDir, 'cached.txt')
    writeFileSync(filePath, 'cached content')

    const ctx = makeContext()
    await readToolDef.call({ file_path: filePath }, ctx)

    const state = ctx.readFileState.get(filePath)
    expect(state).toBeDefined()
    expect(state!.content).toBe('cached content')
    expect(state!.timestamp).toBeGreaterThan(0)
  })

  it('does not update cache on error', async () => {
    const ctx = makeContext()
    await readToolDef.call({ file_path: join(tempDir, 'missing.txt') }, ctx)

    expect(ctx.readFileState.size).toBe(0)
  })

  it('marks partial views in cache', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n')
    const filePath = join(tempDir, 'partial.txt')
    writeFileSync(filePath, lines)

    const ctx = makeContext()
    await readToolDef.call({ file_path: filePath, limit: 5 }, ctx)

    const state = ctx.readFileState.get(filePath)
    expect(state).toBeDefined()
    expect(state!.isPartialView).toBe(true)
  })

  it('marks full views as not partial', async () => {
    const filePath = join(tempDir, 'full.txt')
    writeFileSync(filePath, 'short file')

    const ctx = makeContext()
    await readToolDef.call({ file_path: filePath }, ctx)

    const state = ctx.readFileState.get(filePath)
    expect(state).toBeDefined()
    expect(state!.isPartialView).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

describe('Read tool — metadata', () => {
  it('isReadOnly returns true', () => {
    expect(readToolDef.isReadOnly!(undefined as any)).toBe(true)
  })

  it('isConcurrencySafe returns true', () => {
    expect(readToolDef.isConcurrencySafe!(undefined as any)).toBe(true)
  })

  it('has correct name', () => {
    expect(readToolDef.name).toBe('Read')
  })

  it('prompt returns non-empty string', () => {
    expect(readToolDef.prompt!()).toBeTruthy()
  })
})
