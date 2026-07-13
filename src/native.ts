/**
 * Native NAPI module loader — loads the compiled .node addon.
 * Supports macOS (darwin) and Windows (win32) with platform-specific binaries.
 */

import { createRequire } from 'module'
import { existsSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

/**
 * Supported platform + architecture combinations.
 * Each entry maps to a binary named `computer-use-napi.${platform}-${arch}.node`.
 */
const SUPPORTED_TARGETS: ReadonlyArray<{ platform: string; arch: string }> = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'x64' },
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
]

const require = createRequire(import.meta.url)

/**
 * Resolve the path to the platform-specific native binary.
 *
 * Resolution order (Appendix D — additive, back-compatible):
 *   1. `COMPUTER_USE_NATIVE_PATH` env override
 *   2. optional platform package `@zavora-ai/computer-use-mcp-${platform}-${arch}`
 *   3. legacy package-root `computer-use-napi.${platform}-${arch}.node`
 *   4. legacy package-root generic `computer-use-napi.node`
 * Throws a doctor-friendly error when none resolve.
 *
 * Exported for tests. When the optional packages are unpublished (current
 * state), resolution falls through to the legacy root binary — identical to
 * prior behavior.
 */
export interface AddonResolverOptions {
  /** Test/embedding seam that avoids mutating the process-wide node_modules tree. */
  resolveOptionalPackage?: (specifier: string) => string
}

export function resolveAddonPath(options: AddonResolverOptions = {}): string {
  const platform = process.platform
  const arch = process.arch

  const isSupported = SUPPORTED_TARGETS.some(
    (t) => t.platform === platform && t.arch === arch,
  )

  if (!isSupported) {
    const supported = SUPPORTED_TARGETS.map((t) => `${t.platform}-${t.arch}`).join(', ')
    throw new Error(
      `Unsupported platform: ${platform}-${arch}. ` +
      `Supported platforms: ${supported}.`,
    )
  }

  const binaryName = `computer-use-napi.${platform}-${arch}.node`
  const pkgRoot = join(fileURLToPath(import.meta.url), '..', '..')
  const attempts: string[] = []

  // 1. Explicit override.
  const override = process.env.COMPUTER_USE_NATIVE_PATH
  if (override) {
    attempts.push(override)
    if (existsSync(override)) return override
  }

  // 2. Optional platform package (npm optionalDependencies pattern).
  try {
    const resolveOptionalPackage = options.resolveOptionalPackage ?? ((specifier: string) => require.resolve(specifier))
    const resolved = resolveOptionalPackage(`@zavora-ai/computer-use-mcp-${platform}-${arch}/${binaryName}`)
    attempts.push(resolved)
    if (existsSync(resolved)) return resolved
  } catch {
    // optional package not installed — fall through to legacy resolution
  }

  // 3. Legacy package-root platform-specific binary.
  const legacy = join(pkgRoot, binaryName)
  attempts.push(legacy)
  if (existsSync(legacy)) return legacy

  // 4. Legacy package-root generic binary (build copies here too).
  const generic = join(pkgRoot, 'computer-use-napi.node')
  attempts.push(generic)
  if (existsSync(generic)) return generic

  throw new Error(
    `Native binary missing for ${platform}-${arch}. ` +
    `Install @zavora-ai/computer-use-mcp-${platform}-${arch} at the matching version, ` +
    `rebuild via \`npm run build:native\`, or set COMPUTER_USE_NATIVE_PATH to an explicit .node path. ` +
    `Tried: ${attempts.join(', ')}.`,
  )
}

