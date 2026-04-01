/**
 * Glob Tool — Fast file pattern matching
 *
 * Uses fast-glob to find files by glob patterns.
 * Returns sorted file list with sensible defaults for code projects.
 */

import { resolve } from 'node:path'
import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext } from '../core/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RESULTS = 200
const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  '**/target/**',      // Rust/Java
  '**/vendor/**',      // Go/PHP
  '**/.venv/**',
  '**/venv/**',
  '**/.tox/**',
  '**/*.pyc',
  '**/.DS_Store',
]

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  pattern: z.string().describe(
    'Glob pattern to match files against (e.g., "**/*.ts", "src/**/*.test.js").',
  ),
  path: z.string().optional().describe(
    'Directory to search in. Default: working directory.',
  ),
})

type GlobInput = z.infer<typeof inputSchema>

// ---------------------------------------------------------------------------
// Glob Implementation (fallback using find if fast-glob not available)
// ---------------------------------------------------------------------------

async function globFiles(pattern: string, cwd: string): Promise<string[]> {
  try {
    // Try fast-glob first
    const fg = await import('fast-glob')
    const files = await fg.default(pattern, {
      cwd,
      ignore: DEFAULT_IGNORE,
      absolute: true,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
    })
    return files.sort().slice(0, MAX_RESULTS)
  } catch {
    // Fallback: use Node's built-in glob (Node 22+) or find command
    try {
      const { glob } = await import('node:fs/promises')
      const results: string[] = []
      for await (const entry of (glob as any)(pattern, { cwd })) {
        const fullPath = resolve(cwd, entry)
        // Apply basic ignore
        if (DEFAULT_IGNORE.some((ig) => {
          const igBase = ig.replace(/\*\*/g, '').replace(/\*/g, '')
          return fullPath.includes(igBase.replace(/\//g, ''))
        })) {
          continue
        }
        results.push(fullPath)
        if (results.length >= MAX_RESULTS) break
      }
      return results.sort()
    } catch {
      // Last resort: use find via child_process
      const { execSync } = await import('node:child_process')
      try {
        const namePattern = pattern
          .replace(/\*\*\//g, '')
          .replace(/\*/g, '*')

        const output = execSync(
          `find . -name "${namePattern}" -type f | head -${MAX_RESULTS}`,
          { cwd, encoding: 'utf-8', timeout: 10_000 },
        )
        return output
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((f) => resolve(cwd, f))
          .sort()
      } catch {
        return []
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const globToolDef: ToolDef<GlobInput> = {
  name: 'Glob',

  description: 'Find files by glob pattern. Returns matching file paths sorted alphabetically. Ignores node_modules, .git, dist, build by default.',

  inputSchema,

  async call(input: GlobInput, context: ToolContext): Promise<ToolResult> {
    const { pattern, path } = input
    const searchDir = path ? resolve(context.cwd, path) : context.cwd

    try {
      const files = await globFiles(pattern, searchDir)

      if (files.length === 0) {
        return {
          result: `No files found matching pattern: ${pattern} in ${searchDir}`,
          isError: false,
        }
      }

      let output = files.join('\n')
      if (files.length >= MAX_RESULTS) {
        output += `\n\n(Results capped at ${MAX_RESULTS}. Narrow your pattern for more specific results.)`
      }

      return { result: output, isError: false }
    } catch (err: any) {
      return {
        result: `Error searching for files: ${err.message}`,
        isError: true,
      }
    }
  },

  prompt(): string {
    return [
      'Find files matching a glob pattern.',
      '',
      'Common patterns:',
      '  **/*.ts          All TypeScript files',
      '  src/**/*.test.js All test files in src/',
      '  **/package.json  All package.json files',
      '  *.{js,ts}        JS and TS files in current dir',
    ].join('\n')
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 30_000,

  userFacingName(input: GlobInput): string {
    return `Glob: ${input.pattern}`
  },
}
