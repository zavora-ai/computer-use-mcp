import { randomUUID } from 'node:crypto'
import { RuntimeError, type ExecutionMode } from '../runtime/types.js'

export type LeaseKind = 'cooperative' | 'exclusive'
export type LeaseState = 'active' | 'released' | 'revoked' | 'expired'

export interface LeaseBoundaries {
  appIds?: string[]
  windowIds?: Array<string | number>
  displayIds?: string[]
}

export interface ControlLease {
  leaseId: string
  revision: number
  sessionId: string
  principalId: string
  agentId?: string
  kind: LeaseKind
  executionMode: ExecutionMode
  state: LeaseState
  acquiredAt: string
  expiresAt: string
  actionBudget: number
  actionsUsed: number
  boundaries: LeaseBoundaries
  revokedReason?: string
}

export interface LeaseRequest {
  sessionId: string
  principalId: string
  agentId?: string
  kind: LeaseKind
  executionMode: ExecutionMode
  ttlMs: number
  actionBudget: number
  priority?: number
  boundaries?: LeaseBoundaries
  signal?: AbortSignal
}

interface QueuedRequest {
  sequence: number
  request: LeaseRequest
  resolve: (lease: ControlLease) => void
  reject: (error: Error) => void
}

/** Fair one-writer lease manager. Observations do not acquire this lease. */
export class ControlLeaseManager {
  #active?: ControlLease
  readonly #queue: QueuedRequest[] = []
  #queueSequence = 0
  #revision = 0
  #stopped = false
  readonly #now: () => number
  readonly #revocationListeners = new Set<(lease: ControlLease) => void>()

  constructor(now: () => number = () => Date.now()) {
    this.#now = now
  }

  current(): ControlLease | undefined {
    this.#expireIfNeeded()
    return this.#active ? structuredClone(this.#active) : undefined
  }

  queued(): number {
    return this.#queue.length
  }

  emergencyStopped(): boolean {
    return this.#stopped
  }

  onRevoked(listener: (lease: ControlLease) => void): () => void {
    this.#revocationListeners.add(listener)
    return () => this.#revocationListeners.delete(listener)
  }

