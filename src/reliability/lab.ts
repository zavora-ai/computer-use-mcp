import { createHash } from 'node:crypto'

export type LabPlatform = 'darwin' | 'win32' | 'linux'
export type LabApproach = 'scripting' | 'ax' | 'uia' | 'physical_input' | 'capture' | 'runtime'
export type LabEvidenceLevel = 'deterministic' | 'integration' | 'live'
export type LabResultStatus = 'passed' | 'failed' | 'blocked' | 'not_run'

export interface ReliabilityLabScenario {
  id: string
  title: string
  platforms: LabPlatform[]
  approaches: LabApproach[]
  category: 'display' | 'privilege' | 'session' | 'workspace' | 'compositor' | 'interference'
  condition: string
  minimumEvidence: LabEvidenceLevel
  assertions: string[]
  requiredFacts: string[]
}

export interface ReliabilityLabCorpus {
  schemaVersion: 1
  corpusId: string
  description: string
  scenarios: ReliabilityLabScenario[]
  corpusDigest: string
}

export interface ReliabilityObservation {
  attempts: number
  successes: number
  unintendedMutations: number
  interferenceEvents: number
  attributedMutations: number
  staleActionsBlocked: number
  staleActionsAttempted: number
  restorationsAttempted: number
  restorationsSucceeded: number
  latenciesMs: number[]
}

export interface ReliabilityLabResult {
  schemaVersion: 1
  resultId: string
  scenarioId: string
  platform: LabPlatform
  approach: LabApproach
  evidenceLevel: LabEvidenceLevel
  status: LabResultStatus
  observedAt: string
  environment: {
    osRelease: string
    arch: string
    interactive: boolean
    ci: boolean
    sessionKind: string
    displayServer: string
    compositor: string
  }
  facts: Record<string, string | number | boolean>
  assertions: Array<{ id: string; passed: boolean; detail: string }>
  observation?: ReliabilityObservation
  blocker?: string
  sourceDigest: string
  outputDigest: string
}

export interface ReliabilityMetricRow {
  platform: LabPlatform
  approach: LabApproach
  evidenceLevel: LabEvidenceLevel
  scenariosPassed: number
  scenariosFailed: number
  attempts: number
  successes: number
  successRate: number | null
  unintendedMutations: number
  interferenceEvents: number
  attributionRate: number | null
  staleBlockRate: number | null
  restorationRate: number | null
  latencyP50Ms: number | null
  latencyP95Ms: number | null
}

export interface ReliabilityLabReport {
  schemaVersion: 1
  protocol: 'computer-use-v8-reliability-lab'
  corpusId: string
  corpusDigest: string
  runtimeVersion: string
  generatedAt: string
  results: ReliabilityLabResult[]
  coverage: {
    totalCells: number
    passed: number
    failed: number
    blocked: number
    notRun: number
    byEvidenceLevel: Record<LabEvidenceLevel, { passed: number; failed: number }>
    missingLiveScenarioIds: string[]
  }
  metrics: ReliabilityMetricRow[]
  reportDigest: string
}

export interface ReliabilityProbeContext {
  scenario: ReliabilityLabScenario
  platform: LabPlatform
  approach: LabApproach
  now: () => Date
}

export interface ReliabilityProbeOutput {
  evidenceLevel: LabEvidenceLevel
  status: Exclude<LabResultStatus, 'not_run'>
  environment: ReliabilityLabResult['environment']
  facts?: ReliabilityLabResult['facts']
  assertions?: ReliabilityLabResult['assertions']
  observation?: ReliabilityObservation
  blocker?: string
  sourceDigest: string
}

export type ReliabilityProbe = (context: ReliabilityProbeContext) => Promise<ReliabilityProbeOutput>

const evidenceRank: Record<LabEvidenceLevel, number> = { deterministic: 0, integration: 1, live: 2 }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex')}`
}

