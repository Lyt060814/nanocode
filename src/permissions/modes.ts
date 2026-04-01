/**
 * nanocode — Permission Mode Utilities
 *
 * Human-readable descriptions and restriction metadata for each
 * permission mode.
 */

import type { PermissionMode } from '../core/types.js'

// ---------------------------------------------------------------------------
// Mode descriptions
// ---------------------------------------------------------------------------

const MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: 'Default mode — asks for permission on write operations and shell commands.',
  plan: 'Plan mode — read-only, no writes or shell mutations allowed.',
  acceptEdits: 'Accept-edits mode — file writes are auto-approved, shell commands still require approval.',
  bypassPermissions: 'Bypass mode — all operations are auto-approved without user confirmation.',
}

/**
 * Get a human-readable description for a permission mode.
 */
export function getModeDescription(mode: PermissionMode): string {
  return MODE_DESCRIPTIONS[mode] ?? `Unknown mode: ${mode}`
}

// ---------------------------------------------------------------------------
// Mode restrictions
// ---------------------------------------------------------------------------

export interface ModeRestrictions {
  allowReads: boolean
  allowWrites: boolean
  allowBash: boolean
}

const MODE_RESTRICTIONS: Record<PermissionMode, ModeRestrictions> = {
  default: { allowReads: true, allowWrites: false, allowBash: false },
  plan: { allowReads: true, allowWrites: false, allowBash: false },
  acceptEdits: { allowReads: true, allowWrites: true, allowBash: false },
  bypassPermissions: { allowReads: true, allowWrites: true, allowBash: true },
}

/**
 * Get the restriction flags for a permission mode.
 *
 * - allowReads:  Whether read operations are permitted without asking
 * - allowWrites: Whether write operations are permitted without asking
 * - allowBash:   Whether shell commands are permitted without asking
 */
export function getModeRestrictions(mode: PermissionMode): ModeRestrictions {
  return MODE_RESTRICTIONS[mode] ?? MODE_RESTRICTIONS.default
}
