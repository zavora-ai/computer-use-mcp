#!/usr/bin/env node
/**
 * Computer Use MCP Server — exposes tools over MCP protocol.
 * Backed by in-process Rust NAPI module via session.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z, ZodTypeAny } from 'zod'
import { createSession, type Session, type SessionOptions } from './session.js'

const targetAppParam = z.string().optional().describe('Bundle ID of target app (auto-focuses before action)')
const targetWindowIdParam = z.number().int().optional().describe('CGWindowID to target. Takes precedence over target_app.')
const focusStrategyParam = z.enum(['strict', 'best_effort', 'none']).optional().describe('Focus strategy: strict (fail if unconfirmed), best_effort (try and proceed), none (skip activation)')
const coord = { coordinate: z.tuple([z.number(), z.number()]).describe('[x, y] pixels') }
const withTargeting = (schema: Record<string, ZodTypeAny>) => ({
  ...schema,
  target_app: targetAppParam,
  target_window_id: targetWindowIdParam,
  focus_strategy: focusStrategyParam,
})

const PROVIDERS = ['anthropic', 'openai', 'openai-low', 'gemini', 'llama', 'grok', 'mistral', 'qwen', 'nova', 'deepseek-vl', 'phi', 'auto'] as const

export interface ServerOptions extends SessionOptions {
  /** Override session instance for tests */
  session?: Session
}

