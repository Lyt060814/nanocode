import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  checkPermission,
  addSessionRule,
  getSessionRules,
  clearSessionRules,
  type PermissionContext,
} from '../../src/permissions/engine'

// Mock the rules module so checkPermission doesn't read from disk
vi.mock('../../src/permissions/rules.js', () => ({
  loadProjectRules: vi.fn().mockResolvedValue([]),
  loadUserRules: vi.fn().mockResolvedValue([]),
  matchRule: vi.fn((toolName: string, input: Record<string, unknown>, rule: any) => {
    // Simple matching: tool name must match
    if (rule.tool !== toolName && rule.tool !== '*') return false
    if (rule.content) {
      // Check if any string value in input contains the content pattern
      const vals = Object.values(input).filter((v) => typeof v === 'string') as string[]
      return vals.some((v) => v.includes(rule.content))
    }
    return true
  }),
}))

function makeContext(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    cwd: '/tmp/test-project',
    permissionMode: 'default',
    tools: [],
    ...overrides,
  }
}

describe('Permission Engine', () => {
  beforeEach(() => {
    clearSessionRules()
  })

  // -------------------------------------------------------------------
  // bypassPermissions mode
  // -------------------------------------------------------------------
  describe('bypassPermissions mode', () => {
    it('allows any tool invocation', async () => {
      const ctx = makeContext({ permissionMode: 'bypassPermissions' })
      const result = await checkPermission('Write', { file_path: '/etc/passwd' }, ctx)
      expect(result.behavior).toBe('allow')
    })

    it('allows shell commands without asking', async () => {
      const ctx = makeContext({ permissionMode: 'bypassPermissions' })
      const result = await checkPermission('Bash', { command: 'rm -rf /' }, ctx)
      expect(result.behavior).toBe('allow')
    })
  })

  // -------------------------------------------------------------------
  // plan mode
  // -------------------------------------------------------------------
  describe('plan mode', () => {
    it('denies write tools', async () => {
      const ctx = makeContext({ permissionMode: 'plan' })
      const result = await checkPermission('Write', { file_path: 'foo.ts' }, ctx)
      expect(result.behavior).toBe('deny')
      expect(result.message).toContain('plan mode')
    })

    it('denies Bash commands (non-read-only)', async () => {
      const ctx = makeContext({ permissionMode: 'plan' })
      const result = await checkPermission('Bash', { command: 'npm install' }, ctx)
      expect(result.behavior).toBe('deny')
    })

    it('allows read-only tools via isReadOnly', async () => {
      const ctx = makeContext({
        permissionMode: 'plan',
        tools: [{ name: 'Read', isReadOnly: () => true }],
      })
      const result = await checkPermission('Read', { file_path: 'foo.ts' }, ctx)
      expect(result.behavior).toBe('allow')
    })
  })

  // -------------------------------------------------------------------
  // acceptEdits mode
  // -------------------------------------------------------------------
  describe('acceptEdits mode', () => {
    it('allows file write tools', async () => {
      const ctx = makeContext({ permissionMode: 'acceptEdits' })
      const result = await checkPermission('Write', { file_path: 'foo.ts' }, ctx)
      expect(result.behavior).toBe('allow')
    })

    it('allows Edit tool', async () => {
      const ctx = makeContext({ permissionMode: 'acceptEdits' })
      const result = await checkPermission('Edit', { file_path: 'bar.ts', old: 'a', new: 'b' }, ctx)
      expect(result.behavior).toBe('allow')
    })
  })

  // -------------------------------------------------------------------
  // default mode — ask for non-readonly
  // -------------------------------------------------------------------
  describe('default mode', () => {
    it('asks for permission on write tools', async () => {
      const ctx = makeContext({ permissionMode: 'default' })
      const result = await checkPermission('Write', { file_path: 'foo.ts' }, ctx)
      expect(result.behavior).toBe('ask')
      expect(result.message).toContain('requires permission')
    })

    it('allows read-only Bash commands (ls, cat, etc.)', async () => {
      const ctx = makeContext({ permissionMode: 'default' })
      const lsResult = await checkPermission('Bash', { command: 'ls -la' }, ctx)
      expect(lsResult.behavior).toBe('allow')

      const catResult = await checkPermission('Bash', { command: 'cat foo.ts' }, ctx)
      expect(catResult.behavior).toBe('allow')

      const gitResult = await checkPermission('Bash', { command: 'git status' }, ctx)
      expect(gitResult.behavior).toBe('allow')
    })

    it('asks for non-readonly Bash commands', async () => {
      const ctx = makeContext({ permissionMode: 'default' })
      const result = await checkPermission('Bash', { command: 'rm -rf /' }, ctx)
      expect(result.behavior).toBe('ask')
    })
  })

  // -------------------------------------------------------------------
  // Read-only tools auto-allowed
  // -------------------------------------------------------------------
  describe('read-only tools', () => {
    it('auto-allows tools whose isReadOnly returns true', async () => {
      const ctx = makeContext({
        permissionMode: 'default',
        tools: [{ name: 'Glob', isReadOnly: () => true }],
      })
      const result = await checkPermission('Glob', { pattern: '*.ts' }, ctx)
      expect(result.behavior).toBe('allow')
    })

    it('does not auto-allow when isReadOnly returns false', async () => {
      const ctx = makeContext({
        permissionMode: 'default',
        tools: [{ name: 'CustomTool', isReadOnly: () => false }],
      })
      const result = await checkPermission('CustomTool', {}, ctx)
      expect(result.behavior).toBe('ask')
    })
  })

  // -------------------------------------------------------------------
  // Deny rules take priority
  // -------------------------------------------------------------------
  describe('deny rules priority', () => {
    it('deny session rule blocks even in bypassPermissions (checked first)', async () => {
      addSessionRule({ tool: 'Bash', behavior: 'deny', source: 'session' })
      const ctx = makeContext({ permissionMode: 'bypassPermissions' })
      const result = await checkPermission('Bash', { command: 'echo hi' }, ctx)
      expect(result.behavior).toBe('deny')
    })
  })

  // -------------------------------------------------------------------
  // Allow rules match
  // -------------------------------------------------------------------
  describe('allow rules', () => {
    it('allow session rule permits a tool in default mode', async () => {
      addSessionRule({ tool: 'Write', behavior: 'allow', source: 'session' })
      const ctx = makeContext({ permissionMode: 'default' })
      const result = await checkPermission('Write', { file_path: 'foo.ts' }, ctx)
      expect(result.behavior).toBe('allow')
    })
  })

  // -------------------------------------------------------------------
  // Session rules API
  // -------------------------------------------------------------------
  describe('session rules', () => {
    it('addSessionRule and getSessionRules work', () => {
      expect(getSessionRules()).toHaveLength(0)
      addSessionRule({ tool: 'X', behavior: 'allow', source: 'session' })
      addSessionRule({ tool: 'Y', behavior: 'deny', source: 'session' })
      expect(getSessionRules()).toHaveLength(2)
    })

    it('getSessionRules returns a copy', () => {
      addSessionRule({ tool: 'X', behavior: 'allow', source: 'session' })
      const rules = getSessionRules()
      rules.push({ tool: 'Z', behavior: 'deny', source: 'session' })
      expect(getSessionRules()).toHaveLength(1)
    })

    it('clearSessionRules resets state', () => {
      addSessionRule({ tool: 'X', behavior: 'allow', source: 'session' })
      clearSessionRules()
      expect(getSessionRules()).toHaveLength(0)
    })
  })
})
