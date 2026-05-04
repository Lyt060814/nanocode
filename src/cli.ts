#!/usr/bin/env node
/**
 * nanocode CLI Entry Point
 *
 * Simple REPL + one-shot mode.
 * Key patterns from Claude Code: cli.tsx, main.tsx, REPL.tsx
 */

import * as readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import type {
  Message,
  StreamEvent,
  QueryParams,
  ModelConfig,
  CostTracker,
  PermissionDecision,
  PermissionMode,
  SystemPromptBlock,
} from './core/types.js'
import { agentLoop } from './core/agent.js'
import { getModelConfig } from './core/api.js'
import { createFileStateCache } from './files/cache.js'
import { createFileHistoryState } from './files/history.js'
import { buildSystemPromptBlocks } from './prompt/system.js'
import { loadClaudeMd } from './context/memory.js'
import { getGitContext } from './context/git-context.js'
import { createCostTracker } from './utils/cost.js'
import {
  formatToolStart, formatToolResult, formatToolError,
  formatThinking, costDivider, renderMarkdown, renderLogo,
  box, divider, dim, bold, red, yellow, green, cyan, blue, gold,
  drawInputLine, inputPrompt, closeInputBox,
} from './utils/format.js'
import { spinner, type SpinnerHandle } from './utils/streaming.js'
import {
  createCompleterState, updateSuggestions, selectNext, selectPrevious,
  acceptSuggestion, dismissSuggestions, renderSuggestions, clearRenderedSuggestions,
  type CompleterState,
} from './utils/completer.js'

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  model: string
  apiKey: string
  prompt?: string
  maxTurns?: number
  permissionMode: PermissionMode
  resume?: string
  cwd: string
  enableThinking: boolean
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  const result: CliArgs = {
    model: process.env.ANTHROPIC_MODEL || process.env.MY_MODEL ||'sonnet',
    apiKey: process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY || process.env.MY_API_KEY || '',
    permissionMode: 'default',
    cwd: process.cwd(),
    enableThinking: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '-p':
      case '--prompt':
        result.prompt = args[++i]
        break
      case '-m':
      case '--model':
        result.model = args[++i] || result.model
        break
      case '--api-key':
        result.apiKey = args[++i] || result.apiKey
        break
      case '--max-turns':
        result.maxTurns = parseInt(args[++i] || '200', 10)
        break
      case '--permission-mode':
        result.permissionMode = (args[++i] || 'default') as PermissionMode
        break
      case '--dangerously-skip-permissions':
        result.permissionMode = 'bypassPermissions'
        break
      case '--resume':
        result.resume = args[++i]
        break
      case '--thinking':
        result.enableThinking = true
        break
      case '--help':
      case '-h':
        result.prompt = '__HELP__'
        return result
      case '--version':
        console.log('nanocode 0.1.0')
        process.exit(0)
      default:
        if (!arg?.startsWith('-') && !result.prompt) {
          result.prompt = arg
        }
    }
  }

  return result
}

async function printHelp(): Promise<void> {
  let commandLines: string
  try {
    const { getCommandInfoList } = await import('./commands/index.js')
    const cmds = getCommandInfoList()
    commandLines = cmds.map((c: { name: string; description: string }) => `  /${c.name.padEnd(12)} ${c.description}`).join('\n')
  } catch {
    commandLines = '  (run /help in REPL for full command list)'
  }
  console.log(`
${bold('nanocode')} — Lightweight Claude Code clone

${bold('Usage:')}
  nanocode [options]           Start interactive REPL
  nanocode -p "prompt"         One-shot mode

${bold('Options:')}
  -p, --prompt <text>          Run single prompt and exit
  -m, --model <model>          Model name (default: sonnet)
  --api-key <key>              API key (or set ANTHROPIC_API_KEY)
  --max-turns <n>              Max agent turns (default: 200)
  --permission-mode <mode>     default|plan|acceptEdits|bypassPermissions
  --dangerously-skip-permissions  Bypass all permission checks
  --thinking                   Enable extended thinking
  --resume <session-id>        Resume a previous session
  -h, --help                   Show this help
  --version                    Show version

${bold('Slash Commands:')}
${commandLines}
`)
}

