import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  initializeSkills,
  getLoadedSkills,
  resetSkills,
  formatSkillListing,
  skillToolDef,
} from '../../src/skills/skill-tool'
import type { SkillDefinition } from '../../src/skills/types'
import type { ToolContext } from '../../src/core/types'

// Mock the loader to avoid filesystem access
vi.mock('../../src/skills/loader.js', () => ({
  loadAllSkills: vi.fn().mockResolvedValue([]),
  parseFrontmatter: vi.fn(),
  parseSkillFile: vi.fn(),
}))

// Import the mocked loader so we can control its behavior
import { loadAllSkills } from '../../src/skills/loader'
const mockLoadAllSkills = vi.mocked(loadAllSkills)

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'test-skill',
    description: 'A test skill',
    userInvocable: true,
    context: 'inline',
    getPrompt: async (args: string) => `Expanded prompt: ${args}`,
    ...overrides,
  }
}

function makeToolContext(): ToolContext {
  return {
    cwd: '/tmp/test',
    readFileState: {
      get: () => undefined,
      set: () => {},
      has: () => false,
      delete: () => {},
      keys: function* () {},
      clone: () => makeToolContext().readFileState,
      merge: () => {},
      size: 0,
    },
    fileHistory: {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    },
    modifiedFiles: new Set(),
    sessionId: 'test-session',
    permissionMode: 'default',
    onPermissionRequest: async () => ({ behavior: 'allow' as const }),
  }
}

describe('Skill Tool', () => {
  beforeEach(() => {
    resetSkills()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------
  // initializeSkills
  // -------------------------------------------------------------------
  describe('initializeSkills', () => {
    it('loads skills from cwd', async () => {
      const skills = [makeSkill({ name: 'loaded-skill' })]
      mockLoadAllSkills.mockResolvedValueOnce(skills)
      await initializeSkills('/tmp/test')
      expect(mockLoadAllSkills).toHaveBeenCalledWith('/tmp/test')
      expect(getLoadedSkills()).toHaveLength(1)
      expect(getLoadedSkills()[0]!.name).toBe('loaded-skill')
    })
  })

  // -------------------------------------------------------------------
  // Skill lookup: case-insensitive
  // -------------------------------------------------------------------
  describe('skill lookup', () => {
    it('finds skill case-insensitively', async () => {
      const skills = [makeSkill({ name: 'MySkill' })]
      mockLoadAllSkills.mockResolvedValueOnce(skills)
      await initializeSkills('/tmp/test')

      const result = await skillToolDef.call(
        { skill: 'myskill', args: 'test' },
        makeToolContext(),
      )
      expect(result.isError).toBeFalsy()
      expect(result.result).toContain('Expanded prompt')
    })

    it('finds skill with leading slash', async () => {
      const skills = [makeSkill({ name: 'my-skill' })]
      mockLoadAllSkills.mockResolvedValueOnce(skills)
      await initializeSkills('/tmp/test')

      const result = await skillToolDef.call(
        { skill: '/my-skill', args: 'hello' },
        makeToolContext(),
      )
      expect(result.isError).toBeFalsy()
      expect(result.result).toContain('Expanded prompt')
    })

    it('finds skill without leading slash', async () => {
      const skills = [makeSkill({ name: 'my-skill' })]
      mockLoadAllSkills.mockResolvedValueOnce(skills)
      await initializeSkills('/tmp/test')

      const result = await skillToolDef.call(
        { skill: 'my-skill', args: 'hello' },
        makeToolContext(),
      )
      expect(result.isError).toBeFalsy()
    })
  })

  // -------------------------------------------------------------------
  // Skill not found
  // -------------------------------------------------------------------
  describe('skill not found', () => {
    it('returns error with listing when skill not found', async () => {
      const skills = [
        makeSkill({ name: 'alpha', description: 'Alpha skill' }),
        makeSkill({ name: 'beta', description: 'Beta skill' }),
      ]
      mockLoadAllSkills.mockResolvedValueOnce(skills)
      await initializeSkills('/tmp/test')

      const result = await skillToolDef.call(
        { skill: 'nonexistent', args: '' },
        makeToolContext(),
      )
      expect(result.isError).toBe(true)
      expect(result.result).toContain('not found')
      expect(result.result).toContain('alpha')
      expect(result.result).toContain('beta')
    })

    it('returns appropriate message when no skills loaded', async () => {
      mockLoadAllSkills.mockResolvedValueOnce([])
      await initializeSkills('/tmp/test')

      const result = await skillToolDef.call(
        { skill: 'missing', args: '' },
        makeToolContext(),
      )
      expect(result.isError).toBe(true)
      expect(result.result).toContain('No skills are currently loaded')
    })
  })

  // -------------------------------------------------------------------
  // Inline execution
  // -------------------------------------------------------------------
  describe('inline execution', () => {
    it('returns expanded prompt', async () => {
      const skills = [
        makeSkill({
          name: 'greet',
          context: 'inline',
          getPrompt: async (args) => `Hello, ${args}!`,
        }),
      ]
      mockLoadAllSkills.mockResolvedValueOnce(skills)
      await initializeSkills('/tmp/test')

      const result = await skillToolDef.call(
        { skill: 'greet', args: 'world' },
        makeToolContext(),
      )
      expect(result.isError).toBeFalsy()
      expect(result.result).toBe('Hello, world!')
    })
  })

  // -------------------------------------------------------------------
  // Robust input parsing: { name, args }
  // -------------------------------------------------------------------
  describe('robust input parsing', () => {
    it('handles { name, args } format', async () => {
      const skills = [makeSkill({ name: 'test-skill' })]
      mockLoadAllSkills.mockResolvedValueOnce(skills)
      await initializeSkills('/tmp/test')

      // The tool accepts `skill` field, but also falls back to `name`
      const anyInput = { name: 'test-skill', args: 'data' } as any
      const result = await skillToolDef.call(anyInput, makeToolContext())
      expect(result.isError).toBeFalsy()
      expect(result.result).toContain('Expanded prompt')
    })

    it('returns error when skill name is empty', async () => {
      mockLoadAllSkills.mockResolvedValueOnce([])
      await initializeSkills('/tmp/test')

      const result = await skillToolDef.call(
        { skill: '', args: '' },
        makeToolContext(),
      )
      expect(result.isError).toBe(true)
      expect(result.result).toContain('skill name is required')
    })
  })

  // -------------------------------------------------------------------
  // formatSkillListing
  // -------------------------------------------------------------------
  describe('formatSkillListing', () => {
    it('returns empty string for no skills', () => {
      expect(formatSkillListing([])).toBe('')
    })

    it('lists skills with descriptions', () => {
      const skills = [
        makeSkill({ name: 'alpha', description: 'Alpha desc' }),
        makeSkill({ name: 'beta', description: 'Beta desc', whenToUse: 'For testing' }),
      ]
      const listing = formatSkillListing(skills)
      expect(listing).toContain('alpha: Alpha desc')
      expect(listing).toContain('beta: Beta desc')
      expect(listing).toContain('When to use: For testing')
    })
  })
})
