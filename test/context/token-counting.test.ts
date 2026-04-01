import { describe, it, expect } from 'vitest'
import {
  estimateTokens,
  estimateJsonTokens,
  estimateMessageTokens,
  estimateSingleMessageTokens,
  estimateSystemPromptTokens,
  wouldExceedBudget,
  truncateToTokenBudget,
  CHARS_PER_TOKEN,
  JSON_CHARS_PER_TOKEN,
} from '../../src/context/token-counting'
import type { Message, ContentBlock, SystemPromptBlock } from '../../src/core/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('CHARS_PER_TOKEN should be 4', () => {
    expect(CHARS_PER_TOKEN).toBe(4)
  })

  it('JSON_CHARS_PER_TOKEN should be 2', () => {
    expect(JSON_CHARS_PER_TOKEN).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('returns 0 for null-ish input', () => {
    // The function guards against falsy values
    expect(estimateTokens(null as unknown as string)).toBe(0)
    expect(estimateTokens(undefined as unknown as string)).toBe(0)
  })

  it('estimates tokens as Math.round(length / 4)', () => {
    // 8 chars -> 8/4 = 2 exactly
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('rounds to nearest integer', () => {
    // 5 chars -> 5/4 = 1.25 -> rounds to 1
    expect(estimateTokens('abcde')).toBe(1)
    // 6 chars -> 6/4 = 1.5 -> rounds to 2
    expect(estimateTokens('abcdef')).toBe(2)
    // 7 chars -> 7/4 = 1.75 -> rounds to 2
    expect(estimateTokens('abcdefg')).toBe(2)
  })

  it('handles single character', () => {
    // 1/4 = 0.25 -> rounds to 0
    expect(estimateTokens('a')).toBe(0)
  })

  it('handles two characters', () => {
    // 2/4 = 0.5 -> rounds to 1 (banker's rounding: 0 in some engines, but Math.round(0.5) = 1 in JS)
    expect(estimateTokens('ab')).toBe(1)
  })

  it('handles very long strings', () => {
    const longString = 'x'.repeat(100_000)
    expect(estimateTokens(longString)).toBe(25_000)
  })

  it('handles strings with special characters', () => {
    const text = 'Hello, world! 🌍'
    // The emoji is 2 UTF-16 code units, so .length = 16
    expect(estimateTokens(text)).toBe(Math.round(text.length / 4))
  })

  it('handles multiline text', () => {
    const text = 'line1\nline2\nline3'
    expect(estimateTokens(text)).toBe(Math.round(text.length / 4))
  })
})

// ---------------------------------------------------------------------------
// estimateJsonTokens
// ---------------------------------------------------------------------------

describe('estimateJsonTokens', () => {
  it('returns 0 for null', () => {
    expect(estimateJsonTokens(null)).toBe(0)
  })

  it('returns 0 for undefined', () => {
    expect(estimateJsonTokens(undefined)).toBe(0)
  })

  it('estimates from JSON.stringify length / 2', () => {
    const obj = { key: 'value' }
    const jsonLen = JSON.stringify(obj).length // {"key":"value"} = 15
    expect(estimateJsonTokens(obj)).toBe(Math.round(jsonLen / 2))
  })

  it('handles empty object', () => {
    // "{}" length = 2, 2/2 = 1
    expect(estimateJsonTokens({})).toBe(1)
  })

  it('handles empty array', () => {
    // "[]" length = 2, 2/2 = 1
    expect(estimateJsonTokens([])).toBe(1)
  })

  it('handles string value', () => {
    const str = 'hello'
    // '"hello"' length = 7, 7/2 = 3.5 -> rounds to 4
    expect(estimateJsonTokens(str)).toBe(Math.round(JSON.stringify(str).length / 2))
  })

  it('handles number', () => {
    // "42" length = 2, 2/2 = 1
    expect(estimateJsonTokens(42)).toBe(1)
  })

  it('handles nested object', () => {
    const obj = { a: { b: { c: [1, 2, 3] } } }
    const jsonLen = JSON.stringify(obj).length
    expect(estimateJsonTokens(obj)).toBe(Math.round(jsonLen / 2))
  })

  it('returns 0 for circular references (JSON.stringify throws)', () => {
    const obj: any = {}
    obj.self = obj
    expect(estimateJsonTokens(obj)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// estimateSingleMessageTokens
// ---------------------------------------------------------------------------

describe('estimateSingleMessageTokens', () => {
  const STRUCTURE_OVERHEAD = 4

  it('returns structure overhead for message with no content', () => {
    const msg: Message = { role: 'user', content: [] }
    expect(estimateSingleMessageTokens(msg)).toBe(STRUCTURE_OVERHEAD)
  })

  it('returns structure overhead for message with null content', () => {
    const msg = { role: 'user', content: null } as unknown as Message
    expect(estimateSingleMessageTokens(msg)).toBe(STRUCTURE_OVERHEAD)
  })

  it('counts text block tokens', () => {
    const text = 'Hello world test' // 16 chars -> 4 tokens
    const msg: Message = {
      role: 'user',
      content: [{ type: 'text', text }],
    }
    expect(estimateSingleMessageTokens(msg)).toBe(STRUCTURE_OVERHEAD + estimateTokens(text))
  })

  it('counts tool_use block tokens (name + id + input)', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool_01',
          name: 'read_file',
          input: { path: '/tmp/test.ts' },
        },
      ],
    }
    const expected =
      STRUCTURE_OVERHEAD +
      estimateTokens('read_file') +
      estimateTokens('tool_01') +
      estimateJsonTokens({ path: '/tmp/test.ts' })
    expect(estimateSingleMessageTokens(msg)).toBe(expected)
  })

  it('counts tool_result block with string content', () => {
    const msg: Message = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool_01',
          content: 'File contents here',
        },
      ],
    }
    expect(estimateSingleMessageTokens(msg)).toBe(
      STRUCTURE_OVERHEAD + estimateTokens('File contents here'),
    )
  })

  it('counts tool_result block with array content', () => {
    const msg: Message = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool_01',
          content: [
            { type: 'text', text: 'result text' },
          ],
        },
      ],
    }
    expect(estimateSingleMessageTokens(msg)).toBe(
      STRUCTURE_OVERHEAD + estimateTokens('result text'),
    )
  })

  it('counts thinking block tokens', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Let me think about this' }],
    }
    expect(estimateSingleMessageTokens(msg)).toBe(
      STRUCTURE_OVERHEAD + estimateTokens('Let me think about this'),
    )
  })

  it('counts image block as 1500 tokens', () => {
    const msg: Message = {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'abc' },
        },
      ],
    }
    expect(estimateSingleMessageTokens(msg)).toBe(STRUCTURE_OVERHEAD + 1500)
  })

  it('sums multiple blocks', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: 'World' },
      ],
    }
    expect(estimateSingleMessageTokens(msg)).toBe(
      STRUCTURE_OVERHEAD + estimateTokens('Hello') + estimateTokens('World'),
    )
  })

  it('counts redacted_thinking block', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'redacted_thinking', data: 'opaque-data-here' }],
    }
    expect(estimateSingleMessageTokens(msg)).toBe(
      STRUCTURE_OVERHEAD + estimateTokens('opaque-data-here'),
    )
  })
})

