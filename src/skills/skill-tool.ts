/**
 * Skill Tool — Invoke skills from the conversation
 *
 * The model can call this tool to invoke any loaded skill.
 * Skills are either executed inline (prompt injected into conversation)
 * or forked (run as sub-agent with isolated context).
 *
 * Users can also trigger skills via the /skill slash command, which
 * feeds into the same execution path.
 */

import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext } from '../core/types.js'
import type { SkillDefinition } from './types.js'
import { loadAllSkills } from './loader.js'

// ---------------------------------------------------------------------------
// Module State
// ---------------------------------------------------------------------------

/** Cached loaded skills — populated by initialize() or first tool call */
let _loadedSkills: SkillDefinition[] = []
let _initialized = false

// ---------------------------------------------------------------------------
// Public API — Skill Access
// ---------------------------------------------------------------------------

/**
 * Initialize the skill system by loading skills from disk.
 * Call this once at startup (e.g., during tool registry initialization).
 *
 * @param cwd - Working directory to discover project skills from
 */
export async function initializeSkills(cwd: string): Promise<void> {
  _loadedSkills = await loadAllSkills(cwd)
  _initialized = true
}

/**
 * Get all currently loaded skills.
 * Returns empty array if not yet initialized.
 */
export function getLoadedSkills(): SkillDefinition[] {
  return _loadedSkills
}

/**
 * Format a listing of available skills for injection into the system prompt.
 * Only includes skills that are relevant (passes path filter if applicable).
 */
export function formatSkillListing(skills: SkillDefinition[]): string {
  if (skills.length === 0) return ''

  const lines: string[] = [
    'Available skills (invoke via the Skill tool):',
    '',
  ]

  for (const skill of skills) {
    lines.push(`  - ${skill.name}: ${skill.description}`)
    if (skill.whenToUse) {
      lines.push(`    When to use: ${skill.whenToUse}`)
    }
    if (skill.argumentHint) {
      lines.push(`    Arguments: ${skill.argumentHint}`)
    }
    if (skill.context === 'fork') {
      lines.push(`    Execution: forked sub-agent`)
    }
  }

  return lines.join('\n')
}

/**
 * Reset skill state. Primarily for testing.
 */
export function resetSkills(): void {
  _loadedSkills = []
  _initialized = false
}

// ---------------------------------------------------------------------------
// Skill Lookup
// ---------------------------------------------------------------------------

/**
 * Find a skill by name. Case-insensitive, also tries with/without leading slash.
 */
function findSkill(name: string): SkillDefinition | undefined {
  const normalized = name.startsWith('/') ? name.slice(1) : name

  return _loadedSkills.find((s) => {
    const skillName = s.name.toLowerCase()
    return (
      skillName === normalized.toLowerCase() ||
      skillName === name.toLowerCase()
    )
  })
}

/**
 * Generate an error message listing available skills when a skill is not found.
 */
function skillNotFoundMessage(requested: string): string {
  const available = _loadedSkills
    .map((s) => `  - ${s.name}: ${s.description}`)
    .join('\n')

  if (!available) {
    return (
      `Skill "${requested}" not found. No skills are currently loaded.\n` +
      `Skills are loaded from .nanocode/skills/ or .claude/skills/ directories.`
    )
  }

  return (
    `Skill "${requested}" not found. Available skills:\n${available}`
  )
}

// ---------------------------------------------------------------------------
// Skill Execution
// ---------------------------------------------------------------------------

/**
 * Execute a skill inline — expand its prompt and return as tool result.
 */
async function executeInline(
  skill: SkillDefinition,
  args: string,
): Promise<ToolResult> {
  const prompt = await skill.getPrompt(args)
  return {
    result: prompt,
    isError: false,
  }
}

/**
 * Execute a skill as a forked sub-agent.
 * Imports runSubAgent dynamically to avoid circular dependencies.
 */
