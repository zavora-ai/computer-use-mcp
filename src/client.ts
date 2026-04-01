/**
 * Computer Use MCP Client — typed API over MCP protocol.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  isError?: boolean
}

export interface ComputerUseClient {
  listTools(): Promise<Array<{ name: string; description?: string }>>
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResult>
  close(): Promise<void>
  // Typed convenience
  screenshot(): Promise<ToolResult>
  click(x: number, y: number): Promise<ToolResult>
  doubleClick(x: number, y: number): Promise<ToolResult>
  rightClick(x: number, y: number): Promise<ToolResult>
  moveMouse(x: number, y: number): Promise<ToolResult>
  drag(to: [number, number], from?: [number, number]): Promise<ToolResult>
  type(text: string, targetApp?: string): Promise<ToolResult>
  key(combo: string, targetApp?: string): Promise<ToolResult>
  scroll(x: number, y: number, direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<ToolResult>
  readClipboard(): Promise<ToolResult>
  writeClipboard(text: string): Promise<ToolResult>
  openApp(bundleId: string): Promise<ToolResult>
  cursorPosition(): Promise<ToolResult>
  wait(seconds: number): Promise<ToolResult>
}

export async function connectStdio(command: string, args: string[], cwd?: string): Promise<ComputerUseClient> {
  const transport = new StdioClientTransport({ command, args, cwd })
  const client = new Client({ name: 'computer-use-client', version: '2.0.0' })
  await client.connect(transport)
  return wrap(client, () => client.close())
}

export async function connectInProcess(server: McpServer): Promise<ComputerUseClient> {
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'computer-use-client', version: '2.0.0' })
  await server.connect(st)
  await client.connect(ct)
  return wrap(client, async () => { await client.close(); await server.close() })
}

function wrap(client: Client, closeFn: () => Promise<void>): ComputerUseClient {
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args })) as ToolResult

  return {
    async listTools() { return (await client.listTools()).tools.map(t => ({ name: t.name, description: t.description })) },
    callTool: call,
    close: closeFn,
    screenshot: () => call('screenshot'),
    click: (x, y) => call('left_click', { coordinate: [x, y] }),
    doubleClick: (x, y) => call('double_click', { coordinate: [x, y] }),
    rightClick: (x, y) => call('right_click', { coordinate: [x, y] }),
    moveMouse: (x, y) => call('mouse_move', { coordinate: [x, y] }),
    drag: (to, from) => call('left_click_drag', { coordinate: to, ...(from ? { start_coordinate: from } : {}) }),
    type: (text, app) => call('type', { text, ...(app ? { target_app: app } : {}) }),
    key: (combo, app) => call('key', { text: combo, ...(app ? { target_app: app } : {}) }),
    scroll: (x, y, dir, amt = 3) => call('scroll', { coordinate: [x, y], direction: dir, amount: amt }),
    readClipboard: () => call('read_clipboard'),
    writeClipboard: (text) => call('write_clipboard', { text }),
    openApp: (id) => call('open_application', { bundle_id: id }),
    cursorPosition: () => call('cursor_position'),
    wait: (s) => call('wait', { duration: s }),
  }
}
