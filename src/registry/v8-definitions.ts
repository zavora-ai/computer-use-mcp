import { z } from 'zod'
import { AUDIT_EXPORT_SCHEMA_DIGEST, AUDIT_EXPORT_SCHEMA_URI } from '../session/event-schema.js'
import { errJson, type ToolResult } from '../result.js'
import type { RuntimeCoordinator } from '../runtime/coordinator.js'
import { RuntimeError, type ExecutionMode, type TargetEvidence } from '../runtime/types.js'
import { TOOL_CATALOG, type ToolMeta } from '../tool-catalog.js'
import type { ToolRegistry } from './registry.js'
import { configurationForOnboardingProfile, type OnboardingManager } from '../onboarding/manager.js'
import type { CapabilityCertificationService } from '../runtime/adapters.js'

const modeSchema = z.enum(['shadow', 'background', 'foreground'])
const targetSchema = z.object({
  platform: z.enum(['darwin', 'win32', 'linux', 'aix', 'android', 'freebsd', 'haiku', 'openbsd', 'sunos', 'cygwin', 'netbsd']),
  app_id: z.string(),
  pid: z.number().int().optional(),
  window_id: z.union([z.string(), z.number()]).optional(),
  window_title_digest: z.string().optional(),
  display_id: z.string().optional(),
  role: z.string().optional(),
  label_digest: z.string().optional(),
  bounds: z.object({
    x: z.number(), y: z.number(), width: z.number().nonnegative(), height: z.number().nonnegative(),
  }).optional(),
  observation_id: z.string(),
  screenshot_hash: z.string().optional(),
  ui_tree_revision: z.string().optional(),
  confidence: z.number().min(0).max(1),
  captured_at: z.string(),
}).optional()

// The high-level v8 facade remains available in narrow provider-facing
// profiles. Its executor still enforces the hidden low-level tool's policy,
// capability, target, lease, and receipt contracts.
const v8ReadMeta: ToolMeta = { ...TOOL_CATALOG.screenshot, tier: 'core' }
const v8ControlMeta: ToolMeta = { ...TOOL_CATALOG.write_clipboard, tier: 'core' }
const v8DynamicMeta: ToolMeta = { ...TOOL_CATALOG.openai_computer, tier: 'core' }
const v8StopMeta: ToolMeta = { ...v8ControlMeta, destructiveHint: true, idempotentHint: true }
const browserActionMeta: ToolMeta = {
  ...v8ControlMeta,
  focusRequired: 'none', requiresFocus: false, movesUserCursor: false,
  physicalInput: false, openWorldHint: true, idempotentHint: false,
}

const readRisk = () => ({ actionClass: 'observe' as const, reversible: true, externalSideEffect: false, reasons: ['v8:control_read'] })
const controlRisk = () => ({ actionClass: 'navigate' as const, reversible: true, externalSideEffect: false, reasons: ['v8:control_state'] })

function fromWireTarget(value: unknown): TargetEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined
  const target = value as Record<string, unknown>
  return {
    platform: target.platform as NodeJS.Platform,
    appId: String(target.app_id),
    ...(typeof target.pid === 'number' ? { pid: target.pid } : {}),
    ...(typeof target.window_id === 'number' || typeof target.window_id === 'string' ? { windowId: target.window_id } : {}),
    ...(typeof target.window_title_digest === 'string' ? { windowTitleDigest: target.window_title_digest } : {}),
    ...(typeof target.display_id === 'string' ? { displayId: target.display_id } : {}),
    ...(typeof target.role === 'string' ? { role: target.role } : {}),
    ...(typeof target.label_digest === 'string' ? { labelDigest: target.label_digest } : {}),
    ...(target.bounds && typeof target.bounds === 'object' ? { bounds: target.bounds as TargetEvidence['bounds'] } : {}),
    observationId: String(target.observation_id),
    ...(typeof target.screenshot_hash === 'string' ? { screenshotHash: target.screenshot_hash } : {}),
    ...(typeof target.ui_tree_revision === 'string' ? { uiTreeRevision: target.ui_tree_revision } : {}),
    confidence: Number(target.confidence),
    capturedAt: String(target.captured_at),
  }
}