export function reliabilityCorpusDigest(corpus: ReliabilityLabCorpus): string {
  const body = structuredClone(corpus)
  body.corpusDigest = ''
  return sha256(body)
}

export function verifyReliabilityCorpus(corpus: ReliabilityLabCorpus): boolean {
  const ids = corpus.scenarios.map(item => item.id)
  return corpus.schemaVersion === 1
    && corpus.corpusId.length > 0
    && ids.length > 0
    && new Set(ids).size === ids.length
    && corpus.scenarios.every(item => item.platforms.length > 0
      && item.approaches.length > 0
      && item.assertions.length > 0
      && item.requiredFacts.length > 0)
    && /^sha256:[a-f0-9]{64}$/.test(corpus.corpusDigest)
    && reliabilityCorpusDigest(corpus) === corpus.corpusDigest
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? sorted.at(-1) ?? null
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator
}

function validateObservation(value: ReliabilityObservation): boolean {
  const counts = [value.attempts, value.successes, value.unintendedMutations, value.interferenceEvents,
    value.attributedMutations, value.staleActionsBlocked, value.staleActionsAttempted,
    value.restorationsAttempted, value.restorationsSucceeded]
  return counts.every(entry => Number.isSafeInteger(entry) && entry >= 0)
    && value.successes <= value.attempts
    && value.attributedMutations <= value.attempts
    && value.staleActionsBlocked <= value.staleActionsAttempted
    && value.restorationsSucceeded <= value.restorationsAttempted
    && value.latenciesMs.every(entry => Number.isFinite(entry) && entry >= 0)
}

function validateOutput(scenario: ReliabilityLabScenario, output: ReliabilityProbeOutput): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(output.sourceDigest)) throw new TypeError('probe sourceDigest must be sha256')
  if (evidenceRank[output.evidenceLevel] < evidenceRank[scenario.minimumEvidence] && output.status === 'passed') {
    throw new TypeError(`${scenario.id} requires ${scenario.minimumEvidence} evidence`)
  }
  if (output.evidenceLevel === 'live' && output.status === 'passed' && !output.environment.interactive) {
    throw new TypeError('passing live evidence requires an interactive environment')
  }
  if (output.status === 'blocked' && !output.blocker) throw new TypeError('blocked probe requires blocker')
  if (output.observation && !validateObservation(output.observation)) throw new TypeError('invalid reliability observation')
  const assertions = new Map((output.assertions ?? []).map(item => [item.id, item]))
  const facts = output.facts ?? {}
  if (output.status === 'passed') {
    for (const required of scenario.assertions) {
      if (assertions.get(required)?.passed !== true) throw new TypeError(`missing passing assertion ${required}`)
    }
    for (const required of scenario.requiredFacts) {
      if (!(required in facts)) throw new TypeError(`missing required fact ${required}`)
    }
  }
}

function outputDigest(result: ReliabilityLabResult): string {
  const body = structuredClone(result)
  body.outputDigest = ''
  return sha256(body)
}

