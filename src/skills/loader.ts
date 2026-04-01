/**
 * Skill Loader — Discover and parse skills from .claude/skills/ directories
 *
 * Discovery order (first wins on name collision):
 * 1. Project skills: .claude/skills/ (walking up from cwd toward home)
 * 2. User skills: ~/.claude/skills/
 *
 * Each skill is a directory containing SKILL.md with YAML frontmatter.
 * The frontmatter defines metadata; the body is the prompt template.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, dirname, basename, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { SkillDefinition, SkillFrontmatter, SkillLoadResult } from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Config dirs — .nanocode/ takes priority over .claude/ */
const CONFIG_DIRS = ['.nanocode', '.claude'] as const
const SKILL_DIR_NAMES = CONFIG_DIRS.map(d => `${d}/skills`)
const SKILL_FILE_NAME = 'SKILL.md'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover and load all skills from .claude/skills/ directories.
 *
 * Walks from `cwd` up to the user's home directory, checking for
 * .claude/skills/ at each level. Also checks ~/.claude/skills/.
 * First skill found with a given name wins (project skills shadow user skills).
 *
 * @param cwd - Current working directory to start searching from
 * @returns Deduplicated array of loaded skill definitions
 */
export async function loadAllSkills(cwd: string): Promise<SkillDefinition[]> {
  const seen = new Map<string, SkillLoadResult>()
  const home = homedir()

  // 1. Walk from cwd upward, checking .nanocode/skills/ then .claude/skills/
  const searchDirs = getSearchDirs(cwd, home)

  for (const dir of searchDirs) {
    for (const skillDirName of SKILL_DIR_NAMES) {
      const skillsDir = join(dir, skillDirName)
      const results = await loadSkillsFromDir(skillsDir, 'project')
      for (const result of results) {
        const key = result.skill.name.toLowerCase()
        if (!seen.has(key)) {
          seen.set(key, result)
        }
      }
    }
  }

  // 2. User-level skills (~/.nanocode/skills/ then ~/.claude/skills/)
  for (const skillDirName of SKILL_DIR_NAMES) {
    const userSkillsDir = join(home, skillDirName)
    const userResults = await loadSkillsFromDir(userSkillsDir, 'user')
    for (const result of userResults) {
      const key = result.skill.name.toLowerCase()
      if (!seen.has(key)) {
        seen.set(key, result)
      }
    }
  }

  return Array.from(seen.values()).map((r) => r.skill)
}

/**
 * Parse a single SKILL.md file into a SkillDefinition.
 *
 * @param filePath - Absolute path to the SKILL.md file
 * @returns Parsed skill definition, or null if the file is invalid
 */
export async function parseSkillFile(filePath: string): Promise<SkillDefinition | null> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch {
    return null
  }

  if (!content.trim()) return null

  const { frontmatter, body } = parseFrontmatter(content)
  const skillDir = dirname(filePath)
  const dirName = basename(skillDir)

  // Name: frontmatter > directory name
  const name = frontmatter.name || dirName

  // Description is required for a useful skill
  const description = frontmatter.description || `Skill: ${name}`

  // Parse arguments field (can be string or string[])
  const argumentNames = normalizeStringArray(frontmatter.arguments)

  // Parse paths field (can be string or string[])
  const paths = normalizeStringArray(frontmatter.paths)

  // Parse allowed-tools field
  const allowedTools = frontmatter['allowed-tools']

  const skill: SkillDefinition = {
    name,
    description,
    whenToUse: frontmatter['when_to_use'],
    argumentHint: frontmatter['argument-hint'],
    argumentNames,
    allowedTools,
    model: frontmatter.model,
    userInvocable: frontmatter['user-invocable'] !== false, // default true
    context: frontmatter.context || 'inline',
    agent: frontmatter.agent,
    paths,
    skillRoot: resolve(skillDir),
    getPrompt: createPromptExpander(body, resolve(skillDir), argumentNames),
  }

  return skill
}

// ---------------------------------------------------------------------------
// Frontmatter Parser — Simple YAML subset (no external dependency)
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Expects content delimited by `---` markers at the start.
 *
 * Supports:
 * - Simple key: value pairs
 * - Arrays via `- item` lines or `[a, b, c]` inline syntax
 * - Boolean values (true/false/yes/no)
 * - Quoted strings (single or double)
 *
 * Does NOT support nested objects — not needed for skill frontmatter.
 */
export function parseFrontmatter(content: string): {
  frontmatter: SkillFrontmatter
  body: string
} {
  const trimmed = content.trimStart()

  // Must start with ---
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: content }
  }

  // Find the closing ---
  const afterFirst = trimmed.slice(3)
  const closingIndex = afterFirst.indexOf('\n---')

  if (closingIndex === -1) {
    // No closing marker — treat entire content as body
    return { frontmatter: {}, body: content }
  }

  const yamlBlock = afterFirst.slice(0, closingIndex).trim()
  const body = afterFirst.slice(closingIndex + 4).trimStart() // skip \n---

  const frontmatter = parseSimpleYaml(yamlBlock)
  return { frontmatter: frontmatter as SkillFrontmatter, body }
}

// ---------------------------------------------------------------------------
// Simple YAML Parser
// ---------------------------------------------------------------------------