function publicError(error: unknown): ToolResult {
  if (error instanceof RuntimeError) {
    return errJson({ error: error.code, message: error.message, details: error.details })
  }
  return errJson({ error: 'runtime_error', message: error instanceof Error ? error.message : String(error) })
}

function requestFromArgs(args: Record<string, unknown>, principalId: string) {
  return {
    sessionId: String(args.session_id),
    ...(typeof args.action_id === 'string' ? { actionId: args.action_id } : {}),
    ...(typeof args.attempt === 'number' ? { attempt: args.attempt } : {}),
    ...(typeof args.execution_group_id === 'string' ? { executionGroupId: args.execution_group_id } : {}),
    principalId,
    ...(typeof args.agent_id === 'string' ? { agentId: args.agent_id } : {}),
    tool: String(args.tool),
    ...(typeof args.operation === 'string' ? { operation: args.operation } : {}),
    ...(typeof args.certification_id === 'string' ? { certificationId: args.certification_id } : {}),
    args: (args.arguments && typeof args.arguments === 'object' ? args.arguments : {}) as Record<string, unknown>,
    mode: args.mode as ExecutionMode,
    ...(args.target ? { target: fromWireTarget(args.target) } : {}),
    ...(Array.isArray(args.data_labels) ? { dataLabels: args.data_labels as never[] } : {}),
    ...(args.provenance && typeof args.provenance === 'object' ? {
      provenance: {
        untrustedInstruction: Boolean((args.provenance as Record<string, unknown>).untrusted_instruction),
        sourceObservationIds: Array.isArray((args.provenance as Record<string, unknown>).source_observation_ids)
          ? (args.provenance as Record<string, unknown>).source_observation_ids as string[]
          : [],
        ...(typeof (args.provenance as Record<string, unknown>).crosses_data_boundary === 'boolean'
          ? { crossesDataBoundary: (args.provenance as Record<string, unknown>).crosses_data_boundary as boolean }
          : {}),
      },
    } : {}),
    ...(typeof args.expires_in_ms === 'number' ? { expiresInMs: args.expires_in_ms } : {}),
    ...(typeof args.lease_id === 'string' ? { leaseId: args.lease_id } : {}),
    ...(typeof args.approval_grant_id === 'string' ? { approvalGrantId: args.approval_grant_id } : {}),
  }
}

const actionSchema = {
  session_id: z.string(),
  action_id: z.string().optional().describe('Required for execute_action; stable across retries'),
  attempt: z.number().int().positive().optional(),
  execution_group_id: z.string().optional(),
  agent_id: z.string().optional().describe('Untrusted attribution label; principal identity comes from the host'),
  tool: z.string().describe('Existing low-level tool to preview or execute'),
  operation: z.string().optional(),
  certification_id: z.string().regex(/^cert_[a-f0-9]{32}$/).optional()
    .describe('Explicit app/version/action-contract certification required for adapter-proven background execution'),
  arguments: z.record(z.string(), z.unknown()),
  mode: modeSchema,
  target: targetSchema,
  data_labels: z.array(z.enum(['public', 'private', 'credential', 'payment', 'health', 'unknown'])).optional(),
  provenance: z.object({
    untrusted_instruction: z.boolean(),
    source_observation_ids: z.array(z.string()),
    crosses_data_boundary: z.boolean().optional(),
  }).optional(),
  expires_in_ms: z.number().int().positive().max(300_000).optional(),
  approval_grant_id: z.string().optional(),
}

