/**
 * The live share watcher (7.8): watches the screen between tool calls and says when something worth a look happened.
 *
 * A model cannot take a video stream, and a frame a second costs a lot and answers late
 * (docs/reviews/2026-10-25-live-screen-share.md). So the watcher stays local: it samples the target a couple of times a
 * second, the helper says what changed between samples without the server decoding an image (macOS), the window list
 * says what opened, closed or took focus, and a gate turns bursts of change into single events. A model reads the
 * events (live_events, or a host's driver loop) and asks for a frame only when it wants to look.
 *
 * A persistent ScreenCaptureKit stream was tried first and dropped: while one ran, captures from other processes of the
 * helper hung (2026-10-25). Sampling goes through the same warm helper and lock as every other capture.
 *
 * The person stays in charge: watching shows on the status card, Pause stops the sampling (nothing is seen while
 * paused), Stop ends the watch, a locked screen pauses it, and nothing is sampled while a credential manager is
 * frontmost.
 */

import type { NativeModule, WindowRecord } from '../native.js'
import { ChangeGate, type FrameRect, type GateOptions } from './change-gate.js'
import { HelperFailure, type MacosHelper } from './macos-helper.js'
import { offThread } from './native-async.js'
import { resolveAppWindow } from './window-select.js'

export type LiveEventKind =
  | 'screen' | 'window_opened' | 'window_closed' | 'focus_changed' | 'title_changed'
  | 'watch_started' | 'watch_stopped' | 'paused' | 'resumed'

export interface ScreenRect { x: number; y: number; width: number; height: number }

export interface LiveEvent {
  seq: number
  at: string
  kind: LiveEventKind
  /** `agent` when it happened while the agent was acting (or just after): its own doing, most likely. */
  cause: 'agent' | 'other'
  /** screen: the largest single change, as a share of the watched area. */
  area?: number
  /** screen: the box around what changed, in screen points (the coordinates `click` takes). */
  region?: ScreenRect
  /** screen: false when the screen was still changing (reported every few seconds while it does). */
  settled?: boolean
  app?: string | null
  title?: string | null
  windowId?: number
  /** A credential manager is frontmost: nothing is sampled until it is not. */
  sensitive?: boolean
  reason?: string
}

export interface WatchTarget {
  app?: string
  title?: string
  windowId?: number
  displayId?: number | 'main'
}

export interface WatchStatus {
  watching: boolean
  target: string | null
  since: string | null
  intervalMs: number
  paused: boolean
  sensitive: boolean
  source: 'helper' | 'native' | null
  samples: number
  changes: number
  events: number
  lastSeq: number
  lastEventAt: string | null
  stoppedReason: string | null
}

export interface LiveFrame {
  data: string
  mimeType: string
  width: number
  height: number
  /** The captured area in screen points: screen point = frame origin + image point × (frame size / image size). */
  frame: ScreenRect
  capturedAt: string
}

/** What the watcher needs from the person-control layer (OperatorControl). */
export interface WatcherControl {
  state(): string
  watching(info: { target: string; since: number } | null): void
}

export const WATCH_INTERVAL_MS = 500
/** Width of the samples compared for change: a dialog or a line of text shows; a pixel of noise does not. */
export const WATCH_SAMPLE_WIDTH = 640
const AGENT_SETTLE_MS = 1_500
const MAX_EVENTS = 500
const MAX_FAILURES = 3
/** The macOS menu bar: a clock and status items change there all day. */
const MENU_BAR_POINTS = 38

