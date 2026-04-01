/**
 * nanocode Git Context
 *
 * Gathers git repository information for the system prompt.
 * Collects branch name, status, and recent commit log.
 * Results are cached per session to avoid repeated subprocess calls.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of porcelain status lines to include. */
const MAX_STATUS_LINES = 100

/** Maximum number of recent commits to include. */
const MAX_LOG_ENTRIES = 10

/** Timeout for git commands in milliseconds. */
const GIT_TIMEOUT = 5_000

// ---------------------------------------------------------------------------
// Session cache
// ---------------------------------------------------------------------------

/**
 * Simple session-scoped cache for git context.
 * The cache is keyed by cwd so multiple projects can be tracked.
 * Cache entries expire after CACHE_TTL_MS.
 */
const cache = new Map<string, { value: string; timestamp: number }>()

/** Cache TTL: 5 minutes. Git state changes rarely mid-conversation. */
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * Clear the git context cache. Useful for testing or after git operations.
 */
export function clearGitCache(): void {
  cache.clear()
}

// ---------------------------------------------------------------------------
// Git command helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command and return stdout, or null on failure.
 */
async function git(
  args: string[],
  cwd: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT,
      maxBuffer: 1024 * 1024, // 1MB
      env: {
        ...process.env,
        // Prevent git from prompting for credentials
        GIT_TERMINAL_PROMPT: '0',
        // Use English output regardless of locale
        LC_ALL: 'C',
      },
    })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * Check if the given directory is inside a git repository.
 */
async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await git(['rev-parse', '--is-inside-work-tree'], cwd)
  return result === 'true'
}

// ---------------------------------------------------------------------------
// Context gathering
// ---------------------------------------------------------------------------

/**
 * Get the current branch name.
 */
async function getBranch(cwd: string): Promise<string | null> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
}

/**
 * Get the main/default branch name.
 */
async function getMainBranch(cwd: string): Promise<string | null> {
  // Try common default branch names
  for (const branch of ['main', 'master']) {
    const result = await git(
      ['rev-parse', '--verify', '--quiet', branch],
      cwd,
    )
    if (result !== null) {
      return branch
    }
  }
  return null
}

/**
 * Get porcelain status (max MAX_STATUS_LINES lines).
 */
async function getStatus(cwd: string): Promise<string | null> {
  const result = await git(['status', '--porcelain'], cwd)
  if (result === null) {
    return null
  }

  const lines = result.split('\n')
  if (lines.length > MAX_STATUS_LINES) {
    const truncated = lines.slice(0, MAX_STATUS_LINES).join('\n')
    return `${truncated}\n... (${lines.length - MAX_STATUS_LINES} more files)`
  }

  return result
}

/**
 * Get recent commit log (oneline format).
 */
async function getLog(cwd: string): Promise<string | null> {
  return git(
    ['log', '--oneline', `-${MAX_LOG_ENTRIES}`],
    cwd,
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Gather git repository context for the system prompt.
 *
 * Returns a formatted string containing:
 * - Current branch
 * - Main branch (for PR context)
 * - Working tree status (porcelain, max 100 lines)
 * - Recent commits (oneline, last 10)
 *
 * Returns empty string if the cwd is not a git repository.
 * Results are cached per cwd for the duration of the session.
 *
 * @param cwd Working directory to check
 * @returns Formatted git context string
 */
export async function getGitContext(cwd: string): Promise<string> {
  // Check cache
  const cached = cache.get(cwd)
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.value
  }

  // Check if this is a git repo
  if (!(await isGitRepo(cwd))) {
    const result = 'Not a git repository.'
    cache.set(cwd, { value: result, timestamp: Date.now() })
    return result
  }

  // Gather all info in parallel
  const [branch, mainBranch, status, log] = await Promise.all([
    getBranch(cwd),
    getMainBranch(cwd),
    getStatus(cwd),
    getLog(cwd),
  ])

  // Format the context
  const sections: string[] = []

  if (branch) {
    sections.push(`Current branch: ${branch}`)
  }

  if (mainBranch) {
    sections.push(`Main branch: ${mainBranch}`)
  }

  if (status !== null) {
    if (status.length === 0) {
      sections.push('Status: Clean working tree')
    } else {
      sections.push(`Status:\n${status}`)
    }
  }

  if (log) {
    sections.push(`Recent commits:\n${log}`)
  }

  const result = sections.join('\n\n')

  // Cache the result
  cache.set(cwd, { value: result, timestamp: Date.now() })

  return result
}

/**
 * Get a short git status summary (one line).
 * Useful for the prompt status bar.
 */
export async function getGitStatusShort(cwd: string): Promise<string> {
  if (!(await isGitRepo(cwd))) {
    return ''
  }

  const branch = await getBranch(cwd)
  const status = await getStatus(cwd)

  if (!branch) {
    return ''
  }

  const fileCount = status
    ? status.split('\n').filter((l) => l.trim().length > 0).length
    : 0

  if (fileCount === 0) {
    return `${branch} (clean)`
  }

  return `${branch} (${fileCount} changed)`
}
