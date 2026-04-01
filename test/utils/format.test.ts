import { describe, it, expect } from 'vitest'
import {
  bold,
  dim,
  red,
  yellow,
  green,
  cyan,
  formatToolResult,
  formatCost,
} from '../../src/utils/format'
import { createCostTracker } from '../../src/utils/cost'
import type { ModelConfig } from '../../src/core/types'

const ESC = '\x1b['
const RESET = `${ESC}0m`

describe('ANSI format helpers', () => {
  // -------------------------------------------------------------------
  // Color wrappers
  // -------------------------------------------------------------------
  describe('bold', () => {
    it('wraps with ANSI bold codes', () => {
      expect(bold('hello')).toBe(`${ESC}1mhello${RESET}`)
    })
  })

  describe('dim', () => {
    it('wraps with ANSI dim codes', () => {
      expect(dim('hello')).toBe(`${ESC}2mhello${RESET}`)
    })
  })

  describe('red', () => {
    it('wraps with ANSI red codes', () => {
      expect(red('error')).toBe(`${ESC}31merror${RESET}`)
    })
  })

  describe('yellow', () => {
    it('wraps with ANSI yellow codes', () => {
      expect(yellow('warn')).toBe(`${ESC}33mwarn${RESET}`)
    })
  })

  describe('green', () => {
    it('wraps with ANSI green codes', () => {
      expect(green('ok')).toBe(`${ESC}32mok${RESET}`)
    })
  })

  describe('cyan', () => {
    it('wraps with ANSI cyan codes', () => {
      expect(cyan('info')).toBe(`${ESC}36minfo${RESET}`)
    })
  })

  // -------------------------------------------------------------------
  // formatToolResult
  // -------------------------------------------------------------------
  describe('formatToolResult', () => {
    it('includes tool name header', () => {
      const output = formatToolResult('Read', 'file contents here')
      expect(output).toContain('[Read]')
      expect(output).toContain('file contents here')
    })

    it('truncates output longer than 2000 chars', () => {
      const longText = 'x'.repeat(5000)
      const output = formatToolResult('Bash', longText)
      // Should contain truncation notice
      expect(output).toContain('more characters')
      // The truncated body should be shorter than original
      expect(output.length).toBeLessThan(longText.length + 200)
    })

    it('does not truncate short output', () => {
      const shortText = 'hello world'
      const output = formatToolResult('Bash', shortText)
      expect(output).toContain('hello world')
      expect(output).not.toContain('more characters')
    })
  })

  // -------------------------------------------------------------------
  // formatCost
  // -------------------------------------------------------------------
  describe('formatCost', () => {
    const config: ModelConfig = {
      model: 'test-model',
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      supportsThinking: false,
      supportsCaching: true,
      pricePerInputToken: 0.003 / 1000,
      pricePerOutputToken: 0.015 / 1000,
      pricePerCacheRead: 0.0003 / 1000,
      pricePerCacheWrite: 0.00375 / 1000,
    }

    it('produces readable output with dim formatting', () => {
      const tracker = createCostTracker()
      tracker.add({ inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0 })
      const output = formatCost(tracker, config)
      // Should be wrapped in dim ANSI
      expect(output).toContain(ESC)
      expect(output).toContain('Turn 1')
      expect(output).toContain('$')
    })
  })
})
