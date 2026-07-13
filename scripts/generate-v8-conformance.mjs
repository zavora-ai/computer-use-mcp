#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { buildV8ConformanceReport, verifyV8ConformanceReport } from '../dist/reliability/conformance.js'

const runFile = promisify(execFile)
const root = resolve(new URL('..', import.meta.url).pathname)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const suites = [
  {
    scope: 'policy', kind: 'deterministic_suite',
    files: [
      'test/v8-runtime-kernel.test.mjs',
      'test/v8-browser-bridge.test.mjs',
      'test/v8-provider-adapters.test.mjs',
      'test/v8-provider-examples.test.mjs',
      'test/v8-onboarding.test.mjs',
      'test/v8-onboarding-ui.test.mjs',
      'test/v8-reliability-lab.test.mjs',
      'test/v8-release-artifacts.test.mjs',
      'test/v8-release-readiness.test.mjs',
      'test/v8-registry-action.test.mjs',
      'test/v8-migration.test.mjs',
      'examples/v8-direct-sdk.mjs',
      'examples/v8-langgraph.mjs',
      'src/runtime/browser-bridge.ts',
      'contracts/v8/browser-page-evidence.schema.json',
      'contracts/v8/setup-command.schema.json',
      'contracts/v8/setup-view-model.schema.json',
      'src/onboarding/desktop.ts',
      'src/onboarding/terminal.ts',
      'src/onboarding/view-model.ts',
      'src/native.ts',
      'native/src/lib.rs',
      'native/src/permissions.rs',
      'native/src/keychain.rs',
      'packages/computer-use-remote/src/os-vault.mjs',
      'packages/computer-use-remote/src/pairing.mjs',
      'packages/computer-use-remote/src/cli.mjs',
      'packages/computer-use-remote/test/remote.test.mjs',
      'examples/v8-electron-setup.mjs',
      'examples/v8-tauri-setup.mjs',
      'examples/v8-setup-ui.mjs',
      'src/reliability/lab.ts',
      'scripts/run-v8-reliability-lab.mjs',
      'contracts/v8/reliability-lab-corpus.json',
      'contracts/v8/reliability-lab-corpus.schema.json',
      'contracts/v8/reliability-lab-report.schema.json',
      'src/release/artifacts.ts',
      'scripts/generate-release-artifacts.mjs',
      'release-artifacts.json',
      'contracts/v8/release-artifact-manifest.schema.json',
      'src/release/readiness.ts',
      'src/migration/v8.ts',
      'src/migration/cli.ts',
      'scripts/evaluate-v8-readiness.mjs',
      'contracts/v8/release-evidence.schema.json',
      'contracts/v8/release-readiness-report.schema.json',
      'contracts/v8/adk-evaluation-receipt.schema.json',
      'docs/conformance/v8/adk-evaluation-receipt-7.0.0.json',
    ],
    commands: [[process.execPath, ['--test',
      'test/v8-runtime-kernel.test.mjs',
      'test/v8-browser-bridge.test.mjs',
      'test/v8-provider-adapters.test.mjs',
      'test/v8-provider-examples.test.mjs',
      'test/v8-onboarding.test.mjs',
      'test/v8-onboarding-ui.test.mjs',
      'test/v8-reliability-lab.test.mjs',
      'test/v8-release-artifacts.test.mjs',
      'test/v8-release-readiness.test.mjs',
      'test/v8-registry-action.test.mjs',
      'test/v8-migration.test.mjs',
    ]], [npm, ['test', '--prefix', 'packages/computer-use-remote']]],
    assertions: [
      'policy.operation_boundaries', 'policy.approval_binding', 'policy.untrusted_provenance',
      'target.stale_fail_closed', 'receipt.exactly_once',
      'onboarding.disclosure_boundary',
      'reliability.evidence_separation',
      'release.artifact_binding',
      'release.mandatory_readiness_gates',
      'remote.os_vault_boundary',
    ],
  },
  {
    scope: 'multi_agent', kind: 'deterministic_suite',
    files: ['test/v8-reliability-corpus.test.mjs', 'test/v8-mcp-facade.test.mjs'],
    commands: [[process.execPath, ['--test',
      'test/v8-reliability-corpus.test.mjs', 'test/v8-mcp-facade.test.mjs',
    ]]],
    assertions: [
      'lease.one_writer', 'lease.terminal_revocation', 'lease.schedule_10000',
      'reservation.conflict', 'reservation.no_authority',
    ],
  },
  {
    scope: 'supervisor', kind: 'integration_suite',
    files: [
      'test/v8-supervisor-ipc.test.mjs',
      'test/v8-emergency-stop.test.mjs',
      'test/cancellation.test.mjs',
      'src/session/spawn.ts',
      'src/server.ts',
      'src/control/activity-monitor.ts',
      'src/runtime/coordinator.ts',
      'src/session/supervisor-ipc.ts',
      'native/src/activity.rs',
      'native/src/keyboard.rs',
      'native/src/mouse.rs',
      'packages/computer-use-supervisor/test/model.test.mjs',
      'packages/computer-use-supervisor/src/model.mjs',
      'packages/computer-use-supervisor/src/main.mjs',
      'packages/computer-use-supervisor/src/preload.mjs',
      'packages/computer-use-supervisor/src/renderer.mjs',
      'packages/computer-use-supervisor/src/renderer.html',
    ],
    commands: [
      [process.execPath, ['--test',
        'test/v8-supervisor-ipc.test.mjs', 'test/v8-emergency-stop.test.mjs', 'test/cancellation.test.mjs',
      ]],
      [npm, ['test', '--prefix', 'packages/computer-use-supervisor']],
    ],
    assertions: [
      'supervisor.authentication', 'supervisor.principal_isolation',
      'supervisor.lifecycle_control', 'supervisor.approval_binding',
      'supervisor.renderer_boundary', 'supervisor.emergency_out_of_band',
      'supervisor.emergency_confirmed_reset',
      'supervisor.credential_not_inherited',
    ],
  },
]

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

