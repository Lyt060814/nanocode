import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeToolsCollect, executeTools } from '../../src/core/streaming-executor'
import type { Tool, ToolUseBlock, ToolContext, ToolResult, StreamEvent } from '../../src/core/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    description: '',
    inputSchema: {} as any,
    call: vi.fn(async () => ({ result: `result-${overrides.name}`, isError: false })),
    prompt: () => '',
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    maxResultSizeChars: 30_000,
    userFacingName: () => overrides.name,
    ...overrides,
  }
}

function makeBlock(name: string, id?: string): ToolUseBlock {
  return {
    type: 'tool_use',
    id: id ?? `id-${name}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    input: {},
  }
}

function makeContext(): ToolContext {
  return {
    cwd: '/tmp',
    readFileState: {
      get: () => undefined,
      set: () => {},
      has: () => false,
      delete: () => {},
      keys: function* () {},
      clone: () => makeContext().readFileState,
      merge: () => {},
      size: 0,
    },
    fileHistory: { snapshots: [], trackedFiles: new Set(), snapshotSequence: 0 },
    modifiedFiles: new Set(),
    sessionId: 'test-session',
    permissionMode: 'bypassPermissions',
    onPermissionRequest: async () => ({ behavior: 'allow' as const }),
  }
}

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const e of gen) events.push(e)
  return events
}

// ---------------------------------------------------------------------------
// Partition logic (tested via executeToolsCollect behavior)
// ---------------------------------------------------------------------------

describe('executeTools — partition logic', () => {
  it('groups consecutive safe tools into one parallel batch', async () => {
    const callOrder: string[] = []
    const toolA = makeTool({
      name: 'A',
      isConcurrencySafe: () => true,
      call: async () => {
        callOrder.push('A')
        return { result: 'A', isError: false }
      },
    })
    const toolB = makeTool({
      name: 'B',
      isConcurrencySafe: () => true,
      call: async () => {
        callOrder.push('B')
        return { result: 'B', isError: false }
      },
    })

    const blocks = [makeBlock('A', 'a1'), makeBlock('B', 'b1')]
    const results = await executeToolsCollect(blocks, [toolA, toolB], makeContext())

    expect(results).toHaveLength(2)
    expect(results[0]!.toolName).toBe('A')
    expect(results[1]!.toolName).toBe('B')
  })

  it('gives each unsafe tool its own serial batch', async () => {
    const callOrder: string[] = []
    const unsafeA = makeTool({
      name: 'UA',
      isConcurrencySafe: () => false,
      call: async () => {
        callOrder.push('UA')
        return { result: 'UA', isError: false }
      },
    })
    const unsafeB = makeTool({
      name: 'UB',
      isConcurrencySafe: () => false,
      call: async () => {
        callOrder.push('UB')
        return { result: 'UB', isError: false }
      },
    })

    const blocks = [makeBlock('UA', 'ua1'), makeBlock('UB', 'ub1')]
    const results = await executeToolsCollect(blocks, [unsafeA, unsafeB], makeContext())

    expect(results).toHaveLength(2)
    // Serial means UA finishes before UB starts
    expect(callOrder).toEqual(['UA', 'UB'])
  })

  it('interleaves safe and unsafe batches correctly', async () => {
    const callOrder: string[] = []
    const safe1 = makeTool({
      name: 'S1',
      isConcurrencySafe: () => true,
      call: async () => { callOrder.push('S1'); return { result: 'S1', isError: false } },
    })
    const safe2 = makeTool({
      name: 'S2',
      isConcurrencySafe: () => true,
      call: async () => { callOrder.push('S2'); return { result: 'S2', isError: false } },
    })
    const unsafe = makeTool({
      name: 'U',
      isConcurrencySafe: () => false,
      call: async () => { callOrder.push('U'); return { result: 'U', isError: false } },
    })
    const safe3 = makeTool({
      name: 'S3',
      isConcurrencySafe: () => true,
      call: async () => { callOrder.push('S3'); return { result: 'S3', isError: false } },
    })

    // Order: S1, S2, U, S3
    const blocks = [
      makeBlock('S1', 's1'), makeBlock('S2', 's2'),
      makeBlock('U', 'u1'), makeBlock('S3', 's3'),
    ]
    const results = await executeToolsCollect(blocks, [safe1, safe2, unsafe, safe3], makeContext())

    expect(results).toHaveLength(4)
    // Unsafe must run after S1/S2 batch and before S3 batch
    const uIdx = callOrder.indexOf('U')
    const s3Idx = callOrder.indexOf('S3')
    expect(uIdx).toBeLessThan(s3Idx)
  })
})

// ---------------------------------------------------------------------------
// Execution behavior
// ---------------------------------------------------------------------------

describe('executeTools — execution', () => {
  it('safe tools run concurrently (parallel)', async () => {
    let concurrency = 0
    let maxConcurrency = 0

    const makeConcurrentTool = (name: string): Tool =>
      makeTool({
        name,
        isConcurrencySafe: () => true,
        call: async () => {
          concurrency++
          maxConcurrency = Math.max(maxConcurrency, concurrency)
          // Simulate async work
          await new Promise((r) => setTimeout(r, 10))
          concurrency--
          return { result: name, isError: false }
        },
      })

    const tools = ['T1', 'T2', 'T3'].map(makeConcurrentTool)
    const blocks = tools.map((t) => makeBlock(t.name))
    await executeToolsCollect(blocks, tools, makeContext())

    expect(maxConcurrency).toBeGreaterThan(1)
  })

  it('results returned in original order regardless of completion order', async () => {
    // T1 is slow, T2 is fast — both safe (parallel). Results should still be T1, T2 order.
    const slowTool = makeTool({
      name: 'Slow',
      isConcurrencySafe: () => true,
      call: async () => {
        await new Promise((r) => setTimeout(r, 50))
        return { result: 'slow-result', isError: false }
      },
    })
    const fastTool = makeTool({
      name: 'Fast',
      isConcurrencySafe: () => true,
      call: async () => {
        return { result: 'fast-result', isError: false }
      },
    })

    const blocks = [makeBlock('Slow', 'slow-id'), makeBlock('Fast', 'fast-id')]
    const results = await executeToolsCollect(blocks, [slowTool, fastTool], makeContext())

    expect(results[0]!.toolName).toBe('Slow')
    expect(results[0]!.result.result).toBe('slow-result')
    expect(results[1]!.toolName).toBe('Fast')
    expect(results[1]!.result.result).toBe('fast-result')
  })
})

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('executeTools — error handling', () => {
  it('tool errors do not crash the executor', async () => {
    const badTool = makeTool({
      name: 'Bad',
      isConcurrencySafe: () => false,
      call: async () => {
        throw new Error('tool exploded')
      },
    })
    const goodTool = makeTool({
      name: 'Good',
      isConcurrencySafe: () => false,
      call: async () => ({ result: 'ok', isError: false }),
    })

    const blocks = [makeBlock('Bad', 'bad1'), makeBlock('Good', 'good1')]
    const results = await executeToolsCollect(blocks, [badTool, goodTool], makeContext())

    expect(results).toHaveLength(2)
    expect(results[0]!.result.isError).toBe(true)
    expect(results[0]!.result.result).toContain('tool exploded')
    expect(results[1]!.result.isError).toBe(false)
    expect(results[1]!.result.result).toBe('ok')
  })

  it('error in one parallel tool does not block others', async () => {
    const badTool = makeTool({
      name: 'BadP',
      isConcurrencySafe: () => true,
      call: async () => { throw new Error('parallel fail') },
    })
    const goodTool = makeTool({
      name: 'GoodP',
      isConcurrencySafe: () => true,
      call: async () => ({ result: 'ok', isError: false }),
    })

    const blocks = [makeBlock('BadP', 'bp'), makeBlock('GoodP', 'gp')]
    const results = await executeToolsCollect(blocks, [badTool, goodTool], makeContext())

    expect(results).toHaveLength(2)
    expect(results[0]!.result.isError).toBe(true)
    expect(results[1]!.result.isError).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Unknown tools
// ---------------------------------------------------------------------------

describe('executeTools — unknown tools', () => {
  it('returns error result for unknown tool names', async () => {
    const blocks = [makeBlock('NonExistent', 'ne1')]
    const results = await executeToolsCollect(blocks, [], makeContext())

    expect(results).toHaveLength(1)
    expect(results[0]!.result.isError).toBe(true)
    expect(results[0]!.result.result).toContain('Unknown tool: NonExistent')
  })

  it('unknown tool does not block other tools', async () => {
    const goodTool = makeTool({
      name: 'Real',
      isConcurrencySafe: () => false,
      call: async () => ({ result: 'real-result', isError: false }),
    })

    const blocks = [makeBlock('Missing', 'm1'), makeBlock('Real', 'r1')]
    const results = await executeToolsCollect(blocks, [goodTool], makeContext())

    expect(results).toHaveLength(2)
    expect(results[0]!.result.isError).toBe(true)
    expect(results[1]!.result.result).toBe('real-result')
  })
})

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

describe('executeTools — stream events', () => {
  it('yields tool_start and tool_result events', async () => {
    const tool = makeTool({
      name: 'Echo',
      isConcurrencySafe: () => false,
      call: async () => ({ result: 'hello', isError: false }),
    })
    const blocks = [makeBlock('Echo', 'echo1')]
    const events = await collectEvents(executeTools(blocks, [tool], makeContext()))

    const starts = events.filter((e) => e.type === 'tool_start')
    const results = events.filter((e) => e.type === 'tool_result')

    expect(starts).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect((starts[0] as any).toolName).toBe('Echo')
    expect((results[0] as any).toolName).toBe('Echo')
    expect((results[0] as any).result).toBe('hello')
  })

  it('yields events in batch order', async () => {
    const safe = makeTool({
      name: 'S',
      isConcurrencySafe: () => true,
      call: async () => ({ result: 's', isError: false }),
    })
    const unsafe = makeTool({
      name: 'U',
      isConcurrencySafe: () => false,
      call: async () => ({ result: 'u', isError: false }),
    })

    const blocks = [makeBlock('S', 's1'), makeBlock('U', 'u1')]
    const events = await collectEvents(executeTools(blocks, [safe, unsafe], makeContext()))
    const resultEvents = events.filter((e) => e.type === 'tool_result')

    expect(resultEvents).toHaveLength(2)
    expect((resultEvents[0] as any).toolName).toBe('S')
    expect((resultEvents[1] as any).toolName).toBe('U')
  })
})

// ---------------------------------------------------------------------------
// Result truncation
// ---------------------------------------------------------------------------

describe('executeTools — result truncation', () => {
  it('truncates oversized results', async () => {
    const bigResult = 'x'.repeat(100)
    const tool = makeTool({
      name: 'Big',
      isConcurrencySafe: () => false,
      maxResultSizeChars: 50,
      call: async () => ({ result: bigResult, isError: false }),
    })

    const blocks = [makeBlock('Big', 'big1')]
    const results = await executeToolsCollect(blocks, [tool], makeContext())

    expect(results[0]!.result.result).toContain('[Output truncated')
    expect(results[0]!.result.result.length).toBeLessThan(bigResult.length + 100)
  })
})
