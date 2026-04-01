/**
 * Skills System — Public API
 *
 * Re-exports all skill-related types, loader functions, and tool definitions.
 *
 * Usage:
 *   import { loadAllSkills, skillToolDef, getLoadedSkills } from './skills/index.js'
 *
 *   // At startup: load skills from disk
 *   await initializeSkills(cwd)
 *
 *   // Register the Skill tool in the tool registry
 *   registerToolDef(skillToolDef)
 *
 *   // Inject skill listing into system prompt
 *   const listing = formatSkillListing(getLoadedSkills())
 */

// Types
export type { SkillDefinition, SkillFrontmatter, SkillSource, SkillLoadResult } from './types.js'

// Loader
export { loadAllSkills, parseSkillFile, parseFrontmatter } from './loader.js'

// Skill Tool
export {
  skillToolDef,
  getLoadedSkills,
  formatSkillListing,
  initializeSkills,
  resetSkills,
} from './skill-tool.js'
