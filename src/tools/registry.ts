/**
 * Tool Registry & buildTool Factory
 *
 * Key pattern from Claude Code: fail-closed defaults.
 * isConcurrencySafe defaults to false, isReadOnly defaults to false.
 *
 * All tool modules export a ToolDef which is wrapped by buildTool to produce
 * a fully-defaulted Tool. The registry collects and exposes all tools.
 */

import type { Tool, ToolDef } from '../core/types.js'

// ---------------------------------------------------------------------------
// buildTool — Apply fail-closed defaults
// ---------------------------------------------------------------------------

/**
 * Wraps a ToolDef with fail-closed defaults to produce a Tool.
 *
 * Defaults:
 *   - prompt: () => ''
 *   - isConcurrencySafe: () => false  (FAIL CLOSED — assume not safe)
 *   - isReadOnly: () => false          (FAIL CLOSED — assume writes)
 *   - maxResultSizeChars: 30_000
 *   - userFacingName: () => tool.name
 */
export function buildTool<Input = any>(def: ToolDef<Input>): Tool<Input> {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    call: def.call.bind(def),
    prompt: def.prompt ?? (() => ''),
    isConcurrencySafe: def.isConcurrencySafe ?? (() => false),
    isReadOnly: def.isReadOnly ?? (() => false),
    maxResultSizeChars: def.maxResultSizeChars ?? 30_000,
    userFacingName: def.userFacingName ?? (() => def.name),
  }
}

// ---------------------------------------------------------------------------
// Tool Registry — Internal State
// ---------------------------------------------------------------------------

const _registry: Map<string, Tool> = new Map()
let _initialized = false

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a single tool. Overwrites if a tool with the same name exists.
 */
export function registerTool(tool: Tool): void {
  _registry.set(tool.name, tool)
}

/**
 * Register a ToolDef by wrapping it with buildTool, then adding to registry.
 */
export function registerToolDef<Input = any>(def: ToolDef<Input>): Tool<Input> {
  const tool = buildTool(def)
  registerTool(tool as Tool)
  return tool
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Get all registered tools. If not initialized, returns empty array.
 * Call initializeTools() first.
 */
export function getAllTools(): Tool[] {
  return Array.from(_registry.values())
}

/**
 * Look up a tool by name.
 */
export function getToolByName(name: string): Tool | undefined {
  return _registry.get(name)
}

/**
 * Check if a tool is registered.
 */
export function hasToolByName(name: string): boolean {
  return _registry.has(name)
}

/**
 * Get count of registered tools.
 */
export function getToolCount(): number {
  return _registry.size
}

// ---------------------------------------------------------------------------
// Initialization — Load All Tool Modules
// ---------------------------------------------------------------------------

/**
 * Initialize the tool registry by importing all tool modules.
 * Each module exports a ToolDef (or multiple ToolDefs).
 * Must be called once at startup before using getAllTools().
 *
 * Returns the full list of registered tools.
 */
export async function initializeTools(): Promise<Tool[]> {
  if (_initialized && _registry.size > 0) {
    return getAllTools()
  }

  // Import all tool modules in parallel
  const [
    bashMod,
    readMod,
    editMod,
    writeMod,
    globMod,
    grepMod,
    agentMod,
    askMod,
    todoMod,
    webFetchMod,
    webSearchMod,
    planModeMod,
    notebookEditMod,
    mcpMod,
    skillMod,
  ] = await Promise.all([
    import('./bash.js'),
    import('./read.js'),
    import('./edit.js'),
    import('./write.js'),
    import('./glob.js'),
    import('./grep.js'),
    import('./agent.js'),
    import('./ask.js'),
    import('./todo.js'),
    import('./web-fetch.js'),
    import('./web-search.js'),
    import('./plan-mode.js'),
    import('./notebook-edit.js'),
    import('./mcp-wrapper.js'),
    import('../skills/skill-tool.js').catch(() => null),
  ])

  // Register each tool from its ToolDef export
  // Each module exports its ToolDef under a predictable name

  // Core tools
  registerToolDef(bashMod.bashToolDef)
  registerToolDef(readMod.readToolDef)
  registerToolDef(editMod.editToolDef)
  registerToolDef(writeMod.writeToolDef)
  registerToolDef(globMod.globToolDef)
  registerToolDef(grepMod.grepToolDef)

  // Agent tool
  registerToolDef(agentMod.agentToolDef)

  // User interaction
  registerToolDef(askMod.askToolDef)

  // Task management
  registerToolDef(todoMod.todoToolDef)

  // Web tools
  registerToolDef(webFetchMod.webFetchToolDef)
  registerToolDef(webSearchMod.webSearchToolDef)

  // Plan mode (exports two ToolDefs)
  registerToolDef(planModeMod.enterPlanModeToolDef)
  registerToolDef(planModeMod.exitPlanModeToolDef)

  // Notebook editing
  registerToolDef(notebookEditMod.notebookEditToolDef)

  // MCP tools are registered dynamically via wrapMcpTool, not here.
  // The mcpMod is imported to make its exports available.

  // Skill tool (loaded with catch in case skills module not ready)
  if (skillMod && (skillMod as any).skillToolDef) {
    registerToolDef((skillMod as any).skillToolDef)
  }

  _initialized = true
  return getAllTools()
}

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

/**
 * Clear the registry. Primarily for testing.
 */
export function resetRegistry(): void {
  _registry.clear()
  _initialized = false
}

// ---------------------------------------------------------------------------
// Tool Filtering Utilities
// ---------------------------------------------------------------------------

/**
 * Get only read-only tools (useful for plan mode / explore sub-agents).
 * Note: isReadOnly depends on input, so this checks with undefined input.
 * For accurate filtering, use the tool's isReadOnly(input) at call time.
 */
export function getReadOnlyToolNames(): string[] {
  return getAllTools()
    .filter((t) => {
      try {
        return t.isReadOnly(undefined as any)
      } catch {
        return false
      }
    })
    .map((t) => t.name)
}

/**
 * Filter tools by name allowlist.
 */
export function filterToolsByName(names: string[]): Tool[] {
  const nameSet = new Set(names)
  return getAllTools().filter((t) => nameSet.has(t.name))
}

/**
 * Filter tools by name blocklist.
 */
export function excludeToolsByName(names: string[]): Tool[] {
  const nameSet = new Set(names)
  return getAllTools().filter((t) => !nameSet.has(t.name))
}

// ---------------------------------------------------------------------------
// Tool Description Helper
// ---------------------------------------------------------------------------

/**
 * Generate a summary of all registered tools for system prompts.
 */
export function generateToolSummary(): string {
  const tools = getAllTools()
  if (tools.length === 0) return '(No tools registered)'

  const lines: string[] = ['Available tools:']
  for (const tool of tools) {
    const desc = typeof tool.description === 'function'
      ? tool.description()
      : tool.description
    lines.push(`  - ${tool.name}: ${desc}`)
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type { Tool, ToolDef } from '../core/types.js'
