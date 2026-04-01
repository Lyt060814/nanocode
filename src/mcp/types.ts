/**
 * MCP (Model Context Protocol) Type Definitions
 *
 * JSON-RPC 2.0 message types and MCP-specific structures for
 * communicating with MCP server processes over stdio.
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 base types
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: JsonRpcError
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

// ---------------------------------------------------------------------------
// MCP server configuration
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

// ---------------------------------------------------------------------------
// MCP tool definitions (as returned by tools/list)
// ---------------------------------------------------------------------------

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// MCP tool call results (as returned by tools/call)
// ---------------------------------------------------------------------------

export interface McpToolCallResult {
  content: McpContentBlock[]
  isError?: boolean
}

export interface McpContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
}
