import { execFileSync as defaultExecFileSync } from 'node:child_process'
import type { AXBounds, NativeModule } from '../native.js'
import { offThread } from './native-async.js'
import { ok, okJson, type ToolResult } from '../result.js'
import type { Effect } from './contract.js'
import { StructuredToolError } from './errors.js'
import { cardClickRefusal, insideRect } from './card-guard.js'
import type { CardRect } from './operator-control.js'
import type { FocusController } from './focus.js'
import type { ResolvedTarget, TargetStateController } from './target-state.js'
import { charToUsCombo, explainNativeKeyError, normalizeHeldKeys, normalizeKeyCombo } from './keys.js'
import type { MacosHelper } from './macos-helper.js'
import { inputClassFor, type PidDeliveryStore, type PidOutcome } from './pid-delivery.js'
import type { UserActivityGuard } from './user-activity.js'
import { resolveAppWindow } from './window-select.js'
import { sleepAbortable } from './spawn.js'

type ExecFile = typeof defaultExecFileSync

const INPUT_TOOLS = new Set([
  'click', 'set_target', 'get_target',
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'mouse_move', 'left_click_drag', 'mouse_drag', 'left_mouse_down', 'left_mouse_up',
  'cursor_position', 'scroll', 'type', 'key', 'hold_key',
  'read_clipboard', 'write_clipboard', 'multi_select', 'multi_edit',
])

/** Tools that neither post input nor activate anything. */
const NON_PHYSICAL_TOOLS = new Set(['cursor_position', 'read_clipboard', 'write_clipboard', 'set_target', 'get_target'])
/**
 * The longest `hold_key`. Since 7.7.0 a hold is a native key-down, an awaited timer and a key-up, so it no longer
 * blocks the server (Pause, Stop and cancellation reach it at once and the keys are released); the cap stays so a
 * forgotten hold cannot keep keys down for long.
 */
export const MAX_HOLD_SECONDS = 10
/** 7.8.1: keys held across calls (hold_key down) come up by themselves after this long. */
export const HELD_KEYS_MAX_MS = 60_000

/**
 * 8.0: how the pointer reaches a point. `jump` (the default) moves it there in one event, as before. `glide` makes
 * clicks, drags and scrolls travel from where the pointer is, eased, so a person watching (or a recording) can follow
 * it and apps that act on hover see a movement. `COMPUTER_USE_POINTER_MOTION=glide` turns it on.
 */
export type PointerMotion = 'jump' | 'glide'
export function pointerMotionFromEnv(env: NodeJS.ProcessEnv = process.env): PointerMotion {
  return env.COMPUTER_USE_POINTER_MOTION?.trim().toLowerCase() === 'glide' ? 'glide' : 'jump'
}
/** One motion event about every 8 ms (about 120 a second). */
export const MOTION_STEP_MS = 8
/** Glide speed and bounds: 1.5 px per ms, never under 120 ms or over 600 ms. */
export const GLIDE_PX_PER_MS = 1.5
export const GLIDE_MIN_MS = 120
export const GLIDE_MAX_MS = 600
/** A mouse_move path with no duration_ms: about 1 px per ms, between 100 ms and 5 s. */
export const PATH_PX_PER_MS = 1
export const PATH_MIN_MS = 100
export const PATH_MAX_MS = 5_000

/**
 * 7.8.1 (macOS): apps that take only the first character of a key event's text. Blender's event layer keeps one
 * character per key event, so Unicode text posted in chunks lost all but the first character of each chunk.
 */
const ONE_CHARACTER_PER_KEY_APPS = new Set(['org.blenderfoundation.blender'])

/** 7.8.1: the modifiers a click, drag or scroll may hold. */
const POINTER_MODIFIERS = new Set(['shift', 'ctrl', 'alt', 'cmd'])

/**
 * 7.8.1: a pen's pressure along a stroke. `values` are spread evenly over the stroke, so one value is constant, two
 * ramp, three taper, and as many as there are waypoints give one per waypoint (each segment has the same step count).
 */
export function pressureAt(values: readonly number[], t: number): number {
  const position = Math.min(Math.max(t, 0), 1) * (values.length - 1)
  const index = Math.floor(position)
  if (index >= values.length - 1) return values[values.length - 1]
  const ratio = position - index
  return ratio === 0 ? values[index] : values[index] + (values[index + 1] - values[index]) * ratio
}

/** 7.7.0 (K1): tools that accept `verify: true` (capture the target before and after, and report the effect). */
export const VERIFIABLE_TOOLS = new Set([
  'click', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'scroll', 'type', 'key',
  'mouse_drag', 'left_click_drag', 'hold_key', 'multi_select', 'multi_edit',
])

/**
 * 7.7.0 (M3): pbcopy and pbpaste pick their encoding from the locale; a host that starts the server without `LANG`
 * (launchd, some IDEs) got non-ASCII text mangled. Run them with a UTF-8 locale unless one is set.
 */
export function utf8Env(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG
  return locale && /utf-?8/i.test(locale) ? env : { ...env, LANG: 'en_US.UTF-8', LC_CTYPE: 'en_US.UTF-8' }
}

