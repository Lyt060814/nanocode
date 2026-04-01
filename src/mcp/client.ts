/**
 * MCP (Model Context Protocol) stdio Client
 *
 * Spawns MCP server processes and communicates via JSON-RPC over stdin/stdout.
 * Supports: initialize, tools/list, tools/call
 *
 * Protocol:
 *   - Each JSON-RPC message is sent as a single line on stdin
 *   - Each response is read as a single line from stdout
 *   - Stderr is piped through for debugging
 *   - On server crash, auto-reconnect is attempted (max 3 retries)
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpServerConfig,
  McpToolDefinition,
  McpToolCallResult,
} from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Protocol version for MCP initialize handshake. */
const MCP_PROTOCOL_VERSION = '2024-11-05'

/** Maximum number of reconnect attempts on server crash. */
const MAX_RECONNECT_RETRIES = 3

/** Timeout for a single JSON-RPC request in milliseconds. */
const REQUEST_TIMEOUT_MS = 60_000

/** Timeout for the initialize handshake in milliseconds. */
const INIT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

export class McpClient {
  // --- Config ---
  private readonly serverName: string
  private readonly command: string
  private readonly args: string[]
  private readonly env: Record<string, string> | undefined

  // --- State ---
  private process: ChildProcess | null = null
  private readline: ReadlineInterface | null = null
  private _nextId = 1
  private connected = false
  private reconnectCount = 0

