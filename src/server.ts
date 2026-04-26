#!/usr/bin/env node
/**
 * Computer Use MCP Server — exposes tools over MCP protocol.
 * Backed by in-process Rust NAPI module via session.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z, ZodTypeAny } from 'zod'
import { createSession, type Session, type SessionOptions } from './session.js'

/**
 * v5.2 — How each tool reaches the target app.
 *
 * - `scripting`: executes via AppleScript / JXA (`osascript`). Works even when
 *   the target app is backgrounded or hidden. Cheapest path for scriptable
 *   apps (Mail, Safari, Finder, Numbers, Music, Messages, Notes, Calendar).
 * - `ax`: reads or mutates via the AXUIElement (Accessibility) API. Needs
 *   Accessibility permission. Reads are always safe; mutations typically
 *   require the target frontmost but some apps allow background AXPress.
 * - `cgevent`: synthesizes keyboard / mouse events via CGEvent. **Requires
 *   the target app to be frontmost** — events route to whatever has focus.
 * - `none`: pure observation of system state (clipboard, display size,
 *   cursor position). No target needed.
 */
export type FocusRequired = 'scripting' | 'ax' | 'cgevent' | 'none'

export interface ToolMeta {
  focusRequired: FocusRequired
  /** Whether this tool is classified as mutating by the session layer. */
  mutates: boolean
}

