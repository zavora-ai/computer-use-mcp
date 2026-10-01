import { execFileSync as defaultExecFileSync } from 'node:child_process'
import type { AXBounds, NativeModule } from '../native.js'
import { ok, type ToolResult } from '../result.js'
import { StructuredToolError } from './errors.js'
import type { FocusController } from './focus.js'
import type { ResolvedTarget, TargetStateController } from './target-state.js'
import { charToUsCombo, explainNativeKeyError, normalizeHeldKeys, normalizeKeyCombo } from './keys.js'
import type { MacosHelper } from './macos-helper.js'
import { inputClassFor, type PidDeliveryStore, type PidOutcome } from './pid-delivery.js'
import type { UserActivityGuard } from './user-activity.js'
import { resolveAppWindow } from './window-select.js'

type ExecFile = typeof defaultExecFileSync

const INPUT_TOOLS = new Set([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'mouse_move', 'left_click_drag', 'mouse_drag', 'left_mouse_down', 'left_mouse_up',
  'cursor_position', 'scroll', 'type', 'key', 'hold_key',
  'read_clipboard', 'write_clipboard', 'multi_select', 'multi_edit',
])

/** Tools that neither post input nor activate anything. */
const NON_PHYSICAL_TOOLS = new Set(['cursor_position', 'read_clipboard', 'write_clipboard'])

/** v7.5 (R5): tools whose input can be posted to the target process instead. */
export const PID_DELIVERY_TOOLS = new Set([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'scroll', 'type', 'key',
])

/**
 * Where a call's input goes. `hid`: the HID event tap, i.e. the frontmost app, after
 * focusing the target per focus_strategy, moving the real cursor for pointer events.
 * `pid`: CGEventPostToPid to the target process, no activation, no cursor movement.
 */
export type InputRoute =
  | { mode: 'hid' }
  | {
    mode: 'pid'
    pid: number
    bundleId?: string
    windowId?: number
    bounds?: AXBounds
    /** Explicit delivery:"pid" with target_window_id: coordinates are window-relative. */
    windowRelative: boolean
    reason: 'requested' | 'user_active'
  }

/**
 * Does this look like text an agent meant to type, rather than a key combination?
 *
 * Deliberately conservative: a real combo is short, and its parts are key names.
 * Only these shapes are rejected, so no legitimate combo becomes unusable:
 *
 * - a URL or path, which no combo contains
 * - whitespace outside a `+` combo, i.e. more than one word
 * - a long single token, longer than any key name
 *
 * `command+l`, `return`, `shift+;`, `f11` and `ctrl+alt+delete` all pass.
 */
function looksLikeProse(combo: string): boolean {
  const trimmed = combo.trim()
  if (trimmed.includes('://') || trimmed.startsWith('/')) return true
  // Split on the combo separator first; a combo's parts are individual key names.
  const parts = trimmed.split('+').filter(part => part.length > 0)
  if (parts.some(part => /\s/.test(part.trim()) && part.trim().includes(' '))) return true
  // The longest key name in use is around a dozen characters ("page_down",
  // "volume_down"); a single token far past that is text, not a key.
  return parts.some(part => part.trim().length > 16)
}

/** Physical pointer, keyboard, clipboard, and batch-input execution. */
export class InputHandler {
  readonly #native: NativeModule
  readonly #targets: TargetStateController
  readonly #focus: FocusController
  readonly #platform: NodeJS.Platform
  readonly #sleep: (milliseconds: number) => Promise<void>
  readonly #execFile: ExecFile
  readonly #guard: UserActivityGuard | undefined
  readonly #pidStore: PidDeliveryStore | undefined
  readonly #helper: MacosHelper | undefined

