import { randomUUID } from 'node:crypto'
import { RuntimeError } from '../runtime/types.js'

export type TargetReservationState = 'active' | 'released' | 'expired' | 'cancelled'

export interface TargetReservationScope {
  appId: string
  windowId?: string | number
}

export interface TargetReservation {
  reservationId: string
  revision: number
  intentId: string
  sessionId: string
  principalId: string
  executionGroupId?: string
  agentId?: string
  scope: TargetReservationScope
  state: TargetReservationState
  acquiredAt: string
  expiresAt: string
  terminalReason?: string
}

export interface TargetReservationRequest {
  intentId: string
  sessionId: string
  principalId: string
  executionGroupId?: string
  agentId?: string
  scope: TargetReservationScope
  ttlMs: number
}

/**
 * Short-lived planner intent registry. It does not grant mutation authority;
 * the control lease remains the sole writer gate.
 */
export class TargetReservationManager {
  readonly #reservations = new Map<string, TargetReservation>()
  readonly #intentIndex = new Map<string, string>()
  readonly #now: () => number
  #revision = 0

  constructor(now: () => number = () => Date.now()) {
    this.#now = now
  }

  reserve(request: TargetReservationRequest): TargetReservation {
    this.#validateRequest(request)
    this.#expire()
    const intentKey = this.#intentKey(request.sessionId, request.intentId)
    const existingId = this.#intentIndex.get(intentKey)
    const existing = existingId ? this.#reservations.get(existingId) : undefined
    if (existing?.state === 'active') {
      if (existing.principalId !== request.principalId || !this.#sameScope(existing.scope, request.scope)) {
        throw new RuntimeError('target_conflict', 'intent id is already bound to a different target', {
          intentId: request.intentId,
        })
      }
      return structuredClone(existing)
    }

    const conflict = [...this.#reservations.values()].find(reservation =>
      reservation.state === 'active' && this.#overlaps(reservation.scope, request.scope))
    if (conflict) {
      throw new RuntimeError('target_conflict', 'another planner has reserved the target', {
        ...(conflict.principalId === request.principalId ? {
          reservationId: conflict.reservationId,
          agentId: conflict.agentId ?? null,
          expiresAt: conflict.expiresAt,
        } : { occupied: true }),
      })
    }

    const now = this.#now()
    const reservation: TargetReservation = {
      reservationId: randomUUID(),
      revision: ++this.#revision,
      intentId: request.intentId,
      sessionId: request.sessionId,
      principalId: request.principalId,
      ...(request.executionGroupId ? { executionGroupId: request.executionGroupId } : {}),
      ...(request.agentId ? { agentId: request.agentId } : {}),
      scope: structuredClone(request.scope),
      state: 'active',
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + request.ttlMs).toISOString(),
    }
    this.#reservations.set(reservation.reservationId, reservation)
    this.#intentIndex.set(intentKey, reservation.reservationId)
    return structuredClone(reservation)
  }

  get(reservationId: string): TargetReservation | undefined {
    this.#expire()
    const reservation = this.#reservations.get(reservationId)
    return reservation ? structuredClone(reservation) : undefined
  }

  active(): TargetReservation[] {
    this.#expire()
    return [...this.#reservations.values()]
      .filter(reservation => reservation.state === 'active')
      .map(reservation => structuredClone(reservation))
  }

  release(reservationId: string, principalId: string, reason = 'released'): TargetReservation | undefined {
    this.#expire()
    const reservation = this.#reservations.get(reservationId)
    if (!reservation || reservation.state !== 'active') return undefined
    if (reservation.principalId !== principalId) {
      throw new RuntimeError('principal_mismatch', 'target reservation belongs to another principal')
    }
    reservation.state = reason === 'released' ? 'released' : 'cancelled'
    reservation.terminalReason = reason
    reservation.revision = ++this.#revision
    this.#intentIndex.delete(this.#intentKey(reservation.sessionId, reservation.intentId))
    return structuredClone(reservation)
  }

  cancelSession(sessionId: string, principalId: string, reason: string): TargetReservation[] {
    const cancelled: TargetReservation[] = []
    for (const reservation of this.active()) {
      if (reservation.sessionId !== sessionId) continue
      const value = this.release(reservation.reservationId, principalId, reason)
      if (value) cancelled.push(value)
    }
    return cancelled
  }

  #expire(): void {
    const now = this.#now()
    for (const reservation of this.#reservations.values()) {
      if (reservation.state !== 'active' || now < Date.parse(reservation.expiresAt)) continue
      reservation.state = 'expired'
      reservation.terminalReason = 'ttl_expired'
      reservation.revision = ++this.#revision
      this.#intentIndex.delete(this.#intentKey(reservation.sessionId, reservation.intentId))
    }
  }

  #overlaps(left: TargetReservationScope, right: TargetReservationScope): boolean {
    if (left.appId.toLowerCase() !== right.appId.toLowerCase()) return false
    return left.windowId === undefined || right.windowId === undefined || left.windowId === right.windowId
  }

  #sameScope(left: TargetReservationScope, right: TargetReservationScope): boolean {
    return left.appId.toLowerCase() === right.appId.toLowerCase() && left.windowId === right.windowId
  }

  #intentKey(sessionId: string, intentId: string): string {
    return `${sessionId}\u0000${intentId}`
  }

  #validateRequest(request: TargetReservationRequest): void {
    if (!request.intentId || !request.sessionId || !request.principalId || !request.scope.appId) {
      throw new TypeError('intentId, sessionId, principalId, and scope.appId are required')
    }
    if (!Number.isFinite(request.ttlMs) || request.ttlMs < 1 || request.ttlMs > 300_000) {
      throw new RangeError('reservation ttlMs must be between 1 and 300000')
    }
  }
}