  // --- Pending request resolution ---
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: JsonRpcResponse) => void
      reject: (reason: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  // --- Server capabilities (populated after initialize) ---
  private serverInfo: Record<string, unknown> = {}
  private serverCapabilities: Record<string, unknown> = {}

  constructor(
    serverName: string,
    command: string,
    args: string[] = [],
    env?: Record<string, string>,
  ) {
    this.serverName = serverName
    this.command = command
    this.args = args
    this.env = env
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Spawn the child process and perform the MCP initialize handshake.
   *
   * After this resolves, the client is ready to call listTools() / callTool().
   */
  async connect(): Promise<void> {
    if (this.connected) return

    this._spawnProcess()
    await this._initialize()
    this.connected = true
    this.reconnectCount = 0
  }

  /**
   * Request the list of tools exposed by the server.
   *
   * @returns Array of tool definitions with name, description, and inputSchema.
   */
  async listTools(): Promise<McpToolDefinition[]> {
    await this._ensureConnected()

    const response = await this._sendRequest('tools/list', {})

    if (response.error) {
      throw new Error(
        `MCP tools/list error from "${this.serverName}": ${response.error.message}`,
      )
    }

    const result = response.result as { tools?: McpToolDefinition[] } | undefined
    return result?.tools ?? []
  }

  /**
   * Invoke a tool on the server.
   *
   * @param name  Tool name (as returned by listTools)
   * @param args  Tool arguments matching the tool's inputSchema
   * @returns     Tool result containing content blocks and optional error flag
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    await this._ensureConnected()

    const response = await this._sendRequest('tools/call', {
      name,
      arguments: args,
    })

    if (response.error) {
      return {
        content: [{ type: 'text', text: response.error.message }],
        isError: true,
      }
    }

    const result = response.result as McpToolCallResult | undefined
    if (!result) {
      return {
        content: [{ type: 'text', text: '(empty result)' }],
        isError: false,
      }
    }

    return result
  }

  /**
   * Gracefully disconnect: kill the child process and clean up.
   */
  async disconnect(): Promise<void> {
    this.connected = false

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new Error('MCP client disconnecting'))
      this.pendingRequests.delete(id)
    }

    // Close readline
    if (this.readline) {
      this.readline.close()
      this.readline = null
    }

    // Kill process
    if (this.process) {
      const proc = this.process
      this.process = null

      // Try graceful SIGTERM first
      proc.kill('SIGTERM')

      // Force kill after 2 seconds if still alive
      const forceKill = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // Already dead
        }
      }, 2000)

      proc.on('exit', () => clearTimeout(forceKill))
    }
  }

  /**
   * Whether the client is currently connected to the server.
   */
  get isConnected(): boolean {
    return this.connected
  }

  /**
   * The name of the server this client is connected to.
   */
  get name(): string {
    return this.serverName
  }

  // -------------------------------------------------------------------------
  // Internal: process management
  // -------------------------------------------------------------------------

  /**
   * Spawn the MCP server as a child process.
   *
   * stdin/stdout are used for JSON-RPC communication.
   * stderr is piped to the parent process for debugging.
   */
  private _spawnProcess(): void {
    const mergedEnv = {
      ...process.env,
      ...(this.env ?? {}),
    }

    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: mergedEnv,
      // Do not inherit the parent's signal handling
      detached: false,
    })

    // Pipe stderr through for debugging
    if (this.process.stderr) {
      this.process.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) {
          process.stderr.write(`[mcp:${this.serverName}] ${text}\n`)
        }
      })
    }

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      const wasConnected = this.connected
      this.connected = false

      // Reject all pending requests
      const exitMsg = `MCP server "${this.serverName}" exited (code=${code}, signal=${signal})`
      for (const [id, pending] of this.pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error(exitMsg))
        this.pendingRequests.delete(id)
      }

      if (wasConnected) {
        process.stderr.write(`${exitMsg}\n`)
      }
    })

    this.process.on('error', (err) => {
      this.connected = false
      process.stderr.write(
        `[mcp:${this.serverName}] Process error: ${err.message}\n`,
      )
    })

    // Set up line-based reading from stdout
    if (this.process.stdout) {
      this.readline = createInterface({
        input: this.process.stdout,
        crlfDelay: Infinity,
      })

      this.readline.on('line', (line: string) => {
        this._handleLine(line)
      })
    }
  }

  /**
   * Send the MCP initialize request and wait for the response.
   */
  private async _initialize(): Promise<void> {
    const response = await this._sendRequest(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'nanocode',
          version: '0.1.0',
        },
      },
      INIT_TIMEOUT_MS,
    )

    if (response.error) {
      throw new Error(
        `MCP initialize failed for "${this.serverName}": ${response.error.message}`,
      )
    }

    const result = response.result as Record<string, unknown> | undefined
    if (result) {
      this.serverInfo = (result.serverInfo as Record<string, unknown>) ?? {}
      this.serverCapabilities =
        (result.capabilities as Record<string, unknown>) ?? {}
    }

    // Send initialized notification (no response expected)
    this._sendNotification('notifications/initialized', {})
  }

  // -------------------------------------------------------------------------
  // Internal: JSON-RPC transport
  // -------------------------------------------------------------------------

  /**
   * Send a JSON-RPC request and wait for the matching response.
   *
   * @param method   The RPC method name
   * @param params   Parameters object
   * @param timeout  Request timeout in ms (defaults to REQUEST_TIMEOUT_MS)
   * @returns        The JSON-RPC response
   */
  private _sendRequest(
    method: string,
    params: Record<string, unknown>,
    timeout: number = REQUEST_TIMEOUT_MS,
  ): Promise<JsonRpcResponse> {
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        reject(new Error(`MCP server "${this.serverName}" stdin not writable`))
        return
      }

      const id = this._nextId++

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      // Set up timeout
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(
          new Error(
            `MCP request "${method}" to "${this.serverName}" timed out after ${timeout}ms`,
          ),
        )
      }, timeout)

      // Register pending request
      this.pendingRequests.set(id, { resolve, reject, timer })

      // Write request as a single JSON line
      const line = JSON.stringify(request) + '\n'
      this.process.stdin.write(line, 'utf-8')
    })
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  private _sendNotification(
    method: string,
    params: Record<string, unknown>,
  ): void {
    if (!this.process?.stdin?.writable) return

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    }

    const line = JSON.stringify(notification) + '\n'
    this.process.stdin.write(line, 'utf-8')
  }

  /**
   * Handle a line read from the server's stdout.
   *
   * Parses it as JSON-RPC and resolves the corresponding pending request.
   */
  private _handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let parsed: JsonRpcResponse
    try {
      parsed = JSON.parse(trimmed) as JsonRpcResponse
    } catch {
      // Not valid JSON — could be debug output, ignore
      return
    }

    // Only handle responses (must have an id)
    if (parsed.id === undefined || parsed.id === null) {
      // This is a server-initiated notification, ignore for now
      return
    }

    const pending = this.pendingRequests.get(parsed.id)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingRequests.delete(parsed.id)
      pending.resolve(parsed)
    }
  }

  // -------------------------------------------------------------------------
  // Internal: auto-reconnect
  // -------------------------------------------------------------------------

  /**
   * Ensure the client is connected, attempting reconnection if needed.
   *
   * If the server has crashed and we haven't exceeded MAX_RECONNECT_RETRIES,
   * spawn a new process and re-initialize.
   */
  private async _ensureConnected(): Promise<void> {
    if (this.connected) return

    if (this.reconnectCount >= MAX_RECONNECT_RETRIES) {
      throw new Error(
        `MCP server "${this.serverName}" is not connected and reconnect limit (${MAX_RECONNECT_RETRIES}) exceeded`,
      )
    }

    this.reconnectCount++
    process.stderr.write(
      `[mcp:${this.serverName}] Reconnecting (attempt ${this.reconnectCount}/${MAX_RECONNECT_RETRIES})...\n`,
    )

    // Clean up old process
    if (this.readline) {
      this.readline.close()
      this.readline = null
    }
    if (this.process) {
      try {
        this.process.kill('SIGKILL')
      } catch {
        // Already dead
      }
      this.process = null
    }

    // Spawn fresh and re-initialize
    this._spawnProcess()
    await this._initialize()
    this.connected = true
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Create an McpClient from a config object.
 *
 * @param name    Logical name of the server (used in logging)
 * @param config  Server configuration (command, args, env)
 * @returns       A new McpClient instance (not yet connected)
 */
export function createMcpClient(
  name: string,
  config: McpServerConfig,
): McpClient {
  return new McpClient(
    name,
    config.command,
    config.args ?? [],
    config.env,
  )
}
