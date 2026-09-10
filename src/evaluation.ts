export interface EvaluationRun {
  taskId: string; verified: boolean; elapsedMs: number; inputTokens: number; cachedInputTokens: number
  outputTokens: number; modelCalls: number; interventions: number; attentionMs: number; cost?: number
}
export interface EvaluationDataset {
  configuration: { model: string; environment: string; taskRevision: string; accessMode: string; tokenBudget: number; timeBudgetMs: number }
  runs: EvaluationRun[]
}
const median = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return sorted.length ? (sorted[Math.floor((sorted.length-1)/2)] + sorted[Math.ceil((sorted.length-1)/2)])/2 : null }
/** Paired execution-layer comparison. Verification must come from an external task verifier. */
export function compareEvaluations(baseline: EvaluationDataset, candidate: EvaluationDataset) {
  for (const key of ['model','environment','taskRevision','accessMode','tokenBudget','timeBudgetMs'] as const) {
    if (baseline.configuration[key] !== candidate.configuration[key]) throw new Error(`Unmatched benchmark condition: ${key}`)
  }
  const validate = (dataset: EvaluationDataset) => {
    const ids = new Set<string>()
    for (const run of dataset.runs) {
      if (ids.has(run.taskId)) throw new Error('Duplicate task IDs; aggregate repetitions explicitly')
      ids.add(run.taskId)
      if (typeof run.verified !== 'boolean') throw new Error('External verification outcome is required')
      for (const field of ['elapsedMs','inputTokens','cachedInputTokens','outputTokens','modelCalls','interventions','attentionMs'] as const) {
        if (!Number.isFinite(run[field]) || run[field] < 0) throw new Error(`Invalid metric: ${field}`)
      }
      if (run.cachedInputTokens > run.inputTokens) throw new Error('Cached tokens exceed input tokens')
    }
    return ids
  }
  const ids = validate(baseline), candidateIds = validate(candidate)
  if (!ids.size || ids.size !== candidateIds.size || [...ids].some(id => !candidateIds.has(id))) throw new Error('Require the same nonempty task set')
  const summary = (runs: EvaluationRun[]) => {
    const successful = runs.filter(run => run.verified)
    const sum = (field: keyof EvaluationRun) => runs.reduce((total, run) => total + Number(run[field]), 0)
    return { tasks: runs.length, verifiedSuccesses: successful.length, successRate: successful.length/runs.length,
      medianElapsedMs: median(runs.map(run => run.elapsedMs)), medianSuccessfulElapsedMs: median(successful.map(run => run.elapsedMs)),
      inputTokens: sum('inputTokens'), cachedInputTokens: sum('cachedInputTokens'), outputTokens: sum('outputTokens'),
      tokensPerVerifiedSuccess: successful.length ? (sum('inputTokens')+sum('outputTokens'))/successful.length : null,
      costPerVerifiedSuccess: successful.length && runs.every(run => Number.isFinite(run.cost) && run.cost! >= 0) ? sum('cost')/successful.length : null,
      modelCalls: sum('modelCalls'), interventions: sum('interventions'), attentionMs: sum('attentionMs') }
  }
  const map = new Map(candidate.runs.map(run => [run.taskId, run]))
  const differences = baseline.runs.map(run => Number(map.get(run.taskId)!.verified) - Number(run.verified))
  let state = 123456789
  const random = () => { state = (1664525*state+1013904223) >>> 0; return state/4294967296 }
  const samples = Array.from({ length: 2000 }, () => differences.reduce(total => total + differences[Math.floor(random()*differences.length)], 0)/differences.length).sort((a,b) => a-b)
  return { configuration: baseline.configuration, baseline: summary(baseline.runs), candidate: summary(candidate.runs),
    pairedSuccessDifference: differences.reduce((a,b) => a+b,0)/differences.length,
    bootstrap95: [samples[49], samples[1949]], method: 'Paired task bootstrap, 2000 replicates, fixed seed; small suites are descriptive, not proof of superiority.' }
}