export async function runReliabilityLab(input: {
  corpus: ReliabilityLabCorpus
  runtimeVersion: string
  probes?: Record<string, ReliabilityProbe>
  now?: () => Date
  platform?: LabPlatform
  approaches?: LabApproach[]
}): Promise<ReliabilityLabReport> {
  if (!verifyReliabilityCorpus(input.corpus)) throw new TypeError('invalid reliability corpus')
  const now = input.now ?? (() => new Date())
  const platform = input.platform ?? process.platform as LabPlatform
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new TypeError(`unsupported platform ${platform}`)
  const results: ReliabilityLabResult[] = []
  for (const scenario of input.corpus.scenarios) {
    if (!scenario.platforms.includes(platform)) continue
    for (const approach of scenario.approaches.filter(value => !input.approaches || input.approaches.includes(value))) {
      const probe = input.probes?.[scenario.id]
      const observedAt = now().toISOString()
      if (!probe) {
        const result: ReliabilityLabResult = {
          schemaVersion: 1, resultId: `lab_${sha256(`${scenario.id}:${platform}:${approach}:${observedAt}`).slice(-24)}`,
          scenarioId: scenario.id, platform, approach, evidenceLevel: 'deterministic', status: 'not_run', observedAt,
          environment: { osRelease: 'not_observed', arch: process.arch, interactive: false, ci: Boolean(process.env.CI), sessionKind: 'not_observed', displayServer: 'not_observed', compositor: 'not_observed' },
          facts: {}, assertions: [], blocker: 'no_probe_registered', sourceDigest: sha256('no_probe_registered'), outputDigest: '',
        }
        result.outputDigest = outputDigest(result)
        results.push(result)
        continue
      }
      const output = await probe({ scenario, platform, approach, now })
      validateOutput(scenario, output)
      const result: ReliabilityLabResult = {
        schemaVersion: 1, resultId: `lab_${sha256(`${scenario.id}:${platform}:${approach}:${observedAt}`).slice(-24)}`,
        scenarioId: scenario.id, platform, approach, evidenceLevel: output.evidenceLevel, status: output.status,
        observedAt, environment: structuredClone(output.environment), facts: structuredClone(output.facts ?? {}),
        assertions: structuredClone(output.assertions ?? []), sourceDigest: output.sourceDigest, outputDigest: '',
      }
      if (output.observation) result.observation = structuredClone(output.observation)
      if (output.blocker) result.blocker = output.blocker
      result.outputDigest = outputDigest(result)
      results.push(result)
    }
  }
  return buildReliabilityLabReport({ corpus: input.corpus, runtimeVersion: input.runtimeVersion, generatedAt: now().toISOString(), results })
}