  constructor(options: {
    native: NativeModule
    targets: TargetStateController
    focus: FocusController
    platform?: NodeJS.Platform
    sleep(milliseconds: number): Promise<void>
    execFile?: ExecFile
    /** v7.5 (R4): refuse HID input and activation while the user is active. */
    guard?: UserActivityGuard
    /** v7.5 (R5): what pid delivery did for each app. */
    pidStore?: PidDeliveryStore
    /** v7.5: captures the target before/after a first pid delivery to verify it. */
    helper?: MacosHelper
  }) {
    this.#native = options.native
    this.#targets = options.targets
    this.#focus = options.focus
    this.#platform = options.platform ?? process.platform
    this.#sleep = options.sleep
    this.#execFile = options.execFile ?? defaultExecFileSync
    this.#guard = options.guard
    this.#pidStore = options.pidStore
    this.#helper = options.helper
  }

  /** Can this platform/native module post input to a process? */
  pidDeliverySupported(): boolean {
    return this.#platform === 'darwin' && typeof this.#native.mouseClickToPid === 'function'
      && typeof this.#native.keyPressToPid === 'function' && typeof this.#native.typeTextToPid === 'function'
  }

  /**
   * Decide where a physical-input call goes (R4 + R5).
   *
   * - delivery "pid": post to the target process; refused when impossible.
   * - delivery "hid": the old path, subject to the user-active guard unless force.
   * - delivery "auto" (default): the old path while the user is idle; while the
   *   user is active, pid delivery for an app recorded as accepting it, otherwise
   *   `user_active`. `force: true` always takes the old path.
   */
  route(tool: string, args: Record<string, unknown>, wouldDo: string): InputRoute {
    const requested = args.delivery === 'pid' || args.delivery === 'hid' ? args.delivery : 'auto'
    const force = args.force === true
    const pidTool = PID_DELIVERY_TOOLS.has(tool) || tool === 'click_text'
    if (requested === 'pid') {
      if (!pidTool) {
        throw new StructuredToolError(`${tool} has no pid delivery`, {
          error: 'pid_delivery_unsupported', tool,
          remediation: ['Pid delivery covers key, type, the click tools, scroll and click_text.'],
        })
      }
      return this.#pidRoute(tool, args, 'requested')
    }
    if (requested === 'hid' || force || !this.#guard) {
      this.#guard?.check({ tool, wouldDo, force, pidPossible: pidTool && this.pidDeliverySupported() })
      return { mode: 'hid' }
    }
    const activity = this.#guard.activity()
    if (!activity.active) return { mode: 'hid' }
    if (pidTool && this.pidDeliverySupported()) {
      const resolved = this.#targets.resolve(args)
      const bundleId = resolved.bundleId ?? (resolved.windowId !== undefined ? this.#native.getWindow(resolved.windowId)?.bundleId ?? undefined : undefined)
      if (bundleId && this.#pidStore?.knownGood(bundleId, inputClassFor(tool))) {
        // Coordinates stay screen coordinates: the caller did not ask for pid.
        return { ...this.#pidRoute(tool, args, 'user_active'), windowRelative: false } as InputRoute
      }
    }
    this.#guard.check({ tool, wouldDo, pidPossible: pidTool && this.pidDeliverySupported() })
    return { mode: 'hid' }
  }

  #pidRoute(tool: string, args: Record<string, unknown>, reason: 'requested' | 'user_active'): InputRoute {
    if (!this.pidDeliverySupported()) {
      throw new StructuredToolError('pid delivery is unavailable', {
        error: 'pid_delivery_unsupported', tool, platform: this.#platform,
        remediation: [this.#platform === 'darwin'
          ? 'The native module predates pid delivery; rebuild it (npm run build:native) or reinstall the package.'
          : 'Pid delivery (CGEventPostToPid) is macOS only; use delivery "hid" with the target focused.'],
      })
    }
    const resolved: ResolvedTarget = this.#targets.resolve(args)
    let pid: number | undefined
    let windowId = resolved.windowId
    let bounds: AXBounds | undefined
    let bundleId = resolved.bundleId
    if (windowId !== undefined) {
      const window = this.#native.getWindow(windowId)
      pid = window?.pid
      bounds = window?.bounds
      bundleId = window?.bundleId ?? bundleId
    } else if (bundleId) {
      pid = this.#native.listRunningApps().find(app => app.bundleId === bundleId)?.pid
      const title = typeof args.target_title === 'string' && args.target_title ? args.target_title : undefined
      const window = resolveAppWindow(this.#native, bundleId, title)
      windowId = window?.windowId
      bounds = window?.bounds
    }
    if (pid === undefined) {
      throw new StructuredToolError('pid delivery needs a running target', {
        error: 'pid_target_missing', tool, target_app: bundleId ?? null, target_window_id: windowId ?? null,
        remediation: ['Pass target_app (a running app) or target_window_id so the input has a process to go to.'],
      })
    }
    return {
      mode: 'pid', pid, bundleId, windowId, bounds, reason,
      windowRelative: reason === 'requested' && typeof args.target_window_id === 'number',
    }
  }

  /**
   * Post pid-delivered input, verifying it the first time for an app (and until a
   * change is seen): the target window is captured twice before (to rule out a
   * window that is changing on its own) and once after, and the outcome recorded.
   */
  async #deliverPid(route: Extract<InputRoute, { mode: 'pid' }>, tool: string, act: () => void): Promise<PidOutcome | undefined> {
    const store = this.#pidStore
    const helper = this.#helper
    const bundleId = route.bundleId
    const inputClass = inputClassFor(tool)
    const verify = store && bundleId && !store.knownGood(bundleId, inputClass) && helper?.supportsCapture() && route.windowId !== undefined
    if (!verify) {
      act()
      if (store && bundleId && !store.observation(bundleId, inputClass)) {
        store.record(bundleId, inputClass, { outcome: 'unverified', tool, at: new Date().toISOString() })
      }
      return undefined
    }
    const shot = async () => {
      try { return (await helper!.capture({ windowId: route.windowId!, width: 480, format: 'jpeg', quality: 60 })).hash } catch { return undefined }
    }
    const first = await shot()
    await this.#sleep(250)
    const before = await shot()
    act()
    await this.#sleep(250)
    const after = await shot()
    const outcome: PidOutcome = !first || !before || !after ? 'unverified'
      : first !== before ? 'unverified'
        : before !== after ? 'changed' : 'no_visible_change'
    store.record(bundleId, inputClass, {
      outcome, tool, at: new Date().toISOString(),
      ...(first && before && first !== before ? { detail: 'the window was changing on its own' } : {}),
    })
    return outcome
  }

  #pidNote(route: Extract<InputRoute, { mode: 'pid' }>, outcome: PidOutcome | undefined): string {
    return ` (delivery: pid to ${route.bundleId ?? `pid ${route.pid}`}`
      + (route.reason === 'user_active' ? ', because the user is active' : '')
      + (outcome ? `; verification: ${outcome}` : '') + ')'
  }

