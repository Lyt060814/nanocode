/**
 * nanocode — REPL Autocomplete
 *
 * Provides slash command (/) and file mention (@) completion for readline.
 * Uses ANSI escape codes to render an inline suggestion list below the prompt.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { dim, bold, blue } from './format.js'
import { getCommandInfoList } from '../commands/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Suggestion {
  label: string
  description: string
  icon?: string
  value: string // What gets inserted
}

export interface CompleterState {
  suggestions: Suggestion[]
  selectedIndex: number
  visible: boolean
  triggerType: '/' | '@' | null
  triggerPos: number
}

// ---------------------------------------------------------------------------
// Slash Command Suggestions (sourced from commands/index.ts)
// ---------------------------------------------------------------------------

function getCommandSuggestions(partial: string): Suggestion[] {
  const query = partial.toLowerCase()
  return getCommandInfoList()
    .filter((c) => c.name.startsWith(query))
    .map((c) => ({
      label: `/${c.name}`,
      description: c.description,
      icon: '▸',
      value: `/${c.name} `,
    }))
}

// ---------------------------------------------------------------------------
// File Mention Suggestions (@)
// ---------------------------------------------------------------------------

function getFileSuggestions(partial: string, cwd: string, maxResults = 10): Suggestion[] {
  const query = partial.toLowerCase()

  // If partial looks like a path (has /), do directory completion
  if (partial.includes('/') || partial.includes(path.sep)) {
    return getPathCompletions(partial, cwd, maxResults)
  }

  // Otherwise, search all files in cwd (shallow + common subdirs)
  const results: Suggestion[] = []
  try {
    collectFiles(cwd, '', query, results, maxResults, 0, 3)
  } catch {
    // Ignore permission errors
  }
  return results
}

function getPathCompletions(partial: string, cwd: string, maxResults: number): Suggestion[] {
  const fullPath = partial.startsWith('/')
    ? partial
    : path.join(cwd, partial)

  const dir = partial.endsWith('/') ? fullPath : path.dirname(fullPath)
  const prefix = partial.endsWith('/') ? '' : path.basename(partial).toLowerCase()

  const results: Suggestion[] = []
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue // Skip hidden
      if (prefix && !entry.name.toLowerCase().startsWith(prefix)) continue
      if (results.length >= maxResults) break

      const isDir = entry.isDirectory()
      const rel = partial.endsWith('/')
        ? partial + entry.name
        : path.dirname(partial) + '/' + entry.name

      results.push({
        label: entry.name + (isDir ? '/' : ''),
        description: isDir ? 'directory' : getFileSize(path.join(dir, entry.name)),
        icon: isDir ? '+' : ' ',
        value: '@' + rel + (isDir ? '/' : ' '),
      })
    }
  } catch {
    // Directory not readable
  }
  return results
}

function collectFiles(
  base: string,
  rel: string,
  query: string,
  results: Suggestion[],
  max: number,
  depth: number,
  maxDepth: number,
): void {
  if (results.length >= max || depth > maxDepth) return

  const dir = rel ? path.join(base, rel) : base
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= max) return
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue

    const entryRel = rel ? `${rel}/${entry.name}` : entry.name

    if (entry.isDirectory()) {
      // Add directory itself if matches
      if (entry.name.toLowerCase().includes(query)) {
        results.push({
          label: entryRel + '/',
          description: 'directory',
          icon: '+',
          value: '@' + entryRel + '/',
        })
      }
      // Recurse
      collectFiles(base, entryRel, query, results, max, depth + 1, maxDepth)
    } else {
      if (entry.name.toLowerCase().includes(query) || entryRel.toLowerCase().includes(query)) {
        results.push({
          label: entryRel,
          description: getFileSize(path.join(dir, entry.name)),
          icon: ' ',
          value: '@' + entryRel + ' ',
        })
      }
    }
  }
}

function getFileSize(filePath: string): string {
  try {
    const stat = fs.statSync(filePath)
    const kb = stat.size / 1024
    if (kb < 1) return `${stat.size}B`
    if (kb < 1024) return `${Math.round(kb)}KB`
    return `${(kb / 1024).toFixed(1)}MB`
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Suggestion State Manager
// ---------------------------------------------------------------------------

export function createCompleterState(): CompleterState {
  return {
    suggestions: [],
    selectedIndex: 0,
    visible: false,
    triggerType: null,
    triggerPos: 0,
  }
}

/**
 * Update suggestions based on current input and cursor position.
 */
