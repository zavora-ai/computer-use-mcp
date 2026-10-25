import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { TARGETS } from '../scripts/prepare-platform-packages.mjs'
import { stagePlatformPackages } from '../scripts/stage-platform-packages.mjs'

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'computer-use-native-staging-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const version = '9.0.0-test.1'
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version }))
  const destination = path.join(directory, 'release', 'platform')
  fs.mkdirSync(destination, { recursive: true })
  const packages = TARGETS.map(target => {
    const content = Buffer.from(target)
    const filename = `zavora-ai-computer-use-mcp-${target}-${version}.tgz`
    fs.writeFileSync(path.join(destination, filename), content)
    return { target, version, filename, name: `@zavora-ai/computer-use-mcp-${target}`,
      integrity: 'sha512-' + createHash('sha512').update(content).digest('base64') }
  })
  fs.writeFileSync(path.join(destination, 'packages.json'), JSON.stringify(packages))
  return { directory, destination, packages }
}
// npm's E404 for a version that a package does not have; a name npm has never seen answers "Not Found" instead.
const error = (code, summary = code === 'E404' ? 'No match found for version 9.0.0-test.1' : code) =>
  ({ status: 1, stdout: JSON.stringify({ error: { code, summary } }), stderr: '' })
// The main package's own version check (7.6.2) comes first; these fixtures stage an unreleased version.
const isMainView = args => args[0] === 'view' && args[1].startsWith('@zavora-ai/computer-use-mcp@')

test('all six native packages are preflighted and staged with provenance from exact tarballs', t => {
  const { directory, packages } = fixture(t)
  const calls = []
  stagePlatformPackages(directory, args => {
    calls.push(args)
    return args[0] === 'view' ? error('E404') : { status: 0, stdout: '{}', stderr: '' }
  })
  assert.equal(calls.length, 13)
  assert.ok(isMainView(calls[0]), 'the main version is checked first')
  assert.ok(calls.slice(1, 7).every(args => args[0] === 'view'))
  for (const [index, args] of calls.slice(7).entries()) {
    assert.equal(args[0], 'stage')
    assert.equal(args[1], 'publish')
    assert.equal(args[2], path.join(directory, 'release', 'platform', packages[index].filename))
    assert.ok(args.includes('--provenance'))
    assert.ok(args.includes('--ignore-scripts'))
  }
})

test('published native versions skip only when the packed integrity matches', t => {
  const { directory, packages } = fixture(t)
  let index = 0
  stagePlatformPackages(directory, args => {
    assert.equal(args[0], 'view')
    if (isMainView(args)) return error('E404')
    return { status: 0, stdout: JSON.stringify(packages[index++].integrity), stderr: '' }
  })
  assert.equal(index, 6)
})

test('a published native that differs from this build is skipped with a warning; the others still stage', t => {
  const { directory, packages } = fixture(t)
  let index = 0
  const staged = []
  stagePlatformPackages(directory, args => {
    if (isMainView(args)) return error('E404')
    if (args[0] === 'view') return index++ === 2 ? { status: 0, stdout: JSON.stringify('sha512-different'), stderr: '' } : error('E404')
    staged.push(args[2])
    return { status: 0, stdout: '{}', stderr: '' }
  })
  assert.deepEqual(staged, packages.filter((_, i) => i !== 2).map(pkg => path.join(directory, 'release', 'platform', pkg.filename)))
})

test('a registry authentication failure on a native check prevents any staging', t => {
  const { directory } = fixture(t)
  let index = 0
  assert.throws(() => stagePlatformPackages(directory, args => {
    assert.equal(args[0], 'view', 'no writes before the complete preflight succeeds')
    if (isMainView(args)) return error('E404')
    return index++ === 2 ? error('E401') : error('E404')
  }), /Cannot check/)
})

test('nothing is staged or checked when the main version is already published', t => {
  const { directory } = fixture(t)
  const calls = []
  stagePlatformPackages(directory, args => {
    calls.push(args)
    return isMainView(args) ? { status: 0, stdout: JSON.stringify('9.0.0-test.1'), stderr: '' } : error('E500')
  })
  assert.deepEqual(calls, [['view', '@zavora-ai/computer-use-mcp@9.0.0-test.1', 'version', '--json']])
})

test('a registry failure on the main version check stops staging', t => {
  const { directory } = fixture(t)
  assert.throws(() => stagePlatformPackages(directory, args => {
    assert.ok(isMainView(args), 'no native package is checked or staged')
    return error('E401')
  }), /Cannot check @zavora-ai\/computer-use-mcp@9\.0\.0-test\.1/)
})

