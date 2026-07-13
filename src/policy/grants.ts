import { randomUUID } from 'node:crypto'
import { RuntimeError, type ActionEnvelope, type ExecutionMode } from '../runtime/types.js'
import type { ActionClass } from '../runtime/action.js'

export interface ApprovalGrant {
  grantId: string
  scope: 'exact_action' | 'session_operation'
  principalId: string
  sessionId: string
  /** Digest of the reviewed seed action. Session-scoped validation uses scopeDigest instead. */
  actionDigest: string
  scopeDigest: string
  policyDigest: string
  tool: string
  operation: string
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
    scope?: ApprovalGrant['scope']
    scopeDigest?: string
    tool?: string
    operation?: string
  }): ApprovalGrant
  validate(grantId: string, envelope: ActionEnvelope, policyDigest: string, scopeDigest?: string): ApprovalGrant
  consume(grantId: string, envelope: ActionEnvelope, policyDigest: string, scopeDigest?: string): ApprovalGrant
  revoke(grantId: string): boolean
  revokeSession(sessionId: string, principalId: string): number
  revokeAll(): ApprovalGrant[]
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
    scope?: ApprovalGrant['scope']
    scopeDigest?: string
    tool?: string
    operation?: string
  }): ApprovalGrant {
    if (!/^[a-f0-9]{64}$/.test(input.actionDigest)) {
      throw new TypeError('approval actionDigest must be a lowercase SHA-256 hex digest')
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > 300_000) {
      throw new RangeError('approval ttlMs must be between 1 and 300000')
    }
    const scope = input.scope ?? 'exact_action'
    const uses = input.uses ?? 1
    if (!Number.isInteger(uses) || uses < 1 || uses > 100) throw new RangeError('approval uses must be between 1 and 100')
    if (scope === 'exact_action' && uses !== 1) {
      throw new RangeError('exact-action approval grants must have exactly one use')
    }
    if (scope === 'session_operation') {
      if (!input.scopeDigest || !/^[a-f0-9]{64}$/.test(input.scopeDigest)) {
        throw new TypeError('session-operation approval requires a valid scope digest')
      }
      if (!input.tool || !input.operation) {
        throw new TypeError('session-operation approval requires tool and operation bindings')
      }
      if (!['set_value', 'fill_form'].includes(input.tool)
          || input.actionClass !== 'edit_reversible' || uses > 20) {
        throw new TypeError('session-operation approval is limited to at most 20 reversible semantic edits')
      }
    }
    const now = this.#now()
    const grant: ApprovalGrant = {
      grantId: randomUUID(),
      scope,
      principalId: input.principalId,
      sessionId: input.sessionId,
      actionDigest: input.actionDigest,
      scopeDigest: scope === 'exact_action' ? input.actionDigest : input.scopeDigest!,
      policyDigest: input.policyDigest,
      tool: input.tool ?? '',
      operation: input.operation ?? '',
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

  validate(grantId: string, envelope: ActionEnvelope, policyDigest: string, scopeDigest?: string): ApprovalGrant {
    const grant = this.#grants.get(grantId)
    if (!grant) throw new RuntimeError('approval_required', 'approval grant is unknown or revoked')
    if (this.#now() >= Date.parse(grant.expiresAt)) {
      this.#grants.delete(grantId)
      throw new RuntimeError('approval_required', 'approval grant expired')
    }
    const scopeMatches = grant.scope === 'exact_action'
      ? grant.actionDigest === envelope.argsDigest
      : Boolean(scopeDigest)
        && grant.scopeDigest === scopeDigest
        && grant.tool === envelope.tool
        && grant.operation === envelope.operation
    const matches = grant.principalId === envelope.principalId
      && grant.sessionId === envelope.sessionId
      && scopeMatches
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

  consume(grantId: string, envelope: ActionEnvelope, policyDigest: string, scopeDigest?: string): ApprovalGrant {
    this.validate(grantId, envelope, policyDigest, scopeDigest)
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

  revokeAll(): ApprovalGrant[] {
    const revoked = [...this.#grants.values()].map(grant => structuredClone(grant))
    this.#grants.clear()
    return revoked
  }
}
