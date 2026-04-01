/**
 * NanoCode — ANSI Formatting Utilities
 *
 * Terminal color helpers, tool result formatting, thinking display,
 * cost display, and unified diff with color.
 */

import type { CostTracker, ModelConfig } from '../core/types.js'

// ---------------------------------------------------------------------------
// ANSI escape sequences
// ---------------------------------------------------------------------------

const ESC = '\x1b['
const RESET = `${ESC}0m`

// ---------------------------------------------------------------------------
// NanoCode Brand Colors (RGB)
//   Primary:  soft blue  rgb(100,149,237) — text, highlights, suggestions
//   Accent:   warm gold  rgb(230,190,80)  — spinner, icons, accents
// ---------------------------------------------------------------------------

/** Primary brand color — soft blue for text and highlights */
export function blue(s: string): string {
  return `${ESC}38;2;100;149;237m${s}${RESET}`
}

/** Accent brand color — warm gold for spinner/icons */
export function gold(s: string): string {
  return `${ESC}38;2;230;190;80m${s}${RESET}`
}

// Standard ANSI helpers

export function bold(s: string): string {
  return `${ESC}1m${s}${RESET}`
}

export function dim(s: string): string {
  return `${ESC}2m${s}${RESET}`
}

export function red(s: string): string {
  return `${ESC}31m${s}${RESET}`
}

export function yellow(s: string): string {
  return `${ESC}33m${s}${RESET}`
}

export function green(s: string): string {
  return `${ESC}32m${s}${RESET}`
}

export function cyan(s: string): string {
  return `${ESC}36m${s}${RESET}`
}

export function magenta(s: string): string {
  return `${ESC}35m${s}${RESET}`
}

// ---------------------------------------------------------------------------
// Tool output display — bordered blocks
// ---------------------------------------------------------------------------

const MAX_TOOL_LINES = 20
const MAX_TOOL_RESULT_DISPLAY = 2000

export function formatToolStart(toolName: string, summary: string): string {
  return `\n  ${gold('●')} ${bold(blue(toolName))}  ${dim(summary)}\n`
}

export function formatToolResult(toolName: string, result: string, isError = false): string {
  if (!result.trim()) return ''

  const lines = result.split('\n')
  const dot = isError ? red('●') : gold('●')
  const border = dim('  ┃ ')

  // Truncate long output
  let displayLines = lines
  let truncated = false
  if (lines.length > MAX_TOOL_LINES) {
    displayLines = lines.slice(0, MAX_TOOL_LINES)
    truncated = true
  }

  const body = displayLines
    .map((line) => {
      if (line.length > 200) line = line.slice(0, 200) + dim('…')
      return border + (isError ? red(line) : line)
    })
    .join('\n')

  const footer = truncated
    ? `\n  ${dim(`╰─ (${lines.length} lines, ${lines.length - MAX_TOOL_LINES} hidden)`)}`
    : ''

  return body + footer + '\n'
}

export function formatToolError(result: string): string {
  const lines = result.slice(0, 500).split('\n')
  return lines.map((l) => `  ${dim('┃')} ${red(l)}`).join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Gradient Text — character-by-character RGB interpolation
// ---------------------------------------------------------------------------

/**
 * Interpolate between two RGB colors.
 * factor: 0.0 = colorA, 1.0 = colorB
 */
function lerpColor(
  a: [number, number, number],
  b: [number, number, number],
  factor: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * factor),
    Math.round(a[1] + (b[1] - a[1]) * factor),
    Math.round(a[2] + (b[2] - a[2]) * factor),
  ]
}

/**
 * Apply a gradient across a string, character by character.
 * Skips whitespace (no color needed). Only colors visible chars.
 */
export function gradient(text: string, from: [number, number, number], to: [number, number, number]): string {
  // Count visible chars for interpolation
  const chars = [...text]
  const visibleCount = chars.filter((c) => c.trim()).length
  if (visibleCount === 0) return text

  let visIndex = 0
  const result = chars.map((ch) => {
    if (!ch.trim()) return ch // whitespace — no color
    const factor = visibleCount <= 1 ? 0 : visIndex / (visibleCount - 1)
    visIndex++
    const [r, g, b] = lerpColor(from, to, factor)
    return `\x1b[38;2;${r};${g};${b}m${ch}\x1b[0m`
  })

  return result.join('')
}

