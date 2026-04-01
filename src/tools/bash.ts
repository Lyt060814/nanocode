/**
 * Bash Tool — Shell command execution
 *
 * Spawns a child process to run shell commands.
 * Delegates read-only detection to bash-readonly.ts for permission/concurrency decisions.
 */

import { spawn } from 'node:child_process'
import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext } from '../core/types.js'
import { isReadOnlyCommand } from './bash-readonly.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000 // 120 seconds
const MAX_RESULT_SIZE_CHARS = 30_000
const MAX_BUFFER_SIZE = 10 * 1024 * 1024 // 10 MB

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  command: z.string().describe(
    'The bash command to execute. Can be a simple command or a compound command with pipes, &&, ||, etc.',
  ),
  timeout: z.number().optional().describe(
    'Timeout in seconds. Default: 120. Max: 600.',
  ),
  description: z.string().optional().describe(
    'A short human-readable description of what the command does and why.',
  ),
})

type BashInput = z.infer<typeof inputSchema>

// ---------------------------------------------------------------------------
// Command Execution
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', command], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure consistent output
        LANG: process.env.LANG || 'en_US.UTF-8',
        TERM: process.env.TERM || 'xterm-256color',
        // Disable pagers
        GIT_PAGER: 'cat',
        PAGER: 'cat',
      },
    })

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let timedOut = false

    // Handle abort signal
    const onAbort = () => {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 2000)
    }

    if (abortSignal) {
      if (abortSignal.aborted) {
        child.kill('SIGTERM')
        reject(new Error('Aborted'))
        return
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    // Set timeout
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
      }, 2000)
    }, timeoutMs)

    // Collect stdout
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return
      stdout += chunk.toString()
      if (stdout.length > MAX_BUFFER_SIZE) {
        stdoutTruncated = true
        stdout = stdout.slice(0, MAX_BUFFER_SIZE)
      }
    })

    // Collect stderr
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrTruncated) return
      stderr += chunk.toString()
      if (stderr.length > MAX_BUFFER_SIZE) {
        stderrTruncated = true
        stderr = stderr.slice(0, MAX_BUFFER_SIZE)
      }
    })

    // Close stdin immediately (we don't send input)
    child.stdin?.end()

    child.on('close', (code) => {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        timedOut,
      })
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
      reject(err)
    })
  })
}

// ---------------------------------------------------------------------------
// Output Formatting
// ---------------------------------------------------------------------------

function formatOutput(result: ExecResult): string {
  const parts: string[] = []

  if (result.timedOut) {
    parts.push('[Command timed out]')
  }

  if (result.stdout) {
    let stdout = result.stdout
    if (stdout.length > MAX_RESULT_SIZE_CHARS) {
      stdout = stdout.slice(0, MAX_RESULT_SIZE_CHARS)
      parts.push(stdout)
      parts.push(`\n[stdout truncated: ${result.stdout.length} chars total]`)
    } else {
      parts.push(stdout)
    }
  }

  if (result.stderr) {
    let stderr = result.stderr
    if (stderr.length > MAX_RESULT_SIZE_CHARS / 3) {
      stderr = stderr.slice(0, MAX_RESULT_SIZE_CHARS / 3)
      parts.push(`\nSTDERR:\n${stderr}`)
      parts.push(`[stderr truncated: ${result.stderr.length} chars total]`)
    } else if (stderr.trim()) {
      parts.push(`\nSTDERR:\n${stderr}`)
    }
  }

  if (parts.length === 0) {
    if (result.exitCode === 0) {
      return '(No output)'
    }
    return `(No output, exit code: ${result.exitCode})`
  }

  if (result.exitCode !== 0 && !result.timedOut) {
    parts.push(`\n(exit code: ${result.exitCode})`)
  }

  return parts.join('')
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const bashToolDef: ToolDef<BashInput> = {
  name: 'Bash',

  description: (input?: BashInput) => {
    if (input?.description) {
      return `Bash: ${input.description}`
    }
    return 'Execute a bash command. Use for running scripts, installing packages, searching code, and system operations.'
  },

  inputSchema,

  async call(input: BashInput, context: ToolContext): Promise<ToolResult> {
    const { command, timeout, description } = input
    const timeoutMs = Math.min((timeout ?? 120) * 1000, 600_000)

    // Validate command is not empty
    if (!command.trim()) {
      return { result: 'Error: command cannot be empty.', isError: true }
    }

    try {
      const result = await executeCommand(
        command,
        context.cwd,
        timeoutMs,
        context.abortSignal,
      )

      const output = formatOutput(result)

      return {
        result: output,
        isError: result.exitCode !== 0 && !result.timedOut,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        result: `Error executing command: ${message}`,
        isError: true,
      }
    }
  },

  prompt(): string {
    return [
      'Execute bash commands to interact with the system.',
      'Use for: running scripts, searching code, checking file status, running tests, installing packages.',
      '',
      'Guidelines:',
      '- Prefer non-interactive commands.',
      '- For long-running processes, consider using timeout.',
      '- Use pipes and redirection for complex data processing.',
      '- The command runs in the project working directory.',
      '- Combine commands with && for sequential execution.',
      '- Use grep/rg for searching, find for file discovery.',
    ].join('\n')
  },

  isReadOnly(input: BashInput): boolean {
    return isReadOnlyCommand(input.command)
  },

  isConcurrencySafe(input: BashInput): boolean {
    return isReadOnlyCommand(input.command)
  },

  maxResultSizeChars: MAX_RESULT_SIZE_CHARS,

  userFacingName(input: BashInput): string {
    const cmd = input.command
    if (cmd.length > 60) {
      return `Bash: ${cmd.slice(0, 57)}...`
    }
    return `Bash: ${cmd}`
  },
}
