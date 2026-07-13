import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  buildReleaseArtifactManifest,
  nativeBinaryArchitecture,
  nativeBinaryFormat,
  verifyArtifactBytes,
  verifyReleaseArtifactManifest,
} from '../dist/release/index.js'

const mach = new Uint8Array(32); mach.set([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1])
const pe = new Uint8Array(80); pe.set([0x4d, 0x5a]); new DataView(pe.buffer).setUint32(0x3c, 64, true); pe.set([0x50, 0x45, 0, 0, 0x64, 0x86], 64)
const elf = new Uint8Array(64); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); new DataView(elf.buffer).setUint16(18, 0x3e, true)
const bytes = { darwin: mach, win32: pe, linux: elf }

const input = (target, platform, arch) => ({
  filename: `computer-use-napi.${target}.node`, platform, arch,
  packageName: `@zavora-ai/computer-use-mcp-${target}`, packageVersion: '8.0.0', bytes: bytes[platform],
})

test('release manifest binds lockstep platform packages to exact binary bytes and formats', () => {
  const manifest = buildReleaseArtifactManifest({
    rootPackage: '@zavora-ai/computer-use-mcp', rootVersion: '8.0.0',
    artifacts: [input('linux-x64', 'linux', 'x64'), input('darwin-arm64', 'darwin', 'arm64'), input('win32-x64', 'win32', 'x64')],
  })
  assert.equal(verifyReleaseArtifactManifest(manifest), true)
  assert.deepEqual(manifest.artifacts.map(item => item.filename), [
    'computer-use-napi.darwin-arm64.node', 'computer-use-napi.linux-x64.node', 'computer-use-napi.win32-x64.node',
  ])
  for (const record of manifest.artifacts) assert.equal(verifyArtifactBytes(record, bytes[record.platform]), true)
  assert.equal(nativeBinaryFormat(bytes.darwin), 'mach-o')
  assert.equal(nativeBinaryFormat(bytes.win32), 'pe')
  assert.equal(nativeBinaryFormat(bytes.linux), 'elf')
  assert.equal(nativeBinaryArchitecture(bytes.darwin), 'arm64')
  assert.equal(nativeBinaryArchitecture(bytes.win32), 'x64')
  assert.equal(nativeBinaryArchitecture(bytes.linux), 'x64')
})

test('release manifest rejects version drift, wrong formats, duplicates, and byte tampering', () => {
  assert.throws(() => buildReleaseArtifactManifest({ rootPackage: 'root', rootVersion: '8.0.0', artifacts: [{ ...input('linux-x64', 'linux', 'x64'), packageVersion: '7.0.0' }] }), /lockstep/)
  assert.throws(() => buildReleaseArtifactManifest({ rootPackage: 'root', rootVersion: '8.0.0', artifacts: [{ ...input('linux-x64', 'linux', 'x64'), bytes: bytes.win32 }] }), /format/)
  assert.throws(() => buildReleaseArtifactManifest({ rootPackage: 'root', rootVersion: '8.0.0', artifacts: [{ ...input('linux-x64', 'linux', 'x64'), arch: 'arm64' }] }), /identity mismatch/)
  const armNamedX64 = { ...input('linux-arm64', 'linux', 'arm64'), bytes: bytes.linux }
  assert.throws(() => buildReleaseArtifactManifest({ rootPackage: 'root', rootVersion: '8.0.0', artifacts: [armNamedX64] }), /machine code/)
  assert.throws(() => buildReleaseArtifactManifest({ rootPackage: 'root', rootVersion: '8.0.0', artifacts: [input('linux-x64', 'linux', 'x64'), input('linux-x64', 'linux', 'x64')] }), /duplicate/)
  const manifest = buildReleaseArtifactManifest({ rootPackage: 'root', rootVersion: '8.0.0', artifacts: [input('linux-x64', 'linux', 'x64')] })
  assert.equal(verifyArtifactBytes(manifest.artifacts[0], Uint8Array.from([...bytes.linux, 9])), false)
  manifest.artifacts[0].sha256 = `sha256:${'0'.repeat(64)}`
  assert.equal(verifyReleaseArtifactManifest(manifest), false)
})

test('release manifest JSON Schema is public and accepts generated manifests', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/v8/release-artifact-manifest.schema.json', import.meta.url), 'utf8'))
  const contractManifest = JSON.parse(await readFile(new URL('../contracts/v8/manifest.json', import.meta.url), 'utf8'))
  assert.ok(contractManifest.fixtures.includes('release-artifact-manifest.schema.json'))
  const value = buildReleaseArtifactManifest({ rootPackage: 'root', rootVersion: '8.0.0', artifacts: [input('darwin-arm64', 'darwin', 'arm64')] })
  assert.equal(new Ajv2020({ strict: false }).compile(schema)(value), true)
})
