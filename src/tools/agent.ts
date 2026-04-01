/**
 * Agent Tool — Sub-agent delegation
 *
 * Launches a sub-agent with an isolated message context but shared file state.
 * Three modes:
 *   - 'Explore': read-only tools only, omits CLAUDE.md — for quick research
 *   - 'Plan': all tools except Agent — for planning tasks
 *   - default: all tools — general-purpose sub-agent
 *
 * Key patterns from Claude Code: SubAgent tool with tool filtering.
 */

import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext, QueryParams } from '../core/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Bash'])
const MAX_SUB_AGENT_TURNS = 50
const DEFAULT_SUB_AGENT_TURNS = 30

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  prompt: z.string().describe(
    'The task description or question for the sub-agent. Be specific and provide context.',
  ),
  subagent_type: z.enum(['Explore', 'Plan', 'default']).optional().describe(
    'Sub-agent mode. "Explore" = read-only research, "Plan" = all tools except Agent, default = all tools.',
  ),
  description: z.string().optional().describe(
    'A brief description of the sub-agent task for logging.',
  ),
  model: z.string().optional().describe(
    'Override the model for the sub-agent. Default: use parent model.',
  ),
  run_in_background: z.boolean().optional().describe(
    'If true, run the sub-agent in the background (future feature). Default: false.',
  ),
})

type AgentInput = z.infer<typeof inputSchema>

// ---------------------------------------------------------------------------
// Singleton reference to query params — injected at registration time
// ---------------------------------------------------------------------------

let _queryParamsRef: QueryParams | null = null

/**
 * Set the query params reference for the Agent tool.
 * Called by the registry or agent loop when initializing tools.
 */
export function setAgentQueryParams(params: QueryParams): void {
  _queryParamsRef = params
}

/**
 * Get the current query params reference.
 */
export function getAgentQueryParams(): QueryParams | null {
  return _queryParamsRef
}

// ---------------------------------------------------------------------------
// Sub-Agent Type Configuration
// ---------------------------------------------------------------------------

interface SubAgentConfig {
  tools?: string[]           // Allowlist of tool names (undefined = all)
  disallowedTools?: string[] // Blocklist of tool names
  maxTurns: number
  omitClaudeMd: boolean
}

function getSubAgentConfig(type: string | undefined): SubAgentConfig {
  switch (type) {
    case 'Explore':
      return {
        tools: [...READ_ONLY_TOOLS],
        maxTurns: DEFAULT_SUB_AGENT_TURNS,
        omitClaudeMd: true,
      }

    case 'Plan':
      return {
        disallowedTools: ['Agent'],
        maxTurns: MAX_SUB_AGENT_TURNS,
        omitClaudeMd: false,
      }

    default:
      return {
        maxTurns: MAX_SUB_AGENT_TURNS,
        omitClaudeMd: false,
      }
  }
}

// ---------------------------------------------------------------------------
// Prompt Enhancement
// ---------------------------------------------------------------------------

function buildSubAgentPrompt(
  prompt: string,
  type: string | undefined,
  description?: string,
): string {
  const parts: string[] = []

  if (description) {
    parts.push(`Task: ${description}`)
    parts.push('')
  }

  switch (type) {
    case 'Explore':
      parts.push(
        'You are a research sub-agent. Your job is to explore the codebase and gather information.',
        'You have read-only access. Do NOT attempt to modify any files.',
        'Focus on finding relevant code, understanding structure, and reporting findings.',
        '',
      )
      break

    case 'Plan':
      parts.push(
        'You are a planning sub-agent. Your job is to analyze the problem and create a detailed plan.',
        'You have access to all tools except Agent (no further delegation).',
        'Create a clear, actionable plan with specific file paths and changes needed.',
        '',
      )
      break

    default:
      parts.push(
        'You are a sub-agent working on a specific task.',
        'Complete the task thoroughly and report your results.',
        '',
      )
      break
  }

  parts.push(prompt)

  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const agentToolDef: ToolDef<AgentInput> = {
  name: 'Agent',

  description: (input?: AgentInput) => {
    const type = input?.subagent_type ?? 'default'
    switch (type) {
      case 'Explore':
        return 'Launch a read-only research sub-agent to explore the codebase.'
      case 'Plan':
        return 'Launch a planning sub-agent with full tool access (except delegation).'
      default:
        return 'Launch a sub-agent to handle a specific task with isolated context.'
    }
  },

  inputSchema,

  async call(input: AgentInput, context: ToolContext): Promise<ToolResult> {
    const { prompt, subagent_type, description, model } = input

    if (!prompt.trim()) {
      return { result: 'Error: prompt cannot be empty.', isError: true }
    }

    // Get query params reference
    const params = _queryParamsRef
    if (!params) {
      return {
        result: 'Error: Agent tool not properly initialized. Query params not available.',
        isError: true,
      }
    }

    // Get sub-agent configuration
    const config = getSubAgentConfig(subagent_type)

    // Build the enhanced prompt
    const enhancedPrompt = buildSubAgentPrompt(prompt, subagent_type, description)

    try {
      // Dynamically import to avoid circular dependencies
      const { runSubAgent } = await import('../core/agent.js')

      const response = await runSubAgent(enhancedPrompt, params, {
        tools: config.tools,
        disallowedTools: config.disallowedTools,
        maxTurns: config.maxTurns,
        model,
      })

      if (!response || response === '(No response from sub-agent)') {
        return {
          result: 'Sub-agent completed but produced no response.',
          isError: false,
        }
      }

      // Format response with metadata
      const header = description
        ? `[Sub-agent: ${description}]`
        : `[Sub-agent: ${subagent_type ?? 'default'}]`

      return {
        result: `${header}\n\n${response}`,
        isError: false,
      }
    } catch (err: any) {
      return {
        result: `Error running sub-agent: ${err.message}`,
        isError: true,
      }
    }
  },

  prompt(): string {
    return [
      'Delegate a task to a sub-agent with isolated context.',
      '',
      'Sub-agent types:',
      '  Explore — Read-only research (Read, Glob, Grep, Bash)',
      '  Plan    — Full tools except Agent (no further delegation)',
      '  default — All tools available',
      '',
      'Guidelines:',
      '- Use Explore for quick research tasks that do not modify files.',
      '- Use Plan for complex analysis that needs a structured plan.',
      '- Use default for tasks that need to both read and write.',
      '- Be specific in the prompt — provide context and expected output.',
      '- Sub-agents have isolated message context but share file state.',
    ].join('\n')
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  maxResultSizeChars: 60_000,

  userFacingName(input: AgentInput): string {
    const type = input.subagent_type ?? 'default'
    const desc = input.description
      ? input.description.slice(0, 40)
      : input.prompt.slice(0, 40)
    return `Agent(${type}): ${desc}${desc.length >= 40 ? '...' : ''}`
  },
}
