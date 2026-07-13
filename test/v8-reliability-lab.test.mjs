import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  runReliabilityLab,
  verifyReliabilityCorpus,
  verifyReliabilityLabReport,
} from '../dist/reliability/index.js'

const exec = promisify(execFile)
const corpus = JSON.parse(await readFile(new URL('../contracts/v8/reliability-lab-corpus.json', import.meta.url), 'utf8'))
const sha = value => `sha256:${value.repeat(64)}`
const environment = interactive => ({
  osRelease: 'test', arch: 'test', interactive, ci: false,
  sessionKind: interactive ? 'console' : 'deterministic_fake',
  displayServer: 'test', compositor: 'test',
})

test('versioned reliability corpus covers every roadmap lab dimension', () => {
  assert.equal(verifyReliabilityCorpus(corpus), true)
  const categories = new Set(corpus.scenarios.map(item => item.category))
  assert.deepEqual([...categories].sort(), ['compositor', 'display', 'interference', 'privilege', 'session', 'workspace'])
  for (const id of ['multi-monitor-mixed-scale', 'windows-uac-integrity', 'remote-desktop-session',
    'lock-unlock-session', 'sleep-wake-session', 'virtual-machine-session',
    'macos-spaces-fullscreen-stage-manager', 'linux-x11', 'linux-wayland-gnome',
    'linux-wayland-kde', 'linux-wayland-wlroots', 'focus-notification-overlay-modal']) {
    assert.ok(corpus.scenarios.some(item => item.id === id && item.minimumEvidence === 'live'), id)
  }
})

test('public corpus and generated report satisfy their JSON Schemas', async () => {
  const ajv = new Ajv2020({ strict: false, formats: { 'date-time': true } })
  const corpusSchema = JSON.parse(await readFile(new URL('../contracts/v8/reliability-lab-corpus.schema.json', import.meta.url), 'utf8'))
  const reportSchema = JSON.parse(await readFile(new URL('../contracts/v8/reliability-lab-report.schema.json', import.meta.url), 'utf8'))
  assert.equal(ajv.compile(corpusSchema)(corpus), true)
  const report = await runReliabilityLab({ corpus, runtimeVersion: '7.0.0', platform: process.platform })
  const valid = ajv.compile(reportSchema)(report)
  assert.equal(valid, true)
})

test('lab report calculates transparent metrics without promoting missing live cells', async () => {
  const platform = process.platform
  const report = await runReliabilityLab({
    corpus, runtimeVersion: '7.0.0', platform,
    now: () => new Date('2026-07-13T12:00:00.000Z'),
    approaches: ['runtime'],
    probes: {
      'deterministic-display-transform': async () => ({
        evidenceLevel: 'deterministic', status: 'passed', environment: environment(false),
        facts: { cases: 3, scaleFactors: '1,2' },
        assertions: [
          { id: 'coordinates.round_trip', passed: true, detail: 'three cases' },
          { id: 'coordinates.bounds_fail_closed', passed: true, detail: 'four edges' },
        ],
        observation: { attempts: 3, successes: 2, unintendedMutations: 0, interferenceEvents: 1,
          attributedMutations: 2, staleActionsBlocked: 1, staleActionsAttempted: 1,
          restorationsAttempted: 2, restorationsSucceeded: 1, latenciesMs: [1, 2, 100] },
        sourceDigest: sha('a'),
      }),
    },
  })
  assert.equal(verifyReliabilityLabReport(report, corpus), true)
  assert.equal(report.coverage.byEvidenceLevel.deterministic.passed, 1)
  assert.equal(report.coverage.byEvidenceLevel.live.passed, 0)
  assert.ok(report.coverage.missingLiveScenarioIds.includes('windows-uac-integrity'))
  const metric = report.metrics.find(item => item.approach === 'runtime' && item.evidenceLevel === 'deterministic')
  assert.equal(metric.successRate, 2 / 3)
  assert.equal(metric.attributionRate, 2 / 3)
  assert.equal(metric.staleBlockRate, 1)
  assert.equal(metric.restorationRate, .5)
  assert.equal(metric.latencyP50Ms, 2)
  assert.equal(metric.latencyP95Ms, 100)

  report.metrics[0].successRate = 1
  assert.equal(verifyReliabilityLabReport(report, corpus), false)
})

test('live-only scenarios reject deterministic or non-interactive passing evidence', async () => {
  const platform = process.platform
  const scenario = corpus.scenarios.find(item => item.minimumEvidence === 'live' && item.platforms.includes(platform) && item.approaches.includes('runtime'))
  assert.ok(scenario)
  const output = evidenceLevel => async () => ({
    evidenceLevel, status: 'passed', environment: environment(evidenceLevel === 'live' ? false : false),
    facts: Object.fromEntries(scenario.requiredFacts.map(key => [key, 1])),
    assertions: scenario.assertions.map(id => ({ id, passed: true, detail: 'claimed' })),
    sourceDigest: sha('b'),
  })
  await assert.rejects(runReliabilityLab({ corpus, runtimeVersion: '7.0.0', platform, approaches: ['runtime'], probes: { [scenario.id]: output('deterministic') } }), /requires live evidence/)
  await assert.rejects(runReliabilityLab({ corpus, runtimeVersion: '7.0.0', platform, approaches: ['runtime'], probes: { [scenario.id]: output('live') } }), /interactive environment/)
})

test('packaged lab runner passes only deterministic probes and retains unrun live rows', async () => {
  const { stdout } = await exec(process.execPath, ['scripts/run-v8-reliability-lab.mjs', '--compact'], {
    cwd: new URL('..', import.meta.url), maxBuffer: 8 * 1024 * 1024,
  })
  const report = JSON.parse(stdout)
  assert.equal(verifyReliabilityLabReport(report, corpus), true)
  assert.equal(report.coverage.byEvidenceLevel.deterministic.passed, 3)
  assert.equal(report.coverage.byEvidenceLevel.live.passed, 0)
  assert.ok(report.coverage.notRun > 0)
  assert.ok(report.coverage.missingLiveScenarioIds.length >= 10)
  assert.ok(report.coverage.missingLiveScenarioIds.includes('physical-emergency-chord'))
})

test('published reliability baseline remains digest-valid and makes no live claim', async () => {
  const report = JSON.parse(await readFile(new URL('../docs/conformance/v8/reliability-report-2026-07-13.json', import.meta.url), 'utf8'))
  assert.equal(verifyReliabilityLabReport(report, corpus), true)
  assert.equal(report.coverage.byEvidenceLevel.deterministic.passed, 3)
  assert.equal(report.coverage.byEvidenceLevel.live.passed, 0)
  assert.equal(report.coverage.notRun, 16)
})
