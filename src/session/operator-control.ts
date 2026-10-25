/**
 * Operator control (7.6.1): the person's side of the desktop session.
 *
 * One state machine, on every platform, that a desktop status card drives: `running`, `paused` (new mutations are
 * refused with `paused_by_user`, the one in flight is aborted, reads continue) and `stopped` (the same, latched for the
 * rest of the session; when the native module has the emergency-stop latch, Stop trips it too, so actuators stop
 * mid-gesture and nothing resumes until a trusted host resets it). The model reads the state through `control_status`
 * and in every refusal, so it stops guessing.
 *
 * The card itself is a separate process per platform (`libexec/macos-status-card.swift`, compiled on first use like
 * the capture helper; `libexec/windows-status-card.ps1`; `libexec/linux-status-card.py`), fed through two small files
 * in a private directory: `state.json`, written here atomically, and `control.txt`, written by the card (`running`,
 * `paused`, `stopped`). The card watches this process's pid and exits when it is gone, so a crashed server leaves
 * nothing on screen. On macOS and Windows it is excluded from screen capture, so the agent never sees its own controls;
 * X11 has no such exclusion, so the Linux card reports where it is (`card.json`) and the session paints that rectangle
 * out of captures and refuses clicks inside it (`card-guard.ts`).
 *
 * What the card shows is honest: the tool, its key argument, the app and the window it was aimed at, as the session
 * resolved them, never a bucketed verb like "Selecting". Designed from the review of PR #40 (a Windows-only card with
 * the same two files), whose veto-and-abort shape this keeps.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NativeModule } from '../native.js'
import { compileSwiftHelper, defaultHelperCacheDir } from './macos-helper.js'

export type ControlState = 'running' | 'paused' | 'stopped'
/** `takeover` (7.7.0, K5): the person used the mouse or keyboard while the agent was acting; it resumes when they stop. */
export type ControlReason = 'person' | 'host' | 'emergency_stop' | 'session_closed' | 'takeover'
export type ControlWaiting = 'user_active' | 'approval' | null

export interface ControlAction {
  tool: string
  /** The tool and its key argument, e.g. `click (120, 340)`, `type 24 chars`, `run_script applescript`. */
  label: string
  app?: string
  window?: string
  at: string
  outcome: 'active' | 'done' | 'failed'
}

/** What the card renders; `state.json`. */
export interface CardFrame {
  pid: number
  state: ControlState
  reason: ControlReason | null
  startedAt: number
  updatedAt: number
  action: ControlAction | null
  recent: ControlAction[]
  waiting: ControlWaiting
  chord: string | null
  platform: NodeJS.Platform
}

export interface ControlStatus extends Record<string, unknown> {
  state: ControlState
  reason: ControlReason | null
  since: string
  card: {
    enabled: boolean
    presenter: string
    launched: boolean
    directory: string | null
    error: string | null
  }
  emergencyStop: { latched: boolean }
  lastRefused: { tool: string; at: string } | null
  waiting: ControlWaiting
}

/** Shows the card for a session directory; one per platform, or none. */
export interface CardPresenter {
  readonly kind: string
  /**
   * The card shows up in screen captures (Linux: X11 cannot exclude a window). The card then writes its rectangle to
   * `card.json`, and the session masks it out of captures and refuses clicks inside it.
   */
  readonly visibleInCaptures?: boolean
  start(directory: string): Promise<void> | void
  stop(): void
}

/** A rectangle in screen pixels (X root pixels on Linux). */
export interface CardRect { x: number; y: number; width: number; height: number }

export const CONTROL_POLL_MS = 150
const RECENT_ACTIONS = 4

/**
 * 7.7.0 (K5): what counts as the person taking over during an action: any physical key or button press, or this much
 * pointer travel (points, summed |dx| + |dy|; Windows-MCP settled on 500 after nudges kept pausing agents). After a
 * takeover the agent resumes once the person has been idle this long.
 */
export const TAKEOVER_MOVEMENT = 500
export const TAKEOVER_RESUME_IDLE_MS = 5000
const TAKEOVER_POLL_MS = 100

