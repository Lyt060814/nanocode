import { describe, it, expect, beforeEach } from 'vitest'
import {
  buildTool,
  registerTool,
  registerToolDef,
  getAllTools,
  getToolByName,
  hasToolByName,
  getToolCount,
  resetRegistry,
} from '../../src/tools/registry'
import type { ToolDef, Tool } from '../../src/core/types'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolDef(overrides?: Partial<ToolDef>): ToolDef {
  return {
    name: overrides?.name ?? 'TestTool',
    description: overrides?.description ?? 'A test tool',
    inputSchema: overrides?.inputSchema ?? z.object({}),
    call: overrides?.call ?? (async () => ({ result: 'ok', isError: false })),
    ...overrides,
  }
}

beforeEach(() => {
  resetRegistry()
})

// ---------------------------------------------------------------------------
// buildTool — fail-closed defaults
// ---------------------------------------------------------------------------

describe('buildTool — fail-closed defaults', () => {
  it('defaults isConcurrencySafe to false', () => {
    const tool = buildTool(makeToolDef())
    expect(tool.isConcurrencySafe(undefined as any)).toBe(false)
  })

  it('defaults isReadOnly to false', () => {
    const tool = buildTool(makeToolDef())
    expect(tool.isReadOnly(undefined as any)).toBe(false)
  })

  it('defaults maxResultSizeChars to 30_000', () => {
    const tool = buildTool(makeToolDef())
    expect(tool.maxResultSizeChars).toBe(30_000)
  })

  it('defaults prompt to empty string', () => {
    const tool = buildTool(makeToolDef())
    expect(tool.prompt()).toBe('')
  })

  it('defaults userFacingName to tool name', () => {
    const tool = buildTool(makeToolDef({ name: 'MyTool' }))
    expect(tool.userFacingName(undefined as any)).toBe('MyTool')
  })
})

describe('buildTool — preserves explicit overrides', () => {
  it('preserves isConcurrencySafe: true', () => {
    const tool = buildTool(makeToolDef({ isConcurrencySafe: () => true }))
    expect(tool.isConcurrencySafe(undefined as any)).toBe(true)
  })

  it('preserves isReadOnly: true', () => {
    const tool = buildTool(makeToolDef({ isReadOnly: () => true }))
    expect(tool.isReadOnly(undefined as any)).toBe(true)
  })

  it('preserves custom maxResultSizeChars', () => {
    const tool = buildTool(makeToolDef({ maxResultSizeChars: 100_000 }))
    expect(tool.maxResultSizeChars).toBe(100_000)
  })

  it('preserves custom prompt', () => {
    const tool = buildTool(makeToolDef({ prompt: () => 'Custom prompt' }))
    expect(tool.prompt()).toBe('Custom prompt')
  })

  it('preserves custom userFacingName', () => {
    const tool = buildTool(
      makeToolDef({ userFacingName: (input: any) => `Custom: ${input?.file}` }),
    )
    expect(tool.userFacingName({ file: 'test.ts' } as any)).toBe('Custom: test.ts')
  })

  it('preserves name, description, inputSchema', () => {
    const schema = z.object({ path: z.string() })
    const tool = buildTool(makeToolDef({
      name: 'SpecialTool',
      description: 'Does something special',
      inputSchema: schema,
    }))
    expect(tool.name).toBe('SpecialTool')
    expect(tool.description).toBe('Does something special')
    expect(tool.inputSchema).toBe(schema)
  })

  it('binds call to the def', async () => {
    const callFn = async () => ({ result: 'bound', isError: false })
    const tool = buildTool(makeToolDef({ call: callFn }))
    const result = await tool.call({} as any, {} as any)
    expect(result.result).toBe('bound')
  })
})

// ---------------------------------------------------------------------------
// Registry — registerTool / registerToolDef
// ---------------------------------------------------------------------------

describe('Registry — registration', () => {
  it('registerTool adds tool to registry', () => {
    const tool = buildTool(makeToolDef({ name: 'RegTool' }))
    registerTool(tool as Tool)
    expect(getToolByName('RegTool')).toBe(tool)
  })

  it('registerToolDef wraps and registers', () => {
    const def = makeToolDef({ name: 'DefTool' })
    const tool = registerToolDef(def)
    expect(tool.name).toBe('DefTool')
    expect(getToolByName('DefTool')).toBe(tool)
  })

  it('registerTool overwrites existing tool with same name', () => {
    const tool1 = buildTool(makeToolDef({ name: 'Dup', description: 'first' }))
    const tool2 = buildTool(makeToolDef({ name: 'Dup', description: 'second' }))
    registerTool(tool1 as Tool)
    registerTool(tool2 as Tool)
    expect(getToolByName('Dup')?.description).toBe('second')
    expect(getToolCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Registry — queries
// ---------------------------------------------------------------------------

describe('Registry — queries', () => {
  it('getToolByName returns undefined for missing tool', () => {
    expect(getToolByName('NonExistent')).toBeUndefined()
  })

  it('hasToolByName returns correct boolean', () => {
    registerToolDef(makeToolDef({ name: 'Exists' }))
    expect(hasToolByName('Exists')).toBe(true)
    expect(hasToolByName('Missing')).toBe(false)
  })

  it('getAllTools returns all registered tools', () => {
    registerToolDef(makeToolDef({ name: 'A' }))
    registerToolDef(makeToolDef({ name: 'B' }))
    registerToolDef(makeToolDef({ name: 'C' }))

    const all = getAllTools()
    expect(all).toHaveLength(3)
    const names = all.map((t) => t.name).sort()
    expect(names).toEqual(['A', 'B', 'C'])
  })

  it('getToolCount returns correct count', () => {
    expect(getToolCount()).toBe(0)
    registerToolDef(makeToolDef({ name: 'X' }))
    expect(getToolCount()).toBe(1)
    registerToolDef(makeToolDef({ name: 'Y' }))
    expect(getToolCount()).toBe(2)
  })

  it('getAllTools returns empty array when nothing registered', () => {
    expect(getAllTools()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Registry — resetRegistry
// ---------------------------------------------------------------------------

describe('Registry — reset', () => {
  it('clears all tools', () => {
    registerToolDef(makeToolDef({ name: 'Temp1' }))
    registerToolDef(makeToolDef({ name: 'Temp2' }))
    expect(getToolCount()).toBe(2)

    resetRegistry()
    expect(getToolCount()).toBe(0)
    expect(getAllTools()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// initializeTools — skipped (requires real module imports)
// We test it indirectly: the function exists and is callable.
// A full integration test would need the complete tool modules available.
// ---------------------------------------------------------------------------

describe('initializeTools — smoke', () => {
  // We just verify the import exists; actually calling it would require
  // all tool modules to be resolvable. That's an integration test concern.
  it('is exported as a function', async () => {
    const mod = await import('../../src/tools/registry.js')
    expect(typeof mod.initializeTools).toBe('function')
  })
})