export function updateSuggestions(
  state: CompleterState,
  input: string,
  cwd: string,
): void {
  // Check for slash command at start of input
  if (input.startsWith('/')) {
    const partial = input.slice(1).split(' ')[0] || ''
    // Only show suggestions if no space yet (still typing command name)
    if (!input.includes(' ') || input.indexOf(' ') > input.length - 1) {
      state.suggestions = getCommandSuggestions(partial)
      state.triggerType = '/'
      state.triggerPos = 0
      state.selectedIndex = 0
      state.visible = state.suggestions.length > 0
      return
    }
  }

  // Check for @ file mention
  const atMatch = input.match(/(^|\s)@([\w\-./\\~]*)$/)
  if (atMatch) {
    const partial = atMatch[2] || ''
    state.suggestions = getFileSuggestions(partial, cwd)
    state.triggerType = '@'
    state.triggerPos = input.lastIndexOf('@')
    state.selectedIndex = 0
    state.visible = state.suggestions.length > 0
    return
  }

  // No trigger — hide
  state.suggestions = []
  state.visible = false
  state.triggerType = null
}

/**
 * Move selection up.
 */
export function selectPrevious(state: CompleterState): void {
  if (!state.visible || state.suggestions.length === 0) return
  state.selectedIndex =
    (state.selectedIndex - 1 + state.suggestions.length) % state.suggestions.length
}

/**
 * Move selection down.
 */
export function selectNext(state: CompleterState): void {
  if (!state.visible || state.suggestions.length === 0) return
  state.selectedIndex = (state.selectedIndex + 1) % state.suggestions.length
}

/**
 * Accept the current selection. Returns the new input string.
 */
export function acceptSuggestion(state: CompleterState, input: string): string {
  if (!state.visible || state.suggestions.length === 0) return input

  const suggestion = state.suggestions[state.selectedIndex]!

  if (state.triggerType === '/') {
    // Replace from start
    state.visible = false
    return suggestion.value
  }

  if (state.triggerType === '@') {
    // Replace from @ position
    const before = input.slice(0, state.triggerPos)
    state.visible = false
    return before + suggestion.value
  }

  return input
}

/**
 * Dismiss suggestions.
 */
export function dismissSuggestions(state: CompleterState): void {
  state.visible = false
  state.suggestions = []
}

// ---------------------------------------------------------------------------
// Rendering — ANSI inline suggestion dropdown
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 6

/**
 * Render suggestions below the current line using ANSI escape codes.
 * Uses a scrolling window that follows the selection (carousel).
 */
export function renderSuggestions(state: CompleterState): { output: string; lineCount: number } {
  if (!state.visible || state.suggestions.length === 0) {
    return { output: '', lineCount: 0 }
  }

  const total = state.suggestions.length
  const sel = state.selectedIndex

  // Calculate visible window that follows selection
  let windowStart: number
  if (total <= MAX_VISIBLE) {
    windowStart = 0
  } else {
    // Keep selection roughly centered in the window
    windowStart = Math.max(0, Math.min(sel - Math.floor(MAX_VISIBLE / 2), total - MAX_VISIBLE))
  }
  const windowEnd = Math.min(windowStart + MAX_VISIBLE, total)

  const lines: string[] = []

  // Scroll-up indicator
  if (windowStart > 0) {
    lines.push(dim(`  ↑ ${windowStart} more`))
  }

  for (let i = windowStart; i < windowEnd; i++) {
    const item = state.suggestions[i]!
    const selected = i === sel
    if (selected) {
      lines.push(`  ${blue(bold(item.label))}  ${dim(item.description)}`)
    } else {
      lines.push(`  ${dim(item.label)}  ${dim(item.description)}`)
    }
  }

  // Scroll-down indicator
  if (windowEnd < total) {
    lines.push(dim(`  ↓ ${total - windowEnd} more`))
  }

  const ansi =
    '\x1b[s' + // Save cursor position
    '\n' +
    lines.join('\n') +
    '\x1b[u' // Restore cursor position

  return { output: ansi, lineCount: lines.length + 1 }
}

/**
 * Clear rendered suggestions from screen.
 */
export function clearRenderedSuggestions(lineCount: number): string {
  if (lineCount === 0) return ''
  // Save pos, move down, clear lines, restore pos
  let ansi = '\x1b[s' // save
  for (let i = 0; i < lineCount; i++) {
    ansi += '\n\x1b[2K' // next line + clear
  }
  ansi += '\x1b[u' // restore
  return ansi
}