export function createComputerUseServer(opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'computer-use', version: '5.0.0' })
  const session = opts.session ?? createSession({
    vision: opts.vision ?? (process.env.COMPUTER_USE_VISION !== 'false'),
    provider: opts.provider ?? process.env.COMPUTER_USE_PROVIDER,
    native: opts.native,
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

  tool('screenshot', 'Capture the screen or a specific window. BEFORE using this, consider get_ui_tree or find_element to discover UI by role/label — structured queries are cheaper than visual parsing. Auto-targets the active session window when no explicit target is given.', {
    width: z.number().int().positive().optional()
      .describe('Override width in pixels. Omit to use provider-optimal default.'),
    quality: z.number().int().min(1).max(100).optional()
      .describe('JPEG quality 1–100. Default: 80. Lower = smaller = fewer tokens.'),
    target_app: z.string().optional()
      .describe('Bundle ID of app to capture (window only). Omit for full screen.'),
    target_window_id: targetWindowIdParam,
    provider: z.enum(PROVIDERS).optional()
      .describe('AI provider — sets optimal default width. anthropic=1024px, openai=1024px, gemini=768px, qwen/deepseek-vl/phi=896px. Default: auto (1024px).'),
  })
  tool('left_click', 'Left-click at coordinates', withTargeting(coord))
  tool('right_click', 'Right-click at coordinates', withTargeting(coord))
  tool('middle_click', 'Middle-click at coordinates', withTargeting(coord))
  tool('double_click', 'Double-click at coordinates', withTargeting(coord))
  tool('triple_click', 'Triple-click at coordinates', withTargeting(coord))
  tool('mouse_move', 'Move cursor to coordinates', withTargeting(coord))
  tool('left_click_drag', 'Click and drag', withTargeting({
    coordinate: z.tuple([z.number(), z.number()]),
    start_coordinate: z.tuple([z.number(), z.number()]).optional(),
  }))
  tool('cursor_position', 'Get current cursor position', {})
  tool('left_mouse_down', 'Press left mouse button', withTargeting(coord))
  tool('left_mouse_up', 'Release left mouse button', withTargeting(coord))
  tool('scroll', 'Scroll at position', {
    ...coord,
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().positive().default(3),
    target_app: targetAppParam,
    target_window_id: targetWindowIdParam,
    focus_strategy: focusStrategyParam,
  })
  tool('type', 'Type text into the focused app. For form fields, prefer set_value or fill_form — accessibility-based writes are more reliable and need no click-to-focus.', {
    text: z.string(),
    target_app: targetAppParam,
    target_window_id: targetWindowIdParam,
    focus_strategy: focusStrategyParam,
  })
  tool('key', 'Press a key combination (e.g. "command+c", "return"). Tab and Shift+Tab navigate between form fields; keyboard shortcuts are usually faster than coordinate-based clicks.', {
    text: z.string().describe('Key combo like "command+c" or "return"'),
    repeat: z.number().int().positive().optional(),
    target_app: targetAppParam,
    target_window_id: targetWindowIdParam,
    focus_strategy: focusStrategyParam,
  })
  tool('hold_key', 'Hold keys for a duration', {
    keys: z.array(z.string()),
    duration: z.number().positive().describe('Seconds'),
    target_app: targetAppParam,
    target_window_id: targetWindowIdParam,
    focus_strategy: focusStrategyParam,
  })
  tool('read_clipboard', 'Read clipboard contents', {})
  tool('write_clipboard', 'Write text to clipboard', { text: z.string() })
  tool('open_application', 'Open and focus an app by bundle ID', {
    bundle_id: z.string().describe('macOS bundle ID e.g. "com.apple.Safari"'),
  })
  tool('get_frontmost_app', 'Get the currently frontmost app', {})
  tool('list_windows', 'List visible on-screen windows, optionally filtered by bundle ID', {
    bundle_id: z.string().optional().describe('Bundle ID to filter windows by'),
  })
  tool('list_running_apps', 'List all running regular applications', {})
  tool('hide_app', 'Hide an app by bundle ID', { bundle_id: z.string() })
  tool('unhide_app', 'Unhide an app by bundle ID', { bundle_id: z.string() })
  tool('get_display_size', 'Get display dimensions and scale factor', {
    display_id: z.number().optional().describe('Display ID (omit for main display)'),
  })
  tool('list_displays', 'List all connected displays', {})
  tool('get_window', 'Look up a window by its CGWindowID', {
    window_id: z.number().int().describe('CGWindowID of the window to look up'),
  })
  tool('get_cursor_window', 'Get the window currently under the mouse cursor', {})
  tool('activate_app', 'Activate an app and return structured before/after diagnostics', {
    bundle_id: z.string().describe('macOS bundle ID'),
    timeout_ms: z.number().int().positive().optional().describe('Activation polling timeout in ms'),
  })
  tool('activate_window', 'Raise a specific window by CGWindowID', {
    window_id: z.number().int().describe('CGWindowID of the window to raise'),
    timeout_ms: z.number().int().positive().optional().describe('Activation polling timeout in ms'),
  })
  tool('wait', 'Wait for N seconds', { duration: z.number().positive().max(300) })

  // ── v5: Accessibility observation ───────────────────────────────────────
  tool('get_ui_tree', 'Get the accessibility tree for a window — discover UI elements by role/label instead of parsing pixels. Returns role, label, value, bounds, actions, children per node. Capped at 500 nodes.', {
    window_id: z.number().int().describe('CGWindowID to introspect'),
    max_depth: z.number().int().positive().max(20).optional().describe('Maximum tree depth (default 10, max 20)'),
  })
  tool('get_focused_element', 'Get the currently focused UI element — where typed text will go. Returns null if no element has focus.', {})
  tool('find_element', 'Search for UI elements in a window by role, label, or value (AND of the provided criteria). Faster than walking the full tree.', {
    window_id: z.number().int().describe('CGWindowID to search within'),
    role: z.string().optional().describe('AX role — e.g. AXButton, AXTextField, AXStaticText, AXMenuItem'),
    label: z.string().optional().describe('Element label (AXTitle or AXDescription); case-insensitive substring match'),
    value: z.string().optional().describe('Element value (AXValue); case-insensitive substring match'),
    max_results: z.number().int().positive().max(100).optional().describe('Max matches to return (default 25)'),
  })

  // ── v5: Semantic actions ────────────────────────────────────────────────
  tool('click_element', 'Click a UI element by role and label — more reliable than pixel clicks (survives window moves and resolution changes). Falls back to coordinate click if AXPress is unsupported.', {
    window_id: z.number().int().describe('CGWindowID of the window containing the element'),
    role: z.string().describe('AX role of the element to click (e.g. AXButton)'),
    label: z.string().describe('Element label — matched against AXTitle/AXDescription'),
    focus_strategy: focusStrategyParam,
  })
  tool('set_value', 'Set a UI element\'s value directly (e.g. text field content). Avoids the click → type dance. Defaults to strict focus since it writes text.', {
    window_id: z.number().int().describe('CGWindowID of the window containing the element'),
    role: z.string().describe('AX role (usually AXTextField or AXTextArea)'),
    label: z.string().describe('Element label'),
    value: z.string().describe('New value to set'),
    focus_strategy: focusStrategyParam,
  })
  tool('press_button', 'Press a button by its label. Shortcut over click_element for role=AXButton.', {
    window_id: z.number().int().describe('CGWindowID of the window containing the button'),
    label: z.string().describe('Button label'),
    focus_strategy: focusStrategyParam,
  })
  tool('select_menu_item', 'Select an app menu item programmatically — walks AXMenuBar. Returns list of available menus on miss.', {
    bundle_id: z.string().describe('Bundle ID of the app'),
    menu: z.string().describe('Top-level menu title (e.g. "File")'),
    item: z.string().describe('Menu item title (e.g. "New")'),
    submenu: z.string().optional().describe('Submenu title when the item is nested'),
  })
  tool('fill_form', 'Set multiple UI element values in a single call — collapses click+type loops into one tool call. Partial failures are reported per field without aborting the batch.', {
    window_id: z.number().int().describe('CGWindowID of the form window'),
    fields: z.array(z.object({
      role: z.string(),
      label: z.string(),
      value: z.string(),
    })).describe('Ordered list of fields to fill'),
    focus_strategy: focusStrategyParam,
  })

  // ── v5: Scripting bridge ────────────────────────────────────────────────
  tool('run_script', 'Execute AppleScript or JXA and return the output. Fastest path for scriptable apps (Mail, Safari, Finder, Numbers, Music, Messages, Notes, Calendar). Bounded by timeout_ms.', {
    language: z.enum(['applescript', 'javascript']).describe('Scripting language'),
    script: z.string().describe('Script body to execute'),
    timeout_ms: z.number().int().positive().max(120_000).optional().describe('Hard timeout in ms (default 30000, max 120000)'),
  })
  tool('get_app_dictionary', 'Get a scriptable app\'s dictionary (suites, commands, classes). Returns summarized names by default; pass `suite` for full details of one suite.', {
    bundle_id: z.string().describe('Bundle ID of the scriptable app'),
    suite: z.string().optional().describe('Limit to a specific suite; omit for a summary'),
  })

  // ── v5.1: Menu bar introspection ────────────────────────────────────────
  tool('list_menu_bar', 'List an app\'s full menu bar structure with keyboard shortcuts. Use this BEFORE select_menu_item to see what menus / items / shortcuts exist — agents can then press the shortcut directly (faster than walking the menu) or pass the exact item title to select_menu_item.', {
    bundle_id: z.string().describe('Bundle ID of the app whose menu bar to read'),
  })

  // ── v5: Strategy advisor ────────────────────────────────────────────────
  tool('get_tool_guide', 'Recommend the best automation approach for a task. Call this BEFORE committing to screenshot-and-click — it suggests scripting or accessibility paths when they exist.', {
    task_description: z.string().describe('Natural-language description of the task to automate'),
  })
  tool('get_app_capabilities', 'Discover what automation approaches work for an app: scriptable? accessible? running? hidden?', {
    bundle_id: z.string().describe('Bundle ID to probe'),
  })

  // ── v5: Agent Spaces (read-only) ─────────────────────────────────────────
  // NOTE: Space *mutation* tools (create/move/remove/destroy) are disabled.
  // CGS-created Spaces are orphaned on SIP-enabled Macs (not visible in
  // Mission Control) and window moves silently no-op without elevated
  // entitlements. The gesture-based Mission Control "+" click approach is
  // unreliable (coordinate guessing) and the AX approach could not locate
  // the button in Dock's tree. Dispatch + native code remain in place for
  // possible future revival, but they are not exposed via MCP.
  tool('list_spaces', 'List user Spaces grouped by display. Always works — pure read via CGS.', {})
  tool('get_active_space', 'Get the currently active Space ID.', {})

  return server
}

// Standalone stdio entrypoint
if (process.argv[1]?.endsWith('/server.ts') || process.argv[1]?.endsWith('/server.js') || process.argv[1]?.endsWith('/computer-use-mcp')) {
  const server = createComputerUseServer()
  const transport = new StdioServerTransport()
  server.connect(transport).then(() => console.error('[computer-use-mcp] Server running'))
    .catch(err => { console.error('Fatal:', err); process.exit(1) })
}
