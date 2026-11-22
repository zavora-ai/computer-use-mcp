import { coerceArguments, withToolDefaults } from './registry/definitions.js'
/**
 * Session — resilient computer use session with in-process focus management.
 *
 * v4: Window-aware targeting with TargetState, focus strategies, and structured diagnostics.
 * Every mutating action: (1) resolve target, (2) ensure focus per strategy, (3) act, (4) update state.
 * Observation tools never mutate TargetState.
 * All runs in-process via NAPI — no child processes, no focus stealing.
 */

import { discoverApplications } from './session/application-discovery.js'
import { okJson } from './result.js'
import { offThread } from './session/native-async.js'
import { describeLoadedAddon, loadNative, type NativeModule } from './native.js'
import { DEFAULT_PROFILE, MUTATING_TOOLS, RUN_STEP_TOOLS, callMutates, getToolMeta, parseProfile, toolAvailableOn, toolInProfile } from './tool-catalog.js'
import { applyContract, targetArgs, withRefusalAdvice, type Effect } from './session/contract.js'
import { sleep, sleepAbortable, defaultSpawnBounded } from './session/spawn.js'
import type { SpawnBounded } from './session/spawn.js'
import { FocusError, StructuredToolError, WindowNotFoundError } from './session/errors.js'
import type { FocusFailure } from './session/errors.js'
import {
  createLockPumpController,
  coordinateDesktop,
  DEFAULT_SESSION_LOCK_PATH,
  LockError,
} from './session/lock.js'
import { createLegacyPolicyRuntime, sensitiveApps } from './session/legacy-policy.js'
import { createFocusController } from './session/focus.js'
import { TargetStateController } from './session/target-state.js'
import { VirtualPointerController } from './session/virtual-pointer.js'
import { runDoctor as runDoctorService } from './session/doctor.js'
import { handleAdminTool } from './session/admin-handlers.js'
import { handleBrowserTool } from './session/browser-handlers.js'
import { handleWindowTool } from './session/window-handlers.js'
import { handleLinuxAccessibility } from './session/linux-atspi.js'
import { handleAccessibilityTool } from './session/accessibility-handlers.js'
import { SpacesHandler } from './session/spaces-handlers.js'
import { ScreenshotHandler } from './session/screenshot-handlers.js'
import { InputHandler, VERIFIABLE_TOOLS, pointerMotionFromEnv, type PointerMotion } from './session/input-handlers.js'
import { ScriptingService } from './session/scripting-service.js'
import { OpenAiCompatibilityHandler } from './session/openai-handler.js'
import { handleCoreTool } from './session/core-handlers.js'
import { findText, handleAgentDesktopTool, mapOcrLines, similarLines } from './session/agent-desktop-handlers.js'
import { REDACTED, StepJournal, cleanArgs, exportSteps, holdsRedaction, textUnder, type JournalWindow, type RecordInput } from './session/step-journal.js'
import { listClassifiedWindows, resolveAppWindow } from './session/window-select.js'
import { BROWSERS, authHandoffEnabled, focusWall, textWall, titleWall, typesText, wallMessage, type Wall } from './session/auth-wall.js'
import { createMacosHelper, type MacosHelper } from './session/macos-helper.js'
import { defaultPidDeliveryPath, PidDeliveryStore } from './session/pid-delivery.js'
import { createUserActivityGuard, type UserActivityGuard } from './session/user-activity.js'
import { maskCardInCaptures } from './session/card-guard.js'
import { LiveWatcher } from './session/live-watcher.js'
import { OperatorControl, defaultCardPresenter, describeAction, emergencyChord, statusCardEnabled, takeoverEnabled } from './session/operator-control.js'
import {
  errJson,
  type ToolResult,
} from './result.js'

export type { ToolResult } from './result.js'
export type { SpawnResult, SpawnBounded } from './session/spawn.js'
export type { AutomationApproach, ToolGuideEntry } from './session/tool-guide.js'
export { LockError } from './session/lock.js'
export type { FocusStrategy } from './session/focus.js'
export type { TargetState } from './session/target-state.js'
export type {
  ScriptingDictionary,
  ScriptingDictionaryCommand,
  ScriptingDictionarySuite,
  ScriptingDictionaryClass,
} from './session/scripting-dictionary.js'





// ── Types ─────────────────────────────────────────────────────────────────────

export interface Session {
  close?(): void
  retain?(): () => void
  preflight?(tool: string, args: Record<string, unknown>, signal?: AbortSignal, context?: SessionRequestContext): Promise<ToolResult>

  dispatch(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: ProgressReporter,
    requestContext?: SessionRequestContext,
  ): Promise<ToolResult>
  /** Last screenshot from this session, if any (for cache-only resource; K15). */
  getLastScreenshot?(): { mimeType: string; data: string; capturedAt: number; targetArgs?: Record<string, unknown> } | undefined
  /** 7.8: the live share watcher, idle until the live tools or a host start it. */
  live?: LiveWatcher
}

export type ElicitApproval = (ctx: {
  tool: string
  args: Record<string, unknown>
  reasons: string[]
  targetApp?: string
  destructive: boolean
}) => Promise<boolean>

/** Per-call authority supplied by the negotiated MCP request context. */
export interface SessionRequestContext {
  /** Host-only authorization probe; never accepted from tool arguments. */
  preflight?: boolean

  clientRoots?: readonly string[]
  elicitApproval?: ElicitApproval
}

/**
 * Progress reporter for long-running tools (PR-14 progress half). Only wired by
 * the server when the MCP request carries a progressToken — no token, no reporter,
 * no notifications (avoids spam). Best-effort; handlers ignore a missing reporter.
 */
export type ProgressReporter = (update: { progress: number; total?: number; message?: string }) => void

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
  /**
   * Optional host elicitation callback for policy approval (PR-10).
   * Invoked only when approval is required and no valid approval_token is present.
   * Token wins over elicitation (K13).
   */
  elicitApproval?: ElicitApproval
  /** Active tool profile name (for guide unavailableInProfile). Init-time only (K18). */
  profile?: string
  /** Live MCP client roots. Undefined preserves legacy behavior for clients without roots support. */
  getClientRoots?: () => readonly string[] | undefined
  /**
   * v7.5: the macOS ScreenCaptureKit/Vision helper. Defaults to the compiled-on-first-use
   * helper on macOS with the real native module; `null` disables it. Tests inject a fake.
   */
  macosHelper?: MacosHelper | null
  /** v7.5: where pid delivery outcomes are kept. Defaults to the cache file (memory with an injected native). */
  pidDeliveryStore?: PidDeliveryStore
  /** v7.5: the user-active guard. Defaults to one over the native physical-input clock. */
  userActivityGuard?: UserActivityGuard
  /**
   * 7.6.1: the operator control (pause, stop, the desktop status card). Defaults to a control with the platform's
   * card when `COMPUTER_USE_STATUS_CARD=true` and the native module is real; otherwise the state machine alone.
   * Tests inject one with a fake presenter.
   */
  operatorControl?: OperatorControl
  /**
   * 7.7.0 (K2): the registry's argument check, so each run_steps step is validated exactly like a direct call. Absent
   * (a session without a registry, as in tests): steps are checked by tool name and availability only.
   */
  /**
   * 8.0: hand the desktop to the person when the agent is about to type into a sign-in or verification screen
   * (default on; `COMPUTER_USE_AUTH_HANDOFF=off`). For an operator whose agent must sign in, e.g. to a test account.
   */
  authHandoff?: boolean
  /**
   * 8.0: `glide` makes clicks, drags and scrolls travel to their point, eased, so a person or a recording can follow the
   * pointer (default `jump`; `COMPUTER_USE_POINTER_MOTION=glide`).
   */
  pointerMotion?: PointerMotion
  /** 8.0: how often a hand-off's watcher polls (tests shorten it). */
  handOffPollMs?: number
  validateArguments?: (tool: string, args: Record<string, unknown>) =>
    | { ok: true; args: Record<string, unknown> }
    | { ok: false; issues: Array<{ path: string; message: string }> }
}