async function executeFork(
  skill: SkillDefinition,
  args: string,
  context: ToolContext,
): Promise<ToolResult> {
  // Dynamic import to break circular dependency with core/agent.ts
  const { runSubAgent } = await import('../core/agent.js')

  const prompt = await skill.getPrompt(args)

  // We need QueryParams to call runSubAgent. Since we only have ToolContext,
  // we construct a minimal params object. The tool context carries the
  // essential runtime state; for the rest we use reasonable defaults.
  const { getAllTools } = await import('../tools/registry.js')

  // Build a pseudo QueryParams — runSubAgent needs messages, tools, etc.
  // We pass the prompt as the user message and let the sub-agent run.
  const result = await runSubAgent(prompt, {
    messages: [],
    tools: getAllTools(),
    modelConfig: {
      model: skill.model || 'claude-sonnet-4-20250514',
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      supportsThinking: false,
      supportsCaching: true,
      pricePerInputToken: 0.003 / 1000,
      pricePerOutputToken: 0.015 / 1000,
      pricePerCacheRead: 0.0003 / 1000,
      pricePerCacheWrite: 0.00375 / 1000,
    },
    systemPromptBlocks: [],
    permissionMode: context.permissionMode,
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    cwd: context.cwd,
    sessionId: context.sessionId,
    onPermissionRequest: context.onPermissionRequest,
    abortSignal: context.abortSignal,
    readFileState: context.readFileState,
    fileHistory: context.fileHistory,
  }, {
    tools: skill.allowedTools,
    maxTurns: 50,
    model: skill.model,
  })

  return {
    result: result || '(Skill produced no output)',
    isError: false,
  }
}

// ---------------------------------------------------------------------------
// Skill Tool Definition
// ---------------------------------------------------------------------------

const skillInputSchema = z.object({
  /** Name of the skill to invoke */
  skill: z.string().describe('The name of the skill to invoke'),

  /** Optional arguments to pass to the skill */
  args: z.string().optional().describe(
    'Arguments to pass to the skill. Substituted into the skill template as $ARGUMENTS, $1, $2, etc.',
  ),
})

type SkillInput = z.infer<typeof skillInputSchema>

/**
 * The Skill tool definition.
 *
 * Allows the model to invoke loaded skills by name. Skills are prompt
 * templates discovered from .claude/skills/ directories. They can run
 * inline (injecting the expanded prompt into the conversation) or as
 * forked sub-agents with their own tool sets.
 */
export const skillToolDef: ToolDef<SkillInput> = {
  name: 'Skill',

  description:
    'Invoke a loaded skill by name. Skills are reusable prompt templates ' +
    'loaded from .nanocode/skills/ or .claude/skills/ directories. Use this tool when a task ' +
    'matches a loaded skill\'s purpose. Pass the skill name and any arguments.',

  inputSchema: skillInputSchema,

  async call(input: SkillInput, context: ToolContext): Promise<ToolResult> {
    // Lazy-initialize if needed
    if (!_initialized) {
      await initializeSkills(context.cwd)
    }

    // Robust input handling — model may pass { name, args } or { skill, args }
    // or even { name, topic } etc.
    const anyInput = input as any
    const skillName = input.skill || anyInput.name || ''
    let args: string
    if (typeof input.args === 'string') {
      args = input.args
    } else if (typeof anyInput.arguments === 'string') {
      args = anyInput.arguments
    } else {
      // Collect any extra fields as args
      const extra = Object.entries(anyInput)
        .filter(([k]) => !['skill', 'name', 'args', 'arguments'].includes(k))
        .map(([_k, v]) => String(v))
        .join(' ')
      args = extra
    }

    if (!skillName) {
      return { result: 'Error: skill name is required.', isError: true }
    }

    const skill = findSkill(skillName)

    if (!skill) {
      return {
        result: skillNotFoundMessage(skillName),
        isError: true,
      }
    }

    // Execute based on context mode
    if (skill.context === 'fork') {
      return executeFork(skill, args, context)
    }

    return executeInline(skill, args)
  },

  prompt(): string {
    const skills = getLoadedSkills()
    if (skills.length === 0) return ''
    return formatSkillListing(skills)
  },

  isReadOnly: () => true, // The skill tool itself doesn't modify files
  isConcurrencySafe: () => false, // Forked skills may modify state
  userFacingName: (input: SkillInput) => `Skill(${input.skill})`,
}
