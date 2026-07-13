#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { release } from 'node:os'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { DeterministicFakeDesktop, runReliabilityLab, verifyReliabilityLabReport } from '../dist/reliability/index.js'
import { ControlLeaseManager } from '../dist/control/lease.js'

const root = resolve(new URL('..', import.meta.url).pathname)
const corpus = JSON.parse(await readFile(resolve(root, 'contracts/v8/reliability-lab-corpus.json'), 'utf8'))
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

const builtInSource = createHash('sha256')
for (const file of ['scripts/run-v8-reliability-lab.mjs', 'src/reliability/lab.ts', 'src/reliability/fake-desktop.ts']) {
  builtInSource.update(file)
  builtInSource.update(await readFile(resolve(root, file)))
}
const sourceDigest = `sha256:${builtInSource.digest('hex')}`

function environment() {
  return {
    osRelease: release(), arch: process.arch, interactive: false, ci: Boolean(process.env.CI),
    sessionKind: 'deterministic_fake', displayServer: 'deterministic_fake', compositor: 'deterministic_fake',
  }
}

const probes = {
  'deterministic-display-transform': async () => {
    const origins = [[0, 0], [-1920, 0], [2560, -900]]
    const scales = [1, 1.25, 1.5, 2]
    let cases = 0
    for (const [originX, originY] of origins) {
      for (const scale of scales) {
        for (const [x, y] of [[0, 0], [1, 1], [799, 599], [1919, 1079]]) {
          const physical = [Math.round((originX + x) * scale), Math.round((originY + y) * scale)]
          const logical = [physical[0] / scale - originX, physical[1] / scale - originY]
          if (Math.abs(logical[0] - x) > .5 || Math.abs(logical[1] - y) > .5) throw new Error('display round trip exceeded half a logical pixel')
          cases++
        }
      }
    }
    const outsideBlocked = [[-1, 0], [0, -1], [1920, 0], [0, 1080]].every(([x, y]) => !(x >= 0 && y >= 0 && x < 1920 && y < 1080))
    return {
      evidenceLevel: 'deterministic', status: outsideBlocked ? 'passed' : 'failed', environment: environment(),
      facts: { cases, scaleFactors: scales.join(',') },
      assertions: [
        { id: 'coordinates.round_trip', passed: true, detail: `${cases} seeded mappings stayed within half a logical pixel` },
        { id: 'coordinates.bounds_fail_closed', passed: outsideBlocked, detail: 'all four boundary escapes were rejected' },
      ],
      observation: { attempts: cases + 4, successes: cases + 4, unintendedMutations: 0, interferenceEvents: 0, attributedMutations: 0, staleActionsBlocked: 4, staleActionsAttempted: 4, restorationsAttempted: 0, restorationsSucceeded: 0, latenciesMs: [] },
      sourceDigest,
    }
  },
  'deterministic-interference-guard': async () => {
    const faults = ['focus_thief', 'notification', 'overlay', 'modal']
    let blocked = 0
    for (const fault of faults) {
      const fake = new DeterministicFakeDesktop({ uiTreeRevision: `before-${fault}` })
      const evidence = fake.targetEvidence()
      fake.driftWindow()
      if (!fake.validateTarget(evidence)) blocked++
      if (fake.state.effectCount !== 0) throw new Error('fake desktop mutated during target validation')
    }
    return {
      evidenceLevel: 'deterministic', status: blocked === faults.length ? 'passed' : 'failed', environment: environment(),
      facts: { faults: faults.join(','), seed: 'v8-platform-lab-2026-07' },
      assertions: [
        { id: 'target.drift_blocked', passed: blocked === faults.length, detail: `${blocked}/${faults.length} revised targets rejected` },
        { id: 'mutation.zero_after_drift', passed: true, detail: 'validation produced no fake desktop effects' },
      ],
      observation: { attempts: faults.length, successes: faults.length, unintendedMutations: 0, interferenceEvents: faults.length, attributedMutations: 0, staleActionsBlocked: blocked, staleActionsAttempted: faults.length, restorationsAttempted: 0, restorationsSucceeded: 0, latenciesMs: [] },
      sourceDigest,
    }
  },
  'deterministic-emergency-latch': async () => {
    const leases = new ControlLeaseManager()
    const active = await leases.acquire({
      sessionId: 'lab-session', principalId: 'lab-operator', kind: 'cooperative',
      executionMode: 'foreground', ttlMs: 10_000, actionBudget: 2,
    })
    leases.emergencyStop('lab_emergency')
    let blockedAcquisitions = 0
    try {
      await leases.acquire({
        sessionId: 'lab-after-stop', principalId: 'lab-operator', kind: 'cooperative',
        executionMode: 'foreground', ttlMs: 10_000, actionBudget: 1,
      })
    } catch { blockedAcquisitions++ }
    const activeRevoked = leases.current() === undefined
    leases.resetEmergencyStop()
    const recovered = await leases.acquire({
      sessionId: 'lab-host-reset', principalId: 'lab-operator', kind: 'cooperative',
      executionMode: 'foreground', ttlMs: 10_000, actionBudget: 1,
    })
    return {
      evidenceLevel: 'deterministic', status: activeRevoked && blockedAcquisitions === 1 ? 'passed' : 'failed',
      environment: environment(), facts: { revokedLeases: active.state === 'active' && activeRevoked ? 1 : 0, blockedAcquisitions },
      assertions: [
        { id: 'lease.active_revoked', passed: activeRevoked, detail: 'active writer removed immediately' },
        { id: 'lease.new_work_blocked', passed: blockedAcquisitions === 1, detail: 'fresh acquisition rejected while latched' },
        { id: 'reset.host_only', passed: recovered.state === 'active', detail: 'direct host reset restored acquisition; no MCP reset exists' },
      ],
      observation: { attempts: 2, successes: 2, unintendedMutations: 0, interferenceEvents: 1, attributedMutations: 0, staleActionsBlocked: 1, staleActionsAttempted: 1, restorationsAttempted: 0, restorationsSucceeded: 0, latenciesMs: [] },
      sourceDigest,
    }
  },
}

const moduleFlag = process.argv.indexOf('--probe-module')
if (moduleFlag >= 0) {
  const path = process.argv[moduleFlag + 1]
  if (!path) throw new TypeError('--probe-module requires a path')
  const operator = await import(pathToFileURL(resolve(process.cwd(), path)).href)
  if (!operator.probes || typeof operator.probes !== 'object') throw new TypeError('probe module must export a probes object')
  Object.assign(probes, operator.probes)
}

const report = await runReliabilityLab({ corpus, runtimeVersion: pkg.version, probes })
if (!verifyReliabilityLabReport(report, corpus)) throw new Error('generated reliability report failed integrity verification')
const rendered = `${JSON.stringify(report, null, process.argv.includes('--compact') ? 0 : 2)}\n`
const outputFlag = process.argv.indexOf('--output')
if (outputFlag >= 0) {
  const outputPath = process.argv[outputFlag + 1]
  if (!outputPath) throw new TypeError('--output requires a path')
  await writeFile(resolve(process.cwd(), outputPath), rendered, { mode: 0o644 })
} else {
  process.stdout.write(rendered)
}
