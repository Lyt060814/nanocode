/**
 * MCP Server Config — Load from .claude/settings.json and ~/.claude/settings.json
 *
 * Configuration is loaded from two sources:
 *   1. Project-level:  {cwd}/.claude/settings.json  -> mcpServers
 *   2. User-level:     ~/.claude/settings.json       -> mcpServers
 *
 * Project settings override user settings for servers with the same name.
 * Each server entry specifies a command, optional args, and optional env vars.
 */

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

import type { McpServerConfig } from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Settings filename within .claude directories. */
const SETTINGS_FILE = 'settings.json'

/** Settings directory names — .nanocode/ takes priority over .claude/ */
const SETTINGS_DIRS = ['.nanocode', '.claude'] as const

// ---------------------------------------------------------------------------
// Settings file loading
// ---------------------------------------------------------------------------

/**
 * Safely read and parse a JSON settings file.
 * Returns null if the file doesn't exist or contains invalid JSON.
 */
async function readSettingsFile(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

/**
 * Extract mcpServers from a settings object.
 *
 * Expected shape:
 * ```json
 * {
 *   "mcpServers": {
 *     "server-name": {
 *       "command": "npx",
 *       "args": ["-y", "@some/mcp-server"],
 *       "env": { "API_KEY": "..." }
 *     }
 *   }
 * }
 * ```
 */
function extractMcpServers(
  settings: Record<string, unknown>,
): Record<string, McpServerConfig> {
  const mcpServers = settings.mcpServers
  if (
    typeof mcpServers !== 'object' ||
    mcpServers === null ||
    Array.isArray(mcpServers)
  ) {
    return {}
  }

  const result: Record<string, McpServerConfig> = {}
  const servers = mcpServers as Record<string, unknown>

  for (const [name, value] of Object.entries(servers)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue
    }

    const entry = value as Record<string, unknown>
    const command = entry.command
    if (typeof command !== 'string' || command.length === 0) {
      continue
    }

    const config: McpServerConfig = { command }

    // Parse args
    if (Array.isArray(entry.args)) {
      config.args = entry.args.filter(
        (a): a is string => typeof a === 'string',
      )
    }

    // Parse env
    if (
      typeof entry.env === 'object' &&
      entry.env !== null &&
      !Array.isArray(entry.env)
    ) {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(entry.env as Record<string, unknown>)) {
        if (typeof v === 'string') {
          env[k] = v
        }
      }
      if (Object.keys(env).length > 0) {
        config.env = env
      }
    }

    result[name] = config
  }

  return result
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load MCP server configurations from project and user settings.
 *
 * Reads from:
 *   1. {cwd}/.claude/settings.json  (project-level)
 *   2. ~/.claude/settings.json       (user-level)
 *
 * Project settings override user settings for servers with the same name.
 *
 * @param cwd  Current working directory (project root)
 * @returns    Map of server name to config
 */
export async function loadMcpConfig(
  cwd: string,
): Promise<Record<string, McpServerConfig>> {
  const resolvedCwd = resolve(cwd)

  // Load user-level settings (.nanocode/ first, then .claude/)
  let userServers: Record<string, McpServerConfig> = {}
  for (const dir of SETTINGS_DIRS) {
    const userSettingsPath = join(homedir(), dir, SETTINGS_FILE)
    const userSettings = await readSettingsFile(userSettingsPath)
    if (userSettings) {
      userServers = { ...userServers, ...extractMcpServers(userSettings) }
    }
  }

  // Load project-level settings (.nanocode/ first, then .claude/)
  let projectServers: Record<string, McpServerConfig> = {}
  for (const dir of SETTINGS_DIRS) {
    const projectSettingsPath = join(resolvedCwd, dir, SETTINGS_FILE)
    const projectSettings = await readSettingsFile(projectSettingsPath)
    if (projectSettings) {
      projectServers = { ...projectServers, ...extractMcpServers(projectSettings) }
    }
  }

  // Merge: project overrides user
  const merged: Record<string, McpServerConfig> = {
    ...userServers,
    ...projectServers,
  }

  // Resolve commands
  for (const [name, config] of Object.entries(merged)) {
    merged[name] = resolveMcpCommand(config)
  }

  return merged
}

/**
 * Resolve special command prefixes like npx and uvx to full paths
 * when possible, and normalize the config.
 *
 * Currently handles:
 *   - "npx" -> kept as-is (resolved via PATH at spawn time)
 *   - "uvx" -> kept as-is (resolved via PATH at spawn time)
 *   - "node" -> kept as-is
 *   - Absolute paths -> kept as-is
 *   - Relative paths -> resolved against cwd
 *
 * @param config  Raw server config
 * @returns       Config with resolved command
 */
export function resolveMcpCommand(config: McpServerConfig): McpServerConfig {
  const command = config.command.trim()

  // Well-known commands that should be resolved via PATH
  const pathCommands = new Set([
    'npx',
    'uvx',
    'node',
    'python',
    'python3',
    'deno',
    'bun',
  ])

  if (pathCommands.has(command)) {
    return { ...config, command }
  }

  // Absolute path: keep as-is
  if (command.startsWith('/') || command.startsWith('~')) {
    const resolved = command.startsWith('~')
      ? join(homedir(), command.slice(1))
      : command
    return { ...config, command: resolved }
  }

  // Everything else: keep as-is (will be resolved via PATH)
  return { ...config, command }
}

/**
 * Get the settings file paths that would be checked for MCP config.
 * Useful for debugging and display purposes.
 */
export function getMcpConfigPaths(cwd: string): {
  project: string
  user: string
} {
  return {
    project: join(resolve(cwd), SETTINGS_DIRS[0], SETTINGS_FILE),
    user: join(homedir(), SETTINGS_DIRS[0], SETTINGS_FILE),
  }
}
