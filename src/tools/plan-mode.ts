/**
 * Plan Mode Tools — Enter/Exit plan mode
 *
 * Plan mode restricts the agent to read-only operations.
 * Useful for analysis and planning before making changes.
 */

import { createInterface } from 'node:readline'
import type { Interface as ReadlineInterface } from 'node:readline'
import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext, PermissionMode } from '../core/types.js'

// ---------------------------------------------------------------------------
// Plan Mode State
// ---------------------------------------------------------------------------

let _previousMode: PermissionMode | null = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isYes(answer: string): boolean {
  const normalized = answer.trim().toLowerCase()
  return normalized === 'y' || normalized === 'yes'
}

function askUserConfirmation(
  question: string,
  rl?: ReadlineInterface,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error('Aborted'))
      return
    }

    const prompt = `\n\x1b[36m? ${question} (y/n)\x1b[0m\n> `
    const onAbort = () => reject(new Error('Aborted'))

    abortSignal?.addEventListener('abort', onAbort, { once: true })

    // Use existing readline instance if available (avoids stdin conflicts)
    if (rl) {
      rl.question(prompt, (answer) => {
        abortSignal?.removeEventListener('abort', onAbort)
        resolve(isYes(answer))
      })
      return
    }

    // Fallback: create new readline instance (for headless/testing)
    const newRl = createInterface({ input: process.stdin, output: process.stderr })

    const cleanup = () => {
      abortSignal?.removeEventListener('abort', onAbort)
      newRl.removeAllListeners()
      newRl.close()
    }

    abortSignal?.addEventListener('abort', () => {
      cleanup()
      reject(new Error('Aborted'))
    }, { once: true })

    process.stderr.write(prompt)

    newRl.once('line', (answer) => {
      cleanup()
      resolve(isYes(answer))
    })

    newRl.once('close', () => {
      cleanup()
      resolve(false)
    })

    newRl.once('error', (err) => {
      cleanup()
      reject(err)
    })
  })
}

function setMode(context: ToolContext, mode: PermissionMode): void {
  context.setPermissionMode?.(mode)
  ;(context as any).permissionMode = mode
}

// ---------------------------------------------------------------------------
// EnterPlanMode
// ---------------------------------------------------------------------------

const enterPlanInputSchema = z.object({
  reason: z.string().optional().describe('Optional reason for entering plan mode.'),
})

type EnterPlanInput = z.infer<typeof enterPlanInputSchema>

export const enterPlanModeToolDef: ToolDef<EnterPlanInput> = {
  name: 'EnterPlanMode',

  description: 'Enter plan mode. In plan mode, you can only read files and search — no edits or writes are allowed. Use this when you need to gather information and plan before making changes.',

  inputSchema: enterPlanInputSchema,

  async call(input: EnterPlanInput, context: ToolContext): Promise<ToolResult> {
    if (context.permissionMode === 'plan') {
      return { result: 'Already in plan mode.', isError: false }
    }

    _previousMode = context.permissionMode
    setMode(context, 'plan')

    return {
      result: [
        'Plan mode activated. You can now only use read-only tools.',
        'Use ExitPlanMode when ready to implement.',
        input.reason ? `Reason: ${input.reason}` : '',
      ].filter(Boolean).join('\n'),
      isError: false,
    }
  },

  prompt(): string {
    return 'Enter plan mode to restrict to read-only operations. Useful for analysis and planning phases before making changes.'
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  maxResultSizeChars: 1_000,

  userFacingName(): string {
    return 'EnterPlanMode'
  },
}

// ---------------------------------------------------------------------------
// ExitPlanMode
// ---------------------------------------------------------------------------

const exitPlanInputSchema = z.object({
  reason: z.string().optional().describe('Optional reason for exiting plan mode.'),
})

type ExitPlanInput = z.infer<typeof exitPlanInputSchema>

export const exitPlanModeToolDef: ToolDef<ExitPlanInput> = {
  name: 'ExitPlanMode',

  description: 'Exit plan mode and return to normal mode where edits and writes are allowed.',

  inputSchema: exitPlanInputSchema,

  async call(input: ExitPlanInput, context: ToolContext): Promise<ToolResult> {
    if (context.permissionMode !== 'plan') {
      return { result: 'Not currently in plan mode.', isError: false }
    }

    // Ask user for confirmation before exiting plan mode
    try {
      const confirmed = await askUserConfirmation(
        'Exit plan mode? This will restore write operations.',
        context.readline,
        context.abortSignal,
      )

      if (!confirmed) {
        return { result: 'Plan mode exit cancelled by user.', isError: false }
      }
    } catch (err: any) {
      if (err.message === 'Aborted') {
        return { result: '(User interaction cancelled)', isError: false }
      }
      return { result: `Error reading user input: ${err.message}`, isError: true }
    }

    const previousMode = _previousMode ?? 'default'
    _previousMode = null
    setMode(context, previousMode)

    return {
      result: [
        `Plan mode deactivated. Restored to "${previousMode}" mode.`,
        'All tools are now available including edits and writes.',
        input.reason ? `Reason: ${input.reason}` : '',
      ].filter(Boolean).join('\n'),
      isError: false,
    }
  },

  prompt(): string {
    return 'Exit plan mode and return to normal operation. Restores the previous permission mode.'
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => false,
  maxResultSizeChars: 1_000,

  userFacingName(): string {
    return 'ExitPlanMode'
  },
}

// ---------------------------------------------------------------------------
// Helpers (for external use / testing)
// ---------------------------------------------------------------------------

export function getPreviousPlanMode(): PermissionMode | null {
  return _previousMode
}

export function resetPlanModeState(): void {
  _previousMode = null
}
