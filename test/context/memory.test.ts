import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  loadClaudeMd,
  loadClaudeMdFromPath,
  hasClaudeMd,
} from '../../src/context/memory'

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'nanocode-memory-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// loadClaudeMd — basic file discovery
// ---------------------------------------------------------------------------

describe('loadClaudeMd', () => {
  it('returns empty string when no CLAUDE.md exists', async () => {
    const result = await loadClaudeMd(tempDir)
    expect(result).toBe('')
  })

  it('finds CLAUDE.md in the current directory', async () => {
    writeFileSync(join(tempDir, 'CLAUDE.md'), '# Project Rules\nBe concise.')
    const result = await loadClaudeMd(tempDir)
    expect(result).toContain('# Project Rules')
    expect(result).toContain('Be concise.')
  })

  it('finds .claude/CLAUDE.md', async () => {
    mkdirSync(join(tempDir, '.claude'), { recursive: true })
    writeFileSync(join(tempDir, '.claude', 'CLAUDE.md'), 'Hidden config')
    const result = await loadClaudeMd(tempDir)
    expect(result).toContain('Hidden config')
  })

  it('finds CLAUDE.local.md', async () => {
    writeFileSync(join(tempDir, 'CLAUDE.local.md'), 'Local overrides')
    const result = await loadClaudeMd(tempDir)
    expect(result).toContain('Local overrides')
  })

  it('walks upward to parent directories', async () => {
    // Create CLAUDE.md in tempDir (parent)
    writeFileSync(join(tempDir, 'CLAUDE.md'), 'Parent rules')

    // Create a child directory and search from there
    const childDir = join(tempDir, 'child', 'grandchild')
    mkdirSync(childDir, { recursive: true })

    const result = await loadClaudeMd(childDir)
    expect(result).toContain('Parent rules')
  })

  it('merges multiple files with source labels', async () => {
    writeFileSync(join(tempDir, 'CLAUDE.md'), 'Top level content')
    mkdirSync(join(tempDir, '.claude'), { recursive: true })
    writeFileSync(join(tempDir, '.claude', 'CLAUDE.md'), 'Dot-claude content')

    const result = await loadClaudeMd(tempDir)
    // Should contain both contents
    expect(result).toContain('Top level content')
    expect(result).toContain('Dot-claude content')
    // Should have source labels
    expect(result).toContain('# Source:')
    // Should have separator
    expect(result).toContain('---')
  })

  it('finds .claude/rules/*.md files', async () => {
    const rulesDir = join(tempDir, '.claude', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'formatting.md'), 'Use 2-space indent')
    writeFileSync(join(rulesDir, 'testing.md'), 'Always write tests')

    const result = await loadClaudeMd(tempDir)
    expect(result).toContain('Use 2-space indent')
    expect(result).toContain('Always write tests')
  })

  it('sorts rules files alphabetically', async () => {
    const rulesDir = join(tempDir, '.claude', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'z-last.md'), 'Z rule')
    writeFileSync(join(rulesDir, 'a-first.md'), 'A rule')

    const result = await loadClaudeMd(tempDir)
    const aIdx = result.indexOf('A rule')
    const zIdx = result.indexOf('Z rule')
    expect(aIdx).toBeLessThan(zIdx)
  })

  it('skips empty CLAUDE.md files', async () => {
    writeFileSync(join(tempDir, 'CLAUDE.md'), '')
    writeFileSync(join(tempDir, 'CLAUDE.local.md'), '   \n  ')

    const result = await loadClaudeMd(tempDir)
    expect(result).toBe('')
  })

  it('does not duplicate files when walking upward', async () => {
    writeFileSync(join(tempDir, 'CLAUDE.md'), 'Unique content')
    const childDir = join(tempDir, 'child')
    mkdirSync(childDir, { recursive: true })

    const result = await loadClaudeMd(childDir)
    // Should appear exactly once
    const occurrences = result.split('Unique content').length - 1
    expect(occurrences).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// @include directive
// ---------------------------------------------------------------------------

describe('@include directives', () => {
  it('resolves @include for existing file', async () => {
    writeFileSync(join(tempDir, 'extra.md'), 'Included content here')
    writeFileSync(join(tempDir, 'CLAUDE.md'), 'Preamble\n@include extra.md\nPostamble')

    const result = await loadClaudeMd(tempDir)
    expect(result).toContain('Included content here')
    expect(result).toContain('Preamble')
    expect(result).toContain('Postamble')
  })

  it('replaces missing @include with warning comment', async () => {
    writeFileSync(join(tempDir, 'CLAUDE.md'), '@include nonexistent.md')

    const result = await loadClaudeMd(tempDir)
    expect(result).toContain('<!-- @include failed: nonexistent.md not found -->')
  })

  it('resolves nested @includes', async () => {
    writeFileSync(join(tempDir, 'a.md'), '@include b.md')
    writeFileSync(join(tempDir, 'b.md'), 'Deeply included')
    writeFileSync(join(tempDir, 'CLAUDE.md'), '@include a.md')

    const result = await loadClaudeMd(tempDir)
    expect(result).toContain('Deeply included')
  })

  it('stops at max include depth (5)', async () => {
    // Create a chain of includes deeper than MAX_INCLUDE_DEPTH (5)
    for (let i = 0; i <= 6; i++) {
      const content = i <= 5 ? `@include level${i + 1}.md` : 'Deep content'
      writeFileSync(join(tempDir, `level${i}.md`), content)
    }
    writeFileSync(join(tempDir, 'CLAUDE.md'), '@include level0.md')

    const result = await loadClaudeMd(tempDir)
    // At depth 5, the @include should stop being resolved
    // The raw @include directive should remain
    expect(result).toContain('@include level')
  })
})

// ---------------------------------------------------------------------------
// loadClaudeMdFromPath
// ---------------------------------------------------------------------------

describe('loadClaudeMdFromPath', () => {
  it('loads specific file', async () => {
    const filePath = join(tempDir, 'custom.md')
    writeFileSync(filePath, 'Custom memory content')

    const result = await loadClaudeMdFromPath(filePath)
    expect(result).toBe('Custom memory content')
  })

  it('returns empty string for missing file', async () => {
    const result = await loadClaudeMdFromPath(join(tempDir, 'missing.md'))
    expect(result).toBe('')
  })

  it('processes @include in the specified file', async () => {
    writeFileSync(join(tempDir, 'included.md'), 'Included text')
    writeFileSync(join(tempDir, 'main.md'), 'Main\n@include included.md')

    const result = await loadClaudeMdFromPath(join(tempDir, 'main.md'))
    expect(result).toContain('Main')
    expect(result).toContain('Included text')
  })
})

// ---------------------------------------------------------------------------
// hasClaudeMd
// ---------------------------------------------------------------------------

describe('hasClaudeMd', () => {
  it('returns false when no memory files exist', async () => {
    expect(await hasClaudeMd(tempDir)).toBe(false)
  })

  it('returns true when CLAUDE.md exists', async () => {
    writeFileSync(join(tempDir, 'CLAUDE.md'), 'content')
    expect(await hasClaudeMd(tempDir)).toBe(true)
  })

  it('returns true when .claude/CLAUDE.md exists', async () => {
    mkdirSync(join(tempDir, '.claude'), { recursive: true })
    writeFileSync(join(tempDir, '.claude', 'CLAUDE.md'), 'content')
    expect(await hasClaudeMd(tempDir)).toBe(true)
  })

  it('returns true when .claude/rules/ has .md files', async () => {
    const rulesDir = join(tempDir, '.claude', 'rules')
    mkdirSync(rulesDir, { recursive: true })
    writeFileSync(join(rulesDir, 'rule.md'), 'A rule')
    expect(await hasClaudeMd(tempDir)).toBe(true)
  })

  it('returns false when CLAUDE.md is empty', async () => {
    writeFileSync(join(tempDir, 'CLAUDE.md'), '')
    expect(await hasClaudeMd(tempDir)).toBe(false)
  })

  it('returns false when CLAUDE.md is whitespace only', async () => {
    writeFileSync(join(tempDir, 'CLAUDE.md'), '  \n  ')
    expect(await hasClaudeMd(tempDir)).toBe(false)
  })
})
