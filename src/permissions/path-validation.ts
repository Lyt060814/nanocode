/**
 * NanoCode — Path Validation
 *
 * Validates file paths against dangerous system directories, symlink
 * escape, and project boundary constraints.
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

// ---------------------------------------------------------------------------
// Dangerous path prefixes
// ---------------------------------------------------------------------------

const DANGEROUS_ABSOLUTE_PATHS = [
  '/',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
]

/**
 * Dangerous paths under user home directory.
 */
function dangerousHomePaths(): string[] {
  const home = os.homedir()
  return [
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.gnupg'),
    path.join(home, '.config'),
  ]
}

/**
 * Check if a resolved path exactly matches or is under a dangerous prefix.
 */
function isDangerousPath(resolved: string): string | null {
  // Check exact dangerous root paths
  for (const dangerous of DANGEROUS_ABSOLUTE_PATHS) {
    if (resolved === dangerous) {
      return dangerous
    }
    // Only flag files directly inside root dangerous dirs like /etc/passwd
    // but not project paths that happen to start with /usr (shouldn't normally)
    if (dangerous !== '/' && resolved.startsWith(dangerous + path.sep)) {
      return dangerous
    }
  }

  // Check dangerous home directories
  for (const dangerous of dangerousHomePaths()) {
    if (resolved === dangerous || resolved.startsWith(dangerous + path.sep)) {
      return dangerous
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Symlink resolution
// ---------------------------------------------------------------------------

/**
 * Resolve symlinks in a path, returning the real path.
 * Returns the original path if it doesn't exist yet (new file).
 */
async function resolveSymlinks(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath)
  } catch {
    // File doesn't exist yet — resolve parent directory instead
    const dir = path.dirname(filePath)
    try {
      const realDir = await fs.realpath(dir)
      return path.join(realDir, path.basename(filePath))
    } catch {
      // Parent doesn't exist either, return as-is
      return filePath
    }
  }
}

// ---------------------------------------------------------------------------
// Main validation
// ---------------------------------------------------------------------------

export interface PathValidationResult {
  allowed: boolean
  message?: string
}

/**
 * Validate whether a file path is safe for tool operations.
 *
 * Checks:
 * 1. Path normalization (resolve to absolute)
 * 2. Dangerous system/credential path detection
 * 3. Symlink resolution — re-check after resolving
 * 4. Project boundary — warn (but allow) if outside project
 *
 * @param filePath     Path to validate (may be relative)
 * @param projectRoot  Project root directory
 * @returns            Validation result with allowed flag and optional message
 */
export async function validatePath(
  filePath: string,
  projectRoot: string,
): Promise<PathValidationResult> {
  // Step 1: Normalize
  const resolved = path.resolve(filePath)

  // Step 2: Check dangerous paths
  const dangerousMatch = isDangerousPath(resolved)
  if (dangerousMatch) {
    return {
      allowed: false,
      message: `Access denied: "${resolved}" is within dangerous system path "${dangerousMatch}".`,
    }
  }

  // Step 3: Resolve symlinks and re-check
  const realPath = await resolveSymlinks(resolved)

  if (realPath !== resolved) {
    // Symlink resolved to a different location — re-check
    const symlinkDanger = isDangerousPath(realPath)
    if (symlinkDanger) {
      return {
        allowed: false,
        message: `Access denied: "${resolved}" is a symlink to "${realPath}" within dangerous path "${symlinkDanger}".`,
      }
    }
  }

  // Step 4: Project boundary check
  const normalizedRoot = path.resolve(projectRoot)
  const isInProject =
    realPath === normalizedRoot || realPath.startsWith(normalizedRoot + path.sep)

  if (!isInProject) {
    return {
      allowed: true,
      message: `Warning: "${resolved}" is outside the project root "${normalizedRoot}".`,
    }
  }

  return { allowed: true }
}
