// Native packaging — universal v7.1 tarball, future split-package manifests,
// and resolver support for a separately installed platform package.

import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { resolveAddonPath } from '../dist/native.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const TARGETS = {
  'darwin-arm64': { os: 'darwin', cpu: 'arm64' },
  'darwin-x64': { os: 'darwin', cpu: 'x64' },
  'win32-x64': { os: 'win32', cpu: 'x64' },
  'win32-arm64': { os: 'win32', cpu: 'arm64' },
  'linux-x64': { os: 'linux', cpu: 'x64' },
  'linux-arm64': { os: 'linux', cpu: 'arm64' },
}

test('each platform package manifest is well-formed and version-locked to the root', () => {
  for (const [target, { os, cpu }] of Object.entries(TARGETS)) {
    const pkgPath = path.join(root, 'packages', `computer-use-mcp-${target}`, 'package.json')
    assert.ok(fs.existsSync(pkgPath), `missing manifest for ${target}`)
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    assert.equal(pkg.name, `@zavora-ai/computer-use-mcp-${target}`)
    assert.equal(pkg.version, rootPkg.version, `${target} version must match root ${rootPkg.version}`)
    assert.deepEqual(pkg.os, [os], `${target} os`)
    assert.deepEqual(pkg.cpu, [cpu], `${target} cpu`)
    assert.ok(pkg.files.includes(`computer-use-napi.${target}.node`), `${target} must ship its binary`)
  }
})

test('staged v7.1 release is universal and does not depend on unbootstrapped package names', () => {
  assert.deepEqual(rootPkg.optionalDependencies ?? {}, {})
  for (const target of Object.keys(TARGETS)) {
    assert.ok(
      rootPkg.files.includes(`computer-use-napi.${target}.node`),
      `universal package must ship the ${target} binary`,
    )
  }
})

test('resolveAddonPath prefers an installed optional platform package over the legacy root binary', () => {
  const target = `${process.platform}-${process.arch}`
  if (!(target in TARGETS)) { return } // unsupported host — skip
  const prevEnv = process.env.COMPUTER_USE_NATIVE_PATH
  delete process.env.COMPUTER_USE_NATIVE_PATH
  const binaryName = `computer-use-napi.${target}.node`
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'computer-use-platform-package-'))
  const binary = path.join(directory, binaryName)
  try {
    fs.writeFileSync(binary, 'dummy-native-binary')
    const resolved = resolveAddonPath({ resolveOptionalPackage: () => binary })
    assert.equal(resolved, binary)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.COMPUTER_USE_NATIVE_PATH
    else process.env.COMPUTER_USE_NATIVE_PATH = prevEnv
  }
})