/** A pid delivery's verification outcome as a contract effect. */
function pidEffect(outcome: PidOutcome | undefined): Effect {
  return outcome === 'changed' ? 'changed' : outcome === 'no_visible_change' ? 'no_visible_change' : 'unverified'
}

/** v7.5 (R5): tools whose input can be posted to the target process instead. */
export const PID_DELIVERY_TOOLS = new Set([
  'click', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'scroll', 'type', 'key',
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
  readonly #protectedRegion: (() => CardRect | undefined) | undefined
  readonly #clearOfCard: ((points: Array<[number, number]>) => Promise<void>) | undefined
  readonly #haltSignal: (() => AbortSignal) | undefined
  readonly #heldKeysMaxMs: number
  /** 8.0: clicks, drags and scrolls travel to their point instead of jumping. */
  readonly #glide: boolean
  /** 7.8.1: keys down across calls (hold_key down), each with its auto-release timer. */
  readonly #held = new Map<string, ReturnType<typeof setTimeout>>()
  #exitHook: (() => void) | undefined

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
    /** Screen rectangle no pointer action may land in: the Linux status card, which shows on screen to the agent. */
    protectedRegion?: () => CardRect | undefined
    /** 7.8.1: move the status card off these points when captures cannot see it (macOS), before input lands there. */
    clearOfCard?: (points: Array<[number, number]>) => Promise<void>
    /** 7.8.1: aborted when the person pauses or stops the agent, or the session ends; held keys come up then. */
    haltSignal?: () => AbortSignal
    /** 7.8.1: how long hold_key down may hold before the keys come up by themselves (default 60 s). */
    heldKeysMaxMs?: number
    /** 8.0: `glide` makes pointer actions travel to their point (default `jump`). */
    pointerMotion?: PointerMotion
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
    this.#protectedRegion = options.protectedRegion
    this.#clearOfCard = options.clearOfCard
    this.#haltSignal = options.haltSignal
    this.#heldKeysMaxMs = options.heldKeysMaxMs ?? HELD_KEYS_MAX_MS
    this.#glide = options.pointerMotion === 'glide'
  }

  /** 8.0: whether pointer actions glide to their point. */
  pointerMotion(): PointerMotion { return this.#glide ? 'glide' : 'jump' }

  /**
   * 8.0: move the cursor from where it is to (x, y) through eased intermediate positions instead of one jump. Without a
   * duration it takes the glide time for the distance. A cursor position that cannot be read leaves the jump to the
   * caller.
   */
  async #travel(x: number, y: number, durationMs?: number, signal?: AbortSignal): Promise<void> {
    let from: { x: number; y: number } | undefined
    try { from = this.#native.cursorPosition() } catch { from = undefined }
    if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.y)) return
    const distance = Math.hypot(x - from.x, y - from.y)
    if (distance < 2) return
    const duration = durationMs ?? Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, distance / GLIDE_PX_PER_MS))
    const steps = Math.max(2, Math.min(1250, Math.round(duration / MOTION_STEP_MS)))
    for (let step = 1; step <= steps; step++) {
      this.#checkAbort(signal, 'pointer travel aborted')
      const t = step / steps
      const eased = t * t * (3 - 2 * t)
      this.#native.mouseMove(Math.round(from.x + (x - from.x) * eased), Math.round(from.y + (y - from.y) * eased))
      await this.#sleep(duration / steps)
    }
  }

  /** 8.0: glide to a point before a pointer action when the session asks for it. */
  async #approach(x: number, y: number, signal?: AbortSignal): Promise<void> {
    if (this.#glide) await this.#travel(x, y, undefined, signal)
  }

  /** 8.0: move through waypoints at a constant speed, `durationMs` in all, with no button held. */
  async #movePath(path: ReadonlyArray<readonly [number, number]>, durationMs: number, signal?: AbortSignal): Promise<void> {
    const lengths = path.slice(1).map((point, index) => Math.hypot(point[0] - path[index][0], point[1] - path[index][1]))
    const total = lengths.reduce((sum, length) => sum + length, 0)
    const allSteps = Math.max(path.length - 1, Math.min(1250, Math.round(durationMs / MOTION_STEP_MS)))
    for (let segment = 1; segment < path.length; segment++) {
      const share = total > 0 ? lengths[segment - 1] / total : 1 / (path.length - 1)
      const steps = Math.max(1, Math.round(allSteps * share))
      const pause = (durationMs * share) / steps
      const [fromX, fromY] = path[segment - 1]
      const [toX, toY] = path[segment]
      for (let step = 1; step <= steps; step++) {
        this.#checkAbort(signal, 'mouse_move aborted mid-path')
        const ratio = step / steps
        this.#native.mouseMove(Math.round(fromX + (toX - fromX) * ratio), Math.round(fromY + (toY - fromY) * ratio))
        await this.#sleep(pause)
      }
    }
  }

  /** Keys held across calls (hold_key down), in the order they went down. */
  heldKeys(): string[] { return [...this.#held.keys()] }

  /**
   * 7.8.1: release keys held across calls: these, or all. Called by hold_key up/release, the auto-release timer, the
   * halt signal (Pause, Stop, take-over, session end) and process exit. A release is never refused.
   */
  releaseHeldKeys(keys?: string[]): string[] {
    const targets = keys ? keys.filter(key => this.#held.has(key)) : [...this.#held.keys()]
    for (const key of targets) { clearTimeout(this.#held.get(key)); this.#held.delete(key) }
    if (targets.length) {
      try { this.#native.keyUp?.(targets.slice().reverse()) } catch { /* the native layer releases what it holds */ }
    }
    if (this.#held.size === 0 && this.#exitHook) { process.removeListener('exit', this.#exitHook); this.#exitHook = undefined }
    return targets
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
  /** v7.6 R7: the session target as get_target / set_target report it. */
  #describeTarget(): Record<string, unknown> | null {
    const state = this.#targets.current()
    if (!state) return null
    const window = state.windowId !== undefined ? this.#native.getWindow(state.windowId) : null
    return {
      app: state.bundleId ?? null,
      windowId: state.windowId ?? null,
      title: window?.title ?? null,
      onScreen: state.windowId !== undefined ? Boolean(window?.isOnScreen) : null,
      establishedBy: state.establishedBy,
      establishedAt: state.establishedAt,
    }
  }

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
    // 7.8.1: checked before anything moves, so a bad name changes nothing.
    const modifiers = this.#modifiers(args)
    const holdKeys = this.#heldKeys(args)
    const chosen = route ?? this.route(tool, args, this.#wouldDo(tool, { ...args, coordinate: [point.x, point.y] }))
    const resolved = this.#targets.resolve(args)
    if (chosen.mode === 'pid' && (modifiers.length > 0 || holdKeys.length > 0)) this.#refuseHeldKeysForPid(tool)
    if (chosen.mode === 'pid') {
      let { x, y } = point
      if (chosen.windowRelative && !point.screen && chosen.bounds) { x += chosen.bounds.x; y += chosen.bounds.y }
      const outcome = await this.#deliverPid(chosen, tool, () => {
        this.#native.mouseClickToPid!(chosen.pid, x, y, button, count, chosen.windowId)
      })
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return { ...ok(`Clicked (${Math.round(x)}, ${Math.round(y)})${this.#pidNote(chosen, outcome)}`),
        contract: { delivery: 'pid', effect: pidEffect(outcome) } }
    }
    const { x, y } = point
    // Before activating anything: a point off the screens, or on the status card, is refused with nothing changed.
    this.#validateCoordinates(x, y)
    await this.#clearCard([[x, y]])
    await this.#focus.ensure(resolved, this.#focus.strategyFor(tool, args), { tool, force: true })
    await this.#approach(x, y)
    this.#native.mouseMove(x, y)
    await this.#sleep(50)
    await this.#withHeldKeys(holdKeys, async () => {
      if (modifiers.length > 0) await this.#clickModified(x, y, button, count, modifiers)
      else this.#native.mouseClick(x, y, button, count)
    })
    this.#targets.trackClick(resolved)
    const held = [...modifiers, ...holdKeys]
    return { ...ok(`Clicked (${x}, ${y})${held.length ? ` with ${held.join('+')}` : ''}`), contract: { delivery: 'hid' } }
  }

  /** 7.8.1: `modifiers`, checked against the schema's enum again (run_steps and the aliases reach here too). */
  #modifiers(args: Record<string, unknown>): string[] {
    const raw = args.modifiers
    if (raw === undefined) return []
    if (!Array.isArray(raw) || !raw.every(name => typeof name === 'string' && POINTER_MODIFIERS.has(name))) {
      throw new Error('Invalid modifiers: expected a list of shift, ctrl, alt, cmd')
    }
    return [...new Set(raw as string[])]
  }

  /** 7.8.1: `hold_keys`, resolved to native names (unknown names are refused with the valid ones). */
  #heldKeys(args: Record<string, unknown>): string[] {
    const raw = args.hold_keys
    if (raw === undefined) return []
    if (!Array.isArray(raw) || !raw.every(key => typeof key === 'string')) throw new Error('Invalid hold_keys: expected string[]')
    return normalizeHeldKeys(raw, this.#platform)
  }

  #refuseHeldKeysForPid(tool: string): never {
    throw new StructuredToolError(`${tool} cannot hold keys with pid delivery`, {
      error: 'pid_delivery_unsupported', tool,
      remediation: ['modifiers and hold_keys go through the keyboard: use delivery "hid" with the target in front, after the person stops typing.'],
    })
  }

  #missingNative(capability: string, remediation: string): never {
    throw new StructuredToolError(`native capability missing: ${capability}`, {
      error: 'native_capability_missing', capability,
      remediation: [`${remediation} needs a native module built from this release; rebuild it (npm run build:native) or reinstall the package.`],
    })
  }

  /**
   * 7.8.1: run a pointer action with keys held down (Blender's blade while C is held, an annotation while D is held).
   * The keys come up on every exit path; the native latch also releases them on Stop.
   */
  async #withHeldKeys<T>(keys: readonly string[], act: () => Promise<T>): Promise<T> {
    if (keys.length === 0) return act()
    if (!this.#native.keyDown || !this.#native.keyUp) this.#missingNative('keyDown/keyUp', 'hold_keys')
    try { this.#native.keyDown([...keys]) } catch (error) { throw explainNativeKeyError(error) }
    try {
      await this.#sleep(30)
      return await act()
    } finally {
      this.#native.keyUp([...keys])
    }
  }

  /**
   * 7.8.1: a click with modifiers. macOS presses them as keys around the click (Blender ignored flags alone); Windows
   * and Linux press the real keys inside each press and release.
   */
  async #clickModified(x: number, y: number, button: string, count: number, modifiers: string[]): Promise<void> {
    if (this.#native.mouseClickModified) {
      this.#native.mouseClickModified(x, y, button, count, modifiers)
      return
    }
    if (!this.#native.mousePress || !this.#native.mouseRelease) this.#missingNative('mousePress/mouseRelease', 'A click with modifiers')
    for (let index = 0; index < count; index++) {
      this.#native.mousePress(x, y, button, modifiers)
      this.#native.mouseRelease(x, y, button, modifiers)
      if (index < count - 1) await this.#sleep(30)
    }
  }

  /**
   * 7.7.0 (K1) `verify: true`: capture the target (its window, or the screen) before and after the action and report
   * `changed` or `no_visible_change` instead of `unverified`. It costs two captures and a 250 ms settle.
   */
  async #verified(args: Record<string, unknown>, act: () => Promise<ToolResult>): Promise<ToolResult> {
    const before = await this.#targetHash(args)
    const result = await act()
    if (result.isError) return result
    await this.#sleep(250)
    const after = await this.#targetHash(args)
    const effect: Effect = !before || !after ? 'unverified' : before === after ? 'no_visible_change' : 'changed'
    return { ...result, contract: { ...result.contract, effect } }
  }

  async #targetHash(args: Record<string, unknown>): Promise<string | undefined> {
    let windowId: number | undefined
    try { windowId = this.#targets.resolve(args).windowId } catch { windowId = undefined }
    try {
      if (windowId !== undefined && this.#helper?.supportsCapture()) {
        return (await this.#helper.capture({ windowId, width: 480, format: 'jpeg', quality: 60 })).hash
      }
      return (await offThread(this.#native, 'takeScreenshot', 480, undefined, 60, undefined, windowId)).hash
    } catch { return undefined }
  }

  async handle(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult | undefined> {
    if (!INPUT_TOOLS.has(tool)) return undefined
    if (args.verify === true && VERIFIABLE_TOOLS.has(tool)) {
      const { verify: _verify, ...rest } = args
      return this.#verified(args, async () => (await this.#handle(tool, rest, signal))!)
    }
    return this.#handle(tool, args, signal)
  }

  async #handle(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult | undefined> {
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

    // v7.6 R7: one click with button and count; the five v7 names below are aliases of it.
    if (tool === 'click') {
      const button = args.button === undefined ? 'left' : args.button
      if (button !== 'left' && button !== 'right' && button !== 'middle') throw new Error('Invalid button: expected left, right or middle')
      const count = args.count === undefined ? 1 : args.count
      if (count !== 1 && count !== 2 && count !== 3) throw new Error('Invalid count: expected 1, 2 or 3')
      return click(button, count)
    }
    if (tool === 'set_target') {
      if (args.clear === true) { this.#targets.clear(); return okJson({ target: null, cleared: true }) }
      const windowId = typeof args.window_id === 'number' ? args.window_id : undefined
      const app = typeof args.app === 'string' && args.app.length > 0 ? args.app : undefined
      const title = typeof args.title === 'string' && args.title.length > 0 ? args.title : undefined
      if (windowId === undefined && app === undefined) throw new Error('set_target needs app, window_id, or clear: true')
      let resolved: ResolvedTarget
      if (windowId !== undefined) {
        resolved = this.#targets.resolve({ target_window_id: windowId })
      } else {
        const window = resolveAppWindow(this.#native, app!, title)
        resolved = { bundleId: app, ...(window ? { windowId: window.windowId } : {}) }
      }
      this.#targets.update(resolved, 'activation')
      return okJson({ target: this.#describeTarget() })
    }
    if (tool === 'get_target') return okJson({ target: this.#describeTarget() })

    if (tool === 'left_click') return click('left', 1)
    if (tool === 'right_click') return click('right', 1)
    if (tool === 'middle_click') return click('middle', 1)
    if (tool === 'double_click') return click('left', 2)
    if (tool === 'triple_click') return click('left', 3)

    if (tool === 'mouse_move') {
      const resolved = target()
      // 8.0: a path with no button held (a hover with Shift down), or a timed move to a point.
      let path: Array<[number, number]> | undefined
      if (args.path !== undefined) {
        if (!Array.isArray(args.path) || args.path.length < 2 || args.path.length > 64
          || !args.path.every(point => Array.isArray(point) && point.length >= 2 && typeof point[0] === 'number' && typeof point[1] === 'number')) {
          throw new Error('Invalid path: expected 2 to 64 [x, y] points')
        }
        path = (args.path as number[][]).map(point => [point[0], point[1]])
      }
      if (!path && args.coordinate === undefined) throw new Error('mouse_move needs coordinate or path')
      const points = path ?? [coordinate()]
      const modifiers = this.#modifiers(args)
      const held = [...new Set([...normalizeHeldKeys(modifiers, this.#platform), ...this.#heldKeys(args)])]
      const duration = typeof args.duration_ms === 'number' ? Math.max(0, Math.min(10_000, args.duration_ms)) : undefined
      for (const [x, y] of points) this.#validateCoordinates(x, y)
      await this.#clearCard(points)
      await focus(resolved)
      const holding = held.length ? ` holding ${held.join('+')}` : ''
      if (!path) {
        const [x, y] = points[0]
        await this.#withHeldKeys(held, async () => {
          if (duration !== undefined && duration > 0) await this.#travel(x, y, duration, signal)
          else await this.#approach(x, y, signal)
          this.#native.mouseMove(x, y)
        })
        if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
        return ok(`Moved to (${x}, ${y})${holding}`)
      }
      // Reach the path's start (gliding when the session glides), then travel through it with the keys held.
      const waypoints = path
      const [startX, startY] = waypoints[0]
      await this.#approach(startX, startY, signal)
      this.#native.mouseMove(startX, startY)
      const length = waypoints.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - waypoints[index][0], point[1] - waypoints[index][1]), 0)
      const pathMs = duration ?? Math.min(PATH_MAX_MS, Math.max(PATH_MIN_MS, length / PATH_PX_PER_MS))
      await this.#withHeldKeys(held, () => this.#movePath(waypoints, pathMs, signal))
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      const [endX, endY] = waypoints[waypoints.length - 1]
      return ok(`Moved through ${waypoints.length} waypoints to (${endX}, ${endY}) in ${Math.round(pathMs)} ms${holding}`)
    }

    if (tool === 'left_click_drag') {
      const resolved = target()
      const to = coordinate()
      const from = args.start_coordinate ? coordinate('start_coordinate') : to
      const path = Array.isArray(args.path) ? args.path as [number, number][] : [from, to]
      for (const [x, y] of path) this.#validateCoordinates(x, y)
      await this.#clearCard(path)
      await focus(resolved)
      await this.#approach(from[0], from[1], signal)
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
      const [x, y] = coordinate()
      this.#validateCoordinates(x, y)
      await this.#clearCard([[x, y]])
      await focus(resolved)
      await this.#approach(x, y, signal)
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
      const modifiers = this.#modifiers(args)
      if (route.mode === 'pid' && modifiers.length > 0) this.#refuseHeldKeysForPid(tool)
      if (route.mode === 'pid') {
        if (!this.#native.mouseScrollToPid) throw new Error('This native module has no mouseScrollToPid; rebuild it')
        const sx = route.windowRelative && route.bounds ? route.bounds.x + x : x
        const sy = route.windowRelative && route.bounds ? route.bounds.y + y : y
        const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
        const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0
        const outcome = await this.#deliverPid(route, tool, () => this.#native.mouseScrollToPid!(route.pid, sx, sy, deltaY, deltaX, route.windowId))
        if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
        return { ...ok(`Scrolled ${direction} ${amount}${this.#pidNote(route, outcome)}`), contract: { delivery: 'pid', effect: pidEffect(outcome) } }
      }
      this.#validateCoordinates(x, y)
      await this.#clearCard([[x, y]])
      await focus(resolved)
      await this.#approach(x, y, signal)
      this.#native.mouseMove(x, y)
      await this.#sleep(15)
      const deltaX = typeof args.delta_x === 'number' ? args.delta_x : direction === 'left' ? -amount : direction === 'right' ? amount : 0
      const deltaY = typeof args.delta_y === 'number' ? args.delta_y : direction === 'up' ? -amount : direction === 'down' ? amount : 0
      if (modifiers.length === 0) this.#native.mouseScroll(deltaY, deltaX)
      else if (this.#native.mouseScrollModified) this.#native.mouseScrollModified(deltaY, deltaX, modifiers)
      else await this.#withHeldKeys(modifiers, async () => this.#native.mouseScroll(deltaY, deltaX))
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      return ok(`Scrolled ${direction} ${amount}${modifiers.length ? ` with ${modifiers.join('+')}` : ''}`)
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
      // 7.8.1: an app that reads one character per key event (Blender) kept only the first character of each text
      // chunk ("Relax Edge Loops" arrived as "R"); short text goes to it as key events unless a mode was asked for.
      const short = text.length <= 100 && !text.includes('\n')
      if (args.mode === 'keys' || (args.mode === undefined && short && this.#readsOneCharacterPerKey(resolved))) {
        summary = await this.#typeKeys(text, signal)
        if (args.mode === undefined) summary += ' as key events (this app reads one character per key event)'
      } else if (!short) {
        // 7.7.0 (K9): never paste over an image or files the person copied; type the text instead.
        let guarded = false
        try { guarded = this.#native.clipboardHasNonText?.() === true } catch { guarded = false }
        if (guarded) {
          this.#native.typeText(text)
          summary = 'Typed (the clipboard holds an image or files, so the text was typed rather than pasted, to keep them)'
        } else await this.#pasteText(text)
      } else this.#native.typeText(text)
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
        return { ...ok(`Pressed ${args.text}${this.#pidNote(route, outcome)}`), contract: { delivery: 'pid', effect: pidEffect(outcome) } }
      }
      await focus(resolved)
      try {
        this.#native.keyPress(normalized, args.repeat !== undefined ? number('repeat', 1) : undefined)
      } catch (error) { throw explainNativeKeyError(error) }
      if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
      return ok(`Pressed ${args.text}`)
    }

    if (tool === 'hold_key') {
      const action = typeof args.action === 'string' ? args.action : 'hold'
      if (action === 'release') {
        const released = this.releaseHeldKeys()
        return ok(released.length ? `Released ${released.join('+')}` : 'Nothing was held')
      }
      if (!Array.isArray(args.keys) || args.keys.length === 0 || !args.keys.every(key => typeof key === 'string')) {
        throw new Error('Invalid keys: expected a non-empty string[]')
      }
      const keys = normalizeHeldKeys(args.keys, this.#platform)
      if (action === 'up') {
        const released = this.releaseHeldKeys(keys)
        const untracked = keys.filter(key => !released.includes(key))
        if (untracked.length) { try { this.#native.keyUp?.(untracked) } catch (error) { throw explainNativeKeyError(error) } }
        const still = this.heldKeys()
        return ok(`Released ${keys.join('+')}${still.length ? `; still held: ${still.join('+')}` : ''}`)
      }
      if (action === 'down') {
        if (!this.#native.keyDown || !this.#native.keyUp) {
          throw new StructuredToolError('holding keys across calls needs a newer native module', {
            error: 'hold_unsupported', remediation: ['Rebuild the native module (npm run build:native) or reinstall the package.'],
          })
        }
        const resolved = target()
        await focus(resolved)
        try { this.#native.keyDown(keys) } catch (error) { throw explainNativeKeyError(error) }
        for (const key of keys) {
          if (this.#held.has(key)) continue
          const timer = setTimeout(() => { this.releaseHeldKeys([key]) }, this.#heldKeysMaxMs)
          timer.unref?.()
          this.#held.set(key, timer)
        }
        const halt = this.#haltSignal?.()
        if (halt?.aborted) this.releaseHeldKeys()
        else halt?.addEventListener('abort', () => { this.releaseHeldKeys() }, { once: true })
        if (!this.#exitHook && this.#held.size) {
          this.#exitHook = () => { try { this.#native.keyUp?.([...this.#held.keys()].reverse()) } catch { /* exiting */ } }
          process.once('exit', this.#exitHook)
        }
        if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
        return ok(`Holding ${this.heldKeys().join('+')} until hold_key {action: "up"} or {action: "release"}; `
          + `they come up by themselves after ${Math.round(this.#heldKeysMaxMs / 1000)} s, on Pause, Stop or take-over, and when the session ends.`)
      }
      if (action !== 'hold') throw new Error(`Invalid action: ${action} (hold, down, up or release)`)
      if (typeof args.duration !== 'number') throw new Error('hold needs duration (seconds); use action "down" to hold across calls')
      const resolved = target()
      await focus(resolved)
      const requested = number('duration', 1)
      const duration = Math.min(Math.max(requested, 0), MAX_HOLD_SECONDS)
      if (this.#native.keyDown && this.#native.keyUp) {
        // 7.7.0 (C6): press, await, release. The event loop stays free during the hold, so the status card's Pause and
        // Stop, notifications/cancelled and control_status all work, and the keys come up on every exit path.
        try { this.#native.keyDown(keys) } catch (error) { throw explainNativeKeyError(error) }
        let interrupted = false
        try {
          interrupted = await sleepAbortable(duration * 1000, signal)
        } finally {
          this.#native.keyUp(keys)
        }
        if (interrupted) throw new Error(`hold_key interrupted after the keys went down; they are released`)
      } else {
        // An older native module: the hold sleeps on the server thread.
        try {
          this.#native.holdKey(keys, duration * 1000)
        } catch (error) { throw explainNativeKeyError(error) }
      }
      if (resolved.bundleId) this.#targets.update(resolved, 'keyboard')
      return ok(requested > MAX_HOLD_SECONDS ? `Held for ${duration} s (capped from ${requested} s)` : 'Held')
    }

    if (tool === 'read_clipboard') {
      if (this.#platform !== 'darwin' && this.#native.readClipboard) return ok(this.#native.readClipboard())
      return ok(this.#execFile('pbpaste', [], { env: utf8Env() }).toString())
    }

    if (tool === 'write_clipboard') {
      const text = string('text')
      let readBack: string | undefined
      if (this.#platform !== 'darwin' && this.#native.writeClipboard) {
        this.#native.writeClipboard(text)
        try { readBack = this.#native.readClipboard?.() } catch { readBack = undefined }
      } else {
        this.#execFile('pbcopy', [], { input: text, env: utf8Env() })
        try { readBack = this.#execFile('pbpaste', [], { env: utf8Env() }).toString() } catch { readBack = undefined }
      }
      // 7.7.0 (K1): read back, so `verified` means the clipboard holds exactly this text.
      return { ...ok('Written'), contract: { effect: readBack === text ? 'verified' : 'unverified' } }
    }

    if (tool === 'mouse_drag') {
      const resolved = target()
      const path = (Array.isArray(args.path) ? args.path : []) as [number, number][]
      if (path.length < 2) return this.#noCoordinates()
      const button = typeof args.button === 'string' ? args.button : 'left'
      const modifiers = this.#modifiers(args)
      const steps = typeof args.steps === 'number' ? args.steps : 8
      // 7.8.1: held keys, keys pressed mid-drag and pen pressure, all checked before anything moves.
      const holdKeys = this.#heldKeys(args)
      const keyPresses = this.#dragKeyPresses(args.key_presses, path.length)
      const pressure = this.#dragPressure(args.pressure)
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
      await this.#clearCard(path)
      if (pressure && (this.#platform !== 'darwin' || !this.#native.mousePenEvent)) {
        throw new StructuredToolError('pen pressure is unavailable here', {
          error: 'pressure_unsupported', platform: this.#platform,
          remediation: [this.#platform === 'darwin'
            ? 'The native module predates pen pressure; rebuild it (npm run build:native) or reinstall the package.'
            : 'Pen pressure is macOS only in this release; omit pressure for a mouse drag.'],
        })
      }
      await focus(resolved)

      const [startX, startY] = path[0]
      const [endX, endY] = path[path.length - 1]
      const total = (path.length - 1) * steps
      const pen = pressure ? this.#native.mousePenEvent!.bind(this.#native) : undefined
      const pressKeysAt = async (waypoint: number) => {
        for (const press of keyPresses.filter(entry => entry.at === waypoint)) {
          this.#checkAbort(signal, 'mouse_drag aborted mid-gesture')
          try { this.#native.keyPress(press.combo) } catch (error) { throw explainNativeKeyError(error) }
          await this.#sleep(40)
        }
      }
      await this.#approach(startX, startY, signal)
      this.#native.mouseMove(startX, startY)
      await this.#sleep(15)
      await this.#withHeldKeys(holdKeys, async () => {
        if (pen) pen(startX, startY, button, modifiers, 0, pressureAt(pressure!, 0))
        else this.#native.mousePress!(startX, startY, button, modifiers)
        try {
          await pressKeysAt(0)
          // Interpolate: applications that integrate incremental motion — 3D
          // viewport orbit, canvas painting — ignore a single jump to the endpoint.
          for (let segment = 1; segment < path.length; segment++) {
            const [fromX, fromY] = path[segment - 1]
            const [toX, toY] = path[segment]
            for (let step = 1; step <= steps; step++) {
              this.#checkAbort(signal, 'mouse_drag aborted mid-gesture')
              const ratio = step / steps
              const x = Math.round(fromX + (toX - fromX) * ratio)
              const y = Math.round(fromY + (toY - fromY) * ratio)
              if (pen) pen(x, y, button, modifiers, 1, pressureAt(pressure!, ((segment - 1) * steps + step) / total))
              else this.#native.mouseDragTo!(x, y, button, modifiers)
              await this.#sleep(8)
            }
            await pressKeysAt(segment)
          }
        } finally {
          // Never leave a button or modifier stuck down, even on abort. A pen ends at full pressure: the app keeps the
          // last pressure it saw, and the plain mouse should behave as it did before the stroke.
          if (pen) pen(endX, endY, button, modifiers, 2, 1)
          else this.#native.mouseRelease!(endX, endY, button, modifiers)
        }
      })
      if (resolved.bundleId) this.#targets.update(resolved, 'pointer')
      const notes = [
        ...(modifiers.length ? [`with ${modifiers.join('+')}`] : []),
        ...(holdKeys.length ? [`holding ${holdKeys.join('+')}`] : []),
        ...(pressure ? [`as a pen at pressure ${pressure.join('→')}`] : []),
        ...(keyPresses.length ? [`pressing ${keyPresses.map(entry => `${entry.key} at waypoint ${entry.at}`).join(', ')}`] : []),
      ]
      return ok(`Dragged ${button}${notes.length ? ' ' + notes.join(', ') : ''} through ${path.length} waypoints`)
    }

    if (tool === 'multi_select') {
      const resolved = target()
      await focus(resolved)
      const locations = Array.isArray(args.locs) ? [...args.locs] as [number, number][] : []
      if (Array.isArray(args.labels) && args.labels.length > 0 && resolved.windowId) {
        for (const label of args.labels as string[]) {
          const found = await this.#resolveLabel(resolved.windowId, label)
          if (found) locations.push(found)
        }
      }
      if (locations.length === 0) return this.#noCoordinates()
      for (const [x, y] of locations) this.#validateCoordinates(x, y)
      await this.#clearCard(locations)
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
        const found = await this.#resolveLabel(resolved.windowId, label)
        if (found) edits.push([found[0], found[1], text])
      }
    }
    if (edits.length === 0) return this.#noCoordinates()
    for (const [x, y] of edits) this.#validateCoordinates(x, y)
    await this.#clearCard(edits.map(([x, y]) => [x, y] as [number, number]))
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
    return { ...ok(`${summary}${this.#pidNote(route, outcome)}`), contract: { delivery: 'pid', effect: pidEffect(outcome) } }
  }

  /**
   * `type mode:"keys"`: every character as a key-down/key-up of its virtual key,
   * so apps that bind keys rather than read text (a game console on the grave key)
   * receive them. macOS uses the native layout-aware table; elsewhere, or with an
   * older native module, each character goes through `keyPress` with its US-ANSI
   * combo, and characters no key produces are sent as text.
   */
  /** 7.8.1 (macOS): does the target read only the first character of a key event's text? */
  #readsOneCharacterPerKey(resolved: ResolvedTarget): boolean {
    if (this.#platform !== 'darwin') return false
    let bundleId = resolved.bundleId
    try {
      if (!bundleId && resolved.windowId !== undefined) bundleId = this.#native.getWindow(resolved.windowId)?.bundleId ?? undefined
      if (!bundleId) bundleId = this.#native.getFrontmostApp()?.bundleId
    } catch { return false }
    return bundleId !== undefined && ONE_CHARACTER_PER_KEY_APPS.has(bundleId)
  }

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

  /** 7.8.1: `key_presses` of mouse_drag: each key resolved and its waypoint in range, before the drag starts. */
  #dragKeyPresses(raw: unknown, waypoints: number): { at: number; key: string; combo: string }[] {
    if (raw === undefined) return []
    if (!Array.isArray(raw)) throw new Error('Invalid key_presses: expected [{at, key}]')
    return raw.map((entry, index) => {
      const at = (entry as { at?: unknown })?.at
      const key = (entry as { key?: unknown })?.key
      if (typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at >= waypoints) {
        throw new Error(`Invalid key_presses[${index}].at: expected a waypoint index from 0 to ${waypoints - 1}`)
      }
      if (typeof key !== 'string' || key.length === 0) throw new Error(`Invalid key_presses[${index}].key: expected a key name`)
      return { at, key, combo: normalizeKeyCombo(key, this.#platform) }
    })
  }

  /** 7.8.1: `pressure` of mouse_drag as a list of 0-1 values, or undefined for a mouse drag. */
  #dragPressure(raw: unknown): number[] | undefined {
    if (raw === undefined) return undefined
    const values = typeof raw === 'number' ? [raw] : raw
    if (!Array.isArray(values) || values.length === 0 || values.length > 64
      || !values.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) {
      throw new Error('Invalid pressure: expected a number from 0 to 1, or a list of 1 to 64 of them')
    }
    return values as number[]
  }

  /** 7.8.1: the card is not in captures on macOS, so it moves aside rather than take input meant for the app under it. */
  async #clearCard(points: ReadonlyArray<readonly [number, number]>): Promise<void> {
    if (this.#clearOfCard && points.length > 0) await this.#clearOfCard(points.map(([x, y]) => [x, y] as [number, number]))
  }

  #validateCoordinates(x: number, y: number): void {
    const available = this.#native.listDisplays?.()
    const displays = available?.length ? available : [this.#native.getDisplaySize()]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !displays.some(display => {
      const originX = display.x ?? 0, originY = display.y ?? 0
      return x >= originX && y >= originY && x < originX + display.width && y < originY + display.height
    })) throw new Error(`Coordinates (${x}, ${y}) are outside display bounds`)
    const card = this.#protectedRegion?.()
    if (card && insideRect(x, y, card)) throw cardClickRefusal(x, y, card)
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
    try { saved = this.#execFile('pbpaste', [], { env: utf8Env() }).toString() } catch { /* best effort */ }
    try {
      this.#execFile('pbcopy', [], { input: text, env: utf8Env() })
      const verified = this.#execFile('pbpaste', [], { env: utf8Env() }).toString()
      if (verified === text) {
        this.#native.keyPress('command+v')
        await this.#sleep(100)
      } else this.#native.typeText(text)
    } finally {
      if (typeof saved === 'string') {
        try {
          if (this.#execFile('pbpaste', [], { env: utf8Env() }).toString() === text) this.#execFile('pbcopy', [], { input: saved, env: utf8Env() })
        } catch { /* best effort */ }
      }
    }
  }

  async #resolveLabel(windowId: number, label: string): Promise<[number, number] | undefined> {
    try {
      const elements = await offThread(this.#native, 'findElement', windowId, undefined, label, undefined, 1)
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
