import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envPositiveInt } from '../dist/env.js'
import { checkInstall } from '../dist/launch.js'

// ── envPositiveInt: an empty or bad value falls back instead of throwing at import ─────────────

test('envPositiveInt falls back on empty, non-numeric, zero and negative values and warns', () => {
  const warnings = []
  const warn = line => warnings.push(line)
  assert.equal(envPositiveInt('X', 16, { X: '' }, warn), 16)
  assert.equal(envPositiveInt('X', 16, {}, warn), 16)
  assert.equal(warnings.length, 0, 'unset and empty are silent')
  assert.equal(envPositiveInt('X', 16, { X: 'abc' }, warn), 16)
  assert.equal(envPositiveInt('X', 16, { X: '0' }, warn), 16)
  assert.equal(envPositiveInt('X', 16, { X: '-4' }, warn), 16)
  assert.equal(envPositiveInt('X', 16, { X: '1.5' }, warn), 16)
  assert.equal(warnings.length, 4)
  assert.match(warnings[0], /COMPUTER_USE|X=/)
})

test('envPositiveInt accepts a positive integer', () => {
  assert.equal(envPositiveInt('X', 16, { X: '32' }, () => { throw new Error('no warning expected') }), 32)
})

// ── checkInstall: names what is missing and how to fix it ──────────────────────────────────────

test('checkInstall passes on this checkout', () => {
  const result = checkInstall()
  assert.deepEqual(result.problems, [], 'the repo under test is installed and built')
  assert.equal(result.ok, true)
})

test('checkInstall names node_modules, dist and the native addon when they are missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cu-install-'))
  try {
    await writeFile(join(root, 'package.json'), '{"name":"fixture","type":"module"}\n')
    const result = checkInstall(root, 'darwin', 'arm64')
    assert.equal(result.ok, false)
    const text = result.problems.join('\n')
    assert.match(text, /zod/)
    assert.match(text, /npm ci/)
    assert.match(text, /dist\/server\.js is missing/)
    assert.match(text, /native addon for darwin-arm64 is missing/)
    assert.match(text, /npm run build:native/)
    // A present addon clears that problem.
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'dist', 'server.js'), '')
    await writeFile(join(root, 'computer-use-napi.darwin-arm64.node'), '')
    const again = checkInstall(root, 'darwin', 'arm64')
    assert.equal(again.problems.length, 2, 'only the two dependency problems remain')
    assert.ok(again.problems.every(problem => /is not installed/.test(problem)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
