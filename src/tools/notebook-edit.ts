/**
 * Notebook Edit Tool — Edit Jupyter notebook cells
 *
 * Parses .ipynb JSON format, edits a specific cell, and writes back.
 * Handles code, markdown, and raw cell types.
 */

import { readFileSync, writeFileSync, statSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext } from '../core/types.js'

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  notebook_path: z.string().describe(
    'Path to the .ipynb file. Absolute or relative to working directory.',
  ),
  cell_index: z.number().int().min(0).describe(
    '0-based cell index to edit.',
  ),
  new_source: z.string().describe(
    'New source code/content for the cell.',
  ),
  cell_type: z.enum(['code', 'markdown', 'raw']).optional().describe(
    'Optionally change the cell type.',
  ),
})

type NotebookEditInput = z.infer<typeof inputSchema>

// ---------------------------------------------------------------------------
// Notebook Types
// ---------------------------------------------------------------------------

interface NotebookCell {
  cell_type: string
  source: string | string[]
  metadata: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
}

interface Notebook {
  cells: NotebookCell[]
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

// ---------------------------------------------------------------------------
// Atomic Write
// ---------------------------------------------------------------------------

function atomicWriteFileSync(filePath: string, content: string): void {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })

  const tempPath = join(dir, `.nanocode-tmp-${randomUUID()}`)
  try {
    writeFileSync(tempPath, content, 'utf-8')
    renameSync(tempPath, filePath)
  } catch (err) {
    try { unlinkSync(tempPath) } catch { /* ignore */ }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const notebookEditToolDef: ToolDef<NotebookEditInput> = {
  name: 'NotebookEdit',

  description: 'Edit a Jupyter notebook (.ipynb) cell. Specify the notebook path, cell index (0-based), and the new cell source code.',

  inputSchema,

  async call(input: NotebookEditInput, context: ToolContext): Promise<ToolResult> {
    const { cell_index, new_source, cell_type } = input
    const filePath = resolve(context.cwd, input.notebook_path)

    // Read notebook
    let rawContent: string
    try {
      rawContent = readFileSync(filePath, 'utf-8')
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { result: `Error: notebook not found: ${filePath}`, isError: true }
      }
      return {
        result: `Error reading notebook: ${err.message}`,
        isError: true,
      }
    }

    // Parse JSON
    let notebook: Notebook
    try {
      notebook = JSON.parse(rawContent)
    } catch {
      return {
        result: 'Error: file is not valid JSON (not a Jupyter notebook).',
        isError: true,
      }
    }

    // Validate structure
    if (!notebook.cells || !Array.isArray(notebook.cells)) {
      return {
        result: 'Error: not a valid Jupyter notebook (no cells array).',
        isError: true,
      }
    }

    if (cell_index >= notebook.cells.length) {
      return {
        result: `Error: cell index ${cell_index} out of range (notebook has ${notebook.cells.length} cells, indices 0-${notebook.cells.length - 1}).`,
        isError: true,
      }
    }

    // Get the target cell
    const cell = notebook.cells[cell_index]!

    // Capture old source for reporting
    const oldSource = Array.isArray(cell.source)
      ? cell.source.join('')
      : (cell.source || '')

    // Update cell source
    // Notebooks store source as an array of lines, each ending with \n except the last
    const lines = new_source.split('\n')
    const notebookLines = lines.map((line, i) =>
      i < lines.length - 1 ? line + '\n' : line,
    )
    cell.source = notebookLines

    // Optionally change cell type
    if (cell_type) {
      cell.cell_type = cell_type
    }

    // Clear outputs for code cells (they're stale after editing)
    if (cell.cell_type === 'code') {
      cell.outputs = []
      cell.execution_count = null
    }

    // Serialize and write back
    const newContent = JSON.stringify(notebook, null, 1) + '\n'

    try {
      atomicWriteFileSync(filePath, newContent)
    } catch (err: any) {
      return {
        result: `Error writing notebook: ${err.message}`,
        isError: true,
      }
    }

    // Track in history
    context.modifiedFiles.add(filePath)
    context.fileHistory.trackedFiles.add(filePath)

    // Update readFileState cache
    let mtime: number
    try {
      mtime = statSync(filePath).mtimeMs
    } catch {
      mtime = Date.now()
    }

    context.readFileState.set(filePath, {
      content: newContent,
      timestamp: mtime,
    })

    return {
      result: `Edited cell ${cell_index} in ${input.notebook_path}\nOld source (${oldSource.length} chars) -> New source (${new_source.length} chars)${cell_type ? `\nCell type changed to: ${cell_type}` : ''}`,
      isError: false,
    }
  },

  prompt(): string {
    return [
      'Edit Jupyter notebook (.ipynb) cells.',
      '',
      'Guidelines:',
      '- Cell index is 0-based.',
      '- Code cell outputs are cleared after editing.',
      '- You can optionally change the cell type (code, markdown, raw).',
      '- Read the notebook first to see current cell contents.',
    ].join('\n')
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  maxResultSizeChars: 10_000,

  userFacingName(input: NotebookEditInput): string {
    return `NotebookEdit: ${input.notebook_path} cell ${input.cell_index}`
  },
}