/**
 * Apply gradient across multiple lines of ASCII art.
 * Gradient goes left-to-right based on column position (not character order).
 */
export function gradientBlock(lines: string[], from: [number, number, number], to: [number, number, number]): string {
  const maxLen = Math.max(...lines.map((l) => l.length), 1)

  return lines.map((line) => {
    const chars = [...line]
    return chars.map((ch, col) => {
      if (!ch.trim()) return ch
      const factor = maxLen <= 1 ? 0 : col / (maxLen - 1)
      const [r, g, b] = lerpColor(from, to, factor)
      return `\x1b[38;2;${r};${g};${b}m${ch}\x1b[0m`
    }).join('')
  }).join('\n')
}

// NanoCode brand gradient: blue → gold
const GRADIENT_FROM: [number, number, number] = [100, 149, 237] // soft blue
const GRADIENT_TO: [number, number, number] = [230, 190, 80]   // warm gold

// ASCII art logo — Gemini-style, "nanocode" in 6 lines
const LOGO_LARGE = [
  ' ███╗   ██╗ █████╗ ███╗   ██╗ ██████╗  ██████╗ ██████╗ ██████╗ ███████╗',
  ' ████╗  ██║██╔══██╗████╗  ██║██╔═══██╗██╔════╝██╔═══██╗██╔══██╗██╔════╝',
  ' ██╔██╗ ██║███████║██╔██╗ ██║██║   ██║██║     ██║   ██║██║  ██║█████╗  ',
  ' ██║╚██╗██║██╔══██║██║╚██╗██║██║   ██║██║     ██║   ██║██║  ██║██╔══╝  ',
  ' ██║ ╚████║██║  ██║██║ ╚████║╚██████╔╝╚██████╗╚██████╔╝██████╔╝███████╗',
  ' ╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝',
]

// Medium version for narrower terminals
const LOGO_MEDIUM = [
  ' ██╗ ██╗████╗ ██╗ ██╗████╗ ████╗ ████╗ ████╗ █████╗',
  ' ███╗██║█╔═█╗███╗██║█╔══█╗█╔══╝█╔═█╗█╔═█╗█╔══╝',
  ' █╔██║████║█╔██║█║ █║█║   █║ █║█║ █║███╗ ',
  ' █║╚█║█╔═█║█║╚█║█║ █║█║   █║ █║█║ █║█╔═╝ ',
  ' █║ ╚║█║ █║█║ ╚║╚███╔╝╚███╗╚███╔╝███╔╝████╗',
  ' ╚╝  ╝╚╝ ╚╝╚╝  ╝ ╚══╝  ╚══╝ ╚══╝ ╚══╝ ╚═══╝',
]

/**
 * Render the NanoCode gradient logo.
 */
export function renderLogo(): string {
  const width = process.stdout.columns || 80
  const logo = width >= 72 ? LOGO_LARGE : LOGO_MEDIUM
  return gradientBlock(logo, GRADIENT_FROM, GRADIENT_TO)
}

// ---------------------------------------------------------------------------
// Box drawing
// ---------------------------------------------------------------------------

export function box(lines: string[]): string {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
  const maxLen = Math.max(...lines.map((l) => stripAnsi(l).length), 20)
  const innerWidth = maxLen + 2 // 1 space padding each side

  const border = (s: string) => gold(dim(s))
  const top = border(`╭${'─'.repeat(innerWidth + 2)}╮`)
  const bot = border(`╰${'─'.repeat(innerWidth + 2)}╯`)
  const body = lines.map((l) => {
    const visLen = stripAnsi(l).length
    const pad = maxLen - visLen
    return border('│') + `  ${l}${' '.repeat(Math.max(0, pad))}  ` + border('│')
  })

  return [top, ...body, bot].join('\n')
}

// ---------------------------------------------------------------------------
// Input prompt — yellow rounded box
// ---------------------------------------------------------------------------

/**
 * Draw a gold horizontal line above the input prompt, full terminal width.
 */
export function drawInputLine(): string {
  const cols = process.stdout.columns || 80
  return gold('─'.repeat(cols)) + '\n'
}

