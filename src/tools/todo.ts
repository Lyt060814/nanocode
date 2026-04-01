/**
 * Todo Tool — In-memory task management
 *
 * Manages a task list during the session for tracking multi-step work.
 * Tasks persist only for the current session.
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ToolDef, ToolResult, ToolContext } from '../core/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TaskStatus = 'pending' | 'in_progress' | 'completed'

interface Task {
  id: string
  task: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// In-Memory Store (per-session)
// ---------------------------------------------------------------------------

const taskStore: Map<string, Task> = new Map()

// ---------------------------------------------------------------------------
// Input Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  command: z.enum(['create', 'update', 'list']).describe(
    'The operation to perform: create a new task, update an existing task, or list all tasks.',
  ),
  task: z.string().optional().describe(
    'Task description (required for "create").',
  ),
  id: z.string().optional().describe(
    'Task ID (required for "update").',
  ),
  status: z.enum(['pending', 'in_progress', 'completed']).optional().describe(
    'New status for the task (used with "update"). Default: in_progress.',
  ),
})

type TodoInput = z.infer<typeof inputSchema>

// ---------------------------------------------------------------------------
// Task Formatting
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
}

function formatTask(task: Task): string {
  const icon = STATUS_ICONS[task.status]
  return `${icon} ${task.id.slice(0, 8)} | ${task.task} (${task.status})`
}

function formatTaskList(tasks: Task[]): string {
  if (tasks.length === 0) {
    return 'No tasks.'
  }

  const pending = tasks.filter((t) => t.status === 'pending')
  const inProgress = tasks.filter((t) => t.status === 'in_progress')
  const completed = tasks.filter((t) => t.status === 'completed')

  const sections: string[] = []

  if (inProgress.length > 0) {
    sections.push('In Progress:')
    sections.push(...inProgress.map((t) => `  ${formatTask(t)}`))
  }

  if (pending.length > 0) {
    sections.push('Pending:')
    sections.push(...pending.map((t) => `  ${formatTask(t)}`))
  }

  if (completed.length > 0) {
    sections.push('Completed:')
    sections.push(...completed.map((t) => `  ${formatTask(t)}`))
  }

  sections.push('')
  sections.push(`Total: ${tasks.length} (${pending.length} pending, ${inProgress.length} in progress, ${completed.length} completed)`)

  return sections.join('\n')
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const todoToolDef: ToolDef<TodoInput> = {
  name: 'Todo',

  description: 'Manage a task list for tracking multi-step work. Create tasks, update their status, and list all tasks.',

  inputSchema,

  async call(input: TodoInput, context: ToolContext): Promise<ToolResult> {
    const { command, task, id, status } = input

    switch (command) {
      case 'create': {
        if (!task || !task.trim()) {
          return { result: 'Error: task description is required for "create".', isError: true }
        }

        const newTask: Task = {
          id: randomUUID(),
          task: task.trim(),
          status: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

        taskStore.set(newTask.id, newTask)

        return {
          result: `Created task: ${formatTask(newTask)}`,
          isError: false,
        }
      }

      case 'update': {
        if (!id) {
          return { result: 'Error: task ID is required for "update".', isError: true }
        }

        // Find task by full ID or prefix match
        let foundTask: Task | undefined
        if (taskStore.has(id)) {
          foundTask = taskStore.get(id)
        } else {
          // Prefix match
          for (const [taskId, t] of taskStore) {
            if (taskId.startsWith(id)) {
              foundTask = t
              break
            }
          }
        }

        if (!foundTask) {
          return { result: `Error: task not found with ID: ${id}`, isError: true }
        }

        const newStatus = status ?? 'in_progress'
        foundTask.status = newStatus
        foundTask.updatedAt = Date.now()

        // Update task description if provided
        if (task && task.trim()) {
          foundTask.task = task.trim()
        }

        return {
          result: `Updated task: ${formatTask(foundTask)}`,
          isError: false,
        }
      }

      case 'list': {
        const allTasks = Array.from(taskStore.values())
          .sort((a, b) => {
            // Sort: in_progress first, then pending, then completed
            const order: Record<TaskStatus, number> = { in_progress: 0, pending: 1, completed: 2 }
            const statusDiff = order[a.status] - order[b.status]
            if (statusDiff !== 0) return statusDiff
            return a.createdAt - b.createdAt
          })

        return {
          result: formatTaskList(allTasks),
          isError: false,
        }
      }

      default:
        return {
          result: `Error: unknown command "${command}". Use "create", "update", or "list".`,
          isError: true,
        }
    }
  },

  prompt(): string {
    return [
      'Track multi-step tasks during the session.',
      '',
      'Commands:',
      '  create — Create a new task (requires task description)',
      '  update — Update task status (requires id, optional status)',
      '  list   — List all tasks',
      '',
      'Statuses: pending, in_progress, completed',
    ].join('\n')
  },

  isReadOnly: () => false, // Modifies in-memory state
  isConcurrencySafe: () => false,
  maxResultSizeChars: 10_000,

  userFacingName(input: TodoInput): string {
    return `Todo: ${input.command}`
  },
}

/**
 * Reset task store (useful for testing).
 */
export function resetTodoStore(): void {
  taskStore.clear()
}
