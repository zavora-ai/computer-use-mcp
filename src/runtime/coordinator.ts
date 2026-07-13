import { createHash, randomUUID } from 'node:crypto'
import type { ToolResult } from '../result.js'
import { ControlLeaseManager } from '../control/lease.js'
import type { EmergencyStopMonitor, InputActivityMonitor } from '../control/activity-monitor.js'
import { TargetReservationManager, type TargetReservation } from '../control/reservation.js'
import { MemoryReceiptStore, type ExecutionReceipt, type ReceiptStore } from '../control/receipts.js'
import type { DesktopStateSnapshot, TransactionHooks } from '../control/transaction.js'
import { defaultPolicyEvaluator, type PolicyDecision, type PolicyEvaluator } from '../policy/evaluate.js'
import { MemoryApprovalGrantStore, type ApprovalGrantStore } from '../policy/grants.js'
import { SupervisorEventBus } from '../session/events.js'
import {
  MemoryEvidenceFrameStore,
  type EvidenceFrame,
  type EvidenceFrameMetadata,
  type EvidenceFramePhase,
} from '../session/evidence-frames.js'
import { SessionLifecycle } from '../session/lifecycle.js'
import { MemorySessionStore, type RuntimeSession, type SessionCompletionEvidence } from '../session/store.js'
import { getToolMeta, type ToolMeta } from '../tool-catalog.js'
import { classifyToolAction } from './action.js'
import { BROWSER_BRIDGE_OPERATIONS, validateBrowserActionArguments } from './browser-bridge.js'
import { capabilityForTool, supportsMode, type CapabilityRegistry } from './capabilities.js'
import {
  RuntimeError,
  type ActionEnvelope,
  type ActionResourceContext,
  type ActionProvenance,
  type DataLabel,
  type ExecutionCapability,
  type ExecutionMode,
  type TargetEvidence,
} from './types.js'

export interface ActionRequest {
  sessionId: string
  actionId?: string
  attempt?: number
  executionGroupId?: string
  principalId: string
  agentId?: string
  tool: string
  operation?: string
  /** Explicit adapter certification; operation labels alone never grant background authority. */
  certificationId?: string
  args: Record<string, unknown>
  mode: ExecutionMode
  target?: TargetEvidence
  dataLabels?: DataLabel[]
  expiresInMs?: number
  leaseId?: string
  approvalGrantId?: string
  provenance?: ActionProvenance
}

export interface ActionPreview {
  envelope: ActionEnvelope
  capability: ExecutionCapability
  policy: PolicyDecision
  executable: boolean
  blocker?: 'shadow_mutation' | 'foreground_required' | 'input_attribution_unavailable' | 'target_evidence_required' | 'approval_required' | 'policy_denied'
}

export interface ExecutionOutcome {
  preview: ActionPreview
  receipt: ExecutionReceipt<ToolResult>
  replay: boolean
}

export interface SessionDeletionResult {
  sessionId: string
  deleted: boolean
  deletedEvents: number
  deletedReceipts: number
  deletedEvidenceFrames: number
  revokedGrants: number
  retainedEvents: number
  retentionMarkerId?: string
}

export interface SessionFollowUp {
  followUpId: string
  sequence: number
  sessionId: string
  principalId: string
  instruction: string
  createdAt: string
}

export type ActionExecutor = (
  tool: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  envelope?: Readonly<ActionEnvelope>,
) => Promise<ToolResult>

export type TargetValidator = (target: TargetEvidence, envelope: ActionEnvelope) => Promise<boolean> | boolean

