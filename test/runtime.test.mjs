import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { ComputerRuntime } from '../dist/runtime.js'
import { compareEvaluations } from '../dist/evaluation.js'

// This launch hook is restricted to fixed, trusted test programs. Production defaults to Docker.
const launch = () => spawn(process.execPath, ['dist/runtime-worker.js'], { stdio: 'pipe' })
test('runtime retains explicit state and returns only selected broker results', async () => {
  const calls = []
  const runtime = new ComputerRuntime({ allowedTools: ['observe'], launch, execute: async (name, args) => { calls.push([name,args]); return { ready: true } } })
  try {
    assert.deepEqual(await runtime.run('state.count = 1; emit(await computer.call("observe", {windowId:1}));'), [{ ready: true }])
    assert.deepEqual(await runtime.run('state.count++; emit(state.count);'), [2])
    assert.equal(calls.length, 1)
  } finally { runtime.close() }
})
test('runtime denies undeclared capabilities and terminates stalled runs', async () => {
  let calls = 0
  const runtime = new ComputerRuntime({ allowedTools: [], launch, execute: async () => { calls++ } })
  await assert.rejects(runtime.run('await computer.call("run_script", {});'), /denied/)
  assert.equal(calls, 0)
  const waiting = new ComputerRuntime({ allowedTools: [], timeoutMs: 50, launch, execute: async () => {} })
  await assert.rejects(waiting.run('await new Promise(() => {});'), /deadline/)
})
test('paired evaluation rejects mismatched access and counts failed attempts in cost', () => {
  const configuration = { model:'fixture',environment:'fixture',taskRevision:'1',accessMode:'hybrid',tokenBudget:1000,timeBudgetMs:1000 }
  const run = { taskId:'one', verified:true,elapsedMs:1,inputTokens:100,cachedInputTokens:0,outputTokens:10,modelCalls:1,interventions:0,attentionMs:0 }
  const baseline = { configuration, runs: [run, {...run, taskId:'two',verified:false}] }
  const candidate = { configuration, runs: [run, {...run,taskId:'two'}] }
  const result = compareEvaluations(baseline,candidate)
  assert.equal(result.baseline.tokensPerVerifiedSuccess,220)
  assert.equal(result.candidate.tokensPerVerifiedSuccess,110)
  assert.equal(result.pairedSuccessDifference,.5)
  assert.throws(() => compareEvaluations(baseline,{...candidate,configuration:{...configuration,accessMode:'visual'}}), /Unmatched/)
})