/**
 * The readline prompt string.
 */
export function inputPrompt(): string {
  return `${gold('❯')} `
}

/**
 * Blank line between user input and agent response.
 */
export function closeInputBox(): string {
  return '\n'
}

// ---------------------------------------------------------------------------
// Dividers
// ---------------------------------------------------------------------------

export function divider(text?: string, width = 50): string {
  if (!text) return dim('  ' + '─'.repeat(width))
  const pad = Math.max(2, Math.floor((width - text.length - 2) / 2))
  return dim('─'.repeat(pad) + ' ' + text + ' ' + '─'.repeat(pad))
}

export function costDivider(tracker: CostTracker, config: ModelConfig): string {
  const s = tracker.summary(config)
  return dim(`  ─── ${s} ───`)
}

// ---------------------------------------------------------------------------
// Markdown-lite rendering
// ---------------------------------------------------------------------------

export function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let codeBlockLang = ''

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeBlockLang = line.trimStart().slice(3).trim()
        result.push(dim(`  ┌─ ${codeBlockLang || 'code'} ${'─'.repeat(Math.max(1, 40 - (codeBlockLang || 'code').length))}`))
        continue
      } else {
        inCodeBlock = false
        result.push(dim('  └' + '─'.repeat(44)))
        continue
      }
    }

    if (inCodeBlock) {
      result.push(dim('  │ ') + line)
      continue
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      result.push('')
      result.push(bold(blue(headingMatch[2]!)))
      continue
    }

    // Blockquotes
    if (line.startsWith('> ')) {
      result.push(dim('  │ ') + dim(line.slice(2)))
      continue
    }

    // Unordered list
    if (line.match(/^\s*[-*]\s+/)) {
      const content = line.replace(/^\s*[-*]\s+/, '')
      const indent = line.match(/^\s*/)?.[0] || ''
      result.push(`${indent}  ${blue('•')} ${inlineMarkdown(content)}`)
      continue
    }

    // Ordered list (1. 2. 3.)
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.+)/)
    if (olMatch) {
      result.push(`${olMatch[1]}  ${blue(olMatch[2] + '.')} ${inlineMarkdown(olMatch[3]!)}`)
      continue
    }

    // Regular text — apply inline formatting
    result.push(inlineMarkdown(line))
  }

  return result.join('\n')
}

function inlineMarkdown(text: string): string {
  // Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, (_m, p1) => bold(p1))
  text = text.replace(/__(.+?)__/g, (_m, p1) => bold(p1))
  // Inline code: `code` — blue + slightly distinct
  text = text.replace(/`([^`]+)`/g, (_m, p1) => blue(p1))
  // File paths with extensions (src/foo.ts, ./bar.js, /usr/bin/node)
  text = text.replace(/(?<![`\w])([.~]?\/[\w\-./]+\.\w+)/g, (_m, p1) => blue(p1))
  // Bare filenames with common extensions
  text = text.replace(/(?<![/\w])(\w[\w\-.]*\.(ts|tsx|js|jsx|json|md|yaml|yml|toml|py|rs|go|java|c|h|cpp|css|html|sh|sql|env|lock|cfg|conf|xml))\b/g, (_m, p1) => blue(p1))
  // URLs
  text = text.replace(/(https?:\/\/[^\s)]+)/g, (_m, p1) => blue(p1))
  // Slash commands: /help, /init etc.
  text = text.replace(/(?<!\w)(\/[a-z][\w-]*)\b/g, (_m, p1) => bold(blue(p1)))
  // @mentions
  text = text.replace(/@([\w\-./]+)/g, (_m, p1) => bold(blue('@' + p1)))
  // CLI commands and tools (npm, git, node, etc.) — when followed by a subcommand or flag
  text = text.replace(/(?<!\w)(npm|npx|yarn|pnpm|git|node|python|pip|cargo|go|docker|make|curl|wget|brew|apt|sudo)\s+([\w\-]+)/g,
    (_m, cmd, sub) => `${blue(cmd)} ${blue(sub)}`)
  // Identifiers: camelCase, PascalCase, snake_case with 2+ segments — likely code references
  text = text.replace(/(?<!\w)([a-z]\w*[A-Z]\w*)\b/g, (_m, p1) => blue(p1))  // camelCase
  text = text.replace(/(?<!\w)([A-Z][a-z]+[A-Z]\w*)\b/g, (_m, p1) => blue(p1))  // PascalCase
  text = text.replace(/(?<!\w)([a-z]+_[a-z_]+)\b/g, (_m, p1) => blue(p1))  // snake_case
  // Dotted identifiers (object.method, package.name)
  text = text.replace(/(?<!\w)(\w+\.\w+(?:\.\w+)*)\(\)/g, (_m, p1) => blue(p1) + '()')  // foo.bar()
  text = text.replace(/(?<![.\w])(\w+(?:\.\w+){2,})\b/g, (_m, p1) => blue(p1))  // a.b.c (3+ segments)
  // Flags and options (--flag, -f)
  text = text.replace(/(?<!\w)(--[\w][\w-]*|-[a-zA-Z])\b/g, (_m, p1) => blue(p1))
  // Numbers with units or standalone significant numbers
  text = text.replace(/\b(\d+(?:\.\d+)?)\s*(ms|s|min|MB|KB|GB|TB|bytes?|tokens?|lines?|files?|%)\b/g,
    (_m, num, unit) => `${blue(num)} ${unit}`)
  return text
}

