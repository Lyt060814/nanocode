/**
 * Web Fetch Tool — HTTP content retrieval
 *
 * Fetches a URL and returns the content as text.
 * Converts HTML to markdown using turndown for readability.
 */

import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext } from '../core/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000
const MAX_RESULT_SIZE_CHARS = 30_000
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5 MB

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  url: z.string().describe(
    'The URL to fetch. Must be a valid HTTP or HTTPS URL.',
  ),
})

type WebFetchInput = z.infer<typeof inputSchema>

// ---------------------------------------------------------------------------
// HTML to Markdown Conversion
// ---------------------------------------------------------------------------

/**
 * Simple HTML to text conversion.
 * If turndown is available, use it for proper markdown conversion.
 * Otherwise, strip tags with basic heuristics.
 */
async function htmlToMarkdown(html: string): Promise<string> {
  try {
    const TurndownService = (await import('turndown')).default
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })

    // Remove script and style elements
    turndown.remove(['script', 'style', 'nav', 'footer', 'header'])

    return turndown.turndown(html)
  } catch {
    // Fallback: basic HTML stripping
    return stripHtml(html)
  }
}

/**
 * Basic HTML tag stripping fallback.
 */
function stripHtml(html: string): string {
  // Remove script and style content
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, '')

  // Convert common elements
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/p>/gi, '\n\n')
  text = text.replace(/<\/div>/gi, '\n')
  text = text.replace(/<\/h[1-6]>/gi, '\n\n')
  text = text.replace(/<h([1-6])[^>]*>/gi, (_, level) => '#'.repeat(parseInt(level)) + ' ')
  text = text.replace(/<li[^>]*>/gi, '- ')
  text = text.replace(/<\/li>/gi, '\n')

  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode common HTML entities
  text = text.replace(/&amp;/g, '&')
  text = text.replace(/&lt;/g, '<')
  text = text.replace(/&gt;/g, '>')
  text = text.replace(/&quot;/g, '"')
  text = text.replace(/&#39;/g, "'")
  text = text.replace(/&nbsp;/g, ' ')

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.replace(/[ \t]+/g, ' ')
  text = text.replace(/^ +/gm, '')

  return text.trim()
}

// ---------------------------------------------------------------------------
// Content Type Detection
// ---------------------------------------------------------------------------

function isHtml(contentType: string | null, body: string): boolean {
  if (contentType && contentType.includes('text/html')) return true
  // Heuristic: check if body starts with HTML-like content
  const trimmed = body.trimStart().slice(0, 100).toLowerCase()
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html')
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const webFetchToolDef: ToolDef<WebFetchInput> = {
  name: 'WebFetch',

  description: 'Fetch a URL and return its content. HTML pages are converted to markdown for readability.',

  inputSchema,

  async call(input: WebFetchInput, context: ToolContext): Promise<ToolResult> {
    const { url } = input

    // Validate URL
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return { result: `Error: invalid URL: ${url}`, isError: true }
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { result: `Error: only HTTP and HTTPS URLs are supported.`, isError: true }
    }

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      // Also respect the context abort signal
      if (context.abortSignal) {
        context.abortSignal.addEventListener('abort', () => controller.abort(), { once: true })
      }

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'nanocode/1.0 (CLI Agent)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
        },
        redirect: 'follow',
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        return {
          result: `Error: HTTP ${response.status} ${response.statusText} fetching ${url}`,
          isError: true,
        }
      }

      // Check content length
      const contentLength = response.headers.get('content-length')
      if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
        return {
          result: `Error: response too large (${contentLength} bytes, max ${MAX_RESPONSE_SIZE}).`,
          isError: true,
        }
      }

      const contentType = response.headers.get('content-type')
      const body = await response.text()

      // Truncate massive responses before processing
      const truncatedBody = body.length > MAX_RESPONSE_SIZE
        ? body.slice(0, MAX_RESPONSE_SIZE)
        : body

      // Convert HTML to markdown
      let content: string
      if (isHtml(contentType, truncatedBody)) {
        content = await htmlToMarkdown(truncatedBody)
      } else {
        content = truncatedBody
      }

      // Final truncation
      if (content.length > MAX_RESULT_SIZE_CHARS) {
        content = content.slice(0, MAX_RESULT_SIZE_CHARS)
        content += `\n\n[Content truncated at ${MAX_RESULT_SIZE_CHARS} chars]`
      }

      // Add metadata header
      const header = `URL: ${url}\nStatus: ${response.status}\nContent-Type: ${contentType ?? 'unknown'}\n---\n\n`

      return { result: header + content, isError: false }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { result: `Error: request timed out after ${FETCH_TIMEOUT_MS / 1000}s fetching ${url}`, isError: true }
      }
      return {
        result: `Error fetching ${url}: ${err.message}`,
        isError: true,
      }
    }
  },

  prompt(): string {
    return [
      'Fetch content from a URL.',
      '',
      'Guidelines:',
      '- HTML pages are converted to markdown for readability.',
      '- Timeout: 30 seconds.',
      '- Max response size: 5 MB.',
      '- Only HTTP and HTTPS URLs are supported.',
    ].join('\n')
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  maxResultSizeChars: MAX_RESULT_SIZE_CHARS,

  userFacingName(input: WebFetchInput): string {
    return `WebFetch: ${input.url.slice(0, 60)}${input.url.length > 60 ? '...' : ''}`
  },
}
