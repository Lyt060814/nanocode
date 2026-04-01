/**
 * Bash Read-Only Command Validator
 *
 * THE CRITICAL PERFORMANCE FILE.
 * Determines if a shell command is safe (read-only) to run without permission.
 * Commands that only read data can be executed concurrently and without user approval.
 *
 * Key patterns from Claude Code: isReadOnlyCommand analysis with allowlist approach.
 */

// ---------------------------------------------------------------------------
// Safe Command Allowlist
// ---------------------------------------------------------------------------

const SAFE_COMMANDS: ReadonlySet<string> = new Set([
  // File content viewing
  'cat', 'head', 'tail', 'less', 'more',

  // Text processing (read-only)
  'wc', 'sort', 'uniq', 'diff', 'comm',

  // File finding
  'find', 'ls', 'tree',

  // Shell builtins (safe ones)
  'pwd', 'echo', 'printf',

  // Search tools
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack',

  // Text transformation (read-only pipeline tools)
  'awk', 'sed',
  'tr', 'cut', 'paste', 'col', 'column', 'fold', 'fmt', 'expand', 'unexpand',
  'tee', // Only safe to /dev/null, validated separately

  // Version control (read operations)
  'git',

  // Version checks
  'node', 'python', 'python3', 'ruby', 'perl',
  'cargo', 'go', 'rustc', 'java', 'javac', 'gcc', 'g++', 'clang',

  // System info
  'which', 'type', 'file', 'stat', 'du', 'df',
  'env', 'printenv', 'date', 'uname', 'whoami', 'id', 'hostname',

  // Test/conditionals
  'test', '[', 'true', 'false',

  // Package list commands
  'npm', 'yarn', 'pnpm', 'pip', 'pip3', 'gem', 'bundle',

  // Path utilities
  'realpath', 'dirname', 'basename', 'readlink',

  // Hash / binary inspection
  'md5sum', 'sha256sum', 'sha1sum', 'shasum',
  'xxd', 'od', 'strings', 'nm', 'hexdump',

  // JSON processing
  'jq',

  // Misc safe
  'xargs', // Only safe with safe sub-commands, validated separately
])

// ---------------------------------------------------------------------------
// Git Safe Subcommands
// ---------------------------------------------------------------------------

const GIT_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'log', 'diff', 'show', 'status', 'branch', 'remote', 'tag',
  'rev-parse', 'rev-list', 'describe', 'shortlog', 'blame',
  'ls-files', 'ls-tree', 'ls-remote', 'cat-file',
  'name-rev', 'config', 'for-each-ref', 'count-objects',
  'stash', // stash list/show are safe
])

// Git subcommands that are only safe with certain flags
const GIT_STASH_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'list', 'show',
])

// ---------------------------------------------------------------------------
// npm/yarn/pip safe subcommands
// ---------------------------------------------------------------------------

const NPM_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'list', 'ls', 'view', 'info', 'show', 'search', 'outdated',
  'explain', 'why', 'fund', 'audit', 'doctor', 'config',
])

const YARN_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'list', 'info', 'why', 'outdated', 'config',
])

const PIP_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'list', 'show', 'freeze', 'check',
])

// ---------------------------------------------------------------------------
// Dangerous Patterns
// ---------------------------------------------------------------------------

/**
 * Patterns that indicate command substitution or other unsafe constructs.
 * These are checked against the raw command string before parsing.
 */