let cachedPath: string | undefined
function addonPath(): string {
  if (cachedPath === undefined) cachedPath = resolveAddonPath()
  return cachedPath
}

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
  /** Trusted native classification; protected values are always returned as null. */
  sensitive: boolean
  /** Disclosure-safe native reasons such as secure_role or uia_is_password. */
  sensitivitySignals: string[]
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
  /** Host-only macOS Keychain access. Never registered as an MCP tool. */
  keychainGetGenericPassword?(service: string, account: string): string | null | undefined
  /** Host-only macOS Keychain access. Never registered as an MCP tool. */
  keychainSetGenericPassword?(service: string, account: string, value: string): void
  /** Host-only permission status. Never registered as an MCP tool. */
  getNativePermissionStatus?(permission: 'accessibility' | 'display_capture'): NativePermissionResult
  /** Host-only present-user OS prompt. Never registered as an MCP tool. */
  requestNativePermission?(permission: 'accessibility' | 'display_capture'): NativePermissionResult
  // User activity clock (v8 lease interruption)
  getUserIdleTimeMs?(): number | null
  getInputMonitorCapability?(): {
    supported: boolean
    backend: string
    distinguishesInjected: boolean
    recommendedPollMs: number
    reason?: string
  }
  configureEmergencyStopChord?(chord: string): {
    supported: boolean
    backend: string
    physicalOnly: boolean
    latched: boolean
    generation: number
    chord?: string
    reason?: string
  }
  getEmergencyStopGeneration?(): number
  isNativeEmergencyStopActive?(): boolean
  triggerNativeEmergencyStop?(): void
  /** Host-only reset. This is intentionally never exposed as an MCP tool. */
  resetNativeEmergencyStop?(): void
  waitForNativeEmergencyStop?(timeoutMs: number): {
    triggered: boolean
    generation: number
    observerLatencyMs?: number
  }
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

  // ── v5.2 Runloop pump ───────────────────────────────────────────────────
  /**
   * Pump the main CFRunLoop once. Used by the session layer during a CU
   * session to keep NSWorkspace / AX state fresh. Cheap when idle.
   */
  drainRunloop(): void

  // ── Windows-only: native clipboard ──────────────────────────────────────
  /** Read clipboard text (Windows native). Undefined on macOS. */
  readClipboard?(): string
  /** Write text to clipboard (Windows native). Undefined on macOS. */
  writeClipboard?(text: string): void
  /** Draw annotations and grid lines on an image. Cross-platform. */
  annotateImage(base64Jpeg: string, annotations: string | null, gridCols: number | null, gridRows: number | null, quality: number | null): { base64: string; width: number; height: number; mimeType: string }
  /** Crop a region from a base64 image at full resolution. Cross-platform. */
  cropImage(base64Image: string, x1: number, y1: number, x2: number, y2: number, quality: number | null): { base64: string; width: number; height: number; mimeType: string }

  // ── Native virtual pointer overlay ─────────────────────────────────────
  /** Show a non-activating, always-on-top native overlay pointer. */
  agentPointerOverlayShow?(x: number, y: number): Record<string, unknown>
  /** Move the native overlay pointer without changing visibility. */
  agentPointerOverlayMove?(x: number, y: number): Record<string, unknown>
  /** Hide the native overlay pointer. */
  agentPointerOverlayHide?(): Record<string, unknown>
  /** Return native overlay status/capability metadata. */
  agentPointerOverlayStatus?(): Record<string, unknown>

  // ── v5.2 prepareDisplay ─────────────────────────────────────────────────
  /**
   * Hide every regular running app except the target and the keep-visible
   * set. Defends against focus-stealing background apps (screenshot
   * watchers, notification panels) before input dispatch.
   *
   * Returns the bundle IDs we actually hid — apps already hidden are NOT
   * included, so callers can restore exactly the state they changed.
   */
  prepareDisplay(
    targetBundleId: string,
    keepVisible: string[],
  ): {
    targetBundleId: string
    hiddenBundleIds: string[]
  }
}

export interface NativePermissionResult {
  permission: 'accessibility' | 'display_capture'
  supported: boolean
  canPrompt: boolean
  granted: boolean
  promptRequested: boolean
  backend: string
  restartMayBeRequired: boolean
  reason?: string | null
}

let cached: NativeModule | undefined

export function loadNative(): NativeModule {
  if (cached) return cached
  cached = require(addonPath()) as NativeModule
  return cached
}