export class LiveWatcher {
  readonly #native: NativeModule
  readonly #helper: MacosHelper | undefined
  readonly #control: WatcherControl | undefined
  readonly #now: () => number
  readonly #sensitiveApps: Set<string>
  readonly #gateOptions: GateOptions
  readonly #platform: NodeJS.Platform
  #target: (WatchTarget & { label: string; pid?: number; bundleId?: string | null }) | undefined
  #since = 0
  #intervalMs = WATCH_INTERVAL_MS
  readonly #setTimer: (run: () => void, ms: number) => { cancel(): void }
  #timer: { cancel(): void } | undefined
  #ticking = false
  #gate = new ChangeGate()
  #frame: ScreenRect | undefined
  #previousHash: string | undefined
  #windows: Map<number, { app: string | null; title: string | null }> | undefined
  #frontmost: { app: string | null; title: string | null } | undefined
  #paused = false
  #sensitive = false
  #failures = 0
  #agentActive = false
  #agentUntil = 0
  #samples = 0
  #changes = 0
  #events: LiveEvent[] = []
  #seq = 0
  #stoppedReason: string | null = null
  readonly #listeners = new Set<(event: LiveEvent) => void>()

  constructor(options: {
    native: NativeModule
    helper?: MacosHelper
    control?: WatcherControl
    now?: () => number
    platform?: NodeJS.Platform
    sensitiveApps?: string[]
    gate?: GateOptions
    /** Schedules the next sample; tests step it by hand. */
    setTimer?: (run: () => void, ms: number) => { cancel(): void }
  }) {
    this.#setTimer = options.setTimer ?? ((run, ms) => {
      const timer = setTimeout(run, ms)
      timer.unref?.()
      return { cancel: () => clearTimeout(timer) }
    })
    this.#native = options.native
    this.#helper = options.helper
    this.#control = options.control
    this.#now = options.now ?? Date.now
    this.#platform = options.platform ?? process.platform
    this.#sensitiveApps = new Set((options.sensitiveApps ?? []).map(app => app.toLowerCase()))
    this.#gateOptions = options.gate ?? {}
  }

  get watching(): boolean { return this.#target !== undefined }

  /** Start watching (or move the watch to a new target). */
  start(target: WatchTarget = {}, options: { intervalMs?: number } = {}): WatchStatus {
    const state = this.#control?.state()
    if (state === 'stopped') throw new LiveWatchError('stopped_by_user', 'The person stopped the agent for this session; it cannot watch.')
    let resolved: WatchTarget & { label: string; pid?: number; bundleId?: string | null }
    if (target.windowId !== undefined) {
      const window = this.#native.getWindow?.(target.windowId)
      if (!window) throw new LiveWatchError('window_not_found', `No on-screen window ${target.windowId}`)
      resolved = { windowId: target.windowId, label: describeWindow(window), pid: window.pid, bundleId: window.bundleId }
    } else if (target.app) {
      const window = resolveAppWindow(this.#native, target.app, target.title)
      if (!window) throw new LiveWatchError('window_not_found', `${target.app} has no on-screen window`)
      resolved = { app: target.app, windowId: window.windowId, label: describeWindow(window), pid: window.pid, bundleId: window.bundleId }
    } else {
      resolved = { displayId: target.displayId ?? 'main', label: 'the screen' }
    }
    this.#halt()
    this.#target = resolved
    this.#since = this.#now()
    this.#intervalMs = Math.max(200, Math.min(5_000, options.intervalMs ?? WATCH_INTERVAL_MS))
    this.#frame = undefined
    this.#gate = new ChangeGate(this.#gateOptions)
    this.#previousHash = undefined
    this.#windows = undefined
    this.#frontmost = undefined
    this.#failures = 0
    this.#paused = false
    this.#sensitive = false
    this.#stoppedReason = null
    this.#control?.watching({ target: resolved.label, since: this.#since })
    this.#emit({ kind: 'watch_started', reason: resolved.label })
    this.#schedule(0)
    return this.status()
  }

  stop(reason = 'stopped'): WatchStatus {
    if (!this.#target) return this.status()
    this.#halt()
    this.#target = undefined
    this.#stoppedReason = reason
    this.#control?.watching(null)
    this.#emit({ kind: 'watch_stopped', reason })
    return this.status()
  }

  close(): void {
    this.stop('session_closed')
    this.#listeners.clear()
  }

  status(): WatchStatus {
    const last = this.#events.at(-1)
    return {
      watching: this.#target !== undefined,
      target: this.#target?.label ?? null,
      since: this.#target ? new Date(this.#since).toISOString() : null,
      intervalMs: this.#intervalMs,
      paused: this.#paused,
      sensitive: this.#sensitive,
      source: this.#target ? (this.#useHelper() ? 'helper' : 'native') : null,
      samples: this.#samples,
      changes: this.#changes,
      events: this.#events.length,
      lastSeq: this.#seq,
      lastEventAt: last?.at ?? null,
      stoppedReason: this.#stoppedReason,
    }
  }

  /** Events after `since` (a seq), oldest first. */
  events(since = 0): LiveEvent[] {
    return this.#events.filter(event => event.seq > since)
  }

  /** Events after `since`, waiting up to `timeoutMs` for the first one. */
  async waitForEvents(since: number, timeoutMs: number, signal?: AbortSignal): Promise<LiveEvent[]> {
    const ready = this.events(since)
    if (ready.length || timeoutMs <= 0) return ready
    return await new Promise<LiveEvent[]>(resolve => {
      const finish = () => {
        clearTimeout(timer)
        this.#listeners.delete(listener)
        signal?.removeEventListener('abort', finish)
        resolve(this.events(since))
      }
      const listener = () => finish()
      const timer = setTimeout(finish, timeoutMs)
      this.#listeners.add(listener)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  onEvent(listener: (event: LiveEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** The session dispatched (or finished) an action: changes now are most likely the agent's own. */
  agentActing(active: boolean): void {
    this.#agentActive = active
    if (!active) this.#agentUntil = this.#now() + AGENT_SETTLE_MS
  }

  /** A fresh frame of the watched target, for a model or a person's live view. Not a sample: full size by default. */
  async latestFrame(options: { width?: number; quality?: number } = {}, signal?: AbortSignal): Promise<LiveFrame> {
    const target = this.#target
    if (!target) throw new LiveWatchError('not_watching', 'Nothing is being watched; start a watch first.')
    if (this.#paused) throw new LiveWatchError('paused_by_user', 'The person paused the agent; the watch sees nothing until they resume.')
    if (this.#sensitive) throw new LiveWatchError('sensitive_app_frontmost', 'A credential manager is frontmost, so no frame is taken.')
    const width = options.width ?? 1280
    const quality = options.quality ?? 70
    if (this.#useHelper()) {
      const capture = await this.#helper!.capture({
        ...(target.windowId !== undefined ? { windowId: target.windowId } : { displayId: target.displayId ?? 'main', overlayPids: [process.pid] }),
        width, quality,
      }, signal)
      return { data: capture.data.toString('base64'), mimeType: capture.mimeType, width: capture.width, height: capture.height,
        frame: capture.frame, capturedAt: new Date(this.#now()).toISOString() }
    }
    const shot = await offThread(this.#native, 'takeScreenshot', width, undefined, quality, undefined, target.windowId, typeof target.displayId === 'number' ? target.displayId : undefined)
    if (!shot.base64) throw new LiveWatchError('capture_failed', 'The capture returned no image')
    return { data: shot.base64, mimeType: shot.mimeType, width: shot.width, height: shot.height,
      frame: this.#nativeArea(target), capturedAt: new Date(this.#now()).toISOString() }
  }

  // ── The loop ───────────────────────────────────────────────────────────

  #useHelper(): boolean {
    return this.#platform === 'darwin' && this.#helper?.supportsCapture() === true
  }

  #halt(): void {
    this.#timer?.cancel()
    this.#timer = undefined
  }

  #schedule(delay: number): void {
    if (!this.#target) return
    this.#timer = this.#setTimer(() => { void this.#tick() }, delay)
  }

  async #tick(): Promise<void> {
    if (this.#ticking || !this.#target) return
    this.#ticking = true
    const started = this.#now()
    try {
      await this.#sample()
    } finally {
      this.#ticking = false
      this.#schedule(Math.max(0, this.#intervalMs - (this.#now() - started)))
    }
  }

  async #sample(): Promise<void> {
    const target = this.#target!
    // The person's controls first: Stop ends the watch, Pause and a locked screen stop it seeing anything.
    const state = this.#control?.state()
    if (state === 'stopped') { this.stop('stopped_by_user'); return }
    const locked = this.#locked()
    const shouldPause = state === 'paused' || locked
    if (shouldPause !== this.#paused) {
      this.#paused = shouldPause
      this.#gate.reset()
      this.#emit({ kind: shouldPause ? 'paused' : 'resumed', reason: shouldPause ? (locked ? 'screen_locked' : 'paused_by_user') : 'running' })
    }
    if (this.#paused) return
    this.#watchWindows(target)
    if (this.#sensitive) return
    const now = this.#now()
    try {
      if (this.#useHelper()) await this.#sampleHelper(target, now)
      else await this.#sampleNative(target, now)
      this.#failures = 0
    } catch (error) {
      if (!(error instanceof HelperFailure) && !(error instanceof Error)) throw error
      this.#failures += 1
      const code = error instanceof HelperFailure ? error.code : 'capture_failed'
      if (code === 'screen_recording_denied' || code === 'window_not_found' || this.#failures >= MAX_FAILURES) {
        this.stop(`${code}: ${error.message}`.slice(0, 300))
      }
      return
    }
    const gated = this.#gate.poll(this.#now())
    if (gated) {
      const frame = this.#frame
      this.#emit({
        kind: 'screen', area: gated.area, settled: gated.settled,
        ...(gated.dirty && frame ? { region: toScreen(gated.dirty, frame) } : {}),
      }, gated.startedAt)
    }
  }

  async #sampleHelper(target: WatchTarget, now: number): Promise<void> {
    const capture = await this.#helper!.capture({
      ...(target.windowId !== undefined ? { windowId: target.windowId } : { displayId: target.displayId ?? 'main', overlayPids: [process.pid] }),
      width: WATCH_SAMPLE_WIDTH, quality: 50, diff: true, skipUnchanged: true,
    })
    this.#samples += 1
    if (!this.#frame || !sameRect(this.#frame, capture.frame)) {
      this.#frame = capture.frame
      this.#gate = new ChangeGate({ ...this.#gateOptions, ignore: this.#ignoreFor(target, capture.frame) })
    }
    const diff = capture.diff
    if (diff?.changed && !diff.first) {
      this.#changes += 1
      this.#gate.observe({ at: now, area: diff.area, ...(diff.dirty ? { dirty: diff.dirty } : {}) })
    }
  }

  async #sampleNative(target: WatchTarget, now: number): Promise<void> {
    const shot = await offThread(this.#native, 'takeScreenshot', WATCH_SAMPLE_WIDTH, undefined, 50, this.#previousHash,
      target.windowId, typeof target.displayId === 'number' ? target.displayId : undefined)
    this.#samples += 1
    this.#frame = this.#nativeArea(target)
    // The native capture says only whether the encoded frame changed, not where.
    if (this.#previousHash !== undefined && !shot.unchanged && shot.hash !== this.#previousHash) {
      this.#changes += 1
      this.#gate.observe({ at: now, area: 1 })
    }
    this.#previousHash = shot.hash
  }

  #nativeArea(target: WatchTarget): ScreenRect {
    const bounds = target.windowId !== undefined ? this.#native.getWindow?.(target.windowId)?.bounds : undefined
    if (bounds) return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    const display = this.#native.getDisplaySize()
    return { x: display.x ?? 0, y: display.y ?? 0, width: display.width, height: display.height }
  }

  #ignoreFor(target: WatchTarget, frame: ScreenRect): FrameRect[] {
    const ignore = [...(this.#gateOptions.ignore ?? [])]
    if (target.windowId === undefined && this.#platform === 'darwin' && frame.height > 0) {
      ignore.push({ x: 0, y: 0, width: 1, height: MENU_BAR_POINTS / frame.height })
    }
    return ignore
  }

  #locked(): boolean {
    try { return this.#native.getSessionState?.().locked === true } catch { return false }
  }

  /** Windows that opened or closed, focus moving between apps, and the frontmost title changing. */
  #watchWindows(target: WatchTarget & { pid?: number; bundleId?: string | null }): void {
    let windows: WindowRecord[] = []
    let front: { bundleId?: string | null; displayName?: string } | null = null
    try { windows = this.#native.listWindows() } catch { windows = [] }
    try { front = this.#native.getFrontmostApp() } catch { front = null }
    const app = front?.bundleId ?? null
    this.#sensitive = app !== null && this.#sensitiveApps.has(app.toLowerCase())
    const relevant = windows.filter(window =>
      window.isOnScreen !== false && window.bounds.width > 40 && window.bounds.height > 40
      && window.pid !== process.pid && !(window.displayName ?? '').startsWith('macos-status-card')
      && (target.pid === undefined || window.pid === target.pid))
    const current = new Map(relevant.map(window => [window.windowId, { app: window.bundleId, title: window.title }]))
    const frontTitle = relevant.find(window => window.isFocused && window.bundleId === app)?.title ?? null
    const previous = this.#windows
    const previousFront = this.#frontmost
    this.#windows = current
    this.#frontmost = { app, title: frontTitle }
    if (!previous || !previousFront) return
    if (previousFront.app !== app) {
      // A window or app watch cares about focus only when its own app gains or loses it (the person switching between
      // other apps is not news), and its pixels do not change with focus, so its gate keeps a burst in progress. A
      // credential manager coming forward is always reported: it is why sampling pauses.
      const scoped = target.pid !== undefined
      if (!scoped) this.#gate.reset()
      if (!scoped || this.#sensitive || previousFront.app === target.bundleId || app === target.bundleId) {
        this.#emit({ kind: 'focus_changed', app, title: this.#sensitive ? null : frontTitle, ...(this.#sensitive ? { sensitive: true } : {}) })
      }
    } else if (previousFront.title !== frontTitle && frontTitle !== null && !this.#sensitive) {
      this.#emit({ kind: 'title_changed', app, title: frontTitle })
    }
    const opened = [...current].filter(([id]) => !previous.has(id))
    const closed = [...previous].filter(([id]) => !current.has(id))
    // Mission Control or a space switch changes every window at once; one event says so.
    if (opened.length + closed.length > 8) {
      this.#emit({ kind: 'window_opened', reason: `${opened.length} windows appeared and ${closed.length} went away` })
      return
    }
    for (const [windowId, info] of opened) this.#emit({ kind: 'window_opened', windowId, app: info.app, title: this.#sensitiveTitle(info) })
    for (const [windowId, info] of closed) this.#emit({ kind: 'window_closed', windowId, app: info.app, title: this.#sensitiveTitle(info) })
  }

  #sensitiveTitle(info: { app: string | null; title: string | null }): string | null {
    return info.app && this.#sensitiveApps.has(info.app.toLowerCase()) ? null : info.title
  }

  #emit(event: Omit<LiveEvent, 'seq' | 'at' | 'cause'>, startedAt = this.#now()): void {
    const agent = this.#agentActive || startedAt <= this.#agentUntil
    const full: LiveEvent = { seq: ++this.#seq, at: new Date(this.#now()).toISOString(), cause: agent ? 'agent' : 'other', ...event }
    this.#events.push(full)
    if (this.#events.length > MAX_EVENTS) this.#events.splice(0, this.#events.length - MAX_EVENTS)
    for (const listener of [...this.#listeners]) {
      try { listener(full) } catch { /* a listener's failure is its own */ }
    }
  }
}

export class LiveWatchError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'LiveWatchError'
  }
}

function describeWindow(window: WindowRecord): string {
  const app = window.displayName || window.bundleId || 'a window'
  return window.title ? `${app} · ${window.title}` : app
}

function sameRect(a: ScreenRect, b: ScreenRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function toScreen(dirty: FrameRect, frame: ScreenRect): ScreenRect {
  return {
    x: Math.round(frame.x + dirty.x * frame.width),
    y: Math.round(frame.y + dirty.y * frame.height),
    width: Math.max(1, Math.round(dirty.width * frame.width)),
    height: Math.max(1, Math.round(dirty.height * frame.height)),
  }
}
