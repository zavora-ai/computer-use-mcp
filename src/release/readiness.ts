import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import type { V8ConformanceReport } from '../reliability/conformance.js'
import { verifyV8ConformanceReport } from '../reliability/conformance.js'
import type { ReliabilityLabCorpus, ReliabilityLabReport } from '../reliability/lab.js'
import { verifyReliabilityLabReport } from '../reliability/lab.js'
import type { ReleaseArtifactManifest } from './artifacts.js'
import { verifyReleaseArtifactManifest } from './artifacts.js'

export type ReleaseStage = 'developer_preview' | 'beta' | 'stable'
export type ReleaseEvidenceKind = 'ci_matrix' | 'background_certification' | 'input_interruption' | 'adk_graph' | 'code_signing' | 'security_review'

export interface SignedReleaseEvidence {
  schemaVersion: 1
  evidenceId: string
  kind: ReleaseEvidenceKind
  platform: 'darwin' | 'win32' | 'linux' | 'all'
  subjectVersion: string
  observedAt: string
  expiresAt: string
  claims: Record<string, string | number | boolean>
  artifactDigests: string[]
  keyId: string
  signature: string
}

export interface AdkEvaluationReceipt {
  schemaVersion: 1
  protocol: 'adk-rust-computer-use-v8-evaluation'
  subjectVersion: string
  generatedAt: string
  commands: string[]
  assertions: string[]
  claims: {
    testsPassed: boolean
    authBound: boolean
    multimodalEvidence: boolean
    duplicateMutations: number
    crashPointsCovered: number
    testCount: number
  }
  sources: Array<{ path: string; digest: string }>
  sourceDigest: string
  outputDigest: string
  receiptDigest: string
}

export interface ReleaseGateResult {
  id: string
  requiredFor: ReleaseStage[]
  status: 'pass' | 'fail' | 'missing'
  evidenceLevel: 'deterministic' | 'integration' | 'live' | 'signed_external' | 'none'
  evidenceDigests: string[]
  reasons: string[]
}

export interface V8ReleaseReadinessReport {
  schemaVersion: 1
  protocol: 'computer-use-v8-release-readiness'
  runtimeVersion: string
  evaluatedAt: string
  requestedStage: ReleaseStage
  decision: 'go' | 'no_go'
  highestReadyStage: ReleaseStage | 'none'
  inputs: {
    conformanceDigest: string
    reliabilityDigest: string
    artifactManifestDigest?: string
    adkEvaluationDigest?: string
    signedEvidenceDigests: string[]
  }
  gates: ReleaseGateResult[]
  reportDigest: string
}

const stageRank: Record<ReleaseStage, number> = { developer_preview: 0, beta: 1, stable: 2 }
const everyStage: ReleaseStage[] = ['developer_preview', 'beta', 'stable']
const betaAndStable: ReleaseStage[] = ['beta', 'stable']
const mandatoryGateStages: Record<string, ReleaseStage[]> = {
  'core.governed_runtime': everyStage,
  'background.dual_platform_purity': everyStage,
  'supervisor.cross_platform_boundary': betaAndStable,
  'adk.flagship_crash_resume': everyStage,
  'compatibility.supported_target_ci': betaAndStable,
  'input.revocation_hardware': betaAndStable,
  'reliability.live_matrix': ['stable'],
  'release.all_native_artifacts': ['stable'],
  'release.platform_signing': ['stable'],
  'security.independent_review': ['stable'],
}

