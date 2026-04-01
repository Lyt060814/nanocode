/**
 * NanoCode Session Persistence
 *
 * Stores conversation transcripts as JSONL (JSON Lines) files.
 * Each session gets a directory under ~/.nanocode/sessions/{id}/
 * with a transcript.jsonl file containing one JSON object per line.
 *
 * Format: each line is a SessionEntry JSON object with:
 * - type: 'user' | 'assistant' | 'system' | 'compact_boundary'
 * - message: the Message object
 * - timestamp: Unix epoch ms
 * - id: unique entry ID
 */

import {
  readFile,
  writeFile,
  appendFile,
  mkdir,
  readdir,
  stat,
} from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

import type { Message, SessionEntry } from '../core/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base directory for all NanoCode sessions. */
const SESSIONS_BASE = join(homedir(), '.nanocode', 'sessions')

/** Transcript filename within each session directory. */
const TRANSCRIPT_FILE = 'transcript.jsonl'

/** Session metadata filename. */
const META_FILE = 'meta.json'

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Get the directory path for a session.
 */
export function getSessionDir(sessionId: string): string {
  return join(SESSIONS_BASE, sessionId)
}

/**
 * Get the transcript file path for a session.
 */
export function getSessionPath(sessionId: string): string {
  return join(getSessionDir(sessionId), TRANSCRIPT_FILE)
}

/**
 * Get the metadata file path for a session.
 */
function getMetaPath(sessionId: string): string {
  return join(getSessionDir(sessionId), META_FILE)
}

// ---------------------------------------------------------------------------
// Directory initialization
// ---------------------------------------------------------------------------

/**
 * Ensure the session directory exists.
 */
async function ensureSessionDir(sessionId: string): Promise<void> {
  const dir = getSessionDir(sessionId)
  await mkdir(dir, { recursive: true })
}

/**
 * Ensure the base sessions directory exists.
 */
async function ensureBaseDir(): Promise<void> {
  await mkdir(SESSIONS_BASE, { recursive: true })
}

// ---------------------------------------------------------------------------
// Session metadata
// ---------------------------------------------------------------------------

interface SessionMeta {
  id: string
  createdAt: number
  updatedAt: number
  cwd: string
  messageCount: number
  summary?: string
}

/**
 * Write or update session metadata.
 */
async function writeMeta(
  sessionId: string,
  meta: Partial<SessionMeta>,
): Promise<void> {
  const metaPath = getMetaPath(sessionId)
  let existing: SessionMeta

  try {
    const raw = await readFile(metaPath, 'utf-8')
    existing = JSON.parse(raw) as SessionMeta
  } catch {
    existing = {
      id: sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cwd: '',
      messageCount: 0,
    }
  }

  const updated: SessionMeta = {
    ...existing,
    ...meta,
    updatedAt: Date.now(),
  }

  await writeFile(metaPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8')
}

/**
 * Read session metadata.
 */
async function readMeta(sessionId: string): Promise<SessionMeta | null> {
  try {
    const raw = await readFile(getMetaPath(sessionId), 'utf-8')
    return JSON.parse(raw) as SessionMeta
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Message persistence
// ---------------------------------------------------------------------------

/**
 * Save a message to the session transcript.
 *
 * Appends a single JSONL line to the transcript file.
 * Creates the session directory if it doesn't exist.
 *
 * @param sessionId The session identifier
 * @param message The message to save
 */
export async function saveMessage(
  sessionId: string,
  message: Message,
): Promise<void> {
  await ensureSessionDir(sessionId)

  const entry: SessionEntry = {
    type: message.role === 'user' ? 'user' : 'assistant',
    message,
    timestamp: Date.now(),
    id: randomUUID(),
  }

  const line = JSON.stringify(entry) + '\n'
  const transcriptPath = getSessionPath(sessionId)

  await appendFile(transcriptPath, line, 'utf-8')

  // Update metadata
  await writeMeta(sessionId, {
    messageCount: (await countEntries(sessionId)),
  })
}

/**
 * Save multiple messages to the session transcript in batch.
 */
export async function saveMessages(
  sessionId: string,
  messages: Message[],
): Promise<void> {
  await ensureSessionDir(sessionId)

  const lines = messages
    .map((message) => {
      const entry: SessionEntry = {
        type: message.role === 'user' ? 'user' : 'assistant',
        message,
        timestamp: Date.now(),
        id: randomUUID(),
      }
      return JSON.stringify(entry)
    })
    .join('\n')

  const transcriptPath = getSessionPath(sessionId)
  await appendFile(transcriptPath, lines + '\n', 'utf-8')

  await writeMeta(sessionId, {
    messageCount: (await countEntries(sessionId)),
  })
}

// ---------------------------------------------------------------------------
// Session loading
// ---------------------------------------------------------------------------

/**
 * Load all messages from a session transcript.
 *
 * Parses the JSONL file and returns the messages in order.
 * Returns an empty array if the session doesn't exist.
 *
 * @param sessionId The session identifier
 * @returns Array of messages in chronological order
 */
export async function loadSession(sessionId: string): Promise<Message[]> {
  const transcriptPath = getSessionPath(sessionId)

  let raw: string
  try {
    raw = await readFile(transcriptPath, 'utf-8')
  } catch {
    return []
  }

  const messages: Message[] = []
  const lines = raw.split('\n').filter((line) => line.trim().length > 0)

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SessionEntry
      if (entry.message) {
        messages.push(entry.message)
      }
    } catch {
      // Skip malformed lines
      continue
    }
  }

  return messages
}

/**
 * Load raw session entries (with metadata like timestamps).
 */
export async function loadSessionEntries(
  sessionId: string,
): Promise<SessionEntry[]> {
  const transcriptPath = getSessionPath(sessionId)

  let raw: string
  try {
    raw = await readFile(transcriptPath, 'utf-8')
  } catch {
    return []
  }

  const entries: SessionEntry[] = []
  const lines = raw.split('\n').filter((line) => line.trim().length > 0)

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SessionEntry
      entries.push(entry)
    } catch {
      continue
    }
  }

  return entries
}

