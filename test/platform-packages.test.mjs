// Native packages are version-locked optional dependencies; the universal
// tarball and explicit path override remain supported throughout 7.x.

import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { missingAddonFix, resolveAddonPath } from '../dist/native.js'
import { preparePlatformPackages } from '../scripts/prepare-platform-packages.mjs'
import { npmCommand } from '../scripts/npm-command.mjs'

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
    assert.equal(pkg.repository.url, rootPkg.repository.url)
    assert.equal(pkg.repository.directory, `packages/computer-use-mcp-${target}`)
    assert.deepEqual(pkg.publishConfig, { access: 'public' })
    assert.equal(pkg.dependencies, undefined, 'native packages have no runtime dependencies')
  }
})

test('root and lockfile pin all six optional packages, and the main package ships no binary (7.7.0: thin)', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  assert.equal(lock.version, rootPkg.version)
  assert.equal(lock.packages[''].version, rootPkg.version)
  for (const target of Object.keys(TARGETS)) {
    const name = `@zavora-ai/computer-use-mcp-${target}`
    assert.equal(rootPkg.optionalDependencies[name], rootPkg.version)
    assert.equal(lock.packages[''].optionalDependencies[name], rootPkg.version)
    const entry = lock.packages[`node_modules/${name}`]
    assert.equal(entry.version, rootPkg.version)
    assert.equal(entry.optional, true)
    assert.deepEqual(entry.os, [TARGETS[target].os])
    assert.deepEqual(entry.cpu, [TARGETS[target].cpu])
  }
  // The addon comes only from the platform package npm picks by os and cpu, as Claude Code, Codex and esbuild ship.
  assert.deepEqual(rootPkg.files.filter(file => file.endsWith('.node')), [], 'the main package must not ship a native binary')
})

test('a missing addon names the platform package and how to get it', () => {
  const fix = missingAddonFix('linux', 'arm64')
  assert.match(fix, /optional package @zavora-ai\/computer-use-mcp-linux-arm64/)
  assert.match(fix, /--omit=optional/)
  assert.match(fix, /npm run build:native/)
  assert.match(fix, /COMPUTER_USE_NATIVE_PATH/)
})

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'computer-use-package-preparation-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(directory, 'LICENSE'))
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ ...rootPkg, version: '9.0.0-test.1' }))
  fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(directory, 'package-lock.json'))
  for (const target of Object.keys(TARGETS)) {
    const dir = path.join(directory, 'packages', `computer-use-mcp-${target}`)
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(path.join(root, 'packages', `computer-use-mcp-${target}`, 'package.json'), path.join(dir, 'package.json'))
    fs.writeFileSync(path.join(directory, `computer-use-napi.${target}.node`), `new-${target}`)
  }
  return directory
}

test('preparation synchronizes a new version, dependencies and lockfile and copies fresh artifacts', t => {
  const directory = fixture(t)
  preparePlatformPackages(directory, { requireBinaries: true })
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'))
  assert.equal(pkg.optionalDependencies.playwright, rootPkg.optionalDependencies.playwright)
  assert.equal(lock.version, pkg.version)
  for (const target of Object.keys(TARGETS)) {
    const name = `@zavora-ai/computer-use-mcp-${target}`
    const dir = path.join(directory, 'packages', `computer-use-mcp-${target}`)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, pkg.version)
    assert.equal(pkg.optionalDependencies[name], pkg.version)
    assert.equal(lock.packages[`node_modules/${name}`].version, pkg.version)
    assert.ok(lock.packages[`node_modules/${name}`].resolved.endsWith(`-${pkg.version}.tgz`))
    assert.equal(fs.readFileSync(path.join(dir, `computer-use-napi.${target}.node`), 'utf8'), `new-${target}`)
    assert.equal(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'))
  }
})

test('npm version runs the synchronization hook without native builds or registry access', t => {
  const directory = fixture(t)
  fs.mkdirSync(path.join(directory, 'scripts'))
  fs.copyFileSync(path.join(root, 'scripts', 'prepare-platform-packages.mjs'), path.join(directory, 'scripts', 'prepare-platform-packages.mjs'))
  const command = npmCommand(['version', '9.0.0-test.2', '--no-git-tag-version', '--no-audit', '--no-fund'])
  execFileSync(command.command, command.args, { cwd: directory, stdio: 'pipe' })
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const lock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'))
  assert.equal(pkg.version, '9.0.0-test.2')
  assert.equal(lock.version, pkg.version)
  for (const target of Object.keys(TARGETS)) {
    const name = `@zavora-ai/computer-use-mcp-${target}`
    assert.equal(pkg.optionalDependencies[name], pkg.version)
    assert.equal(lock.packages[`node_modules/${name}`].version, pkg.version)
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'packages', `computer-use-mcp-${target}`, 'package.json'), 'utf8')).version, pkg.version)
  }
})

test('strict release preparation refuses a missing artifact even with a stale packaged binary', t => {
  const directory = fixture(t)
  const target = 'linux-arm64'
  fs.rmSync(path.join(directory, `computer-use-napi.${target}.node`))
  fs.writeFileSync(path.join(directory, 'packages', `computer-use-mcp-${target}`, `computer-use-napi.${target}.node`), 'stale')
  const before = fs.readFileSync(path.join(directory, 'package.json'), 'utf8')
  assert.throws(() => preparePlatformPackages(directory, { requireBinaries: true }), /Missing native build artifact/)
  assert.equal(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'), before)
  preparePlatformPackages(directory)
  assert.equal(fs.existsSync(path.join(directory, 'packages', `computer-use-mcp-${target}`, `computer-use-napi.${target}.node`)), false)
})

test('strict release preparation rejects an empty artifact and wrong os/cpu metadata', t => {
  const directory = fixture(t)
  fs.writeFileSync(path.join(directory, 'computer-use-napi.win32-x64.node'), '')
  assert.throws(() => preparePlatformPackages(directory, { requireBinaries: true }), /Missing native build artifact/)
  const manifest = path.join(directory, 'packages', 'computer-use-mcp-darwin-arm64', 'package.json')
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'))
  pkg.cpu = ['x64']
  fs.writeFileSync(manifest, JSON.stringify(pkg))
  assert.throws(() => preparePlatformPackages(directory, { syncOnly: true }), /Invalid platform package manifest/)
})

test('explicit native path still wins over an installed optional package', t => {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'computer-use-package-override-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const binary = path.join(directory, 'override.node')
  fs.writeFileSync(binary, 'override')
  const previous = process.env.COMPUTER_USE_NATIVE_PATH
  process.env.COMPUTER_USE_NATIVE_PATH = binary
  try {
    assert.equal(resolveAddonPath({ resolveOptionalPackage: () => { throw new Error('must not be consulted') } }), binary)
  } finally {
    if (previous === undefined) delete process.env.COMPUTER_USE_NATIVE_PATH
    else process.env.COMPUTER_USE_NATIVE_PATH = previous
  }
})

test('resolveAddonPath prefers an installed optional platform package over a checkout build', () => {
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
