// 7.7.0: each helper instance runs its own signed copy of the compiled helper. While a helper process holds a
// ScreenCaptureKit session, a capture in another process with the same code identity hangs until the first exits
// (measured 2026-10-25), and every server shared one compiled binary.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createMacosHelper, ownHelperCopy } from '../dist/session/macos-helper.js'

function cache() {
  const dir = mkdtempSync(join(tmpdir(), 'cu-helper-identity-'))
  const source = join(dir, 'helper.swift')
  writeFileSync(source, '// fixture')
  const sha = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 8)
  const shared = join(dir, `macos-agent-helper-${sha}`)
  writeFileSync(shared, '#!/bin/sh\necho fixture\n', { mode: 0o755 })
  return { dir, source, shared, sha }
}

const signing = () => {
  const calls = []
  const run = async (file, args) => {
    calls.push([file, ...args])
    return { code: 0, stdout: '', stderr: '' }
  }
  return { calls, run }
}

// The helper is macOS only; Windows has no POSIX mode bits for the executable check.
test('a copy of the helper is signed with an identifier of its own', { skip: process.platform === 'win32' && 'POSIX file modes; the helper is macOS only' }, async () => {
  const c = cache()
  const s = signing()
  const copy = await ownHelperCopy(c.shared, s.run)
  assert.notEqual(copy, c.shared)
  assert.match(basename(copy), new RegExp(`^macos-agent-helper-${c.sha}-p${process.pid}-[0-9a-f]+$`))
  assert.ok(existsSync(copy))
  assert.equal(statSync(copy).mode & 0o111, 0o111, 'executable')
  assert.equal(readFileSync(copy, 'utf8'), readFileSync(c.shared, 'utf8'))
  const codesign = s.calls.find(call => call[0] === 'codesign')
  assert.deepEqual(codesign.slice(1, 5), ['--force', '--sign', '-', '--identifier'])
  assert.match(codesign[5], /^ai\.zavora\.computer-use\.helper\.\d+-[0-9a-f]+$/)
  assert.equal(codesign[6], copy)
  const again = await ownHelperCopy(c.shared, s.run)
  assert.notEqual(again, copy, 'two instances in one process get two identities')
  rmSync(c.dir, { recursive: true, force: true })
})

test('copies left by processes that have exited are removed; a live process keeps its copy', async () => {
  const c = cache()
  const dead = join(c.dir, `macos-agent-helper-${c.sha}-p999999-abcdef`)
  const live = join(c.dir, `macos-agent-helper-${c.sha}-p${process.pid}-012345`)
  writeFileSync(dead, 'x')
  writeFileSync(live, 'x')
  await ownHelperCopy(c.shared, signing().run)
  assert.equal(existsSync(dead), false, 'a dead process leaves nothing behind for long')
  assert.equal(existsSync(live), true)
  assert.equal(existsSync(c.shared), true, 'the shared binary is never touched')
  rmSync(c.dir, { recursive: true, force: true })
})

test('without codesign the shared binary is used and no copy is left', async () => {
  const c = cache()
  const shared = await ownHelperCopy(c.shared, async () => ({ code: 1, stdout: '', stderr: 'codesign: not found' }))
  assert.equal(shared, c.shared)
  assert.deepEqual(readdirSync(c.dir).filter(name => name.includes('-p')), [])
  rmSync(c.dir, { recursive: true, force: true })
})

test('a helper instance runs its own copy, not the shared binary', async () => {
  const c = cache()
  const ran = []
  const run = async (file, args) => {
    if (file === 'codesign' || file === 'xcrun') return { code: 0, stdout: '/usr/bin/swiftc', stderr: '' }
    ran.push(file)
    writeFileSync(args[args.indexOf('--out') + 1], 'IMG')
    return { code: 0, stderr: '', stdout: JSON.stringify({ path: 'x', width: 1, height: 1, hash: 'h', scale: 1, frame: { x: 0, y: 0, width: 1, height: 1 }, mimeType: 'image/jpeg', bytes: 3 }) }
  }
  const helper = createMacosHelper({ sourcePath: c.source, cacheDir: c.dir, platform: 'darwin', darwinRelease: '25.2.0', run, serve: false })
  assert.equal((await helper.ensure()).path, c.shared, 'ensure still reports the compiled binary')
  await helper.capture({ windowId: 1 })
  await helper.capture({ windowId: 2 })
  assert.equal(ran.length, 2)
  assert.notEqual(ran[0], c.shared)
  assert.match(basename(ran[0]), /-p\d+-[0-9a-f]+$/)
  assert.equal(ran[1], ran[0], 'one copy per instance, made once')
  rmSync(c.dir, { recursive: true, force: true })
})
