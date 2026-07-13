import type { ActionClass } from './action.js'

export type ExecutionMode = 'shadow' | 'background' | 'foreground'

export type InterferenceLevel =
  | 'none'
  | 'visual_overlay_only'
  | 'may_raise_window'
  | 'takes_foreground'
  | 'moves_physical_pointer'

export type ExecutionBackend =
  | 'applescript'
  | 'javascript'
  | 'powershell'
  | 'scripting'
  | 'ax'
  | 'uia'
  | 'filesystem'
  | 'registry'
  | 'process'
  | 'physical_input'
  | 'browser'
  | 'none'

export interface ExecutionCapability {
  appId: string
  operation: string
  backend: ExecutionBackend
  supportedModes: ExecutionMode[]
  interference: InterferenceLevel
  confidence: number
  verifiedAt?: string
  verificationSource: 'platform_rule' | 'live_probe' | 'adapter' | 'unknown'
  certification?: {
    certificationId: string
    adapterId: string
    adapterVersion: string
    appVersion: string
    tool: string
    actionContractDigest: string
    probeFingerprint: string
    traceDigest: string
    validUntil: string
  }
}

export interface TargetEvidence {
  platform: NodeJS.Platform
  appId: string
  pid?: number
  windowId?: number | string
  windowTitleDigest?: string
  displayId?: string
  role?: string
  labelDigest?: string
  bounds?: { x: number; y: number; width: number; height: number }
  observationId: string
  screenshotHash?: string
  uiTreeRevision?: string
  confidence: number
  capturedAt: string
}

export interface ActionResourceContext {
  targetAppId?: string
  targetWindowId?: string | number
  filesystemPath?: string
  filesystemDestination?: string
  registryPath?: string
  processName?: string
  processId?: number
  browserDomain?: string
}

export interface ActionProvenance {
  untrustedInstruction: boolean
  sourceObservationIds: string[]
  crossesDataBoundary?: boolean
}

export type DataLabel = 'public' | 'private' | 'credential' | 'payment' | 'health' | 'unknown'

export interface ActionEnvelope {
  actionId: string
  sessionId: string
  executionGroupId?: string
  principalId: string
  agentId?: string
  tool: string
  operation: string
  actionClass: ActionClass
  requestedMode: ExecutionMode
  target?: TargetEvidence
  resource?: ActionResourceContext
  provenance?: ActionProvenance
  dataLabels: DataLabel[]
  reversible: boolean
  externalSideEffect: boolean
  proposedAt: string
  expiresAt: string
  argsDigest: string
}

export type RuntimeErrorCode =
  | 'foreground_required'
  | 'input_attribution_unavailable'
  | 'shadow_mutation'
  | 'stale_target'
  | 'lease_conflict'
  | 'lease_expired'
  | 'lease_revoked'
  | 'target_conflict'
  | 'interrupted'
  | 'approval_required'
  | 'policy_denied'
  | 'action_id_conflict'
  | 'indeterminate'
  | 'execution_failed'
  | 'session_not_found'
  | 'session_not_running'
  | 'session_not_terminal'
  | 'principal_mismatch'

export class RuntimeError extends Error {
  constructor(
    readonly code: RuntimeErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'RuntimeError'
  }
}
