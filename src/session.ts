import { withToolDefaults } from './registry/definitions.js'
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
import { MUTATING_TOOLS } from './tool-catalog.js'
import { sleep, sleepAbortable, defaultSpawnBounded } from './session/spawn.js'
import type { SpawnBounded } from './session/spawn.js'
import { FocusError, WindowNotFoundError } from './session/errors.js'
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
import { handleWindowTool } from './session/window-handlers.js'
import { handleLinuxAccessibility } from './session/linux-atspi.js'
import { handleAccessibilityTool } from './session/accessibility-handlers.js'
import { SpacesHandler } from './session/spaces-handlers.js'
import { ScreenshotHandler } from './session/screenshot-handlers.js'
import { InputHandler } from './session/input-handlers.js'
import { ScriptingService } from './session/scripting-service.js'
import { OpenAiCompatibilityHandler } from './session/openai-handler.js'
import { handleCoreTool } from './session/core-handlers.js'
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
}

const IS_WINDOWS = process.platform === 'win32'

// MUTATING_TOOLS imported from tool-catalog.ts (SSOT with ToolMeta.mutates; includes resize_window).
// Observation tools (screenshot, list_*, get_*) do not take the lock.

// ── Session factory ───────────────────────────────────────────────────────────

export function createSession(opts: SessionOptions = {}): Session {
  const n = opts.native ?? loadNative()
  const spawnBounded: SpawnBounded = opts.spawnBounded ?? defaultSpawnBounded
  const targetController = new TargetStateController(n)
  const visionEnabled = opts.vision !== false
  const elicitApproval = opts.elicitApproval
  const activeProfile = opts.profile ?? process.env.COMPUTER_USE_PROFILE ?? 'full'

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
  const dispose = () => { if (closeRequested && references === 0) { closed = true; process.removeListener('exit', forceRelease) } }
  const defaultProvider = opts.provider ?? process.env.COMPUTER_USE_PROVIDER ?? 'auto'

  const virtualPointer = new VirtualPointerController(n)
  const spacesHandler = new SpacesHandler({ native: n, spawnBounded, sleep })
  const screenshotHandler = new ScreenshotHandler({
    native: n,
    targets: targetController,
    pointer: virtualPointer,
    visionEnabled,
    defaultProvider,
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

  const focus = createFocusController({ native: n, sleep })
  const inputHandler = new InputHandler({
    native: n,
    targets: targetController,
    focus,
    sleep,
  })
  const scripting = new ScriptingService({ native: n, spawnBounded })
  const runScriptHelper = scripting.runScript.bind(scripting)
  const getAppDictionary = scripting.getAppDictionary.bind(scripting)
  const getPowerShellExe = scripting.getPowerShellExe.bind(scripting)
  const openAiHandler = new OpenAiCompatibilityHandler(
    (tool, args, signal, onProgress, requestContext) => dispatch(tool, args, signal, onProgress, requestContext),
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
    })
  }

  // ── Click helper ────────────────────────────────────────────────────────

  // ── Dispatch ────────────────────────────────────────────────────────────

  async function dispatch(
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: ProgressReporter,
    requestContext?: SessionRequestContext,
  ): Promise<ToolResult> {

    args = withToolDefaults(tool, args)

    // v5.2: Only mutating tools take the session lock and start the pump.
    // Observation tools stay concurrent and cheap.
    const startedAt = Date.now()
    const startedAtIso = new Date(startedAt).toISOString()
    const mutates = MUTATING_TOOLS.has(tool)
    let policyDecision = evaluatePolicy(tool, args, mutates)

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
      const clientRoots = requestContext?.clientRoots ?? opts.getClientRoots?.()
      const extracted = await handleAdminTool(tool, args, {
        spawnBounded,
        getPowerShellExe,
        ...(clientRoots !== undefined ? { clientRoots } : {}),
        ...(signal ? { signal } : {}),
        ...(onProgress ? { onProgress } : {}),
      })
      if (extracted) return extracted
      const windowResult = await handleWindowTool(tool, args, {
        native: n,
        targets: targetController,
        defaultProvider,
        sleep,
        sleepAbortable,
        runScript: runScriptHelper,
        ...(signal ? { signal } : {}),
      })
      if (windowResult) return windowResult
      const accessibilityContext = {
        native: n,
        targets: targetController,
        focus,
        activeProfile,
        sleep,
        runScript: runScriptHelper,
        getAppDictionary,
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
      const screenshotResult = screenshotHandler.handle(tool, args)
      if (screenshotResult) return screenshotResult
      const inputResult = await inputHandler.handle(tool, args, signal)
      if (inputResult) return inputResult
      const compatibilityResult = await openAiHandler.handle(tool, args, signal, onProgress, requestContext)
      if (compatibilityResult) return compatibilityResult
      const coreResult = await handleCoreTool(tool, args, {
        runDoctor,
        policyStatus,
        pointer: virtualPointer,
      })
      if (coreResult) return coreResult
      return { content: [{ type: 'text', text: `Unknown tool: ${tool}` }], isError: true }
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

  const coordinated: Session['dispatch'] = (tool, args, signal, progress, context) => {
    if (closed) return Promise.reject(new Error('Session is closed'))
    return MUTATING_TOOLS.has(tool) && !context?.preflight
      ? coordinateDesktop(opts.lockPath ?? DEFAULT_SESSION_LOCK_PATH, () => dispatch(tool, args, signal, progress, context), signal)
      : dispatch(tool, args, signal, progress, context)
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