// ---------------------------------------------------------------------------
// Thinking output formatting
// ---------------------------------------------------------------------------

/**
 * Format thinking/reasoning output as dimmed text.
 */
export function formatThinking(text: string): string {
  const lines = text.split('\n')
  const formatted = lines.map((line) => dim(`  ${line}`))
  return formatted.join('\n')
}

// ---------------------------------------------------------------------------
// Cost display
// ---------------------------------------------------------------------------

/**
 * Format cost tracker data for display.
 */
export function formatCost(tracker: CostTracker, config: ModelConfig): string {
  return dim(tracker.summary(config))
}

// ---------------------------------------------------------------------------
// Unified diff with colors
// ---------------------------------------------------------------------------

/**
 * Generate a simple unified diff between two strings, with ANSI colors.
 *
 * - Added lines shown in green with "+"
 * - Removed lines shown in red with "-"
 * - Context lines shown with " "
 *
 * This is a simplified line-level diff (not a proper Myers diff),
 * suitable for displaying file changes.
 *
 * @param oldText  Original text
 * @param newText  Modified text
 * @returns        Colored diff string
 */
export function formatDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')

  // Build a simple LCS-based diff
  const diff = computeLineDiff(oldLines, newLines)

  const output: string[] = []

  for (const entry of diff) {
    switch (entry.type) {
      case 'equal':
        output.push(dim(`  ${entry.line}`))
        break
      case 'insert':
        output.push(green(`+ ${entry.line}`))
        break
      case 'delete':
        output.push(red(`- ${entry.line}`))
        break
    }
  }

  return output.join('\n')
}

// ---------------------------------------------------------------------------
// Simple line diff (LCS-based)
// ---------------------------------------------------------------------------

interface DiffEntry {
  type: 'equal' | 'insert' | 'delete'
  line: string
}

/**
 * Compute a line-level diff using a simplified LCS approach.
 *
 * For large files this is O(N*M); adequate for typical file sizes
 * shown in a terminal context.
 */
function computeLineDiff(oldLines: string[], newLines: string[]): DiffEntry[] {
  const m = oldLines.length
  const n = newLines.length

  // For very large inputs, fall back to a simpler approach
  if (m * n > 1_000_000) {
    return fallbackDiff(oldLines, newLines)
  }

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0),
  )

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  // Backtrack to build diff
  const result: DiffEntry[] = []
  let i = m
  let j = n

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'equal', line: oldLines[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'insert', line: newLines[j - 1] })
      j--
    } else {
      result.push({ type: 'delete', line: oldLines[i - 1] })
      i--
    }
  }

  return result.reverse()
}

/**
 * Fallback diff for very large files: show all old lines as deletions
 * and all new lines as insertions.
 */
function fallbackDiff(oldLines: string[], newLines: string[]): DiffEntry[] {
  const result: DiffEntry[] = []
  for (const line of oldLines) {
    result.push({ type: 'delete', line })
  }
  for (const line of newLines) {
    result.push({ type: 'insert', line })
  }
  return result
}
