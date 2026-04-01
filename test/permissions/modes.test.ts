import { describe, it, expect } from 'vitest'
import { getModeDescription, getModeRestrictions } from '../../src/permissions/modes'
import type { PermissionMode } from '../../src/core/types'

const ALL_MODES: PermissionMode[] = ['default', 'plan', 'acceptEdits', 'bypassPermissions']

describe('Permission Modes', () => {
  // -------------------------------------------------------------------
  // getModeDescription
  // -------------------------------------------------------------------
  describe('getModeDescription', () => {
    it('returns a description for every known mode', () => {
      for (const mode of ALL_MODES) {
        const desc = getModeDescription(mode)
        expect(typeof desc).toBe('string')
        expect(desc.length).toBeGreaterThan(0)
      }
    })

    it('default mode mentions "asks for permission"', () => {
      expect(getModeDescription('default')).toContain('asks for permission')
    })

    it('plan mode mentions "read-only"', () => {
      expect(getModeDescription('plan')).toContain('read-only')
    })

    it('acceptEdits mode mentions "auto-approved"', () => {
      expect(getModeDescription('acceptEdits')).toContain('auto-approved')
    })

    it('bypassPermissions mode mentions "auto-approved"', () => {
      expect(getModeDescription('bypassPermissions')).toContain('auto-approved')
    })

    it('returns fallback for unknown mode', () => {
      const desc = getModeDescription('nonexistent' as PermissionMode)
      expect(desc).toContain('Unknown mode')
    })
  })

  // -------------------------------------------------------------------
  // getModeRestrictions
  // -------------------------------------------------------------------
  describe('getModeRestrictions', () => {
    it('bypassPermissions allows reads, writes, and bash', () => {
      const r = getModeRestrictions('bypassPermissions')
      expect(r.allowReads).toBe(true)
      expect(r.allowWrites).toBe(true)
      expect(r.allowBash).toBe(true)
    })

    it('plan allows reads but denies writes and bash', () => {
      const r = getModeRestrictions('plan')
      expect(r.allowReads).toBe(true)
      expect(r.allowWrites).toBe(false)
      expect(r.allowBash).toBe(false)
    })

    it('acceptEdits allows reads and writes but denies bash', () => {
      const r = getModeRestrictions('acceptEdits')
      expect(r.allowReads).toBe(true)
      expect(r.allowWrites).toBe(true)
      expect(r.allowBash).toBe(false)
    })

    it('default allows reads but denies writes and bash', () => {
      const r = getModeRestrictions('default')
      expect(r.allowReads).toBe(true)
      expect(r.allowWrites).toBe(false)
      expect(r.allowBash).toBe(false)
    })

    it('unknown mode falls back to default restrictions', () => {
      const r = getModeRestrictions('nonexistent' as PermissionMode)
      expect(r.allowReads).toBe(true)
      expect(r.allowWrites).toBe(false)
      expect(r.allowBash).toBe(false)
    })
  })
})