// ---------------------------------------------------------------------------
// estimateMessageTokens
// ---------------------------------------------------------------------------

describe('estimateMessageTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateMessageTokens([])).toBe(0)
  })

  it('returns 0 for null/undefined', () => {
    expect(estimateMessageTokens(null as unknown as Message[])).toBe(0)
    expect(estimateMessageTokens(undefined as unknown as Message[])).toBe(0)
  })

  it('sums tokens across multiple messages', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
    ]
    const expected =
      estimateSingleMessageTokens(messages[0]) +
      estimateSingleMessageTokens(messages[1])
    expect(estimateMessageTokens(messages)).toBe(expected)
  })

  it('handles single message', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'test' }] },
    ]
    expect(estimateMessageTokens(messages)).toBe(
      estimateSingleMessageTokens(messages[0]),
    )
  })
})

// ---------------------------------------------------------------------------
// estimateSystemPromptTokens
// ---------------------------------------------------------------------------

describe('estimateSystemPromptTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateSystemPromptTokens([])).toBe(0)
  })

  it('returns 0 for null/undefined', () => {
    expect(estimateSystemPromptTokens(null as unknown as SystemPromptBlock[])).toBe(0)
  })

  it('sums text token estimates across blocks', () => {
    const blocks: SystemPromptBlock[] = [
      { type: 'text', text: 'You are a helpful assistant.' },
      { type: 'text', text: 'Follow instructions carefully.' },
    ]
    const expected =
      estimateTokens(blocks[0].text) + estimateTokens(blocks[1].text)
    expect(estimateSystemPromptTokens(blocks)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// wouldExceedBudget
// ---------------------------------------------------------------------------

describe('wouldExceedBudget', () => {
  it('returns false when within budget', () => {
    expect(wouldExceedBudget(10, 'test', 100)).toBe(false)
  })

  it('returns true when exceeding budget', () => {
    // 'a'.repeat(400) = 400 chars = 100 tokens, current = 1, budget = 100
    expect(wouldExceedBudget(1, 'a'.repeat(400), 100)).toBe(true)
  })

  it('returns false at exact boundary', () => {
    // 4 chars = 1 token, current = 99, budget = 100
    expect(wouldExceedBudget(99, 'test', 100)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// truncateToTokenBudget
// ---------------------------------------------------------------------------

describe('truncateToTokenBudget', () => {
  it('returns text as-is if within budget', () => {
    expect(truncateToTokenBudget('hello', 100)).toBe('hello')
  })

  it('truncates text exceeding budget', () => {
    const text = 'word '.repeat(200) // 1000 chars = 250 tokens
    const result = truncateToTokenBudget(text, 10) // 10 tokens = 40 chars
    expect(result.length).toBeLessThan(text.length)
    expect(result).toContain('...[truncated]')
  })

  it('cuts at word boundary when possible', () => {
    const text = 'hello world this is a test of truncation'
    const result = truncateToTokenBudget(text, 2) // 2 tokens = 8 chars
    expect(result).toContain('...[truncated]')
    // Should not cut mid-word if a space is available
  })
})