/**
 * Count the number of entries in a session transcript.
 */
async function countEntries(sessionId: string): Promise<number> {
  const transcriptPath = getSessionPath(sessionId)

  try {
    const raw = await readFile(transcriptPath, 'utf-8')
    return raw.split('\n').filter((line) => line.trim().length > 0).length
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Session listing
// ---------------------------------------------------------------------------

export interface SessionInfo {
  id: string
  createdAt: number
  updatedAt: number
  cwd: string
  messageCount: number
  summary?: string
}

/**
 * List all available sessions.
 *
 * Returns session info sorted by most recently updated first.
 */
export async function listSessions(): Promise<SessionInfo[]> {
  await ensureBaseDir()

  let entries: string[]
  try {
    const dirEntries = await readdir(SESSIONS_BASE, { withFileTypes: true })
    entries = dirEntries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }

  const sessions: SessionInfo[] = []

  for (const sessionId of entries) {
    const meta = await readMeta(sessionId)
    if (meta) {
      sessions.push({
        id: meta.id,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        cwd: meta.cwd,
        messageCount: meta.messageCount,
        summary: meta.summary,
      })
    } else {
      // No metadata — try to infer from transcript
      const transcriptPath = getSessionPath(sessionId)
      try {
        const s = await stat(transcriptPath)
        const count = await countEntries(sessionId)
        sessions.push({
          id: sessionId,
          createdAt: s.birthtimeMs,
          updatedAt: s.mtimeMs,
          cwd: '',
          messageCount: count,
        })
      } catch {
        // Skip sessions that can't be read
        continue
      }
    }
  }

  // Sort by most recently updated
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)

  return sessions
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Generate a new unique session ID.
 */
export function newSessionId(): string {
  return randomUUID()
}

/**
 * Initialize a new session with metadata.
 */
export async function initSession(
  sessionId: string,
  cwd: string,
): Promise<void> {
  await ensureSessionDir(sessionId)
  await writeMeta(sessionId, {
    id: sessionId,
    createdAt: Date.now(),
    cwd,
    messageCount: 0,
  })
}

/**
 * Check if a session exists.
 */
export async function sessionExists(sessionId: string): Promise<boolean> {
  try {
    await stat(getSessionDir(sessionId))
    return true
  } catch {
    return false
  }
}

/**
 * Update the session summary (used after compaction).
 */
export async function updateSessionSummary(
  sessionId: string,
  summary: string,
): Promise<void> {
  await writeMeta(sessionId, { summary })
}
