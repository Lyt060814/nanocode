/**
 * nanocode Streaming Tool Executor
 *
 * Partitions tool calls into concurrent-safe (parallel) and serial batches.
 * Key patterns from Claude Code: StreamingToolExecutor.ts, toolOrchestration.ts
 *
 * Critical performance feature:
 * - Read-only tools (Glob, Grep, Read, safe Bash) run in parallel
 * - Write tools (Edit, Write, unsafe Bash) run serially
 * - Reduces latency 30-50% on multi-tool turns
 */

import type {
  Tool,
  ToolUseBlock,
  ToolResult,
  ToolContext,
  StreamEvent,
} from './types.js'
import { ToolExecutionError } from './errors.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY = 10

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ToolStatus = 'queued' | 'executing' | 'completed' | 'errored'

interface QueuedTool {
  block: ToolUseBlock
  tool: Tool
  status: ToolStatus
  result?: ToolResult
  isSafe: boolean
}

export interface ExecutionResult {
  toolUseId: string
  toolName: string
  result: ToolResult
}

// ---------------------------------------------------------------------------
// Partition Logic
// ---------------------------------------------------------------------------

interface ToolBatch {
  isConcurrencySafe: boolean
  items: QueuedTool[]
}

/**
 * Partition consecutive tool calls into batches.
 * Consecutive concurrent-safe tools → one parallel batch.
 * Each non-safe tool → its own serial batch.
 */
function partitionToolCalls(items: QueuedTool[]): ToolBatch[] {
  const batches: ToolBatch[] = []
  let currentSafeBatch: QueuedTool[] = []

  for (const item of items) {
    if (item.isSafe) {
      currentSafeBatch.push(item)
    } else {
      // Flush any accumulated safe batch
      if (currentSafeBatch.length > 0) {
        batches.push({ isConcurrencySafe: true, items: currentSafeBatch })
        currentSafeBatch = []
      }
      // Serial batch for this unsafe tool
      batches.push({ isConcurrencySafe: false, items: [item] })
    }
  }

  // Flush remaining safe batch
  if (currentSafeBatch.length > 0) {
    batches.push({ isConcurrencySafe: true, items: currentSafeBatch })
  }

  return batches
}

// ---------------------------------------------------------------------------
// Single Tool Execution
// ---------------------------------------------------------------------------

async function executeSingleTool(
  item: QueuedTool,
  context: ToolContext,
): Promise<ToolResult> {
  item.status = 'executing'

  try {
    const result = await item.tool.call(item.block.input, context)

    // Truncate oversized results
    if (result.result.length > item.tool.maxResultSizeChars) {
      result.result =
        result.result.slice(0, item.tool.maxResultSizeChars) +
        `\n\n[Output truncated: was ${result.result.length} chars, limit ${item.tool.maxResultSizeChars}]`
    }

    item.status = 'completed'
    item.result = result
    return result
  } catch (err) {
    item.status = 'errored'
    const message =
      err instanceof Error ? err.message : String(err)
    const result: ToolResult = {
      result: `Error executing ${item.block.name}: ${message}`,
      isError: true,
    }
    item.result = result
    return result
  }
}

// ---------------------------------------------------------------------------
// Batch Execution
// ---------------------------------------------------------------------------

async function* executeBatch(
  batch: ToolBatch,
  context: ToolContext,
): AsyncGenerator<StreamEvent> {
  if (batch.isConcurrencySafe) {
    // Parallel execution with concurrency limit
    const items = batch.items
    const executing: Promise<{ item: QueuedTool; result: ToolResult }>[] = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!

      // Yield tool_start
      yield {
        type: 'tool_start',
        toolUseId: item.block.id,
        toolName: item.block.name,
        input: item.block.input,
      }

      const promise = executeSingleTool(item, context).then((result) => ({
        item,
        result,
      }))
      executing.push(promise)

      // If we've hit concurrency limit, wait for one to finish
      if (executing.length >= MAX_CONCURRENCY) {
        const completed = await Promise.race(executing)
        executing.splice(executing.indexOf(
          executing.find((p) => p === Promise.resolve(completed)) || executing[0]!
        ), 1)
      }
    }

    // Wait for all remaining
    const results = await Promise.all(executing)

    // Yield results in original order
    for (const item of items) {
      yield {
        type: 'tool_result',
        toolUseId: item.block.id,
        toolName: item.block.name,
        result: item.result!.result,
        isError: item.result!.isError || false,
      }
    }
  } else {
    // Serial execution (one tool)
    const item = batch.items[0]!

    yield {
      type: 'tool_start',
      toolUseId: item.block.id,
      toolName: item.block.name,
      input: item.block.input,
    }

    await executeSingleTool(item, context)

    yield {
      type: 'tool_result',
      toolUseId: item.block.id,
      toolName: item.block.name,
      result: item.result!.result,
      isError: item.result!.isError || false,
    }
  }
}

// ---------------------------------------------------------------------------
// Main Executor
// ---------------------------------------------------------------------------

/**
 * Execute a set of tool use blocks with concurrent/serial partitioning.
 *
 * This is the core execution strategy:
 * 1. For each tool_use block, look up the Tool definition
 * 2. Check isConcurrencySafe for each
 * 3. Partition into batches
 * 4. Execute batches in order, with concurrent-safe batches running in parallel
 *
 * Yields StreamEvents for progress tracking.
 */
export async function* executeTools(
  toolUseBlocks: ToolUseBlock[],
  tools: Tool[],
  context: ToolContext,
): AsyncGenerator<StreamEvent> {
  const toolMap = new Map(tools.map((t) => [t.name, t]))

  // Build queue
  const queue: QueuedTool[] = toolUseBlocks.map((block) => {
    const tool = toolMap.get(block.name)
    if (!tool) {
      return {
        block,
        tool: createErrorTool(block.name),
        status: 'queued' as ToolStatus,
        isSafe: false,
      }
    }
    return {
      block,
      tool,
      status: 'queued' as ToolStatus,
      isSafe: tool.isConcurrencySafe(block.input),
    }
  })

  // Partition and execute
  const batches = partitionToolCalls(queue)
  for (const batch of batches) {
    yield* executeBatch(batch, context)
  }
}

/**
 * Collect all execution results (non-streaming convenience wrapper)
 */
export async function executeToolsCollect(
  toolUseBlocks: ToolUseBlock[],
  tools: Tool[],
  context: ToolContext,
): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = []

  for await (const event of executeTools(toolUseBlocks, tools, context)) {
    if (event.type === 'tool_result') {
      results.push({
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        result: {
          result: event.result,
          isError: event.isError,
        },
      })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createErrorTool(name: string): Tool {
  return {
    name,
    description: '',
    inputSchema: {} as any,
    call: async () => ({
      result: `Unknown tool: ${name}. Available tools will be listed in the system prompt.`,
      isError: true,
    }),
    prompt: () => '',
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    maxResultSizeChars: 30_000,
    userFacingName: () => name,
  }
}
