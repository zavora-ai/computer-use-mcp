import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  buildV8ReleaseReadinessReport,
  signedReleaseEvidenceDigest,
  signedReleaseEvidencePayload,
  v8ReleaseReadinessReportDigest,
  verifyAdkEvaluationReceipt,
  verifyV8ReleaseReadinessReport,
} from '../dist/release/readiness.js'
import { buildReleaseArtifactManifest } from '../dist/release/artifacts.js'
import { conformanceReportDigest } from '../dist/reliability/conformance.js'
import { reliabilityCorpusDigest, runReliabilityLab } from '../dist/reliability/lab.js'

const exec = promisify(execFile)
const conformanceBase = JSON.parse(await readFile(new URL('../docs/conformance/v8/report-2026-07-13.json', import.meta.url), 'utf8'))
const reliabilityBase = JSON.parse(await readFile(new URL('../docs/conformance/v8/reliability-report-2026-07-13.json', import.meta.url), 'utf8'))
const corpusBase = JSON.parse(await readFile(new URL('../contracts/v8/reliability-lab-corpus.json', import.meta.url), 'utf8'))
const adkEvaluation = JSON.parse(await readFile(new URL('../docs/conformance/v8/adk-evaluation-receipt-7.0.0.json', import.meta.url), 'utf8'))
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

function evidence(kind, platform, claims, artifactDigests, overrides = {}) {
  const value = {
    schemaVersion: 1, evidenceId: `sha256:${'0'.repeat(64)}`, kind, platform, subjectVersion: '7.0.0',
    observedAt: '2026-07-13T12:00:00.000Z', expiresAt: '2026-08-13T12:00:00.000Z', claims,
    artifactDigests, keyId: 'release-test', signature: '', ...overrides,
  }
  value.evidenceId = signedReleaseEvidenceDigest(value)
  value.signature = sign(null, Buffer.from(signedReleaseEvidencePayload(value)), privateKey).toString('base64')
  return value
}

test('current public evidence produces an honest no-go even for developer preview', () => {
  assert.equal(verifyAdkEvaluationReceipt(adkEvaluation), true)
  const tamperedAdk = structuredClone(adkEvaluation); tamperedAdk.claims.duplicateMutations = 1
  assert.equal(verifyAdkEvaluationReceipt(tamperedAdk), false)
  const report = buildV8ReleaseReadinessReport({
    requestedStage: 'developer_preview', runtimeVersion: '7.0.0', evaluatedAt: '2026-07-13T13:00:00.000Z',
    conformance: conformanceBase, reliability: reliabilityBase, reliabilityCorpus: corpusBase,
  })
  assert.equal(verifyV8ReleaseReadinessReport(report), true)
  assert.equal(report.decision, 'no_go')
  assert.equal(report.highestReadyStage, 'none')
  assert.equal(report.gates.find(item => item.id === 'core.governed_runtime').status, 'pass')
  assert.notEqual(report.gates.find(item => item.id === 'background.dual_platform_purity').status, 'pass')
  assert.equal(report.gates.find(item => item.id === 'adk.flagship_crash_resume').status, 'missing')
  const deleted = structuredClone(report)
  deleted.gates = deleted.gates.filter(item => item.id !== 'background.dual_platform_purity')
  deleted.reportDigest = v8ReleaseReadinessReportDigest(deleted)
  assert.equal(verifyV8ReleaseReadinessReport(deleted), false)
})

test('untrusted, expired, or edited signed evidence cannot satisfy a release gate', () => {
  const valid = evidence('adk_graph', 'all', { testsPassed: true, authBound: true, multimodalEvidence: true, duplicateMutations: 0, crashPointsCovered: 8 }, [conformanceBase.reportDigest])
  const edited = structuredClone(valid); edited.claims.duplicateMutations = 1
  const expired = evidence('adk_graph', 'all', valid.claims, [conformanceBase.reportDigest], { expiresAt: '2026-07-13T12:30:00.000Z' })
  for (const [item, keys] of [[edited, { 'release-test': publicPem }], [expired, { 'release-test': publicPem }], [valid, {}]]) {
    const report = buildV8ReleaseReadinessReport({
      requestedStage: 'developer_preview', runtimeVersion: '7.0.0', evaluatedAt: '2026-07-13T13:00:00.000Z',
      conformance: conformanceBase, reliability: reliabilityBase, reliabilityCorpus: corpusBase,
      signedEvidence: [item], trustedKeys: keys,
    })
    assert.equal(report.gates.find(gate => gate.id === 'adk.flagship_crash_resume').status, 'missing')
    assert.deepEqual(report.inputs.signedEvidenceDigests, [])
  }
})