function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const lines = yaml.split('\n')

  let currentKey: string | null = null
  let currentArray: string[] | null = null

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()

    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) {
      continue
    }

    // Check for array item (continuation of previous key)
    const arrayItemMatch = line.match(/^\s+-\s+(.+)$/)
    if (arrayItemMatch && currentKey) {
      if (!currentArray) {
        currentArray = []
      }
      currentArray.push(unquote(arrayItemMatch[1]!.trim()))
      result[currentKey] = currentArray
      continue
    }

    // Flush any pending array
    if (currentArray && currentKey) {
      result[currentKey] = currentArray
      currentArray = null
    }

    // Parse key: value pair
    const kvMatch = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/)
    if (!kvMatch) continue

    currentKey = kvMatch[1]!
    const rawValue = kvMatch[2]!.trim()

    // Empty value — might be followed by array items
    if (!rawValue) {
      currentArray = []
      continue
    }

    // Inline array: [a, b, c]
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1)
      result[currentKey] = inner
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean)
      currentArray = null
      continue
    }

    // Boolean
    const lower = rawValue.toLowerCase()
    if (lower === 'true' || lower === 'yes') {
      result[currentKey] = true
      currentArray = null
      continue
    }
    if (lower === 'false' || lower === 'no') {
      result[currentKey] = false
      currentArray = null
      continue
    }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      result[currentKey] = Number(rawValue)
      currentArray = null
      continue
    }

    // String (possibly quoted)
    result[currentKey] = unquote(rawValue)
    currentArray = null
  }

  // Flush trailing array
  if (currentArray && currentKey) {
    result[currentKey] = currentArray
  }

  return result
}

/**
 * Remove surrounding quotes from a string value.
 */
function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1)
  }
  return s
}

// ---------------------------------------------------------------------------
// Prompt Template Expansion
// ---------------------------------------------------------------------------

/**
 * Create a getPrompt function that expands template variables in the skill body.
 *
 * Template variables:
 * - $ARGUMENTS — replaced with the full args string
 * - $1, $2, ... — replaced with positional arguments (split by whitespace)
 * - ${CLAUDE_SKILL_DIR} — replaced with the skill's root directory
 */
function createPromptExpander(
  template: string,
  skillRoot: string,
  argumentNames?: string[],
): (args: string) => Promise<string> {
  return async (args: string): Promise<string> => {
    let result = template

    // Replace ${NANOCODE_SKILL_DIR} / ${CLAUDE_SKILL_DIR} (both supported)
    result = result.replace(/\$\{NANOCODE_SKILL_DIR\}/g, skillRoot)
    result = result.replace(/\$NANOCODE_SKILL_DIR\b/g, skillRoot)
    result = result.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillRoot)
    result = result.replace(/\$CLAUDE_SKILL_DIR\b/g, skillRoot)

    // Replace $ARGUMENTS with full args string
    result = result.replace(/\$ARGUMENTS/g, args)

    // Split args into positional parameters
    const positional = splitArgs(args)

    // Replace named arguments ($name) if argumentNames are defined
    if (argumentNames) {
      for (let i = 0; i < argumentNames.length; i++) {
        const name = argumentNames[i]!
        const value = positional[i] ?? ''
        result = result.replace(new RegExp(`\\$${escapeRegExp(name)}\\b`, 'g'), value)
      }
    }

    // Replace positional $1, $2, ... (up to $9)
    for (let i = 0; i < 9; i++) {
      const value = positional[i] ?? ''
      result = result.replace(new RegExp(`\\$${i + 1}\\b`, 'g'), value)
    }

    return result
  }
}

/**
 * Split argument string into positional params.
 * Respects double-quoted strings as single arguments.
 */
function splitArgs(args: string): string[] {
  if (!args.trim()) return []

  const result: string[] = []
  let current = ''
  let inQuote = false

  for (const char of args) {
    if (char === '"') {
      inQuote = !inQuote
      continue
    }
    if (char === ' ' && !inQuote) {
      if (current) {
        result.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (current) result.push(current)
  return result
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Directory Discovery
// ---------------------------------------------------------------------------

/**
 * Get the list of directories to search for .claude/skills/,
 * walking from cwd up to (and including) home.
 */
function getSearchDirs(cwd: string, home: string): string[] {
  const dirs: string[] = []
  let current = resolve(cwd)
  const resolvedHome = resolve(home)

  // Walk upward from cwd to home (inclusive)
  while (true) {
    dirs.push(current)

    if (current === resolvedHome) break

    const parent = dirname(current)
    if (parent === current) break // filesystem root
    if (!current.startsWith(resolvedHome)) break // gone above home

    current = parent
  }

  return dirs
}

/**
 * Load all skills from a single .claude/skills/ directory.
 */
async function loadSkillsFromDir(
  skillsDir: string,
  source: 'user' | 'project',
): Promise<SkillLoadResult[]> {
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return [] // Directory doesn't exist — that's fine
  }

  const results: SkillLoadResult[] = []

  for (const entry of entries) {
    const entryPath = join(skillsDir, entry)

    // Each skill is a subdirectory containing SKILL.md
    let entryStat
    try {
      entryStat = await stat(entryPath)
    } catch {
      continue
    }

    if (!entryStat.isDirectory()) continue

    const skillFilePath = join(entryPath, SKILL_FILE_NAME)
    const skill = await parseSkillFile(skillFilePath)

    if (skill) {
      results.push({ skill, source, filePath: skillFilePath })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Utility: Normalize string/string[] fields from frontmatter
// ---------------------------------------------------------------------------

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!value) return undefined
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.map(String)
  return undefined
}