export interface TakeoverOptions {
  counters: () => { supported: boolean; movement: number; keys: number; buttons: number } | undefined
  /** Milliseconds since the person's last physical input, or null when unknown. */
  idleMs: () => number | null | undefined
  movement?: number
  resumeIdleMs?: number
  pollMs?: number
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b])
  const controller = new AbortController()
  const forward = (signal: AbortSignal) => () => { if (!controller.signal.aborted) controller.abort(signal.reason) }
  if (a.aborted) controller.abort(a.reason)
  else if (b.aborted) controller.abort(b.reason)
  else { a.addEventListener('abort', forward(a), { once: true }); b.addEventListener('abort', forward(b), { once: true }) }
  return controller.signal
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class OperatorControl {
  readonly #native: Partial<Pick<NativeModule, 'triggerNativeEmergencyStop' | 'isNativeEmergencyStopActive'>>
  readonly #now: () => number
  readonly #presenter: CardPresenter | undefined
  readonly #pollMs: number
  readonly #platform: NodeJS.Platform
  readonly #chord: string | null
  readonly #startedAt: number
  #directory: string | undefined
  #state: ControlState = 'running'
  #reason: ControlReason | null = null
  #since: number
  #controller = new AbortController()
  #timer: ReturnType<typeof setInterval> | undefined
  #launched = false
  #launching: Promise<void> | undefined
  #presenterError: string | null = null
  #closed = false
  #lastControl = 'running'
  #action: ControlAction | null = null
  #recent: ControlAction[] = []
  #waiting: ControlWaiting = null
  #lastRefused: { tool: string; at: string } | null = null
  #lastFrame = ''
  readonly #takeover: TakeoverOptions | undefined
  #takeoverTimer: ReturnType<typeof setInterval> | undefined
  #takeoverBaseline: { movement: number; keys: number; buttons: number } | undefined
  #resumeTimer: ReturnType<typeof setInterval> | undefined
  #watcher: { close(): void } | undefined

  constructor(options: {
    native?: Partial<Pick<NativeModule, 'triggerNativeEmergencyStop' | 'isNativeEmergencyStopActive'>>
    /** The desktop card. Absent: the state machine alone (the host can still pause, resume and stop). */
    card?: { presenter: CardPresenter; directory?: string; pollMs?: number }
    now?: () => number
    platform?: NodeJS.Platform
    /** The physical emergency-stop chord, when a host armed one; shown on the card. */
    chord?: string | null
    /** 7.7.0 (K5): pause when the person takes over the mouse or keyboard during an action; absent: no takeover. */
    takeover?: TakeoverOptions
  } = {}) {
    this.#native = options.native ?? {}
    this.#now = options.now ?? Date.now
    this.#presenter = options.card?.presenter
    this.#pollMs = options.card?.pollMs ?? CONTROL_POLL_MS
    this.#platform = options.platform ?? process.platform
    this.#chord = options.chord ?? null
    this.#takeover = options.takeover
    this.#startedAt = this.#now()
    this.#since = this.#startedAt
    if (options.card) {
      this.#directory = options.card.directory ?? mkdtempSync(join(tmpdir(), 'computer-use-card-'))
      this.#writeControl('running')
      this.#publish()
    }
  }

  state(): ControlState { this.#refresh(); return this.#state }

  status(): ControlStatus {
    this.#refresh()
    return {
      state: this.#state,
      reason: this.#reason,
      since: new Date(this.#since).toISOString(),
      card: {
        enabled: Boolean(this.#presenter),
        presenter: this.#presenter?.kind ?? 'none',
        launched: this.#launched,
        directory: this.#directory ?? null,
        error: this.#presenterError,
      },
      emergencyStop: { latched: this.#native.isNativeEmergencyStopActive?.() === true },
      lastRefused: this.#lastRefused,
      waiting: this.#waiting,
      takeover: this.#takeover ? {
        enabled: true,
        movement: this.#takeover.movement ?? TAKEOVER_MOVEMENT,
        resumeIdleMs: this.#takeover.resumeIdleMs ?? TAKEOVER_RESUME_IDLE_MS,
      } : { enabled: false },
      chord: this.#chord,
    }
  }

  /**
   * Where the card is on screen, when it is up and shows in captures (Linux); undefined otherwise. Read from the
   * `card.json` the card writes, padded by a few pixels for anti-aliasing at its edge. A card that died without
   * removing the file (killed, crashed, its X connection gone) has given its strip back, so its pid is checked:
   * otherwise captures would keep a grey box, and clicks there would be refused, where nothing is.
   */
  cardRegion(): CardRect | undefined {
    if (this.#closed || !this.#presenter?.visibleInCaptures || !this.#directory) return undefined
    if (!this.#launched && !this.#launching) return undefined
    let card: { frame?: Partial<CardRect>; pid?: unknown }
    try { card = JSON.parse(readFileSync(join(this.#directory, 'card.json'), 'utf8')) as typeof card } catch { return undefined }
    if (typeof card.pid === 'number' && !processAlive(card.pid)) return undefined
    const frame = card.frame
    if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(value => typeof value === 'number' && Number.isFinite(value))) return undefined
    const pad = 2
    return { x: frame.x! - pad, y: frame.y! - pad, width: frame.width! + 2 * pad, height: frame.height! + 2 * pad }
  }

  /** The signal a mutating dispatch should run under: aborted by Pause and Stop. */
  signal(parent?: AbortSignal): AbortSignal {
    this.#refresh()
    return mergeSignals(parent, this.#controller.signal)
  }

  /** A refusal payload when the person has paused or stopped; undefined when the call may proceed. */
  gate(tool: string): Record<string, unknown> | undefined {
    this.#refresh()
    if (this.#state === 'running') return undefined
    const at = new Date(this.#now()).toISOString()
    this.#lastRefused = { tool, at }
    this.#publish()
    if (this.#state === 'paused' && this.#reason === 'takeover') {
      return {
        error: 'taken_over',
        status: this.#state,
        tool,
        since: new Date(this.#since).toISOString(),
        reason: this.#reason,
        hint: `The person is using the mouse or keyboard, so the agent paused. It resumes by itself ${Math.round((this.#takeover?.resumeIdleMs ?? TAKEOVER_RESUME_IDLE_MS) / 1000)} s after they stop; then look before acting.`,
      }
    }
    return {
      error: `${this.#state}_by_user`,
      status: this.#state,
      tool,
      since: new Date(this.#since).toISOString(),
      reason: this.#reason,
      hint: this.#state === 'paused'
        ? 'The person paused the agent from the desktop status card. Observation tools still work; wait, then retry, or report what you have. control_status says when it resumes.'
        : 'The person stopped the agent from the desktop status card. No mutating tool runs again in this session; report what you have and finish.',
    }
  }

  /**
   * A tracked call started. 7.7.0: the card launches on the first call that changes the desktop (`mutates`), not on
   * a screenshot; a mutating call also arms the takeover watch for its duration.
   */
  begin(action: { tool: string; label: string; app?: string; window?: string }, options: { mutates?: boolean } = {}): void {
    if (this.#closed) return
    if (options.mutates !== false) this.#ensurePresenter()
    this.#refresh()
    this.#action = { ...action, at: new Date(this.#now()).toISOString(), outcome: 'active' }
    this.#waiting = null
    if (options.mutates) this.#watchTakeover()
    this.#publish()
  }

  finish(outcome: 'done' | 'failed'): void {
    this.#stopTakeoverWatch()
    if (this.#closed || !this.#action) return
    const finished: ControlAction = { ...this.#action, outcome }
    this.#recent = [finished, ...this.#recent].slice(0, RECENT_ACTIONS)
    this.#action = null
    this.#publish()
  }

  // ── Takeover (7.7.0, K5) ───────────────────────────────────────────────

  #watchTakeover(): void {
    if (!this.#takeover || this.#takeoverTimer || this.#state !== 'running') return
    const first = this.#takeover.counters()
    if (!first?.supported) return
    this.#takeoverBaseline = { movement: first.movement, keys: first.keys, buttons: first.buttons }
    this.#takeoverTimer = setInterval(() => this.#checkTakeover(), this.#takeover.pollMs ?? TAKEOVER_POLL_MS)
    this.#takeoverTimer.unref?.()
  }

  #stopTakeoverWatch(): void {
    if (this.#takeoverTimer) clearInterval(this.#takeoverTimer)
    this.#takeoverTimer = undefined
    this.#takeoverBaseline = undefined
  }

  #checkTakeover(): void {
    const baseline = this.#takeoverBaseline
    const now = this.#takeover?.counters()
    if (!baseline || !now?.supported || this.#state !== 'running') return
    const deliberate = now.keys > baseline.keys || now.buttons > baseline.buttons
      || now.movement - baseline.movement >= (this.#takeover?.movement ?? TAKEOVER_MOVEMENT)
    if (!deliberate) return
    this.#stopTakeoverWatch()
    this.#transition('paused', 'takeover')
    this.#watchResume()
  }

  /** Resume after a takeover once the person has been idle long enough; a person's own pause or stop wins. */
  #watchResume(): void {
    if (!this.#takeover || this.#resumeTimer) return
    const quiet = this.#takeover.resumeIdleMs ?? TAKEOVER_RESUME_IDLE_MS
    this.#resumeTimer = setInterval(() => {
      if (this.#closed || this.#state !== 'paused' || this.#reason !== 'takeover') {
        clearInterval(this.#resumeTimer)
        this.#resumeTimer = undefined
        return
      }
      const idle = this.#takeover?.idleMs()
      if (typeof idle === 'number' && idle >= quiet) {
        clearInterval(this.#resumeTimer)
        this.#resumeTimer = undefined
        this.#transition('running', 'takeover')
      }
    }, 250)
    this.#resumeTimer.unref?.()
  }

  /** What the agent is waiting on, so the card can say "waiting for you" or "approval needed". */
  waiting(kind: ControlWaiting): void {
    if (this.#closed || this.#waiting === kind) return
    this.#waiting = kind
    this.#publish()
  }

  pause(reason: ControlReason = 'host'): void {
    if (this.#closed || this.#state !== 'running') return
    this.#transition('paused', reason)
  }

  resume(reason: ControlReason = 'host'): void {
    if (this.#closed || this.#state !== 'paused') return
    this.#transition('running', reason)
  }

  /** Terminal for the session. Trips the native latch when there is one, so actuators stop mid-gesture. */
  stop(reason: ControlReason = 'host'): void {
    if (this.#closed || this.#state === 'stopped') return
    this.#transition('stopped', reason)
    try { this.#native.triggerNativeEmergencyStop?.() } catch { /* the session-level refusal still holds */ }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#timer) clearInterval(this.#timer)
    this.#stopTakeoverWatch()
    if (this.#resumeTimer) clearInterval(this.#resumeTimer)
    try { this.#watcher?.close() } catch { /* already closed */ }
    if (!this.#controller.signal.aborted) this.#controller.abort(new Error('Desktop session closed'))
    this.#writeControl('stopped')
    try { this.#presenter?.stop() } catch { /* already gone */ }
    if (this.#directory) {
      try { rmSync(this.#directory, { recursive: true, force: true }) } catch { /* the card removes what it can */ }
    }
  }

  #transition(state: ControlState, reason: ControlReason): void {
    this.#state = state
    this.#reason = reason
    this.#since = this.#now()
    if (state === 'running') this.#controller = new AbortController()
    else if (!this.#controller.signal.aborted) this.#controller.abort(new Error(`Desktop control ${state} by ${reason}`))
    this.#lastControl = state
    this.#writeControl(state)
    this.#publish()
  }

  #ensurePresenter(): void {
    if (!this.#presenter || !this.#directory || this.#launched || this.#launching) return
    const directory = this.#directory
    this.#launching = Promise.resolve()
      .then(() => this.#presenter!.start(directory))
      .then(() => { this.#launched = true; this.#publish() })
      .catch(error => { this.#presenterError = error instanceof Error ? error.message : String(error); this.#publish() })
      .finally(() => { this.#launching = undefined })
    if (!this.#timer) {
      this.#timer = setInterval(() => this.#refresh(), this.#pollMs)
      this.#timer.unref?.()
    }
    this.#watchControlFile()
  }

  /**
   * 7.7.0 (K4): react to the card's Pause and Stop the moment `control.txt` changes, not at the next 150 ms poll (the
   * poll stays as a fallback for file systems where watching is unreliable).
   */
  #watchControlFile(): void {
    if (this.#watcher || !this.#directory) return
    try {
      const watcher = watch(this.#directory, { persistent: false }, (_event, file) => {
        if (!file || String(file) === 'control.txt') this.#refresh()
      })
      watcher.on('error', () => { /* the poll remains */ })
      this.#watcher = watcher
    } catch { /* the poll remains */ }
  }

  /** Apply what the card wrote, if it changed. */
  #refresh(): void {
    if (this.#closed || !this.#directory) return
    let value: string
    try { value = readFileSync(join(this.#directory, 'control.txt'), 'utf8').trim().toLowerCase() } catch { return }
    if (value === this.#lastControl) return
    if (value !== 'running' && value !== 'paused' && value !== 'stopped') return
    this.#lastControl = value
    if (value === 'stopped') this.stop('person')
    else if (value === 'paused') this.pause('person')
    else this.resume('person')
  }

  #writeControl(value: string): void {
    if (!this.#directory) return
    try { writeFileSync(join(this.#directory, 'control.txt'), value, { mode: 0o600 }) } catch { /* the card is optional */ }
  }

  #publish(): void {
    if (!this.#directory) return
    const frame: CardFrame = {
      pid: process.pid,
      state: this.#state,
      reason: this.#reason,
      startedAt: this.#startedAt,
      updatedAt: this.#now(),
      action: this.#action,
      recent: this.#recent,
      waiting: this.#waiting,
      chord: this.#chord,
      platform: this.#platform,
    }
    const payload = JSON.stringify(frame)
    if (payload === this.#lastFrame) return
    try {
      const target = join(this.#directory, 'state.json')
      const temporary = `${target}.${process.pid}.tmp`
      writeFileSync(temporary, payload, { mode: 0o600 })
      renameSync(temporary, target)
      this.#lastFrame = payload
    } catch { /* the card is optional: never change a tool result */ }
  }
}

/** The tool and its key argument, with the app and window the session resolved, for the card. Never typed text. */
export function describeAction(tool: string, args: Record<string, unknown>, resolved: { app?: string; window?: string }): { tool: string; label: string; app?: string; window?: string } {
  const text = (value: unknown, max = 40) => typeof value === 'string' ? (value.length > max ? `${value.slice(0, max)}…` : value) : undefined
  const point = Array.isArray(args.coordinate) && args.coordinate.length >= 2 ? `(${args.coordinate[0]}, ${args.coordinate[1]})` : undefined
  let detail: string | undefined
  switch (tool) {
    case 'click': case 'left_click': case 'right_click': case 'middle_click': case 'double_click': case 'triple_click':
    case 'mouse_move': case 'left_mouse_down': case 'left_mouse_up':
      detail = point; break
    case 'scroll': detail = `${String(args.direction ?? '')} ${point ?? ''}`.trim(); break
    case 'type': detail = typeof args.text === 'string' ? `${args.text.length} chars` : undefined; break
    case 'key': detail = text(args.text, 24); break
    case 'hold_key': detail = Array.isArray(args.keys) ? args.keys.join('+') : undefined; break
    case 'click_text': case 'wait_for_text': detail = text(args.text) ? `"${text(args.text)}"` : undefined; break
    case 'click_element': case 'press_button': case 'set_value': detail = text(args.label); break
    case 'select_menu_item': detail = [args.menu, args.submenu, args.item].filter(Boolean).join(' › '); break
    case 'run_script': detail = text(args.language); break
    case 'filesystem': detail = `${String(args.mode ?? '')} ${text(args.path, 60) ?? ''}`.trim(); break
    case 'process_kill': detail = `${String(args.mode ?? '')} ${text(args.name) ?? (args.pid !== undefined ? `pid ${String(args.pid)}` : '')}`.trim(); break
    case 'registry': detail = `${String(args.mode ?? '')} ${text(args.path, 60) ?? ''}`.trim(); break
    case 'open_application': case 'activate_app': case 'hide_app': case 'unhide_app': detail = text(args.bundle_id); break
    case 'activate_window': detail = args.window_id !== undefined ? `window ${String(args.window_id)}` : undefined; break
    case 'mouse_drag': case 'left_click_drag': detail = 'drag'; break
    case 'screenshot': detail = args.full_screen === true ? 'full screen' : undefined; break
    default: detail = undefined
  }
  return { tool, label: detail ? `${tool} ${detail}` : tool, ...(resolved.app ? { app: resolved.app } : {}), ...(resolved.window ? { window: resolved.window } : {}) }
}

// ── Presenters ────────────────────────────────────────────────────────────────

function libexecPath(name: string): string {
  return join(fileURLToPath(import.meta.url), '..', '..', '..', 'libexec', name)
}

/** The macOS card: a Swift NSPanel compiled on first use into the helper cache, like the capture helper. */
export class MacosCardPresenter implements CardPresenter {
  readonly kind = 'macos'
  #child: ChildProcess | undefined
  constructor(private readonly options: { sourcePath?: string; cacheDir?: string } = {}) {}
  async start(directory: string): Promise<void> {
    const built = await compileSwiftHelper({
      sourcePath: this.options.sourcePath ?? libexecPath('macos-status-card.swift'),
      cacheDir: this.options.cacheDir ?? defaultHelperCacheDir(),
      name: 'macos-status-card',
    })
    if (!built.ok) throw new Error(`${built.reason}. ${built.remediation}`)
    const child = spawn(built.path, [directory], { stdio: 'ignore' })
    child.on('error', () => { /* the card is optional */ })
    child.unref()
    this.#child = child
  }
  stop(): void { try { this.#child?.kill() } catch { /* already gone */ } }
}

/** The Windows card: PowerShell and WPF (the lineage is PR #40), with the server's pid watched and capture excluded. */
export class WindowsCardPresenter implements CardPresenter {
  readonly kind = 'windows'
  #child: ChildProcess | undefined
  constructor(private readonly options: { scriptPath?: string } = {}) {}
  start(directory: string): void {
    const script = this.options.scriptPath ?? libexecPath('windows-status-card.ps1')
    const child = spawn('powershell.exe',
      ['-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, directory],
      { windowsHide: true, stdio: 'ignore' })
    child.on('error', () => { /* the card is optional */ })
    child.unref()
    this.#child = child
  }
  stop(): void { try { this.#child?.kill() } catch { /* already gone */ } }
}

/** How long the Linux card has to put up its window and report where it is. */
const LINUX_CARD_START_MS = 5000

/**
 * The Linux card: GTK 3 through python3-gi, on X11 or GNOME Wayland through XWayland (`GDK_BACKEND=x11`). It is a
 * DOCK window that reserves a strip on the right of the desktop (`_NET_WM_STRUT_PARTIAL`), so maximized windows make
 * room for it instead of the card floating on top. It shows in captures, so it reports its rectangle in `card.json`
 * and the session masks it; `NO_AT_BRIDGE=1` keeps its buttons off the accessibility bus.
 */
export class LinuxCardPresenter implements CardPresenter {
  readonly kind = 'linux'
  readonly visibleInCaptures = true
  #child: ChildProcess | undefined
  constructor(private readonly options: { scriptPath?: string; python?: string; env?: NodeJS.ProcessEnv; startMs?: number } = {}) {}

  async start(directory: string): Promise<void> {
    const env: NodeJS.ProcessEnv = { ...(this.options.env ?? process.env), GDK_BACKEND: 'x11', NO_AT_BRIDGE: '1' }
    if (!env.DISPLAY) {
      throw new Error('No X display (DISPLAY is unset). The Linux card needs X11, or XWayland on a Wayland desktop.')
    }
    const python = this.options.python ?? 'python3'
    const script = this.options.scriptPath ?? libexecPath('linux-status-card.py')
    const child = spawn(python, [script, directory], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    this.#child = child
    let stderr = ''
    child.stderr?.on('data', chunk => { if (stderr.length < 2000) stderr += String(chunk) })
    // Up when it has written card.json; a missing python3-gi or display ends it first, with the reason on stderr.
    const limit = this.options.startMs ?? LINUX_CARD_START_MS
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + limit
      const finish = (error?: Error) => {
        clearInterval(timer)
        child.off('exit', onExit)
        child.off('error', onError)
        if (error) reject(error)
        else resolve()
      }
      const onExit = (code: number | null) => finish(new Error(linuxCardFailure(code, stderr)))
      const onError = (error: Error) => finish(new Error(`${python} could not be started: ${error.message}. Install python3 and python3-gi (gir1.2-gtk-3.0).`))
      const timer = setInterval(() => {
        if (existsSync(join(directory, 'card.json'))) finish()
        else if (Date.now() > deadline) { try { child.kill() } catch { /* already gone */ } finish(new Error(`The card did not come up within ${limit / 1000} s.${stderr ? ` ${stderr.trim()}` : ''}`)) }
      }, 50)
      child.once('exit', onExit)
      child.once('error', onError)
    })
    child.on('error', () => { /* the card is optional */ })
    child.stderr?.removeAllListeners('data')
    child.stderr?.resume()
    ;(child.stderr as { unref?: () => void } | null)?.unref?.()
    child.unref()
  }

  stop(): void { try { this.#child?.kill() } catch { /* already gone */ } }
}

/** Why the Linux card exited before it came up, with the package that fixes it. */
export function linuxCardFailure(code: number | null, stderr: string): string {
  const detail = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ')
  if (/No module named 'gi'|Namespace Gtk not available|ValueError: Namespace/.test(stderr)) {
    return `python3-gi with GTK 3 is missing (${detail}). Install python3-gi and gir1.2-gtk-3.0.`
  }
  return `The card exited with code ${code ?? 'null'} before it came up${detail ? `: ${detail}` : ''}.`
}

export function defaultCardPresenter(platform: NodeJS.Platform = process.platform): CardPresenter | undefined {
  if (platform === 'darwin') return new MacosCardPresenter()
  if (platform === 'win32') return new WindowsCardPresenter()
  if (platform === 'linux') return new LinuxCardPresenter()
  return undefined
}

/**
 * Whether the desktop status card shows. 7.7.0 (K5): on by default on macOS, where it has run since 7.6.1;
 * `COMPUTER_USE_STATUS_CARD=false` turns it off. Windows stays opt-in (`true`) until the card has been run on more
 * hardware. Linux is opt-in too: its card takes a strip of the desktop from the person's windows and shows in
 * captures (masked), and it has run on GNOME and one X11 window manager so far.
 */
export function statusCardEnabled(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const raw = env.COMPUTER_USE_STATUS_CARD?.trim().toLowerCase()
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return platform === 'darwin'
}

/** The emergency-stop chord armed by default (7.7.0, K5): two modifiers and Escape, shown on the card. */
export const DEFAULT_EMERGENCY_CHORD = 'ctrl+alt+escape'

/** The chord to arm: `COMPUTER_USE_EMERGENCY_CHORD` (`off` disables), else the default on macOS and Windows. */
export function emergencyChord(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const raw = env.COMPUTER_USE_EMERGENCY_CHORD?.trim()
  if (raw && /^(off|false|0|none)$/i.test(raw)) return null
  if (raw) return raw
  return platform === 'darwin' || platform === 'win32' ? DEFAULT_EMERGENCY_CHORD : null
}

/** `COMPUTER_USE_TAKEOVER=false` turns the takeover watch off (7.7.0: on by default). */
export function takeoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(false|0|off)$/i.test(env.COMPUTER_USE_TAKEOVER?.trim() ?? '')
}
