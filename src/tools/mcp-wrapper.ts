/**
 * MCP Wrapper — Placeholder for MCP tool integration
 *
 * MCP (Model Context Protocol) tools are dynamically registered when MCP
 * servers are configured. This module provides the wrapper that converts
 * MCP tool calls to the nanocode Tool interface.
 *
 * Will be connected to an MCP client in a future phase.
 */

import { z } from 'zod'
import type { Tool, ToolDef, ToolResult, ToolContext } from '../core/types.js'
import { buildTool } from './registry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export type McpCallFn = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<McpCallResult>

export interface McpCallResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>
  isError?: boolean
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// MCP Tool Wrapping
// ---------------------------------------------------------------------------

/**
 * Create a nanocode Tool wrapper for an MCP tool.
 *
 * The wrapper translates between nanocode's ToolDef interface and
 * the MCP protocol's tool call format.
 *
 * @param serverName - Name of the MCP server providing this tool
 * @param mcpTool - The MCP tool definition (name, description, schema)
 * @param callMcp - Function to invoke the MCP tool on its server
 * @returns A fully-built nanocode Tool
 */
export function wrapMcpTool(
  serverName: string,
  mcpTool: McpToolDefinition,
  callMcp: McpCallFn,
): Tool {
  const fullName = `mcp__${serverName}__${mcpTool.name}`

  const def: ToolDef<Record<string, unknown>> = {
    name: fullName,

    description: mcpTool.description || `MCP tool: ${mcpTool.name} from ${serverName}`,

    // Accept any input — MCP tools have dynamic schemas
    inputSchema: z.record(z.unknown()),

    async call(input: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      try {
        const result = await callMcp(mcpTool.name, input)

        // MCP returns content blocks
        if (Array.isArray(result?.content)) {
          const textParts = result.content
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text as string)

          const text = textParts.length > 0
            ? textParts.join('\n')
            : JSON.stringify(result, null, 2)

          return {
            result: text,
            isError: result.isError ?? false,
          }
        }

        return {
          result: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          isError: false,
        }
      } catch (err) {
        return {
          result: `MCP tool error (${fullName}): ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },

    prompt(): string {
      return `MCP tool from server "${serverName}". ${mcpTool.description || ''}`
    },

    // Fail-closed defaults for MCP tools
    isConcurrencySafe: () => true,  // MCP calls are independent
    isReadOnly: () => false,         // Cannot determine — fail-closed
    maxResultSizeChars: 50_000,

    userFacingName(): string {
      return fullName
    },
  }

  return buildTool(def)
}

// ---------------------------------------------------------------------------
// MCP Server Registry
// ---------------------------------------------------------------------------

const _mcpTools: Map<string, Tool> = new Map()

/**
 * Register MCP tools from a server.
 */
export function registerMcpTools(tools: Tool[]): void {
  for (const tool of tools) {
    _mcpTools.set(tool.name, tool)
  }
}

/**
 * Get all registered MCP tools.
 */
export function getMcpTools(): Tool[] {
  return Array.from(_mcpTools.values())
}

/**
 * Get an MCP tool by name.
 */
export function getMcpToolByName(name: string): Tool | undefined {
  return _mcpTools.get(name)
}

/**
 * Clear all MCP tools (for testing or server disconnect).
 */
export function clearMcpTools(): void {
  _mcpTools.clear()
}

/**
 * Register all tools from an MCP server.
 *
 * @param serverName - Name identifier for the MCP server
 * @param toolDefs - Array of MCP tool definitions from the server
 * @param callMcp - Function to call tools on this server
 * @returns Array of wrapped nanocode tools
 */
export function registerMcpServer(
  serverName: string,
  toolDefs: McpToolDefinition[],
  callMcp: McpCallFn,
): Tool[] {
  const tools: Tool[] = []

  for (const mcpTool of toolDefs) {
    const wrapped = wrapMcpTool(serverName, mcpTool, callMcp)
    _mcpTools.set(wrapped.name, wrapped)
    tools.push(wrapped)
  }

  return tools
}
