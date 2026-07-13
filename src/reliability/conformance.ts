import { createHash } from 'node:crypto'
import type { CapabilityCertificationTrace } from '../runtime/adapters.js'
import { verifyCertificationTrace } from '../runtime/adapters.js'

export type ConformanceBadgeName =
  | 'background-safe'
  | 'supervisor-ready'
  | 'policy-v2'
  | 'multi-agent-safe'

export type ConformanceStatus = 'pass' | 'partial' | 'unassessed'

export interface ConformanceEvidence {
  schemaVersion: 1
  evidenceId: string
  kind: 'deterministic_suite' | 'integration_suite'
  scope: 'policy' | 'multi_agent' | 'supervisor'
  observedAt: string
  environment: {
    platform: NodeJS.Platform | 'all'
    arch: string
    node: string
    interactive: boolean
    source: 'local' | 'ci'
  }
  command: string
  passed: boolean
  tests: number
  durationMs: number
  assertions: string[]
  sources: Array<{ path: string; digest: string }>
  sourceDigest: string
  outputDigest: string
}

export interface ConformanceBadgeResult {
  status: ConformanceStatus
  evidenceLevel: 'live' | 'integration' | 'deterministic' | 'none'
  satisfied: string[]
  missing: string[]
}

export interface V8ConformanceReport {
  schemaVersion: 1
  protocol: 'computer-use-v8-preview'
  runtimeVersion: string
  generatedAt: string
  evidence: ConformanceEvidence[]
  certifications: Array<{
    path: string
    certificationId: string
    traceDigest: string
    platform: NodeJS.Platform
    appId: string
    appVersion: string
    operation: string
    approach: 'scripting' | 'ax' | 'uia' | 'physical_input' | 'other'
    observedAt: string
    passed: boolean
  }>
  badges: Record<ConformanceBadgeName, ConformanceBadgeResult>
  platformCoverage: Array<{
    platform: NodeJS.Platform
    liveBackgroundApproaches: string[]
    operations: string[]
  }>
  reportDigest: string
}

const badgeRequirements: Record<Exclude<ConformanceBadgeName, 'background-safe'>, string[]> = {
  'policy-v2': [
    'policy.operation_boundaries',
    'policy.approval_binding',
    'policy.untrusted_provenance',
    'target.stale_fail_closed',
    'receipt.exactly_once',
  ],
  'multi-agent-safe': [
    'lease.one_writer',
    'lease.terminal_revocation',
    'lease.schedule_10000',
    'reservation.conflict',
    'reservation.no_authority',
  ],
  'supervisor-ready': [
    'supervisor.authentication',
    'supervisor.principal_isolation',
    'supervisor.lifecycle_control',
    'supervisor.approval_binding',
    'supervisor.renderer_boundary',
    'supervisor.emergency_out_of_band',
    'supervisor.emergency_confirmed_reset',
    'supervisor.credential_not_inherited',
  ],
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')}`
}

function approach(trace: CapabilityCertificationTrace): V8ConformanceReport['certifications'][number]['approach'] {
  if (['applescript', 'javascript', 'powershell', 'scripting'].includes(trace.backend)) return 'scripting'
  if (trace.backend === 'ax') return 'ax'
  if (trace.backend === 'uia') return 'uia'
  if (trace.backend === 'physical_input') return 'physical_input'
  return 'other'
}

function provesLiveBackground(trace: CapabilityCertificationTrace): boolean {
  const result = trace.probe.result
  const evidence = result.evidence
  return verifyCertificationTrace(trace)
    && trace.capability.supportedModes.includes('background')
    && result.supported
    && result.interference === 'none'
    && !result.focusChanged
    && !result.pointerMoved
    && !result.physicalInputInjected
    && evidence.quietPeriodSatisfied === true
    && evidence.executionSucceeded === true
    && evidence.postconditionSatisfied === true
    && evidence.rollbackSucceeded === true
    && evidence.frontmostAppBefore === evidence.frontmostAppAfter
    && JSON.stringify(evidence.pointerBefore) === JSON.stringify(evidence.pointerAfter)
}