// ---------------------------------------------------------------------------
// Permission Request Handler
// ---------------------------------------------------------------------------

function createPermissionHandler(
  rl: readline.Interface | null,
): (tool: string, input: unknown, message: string) => Promise<PermissionDecision> {
  const alwaysAllowed = new Set<string>()

  return async (tool, input, message) => {
    if (!rl) {
      return { behavior: 'allow' } // Headless mode
    }

    // Check if tool was already "always allowed"
    if (alwaysAllowed.has(tool)) {
      return { behavior: 'allow' }
    }

    return new Promise((resolve) => {
      const prompt = `\n  ${gold('⚡')} ${bold('Allow')} ${message}\n  ${dim('[y] Yes  [n] No  [a] Always')} > `
      rl.question(prompt, (answer) => {
        const a = (answer || 'y').toLowerCase().trim()
        if (a === 'n' || a === 'no') {
          resolve({ behavior: 'deny', message: 'User denied' })
        } else if (a === 'a' || a === 'always') {
          alwaysAllowed.add(tool)
          resolve({ behavior: 'allow' })
        } else {
          resolve({ behavior: 'allow' })
        }
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Stream Event Display
// ---------------------------------------------------------------------------

let activeSpinner: SpinnerHandle | null = null
let assistantTextBuffer = ''  // Buffer for markdown rendering
let assistantTextStarted = false

function stopSpinner(): void {
  if (activeSpinner) { activeSpinner.stop(); activeSpinner = null }
}

function startSpinner(): void {
  stopSpinner()
  if (process.stdout.isTTY) {
    activeSpinner = spinner()
  }
}

/**
 * Flush buffered assistant text with markdown rendering.
 * Called when we have complete lines to render.
 */
function flushAssistantText(): void {
  if (!assistantTextBuffer) return
  // Find last newline — render complete lines, keep partial
  const lastNl = assistantTextBuffer.lastIndexOf('\n')
  if (lastNl === -1) return // No complete lines yet

  const complete = assistantTextBuffer.slice(0, lastNl + 1)
  assistantTextBuffer = assistantTextBuffer.slice(lastNl + 1)
  process.stdout.write(renderMarkdown(complete))
}

/**
 * Flush all remaining buffered text (at end of message).
 */
function flushAllAssistantText(): void {
  if (!assistantTextBuffer) return
  process.stdout.write(renderMarkdown(assistantTextBuffer))
  assistantTextBuffer = ''
}

/**
 * Colorize diff output from Edit tool results.
 */
function colorizeDiff(result: string): string {
  return result.split('\n').map(line => {
    if (line.startsWith('+') && !line.startsWith('+++')) return green(line)
    if (line.startsWith('-') && !line.startsWith('---')) return red(line)
    if (line.startsWith('@@')) return cyan(line)
    return line
  }).join('\n')
}

function displayEvent(event: StreamEvent, costTracker: CostTracker, modelConfig: ModelConfig): void {
  switch (event.type) {
    case 'assistant_text':
      stopSpinner()
      if (!assistantTextStarted) {
        assistantTextStarted = true
      }
      // Buffer text for markdown rendering on complete lines
      assistantTextBuffer += event.text
      flushAssistantText()
      break

    case 'thinking':
      stopSpinner()
      process.stdout.write(formatThinking(event.text))
      break

    case 'tool_start':
      // Flush any remaining assistant text before tool output
      flushAllAssistantText()
      stopSpinner()
      assistantTextStarted = false
      process.stdout.write(formatToolStart(event.toolName, summarizeInput(event.toolName, event.input)))
      break

    case 'tool_result': {
      let output = event.result
      // Colorize diff for Edit tool
      if (event.toolName === 'Edit' && (output.includes('@@ ') || output.includes('+') || output.includes('-'))) {
        output = colorizeDiff(output)
      }
      if (event.isError) {
        process.stdout.write(formatToolError(output))
      } else {
        process.stdout.write(formatToolResult(event.toolName, output, event.isError))
      }
      // Start spinner while waiting for next API response
      startSpinner()
      break
    }

    case 'compact':
      stopSpinner()
      process.stdout.write(
        `\n  ${yellow(`[compact]`)} ${dim(`${event.oldTokens} → ${event.newTokens} tokens`)}\n`,
      )
      break

    case 'usage':
      costTracker.add(event.usage)
      break

    case 'error':
      stopSpinner()
      process.stderr.write(red(`\n  Error: ${event.error.message}\n`))
      break

    case 'max_turns_reached':
      stopSpinner()
      process.stdout.write(
        yellow(`\n  Max turns reached (${event.maxTurns}). Use /compact or continue.\n`),
      )
      break

    case 'assistant_message':
      stopSpinner()
      flushAllAssistantText()
      break

    case 'turn_complete':
      stopSpinner()
      flushAllAssistantText()
      assistantTextStarted = false
      process.stdout.write('\n')
      break
  }
}

function summarizeInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return String(input.command || '').slice(0, 200)
    case 'Read':
    case 'Edit':
    case 'Write':
      return String(input.file_path || '')
    case 'Glob':
      return String(input.pattern || '')
    case 'Grep':
      return `${input.pattern} ${input.path || ''}`
    case 'Agent':
      return String(input.description || input.prompt || '').slice(0, 100)
    default:
      return JSON.stringify(input).slice(0, 100)
  }
}

// ---------------------------------------------------------------------------
// Slash Command Handler — delegates to commands/index.ts
// ---------------------------------------------------------------------------

import { executeCommand } from './commands/index.js'
import type { CommandContext } from './core/types.js'

/**
 * Build a CommandContext that bridges cli.ts local state into the
 * commands/index.ts interface. Callbacks mutate cli state via closures.
 */
function buildCommandContext(
  messages: Message[],
  state: SessionState,
  costTracker: CostTracker,
  readFileState: ReturnType<typeof createFileStateCache>,
  fileHistory: ReturnType<typeof createFileHistoryState>,
  tools: import('./core/types.js').Tool[],
  setMessages: (msgs: Message[]) => void,
): CommandContext {
  return {
    messages,
    tools,
    modelConfig: state.modelConfig,
    cwd: state.cwd,
    sessionId: state.sessionId,
    costTracker,
    fileHistory,
    readFileState,
    permissionMode: state.permissionMode,
    setPermissionMode: (mode: PermissionMode) => {
      state.permissionMode = mode
    },
    setModel: (model: string) => {
      state.modelConfig = getModelConfig(model)
    },
    clearMessages: () => {
      setMessages([])
    },
    compact: async () => {
      const sp = spinner('Compacting...')
      try {
        const { compact } = await import('./context/compaction.js')
        const { createClient } = await import('./core/api.js')
        const callModelForCompact = async (
          systemPrompt: string,
          userMessage: string,
          model: string,
          apiKey: string,
        ): Promise<string> => {
          const client = createClient(apiKey)
          const response = await client.messages.create({
            model,
            max_tokens: 8000,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
          })
          const textBlock = response.content.find((b: any) => b.type === 'text') as any
          return textBlock?.text || ''
        }
        const result = await compact(messages, {
          apiKey: state.apiKey,
          model: state.modelConfig.model,
          systemPromptBlocks: state.systemPromptBlocks,
        }, callModelForCompact)
        sp.stop()
        setMessages(result.compacted)
        console.log(green(`Compacted: ${result.oldTokens} → ${result.newTokens} tokens`))
      } catch (err) {
        sp.stop()
        throw err
      }
    },
    resumeSession: async (targetSessionId: string): Promise<string | null> => {
      const { loadSession } = await import('./context/session.js')
      const loaded = await loadSession(targetSessionId)
      if (loaded.length === 0) return `Session ${targetSessionId.slice(0, 8)} is empty or not found.`
      setMessages(loaded)
      state.sessionId = targetSessionId
      return null
    },
    sendPrompt: (prompt: string) => {
      _pendingPrompt = prompt
    },
  }
}

/** Prompt-type commands (like /init) set this; processInput picks it up */
let _pendingPrompt: string | null = null

async function handleSlashCommand(
  input: string,
  messages: Message[],
  costTracker: CostTracker,
  state: SessionState,
  readFileState: ReturnType<typeof createFileStateCache>,
  fileHistory: ReturnType<typeof createFileHistoryState>,
  tools: import('./core/types.js').Tool[],
  setMessages: (msgs: Message[]) => void,
): Promise<void> {
  const [cmd, ...rest] = input.slice(1).split(' ')
  const args = rest.join(' ')

  const ctx = buildCommandContext(
    messages, state, costTracker, readFileState, fileHistory, tools, setMessages,
  )

  try {
    const result = await executeCommand(cmd!, args, ctx)
    if (result) {
      console.log(result)
    }
  } catch (err) {
    console.error(red(`Command error: ${err instanceof Error ? err.message : String(err)}`))
  }
}

// ---------------------------------------------------------------------------
// Session State
// ---------------------------------------------------------------------------

interface SessionState {
  sessionId: string
  modelConfig: ModelConfig
  apiKey: string
  cwd: string
  permissionMode: PermissionMode
  systemPromptBlocks: SystemPromptBlock[]
  enableThinking: boolean
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cliArgs = parseArgs()

  // Handle --help (needs async import for command list)
  if (cliArgs.prompt === '__HELP__') {
    await printHelp()
    process.exit(0)
  }

  // Validate API key
  if (!cliArgs.apiKey) {
    console.error(red('Error: ANTHROPIC_API_KEY not set.'))
    console.error(dim('Set it via environment variable or --api-key flag.'))
    process.exit(1)
  }

  const { initSession, saveMessage, loadSession } = await import('./context/session.js')

  const modelConfig = getModelConfig(cliArgs.model)
  const costTracker = createCostTracker()
  const readFileState = createFileStateCache()
  const fileHistory = createFileHistoryState()

  // Handle --resume: load previous session or create new
  let sessionId: string
  let resumedMessages: Message[] = []
  if (cliArgs.resume) {
    sessionId = cliArgs.resume
    resumedMessages = await loadSession(sessionId)
    if (resumedMessages.length === 0) {
      console.error(red(`Session ${sessionId} not found or empty.`))
      process.exit(1)
    }
  } else {
    sessionId = randomUUID()
  }

  // Load context
  const claudeMd = await loadClaudeMd(cliArgs.cwd).catch(() => '')
  const gitContext = await getGitContext(cliArgs.cwd).catch(() => '')
  const systemPromptBlocks = buildSystemPromptBlocks({
    claudeMd: claudeMd || '',
    gitContext: gitContext || '',
    cwd: cliArgs.cwd,
    model: modelConfig.model,
  })

  const state: SessionState = {
    sessionId,
    modelConfig,
    apiKey: cliArgs.apiKey,
    cwd: cliArgs.cwd,
    permissionMode: cliArgs.permissionMode,
    systemPromptBlocks,
    enableThinking: cliArgs.enableThinking,
  }

  // Session is lazily initialized on first saveMessage — no eager creation
  let sessionInitialized = false
  const persistMessage = async (msg: Message) => {
    if (!sessionInitialized) {
      await initSession(sessionId, cliArgs.cwd)
      sessionInitialized = true
    }
    await saveMessage(sessionId, msg)
  }

  // One-shot mode
  if (cliArgs.prompt) {
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: cliArgs.prompt }],
        id: randomUUID(),
      },
    ]

    startSpinner()
    await runAgent(messages, state, costTracker, readFileState, fileHistory, null)
    stopSpinner()
    console.log('\n' + costDivider(costTracker, modelConfig))
    return
  }

  // REPL mode — logo + info panel
  const shortCwd = cliArgs.cwd.replace(process.env.HOME || '', '~')
  console.log('')
  console.log(renderLogo())
  console.log(box([
    gold(bold('nanocode')) + dim(' v0.1.0'),
    `${dim('Model:')} ${modelConfig.model}`,
    `${dim('CWD:')}   ${shortCwd}`,
  ]))
  console.log(dim('  /help for commands · Ctrl+C abort · Ctrl+D exit\n'))

  // Pre-load tools once for both commands and agent
  const { initializeTools } = await import('./tools/registry.js')
  const tools = await initializeTools()

  const completerState = createCompleterState()
  let renderedLines = 0
  let pendingEnterBlock = false

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: inputPrompt(),
    completer: (line: string) => {
      // Tab completion handler
      if (completerState.visible && completerState.suggestions.length > 0) {
        const newLine = acceptSuggestion(completerState, line)
        clearSuggestionDisplay()
        return [[newLine], line]
      }
      // Trigger suggestions on Tab if nothing visible
      updateSuggestions(completerState, line, cliArgs.cwd)
      if (completerState.visible) {
        showSuggestionDisplay()
        return [[], line]
      }
      return [[], line]
    },
  })

  // Dynamic prompt: when input starts with / or @, switch to blue-tinted prompt
  // The trick: append an unclosed blue ANSI code to the prompt, so typed text inherits the color
  const PROMPT_NORMAL = inputPrompt()
  const BLUE_OPEN = '\x1b[1;38;2;100;149;237m' // bold blue — intentionally unclosed
  const PROMPT_BLUE = inputPrompt() + BLUE_OPEN
  let currentPromptIsBlue = false

  function showSuggestionDisplay(): void {
    if (!process.stdout.isTTY) return
    clearSuggestionDisplay()
    const { output, lineCount } = renderSuggestions(completerState)
    if (output) {
      process.stdout.write(output)
      renderedLines = lineCount
    }
  }

  function clearSuggestionDisplay(): void {
    if (renderedLines > 0) {
      process.stdout.write(clearRenderedSuggestions(renderedLines))
      renderedLines = 0
    }
  }

  // Multi-line input buffer: Shift+Enter adds a newline, plain Enter submits
  let multiLineBuffer: string[] = []
  let isMultiLine = false

  // Listen for keypress to show live suggestions and handle Shift+Enter
  if (process.stdin.isTTY) {
    process.stdin.on('keypress', (_ch: string, key: any) => {
      if (processing || !key) return

      // Option+Enter (meta) or Shift+Enter → insert newline
      if (key.name === 'return' && (key.meta || key.shift)) {
        const currentLine = (rl as any).line || ''
        multiLineBuffer.push(currentLine)
        isMultiLine = true
        ;(rl as any).line = ''
        ;(rl as any).cursor = 0
        process.stdout.write('\n' + dim('… '))
        return
      }

      // Arrow up/down to navigate suggestions
      if (completerState.visible) {
        if (key.name === 'up') {
          selectPrevious(completerState)
          showSuggestionDisplay()
          return
        }
        if (key.name === 'down') {
          selectNext(completerState)
          showSuggestionDisplay()
          return
        }
        if (key.name === 'escape') {
          dismissSuggestions(completerState)
          clearSuggestionDisplay()
          return
        }
      }

      // Update prompt color and suggestions on any regular keypress
      setImmediate(() => {
        const line = (rl as any).line || ''

        // Switch prompt to blue only for /commands (whole line is the command)
        const wantBlue = line.startsWith('/')
        if (wantBlue && !currentPromptIsBlue) {
          currentPromptIsBlue = true
          rl.setPrompt(PROMPT_BLUE)
          ;(rl as any)._refreshLine()
        } else if (!wantBlue && currentPromptIsBlue) {
          currentPromptIsBlue = false
          rl.setPrompt(PROMPT_NORMAL)
          ;(rl as any)._refreshLine()
        }

        // Update suggestions AFTER prompt refresh so they render on top
        updateSuggestions(completerState, line, cliArgs.cwd)
        if (completerState.visible) {
          showSuggestionDisplay()
        } else {
          clearSuggestionDisplay()
        }
      })
    })
  }

  let messages: Message[] = resumedMessages
  if (resumedMessages.length > 0) {
    console.log(dim(`  Resumed session ${sessionId.slice(0, 8)} (${resumedMessages.length} messages)\n`))
  }
  let processing = false
  let currentAbort: AbortController | null = null
  const inputQueue: string[] = []

  // Handle Ctrl+C at REPL level: abort generation, don't exit
  rl.on('SIGINT', () => {
    if (processing && currentAbort) {
      currentAbort.abort()
      process.stdout.write(dim('\n[interrupted]\n'))
    } else {
      dismissSuggestions(completerState)
      clearSuggestionDisplay()
      process.stdout.write('\n' + dim('(Ctrl+D to exit)') + '\n')
      rl.prompt()
    }
  })

  const promptUser = () => {
    if (!processing) {
      process.stdout.write(drawInputLine())
      rl.prompt()
    }
  }

  const processInput = async (input: string) => {
    // Clear any visible suggestions
    dismissSuggestions(completerState)
    clearSuggestionDisplay()

    if (!input) {
      promptUser()
      return
    }

    // Reset prompt color and ANSI state after submission
    if (currentPromptIsBlue) {
      currentPromptIsBlue = false
      rl.setPrompt(PROMPT_NORMAL)
      process.stdout.write('\x1b[0m') // close the unclosed blue
    }

    processing = true

    // Slash commands — delegates to commands/index.ts via handleSlashCommand
    if (input.startsWith('/')) {
      process.stdout.write(closeInputBox())
      _pendingPrompt = null
      await handleSlashCommand(
        input,
        messages,
        costTracker,
        state,
        readFileState,
        fileHistory,
        tools,
        (newMsgs) => { messages = newMsgs },
      )
      // Check if the command injected a prompt (e.g. /init)
      if (_pendingPrompt) {
        const prompt = _pendingPrompt
        _pendingPrompt = null
        processing = false
        await processInput(prompt)
        return
      }
      processing = false
      promptUser()
      return
    }

    // Skip past the pre-drawn bottom border
    process.stdout.write(closeInputBox())

    // Add user message
    const userMsg: Message = {
      role: 'user',
      content: [{ type: 'text', text: input }],
      id: randomUUID(),
    }
    messages.push(userMsg)
    persistMessage(userMsg).catch(() => {})

    // Run agent with abort support
    // Start spinner while waiting for API
    startSpinner()
    currentAbort = new AbortController()
    messages = await runAgent(
      messages,
      state,
      costTracker,
      readFileState,
      fileHistory,
      rl,
      currentAbort.signal,
      tools,
      (msg) => persistMessage(msg).catch(() => {}),
    )
    currentAbort = null

    // Show cost divider
    console.log(costDivider(costTracker, state.modelConfig))
    processing = false

    // Process queued input
    if (inputQueue.length > 0) {
      const next = inputQueue.shift()!
      await processInput(next)
    } else {
      promptUser()
    }
  }

  rl.on('line', (line) => {
    // If suggestions are visible and user hasn't typed a complete command,
    // Enter accepts the suggestion instead of submitting.
    if (!completerState.visible) {
      updateSuggestions(completerState, line, cliArgs.cwd)
    }
    if (completerState.visible && completerState.suggestions.length > 0) {
      // Don't intercept if the input is already a complete slash command or message
      const isCompleteCommand = line.startsWith('/') && line.includes(' ')
      const isExactCommand = line.startsWith('/') &&
        completerState.suggestions.some(s => s.value.trim() === line.trim())
      if (!isCompleteCommand && !isExactCommand) {
        const newLine = acceptSuggestion(completerState, line)
        clearSuggestionDisplay()
        // readline already moved to a new line after Enter.
        // Move cursor up to overwrite, then redisplay with accepted content.
        process.stdout.write('\x1b[A\r\x1b[K')
        ;(rl as any).line = newLine
        ;(rl as any).cursor = newLine.length
        ;(rl as any)._refreshLine()
        return
      }
      // Complete command — fall through to execute it
      dismissSuggestions(completerState)
      clearSuggestionDisplay()
    }
    // Backslash continuation: line ending with \ → buffer and wait for more
    if (line.endsWith('\\') && !line.endsWith('\\\\')) {
      multiLineBuffer.push(line.slice(0, -1)) // strip trailing \
      isMultiLine = true
      process.stdout.write(dim('… '))
      return
    }

    // Assemble final input: join buffered lines + current line
    let fullInput: string
    if (isMultiLine) {
      multiLineBuffer.push(line)
      fullInput = multiLineBuffer.join('\n').trim()
      multiLineBuffer = []
      isMultiLine = false
    } else {
      fullInput = line.trim()
    }

    if (processing) {
      inputQueue.push(fullInput)
    } else {
      processInput(fullInput)
    }
  })

  let closing = false
  rl.on('close', () => {
    closing = true
    // Don't exit immediately — wait for any in-flight processing
    const checkAndExit = () => {
      if (!processing) {
        console.log(dim('\nGoodbye!'))
        process.exit(0)
      } else {
        setTimeout(checkAndExit, 100)
      }
    }
    checkAndExit()
  })

  promptUser()
}