export function buildReliabilityLabReport(input: {
  corpus: ReliabilityLabCorpus
  runtimeVersion: string
  generatedAt: string
  results: ReliabilityLabResult[]
}): ReliabilityLabReport {
  if (!verifyReliabilityCorpus(input.corpus)) throw new TypeError('invalid reliability corpus')
  const scenarioById = new Map(input.corpus.scenarios.map(item => [item.id, item]))
  const seen = new Set<string>()
  for (const result of input.results) {
    const scenario = scenarioById.get(result.scenarioId)
    if (!scenario || !scenario.platforms.includes(result.platform) || !scenario.approaches.includes(result.approach)) throw new TypeError('result is outside corpus matrix')
    const key = `${result.scenarioId}:${result.platform}:${result.approach}`
    if (seen.has(key)) throw new TypeError(`duplicate result cell ${key}`)
    seen.add(key)
    if (outputDigest(result) !== result.outputDigest) throw new TypeError(`invalid result digest ${result.resultId}`)
    if (result.observation && !validateObservation(result.observation)) throw new TypeError(`invalid observation ${result.resultId}`)
    if (result.status === 'passed' && evidenceRank[result.evidenceLevel] < evidenceRank[scenario.minimumEvidence]) throw new TypeError('insufficient evidence level')
    if (result.status === 'passed' && result.evidenceLevel === 'live' && !result.environment.interactive) throw new TypeError('non-interactive result cannot pass as live evidence')
  }
  const groups = new Map<string, ReliabilityLabResult[]>()
  for (const result of input.results) {
    const key = `${result.platform}:${result.approach}:${result.evidenceLevel}`
    groups.set(key, [...(groups.get(key) ?? []), result])
  }
  const metrics = [...groups.values()].map(group => {
    const observations = group.flatMap(item => item.observation ? [item.observation] : [])
    const sum = (pick: (item: ReliabilityObservation) => number) => observations.reduce((total, item) => total + pick(item), 0)
    const attempts = sum(item => item.attempts)
    const staleAttempts = sum(item => item.staleActionsAttempted)
    const restorationAttempts = sum(item => item.restorationsAttempted)
    return {
      platform: group[0]!.platform, approach: group[0]!.approach, evidenceLevel: group[0]!.evidenceLevel,
      scenariosPassed: group.filter(item => item.status === 'passed').length,
      scenariosFailed: group.filter(item => item.status === 'failed').length,
      attempts, successes: sum(item => item.successes), successRate: ratio(sum(item => item.successes), attempts),
      unintendedMutations: sum(item => item.unintendedMutations), interferenceEvents: sum(item => item.interferenceEvents),
      attributionRate: ratio(sum(item => item.attributedMutations), attempts),
      staleBlockRate: ratio(sum(item => item.staleActionsBlocked), staleAttempts),
      restorationRate: ratio(sum(item => item.restorationsSucceeded), restorationAttempts),
      latencyP50Ms: percentile(observations.flatMap(item => item.latenciesMs), .5),
      latencyP95Ms: percentile(observations.flatMap(item => item.latenciesMs), .95),
    } satisfies ReliabilityMetricRow
  }).sort((a, b) => `${a.platform}:${a.approach}:${a.evidenceLevel}`.localeCompare(`${b.platform}:${b.approach}:${b.evidenceLevel}`))
  const counts = (status: LabResultStatus) => input.results.filter(item => item.status === status).length
  const report: ReliabilityLabReport = {
    schemaVersion: 1, protocol: 'computer-use-v8-reliability-lab', corpusId: input.corpus.corpusId,
    corpusDigest: input.corpus.corpusDigest, runtimeVersion: input.runtimeVersion, generatedAt: input.generatedAt,
    results: structuredClone(input.results).sort((a, b) => `${a.scenarioId}:${a.platform}:${a.approach}`.localeCompare(`${b.scenarioId}:${b.platform}:${b.approach}`)),
    coverage: {
      totalCells: input.results.length, passed: counts('passed'), failed: counts('failed'), blocked: counts('blocked'), notRun: counts('not_run'),
      byEvidenceLevel: {
        deterministic: { passed: input.results.filter(item => item.evidenceLevel === 'deterministic' && item.status === 'passed').length, failed: input.results.filter(item => item.evidenceLevel === 'deterministic' && item.status === 'failed').length },
        integration: { passed: input.results.filter(item => item.evidenceLevel === 'integration' && item.status === 'passed').length, failed: input.results.filter(item => item.evidenceLevel === 'integration' && item.status === 'failed').length },
        live: { passed: input.results.filter(item => item.evidenceLevel === 'live' && item.status === 'passed').length, failed: input.results.filter(item => item.evidenceLevel === 'live' && item.status === 'failed').length },
      },
      missingLiveScenarioIds: [...new Set(input.corpus.scenarios.filter(item => item.minimumEvidence === 'live' && !input.results.some(result => result.scenarioId === item.id && result.status === 'passed' && result.evidenceLevel === 'live')).map(item => item.id))].sort(),
    },
    metrics, reportDigest: '',
  }
  report.reportDigest = reliabilityLabReportDigest(report)
  return report
}

export function reliabilityLabReportDigest(report: ReliabilityLabReport): string {
  const body = structuredClone(report)
  body.reportDigest = ''
  return sha256(body)
}

export function verifyReliabilityLabReport(report: ReliabilityLabReport, corpus: ReliabilityLabCorpus): boolean {
  try {
    if (report.schemaVersion !== 1 || report.protocol !== 'computer-use-v8-reliability-lab'
      || report.corpusId !== corpus.corpusId || report.corpusDigest !== corpus.corpusDigest
      || !/^sha256:[a-f0-9]{64}$/.test(report.reportDigest) || reliabilityLabReportDigest(report) !== report.reportDigest) return false
    const rebuilt = buildReliabilityLabReport({ corpus, runtimeVersion: report.runtimeVersion, generatedAt: report.generatedAt, results: report.results })
    return rebuilt.reportDigest === report.reportDigest
  } catch { return false }
}
