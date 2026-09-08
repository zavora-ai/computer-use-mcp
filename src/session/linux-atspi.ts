import { fileURLToPath } from 'node:url'
import type { SpawnBounded } from './spawn.js'
import type { AccessibilityHandlerContext } from './accessibility-handlers.js'
import { sanitizeAccessibilityResult } from './accessibility-handlers.js'
import { ok, errJson, type ToolResult } from '../result.js'
const TOOLS = new Set(['get_ui_tree', 'find_element', 'click_element', 'set_value', 'press_button', 'fill_form'])

/** Bounded AT-SPI bridge; never substitutes an empty successful tree for missing Linux support. */
export async function handleLinuxAccessibility(tool: string, args: Record<string, unknown>, context: AccessibilityHandlerContext,
  spawn: SpawnBounded): Promise<ToolResult | undefined> {
  if (!TOOLS.has(tool)) return undefined
  const id = Number(args.window_id ?? args.target_window_id)
  const window = Number.isSafeInteger(id) ? context.native.getWindow(id) : undefined
  if (!window) return errJson({ error: 'window_unavailable' })
  if (!['get_ui_tree', 'find_element'].includes(tool)) {
    await context.focus.ensure({ windowId: id, ...(window.bundleId ? { bundleId: window.bundleId } : {}) }, 'strict')
  }
  const result = await spawn('python3', [fileURLToPath(new URL('../../libexec/linux-atspi.py', import.meta.url))], 10000,
    context.signal, JSON.stringify({ tool, args, window }))
  if (result.code !== 0 || result.timedOut) return errJson({ error: 'atspi_unavailable',
    message: 'AT-SPI request failed or timed out. Install python3-gi and gir1.2-atspi-2.0 and enable the desktop accessibility bus.',
    details: result.stderr.slice(0, 1000) })
  const output = JSON.parse(result.stdout)
  if (output.error) return errJson(output)
  return ok(JSON.stringify(sanitizeAccessibilityResult(output)))
}
