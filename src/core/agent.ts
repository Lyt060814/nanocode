/**
 * nanocode Agent Loop
 *
 * THE critical file. Implements the core agent loop as an async generator.
 * Key patterns from Claude Code: query.ts:307-1729
 *
 * Architecture:
 *   while (true) {
 *     1. Auto-compact check
 *     2. Call Claude API (streaming)
 *     3. Collect tool_use blocks
 *     4. If no tools → done
 *     5. Check permissions for each tool
 *     6. Execute tools (concurrent/serial)
 *     7. Accumulate results
 *     8. Check maxTurns
 *   }
 */

import { randomUUID } from 'node:crypto'
import type {
  Message,
  StreamEvent,
  QueryParams,
  ToolUseBlock,
  ToolResult,
  ToolContext,
  ContentBlock,
  ToolResultBlock,
  TokenUsage,
} from './types.js'
import { callModel, getLastUsage, setLastUsage } from './api.js'
import { executeTools } from './streaming-executor.js'
import {
  PromptTooLongError,
  AbortError,
  classifyError,
} from './errors.js'

// ---------------------------------------------------------------------------
// Constants (from Claude Code)
// ---------------------------------------------------------------------------

const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const MAX_PTL_RETRIES = 3
const DEFAULT_MAX_TURNS = 200
const MICRO_COMPACT_THRESHOLD_CHARS = 50_000

// ---------------------------------------------------------------------------
// Token Estimation (inline for simplicity)
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.round(text.length / 4)
}

function estimateMessageTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          total += estimateTokens(block.text)
          break
        case 'tool_use':
          total += estimateTokens(
            block.name + JSON.stringify(block.input),
          )
          break
        case 'tool_result': {
          const content =
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content)
          total += estimateTokens(content)
          break
        }
        case 'thinking':
          total += estimateTokens(block.thinking)
          break
        case 'image':
          total += 2000 // Fixed estimate for images
          break
      }
    }
  }
  return total
}

// ---------------------------------------------------------------------------
// Auto-Compact Check
// ---------------------------------------------------------------------------

function shouldAutoCompact(
  messages: Message[],
  contextWindow: number,
  maxOutputTokens: number,
): boolean {
  const threshold = contextWindow - maxOutputTokens - AUTOCOMPACT_BUFFER_TOKENS
  const currentTokens = estimateMessageTokens(messages)
  return currentTokens > threshold
}

// ---------------------------------------------------------------------------
// Micro-Compact: Truncate old tool results
// ---------------------------------------------------------------------------

