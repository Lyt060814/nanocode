/**
 * Web Search Tool — Search the web
 *
 * Constructs a search URL and fetches results.
 * Simple implementation using DuckDuckGo HTML search as a backend.
 */

import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext } from '../core/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEARCH_TIMEOUT_MS = 15_000
const MAX_RESULT_SIZE_CHARS = 20_000

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  query: z.string().describe(
    'The search query. Be specific for better results.',
  ),
})

type WebSearchInput = z.infer<typeof inputSchema>

// ---------------------------------------------------------------------------
// Search Implementation
// ---------------------------------------------------------------------------

async function performSearch(query: string, abortSignal?: AbortSignal): Promise<string> {
  const encodedQuery = encodeURIComponent(query)
  const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)

  if (abortSignal) {
    abortSignal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'nanocode/1.0 (CLI Agent)',
        'Accept': 'text/html',
      },
    })

    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`Search returned HTTP ${response.status}`)
    }

    const html = await response.text()
    return parseSearchResults(html, query)
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Parse DuckDuckGo HTML search results into a readable format.
 */
function parseSearchResults(html: string, query: string): string {
  const results: Array<{ title: string; url: string; snippet: string }> = []

  // Extract result blocks — DuckDuckGo uses .result class
  const resultBlockRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi
  const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i
  const snippetRegex = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i

  let match: RegExpExecArray | null
  while ((match = resultBlockRegex.exec(html)) !== null && results.length < 10) {
    const block = match[1] ?? ''

    const linkMatch = linkRegex.exec(block)
    const snippetMatch = snippetRegex.exec(block)

    if (linkMatch) {
      let url = linkMatch[1] ?? ''
      // DuckDuckGo wraps URLs in a redirect — extract the actual URL
      const uddgMatch = url.match(/uddg=([^&]+)/)
      if (uddgMatch) {
        url = decodeURIComponent(uddgMatch[1] ?? '')
      }

      const title = stripTags(linkMatch[2] ?? '').trim()
      const snippet = stripTags(snippetMatch?.[1] ?? '').trim()

      if (title && url) {
        results.push({ title, url, snippet })
      }
    }
  }

  // If regex parsing failed, try a simpler approach
  if (results.length === 0) {
    // Try to extract any links with surrounding text
    const simpleLinkRegex = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    let simpleMatch: RegExpExecArray | null
    const seen = new Set<string>()

    while ((simpleMatch = simpleLinkRegex.exec(html)) !== null && results.length < 10) {
      const url = simpleMatch[1] ?? ''
      const title = stripTags(simpleMatch[2] ?? '').trim()

      // Skip DuckDuckGo internal links
      if (url.includes('duckduckgo.com') || !title || seen.has(url)) continue
      seen.add(url)

      results.push({ title, url, snippet: '' })
    }
  }

  if (results.length === 0) {
    return `No search results found for: ${query}\n\nTip: Try different search terms or use WebFetch to access a specific URL directly.`
  }

  // Format results
  const formatted: string[] = [`Search results for: ${query}\n`]

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    formatted.push(`${i + 1}. ${r.title}`)
    formatted.push(`   ${r.url}`)
    if (r.snippet) {
      formatted.push(`   ${r.snippet}`)
    }
    formatted.push('')
  }

  formatted.push(`(${results.length} results)`)

  return formatted.join('\n')
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const webSearchToolDef: ToolDef<WebSearchInput> = {
  name: 'WebSearch',

  description: 'Search the web for information. Returns a list of search results with titles, URLs, and snippets.',

  inputSchema,

  async call(input: WebSearchInput, context: ToolContext): Promise<ToolResult> {
    const { query } = input

    if (!query.trim()) {
      return { result: 'Error: search query cannot be empty.', isError: true }
    }

    try {
      const results = await performSearch(query, context.abortSignal)
      return { result: results, isError: false }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { result: `Error: search timed out after ${SEARCH_TIMEOUT_MS / 1000}s`, isError: true }
      }
      return {
        result: `Error performing search: ${err.message}`,
        isError: true,
      }
    }
  },

  prompt(): string {
    return [
      'Search the web for information.',
      '',
      'Guidelines:',
      '- Be specific in your search queries.',
      '- Use WebFetch to read full content from search result URLs.',
      '- Returns up to 10 results.',
    ].join('\n')
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: MAX_RESULT_SIZE_CHARS,

  userFacingName(input: WebSearchInput): string {
    return `WebSearch: ${input.query.slice(0, 50)}${input.query.length > 50 ? '...' : ''}`
  },
}