test('local corruption, duplicate targets and version skew prevent staging', t => {
  const { directory, destination, packages } = fixture(t)
  fs.writeFileSync(path.join(destination, packages[0].filename), 'corrupted')
  assert.throws(() => stagePlatformPackages(directory, () => { throw new Error('registry must not be consulted') }), /Tarball integrity mismatch/)
  const metadata = path.join(destination, 'packages.json')
  fs.writeFileSync(metadata, JSON.stringify([...packages.slice(0, 5), packages[0]]))
  assert.throws(() => stagePlatformPackages(directory), /six distinct/)
  fs.writeFileSync(metadata, JSON.stringify(packages.map(pkg => ({ ...pkg, version: 'wrong' }))))
  assert.throws(() => stagePlatformPackages(directory), /Invalid native release metadata/)
})

test('a version already staged and awaiting approval is tolerated; the remaining natives still stage', t => {
  const { directory, packages } = fixture(t)
  for (const summary of ['Cannot stage previously published version', 'already staged']) {
    const staged = []
    stagePlatformPackages(directory, args => {
      if (args[0] === 'view') return error('E404')
      staged.push(args[2])
      return staged.length === 1 ? error('E409', summary) : { status: 0, stdout: '{}', stderr: '' }
    })
    assert.deepEqual(staged, packages.map(pkg => path.join(directory, 'release', 'platform', pkg.filename)))
  }
})

test('any other staging conflict stops the remaining native publishes with the release evidence', t => {
  const { directory, packages } = fixture(t)
  for (const conflictAt of [0, 2]) {
    const staged = []
    assert.throws(() => stagePlatformPackages(directory, args => {
      if (args[0] === 'view') return error('E404')
      staged.push(args[2])
      return staged.length === conflictAt + 1 ? error('E409', 'other conflict') : { status: 0, stdout: '{}', stderr: '' }
    }), thrown => {
      assert.match(thrown.message, /Cannot stage .*E409/)
      assert.ok(thrown.message.includes(`${packages[conflictAt].name}@${packages[conflictAt].version}`))
      assert.ok(thrown.message.includes(packages[conflictAt].filename))
      assert.ok(thrown.message.includes(packages[conflictAt].integrity))
      assert.match(thrown.message, /Commit: .*\nArtifact: .*\nIntegrity: /)
      return true
    })
    assert.deepEqual(staged, packages.slice(0, conflictAt + 1).map(pkg => path.join(directory, 'release', 'platform', pkg.filename)))
  }
})

test('a staging failure exits nonzero with the commit and artifact context', t => {
  const { directory, packages } = fixture(t)
  const commit = 'a'.repeat(40)
  const script = `
    import { stagePlatformPackages } from ${JSON.stringify(new URL('../scripts/stage-platform-packages.mjs', import.meta.url).href)};
    stagePlatformPackages(${JSON.stringify(directory)}, args => ({
      status: 1, stderr: '', stdout: JSON.stringify({error: {code: args[0] === 'view' ? 'E404' : 'E409', summary: 'other conflict'}}),
    }));
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    // A token, so the new names (an E404 that is not "No match found for version") reach staging.
    encoding: 'utf8', env: { ...process.env, GITHUB_SHA: commit, NODE_AUTH_TOKEN: 'stage-only' },
  })
  assert.equal(result.error, undefined)
  assert.notEqual(result.status, 0)
  assert.ok(result.stderr.includes(`Commit: ${commit}`))
  assert.ok(result.stderr.includes(`${packages[0].name}@${packages[0].version}`))
  assert.ok(result.stderr.includes(packages[0].filename))
  assert.ok(result.stderr.includes(packages[0].integrity))
})

test('other staging failures also propagate', t => {
  const { directory } = fixture(t)
  assert.throws(() => stagePlatformPackages(directory, args => args[0] === 'view' ? error('E404') : error('E403', 'publish denied')), /Cannot stage/)
})

test('a new package name without the bootstrap token stops before anything is staged, naming the secret', t => {
  const { directory } = fixture(t)
  const staged = []
  const npm = args => {
    if (args[0] === 'stage') { staged.push(args); return { status: 0, stdout: '{}', stderr: '' } }
    return isMainView(args) ? error('E404') : error('E404', 'Not Found - GET https://registry.npmjs.org/@zavora-ai%2fcomputer-use-mcp-x - Not found')
  }
  assert.throws(() => stagePlatformPackages(directory, npm, {}), /new package names.*NPM_NATIVE_STAGE_TOKEN.*Nothing was staged/s)
  assert.equal(staged.length, 0)
  stagePlatformPackages(directory, npm, { NODE_AUTH_TOKEN: 'stage-only' })
  assert.equal(staged.length, 6, 'with the token, all six new names are staged')
})