  /** Describe a call for a user_active refusal. */
  #wouldDo(tool: string, args: Record<string, unknown>): string {
    const at = Array.isArray(args.coordinate) ? ` at (${args.coordinate.join(', ')})` : ''
    const target = typeof args.target_app === 'string' ? ` in ${args.target_app}`
      : typeof args.target_window_id === 'number' ? ` in window ${args.target_window_id}` : ' in the frontmost app'
    const what = tool === 'type' ? 'type text' : tool === 'key' ? `press ${String(args.text)}` : tool.replace(/_/g, ' ')
    return `${what}${at}${target}`
  }

  /**
   * Click at a point. `screen: true` means the point is in screen coordinates even
   * for an explicit pid delivery with target_window_id (click_text uses this).
   */
  async clickAt(
    point: { x: number; y: number; screen?: boolean },
    button: string,
    count: number,
    tool: string,
    args: Record<string, unknown>,
    route?: InputRoute,
  ): Promise<ToolResult> {
    const chosen = route ?? this.route(tool, args, this.#wouldDo(tool, { ...args, coordinate: [point.x, point.y] }))
    const resolved = this.#targets.resolve(args)
    if (chosen.mode === 'pid') {
      let { x, y } = point
      if (chosen.windowRelative && !point.screen && chosen.bounds) { x += chosen.bounds.x; y += chosen.bounds.y }
      const outcome = await this.#deliverPid(chosen, tool, () => {
        this.#native.mouseClickToPid!(chosen.pid, x, y, button, count, chosen.windowId)
      })
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Clicked (${Math.round(x)}, ${Math.round(y)})${this.#pidNote(chosen, outcome)}`)
    }
    await this.#focus.ensure(resolved, this.#focus.strategyFor(tool, args), { tool, force: true })
    const { x, y } = point
    this.#validateCoordinates(x, y)
    this.#native.mouseMove(x, y)
    await this.#sleep(50)
    this.#native.mouseClick(x, y, button, count)
    this.#targets.trackClick(resolved)
    return ok(`Clicked (${x}, ${y})`)
  }

  async handle(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult | undefined> {
    if (!INPUT_TOOLS.has(tool)) return undefined
    const coordinate = (key = 'coordinate'): [number, number] => {
      const value = args[key]
      if (!Array.isArray(value) || value.length < 2
        || typeof value[0] !== 'number' || typeof value[1] !== 'number') {
        throw new Error(`Invalid ${key}: expected [number, number]`)
      }
      return [value[0], value[1]]
    }
    const string = (key: string): string => {
      if (typeof args[key] !== 'string') throw new Error(`Invalid ${key}: expected string`)
      return args[key]
    }
    const number = (key: string, fallback: number): number =>
      typeof args[key] === 'number' ? args[key] : fallback
    const target = () => this.#targets.resolve(args)
    // The route below already applied the user-active guard, so focusing is forced.
    const focus = async (resolved: { bundleId?: string; windowId?: number }) => {
      await this.#focus.ensure(resolved, this.#focus.strategyFor(tool, args), { tool, force: true })
    }
    // v7.5: decide once where this call's input goes (and refuse while the user is active).
    const route: InputRoute = NON_PHYSICAL_TOOLS.has(tool) ? { mode: 'hid' } : this.route(tool, args, this.#wouldDo(tool, args))

    const click = async (button: string, count: number): Promise<ToolResult> => {
      const [x, y] = coordinate()
      return this.clickAt({ x, y }, button, count, tool, args, route)
    }

    if (tool === 'left_click') return click('left', 1)
    if (tool === 'right_click') return click('right', 1)
    if (tool === 'middle_click') return click('middle', 1)
    if (tool === 'double_click') return click('left', 2)
    if (tool === 'triple_click') return click('left', 3)

    if (tool === 'mouse_move') {
      const resolved = target()
      await focus(resolved)
      const [x, y] = coordinate()
      this.#validateCoordinates(x, y)
      this.#native.mouseMove(x, y)
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Moved to (${x}, ${y})`)
    }

    if (tool === 'left_click_drag') {
      const resolved = target()
      await focus(resolved)
      const to = coordinate()
      const from = args.start_coordinate ? coordinate('start_coordinate') : to
      const path = Array.isArray(args.path) ? args.path as [number, number][] : [from, to]
      for (const [x, y] of path) this.#validateCoordinates(x, y)
      this.#native.mouseMove(from[0], from[1])
      await this.#sleep(50)
      signal?.throwIfAborted()
      this.#native.mouseButton('press', from[0], from[1])
      try {
        for (const [x, y] of path.slice(1)) {
          signal?.throwIfAborted()
          this.#native.mouseDrag(x, y)
          await this.#sleep(16)
        }
      } finally { this.#native.mouseButton('release', to[0], to[1]) }
      this.#targets.trackClick(resolved)
      return ok(`Dragged to (${to[0]}, ${to[1]})`)
    }

    if (tool === 'left_mouse_down' || tool === 'left_mouse_up') {
      const resolved = target()
      await focus(resolved)
      const [x, y] = coordinate()
      this.#native.mouseButton(tool === 'left_mouse_down' ? 'press' : 'release', x, y)
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(tool === 'left_mouse_down' ? 'Mouse down' : 'Mouse up')
    }

    if (tool === 'cursor_position') {
      const position = this.#native.cursorPosition()
      return ok(`(${position.x}, ${position.y})`)
    }

    if (tool === 'scroll') {
      const resolved = target()
      const [x, y] = coordinate()
      const direction = string('direction')
      const amount = number('amount', 3)
      if (route.mode === 'pid') {
        if (!this.#native.mouseScrollToPid) throw new Error('This native module has no mouseScrollToPid; rebuild it')
        const sx = route.windowRelative && route.bounds ? route.bounds.x + x : x
        const sy = route.windowRelative && route.bounds ? route.bounds.y + y : y
        const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
        const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0
        const outcome = await this.#deliverPid(route, tool, () => this.#native.mouseScrollToPid!(route.pid, sx, sy, deltaY, deltaX, route.windowId))
        if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
        return ok(`Scrolled ${direction} ${amount}${this.#pidNote(route, outcome)}`)
      }
      await focus(resolved)
      this.#native.mouseMove(x, y)
      await this.#sleep(15)
      const deltaX = typeof args.delta_x === 'number' ? args.delta_x : direction === 'left' ? -amount : direction === 'right' ? amount : 0
      const deltaY = typeof args.delta_y === 'number' ? args.delta_y : direction === 'up' ? -amount : direction === 'down' ? amount : 0
      this.#native.mouseScroll(deltaY, deltaX)
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Scrolled ${direction} ${amount}`)
    }

    if (tool === 'type') {
      const resolved = target()
      const text = string('text')
      if (route.mode === 'pid') return this.#typeToPid(route, text, args, resolved)
      await focus(resolved)
      const caretPosition = typeof args.caret_position === 'string' ? args.caret_position : 'idle'
      if (caretPosition === 'start' || caretPosition === 'end') {
        this.#native.keyPress(caretPosition === 'start' ? 'home' : 'end')
        await this.#sleep(30)
      }
      if (args.clear === true || args.clear === 'true') {
        this.#native.keyPress(this.#platform === 'darwin' ? 'command+a' : 'ctrl+a')
        await this.#sleep(30)
        this.#native.keyPress('delete')
        await this.#sleep(30)
      }
      let summary = 'Typed'
      if (args.mode === 'keys') summary = await this.#typeKeys(text, signal)
      else if (text.length > 100 || text.includes('\n')) await this.#pasteText(text)
      else this.#native.typeText(text)
      if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
      if (args.press_enter === true || args.press_enter === 'true') {
        this.#native.keyPress('return')
        await this.#sleep(30)
      }
      return ok(summary)
    }

    if (tool === 'key') {
      const combo = string('text')
      // `key` presses a key combination. An agent that wants to enter text often
      // reaches for it anyway and then spells the text out one keystroke at a
      // time, which is slow, wrong, and hard to diagnose from the native layer's
      // `Unknown key in combo`. Say which tool to use instead, before acting.
      const looksLikeText = looksLikeProse(combo)
      if (looksLikeText) {
        throw new Error(
          `key presses a key combination such as "command+l" or "return", not text. ` +
            `Received ${JSON.stringify(combo.length > 60 ? `${combo.slice(0, 60)}…` : combo)}. ` +
            `Use the type tool to enter text — it accepts press_enter to submit, and routes ` +
            `long or multi-line text through the clipboard.`,
        )
      }
      // v7.5: resolve names ("grave", "tilde", "minus") before focusing anything,
      // and refuse an unknown one with the list of valid names.
      const normalized = normalizeKeyCombo(combo, this.#platform)
      const resolved = target()
      if (route.mode === 'pid') {
        const repeat = args.repeat !== undefined ? number('repeat', 1) : undefined
        const outcome = await this.#deliverPid(route, tool, () => {
          try { this.#native.keyPressToPid!(route.pid, normalized, repeat) } catch (error) { throw explainNativeKeyError(error) }
        })
        if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
        return ok(`Pressed ${args.text}${this.#pidNote(route, outcome)}`)
      }
      await focus(resolved)
      try {
        this.#native.keyPress(normalized, args.repeat !== undefined ? number('repeat', 1) : undefined)
      } catch (error) { throw explainNativeKeyError(error) }
      if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
      return ok(`Pressed ${args.text}`)
    }

    if (tool === 'hold_key') {
      if (!Array.isArray(args.keys) || !args.keys.every(key => typeof key === 'string')) {
        throw new Error('Invalid keys: expected string[]')
      }
      const keys = normalizeHeldKeys(args.keys, this.#platform)
      const resolved = target()
      await focus(resolved)
      try {
        this.#native.holdKey(keys, number('duration', 1) * 1000)
      } catch (error) { throw explainNativeKeyError(error) }
      if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
      return ok('Held')
    }

    if (tool === 'read_clipboard') {
      if (this.#platform !== 'darwin' && this.#native.readClipboard) return ok(this.#native.readClipboard())
      return ok(this.#execFile('pbpaste', []).toString())
    }

    if (tool === 'write_clipboard') {
      const text = string('text')
      if (this.#platform !== 'darwin' && this.#native.writeClipboard) this.#native.writeClipboard(text)
      else this.#execFile('pbcopy', [], { input: text })
      return ok('Written')
    }

    if (tool === 'mouse_drag') {
      const resolved = target()
      await focus(resolved)
      const path = (Array.isArray(args.path) ? args.path : []) as [number, number][]
      if (path.length < 2) return this.#noCoordinates()
      const button = typeof args.button === 'string' ? args.button : 'left'
      const modifiers = Array.isArray(args.modifiers) ? args.modifiers as string[] : []
      const steps = typeof args.steps === 'number' ? args.steps : 8
      if (!this.#native.mousePress || !this.#native.mouseDragTo || !this.#native.mouseRelease) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: 'native_capability_missing',
            capability: 'mousePress/mouseDragTo/mouseRelease',
            remediation: [
              'Button-aware drags need a native module built from this release; rebuild it (npm run build:native) or reinstall the package.',
              'For a plain left-button drag between two points, left_click_drag works with any version.',
            ],
          }) }],
          isError: true,
        }
      }
      for (const [x, y] of path) this.#validateCoordinates(x, y)

      const [startX, startY] = path[0]
      this.#native.mouseMove(startX, startY)
      await this.#sleep(15)
      this.#native.mousePress(startX, startY, button, modifiers)
      try {
        // Interpolate: applications that integrate incremental motion — 3D
        // viewport orbit, canvas painting — ignore a single jump to the endpoint.
        for (let segment = 1; segment < path.length; segment++) {
          const [fromX, fromY] = path[segment - 1]
          const [toX, toY] = path[segment]
          for (let step = 1; step <= steps; step++) {
            this.#checkAbort(signal, 'mouse_drag aborted mid-gesture')
            const ratio = step / steps
            this.#native.mouseDragTo(
              Math.round(fromX + (toX - fromX) * ratio),
              Math.round(fromY + (toY - fromY) * ratio),
              button, modifiers,
            )
            await this.#sleep(8)
          }
        }
      } finally {
        // Never leave a button or modifier stuck down, even on abort.
        const [endX, endY] = path[path.length - 1]
        this.#native.mouseRelease(endX, endY, button, modifiers)
      }
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Dragged ${button}${modifiers.length ? ' with ' + modifiers.join('+') : ''} through ${path.length} waypoints`)
    }

    if (tool === 'multi_select') {
      const resolved = target()
      await focus(resolved)
      const locations = Array.isArray(args.locs) ? [...args.locs] as [number, number][] : []
      if (Array.isArray(args.labels) && args.labels.length > 0 && resolved.windowId) {
        for (const label of args.labels as string[]) {
          const found = this.#resolveLabel(resolved.windowId, label)
          if (found) locations.push(found)
        }
      }
      if (locations.length === 0) return this.#noCoordinates()
      // press_ctrl advertises default true, so additive is the documented behavior.
      // The modifier has to be held across the click, which only the native
      // additive entry point does — tapping it separately selects nothing.
      const additive = args.press_ctrl !== false
      if (additive && !this.#native.mouseClickAdditive) {
        return {
          content: [{ type: 'text', text: JSON.stringify({
            error: 'native_capability_missing',
            capability: 'mouseClickAdditive',
            remediation: [
              'Additive selection needs a native module built from this release; rebuild it (npm run build:native) or reinstall the package.',
              'Pass press_ctrl=false to replace the selection instead of extending it.',
            ],
          }) }],
          isError: true,
        }
      }
      for (const [x, y] of locations) {
        this.#checkAbort(signal, 'multi_select aborted before the next selection')
        this.#native.mouseMove(x, y)
        await this.#sleep(50)
        this.#checkAbort(signal, 'multi_select aborted before click')
        if (additive) this.#native.mouseClickAdditive!(x, y, 'left', 1)
        else this.#native.mouseClick(x, y, 'left', 1)
        await this.#sleep(30)
      }
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Selected ${locations.length} elements`)
    }

    const resolved = target()
    await focus(resolved)
    const edits = Array.isArray(args.locs) ? [...args.locs] as [number, number, string][] : []
    if (Array.isArray(args.labels) && args.labels.length > 0 && resolved.windowId) {
      for (const [label, text] of args.labels as [string, string][]) {
        const found = this.#resolveLabel(resolved.windowId, label)
        if (found) edits.push([found[0], found[1], text])
      }
    }
    if (edits.length === 0) return this.#noCoordinates()
    for (const [x, y, text] of edits) {
      this.#checkAbort(signal, 'multi_edit aborted before the next edit')
      this.#native.mouseMove(x, y)
      await this.#sleep(50)
      this.#checkAbort(signal, 'multi_edit aborted before click')
      this.#native.mouseClick(x, y, 'left', 1)
      await this.#sleep(50)
      this.#checkAbort(signal, 'multi_edit aborted before typing')
      this.#native.typeText(text)
      await this.#sleep(30)
    }
    if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
    return ok(`Edited ${edits.length} fields`)
  }

  async #typeToPid(
    route: Extract<InputRoute, { mode: 'pid' }>,
    text: string,
    args: Record<string, unknown>,
    resolved: ResolvedTarget,
  ): Promise<ToolResult> {
    const native = this.#native
    let summary = 'Typed'
    const outcome = await this.#deliverPid(route, 'type', () => {
      const caret = typeof args.caret_position === 'string' ? args.caret_position : 'idle'
      if (caret === 'start' || caret === 'end') native.keyPressToPid!(route.pid, caret === 'start' ? 'home' : 'end')
      if (args.clear === true || args.clear === 'true') {
        native.keyPressToPid!(route.pid, 'cmd+a')
        native.keyPressToPid!(route.pid, 'delete')
      }
      // No clipboard paste here: cmd+v would land in whatever the user has focused.
      if (args.mode === 'keys' && native.typeKeysToPid) {
        const counts = native.typeKeysToPid(route.pid, text)
        summary = `Typed ${counts.keys} key${counts.keys === 1 ? '' : 's'}`
          + (counts.unicode ? ` and ${counts.unicode} character(s) as text` : '') + ` (layout: ${counts.layout})`
      } else native.typeTextToPid!(route.pid, text)
      if (args.press_enter === true || args.press_enter === 'true') native.keyPressToPid!(route.pid, 'return')
    })
    if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
    return ok(`${summary}${this.#pidNote(route, outcome)}`)
  }

  /**
   * `type mode:"keys"`: every character as a key-down/key-up of its virtual key,
   * so apps that bind keys rather than read text (a game console on the grave key)
   * receive them. macOS uses the native layout-aware table; elsewhere, or with an
   * older native module, each character goes through `keyPress` with its US-ANSI
   * combo, and characters no key produces are sent as text.
   */
  async #typeKeys(text: string, signal?: AbortSignal): Promise<string> {
    if (this.#native.typeKeys) {
      const counts = this.#native.typeKeys(text)
      return `Typed ${counts.keys} key${counts.keys === 1 ? '' : 's'}`
        + (counts.unicode ? ` and ${counts.unicode} character(s) as text` : '')
        + ` (layout: ${counts.layout})`
    }
    let keys = 0
    let unicode = 0
    for (const char of text) {
      this.#checkAbort(signal, 'type aborted mid-text')
      if (char === '\r') continue
      const combo = charToUsCombo(char)
      if (combo) { this.#native.keyPress(combo); keys++ }
      else { this.#native.typeText(char); unicode++ }
      await this.#sleep(4)
    }
    return `Typed ${keys} key${keys === 1 ? '' : 's'}${unicode ? ` and ${unicode} character(s) as text` : ''} (layout: us_ansi)`
  }

  #validateCoordinates(x: number, y: number): void {
    const available = this.#native.listDisplays?.()
    const displays = available?.length ? available : [this.#native.getDisplaySize()]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !displays.some(display => {
      const originX = display.x ?? 0, originY = display.y ?? 0
      return x >= originX && y >= originY && x < originX + display.width && y < originY + display.height
    })) throw new Error(`Coordinates (${x}, ${y}) are outside display bounds`)

  }

  async #pasteText(text: string): Promise<void> {
    if (this.#platform !== 'darwin' && this.#native.readClipboard && this.#native.writeClipboard) {
      let saved: string | undefined
      try { saved = this.#native.readClipboard() } catch { /* best effort */ }
      try {
        this.#native.writeClipboard(text)
        this.#native.keyPress('ctrl+v')
        await this.#sleep(100)
      } finally {
        if (typeof saved === 'string') {
          // Preserve a new clipboard value copied by the user while paste settled.
          try { if (this.#native.readClipboard() === text) this.#native.writeClipboard(saved) } catch { /* best effort */ }
        }
      }
      return
    }
    let saved: string | undefined
    try { saved = this.#execFile('pbpaste', []).toString() } catch { /* best effort */ }
    try {
      this.#execFile('pbcopy', [], { input: text })
      const verified = this.#execFile('pbpaste', []).toString()
      if (verified === text) {
        this.#native.keyPress('command+v')
        await this.#sleep(100)
      } else this.#native.typeText(text)
    } finally {
      if (typeof saved === 'string') {
        try {
          if (this.#execFile('pbpaste', []).toString() === text) this.#execFile('pbcopy', [], { input: saved })
        } catch { /* best effort */ }
      }
    }
  }

  #resolveLabel(windowId: number, label: string): [number, number] | undefined {
    try {
      const elements = this.#native.findElement(windowId, undefined, label, undefined, 1)
      const values = Array.isArray(elements) ? elements : JSON.parse(JSON.stringify(elements))
      const bounds = values[0]?.bounds
      return bounds
        ? [Math.round(bounds.x + bounds.width / 2), Math.round(bounds.y + bounds.height / 2)]
        : undefined
    } catch { return undefined }
  }

  #checkAbort(signal: AbortSignal | undefined, message: string): void {
    if (signal?.aborted) throw new Error(message)
  }

  #noCoordinates(): ToolResult {
    return {
      content: [{ type: 'text', text: 'No coordinates resolved. Provide locs or valid labels.' }],
      isError: true,
    }
  }
}
