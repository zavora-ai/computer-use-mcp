// PR-14: cancellation — AbortSignal threaded through dispatch → wait / spawnBounded.

import assert from 'node:assert/strict'
import test from 'node:test'
const macOnly = { skip: process.platform !== 'darwin' && 'macOS-only integration test' }
import { createSession } from '../dist/session.js'

test('wait returns early when the signal aborts mid-flight', async () => {
  const session = createSession({ disableSessionLock: true })
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 50)
  const start = Date.now()
  const r = await session.dispatch('wait', { duration: 30 }, ctrl.signal)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 3000, `aborted wait should return fast, took ${elapsed}ms`)
  assert.ok(!r.isError)
  assert.match(r.content.find(c => c.type === 'text').text, /cancel/i)
})

test('wait with an already-aborted signal returns immediately', async () => {
  const session = createSession({ disableSessionLock: true })
  const ctrl = new AbortController()
  ctrl.abort()
  const start = Date.now()
  const r = await session.dispatch('wait', { duration: 30 }, ctrl.signal)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 500, `pre-aborted wait should return immediately, took ${elapsed}ms`)
  assert.match(r.content.find(c => c.type === 'text').text, /cancel/i)
})

test('wait without a signal still waits the full (short) duration', async () => {
  const session = createSession({ disableSessionLock: true })
  const start = Date.now()
  const r = await session.dispatch('wait', { duration: 0.2 })
  const elapsed = Date.now() - start
  assert.ok(elapsed >= 150, `unaborted wait should elapse, took ${elapsed}ms`)
  assert.match(r.content.find(c => c.type === 'text').text, /Waited/)
})

test('run_script threads the abort signal into spawnBounded', macOnly, async () => {
  let capturedSignal = 'not-called'
  const spawnBounded = (_cmd, _args, _timeoutMs, signal) => {
    capturedSignal = signal
    return Promise.resolve({ stdout: 'ok', stderr: '', code: 0, timedOut: false })
  }
  const session = createSession({ disableSessionLock: true, spawnBounded })
  const ctrl = new AbortController()
  const r = await session.dispatch('run_script', { language: 'applescript', script: 'return 1' }, ctrl.signal)
  assert.ok(!r.isError, 'mock script should succeed')
  assert.equal(capturedSignal, ctrl.signal, 'the same AbortSignal must reach spawnBounded')
})

test('run_script without a signal passes undefined to spawnBounded (back-compat)', macOnly, async () => {
  let sawArgCount = -1
  const spawnBounded = (...a) => {
    sawArgCount = a.length >= 4 ? (a[3] === undefined ? 3 : 4) : a.length
    return Promise.resolve({ stdout: 'ok', stderr: '', code: 0, timedOut: false })
  }
  const session = createSession({ disableSessionLock: true, spawnBounded })
  const r = await session.dispatch('run_script', { language: 'applescript', script: 'return 1' })
  assert.ok(!r.isError)
  assert.equal(sawArgCount, 3, 'no signal → spawnBounded receives undefined as 4th arg')
})

// Real-process abort uses the default spawnBounded (SIGKILL on abort).
// Guarded to macOS where `osascript delay` is the default run_script path.
test('run_script real process is killed on abort (darwin)', { skip: process.platform !== 'darwin' }, async () => {
  const session = createSession({ disableSessionLock: true })
  const ctrl = new AbortController()
  setTimeout(() => ctrl.abort(), 200)
  const start = Date.now()
  const r = await session.dispatch('run_script', { language: 'applescript', script: 'delay 30' }, ctrl.signal)
  const elapsed = Date.now() - start
  assert.ok(elapsed < 6000, `aborted long script should be killed fast, took ${elapsed}ms`)
  assert.ok(r.isError, 'a killed script is reported as an error, not success')
})
