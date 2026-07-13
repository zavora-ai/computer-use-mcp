#!/usr/bin/env node
/**
 * Computer Use MCP Server — exposes tools over MCP protocol.
 * Backed by in-process Rust NAPI module via session.
 *
 * v6.2+: registerTool + annotations + structuredContent + profiles + prompts + resources.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createSession, type Session, type SessionOptions } from './session.js'
import {
  parseProfile,
  parseSurfaceProfile,
  type FocusRequired,
  type ToolMeta,
  type ProfileName,
} from './tool-catalog.js'
import { SERVER_INSTRUCTIONS } from './instructions.js'
import { registerPrompts } from './prompts.js'
import { registerResources } from './resources.js'
import { isStdioEntrypoint } from './entrypoint.js'
import { ToolRegistry } from './registry/registry.js'
import { approvalTokenParam, defineV7Tools } from './registry/definitions.js'
import { defineV8Tools } from './registry/v8-definitions.js'
import { RuntimeCoordinator, type RuntimeCoordinatorOptions } from './runtime/coordinator.js'
import { PollingEmergencyStopMonitor, PollingInputActivityMonitor } from './control/activity-monitor.js'
import { loadNative, type NativeModule } from './native.js'
import { FileReceiptStore } from './control/receipts.js'
import { SessionTransactionHooks } from './control/session-transaction.js'
import { createDefaultV8PolicyFromEnvironment } from './policy/engine.js'
import { SessionTargetEvidenceValidator } from './targeting/session-validator.js'
import { FileSessionStore } from './session/store.js'
import { FileEventJournal, SupervisorEventBus } from './session/events.js'
import { SessionLifecycle } from './session/lifecycle.js'
import { SupervisorIpcServer } from './session/supervisor-ipc.js'
import { MemoryEvidenceFrameStore } from './session/evidence-frames.js'
import { FileOnboardingStore, OnboardingManager } from './onboarding/manager.js'
import { McpSessionTaskAdapter } from './runtime/mcp-tasks.js'
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js'
import type { TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CapabilityRegistry } from './runtime/capabilities.js'
import {
  CapabilityCertificationService,
  FileCertificationTraceStore,
  type CertificationTraceStore,
} from './runtime/adapters.js'
import {
  createReferenceAdapters,
  createSessionReferenceAdapterHost,
} from './runtime/reference-adapters.js'
import { BrowserBridgeHost, type BrowserBridge } from './runtime/browser-bridge.js'
import { v8StartupWarnings } from './migration/v8.js'

export type { FocusRequired, ToolMeta }

function optionalBoundedInteger(
  name: string,
  value: string | undefined,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined || value === '') return undefined
  if (!/^\d+$/.test(value)) throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}


export interface ServerOptions extends SessionOptions {
  /** Override session instance for tests */
  session?: Session
  /** Init-time tool profile (K18). Default full. */
  profile?: ProfileName | string
  /**
   * Emit `structuredContent` + advertise `outputSchema`. Defaults to the
   * `COMPUTER_USE_STRUCTURED_CONTENT` env var (true unless explicitly "false").
   * When false, both are omitted for legacy text-only compatibility.
   */
  structuredContent?: boolean
  /**
   * v7 deprecation: append the legacy `[focusRequired: X]` suffix to tool
   * descriptions. Defaults to the `COMPUTER_USE_LEGACY_FOCUS_TAG` env var,
   * which is **off by default in v7** (focusRequired remains in `_meta`).
   * Set to `true` (or the env var to "true") to restore the legacy suffix.
   */
  legacyFocusTag?: boolean
  /** Enable the additive v8 high-level action and control facade. */
  enableV8?: boolean
  /** Initially enabled subset inside `profile`; hosts may change it through `onRegistry`. */
  activeProfile?: ProfileName | string
  /** Override v8 coordinator services for embedding and deterministic tests. */
  runtime?: RuntimeCoordinator
  runtimeOptions?: Omit<RuntimeCoordinatorOptions, 'execute'>
  /** Authenticated host principal. Never sourced from model tool arguments. */
  principalId?: string
  /** Embedding hook for attaching a local supervisor transport to the enforced runtime. */
  onRuntime?: (runtime: RuntimeCoordinator) => void
  /** Opt in to short-lived, process-memory-only supervisor before/after frames. */
  enableSupervisorFrames?: boolean
  /** Embedding hook for host-controlled dynamic tool profile negotiation. */
  onRegistry?: (registry: ToolRegistry) => void
  /** Opt in to the experimental MCP Tasks projection over the v8 lifecycle. */
  enableExperimentalTasks?: boolean
  /** Override experimental task persistence. The v8 lifecycle remains authoritative. */
  experimentalTaskStore?: TaskStore
  /** Host/transport authorization invoked before every registered tool handler. */
  authorizeToolCall?: ConstructorParameters<typeof ToolRegistry>[0]['authorizeToolCall']
  /** Trusted app-adapter certification service; required when embedding a prebuilt runtime. */
  certificationService?: CapabilityCertificationService
  /** Optional private trace persistence override. */
  certificationTraceStore?: CertificationTraceStore
  /** Optional trusted DOM/CDP adapter. It is never exposed as a raw MCP tool. */
  browserBridge?: BrowserBridge
}

