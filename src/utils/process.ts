/**
 * nanocode — Process Utilities
 *
 * Child process spawning with timeout, signal handling, and
 * graceful shutdown cleanup.
 */

import { spawn } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

export interface SpawnCommandOptions {
  /** Working directory for the command. */
  cwd?: string
  /** Environment variables (merged with process.env). */
  env?: Record<string, string>
  /** Timeout in milliseconds. 0 = no timeout. */
  timeout?: number
  /** AbortSignal for external cancellation. */
  signal?: AbortSignal
  /** Shell to use. Defaults to true (system shell). */
  shell?: boolean | string
}

export interface SpawnCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Spawn a shell command and capture its output.
 *
 * Features:
 * - Captures stdout and stderr as strings
 * - Timeout support (kills process on expiry)
 * - AbortSignal support for external cancellation
 * - Returns exit code (never throws on non-zero)
 *
 * @param command  Shell command string
 * @param opts     Spawn options
 * @returns        Promise resolving to { stdout, stderr, exitCode }
 */
export function spawnCommand(
  command: string,
  opts: SpawnCommandOptions = {},
): Promise<SpawnCommandResult> {
  return new Promise((resolve, reject) => {
    const { cwd, env, timeout = 0, signal, shell = true } = opts

    const spawnOpts: SpawnOptions = {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    }

    const child = spawn(command, [], spawnOpts)

    let stdout = ''
    let stderr = ''
    let killed = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    // Collect stdout
    child.stdout?.setEncoding('utf-8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })

    // Collect stderr
    child.stderr?.setEncoding('utf-8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    // Timeout handling
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        killed = true
        child.kill('SIGTERM')
        // Hard kill after 5s grace period
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL')
          }
        }, 5000)
      }, timeout)
    }

    // AbortSignal handling
    if (signal) {
      const onAbort = (): void => {
        killed = true
        child.kill('SIGTERM')
      }

      if (signal.aborted) {
        child.kill('SIGTERM')
        killed = true
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
        child.on('close', () => {
          signal.removeEventListener('abort', onAbort)
        })
      }
    }

    child.on('error', (err) => {
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      reject(err)
    })

    child.on('close', (code) => {
      if (timeoutId !== undefined) clearTimeout(timeoutId)

      if (killed && code === null) {
        resolve({
          stdout,
          stderr: stderr || 'Process was killed (timeout or abort)',
          exitCode: 137,
        })
        return
      }

      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

type CleanupFn = () => void | Promise<void>
const cleanupHandlers: CleanupFn[] = []

/**
 * Register a cleanup function for graceful shutdown.
 * All registered functions are called on SIGINT/SIGTERM.
 */
export function onCleanup(fn: CleanupFn): void {
  cleanupHandlers.push(fn)
}

/**
 * Run all registered cleanup handlers and exit.
 */
export async function cleanup(): Promise<void> {
  for (const fn of cleanupHandlers) {
    try {
      await fn()
    } catch {
      // Best-effort cleanup
    }
  }
  cleanupHandlers.length = 0
}

// Install signal handlers (once)
let signalHandlersInstalled = false

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return
  signalHandlersInstalled = true

  const handler = async (signal: string): Promise<void> => {
    await cleanup()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }

  process.on('SIGINT', () => handler('SIGINT'))
  process.on('SIGTERM', () => handler('SIGTERM'))
}

installSignalHandlers()
