/**
 * nanocode Compact Prompt
 *
 * The prompt used to instruct the model to summarize a conversation
 * when context compaction is triggered. This is sent as a user message
 * along with the messages to be summarized.
 *
 * The 9-section format matches Claude Code's compaction prompt exactly.
 */

// ---------------------------------------------------------------------------
// Compact prompt — 9 sections
// ---------------------------------------------------------------------------

export const COMPACT_PROMPT = `\
Your task is to create a detailed summary of this conversation that will \
replace the conversation history. This summary will be used as context for \
continuing the conversation, so it must preserve all important information.

The summary should be detailed enough that a reader could continue the \
conversation without losing important context.

Please organize the summary into the following sections:

1. **Primary Request and Intent**: What is the user trying to accomplish? \
What are their goals?

2. **Key Technical Concepts**: Important technical details, architecture \
decisions, algorithms discussed

3. **Files and Code Sections**: Important files referenced or modified, with \
key code snippets preserved verbatim (include file paths and line numbers)

4. **Errors and fixes**: Any errors encountered and their resolutions

5. **Problem Solving**: Approaches tried, what worked and what didn't

6. **All user messages**: preserve the exact content and intent of all user \
messages

7. **Pending Tasks**: Tasks that still need to be completed

8. **Current Work**: What is currently being worked on

9. **Optional Next Step**: If there is a clear next step, describe it \
(should align with user's latest request)

Important guidelines:
- Preserve ALL file paths, code snippets, and error messages VERBATIM
- Include specific line numbers where code was modified
- Keep exact command-line invocations and their outputs
- Maintain the chronological order of events
- Be specific - include actual values, names, and identifiers rather than \
generic descriptions`

// ---------------------------------------------------------------------------
// Compact system instruction
// ---------------------------------------------------------------------------

/**
 * System-level instruction prepended when asking the model to compact.
 * This tells the model its role is to summarize, not to continue acting
 * as a coding agent.
 */
export const COMPACT_SYSTEM_INSTRUCTION = `\
You are a conversation summarizer. Your job is to create a detailed, \
structured summary of the conversation provided to you. You must follow \
the format and guidelines specified in the user message exactly. Do NOT \
attempt to continue the conversation, answer questions, or take any \
actions. Only produce the summary.`

// ---------------------------------------------------------------------------
// Compact boundary marker
// ---------------------------------------------------------------------------

/**
 * Marker text inserted into the conversation to indicate where a
 * compaction occurred. This is used to find the boundary when a
 * subsequent compaction is needed.
 */
export const COMPACT_BOUNDARY_MARKER = '[CONVERSATION_COMPACTED]'

/**
 * Wraps a summary in the standard compact message format.
 */
export function formatCompactSummary(summary: string): string {
  return `\
${COMPACT_BOUNDARY_MARKER}

The following is a summary of the conversation so far. Continue the \
conversation from where the summary leaves off. Do NOT repeat information \
already covered in the summary — pick up where it ends.

---

${summary}

---

The conversation has been compacted. The above summary replaces earlier \
messages. Continue from where the summary leaves off.`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the user message that asks the model to summarize a set of messages.
 * This combines COMPACT_PROMPT with a serialized version of the messages.
 */
export function buildCompactUserMessage(
  messagesText: string,
): string {
  return `\
${COMPACT_PROMPT}

Here is the conversation to summarize:

<conversation>
${messagesText}
</conversation>

Please produce the summary now, following the 9-section format above.`
}

/**
 * Serialize messages into a readable text format for the compaction prompt.
 * Each message is labeled by role and its text content is extracted.
 */
export function serializeMessagesForCompact(
  messages: Array<{ role: string; content: unknown[] }>,
): string {
  const lines: string[] = []

  for (const msg of messages) {
    const role = msg.role.toUpperCase()
    lines.push(`--- ${role} ---`)

    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as Record<string, unknown>
        if (b.type === 'text' && typeof b.text === 'string') {
          lines.push(b.text)
        } else if (b.type === 'tool_use') {
          lines.push(
            `[Tool call: ${b.name}(${JSON.stringify(b.input).slice(0, 500)})]`,
          )
        } else if (b.type === 'tool_result') {
          const content =
            typeof b.content === 'string'
              ? b.content
              : JSON.stringify(b.content)
          const truncated =
            content.length > 1000
              ? content.slice(0, 1000) + '...[truncated]'
              : content
          lines.push(`[Tool result: ${truncated}]`)
        } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
          // Omit thinking blocks from compact — they are internal
        }
      }
    }

    lines.push('')
  }

  return lines.join('\n')
}
