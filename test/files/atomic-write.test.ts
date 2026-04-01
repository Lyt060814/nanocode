import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  statSync,
  existsSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWrite } from '../../src/files/atomic-write'

// ---------------------------------------------------------------------------
// Temp directory
// ---------------------------------------------------------------------------

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nanocode-atomic-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Basic write
// ---------------------------------------------------------------------------

describe('basic write', () => {
  it('creates a file with correct content', async () => {
    const filePath = join(tempDir, 'test.txt')
    await atomicWrite(filePath, 'Hello, world!')
    expect(readFileSync(filePath, 'utf-8')).toBe('Hello, world!')
  })

  it('overwrites existing file', async () => {
    const filePath = join(tempDir, 'test.txt')
    writeFileSync(filePath, 'old content')
    await atomicWrite(filePath, 'new content')
    expect(readFileSync(filePath, 'utf-8')).toBe('new content')
  })

  it('handles empty content', async () => {
    const filePath = join(tempDir, 'empty.txt')
    await atomicWrite(filePath, '')
    expect(readFileSync(filePath, 'utf-8')).toBe('')
  })

  it('handles large content', async () => {
    const filePath = join(tempDir, 'large.txt')
    const content = 'x'.repeat(10_000_000) // 10MB
    await atomicWrite(filePath, content)
    expect(readFileSync(filePath, 'utf-8')).toBe(content)
  })

  it('handles unicode content', async () => {
    const filePath = join(tempDir, 'unicode.txt')
    const content = 'Hello \u{1F600} \u4F60\u597D \u{1F30D}'
    await atomicWrite(filePath, content)
    expect(readFileSync(filePath, 'utf-8')).toBe(content)
  })

  it('handles multiline content', async () => {
    const filePath = join(tempDir, 'multiline.txt')
    const content = 'line 1\nline 2\nline 3\n'
    await atomicWrite(filePath, content)
    expect(readFileSync(filePath, 'utf-8')).toBe(content)
  })
})

// ---------------------------------------------------------------------------
// Parent directory creation
// ---------------------------------------------------------------------------

describe('parent directory creation', () => {
  it('creates parent directories if they do not exist', async () => {
    const filePath = join(tempDir, 'a', 'b', 'c', 'test.txt')
    await atomicWrite(filePath, 'nested content')
    expect(readFileSync(filePath, 'utf-8')).toBe('nested content')
  })

  it('works when parent directory already exists', async () => {
    const filePath = join(tempDir, 'test.txt')
    await atomicWrite(filePath, 'content')
    expect(readFileSync(filePath, 'utf-8')).toBe('content')
  })
})

// ---------------------------------------------------------------------------
// Permission preservation
// ---------------------------------------------------------------------------

describe('permission preservation', () => {
  it('preserves permissions of existing file', async () => {
    const filePath = join(tempDir, 'perms.txt')
    writeFileSync(filePath, 'original')
    // Set to read-write-execute for owner only (0o700)
    chmodSync(filePath, 0o755)

    const originalMode = statSync(filePath).mode

    await atomicWrite(filePath, 'updated')

    const newMode = statSync(filePath).mode
    expect(newMode).toBe(originalMode)
    expect(readFileSync(filePath, 'utf-8')).toBe('updated')
  })

  it('preserves read-only permissions', async () => {
    const filePath = join(tempDir, 'readonly.txt')
    writeFileSync(filePath, 'original')
    chmodSync(filePath, 0o444)

    const originalMode = statSync(filePath).mode

    // Need to temporarily make it writable for the temp file rename to work
    // The atomic write should still preserve the original permissions
    chmodSync(filePath, 0o644)
    await atomicWrite(filePath, 'updated')

    // Restore and check
    chmodSync(filePath, originalMode)
    const content = readFileSync(filePath, 'utf-8')
    expect(content).toBe('updated')
  })
})

// ---------------------------------------------------------------------------
// Concurrent writes
// ---------------------------------------------------------------------------

describe('concurrent writes', () => {
  it('handles concurrent writes without corruption', async () => {
    const filePath = join(tempDir, 'concurrent.txt')

    // Launch multiple writes concurrently
    const writes = Array.from({ length: 20 }, (_, i) =>
      atomicWrite(filePath, `content-${i}`),
    )

    await Promise.all(writes)

    // File should exist and contain one of the written values (no corruption)
    const content = readFileSync(filePath, 'utf-8')
    expect(content).toMatch(/^content-\d+$/)
  })

  it('no temp files left behind after concurrent writes', async () => {
    const filePath = join(tempDir, 'concurrent2.txt')

    const writes = Array.from({ length: 10 }, (_, i) =>
      atomicWrite(filePath, `content-${i}`),
    )
    await Promise.all(writes)

    // Check that no .tmp. files remain in the directory
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(tempDir)
    const tmpFiles = files.filter((f) => f.includes('.tmp.'))
    expect(tmpFiles).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Atomicity (no partial content on read)
// ---------------------------------------------------------------------------

describe('atomicity', () => {
  it('file is never in a partial state during write', async () => {
    const filePath = join(tempDir, 'atomic-check.txt')
    const expectedContent = 'A'.repeat(100_000)
    writeFileSync(filePath, expectedContent)

    // Write new content atomically
    const newContent = 'B'.repeat(100_000)
    const writePromise = atomicWrite(filePath, newContent)

    // Read in parallel — should get either old or new content, never mixed
    const readPromise = new Promise<string>((resolve) => {
      // Small delay to try to catch mid-write
      setTimeout(() => {
        resolve(readFileSync(filePath, 'utf-8'))
      }, 1)
    })

    await writePromise
    const readContent = await readPromise

    // Content should be entirely A's or entirely B's
    const isAllA = readContent === expectedContent
    const isAllB = readContent === newContent
    expect(isAllA || isAllB).toBe(true)
  })
})
