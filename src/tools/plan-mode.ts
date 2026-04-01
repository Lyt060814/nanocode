/**
 * Plan Mode Tools — Enter/Exit plan mode
 *
 * Plan mode restricts the agent to read-only operations.
 * Useful for analysis and planning before making changes.
 */

import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext } from '../core/types.js'

// ---------------------------------------------------------------------------
// Plan Mode State
// ---------------------------------------------------------------------------

let _previousMode: string | null = null

// ---------------------------------------------------------------------------
// EnterPlanMode
// ---------------------------------------------------------------------------

const enterPlanInputSchema = z.object({
  reason: z.string().optional().describe(
    'Optional reason for entering plan mode.',
  ),
})

type EnterPlanInput = z.infer<typeof enterPlanInputSchema>

export const enterPlanModeToolDef: ToolDef<EnterPlanInput> = {
  name: 'EnterPlanMode',

  description: 'Enter plan mode. In plan mode, you can only read files and search — no edits or writes are allowed. Use this when you need to gather information and plan before making changes.',

  inputSchema: enterPlanInputSchema,

  async call(input: EnterPlanInput, context: ToolContext): Promise<ToolResult> {
    if (context.permissionMode === 'plan') {
      return {
        result: 'Already in plan mode.',
        isError: false,
      }
    }

    // Save current mode so we can restore it
    _previousMode = context.permissionMode

    // Signal mode change through the context (mutable)
    ;(context as any).permissionMode = 'plan'

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
    return [
      'Enter plan mode to restrict to read-only operations.',
      'Useful for analysis and planning phases before making changes.',
    ].join('\n')
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
  reason: z.string().optional().describe(
    'Optional reason for exiting plan mode.',
  ),
})

type ExitPlanInput = z.infer<typeof exitPlanInputSchema>

export const exitPlanModeToolDef: ToolDef<ExitPlanInput> = {
  name: 'ExitPlanMode',

  description: 'Exit plan mode and return to normal mode where edits and writes are allowed.',

  inputSchema: exitPlanInputSchema,

  async call(input: ExitPlanInput, context: ToolContext): Promise<ToolResult> {
    if (context.permissionMode !== 'plan') {
      return {
        result: 'Not currently in plan mode.',
        isError: false,
      }
    }

    const previousMode = _previousMode ?? 'default'
    _previousMode = null

    // Restore previous mode
    ;(context as any).permissionMode = previousMode

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
    return [
      'Exit plan mode and return to normal operation.',
      'Restores the previous permission mode.',
    ].join('\n')
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

/**
 * Get the saved previous mode (for mode restoration by the caller).
 */
export function getPreviousPlanMode(): string | null {
  return _previousMode
}

/**
 * Reset plan mode state (for testing).
 */
export function resetPlanModeState(): void {
  _previousMode = null
}
