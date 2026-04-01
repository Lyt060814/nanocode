/**
 * Slash Commands — User-facing commands prefixed with /
 *
 * This is the SINGLE SOURCE OF TRUTH for all slash commands.
 * cli.ts delegates here via executeCommand(). completer.ts imports
 * getCommandInfoList() for autocomplete suggestions.
 */

import type { SlashCommand, CommandContext } from '../core/types.js'
import { blue, bold, dim, gold, green, yellow } from '../utils/format.js'

// ---------------------------------------------------------------------------
// Command Implementations
// ---------------------------------------------------------------------------

const helpCommand: SlashCommand = {
  name: 'help',
  description: 'Show available commands',
  async execute(_args, _ctx) {
    const lines = [
      'Available commands:',
      '',
      ...commands.map((c) => `  ${blue('/' + c.name.padEnd(12))} ${c.description}`),
      '',
      dim('Type a message to start a conversation with the agent.'),
    ]
    return lines.join('\n')
  },
}

const compactCommand: SlashCommand = {
  name: 'compact',
  description: 'Compact conversation context',
  async execute(_args, ctx) {
    if (ctx.messages.length === 0) return 'Nothing to compact.'
    await ctx.compact()
  },
}

const clearCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear conversation history',
  async execute(_args, ctx) {
    ctx.clearMessages()
    return 'Conversation cleared.'
  },
}

const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Show or change model',
  async execute(args, ctx) {
    if (args.trim()) {
      ctx.setModel(args.trim())
      return `Model changed to: ${blue(args.trim())}`
    }
    return `Current model: ${blue(ctx.modelConfig.model)}`
  },
}

const costCommand: SlashCommand = {
  name: 'cost',
  description: 'Show token usage and cost',
  async execute(_args, ctx) {
    const tracker = ctx.costTracker
    const config = ctx.modelConfig
    const cost = tracker.totalCostUSD(config)
    return [
      `Model:    ${blue(config.model)}`,
      `Turns:    ${tracker.turns}`,
      `Input:    ${tracker.totalInputTokens.toLocaleString()} tokens`,
      `Output:   ${tracker.totalOutputTokens.toLocaleString()} tokens`,
      `Cache R:  ${tracker.totalCacheReadTokens.toLocaleString()} tokens`,
      `Cache W:  ${tracker.totalCacheCreationTokens.toLocaleString()} tokens`,
      `Cost:     ${gold('$' + cost.toFixed(4))}`,
    ].join('\n')
  },
}


const resumeCommand: SlashCommand = {
  name: 'resume',
  description: 'Resume a previous session',
  async execute(args, ctx) {
    const { listSessions } = await import('../context/session.js')

    if (!args.trim()) {
      const sessions = await listSessions()
      if (sessions.length === 0) return 'No previous sessions found.'
      const lines = ['Recent sessions:', '']
      for (const s of sessions.slice(0, 10)) {
        const date = new Date(s.updatedAt).toLocaleString()
        const shortCwd = s.cwd.replace(process.env.HOME || '', '~') || '(unknown)'
        lines.push(`  ${blue(s.id.slice(0, 8))}  ${dim(date)}  ${shortCwd}  ${dim(`(${s.messageCount} msgs)`)}`)
      }
      lines.push('', dim('Use /resume <session-id-prefix> to resume.'))
      return lines.join('\n')
    }

    const prefix = args.trim().toLowerCase()
    const sessions = await listSessions()
    const match = sessions.find((s) => s.id.toLowerCase().startsWith(prefix))
    if (!match) {
      return `No session found matching "${prefix}".`
    }

    const err = await ctx.resumeSession(match.id)
    if (err) return err
    return `Resumed session ${blue(match.id.slice(0, 8))} (${match.messageCount} messages).`
  },
}

const planCommand: SlashCommand = {
  name: 'plan',
  description: 'Toggle plan mode (read-only)',
  async execute(_args, ctx) {
    if (ctx.permissionMode === 'plan') {
      ctx.setPermissionMode('default')
      return 'Plan mode disabled. All tools available.'
    }
    ctx.setPermissionMode('plan')
    return yellow('Plan mode enabled.') + ' Only read-only tools available.'
  },
}

