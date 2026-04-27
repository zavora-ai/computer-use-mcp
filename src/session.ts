/**
 * Session — resilient computer use session with in-process focus management.
 *
 * v4: Window-aware targeting with TargetState, focus strategies, and structured diagnostics.
 * Every mutating action: (1) resolve target, (2) ensure focus per strategy, (3) act, (4) update state.
 * Observation tools never mutate TargetState.
 * All runs in-process via NAPI — no child processes, no focus stealing.
 */

import { loadNative, type NativeModule } from './native.js'
import { execFile, execFileSync } from 'child_process'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ── Scripting bridge ──────────────────────────────────────────────────────────

export interface SpawnResult {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
}

export type SpawnBounded = (
  cmd: string,
  args: string[],
  timeoutMs: number,
) => Promise<SpawnResult>

/** Spawn a process with a hard timeout. Kills the child on overrun. */
const defaultSpawnBounded: SpawnBounded = (cmd, args, timeoutMs) =>
  new Promise<SpawnResult>(resolve => {
    const child = execFile(cmd, args, { timeout: 0, maxBuffer: 8 * 1024 * 1024 })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk.toString() })
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    let timedOut = false
    const killer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, Math.max(timeoutMs, 100))
    child.on('error', err => {
      clearTimeout(killer)
      resolve({ stdout, stderr: stderr || String(err), code: -1, timedOut })
    })
    child.on('close', code => {
      clearTimeout(killer)
      resolve({ stdout, stderr, code: code ?? -1, timedOut })
    })
  })

// ── Scripting dictionary parser ───────────────────────────────────────────────

export interface ScriptingDictionaryCommand {
  name: string
  description?: string
}

export interface ScriptingDictionaryClass {
  name: string
  properties?: string[]
}

export interface ScriptingDictionarySuite {
  name: string
  commands: ScriptingDictionaryCommand[]
  classes: ScriptingDictionaryClass[]
}

export interface ScriptingDictionary {
  bundleId: string
  suites: ScriptingDictionarySuite[]
}

/** Minimal `.sdef` parser — extracts suite/command/class names from the XML. */
function parseSdef(xml: string, bundleId: string): ScriptingDictionary {
  const suites: ScriptingDictionarySuite[] = []
  const suiteRe = /<suite\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/suite>/g
  let m: RegExpExecArray | null
  while ((m = suiteRe.exec(xml)) !== null) {
    const suiteName = m[1]
    const body = m[2]
    const commands: ScriptingDictionaryCommand[] = []
    const cmdRe = /<command\b[^>]*\bname="([^"]+)"[^>]*(?:\/>|>([\s\S]*?)<\/command>)/g
    let cm: RegExpExecArray | null
    while ((cm = cmdRe.exec(body)) !== null) {
      const desc = cm[0].match(/\bdescription="([^"]*)"/)?.[1]
      commands.push(desc ? { name: cm[1], description: desc } : { name: cm[1] })
    }
    const classes: ScriptingDictionaryClass[] = []
    const classRe = /<class\b[^>]*\bname="([^"]+)"[^>]*(?:\/>|>([\s\S]*?)<\/class>)/g
    let classMatch: RegExpExecArray | null
    while ((classMatch = classRe.exec(body)) !== null) {
      const clsName = classMatch[1]
      const clsBody = classMatch[2] ?? ''
      const propNames: string[] = []
      const propRe = /<property\b[^>]*\bname="([^"]+)"/g
      let pm: RegExpExecArray | null
      while ((pm = propRe.exec(clsBody)) !== null) {
        propNames.push(pm[1])
      }
      classes.push(propNames.length ? { name: clsName, properties: propNames } : { name: clsName })
    }
    suites.push({ name: suiteName, commands, classes })
  }
  return { bundleId, suites }
}

// ── Provider-aware screenshot defaults ────────────────────────────────────────

const PROVIDER_WIDTH: Record<string, number> = {
  anthropic:     1024,
  openai:        1024,
  'openai-low':   512,
  gemini:         768,
  llama:         1120,
  grok:          1024,
  mistral:       1024,
  qwen:           896,
  nova:          1024,
  'deepseek-vl':  896,
  phi:            896,
  auto:          1024,
}