async function sourceEvidence(files) {
  const hash = createHash('sha256')
  const sources = []
  for (const file of [...files].sort()) {
    const bytes = await readFile(join(root, file))
    hash.update(`${file}\0`)
    hash.update(bytes)
    hash.update('\0')
    sources.push({ path: file, digest: digest(bytes) })
  }
  return { digest: `sha256:${hash.digest('hex')}`, sources }
}

function testCount(output) {
  return [...output.matchAll(/(?:ℹ|#) tests (\d+)/g)]
    .reduce((total, match) => total + Number(match[1]), 0)
}

async function runSuite(suite) {
  const started = performance.now()
  let passed = true
  let output = ''
  for (const [command, args] of suite.commands) {
    try {
      const result = await runFile(command, args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })
      output += `${result.stdout}\n${result.stderr}\n`
    } catch (error) {
      passed = false
      output += `${error.stdout ?? ''}\n${error.stderr ?? error.message}\n`
    }
  }
  const source = await sourceEvidence(suite.files)
  return {
    schemaVersion: 1,
    evidenceId: `evidence_${suite.scope}_${source.digest.slice(-16)}`,
    kind: suite.kind,
    scope: suite.scope,
    observedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      interactive: false,
      source: process.env.CI ? 'ci' : 'local',
    },
    command: suite.commands.map(([command, args]) => `${basename(command)} ${args.join(' ')}`).join(' && '),
    passed,
    tests: testCount(output),
    durationMs: Math.round(performance.now() - started),
    assertions: suite.assertions,
    sources: source.sources,
    sourceDigest: source.digest,
    outputDigest: digest(output),
  }
}

const traceRoot = join(root, 'docs', 'conformance', 'v8')
const traces = []
for (const file of (await readdir(traceRoot)).sort()) {
  if (!file.endsWith('.json') || file.includes('report') || file.includes('evidence')) continue
  const path = join(traceRoot, file)
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (value?.schemaVersion === 1 && typeof value?.certificationId === 'string') {
    traces.push({ path: relative(root, path), trace: value })
  }
}
const evidence = []
for (const suite of suites) evidence.push(await runSuite(suite))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const report = buildV8ConformanceReport({
  runtimeVersion: pkg.version,
  generatedAt: new Date().toISOString(),
  evidence,
  traces,
})
if (!verifyV8ConformanceReport(report)) throw new Error('generated conformance report failed integrity verification')
const rendered = `${JSON.stringify(report, null, process.argv.includes('--compact') ? 0 : 2)}\n`
const outputFlag = process.argv.indexOf('--output')
if (outputFlag >= 0) {
  const outputPath = process.argv[outputFlag + 1]
  if (!outputPath) throw new TypeError('--output requires a path')
  await writeFile(resolve(process.cwd(), outputPath), rendered, { mode: 0o644 })
} else {
  process.stdout.write(rendered)
}
if (evidence.some(item => !item.passed)) process.exitCode = 1
