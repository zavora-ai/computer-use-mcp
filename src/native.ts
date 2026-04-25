/**
 * Native NAPI module loader — loads the compiled .node addon.
 * All functions run in-process via CGEvent/NSWorkspace.
 */

import { createRequire } from 'module'
import { join } from 'path'
import { fileURLToPath } from 'url'

if (process.platform !== 'darwin') {
  throw new Error(`computer-use-mcp requires macOS (got ${process.platform})`)
}

const require = createRequire(import.meta.url)
const ADDON_PATH = join(fileURLToPath(import.meta.url), '..', '..', 'computer-use-napi.node')

// ── v5 Accessibility shapes ───────────────────────────────────────────────────

export interface AXBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface AXElement {
  role: string
  label: string | null
  value: string | null
  bounds: AXBounds
  actions: string[]
  /** Present on full tree nodes; omitted by flat find_element results. */
  children?: AXElement[]
  /** Present on find_element results — indices from the walk root. */
  path?: number[]
  /** Set when a subtree or the whole tree hit the depth / node cap. */
  truncated?: boolean
}

export interface MenuItem {
  title: string
  enabled: boolean
  shortcut?: string
  submenu?: MenuItem[]
}

export interface MenuBarEntry {
  title: string
  enabled: boolean
  items: MenuItem[]
}

export interface WindowRecord {
  windowId: number
  bundleId: string | null
  displayName: string
  pid: number
  title: string | null
  bounds: AXBounds
  isOnScreen: boolean
  isFocused: boolean
  displayId: number
}

export interface NativeModule {
  // Mouse
  mouseMove(x: number, y: number): void
  mouseClick(x: number, y: number, button: string, count: number): void  // throws on invalid button
  mouseButton(action: string, x: number, y: number): void                // throws on invalid action
  mouseScroll(dy: number, dx: number): void
  mouseDrag(x: number, y: number): void
  cursorPosition(): { x: number; y: number }
  // Keyboard
  keyPress(combo: string, repeat?: number): void   // throws on unknown key
  typeText(text: string): void
  holdKey(keys: string[], durationMs: number): void // throws on unknown key
  // Apps
  activateApp(bundleId: string, timeoutMs?: number): { bundleId: string; activated: boolean; displayName?: string }
  getFrontmostApp(): { bundleId: string; displayName: string; pid: number } | null
  getWindow(windowId: number): WindowRecord | null
  getCursorWindow(): WindowRecord | null
  activateWindow(windowId: number, timeoutMs?: number): {
    windowId: number
    activated: boolean
    reason: string | null
  }
  listWindows(bundleId?: string): Array<WindowRecord>
  listRunningApps(): Array<{ bundleId: string; displayName: string; pid: number; isHidden: boolean }>
  hideApp(bundleId: string): boolean
  unhideApp(bundleId: string): boolean
  // Display
  getDisplaySize(displayId?: number): { width: number; height: number; pixelWidth: number; pixelHeight: number; scaleFactor: number; displayId: number }
  listDisplays(): Array<{ width: number; height: number; scaleFactor: number; displayId: number }>
  // Screenshot
  takeScreenshot(width?: number, targetApp?: string, quality?: number, previousHash?: string, windowId?: number): {
    base64?: string
    width: number
    height: number
    mimeType: string
    hash: string
    unchanged: boolean
  }

  // ── v5: Accessibility ──────────────────────────────────────────────────
  /** Depth-limited AX tree rooted at the window; caps at 500 nodes. */
  getUiTree(windowId: number, maxDepth?: number): AXElement
  /** Currently focused AX element (or null). */
  getFocusedElement(): AXElement | null
  /** Depth-first search within the window's AX tree. */
  findElement(
    windowId: number,
    role?: string,
    label?: string,
    value?: string,
    maxResults?: number,
  ): AXElement[]
  /** Perform an AX action (e.g. AXPress) on the first (role, label) match. */
  performAction(
    windowId: number,
    role: string,
    label: string,
    action: string,
  ): { performed: boolean; reason?: string; bounds?: AXBounds }
  /** Set AXValue on the first (role, label) match. */
  setElementValue(
    windowId: number,
    role: string,
    label: string,
    value: string,
  ): { set: boolean; reason?: string }
  /** Walk the app's menu bar and return nested menu structure. */
  getMenuBar(bundleId: string): MenuBarEntry[]
  /** Press a named menu item, optionally nested under a submenu. */
  pressMenuItem(
    bundleId: string,
    menu: string,
    item: string,
    submenu?: string,
  ): { pressed: boolean; reason?: string }

  // ── v5: Spaces (best effort) ────────────────────────────────────────────
  /** List user Spaces grouped by display, with the active Space ID. */
  listSpaces(): {
    supported: boolean
    reason?: string
    active_space_id: number | null
    displays: Array<{
      display_id: string
      spaces: Array<{ id: number; type: number; uuid: string }>
    }>
  }
  /** Active Space ID or null if CGS is unreachable. */
  getActiveSpace(): number | null
  /** Create a new Space. Reports `attached: false` when the created Space is
   *  orphaned (not visible in Mission Control). */
  createAgentSpace(): {
    supported: boolean
    spaceId?: number
    attached?: boolean
    reason?: string
    note?: string
  }
  /** Move a window into a Space. `verified: true` only when the window
   *  visibly disappears from the on-screen window list. */
  moveWindowToSpace(windowId: number, spaceId: number): {
    moved: boolean
    verified?: boolean
    reason?: string
    note?: string
    window_on_screen_before?: boolean
    window_on_screen_after?: boolean
  }
  /** Remove a window from a Space (restores visibility). */
  removeWindowFromSpace(windowId: number, spaceId: number): { removed: boolean; reason?: string }
  /** Destroy a Space created via createAgentSpace. */
  destroySpace(spaceId: number): { destroyed: boolean; reason?: string }
}

let cached: NativeModule | undefined

export function loadNative(): NativeModule {
  if (cached) return cached
  cached = require(ADDON_PATH) as NativeModule
  return cached
}