const targetAppParam = z.string().optional().describe('Bundle ID of target app (auto-focuses before action)')
const targetWindowIdParam = z.number().int().optional().describe('CGWindowID to target. Takes precedence over target_app.')
const focusStrategyParam = z.enum(['strict', 'best_effort', 'none', 'prepare_display']).optional().describe('Focus strategy: strict (fail if unconfirmed), best_effort (try and proceed), none (skip activation), prepare_display (hide every non-target app before acting — v5.2, defeats focus-stealing background apps)')
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
  const server = new McpServer({ name: 'computer-use', version: '5.2.0' })
  const session = opts.session ?? createSession({
    vision: opts.vision ?? (process.env.COMPUTER_USE_VISION !== 'false'),
    provider: opts.provider ?? process.env.COMPUTER_USE_PROVIDER,
    native: opts.native,
  })

  // v5.2: Per-tool metadata registry. Populated as each `tool()` call runs.
  // Exposed to clients via the new `get_tool_metadata` tool and appended to
  // each tool's description as `[focusRequired: X]` so agents that read
  // descriptions can filter without a separate call.
  const toolMeta = new Map<string, ToolMeta>()

  // Shorthand for common metadata combos, so each tool() call stays readable.
  const CG_MUT:    ToolMeta = { focusRequired: 'cgevent',   mutates: true }
  const AX_MUT:    ToolMeta = { focusRequired: 'ax',        mutates: true }
  const AX_READ:   ToolMeta = { focusRequired: 'ax',        mutates: false }
  const SCRIPTING: ToolMeta = { focusRequired: 'scripting', mutates: true }
  const SCRIPT_READ: ToolMeta = { focusRequired: 'scripting', mutates: false }
  const NONE_READ: ToolMeta = { focusRequired: 'none',      mutates: false }
  const NONE_MUT:  ToolMeta = { focusRequired: 'none',      mutates: true }

  const tool = (
    name: string,
    desc: string,
    schema: Record<string, ZodTypeAny>,
    meta: ToolMeta,
  ) => {
    toolMeta.set(name, meta)
    const tagged = `${desc} [focusRequired: ${meta.focusRequired}]`
    server.tool(name, tagged, schema, async (args: Record<string, unknown>) => {
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
  }, NONE_READ)
  // Pointer / keyboard — CGEvent, target must be frontmost.
  tool('left_click', 'Left-click at coordinates', withTargeting(coord), CG_MUT)
  tool('right_click', 'Right-click at coordinates', withTargeting(coord), CG_MUT)
  tool('middle_click', 'Middle-click at coordinates', withTargeting(coord), CG_MUT)
  tool('double_click', 'Double-click at coordinates', withTargeting(coord), CG_MUT)
  tool('triple_click', 'Triple-click at coordinates', withTargeting(coord), CG_MUT)
  tool('mouse_move', 'Move cursor to coordinates', withTargeting(coord), CG_MUT)
  tool('left_click_drag', 'Click and drag', withTargeting({
    coordinate: z.tuple([z.number(), z.number()]),
    start_coordinate: z.tuple([z.number(), z.number()]).optional(),
  }), CG_MUT)
  tool('cursor_position', 'Get current cursor position', {}, NONE_READ)
  tool('left_mouse_down', 'Press left mouse button', withTargeting(coord), CG_MUT)
  tool('left_mouse_up', 'Release left mouse button', withTargeting(coord), CG_MUT)
  tool('scroll', 'Scroll at position', {
    ...coord,
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().positive().default(3),
    target_app: targetAppParam,
    target_window_id: targetWindowIdParam,
    focus_strategy: focusStrategyParam,
  }, CG_MUT)
  tool('type', 'Type text into the focused app. For form fields, prefer set_value or fill_form — accessibility-based writes are more reliable and need no click-to-focus.', {
    text: z.string(),
    target_app: targetAppParam,
    target_window_id: targetWindowIdParam,
    focus_strategy: focusStrategyParam,
  }, CG_MUT)
  tool('key', 'Press a key combination (e.g. "command+c", "return"). Tab and Shift+Tab navigate between form fields; keyboard shortcuts are usually faster than coordinate-based clicks.', {
    text: z.string().describe('Key combo like "command+c" or "return"'),
    repeat: z.number().int().positive().optional(),
    target_app: targetAppParam,
    target_window_id: targetWindowIdParam,
    focus_strategy: focusStrategyParam,
  }, CG_MUT)
  tool('hold_key', 'Hold keys for a duration', {
    keys: z.array(z.string()),
    duration: z.number().positive().describe('Seconds'),
    target_app: targetAppParam,
    target_window_id: targetWindowIdParam,
    focus_strategy: focusStrategyParam,
  }, CG_MUT)
  // Clipboard — touches pasteboard only, no focus dependency.
  tool('read_clipboard', 'Read clipboard contents', {}, NONE_READ)
  tool('write_clipboard', 'Write text to clipboard', { text: z.string() }, NONE_MUT)
  // App / window lifecycle — NSWorkspace/AX mutations.
  tool('open_application', 'Open and focus an app by bundle ID', {
    bundle_id: z.string().describe('macOS bundle ID e.g. "com.apple.Safari"'),
  }, AX_MUT)
  tool('get_frontmost_app', 'Get the currently frontmost app', {}, AX_READ)
  tool('list_windows', 'List visible on-screen windows, optionally filtered by bundle ID', {
    bundle_id: z.string().optional().describe('Bundle ID to filter windows by'),
  }, AX_READ)
  tool('list_running_apps', 'List all running regular applications', {}, AX_READ)
  tool('hide_app', 'Hide an app by bundle ID', { bundle_id: z.string() }, AX_MUT)
  tool('unhide_app', 'Unhide an app by bundle ID', { bundle_id: z.string() }, AX_MUT)
  tool('get_display_size', 'Get display dimensions and scale factor', {
    display_id: z.number().optional().describe('Display ID (omit for main display)'),
  }, NONE_READ)
  tool('list_displays', 'List all connected displays', {}, NONE_READ)
  tool('get_window', 'Look up a window by its CGWindowID', {
    window_id: z.number().int().describe('CGWindowID of the window to look up'),
  }, AX_READ)
  tool('get_cursor_window', 'Get the window currently under the mouse cursor', {}, AX_READ)
  tool('activate_app', 'Activate an app and return structured before/after diagnostics', {
    bundle_id: z.string().describe('macOS bundle ID'),
    timeout_ms: z.number().int().positive().optional().describe('Activation polling timeout in ms'),
  }, AX_MUT)
  tool('activate_window', 'Raise a specific window by CGWindowID', {
    window_id: z.number().int().describe('CGWindowID of the window to raise'),
    timeout_ms: z.number().int().positive().optional().describe('Activation polling timeout in ms'),
  }, AX_MUT)
  tool('wait', 'Wait for N seconds', { duration: z.number().positive().max(300) }, NONE_READ)

  // ── v5: Accessibility observation ───────────────────────────────────────
  tool('get_ui_tree', 'Get the accessibility tree for a window — discover UI elements by role/label instead of parsing pixels. Returns role, label, value, bounds, actions, children per node. Capped at 500 nodes.', {
    window_id: z.number().int().describe('CGWindowID to introspect'),
    max_depth: z.number().int().positive().max(20).optional().describe('Maximum tree depth (default 10, max 20)'),
  }, AX_READ)
  tool('get_focused_element', 'Get the currently focused UI element — where typed text will go. Returns null if no element has focus.', {}, AX_READ)
  tool('find_element', 'Search for UI elements in a window by role, label, or value (AND of the provided criteria). Faster than walking the full tree.', {
    window_id: z.number().int().describe('CGWindowID to search within'),
    role: z.string().optional().describe('AX role — e.g. AXButton, AXTextField, AXStaticText, AXMenuItem'),
    label: z.string().optional().describe('Element label (AXTitle or AXDescription); case-insensitive substring match'),
    value: z.string().optional().describe('Element value (AXValue); case-insensitive substring match'),
    max_results: z.number().int().positive().max(100).optional().describe('Max matches to return (default 25)'),
  }, AX_READ)

  // ── v5: Semantic actions ────────────────────────────────────────────────
  tool('click_element', 'Click a UI element by role and label — more reliable than pixel clicks (survives window moves and resolution changes). Falls back to coordinate click if AXPress is unsupported.', {
    window_id: z.number().int().describe('CGWindowID of the window containing the element'),
    role: z.string().describe('AX role of the element to click (e.g. AXButton)'),
    label: z.string().describe('Element label — matched against AXTitle/AXDescription'),
    focus_strategy: focusStrategyParam,
  }, AX_MUT)
  tool('set_value', 'Set a UI element\'s value directly (e.g. text field content). Avoids the click → type dance. Defaults to strict focus since it writes text.', {
    window_id: z.number().int().describe('CGWindowID of the window containing the element'),
    role: z.string().describe('AX role (usually AXTextField or AXTextArea)'),
    label: z.string().describe('Element label'),
    value: z.string().describe('New value to set'),
    focus_strategy: focusStrategyParam,
  }, AX_MUT)
  tool('press_button', 'Press a button by its label. Shortcut over click_element for role=AXButton.', {
    window_id: z.number().int().describe('CGWindowID of the window containing the button'),
    label: z.string().describe('Button label'),
    focus_strategy: focusStrategyParam,
  }, AX_MUT)
  tool('select_menu_item', 'Select an app menu item programmatically — walks AXMenuBar. Returns list of available menus on miss.', {
    bundle_id: z.string().describe('Bundle ID of the app'),
    menu: z.string().describe('Top-level menu title (e.g. "File")'),
    item: z.string().describe('Menu item title (e.g. "New")'),
    submenu: z.string().optional().describe('Submenu title when the item is nested'),
  }, AX_MUT)
  tool('fill_form', 'Set multiple UI element values in a single call — collapses click+type loops into one tool call. Partial failures are reported per field without aborting the batch.', {
    window_id: z.number().int().describe('CGWindowID of the form window'),
    fields: z.array(z.object({
      role: z.string(),
      label: z.string(),
      value: z.string(),
    })).describe('Ordered list of fields to fill'),
    focus_strategy: focusStrategyParam,
  }, AX_MUT)

  // ── v5: Scripting bridge ────────────────────────────────────────────────
  tool('run_script', 'Execute AppleScript or JXA and return the output. Fastest path for scriptable apps (Mail, Safari, Finder, Numbers, Music, Messages, Notes, Calendar). Bounded by timeout_ms.', {
    language: z.enum(['applescript', 'javascript']).describe('Scripting language'),
    script: z.string().describe('Script body to execute'),
    timeout_ms: z.number().int().positive().max(120_000).optional().describe('Hard timeout in ms (default 30000, max 120000)'),
  }, SCRIPTING)
  tool('get_app_dictionary', 'Get a scriptable app\'s dictionary (suites, commands, classes). Returns summarized names by default; pass `suite` for full details of one suite.', {
    bundle_id: z.string().describe('Bundle ID of the scriptable app'),
    suite: z.string().optional().describe('Limit to a specific suite; omit for a summary'),
  }, SCRIPT_READ)

  // ── v5.1: Menu bar introspection ────────────────────────────────────────
  tool('list_menu_bar', 'List an app\'s full menu bar structure with keyboard shortcuts. Use this BEFORE select_menu_item to see what menus / items / shortcuts exist — agents can then press the shortcut directly (faster than walking the menu) or pass the exact item title to select_menu_item.', {
    bundle_id: z.string().describe('Bundle ID of the app whose menu bar to read'),
  }, AX_READ)

  // ── v5: Strategy advisor ────────────────────────────────────────────────
  tool('get_tool_guide', 'Recommend the best automation approach for a task. Call this BEFORE committing to screenshot-and-click — it suggests scripting or accessibility paths when they exist.', {
    task_description: z.string().describe('Natural-language description of the task to automate'),
  }, NONE_READ)
  tool('get_app_capabilities', 'Discover what automation approaches work for an app: scriptable? accessible? running? hidden?', {
    bundle_id: z.string().describe('Bundle ID to probe'),
  }, AX_READ)

  // ── v5: Agent Spaces (read-only) ─────────────────────────────────────────
  // NOTE: Space *mutation* tools (create/move/remove/destroy) are disabled.
  // CGS-created Spaces are orphaned on SIP-enabled Macs (not visible in
  // Mission Control) and window moves silently no-op without elevated
  // entitlements. The gesture-based Mission Control "+" click approach is
  // unreliable (coordinate guessing) and the AX approach could not locate
  // the button in Dock's tree. Dispatch + native code remain in place for
  // possible future revival, but they are not exposed via MCP.
  tool('list_spaces', 'List user Spaces grouped by display. Always works — pure read via CGS.', {}, NONE_READ)
  tool('get_active_space', 'Get the currently active Space ID.', {}, NONE_READ)

  // ── v5.2: Tool metadata introspection ───────────────────────────────────
  //
  // This is the only tool that doesn't go through session.dispatch —
  // it reads directly from the toolMeta registry populated by each
  // tool() registration above. Pure read; no side effects.
  server.tool(
    'get_tool_metadata',
    'Get structured metadata for a tool: focusRequired (scripting|ax|cgevent|none) and mutates (bool). Useful for agents that want to filter tools by their focus requirements — e.g. "show me only tools I can use while Safari is backgrounded". [focusRequired: none]',
    { tool_name: z.string().describe('Name of the tool to inspect') },
    async (args: Record<string, unknown>) => {
      const name = typeof args.tool_name === 'string' ? args.tool_name : ''
      const meta = toolMeta.get(name)
      if (!meta) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'unknown_tool', tool_name: name }),
          }],
          isError: true,
        }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ tool_name: name, ...meta }) }],
      }
    },
  )
  toolMeta.set('get_tool_metadata', { focusRequired: 'none', mutates: false })

  return server
}

// Standalone stdio entrypoint
if (process.argv[1]?.endsWith('/server.ts') || process.argv[1]?.endsWith('/server.js') || process.argv[1]?.endsWith('/computer-use-mcp')) {
  const server = createComputerUseServer()
  const transport = new StdioServerTransport()
  server.connect(transport).then(() => console.error('[computer-use-mcp] Server running'))
    .catch(err => { console.error('Fatal:', err); process.exit(1) })
}
