// v7.6: one capture helper at a time. Two ScreenCaptureKit captures running at once hang each other (measured
// 2026-10-09), so helper runs are serialised within a server and locked across servers, and a helper killed by the
// timeout is reported as such instead of a silent "exit 1".
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMacosHelper, defaultRunner, HelperFailure } from '../dist/session/macos-helper.js'

function fixture({ delayMs = 30 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cu-helper-serial-'))
  const source = join(dir, 'helper.swift')
  writeFileSync(source, '// fixture')
  const sha = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 8)
  const binary = join(dir, `macos-agent-helper-${sha}`)
  writeFileSync(binary, '#!/bin/sh\necho fixture\n')
  let active = 0, maxActive = 0, calls = 0
  const run = async (file, args, options) => {
    if (file === 'xcrun') return { stdout: '/usr/bin/swiftc', stderr: '', code: 0 }
    if (file === 'codesign') return { stdout: '', stderr: '', code: 0 }
    calls += 1; active += 1; maxActive = Math.max(maxActive, active)
    await new Promise(resolve => setTimeout(resolve, delayMs))
    active -= 1
    if (args[0] === 'capture') {
      const out = args[args.indexOf('--out') + 1]
      writeFileSync(out, 'jpegbytes')
      return { stdout: JSON.stringify({ path: out, width: 10, height: 10, hash: 'h', scale: 1, frame: { x: 0, y: 0, width: 10, height: 10 }, mimeType: 'image/jpeg', bytes: 9 }), stderr: '', code: 0 }
    }
    return { stdout: JSON.stringify({ lines: [], width: 10, height: 10, scale: 1, frame: { x: 0, y: 0, width: 10, height: 10 }, ocrMs: 1 }), stderr: '', code: 0 }
  }
  return { dir, source, binary, run, stats: () => ({ maxActive, calls }) }
}

async function helperFor(f, extra = {}) {
  const helper = createMacosHelper({ sourcePath: f.source, cacheDir: f.dir, platform: 'darwin', darwinRelease: '25.2.0', run: f.run, ...extra })
  const availability = await helper.ensure()
  assert.equal(availability.ok, true, JSON.stringify(availability))
  return helper
}

test('two concurrent captures in one server run one at a time and both succeed', async () => {
  const f = fixture()
  const helper = await helperFor(f)
  const [a, b] = await Promise.all([
    helper.capture({ windowId: 1, width: 100 }),
    helper.capture({ windowId: 2, width: 100 }),
  ])
  assert.equal(a.hash, 'h'); assert.equal(b.hash, 'h')
  assert.equal(f.stats().calls, 2)
  assert.equal(f.stats().maxActive, 1, 'helper runs never overlap')
  assert.equal(existsSync(join(f.dir, 'helper.lock')), false, 'the lock is released')
  rmSync(f.dir, { recursive: true, force: true })
})

test('the cross-process lock waits for a live holder and takes over a dead one', async () => {
  const f = fixture()
  const helper = await helperFor(f, { lockWaitMs: 300 })
  const lock = join(f.dir, 'helper.lock')
  // a dead holder: a pid that cannot exist
  writeFileSync(lock, '999999')
  const result = await helper.ocr({ windowId: 1 })
  assert.ok(Array.isArray(result.lines), 'the stale lock was taken over')
  // a live holder (this process) that never releases: the call gives up with helper_busy after lockWaitMs
  writeFileSync(lock, String(process.pid))
  const started = Date.now()
  await assert.rejects(helper.ocr({ windowId: 1 }), error => error instanceof HelperFailure && error.code === 'helper_busy' && /two ScreenCaptureKit captures at once/.test(error.message))
  assert.ok(Date.now() - started >= 250, 'it waited for the holder before giving up')
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid), 'another process\'s lock is left alone')
  rmSync(f.dir, { recursive: true, force: true })
})

test('a helper killed by the timeout is reported as helper_timeout, not a silent exit 1', async () => {
  const result = await defaultRunner('/bin/sleep', ['5'], { timeout: 100 })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /timed out after 100 ms and was killed \(SIGTERM\)/)
  const f = fixture()
  const helper = await helperFor(f, { run: async (file, args, options) => file === 'xcrun' ? { stdout: '/usr/bin/swiftc', stderr: '', code: 0 } : file === 'codesign' ? { stdout: '', stderr: '', code: 0 } : { stdout: '', stderr: 'helper timed out after 30000 ms and was killed (SIGTERM)', code: 1 } })
  await assert.rejects(helper.ocr({ windowId: 1 }), error => error instanceof HelperFailure && error.code === 'helper_timeout' && /timed out/.test(error.message))
  rmSync(f.dir, { recursive: true, force: true })
})
