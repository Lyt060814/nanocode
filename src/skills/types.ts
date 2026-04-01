/**
 * Skill Type Definitions
 *
 * Skills are reusable prompt templates loaded from SKILL.md files
 * in .claude/skills/ directories. They can be invoked by users
 * via slash commands or by the model via the Skill tool.
 */

// ---------------------------------------------------------------------------
// Skill Definition — The runtime representation of a loaded skill
// ---------------------------------------------------------------------------

export interface SkillDefinition {
  /** Unique skill name (from frontmatter or directory name) */
  name: string

  /** Human-readable description shown in listings */
  description: string

  /** Hint for when the model should invoke this skill */
  whenToUse?: string

  /** Hint shown to users about what arguments to provide */
  argumentHint?: string

  /** Named arguments the skill accepts (for $1, $2, ... substitution) */
  argumentNames?: string[]

  /** Restrict which tools the skill's sub-agent can use */
  allowedTools?: string[]

  /** Override the model used when this skill is forked */
  model?: string

  /** true = users can invoke via /skill, false = model-only */
  userInvocable: boolean

  /** inline = inject prompt into current conversation, fork = run as sub-agent */
  context: 'inline' | 'fork'

  /** Agent type when forked (e.g. 'explore', 'code') */
  agent?: string

  /** Glob patterns — skill only activates when matching files exist in cwd */
  paths?: string[]

  /** Absolute path to the directory containing SKILL.md */
  skillRoot?: string

  /**
   * Expand the skill's prompt template with the given arguments.
   * Substitutes $ARGUMENTS, $1/$2/..., and ${CLAUDE_SKILL_DIR}.
   */
  getPrompt(args: string): Promise<string>
}

// ---------------------------------------------------------------------------
// Skill Frontmatter — Parsed from YAML header in SKILL.md
// ---------------------------------------------------------------------------

export interface SkillFrontmatter {
  name?: string
  description?: string
  'when_to_use'?: string
  'user-invocable'?: boolean
  'argument-hint'?: string
  arguments?: string | string[]
  'allowed-tools'?: string[]
  model?: string
  context?: 'inline' | 'fork'
  agent?: string
  paths?: string | string[]
}

// ---------------------------------------------------------------------------
// Discovery Source — Where a skill was found
// ---------------------------------------------------------------------------

export type SkillSource = 'user' | 'project'

export interface SkillLoadResult {
  skill: SkillDefinition
  source: SkillSource
  filePath: string
}