export interface RuntimeCoordinatorOptions {
  execute: ActionExecutor
  leases?: ControlLeaseManager
  receipts?: ReceiptStore
  events?: SupervisorEventBus
  policy?: PolicyEvaluator
  capabilities?: CapabilityRegistry
  validateTarget?: TargetValidator
  now?: () => Date
  maxTargetAgeMs?: number
  activityMonitor?: InputActivityMonitor
  emergencyStopMonitor?: EmergencyStopMonitor
  /** Native fail-closed latch invoked for API/supervisor stops. */
  nativeEmergencyStop?: () => void
  /** Trusted-host reset paired with the native latch; never model-callable. */
  nativeEmergencyReset?: () => void
  nativeEmergencyStatus?: () => {
    active: boolean
    generation: number
    supported: boolean
    backend: string
    chord?: string
  }
  /** Fail closed for physical input unless the OS monitor excludes injected events. */
  requireAttributedPhysicalInput?: boolean
  grants?: ApprovalGrantStore
  lifecycle?: SessionLifecycle
  requireManagedSession?: boolean
  transactionHooks?: TransactionHooks
  /** Resolve host-internal v8 actuators without adding them to the frozen v7 catalog. */
  resolveToolMeta?: (tool: string) => ToolMeta | undefined
  reservations?: TargetReservationManager
  /** Explicit opt-in short-lived process-memory-only supervisor frames. */
  evidenceFrames?: MemoryEvidenceFrameStore
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function digestAction(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export class RuntimeCoordinator {
  readonly leases: ControlLeaseManager
  readonly receipts: ReceiptStore
  readonly events: SupervisorEventBus
  readonly #execute: ActionExecutor
  readonly #policy: PolicyEvaluator
  readonly #capabilities?: CapabilityRegistry
  readonly #validateTarget?: TargetValidator
  readonly #now: () => Date
  readonly #maxTargetAgeMs: number
  readonly #activityMonitor?: InputActivityMonitor
  readonly #emergencyStopMonitor?: EmergencyStopMonitor
  readonly #nativeEmergencyStop?: () => void
  readonly #nativeEmergencyReset?: () => void
  readonly #nativeEmergencyStatus?: RuntimeCoordinatorOptions['nativeEmergencyStatus']
  readonly #requireAttributedPhysicalInput: boolean
  readonly grants: ApprovalGrantStore
  readonly sessions: SessionLifecycle
  readonly reservations: TargetReservationManager
  readonly evidenceFrames?: MemoryEvidenceFrameStore
  readonly #requireManagedSession: boolean
  readonly #transactionHooks?: TransactionHooks
  readonly #resolveToolMeta: (tool: string) => ToolMeta | undefined
  readonly #pendingApprovals = new Map<string, ActionPreview>()
  readonly #emergencyListeners = new Set<(status: ReturnType<RuntimeCoordinator['emergencyStopStatus']>) => void>()
  readonly #followUps = new Map<string, SessionFollowUp[]>()
  readonly #activeExecutions = new Map<string, {
    sessionId: string
    leaseId: string
    controller: AbortController
  }>()
  readonly #unsubscribeLeaseRevocation: () => void

  constructor(options: RuntimeCoordinatorOptions) {
    this.#execute = options.execute
    this.leases = options.leases ?? new ControlLeaseManager()
    this.receipts = options.receipts ?? new MemoryReceiptStore()
    this.events = options.events ?? new SupervisorEventBus()
    this.#policy = options.policy ?? defaultPolicyEvaluator
    this.#capabilities = options.capabilities
    this.#validateTarget = options.validateTarget
    this.#now = options.now ?? (() => new Date())
    this.#maxTargetAgeMs = options.maxTargetAgeMs ?? 30_000
    this.#activityMonitor = options.activityMonitor
    this.#emergencyStopMonitor = options.emergencyStopMonitor
    this.#nativeEmergencyStop = options.nativeEmergencyStop
    this.#nativeEmergencyReset = options.nativeEmergencyReset
    this.#nativeEmergencyStatus = options.nativeEmergencyStatus
    this.#requireAttributedPhysicalInput = options.requireAttributedPhysicalInput ?? false
    this.grants = options.grants ?? new MemoryApprovalGrantStore()
    this.sessions = options.lifecycle ?? new SessionLifecycle(new MemorySessionStore(), this.events)
    this.reservations = options.reservations ?? new TargetReservationManager()
    this.evidenceFrames = options.evidenceFrames
    this.#requireManagedSession = options.requireManagedSession ?? false
    this.#transactionHooks = options.transactionHooks
    this.#resolveToolMeta = options.resolveToolMeta ?? getToolMeta
    this.#unsubscribeLeaseRevocation = this.leases.onRevoked(lease => {
      for (const active of this.#activeExecutions.values()) {
        if (active.leaseId === lease.leaseId) active.controller.abort(lease.revokedReason ?? lease.state)
      }
    })
    this.#activityMonitor?.start(activity => {
      const revoked = this.leases.recordUserActivity(activity.at)
      if (revoked) {
        this.events.publish({
          sessionId: revoked.sessionId,
          principalId: revoked.principalId,
          type: 'control.user_activity_revoked',
          payload: {
            leaseId: revoked.leaseId,
            latencyMs: activity.latencyMs,
            backend: activity.backend,
          },
        })
      }
    })
    this.#emergencyStopMonitor?.start(event => {
      this.emergencyStop(`physical_emergency_chord:${event.backend}:${event.generation}`, true)
    })
  }

  async preview(request: ActionRequest): Promise<ActionPreview> {
    await this.#assertSession(request.sessionId, request.principalId)
    if (request.tool === 'openai_computer') {
      throw new RuntimeError(
        'policy_denied',
        'batched provider compatibility wrappers cannot cross the v8 action boundary; translate one action first',
      )
    }
    const meta = this.#meta(request.tool)
    const classification = classifyToolAction(request.tool, request.args, meta)
    const now = this.#now()
    const actionId = request.actionId ?? randomUUID()
    const operation = request.operation ?? this.#operation(request)
    const resource = this.#resourceContext(request)
    const dataLabels = [...(request.dataLabels ?? ['unknown'])]
    const argsDigest = digestAction({
      tool: request.tool,
      operation,
      args: request.args,
      mode: request.mode,
      target: request.target,
      resource,
      dataLabels,
      provenance: request.provenance,
    })
    const envelope: ActionEnvelope = {
      actionId,
      sessionId: request.sessionId,
      ...(request.executionGroupId ? { executionGroupId: request.executionGroupId } : {}),
      principalId: request.principalId,
      ...(request.agentId ? { agentId: request.agentId } : {}),
      tool: request.tool,
      operation,
      actionClass: classification.actionClass,
      requestedMode: request.mode,
      ...(request.target ? { target: structuredClone(request.target) } : {}),
      ...(Object.keys(resource).length ? { resource } : {}),
      ...(request.provenance ? { provenance: structuredClone(request.provenance) } : {}),
      dataLabels,
      reversible: classification.reversible,
      externalSideEffect: classification.externalSideEffect,
      proposedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (request.expiresInMs ?? 30_000)).toISOString(),
      argsDigest,
    }
    const capability = await this.#selectCapability(request, meta, operation)
    const policy = await this.#policy(envelope)

    let blocker: ActionPreview['blocker']
    if (request.mode === 'shadow' && meta.mutates) blocker = 'shadow_mutation'
    else if (!supportsMode(capability, request.mode)) blocker = 'foreground_required'
    else if (
      this.#requireAttributedPhysicalInput
      && (meta.physicalInput || meta.movesUserCursor)
      && (!this.#activityMonitor?.capability.supported || !this.#activityMonitor.capability.distinguishesInjected)
    ) blocker = 'input_attribution_unavailable'
    else if (policy.decision === 'deny') blocker = 'policy_denied'
    else if (this.#requiresTargetEvidence(request, meta) && !request.target) blocker = 'target_evidence_required'
    else if (policy.decision === 'confirm') {
      if (!request.approvalGrantId) blocker = 'approval_required'
      else {
        try { this.grants.validate(request.approvalGrantId, envelope, policy.policyDigest) }
        catch { blocker = 'approval_required' }
      }
    }

    const preview: ActionPreview = { envelope, capability, policy, executable: !blocker, ...(blocker ? { blocker } : {}) }
    if (blocker === 'approval_required') {
      this.#pendingApprovals.set(`${request.sessionId}\u0000${actionId}`, structuredClone(preview))
    }
    this.events.publish({
      sessionId: request.sessionId,
      actionId,
      principalId: request.principalId,
      type: 'action.previewed',
      payload: {
        tool: request.tool,
        operation,
        mode: request.mode,
        actionClass: classification.actionClass,
        interference: capability.interference,
        policyDecision: policy.decision,
        executable: preview.executable,
        ...(blocker ? { blocker } : {}),
      },
    })
    if (blocker === 'approval_required') {
      this.events.publish({
        sessionId: request.sessionId,
        actionId,
        principalId: request.principalId,
        type: 'action.approval_required',
        payload: {
          actionDigest: envelope.argsDigest,
          tool: envelope.tool,
          operation: envelope.operation,
          actionClass: envelope.actionClass,
          mode: envelope.requestedMode,
          expiresAt: envelope.expiresAt,
          targetAppId: envelope.target?.appId ?? null,
          targetWindowId: envelope.target?.windowId ?? null,
          reasons: policy.reasons,
        },
      })
    }
    return preview
  }

  getExecutionCapabilities(tool: string, appId = '*', operation = tool): ExecutionCapability[] {
    const meta = this.#meta(tool)
    const certified = this.#capabilities?.find(appId, operation) ?? []
    return certified.length ? certified.sort((a, b) => b.confidence - a.confidence) : [capabilityForTool(tool, meta, appId)]
  }

  async execute(request: ActionRequest, signal?: AbortSignal): Promise<ExecutionOutcome> {
    if (!request.actionId) throw new TypeError('execute requires an explicit actionId for idempotency')
    const preview = await this.preview(request)
    if (!preview.executable) throw this.#blockerError(preview)
    if (this.#now().getTime() >= Date.parse(preview.envelope.expiresAt)) {
      throw new RuntimeError('stale_target', 'action proposal expired before execution')
    }

    if (preview.policy.decision === 'confirm') {
      if (!request.approvalGrantId) throw new RuntimeError('approval_required', 'action-bound approval is required')
      this.grants.consume(request.approvalGrantId, preview.envelope, preview.policy.policyDigest)
      this.#pendingApprovals.delete(`${request.sessionId}\u0000${request.actionId}`)
    }

    const begun = await this.receipts.begin({
      sessionId: request.sessionId,
      actionId: request.actionId,
      actionDigest: preview.envelope.argsDigest,
      attempt: request.attempt ?? 1,
    })
    if (begun.replay) {
      if (begun.receipt.status === 'pending') {
        throw new RuntimeError('indeterminate', 'prior execution may have crossed the side-effect boundary', {
          receiptId: begun.receipt.receiptId,
        })
      }
      return { preview, receipt: begun.receipt as ExecutionReceipt<ToolResult>, replay: true }
    }

    const meta = this.#meta(request.tool)
    let crossedSideEffectBoundary = false
    let snapshot: DesktopStateSnapshot | undefined
    let leaseExpiryTimer: NodeJS.Timeout | undefined
    const actionController = new AbortController()
    const abortFromCaller = () => actionController.abort(signal?.reason)
    if (signal?.aborted) abortFromCaller()
    else signal?.addEventListener('abort', abortFromCaller, { once: true })
    if (meta.mutates && request.leaseId) {
      this.#activeExecutions.set(request.actionId, {
        sessionId: request.sessionId,
        leaseId: request.leaseId,
        controller: actionController,
      })
    }
    try {
      if (meta.mutates) {
        if (!request.leaseId) throw new RuntimeError('lease_conflict', 'mutating execution requires a lease')
        const lease = this.leases.validate(request.leaseId, {
          appId: request.target?.appId ?? preview.envelope.resource?.targetAppId,
          windowId: request.target?.windowId ?? preview.envelope.resource?.targetWindowId,
          displayId: request.target?.displayId,
        })
        leaseExpiryTimer = setTimeout(() => {
          this.leases.revoke(request.leaseId!, 'lease_expired')
        }, Math.max(0, Date.parse(lease.expiresAt) - Date.now()))
        leaseExpiryTimer.unref()
        await this.#revalidateTarget(preview.envelope)
        if (actionController.signal.aborted) throw new RuntimeError('interrupted', 'action cancelled before execution')
        if (preview.capability.backend !== 'browser') {
          snapshot = await this.#transactionHooks?.capture(preview.envelope)
          await this.#captureEvidence(preview.envelope, 'before')
          // Evidence capture is an observation between validation and actuation;
          // close that TOCTOU window before consuming the one-shot lease.
          await this.#revalidateTarget(preview.envelope)
        }
        this.leases.consume(request.leaseId)
        if (actionController.signal.aborted) throw new RuntimeError('interrupted', 'control lease revoked before execution')
      }

      this.events.publish({
        sessionId: request.sessionId,
        actionId: request.actionId,
        principalId: request.principalId,
        type: 'action.started',
        payload: { tool: request.tool, mode: request.mode, leaseId: request.leaseId ?? null },
      })
      if (meta.physicalInput || meta.movesUserCursor) {
        // Attributed backends exclude synthetic input at the OS boundary and
        // must never suppress real takeover. Legacy/unattributed backends keep
        // a narrowly documented compatibility window only when the host did
        // not opt into fail-closed attribution.
        if (this.#activityMonitor && !this.#activityMonitor.capability.distinguishesInjected) {
          this.#activityMonitor.suppressInjectedFor(500)
        }
      }
      let executor = this.#execute
      if (preview.capability.certification) {
        const certified = await this.#capabilities?.resolveBinding({
          appId: preview.capability.appId,
          operation: preview.capability.operation,
          certificationId: preview.capability.certification.certificationId,
          tool: request.tool,
          args: request.args,
        })
        if (!certified) {
          throw new RuntimeError(
            'foreground_required',
            'background certification changed or expired before execution',
          )
        }
        if (certified.binding.execute) {
          executor = (_tool, args, executionSignal) => certified.binding.execute!(args, executionSignal)
        }
      }
      crossedSideEffectBoundary = meta.mutates
      const result = await executor(request.tool, request.args, actionController.signal, preview.envelope)
      if (meta.mutates && actionController.signal.aborted) {
        throw new RuntimeError('indeterminate', 'control was revoked while the action was executing')
      }
      if (result.isError) {
        throw new RuntimeError(
          meta.mutates ? 'indeterminate' : 'execution_failed',
          meta.mutates
            ? 'mutating handler returned an error after entering the side-effect boundary'
            : 'observation handler returned an error',
          { tool: request.tool },
        )
      }
      if (meta.mutates && this.#transactionHooks && preview.capability.backend !== 'browser') {
        const verification = await this.#transactionHooks.verify(preview.envelope, result)
        this.events.publish({
          sessionId: request.sessionId,
          actionId: request.actionId,
          principalId: request.principalId,
          type: 'action.verified',
          payload: { verified: verification.verified, method: verification.method },
        })
        if (!verification.verified) {
          throw new RuntimeError('indeterminate', 'postcondition verification failed', { method: verification.method })
        }
        await this.#revalidateTarget(preview.envelope)
        await this.#captureEvidence(preview.envelope, 'after')
      } else if (!meta.mutates) {
        this.#recordEvidence(preview.envelope, 'observation', result)
      }
      if (snapshot && this.#transactionHooks && request.leaseId) {
        const active = this.leases.current()
        if (active?.leaseId === request.leaseId) {
          const restoration = await this.#transactionHooks.restore(snapshot, preview.envelope)
          this.events.publish({
            sessionId: request.sessionId,
            actionId: request.actionId,
            principalId: request.principalId,
            type: 'action.restored',
            payload: restoration as unknown as Record<string, unknown>,
          })
          if (!restoration.restored) {
            throw new RuntimeError('indeterminate', 'cursor/focus restoration failed')
          }
        }
      }
      const receipt = await this.receipts.finish(begun.receipt.receiptId, { status: 'committed', result })
      this.events.publish({
        sessionId: request.sessionId,
        actionId: request.actionId,
        principalId: request.principalId,
        type: 'action.committed',
        payload: { receiptId: receipt.receiptId, leaseId: request.leaseId ?? null },
      })
      return { preview, receipt: receipt as ExecutionReceipt<ToolResult>, replay: false }
    } catch (error) {
      const runtimeError = error instanceof RuntimeError ? error : undefined
      const status = crossedSideEffectBoundary
        ? 'indeterminate'
        : runtimeError?.code === 'interrupted'
          ? 'interrupted'
          : 'rejected'
      if (status === 'indeterminate' && request.leaseId) {
        this.leases.revoke(request.leaseId, 'action_indeterminate')
      }
      const receipt = await this.receipts.finish(begun.receipt.receiptId, {
        status,
        error: { code: runtimeError?.code ?? 'execution_error', message: error instanceof Error ? error.message : String(error) },
      })
      this.events.publish({
        sessionId: request.sessionId,
        actionId: request.actionId,
        principalId: request.principalId,
        type: `action.${status}`,
        payload: { receiptId: receipt.receiptId, code: receipt.error?.code ?? 'execution_error' },
      })
      throw error
    } finally {
      if (leaseExpiryTimer) clearTimeout(leaseExpiryTimer)
      signal?.removeEventListener('abort', abortFromCaller)
      this.#activeExecutions.delete(request.actionId)
    }
  }

  emergencyStop(reason?: string, nativeAlreadyLatched = false): void {
    if (!nativeAlreadyLatched) {
      try { this.#nativeEmergencyStop?.() }
      catch { /* the cooperative boundary must still stop if the native latch reports failure */ }
    }
    const revoked = this.leases.emergencyStop(reason)
    if (revoked) {
      this.events.publish({
        sessionId: revoked.sessionId,
        principalId: revoked.principalId,
        type: 'control.emergency_stopped',
        payload: {
          leaseId: revoked.leaseId,
          reasonDigest: `sha256:${createHash('sha256')
            .update(revoked.revokedReason ?? 'emergency_stop')
            .digest('hex')}`,
        },
      })
    }
    this.#notifyEmergencyStatus()
  }

  /** Trusted host/operator recovery only. This is deliberately absent from MCP tools. */
  resetEmergencyStop(): void {
    this.#nativeEmergencyReset?.()
    this.leases.resetEmergencyStop()
    this.#notifyEmergencyStatus()
  }

  onEmergencyStopChanged(
    listener: (status: ReturnType<RuntimeCoordinator['emergencyStopStatus']>) => void,
  ): () => void {
    this.#emergencyListeners.add(listener)
    return () => this.#emergencyListeners.delete(listener)
  }

  emergencyStopStatus(): {
    active: boolean
    generation: number
    supported: boolean
    backend: string
    chord?: string
  } {
    const native = this.#nativeEmergencyStatus?.()
    if (native) return { ...native, active: native.active || this.leases.emergencyStopped() }
    return {
      active: this.leases.emergencyStopped(),
      generation: 0,
      supported: false,
      backend: 'cooperative_runtime_only',
    }
  }

  #notifyEmergencyStatus(): void {
    const status = this.emergencyStopStatus()
    for (const listener of this.#emergencyListeners) {
      try { listener(status) } catch { /* emergency state propagation is best effort per observer */ }
    }
  }

  async approveAction(
    sessionId: string,
    principalId: string,
    actionId: string,
    ttlMs = 60_000,
  ) {
    await this.getSession(sessionId, principalId)
    const preview = this.#pendingApprovals.get(`${sessionId}\u0000${actionId}`)
    if (!preview || preview.envelope.principalId !== principalId) {
      throw new RuntimeError('approval_required', 'no exact pending action is available for approval')
    }
    if (this.#now().getTime() >= Date.parse(preview.envelope.expiresAt)) {
      this.#pendingApprovals.delete(`${sessionId}\u0000${actionId}`)
      throw new RuntimeError('approval_required', 'pending action expired before approval')
    }
    return this.grants.issue({
      principalId,
      sessionId,
      actionDigest: preview.envelope.argsDigest,
      policyDigest: preview.policy.policyDigest,
      actionClass: preview.envelope.actionClass,
      mode: preview.envelope.requestedMode,
      ttlMs: Math.min(ttlMs, 300_000),
      uses: 1,
    })
  }

  async startSession(input: { principalId: string; executionGroupId?: string; objective?: string }): Promise<RuntimeSession> {
    return this.sessions.start(input)
  }

  async getSession(sessionId: string, principalId: string): Promise<RuntimeSession> {
    const session = await this.sessions.store.get(sessionId)
    if (!session) throw new RuntimeError('session_not_found', 'runtime session does not exist', { sessionId })
    if (session.principalId !== principalId) throw new RuntimeError('principal_mismatch', 'session belongs to another principal')
    return session
  }

  /** Principal-scoped lifecycle view for supervisor/resource adapters. */
  async listSessions(principalId: string): Promise<RuntimeSession[]> {
    const sessions = (await this.sessions.store.list())
      .filter(session => session.principalId === principalId)
      .sort((left, right) => {
        const byUpdated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        return byUpdated !== 0 ? byUpdated : right.sessionId.localeCompare(left.sessionId)
      })
    return structuredClone(sessions)
  }

  /**
   * Fail-safe boundary for remote authorization loss, host lock, or relay loss.
   * Every active lease/reservation is revoked before owned sessions are paused.
   */
  async suspendPrincipal(principalId: string, reason = 'authorization_lost'): Promise<RuntimeSession[]> {
    if (!principalId) throw new TypeError('principalId is required')
    const affected: RuntimeSession[] = []
    const sessions = await this.listSessions(principalId)
    for (const session of sessions) {
      const lease = this.leases.current()
      if (lease?.sessionId === session.sessionId) this.leases.revoke(lease.leaseId, reason)
      this.#cancelReservations(session.sessionId, principalId, reason)
      if (session.state === 'running' || session.state === 'waiting_for_user') {
        affected.push(await this.sessions.transition(session.sessionId, 'paused_by_policy', reason))
      }
    }
    return affected
  }

  /** Memory-only steering queue; event metadata never contains instruction text. */
  async submitFollowUp(sessionId: string, principalId: string, instruction: string): Promise<SessionFollowUp> {
    const session = await this.getSession(sessionId, principalId)
    if (['completed', 'failed', 'stopped'].includes(session.state)) {
      throw new RuntimeError('session_not_running', `terminal session cannot accept follow-up instructions: ${session.state}`)
    }
    if (typeof instruction !== 'string' || !instruction.trim() || Buffer.byteLength(instruction) > 16 * 1024) {
      throw new TypeError('instruction must contain 1 to 16384 UTF-8 bytes')
    }
    const queue = this.#followUps.get(sessionId) ?? []
    if (queue.length >= 1000) throw new RuntimeError('execution_failed', 'follow-up queue limit reached')
    const followUp: SessionFollowUp = {
      followUpId: randomUUID(), sequence: (queue.at(-1)?.sequence ?? 0) + 1,
      sessionId, principalId, instruction, createdAt: this.#now().toISOString(),
    }
    queue.push(followUp)
    this.#followUps.set(sessionId, queue)
    this.events.publish({
      sessionId, principalId, type: 'session.follow_up_submitted',
      payload: {
        followUpId: followUp.followUpId,
        sequence: followUp.sequence,
        instructionMetadata: {
          digest: `sha256:${createHash('sha256').update(instruction).digest('hex')}`,
          length: instruction.length,
        },
      },
    })
    return structuredClone(followUp)
  }

  async getFollowUps(
    sessionId: string,
    principalId: string,
    afterSequence = 0,
    limit = 100,
  ): Promise<SessionFollowUp[]> {
    await this.getSession(sessionId, principalId)
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new RangeError('afterSequence must be non-negative')
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('limit must be between 1 and 1000')
    return structuredClone((this.#followUps.get(sessionId) ?? [])
      .filter(item => item.sequence > afterSequence).slice(0, limit))
  }

  async pauseSession(sessionId: string, principalId: string, reason = 'user_pause'): Promise<RuntimeSession> {
    await this.getSession(sessionId, principalId)
    const lease = this.leases.current()
    if (lease?.sessionId === sessionId) this.leases.revoke(lease.leaseId, reason)
    this.#cancelReservations(sessionId, principalId, reason)
    return this.sessions.transition(sessionId, 'paused_by_user', reason)
  }

  async resumeSession(sessionId: string, principalId: string): Promise<RuntimeSession> {
    await this.getSession(sessionId, principalId)
    return this.sessions.transition(sessionId, 'running')
  }

  async takeOver(sessionId: string, principalId: string): Promise<RuntimeSession> {
    return this.pauseSession(sessionId, principalId, 'user_takeover')
  }

  async stopSession(sessionId: string, principalId: string, reason = 'user_stop'): Promise<RuntimeSession> {
    const current = await this.getSession(sessionId, principalId)
    if (current.state === 'stopped') return current
    const lease = this.leases.current()
    if (lease?.sessionId === sessionId) this.leases.revoke(lease.leaseId, reason)
    this.#cancelReservations(sessionId, principalId, reason)
    const stopping = current.state === 'stopping'
      ? current
      : await this.sessions.transition(sessionId, 'stopping', reason)
    return this.sessions.transition(stopping.sessionId, 'stopped', reason)
  }

  async completeSession(
    sessionId: string,
    principalId: string,
    evidence: Omit<SessionCompletionEvidence, 'completedAt'>,
  ): Promise<RuntimeSession> {
    await this.getSession(sessionId, principalId)
    const lease = this.leases.current()
    if (lease?.sessionId === sessionId) this.leases.revoke(lease.leaseId, 'session_completed')
    this.#cancelReservations(sessionId, principalId, 'session_completed')
    return this.sessions.complete(sessionId, evidence)
  }

  async deleteSession(sessionId: string, principalId: string): Promise<SessionDeletionResult> {
    const session = await this.getSession(sessionId, principalId)
    if (!['completed', 'failed', 'stopped'].includes(session.state)) {
      throw new RuntimeError(
        'session_not_terminal',
        `session data can only be deleted after a terminal state; current state is ${session.state}`,
      )
    }
    const eventDeletion = this.events.deleteSession(sessionId)
    const deletedReceipts = await this.receipts.deleteSession(sessionId)
    const deletedEvidenceFrames = this.evidenceFrames?.deleteSession(sessionId) ?? 0
    const revokedGrants = this.grants.revokeSession(sessionId, principalId)
    for (const key of [...this.#pendingApprovals.keys()]) {
      if (key.startsWith(`${sessionId}\u0000`)) this.#pendingApprovals.delete(key)
    }
    this.reservations.cancelSession(sessionId, principalId, 'session_data_deleted')
    this.#followUps.delete(sessionId)
    const deleted = await this.sessions.store.delete(sessionId, session.revision)
    if (!deleted && await this.sessions.store.get(sessionId)) {
      throw new Error(`session deletion contention: ${sessionId}`)
    }
    return {
      sessionId,
      deleted: true,
      deletedEvents: eventDeletion.deletedEvents,
      deletedReceipts,
      deletedEvidenceFrames,
      revokedGrants,
      retainedEvents: eventDeletion.retainedEvents,
      ...(eventDeletion.retentionMarkerId ? { retentionMarkerId: eventDeletion.retentionMarkerId } : {}),
    }
  }

  async pruneSessions(
    principalId: string,
    olderThan: Date,
    limit = 100,
  ): Promise<SessionDeletionResult[]> {
    if (!Number.isFinite(olderThan.getTime())) throw new TypeError('olderThan must be a valid date')
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError('session prune limit must be between 1 and 1000')
    }
    const terminal = new Set(['completed', 'failed', 'stopped'])
    const candidates = (await this.sessions.store.list())
      .filter(session => session.principalId === principalId
        && terminal.has(session.state)
        && Date.parse(session.updatedAt) < olderThan.getTime())
      .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
      .slice(0, limit)
    const deleted: SessionDeletionResult[] = []
    for (const session of candidates) deleted.push(await this.deleteSession(session.sessionId, principalId))
    return deleted
  }

  async reserveTarget(input: {
    sessionId: string
    principalId: string
    intentId: string
    executionGroupId?: string
    agentId?: string
    appId: string
    windowId?: string | number
    ttlMs: number
  }): Promise<TargetReservation> {
    await this.getSession(input.sessionId, input.principalId)
    const reservation = this.reservations.reserve({
      intentId: input.intentId,
      sessionId: input.sessionId,
      principalId: input.principalId,
      ...(input.executionGroupId ? { executionGroupId: input.executionGroupId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      scope: { appId: input.appId, ...(input.windowId !== undefined ? { windowId: input.windowId } : {}) },
      ttlMs: input.ttlMs,
    })
    this.events.publish({
      sessionId: input.sessionId,
      principalId: input.principalId,
      type: 'target.reserved',
      payload: {
        reservationId: reservation.reservationId,
        intentId: reservation.intentId,
        agentId: reservation.agentId ?? null,
        appId: reservation.scope.appId,
        windowId: reservation.scope.windowId ?? null,
        expiresAt: reservation.expiresAt,
      },
    })
    return reservation
  }

  async releaseTargetReservation(
    sessionId: string,
    principalId: string,
    reservationId: string,
  ): Promise<TargetReservation | undefined> {
    await this.getSession(sessionId, principalId)
    const current = this.reservations.get(reservationId)
    if (current && current.sessionId !== sessionId) {
      throw new RuntimeError('target_conflict', 'target reservation belongs to another session')
    }
    const reservation = this.reservations.release(reservationId, principalId)
    if (reservation) {
      this.events.publish({
        sessionId,
        principalId,
        type: 'target.released',
        payload: { reservationId, intentId: reservation.intentId },
      })
    }
    return reservation
  }

  dispose(): void {
    this.#activityMonitor?.stop()
    this.#emergencyStopMonitor?.stop()
    this.#unsubscribeLeaseRevocation()
    this.#emergencyListeners.clear()
    for (const active of this.#activeExecutions.values()) active.controller.abort('runtime_disposed')
    this.#activeExecutions.clear()
    this.evidenceFrames?.clear()
  }

  async getEvidenceFrame(sessionId: string, principalId: string, frameId: string): Promise<EvidenceFrame | undefined> {
    await this.getSession(sessionId, principalId)
    return this.evidenceFrames?.get(sessionId, frameId)
  }

  async listEvidenceFrames(sessionId: string, principalId: string): Promise<EvidenceFrameMetadata[]> {
    await this.getSession(sessionId, principalId)
    return this.evidenceFrames?.list(sessionId) ?? []
  }

  async #captureEvidence(envelope: ActionEnvelope, phase: 'before' | 'after'): Promise<void> {
    if (!this.evidenceFrames || !this.#transactionHooks?.captureEvidence) return
    if (!envelope.target?.appId && envelope.target?.windowId === undefined) return
    try {
      const result = await this.#transactionHooks.captureEvidence(envelope, phase)
      if (result && !result.isError) this.#recordEvidence(envelope, phase, result)
      else if (result?.isError) this.#publishEvidenceUnavailable(envelope, phase, 'capture_error')
    } catch {
      // Visual review is observability, never a second authority or a reason to
      // convert an otherwise governed action into an indeterminate mutation.
      this.#publishEvidenceUnavailable(envelope, phase, 'capture_error')
    }
  }

  #recordEvidence(envelope: ActionEnvelope, phase: EvidenceFramePhase, result: ToolResult): boolean {
    if (!this.evidenceFrames) return false
    try {
      const frame = this.evidenceFrames.putFromToolResult({
        sessionId: envelope.sessionId, actionId: envelope.actionId, phase, result,
      })
      if (!frame) return false
      this.events.publish({
        sessionId: envelope.sessionId,
        actionId: envelope.actionId,
        principalId: envelope.principalId,
        type: 'evidence.frame_available',
        payload: {
          frameId: frame.frameId,
          phase: frame.phase,
          mimeType: frame.mimeType,
          byteLength: frame.byteLength,
          digest: frame.digest,
          capturedAt: frame.capturedAt,
          expiresAt: frame.expiresAt,
        },
      })
      return true
    } catch {
      this.#publishEvidenceUnavailable(envelope, phase, 'invalid_or_oversize')
      return false
    }
  }

  #publishEvidenceUnavailable(
    envelope: ActionEnvelope,
    phase: EvidenceFramePhase,
    code: 'capture_error' | 'invalid_or_oversize',
  ): void {
    this.events.publish({
      sessionId: envelope.sessionId,
      actionId: envelope.actionId,
      principalId: envelope.principalId,
      type: 'evidence.frame_unavailable',
      payload: { phase, code },
    })
  }

  #cancelReservations(sessionId: string, principalId: string, reason: string): void {
    for (const reservation of this.reservations.cancelSession(sessionId, principalId, reason)) {
      this.events.publish({
        sessionId,
        principalId,
        type: 'target.cancelled',
        payload: {
          reservationId: reservation.reservationId,
          intentId: reservation.intentId,
          reasonDigest: `sha256:${createHash('sha256').update(reason).digest('hex')}`,
        },
      })
    }
  }

  #meta(tool: string): ToolMeta {
    const meta = this.#resolveToolMeta(tool)
    if (!meta) throw new Error(`unknown tool: ${tool}`)
    return meta
  }

  async #assertSession(sessionId: string, principalId: string): Promise<void> {
    if (!this.#requireManagedSession) return
    const session = await this.getSession(sessionId, principalId)
    if (session.state !== 'running' && session.state !== 'waiting_for_user') {
      throw new RuntimeError('session_not_running', `session cannot execute while ${session.state}`, {
        sessionId,
        state: session.state,
      })
    }
  }

  #operation(request: ActionRequest): string {
    const mode = typeof request.args.mode === 'string' ? request.args.mode : undefined
    return mode ? `${request.tool}.${mode}` : request.tool
  }

  #resourceContext(request: ActionRequest): ActionResourceContext {
    const string = (key: string): string | undefined =>
      typeof request.args[key] === 'string' && request.args[key] ? String(request.args[key]) : undefined
    const targetAppId = request.target?.appId ?? string('target_app') ?? string('bundle_id')
    const requestedWindow = request.args.target_window_id ?? request.args.window_id
    const targetWindowId = request.target?.windowId
      ?? (typeof requestedWindow === 'string' || typeof requestedWindow === 'number' ? requestedWindow : undefined)
    const targetContext: ActionResourceContext = {
      ...(targetAppId ? { targetAppId } : {}),
      ...(targetWindowId !== undefined ? { targetWindowId } : {}),
    }
    if (request.tool === 'filesystem') {
      return {
        ...targetContext,
        ...(string('path') ? { filesystemPath: string('path') } : {}),
        ...(string('destination') ? { filesystemDestination: string('destination') } : {}),
      }
    }
    if (request.tool === 'registry') {
      return { ...targetContext, ...(string('path') ? { registryPath: string('path') } : {}) }
    }
    if (request.tool === 'process_kill') {
      return {
        ...targetContext,
        ...(string('name') ? { processName: string('name') } : {}),
        ...(typeof request.args.pid === 'number' ? { processId: request.args.pid } : {}),
      }
    }
    if (request.tool === 'scrape') {
      const url = string('url')
      if (!url) return targetContext
      try { return { ...targetContext, browserDomain: new URL(url).hostname.toLowerCase() } } catch { return targetContext }
    }
    if (request.tool === 'browser_action') {
      const operation = string('operation')
      if (!operation || !BROWSER_BRIDGE_OPERATIONS.has(operation)) {
        throw new RuntimeError('policy_denied', `unsupported browser bridge operation: ${operation ?? '(missing)'}`)
      }
      const nested = request.args.action_arguments
      const actionArguments = nested && typeof nested === 'object' && !Array.isArray(nested)
        ? nested as Record<string, unknown>
        : {}
      validateBrowserActionArguments(operation, actionArguments, request.target)
      const requested = typeof actionArguments.url === 'string' ? actionArguments.url : undefined
      const current = string('current_url')
      const raw = requested ?? current
      if (!raw) return targetContext
      let parsed: URL
      try { parsed = new URL(raw) } catch { throw new TypeError('browser action URL must be absolute') }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new TypeError('browser action URL must use http or https')
      }
      return { ...targetContext, browserDomain: parsed.hostname.toLowerCase() }
    }
    return targetContext
  }

  async #selectCapability(request: ActionRequest, meta: ToolMeta, operation: string): Promise<ExecutionCapability> {
    const appId = request.target?.appId ?? (typeof request.args.target_app === 'string' ? request.args.target_app : '*')
    if (request.certificationId && this.#capabilities) {
      const certified = await this.#capabilities.resolve({
        appId,
        operation,
        certificationId: request.certificationId,
        tool: request.tool,
        args: request.args,
      })
      if (certified) return certified
    }
    return capabilityForTool(request.tool, meta, appId)
  }

  async #revalidateTarget(envelope: ActionEnvelope): Promise<void> {
    if (!envelope.target) return
    if (this.#now().getTime() - Date.parse(envelope.target.capturedAt) > this.#maxTargetAgeMs) {
      throw new RuntimeError('stale_target', 'target evidence is too old', { observationId: envelope.target.observationId })
    }
    if (!this.#validateTarget) {
      throw new RuntimeError('stale_target', 'target evidence validator is unavailable', {
        observationId: envelope.target.observationId,
      })
    }
    if (!(await this.#validateTarget(envelope.target, envelope))) {
      throw new RuntimeError('stale_target', 'target evidence no longer matches the desktop', { observationId: envelope.target.observationId })
    }
  }

  #requiresTargetEvidence(request: ActionRequest, meta: ToolMeta): boolean {
    if (!meta.mutates) return false
    if (meta.physicalInput || meta.movesUserCursor) return true
    return new Set([
      'click_element', 'set_value', 'press_button', 'select_menu_item', 'fill_form', 'browser_action',
    ]).has(request.tool)
  }

  #blockerError(preview: ActionPreview): RuntimeError {
    switch (preview.blocker) {
      case 'shadow_mutation': return new RuntimeError('shadow_mutation', 'shadow mode cannot mutate desktop state')
      case 'foreground_required': return new RuntimeError('foreground_required', 'requested mode is not supported without foreground interference', { capability: preview.capability })
      case 'input_attribution_unavailable': return new RuntimeError(
        'input_attribution_unavailable',
        'physical input is disabled because the native monitor cannot distinguish user input from injected input',
        { inputMonitor: this.#activityMonitor?.capability ?? { supported: false } },
      )
      case 'target_evidence_required': return new RuntimeError('stale_target', 'fresh target evidence is required for this mutation')
      case 'approval_required': return new RuntimeError('approval_required', 'policy requires an action-bound approval', { policy: preview.policy })
      default: return new RuntimeError('policy_denied', 'policy denied the action', { policy: preview.policy })
    }
  }
}