const memoryCommand: SlashCommand = {
  name: 'memory',
  description: 'Show NANOCODE.md / CLAUDE.md content',
  async execute(_args, ctx) {
    const { loadClaudeMd } = await import('../context/memory.js')
    const content = await loadClaudeMd(ctx.cwd).catch(() => '')
    if (!content) return 'No NANOCODE.md or CLAUDE.md found.'
    const truncated = content.length > 3000
      ? content.slice(0, 3000) + dim(`\n\n... (${content.length} chars total)`)
      : content
    return `${dim('─── NANOCODE.md / CLAUDE.md ───')}\n${truncated}`
  },
}

const configCommand: SlashCommand = {
  name: 'config',
  description: 'Show current configuration',
  async execute(_args, ctx) {
    return [
      `Model:       ${blue(ctx.modelConfig.model)}`,
      `Context:     ${ctx.modelConfig.contextWindow.toLocaleString()} tokens`,
      `Max output:  ${ctx.modelConfig.maxOutputTokens.toLocaleString()} tokens`,
      `Mode:        ${ctx.permissionMode}`,
      `CWD:         ${blue(ctx.cwd)}`,
      `Session:     ${dim(ctx.sessionId.slice(0, 8))}`,
      `Tools:       ${ctx.tools.length} loaded`,
    ].join('\n')
  },
}

const statusCommand: SlashCommand = {
  name: 'status',
  description: 'Show session status',
  async execute(_args, ctx) {
    const { estimateMessageTokens } = await import('../context/token-counting.js')
    const tokenCount = estimateMessageTokens(ctx.messages)
    const threshold = ctx.modelConfig.contextWindow - ctx.modelConfig.maxOutputTokens - 13000
    const pct = Math.round((tokenCount / threshold) * 100)
    return [
      `Session:    ${dim(ctx.sessionId.slice(0, 8))}`,
      `Model:      ${blue(ctx.modelConfig.model)}`,
      `Messages:   ${ctx.messages.length}`,
      `Tokens:     ${tokenCount.toLocaleString()} / ${threshold.toLocaleString()} ${dim(`(${pct}%)`)}`,
      `Mode:       ${ctx.permissionMode}`,
      `CWD:        ${blue(ctx.cwd)}`,
      `Files mod:  ${ctx.fileHistory.trackedFiles.size}`,
      `Snapshots:  ${ctx.fileHistory.snapshots.length}`,
    ].join('\n')
  },
}

const skillsCommand: SlashCommand = {
  name: 'skills',
  description: 'List available skills',
  async execute(_args, ctx) {
    try {
      const { getLoadedSkills, initializeSkills } = await import('../skills/skill-tool.js')
      let skills = getLoadedSkills()
      if (skills.length === 0) {
        await initializeSkills(ctx.cwd)
        skills = getLoadedSkills()
      }
      if (skills.length === 0) return 'No skills loaded. Place skills in .nanocode/skills/ or .claude/skills/ directories.'
      const lines = ['Available skills:', '']
      for (const s of skills) {
        lines.push(`  ${blue(s.name)}  ${dim(s.description || '')}`)
      }
      return lines.join('\n')
    } catch {
      return 'Skills system not initialized.'
    }
  },
}

const contextCommand: SlashCommand = {
  name: 'context',
  description: 'Show context window usage',
  async execute(_args, ctx) {
    const { estimateMessageTokens } = await import('../context/token-counting.js')
    const tokenCount = estimateMessageTokens(ctx.messages)
    const contextWindow = ctx.modelConfig.contextWindow
    const maxOutput = ctx.modelConfig.maxOutputTokens
    const usable = contextWindow - maxOutput - 13000
    const pct = Math.min(100, Math.round((tokenCount / usable) * 100))

    const barWidth = 40
    const filled = Math.round((pct / 100) * barWidth)
    const bar = blue('█'.repeat(filled)) + dim('░'.repeat(barWidth - filled))

    const systemEst = Math.round(ctx.modelConfig.contextWindow * 0.01)
    const toolsEst = ctx.tools.length * 150
    const msgEst = tokenCount - systemEst - toolsEst
    const freeEst = usable - tokenCount

    return [
      `Context Usage  ${blue(ctx.modelConfig.model)}`,
      `[${bar}] ${pct}%`,
      '',
      `  Messages:      ~${Math.max(0, msgEst).toLocaleString()} tokens`,
      `  System prompt: ~${systemEst.toLocaleString()} tokens`,
      `  Tool schemas:  ~${toolsEst.toLocaleString()} tokens`,
      `  Free:          ~${Math.max(0, freeEst).toLocaleString()} tokens`,
      '',
      `  Total: ${tokenCount.toLocaleString()} / ${usable.toLocaleString()}  ${dim('(window: ' + contextWindow.toLocaleString() + ')')}`,
    ].join('\n')
  },
}