const DANGEROUS_PATTERNS: ReadonlyArray<RegExp> = [
  // Command substitution
  /\$\(/,
  /`[^`]*`/,

  // Process substitution
  /<\(/,
  />\(/,

  // Output redirection (but not input redirection <)
  /(?<![12<])>(?!&\d|\/dev\/null)/,
  />>(?!\/dev\/null)/,

  // Function definitions
  /\bfunction\s+\w+/,
  /\w+\s*\(\)\s*\{/,

  // Dangerous builtins
  /\beval\b/,
  /\bexec\b/,
  /\bsource\b/,
  /\b\.\s+\//,  // . /path/to/script (source shorthand)
]

// ---------------------------------------------------------------------------
// Safe Environment Variable Prefixes
// ---------------------------------------------------------------------------

const SAFE_ENV_VARS: ReadonlySet<string> = new Set([
  'GOARCH', 'GOOS', 'GOPATH', 'GOROOT', 'GOBIN', 'GOFLAGS',
  'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH',
  'PYTHONPATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUNBUFFERED',
  'RUST_BACKTRACE', 'RUST_LOG', 'CARGO_HOME',
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
  'TZ', 'EDITOR', 'VISUAL', 'PAGER',
  'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI',
  'DEBUG', 'VERBOSE', 'QUIET',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'FZF_DEFAULT_COMMAND', 'FZF_DEFAULT_OPTS',
  'COLUMNS', 'LINES',
  'TMPDIR', 'TEMP', 'TMP',
])

// ---------------------------------------------------------------------------
// Sed Safety
// ---------------------------------------------------------------------------

/**
 * sed is only safe with -n flag (suppress automatic printing)
 * or -E/-r for extended regex. Without -n, sed with s/// modifies output
 * but that's still read-only in a pipeline. The key danger is -i (in-place edit).
 */
const SED_DANGEROUS_FLAGS: ReadonlySet<string> = new Set(['-i', '--in-place'])

// ---------------------------------------------------------------------------
// Command Parser
// ---------------------------------------------------------------------------

/**
 * Split a compound command string into individual command parts,
 * handling &&, ||, ;, and | operators.
 * Respects single and double quoted strings.
 */
export function parseCommandParts(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let i = 0

  while (i < command.length) {
    const ch = command[i]!

    // Handle escape sequences
    if (ch === '\\' && !inSingleQuote && i + 1 < command.length) {
      current += ch + command[i + 1]!
      i += 2
      continue
    }

    // Handle quotes
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += ch
      i++
      continue
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += ch
      i++
      continue
    }

    // If inside quotes, just accumulate
    if (inSingleQuote || inDoubleQuote) {
      current += ch
      i++
      continue
    }

    // Check for operators: &&, ||, ;, |
    if (ch === '&' && command[i + 1] === '&') {
      if (current.trim()) parts.push(current.trim())
      current = ''
      i += 2
      continue
    }

    if (ch === '|' && command[i + 1] === '|') {
      if (current.trim()) parts.push(current.trim())
      current = ''
      i += 2
      continue
    }

    if (ch === ';') {
      if (current.trim()) parts.push(current.trim())
      current = ''
      i++
      continue
    }

    if (ch === '|') {
      if (current.trim()) parts.push(current.trim())
      current = ''
      i++
      continue
    }

    current += ch
    i++
  }

  if (current.trim()) parts.push(current.trim())
  return parts
}

/**
 * Extract the base command and arguments from a command part.
 * Handles leading env var assignments (VAR=value cmd args...).
 */
function extractCommandAndArgs(part: string): { envVars: string[]; command: string; args: string[] } {
  const tokens = tokenize(part)
  const envVars: string[] = []
  let commandIdx = 0

  // Skip leading env var assignments
  for (let i = 0; i < tokens.length; i++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
      envVars.push(tokens[i]!)
      commandIdx = i + 1
    } else {
      break
    }
  }

  const command = tokens[commandIdx] ?? ''
  const args = tokens.slice(commandIdx + 1)

  return { envVars, command, args }
}

/**
 * Simple tokenizer that splits on whitespace but respects quotes.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!

    if (ch === '\\' && !inSingleQuote && i + 1 < input.length) {
      current += ch + input[i + 1]!
      i++
      continue
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      current += ch
      continue
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      current += ch
      continue
    }

    if (!inSingleQuote && !inDoubleQuote && /\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += ch
  }

  if (current) tokens.push(current)
  return tokens
}

// ---------------------------------------------------------------------------
// Per-Command Flag Validation
// ---------------------------------------------------------------------------

/**
 * Validate that the flags/arguments for a specific command are safe.
 * Returns true if safe, false if dangerous flags are detected.
 */
export function validateFlags(command: string, args: string[]): boolean {
  switch (command) {
    case 'sed': {
      // sed -i is dangerous (in-place edit)
      for (const arg of args) {
        if (SED_DANGEROUS_FLAGS.has(arg)) return false
        // Also catch -i with backup suffix: -i.bak, -i''
        if (arg.startsWith('-i')) return false
      }
      return true
    }

    case 'git': {
      // First non-flag arg is the subcommand
      const subcommand = args.find((a) => !a.startsWith('-'))
      if (!subcommand) return true // bare 'git' is safe

      // Handle 'git stash' specially
      if (subcommand === 'stash') {
        const stashSub = args.find((a, i) => i > args.indexOf('stash') && !a.startsWith('-'))
        if (stashSub && !GIT_STASH_SAFE_SUBCOMMANDS.has(stashSub)) return false
        return true
      }

      return GIT_SAFE_SUBCOMMANDS.has(subcommand)
    }

    case 'npm':
    case 'npx': {
      const sub = args.find((a) => !a.startsWith('-'))
      if (!sub) return command === 'npm' // bare npm is safe, bare npx is not
      if (command === 'npx') return false // npx runs arbitrary commands
      return NPM_SAFE_SUBCOMMANDS.has(sub)
    }

    case 'yarn': {
      const sub = args.find((a) => !a.startsWith('-'))
      if (!sub) return true
      return YARN_SAFE_SUBCOMMANDS.has(sub)
    }

    case 'pnpm': {
      const sub = args.find((a) => !a.startsWith('-'))
      if (!sub) return true
      return NPM_SAFE_SUBCOMMANDS.has(sub) // Reuse npm safe subcommands
    }

    case 'pip':
    case 'pip3': {
      const sub = args.find((a) => !a.startsWith('-'))
      if (!sub) return true
      return PIP_SAFE_SUBCOMMANDS.has(sub)
    }

    case 'cargo': {
      const sub = args.find((a) => !a.startsWith('-'))
      if (!sub) return true
      return sub === '--version'
    }

    case 'go': {
      const sub = args.find((a) => !a.startsWith('-'))
      if (!sub) return true
      return sub === 'version' || sub === 'env' || sub === 'list'
    }

    case 'rustc': {
      return args.some((a) => a === '--version' || a === '-V')
    }

    case 'node':
    case 'python':
    case 'python3':
    case 'ruby':
    case 'perl': {
      // Only safe with --version or -v
      if (args.length === 0) return false
      return args.every((a) => a === '--version' || a === '-v' || a === '-V')
    }

    case 'jq': {
      // jq is safe unless -f is used (reads from file as program)
      for (const arg of args) {
        if (arg === '-f' || arg === '--from-file') return false
      }
      return true
    }

    case 'tee': {
      // tee is only safe if writing to /dev/null
      const nonFlags = args.filter((a) => !a.startsWith('-'))
      return nonFlags.every((a) => a === '/dev/null')
    }

    case 'xargs': {
      // xargs is safe only if the sub-command is also safe
      const xargsCmd = args.find((a) => !a.startsWith('-'))
      if (!xargsCmd) return false
      return SAFE_COMMANDS.has(xargsCmd)
    }

    case 'bundle': {
      const sub = args.find((a) => !a.startsWith('-'))
      if (!sub) return true
      return sub === 'list' || sub === 'show' || sub === 'info' || sub === 'outdated'
    }

    case 'gem': {
      const sub = args.find((a) => !a.startsWith('-'))
      if (!sub) return true
      return sub === 'list' || sub === 'search' || sub === 'info' || sub === 'environment'
    }

    case 'find': {
      // find is mostly safe, but -exec and -delete are dangerous
      for (const arg of args) {
        if (arg === '-exec' || arg === '-execdir' || arg === '-delete' || arg === '-ok') {
          return false
        }
      }
      return true
    }

    case 'awk': {
      // awk is safe for reading, but check for system() or output redirection
      const program = args.find((a) => !a.startsWith('-') && a !== '-F')
      if (program && /\bsystem\s*\(/.test(program)) return false
      if (program && />[^&]/.test(program)) return false
      return true
    }

    default:
      return true
  }
}

// ---------------------------------------------------------------------------
// Environment Variable Safety Check
// ---------------------------------------------------------------------------

function areEnvVarsSafe(envVars: string[]): boolean {
  for (const assignment of envVars) {
    const eqIdx = assignment.indexOf('=')
    if (eqIdx < 0) return false
    const varName = assignment.slice(0, eqIdx)
    if (!SAFE_ENV_VARS.has(varName)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Single Command Part Check
// ---------------------------------------------------------------------------

/**
 * Check if a single command part (no pipes/operators) is read-only safe.
 */
export function checkSafeCommand(part: string): boolean {
  const trimmed = part.trim()
  if (!trimmed) return true

  const { envVars, command, args } = extractCommandAndArgs(trimmed)

  // Validate env vars
  if (envVars.length > 0 && !areEnvVarsSafe(envVars)) {
    return false
  }

  // Empty command (just env vars) is safe
  if (!command) return true

  // Strip path prefix (e.g., /usr/bin/grep → grep)
  const baseCommand = command.split('/').pop() ?? command

  // Check if base command is in allowlist
  if (!SAFE_COMMANDS.has(baseCommand)) {
    return false
  }

  // Per-command flag validation
  return validateFlags(baseCommand, args)
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Determine if a shell command is read-only (safe to run without permission).
 *
 * Strategy:
 * 1. Check for dangerous patterns in the raw command
 * 2. Parse into individual command parts (split on &&, ||, ;, |)
 * 3. For each part, check if the base command is in the allowlist
 * 4. Validate per-command flags
 *
 * Returns true only if ALL parts are safe.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return true

  // Check for dangerous patterns first (fast rejection)
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      // Special case: allow > /dev/null and >> /dev/null
      if (/>\s*\/dev\/null/.test(trimmed) || />>\s*\/dev\/null/.test(trimmed)) {
        // Only allow if that's the only redirection
        const withoutDevNull = trimmed
          .replace(/>>\s*\/dev\/null/g, '')
          .replace(/>\s*\/dev\/null/g, '')
          .replace(/2>&1/g, '')
        // Re-check without the /dev/null redirections
        let stillDangerous = false
        for (const p of DANGEROUS_PATTERNS) {
          if (p.test(withoutDevNull)) {
            stillDangerous = true
            break
          }
        }
        if (stillDangerous) return false
        // Continue with the cleaned command
      } else {
        return false
      }
    }
  }

  // Parse into parts
  const parts = parseCommandParts(trimmed)
  if (parts.length === 0) return true

  // Every part must be safe
  return parts.every(checkSafeCommand)
}
