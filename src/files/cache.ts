/**
 * nanocode — LRU File State Cache
 *
 * Implements FileStateCache with LRU eviction, size limits,
 * deep clone for sub-agent isolation, and timestamp-based merge.
 */

import * as path from 'node:path'
import type { FileState, FileStateCache } from '../core/types.js'

const MAX_ENTRIES = 100
const MAX_TOTAL_BYTES = 25 * 1024 * 1024 // 25 MB

interface CacheEntry {
  state: FileState
  byteSize: number
}

/**
 * Normalize a file path to an absolute, canonical form.
 */
function normalizeKey(p: string): string {
  return path.resolve(path.normalize(p))
}

/**
 * Calculate the byte size of a file state's content.
 */
function contentSize(state: FileState): number {
  return Buffer.byteLength(state.content, 'utf-8')
}

/**
 * Create an LRU-based FileStateCache.
 *
 * - Max 100 entries
 * - Max 25 MB total content size
 * - Map preserves insertion order; re-insert on access to maintain LRU
 */
export function createFileStateCache(): FileStateCache {
  let store = new Map<string, CacheEntry>()
  let totalBytes = 0

  /**
   * Move a key to the end of the Map (most-recently-used position).
   */
  function touch(key: string): void {
    const entry = store.get(key)
    if (entry) {
      store.delete(key)
      store.set(key, entry)
    }
  }

  /**
   * Evict least-recently-used entries until we are within limits.
   */
  function evict(): void {
    // Evict by count
    while (store.size > MAX_ENTRIES) {
      const oldest = store.keys().next()
      if (oldest.done) break
      removeSilent(oldest.value)
    }
    // Evict by size
    while (totalBytes > MAX_TOTAL_BYTES && store.size > 0) {
      const oldest = store.keys().next()
      if (oldest.done) break
      removeSilent(oldest.value)
    }
  }

  /**
   * Remove an entry without returning, used internally by evict.
   */
  function removeSilent(key: string): void {
    const entry = store.get(key)
    if (entry) {
      totalBytes -= entry.byteSize
      store.delete(key)
    }
  }

  const cache: FileStateCache = {
    get(p: string): FileState | undefined {
      const key = normalizeKey(p)
      const entry = store.get(key)
      if (!entry) return undefined
      // Move to most-recently-used
      touch(key)
      return entry.state
    },

    set(p: string, state: FileState): void {
      const key = normalizeKey(p)
      // Remove old entry if present
      const existing = store.get(key)
      if (existing) {
        totalBytes -= existing.byteSize
        store.delete(key)
      }
      const byteSize = contentSize(state)
      totalBytes += byteSize
      store.set(key, { state, byteSize })
      evict()
    },

    has(p: string): boolean {
      const key = normalizeKey(p)
      return store.has(key)
    },

    delete(p: string): void {
      const key = normalizeKey(p)
      removeSilent(key)
    },

    keys(): IterableIterator<string> {
      return store.keys()
    },

    /**
     * Deep clone: returns an independent copy of the cache.
     * Used for sub-agent isolation so mutations don't cross boundaries.
     */
    clone(): FileStateCache {
      const copy = createFileStateCache()
      for (const [key, entry] of store) {
        copy.set(key, {
          content: entry.state.content,
          timestamp: entry.state.timestamp,
          offset: entry.state.offset,
          limit: entry.state.limit,
          isPartialView: entry.state.isPartialView,
        })
      }
      return copy
    },

    /**
     * Merge another cache into this one.
     * For overlapping keys, keep the entry with the newer timestamp.
     */
    merge(other: FileStateCache): void {
      for (const key of other.keys()) {
        const otherState = other.get(key)
        if (!otherState) continue
        const existing = store.get(normalizeKey(key))
        if (!existing || otherState.timestamp > existing.state.timestamp) {
          cache.set(key, otherState)
        }
      }
    },

    get size(): number {
      return store.size
    },
  }

  return cache
}