async function runAgent(
  messages: Message[],
  state: SessionState,
  costTracker: CostTracker,
  readFileState: ReturnType<typeof createFileStateCache>,
  fileHistory: ReturnType<typeof createFileHistoryState>,
  rl: readline.Interface | null,
  abortSignal?: AbortSignal,
  preloadedTools?: import('./core/types.js').Tool[],
  persistMessage?: (msg: Message) => void,
): Promise<Message[]> {
  // Use pre-loaded tools if available, otherwise lazy-load
  let tools: import('./core/types.js').Tool[]
  if (preloadedTools) {
    tools = preloadedTools
  } else {
    const { initializeTools } = await import('./tools/registry.js')
    tools = await initializeTools()
  }

  const abortController = new AbortController()
  // Chain external abort signal
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => abortController.abort(), { once: true })
  }

  const params: QueryParams = {
    messages,
    tools,
    modelConfig: state.modelConfig,
    systemPromptBlocks: state.systemPromptBlocks,
    maxTurns: 200,
    permissionMode: state.permissionMode,
    apiKey: state.apiKey,
    cwd: state.cwd,
    sessionId: state.sessionId,
    onPermissionRequest: createPermissionHandler(rl),
    abortSignal: abortController.signal,
    enableThinking: state.enableThinking,
    readFileState,
    fileHistory,
  }

  let finalMessages = messages
  const initialLen = messages.length

  try {
    const gen = agentLoop(params)
    while (true) {
      const { value, done } = await gen.next()
      if (done) {
        finalMessages = value as Message[]
        break
      }
      displayEvent(value as StreamEvent, costTracker, state.modelConfig)
    }
  } catch (err) {
    console.error(red(`\nFatal: ${err instanceof Error ? err.message : String(err)}`))
  }

  // Persist new messages (assistant + tool results added by agent loop)
  if (persistMessage) {
    for (let i = initialLen; i < finalMessages.length; i++) {
      persistMessage(finalMessages[i]!)
    }
  }

  return finalMessages
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(red(`Fatal error: ${err.message}`))
  process.exit(1)
})
