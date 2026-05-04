/**
 * nanocode API Client
 *
 * Claude API streaming client with retry, caching, and extended thinking.
 * Key patterns from Claude Code: claude.ts, withRetry.ts
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  Message,
  StreamEvent,
  SystemPromptBlock,
  TokenUsage,
  ModelConfig,
  ContentBlock,
  ToolUseBlock,
  Tool,
} from './types.js'
import {
  withRetry,
  classifyError,
  PromptTooLongError,
  type RetryOptions,
} from './errors.js'

// ---------------------------------------------------------------------------
// Client Factory
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null

export function createClient(apiKey: string, baseURL?: string): Anthropic {
  if (_client) return _client
  const opts: any = { apiKey }
  // Support OpenRouter / custom base URLs
  const url = baseURL || process.env.ANTHROPIC_BASE_URL || process.env.MY_BASE_URL
  if (url) {
    opts.baseURL = url
  }
  // OpenRouter uses different auth header
  if (process.env.OPENROUTER_API_KEY && !apiKey) {
    opts.apiKey = process.env.OPENROUTER_API_KEY
  }
  opts.headers = {
    'Authorization': `Bearer ${apiKey}`,
  }
  _client = new Anthropic(opts)
  return _client
}

export function resetClient(): void {
  _client = null
}

// ---------------------------------------------------------------------------
// API Call Parameters
// ---------------------------------------------------------------------------

export interface CallModelParams {
  messages: Message[]
  tools: Tool[]
  modelConfig: ModelConfig
  systemPromptBlocks: SystemPromptBlock[]
  apiKey: string
  enableThinking?: boolean
  thinkingBudget?: number
  abortSignal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Streaming API Call
// ---------------------------------------------------------------------------

export async function* callModel(
  params: CallModelParams,
): AsyncGenerator<StreamEvent> {
  const client = createClient(params.apiKey)

  // Convert messages to API format
  const apiMessages = params.messages.map(messageToAPI)

  // Convert tools to API format
  const apiTools = params.tools.map(toolToAPI)

  // Build request
  const request: any = {
    model: params.modelConfig.model,
    max_tokens: params.modelConfig.maxOutputTokens,
    system: params.systemPromptBlocks,
    messages: apiMessages,
    tools: apiTools.length > 0 ? apiTools : undefined,
    stream: true,
  }

  // Extended thinking
  if (params.enableThinking && params.modelConfig.supportsThinking) {
    request.thinking = {
      type: 'enabled',
      budget_tokens: params.thinkingBudget || 10000,
    }
    // Thinking requires beta endpoint
    delete request.max_tokens
    request.max_tokens = params.modelConfig.maxOutputTokens
  }

  // Execute with retry
  const response = await withRetry(
    async () => {
      if (params.abortSignal?.aborted) {
        throw new Error('Aborted')
      }

      // Use streaming
      if (params.enableThinking && params.modelConfig.supportsThinking) {
        return client.beta.messages.stream({
          ...request,
          betas: ['interleaved-thinking-2025-05-14'],
        })
      }
      return client.messages.stream(request)
    },
    {
      maxRetries: 5,
      abortSignal: params.abortSignal,
      onRetry: (error, attempt, delay) => {
        process.stderr.write(
          `\x1b[33m[retry ${attempt}] ${error.name}: ${error.message} (waiting ${Math.round(delay / 1000)}s)\x1b[0m\n`,
        )
      },
    } satisfies RetryOptions,
  )

  // Process stream events
  const toolUseBlocks: ToolUseBlock[] = []
  let currentToolUse: Partial<ToolUseBlock> | null = null
  let currentToolJson = ''
  let textContent = ''
  // Track usage from streaming events (for OpenRouter compat)
  const streamUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
  let thinkingContent = ''

  try {
    const stream = response as AsyncIterable<any>
    for await (const event of stream) {
      if (params.abortSignal?.aborted) break

      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block
          if (block.type === 'tool_use') {
            currentToolUse = {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: {},
            }
            currentToolJson = ''
          } else if (block.type === 'thinking') {
            thinkingContent = ''
          }
          break
        }

        case 'content_block_delta': {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            textContent += delta.text
            yield { type: 'assistant_text', text: delta.text }
          } else if (delta.type === 'input_json_delta') {
            currentToolJson += delta.partial_json
          } else if (delta.type === 'thinking_delta') {
            thinkingContent += delta.thinking
            yield { type: 'thinking', text: delta.thinking }
          }
          break
        }

        case 'content_block_stop': {
          if (currentToolUse && currentToolUse.id) {
            try {
              currentToolUse.input = currentToolJson
                ? JSON.parse(currentToolJson)
                : {}
            } catch {
              currentToolUse.input = {}
            }
            const block = currentToolUse as ToolUseBlock
            toolUseBlocks.push(block)
            yield { type: 'tool_use', toolUse: block }
            currentToolUse = null
            currentToolJson = ''
          }
          break
        }

        case 'message_start': {
          // Some providers send usage in message_start
          const msg = (event as any).message
          if (msg?.usage) {
            streamUsage.inputTokens = msg.usage.input_tokens || 0
            streamUsage.cacheReadTokens = (msg.usage as any).cache_read_input_tokens || 0
            streamUsage.cacheCreationTokens = (msg.usage as any).cache_creation_input_tokens || 0
          }
          break
        }

        case 'message_stop':
          break

        case 'message_delta': {
          // Extract usage from message_delta (OpenRouter/standard)
          const delta = (event as any).delta
          const deltaUsage = (event as any).usage
          if (deltaUsage) {
            streamUsage.outputTokens = deltaUsage.output_tokens || 0
          }
          break
        }
      }
    }
  } catch (raw) {
    const error = classifyError(raw)
    if (error instanceof PromptTooLongError) throw error
    yield { type: 'error', error }
    return
  }

  // Get final message for usage
  let usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }

  try {
    const finalMessage = await (response as any).finalMessage?.().catch(() => null)
    if (finalMessage?.usage) {
      usage = {
        inputTokens: finalMessage.usage.input_tokens || 0,
        outputTokens: finalMessage.usage.output_tokens || 0,
        cacheReadTokens: (finalMessage.usage as any).cache_read_input_tokens || 0,
        cacheCreationTokens: (finalMessage.usage as any).cache_creation_input_tokens || 0,
      }
    }
    // Fallback to streaming usage if finalMessage didn't have it
    if (usage.inputTokens === 0 && streamUsage.inputTokens > 0) {
      usage = { ...streamUsage }
    }
    if (usage.outputTokens === 0 && streamUsage.outputTokens > 0) {
      usage.outputTokens = streamUsage.outputTokens
    }

    const stopReason = finalMessage?.stop_reason || 'end_turn'

    // Build the complete assistant message
    const content: ContentBlock[] = []
    if (thinkingContent) {
      content.push({ type: 'thinking', thinking: thinkingContent })
    }
    if (textContent) {
      content.push({ type: 'text', text: textContent })
    }
    for (const tu of toolUseBlocks) {
      content.push(tu)
    }

    yield {
      type: 'assistant_message',
      message: { role: 'assistant', content },
    }

    // Emit usage for cost tracking
    if (usage.inputTokens > 0 || usage.outputTokens > 0) {
      yield { type: 'usage', usage }
    }

    yield { type: 'turn_complete', stopReason }
  } catch (raw) {
    const error = classifyError(raw)
    if (error instanceof PromptTooLongError) throw error
    yield { type: 'error', error }
  }
}

// ---------------------------------------------------------------------------
// Extract usage from the last call (exposed for cost tracking)
// ---------------------------------------------------------------------------

let _lastUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
}

export function getLastUsage(): TokenUsage {
  return { ..._lastUsage }
}

export function setLastUsage(usage: TokenUsage): void {
  _lastUsage = { ...usage }
}

// ---------------------------------------------------------------------------
// Conversion Helpers
// ---------------------------------------------------------------------------

function messageToAPI(msg: Message): any {
  return {
    role: msg.role,
    content: msg.content.map(blockToAPI),
  }
}

function blockToAPI(block: ContentBlock): any {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      }
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking }
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data }
    case 'image':
      return block
    default:
      return block
  }
}

function toolToAPI(tool: Tool): any {
  // Convert Zod schema to JSON Schema
  let inputSchema: any
  try {
    // Use zod-to-json-schema if available, otherwise basic conversion
    const { zodToJsonSchema } = require('zod-to-json-schema')
    inputSchema = zodToJsonSchema(tool.inputSchema, { target: 'openApi3' })
    // Remove the $schema wrapper
    delete inputSchema.$schema
  } catch {
    // Fallback: let the SDK handle it
    inputSchema = { type: 'object', properties: {} }
  }

  const desc = typeof tool.description === 'function'
    ? tool.description()
    : tool.description

  return {
    name: tool.name,
    description: desc,
    input_schema: inputSchema,
  }
}

// ---------------------------------------------------------------------------
// Model Configurations
// ---------------------------------------------------------------------------

export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  'claude-sonnet-4-20250514': {
    model: 'claude-sonnet-4-20250514',
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsThinking: true,
    supportsCaching: true,
    pricePerInputToken: 3 / 1_000_000,
    pricePerOutputToken: 15 / 1_000_000,
    pricePerCacheRead: 0.3 / 1_000_000,
    pricePerCacheWrite: 3.75 / 1_000_000,
  },
  'claude-opus-4-20250514': {
    model: 'claude-opus-4-20250514',
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsThinking: true,
    supportsCaching: true,
    pricePerInputToken: 15 / 1_000_000,
    pricePerOutputToken: 75 / 1_000_000,
    pricePerCacheRead: 1.5 / 1_000_000,
    pricePerCacheWrite: 18.75 / 1_000_000,
  },
  'claude-haiku-4-5-20251001': {
    model: 'claude-haiku-4-5-20251001',
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsThinking: false,
    supportsCaching: true,
    pricePerInputToken: 0.8 / 1_000_000,
    pricePerOutputToken: 4 / 1_000_000,
    pricePerCacheRead: 0.08 / 1_000_000,
    pricePerCacheWrite: 1 / 1_000_000,
  },
}

// Aliases
MODEL_CONFIGS['sonnet'] = MODEL_CONFIGS['claude-sonnet-4-20250514']!
MODEL_CONFIGS['opus'] = MODEL_CONFIGS['claude-opus-4-20250514']!
MODEL_CONFIGS['haiku'] = MODEL_CONFIGS['claude-haiku-4-5-20251001']!

export function getModelConfig(model: string): ModelConfig {
  const config = MODEL_CONFIGS[model]
  if (config) return config

  // Try partial match
  for (const [key, cfg] of Object.entries(MODEL_CONFIGS)) {
    if (key.includes(model) || model.includes(key)) return cfg
  }

  // Default to sonnet
  return {
    ...MODEL_CONFIGS['sonnet']!,
    model,
  }
}
