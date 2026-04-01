/**
 * nanocode Core Types
 *
 * All shared type definitions for the agent system.
 * Mirrors Claude Code's type architecture with simplifications.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Content Blocks (API-compatible)
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | ContentBlock[]
  is_error?: boolean
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}

export interface ImageBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ImageBlock

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant'

export interface Message {
  role: MessageRole
  content: ContentBlock[]
  id?: string
}

// ---------------------------------------------------------------------------
// Stream Events (yielded by agent loop)
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { type: 'assistant_text'; text: string }
  | { type: 'assistant_message'; message: Message }
  | { type: 'tool_use'; toolUse: ToolUseBlock }
  | { type: 'tool_result'; toolUseId: string; toolName: string; result: string; isError: boolean }
  | { type: 'tool_start'; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'turn_complete'; stopReason: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'compact'; oldTokens: number; newTokens: number }
  | { type: 'error'; error: Error }
  | { type: 'max_turns_reached'; maxTurns: number }
  | { type: 'thinking'; text: string }

// ---------------------------------------------------------------------------
// Tool System
// ---------------------------------------------------------------------------

export interface ToolResult {
  result: string
  isError?: boolean
}

export interface ToolContext {
  cwd: string
  readFileState: FileStateCache
  fileHistory: FileHistoryState
  modifiedFiles: Set<string>
  sessionId: string
  abortSignal?: AbortSignal
  permissionMode: PermissionMode
  onPermissionRequest: (tool: string, input: unknown, message: string) => Promise<PermissionDecision>
}

export interface ToolDef<Input = any> {
  name: string
  description: string | ((input?: Input) => string)
  inputSchema: z.ZodType<Input>
  call(input: Input, context: ToolContext): Promise<ToolResult>
  prompt?(): string
  isConcurrencySafe?: (input: Input) => boolean
  isReadOnly?: (input: Input) => boolean
  maxResultSizeChars?: number
  userFacingName?: (input: Input) => string
}

export interface Tool<Input = any> extends Required<Pick<ToolDef<Input>,
  'name' | 'description' | 'inputSchema' | 'call'
>> {
  prompt: () => string
  isConcurrencySafe: (input: Input) => boolean
  isReadOnly: (input: Input) => boolean
  maxResultSizeChars: number
  userFacingName: (input: Input) => string
}

// ---------------------------------------------------------------------------
// Permission System
// ---------------------------------------------------------------------------

export type PermissionBehavior = 'allow' | 'deny' | 'ask'

export interface PermissionDecision {
  behavior: PermissionBehavior
  message?: string
  updatedInput?: unknown
}

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'

export interface PermissionRule {
  tool: string
  content?: string
  behavior: 'allow' | 'deny'
  source: 'session' | 'project' | 'user'
}

// ---------------------------------------------------------------------------
// File System
// ---------------------------------------------------------------------------

export interface FileState {
  content: string
  timestamp: number
  offset?: number
  limit?: number
  isPartialView?: boolean
}

export interface FileStateCache {
  get(path: string): FileState | undefined
  set(path: string, state: FileState): void
  has(path: string): boolean
  delete(path: string): void
  keys(): IterableIterator<string>
  clone(): FileStateCache
  merge(other: FileStateCache): void
  readonly size: number
}

export interface FileHistoryBackup {
  backupFileName: string | null
  version: number
  backupTime: Date
}

export interface FileHistorySnapshot {
  messageId: string
  trackedFileBackups: Map<string, FileHistoryBackup>
  timestamp: Date
}

export interface FileHistoryState {
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
  snapshotSequence: number
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionEntry {
  type: 'user' | 'assistant' | 'system' | 'compact_boundary'
  message: Message
  timestamp: number
  id: string
}

export interface CompactBoundary {
  type: 'compact_boundary'
  trigger: 'auto' | 'manual'
  preCompactTokenCount: number
  timestamp: number
}

// ---------------------------------------------------------------------------
// Query Params (input to agent loop)
// ---------------------------------------------------------------------------

export interface ModelConfig {
  model: string
  contextWindow: number
  maxOutputTokens: number
  supportsThinking: boolean
  supportsCaching: boolean
  pricePerInputToken: number
  pricePerOutputToken: number
  pricePerCacheRead: number
  pricePerCacheWrite: number
}

export interface QueryParams {
  messages: Message[]
  tools: Tool[]
  modelConfig: ModelConfig
  systemPromptBlocks: SystemPromptBlock[]
  maxTurns?: number
  permissionMode: PermissionMode
  apiKey: string
  cwd: string
  sessionId: string
  onPermissionRequest: (tool: string, input: unknown, message: string) => Promise<PermissionDecision>
  abortSignal?: AbortSignal
  enableThinking?: boolean
  thinkingBudget?: number
  // Injected services
  readFileState: FileStateCache
  fileHistory: FileHistoryState
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

export interface SystemPromptBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

// ---------------------------------------------------------------------------
// Token Usage
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface CostTracker {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  turns: number
  add(usage: TokenUsage): void
  totalCostUSD(config: ModelConfig): number
  summary(config: ModelConfig): string
}

// ---------------------------------------------------------------------------
// Slash Commands
// ---------------------------------------------------------------------------

export interface SlashCommand {
  name: string
  description: string
  execute(args: string, context: CommandContext): Promise<string | void>
}

export interface CommandContext {
  messages: Message[]
  tools: Tool[]
  modelConfig: ModelConfig
  cwd: string
  sessionId: string
  costTracker: CostTracker
  fileHistory: FileHistoryState
  readFileState: FileStateCache
  permissionMode: PermissionMode
  setPermissionMode: (mode: PermissionMode) => void
  setModel: (model: string) => void
  clearMessages: () => void
  compact: () => Promise<void>
  resumeSession: (sessionId: string) => Promise<string | null>
  /** Inject a user-message prompt into the agent loop (for prompt-type commands like /init) */
  sendPrompt: (prompt: string) => void
}
