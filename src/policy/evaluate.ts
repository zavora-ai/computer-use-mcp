import type { ActionEnvelope } from '../runtime/types.js'

export type PolicyDecisionKind = 'allow' | 'confirm' | 'deny'

export interface PolicyDecision {
  decision: PolicyDecisionKind
  policyDigest: string
  reasons: string[]
  grantId?: string
}

export type PolicyEvaluator = (envelope: Readonly<ActionEnvelope>) => Promise<PolicyDecision> | PolicyDecision

/** Conservative v8 default. Explicit policy adapters may only widen this with auditable grants. */
export const defaultPolicyEvaluator: PolicyEvaluator = envelope => {
  if (envelope.actionClass === 'observe' || envelope.actionClass === 'navigate') {
    return { decision: 'allow', policyDigest: 'v8-default-1', reasons: [`default_allow:${envelope.actionClass}`] }
  }
  if (envelope.actionClass === 'edit_reversible' && !envelope.externalSideEffect) {
    return { decision: 'allow', policyDigest: 'v8-default-1', reasons: ['default_allow:local_reversible_edit'] }
  }
  if (envelope.actionClass === 'communicate_external' || envelope.actionClass === 'edit_reversible') {
    return { decision: 'confirm', policyDigest: 'v8-default-1', reasons: [`confirm:${envelope.actionClass}`] }
  }
  return { decision: 'confirm', policyDigest: 'v8-default-1', reasons: [`sensitive:${envelope.actionClass}`] }
}
