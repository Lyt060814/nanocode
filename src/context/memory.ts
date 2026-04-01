/**
 * nanocode Memory (CLAUDE.md) Loader
 *
 * Loads project and user-level CLAUDE.md memory files.
 *
 * Search order (from project directory walking upward):
 *   1. {dir}/CLAUDE.md
 *   2. {dir}/.claude/CLAUDE.md
 *   3. {dir}/.claude/rules/*.md (all files, sorted alphabetically)
 *   4. {dir}/CLAUDE.local.md
 *
 * Then user-level:
 *   5. ~/.claude/CLAUDE.md
 *
 * All found files are merged with source labels.
 * Supports @include directives to include other files (max depth 5).
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, dirname, join, basename, sep } from 'node:path'
import { homedir } from 'node:os'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum depth for @include directive resolution. */
const MAX_INCLUDE_DEPTH = 5

/** Config directory names — .nanocode/ takes priority over .claude/ */
const CONFIG_DIRS = ['.nanocode', '.claude'] as const

/** Files to check at each directory level (NANOCODE.md first, then CLAUDE.md). */
const MEMORY_FILES = [
  'NANOCODE.md',
  'CLAUDE.md',
  ...CONFIG_DIRS.flatMap(d => [`${d}/NANOCODE.md`, `${d}/CLAUDE.md`]),
  'NANOCODE.local.md',
  'CLAUDE.local.md',
] as const

/** Rules directory patterns. */
const RULES_DIRS = CONFIG_DIRS.map(d => `${d}/rules`)

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

/**
 * Safely read a file, returning null if it doesn't exist or can't be read.
 */
async function tryRead(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Check if a path exists and is a directory.
 */
async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath)
    return s.isDirectory()
  } catch {
    return false
  }
}

/**
 * List all .md files in a directory, sorted alphabetically.
 */
async function listMdFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => join(dirPath, e.name))
      .sort()
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// @include directive processing
// ---------------------------------------------------------------------------

/**
 * Process @include directives in a CLAUDE.md file.
 *
 * Syntax: @include path/to/file.md
 * - Paths are resolved relative to the file containing the directive
 * - Maximum recursion depth is MAX_INCLUDE_DEPTH
 * - Missing includes are replaced with a warning comment
 */
async function processIncludes(
  content: string,
  baseDir: string,
  depth: number = 0,
): Promise<string> {
  if (depth >= MAX_INCLUDE_DEPTH) {
    return content
  }

  const lines = content.split('\n')
  const processed: string[] = []

  for (const line of lines) {
    const includeMatch = line.match(/^@include\s+(.+)$/)
    if (includeMatch) {
      const includePath = resolve(baseDir, includeMatch[1].trim())
      const includeContent = await tryRead(includePath)

      if (includeContent !== null) {
        // Recursively process includes in the included file
        const nestedContent = await processIncludes(
          includeContent,
          dirname(includePath),
          depth + 1,
        )
        processed.push(nestedContent)
      } else {
        processed.push(
          `<!-- @include failed: ${includeMatch[1].trim()} not found -->`,
        )
      }
    } else {
      processed.push(line)
    }
  }

  return processed.join('\n')
}

// ---------------------------------------------------------------------------
// Directory walking
// ---------------------------------------------------------------------------

/**
 * Walk from a directory upward to the filesystem root, yielding each
 * directory path along the way.
 */
function* walkUpward(startDir: string): Generator<string> {
  let current = resolve(startDir)
  const seen = new Set<string>()

  while (!seen.has(current)) {
    seen.add(current)
    yield current

    const parent = dirname(current)
    if (parent === current) {
      // Reached filesystem root
      break
    }
    current = parent
  }
}

// ---------------------------------------------------------------------------
// Memory file collection
// ---------------------------------------------------------------------------

interface MemoryFragment {
  source: string
  content: string
}

/**
 * Collect all memory fragments from a single directory.
 */
