import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import {
  getGitContext,
  getGitStatusShort,
  clearGitCache,
} from '../../src/context/git-context'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string

function gitInit(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' })
}

function gitCommit(dir: string, msg: string): void {
  execSync(`git commit --allow-empty -m "${msg}"`, { cwd: dir, stdio: 'ignore' })
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nanocode-git-test-'))
  clearGitCache()
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Non-git directory
// ---------------------------------------------------------------------------

describe('non-git directory', () => {
  it('returns "Not a git repository." for non-git dir', async () => {
    const result = await getGitContext(tempDir)
    expect(result).toBe('Not a git repository.')
  })

  it('getGitStatusShort returns empty for non-git dir', async () => {
    const result = await getGitStatusShort(tempDir)
    expect(result).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Git repository
// ---------------------------------------------------------------------------

describe('git repository', () => {
  beforeEach(() => {
    gitInit(tempDir)
    gitCommit(tempDir, 'Initial commit')
  })

  it('returns branch name', async () => {
    const result = await getGitContext(tempDir)
    // Default branch could be main or master depending on git config
    expect(result).toMatch(/Current branch: (main|master)/)
  })

  it('returns recent commits', async () => {
    gitCommit(tempDir, 'Second commit')
    clearGitCache()
    const result = await getGitContext(tempDir)
    expect(result).toContain('Recent commits:')
    expect(result).toContain('Second commit')
    expect(result).toContain('Initial commit')
  })

  it('returns clean status for clean tree', async () => {
    const result = await getGitContext(tempDir)
    expect(result).toContain('Clean working tree')
  })

  it('shows changed files in status', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(tempDir, 'newfile.txt'), 'hello')
    clearGitCache()
    const result = await getGitContext(tempDir)
    expect(result).toContain('newfile.txt')
  })

  it('returns main branch info', async () => {
    const result = await getGitContext(tempDir)
    expect(result).toMatch(/Main branch: (main|master)/)
  })
})

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe('caching', () => {
  beforeEach(() => {
    gitInit(tempDir)
    gitCommit(tempDir, 'Initial commit')
  })

  it('returns cached result on second call', async () => {
    const first = await getGitContext(tempDir)
    // Make a change that would alter git status
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(tempDir, 'newfile.txt'), 'hello')
    // Should still return cached result (no clearGitCache called)
    const second = await getGitContext(tempDir)
    expect(second).toBe(first)
  })

  it('returns fresh result after clearGitCache', async () => {
    const first = await getGitContext(tempDir)
    expect(first).toContain('Clean working tree')

    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(tempDir, 'newfile.txt'), 'hello')
    clearGitCache()
    const second = await getGitContext(tempDir)
    expect(second).toContain('newfile.txt')
  })
})

// ---------------------------------------------------------------------------
// getGitStatusShort
// ---------------------------------------------------------------------------

describe('getGitStatusShort', () => {
  beforeEach(() => {
    gitInit(tempDir)
    gitCommit(tempDir, 'Initial commit')
  })

  it('returns branch (clean) for clean working tree', async () => {
    const result = await getGitStatusShort(tempDir)
    expect(result).toMatch(/(main|master) \(clean\)/)
  })

  it('returns branch (N changed) for dirty tree', async () => {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(tempDir, 'a.txt'), 'a')
    writeFileSync(join(tempDir, 'b.txt'), 'b')
    const result = await getGitStatusShort(tempDir)
    expect(result).toMatch(/(main|master) \(2 changed\)/)
  })
})