function evidenceBadge(
  name: Exclude<ConformanceBadgeName, 'background-safe'>,
  evidence: readonly ConformanceEvidence[],
): ConformanceBadgeResult {
  const required = badgeRequirements[name]
  const relevant = evidence.filter(item => item.passed && item.scope === (
    name === 'policy-v2' ? 'policy' : name === 'multi-agent-safe' ? 'multi_agent' : 'supervisor'
  ))
  const assertions = new Set(relevant.flatMap(item => item.assertions))
  const satisfied = required.filter(assertion => assertions.has(assertion))
  const missing = required.filter(assertion => !assertions.has(assertion))
  const result: ConformanceBadgeResult = {
    status: missing.length === 0 ? 'pass' : satisfied.length ? 'partial' : 'unassessed',
    evidenceLevel: relevant.some(item => item.kind === 'integration_suite') ? 'integration'
      : relevant.length ? 'deterministic' : 'none',
    satisfied,
    missing,
  }
  if (name === 'supervisor-ready' && result.status === 'pass') {
    const platforms = new Set(relevant.map(item => item.environment.platform))
    const missingPlatforms = ['darwin', 'win32'].filter(platform =>
      !platforms.has('all') && !platforms.has(platform as NodeJS.Platform))
    if (missingPlatforms.length) {
      result.status = 'partial'
      result.missing.push(...missingPlatforms.map(platform => `platform:${platform}`))
    }
  }
  return result
}

export function buildV8ConformanceReport(input: {
  runtimeVersion: string
  generatedAt: string
  evidence: ConformanceEvidence[]
  traces: Array<{ path: string; trace: CapabilityCertificationTrace }>
}): V8ConformanceReport {
  const certifications = input.traces.map(({ path, trace }) => ({
    path,
    certificationId: trace.certificationId,
    traceDigest: trace.traceDigest,
    platform: trace.platform,
    appId: trace.app.id,
    appVersion: trace.app.version,
    operation: trace.operation,
    approach: approach(trace),
    observedAt: trace.probe.completedAt,
    passed: provesLiveBackground(trace),
  })).sort((left, right) => left.path.localeCompare(right.path))
  const live = certifications.filter(item => item.passed)
  const platforms = [...new Set(live.map(item => item.platform))].sort()
  const backgroundSatisfied = live.map(item => `${item.platform}:${item.approach}:${item.operation}`)
  const missingLivePlatforms = ['darwin', 'win32'].filter(platform => !platforms.includes(platform as NodeJS.Platform))
  const report: V8ConformanceReport = {
    schemaVersion: 1,
    protocol: 'computer-use-v8-preview',
    runtimeVersion: input.runtimeVersion,
    generatedAt: input.generatedAt,
    evidence: structuredClone(input.evidence).sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
    certifications,
    badges: {
      'background-safe': {
        status: missingLivePlatforms.length === 0 ? 'pass' : live.length ? 'partial' : 'unassessed',
        evidenceLevel: live.length ? 'live' : 'none',
        satisfied: backgroundSatisfied,
        missing: missingLivePlatforms.map(platform => `${platform}:valid_live_certification_trace`),
      },
      'policy-v2': evidenceBadge('policy-v2', input.evidence),
      'multi-agent-safe': evidenceBadge('multi-agent-safe', input.evidence),
      'supervisor-ready': evidenceBadge('supervisor-ready', input.evidence),
    },
    platformCoverage: platforms.map(platform => ({
      platform,
      liveBackgroundApproaches: [...new Set(live.filter(item => item.platform === platform).map(item => item.approach))].sort(),
      operations: [...new Set(live.filter(item => item.platform === platform).map(item => item.operation))].sort(),
    })),
    reportDigest: '',
  }
  report.reportDigest = conformanceReportDigest(report)
  return report
}

export function conformanceReportDigest(report: V8ConformanceReport): string {
  const body = structuredClone(report)
  body.reportDigest = ''
  return sha256(body)
}

export function verifyV8ConformanceReport(report: V8ConformanceReport): boolean {
  return report.schemaVersion === 1
    && report.protocol === 'computer-use-v8-preview'
    && /^sha256:[a-f0-9]{64}$/.test(report.reportDigest)
    && conformanceReportDigest(report) === report.reportDigest
    && report.evidence.every(item =>
      item.schemaVersion === 1
      && Array.isArray(item.sources)
      && item.sources.length > 0
      && item.sources.every(source => source.path.length > 0 && /^sha256:[a-f0-9]{64}$/.test(source.digest))
      && /^sha256:[a-f0-9]{64}$/.test(item.sourceDigest)
      && /^sha256:[a-f0-9]{64}$/.test(item.outputDigest))
}
