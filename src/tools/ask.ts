/**
 * Ask Tool — User interaction
 *
 * Asks the user a question and returns their answer.
 * Uses readline for terminal input.
 */

import { createInterface } from 'node:readline'
import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext } from '../core/types.js'

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  question: z.string().describe(
    'The question to ask the user. Be clear and specific about what information you need.',
  ),
})

type AskInput = z.infer<typeof inputSchema>

// ---------------------------------------------------------------------------
// User Input
// ---------------------------------------------------------------------------

function askUser(question: string, abortSignal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error('Aborted'))
      return
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stderr, // Use stderr so it doesn't pollute stdout
    })

    const onAbort = () => {
      rl.close()
      reject(new Error('Aborted'))
    }

    abortSignal?.addEventListener('abort', onAbort, { once: true })

    // Display the question
    process.stderr.write(`\n\x1b[36m? ${question}\x1b[0m\n> `)

    rl.on('line', (answer) => {
      abortSignal?.removeEventListener('abort', onAbort)
      rl.close()
      resolve(answer.trim())
    })

    rl.on('close', () => {
      abortSignal?.removeEventListener('abort', onAbort)
      resolve('')
    })

    rl.on('error', (err) => {
      abortSignal?.removeEventListener('abort', onAbort)
      rl.close()
      reject(err)
    })
  })
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const askToolDef: ToolDef<AskInput> = {
  name: 'Ask',

  description: 'Ask the user a question and wait for their response. Use when you need clarification or additional information to proceed.',

  inputSchema,

  async call(input: AskInput, context: ToolContext): Promise<ToolResult> {
    const { question } = input

    if (!question.trim()) {
      return { result: 'Error: question cannot be empty.', isError: true }
    }

    try {
      const answer = await askUser(question, context.abortSignal)

      if (!answer) {
        return { result: '(No response from user)', isError: false }
      }

      return { result: answer, isError: false }
    } catch (err: any) {
      if (err.message === 'Aborted') {
        return { result: '(User interaction cancelled)', isError: false }
      }
      return {
        result: `Error reading user input: ${err.message}`,
        isError: true,
      }
    }
  },

  prompt(): string {
    return [
      'Ask the user a question when you need clarification.',
      '',
      'Guidelines:',
      '- Only ask when you truly need information you cannot determine yourself.',
      '- Be specific about what you need to know.',
      '- Avoid asking multiple questions at once — one at a time.',
    ].join('\n')
  },

  isReadOnly: () => true,
  isConcurrencySafe: () => false, // Cannot run multiple user prompts concurrently
  maxResultSizeChars: 10_000,

  userFacingName(input: AskInput): string {
    return `Ask: ${input.question.slice(0, 50)}${input.question.length > 50 ? '...' : ''}`
  },
}
