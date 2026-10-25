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
import { loadNative, type NativeModule } from './native.js'
import { DEFAULT_PROFILE, MUTATING_TOOLS, RUN_STEP_TOOLS, callMutates, getToolMeta, parseProfile, toolAvailableOn, toolInProfile } from './tool-catalog.js'
import { applyContract, withRefusalAdvice, type Effect } from './session/contract.js'
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
import { createLegacyPolicyRuntime } from './session/legacy-policy.js'
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
import { InputHandler } from './session/input-handlers.js'
import { ScriptingService } from './session/scripting-service.js'
import { OpenAiCompatibilityHandler } from './session/openai-handler.js'
import { handleCoreTool } from './session/core-handlers.js'
import { handleAgentDesktopTool } from './session/agent-desktop-handlers.js'
import { createMacosHelper, type MacosHelper } from './session/macos-helper.js'
import { defaultPidDeliveryPath, PidDeliveryStore } from './session/pid-delivery.js'
import { createUserActivityGuard, type UserActivityGuard } from './session/user-activity.js'
import { maskCardInCaptures } from './session/card-guard.js'
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
  validateArguments?: (tool: string, args: Record<string, unknown>) =>
    | { ok: true; args: Record<string, unknown> }
    | { ok: false; issues: Array<{ path: string; message: string }> }
}

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
      try { control.close() } catch { /* the card is optional */ }
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
  async function dispatch(
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
    const planned: Array<{ tool: string; args: Record<string, unknown> }> = []
    const problems: Array<Record<string, unknown>> = []
    steps.forEach((step, index) => {
      const name = typeof step?.tool === 'string' ? step.tool : ''
      const given = step?.args && typeof step.args === 'object' ? step.args as Record<string, unknown> : {}
      if (!STEP_TOOLS.has(name)) { problems.push({ index, tool: name || null, message: 'not allowed in run_steps' }); return }
      if (!callable(name)) { problems.push({ index, tool: name, message: 'not available in this profile or on this platform' }); return }
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
      else planned.push({ tool: name, args: checked.args })
    })
    if (problems.length > 0) {
      return errJson({
        error: 'invalid_arguments', tool: 'run_steps',
        message: 'No step ran: fix the listed steps and call again.',
        issues: problems,
      })
    }

    const records: Array<Record<string, unknown>> = []
    let failed: { index: number; result: ToolResult } | undefined
    let weakest: Effect = 'verified'
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
      const result = await dispatch(step.tool, step.args, signal, undefined, requestContext)
      control.finish(result.isError ? 'failed' : 'done')
      const reply = result.structuredContent ?? {}
      const summary = result.content.find(block => block.type === 'text')
      const record: Record<string, unknown> = {
        index, tool: step.tool, ok: !result.isError,
        ...(summary && summary.type === 'text' ? { summary: summary.text.slice(0, 200) } : {}),
      }
      for (const key of ['effect', 'route', 'delivery', 'error', 'hint'] as const) if (reply[key] !== undefined) record[key] = reply[key]
      records.push(record)
      if (result.isError) { failed = { index, result }; break }
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
    const payload: Record<string, unknown> = { completed, total: planned.length, stopped_at: failed?.index ?? null, steps: records }
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
    let outcome: 'done' | 'failed' = 'failed'
    try {
      const result = mutates
        ? await coordinateDesktop(opts.lockPath ?? DEFAULT_SESSION_LOCK_PATH, () => dispatch(tool, args, effective, progress, context), effective)
        : await dispatch(tool, args, effective, progress, context)
      outcome = result.isError ? 'failed' : 'done'
      if (tracked) control.waiting(result.isError && result.structuredContent?.error === 'user_active' ? 'user_active' : null)
      return result
    } finally {
      if (tracked) control.finish(outcome)
    }
  }
  return {
    dispatch: coordinated,
    preflight: (tool, args, signal, context) => dispatch(tool, args, signal, undefined, { ...context, preflight: true }),
    close: () => { closeRequested = true; dispose() },
    retain: () => { references++; let released = false; return () => { if (!released) { released = true; references--; dispose() } } },
    getLastScreenshot: () => screenshotHandler.lastScreenshot(),
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