/** Additive v8 developer-preview facade. The v7 definitions remain byte-for-byte stable. */
export function defineV8Tools(
  registry: ToolRegistry,
  runtime: RuntimeCoordinator,
  context: { principalId: string },
  services: {
    onboarding?: OnboardingManager
    certification?: CapabilityCertificationService
    browserBridge?: boolean
  } = {},
): void {
  if (services.browserBridge) {
    registry.define({
      apiVersion: 8,
      internalOnly: true,
      name: 'browser_action',
      description: 'Host-supplied DOM/CDP actuator reachable only through the governed v8 action facade.',
      inputSchema: {},
      meta: browserActionMeta,
      riskMapper: args => {
        const operation = typeof args.operation === 'string' ? args.operation : 'unknown'
        return ['navigate', 'go_back', 'go_forward', 'open_web_browser'].includes(operation)
          ? { actionClass: 'navigate', reversible: true, externalSideEffect: true, reasons: [`browser:${operation}`] }
          : { actionClass: 'edit_reversible', reversible: true, externalSideEffect: true, reasons: [`browser:${operation}`] }
      },
    })
  }
  if (services.onboarding) {
    registry.define({
      apiVersion: 8,
      name: 'onboarding',
      description: 'Run or resume guided v8 setup: diagnostics, capture, virtual-pointer, semantic-accessibility, emergency-stop acknowledgment, and safe policy profile.',
      inputSchema: {
        action: z.enum(['start', 'status', 'diagnose', 'test_capture', 'show_pointer', 'confirm_pointer', 'test_pointer', 'test_semantic', 'acknowledge_emergency', 'configure', 'complete']),
        onboarding_id: z.string().optional(),
        coordinate: z.tuple([z.number(), z.number()]).optional(),
        confirmed_by_user: z.boolean().optional(),
        acknowledged_by_user: z.boolean().optional(),
        window_id: z.number().int().optional(),
        filesystem_roots: z.array(z.string()).optional(),
        allowed_app_ids: z.array(z.string()).optional(),
        allow_scrape: z.boolean().optional(),
        persist_audit: z.boolean().optional(),
      },
      meta: v8ControlMeta,
      riskMapper: controlRisk,
      handler: async args => {
        try {
          const manager = services.onboarding!
          const action = String(args.action)
          let state
          if (action === 'start') state = await manager.start(context.principalId)
          else {
            if (typeof args.onboarding_id !== 'string') throw new TypeError('onboarding_id is required')
            const id = args.onboarding_id
            if (action === 'status') state = await manager.get(id, context.principalId)
            else if (action === 'diagnose') state = await manager.diagnose(id, context.principalId)
            else if (action === 'test_capture') state = await manager.testCapture(id, context.principalId)
            else if (action === 'test_pointer') {
              if (!Array.isArray(args.coordinate) || args.coordinate.length !== 2) throw new TypeError('coordinate is required')
              state = await manager.testPointer(
                id, context.principalId, args.coordinate as [number, number], args.confirmed_by_user === true,
              )
            } else if (action === 'show_pointer') {
              if (!Array.isArray(args.coordinate) || args.coordinate.length !== 2) throw new TypeError('coordinate is required')
              state = await manager.showPointer(id, context.principalId, args.coordinate as [number, number])
            } else if (action === 'confirm_pointer') {
              if (typeof args.confirmed_by_user !== 'boolean') throw new TypeError('confirmed_by_user is required')
              state = await manager.confirmPointer(id, context.principalId, args.confirmed_by_user)
            } else if (action === 'test_semantic') {
              if (typeof args.window_id !== 'number') throw new TypeError('window_id is required')
              state = await manager.testSemantic(id, context.principalId, args.window_id)
            } else if (action === 'acknowledge_emergency') {
              if (typeof args.acknowledged_by_user !== 'boolean') throw new TypeError('acknowledged_by_user is required')
              state = await manager.acknowledgeEmergencyStop(id, context.principalId, args.acknowledged_by_user)
            } else if (action === 'configure') {
              state = await manager.configure(id, context.principalId, {
                filesystemRoots: Array.isArray(args.filesystem_roots) ? args.filesystem_roots as string[] : [],
                allowedAppIds: Array.isArray(args.allowed_app_ids) ? args.allowed_app_ids as string[] : [],
                allowScrape: args.allow_scrape === true,
                persistAudit: args.persist_audit === true,
              })
            } else if (action === 'complete') state = await manager.complete(id, context.principalId)
            else throw new TypeError(`unsupported onboarding action: ${action}`)
          }
          const configuration = state.profile ? configurationForOnboardingProfile(state.profile) : undefined
          const response = { onboarding: state, ...(configuration ? { configuration } : {}) }
          return { content: [{ type: 'text', text: JSON.stringify(response) }], structuredContent: response }
        } catch (error) { return publicError(error) }
      },
    })
  }

  registry.define({
    apiVersion: 8,
    name: 'start_session',
    description: 'Start an attributable v8 computer-use session and emit its initial lifecycle events.',
    inputSchema: { objective: z.string().optional(), execution_group_id: z.string().optional() },
    meta: v8ControlMeta,
    riskMapper: controlRisk,
    handler: async args => {
      try {
        const session = await runtime.startSession({
          principalId: context.principalId,
          ...(typeof args.objective === 'string' ? { objective: args.objective } : {}),
          ...(typeof args.execution_group_id === 'string' ? { executionGroupId: args.execution_group_id } : {}),
        })
        return { content: [{ type: 'text', text: JSON.stringify({ session }) }], structuredContent: { session } }
      } catch (error) { return publicError(error) }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'get_session',
    description: 'Read the current lifecycle state of a v8 session owned by the authenticated principal.',
    inputSchema: { session_id: z.string() },
    meta: v8ReadMeta,
    riskMapper: readRisk,
    handler: async args => {
      try {
        const session = await runtime.getSession(String(args.session_id), context.principalId)
        return { content: [{ type: 'text', text: JSON.stringify({ session }) }], structuredContent: { session } }
      } catch (error) { return publicError(error) }
    },
  })

  const lifecycleTool = (
    name: string,
    description: string,
    action: (sessionId: string, reason?: string) => Promise<unknown>,
  ) => registry.define({
    apiVersion: 8,
    name,
    description,
    inputSchema: { session_id: z.string(), reason: z.string().optional() },
    meta: v8ControlMeta,
    riskMapper: controlRisk,
    handler: async args => {
      try {
        const session = await action(
          String(args.session_id),
          typeof args.reason === 'string' ? args.reason : undefined,
        )
        return { content: [{ type: 'text', text: JSON.stringify({ session }) }], structuredContent: { session } }
      } catch (error) { return publicError(error) }
    },
  })

  lifecycleTool('pause_session', 'Pause a session after revoking its active mutation lease.',
    (sessionId, reason) => runtime.pauseSession(sessionId, context.principalId, reason))
  lifecycleTool('resume_session', 'Resume a paused session; mutation still requires a newly acquired lease.',
    sessionId => runtime.resumeSession(sessionId, context.principalId))
  lifecycleTool('take_over', 'Let the host user take over immediately by revoking control and pausing the session.',
    sessionId => runtime.takeOver(sessionId, context.principalId))
  lifecycleTool('stop_session', 'Stop a session terminally after revoking its active mutation lease.',
    (sessionId, reason) => runtime.stopSession(sessionId, context.principalId, reason))

  registry.define({
    apiVersion: 8,
    name: 'approve_action',
    description: 'Issue a short-lived grant for the exact pending action and active policy digest after explicit user review.',
    inputSchema: {
      session_id: z.string(),
      action_id: z.string(),
      ttl_ms: z.number().int().min(1_000).max(300_000).optional(),
    },
    meta: v8ControlMeta,
    riskMapper: controlRisk,
    handler: async args => {
      try {
        const grant = await runtime.approveAction(
          String(args.session_id), context.principalId, String(args.action_id),
          typeof args.ttl_ms === 'number' ? args.ttl_ms : 60_000,
        )
        return { content: [{ type: 'text', text: JSON.stringify({ grant }) }], structuredContent: { grant } }
      } catch (error) { return publicError(error) }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'complete_session',
    description: 'Complete a running session with explicit postcondition and action-count evidence.',
    inputSchema: {
      session_id: z.string(),
      summary: z.string(),
      postconditions: z.array(z.object({
        description: z.string(), satisfied: z.boolean(), evidence_hash: z.string().optional(),
      })),
      last_app_id: z.string().optional(),
      last_window_id: z.union([z.string(), z.number()]).optional(),
      action_counts: z.record(z.string(), z.number().int().nonnegative()),
      reason: z.string().optional(),
    },
    meta: v8ControlMeta,
    riskMapper: controlRisk,
    handler: async args => {
      try {
        const session = await runtime.completeSession(String(args.session_id), context.principalId, {
          summary: String(args.summary),
          postconditions: (args.postconditions as Array<Record<string, unknown>>).map(item => ({
            description: String(item.description), satisfied: Boolean(item.satisfied),
            ...(typeof item.evidence_hash === 'string' ? { evidenceHash: item.evidence_hash } : {}),
          })),
          ...(typeof args.last_app_id === 'string' ? { lastAppId: args.last_app_id } : {}),
          ...(typeof args.last_window_id === 'string' || typeof args.last_window_id === 'number'
            ? { lastWindowId: args.last_window_id }
            : {}),
          actionCounts: args.action_counts as Record<string, number>,
          ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
        })
        return { content: [{ type: 'text', text: JSON.stringify({ session }) }], structuredContent: { session } }
      } catch (error) { return publicError(error) }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'get_session_events',
    description: 'Read redacted, monotonic supervisor events with cursor pagination.',
    inputSchema: {
      session_id: z.string(),
      after_sequence: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    meta: v8ReadMeta,
    riskMapper: readRisk,
    handler: async args => {
      try {
        await runtime.getSession(String(args.session_id), context.principalId)
        const events = runtime.events.query(
          String(args.session_id),
          typeof args.after_sequence === 'number' ? args.after_sequence : 0,
          typeof args.limit === 'number' ? args.limit : 100,
        )
        const nextSequence = events.at(-1)?.sequence ?? Number(args.after_sequence ?? 0)
        const auditExport = {
          schema_uri: AUDIT_EXPORT_SCHEMA_URI,
          schema_digest: AUDIT_EXPORT_SCHEMA_DIGEST,
          events,
          next_sequence: nextSequence,
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(auditExport) }],
          structuredContent: auditExport,
        }
      } catch (error) { return publicError(error) }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'submit_follow_up',
    description: 'Submit a bounded, principal-owned steering instruction to a nonterminal session. Text remains memory-only.',
    inputSchema: { session_id: z.string(), instruction: z.string().min(1).max(16_384) },
    meta: v8ControlMeta,
    riskMapper: controlRisk,
    handler: async args => {
      try {
        const followUp = await runtime.submitFollowUp(
          String(args.session_id), context.principalId, String(args.instruction),
        )
        return { content: [{ type: 'text', text: JSON.stringify({ follow_up: followUp }) }], structuredContent: { follow_up: followUp } }
      } catch (error) { return publicError(error) }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'get_follow_ups',
    description: 'Read principal-owned session steering instructions with monotonic cursor pagination.',
    inputSchema: {
      session_id: z.string(),
      after_sequence: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    meta: v8ReadMeta,
    riskMapper: readRisk,
    handler: async args => {
      try {
        const followUps = await runtime.getFollowUps(
          String(args.session_id), context.principalId,
          typeof args.after_sequence === 'number' ? args.after_sequence : 0,
          typeof args.limit === 'number' ? args.limit : 100,
        )
        const nextSequence = followUps.at(-1)?.sequence ?? Number(args.after_sequence ?? 0)
        const response = { follow_ups: followUps, next_sequence: nextSequence }
        return { content: [{ type: 'text', text: JSON.stringify(response) }], structuredContent: response }
      } catch (error) { return publicError(error) }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'delete_session',
    description: 'Permanently delete one caller-owned terminal session and its retained event stream. Requires an explicit confirmation literal.',
    inputSchema: { session_id: z.string(), confirm: z.literal(true) },
    meta: v8ControlMeta,
    riskMapper: controlRisk,
    handler: async args => {
      try {
        const deletion = await runtime.deleteSession(String(args.session_id), context.principalId)
        return {
          content: [{ type: 'text', text: JSON.stringify({ deletion }) }],
          structuredContent: { deletion },
        }
      } catch (error) { return publicError(error) }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'prune_sessions',
    description: 'Permanently delete caller-owned terminal sessions older than a timestamp, bounded by limit. Requires an explicit confirmation literal.',
    inputSchema: {
      older_than: z.string(),
      limit: z.number().int().positive().max(1000).optional(),
      confirm: z.literal(true),
    },
    meta: v8ControlMeta,
    riskMapper: controlRisk,
    handler: async args => {
      try {
        const deletions = await runtime.pruneSessions(
          context.principalId,
          new Date(String(args.older_than)),
          typeof args.limit === 'number' ? args.limit : 100,
        )
        return {
          content: [{ type: 'text', text: JSON.stringify({ deletions, deleted: deletions.length }) }],
          structuredContent: { deletions, deleted: deletions.length },
        }
      } catch (error) { return publicError(error) }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'reserve_target',
    description: 'Declare short-lived planner intent for an app/window and fail early when another agent has a conflicting reservation. This does not grant mutation authority.',
    inputSchema: {
      session_id: z.string(),
      intent_id: z.string(),
      execution_group_id: z.string().optional(),
      agent_id: z.string().optional(),
      app_id: z.string(),
      window_id: z.union([z.string(), z.number()]).optional(),
      ttl_ms: z.number().int().positive().max(300_000),
    },
    meta: v8ControlMeta,
    riskMapper: controlRisk,
    handler: async args => {
      try {
        const reservation = await runtime.reserveTarget({
          sessionId: String(args.session_id),
          principalId: context.principalId,
          intentId: String(args.intent_id),
          ...(typeof args.execution_group_id === 'string' ? { executionGroupId: args.execution_group_id } : {}),
          ...(typeof args.agent_id === 'string' ? { agentId: args.agent_id } : {}),
          appId: String(args.app_id),
          ...(typeof args.window_id === 'string' || typeof args.window_id === 'number'
            ? { windowId: args.window_id }
            : {}),
          ttlMs: Number(args.ttl_ms),
        })
        return {
          content: [{ type: 'text', text: JSON.stringify({ reservation }) }],
          structuredContent: { reservation },
        }
      } catch (error) { return publicError(error) }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'release_target_reservation',
    description: 'Release a caller-owned planner target reservation without changing the desktop control lease.',
    inputSchema: { session_id: z.string(), reservation_id: z.string() },
    meta: v8ControlMeta,
    riskMapper: controlRisk,
    handler: async args => {
      try {
        const reservation = await runtime.releaseTargetReservation(
          String(args.session_id), context.principalId, String(args.reservation_id),
        )
        return reservation
          ? {
              content: [{ type: 'text', text: JSON.stringify({ reservation }) }],
              structuredContent: { reservation },
            }
          : errJson({ error: 'reservation_not_active', reservation_id: args.reservation_id })
      } catch (error) { return publicError(error) }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'get_execution_capabilities',
    description: 'Report enforced execution modes and interference for an existing computer-use operation.',
    inputSchema: { tool: z.string(), app_id: z.string().optional() },
    meta: v8ReadMeta,
    riskMapper: readRisk,
    handler: async args => {
      const tool = String(args.tool)
      const meta = registry.getMeta(tool)
      if (!meta) return errJson({ error: 'unknown_tool', tool })
      const capabilities = runtime.getExecutionCapabilities(tool, typeof args.app_id === 'string' ? args.app_id : '*')
      return {
        content: [{ type: 'text', text: JSON.stringify({ capabilities }) }],
        structuredContent: { capabilities },
      }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'get_certification_trace',
    description: 'Read a redacted, digest-verifiable capability certification trace by its explicit identifier.',
    inputSchema: { certification_id: z.string().regex(/^cert_[a-f0-9]{32}$/) },
    meta: v8ReadMeta,
    riskMapper: readRisk,
    handler: async args => {
      if (!services.certification) return errJson({ error: 'certification_unavailable' })
      try {
        const trace = await services.certification.traces.get(String(args.certification_id))
        if (!trace) return errJson({ error: 'certification_not_found' })
        return {
          content: [{ type: 'text', text: JSON.stringify({ trace }) }],
          structuredContent: { trace } as unknown as Record<string, unknown>,
        }
      } catch (error) { return publicError(error) }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'preview_action',
    description: 'Classify and preview an action without mutating desktop state. Reports mode, interference, policy, and blockers.',
    inputSchema: actionSchema,
    meta: v8ReadMeta,
    riskMapper: readRisk,
    handler: async args => {
      try {
        if (!registry.isWithinMaximum(String(args.tool))) {
          return errJson({ error: 'tool_outside_host_profile', tool: args.tool })
        }
        if (args.tool === 'openai_computer') {
          return errJson({
            error: 'provider_adapter_requires_translation',
            remediation: 'Translate one provider action with adaptProviderAction before preview_action.',
          })
        }
        const preview = await runtime.preview(requestFromArgs(args, context.principalId))
        return { content: [{ type: 'text', text: JSON.stringify(preview) }], structuredContent: preview as unknown as Record<string, unknown> }
      } catch (error) {
        return publicError(error)
      }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'execute_action',
    description: 'Execute an approved, evidence-bound action through v8 policy, lease, interruption, and idempotent receipt enforcement.',
    inputSchema: { ...actionSchema, action_id: z.string(), lease_id: z.string().optional() },
    meta: v8DynamicMeta,
    riskMapper: args => registry.classify(String(args.tool), (args.arguments ?? {}) as Record<string, unknown>) ?? controlRisk(),
    handler: async (args, signal) => {
      try {
        if (!registry.isWithinMaximum(String(args.tool))) {
          return errJson({ error: 'tool_outside_host_profile', tool: args.tool })
        }
        if (args.tool === 'openai_computer') {
          return errJson({
            error: 'provider_adapter_requires_translation',
            remediation: 'Translate one provider action with adaptProviderAction before execute_action.',
          })
        }
        const outcome = await runtime.execute(requestFromArgs(args, context.principalId), signal)
        if (outcome.receipt.status !== 'committed') {
          return errJson({ error: outcome.receipt.status, receipt: outcome.receipt })
        }
        const result = outcome.receipt.result
        return {
          content: [
            ...(result?.content ?? []),
            { type: 'text' as const, text: JSON.stringify({ receipt: outcome.receipt, replay: outcome.replay }) },
          ],
          structuredContent: {
            receipt: outcome.receipt,
            replay: outcome.replay,
            ...(result?.structuredContent ? { output: result.structuredContent } : {}),
          },
        }
      } catch (error) {
        return publicError(error)
      }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'acquire_control_lease',
    description: 'Acquire or queue the single desktop mutation lease with TTL, action budget, and target boundaries.',
    inputSchema: {
      session_id: z.string(),
      agent_id: z.string().optional(),
      kind: z.enum(['cooperative', 'exclusive']),
      mode: z.enum(['background', 'foreground']),
      ttl_ms: z.number().int().positive().max(300_000),
      action_budget: z.number().int().positive().max(10_000),
      priority: z.number().int().optional(),
      app_ids: z.array(z.string()).optional(),
      window_ids: z.array(z.union([z.string(), z.number()])).optional(),
      display_ids: z.array(z.string()).optional(),
    },
    meta: v8ControlMeta,
    riskMapper: controlRisk,
    handler: async (args, signal) => {
      try {
        const lease = await runtime.leases.acquire({
          sessionId: String(args.session_id), principalId: context.principalId,
          ...(typeof args.agent_id === 'string' ? { agentId: args.agent_id } : {}),
          kind: args.kind as 'cooperative' | 'exclusive', executionMode: args.mode as 'background' | 'foreground',
          ttlMs: Number(args.ttl_ms), actionBudget: Number(args.action_budget),
          ...(typeof args.priority === 'number' ? { priority: args.priority } : {}),
          boundaries: {
            ...(Array.isArray(args.app_ids) ? { appIds: args.app_ids as string[] } : {}),
            ...(Array.isArray(args.window_ids) ? { windowIds: args.window_ids as Array<string | number> } : {}),
            ...(Array.isArray(args.display_ids) ? { displayIds: args.display_ids as string[] } : {}),
          },
          signal,
        })
        return { content: [{ type: 'text', text: JSON.stringify({ lease }) }], structuredContent: { lease } }
      } catch (error) {
        return publicError(error)
      }
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'release_control_lease',
    description: 'Release the caller-owned desktop mutation lease and grant the next queued request.',
    inputSchema: { lease_id: z.string() },
    meta: v8ControlMeta,
    riskMapper: controlRisk,
    handler: async args => {
      const lease = runtime.leases.release(String(args.lease_id))
      return lease
        ? { content: [{ type: 'text', text: JSON.stringify({ lease }) }], structuredContent: { lease } }
        : errJson({ error: 'lease_not_active', lease_id: args.lease_id })
    },
  })

  registry.define({
    apiVersion: 8,
    name: 'emergency_stop',
    description: 'Atomically revoke active control and reject queued mutation requests. Reset requires an explicit host-side action.',
    inputSchema: { reason: z.string().optional() },
    meta: v8StopMeta,
    riskMapper: controlRisk,
    handler: async args => {
      runtime.emergencyStop(typeof args.reason === 'string' ? args.reason : undefined)
      return { content: [{ type: 'text', text: JSON.stringify({ stopped: true }) }], structuredContent: { stopped: true } }
    },
  })
}