export function createComputerUseServer(opts: ServerOptions = {}): McpServer {
  const profile = parseProfile(opts.profile ?? process.env.COMPUTER_USE_PROFILE)
  const structuredContentEnabled =
    opts.structuredContent ?? (process.env.COMPUTER_USE_STRUCTURED_CONTENT !== 'false')
  const legacyFocusTag =
    opts.legacyFocusTag ?? (process.env.COMPUTER_USE_LEGACY_FOCUS_TAG === 'true')
  const enableV8 = opts.enableV8 ?? (process.env.COMPUTER_USE_V8 === 'true')
  const enableExperimentalTasks = opts.enableExperimentalTasks
    ?? (process.env.COMPUTER_USE_EXPERIMENTAL_TASKS === 'true')
  if (enableExperimentalTasks && !enableV8) {
    throw new Error('experimental MCP Tasks require the enforced v8 runtime')
  }
  if (opts.browserBridge && !enableV8) throw new Error('browser bridge requires the enforced v8 runtime')
  if (opts.browserBridge && opts.runtime) {
    throw new Error('browser bridge cannot be attached to an opaque prebuilt runtime; configure it when constructing the runtime')
  }
  const enableSupervisorFrames = opts.enableSupervisorFrames
    ?? (process.env.COMPUTER_USE_SUPERVISOR_FRAMES === 'true')
  const supervisorFramesEnabled = enableSupervisorFrames
    || Boolean(opts.runtime?.evidenceFrames)
    || Boolean(opts.runtimeOptions?.evidenceFrames)
  if (enableSupervisorFrames && !enableV8) {
    throw new Error('supervisor evidence frames require the enforced v8 runtime')
  }
  if (enableSupervisorFrames && opts.runtime) {
    throw new Error('configure evidenceFrames on a prebuilt runtime instead of enableSupervisorFrames')
  }
  const experimentalTaskStore = enableExperimentalTasks
    ? opts.experimentalTaskStore ?? new InMemoryTaskStore()
    : undefined

  const server = new McpServer(
    { name: 'computer-use', version: '7.0.0' },
    {
      instructions: SERVER_INSTRUCTIONS,
      ...(experimentalTaskStore ? { taskStore: experimentalTaskStore } : {}),
    },
  )
  if (enableExperimentalTasks) {
    server.server.registerCapabilities({
      tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
    })
  }

  // Elicitation callback (PR-10): only when client supports it; token wins in session (K13).
  const elicitApproval = opts.elicitApproval ?? (async (ctx) => {
    try {
      const caps = server.server.getClientCapabilities()
      if (!caps?.elicitation) return false
      const result = await server.server.elicitInput(
        {
          message: `Allow computer-use tool "${ctx.tool}"?${ctx.targetApp ? ` Target: ${ctx.targetApp}.` : ''}${ctx.destructive ? ' This may be destructive.' : ''}\nReasons: ${ctx.reasons.join(', ')}`,
          requestedSchema: {
            type: 'object',
            properties: {
              approve: { type: 'boolean', title: 'Approve', description: 'Allow this action' },
            },
            required: ['approve'],
          },
        },
        { timeout: 60_000 },
      )
      return result.action === 'accept' && result.content?.approve === true
    } catch {
      return false
    }
  })

  const session = opts.session ?? createSession({
    vision: opts.vision ?? (process.env.COMPUTER_USE_VISION !== 'false'),
    provider: opts.provider ?? process.env.COMPUTER_USE_PROVIDER,
    native: opts.native,
    spawnBounded: opts.spawnBounded,
    lockPath: opts.lockPath,
    disableSessionLock: opts.disableSessionLock,
    elicitApproval: opts.elicitApproval !== undefined ? opts.elicitApproval : elicitApproval,
    profile,
  })

  const registry = new ToolRegistry({
    profile,
    structuredContent: structuredContentEnabled,
    legacyFocusTag,
    approvalTokenSchema: approvalTokenParam,
    session,
    enableV8: opts.enableV8 ?? (process.env.COMPUTER_USE_V8 === 'true'),
    activeProfile: parseSurfaceProfile(
      opts.activeProfile ?? process.env.COMPUTER_USE_ACTIVE_PROFILE,
      profile,
    ),
    ...(opts.authorizeToolCall ? { authorizeToolCall: opts.authorizeToolCall } : {}),
  })

  defineV7Tools(registry)
  let v8Runtime: RuntimeCoordinator | undefined
  let v8InputMonitorCapability: ReturnType<NonNullable<NativeModule['getInputMonitorCapability']>> | undefined
  let v8EmergencyStopCapability: ReturnType<NonNullable<NativeModule['configureEmergencyStopChord']>> | undefined
  let v8PhysicalInputRequiresAttributedMonitor = false
  let v8Certification: CapabilityCertificationService | undefined
  let taskAdapter: McpSessionTaskAdapter | undefined
  if (enableV8) {
    const browserHost = opts.browserBridge ? new BrowserBridgeHost(opts.browserBridge) : undefined
    const monitorNative = opts.native ?? (() => {
      try { return loadNative() } catch { return undefined }
    })()
    const activityMonitor = opts.runtimeOptions?.activityMonitor ?? (
      monitorNative?.getUserIdleTimeMs
        ? new PollingInputActivityMonitor({
            getUserIdleTimeMs: () => monitorNative.getUserIdleTimeMs?.(),
            getInputMonitorCapability: monitorNative.getInputMonitorCapability
              ? () => monitorNative.getInputMonitorCapability!()
              : undefined,
          })
        : undefined
    )
    let emergencyStopMonitor = opts.runtimeOptions?.emergencyStopMonitor
    if (!opts.runtime && !emergencyStopMonitor && monitorNative?.configureEmergencyStopChord && monitorNative.getEmergencyStopGeneration) {
      const chord = process.env.COMPUTER_USE_EMERGENCY_STOP_CHORD ?? 'ctrl+alt+shift+escape'
      try {
        v8EmergencyStopCapability = monitorNative.configureEmergencyStopChord(chord)
        emergencyStopMonitor = new PollingEmergencyStopMonitor({
          getEmergencyStopGeneration: () => monitorNative.getEmergencyStopGeneration!(),
        }, { backend: v8EmergencyStopCapability.backend })
      } catch (error) {
        v8EmergencyStopCapability = {
          supported: false,
          backend: process.platform === 'darwin' ? 'macos_hid_event_tap'
            : process.platform === 'win32' ? 'windows_low_level_keyboard_hook' : 'unsupported',
          physicalOnly: process.platform === 'darwin' || process.platform === 'win32',
          latched: monitorNative.isNativeEmergencyStopActive?.() ?? false,
          generation: monitorNative.getEmergencyStopGeneration(),
          chord,
          reason: error instanceof Error ? error.message : String(error),
        }
      }
    }
    v8PhysicalInputRequiresAttributedMonitor = opts.runtimeOptions?.requireAttributedPhysicalInput
      ?? (process.platform === 'darwin' || process.platform === 'win32')
    try { v8InputMonitorCapability = monitorNative?.getInputMonitorCapability?.() }
    catch { /* capability manifest reports unavailable */ }
    const receipts = opts.runtimeOptions?.receipts ?? (
      process.env.COMPUTER_USE_RECEIPT_DIR
        ? new FileReceiptStore(process.env.COMPUTER_USE_RECEIPT_DIR)
        : undefined
    )
    const targetValidator = new SessionTargetEvidenceValidator(session)
    const capabilityRegistry = opts.runtimeOptions?.capabilities ?? new CapabilityRegistry()
    const eventJournalMaxBytes = optionalBoundedInteger(
      'COMPUTER_USE_EVENT_JOURNAL_MAX_BYTES',
      process.env.COMPUTER_USE_EVENT_JOURNAL_MAX_BYTES,
      1024,
      Number.MAX_SAFE_INTEGER,
    )
    const maxSessions = optionalBoundedInteger(
      'COMPUTER_USE_MAX_SESSIONS',
      process.env.COMPUTER_USE_MAX_SESSIONS,
      1,
      1_000_000,
    )
    const events = opts.runtimeOptions?.events ?? (
      process.env.COMPUTER_USE_EVENT_JOURNAL
        ? new SupervisorEventBus(undefined, undefined, new FileEventJournal(
            process.env.COMPUTER_USE_EVENT_JOURNAL,
            { ...(eventJournalMaxBytes === undefined ? {} : { maxBytes: eventJournalMaxBytes }) },
          ))
        : undefined
    )
    const lifecycle = opts.runtimeOptions?.lifecycle ?? (
      process.env.COMPUTER_USE_SESSION_DIR
        ? new SessionLifecycle(new FileSessionStore(
            process.env.COMPUTER_USE_SESSION_DIR,
            { ...(maxSessions === undefined ? {} : { maxSessions }) },
          ), events)
        : undefined
    )
    const runtime = opts.runtime ?? new RuntimeCoordinator({
      ...opts.runtimeOptions,
      capabilities: capabilityRegistry,
      ...(activityMonitor ? { activityMonitor } : {}),
      ...(emergencyStopMonitor ? { emergencyStopMonitor } : {}),
      ...(monitorNative?.triggerNativeEmergencyStop
        ? { nativeEmergencyStop: () => monitorNative.triggerNativeEmergencyStop!() }
        : {}),
      ...(monitorNative?.resetNativeEmergencyStop
        ? { nativeEmergencyReset: () => monitorNative.resetNativeEmergencyStop!() }
        : {}),
      ...(monitorNative?.isNativeEmergencyStopActive && monitorNative.getEmergencyStopGeneration
        ? { nativeEmergencyStatus: () => ({
            active: monitorNative.isNativeEmergencyStopActive!(),
            generation: monitorNative.getEmergencyStopGeneration!(),
            supported: v8EmergencyStopCapability?.supported ?? false,
            backend: v8EmergencyStopCapability?.backend ?? 'native_unconfigured',
            ...(v8EmergencyStopCapability?.chord ? { chord: v8EmergencyStopCapability.chord } : {}),
          }) }
        : {}),
      requireAttributedPhysicalInput: v8PhysicalInputRequiresAttributedMonitor,
      ...(receipts ? { receipts } : {}),
      ...(events ? { events } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      requireManagedSession: true,
      ...(enableSupervisorFrames && !opts.runtimeOptions?.evidenceFrames
        ? { evidenceFrames: new MemoryEvidenceFrameStore() }
        : {}),
      transactionHooks: opts.runtimeOptions?.transactionHooks ?? new SessionTransactionHooks(session),
      policy: opts.runtimeOptions?.policy ?? createDefaultV8PolicyFromEnvironment(),
      resolveToolMeta: opts.runtimeOptions?.resolveToolMeta ?? (tool => registry.getMeta(tool)),
      validateTarget: opts.runtimeOptions?.validateTarget ?? (target =>
        browserHost?.owns(target)
          ? browserHost.validateTarget(target)
          : targetValidator.validate(target)),
      execute: (tool, args, signal, envelope) => tool === 'browser_action' && browserHost
        ? browserHost.execute(args, envelope, signal)
        : session.dispatch(tool, args, signal),
    })
    v8Runtime = runtime
    opts.onRuntime?.(runtime)
    v8Certification = opts.certificationService
    if (!v8Certification && !opts.runtime && monitorNative) {
      const host = createSessionReferenceAdapterHost({
        native: monitorNative,
        dispatch: (tool, args) => session.dispatch(tool, args),
      })
      const sandboxRoot = process.env.COMPUTER_USE_CERTIFICATION_SANDBOX
        ?? join(homedir(), '.computer-use-mcp', 'certification-sandbox')
      const adapters = createReferenceAdapters(host, sandboxRoot)
      if (adapters.length) {
        const traces = opts.certificationTraceStore ?? new FileCertificationTraceStore(
          process.env.COMPUTER_USE_CERTIFICATION_DIR
            ?? join(homedir(), '.computer-use-mcp', 'certifications'),
        )
        v8Certification = new CapabilityCertificationService(
          capabilityRegistry,
          adapters,
          () => new Date(),
          traces,
        )
      }
    }
    if (v8Certification) {
      const readiness = v8Certification.restore().catch(() => ({ restored: [], rejected: [] }))
      v8Certification.registry.setReady(readiness)
    }
    const onboarding = new OnboardingManager(
      session,
      process.env.COMPUTER_USE_ONBOARDING_DIR
        ? new FileOnboardingStore(process.env.COMPUTER_USE_ONBOARDING_DIR)
        : undefined,
      undefined,
      () => {
        const status = runtime.emergencyStopStatus()
        return {
          chord: status.chord ?? process.env.COMPUTER_USE_EMERGENCY_STOP_CHORD ?? 'ctrl+alt+shift+escape',
          backend: status.backend,
          physicalChordSupported: status.supported,
          physicalOnly: v8EmergencyStopCapability?.physicalOnly === true,
        }
      },
    )
    defineV8Tools(registry, runtime, {
      principalId: opts.principalId ?? process.env.COMPUTER_USE_PRINCIPAL_ID ?? 'local-user',
    }, {
      onboarding,
      ...(v8Certification ? { certification: v8Certification } : {}),
      ...(browserHost ? { browserBridge: true } : {}),
    })
    if (enableExperimentalTasks) {
      taskAdapter = new McpSessionTaskAdapter({
        runtime,
        principalId: opts.principalId ?? process.env.COMPUTER_USE_PRINCIPAL_ID ?? 'local-user',
      })
      taskAdapter.register(server)
      const previousOnClose = server.server.onclose
      server.server.onclose = () => {
        taskAdapter?.dispose()
        const cleanup = (experimentalTaskStore as TaskStore & { cleanup?: () => void }).cleanup
        cleanup?.call(experimentalTaskStore)
        previousOnClose?.()
      }
    }
  }

  // Registration is deliberately deferred until every definition exists so
  // completeness and duplicate checks fail atomically before server startup.
  registry.registerAll(server)
  opts.onRegistry?.(registry)

  // MCP prompts + resources (v6.2+)
  registerPrompts(server)
  registerResources(server, {
    session,
    profile,
    getLastScreenshot: () => session.getLastScreenshot?.(),
    ...(v8Runtime ? {
      runtime: v8Runtime,
      principalId: opts.principalId ?? process.env.COMPUTER_USE_PRINCIPAL_ID ?? 'local-user',
      capabilityManifest: {
        getActiveProfile: () => registry.activeProfile(),
        experimentalTasks: enableExperimentalTasks,
        durableSessions: Boolean(process.env.COMPUTER_USE_SESSION_DIR),
        durableReceipts: Boolean(process.env.COMPUTER_USE_RECEIPT_DIR),
        durableEvents: Boolean(process.env.COMPUTER_USE_EVENT_JOURNAL),
        supervisorIpcConfigured: Boolean(process.env.COMPUTER_USE_SUPERVISOR_SOCKET),
        supervisorFramesEnabled,
        browserBridgeConfigured: Boolean(opts.browserBridge),
        physicalInputRequiresAttributedMonitor: v8PhysicalInputRequiresAttributedMonitor,
        ...(v8InputMonitorCapability ? { inputMonitor: v8InputMonitorCapability } : {}),
        ...(v8EmergencyStopCapability ? { emergencyStop: v8EmergencyStopCapability } : {}),
      },
    } : {}),
  })

  return server
}

// Standalone stdio entrypoint. Detection lives in ./entrypoint.ts so it is
// unit-testable without loading the native NAPI binary.
if (isStdioEntrypoint(process.argv[1])) {
  let runtime: RuntimeCoordinator | undefined
  const principalId = process.env.COMPUTER_USE_PRINCIPAL_ID ?? 'local-user'
  const server = createComputerUseServer({ principalId, onRuntime: value => { runtime = value } })
  const transport = new StdioServerTransport()
  let supervisor: SupervisorIpcServer | undefined
  const start = async () => {
    if (process.env.COMPUTER_USE_V8 === 'true') {
      for (const warning of v8StartupWarnings()) {
        console.error(`[computer-use-mcp] WARNING: ${warning}`)
      }
    }
    const socketPath = process.env.COMPUTER_USE_SUPERVISOR_SOCKET
    if (socketPath) {
      if (!runtime) throw new Error('COMPUTER_USE_SUPERVISOR_SOCKET requires COMPUTER_USE_V8=true')
      const token = process.env.COMPUTER_USE_SUPERVISOR_TOKEN
      if (!token || token.length < 32) {
        throw new Error('COMPUTER_USE_SUPERVISOR_TOKEN must be an explicit secret of at least 32 characters')
      }
      // Retain the credential only in the supervisor object. Model-authored
      // subprocesses receive a scrubbed environment, and later code cannot
      // accidentally forward this process-global variable.
      delete process.env.COMPUTER_USE_SUPERVISOR_TOKEN
      supervisor = new SupervisorIpcServer({ runtime, socketPath, token, principalId })
      await supervisor.start()
    }
    await server.connect(transport)
    console.error('[computer-use-mcp] Server running')
  }
  const shutdown = async () => {
    await supervisor?.stop()
    runtime?.dispose()
    await server.close()
  }
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })
  start().catch(err => { console.error('Fatal:', err); process.exit(1) })
}