test('stable go requires every built-in gate and trusted external proof', async () => {
  const conformance = structuredClone(conformanceBase)
  conformance.badges['background-safe'] = { status: 'pass', evidenceLevel: 'live', satisfied: ['darwin:test', 'win32:test'], missing: [] }
  conformance.badges['supervisor-ready'] = { status: 'pass', evidenceLevel: 'integration', satisfied: ['all'], missing: [] }
  conformance.reportDigest = conformanceReportDigest(conformance)
  const corpus = {
    schemaVersion: 1, corpusId: 'readiness-live', description: 'one live release cell',
    scenarios: [{ id: 'live-cell', title: 'live', platforms: ['darwin'], approaches: ['runtime'], category: 'session', condition: 'interactive', minimumEvidence: 'live', assertions: ['live.ok'], requiredFacts: ['runner'] }],
    corpusDigest: '',
  }
  corpus.corpusDigest = reliabilityCorpusDigest(corpus)
  const reliability = await runReliabilityLab({
    corpus, runtimeVersion: '7.0.0', platform: 'darwin', now: () => new Date('2026-07-13T12:00:00.000Z'),
    probes: { 'live-cell': async () => ({ evidenceLevel: 'live', status: 'passed', environment: { osRelease: 'test', arch: 'arm64', interactive: true, ci: true, sessionKind: 'console', displayServer: 'Quartz', compositor: 'WindowServer' }, facts: { runner: 'signed-hardware' }, assertions: [{ id: 'live.ok', passed: true, detail: 'passed' }], sourceDigest: `sha256:${'a'.repeat(64)}` }) },
  })
  const headers = {
    'darwin-arm64': (() => { const b = new Uint8Array(32); b.set([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]); return b })(),
    'darwin-x64': (() => { const b = new Uint8Array(32); b.set([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0, 0, 1]); return b })(),
    'win32-x64': (() => { const b = new Uint8Array(80); b.set([0x4d, 0x5a]); new DataView(b.buffer).setUint32(0x3c, 64, true); b.set([0x50, 0x45, 0, 0, 0x64, 0x86], 64); return b })(),
    'linux-x64': (() => { const b = new Uint8Array(64); b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); new DataView(b.buffer).setUint16(18, 0x3e, true); return b })(),
    'linux-arm64': (() => { const b = new Uint8Array(64); b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); new DataView(b.buffer).setUint16(18, 0xb7, true); return b })(),
  }
  const artifacts = buildReleaseArtifactManifest({ rootPackage: '@zavora-ai/computer-use-mcp', rootVersion: '7.0.0', artifacts: Object.entries(headers).map(([target, bytes]) => { const [platform, arch] = target.split('-'); return { filename: `computer-use-napi.${target}.node`, platform, arch, packageName: `@zavora-ai/computer-use-mcp-${target}`, packageVersion: '7.0.0', bytes } }) })
  const signed = [
    ...['darwin', 'win32'].map(platform => evidence('background_certification', platform, { interference: 'none', focusChanged: false, pointerMoved: false, physicalInputInjected: false, rollbackVerified: true }, [conformance.reportDigest])),
    evidence('ci_matrix', 'all', { testsPassed: true, supervisorPassed: true, targets: 'darwin-arm64,darwin-x64,win32-x64,linux-arm64,linux-x64', nodeVersions: '18,20,22,current' }, [conformance.reportDigest]),
    ...['darwin', 'win32'].map(platform => evidence('input_interruption', platform, {
      physicalAttribution: true, emergencyChord: true, disconnected: true,
      nativeLatched: true, postRevocationActions: 0, p95Ms: 50, raceCount: 10000,
    }, [reliability.reportDigest])),
    evidence('adk_graph', 'all', { testsPassed: true, authBound: true, multimodalEvidence: true, duplicateMutations: 0, crashPointsCovered: 2 }, [adkEvaluation.receiptDigest]),
    evidence('code_signing', 'darwin', { verified: true, notarized: true }, [artifacts.manifestDigest]),
    evidence('code_signing', 'win32', { verified: true }, [artifacts.manifestDigest]),
    evidence('security_review', 'all', { passed: true, criticalOpen: 0, highOpen: 0 }, [conformance.reportDigest]),
  ]
  const report = buildV8ReleaseReadinessReport({ requestedStage: 'stable', runtimeVersion: '7.0.0', evaluatedAt: '2026-07-13T13:00:00.000Z', conformance, reliability, reliabilityCorpus: corpus, artifactManifest: artifacts, adkEvaluation, signedEvidence: signed, trustedKeys: { 'release-test': publicPem } })
  assert.equal(report.decision, 'go')
  assert.equal(report.highestReadyStage, 'stable')
  assert.ok(report.gates.every(gate => gate.status === 'pass'))
  assert.equal(verifyV8ReleaseReadinessReport(report), true)
})

test('readiness schemas compile and packaged CLI reports current no-go without failing report-only mode', async () => {
  const ajv = new Ajv2020({ strict: false, formats: { 'date-time': true } })
  let reportValidator
  for (const name of ['release-evidence.schema.json', 'release-readiness-report.schema.json', 'adk-evaluation-receipt.schema.json']) {
    const schema = JSON.parse(await readFile(new URL(`../contracts/v8/${name}`, import.meta.url), 'utf8'))
    const validator = ajv.compile(schema)
    if (name.includes('readiness')) reportValidator = validator
  }
  const { stdout } = await exec(process.execPath, ['scripts/evaluate-v8-readiness.mjs', '--stage', 'stable', '--report-only', '--compact'], { cwd: new URL('..', import.meta.url) })
  const report = JSON.parse(stdout)
  assert.equal(report.decision, 'no_go')
  assert.equal(verifyV8ReleaseReadinessReport(report), true)
  assert.equal(reportValidator(report), true)
  await assert.rejects(exec(process.execPath, ['scripts/evaluate-v8-readiness.mjs', '--stage', 'stable', '--compact'], { cwd: new URL('..', import.meta.url) }), error => error.code === 2)
})

test('published readiness report is valid and cannot claim a release stage', async () => {
  const report = JSON.parse(await readFile(new URL('../docs/conformance/v8/readiness-report-2026-07-13.json', import.meta.url), 'utf8'))
  assert.equal(verifyV8ReleaseReadinessReport(report), true)
  assert.equal(report.decision, 'no_go')
  assert.equal(report.highestReadyStage, 'none')
})