async function collectFromDirectory(dir: string): Promise<MemoryFragment[]> {
  const fragments: MemoryFragment[] = []

  // Check each standard memory file
  for (const file of MEMORY_FILES) {
    const filePath = join(dir, file)
    const content = await tryRead(filePath)
    if (content !== null && content.trim().length > 0) {
      const processed = await processIncludes(content, dirname(filePath))
      fragments.push({
        source: filePath,
        content: processed.trim(),
      })
    }
  }

  // Check rules directories (.nanocode/rules/ then .claude/rules/)
  for (const rulesRel of RULES_DIRS) {
    const rulesDir = join(dir, rulesRel)
    if (await isDirectory(rulesDir)) {
      const ruleFiles = await listMdFiles(rulesDir)
      for (const ruleFile of ruleFiles) {
        const content = await tryRead(ruleFile)
        if (content !== null && content.trim().length > 0) {
          const processed = await processIncludes(content, dirname(ruleFile))
          fragments.push({
            source: ruleFile,
            content: processed.trim(),
          })
        }
      }
    }
  }

  return fragments
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and merge all CLAUDE.md memory files.
 *
 * Walks from cwd upward to the filesystem root, then checks user-level
 * config. All found files are merged with source labels.
 *
 * @param cwd Starting directory (usually the project root)
 * @returns Merged CLAUDE.md content with source labels, or empty string
 */
export async function loadClaudeMd(cwd: string): Promise<string> {
  const allFragments: MemoryFragment[] = []
  const seenSources = new Set<string>()

  // Walk upward from cwd
  for (const dir of walkUpward(cwd)) {
    const fragments = await collectFromDirectory(dir)
    for (const fragment of fragments) {
      if (!seenSources.has(fragment.source)) {
        seenSources.add(fragment.source)
        allFragments.push(fragment)
      }
    }
  }

  // Check user-level memory files (.nanocode/ first, then .claude/; NANOCODE.md first, then CLAUDE.md)
  for (const configDir of CONFIG_DIRS) {
    for (const mdName of ['NANOCODE.md', 'CLAUDE.md']) {
      const userMd = join(homedir(), configDir, mdName)
      if (!seenSources.has(userMd)) {
        const content = await tryRead(userMd)
        if (content !== null && content.trim().length > 0) {
          const processed = await processIncludes(content, dirname(userMd))
          seenSources.add(userMd)
          allFragments.push({ source: userMd, content: processed.trim() })
        }
      }
    }
  }
  // (user-level already handled in the loop above)

  if (allFragments.length === 0) {
    return ''
  }

  // Merge with source labels
  const merged = allFragments
    .map((f) => {
      const relSource = f.source.startsWith(cwd)
        ? f.source.slice(cwd.length + 1)
        : f.source
      return `# Source: ${relSource}\n\n${f.content}`
    })
    .join('\n\n---\n\n')

  return merged
}

/**
 * Load CLAUDE.md from a specific file path only (no walking).
 * Useful for testing or when the exact path is known.
 */
export async function loadClaudeMdFromPath(
  filePath: string,
): Promise<string> {
  const content = await tryRead(filePath)
  if (content === null) {
    return ''
  }
  return processIncludes(content, dirname(filePath))
}

/**
 * Check if any CLAUDE.md files exist for the given directory.
 */
export async function hasClaudeMd(cwd: string): Promise<boolean> {
  for (const file of MEMORY_FILES) {
    const filePath = join(cwd, file)
    const content = await tryRead(filePath)
    if (content !== null && content.trim().length > 0) {
      return true
    }
  }

  for (const rulesRel of RULES_DIRS) {
    const rulesDir = join(cwd, rulesRel)
    if (await isDirectory(rulesDir)) {
      const ruleFiles = await listMdFiles(rulesDir)
      if (ruleFiles.length > 0) return true
    }
  }

  return false
}