function microCompactMessages(messages: Message[]): void {
  // Only compact tool results older than the last 3 turns
  const recentTurnThreshold = Math.max(0, messages.length - 6) // ~3 turns = 6 messages
  for (let i = 0; i < recentTurnThreshold; i++) {
    const msg = messages[i]
    if (!msg || msg.role !== 'user') continue

    for (let j = 0; j < msg.content.length; j++) {
      const block = msg.content[j]
      if (!block || block.type !== 'tool_result') continue
      const content =
        typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content)
      if (content.length > MICRO_COMPACT_THRESHOLD_CHARS) {
        ;(msg.content[j] as any) = {
          ...block,
          content: content.slice(0, 5000) +
            `\n\n[Content truncated: was ${content.length} chars. Re-read the file if needed.]`,
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PTL Recovery: Truncate oldest message groups
// ---------------------------------------------------------------------------

function truncateForPTL(messages: Message[]): Message[] {
  if (messages.length <= 2) return messages

  // Find the oldest assistant-user pair after any compact boundary
  // Remove it to free space
  const truncated = [...messages]

  // Remove first 2 messages (oldest turn) but keep the very first if it's
  // a system/context message
  let removeCount = 0
  for (let i = 0; i < truncated.length && removeCount < 2; i++) {
    truncated.splice(i, 1)
    removeCount++
    i-- // Adjust after splice
  }

  return truncated
}

// ---------------------------------------------------------------------------
// Build Messages
// ---------------------------------------------------------------------------

function buildAssistantMessage(content: ContentBlock[]): Message {
  return {
    role: 'assistant',
    content,
    id: randomUUID(),
  }
}

function buildToolResultMessage(
  results: Array<{ toolUseId: string; result: ToolResult }>,
): Message {
  const content: ToolResultBlock[] = results.map(({ toolUseId, result }) => ({
    type: 'tool_result' as const,
    tool_use_id: toolUseId,
    content: result.result,
    is_error: result.isError,
  }))

  return {
    role: 'user',
    content,
    id: randomUUID(),
  }
}

// ---------------------------------------------------------------------------
// Permission Checking
// ---------------------------------------------------------------------------

async function checkToolPermission(
  toolUse: ToolUseBlock,
  params: QueryParams,
  toolContext: ToolContext,
): Promise<{ allowed: boolean; message?: string }> {
  const tool = params.tools.find((t) => t.name === toolUse.name)
  if (!tool) {
    return { allowed: true } // Unknown tools handled by executor
  }

  // Bypass mode: allow everything
  if (params.permissionMode === 'bypassPermissions') {
    return { allowed: true }
  }

  // Read-only tools are always allowed
  if (tool.isReadOnly(toolUse.input)) {
    return { allowed: true }
  }

  // Plan mode: deny write operations
  if (params.permissionMode === 'plan') {
    return {
      allowed: false,
      message: `Tool ${toolUse.name} is not allowed in plan mode (read-only).`,
    }
  }

  // Accept edits mode: allow file operations
  if (params.permissionMode === 'acceptEdits') {
    const fileTools = ['Edit', 'Write', 'NotebookEdit']
    if (fileTools.includes(toolUse.name)) {
      return { allowed: true }
    }
  }

  // Default mode: ask user
  const decision = await params.onPermissionRequest(
    toolUse.name,
    toolUse.input,
    describeToolUse(toolUse),
  )

  return {
    allowed: decision.behavior === 'allow',
    message: decision.behavior === 'deny' ? decision.message : undefined,
  }
}

function describeToolUse(toolUse: ToolUseBlock): string {
  const input = toolUse.input as Record<string, any>
  switch (toolUse.name) {
    case 'Bash':
      return `Bash: ${input.command || '(no command)'}`
    case 'Edit':
      return `Edit: ${input.file_path || input.path || input.filePath || '(unknown file)'}`
    case 'Write':
      return `Write: ${input.file_path || input.path || '(unknown file)'}`
    case 'Read':
      return `Read: ${input.file_path || input.path || '(unknown file)'}`
    default:
      return `${toolUse.name}: ${JSON.stringify(input).slice(0, 200)}`
  }
}

// ---------------------------------------------------------------------------
// Compact Function (stub - will be replaced by context/compaction.ts)
// ---------------------------------------------------------------------------

async function performCompact(
  messages: Message[],
  params: QueryParams,
): Promise<{ compacted: Message[]; oldTokens: number; newTokens: number }> {
  // Import dynamically to avoid circular deps
  const { compact } = await import('../context/compaction.js')
  const Anthropic = (await import('@anthropic-ai/sdk')).default

  // Create a simple callModel callback for the compaction summarizer
  const callModelForCompact = async (
    systemPrompt: string,
    userMessage: string,
    model: string,
    apiKey: string,
    abortSignal?: AbortSignal,
  ): Promise<string> => {
    const client = new Anthropic({ apiKey })
    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    })
    const textBlock = response.content.find((b: any) => b.type === 'text') as any
    return textBlock?.text || ''
  }

  return compact(messages, {
    apiKey: params.apiKey,
    model: params.modelConfig.model,
    systemPromptBlocks: params.systemPromptBlocks,
  }, callModelForCompact)
}

// ---------------------------------------------------------------------------
// Main Agent Loop
// ---------------------------------------------------------------------------

/**
 * Core agent loop — the heart of nanocode.
 *
 * Yields StreamEvents as it processes. The caller (CLI/headless) consumes
 * these events to display output and track progress.
 *
 * Returns the final messages array for session persistence.
 */
export async function* agentLoop(
  params: QueryParams,
): AsyncGenerator<StreamEvent, Message[]> {
  let { messages } = params
  let turnCount = 0
  let ptlRetries = 0
  const maxTurns = params.maxTurns ?? DEFAULT_MAX_TURNS

  // Build tool context (shared across turns)
  const toolContext: ToolContext = {
    cwd: params.cwd,
    readFileState: params.readFileState,
    fileHistory: params.fileHistory,
    modifiedFiles: new Set(),
    sessionId: params.sessionId,
    abortSignal: params.abortSignal,
    permissionMode: params.permissionMode,
    onPermissionRequest: params.onPermissionRequest,
  }

  while (true) {
    // Check abort
    if (params.abortSignal?.aborted) {
      yield { type: 'error', error: new AbortError() }
      return messages
    }

    // -----------------------------------------------------------------------
    // 1. Auto-compact check
    // -----------------------------------------------------------------------
    if (shouldAutoCompact(
      messages,
      params.modelConfig.contextWindow,
      params.modelConfig.maxOutputTokens,
    )) {
      try {
        const { compacted, oldTokens, newTokens } = await performCompact(
          messages,
          params,
        )
        messages = compacted
        yield { type: 'compact', oldTokens, newTokens }
      } catch (err) {
        // Compact failure is non-fatal, continue with current messages
        yield {
          type: 'error',
          error: new Error(`Auto-compact failed: ${err instanceof Error ? err.message : String(err)}`),
        }
      }
    }

    // Micro-compact old tool results
    microCompactMessages(messages)

    // -----------------------------------------------------------------------
    // 2. Call Claude API (streaming)
    // -----------------------------------------------------------------------
    const toolUseBlocks: ToolUseBlock[] = []
    let assistantContent: ContentBlock[] = []
    let stopReason = 'end_turn'

    try {
      for await (const event of callModel({
        messages,
        tools: params.tools,
        modelConfig: params.modelConfig,
        systemPromptBlocks: params.systemPromptBlocks,
        apiKey: params.apiKey,
        enableThinking: params.enableThinking,
        thinkingBudget: params.thinkingBudget,
        abortSignal: params.abortSignal,
      })) {
        // Pass through streaming events to caller
        yield event

        // Collect tool_use blocks
        if (event.type === 'tool_use') {
          toolUseBlocks.push(event.toolUse)
        }

        // Collect complete assistant message
        if (event.type === 'assistant_message') {
          assistantContent = event.message.content
        }

        if (event.type === 'turn_complete') {
          stopReason = event.stopReason
        }
      }

      // Reset PTL counter on success
      ptlRetries = 0
    } catch (err) {
      if (err instanceof PromptTooLongError) {
        ptlRetries++
        if (ptlRetries >= MAX_PTL_RETRIES) {
          yield {
            type: 'error',
            error: new Error(
              `Prompt too long after ${MAX_PTL_RETRIES} truncation attempts. Try /compact.`,
            ),
          }
          return messages
        }

        // PTL Recovery: truncate oldest messages and retry
        messages = truncateForPTL(messages)
        yield {
          type: 'error',
          error: new Error(
            `Prompt too long — truncating old messages (attempt ${ptlRetries}/${MAX_PTL_RETRIES})`,
          ),
        }
        continue // Retry the loop
      }

      // Other errors are yielded but don't break the loop
      yield { type: 'error', error: classifyError(err) }
      return messages
    }

    // -----------------------------------------------------------------------
    // 3. Accumulate assistant message
    // -----------------------------------------------------------------------
    if (assistantContent.length > 0) {
      messages.push(buildAssistantMessage(assistantContent))
    }

    // -----------------------------------------------------------------------
    // 4. No tool use → done
    // -----------------------------------------------------------------------
    if (toolUseBlocks.length === 0) {
      return messages
    }

    // -----------------------------------------------------------------------
    // 5. Check permissions + Execute tools
    // -----------------------------------------------------------------------
    const toolResults: Array<{ toolUseId: string; result: ToolResult }> = []

    // First, check permissions for non-read-only tools
    const permissionChecks = await Promise.all(
      toolUseBlocks.map((tu) => checkToolPermission(tu, params, toolContext)),
    )

    // Separate allowed and denied
    const allowedToolUses: ToolUseBlock[] = []
    for (let i = 0; i < toolUseBlocks.length; i++) {
      const check = permissionChecks[i]!
      const tu = toolUseBlocks[i]!
      if (check.allowed) {
        allowedToolUses.push(tu)
      } else {
        // Add denied result immediately
        toolResults.push({
          toolUseId: tu.id,
          result: {
            result: check.message || `Permission denied for ${tu.name}.`,
            isError: true,
          },
        })
        yield {
          type: 'tool_result',
          toolUseId: tu.id,
          toolName: tu.name,
          result: check.message || `Permission denied for ${tu.name}.`,
          isError: true,
        }
      }
    }

    // -----------------------------------------------------------------------
    // 6. Execute allowed tools (concurrent/serial partition)
    // -----------------------------------------------------------------------
    if (allowedToolUses.length > 0) {
      for await (const event of executeTools(
        allowedToolUses,
        params.tools,
        toolContext,
      )) {
        yield event

        if (event.type === 'tool_result') {
          toolResults.push({
            toolUseId: event.toolUseId,
            result: {
              result: event.result,
              isError: event.isError,
            },
          })
        }
      }
    }

    // -----------------------------------------------------------------------
    // 7. Accumulate tool results as user message
    // -----------------------------------------------------------------------
    // Reorder results to match original tool_use order
    const orderedResults = toolUseBlocks.map((tu) => {
      const r = toolResults.find((tr) => tr.toolUseId === tu.id)
      return r || {
        toolUseId: tu.id,
        result: { result: 'Tool execution failed (no result)', isError: true },
      }
    })

    messages.push(buildToolResultMessage(orderedResults))

    // -----------------------------------------------------------------------
    // 8. Max turns check
    // -----------------------------------------------------------------------
    turnCount++
    if (turnCount >= maxTurns) {
      yield { type: 'max_turns_reached', maxTurns }
      return messages
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-Agent Execution Helper
// ---------------------------------------------------------------------------

/**
 * Run a sub-agent with isolated context.
 * Fresh messages, shared tools (filtered), inherited system prompt.
 */
export async function runSubAgent(
  prompt: string,
  params: QueryParams,
  options: {
    tools?: string[] // Tool names to include (undefined = all)
    disallowedTools?: string[]
    maxTurns?: number
    model?: string // Override model
  } = {},
): Promise<string> {
  // Filter tools
  let tools = params.tools
  if (options.tools) {
    tools = tools.filter((t) => options.tools!.includes(t.name))
  }
  if (options.disallowedTools) {
    tools = tools.filter((t) => !options.disallowedTools!.includes(t.name))
  }

  // Fresh messages
  const messages: Message[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      id: randomUUID(),
    },
  ]

  // Clone file state cache for isolation
  const readFileState = params.readFileState.clone()

  // Run agent
  const subParams: QueryParams = {
    ...params,
    messages,
    tools,
    maxTurns: options.maxTurns ?? 200,
    readFileState,
    // Keep same file history (shared across agents)
  }

  let lastAssistantText = ''
  const gen = agentLoop(subParams)

  while (true) {
    const { value, done } = await gen.next()
    if (done) break

    const event = value as StreamEvent
    if (event.type === 'assistant_text') {
      lastAssistantText += event.text
    } else if (event.type === 'assistant_message') {
      // Extract text from the complete message
      const textBlocks = event.message.content.filter(
        (b): b is { type: 'text'; text: string } => b.type === 'text',
      )
      if (textBlocks.length > 0) {
        lastAssistantText = textBlocks.map((b) => b.text).join('\n')
      }
    }
  }

  // Merge file state caches (newer timestamps win)
  params.readFileState.merge(readFileState)

  return lastAssistantText || '(No response from sub-agent)'
}
