#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import {
  buildReleaseArtifactManifest,
  verifyArtifactBytes,
  verifyReleaseArtifactManifest,
} from '../dist/release/index.js'

const root = resolve(new URL('..', import.meta.url).pathname)
const targets = [
  ['darwin-arm64', 'darwin', 'arm64'],
  ['darwin-x64', 'darwin', 'x64'],
  ['win32-x64', 'win32', 'x64'],
  ['linux-x64', 'linux', 'x64'],
  ['linux-arm64', 'linux', 'arm64'],
]
const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const allowMissing = process.argv.includes('--allow-missing')
const verifyCopies = process.argv.includes('--verify-copies')
const artifacts = []
const missing = []

for (const [target, platform, arch] of targets) {
  const packageName = `@zavora-ai/computer-use-mcp-${target}`
  const packageManifest = JSON.parse(await readFile(resolve(root, 'packages', `computer-use-mcp-${target}`, 'package.json'), 'utf8'))
  if (packageManifest.name !== packageName || packageManifest.version !== rootPackage.version
    || rootPackage.optionalDependencies?.[packageName] !== rootPackage.version
    || packageManifest.os?.[0] !== platform || packageManifest.cpu?.[0] !== arch) {
    throw new Error(`package linkage mismatch for ${target}`)
  }
  const filename = `computer-use-napi.${target}.node`
  let bytes
  try { bytes = await readFile(resolve(root, filename)) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    missing.push(filename)
    continue
  }
  artifacts.push({ filename, platform, arch, packageName, packageVersion: packageManifest.version, bytes })
}

if (missing.length && !allowMissing) throw new Error(`missing release artifacts: ${missing.join(', ')}`)
if (!artifacts.length) throw new Error('no release artifacts found')
const manifest = buildReleaseArtifactManifest({ rootPackage: rootPackage.name, rootVersion: rootPackage.version, artifacts })
if (!verifyReleaseArtifactManifest(manifest)) throw new Error('generated release artifact manifest failed verification')

if (verifyCopies) {
  for (const record of manifest.artifacts) {
    const copy = await readFile(resolve(root, 'packages', `computer-use-mcp-${record.platform}-${record.arch}`, record.filename))
    if (!verifyArtifactBytes(record, copy)) throw new Error(`platform package copy mismatch: ${record.filename}`)
  }
}

const outputFlag = process.argv.indexOf('--output')
if (outputFlag >= 0) {
  const output = process.argv[outputFlag + 1]
  if (!output) throw new TypeError('--output requires a path')
  const path = resolve(process.cwd(), output)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  await rename(temporary, path)
}
console.log(JSON.stringify(manifest, null, process.argv.includes('--compact') ? 0 : 2))