  acquire(request: LeaseRequest): Promise<ControlLease> {
    this.#validateRequest(request)
    if (this.#stopped) return Promise.reject(new RuntimeError('interrupted', 'emergency stop is active'))
    this.#expireIfNeeded()
    if (!this.#active && this.#queue.length === 0) return Promise.resolve(this.#grant(request))

    return new Promise<ControlLease>((resolve, reject) => {
      const entry: QueuedRequest = { sequence: ++this.#queueSequence, request, resolve, reject }
      this.#queue.push(entry)
      this.#queue.sort((a, b) =>
        (b.request.priority ?? 0) - (a.request.priority ?? 0) || a.sequence - b.sequence)
      if (request.signal) {
        const abort = () => {
          const index = this.#queue.indexOf(entry)
          if (index >= 0) this.#queue.splice(index, 1)
          reject(new RuntimeError('interrupted', 'lease request cancelled'))
        }
        if (request.signal.aborted) abort()
        else request.signal.addEventListener('abort', abort, { once: true })
      }
    })
  }

  validate(
    leaseId: string,
    target: { appId?: string; windowId?: string | number; displayId?: string } = {},
  ): ControlLease {
    this.#expireIfNeeded()
    const lease = this.#active
    if (!lease || lease.leaseId !== leaseId) {
      throw new RuntimeError('lease_revoked', 'control lease is not active', { leaseId })
    }
    try {
      this.#assertBoundary('app', target.appId, lease.boundaries.appIds)
      this.#assertBoundary('window', target.windowId, lease.boundaries.windowIds)
      this.#assertBoundary('display', target.displayId, lease.boundaries.displayIds)
    } catch (error) {
      this.revoke(leaseId, 'target_boundary_escape')
      throw error
    }
    if (lease.actionsUsed >= lease.actionBudget) {
      this.revoke(leaseId, 'action_budget_exhausted')
      throw new RuntimeError('lease_revoked', 'lease action budget exhausted', { leaseId })
    }
    return structuredClone(lease)
  }

  consume(leaseId: string): ControlLease {
    this.validate(leaseId)
    const lease = this.#active!
    lease.actionsUsed++
    lease.revision = ++this.#revision
    return structuredClone(lease)
  }

  release(leaseId: string): ControlLease | undefined {
    if (!this.#active || this.#active.leaseId !== leaseId) return undefined
    const released = { ...this.#active, state: 'released' as const, revision: ++this.#revision }
    this.#active = undefined
    this.#grantNext()
    return structuredClone(released)
  }

  revoke(leaseId: string, reason: string): ControlLease | undefined {
    if (!this.#active || this.#active.leaseId !== leaseId) return undefined
    const revoked = {
      ...this.#active,
      state: 'revoked' as const,
      revokedReason: reason,
      revision: ++this.#revision,
    }
    this.#active = undefined
    this.#notifyRevoked(revoked)
    this.#grantNext()
    return structuredClone(revoked)
  }

  recordUserActivity(at = this.#now()): ControlLease | undefined {
    this.#expireIfNeeded()
    const lease = this.#active
    if (!lease || lease.kind !== 'cooperative') return undefined
    if (at < Date.parse(lease.acquiredAt)) return undefined
    return this.revoke(lease.leaseId, 'physical_user_activity')
  }

  emergencyStop(reason = 'emergency_stop'): ControlLease | undefined {
    this.#stopped = true
    const revoked = this.#active ? this.revoke(this.#active.leaseId, reason) : undefined
    const error = new RuntimeError('interrupted', 'emergency stop is active', { reason })
    for (const entry of this.#queue.splice(0)) entry.reject(error)
    return revoked
  }

  resetEmergencyStop(): void {
    this.#stopped = false
  }

  #grant(request: LeaseRequest): ControlLease {
    const now = this.#now()
    const lease: ControlLease = {
      leaseId: randomUUID(),
      revision: ++this.#revision,
      sessionId: request.sessionId,
      principalId: request.principalId,
      ...(request.agentId ? { agentId: request.agentId } : {}),
      kind: request.kind,
      executionMode: request.executionMode,
      state: 'active',
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + request.ttlMs).toISOString(),
      actionBudget: request.actionBudget,
      actionsUsed: 0,
      boundaries: structuredClone(request.boundaries ?? {}),
    }
    this.#active = lease
    return structuredClone(lease)
  }

  #grantNext(): void {
    if (this.#stopped || this.#active) return
    while (this.#queue.length > 0) {
      const next = this.#queue.shift()!
      if (next.request.signal?.aborted) continue
      next.resolve(this.#grant(next.request))
      break
    }
  }

  #expireIfNeeded(): void {
    if (!this.#active || this.#now() < Date.parse(this.#active.expiresAt)) return
    const expired = { ...this.#active, state: 'expired' as const, revokedReason: 'lease_expired', revision: ++this.#revision }
    this.#active = undefined
    this.#notifyRevoked(expired)
    this.#grantNext()
  }

  #notifyRevoked(lease: ControlLease): void {
    const snapshot = structuredClone(lease)
    for (const listener of this.#revocationListeners) listener(snapshot)
  }

  #validateRequest(request: LeaseRequest): void {
    if (!request.sessionId || !request.principalId) throw new TypeError('sessionId and principalId are required')
    if (!Number.isFinite(request.ttlMs) || request.ttlMs < 1 || request.ttlMs > 300_000) {
      throw new RangeError('lease ttlMs must be between 1 and 300000')
    }
    if (!Number.isInteger(request.actionBudget) || request.actionBudget < 1 || request.actionBudget > 10_000) {
      throw new RangeError('lease actionBudget must be between 1 and 10000')
    }
    if (request.executionMode === 'shadow') throw new TypeError('shadow mode does not acquire mutation leases')
    if (request.kind === 'exclusive' && request.executionMode !== 'foreground') {
      throw new TypeError('exclusive leases require foreground execution mode')
    }
  }

  #assertBoundary<T>(kind: string, value: T | undefined, allowed: T[] | undefined): void {
    if (value === undefined || !allowed || allowed.length === 0) return
    if (!allowed.includes(value)) {
      throw new RuntimeError('lease_revoked', `target escaped ${kind} lease boundary`, { kind, value })
    }
  }
}