/** 8.0: a sign-in or verification wall, where it was seen, and the window it was in. */
type FoundWall = Wall & { source: 'focus' | 'title' | 'text'; window?: JournalWindow }
/** 8.0: what ends a hand-off besides Resume: the window closing, text leaving it, or a detected wall moving on. */
type HandOffWatch =
  | { mode: 'window_gone' | 'text_gone'; windowId: number; title?: string; text?: string }
  | { mode: 'wall'; windowId: number; title?: string; source: FoundWall['source'] }
/** 8.0: how often the hand-off watcher looks (twice in a row must agree before it ends the hand-off). */
export const HANDOFF_POLL_MS = 750

const IS_WINDOWS = process.platform === 'win32'
/** 7.7.0 (K5): tools that capture the screen, refused with the mutating ones while the screen is locked. */
const CAPTURE_TOOLS = new Set(['screenshot', 'zoom', 'snapshot', 'read_window_text', 'click_text', 'wait_for_text', 'wait_for_stable'])

// MUTATING_TOOLS imported from tool-catalog.ts (SSOT with ToolMeta.mutates; includes resize_window).
// Observation tools (screenshot, list_*, get_*) do not take the lock.

// ── Session factory ───────────────────────────────────────────────────────────

export function createSession(opts: SessionOptions = {}): Session {
  // Where the status card shows in captures (Linux), every capture paints it out; a no-op elsewhere (card-guard.ts).
  const n = maskCardInCaptures(opts.native ?? loadNative(), () => control.cardRegion())
  const spawnBounded: SpawnBounded = opts.spawnBounded ?? defaultSpawnBounded
  const targetController = new TargetStateController(n)
  const visionEnabled = opts.vision !== false
  const elicitApproval = opts.elicitApproval
  const activeProfile = opts.profile ?? process.env.COMPUTER_USE_PROFILE ?? DEFAULT_PROFILE

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
  const lockPump = createLockPumpController({
    lockPath: opts.lockPath ?? DEFAULT_SESSION_LOCK_PATH,
    disableLock: opts.disableSessionLock ?? lockDisabledByDefault,
    ...(typeof n.drainRunloop === 'function'
      ? { drainRunloop: () => n.drainRunloop() }
      : {}),
  })

  const forceRelease = () => {
    try { while (lockPump.refcount > 0) lockPump.release() } catch { /* best effort */ }
  }
  if (!(opts.disableSessionLock ?? lockDisabledByDefault)) process.once('exit', forceRelease)
  let closed = false
  let closeRequested = false
  let references = 0
  const dispose = () => {
    if (closeRequested && references === 0) {
      closed = true
      process.removeListener('exit', forceRelease)
      // 7.6.1: apps hidden by prepare_display that the agent never restored come back when the session ends.
      try { focus.restoreHidden() } catch { /* best effort */ }
      try { liveWatcher.close() } catch { /* nothing was being watched */ }
      stopHandOffWatch()
      try { control.close() } catch { /* the card is optional */ }
      try { inputHandler.releaseHeldKeys() } catch { /* nothing held */ }
      try { macosHelper?.close?.() } catch { /* the warm helper exits with this process anyway */ }
      if (awakeTimer) clearTimeout(awakeTimer)
      try { n.releaseDisplayAwake?.() } catch { /* best effort */ }
    }
  }
  const defaultProvider = opts.provider ?? process.env.COMPUTER_USE_PROVIDER ?? 'auto'

  // v7.5 agent desktop: OCR/capture helper, pid delivery records, user-active guard.
  const macosHelper: MacosHelper | undefined = opts.macosHelper === null ? undefined
    : opts.macosHelper ?? (process.platform === 'darwin' && opts.native == null ? createMacosHelper() : undefined)
  const pidStore = opts.pidDeliveryStore ?? new PidDeliveryStore(opts.native == null ? defaultPidDeliveryPath() : undefined)
  const userGuard = opts.userActivityGuard ?? createUserActivityGuard({ native: n })
  // 7.6.1: the person's pause/stop state and the desktop status card. 7.7.0 (K5): the card is on by default on macOS,
  // the emergency chord is armed by default (macOS and Windows), and a person taking over the mouse or keyboard
  // during an action pauses the agent until they stop.
  const cardPresenter = opts.native == null && statusCardEnabled() ? defaultCardPresenter() : undefined
  let armedChord: string | null = null
  const wantedChord = opts.native == null ? emergencyChord() : null
  if (wantedChord && n.configureEmergencyStopChord) {
    try { armedChord = n.configureEmergencyStopChord(wantedChord)?.supported ? wantedChord : null } catch { armedChord = null }
  }
  const control = opts.operatorControl ?? new OperatorControl({
    native: n,
    chord: armedChord,
    ...(cardPresenter ? { card: { presenter: cardPresenter } } : {}),
    ...(takeoverEnabled() && typeof n.getPhysicalInputCounters === 'function' ? {
      takeover: {
        counters: () => { try { return n.getPhysicalInputCounters?.() } catch { return undefined } },
        idleMs: () => { try { return n.getUserIdleTimeMs?.() ?? null } catch { return null } },
      },
    } : {}),
  })
  // 7.7.0 (K5): keep the display awake while an agent works, released after ten quiet minutes or on close.
  const AWAKE_RELEASE_MS = 10 * 60_000
  let awakeTimer: ReturnType<typeof setTimeout> | undefined
  const keepAwake = () => {
    if (process.env.COMPUTER_USE_KEEP_AWAKE === 'false' || typeof n.holdDisplayAwake !== 'function') return
    try { n.holdDisplayAwake('computer-use-mcp: an agent is using this computer') } catch { return }
    if (awakeTimer) clearTimeout(awakeTimer)
    awakeTimer = setTimeout(() => { try { n.releaseDisplayAwake?.() } catch { /* best effort */ } }, AWAKE_RELEASE_MS)
    awakeTimer.unref?.()
  }
  // 7.7.0 (K5): a locked screen, a disconnected Remote Desktop session or the secure desktop takes no input and
  // shows nothing worth capturing; read the session state at most once a second.
  let sessionState: { at: number; refusal: Record<string, unknown> | undefined } | undefined
  const sessionRefusal = (tool: string): Record<string, unknown> | undefined => {
    if (typeof n.getSessionState !== 'function') return undefined
    const now = Date.now()
    if (!sessionState || now - sessionState.at > 1000) {
      let refusal: Record<string, unknown> | undefined
      try {
        const state = n.getSessionState()
        if (state.disconnected) refusal = { error: 'session_disconnected', message: 'The Remote Desktop session is disconnected.' }
        else if (state.locked === true) refusal = { error: 'screen_locked', message: 'The screen is locked.' }
        else if (state.offConsole) refusal = { error: 'screen_locked', message: 'Another user has the console (fast user switching).' }
        else if (state.secureDesktop) refusal = { error: 'secure_desktop', message: 'A UAC prompt or the sign-in screen has the input.' }
      } catch { refusal = undefined }
      sessionState = { at: now, refusal }
    }
    return sessionState.refusal ? { ...sessionState.refusal, tool } : undefined
  }
  // Start the native input monitor now: it counts its own start as input, so a
  // first reading taken at the first tool call would refuse that call.
  userGuard.activity()

  const virtualPointer = new VirtualPointerController(n)
  const spacesHandler = new SpacesHandler({ native: n, spawnBounded, sleep })
  const screenshotHandler = new ScreenshotHandler({
    native: n,
    targets: targetController,
    pointer: virtualPointer,
    visionEnabled,
    defaultProvider,
    ...(macosHelper ? { helper: macosHelper } : {}),
  })
  // 7.8: the live share watcher, idle until a host or the live tools start it; it shows on the card while it watches.
  const liveWatcher = new LiveWatcher({
    native: n,
    ...(macosHelper ? { helper: macosHelper } : {}),
    control,
    sensitiveApps: sensitiveApps(process.env, IS_WINDOWS),
  })

  const legacyPolicy = createLegacyPolicyRuntime({
    activeProfile,
    nativeInjected: opts.native != null,
    isWindows: IS_WINDOWS,
    hasElicitation: Boolean(elicitApproval),
    targetApp: args => targetController.targetAppForPolicy(args),
  })
  const { policyConfig, auditEnabled, auditLogPath } = legacyPolicy
  const policyStatus = legacyPolicy.status
  const evaluatePolicy = legacyPolicy.evaluate
  const redactAuditValue = legacyPolicy.redactAuditValue
  const writeAudit = legacyPolicy.writeAudit

  // ── Target resolution ───────────────────────────────────────────────────

  const focus = createFocusController({ native: n, sleep, guard: userGuard })
  const inputHandler = new InputHandler({
    native: n,
    targets: targetController,
    focus,
    sleep,
    guard: userGuard,
    pidStore,
    ...(macosHelper ? { helper: macosHelper } : {}),
    protectedRegion: () => control.cardRegion(),
    clearOfCard: points => control.clearOfCard(points),
    haltSignal: () => control.signal(),
    pointerMotion: opts.pointerMotion ?? pointerMotionFromEnv(),
  })
  const scripting = new ScriptingService({ native: n, spawnBounded })
  const runScriptHelper = scripting.runScript.bind(scripting)
  const getAppDictionary = scripting.getAppDictionary.bind(scripting)
  const getPowerShellExe = scripting.getPowerShellExe.bind(scripting)
  const openAiHandler = new OpenAiCompatibilityHandler(
    (tool, args, signal, onProgress, requestContext) => dispatch(tool, args, signal, onProgress, requestContext),
    () => screenshotHandler.lastMapping(),
  )
  const focusFailureText = (details: FocusFailure): string => JSON.stringify(details)

  // ── State update helpers ────────────────────────────────────────────────


  // ── Tool category helpers ───────────────────────────────────────────────


  // ── Coordinate validation ─────────────────────────────────────────────

  async function runDoctor(includeRemediation: boolean): Promise<Record<string, unknown>> {
    return runDoctorService({
      native: n,
      includeRemediation,
      spawnBounded,
      runScript: runScriptHelper,
      getPowerShellExe,
      policyConfig,
      policyStatus,
      auditEnabled,
      auditLogPath,
      controlStatus: () => control.status(),
      // 8.0: which addon loaded (only when this session loaded it; an embedding host's own native is its business).
      addon: () => (opts.native ? undefined : describeLoadedAddon()),
      agentDesktop: async () => {
        const availability = macosHelper ? await macosHelper.ensure() : null
        return {
          helper: availability
            ? availability.ok
              ? { ok: true, path: availability.path, sck: macosHelper!.supportsCapture() }
              : { ok: false, reason: availability.reason, remediation: availability.remediation }
            : null,
          guard: userGuard.status(),
          pidDelivery: pidStore.all() as unknown as Array<Record<string, unknown>>,
          pidSupported: inputHandler.pidDeliverySupported(),
        }
      },
    })
  }

  // ── Click helper ────────────────────────────────────────────────────────

  // ── Dispatch ────────────────────────────────────────────────────────────

  /** 7.7.0 (K1): a suggested next_call must be a tool this session can call (its profile and platform). */
  const profileName = parseProfile(activeProfile)
  const callable = (name: string): boolean => {
    const meta = getToolMeta(name)
    return Boolean(meta && toolInProfile(meta, profileName) && toolAvailableOn(meta, process.platform))
  }

  /** Every reply through the result contract: effect, route and delivery on actions; hint and next_call on refusals. */
  async function dispatchChecked(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: ProgressReporter,
    requestContext?: SessionRequestContext,
  ): Promise<ToolResult> {
    const result = await dispatchRaw(tool, args, signal, onProgress, requestContext)
    if (requestContext?.preflight) return result
    return applyContract(tool, withToolDefaults(tool, args), result, process.platform, callable)
  }

  /**
   * 8.0 (P2-11): every step tool that works is kept for export_steps, with the window it was aimed at. While a
   * recording is checked (export_steps start), an action is also captured before and after, a click first reads the
   * text under it, typing notes whether the focused field is sensitive, and a window that opens is noted.
   */
  async function dispatch(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: ProgressReporter,
    requestContext?: SessionRequestContext,
  ): Promise<ToolResult> {
    if (requestContext?.preflight || !STEP_TOOLS.has(tool)) return dispatchChecked(tool, args, signal, onProgress, requestContext)
    const window = windowFor(args)
    const checked = journal.recording && MUTATING_TOOLS.has(tool)
    const before = checked ? await beforeAction(tool, args, window, signal) : undefined
    const sent = checked && VERIFIABLE_TOOLS.has(tool) && args.verify !== true ? { ...args, verify: true } : args
    const result = await dispatchChecked(tool, sent, signal, onProgress, requestContext)
    if (result.isError) return result
    const entry: RecordInput = { tool, args: cleanArgs(args), checked, ...(window ? { window } : {}) }
    const effect = result.structuredContent?.effect
    if (typeof effect === 'string') entry.effect = effect as Effect
    if (before) Object.assign(entry, await afterAction(before, window, signal))
    journal.record(entry)
    return result
  }

  async function dispatchRaw(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: ProgressReporter,
    requestContext?: SessionRequestContext,
  ): Promise<ToolResult> {

    args = withToolDefaults(tool, coerceArguments(tool, args))

    // v5.2: Only mutating tools take the session lock and start the pump.
    // Observation tools stay concurrent and cheap.
    const startedAt = Date.now()
    const startedAtIso = new Date(startedAt).toISOString()
    const mutates = callMutates(tool, args)
    // Policy is unchanged by a read-only mode: approval rules name tools, and `COMPUTER_USE_REQUIRE_APPROVAL` still
    // covers every call of a mutating tool. Only the lock and the person's pause look at the call.
    let policyDecision = evaluatePolicy(tool, args, MUTATING_TOOLS.has(tool))

    // The native latch is process-global and outlives MCP connections. Apply
    // it to the dispatcher too so all mutation remains disabled while latched.
    if (mutates && n.isNativeEmergencyStopActive?.()) {
      const result = errJson({
        error: 'emergency_stop_active',
        message: 'all mutation is latched off until trusted host reset',
      })
      writeAudit({
        timestamp: startedAtIso,
        duration_ms: Date.now() - startedAt,
        tool,
        mutates,
        args: redactAuditValue('args', args),
        policy: policyDecision,
        result: { isError: true, text: result.content[0].type === 'text' ? result.content[0].text : undefined },
      })
      return result
    }

    // PR-10: elicitation before lock when approval required (K13 token already checked in evaluatePolicy)
    const requestElicitation = requestContext?.elicitApproval ?? elicitApproval
    if (!policyDecision.allowed && policyDecision.approval === 'required' && requestElicitation) {
      control.waiting('approval')
      try {
        const approved = await requestElicitation({
          tool,
          args,
          reasons: policyDecision.reasons,
          targetApp: policyDecision.targetApp,
          destructive: policyDecision.destructive,
        })
        if (approved) {
          policyDecision = { allowed: true, approval: 'approved', reasons: policyDecision.reasons, targetApp: policyDecision.targetApp, destructive: policyDecision.destructive }
        }
      } catch (error) {
        if (error && typeof error === 'object' && (error as { mcpInputRequired?: unknown }).mcpInputRequired === true) {
          throw error
        }
        // treat as denied / timeout
      } finally {
        control.waiting(null)
      }
    }

    if (!policyDecision.allowed) {
      const payload = {
        error: policyDecision.approval === 'required' ? 'approval_required' : 'policy_denied',
        reasons: policyDecision.reasons,
        target_app: policyDecision.targetApp,
        destructive: policyDecision.destructive,
        remediation: policyDecision.remediation,
      }
      const result = errJson(payload)
      writeAudit({
        timestamp: startedAtIso,
        duration_ms: Date.now() - startedAt,
        tool,
        mutates,
        args: redactAuditValue('args', args),
        policy: policyDecision,
        result: { isError: true, text: result.content[0].type === 'text' ? result.content[0].text : undefined },
      })
      return result
    }

    if (requestContext?.preflight) return { content: [{ type: 'text', text: JSON.stringify({ authorized: true, clientRoots: requestContext.clientRoots ?? opts.getClientRoots?.() }) }] }

    // 8.0: a password or a one-time code is the person's to type. On a sign-in or verification screen the call is
    // refused and the desktop handed to them until they press Resume.
    if (mutates && authHandoff && typesText(tool, args)) {
      const wall = await authWall(args, signal)
      if (wall) {
        const app = policyDecision.targetApp
        const message = wallMessage(wall, app)
        control.handOff({ kind: wall.kind, message, detected: true })
        // 8.0: it ends by itself once the window closes or moves on to something that is no wall.
        if (wall.window) watchHandOff({ mode: 'wall', windowId: wall.window.windowId, ...(wall.window.title ? { title: wall.window.title } : {}), source: wall.source })
        const result = errJson({
          error: 'sign_in_required', tool, kind: wall.kind, seen: wall.seen, asked: message,
          ...(wall.window ? { resumes_when: 'the person presses Resume, or the window closes or moves past the sign-in' } : {}),
          hint: `${wall.seen[0].toUpperCase()}${wall.seen.slice(1)}: the person was asked to do it. Tell them, then wait until control_status says running (it resumes when they finish, or on Resume).`.slice(0, 240),
        })
        writeAudit({
          timestamp: startedAtIso, duration_ms: Date.now() - startedAt, tool, mutates,
          args: redactAuditValue('args', args), policy: policyDecision,
          result: { isError: true, text: result.content[0].type === 'text' ? result.content[0].text : undefined },
        })
        return result
      }
    }

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
    focus.beginDispatch()

    let result: ToolResult
    try {
      result = await (async (): Promise<ToolResult> => {
      if (tool === 'run_steps') return runSteps(args, signal, requestContext)
      if (tool === 'export_steps') return exportStepsTool(args)
      if (tool === 'hand_off') return handOffTool(args, signal)
      if (tool === 'agent_pointer' && typeof args.text === 'string' && args.text) return pointAtText(args, signal)
      const clientRoots = requestContext?.clientRoots ?? opts.getClientRoots?.()
      const extracted = await handleAdminTool(tool, args, {
        spawnBounded,
        getPowerShellExe,
        ...(clientRoots !== undefined ? { clientRoots } : {}),
        ...(signal ? { signal } : {}),
        ...(onProgress ? { onProgress } : {}),
      })
      if (extracted) return extracted
      const browserResult = await handleBrowserTool(tool, args, {
        spawnBounded,
        ...(signal ? { signal } : {}),
      })
      if (browserResult) return browserResult
      const windowResult = await handleWindowTool(tool, args, {
        native: n,
        targets: targetController,
        defaultProvider,
        sleep,
        sleepAbortable,
        runScript: runScriptHelper,
        guard: userGuard,
        ...(signal ? { signal } : {}),
      })
      if (windowResult) {
        if (tool === 'unhide_app' && !windowResult.isError && typeof args.bundle_id === 'string') focus.forgetHidden(args.bundle_id)
        return windowResult
      }
      const agentDesktopResult = await handleAgentDesktopTool(tool, args, {
        native: n,
        targets: targetController,
        input: inputHandler,
        sleepAbortable,
        ...(macosHelper ? { helper: macosHelper } : {}),
        ...(signal ? { signal } : {}),
      })
      if (agentDesktopResult) return agentDesktopResult
      const accessibilityContext = {
        native: n,
        targets: targetController,
        focus,
        activeProfile,
        sleep,
        runScript: runScriptHelper,
        getAppDictionary,
        pidDelivery: (bundleId: string) => pidStore.get(bundleId) ?? null,
        input: inputHandler,
        ...(signal ? { signal } : {}),
      }
      const linuxResult = process.platform === 'linux' && !opts.native
        ? await handleLinuxAccessibility(tool, args, accessibilityContext, spawnBounded) : undefined
      if (linuxResult) return linuxResult
      if (tool === 'discover_applications') return okJson(await discoverApplications(args, {
        platform: process.platform, spawn: spawnBounded, signal, running: n.listRunningApps(),
        capabilities: async id => {
          const result = await handleAccessibilityTool('get_app_capabilities', { bundle_id: id }, accessibilityContext)
          return result?.structuredContent ?? JSON.parse(result?.content.find(c => c.type === 'text')?.text ?? 'null')
        },
      }))
      const accessibilityResult = await handleAccessibilityTool(tool, args, accessibilityContext)
      if (accessibilityResult) return accessibilityResult
      const spacesResult = await spacesHandler.handle(tool, args)
      if (spacesResult) return spacesResult
      const screenshotResult = await screenshotHandler.handleAsync(tool, args, signal)
      if (screenshotResult) return screenshotResult
      const inputResult = await inputHandler.handle(tool, args, signal)
      if (inputResult) return inputResult
      const compatibilityResult = await openAiHandler.handle(tool, args, signal, onProgress, requestContext)
      if (compatibilityResult) return compatibilityResult
      const coreResult = await handleCoreTool(tool, args, {
        runDoctor,
        policyStatus,
        pointer: virtualPointer,
        controlStatus: () => control.status(),
      })
      if (coreResult) return coreResult
      return { content: [{ type: 'text', text: `Unknown tool: ${tool}` }], isError: true }
      })()
    } catch (err: unknown) {
      if (err instanceof FocusError) {
        result = { content: [{ type: 'text', text: focusFailureText(err.details) }], isError: true }
      } else if (err instanceof StructuredToolError) {
        result = errJson(err.details)
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
    const pendingHiddenBundleIds = focus.hiddenBundleIds()
    if (pendingHiddenBundleIds != null) {
      result = decorateWithHiddenBundleIds(result, pendingHiddenBundleIds)
    }
    writeAudit({
      timestamp: startedAtIso,
      duration_ms: Date.now() - startedAt,
      tool,
      mutates,
      args: redactAuditValue('args', args),
      target_app: policyDecision.targetApp,
      focus_strategy: typeof args.focus_strategy === 'string' ? args.focus_strategy : undefined,
      policy: policyDecision,
      screenshot_hash: tool === 'screenshot' ? screenshotHandler.lastHash() : undefined,
      result: {
        isError: Boolean(result.isError),
        content: result.content.map(c => c.type === 'image'
          ? { type: 'image', mimeType: c.mimeType, bytesBase64: c.data.length }
          : c.type === 'resource_link'
            ? { type: 'resource_link', uri: c.uri }
            : { type: 'text', length: c.text.length, hmac_sha256: legacyPolicy.digestText(c.text) }),
      },
    })
    return result
  }

  // ── Record and replay (8.0, P2-11) ────────────────────────────────────────

  const journal = new StepJournal()
  const CLICK_TOOLS = new Set(['click', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click'])

  /** The window a call is aimed at: its window id, its app's main (or titled) window, or the session target's. */
  const windowFor = (args: Record<string, unknown>): JournalWindow | undefined => {
    try {
      const id = typeof args.window_id === 'number' ? args.window_id : typeof args.target_window_id === 'number' ? args.target_window_id : undefined
      const title = typeof args.target_title === 'string' && args.target_title ? args.target_title : undefined
      const app = typeof args.target_app === 'string' && args.target_app ? args.target_app
        : typeof args.bundle_id === 'string' && args.bundle_id ? args.bundle_id : undefined
      const remembered = id === undefined && app === undefined ? targetController.observationWindow() : undefined
      const record = id !== undefined ? n.getWindow(id)
        : app !== undefined ? resolveAppWindow(n, app, title)
          : remembered !== undefined ? n.getWindow(remembered) : undefined
      if (!record) return undefined
      return {
        windowId: record.windowId,
        ...(record.bundleId ? { bundleId: record.bundleId } : {}),
        ...(record.title ? { title: record.title } : {}),
        bounds: { x: record.bounds.x, y: record.bounds.y, width: record.bounds.width, height: record.bounds.height },
      }
    } catch { return undefined }
  }

  /** A hash of a window, or of a region of it ([x, y, width, height] in window points); undefined when it cannot be captured. */
  const hashWindow = async (windowId: number | undefined, region?: readonly number[], signal?: AbortSignal): Promise<string | undefined> => {
    try {
      if (windowId !== undefined && macosHelper?.supportsCapture()) {
        const area = region && region.length === 4 ? { x: region[0], y: region[1], width: region[2], height: region[3] } : undefined
        return (await macosHelper.capture({ windowId, width: 480, format: 'jpeg', quality: 60, ...(area ? { region: area } : {}) }, signal)).hash
      }
      return (await offThread(n, 'takeScreenshot', 480, undefined, 60, undefined, windowId)).hash
    } catch { return undefined }
  }

  interface BeforeAction { hash?: string; ownHash: boolean; app?: string; windows?: Set<number>; under?: RecordInput['under']; sensitive?: boolean }

  async function beforeAction(tool: string, args: Record<string, unknown>, window: JournalWindow | undefined, signal?: AbortSignal): Promise<BeforeAction> {
    const before: BeforeAction = { ownHash: !VERIFIABLE_TOOLS.has(tool) }
    const app = window?.bundleId ?? (typeof args.target_app === 'string' && args.target_app ? args.target_app : undefined)
    if (app) {
      before.app = app
      try { before.windows = new Set(n.listWindows(app).map(record => record.windowId)) } catch { /* no window list */ }
    }
    if (before.ownHash) before.hash = await hashWindow(window?.windowId, undefined, signal)
    const point = Array.isArray(args.coordinate) && typeof args.coordinate[0] === 'number' && typeof args.coordinate[1] === 'number'
      ? args.coordinate as [number, number] : undefined
    if (CLICK_TOOLS.has(tool) && window && point && macosHelper) {
      // A band around the click, not the whole window: Vision joins neighbouring labels into one long line, and a
      // word's place inside a long line is only estimated (15 points out on Blender's header). The export keeps the band.
      const wx = point[0] - window.bounds.x
      const wy = point[1] - window.bounds.y
      const width = Math.min(240, Math.round(window.bounds.width))
      const height = Math.min(36, Math.round(window.bounds.height))
      const x = Math.max(0, Math.min(Math.round(wx - width / 2), Math.round(window.bounds.width) - width))
      const y = Math.max(0, Math.min(Math.round(wy - height / 2), Math.round(window.bounds.height) - height))
      try {
        const ocr = await macosHelper.ocr({ windowId: window.windowId, region: { x, y, width, height } }, signal)
        const under = textUnder(mapOcrLines(ocr, window.bounds), wx, wy)
        if (under) before.under = { ...under, region: [x, y, width, height] }
      } catch { /* no text under the click */ }
    }
    if (tool === 'type' && typeof n.getFocusedElement === 'function') {
      try { if (n.getFocusedElement()?.sensitive === true) before.sensitive = true } catch { /* unknown */ }
    }
    return before
  }

  async function afterAction(before: BeforeAction, window: JournalWindow | undefined, signal?: AbortSignal): Promise<Partial<RecordInput>> {
    const after: Partial<RecordInput> = {}
    if (before.ownHash) {
      await sleep(250)
      const hash = await hashWindow(window?.windowId, undefined, signal)
      if (before.hash && hash) after.effect = before.hash === hash ? 'no_visible_change' : 'changed'
    }
    if (before.under) after.under = before.under
    if (before.sensitive) after.sensitive = true
    if (before.app && before.windows) {
      try {
        const known = before.windows
        if (n.listWindows(before.app).some(record => !known.has(record.windowId))) {
          const opened = listClassifiedWindows(n, before.app, { ax: true }).find(record => !known.has(record.windowId))
          if (opened) after.opened = { kind: opened.kind, ...(opened.title ? { title: opened.title } : {}) }
        }
      } catch { /* no window list */ }
    }
    return after
  }

  /** export_steps: start (checked recording), stop, or export (default) the actions that worked as run_steps batches. */
  function exportStepsTool(args: Record<string, unknown>): ToolResult {
    if (args.action === 'start') {
      const since = journal.start()
      return okJson({
        recording: true, since,
        message: 'Recording: each action is now captured before and after, a click reads the text under it, and a window that opens is noted. Do the task, then call export_steps.',
      })
    }
    const startedAt = args.action === 'stop' ? journal.stop() : undefined
    const range = typeof args.since === 'number' ? { since: args.since }
      : typeof args.last === 'number' ? { last: args.last }
        : startedAt !== undefined ? { since: startedAt } : {}
    const selected = journal.select(range)
    const exported = exportSteps(selected)
    const oldest = journal.oldestSeq()
    const notes: string[] = []
    if (selected.length === 0) notes.push('Nothing to export: actions are recorded as they succeed (run_steps steps included).')
    else notes.push(`Replay with run_steps, passing ${exported.batches.length === 1 ? 'the batch' : 'each batch in turn'} as its arguments.`)
    if (exported.unchecked.length) notes.push(`Steps ${exported.unchecked.join(', ')} have no expect (nothing confirmed what they did); add one, or record with export_steps start.`)
    if (exported.redacted.length) notes.push(`Steps ${exported.redacted.join(', ')} hold a redacted value; run_steps refuses them until it is filled in.`)
    if (typeof range.since === 'number' && oldest !== undefined && range.since + 1 < oldest) notes.push(`Only actions from ${oldest} on are kept (the last 300).`)
    return okJson({
      count: selected.length,
      ...(selected.length ? { from_seq: selected[0].seq, to_seq: selected[selected.length - 1].seq } : {}),
      next_since: journal.lastSeq,
      recording: journal.recording,
      batches: exported.batches,
      // 8.0: when each exported step's action finished, in ms after the first, in step order across the batches.
      ...(selected.length ? { started_at: new Date(selected[0].at).toISOString(), offsets_ms: selected.map(entry => entry.at - selected[0].at) } : {}),
      ...(exported.unchecked.length ? { unchecked: exported.unchecked } : {}),
      ...(exported.redacted.length ? { redacted: exported.redacted } : {}),
      ...(exported.converted.length ? { by_text: exported.converted } : {}),
      hint: notes.join(' '),
    })
  }

  /**
   * agent_pointer with text: find the text by OCR in the target window and move the pointer to it, for the person to
   * see (guide mode). Nothing is clicked, focused or moved but the overlay.
   */
  async function pointAtText(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    const text = String(args.text)
    if (!callable('read_window_text')) {
      return errJson({ error: 'platform_unsupported', tool: 'agent_pointer', message: 'Pointing at text needs OCR (macOS); pass coordinate instead.' })
    }
    // Any window of the app (target_window_id, or target_app with target_title), and a region of it, as read_window_text takes them.
    const target: Record<string, unknown> = {}
    for (const key of ['target_app', 'target_window_id', 'target_title', 'region']) if (args[key] !== undefined) target[key] = args[key]
    const read = await dispatchChecked('read_window_text', target, signal)
    if (read.isError) return read
    const body = (read.structuredContent ?? {}) as { lines?: Array<{ text: string; confidence: number; box: { x: number; y: number; w: number; h: number } }>; screen_origin?: { x: number; y: number } }
    const lines = body.lines ?? []
    // The label itself before a longer word that contains it ("View" before "ViewLayer").
    const origin = body.screen_origin ?? { x: 0, y: 0 }
    const word = `(?<![A-Za-z0-9])${text.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`
    const exact = findText(lines, text, 'exact', origin)
    let whole: ReturnType<typeof findText> = []
    try { whole = findText(lines, word, 'regex', origin) } catch { whole = [] }
    const matches = exact.length ? exact : whole.length ? whole : findText(lines, text, 'contains', origin)
    const nth = typeof args.nth === 'number' && args.nth >= 1 ? Math.floor(args.nth) : 1
    if (matches.length < nth) {
      return errJson({
        error: 'text_not_found', tool: 'agent_pointer', text, nth, matches: matches.length,
        similar: similarLines(lines, text), seen: lines.slice(0, 30).map(line => line.text),
        hint: 'The text was not read there; check similar and seen for how it was read, narrow it with region, or point with coordinate.',
      })
    }
    const chosen = matches[nth - 1]
    virtualPointer.move(chosen.point.x, chosen.point.y, true)
    return okJson({
      ...virtualPointer.current(),
      pointed_at: { text: chosen.matched, line: chosen.line.text, screen: chosen.point },
      matches: matches.length,
      ...(typeof args.label === 'string' && args.label ? { label: args.label } : {}),
      nativeOverlay: virtualPointer.syncOverlay(args.native_overlay !== false),
      note: 'Pointer overlay only; nothing was clicked and the cursor and focus did not change.',
    })
  }

  // ── Hand-off to the person (8.0) ──────────────────────────────────────────

  const authHandoff = opts.authHandoff ?? authHandoffEnabled()
  const wallCache = new Map<number, { at: number; wall: Wall | undefined }>()

  /**
   * Whether the agent is about to type into a sign-in or verification screen: the focused field first (a protected
   * field is a wall; a plain field the accessibility tree knows is not), then the window's title, then for browsers,
   * whose page fields are often not in the tree, the window's text by OCR (kept 3 s per window).
   */
  async function authWall(args: Record<string, unknown>, signal?: AbortSignal): Promise<FoundWall | undefined> {
    let focused: ReturnType<NativeModule['getFocusedElement']> = null
    try { focused = typeof n.getFocusedElement === 'function' ? n.getFocusedElement() : null } catch { focused = null }
    const byFocus = focusWall(focused)
    if (byFocus === 'none') return undefined
    const window = windowFor(args)
    if (byFocus) return { ...byFocus, source: 'focus', window }
    const byTitle = titleWall(window?.title)
    if (byTitle) return { ...byTitle, source: 'title', window }
    const wall = window ? await browserTextWall(window, signal) : undefined
    return wall ? { ...wall, source: 'text', window } : undefined
  }

  /** A browser window's text, read by OCR (macOS), as a wall or none; kept 3 s per window. */
  async function browserTextWall(window: JournalWindow, signal?: AbortSignal, fresh = false): Promise<Wall | undefined> {
    if (!macosHelper || !window.bundleId || !BROWSERS.has(window.bundleId)) return undefined
    const cached = wallCache.get(window.windowId)
    if (!fresh && cached && Date.now() - cached.at < 3000) return cached.wall
    let wall: Wall | undefined
    try {
      const ocr = await macosHelper.ocr({ windowId: window.windowId, fast: true }, signal)
      wall = textWall(mapOcrLines(ocr, window.bounds).map(line => line.text))
    } catch { wall = undefined }
    wallCache.set(window.windowId, { at: Date.now(), wall })
    return wall
  }

  // ── The hand-off ends by itself (8.0, roadmap H1) ─────────────────────────
  //
  // A hand-off used to end only on Resume or `hand_off done`. Now a watcher ends it when what the person was asked to
  // do is visibly done: the sign-in window closed or moved on to a page that is no wall, the window named in
  // `done_when: window_gone` closed, or the text named in `done_when: text_gone` left the window. It must hold on two
  // polls in a row, and a person's own pause is never ended by it (`endHandOff` resumes only a hand-off).

  let handOffWatch: ReturnType<typeof setInterval> | undefined

  function stopHandOffWatch(): void {
    if (handOffWatch) clearInterval(handOffWatch)
    handOffWatch = undefined
  }

  /** Whether the watched condition holds now: the hand-off's work looks done. */
  async function handOffDone(watch: HandOffWatch): Promise<boolean> {
    const record = (() => { try { return n.getWindow(watch.windowId) } catch { return null } })()
    if (!record) return true // the window closed
    if (watch.mode === 'window_gone') return false
    if (watch.mode === 'text_gone') {
      if (!macosHelper || !watch.text) return false
      try {
        const ocr = await macosHelper.ocr({ windowId: watch.windowId, fast: true })
        return findText(mapOcrLines(ocr, record.bounds), watch.text, 'contains').length === 0
      } catch { return false }
    }
    if (watch.mode !== 'wall') return false
    // A detected wall: the window moved on (its title changed) to something that is no wall.
    const title = record.title ?? ''
    if (title === (watch.title ?? '') || titleWall(title)) return false
    // In a browser the next page (a code prompt after the password) can carry a neutral title, so its text is read
    // again whatever showed the wall first; any other window has moved on.
    const now: JournalWindow = { windowId: record.windowId, ...(record.bundleId ? { bundleId: record.bundleId } : {}), title, bounds: record.bounds }
    return !(await browserTextWall(now, undefined, true))
  }

  function watchHandOff(watch: HandOffWatch): void {
    stopHandOffWatch()
    let met = 0
    let busy = false
    const timer = setInterval(() => {
      if (busy) return
      if (!control.status().handoff || control.state() === 'stopped') { stopHandOffWatch(); return }
      busy = true
      void handOffDone(watch).then(done => {
        met = done ? met + 1 : 0
        if (met >= 2 && handOffWatch === timer) {
          stopHandOffWatch()
          wallCache.clear()
          control.endHandOff()
        }
      }, () => { met = 0 }).finally(() => { busy = false })
    }, opts.handOffPollMs ?? HANDOFF_POLL_MS)
    timer.unref?.()
    handOffWatch = timer
  }

  /** hand_off: ask the person to do something only they should do; done: they said it is finished. */
  async function handOffTool(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
    if (args.action === 'done') {
      const resumed = control.endHandOff()
      stopHandOffWatch()
      wallCache.clear()
      return okJson({ resumed, state: control.state(), ...(resumed ? {} : { message: 'Nothing was handed off; control_status says the state.' }) })
    }
    const message = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : 'Finish this step yourself.'
    const kind = typeof args.kind === 'string' ? args.kind : 'other'
    // 8.0: done_when names what ends it besides Resume: the target window closing, or text leaving it.
    const doneWhen = args.done_when === 'window_gone' || args.done_when === 'text_gone' ? args.done_when : 'resume'
    let watch: HandOffWatch | undefined
    if (doneWhen !== 'resume') {
      const text = typeof args.text === 'string' && args.text.trim() ? args.text.trim() : undefined
      if (doneWhen === 'text_gone' && !text) return errJson({ error: 'invalid_arguments', tool: 'hand_off', message: 'done_when text_gone needs text: what should leave the window.' })
      if (doneWhen === 'text_gone' && !callable('read_window_text')) {
        return errJson({ error: 'platform_unsupported', tool: 'hand_off', message: 'done_when text_gone needs OCR (macOS); use window_gone, or resume.' })
      }
      const window = windowFor(args)
      if (!window) return errJson({ error: 'window_not_found', tool: 'hand_off', message: `done_when ${doneWhen} needs the window to watch: target_app (or set_target) with the window on screen.` })
      watch = { mode: doneWhen, windowId: window.windowId, ...(window.title ? { title: window.title } : {}), ...(text ? { text } : {}) }
    }
    if (!control.handOff({ kind, message })) {
      return errJson({ error: 'stopped_by_user', tool: 'hand_off', message: 'The person stopped the agent; report what you have and finish.' })
    }
    if (watch) watchHandOff(watch)
    const card = control.status().card
    const waitMs = typeof args.wait_ms === 'number' ? Math.min(600_000, Math.max(0, args.wait_ms)) : 0
    const started = Date.now()
    while (waitMs > 0 && control.state() === 'paused' && Date.now() - started < waitMs && !signal?.aborted) await sleep(250)
    const resumed = control.state() === 'running'
    return okJson({
      handed_off: true, asked: message, resumed, waitedMs: Date.now() - started,
      ...(watch ? { done_when: doneWhen } : {}),
      hint: resumed ? 'The person resumed: look at the screen before going on.'
        : watch ? `It ends when the person presses Resume or ${doneWhen === 'window_gone' ? 'the window closes' : 'the text leaves the window'}; wait (control_status, or hand_off with wait_ms) until it says running.`
        : card.enabled ? 'The status card asks the person and shows Resume. Tell them too; wait (control_status, or hand_off with wait_ms) until it says running.'
          : 'No status card here: ask the person in the conversation, and when they say it is done call hand_off with action done.',
    })
  }

  // ── run_steps (7.7.0, K2) ─────────────────────────────────────────────────

  const STEP_TOOLS = new Set<string>(RUN_STEP_TOOLS)
  const EFFECT_RANK: Record<Effect, number> = { no_visible_change: 0, unverified: 1, changed: 2, verified: 3 }

  /**
   * Several actions in one call: every step checked before any runs (tool allowed, callable here, arguments valid),
   * each step dispatched exactly as a direct call would be (policy, approval, the person's pause and stop, the lock,
   * the result contract), stopping at the first failure, with one optional capture at the end. The target is focused
   * by the first step that needs it; later steps find it in front and skip activating it.
   */
  async function runSteps(args: Record<string, unknown>, signal: AbortSignal | undefined, requestContext?: SessionRequestContext): Promise<ToolResult> {
    const steps = Array.isArray(args.steps) ? args.steps as Array<{ tool?: unknown; args?: unknown }> : []
    if (steps.length === 0) throw new Error('Invalid steps: expected at least one {tool, args}')
    const batchTarget: Record<string, unknown> = {
      ...(typeof args.target_app === 'string' && args.target_app ? { target_app: args.target_app } : {}),
      ...(typeof args.target_window_id === 'number' ? { target_window_id: args.target_window_id } : {}),
    }
    const planned: Array<{ tool: string; args: Record<string, unknown>; expect?: Record<string, unknown>; own: boolean }> = []
    const problems: Array<Record<string, unknown>> = []
    steps.forEach((step, index) => {
      const name = typeof step?.tool === 'string' ? step.tool : ''
      const given = step?.args && typeof step.args === 'object' ? step.args as Record<string, unknown> : {}
      const expect = step && typeof (step as { expect?: unknown }).expect === 'object' && (step as { expect?: unknown }).expect !== null
        ? (step as { expect: Record<string, unknown> }).expect : undefined
      if (!STEP_TOOLS.has(name)) { problems.push({ index, tool: name || null, message: 'not allowed in run_steps' }); return }
      if (!callable(name)) { problems.push({ index, tool: name, message: 'not available in this profile or on this platform' }); return }
      // 8.0: an exported step whose secret was redacted is never sent as the placeholder.
      if (holdsRedaction(given)) { problems.push({ index, tool: name, message: `holds "${REDACTED}": put the real value in first` }); return }
      if (expect && typeof expect.text === 'string' && !callable('wait_for_text')) {
        problems.push({ index, tool: name, message: 'expect.text needs OCR (macOS); use expect.changed or expect.window here' }); return
      }
      // A step without its own target uses the batch's, when the tool takes one.
      const takesTarget = name !== 'wait' && name !== 'write_clipboard'
      const hasOwn = given.target_app !== undefined || given.target_window_id !== undefined || given.window_id !== undefined
      const merged = takesTarget && !hasOwn && !['click_element', 'set_value', 'press_button', 'fill_form'].includes(name)
        ? { ...batchTarget, ...given }
        : { ...given }
      if ((name === 'click_element' || name === 'set_value' || name === 'press_button' || name === 'fill_form')
        && merged.window_id === undefined && typeof batchTarget.target_window_id === 'number') merged.window_id = batchTarget.target_window_id
      const checked = opts.validateArguments ? opts.validateArguments(name, merged) : { ok: true as const, args: merged }
      if (!checked.ok) problems.push({ index, tool: name, issues: checked.issues })
      else planned.push({ tool: name, args: checked.args, ...(expect ? { expect } : {}), own: hasOwn || given.target_title !== undefined })
    })
    if (problems.length > 0) {
      return errJson({
        error: 'invalid_arguments', tool: 'run_steps',
        message: 'No step ran: fix the listed steps and call again.',
        issues: problems,
      })
    }

    // 8.0: steps recorded with the window's frame move with the window; a window of another size refuses them all.
    let offset: [number, number] | undefined
    if (Array.isArray(args.frame) && args.frame.length === 4) {
      const [fx, fy, fw, fh] = args.frame as number[]
      const window = windowFor(batchTarget)
      if (!window) {
        return errJson({ error: 'window_not_found', tool: 'run_steps', message: 'No step ran: frame needs the target window on screen (target_app, target_window_id or set_target).' })
      }
      const { x, y, width, height } = window.bounds
      if (Math.abs(width - fw) > 2 || Math.abs(height - fh) > 2) {
        return errJson({
          error: 'frame_changed', tool: 'run_steps',
          message: `No step ran: the window is ${width}x${height}; the steps were recorded at ${fw}x${fh}.`,
          recorded: [fx, fy, fw, fh], now: [x, y, width, height],
        })
      }
      if (x !== fx || y !== fy) {
        offset = [x - fx, y - fy]
        for (const step of planned) {
          if (step.own) continue
          for (const key of ['coordinate', 'start_coordinate', 'path']) {
            if (step.args[key] !== undefined) step.args[key] = shiftPoints(step.args[key], offset[0], offset[1])
          }
        }
      }
    }

    const records: Array<Record<string, unknown>> = []
    let failed: { index: number; result: ToolResult } | undefined
    let weakest: Effect = 'verified'
    // 8.0 (18a): soft checks that did not hold; reported, and the batch goes on.
    const softUnmet: Array<Record<string, unknown>> = []
    // 8.0: when each step started and how long it took, so chapters, captions and narration line up with a recording.
    const batchStarted = Date.now()
    for (const [index, step] of planned.entries()) {
      // The person's pause or stop first: it also aborts the signal, and its refusal says more than "aborted".
      if (MUTATING_TOOLS.has(step.tool)) {
        const refusal = control.gate(step.tool)
        if (refusal) {
          failed = { index, result: errJson(refusal) }
          records.push({ index, tool: step.tool, ok: false, error: refusal.error })
          break
        }
      }
      if (signal?.aborted) {
        failed = { index, result: errJson({ error: 'aborted', message: 'The batch was cancelled before this step.' }) }
        records.push({ index, tool: step.tool, ok: false, error: 'aborted' })
        break
      }
      control.begin(describeAction(step.tool, step.args, resolvedFor(step.args)), { mutates: MUTATING_TOOLS.has(step.tool) })
      const checkTarget = expectTarget(batchTarget, step.args)
      const region = Array.isArray(step.expect?.region) && step.expect.region.length === 4 ? step.expect.region as number[] : undefined
      const beforeHash = typeof step.expect?.changed === 'boolean' ? await hashWindow(windowFor(checkTarget)?.windowId, region, signal) : undefined
      const stepStarted = Date.now()
      const seqBefore = journal.lastSeq
      const result = await dispatch(step.tool, step.args, signal, undefined, requestContext)
      control.finish(result.isError ? 'failed' : 'done')
      const reply = result.structuredContent ?? {}
      const summary = result.content.find(block => block.type === 'text')
      const record: Record<string, unknown> = {
        index, tool: step.tool, ok: !result.isError,
        at_ms: stepStarted - batchStarted, ms: Date.now() - stepStarted,
        ...(summary && summary.type === 'text' ? { summary: summary.text.slice(0, 200) } : {}),
      }
      for (const key of ['effect', 'route', 'delivery', 'error', 'hint'] as const) if (reply[key] !== undefined) record[key] = reply[key]
      records.push(record)
      if (result.isError) { failed = { index, result }; break }
      if (step.expect) {
        const missed = await unmetExpect(step.expect, checkTarget, beforeHash, region, signal)
        record.expect = missed ? 'unmet' : 'met'
        // An authored check that held is what a replay of this step should check: export_steps keeps it (T8).
        if (!missed && journal.lastSeq > seqBefore) journal.annotate(journal.lastSeq, { expect: step.expect })
        if (missed && step.expect.soft === true) {
          record.soft = true
          softUnmet.push({ index, tool: step.tool, ...missed })
        } else if (missed) {
          failed = {
            index,
            result: errJson({
              error: 'expect_failed', expect: step.expect, ...missed,
              hint: `${String(missed.message)} Look, then fix this step or the state before it.`.slice(0, 240),
              next_call: { tool: 'screenshot', arguments: targetArgs(checkTarget) },
            }),
          }
          break
        }
      }
      const effect = reply.effect as Effect | undefined
      if (effect && EFFECT_RANK[effect] < EFFECT_RANK[weakest]) weakest = effect
      if (!effect && MUTATING_TOOLS.has(step.tool) && EFFECT_RANK.unverified < EFFECT_RANK[weakest]) weakest = 'unverified'
    }
    for (let index = records.length; index < planned.length; index++) {
      records.push({ index, tool: planned[index].tool, ok: false, status: 'not_run' })
    }

    // One capture at the end: the window (or a region of it) or the screen, sent even when unchanged.
    const capture = args.capture === 'window' || args.capture === 'screen' ? args.capture : 'none'
    let images: ToolResult['content'] = []
    if (capture !== 'none' && !signal?.aborted) {
      const region = Array.isArray(args.region) && args.region.length === 4 ? args.region : undefined
      const shot = capture === 'window' && region
        ? await dispatch('zoom', { ...batchTarget, region }, signal, undefined, requestContext)
        : await dispatch('screenshot', capture === 'screen' ? { full_screen: true, resend: true } : { ...batchTarget, resend: true }, signal, undefined, requestContext)
      images = shot.isError ? [] : shot.content
    }

    const completed = records.filter(record => record.ok === true).length
    const payload: Record<string, unknown> = {
      completed, total: planned.length, stopped_at: failed?.index ?? null, steps: records,
      ...(softUnmet.length ? { soft_unmet: softUnmet } : {}),
      ...(offset ? { shifted: offset } : {}),
    }
    if (failed) {
      // The steps before the failure ran and changed things; the reply says which, why the batch stopped, and the
      // failing step's own advice.
      const reason = failed.result.structuredContent ?? {}
      const stepTool = planned[failed.index].tool
      const refusal: Record<string, unknown> = {
        ...payload,
        error: 'step_failed',
        failed_step: { index: failed.index, tool: stepTool, ...reason },
        ...(typeof reason.hint === 'string' ? { hint: `Step ${failed.index + 1} (${stepTool}) failed: ${reason.hint}`.slice(0, 240) } : {}),
        ...(reason.next_call ? { next_call: reason.next_call } : {}),
      }
      return { content: [{ type: 'text', text: JSON.stringify(refusal) }, ...images], structuredContent: refusal, isError: true }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }, ...images],
      structuredContent: payload,
      contract: {
        effect: weakest,
        ...(weakest === 'verified' ? {} : {
          hint: images.length ? 'Every step ran; the capture above shows the result. Check it before the next step.'
            : 'Every step ran; nothing confirms the unverified ones landed. Look before relying on them, or pass capture.',
        }),
      },
    }
  }

  /** Move a point, or every point of a path, by (dx, dy). */
  function shiftPoints(value: unknown, dx: number, dy: number): unknown {
    if (!Array.isArray(value)) return value
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') return [value[0] + dx, value[1] + dy, ...value.slice(2)]
    return value.map(point => shiftPoints(point, dx, dy))
  }

  /** Where a step's expect is checked: the step's own target, else the batch's. */
  function expectTarget(batchTarget: Record<string, unknown>, stepArgs: Record<string, unknown>): Record<string, unknown> {
    const own: Record<string, unknown> = {}
    for (const key of ['target_app', 'target_window_id', 'target_title']) if (stepArgs[key] !== undefined) own[key] = stepArgs[key]
    if (typeof stepArgs.window_id === 'number' && own.target_window_id === undefined) own.target_window_id = stepArgs.window_id
    return own.target_app !== undefined || own.target_window_id !== undefined ? own : { ...batchTarget, ...own }
  }

  /**
   * 8.0: check a step's expect after it ran. undefined when it holds; otherwise what was seen instead, with a message.
   * changed polls the window (or region) until it differs from before the step; window and text wait for them.
   */
  async function unmetExpect(
    expect: Record<string, unknown>, target: Record<string, unknown>, beforeHash: string | undefined,
    region: number[] | undefined, signal?: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    const timeout = typeof expect.timeout_ms === 'number' ? Math.min(30_000, Math.max(0, expect.timeout_ms)) : undefined
    const gone = expect.gone === true
    if (typeof expect.changed === 'boolean') {
      const windowId = windowFor(target)?.windowId
      if (!beforeHash) return { saw: { changed: null }, message: 'The target could not be captured before the step, so a change could not be checked.' }
      const wait = timeout ?? (expect.changed ? 2000 : 300)
      const deadline = Date.now() + wait
      let after: string | undefined
      if (expect.changed) {
        for (;;) {
          after = await hashWindow(windowId, region, signal)
          if ((after && after !== beforeHash) || Date.now() >= deadline || signal?.aborted) break
          await sleep(100)
        }
        if (!after || after === beforeHash) return { saw: { changed: false }, message: `Nothing changed in the ${region ? 'region' : 'window'} within ${wait} ms.` }
      } else {
        await sleep(wait)
        after = await hashWindow(windowId, region, signal)
        if (after && after !== beforeHash) return { saw: { changed: true }, message: `The ${region ? 'region' : 'window'} changed; this step was expected to leave it as it was.` }
      }
    }
    if (expect.window && typeof expect.window === 'object') {
      const wanted = expect.window as Record<string, unknown>
      const app = typeof target.target_app === 'string' ? target.target_app : windowFor(target)?.bundleId
      if (!app) return { saw: { window: null }, message: 'expect.window needs the app: give the batch a target_app.' }
      const waited = await dispatchChecked('wait_for_window', {
        target_app: app, ...(typeof wanted.kind === 'string' ? { kind: wanted.kind } : {}),
        ...(typeof wanted.title === 'string' ? { title: wanted.title } : {}), ...(gone ? { gone: true } : {}),
        timeout_ms: timeout ?? 3000,
      }, signal)
      if (waited.isError) {
        const name = `${typeof wanted.kind === 'string' ? `${wanted.kind} ` : ''}window${typeof wanted.title === 'string' ? ` "${wanted.title}"` : ''}`
        return { saw: { windows: waited.structuredContent?.windows ?? null }, message: gone ? `The ${name} did not close.` : `No ${name} appeared.` }
      }
    }
    if (typeof expect.text === 'string' && expect.text) {
      const match = expect.match === 'exact' || expect.match === 'regex' ? expect.match : undefined
      const waited = await dispatchChecked('wait_for_text', {
        ...target, text: expect.text, ...(match ? { match } : {}), ...(gone ? { gone: true } : {}), ...(region ? { region } : {}),
        timeout_ms: timeout ?? 3000,
      }, signal)
      if (waited.isError) {
        return { saw: { seen: waited.structuredContent?.seen ?? null }, message: gone ? `"${expect.text}" was still there.` : `"${expect.text}" did not appear.` }
      }
    }
    return undefined
  }

  /** The app and window a call is aimed at, as the policy and the target state resolve them, for the status card. */
  const resolvedFor = (args: Record<string, unknown>): { app?: string; window?: string } => {
    let app: string | undefined
    try { app = targetController.targetAppForPolicy(args) } catch { /* unresolved */ }
    const windowId = typeof args.window_id === 'number' ? args.window_id
      : typeof args.target_window_id === 'number' ? args.target_window_id : targetController.current()?.windowId
    let window: string | undefined
    try { window = windowId !== undefined ? n.getWindow(windowId)?.title ?? undefined : undefined } catch { /* unresolved */ }
    return { ...(app ? { app } : {}), ...(window ? { window } : {}) }
  }

  const coordinated: Session['dispatch'] = async (tool, args, signal, progress, context) => {
    if (closed) throw new Error('Session is closed')
    const mutates = callMutates(tool, args) && !context?.preflight
    // 7.6.1: the person's pause/stop state gates every mutation and aborts the one in flight.
    if (mutates) {
      const refusal = control.gate(tool)
      if (refusal) return withRefusalAdvice(tool, args, errJson(refusal), callable)
    }
    if ((mutates || CAPTURE_TOOLS.has(tool)) && !context?.preflight) {
      const blocked = sessionRefusal(tool)
      if (blocked) return withRefusalAdvice(tool, args, errJson(blocked), callable)
    }
    if (mutates) keepAwake()
    const effective = mutates ? control.signal(signal) : signal
    const tracked = !context?.preflight && getToolMeta(tool)?.job !== 'meta'
    if (tracked) control.begin(describeAction(tool, args, resolvedFor(args)), { mutates })
    // The watcher marks what changes while (and just after) the agent acts as the agent's own doing.
    if (mutates) liveWatcher.agentActing(true)
    let outcome: 'done' | 'failed' = 'failed'
    try {
      const result = mutates
        ? await coordinateDesktop(opts.lockPath ?? DEFAULT_SESSION_LOCK_PATH, () => dispatch(tool, args, effective, progress, context), effective)
        : await dispatch(tool, args, effective, progress, context)
      outcome = result.isError ? 'failed' : 'done'
      if (tracked) control.waiting(result.isError && result.structuredContent?.error === 'user_active' ? 'user_active' : null)
      return result
    } finally {
      if (mutates) liveWatcher.agentActing(false)
      if (tracked) control.finish(outcome)
    }
  }
  return {
    dispatch: coordinated,
    preflight: (tool, args, signal, context) => dispatch(tool, args, signal, undefined, { ...context, preflight: true }),
    close: () => { closeRequested = true; dispose() },
    retain: () => { references++; let released = false; return () => { if (!released) { released = true; references--; dispose() } } },
    getLastScreenshot: () => screenshotHandler.lastScreenshot(),
    live: liveWatcher,
  }
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
