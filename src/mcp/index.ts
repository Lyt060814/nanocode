/**
 * MCP Manager — Initialize servers and register tools
 *
 * Orchestrates the full MCP lifecycle:
 *   1. Load server configs from settings files
 *   2. Spawn and connect to each server
 *   3. Discover tools via tools/list
 *   4. Wrap each MCP tool as a NanoCode Tool
 *   5. Return the aggregated tool array
 *
 * Also provides shutdown for graceful cleanup.
 */

import { z } from 'zod'

import type { Tool, ToolDef, ToolResult, ToolContext } from '../core/types.js'
import type { McpToolDefinition, McpToolCallResult } from './types.js'
import { McpClient, createMcpClient } from './client.js'
import { loadMcpConfig } from './config.js'

// ---------------------------------------------------------------------------
// Active client registry (for shutdown)
// ---------------------------------------------------------------------------

const activeClients: McpClient[] = []

// ---------------------------------------------------------------------------
// Tool wrapping
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema object (from the MCP server) into a Zod schema.
 *
 * MCP tools expose JSON Schema for their input. We wrap it in z.object({})
 * with a passthrough so any valid JSON object is accepted, since we cannot
 * fully translate arbitrary JSON Schema to Zod at runtime.
 *
 * The raw JSON Schema is preserved on the Zod type for the API to use.
 */
function jsonSchemaToZod(
  jsonSchema: Record<string, unknown> | undefined,
): z.ZodType<Record<string, unknown>> {
  // Use a passthrough object that accepts any keys
  const schema = z.record(z.string(), z.unknown())
  // Stash the original JSON schema for API serialization
  ;(schema as any)._jsonSchema = jsonSchema ?? { type: 'object' }
  return schema
}

/**
 * Wrap a single MCP tool definition as a NanoCode Tool.
 *
 * The resulting Tool delegates call() to the McpClient.callTool() method,
 * converting the MCP result format into NanoCode's ToolResult format.
 *
 * Tool names are prefixed with "mcp_{serverName}_" to avoid collisions
 * with built-in tools.
 *
 * @param serverName  Logical name of the MCP server
 * @param toolDef     Tool definition from the server's tools/list response
 * @param client      Connected McpClient instance
 * @returns           A fully-formed NanoCode Tool
 */
function wrapMcpTool(
  serverName: string,
  toolDef: McpToolDefinition,
  client: McpClient,
): Tool<Record<string, unknown>> {
  const prefixedName = `mcp__${serverName}__${toolDef.name}`
  const description = toolDef.description ?? `MCP tool: ${toolDef.name}`
  const inputSchema = jsonSchemaToZod(
    toolDef.inputSchema as Record<string, unknown> | undefined,
  )

  const tool: Tool<Record<string, unknown>> = {
    name: prefixedName,
    description,
    inputSchema,

    async call(
      input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolResult> {
      let result: McpToolCallResult
      try {
        result = await client.callTool(toolDef.name, input)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err)
        return {
          result: `MCP tool error: ${message}`,
          isError: true,
        }
      }

      // Convert MCP content blocks to a single text result
      const textParts: string[] = []
      for (const block of result.content) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text)
        } else if (block.type === 'resource' && block.text) {
          textParts.push(block.text)
        } else if (block.type === 'image' && block.data) {
          textParts.push(`[image: ${block.mimeType ?? 'unknown type'}]`)
        } else {
          // Unknown block type — serialize it
          textParts.push(JSON.stringify(block))
        }
      }

      return {
        result: textParts.join('\n') || '(empty result)',
        isError: result.isError ?? false,
      }
    },

    prompt(): string {
      return description
    },

    isConcurrencySafe(_input: Record<string, unknown>): boolean {
      // MCP tools are assumed to be safe for concurrent use since each
      // call is an independent RPC to the server process.
      return true
    },

    isReadOnly(_input: Record<string, unknown>): boolean {
      // We cannot know if an MCP tool is read-only without additional
      // metadata. Default to false (assume it may write).
      return false
    },

    maxResultSizeChars: 200_000,

    userFacingName(_input: Record<string, unknown>): string {
      return `${serverName}:${toolDef.name}`
    },
  }

  return tool
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize all configured MCP servers and return their tools.
 *
 * For each server defined in settings:
 *   1. Creates an McpClient
 *   2. Connects (spawn + initialize handshake)
 *   3. Lists available tools
 *   4. Wraps each tool for the NanoCode tool system
 *
 * Servers that fail to connect are logged to stderr and skipped.
 * The returned array may be empty if no servers are configured or
 * all fail to connect.
 *
 * @param cwd  Current working directory for loading project settings
 * @returns    Array of wrapped MCP tools ready for registration
 */
export async function initializeMcpServers(
  cwd: string,
): Promise<Tool[]> {
  const configs = await loadMcpConfig(cwd)
  const serverNames = Object.keys(configs)

  if (serverNames.length === 0) {
    return []
  }

  const tools: Tool[] = []

  // Connect to all servers concurrently
  const connectionResults = await Promise.allSettled(
    serverNames.map(async (name) => {
      const config = configs[name]
      const client = createMcpClient(name, config)

      try {
        await client.connect()
        activeClients.push(client)

        const toolDefs = await client.listTools()

        const wrappedTools = toolDefs.map((def) =>
          wrapMcpTool(name, def, client),
        )

        return { name, tools: wrappedTools }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err)
        process.stderr.write(
          `[mcp] Failed to connect to server "${name}": ${message}\n`,
        )

        // Attempt cleanup
        try {
          await client.disconnect()
        } catch {
          // Ignore cleanup errors
        }

        return { name, tools: [] as Tool[] }
      }
    }),
  )

  // Collect successful tools
  for (const result of connectionResults) {
    if (result.status === 'fulfilled') {
      const { name, tools: serverTools } = result.value
      if (serverTools.length > 0) {
        process.stderr.write(
          `[mcp] Server "${name}": ${serverTools.length} tool(s) registered\n`,
        )
        tools.push(...serverTools)
      }
    }
  }

  return tools
}

/**
 * Disconnect all active MCP clients.
 *
 * Should be called during graceful shutdown to clean up child processes.
 */
export async function shutdownMcpServers(): Promise<void> {
  const shutdownPromises = activeClients.map(async (client) => {
    try {
      await client.disconnect()
    } catch {
      // Ignore errors during shutdown
    }
  })

  await Promise.allSettled(shutdownPromises)
  activeClients.length = 0
}

/**
 * Get the number of currently active MCP server connections.
 */
export function getActiveMcpServerCount(): number {
  return activeClients.filter((c) => c.isConnected).length
}

/**
 * Get the names of currently active MCP servers.
 */
export function getActiveMcpServerNames(): string[] {
  return activeClients
    .filter((c) => c.isConnected)
    .map((c) => c.name)
}
