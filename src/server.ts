#!/usr/bin/env node
/**
 * Computer Use MCP Server — exposes tools over MCP protocol.
 * Backed by in-process Rust NAPI module via session.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z, ZodTypeAny } from 'zod'
import { createSession, type SessionOptions } from './session.js'

const targetAppParam = z.string().optional().describe('Bundle ID of target app (auto-focuses before action)')
const coord = { coordinate: z.tuple([z.number(), z.number()]).describe('[x, y] pixels') }

const PROVIDERS = ['anthropic', 'openai', 'openai-low', 'gemini', 'llama', 'grok', 'mistral', 'qwen', 'nova', 'deepseek-vl', 'phi', 'auto'] as const

export interface ServerOptions extends SessionOptions {}

export function createComputerUseServer(opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'computer-use', version: '3.0.0' })
  const session = createSession({
    vision: opts.vision ?? (process.env.COMPUTER_USE_VISION !== 'false'),
    provider: opts.provider ?? process.env.COMPUTER_USE_PROVIDER,
  })

  const tool = (name: string, desc: string, schema: Record<string, ZodTypeAny>) => {
    server.tool(name, desc, schema, async (args: Record<string, unknown>) => {
      const result = await session.dispatch(name, args)
      return {
        content: result.content.map(c =>
          c.type === 'image'
            ? { type: 'image' as const, data: c.data, mimeType: c.mimeType }
            : { type: 'text' as const, text: c.text }
        ),
        isError: result.isError,
      }
    })
  }

  tool('screenshot', 'Capture the screen or a specific app window. Use `provider` to get optimal token cost for your AI provider.', {
    width: z.number().int().positive().optional()
      .describe('Override width in pixels. Omit to use provider-optimal default.'),
    quality: z.number().int().min(1).max(100).optional()
      .describe('JPEG quality 1–100. Default: 80. Lower = smaller = fewer tokens.'),
    target_app: z.string().optional()
      .describe('Bundle ID of app to capture (window only). Omit for full screen.'),
    provider: z.enum(PROVIDERS).optional()
      .describe('AI provider — sets optimal default width. anthropic=1024px, openai=1024px, gemini=768px, qwen/deepseek-vl/phi=896px. Default: auto (1024px).'),
  })
  tool('left_click', 'Left-click at coordinates', coord)
  tool('right_click', 'Right-click at coordinates', coord)
  tool('middle_click', 'Middle-click at coordinates', coord)
  tool('double_click', 'Double-click at coordinates', coord)
  tool('triple_click', 'Triple-click at coordinates', coord)
  tool('mouse_move', 'Move cursor to coordinates', coord)
  tool('left_click_drag', 'Click and drag', {
    coordinate: z.tuple([z.number(), z.number()]),
    start_coordinate: z.tuple([z.number(), z.number()]).optional(),
  })
  tool('cursor_position', 'Get current cursor position', {})
  tool('left_mouse_down', 'Press left mouse button', coord)
  tool('left_mouse_up', 'Release left mouse button', coord)
  tool('scroll', 'Scroll at position', {
    ...coord,
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().positive().default(3),
    target_app: targetAppParam,
  })
  tool('type', 'Type text into the focused app', {
    text: z.string(),
    target_app: targetAppParam,
  })
  tool('key', 'Press a key combination (e.g. "command+c", "return")', {
    text: z.string().describe('Key combo like "command+c" or "return"'),
    repeat: z.number().int().positive().optional(),
    target_app: targetAppParam,
  })
  tool('hold_key', 'Hold keys for a duration', {
    keys: z.array(z.string()),
    duration: z.number().positive().describe('Seconds'),
    target_app: targetAppParam,
  })
  tool('read_clipboard', 'Read clipboard contents', {})
  tool('write_clipboard', 'Write text to clipboard', { text: z.string() })
  tool('open_application', 'Open and focus an app by bundle ID', {
    bundle_id: z.string().describe('macOS bundle ID e.g. "com.apple.Safari"'),
  })
  tool('list_running_apps', 'List all running regular applications', {})
  tool('hide_app', 'Hide an app by bundle ID', { bundle_id: z.string() })
  tool('unhide_app', 'Unhide an app by bundle ID', { bundle_id: z.string() })
  tool('get_display_size', 'Get display dimensions and scale factor', {
    display_id: z.number().optional().describe('Display ID (omit for main display)'),
  })
  tool('list_displays', 'List all connected displays', {})
  tool('wait', 'Wait for N seconds', { duration: z.number().positive().max(300) })

  return server
}

// Standalone stdio entrypoint
if (process.argv[1]?.endsWith('/server.ts') || process.argv[1]?.endsWith('/server.js') || process.argv[1]?.endsWith('/computer-use-mcp')) {
  const server = createComputerUseServer()
  const transport = new StdioServerTransport()
  server.connect(transport).then(() => console.error('[computer-use-mcp] Server running'))
    .catch(err => { console.error('Fatal:', err); process.exit(1) })
}
