import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import {
  buildV8ConformanceReport,
  verifyV8ConformanceReport,
} from '../dist/reliability/conformance.js'

const liveTrace = JSON.parse(await readFile(
  new URL('../docs/conformance/v8/macos-finder-comment-26.2.json', import.meta.url), 'utf8',
))
const digest = character => `sha256:${character.repeat(64)}`
const evidence = (scope, assertions, kind = 'deterministic_suite') => ({
  schemaVersion: 1,
  evidenceId: `evidence_${scope}_0123456789abcdef`,
  kind,
  scope,
  observedAt: '2026-07-13T12:00:00.000Z',
  environment: {
    platform: process.platform, arch: process.arch, node: process.version,
    interactive: false, source: 'local',
  },
  command: `node --test ${scope}`,
  passed: true,
  tests: 1,
  durationMs: 1,
  assertions,
  sources: [{ path: `test/${scope}.test.mjs`, digest: digest('c') }],
  sourceDigest: digest('a'),
  outputDigest: digest('b'),
})

const completeEvidence = [
  evidence('policy', [
    'policy.operation_boundaries', 'policy.approval_binding', 'policy.untrusted_provenance',
    'target.stale_fail_closed', 'receipt.exactly_once',
  ]),
  evidence('multi_agent', [
    'lease.one_writer', 'lease.terminal_revocation', 'lease.schedule_10000',
    'reservation.conflict', 'reservation.no_authority',
  ]),
  evidence('supervisor', [
    'supervisor.authentication', 'supervisor.principal_isolation',
    'supervisor.lifecycle_control', 'supervisor.approval_binding',
    'supervisor.renderer_boundary', 'supervisor.emergency_out_of_band',
    'supervisor.emergency_confirmed_reset',
    'supervisor.credential_not_inherited',
  ], 'integration_suite'),
]

test('conformance badges require scoped evidence and live traces for platform coverage', () => {
  const report = buildV8ConformanceReport({
    runtimeVersion: '7.0.0', generatedAt: '2026-07-13T12:00:00.000Z',
    evidence: completeEvidence,
    traces: [{ path: 'docs/conformance/v8/macos-finder-comment-26.2.json', trace: liveTrace }],
  })
  assert.equal(verifyV8ConformanceReport(report), true)
  assert.equal(report.badges['background-safe'].status, 'partial')
  assert.equal(report.badges['background-safe'].evidenceLevel, 'live')
  assert.equal(report.badges['policy-v2'].status, 'pass')
  assert.equal(report.badges['multi-agent-safe'].status, 'pass')
  assert.equal(report.badges['supervisor-ready'].status, 'partial')
  assert.ok(report.badges['supervisor-ready'].missing.includes('platform:win32'))
  assert.ok(report.badges['background-safe'].missing.includes('win32:valid_live_certification_trace'))
  assert.deepEqual(report.platformCoverage, [{
    platform: 'darwin', liveBackgroundApproaches: ['scripting'],
    operations: ['finder_set_sandbox_file_comment'],
  }])

  const wrongScope = buildV8ConformanceReport({
    runtimeVersion: '7.0.0', generatedAt: '2026-07-13T12:00:00.000Z',
    evidence: [evidence('policy', completeEvidence[2].assertions)], traces: [],
  })
  assert.equal(wrongScope.badges['supervisor-ready'].status, 'unassessed')
  assert.equal(wrongScope.badges['background-safe'].status, 'unassessed')
})

test('tampered certification evidence cannot earn live coverage and report digest detects edits', () => {
  const tampered = structuredClone(liveTrace)
  tampered.probe.result.evidence.rollbackSucceeded = false
  const report = buildV8ConformanceReport({
    runtimeVersion: '7.0.0', generatedAt: '2026-07-13T12:00:00.000Z',
    evidence: completeEvidence,
    traces: [{ path: 'tampered.json', trace: tampered }],
  })
  assert.equal(report.certifications[0].passed, false)
  assert.equal(report.badges['background-safe'].status, 'unassessed')
  assert.deepEqual(report.platformCoverage, [])
  assert.equal(verifyV8ConformanceReport(report), true)
  report.badges['policy-v2'].status = 'unassessed'
  assert.equal(verifyV8ConformanceReport(report), false)
})

test('conformance schemas are included in the public contract manifest', async () => {
  const manifest = JSON.parse(await readFile(new URL('../contracts/v8/manifest.json', import.meta.url), 'utf8'))
  assert.ok(manifest.fixtures.includes('conformance-evidence.schema.json'))
  assert.ok(manifest.fixtures.includes('conformance-report.schema.json'))
  assert.ok(manifest.fixtures.includes('browser-page-evidence.schema.json'))
  assert.ok(manifest.fixtures.includes('setup-command.schema.json'))
  assert.ok(manifest.fixtures.includes('setup-view-model.schema.json'))
  assert.ok(manifest.fixtures.includes('reliability-lab-corpus.json'))
  assert.ok(manifest.fixtures.includes('reliability-lab-corpus.schema.json'))
  assert.ok(manifest.fixtures.includes('reliability-lab-report.schema.json'))
  const published = JSON.parse(await readFile(
    new URL('../docs/conformance/v8/report-2026-07-13.json', import.meta.url), 'utf8',
  ))
  assert.equal(verifyV8ConformanceReport(published), true)
  assert.equal(published.badges['background-safe'].status, 'partial')
  assert.equal(published.badges['supervisor-ready'].status, 'partial')
})