export function canonicalReleaseValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalReleaseValue).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalReleaseValue(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(typeof value === 'string' ? value : canonicalReleaseValue(value)).digest('hex')}`
}

export function signedReleaseEvidencePayload(evidence: SignedReleaseEvidence): string {
  const body = structuredClone(evidence)
  body.evidenceId = ''
  body.signature = ''
  return canonicalReleaseValue(body)
}

export function signedReleaseEvidenceDigest(evidence: SignedReleaseEvidence): string {
  return sha256(signedReleaseEvidencePayload(evidence))
}

export function adkEvaluationReceiptDigest(receipt: AdkEvaluationReceipt): string {
  const body = structuredClone(receipt); body.receiptDigest = ''; return sha256(body)
}

export function verifyAdkEvaluationReceipt(receipt: AdkEvaluationReceipt): boolean {
  const required = ['graph.parallel_one_executor', 'graph.approval_digest_binding', 'graph.policy_digest_binding',
    'graph.pre_effect_crash', 'graph.post_commit_crash', 'auth.verified_identity',
    'eval.no_duplicate_mutation', 'mcp.multimodal_image']
  return receipt.schemaVersion === 1 && receipt.protocol === 'adk-rust-computer-use-v8-evaluation'
    && receipt.subjectVersion.length > 0 && receipt.commands.length >= 2
    && required.every(value => receipt.assertions.includes(value))
    && new Set(receipt.assertions).size === receipt.assertions.length
    && receipt.claims.testsPassed && receipt.claims.authBound && receipt.claims.multimodalEvidence
    && receipt.claims.duplicateMutations === 0 && receipt.claims.crashPointsCovered >= 2 && receipt.claims.testCount > 0
    && receipt.sources.length > 0 && receipt.sources.every(item => item.path.length > 0 && /^sha256:[a-f0-9]{64}$/.test(item.digest))
    && /^sha256:[a-f0-9]{64}$/.test(receipt.sourceDigest) && /^sha256:[a-f0-9]{64}$/.test(receipt.outputDigest)
    && adkEvaluationReceiptDigest(receipt) === receipt.receiptDigest
}

function verifySignedEvidence(evidence: SignedReleaseEvidence, trustedKeys: Readonly<Record<string, string>>, version: string, now: Date): boolean {
  try {
    if (evidence.schemaVersion !== 1 || evidence.subjectVersion !== version || !trustedKeys[evidence.keyId]
      || !/^sha256:[a-f0-9]{64}$/.test(evidence.evidenceId)
      || evidence.evidenceId !== signedReleaseEvidenceDigest(evidence)
      || evidence.artifactDigests.some(value => !/^sha256:[a-f0-9]{64}$/.test(value))
      || Date.parse(evidence.observedAt) > now.getTime() || Date.parse(evidence.expiresAt) <= now.getTime()) return false
    const key = createPublicKey(trustedKeys[evidence.keyId]!)
    if (key.asymmetricKeyType !== 'ed25519') return false
    return verifySignature(null, Buffer.from(signedReleaseEvidencePayload(evidence)), key, Buffer.from(evidence.signature, 'base64'))
  } catch { return false }
}

function gate(id: string, requiredFor: ReleaseStage[], status: ReleaseGateResult['status'], evidenceLevel: ReleaseGateResult['evidenceLevel'], reasons: string[], evidenceDigests: string[] = []): ReleaseGateResult {
  return { id, requiredFor, status, evidenceLevel, reasons, evidenceDigests: [...new Set(evidenceDigests)].sort() }
}

function hasClaims(evidence: SignedReleaseEvidence, claims: Record<string, string | number | boolean>): boolean {
  return Object.entries(claims).every(([key, value]) => evidence.claims[key] === value)
}

export function buildV8ReleaseReadinessReport(input: {
  requestedStage: ReleaseStage
  runtimeVersion: string
  evaluatedAt: string
  conformance: V8ConformanceReport
  reliability: ReliabilityLabReport
  reliabilityCorpus: ReliabilityLabCorpus
  artifactManifest?: ReleaseArtifactManifest
  adkEvaluation?: AdkEvaluationReceipt
  signedEvidence?: SignedReleaseEvidence[]
  trustedKeys?: Record<string, string>
}): V8ReleaseReadinessReport {
  const now = new Date(input.evaluatedAt)
  if (!Number.isFinite(now.getTime()) || !verifyV8ConformanceReport(input.conformance)
    || !verifyReliabilityLabReport(input.reliability, input.reliabilityCorpus)
    || input.conformance.runtimeVersion !== input.runtimeVersion
    || input.reliability.runtimeVersion !== input.runtimeVersion) throw new TypeError('invalid or version-mismatched readiness input')
  if (input.artifactManifest && (!verifyReleaseArtifactManifest(input.artifactManifest) || input.artifactManifest.rootVersion !== input.runtimeVersion)) throw new TypeError('invalid or version-mismatched artifact manifest')
  if (input.adkEvaluation && (!verifyAdkEvaluationReceipt(input.adkEvaluation) || input.adkEvaluation.subjectVersion !== input.runtimeVersion)) throw new TypeError('invalid or version-mismatched ADK evaluation receipt')
  const validExternal = (input.signedEvidence ?? []).filter(item => verifySignedEvidence(item, input.trustedKeys ?? {}, input.runtimeVersion, now))
  const external = (kind: ReleaseEvidenceKind, platform?: SignedReleaseEvidence['platform']) => validExternal.filter(item => item.kind === kind && (!platform || item.platform === platform))
  const digests = (items: SignedReleaseEvidence[]) => items.map(signedReleaseEvidenceDigest)
  const gates: ReleaseGateResult[] = []

  const policy = input.conformance.badges['policy-v2']
  const multi = input.conformance.badges['multi-agent-safe']
  gates.push(gate('core.governed_runtime', everyStage,
    policy.status === 'pass' && multi.status === 'pass' ? 'pass' : 'fail', 'deterministic',
    [...policy.missing, ...multi.missing], [input.conformance.reportDigest]))

  const background = input.conformance.badges['background-safe']
  const signedBackground = ['darwin', 'win32'].flatMap(platform => external('background_certification', platform as 'darwin' | 'win32').filter(item =>
    hasClaims(item, { interference: 'none', focusChanged: false, pointerMoved: false, physicalInputInjected: false, rollbackVerified: true })
    && item.artifactDigests.includes(input.conformance.reportDigest)))
  const backgroundPlatforms = new Set(signedBackground.map(item => item.platform))
  const missingSignedBackground = ['darwin', 'win32'].filter(platform => !backgroundPlatforms.has(platform as 'darwin' | 'win32'))
  gates.push(gate('background.dual_platform_purity', everyStage,
    background.status === 'pass' && background.evidenceLevel === 'live' && !missingSignedBackground.length ? 'pass'
      : background.status === 'unassessed' ? 'missing' : 'fail',
    signedBackground.length ? 'signed_external' : background.evidenceLevel,
    [...background.missing, ...missingSignedBackground.map(platform => `${platform}: trusted signature over conformance digest required`)],
    [input.conformance.reportDigest, ...digests(signedBackground)]))

  const ci = external('ci_matrix', 'all').filter(item => hasClaims(item, {
    testsPassed: true, supervisorPassed: true,
    targets: 'darwin-arm64,darwin-x64,win32-x64,linux-arm64,linux-x64',
    nodeVersions: '18,20,22,current',
  }) && item.artifactDigests.includes(input.conformance.reportDigest))

  const supervisor = input.conformance.badges['supervisor-ready']
  gates.push(gate('supervisor.cross_platform_boundary', betaAndStable,
    supervisor.status === 'pass' && ci.length ? 'pass' : supervisor.status === 'unassessed' ? 'missing' : 'fail', ci.length ? 'signed_external' : supervisor.evidenceLevel,
    [...supervisor.missing, ...(ci.length ? [] : ['trusted cross-platform CI signature required'])], [input.conformance.reportDigest, ...digests(ci)]))

  const adk = external('adk_graph', 'all').filter(item => hasClaims(item, {
    testsPassed: true, authBound: true, multimodalEvidence: true, duplicateMutations: 0,
  }) && typeof item.claims.crashPointsCovered === 'number' && item.claims.crashPointsCovered >= 2
    && Boolean(input.adkEvaluation) && item.artifactDigests.includes(input.adkEvaluation!.receiptDigest))
  gates.push(gate('adk.flagship_crash_resume', everyStage, adk.length ? 'pass' : 'missing', adk.length ? 'signed_external' : 'none',
    adk.length ? [] : [input.adkEvaluation ? 'trusted signature over the ADK evaluation receipt is required' : 'valid ADK evaluation receipt is required'],
    [...(input.adkEvaluation ? [input.adkEvaluation.receiptDigest] : []), ...digests(adk)]))

  gates.push(gate('compatibility.supported_target_ci', betaAndStable, ci.length ? 'pass' : 'missing', ci.length ? 'signed_external' : 'none',
    ci.length ? [] : ['signed all-target and Node-version CI evidence is required'], digests(ci)))

  const interruption = ['darwin', 'win32'].flatMap(platform => external('input_interruption', platform as 'darwin' | 'win32').filter(item =>
    hasClaims(item, {
      physicalAttribution: true,
      emergencyChord: true,
      disconnected: true,
      nativeLatched: true,
      postRevocationActions: 0,
    })
    && typeof item.claims.p95Ms === 'number' && item.claims.p95Ms < 100
    && typeof item.claims.raceCount === 'number' && item.claims.raceCount >= 10_000
    && item.artifactDigests.includes(input.reliability.reportDigest)))
  const interruptionPlatforms = new Set(interruption.map(item => item.platform))
  const missingInterruption = ['darwin', 'win32'].filter(platform => !interruptionPlatforms.has(platform as 'darwin' | 'win32'))
  gates.push(gate('input.revocation_hardware', betaAndStable, missingInterruption.length ? 'missing' : 'pass', interruption.length ? 'signed_external' : 'none',
    missingInterruption.map(platform => `${platform}: signed physical-chord/disconnect p95 and 10,000-race evidence bound to the reliability report is required`),
    [input.reliability.reportDigest, ...digests(interruption)]))

  gates.push(gate('reliability.live_matrix', ['stable'], input.reliability.coverage.missingLiveScenarioIds.length || !input.reliability.coverage.byEvidenceLevel.live.passed ? 'missing' : input.reliability.coverage.failed ? 'fail' : 'pass',
    input.reliability.coverage.byEvidenceLevel.live.passed ? 'live' : 'none', input.reliability.coverage.missingLiveScenarioIds,
    [input.reliability.reportDigest]))

  const expectedTargets = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64', 'linux-arm64'])
  const artifactTargets = new Set(input.artifactManifest?.artifacts.map(item => `${item.platform}-${item.arch}`) ?? [])
  const missingArtifacts = [...expectedTargets].filter(target => !artifactTargets.has(target)).sort()
  gates.push(gate('release.all_native_artifacts', ['stable'], !input.artifactManifest ? 'missing' : missingArtifacts.length ? 'fail' : 'pass',
    input.artifactManifest ? 'integration' : 'none', missingArtifacts.map(target => `${target}: artifact missing`),
    input.artifactManifest ? [input.artifactManifest.manifestDigest] : []))

  const signing = ['darwin', 'win32'].flatMap(platform => external('code_signing', platform as 'darwin' | 'win32').filter(item =>
    item.claims.verified === true && (platform !== 'darwin' || item.claims.notarized === true)))
  const signingPlatforms = new Set(signing.map(item => item.platform))
  const missingSigning = ['darwin', 'win32'].filter(platform => !signingPlatforms.has(platform as 'darwin' | 'win32'))
  gates.push(gate('release.platform_signing', ['stable'], missingSigning.length ? 'missing' : 'pass', signing.length ? 'signed_external' : 'none',
    missingSigning.map(platform => `${platform}: verified signing evidence required`), digests(signing)))

  const review = external('security_review', 'all').filter(item => hasClaims(item, { passed: true, criticalOpen: 0, highOpen: 0 }))
  gates.push(gate('security.independent_review', ['stable'], review.length ? 'pass' : 'missing', review.length ? 'signed_external' : 'none',
    review.length ? [] : ['signed independent security review evidence is required'], digests(review)))

  const stageReady = (stage: ReleaseStage) => gates.filter(item => item.requiredFor.includes(stage)).every(item => item.status === 'pass')
  let highestReadyStage: V8ReleaseReadinessReport['highestReadyStage'] = 'none'
  for (const stage of everyStage) if (stageReady(stage) && (highestReadyStage === 'none' || stageRank[stage] > stageRank[highestReadyStage])) highestReadyStage = stage
  const report: V8ReleaseReadinessReport = {
    schemaVersion: 1, protocol: 'computer-use-v8-release-readiness', runtimeVersion: input.runtimeVersion,
    evaluatedAt: input.evaluatedAt, requestedStage: input.requestedStage,
    decision: stageReady(input.requestedStage) ? 'go' : 'no_go', highestReadyStage,
    inputs: {
      conformanceDigest: input.conformance.reportDigest, reliabilityDigest: input.reliability.reportDigest,
      signedEvidenceDigests: digests(validExternal).sort(),
    }, gates, reportDigest: '',
  }
  if (input.artifactManifest) report.inputs.artifactManifestDigest = input.artifactManifest.manifestDigest
  if (input.adkEvaluation) report.inputs.adkEvaluationDigest = input.adkEvaluation.receiptDigest
  report.reportDigest = v8ReleaseReadinessReportDigest(report)
  return report
}

export function v8ReleaseReadinessReportDigest(report: V8ReleaseReadinessReport): string {
  const body = structuredClone(report); body.reportDigest = ''; return sha256(body)
}

export function verifyV8ReleaseReadinessReport(report: V8ReleaseReadinessReport): boolean {
  const ids = report.gates.map(item => item.id)
  const exactGateSet = ids.length === Object.keys(mandatoryGateStages).length
    && new Set(ids).size === ids.length && ids.every(id => id in mandatoryGateStages)
    && report.gates.every(item => JSON.stringify(item.requiredFor) === JSON.stringify(mandatoryGateStages[item.id]))
  const stageReady = (stage: ReleaseStage) => report.gates.filter(item => item.requiredFor.includes(stage)).every(item => item.status === 'pass')
  let highest: V8ReleaseReadinessReport['highestReadyStage'] = 'none'
  for (const stage of everyStage) if (stageReady(stage) && (highest === 'none' || stageRank[stage] > stageRank[highest])) highest = stage
  return report.schemaVersion === 1 && report.protocol === 'computer-use-v8-release-readiness'
    && everyStage.includes(report.requestedStage) && exactGateSet
    && /^sha256:[a-f0-9]{64}$/.test(report.reportDigest) && v8ReleaseReadinessReportDigest(report) === report.reportDigest
    && [report.inputs.conformanceDigest, report.inputs.reliabilityDigest, ...(report.inputs.artifactManifestDigest ? [report.inputs.artifactManifestDigest] : []), ...(report.inputs.adkEvaluationDigest ? [report.inputs.adkEvaluationDigest] : []), ...report.inputs.signedEvidenceDigests]
      .every(value => /^sha256:[a-f0-9]{64}$/.test(value))
    && report.decision === (stageReady(report.requestedStage) ? 'go' : 'no_go') && report.highestReadyStage === highest
}
