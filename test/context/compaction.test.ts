import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  shouldAutoCompact,
  compactThreshold,
  compact,
  PRESERVE_RECENT_TURNS,
  SAFETY_MARGIN,
  MAX_SUMMARY_TOKENS,
  findLastCompactBoundary,
  splitMessages,
} from '../../src/context/compaction'
import { COMPACT_BOUNDARY_MARKER } from '../../src/prompt/compact-prompt'
import { estimateMessageTokens } from '../../src/context/token-counting'
import type { Message, ModelConfig } from '../../src/core/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] }
}

function boundaryMsg(): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: `${COMPACT_BOUNDARY_MARKER}\n\nSummary here.` }],
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it('PRESERVE_RECENT_TURNS is 3', () => {
    expect(PRESERVE_RECENT_TURNS).toBe(3)
  })

  it('SAFETY_MARGIN is 13000', () => {
    expect(SAFETY_MARGIN).toBe(13_000)
  })

  it('MAX_SUMMARY_TOKENS is 8000', () => {
    expect(MAX_SUMMARY_TOKENS).toBe(8_000)
  })
})

// ---------------------------------------------------------------------------
// shouldAutoCompact
// ---------------------------------------------------------------------------

describe('shouldAutoCompact', () => {
  it('triggers when tokens >= contextWindow - maxOutputTokens - 13000', () => {
    // threshold = 200000 - 4096 - 13000 = 182904
    // We need messages with >= 182904 estimated tokens
    // Each char is ~0.25 tokens, so we need ~731616 chars
    // But let us use a simpler approach: create many messages
    const bigText = 'x'.repeat(800_000) // 200,000 tokens
    const messages: Message[] = [textMsg('user', bigText)]
    expect(shouldAutoCompact(messages, 200_000, 4096)).toBe(true)
  })

  it('does not trigger when tokens < threshold', () => {
    const messages: Message[] = [textMsg('user', 'hello')]
    expect(shouldAutoCompact(messages, 200_000, 4096)).toBe(false)
  })

  it('returns false when threshold would be <= 0', () => {
    const messages: Message[] = [textMsg('user', 'hello')]
    // contextWindow=10000, maxOutputTokens=10000 -> threshold = -13000 <= 0
    expect(shouldAutoCompact(messages, 10_000, 10_000)).toBe(false)
  })

  it('triggers at exact threshold boundary', () => {
    // threshold = 100000 - 1000 - 13000 = 86000
    // Need exactly 86000 tokens = 344000 chars
    const messages: Message[] = [textMsg('user', 'x'.repeat(344_000))]
    // estimateTokens('x'.repeat(344000)) = 86000, plus 4 overhead = 86004
    expect(shouldAutoCompact(messages, 100_000, 1_000)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// compactThreshold
// ---------------------------------------------------------------------------

describe('compactThreshold', () => {
  it('calculates contextWindow - maxOutputTokens - SAFETY_MARGIN', () => {
    const config: ModelConfig = {
      model: 'claude-sonnet-4-20250514',
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      supportsThinking: true,
      supportsCaching: true,
      pricePerInputToken: 0,
      pricePerOutputToken: 0,
      pricePerCacheRead: 0,
      pricePerCacheWrite: 0,
    }
    expect(compactThreshold(config)).toBe(200_000 - 8192 - 13_000)
  })
})

// ---------------------------------------------------------------------------
// findLastCompactBoundary
// ---------------------------------------------------------------------------

describe('findLastCompactBoundary', () => {
  it('returns -1 when no boundary exists', () => {
    const messages: Message[] = [
      textMsg('user', 'hello'),
      textMsg('assistant', 'hi'),
    ]
    expect(findLastCompactBoundary(messages)).toBe(-1)
  })

  it('finds boundary marker in user message', () => {
    const messages: Message[] = [
      textMsg('user', 'hello'),
      textMsg('assistant', 'hi'),
      boundaryMsg(),
      textMsg('user', 'continue'),
    ]
    expect(findLastCompactBoundary(messages)).toBe(2)
  })

  it('finds the LAST boundary when multiple exist', () => {
    const messages: Message[] = [
      boundaryMsg(),
      textMsg('user', 'middle'),
      textMsg('assistant', 'reply'),
      boundaryMsg(),
      textMsg('user', 'end'),
    ]
    expect(findLastCompactBoundary(messages)).toBe(3)
  })

  it('ignores boundary marker in assistant messages', () => {
    const messages: Message[] = [
      textMsg('user', 'hello'),
      {
        role: 'assistant',
        content: [{ type: 'text', text: COMPACT_BOUNDARY_MARKER }],
      },
    ]
    expect(findLastCompactBoundary(messages)).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// splitMessages
// ---------------------------------------------------------------------------

describe('splitMessages', () => {
  it('preserves everything when too few messages to compact', () => {
    // PRESERVE_RECENT_TURNS * 2 = 6, so <= 6 messages means no compaction
    const messages: Message[] = [
      textMsg('user', 'a'),
      textMsg('assistant', 'b'),
      textMsg('user', 'c'),
      textMsg('assistant', 'd'),
    ]
    const { toSummarize, toPreserve } = splitMessages(messages, -1)
    expect(toSummarize).toHaveLength(0)
    expect(toPreserve).toHaveLength(4)
  })

  it('splits into summarize and preserve sets', () => {
    const messages: Message[] = [
      textMsg('user', '1'),
      textMsg('assistant', '2'),
      textMsg('user', '3'),
      textMsg('assistant', '4'),
      textMsg('user', '5'),
      textMsg('assistant', '6'),
      textMsg('user', '7'),
      textMsg('assistant', '8'),
      textMsg('user', '9'),
      textMsg('assistant', '10'),
    ]
    const { toSummarize, toPreserve } = splitMessages(messages, -1)
    // Last 3 turns = 6 messages preserved, rest summarized
    expect(toSummarize.length).toBeGreaterThan(0)
    expect(toPreserve.length).toBeGreaterThanOrEqual(PRESERVE_RECENT_TURNS * 2)
  })

  it('respects afterIndex (previous compact boundary)', () => {
    const messages: Message[] = [
      boundaryMsg(),           // index 0
      textMsg('user', '1'),     // index 1 (after boundary)
      textMsg('assistant', '2'),
      textMsg('user', '3'),
      textMsg('assistant', '4'),
      textMsg('user', '5'),
      textMsg('assistant', '6'),
      textMsg('user', '7'),
      textMsg('assistant', '8'),
    ]
    const { toSummarize, toPreserve } = splitMessages(messages, 0)
    // Only messages after index 0 are considered (8 messages)
    expect(toSummarize.length + toPreserve.length).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// compact
// ---------------------------------------------------------------------------

describe('compact', () => {
  const mockCallModel = vi.fn()

  beforeEach(() => {
    mockCallModel.mockReset()
    mockCallModel.mockResolvedValue('This is the compacted summary.')
  })

  it('returns messages unchanged when nothing to summarize', async () => {
    const messages: Message[] = [
      textMsg('user', 'hello'),
      textMsg('assistant', 'hi'),
    ]
    const result = await compact(
      messages,
      { apiKey: 'test-key', model: 'test-model' },
      mockCallModel,
    )
    expect(result.compacted).toEqual(messages)
    expect(result.oldTokens).toBe(result.newTokens)
    expect(mockCallModel).not.toHaveBeenCalled()
  })

  it('calls model and returns compacted messages for long conversations', async () => {
    // Build a conversation with enough messages to trigger compaction
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      messages.push(textMsg('user', `User message ${i} with some content`))
      messages.push(textMsg('assistant', `Assistant reply ${i} with detail`))
    }

    const result = await compact(
      messages,
      { apiKey: 'test-key', model: 'test-model' },
      mockCallModel,
    )

    expect(mockCallModel).toHaveBeenCalledOnce()
    // The compacted result should contain the summary + preserved recent turns
    expect(result.compacted.length).toBeLessThan(messages.length)
    // The first non-pre-compact message should contain the boundary marker
    const summaryMsg = result.compacted[0]
    expect(summaryMsg.role).toBe('user')
    const textContent = (summaryMsg.content[0] as { type: 'text'; text: string }).text
    expect(textContent).toContain(COMPACT_BOUNDARY_MARKER)
    expect(textContent).toContain('This is the compacted summary.')
  })

  it('preserves recent turns in compacted output', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      messages.push(textMsg('user', `msg-${i}`))
      messages.push(textMsg('assistant', `reply-${i}`))
    }

    const result = await compact(
      messages,
      { apiKey: 'test-key', model: 'test-model' },
      mockCallModel,
    )

    // The last few messages should be preserved verbatim
    const lastOriginal = messages[messages.length - 1]
    const lastCompacted = result.compacted[result.compacted.length - 1]
    expect(lastCompacted).toEqual(lastOriginal)
  })

  it('passes correct arguments to callModel', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      messages.push(textMsg('user', `msg-${i}`))
      messages.push(textMsg('assistant', `reply-${i}`))
    }

    await compact(
      messages,
      { apiKey: 'my-key', model: 'my-model' },
      mockCallModel,
    )

    expect(mockCallModel).toHaveBeenCalledWith(
      expect.any(String),   // system prompt
      expect.any(String),   // user message
      'my-model',
      'my-key',
      undefined,             // no abort signal
    )
  })

  it('handles compact after a previous compaction boundary', async () => {
    const messages: Message[] = [
      boundaryMsg(),
      // After boundary: 20 turn pairs
      ...Array.from({ length: 20 }, (_, i) => [
        textMsg('user', `post-compact-${i}`),
        textMsg('assistant', `reply-${i}`),
      ]).flat(),
    ]

    const result = await compact(
      messages,
      { apiKey: 'key', model: 'model' },
      mockCallModel,
    )

    expect(mockCallModel).toHaveBeenCalledOnce()
    // Pre-compact messages (the old boundary) should be preserved
    expect(result.compacted[0]).toEqual(messages[0])
  })

  it('reports token counts', async () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      messages.push(textMsg('user', `msg-${i} with some text`))
      messages.push(textMsg('assistant', `reply-${i} with detail`))
    }

    const result = await compact(
      messages,
      { apiKey: 'key', model: 'model' },
      mockCallModel,
    )

    expect(result.oldTokens).toBe(estimateMessageTokens(messages))
    expect(result.newTokens).toBeLessThan(result.oldTokens)
    expect(result.newTokens).toBeGreaterThan(0)
  })
})
