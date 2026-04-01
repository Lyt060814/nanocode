/**
 * Grep Tool — Code search
 *
 * Searches file contents using ripgrep (rg) with fallback to grep -rn.
 * Returns results in file:line:content format.
 */

import { execSync } from 'node:child_process'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext } from '../core/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RESULTS = 500
const SEARCH_TIMEOUT_MS = 30_000

// Default directories to exclude
const EXCLUDE_DIRS = [
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'coverage', '__pycache__', '.pytest_cache', 'target', 'vendor',
  '.venv', 'venv', '.tox',
]

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  pattern: z.string().describe(
    'Search pattern (regex supported with ripgrep, basic regex with grep).',
  ),
  path: z.string().optional().describe(
    'Directory or file to search in. Default: working directory.',
  ),
  include: z.string().optional().describe(
    'File pattern to include (e.g., "*.ts", "*.py"). Only search matching files.',
  ),
})

type GrepInput = z.infer<typeof inputSchema>

// ---------------------------------------------------------------------------
// Search Implementation
// ---------------------------------------------------------------------------

function searchWithRipgrep(pattern: string, searchPath: string, include?: string): string | null {
  try {
    const args: string[] = [
      'rg',
      '--line-number',
      '--no-heading',
      '--color=never',
      '--max-count=50',           // Max matches per file
      `--max-columns=200`,        // Truncate long lines
      `--max-columns-preview`,
    ]

    // Exclude directories
    for (const dir of EXCLUDE_DIRS) {
      args.push(`--glob=!${dir}`)
    }

    // Include filter
    if (include) {
      args.push(`--glob=${include}`)
    }

    // Pattern and path
    args.push('--', pattern, searchPath)

    const output = execSync(args.join(' '), {
      encoding: 'utf-8',
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    return output
  } catch (err: any) {
    // Exit code 1 = no matches (not an error for rg)
    if (err.status === 1) return ''
    // Exit code 2 = error
    if (err.status === 2) return null
    // Command not found
    if (err.code === 'ENOENT' || (err.message && err.message.includes('not found'))) return null
    // Timeout or other error
    if (err.stderr && typeof err.stderr === 'string') return null
    return null
  }
}

function searchWithGrep(pattern: string, searchPath: string, include?: string): string {
  const excludeArgs = EXCLUDE_DIRS.map((d) => `--exclude-dir=${d}`).join(' ')
  const includeArg = include ? `--include="${include}"` : ''

  try {
    const cmd = `grep -rn --color=never ${excludeArgs} ${includeArg} -- "${pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null | head -${MAX_RESULTS}`

    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: SEARCH_TIMEOUT_MS,
      maxBuffer: 5 * 1024 * 1024,
    })
  } catch (err: any) {
    // Exit code 1 = no matches
    if (err.status === 1) return ''
    throw err
  }
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const grepToolDef: ToolDef<GrepInput> = {
  name: 'Grep',

  description: 'Search file contents for a pattern. Uses ripgrep (rg) for speed, falls back to grep. Returns file:line:content format.',

  inputSchema,

  async call(input: GrepInput, context: ToolContext): Promise<ToolResult> {
    const { pattern, path, include } = input
    const searchPath = path ? resolve(context.cwd, path) : context.cwd

    if (!pattern.trim()) {
      return { result: 'Error: search pattern cannot be empty.', isError: true }
    }

    try {
      // Try ripgrep first
      let output = searchWithRipgrep(pattern, searchPath, include)

      // Fallback to grep
      if (output === null) {
        output = searchWithGrep(pattern, searchPath, include)
      }

      if (!output || !output.trim()) {
        return {
          result: `No matches found for pattern: ${pattern}${include ? ` in ${include} files` : ''}`,
          isError: false,
        }
      }

      // Limit results
      const lines = output.trim().split('\n')
      let result: string

      if (lines.length > MAX_RESULTS) {
        result = lines.slice(0, MAX_RESULTS).join('\n')
        result += `\n\n(${lines.length} total matches, showing first ${MAX_RESULTS}. Narrow your search for more specific results.)`
      } else {
        result = lines.join('\n')
        result += `\n\n(${lines.length} matches)`
      }

      return { result, isError: false }
    } catch (err: any) {
      return {
        result: `Error searching: ${err.message}`,
        isError: true,
      }
    }
  },

  prompt(): string {
    return [
      'Search file contents for a pattern (regex supported).',
      '',
      'Guidelines:',
      '- Uses ripgrep (rg) for fast search, falls back to grep.',
      '- Results are in file:line:content format.',
      '- Use include to filter by file type (e.g., "*.ts").',
      '- Regex patterns are supported.',
      '- Max 500 results returned.',
    ].join('\n')
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: 30_000,

  userFacingName(input: GrepInput): string {
    return `Grep: ${input.pattern}`
  },
}
