/**
 * NanoCode — Permission Engine
 *
 * Central permission decision logic. Evaluates tool invocations against
 * deny rules, allow rules, permission mode, and falls through to user prompt.
 */

import type {
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  ToolDef,
} from '../core/types.js'
import { matchRule, loadProjectRules, loadUserRules } from './rules.js'
import { getModeRestrictions } from './modes.js'

// ---------------------------------------------------------------------------
// Session rules (in-memory, per-session)
// ---------------------------------------------------------------------------

let sessionRules: PermissionRule[] = []

/**
 * Add a permission rule for the current session.
 */
export function addSessionRule(rule: PermissionRule): void {
  sessionRules.push(rule)
}

/**
 * Get all session-scoped permission rules.
 */
export function getSessionRules(): PermissionRule[] {
  return [...sessionRules]
}

/**
 * Reset session rules (for testing or session restart).
 */
export function clearSessionRules(): void {
  sessionRules = []
}

// ---------------------------------------------------------------------------
// Read-only command detection (for Bash tool)
// ---------------------------------------------------------------------------

const READ_ONLY_PREFIXES = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'rg',
  'find',
  'fd',
  'which',
  'whoami',
  'pwd',
  'echo',
  'date',
  'env',
  'printenv',
  'file',
  'stat',
  'du',
  'df',
  'uname',
  'hostname',
  'id',
  'git log',
  'git status',
  'git diff',
  'git show',
  'git branch',
  'git remote',
  'git tag',
  'git rev-parse',
]

/**
 * Check if a bash command is read-only (safe to run without user approval).
 */
function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  return READ_ONLY_PREFIXES.some(
    (prefix) =>
      trimmed === prefix ||
      trimmed.startsWith(prefix + ' ') ||
      trimmed.startsWith(prefix + '\t'),
  )
}

// ---------------------------------------------------------------------------
// Permission context for decision making
// ---------------------------------------------------------------------------

export interface PermissionContext {
  cwd: string
  permissionMode: PermissionMode
  tools: Array<Pick<ToolDef, 'name' | 'isReadOnly'>>
}

// ---------------------------------------------------------------------------
// Main permission check
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a tool invocation should be allowed, denied, or require
 * user confirmation.
 *
 * Decision flow:
 * 1. Check deny rules → deny immediately
 * 2. Check if tool is read-only → allow
 * 3. Check bypassPermissions mode → allow all
 * 4. Check allow rules (tool + content match) → allow
 * 5. Check acceptEdits mode → allow file operations
 * 6. Check plan mode → deny writes
 * 7. For Bash tool: check isReadOnlyCommand → allow
 * 8. Default: ask user
 *
 * @param toolName  Name of the tool being invoked
 * @param input     Input parameters for the tool
 * @param context   Permission evaluation context
 * @returns         PermissionDecision with behavior and optional message
 */
export async function checkPermission(
  toolName: string,
  input: Record<string, unknown>,
  context: PermissionContext,
): Promise<PermissionDecision> {
  // Gather all rules: session > project > user (priority order)
  const projectRules = await loadProjectRules(context.cwd)
  const userRules = await loadUserRules()
  const allRules: PermissionRule[] = [...sessionRules, ...projectRules, ...userRules]

  // Step 1: Check deny rules
  for (const rule of allRules) {
    if (rule.behavior === 'deny' && matchRule(toolName, input, rule)) {
      return {
        behavior: 'deny',
        message: `Denied by ${rule.source} rule for tool "${rule.tool}"`,
      }
    }
  }

  // Step 2: Check if the tool declares itself read-only for this input
  const toolDef = context.tools.find((t) => t.name === toolName)
  if (toolDef?.isReadOnly?.(input)) {
    return { behavior: 'allow' }
  }

  // Step 3: bypassPermissions mode → allow everything
  const restrictions = getModeRestrictions(context.permissionMode)
  if (context.permissionMode === 'bypassPermissions') {
    return { behavior: 'allow' }
  }

  // Step 4: Check allow rules
  for (const rule of allRules) {
    if (rule.behavior === 'allow' && matchRule(toolName, input, rule)) {
      return { behavior: 'allow' }
    }
  }

  // Step 5: acceptEdits mode → allow file operations
  if (context.permissionMode === 'acceptEdits') {
    if (restrictions.allowWrites) {
      return { behavior: 'allow' }
    }
  }

  // Step 6: plan mode → deny writes
  if (context.permissionMode === 'plan') {
    if (!restrictions.allowWrites) {
      return {
        behavior: 'deny',
        message: 'Write operations are not allowed in plan mode.',
      }
    }
  }

  // Step 7: Bash tool — check if command is read-only
  if (toolName === 'Bash' || toolName === 'bash') {
    const command =
      typeof input.command === 'string'
        ? input.command
        : typeof input.cmd === 'string'
          ? input.cmd
          : ''
    if (command && isReadOnlyCommand(command)) {
      return { behavior: 'allow' }
    }
  }

  // Step 8: Default — ask user
  return {
    behavior: 'ask',
    message: `Tool "${toolName}" requires permission.`,
  }
}
