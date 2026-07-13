#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { buildV8ReleaseReadinessReport, verifyV8ReleaseReadinessReport } from '../dist/release/index.js'

const root = resolve(new URL('..', import.meta.url).pathname)
const flag = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const readJson = async path => JSON.parse(await readFile(resolve(process.cwd(), path), 'utf8'))
const stage = flag('--stage') ?? 'stable'
if (!['developer_preview', 'beta', 'stable'].includes(stage)) throw new TypeError('--stage must be developer_preview, beta, or stable')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const conformance = await readJson(flag('--conformance') ?? resolve(root, 'docs/conformance/v8/report-2026-07-13.json'))
const reliability = await readJson(flag('--reliability') ?? resolve(root, 'docs/conformance/v8/reliability-report-2026-07-13.json'))
const reliabilityCorpus = await readJson(flag('--corpus') ?? resolve(root, 'contracts/v8/reliability-lab-corpus.json'))
const artifactManifest = flag('--artifacts') ? await readJson(flag('--artifacts')) : undefined
const adkEvaluation = await readJson(flag('--adk-evaluation') ?? resolve(root, 'docs/conformance/v8/adk-evaluation-receipt-7.0.0.json'))
const trustedKeys = flag('--trusted-keys') ? await readJson(flag('--trusted-keys')) : {}
const signedEvidence = []
for (let index = 0; index < process.argv.length; index++) {
  if (process.argv[index] !== '--evidence') continue
  const value = await readJson(process.argv[index + 1])
  signedEvidence.push(...(Array.isArray(value) ? value : [value]))
}
const report = buildV8ReleaseReadinessReport({
  requestedStage: stage, runtimeVersion: pkg.version, evaluatedAt: new Date().toISOString(),
  conformance, reliability, reliabilityCorpus, artifactManifest, adkEvaluation, signedEvidence, trustedKeys,
})
if (!verifyV8ReleaseReadinessReport(report)) throw new Error('readiness report failed integrity verification')
const rendered = `${JSON.stringify(report, null, process.argv.includes('--compact') ? 0 : 2)}\n`
const output = flag('--output')
if (output) await writeFile(resolve(process.cwd(), output), rendered, { mode: 0o644 })
else process.stdout.write(rendered)
if (report.decision === 'no_go' && !process.argv.includes('--report-only')) process.exitCode = 2
