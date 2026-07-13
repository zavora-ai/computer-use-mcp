import { randomUUID } from 'node:crypto'
import { RuntimeError, type ActionEnvelope, type ExecutionMode } from '../runtime/types.js'
import type { ActionClass } from '../runtime/action.js'

export interface ApprovalGrant {
  grantId: string
  principalId: string
  sessionId: string
  actionDigest: string
  policyDigest: string
  actionClass: ActionClass
  mode: ExecutionMode
  issuedAt: string
  expiresAt: string
  remainingUses: number
  consumedByActionIds: string[]
}

export interface ApprovalGrantStore {
  issue(input: {
    principalId: string
    sessionId: string
    actionDigest: string
    policyDigest: string
    actionClass: ActionClass
    mode: ExecutionMode
    ttlMs: number
    uses?: number
  }): ApprovalGrant
  validate(grantId: string, envelope: ActionEnvelope, policyDigest: string): ApprovalGrant
  consume(grantId: string, envelope: ActionEnvelope, policyDigest: string): ApprovalGrant
  revoke(grantId: string): boolean
  revokeSession(sessionId: string, principalId: string): number
}

/** In-process action-bound approval grants. Durable sidecars can implement the same interface. */
export class MemoryApprovalGrantStore implements ApprovalGrantStore {
  readonly #grants = new Map<string, ApprovalGrant>()
  readonly #now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.#now = now
  }

  issue(input: {
    principalId: string
    sessionId: string
    actionDigest: string
    policyDigest: string
    actionClass: ActionClass
    mode: ExecutionMode
    ttlMs: number
    uses?: number
  }): ApprovalGrant {
    if (!Number.isFinite(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 300_000) {
      throw new RangeError('approval ttlMs must be between 1 and 300000')
    }
    const uses = input.uses ?? 1
    if (!Number.isInteger(uses) || uses < 1 || uses > 100) throw new RangeError('approval uses must be between 1 and 100')
    const now = this.#now()
    const grant: ApprovalGrant = {
      grantId: randomUUID(),
      principalId: input.principalId,
      sessionId: input.sessionId,
      actionDigest: input.actionDigest,
      policyDigest: input.policyDigest,
      actionClass: input.actionClass,
      mode: input.mode,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + input.ttlMs).toISOString(),
      remainingUses: uses,
      consumedByActionIds: [],
    }
    this.#grants.set(grant.grantId, grant)
    return structuredClone(grant)
  }

  validate(grantId: string, envelope: ActionEnvelope, policyDigest: string): ApprovalGrant {
    const grant = this.#grants.get(grantId)
    if (!grant) throw new RuntimeError('approval_required', 'approval grant is unknown or revoked')
    if (this.#now() >= Date.parse(grant.expiresAt)) {
      this.#grants.delete(grantId)
      throw new RuntimeError('approval_required', 'approval grant expired')
    }
    const matches = grant.principalId === envelope.principalId
      && grant.sessionId === envelope.sessionId
      && grant.actionDigest === envelope.argsDigest
      && grant.policyDigest === policyDigest
      && grant.actionClass === envelope.actionClass
      && grant.mode === envelope.requestedMode
    if (!matches) {
      throw new RuntimeError('approval_required', 'approval grant does not match the exact action envelope')
    }
    const alreadyConsumed = grant.consumedByActionIds.includes(envelope.actionId)
    if (!alreadyConsumed && grant.remainingUses < 1) {
      throw new RuntimeError('approval_required', 'approval grant has no remaining uses')
    }
    return structuredClone(grant)
  }

  consume(grantId: string, envelope: ActionEnvelope, policyDigest: string): ApprovalGrant {
    this.validate(grantId, envelope, policyDigest)
    const grant = this.#grants.get(grantId)!
    if (!grant.consumedByActionIds.includes(envelope.actionId)) {
      grant.remainingUses--
      grant.consumedByActionIds.push(envelope.actionId)
    }
    return structuredClone(grant)
  }

  revoke(grantId: string): boolean {
    return this.#grants.delete(grantId)
  }

  revokeSession(sessionId: string, principalId: string): number {
    let revoked = 0
    for (const [grantId, grant] of this.#grants) {
      if (grant.sessionId !== sessionId || grant.principalId !== principalId) continue
      this.#grants.delete(grantId)
      revoked++
    }
    return revoked
  }
}
