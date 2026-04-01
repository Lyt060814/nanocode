/**
 * nanocode Headless / SDK Mode
 *
 * Programmatic interface to nanocode — no terminal UI, pure async generator.
 * Use this to embed nanocode in other applications.
 *
 * Usage:
 *   import { createAgent } from 'nanocode/headless'
 *   const agent = createAgent({ apiKey, model: 'sonnet' })
 *   for await (const event of agent.query('Fix the bug in auth.ts')) {
 *     if (event.type === 'assistant_text') process.stdout.write(event.text)
 *   }
 */

import { randomUUID } from 'node:crypto'
import type {
  Message,
  StreamEvent,
  QueryParams,
  ModelConfig,
  PermissionDecision,
  PermissionMode,
  Tool,
} from './core/types.js'
import { agentLoop } from './core/agent.js'
import { getModelConfig } from './core/api.js'
import { createFileStateCache } from './files/cache.js'
import { createFileHistoryState } from './files/history.js'
import { buildSystemPromptBlocks } from './prompt/system.js'
import { loadClaudeMd } from './context/memory.js'
import { getGitContext } from './context/git-context.js'
import { initializeTools } from './tools/registry.js'
import { createCostTracker } from './utils/cost.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentOptions {
  apiKey: string
  model?: string
  cwd?: string
  maxTurns?: number
  permissionMode?: PermissionMode
  enableThinking?: boolean
  thinkingBudget?: number
  tools?: Tool[]
  onPermissionRequest?: (tool: string, input: unknown, message: string) => Promise<PermissionDecision>
}

export interface AgentInstance {
  query(prompt: string): AsyncGenerator<StreamEvent, Message[]>
  getMessages(): Message[]
  getCostSummary(): string
  getSessionId(): string
  reset(): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createAgent(options: AgentOptions): Promise<AgentInstance> {
  const cwd = options.cwd || process.cwd()
  const modelConfig = getModelConfig(options.model || 'sonnet')
  const sessionId = randomUUID()
  const costTracker = createCostTracker()
  const readFileState = createFileStateCache()
  const fileHistory = createFileHistoryState()

  // Load context
  const claudeMd = await loadClaudeMd(cwd).catch(() => '')
  const gitContext = await getGitContext(cwd).catch(() => '')
  const systemPromptBlocks = buildSystemPromptBlocks({
    claudeMd: claudeMd || '',
    gitContext: gitContext || '',
    cwd,
    model: modelConfig.model,
  })

  // Initialize tools
  const tools = options.tools || await initializeTools()

  let messages: Message[] = []

  // Default permission handler: allow everything in headless mode
  const defaultPermissionHandler = async (): Promise<PermissionDecision> => ({
    behavior: 'allow',
  })

  const instance: AgentInstance = {
    async *query(prompt: string): AsyncGenerator<StreamEvent, Message[]> {
      // Add user message
      messages.push({
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        id: randomUUID(),
      })

      const params: QueryParams = {
        messages,
        tools,
        modelConfig,
        systemPromptBlocks,
        maxTurns: options.maxTurns ?? 200,
        permissionMode: options.permissionMode ?? 'bypassPermissions',
        apiKey: options.apiKey,
        cwd,
        sessionId,
        onPermissionRequest: options.onPermissionRequest || defaultPermissionHandler,
        enableThinking: options.enableThinking,
        thinkingBudget: options.thinkingBudget,
        readFileState,
        fileHistory,
      }

      const gen = agentLoop(params)
      while (true) {
        const { value, done } = await gen.next()
        if (done) {
          messages = value as Message[]
          return messages
        }
        yield value as StreamEvent
      }
    },

    getMessages(): Message[] {
      return [...messages]
    },

    getCostSummary(): string {
      return costTracker.summary(modelConfig)
    },

    getSessionId(): string {
      return sessionId
    },

    reset(): void {
      messages = []
    },
  }

  return instance
}

// ---------------------------------------------------------------------------
// Convenience: one-shot query
// ---------------------------------------------------------------------------

export async function oneShot(
  prompt: string,
  options: AgentOptions,
): Promise<{ text: string; messages: Message[] }> {
  const agent = await createAgent(options)
  let text = ''

  const gen = agent.query(prompt)
  while (true) {
    const { value, done } = await gen.next()
    if (done) break
    const event = value as StreamEvent
    if (event.type === 'assistant_text') {
      text += event.text
    }
  }

  return { text, messages: agent.getMessages() }
}