const exitCommand: SlashCommand = {
  name: 'exit',
  description: 'Exit nanocode',
  async execute(_args, _ctx) {
    console.log(dim('Goodbye!'))
    process.exit(0)
  },
}

const INIT_PROMPT = `\
Analyze this codebase and create a NANOCODE.md file in the project root.

Do the following:
1. Read key project files to understand the codebase:
   - Package manifests: package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml, etc.
   - Build/CI configs: Makefile, .github/workflows/, Dockerfile, etc.
   - Existing docs: README.md, CONTRIBUTING.md
   - Linter/formatter configs: .eslintrc*, prettier*, ruff.toml, .golangci.yml, etc.
   - Existing AI configs: CLAUDE.md, .cursorrules, .cursor/rules, AGENTS.md, .github/copilot-instructions.md
   - Use Glob and Read tools to explore. Check the directory structure first with Glob.

2. Based on your analysis, write a NANOCODE.md file using the Write tool. The file should be concise (under 100 lines) and include ONLY:
   - Common build, lint, test, and run commands (especially non-standard ones the AI wouldn't guess)
   - Key architectural patterns and conventions
   - Code style rules that differ from language defaults
   - Important gotchas or non-obvious workflows
   - File/directory structure overview if it's not obvious

3. Do NOT include:
   - Obvious things the AI can figure out from reading code (like "this is a TypeScript project")
   - Generic advice that applies to all projects
   - Long explanations — keep it terse, each rule on one line

If NANOCODE.md or CLAUDE.md already exists, read it first, then ask the user if they want to overwrite or merge.
`

const initCommand: SlashCommand = {
  name: 'init',
  description: 'Analyze codebase and generate NANOCODE.md',
  async execute(_args, ctx) {
    ctx.sendPrompt(INIT_PROMPT)
  },
}

const mcpCommand: SlashCommand = {
  name: 'mcp',
  description: 'Show MCP server configuration',
  async execute(_args, ctx) {
    const { loadMcpConfig, getMcpConfigPaths } = await import('../mcp/config.js')
    const paths = getMcpConfigPaths(ctx.cwd)
    const servers = await loadMcpConfig(ctx.cwd)
    const names = Object.keys(servers)

    if (names.length === 0) {
      return [
        'No MCP servers configured.',
        '',
        'Add servers to:',
        `  Project: ${blue(paths.project)}`,
        `  User:    ${blue(paths.user)}`,
        '',
        dim('Example settings.json:'),
        dim('  { "mcpServers": { "my-server": { "command": "npx", "args": ["-y", "..."] } } }'),
      ].join('\n')
    }

    const lines = [`MCP Servers (${names.length}):`, '']
    for (const name of names) {
      const cfg = servers[name]!
      const cmd = [cfg.command, ...(cfg.args || [])].join(' ')
      lines.push(`  ${blue(name)}  ${dim(cmd)}`)
    }
    lines.push('', `Config: ${blue(paths.project)}`)
    return lines.join('\n')
  },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const commands: SlashCommand[] = [
  helpCommand,
  compactCommand,
  clearCommand,
  modelCommand,
  costCommand,
  resumeCommand,
  planCommand,
  memoryCommand,
  configCommand,
  statusCommand,
  skillsCommand,
  contextCommand,
  exitCommand,
  initCommand,
  mcpCommand,
]

export function getCommands(): SlashCommand[] {
  return [...commands]
}

const ALIASES: Record<string, string> = {
  quit: 'exit',
}

export function findCommand(name: string): SlashCommand | undefined {
  let normalized = name.toLowerCase().replace(/^\//, '')
  normalized = ALIASES[normalized] || normalized
  return commands.find((c) => c.name === normalized)
}

export async function executeCommand(
  name: string,
  args: string,
  context: CommandContext,
): Promise<string | void> {
  const cmd = findCommand(name)
  if (!cmd) return `Unknown command: /${name}. Try /help.`
  return cmd.execute(args, context)
}

export function getCommandInfoList(): Array<{ name: string; description: string }> {
  const list = commands.map((c) => ({ name: c.name, description: c.description }))
  // Add aliases
  for (const [alias, target] of Object.entries(ALIASES)) {
    const cmd = commands.find((c) => c.name === target)
    if (cmd) list.push({ name: alias, description: cmd.description })
  }
  return list
}
