/**
 * nanocode — Permission Rules
 *
 * Loads permission rules from project and user settings files,
 * and implements rule matching against tool invocations.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { PermissionRule } from '../core/types.js'

// ---------------------------------------------------------------------------
// Settings file structure
// ---------------------------------------------------------------------------

interface SettingsFile {
  permissions?: {
    allow?: SettingsRule[]
    deny?: SettingsRule[]
  }
}

interface SettingsRule {
  tool: string
  content?: string
}

// ---------------------------------------------------------------------------
// Rule loading
// ---------------------------------------------------------------------------

/**
 * Safely read and parse a JSON settings file.
 * Returns null if the file doesn't exist or is malformed.
 */
async function readSettingsFile(filePath: string): Promise<SettingsFile | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(raw) as SettingsFile
  } catch {
    return null
  }
}

/**
 * Extract PermissionRule[] from a SettingsFile.
 */
function extractRules(
  settings: SettingsFile | null,
  source: 'project' | 'user',
): PermissionRule[] {
  if (!settings?.permissions) return []

  const rules: PermissionRule[] = []

  if (Array.isArray(settings.permissions.allow)) {
    for (const entry of settings.permissions.allow) {
      if (typeof entry.tool === 'string') {
        rules.push({
          tool: entry.tool,
          content: entry.content,
          behavior: 'allow',
          source,
        })
      }
    }
  }

  if (Array.isArray(settings.permissions.deny)) {
    for (const entry of settings.permissions.deny) {
      if (typeof entry.tool === 'string') {
        rules.push({
          tool: entry.tool,
          content: entry.content,
          behavior: 'deny',
          source,
        })
      }
    }
  }

  return rules
}

/** Config dirs — .nanocode/ takes priority over .claude/ */
const CONFIG_DIRS = ['.nanocode', '.claude'] as const

/**
 * Load permission rules from the project's settings.
 * Checks .nanocode/settings.json first, then .claude/settings.json.
 */
export async function loadProjectRules(cwd: string): Promise<PermissionRule[]> {
  const rules: PermissionRule[] = []
  for (const dir of CONFIG_DIRS) {
    const settingsPath = path.join(cwd, dir, 'settings.json')
    const settings = await readSettingsFile(settingsPath)
    rules.push(...extractRules(settings, 'project'))
  }
  return rules
}

/**
 * Load permission rules from the user's settings.
 * Checks ~/.nanocode/settings.json first, then ~/.claude/settings.json.
 */
export async function loadUserRules(): Promise<PermissionRule[]> {
  const rules: PermissionRule[] = []
  for (const dir of CONFIG_DIRS) {
    const settingsPath = path.join(os.homedir(), dir, 'settings.json')
    const settings = await readSettingsFile(settingsPath)
    rules.push(...extractRules(settings, 'user'))
  }
  return rules
}

// ---------------------------------------------------------------------------
// Rule matching
// ---------------------------------------------------------------------------

/**
 * Check if a glob-like pattern matches a string.
 *
 * Supports:
 * - '*' matches any sequence of characters (except path separators in strict mode)
 * - '**' matches any sequence including path separators
 * - '?' matches a single character
 * - Literal characters match themselves
 *
 * This is a simplified glob matcher, not a full POSIX glob implementation.
 */
function globMatch(pattern: string, value: string): boolean {
  // Convert glob pattern to regex
  let regex = '^'
  let i = 0

  while (i < pattern.length) {
    const ch = pattern[i]

    if (ch === '*' && pattern[i + 1] === '*') {
      // ** matches everything
      regex += '.*'
      i += 2
      // Skip trailing slash after **
      if (pattern[i] === '/') i++
    } else if (ch === '*') {
      // * matches anything except /
      regex += '[^/]*'
      i++
    } else if (ch === '?') {
      regex += '[^/]'
      i++
    } else if (ch === '.' || ch === '(' || ch === ')' || ch === '[' || ch === ']'
            || ch === '{' || ch === '}' || ch === '+' || ch === '^' || ch === '$'
            || ch === '|' || ch === '\\') {
      regex += '\\' + ch
      i++
    } else {
      regex += ch
      i++
    }
  }

  regex += '$'

  try {
    return new RegExp(regex).test(value)
  } catch {
    return false
  }
}

/**
 * Match a tool invocation against a permission rule.
 *
 * Tool name matching:
 * - Exact match: rule.tool === toolName
 * - MCP prefix match: rule.tool is "mcp__server__" and toolName starts with it
 *
 * Content matching (if rule.content is set):
 * - For Bash tools: glob match against command string
 * - For file tools: path match against file_path / path input
 *
 * @param toolName  Name of the tool being invoked
 * @param input     Tool input parameters
 * @param rule      Permission rule to check against
 * @returns         true if the rule matches this invocation
 */
export function matchRule(
  toolName: string,
  input: Record<string, unknown>,
  rule: PermissionRule,
): boolean {
  // Tool name match
  if (!matchToolName(toolName, rule.tool)) {
    return false
  }

  // If no content constraint, tool name match is sufficient
  if (!rule.content) {
    return true
  }

  // Content matching depends on tool type
  return matchContent(toolName, input, rule.content)
}

/**
 * Match a tool name against a rule's tool pattern.
 */
function matchToolName(toolName: string, rulePattern: string): boolean {
  // Exact match
  if (toolName === rulePattern) return true

  // MCP prefix match: rule "mcp__server__" matches "mcp__server__toolA"
  if (rulePattern.startsWith('mcp__') && rulePattern.endsWith('__')) {
    return toolName.startsWith(rulePattern)
  }

  // Prefix match for MCP: rule "mcp__server__*" with wildcard
  if (rulePattern.includes('*')) {
    return globMatch(rulePattern, toolName)
  }

  return false
}

/**
 * Match tool input against a content pattern.
 */
function matchContent(
  toolName: string,
  input: Record<string, unknown>,
  pattern: string,
): boolean {
  const lowerTool = toolName.toLowerCase()

  // Bash tools: match against the command string
  if (lowerTool === 'bash' || lowerTool === 'shell') {
    const command =
      typeof input.command === 'string'
        ? input.command
        : typeof input.cmd === 'string'
          ? input.cmd
          : ''
    return globMatch(pattern, command)
  }

  // File tools: match against file path
  const filePath =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : typeof input.filePath === 'string'
          ? input.filePath
          : ''

  if (filePath) {
    return globMatch(pattern, filePath)
  }

  // Generic: try to match against any string value in input
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && globMatch(pattern, val)) {
      return true
    }
  }

  return false
}