const PROVIDER_QUALITY: Record<string, number> = {
  anthropic: 80,
  openai:    80,
  gemini:    75,
  default:   80,
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Session {
  dispatch(tool: string, args: Record<string, unknown>): Promise<ToolResult>
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}

export interface TargetState {
  bundleId?: string
  windowId?: number
  establishedBy: 'activation' | 'pointer' | 'keyboard'
  establishedAt: number
}

/**
 * Focus-acquisition strategy for a mutating tool.
 *
 * - `strict`: fail with a structured FocusFailure if the target cannot be
 *   confirmed frontmost after activation attempts. Default for text-writing
 *   tools (type/key/hold_key/set_value/fill_form) where a wrong-target send
 *   is more damaging than a failed call.
 * - `best_effort`: attempt activation and proceed regardless. Default for
 *   pointer tools.
 * - `none`: skip all activation. Send input to whatever is currently
 *   frontmost. Use only when you genuinely don't care.
 * - `prepare_display`: v5.2 — before activation, hide every non-target
 *   regular app (except the terminal + the caller's keep-visible set).
 *   Blocks focus-stealing background apps (screenshot watchers, NC
 *   banners). After a prepare_display call, the response payload carries
 *   `hiddenBundleIds` so the caller can later restore the layout.
 */
export type FocusStrategy = 'strict' | 'best_effort' | 'none' | 'prepare_display'

interface FocusFailure {
  error: 'focus_failed'
  requestedBundleId: string
  requestedWindowId: number | null
  frontmostBefore: string | null
  frontmostAfter: string | null
  targetRunning: boolean
  targetHidden: boolean
  targetWindowVisible: boolean | null
  activationAttempted: boolean
  suggestedRecovery: 'activate_window' | 'unhide_app' | 'open_application'
}

export interface SessionOptions {
  /** Disable image output for text-only models (DeepSeek-V3, R1, etc.) */
  vision?: boolean
  /** Default provider — sets optimal width/quality when not specified per-call */
  provider?: string
  /** Override native module for tests */
  native?: NativeModule
  /** Override subprocess spawner for tests (used by run_script, get_app_dictionary). */
  spawnBounded?: SpawnBounded
  /** Override session-lock path (tests use a tmpdir-local path so they don't collide with real sessions). */
  lockPath?: string
  /**
   * Disable cross-process session lock. Used in tests that drive multiple
   * Session objects within a single process where the OS-level lock would
   * self-deadlock. Default: false (lock enabled).
   */
  disableSessionLock?: boolean
}

// ── v5: Tool guide static table ───────────────────────────────────────────────

export type AutomationApproach = 'scripting' | 'accessibility' | 'keyboard' | 'coordinate'

export interface ToolGuideEntry {
  approach: AutomationApproach
  toolSequence: string[]
  explanation: string
  bundleIdHints?: string[]
}

interface ToolGuidePattern extends ToolGuideEntry {
  pattern: RegExp
}

const TOOL_GUIDE_TABLE: ToolGuidePattern[] = [
  // ── Windows-specific entries (checked first on Windows) ─────────────────
  ...(process.platform === 'win32' ? [
    {
      pattern: /\b(file|folder|directory|rename|move|copy)\b.*\b(file|folder|directory|desktop)\b|\b(desktop)\b.*\b(file|folder|save|copy)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['filesystem', 'run_script'],
      explanation:
        'Use the filesystem tool for file operations, or PowerShell via run_script for complex tasks. Faster than GUI clicks.',
    },
    {
      pattern: /\b(registry|regedit|hkey|hkcu|hklm)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['registry'],
      explanation:
        'Use the registry tool for Windows Registry operations. Accepts PowerShell-format paths.',
    },
    {
      pattern: /\b(send|compose|reply|new|write).*(email|mail|message)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Use PowerShell via run_script to automate email. For Outlook: `$ol = New-Object -ComObject Outlook.Application; $mail = $ol.CreateItem(0)`.',
    },
    {
      pattern: /\b(open|visit|navigate).*(url|website|https?:|web\s*page|tab)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Use PowerShell: `Start-Process "https://example.com"` to open URLs in the default browser.',
    },
    {
      pattern: /\b(powershell|cmd|terminal|command|shell|script)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Use run_script with language "powershell" for system automation, CLI tools, and scripting.',
    },
    {
      pattern: /\b(process|task|kill|terminate|stop)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['process_kill'],
      explanation:
        'Use process_kill to list or terminate processes by name or PID.',
    },
    {
      pattern: /\b(notify|notification|alert|toast)\b/i,
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['notification'],
      explanation:
        'Use the notification tool to send Windows toast notifications.',
    },
  ] as ToolGuidePattern[] : []),
  // ── macOS-specific entries ──────────────────────────────────────────────
  ...(process.platform === 'darwin' ? [
    {
      pattern: /\b(send|compose|reply|new|write).*(email|mail|message)\b/i,
      bundleIdHints: ['com.apple.mail'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['get_app_capabilities', 'run_script'],
      explanation:
        'Mail is scriptable. Use AppleScript `make new outgoing message` or `send` — one call replaces the whole compose flow.',
    },
    {
      pattern: /\b(open|visit|navigate).*(url|website|https?:|web\s*page|tab)\b/i,
      bundleIdHints: ['com.apple.Safari', 'com.google.Chrome'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Safari and Chrome are scriptable. `tell application "Safari" to open location "<url>"` beats screenshot-and-click.',
    },
    {
      pattern: /\b(spreadsheet|cell|row|column|numbers|sheet)\b/i,
      bundleIdHints: ['com.apple.iWork.Numbers', 'com.microsoft.Excel'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['get_app_dictionary', 'run_script'],
      explanation:
        'Numbers is deeply scriptable — read/write cells via AppleScript. Fall back to fill_form if scripting is unavailable.',
    },
    {
      pattern: /\b(file|folder|directory|finder|rename|move|copy|desktop)\b/i,
      bundleIdHints: ['com.apple.finder'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Finder is scriptable (and shell is often even better). Prefer `osascript` or direct filesystem calls over GUI clicks.',
    },
    {
      pattern: /\b(calendar|event|reminder|note|todo|task)\b/i,
      bundleIdHints: ['com.apple.iCal', 'com.apple.reminders', 'com.apple.Notes'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['get_app_capabilities', 'run_script'],
      explanation:
        'Calendar, Reminders, and Notes are all scriptable. One `make new <event/reminder/note>` call does the work.',
    },
    {
      pattern: /\b(play|pause|track|playlist|song|music)\b/i,
      bundleIdHints: ['com.apple.Music'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Music.app is scriptable: `tell application "Music" to play` / `pause` / `next track`.',
    },
    {
      pattern: /\b(imessage|send\s+message|chat|sms)\b/i,
      bundleIdHints: ['com.apple.iChat'],
      approach: 'scripting' as AutomationApproach,
      toolSequence: ['run_script'],
      explanation:
        'Messages is scriptable. Use AppleScript to send messages to a buddy without UI.',
    },
  ] as ToolGuidePattern[] : []),
  // ── Cross-platform entries ─────────────────────────────────────────────
  {
    pattern: /\b(fill|enter|type)\b.*\b(form|field|input)\b/i,
    approach: 'accessibility',
    toolSequence: ['get_ui_tree', 'fill_form'],
    explanation:
      'Batch-set form fields by accessibility label — one fill_form call instead of click+type per field.',
  },
  {
    pattern: /\b(menu|menubar|file\s*(menu)?|edit\s*menu)\b/i,
    approach: 'accessibility',
    toolSequence: ['select_menu_item'],
    explanation:
      'Use select_menu_item — walks the menu bar programmatically, faster and more reliable than visual navigation.',
  },
  {
    pattern: /\b(click|press|tap)\b.*\b(button|link)\b/i,
    approach: 'accessibility',
    toolSequence: ['find_element', 'press_button'],
    explanation:
      'press_button finds buttons by label — avoids pixel-coordinate drift across window moves and resolution changes.',
  },
  {
    pattern: /\b(read|inspect|verify|check|examine|zoom|detail|small\s*text|tiny|pixel|magnif|enlarge|close.?up)\b/i,
    approach: 'coordinate' as AutomationApproach,
    toolSequence: ['zoom'],
    explanation:
      'Use the zoom tool to inspect a specific screen region at full native resolution. Pass region: [x1, y1, x2, y2] to crop without downscaling. Best for reading small text, verifying values, or checking pixel-level details. Default output is lossless PNG. Tip: take a screenshot first to identify the region coordinates, then zoom into the area of interest.',
  },
  {
    pattern: /\b(text|value|number|label|title|heading|content|status|what\s*does\s*it\s*say|read\s*the|what\s*is\s*written|what\s*does.*say)\b/i,
    approach: 'accessibility' as AutomationApproach,
    toolSequence: ['get_ui_tree', 'zoom'],
    explanation:
      'To read text on screen: first try get_ui_tree which returns element labels and values as structured data (fastest, no image needed). If the text is in an image or non-accessible element, use zoom with a tight region around the text for a full-resolution lossless PNG crop.',
  },
  {
    pattern: /\b(screenshot|see|show|look|observe|capture|screen)\b/i,
    approach: 'accessibility' as AutomationApproach,
    toolSequence: ['screenshot', 'zoom'],
    explanation:
      'Use screenshot for a full-screen overview (resized for efficiency). If you need to read specific text or inspect details, follow up with zoom on the region of interest — it returns full native resolution without downscaling. For structured UI data without an image, use get_ui_tree instead.',
  },
  {
    pattern: /.*/,
    approach: 'accessibility',
    toolSequence: ['get_app_capabilities', 'get_ui_tree', 'find_element', 'click_element'],
    explanation:
      'No specific pattern matched. Probe capabilities, then prefer accessibility — fall back to coordinate input only as a last resort.',
  },
]

function lookupToolGuide(taskDescription: string): ToolGuideEntry {
  for (const entry of TOOL_GUIDE_TABLE) {
    if (entry.pattern.test(taskDescription)) {
      return {
        approach: entry.approach,
        toolSequence: entry.toolSequence,
        explanation: entry.explanation,
        ...(entry.bundleIdHints ? { bundleIdHints: entry.bundleIdHints } : {}),
      }
    }
  }
  // Unreachable — the final `.*` entry matches everything.
  return {
    approach: 'accessibility',
    toolSequence: ['get_ui_tree'],
    explanation: 'Default fallback.',
  }
}

// ── Errors ────────────────────────────────────────────────────────────────────

class FocusError extends Error {
  constructor(readonly details: FocusFailure) {
    super(`Failed to focus ${details.requestedBundleId}`)
    this.name = 'FocusError'
  }
}

class WindowNotFoundError extends Error {
  constructor(readonly windowId: number) {
    super(`Window not found: ${windowId}`)
    this.name = 'WindowNotFoundError'
  }
}

// ── v5.2: Session lock + runloop pump ─────────────────────────────────────────
//
// One computer-use session per Mac. Prevents two MCP processes from fighting
// over the cursor. While the lock is held, we run a 1 ms CFRunLoop pump so
// NSWorkspace KVO updates and @MainActor continuations make progress under
// libuv — matches Claude Code's `drainRunLoop.ts` pattern.
//
// Both lock and pump are refcounted within a single process so nested
// mutating calls (e.g. fill_form → set_value) don't tear down and rebuild.

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const IS_WINDOWS = process.platform === 'win32'
const IS_MACOS = process.platform === 'darwin'

const DEFAULT_LOCK_PATH = IS_WINDOWS
  ? path.join(os.tmpdir(), '.computer-use-mcp.lock')
  : '/tmp/.computer-use-mcp.lock'

export class LockError extends Error {
  readonly lockingPid: number | null
  constructor(lockingPid: number | null) {
    super(lockingPid != null
      ? `computer-use session locked by PID ${lockingPid}`
      : 'computer-use session locked')
    this.name = 'LockError'
    this.lockingPid = lockingPid
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    // Signal 0 is the probe signal — succeeds iff the process exists and we
    // have permission to signal it. Throws ESRCH when the process is gone.
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    // EPERM means the process exists but we can't signal — treat as alive.
    return err?.code === 'EPERM'
  }
}

interface LockHandle {
  release: () => void
}

/**
 * Tries to acquire the cross-process session lock.
 *
 * Returns a handle on success. Throws `LockError` when the lock is held by
 * another live process. Reclaims the lock when the holding PID is dead.
 */
function acquireLockOnce(lockPath: string): LockHandle {
  try {
    const fd = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      0o600,
    )
    fs.writeSync(fd, String(process.pid))
    return {
      release: () => {
        try { fs.closeSync(fd) } catch { /* already closed */ }
        try { fs.unlinkSync(lockPath) } catch { /* already removed */ }
      },
    }
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err
    // Lock exists — inspect the holder.
    let holder: number | null = null
    try {
      const raw = fs.readFileSync(lockPath, 'utf8').trim()
      const parsed = parseInt(raw, 10)
      if (Number.isFinite(parsed) && parsed > 0) holder = parsed
    } catch { /* file vanished between openSync and readFileSync — retry */ }

    if (holder == null) {
      // Unreadable / empty lock: treat as dead.
      try { fs.unlinkSync(lockPath) } catch { /* race — someone else cleaned up */ }
      return acquireLockOnce(lockPath)
    }

    if (holder === process.pid) {
      // Our own process holds the lock but we dropped the FD ref —
      // reclaim by unlinking + re-creating.
      try { fs.unlinkSync(lockPath) } catch { /* ok */ }
      return acquireLockOnce(lockPath)
    }

    if (!pidIsAlive(holder)) {
      try { fs.unlinkSync(lockPath) } catch { /* race — ok */ }
      return acquireLockOnce(lockPath)
    }

    throw new LockError(holder)
  }
}

/**
 * Per-session refcounted lock + pump. A single instance lives inside one
 * `createSession` closure — cross-process contention still goes through the
 * filesystem lock, but nested calls within this session are cheap.
 */
interface LockPumpController {
  acquire: () => void        // throws LockError on contention
  release: () => void
  /** For tests — current refcount. */
  readonly _refcount: number
}

function makeLockPumpController(
  n: NativeModule,
  lockPath: string,
  disableLock: boolean,
): LockPumpController {
  let refcount = 0
  let handle: LockHandle | null = null
  let pumpInterval: NodeJS.Timeout | null = null

  function startPump() {
    if (IS_WINDOWS) return  // No CFRunLoop on Windows
    if (pumpInterval != null) return
    pumpInterval = setInterval(() => {
      try { n.drainRunloop() } catch { /* never let the pump throw */ }
    }, 1)
    // Don't keep Node alive just for the pump.
    pumpInterval.unref?.()
  }

  function stopPump() {
    if (pumpInterval == null) return
    clearInterval(pumpInterval)
    pumpInterval = null
  }

  return {
    acquire() {
      if (refcount === 0 && !disableLock) {
        handle = acquireLockOnce(lockPath)
      }
      refcount++
      if (refcount === 1) startPump()
    },
    release() {
      if (refcount === 0) return
      refcount--
      if (refcount === 0) {
        stopPump()
        if (handle) {
          const h = handle
          handle = null
          h.release()
        }
      }
    },
    get _refcount() { return refcount },
  }
}

// ── Tools that mutate system state (take the session lock + pump) ─────────────
//
// Observation tools (screenshot, list_*, get_*) do not take the lock — they
// must be callable concurrently (e.g. screenshots during a session held by
// another process for diagnostics).
const MUTATING_TOOLS = new Set([
  // Pointer + keyboard CGEvent
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll',
  'type', 'key', 'hold_key', 'write_clipboard',
  // App / window activation
  'activate_app', 'activate_window', 'open_application', 'hide_app', 'unhide_app',
  // Semantic AX mutations
  'click_element', 'set_value', 'press_button', 'select_menu_item', 'fill_form',
  // Scripting bridge (can mutate via AppleScript — treat conservatively)
  'run_script',
])

// ── Session factory ───────────────────────────────────────────────────────────

export function createSession(opts: SessionOptions = {}): Session {
  const n = opts.native ?? loadNative()
  const spawnBounded: SpawnBounded = opts.spawnBounded ?? defaultSpawnBounded
  let targetState: TargetState | undefined
  const visionEnabled = opts.vision !== false

  // v5.2: cross-process lock + main-runloop pump. Mutating tool dispatch
  // acquires before running and releases in `finally`; observation tools
  // skip both to stay cheap and concurrent.
  //
  // Default: when a caller injects a mock native (opts.native set), we infer
  // this is a test harness and disable the cross-process lock by default.
  // Tests that *want* to exercise the lock can pass `disableSessionLock: false`
  // explicitly. Production (no opts.native → real NAPI module) defaults to
  // enabled. Callers can always override explicitly.
  const lockDisabledByDefault = opts.native != null
  const lockPump = makeLockPumpController(
    n,
    opts.lockPath ?? DEFAULT_LOCK_PATH,
    opts.disableSessionLock ?? lockDisabledByDefault,
  )

  // Best-effort cleanup if Node exits while a lock is held (SIGINT, SIGTERM,
  // uncaughtException). We force-release to drop the lockfile; a new session
  // started afterwards will see EEXIST and fall into the stale-PID recovery
  // path anyway, so this is belt + suspenders.
  //
  // Skipped when the cross-process lock is disabled (tests, in-process
  // multiple-sessions). Property-based tests create many sessions, which
  // would otherwise blow past the default MaxListeners on `process`.
  if (!(opts.disableSessionLock ?? lockDisabledByDefault)) {
    const forceRelease = () => {
      try { while (lockPump._refcount > 0) lockPump.release() } catch { /* ignore */ }
    }
    process.once('exit', forceRelease)
    process.once('SIGINT', () => { forceRelease(); process.exit(130) })
    process.once('SIGTERM', () => { forceRelease(); process.exit(143) })
  }
  const defaultProvider = opts.provider ?? process.env.COMPUTER_USE_PROVIDER ?? 'auto'

  // Screenshot dedup cache — keyed on the last encoded image hash.
  let _lastHash: string | undefined
  let _lastResult: ToolResult | undefined

  // Scripting dictionary cache — keyed by bundleId, invalidated on PID change.
  const dictionaryCache = new Map<string, { pid: number; dict: ScriptingDictionary }>()
  // Cached space_id from the most recent successful create_agent_space.
  let cachedAgentSpaceId: number | undefined

  // ── Target resolution ───────────────────────────────────────────────────

  function resolveTarget(args: Record<string, unknown>): { bundleId?: string; windowId?: number } {
    // 1. Explicit window_id (v5 semantic tools) or target_window_id (v4 input tools).
    const wid = typeof args.window_id === 'number' ? args.window_id
              : typeof args.target_window_id === 'number' ? args.target_window_id
              : undefined
    if (wid !== undefined) {
      const win = n.getWindow(wid)
      if (!win) throw new WindowNotFoundError(wid)
      return { bundleId: win.bundleId ?? undefined, windowId: win.windowId }
    }
    // 2. Explicit target_app
    if (typeof args.target_app === 'string' && args.target_app.length > 0) {
      return { bundleId: args.target_app }
    }
    // 3. Current TargetState
    return { bundleId: targetState?.bundleId, windowId: targetState?.windowId }
  }

  // ── Focus strategy ──────────────────────────────────────────────────────

  function defaultStrategy(tool: string): FocusStrategy {
    // Writes default to strict (corrupt-text risk); clicks default to best_effort.
    const strictTools = ['type', 'key', 'hold_key', 'set_value', 'fill_form']
    if (strictTools.includes(tool)) return 'strict'
    return 'best_effort'
  }

  function getStrategy(tool: string, args: Record<string, unknown>): FocusStrategy {
    if (typeof args.focus_strategy === 'string') {
      const s = args.focus_strategy as string
      if (s === 'strict' || s === 'best_effort' || s === 'none' || s === 'prepare_display') return s
    }
    return defaultStrategy(tool)
  }

  function buildFocusFailure(
    requestedBundleId: string,
    requestedWindowId: number | null,
    frontmostBefore: string | null,
    frontmostAfter: string | null,
    activationAttempted: boolean,
  ): FocusFailure {
    const runningApp = n.listRunningApps().find(entry => entry.bundleId === requestedBundleId)
    let targetWindowVisible: boolean | null = null
    if (requestedWindowId != null) {
      const win = n.getWindow(requestedWindowId)
      targetWindowVisible = win?.isOnScreen ?? false
    }

    let suggestedRecovery: FocusFailure['suggestedRecovery']
    if (requestedWindowId != null && targetWindowVisible) {
      suggestedRecovery = 'activate_window'
    } else if (runningApp?.isHidden) {
      suggestedRecovery = 'unhide_app'
    } else {
      suggestedRecovery = 'open_application'
    }

    return {
      error: 'focus_failed',
      requestedBundleId,
      requestedWindowId,
      frontmostBefore,
      frontmostAfter,
      targetRunning: Boolean(runningApp),
      targetHidden: runningApp?.isHidden ?? false,
      targetWindowVisible,
      activationAttempted,
      suggestedRecovery,
    }
  }

  /**
   * Resolve the terminal host's bundle ID so prepare_display doesn't hide it.
   *
   * Order: `COMPUTER_USE_PREPARE_KEEP_VISIBLE` env (comma-separated, user
   * override) → `__CFBundleIdentifier` (set by the OS when launching a macOS
   * app) → `TERM_PROGRAM_BUNDLE_ID` → fallback `com.apple.Terminal`.
   */
  function resolveKeepVisibleBundles(): string[] {
    const envList = process.env.COMPUTER_USE_PREPARE_KEEP_VISIBLE
    if (envList) {
      return envList.split(',').map(s => s.trim()).filter(Boolean)
    }
    if (IS_WINDOWS) {
      // On Windows, keep the terminal/IDE process visible
      return ['explorer.exe']
    }
    const terminal = process.env.__CFBundleIdentifier
                  || process.env.TERM_PROGRAM_BUNDLE_ID
                  || 'com.apple.Terminal'
    return [terminal]
  }

  // v5.2: per-dispatch slot capturing the list of bundles `prepare_display`
  // hid. Set inside `ensureFocusV4`, consumed by the outer dispatch wrapper
  // to decorate the response JSON. Reset to undefined at dispatch entry.
  let pendingHiddenBundleIds: string[] | undefined

  async function ensureFocusV4(
    target: { bundleId?: string; windowId?: number },
    strategy: FocusStrategy,
  ): Promise<{ hiddenBundleIds?: string[] }> {
    if (strategy === 'none') return {}
    if (!target.bundleId) return {}

    // v5.2: prepare_display hides everything else before we even try to
    // activate. This is the hammer for focus-stealing apps (screenshot
    // watchers, NC banners). After this, activation is basically
    // deterministic because nothing else visible can steal focus.
    let hiddenBundleIds: string[] | undefined
    if (strategy === 'prepare_display') {
      const keep = resolveKeepVisibleBundles()
      const result = n.prepareDisplay(target.bundleId, keep)
      hiddenBundleIds = result.hiddenBundleIds
      pendingHiddenBundleIds = hiddenBundleIds
      await sleep(50)  // let the OS process the batched hide calls
      // Fall through to the normal activate+poll loop — after prepareDisplay,
      // the target should activate essentially instantly.
    }

    const front = n.getFrontmostApp()
    const frontBundleId = front?.bundleId ?? null

    if (front?.bundleId === target.bundleId) {
      // App is frontmost — check window if strict + windowId
      if (strategy === 'strict' && target.windowId != null) {
        const win = n.getWindow(target.windowId)
        if (!win?.isOnScreen) {
          throw new FocusError(buildFocusFailure(
            target.bundleId,
            target.windowId,
            frontBundleId,
            frontBundleId,
            false,
          ))
        }
      }
      return { hiddenBundleIds }
    }

    // App not frontmost — attempt recovery
    const runningApp = n.listRunningApps().find(a => a.bundleId === target.bundleId)

    if (runningApp?.isHidden) {
      n.unhideApp(target.bundleId)
      await sleep(100)
    }

    n.activateApp(target.bundleId, 2000)
    await sleep(80)

    // Raise specific window if requested
    if (target.windowId != null) {
      try { n.activateWindow(target.windowId) } catch { /* best effort */ }
      await sleep(80)
    }

    const after = n.getFrontmostApp()
    if (strategy === 'strict' && after?.bundleId !== target.bundleId) {
      throw new FocusError(buildFocusFailure(
        target.bundleId,
        target.windowId ?? null,
        frontBundleId,
        after?.bundleId ?? null,
        true,
      ))
    }
    return { hiddenBundleIds }
  }

  function focusFailureText(details: FocusFailure): string {
    return JSON.stringify(details)
  }

  // ── State update helpers ────────────────────────────────────────────────

  function updateTargetState(
    target: { bundleId?: string; windowId?: number },
    establishedBy: TargetState['establishedBy'],
  ): void {
    targetState = {
      bundleId: target.bundleId,
      windowId: target.windowId,
      establishedBy,
      establishedAt: Date.now(),
    }
  }

  function trackClickTarget(target: { bundleId?: string; windowId?: number }): void {
    if (target.bundleId) {
      updateTargetState(target, 'pointer')
    } else {
      const front = n.getFrontmostApp()
      if (front?.bundleId) {
        updateTargetState({ bundleId: front.bundleId }, 'pointer')
      }
    }
  }

  // ── Tool category helpers ───────────────────────────────────────────────

  function establishedByForTool(tool: string): TargetState['establishedBy'] {
    const keyboardTools = ['type', 'key', 'hold_key']
    const activationTools = ['activate_app', 'activate_window', 'open_application']
    if (keyboardTools.includes(tool)) return 'keyboard'
    if (activationTools.includes(tool)) return 'activation'
    return 'pointer'
  }

  // ── v5: Levenshtein distance + similar-labels helper ────────────────────

  function levenshtein(a: string, b: string): number {
    if (a === b) return 0
    if (!a.length) return b.length
    if (!b.length) return a.length
    const an = a.length
    const bn = b.length
    const prev = new Array<number>(bn + 1)
    const curr = new Array<number>(bn + 1)
    for (let j = 0; j <= bn; j++) prev[j] = j
    for (let i = 1; i <= an; i++) {
      curr[0] = i
      for (let j = 1; j <= bn; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        curr[j] = Math.min(
          prev[j] + 1,
          curr[j - 1] + 1,
          prev[j - 1] + cost,
        )
      }
      for (let j = 0; j <= bn; j++) prev[j] = curr[j]
    }
    return prev[bn]
  }

  function similarLabelsError(
    windowId: number,
    label: string,
    message: string,
    roleFilter?: string,
  ): ToolResult {
    const candidates = n.findElement(windowId, roleFilter, undefined, undefined, 200)
    const target = (label ?? '').toLowerCase()
    const ranked = candidates
      .map(e => ({ e, d: levenshtein((e.label ?? '').toLowerCase(), target) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 5)
      .map(x => ({ role: x.e.role, label: x.e.label, value: x.e.value }))
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ error: message, similar: ranked }),
      }],
      isError: true,
    }
  }

  // ── v5: Scripting dictionary lookup + cache ─────────────────────────────

  async function findAppPath(bundleId: string): Promise<string | undefined> {
    if (IS_WINDOWS) return undefined  // mdfind/sdef are macOS-only
    // Try mdfind first (fast, indexed). Fall back to NSWorkspace is unnecessary
    // — we can simply let `sdef` fail if the app is missing.
    const r = await spawnBounded(
      'mdfind',
      [`kMDItemCFBundleIdentifier == '${bundleId}'`],
      5_000,
    )
    if (r.code !== 0) return undefined
    const first = r.stdout.split('\n').map(s => s.trim()).find(s => s.length > 0)
    return first
  }

  async function getAppDictionary(
    bundleId: string,
    suite?: string,
  ): Promise<{ dict: ScriptingDictionary } | { error: string }> {
    const running = n.listRunningApps().find(a => a.bundleId === bundleId)
    const pid = running?.pid
    const cached = dictionaryCache.get(bundleId)
    let dict: ScriptingDictionary | undefined

    if (cached && cached.pid === pid) {
      dict = cached.dict
    } else {
      const path = await findAppPath(bundleId)
      if (!path) return { error: 'app_not_found' }
      const r = await spawnBounded('sdef', [path], 10_000)
      if (r.timedOut) return { error: 'sdef_timeout' }
      if (r.code !== 0) return { error: 'not_scriptable' }
      dict = parseSdef(r.stdout, bundleId)
      if (pid !== undefined) dictionaryCache.set(bundleId, { pid, dict })
    }

    if (suite) {
      const filtered = dict.suites.filter(s => s.name === suite)
      return { dict: { bundleId, suites: filtered } }
    }
    // Summarized mode: names only, no properties/descriptions.
    const summary: ScriptingDictionary = {
      bundleId,
      suites: dict.suites.map(s => ({
        name: s.name,
        commands: s.commands.map(c => ({ name: c.name })),
        classes: s.classes.map(c => ({ name: c.name })),
      })),
    }
    return { dict: summary }
  }

  // Cache which PowerShell executable is available
  let _psExe: string | undefined
  function getPowerShellExe(): string {
    if (_psExe) return _psExe
    try {
      execFileSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { timeout: 3000 })
      _psExe = 'pwsh'
    } catch {
      _psExe = 'powershell'
    }
    return _psExe
  }

  async function runScriptHelper(
    language: string,
    script: string,
    timeoutMs: number,
  ): Promise<SpawnResult> {
    if (IS_WINDOWS) {
      if (language === 'applescript' || language === 'javascript') {
        return {
          stdout: '',
          stderr: `${language} is not supported on Windows. Use language: "powershell" instead.`,
          code: 1,
          timedOut: false,
        }
      }
      const exe = getPowerShellExe()
      // Use -Command for simple scripts (faster, no encoding overhead)
      // Use -EncodedCommand only when script contains quotes or special chars
      const needsEncoding = /['"$`\r\n]/.test(script)
      if (needsEncoding) {
        const buf = Buffer.from(script, 'utf16le')
        const encoded = buf.toString('base64')
        return spawnBounded(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], timeoutMs)
      }
      return spawnBounded(exe, ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs)
    }
    // macOS: osascript
    const args = language === 'javascript'
      ? ['-l', 'JavaScript', '-e', script]
      : ['-e', script]
    return spawnBounded('osascript', args, timeoutMs)
  }

  // ── Coordinate validation ─────────────────────────────────────────────

  function validateCoordinates(x: number, y: number): void {
    const display = n.getDisplaySize()
    if (x < 0 || y < 0 || x >= display.width || y >= display.height) {
      throw new Error(
        `Coordinates (${x}, ${y}) are outside display bounds (${display.width}x${display.height}). ` +
        `Valid range: x=[0, ${display.width - 1}], y=[0, ${display.height - 1}].`
      )
    }
  }

  // ── Click helper ────────────────────────────────────────────────────────

  async function doClick(
    tool: string,
    coord: [number, number],
    button: string,
    count: number,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const target = resolveTarget(args)
    const strategy = getStrategy(tool, args)
    await ensureFocusV4(target, strategy)

    const [x, y] = coord
    validateCoordinates(x, y)
    n.mouseMove(x, y)
    await sleep(50)  // HID round-trip settle before click
    n.mouseClick(x, y, button, count)

    trackClickTarget(target)
    return ok(`Clicked (${x}, ${y})`)
  }

  // ── Dispatch ────────────────────────────────────────────────────────────

  async function dispatch(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const coord = (key = 'coordinate'): [number, number] => {
      const v = args[key]
      if (!Array.isArray(v) || v.length < 2 || typeof v[0] !== 'number' || typeof v[1] !== 'number')
        throw new Error(`Invalid ${key}: expected [number, number]`)
      return [v[0], v[1]]
    }
    const str = (key: string): string => {
      if (typeof args[key] !== 'string') throw new Error(`Invalid ${key}: expected string`)
      return args[key] as string
    }
    const num = (key: string, fallback: number): number => {
      const v = args[key]
      return typeof v === 'number' ? v : fallback
    }

    // v5.2: Only mutating tools take the session lock and start the pump.
    // Observation tools stay concurrent and cheap.
    const mutates = MUTATING_TOOLS.has(tool)
    let acquired = false
    if (mutates) {
      try {
        lockPump.acquire()
        acquired = true
      } catch (err) {
        if (err instanceof LockError) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              error: 'locked_by_pid',
              lockingPid: err.lockingPid,
            }) }],
            isError: true,
          }
        }
        throw err
      }
    }

    // Reset the prepare_display slot at dispatch entry so one tool call's
    // hidden list doesn't leak into the next.
    pendingHiddenBundleIds = undefined

    let result: ToolResult
    try {
      result = await (async (): Promise<ToolResult> => {
      switch (tool) {

        // ── Screenshot (observation — never mutates TargetState) ──────────
        case 'screenshot': {
          const provider = (typeof args.provider === 'string' ? args.provider : defaultProvider)
          const defaultWidth = PROVIDER_WIDTH[provider] ?? 1024
          const defaultQuality = PROVIDER_QUALITY[provider] ?? PROVIDER_QUALITY.default
          const w = typeof args.width === 'number' ? args.width
                  : typeof process.env.COMPUTER_USE_WIDTH !== 'undefined' ? parseInt(process.env.COMPUTER_USE_WIDTH)
                  : defaultWidth
          const q = typeof args.quality === 'number' ? args.quality
                  : typeof process.env.COMPUTER_USE_QUALITY !== 'undefined' ? parseInt(process.env.COMPUTER_USE_QUALITY)
                  : defaultQuality

          // Explicit target_window_id takes precedence over target_app.
          let windowId = typeof args.target_window_id === 'number' ? args.target_window_id : undefined
          let app = windowId ? undefined : (typeof args.target_app === 'string' && args.target_app.length > 0 ? args.target_app : undefined)

          // v5 auto-target: when neither explicit target is set and the session
          // has an established windowId, use it (read-only — does not mutate
          // bundleId/establishedBy). Stale windowIds fall back to full screen
          // after clearing only the windowId field.
          if (windowId === undefined && app === undefined && targetState?.windowId != null) {
            const stateWin = n.getWindow(targetState.windowId)
            if (stateWin?.isOnScreen) {
              windowId = targetState.windowId
            } else if (targetState) {
              targetState = {
                bundleId: targetState.bundleId,
                windowId: undefined,
                establishedBy: targetState.establishedBy,
                establishedAt: targetState.establishedAt,
              }
            }
          }

          if (!visionEnabled) {
            const front = n.getFrontmostApp()
            const display = n.getDisplaySize()
            return ok(`Screen: ${display.width}×${display.height} | Frontmost: ${front?.bundleId ?? 'unknown'} (${front?.displayName ?? ''})`)
          }

          const r = n.takeScreenshot(w, app, q, _lastHash, windowId)
          if (r.unchanged && _lastResult) return _lastResult
          if (!r.base64) throw new Error('Screenshot capture missing image payload')
          _lastHash = r.hash
          _lastResult = {
            content: [
              { type: 'image', data: r.base64, mimeType: r.mimeType },
              { type: 'text', text: `${r.width}x${r.height}` },
            ]
          }
          return _lastResult
        }

        // ── Zoom (crop a region at full resolution) ──────────────────────────
        case 'zoom': {
          const region = args.region
          if (!Array.isArray(region) || region.length !== 4) {
            throw new Error('zoom requires region: [x1, y1, x2, y2]')
          }
          const [x1, y1, x2, y2] = region as [number, number, number, number]
          if (x1 >= x2 || y1 >= y2) {
            throw new Error(`Invalid region: x1(${x1}) must be < x2(${x2}), y1(${y1}) must be < y2(${y2})`)
          }

          // Capture full-res as PNG (lossless, fast)
          const fullRes = n.takeScreenshot(undefined, undefined, 0, undefined, undefined)
          if (!fullRes.base64) throw new Error('Screenshot capture failed')

          const q = typeof args.quality === 'number' ? args.quality : 0

          // Crop the region at full resolution using native Rust
          const cropped = n.cropImage(fullRes.base64, x1, y1, x2, y2, q)
          return {
            content: [
              { type: 'image' as const, data: cropped.base64, mimeType: cropped.mimeType },
              { type: 'text' as const, text: `${cropped.width}x${cropped.height} (zoomed from ${fullRes.width}x${fullRes.height})` },
            ],
          }
        }

        // ── Clicks ───────────────────────────────────────────────────────────
        // NB: we `return await` instead of `return` so the lock/pump in the
        // outer try/finally stay held until doClick actually resolves.
        // `return promise` fires the finally on return, not on resolution.
        case 'left_click':   return await doClick(tool, coord(), 'left', 1, args)
        case 'right_click':  return await doClick(tool, coord(), 'right', 1, args)
        case 'middle_click': return await doClick(tool, coord(), 'middle', 1, args)
        case 'double_click': return await doClick(tool, coord(), 'left', 2, args)
        case 'triple_click': return await doClick(tool, coord(), 'left', 3, args)

        case 'mouse_move': {
          const target = resolveTarget(args)
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)
          const [x, y] = coord()
          validateCoordinates(x, y)
          n.mouseMove(x, y)
          if (target.bundleId) updateTargetState(target, 'pointer')
          return ok(`Moved to (${x}, ${y})`)
        }

        case 'left_click_drag': {
          const target = resolveTarget(args)
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)

          const to = coord()
          const from = args.start_coordinate ? coord('start_coordinate') : undefined
          if (from) { n.mouseMove(from[0], from[1]); await sleep(50) }
          n.mouseButton('press', from?.[0] ?? to[0], from?.[1] ?? to[1])
          await sleep(50)

          // Ease-out-cubic at 60fps, distance-proportional duration, max 500ms
          const sx = from?.[0] ?? to[0], sy = from?.[1] ?? to[1]
          const dist = Math.hypot(to[0] - sx, to[1] - sy)
          const durationMs = Math.min(dist / 2, 500)
          const frames = Math.max(Math.floor(durationMs / 16), 1)
          for (let i = 1; i <= frames; i++) {
            const t = i / frames
            const eased = 1 - Math.pow(1 - t, 3)
            n.mouseDrag(Math.round(sx + (to[0] - sx) * eased), Math.round(sy + (to[1] - sy) * eased))
            if (i < frames) await sleep(16)
          }

          await sleep(50)
          n.mouseButton('release', to[0], to[1])
          trackClickTarget(target)
          return ok(`Dragged to (${to[0]}, ${to[1]})`)
        }

        case 'left_mouse_down': {
          const target = resolveTarget(args)
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)
          const [x, y] = coord()
          n.mouseButton('press', x, y)
          if (target.bundleId) updateTargetState(target, 'pointer')
          return ok('Mouse down')
        }
        case 'left_mouse_up': {
          const target = resolveTarget(args)
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)
          const [x, y] = coord()
          n.mouseButton('release', x, y)
          if (target.bundleId) updateTargetState(target, 'pointer')
          return ok('Mouse up')
        }
        case 'cursor_position': {
          const p = n.cursorPosition()
          return ok(`(${p.x}, ${p.y})`)
        }

        case 'scroll': {
          const target = resolveTarget(args)
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)
          const [x, y] = coord()
          const dir = str('direction')
          const amt = num('amount', 3)
          n.mouseMove(x, y)
          await sleep(15)
          const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0
          const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0
          n.mouseScroll(dy, dx)
          if (target.bundleId) updateTargetState(target, 'pointer')
          return ok(`Scrolled ${dir} ${amt}`)
        }

        // ── Keyboard ─────────────────────────────────────────────────────────
        case 'type': {
          const target = resolveTarget(args)
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)
          const text = str('text')

          // caret_position: move caret before typing
          const caretPos = typeof args.caret_position === 'string' ? args.caret_position : 'idle'
          if (caretPos === 'start') {
            n.keyPress('home')
            await sleep(30)
          } else if (caretPos === 'end') {
            n.keyPress('end')
            await sleep(30)
          }

          // clear: select all + delete before typing
          if (args.clear === true || args.clear === 'true') {
            n.keyPress(IS_WINDOWS ? 'ctrl+a' : 'command+a')
            await sleep(30)
            n.keyPress('delete')
            await sleep(30)
          }

          if (text.length > 100) {
            // Clipboard-based typing: faster and more reliable for long text
            if (IS_WINDOWS && n.readClipboard && n.writeClipboard) {
              let saved: string | undefined
              try { saved = n.readClipboard() } catch { /* ignore */ }
              try {
                n.writeClipboard(text)
                n.keyPress('ctrl+v')
                await sleep(100)
              } finally {
                if (typeof saved === 'string') {
                  try { n.writeClipboard(saved) } catch { /* ignore */ }
                }
              }
            } else {
              let saved: string | undefined
              try { saved = execFileSync('pbpaste', []).toString() } catch { /* ignore */ }
              try {
                execFileSync('pbcopy', [], { input: text })
                const verify = execFileSync('pbpaste', []).toString()
                if (verify === text) {
                  n.keyPress('command+v')
                  await sleep(100)
                } else {
                  n.typeText(text)
                }
              } finally {
                if (typeof saved === 'string') {
                  try { execFileSync('pbcopy', [], { input: saved }) } catch { /* ignore */ }
                }
              }
            }
          } else {
            n.typeText(text)
          }
          if (target.bundleId) updateTargetState(target, 'keyboard')

          // press_enter: submit after typing
          if (args.press_enter === true || args.press_enter === 'true') {
            n.keyPress('return')
            await sleep(30)
          }

          return ok('Typed')
        }

        case 'key': {
          const target = resolveTarget(args)
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)
          n.keyPress(str('text'), args.repeat !== undefined ? num('repeat', 1) : undefined)
          if (target.bundleId) updateTargetState(target, 'keyboard')
          return ok(`Pressed ${args.text}`)
        }
        case 'hold_key': {
          const target = resolveTarget(args)
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)
          if (!Array.isArray(args.keys) || !args.keys.every(k => typeof k === 'string'))
            throw new Error('Invalid keys: expected string[]')
          n.holdKey(args.keys as string[], num('duration', 1) * 1000)
          if (target.bundleId) updateTargetState(target, 'keyboard')
          return ok('Held')
        }

        // ── Clipboard ────────────────────────────────────────────────────────
        case 'read_clipboard': {
          if (IS_WINDOWS && n.readClipboard) {
            return ok(n.readClipboard())
          }
          const text = execFileSync('pbpaste', []).toString()
          return ok(text)
        }
        case 'write_clipboard': {
          if (IS_WINDOWS && n.writeClipboard) {
            n.writeClipboard(str('text'))
            return ok('Written')
          }
          execFileSync('pbcopy', [], { input: str('text') })
          return ok('Written')
        }

        // ── New v4 observation tools (never mutate TargetState) ──────────
        case 'get_window': {
          const wid = num('window_id', -1)
          if (wid < 0) throw new Error('Invalid window_id: expected number')
          const win = n.getWindow(wid)
          if (!win) {
            return { content: [{ type: 'text', text: `Window not found: ${wid}` }], isError: true }
          }
          return ok(JSON.stringify(win))
        }

        case 'get_cursor_window': {
          const win = n.getCursorWindow()
          return ok(JSON.stringify(win))
        }

        // ── New v4 activation tools (mutate TargetState on success) ──────
        case 'activate_app': {
          const bid = str('bundle_id')
          const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined
          const frontBefore = n.getFrontmostApp()

          const r = n.activateApp(bid, timeoutMs ?? 2000)
          await sleep(80)

          const frontAfter = n.getFrontmostApp()
          const activated = r.activated || frontAfter?.bundleId === bid

          if (activated) {
            updateTargetState({ bundleId: bid }, 'activation')
          }

          // Check for hidden/not_running reasons
          let reason: string | null = null
          let suggestedRecovery: string | undefined
          if (!activated) {
            const runningApp = n.listRunningApps().find(a => a.bundleId === bid)
            if (!runningApp) {
              reason = 'not_running'
            } else if (runningApp.isHidden) {
              reason = 'hidden'
              suggestedRecovery = 'unhide_app'
            } else {
              reason = 'timeout'
            }
          }

          const response: Record<string, unknown> = {
            requestedBundleId: bid,
            frontmostBefore: frontBefore?.bundleId ?? null,
            frontmostAfter: frontAfter?.bundleId ?? null,
            activated,
            reason,
          }
          if (suggestedRecovery) response.suggestedRecovery = suggestedRecovery

          return ok(JSON.stringify(response))
        }

        case 'activate_window': {
          const wid = num('window_id', -1)
          if (wid < 0) throw new Error('Invalid window_id: expected number')
          const timeoutMs = typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined

          // Resolve bundleId from window
          const win = n.getWindow(wid)
          if (!win) {
            return ok(JSON.stringify({
              windowId: wid,
              activated: false,
              frontmostAfter: n.getFrontmostApp()?.bundleId ?? null,
              reason: 'window_not_found',
            }))
          }

          const bundleId = win.bundleId

          // Recovery sequence for hidden apps
          if (bundleId) {
            const runningApp = n.listRunningApps().find(a => a.bundleId === bundleId)
            if (runningApp?.isHidden) {
              n.unhideApp(bundleId)
              await sleep(100)
            }
            n.activateApp(bundleId, timeoutMs ?? 2000)
            await sleep(80)
          }

          // Raise the specific window
          const result = n.activateWindow(wid, timeoutMs)
          await sleep(80)

          const frontAfter = n.getFrontmostApp()
          const activated = result.activated

          if (activated && bundleId) {
            updateTargetState({ bundleId, windowId: wid }, 'activation')
          }

          return ok(JSON.stringify({
            windowId: wid,
            activated,
            frontmostAfter: frontAfter?.bundleId ?? null,
            reason: result.reason,
          }))
        }

        // ── Apps ─────────────────────────────────────────────────────────────
        case 'open_application': {
          const bid = str('bundle_id')
          const r = n.activateApp(bid, 3000)
          if (r.activated) {
            updateTargetState({ bundleId: bid }, 'activation')
          }
          await sleep(300)
          return ok(`Opened ${bid} (activated: ${r.activated})`)
        }

        // ── Observation tools (never mutate TargetState) ─────────────────
        case 'get_frontmost_app':
          return ok(JSON.stringify(n.getFrontmostApp()))
        case 'list_windows':
          return ok(JSON.stringify(n.listWindows(typeof args.bundle_id === 'string' ? args.bundle_id : undefined)))
        case 'list_running_apps':
          return ok(JSON.stringify(n.listRunningApps()))
        case 'hide_app':
          return ok(n.hideApp(str('bundle_id')) ? 'Hidden' : 'App not found')
        case 'unhide_app':
          return ok(n.unhideApp(str('bundle_id')) ? 'Unhidden' : 'App not found')
        case 'get_display_size':
          return ok(JSON.stringify(n.getDisplaySize(typeof args.display_id === 'number' ? args.display_id : undefined)))
        case 'list_displays':
          return ok(JSON.stringify(n.listDisplays()))
        case 'wait': {
          await sleep(num('duration', 1) * 1000)
          return ok(`Waited ${args.duration}s`)
        }

        case 'resize_window': {
          if (IS_WINDOWS) {
            const wid = typeof args.window_id === 'number' ? args.window_id : undefined
            const wname = typeof args.window_name === 'string' ? args.window_name : undefined
            const wsize = Array.isArray(args.window_size) ? args.window_size as [number, number] : undefined
            const wloc = Array.isArray(args.window_loc) ? args.window_loc as [number, number] : undefined

            // Find target HWND
            let targetCmd = ''
            if (wid) {
              targetCmd = `$hwnd = [IntPtr]${wid}`
            } else if (wname) {
              targetCmd = `$hwnd = (Get-Process -Name '${wname.replace(/\.exe$/i, '')}' -ErrorAction SilentlyContinue | Select-Object -First 1).MainWindowHandle; if (-not $hwnd -or $hwnd -eq 0) { $hwnd = (Get-Process | Where-Object { $_.MainWindowTitle -like '*${wname}*' } | Select-Object -First 1).MainWindowHandle }`
            } else {
              targetCmd = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();}'; $hwnd = [W]::GetForegroundWindow()`
            }

            let moveCmd = ''
            if (wsize && wloc) {
              moveCmd = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class MW{[DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r);}'; [MW]::MoveWindow($hwnd, ${wloc[0]}, ${wloc[1]}, ${wsize[0]}, ${wsize[1]}, $true)`
            } else if (wsize) {
              moveCmd = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class GR{[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);[StructLayout(LayoutKind.Sequential)]public struct RECT{public int l,t,r,b;} [DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool rp);}'; $r = New-Object GR+RECT; [GR]::GetWindowRect($hwnd, [ref]$r); [GR]::MoveWindow($hwnd, $r.l, $r.t, ${wsize[0]}, ${wsize[1]}, $true)`
            } else if (wloc) {
              moveCmd = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class GR2{[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);[StructLayout(LayoutKind.Sequential)]public struct RECT{public int l,t,r,b;} [DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool rp);}'; $r = New-Object GR2+RECT; [GR2]::GetWindowRect($hwnd, [ref]$r); [GR2]::MoveWindow($hwnd, ${wloc[0]}, ${wloc[1]}, $r.r-$r.l, $r.b-$r.t, $true)`
            } else {
              return { content: [{ type: 'text', text: 'window_size or window_loc required' }], isError: true }
            }

            const ps = `${targetCmd}; if ($hwnd -and $hwnd -ne 0) { ${moveCmd}; 'Resized' } else { 'Window not found' }`
            const r = await runScriptHelper('powershell', ps, 10000)
            return r.code === 0 ? ok(r.stdout.trim()) : { content: [{ type: 'text', text: r.stderr || r.stdout }], isError: true }
          }

          // macOS: use AppleScript for window resize/move
          const wname = typeof args.window_name === 'string' ? args.window_name : undefined
          const wsize = Array.isArray(args.window_size) ? args.window_size as [number, number] : undefined
          const wloc = Array.isArray(args.window_loc) ? args.window_loc as [number, number] : undefined

          if (!wsize && !wloc) {
            return { content: [{ type: 'text', text: 'window_size or window_loc required' }], isError: true }
          }

          // Build AppleScript to resize/move the window
          let targetClause: string
          if (wname) {
            targetClause = `tell application "${wname}"`
          } else {
            // Target the frontmost app
            targetClause = `tell application (path to frontmost application as text)`
          }

          const parts: string[] = []
          if (wloc) parts.push(`set position of front window to {${wloc[0]}, ${wloc[1]}}`)
          if (wsize) parts.push(`set size of front window to {${wsize[0]}, ${wsize[1]}}`)

          const script = `${targetClause}\n${parts.join('\n')}\nend tell`
          const r = await runScriptHelper('applescript', script, 10000)
          return r.code === 0 ? ok('Resized') : { content: [{ type: 'text', text: r.stderr || r.stdout || 'resize failed' }], isError: true }
        }

        case 'snapshot': {
          // Combined tool: screenshot + UI tree + windows + desktops
          const parts: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []

          // Desktop info
          const front = n.getFrontmostApp()
          const wins = n.listWindows()
          const display = n.getDisplaySize()
          const runningApps = n.listRunningApps()

          let desktopInfo = `Display: ${display.width}x${display.height} (scale: ${display.scaleFactor})\n`
          desktopInfo += `Frontmost: ${front?.bundleId ?? 'unknown'} — ${front?.displayName ?? ''}\n`
          desktopInfo += `Windows: ${Array.isArray(wins) ? wins.length : 0}\n`
          desktopInfo += `Running apps: ${Array.isArray(runningApps) ? runningApps.length : 0}`

          // Windows list
          if (Array.isArray(wins)) {
            const winList = (wins as Array<{windowId: number; bundleId: string | null; title: string | null; isFocused: boolean; bounds: {x: number; y: number; width: number; height: number}}>).map(w =>
              `  ${w.windowId} | ${w.bundleId} | ${w.title ?? '(no title)'}`
            ).join('\n')
            desktopInfo += `\n\nWindows:\n${winList}`
          }

          // UI tree for the frontmost window
          let uiTreeText = ''
          if (args.use_vision !== false) {
            const frontWin = Array.isArray(wins) ? (wins as Array<{windowId: number; isFocused: boolean; bundleId: string | null}>).find(w => w.isFocused) : null
            if (frontWin) {
              try {
                const tree = n.getUiTree(frontWin.windowId, 5)
                uiTreeText = `\n\nUI Tree (${frontWin.bundleId}):\n${JSON.stringify(tree).slice(0, 4000)}`
              } catch { /* UI tree may fail */ }
            }
          }

          parts.push({ type: 'text', text: desktopInfo + uiTreeText })

          // Screenshot if use_vision
          if (args.use_vision) {
            const provider = defaultProvider
            const defaultWidth = PROVIDER_WIDTH[provider] ?? 1024
            const w = typeof args.width === 'number' ? args.width : defaultWidth
            const r = n.takeScreenshot(w, undefined, 80, undefined, undefined)
            if (r.base64) {
              const needsAnnotation = args.use_annotation && Array.isArray(wins)
              const gridLines = Array.isArray(args.grid_lines) ? args.grid_lines as [number, number] : undefined

              if (needsAnnotation || gridLines) {
                // Build annotation data for Rust drawing
                const annData = needsAnnotation
                  ? (wins as Array<{bounds: {x: number; y: number; width: number; height: number}}>)
                      .filter(win => win.bounds)
                      .map(win => ({
                        x: Math.round(win.bounds.x * r.width / display.width),
                        y: Math.round(win.bounds.y * r.height / display.height),
                        width: Math.round(win.bounds.width * r.width / display.width),
                        height: Math.round(win.bounds.height * r.height / display.height),
                      }))
                  : null
                const annotated = n.annotateImage(
                  r.base64,
                  annData ? JSON.stringify(annData) : null,
                  gridLines?.[0] ?? null,
                  gridLines?.[1] ?? null,
                  80,
                )
                parts.push({ type: 'image', data: annotated.base64, mimeType: annotated.mimeType })
                parts.push({ type: 'text', text: `${annotated.width}x${annotated.height}` })
              } else {
                parts.push({ type: 'image', data: r.base64, mimeType: r.mimeType })
                parts.push({ type: 'text', text: `${r.width}x${r.height}` })
              }

              // Always include text annotations for non-vision models
              if (needsAnnotation) {
                const annText = (wins as Array<{bundleId: string | null; bounds: {x: number; y: number; width: number; height: number}}>)
                  .filter(win => win.bounds)
                  .map(win => `[${win.bundleId}] (${win.bounds.x},${win.bounds.y}) ${win.bounds.width}x${win.bounds.height}`)
                  .join('\n')
                parts.push({ type: 'text', text: `\nAnnotations:\n${annText}` })
              }
            }
          }

          return { content: parts }
        }

        // ── v5: Accessibility observation (never mutate TargetState) ─────
        case 'get_ui_tree': {
          const wid = num('window_id', -1)
          if (wid < 0) throw new Error('Invalid window_id: expected number')
          const maxDepth = typeof args.max_depth === 'number' ? args.max_depth : undefined
          return ok(JSON.stringify(n.getUiTree(wid, maxDepth)))
        }

        case 'get_focused_element': {
          return ok(JSON.stringify(n.getFocusedElement()))
        }

        case 'find_element': {
          const wid = num('window_id', -1)
          if (wid < 0) throw new Error('Invalid window_id: expected number')
          const role  = typeof args.role  === 'string' ? args.role  : undefined
          const label = typeof args.label === 'string' ? args.label : undefined
          const value = typeof args.value === 'string' ? args.value : undefined
          if (!role && !label && !value) {
            throw new Error('find_element requires at least one of: role, label, value')
          }
          const maxRes = typeof args.max_results === 'number' ? args.max_results : undefined
          return ok(JSON.stringify(n.findElement(wid, role, label, value, maxRes)))
        }

        // ── v5: Semantic actions (mutate TargetState on success) ─────────
        case 'click_element': {
          const target = resolveTarget({ window_id: args.window_id })
          if (target.windowId == null) throw new Error('click_element requires window_id')
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)

          const role  = str('role')
          const label = str('label')
          const result = n.performAction(target.windowId, role, label, 'AXPress')

          if (result.performed) {
            updateTargetState(target, 'pointer')
            return ok(`Clicked ${role} "${label}"`)
          }

          if (result.reason === 'unsupported_action' && result.bounds) {
            // Coordinate-click fallback at element center.
            const cx = Math.round(result.bounds.x + result.bounds.width / 2)
            const cy = Math.round(result.bounds.y + result.bounds.height / 2)
            n.mouseMove(cx, cy)
            await sleep(50)
            n.mouseClick(cx, cy, 'left', 1)
            updateTargetState(target, 'pointer')
            return ok(`Clicked ${role} "${label}" via coordinate fallback (${cx}, ${cy})`)
          }

          if (result.reason === 'disabled') {
            return { content: [{ type: 'text', text: `Element ${role} "${label}" is disabled` }], isError: true }
          }

          return similarLabelsError(
            target.windowId,
            label,
            `No element matches role="${role}" label="${label}"`,
          )
        }

        case 'set_value': {
          const target = resolveTarget({ window_id: args.window_id })
          if (target.windowId == null) throw new Error('set_value requires window_id')
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)

          const role  = str('role')
          const label = str('label')
          const value = str('value')
          const result = n.setElementValue(target.windowId, role, label, value)

          if (result.set) {
            updateTargetState(target, 'keyboard')
            return ok(`Set ${role} "${label}" = ${JSON.stringify(value)}`)
          }

          if (result.reason === 'read_only') {
            return { content: [{ type: 'text', text: `Element ${role} "${label}" is read-only` }], isError: true }
          }
          if (result.reason === 'not_found') {
            return similarLabelsError(
              target.windowId,
              label,
              `No element matches role="${role}" label="${label}"`,
            )
          }
          return { content: [{ type: 'text', text: `set_value failed: ${result.reason ?? 'unknown'}` }], isError: true }
        }

        case 'press_button': {
          const target = resolveTarget({ window_id: args.window_id })
          if (target.windowId == null) throw new Error('press_button requires window_id')
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)

          const label = str('label')
          const result = n.performAction(target.windowId, 'AXButton', label, 'AXPress')

          if (result.performed) {
            updateTargetState(target, 'pointer')
            return ok(`Pressed "${label}"`)
          }
          if (result.reason === 'disabled') {
            return { content: [{ type: 'text', text: `Button "${label}" is disabled` }], isError: true }
          }
          return similarLabelsError(
            target.windowId,
            label,
            `No button matches label="${label}"`,
            'AXButton',
          )
        }

        case 'select_menu_item': {
          const bundleId = str('bundle_id')
          const menu     = str('menu')
          const item     = str('item')
          const submenu  = typeof args.submenu === 'string' ? args.submenu : undefined

          // Menu bar only responds to the frontmost app.
          await ensureFocusV4({ bundleId }, 'strict')

          const result = n.pressMenuItem(bundleId, menu, item, submenu)
          if (result.pressed) {
            updateTargetState({ bundleId }, 'activation')
            return ok(`Selected ${bundleId} → ${menu}${submenu ? ` → ${submenu}` : ''} → ${item}`)
          }

          const bar = n.getMenuBar(bundleId)
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: result.reason ?? 'menu_item_not_found',
                bundle_id: bundleId, menu, item, submenu,
                availableMenus: bar.map(m => m.title),
              }),
            }],
            isError: true,
          }
        }

        case 'list_menu_bar': {
          if (IS_WINDOWS) {
            return { content: [{ type: 'text', text: 'platform_unsupported: list_menu_bar is macOS-only. Use get_ui_tree to discover menu structure on Windows.' }], isError: true }
          }
          const bundleId = str('bundle_id')
          const bar = n.getMenuBar(bundleId)
          return ok(JSON.stringify(bar))
        }

        case 'fill_form': {
          const target = resolveTarget({ window_id: args.window_id })
          if (target.windowId == null) throw new Error('fill_form requires window_id')
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)

          const fields = args.fields
          if (!Array.isArray(fields)) throw new Error('fill_form requires fields: array')

          let succeeded = 0
          const failures: Array<{ role: string; label: string; reason: string }> = []
          for (const raw of fields) {
            if (raw == null || typeof raw !== 'object') {
              failures.push({ role: '', label: '', reason: 'invalid_entry' })
              continue
            }
            const f = raw as Record<string, unknown>
            const role  = typeof f.role  === 'string' ? f.role  : ''
            const label = typeof f.label === 'string' ? f.label : ''
            const value = typeof f.value === 'string' ? f.value : ''
            if (!role) {
              failures.push({ role, label, reason: 'invalid_entry' })
              continue
            }
            const r = n.setElementValue(target.windowId, role, label, value)
            if (r.set) {
              succeeded++
            } else {
              failures.push({ role, label, reason: r.reason ?? 'not_found' })
            }
          }

          if (succeeded > 0) updateTargetState(target, 'keyboard')
          return ok(JSON.stringify({
            succeeded,
            failed: failures.length,
            failures,
          }))
        }

        // ── v5: Scripting bridge (never mutate TargetState) ───────────────
        case 'run_script': {
          const lang = IS_WINDOWS
            ? (args.language === 'powershell' ? 'powershell' : String(args.language ?? 'powershell'))
            : (args.language === 'javascript' ? 'javascript' : 'applescript')
          const script = str('script')
          const requested = typeof args.timeout_ms === 'number' ? args.timeout_ms : 30_000
          const timeoutMs = Math.max(100, Math.min(requested, 120_000))
          const r = await runScriptHelper(lang, script, timeoutMs)
          if (r.timedOut) {
            return { content: [{ type: 'text', text: `script timed out after ${timeoutMs}ms` }], isError: true }
          }
          if (r.code !== 0) {
            return { content: [{ type: 'text', text: (r.stderr || `script exited with code ${r.code}`).trimEnd() }], isError: true }
          }
          return ok(r.stdout.replace(/\n+$/, ''))
        }

        case 'get_app_dictionary': {
          if (IS_WINDOWS) {
            return { content: [{ type: 'text', text: 'platform_unsupported: get_app_dictionary is macOS-only. Use get_ui_tree to discover UI structure on Windows.' }], isError: true }
          }
          const bundleId = str('bundle_id')
          const suite = typeof args.suite === 'string' ? args.suite : undefined
          const r = await getAppDictionary(bundleId, suite)
          if ('error' in r) {
            return { content: [{ type: 'text', text: r.error }], isError: true }
          }
          return ok(JSON.stringify(r.dict))
        }

        // ── v5: Strategy advisor + capabilities (never mutate state) ─────
        case 'get_tool_guide': {
          const taskDescription = str('task_description')
          return ok(JSON.stringify(lookupToolGuide(taskDescription)))
        }

        case 'get_app_capabilities': {
          const bundleId = str('bundle_id')
          const running = n.listRunningApps().find(a => a.bundleId === bundleId)
          const wins = n.listWindows(bundleId)

          if (IS_WINDOWS) {
            return ok(JSON.stringify({
              bundle_id: bundleId,
              scriptable: false, // No AppleScript on Windows
              suites: [],
              powershell: true, // PowerShell available via run_script
              accessible: wins.length > 0,
              topLevelCount: wins.length,
              running: Boolean(running),
              hidden: running?.isHidden ?? false,
            }))
          }

          const dictResult = await getAppDictionary(bundleId)
          const scriptable = !('error' in dictResult)
          const suites: string[] = scriptable ? dictResult.dict.suites.map(s => s.name) : []

          return ok(JSON.stringify({
            bundle_id: bundleId,
            scriptable,
            suites,
            accessible: wins.length > 0,
            topLevelCount: wins.length,
            running: Boolean(running),
            hidden: running?.isHidden ?? false,
          }))
        }

        // ── v5: Spaces ─────────────────────────────────────────────────────
        case 'list_spaces': {
          return ok(JSON.stringify(n.listSpaces()))
        }

        case 'get_active_space': {
          return ok(JSON.stringify(n.getActiveSpace()))
        }

        case 'create_agent_space': {
          if (IS_WINDOWS) {
            // Count desktops before
            const beforeSpaces = n.listSpaces()
            const beforeCount = beforeSpaces.displays?.[0]?.spaces?.length ?? 0

            // Create via keyboard shortcut — Ctrl+Win+D
            n.keyPress('ctrl+win+d')
            await sleep(500)

            // Count after
            const afterSpaces = n.listSpaces()
            const afterCount = afterSpaces.displays?.[0]?.spaces?.length ?? 0
            const newDesktop = afterSpaces.displays?.[0]?.spaces?.[afterCount - 1]

            return ok(JSON.stringify({
              created: afterCount > beforeCount,
              space_id: newDesktop?.uuid ?? null,
              name: `Desktop ${afterCount}`,
              total_desktops: afterCount,
              note: 'Created via Ctrl+Win+D keyboard shortcut. You are now on the new desktop.',
            }))
          }

          if (cachedAgentSpaceId !== undefined) {
            return ok(JSON.stringify({
              space_id: cachedAgentSpaceId,
              created: false,
              cached: true,
            }))
          }
          const r = n.createAgentSpace()
          if (!r.supported) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  error: 'spaces_api_unavailable',
                  reason: r.reason ?? 'api_unavailable',
                  workaround:
                    'Programmatic Space creation is not available on this macOS version. Use Control+Arrow to switch between user Spaces, or run the agent in the current Space.',
                }),
              }],
              isError: true,
            }
          }
          if (typeof r.spaceId === 'number') cachedAgentSpaceId = r.spaceId
          return ok(JSON.stringify({
            space_id: r.spaceId,
            created: true,
            attached: r.attached ?? false,
            note: r.note,
          }))
        }

        case 'move_window_to_space': {
          const wid = num('window_id', -1)
          const spaceId = num('space_id', -1)
          if (wid < 0) throw new Error('Invalid window_id: expected number')
          if (spaceId < 0) throw new Error('Invalid space_id: expected number')
          const r = n.moveWindowToSpace(wid, spaceId)
          if (!r.moved) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  error: r.reason ?? 'move_failed',
                  window_id: wid,
                  space_id: spaceId,
                }),
              }],
              isError: true,
            }
          }
          return ok(JSON.stringify({
            window_id: wid,
            space_id: spaceId,
            moved: true,
            verified: r.verified ?? false,
            window_on_screen_before: r.window_on_screen_before,
            window_on_screen_after: r.window_on_screen_after,
            note: r.note,
          }))
        }

        case 'remove_window_from_space': {
          const wid = num('window_id', -1)
          const spaceId = num('space_id', -1)
          if (wid < 0) throw new Error('Invalid window_id: expected number')
          if (spaceId < 0) throw new Error('Invalid space_id: expected number')
          const r = n.removeWindowFromSpace(wid, spaceId)
          if (!r.removed) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: r.reason ?? 'remove_failed' }) }],
              isError: true,
            }
          }
          return ok(JSON.stringify({ window_id: wid, space_id: spaceId, removed: true }))
        }

        case 'destroy_space': {
          if (IS_WINDOWS) {
            // Close current desktop via Ctrl+Win+F4
            // This closes the desktop you're currently on and moves windows to the adjacent one
            const beforeSpaces = n.listSpaces()
            const beforeCount = beforeSpaces.displays?.[0]?.spaces?.length ?? 0

            n.keyPress('ctrl+win+f4')
            await sleep(500)

            const afterSpaces = n.listSpaces()
            const afterCount = afterSpaces.displays?.[0]?.spaces?.length ?? 0

            return ok(JSON.stringify({
              destroyed: afterCount < beforeCount,
              remaining_desktops: afterCount,
              note: 'Closed current desktop via Ctrl+Win+F4. Windows moved to adjacent desktop.',
            }))
          }

          const spaceId = num('space_id', -1)
          if (spaceId < 0) throw new Error('Invalid space_id: expected number')
          const r = n.destroySpace(spaceId)
          if (!r.destroyed) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: r.reason ?? 'destroy_failed' }) }],
              isError: true,
            }
          }
          if (cachedAgentSpaceId === spaceId) cachedAgentSpaceId = undefined
          return ok(JSON.stringify({ space_id: spaceId, destroyed: true }))
        }

        // ── New Windows-parity tools ──────────────────────────────────────

        case 'filesystem': {
          const mode = str('mode')
          let filePath = str('path')
          // Resolve relative paths from Desktop — use already-imported modules
          if (!path.isAbsolute(filePath)) {
            filePath = path.join(os.homedir(), 'Desktop', filePath)
          }
          let dest = typeof args.destination === 'string' ? args.destination : undefined
          if (dest && !path.isAbsolute(dest)) {
            dest = path.join(os.homedir(), 'Desktop', dest)
          }
          const encoding = (typeof args.encoding === 'string' ? args.encoding : 'utf-8') as BufferEncoding

          switch (mode) {
            case 'read': {
              if (!fs.existsSync(filePath)) return { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true }
              const content = fs.readFileSync(filePath, encoding)
              const lines = content.split('\n')
              const offset = typeof args.offset === 'number' ? args.offset : 0
              const limit = typeof args.limit === 'number' ? args.limit : lines.length
              return ok(lines.slice(offset, offset + limit).join('\n'))
            }
            case 'write': {
              const content = typeof args.content === 'string' ? args.content : ''
              const dir = path.dirname(filePath)
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
              if (args.append) {
                fs.appendFileSync(filePath, content, encoding)
              } else {
                fs.writeFileSync(filePath, content, encoding)
              }
              return ok(`Written to ${filePath}`)
            }
            case 'copy': {
              if (!dest) return { content: [{ type: 'text', text: 'destination required for copy' }], isError: true }
              fs.cpSync(filePath, dest, { recursive: true, force: Boolean(args.overwrite) })
              return ok(`Copied ${filePath} → ${dest}`)
            }
            case 'move': {
              if (!dest) return { content: [{ type: 'text', text: 'destination required for move' }], isError: true }
              fs.renameSync(filePath, dest)
              return ok(`Moved ${filePath} → ${dest}`)
            }
            case 'delete': {
              if (!fs.existsSync(filePath)) return { content: [{ type: 'text', text: `Not found: ${filePath}` }], isError: true }
              const stat = fs.statSync(filePath)
              if (stat.isDirectory()) {
                fs.rmSync(filePath, { recursive: Boolean(args.recursive), force: true })
              } else {
                fs.unlinkSync(filePath)
              }
              return ok(`Deleted ${filePath}`)
            }
            case 'list': {
              if (!fs.existsSync(filePath)) return { content: [{ type: 'text', text: `Directory not found: ${filePath}` }], isError: true }
              const entries = fs.readdirSync(filePath, { withFileTypes: true })
              const filtered = entries.filter(e => args.show_hidden || !e.name.startsWith('.'))
              const result = filtered.map(e => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`).join('\n')
              return ok(result || '(empty)')
            }
            case 'search': {
              const pattern = typeof args.pattern === 'string' ? args.pattern : '*'
              // Simple glob: just list recursively and filter
              const results: string[] = []
              const walk = (dir: string) => {
                try {
                  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    const full = path.join(dir, e.name)
                    if (e.name.includes(pattern.replace(/\*/g, '')) || pattern === '*') results.push(full)
                    if (e.isDirectory() && args.recursive) walk(full)
                  }
                } catch { /* permission denied etc */ }
              }
              walk(filePath)
              return ok(results.slice(0, 100).join('\n') || 'No matches')
            }
            case 'info': {
              if (!fs.existsSync(filePath)) return { content: [{ type: 'text', text: `Not found: ${filePath}` }], isError: true }
              const stat = fs.statSync(filePath)
              return ok(JSON.stringify({
                path: filePath, type: stat.isDirectory() ? 'directory' : 'file',
                size: stat.size, created: stat.birthtime.toISOString(),
                modified: stat.mtime.toISOString(),
              }))
            }
            default: return { content: [{ type: 'text', text: `Unknown filesystem mode: ${mode}` }], isError: true }
          }
        }

        case 'process_kill': {
          const mode = str('mode')
          if (mode === 'list') {
            if (IS_WINDOWS) {
              const r = await spawnBounded('powershell', ['-NoProfile', '-Command',
                'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 Id,ProcessName,@{N="MemMB";E={[math]::Round($_.WorkingSet64/1MB,1)}} | ConvertTo-Json'], 10000)
              return r.code === 0 ? ok(r.stdout) : { content: [{ type: 'text', text: r.stderr }], isError: true }
            } else {
              const r = await spawnBounded('ps', ['aux', '-r'], 5000)
              const lines = r.stdout.split('\n').slice(0, 21)
              return ok(lines.join('\n'))
            }
          }
          if (mode === 'kill') {
            const name = typeof args.name === 'string' ? args.name : undefined
            const pid = typeof args.pid === 'number' ? args.pid : undefined
            if (!name && !pid) return { content: [{ type: 'text', text: 'name or pid required' }], isError: true }
            if (IS_WINDOWS) {
              const target = pid ? `/PID ${pid}` : `/IM ${name}`
              const flag = args.force ? '/F' : ''
              const r = await spawnBounded('taskkill', [target, flag].filter(Boolean), 10000)
              return r.code === 0 ? ok(r.stdout.trim() || 'Process terminated') : { content: [{ type: 'text', text: r.stderr || r.stdout }], isError: true }
            } else {
              const signal = args.force ? 'SIGKILL' : 'SIGTERM'
              if (pid) { process.kill(pid, signal); return ok(`Sent ${signal} to PID ${pid}`) }
              const r = await spawnBounded('pkill', [args.force ? '-9' : '-15', name!], 5000)
              return r.code === 0 ? ok(`Killed ${name}`) : { content: [{ type: 'text', text: r.stderr || 'No matching process' }], isError: true }
            }
          }
          return { content: [{ type: 'text', text: `Unknown process mode: ${mode}` }], isError: true }
        }

        case 'registry': {
          if (!IS_WINDOWS) return { content: [{ type: 'text', text: 'registry is Windows-only. Use `defaults` via run_script on macOS.' }], isError: true }
          const mode = str('mode')
          const regPath = str('path')
          const name = typeof args.name === 'string' ? args.name : undefined
          const psExe = getPowerShellExe()
          switch (mode) {
            case 'get': {
              if (!name) return { content: [{ type: 'text', text: 'name required for get' }], isError: true }
              const r = await spawnBounded(psExe, ['-NoProfile', '-NonInteractive', '-Command', `Get-ItemPropertyValue -Path '${regPath}' -Name '${name}'`], 10000)
              return r.code === 0 ? ok(r.stdout.trim()) : { content: [{ type: 'text', text: r.stderr }], isError: true }
            }
            case 'set': {
              if (!name) return { content: [{ type: 'text', text: 'name required for set' }], isError: true }
              const val = typeof args.value === 'string' ? args.value : ''
              const type = typeof args.type === 'string' ? args.type : 'String'
              const r = await spawnBounded(psExe, ['-NoProfile', '-NonInteractive', '-Command',
                `New-ItemProperty -Path '${regPath}' -Name '${name}' -Value '${val}' -PropertyType ${type} -Force`], 10000)
              return r.code === 0 ? ok(`Set ${regPath}\\${name}`) : { content: [{ type: 'text', text: r.stderr }], isError: true }
            }
            case 'delete': {
              const cmd = name
                ? `Remove-ItemProperty -Path '${regPath}' -Name '${name}' -Force`
                : `Remove-Item -Path '${regPath}' -Recurse -Force`
              const r = await spawnBounded(psExe, ['-NoProfile', '-NonInteractive', '-Command', cmd], 10000)
              return r.code === 0 ? ok(`Deleted ${name ? `${regPath}\\${name}` : regPath}`) : { content: [{ type: 'text', text: r.stderr }], isError: true }
            }
            case 'list': {
              const r = await spawnBounded(psExe, ['-NoProfile', '-NonInteractive', '-Command',
                `Get-Item -Path '${regPath}' | Select-Object -ExpandProperty Property; Get-ChildItem -Path '${regPath}' -Name`], 10000)
              return r.code === 0 ? ok(r.stdout.trim() || '(empty)') : { content: [{ type: 'text', text: r.stderr }], isError: true }
            }
            default: return { content: [{ type: 'text', text: `Unknown registry mode: ${mode}` }], isError: true }
          }
        }

        case 'notification': {
          if (!IS_WINDOWS) return { content: [{ type: 'text', text: 'notification is Windows-only. Use osascript via run_script on macOS.' }], isError: true }
          const title = str('title')
          const message = str('message')
          const appId = typeof args.app_id === 'string' ? args.app_id : 'Windows.SystemToastNotification'
          const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$xml.LoadXml("<toast><visual><binding template='ToastText02'><text id='1'>${title}</text><text id='2'>${message}</text></binding></visual></toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${appId}').Show($toast)
`
          const r = await spawnBounded('powershell', ['-NoProfile', '-Command', ps], 10000)
          return r.code === 0 ? ok('Notification sent') : { content: [{ type: 'text', text: r.stderr || 'Failed to send notification' }], isError: true }
        }

        case 'multi_select': {
          const target = resolveTarget(args)
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)

          const locs = (Array.isArray(args.locs) ? args.locs : []) as [number, number][]

          // Resolve labels to coordinates via find_element
          if (Array.isArray(args.labels) && args.labels.length > 0 && target.windowId) {
            for (const label of args.labels as string[]) {
              try {
                const elements = n.findElement(target.windowId, undefined, label, undefined, 1)
                const arr = Array.isArray(elements) ? elements : JSON.parse(JSON.stringify(elements))
                if (arr.length > 0 && arr[0].bounds) {
                  const b = arr[0].bounds
                  locs.push([Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)])
                }
              } catch { /* label not found */ }
            }
          }

          if (locs.length === 0) {
            return { content: [{ type: 'text', text: 'No coordinates resolved. Provide locs or valid labels.' }], isError: true }
          }

          // Ctrl-click: hold ctrl for the entire sequence
          if (args.press_ctrl) {
            n.keyPress(IS_WINDOWS ? 'ctrl' : 'command')  // press modifier
          }
          for (let i = 0; i < locs.length; i++) {
            const [x, y] = locs[i]
            n.mouseMove(x, y)
            await sleep(50)
            n.mouseClick(x, y, 'left', 1)
            await sleep(30)
          }
          if (target.bundleId) updateTargetState(target, 'pointer')
          return ok(`Selected ${locs.length} elements`)
        }

        case 'multi_edit': {
          const target = resolveTarget(args)
          const strategy = getStrategy(tool, args)
          await ensureFocusV4(target, strategy)

          const locs = (Array.isArray(args.locs) ? args.locs : []) as [number, number, string][]

          // Resolve labels to coordinates via find_element
          if (Array.isArray(args.labels) && args.labels.length > 0 && target.windowId) {
            for (const [label, text] of args.labels as [string, string][]) {
              try {
                const elements = n.findElement(target.windowId, undefined, label, undefined, 1)
                const arr = Array.isArray(elements) ? elements : JSON.parse(JSON.stringify(elements))
                if (arr.length > 0 && arr[0].bounds) {
                  const b = arr[0].bounds
                  locs.push([Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2), text])
                }
              } catch { /* label not found */ }
            }
          }

          if (locs.length === 0) {
            return { content: [{ type: 'text', text: 'No coordinates resolved. Provide locs or valid labels.' }], isError: true }
          }

          for (const [x, y, text] of locs) {
            n.mouseMove(x, y)
            await sleep(50)
            n.mouseClick(x, y, 'left', 1)
            await sleep(50)
            n.typeText(text)
            await sleep(30)
          }
          if (target.bundleId) updateTargetState(target, 'keyboard')
          return ok(`Edited ${locs.length} fields`)
        }

        case 'scrape': {
          const url = str('url')
          if (args.use_dom) {
            return { content: [{ type: 'text', text: 'use_dom mode requires a browser tab open with the URL. This feature is not yet implemented.' }], isError: true }
          }
          try {
            const resp = await fetch(url, {
              headers: { 'User-Agent': 'computer-use-mcp/6.1.0' },
              signal: AbortSignal.timeout(15000),
            })
            if (!resp.ok) {
              return { content: [{ type: 'text', text: `HTTP ${resp.status}: ${resp.statusText}` }], isError: true }
            }
            const html = await resp.text()
            // Simple HTML-to-text: strip tags, decode entities, collapse whitespace
            const text = html
              .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
              .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/&quot;/g, '"')
              .replace(/&#39;/g, "'")
              .replace(/\s+/g, ' ')
              .trim()
            const truncated = text.length > 8000 ? text.slice(0, 8000) + '...' : text
            return ok(`URL: ${url}\nContent:\n${truncated}`)
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e)
            return { content: [{ type: 'text', text: `Scrape failed: ${msg}` }], isError: true }
          }
        }

        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${tool}` }], isError: true }
      }
      })()
    } catch (err: unknown) {
      if (err instanceof FocusError) {
        result = { content: [{ type: 'text', text: focusFailureText(err.details) }], isError: true }
      } else if (err instanceof WindowNotFoundError) {
        // For input tools with invalid target_window_id, return FocusFailure
        const front = n.getFrontmostApp()
        const failure: FocusFailure = {
          error: 'focus_failed',
          requestedBundleId: '',
          requestedWindowId: err.windowId,
          frontmostBefore: front?.bundleId ?? null,
          frontmostAfter: front?.bundleId ?? null,
          targetRunning: false,
          targetHidden: false,
          targetWindowVisible: false,
          activationAttempted: false,
          suggestedRecovery: 'open_application',
        }
        result = { content: [{ type: 'text', text: focusFailureText(failure) }], isError: true }
      } else {
        const msg = err instanceof Error ? err.message : String(err)
        result = { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
      }
    } finally {
      if (acquired) lockPump.release()
    }

    // v5.2: decorate the response with hiddenBundleIds when prepare_display
    // ran. We attach to both the text payload (parseable by agents) and as
    // a top-level field (for strictly-typed callers who care).
    if (pendingHiddenBundleIds != null) {
      result = decorateWithHiddenBundleIds(result, pendingHiddenBundleIds)
    }
    return result
  }

  return { dispatch }
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

/**
 * Append `hiddenBundleIds` metadata to a dispatch result when the caller
 * used `focus_strategy: "prepare_display"`. We add a trailing text block so
 * the original payload is untouched — agents can parse either block.
 */
function decorateWithHiddenBundleIds(r: ToolResult, hidden: string[]): ToolResult {
  return {
    ...r,
    content: [
      ...r.content,
      { type: 'text', text: JSON.stringify({ hiddenBundleIds: hidden }) },
    ],
  }
}
