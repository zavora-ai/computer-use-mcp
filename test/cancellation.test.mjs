// PR-14: cancellation — AbortSignal threaded through dispatch → wait / spawnBounded.

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const macOnly = { skip: process.platform !== 'darwin' && 'macOS-only integration test' }
import { createSession } from '../dist/session.js'
import { defaultSpawnBounded, sanitizedChildEnvironment } from '../dist/session/spawn.js'

test('script subprocess environment strips control-plane and implicit secret variables', () => {
  const child = sanitizedChildEnvironment({
    PATH: '/bin', HOME: '/safe', ORDINARY_SETTING: 'visible',
    COMPUTER_USE_SUPERVISOR_TOKEN: 'stop-reset-secret',
    COMPUTER_USE_REMOTE_TLS_KEY: '/private/key',
    COMPUTER_USE_APPROVAL_TOKEN: 'approval-secret',
    OPENAI_API_KEY: 'provider-secret',
    NPM_TOKEN: 'registry-secret',
    SSH_AUTH_SOCK: '/private/agent.sock',
    EXPLICIT_API_KEY: 'allowed-by-host',
    COMPUTER_USE_SCRIPT_ENV_ALLOWLIST: 'EXPLICIT_API_KEY,COMPUTER_USE_SUPERVISOR_TOKEN',
  })
  assert.deepEqual(child, {
    PATH: '/bin', HOME: '/safe', ORDINARY_SETTING: 'visible',
    EXPLICIT_API_KEY: 'allowed-by-host',
  })
  assert.doesNotMatch(JSON.stringify(child), /stop-reset|approval|provider|registry|SUPERVISOR_TOKEN/)
})

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

async function waitFor(read, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    try { value = await read() } catch { value = undefined }
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`)
}

test('aborting a bounded script terminates its descendant process tree on every platform', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-process-tree-'))
  const pidPath = join(directory, 'descendant.pid')
  let descendantPid
  try {
    const controller = new AbortController()
    const parentScript = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      'writeFileSync(process.argv[1], String(child.pid))',
      'setInterval(() => {}, 1000)',
    ].join(';')
    const running = defaultSpawnBounded(process.execPath, ['-e', parentScript, pidPath], 30_000, controller.signal)
    descendantPid = Number.parseInt(await waitFor(
      () => readFile(pidPath, 'utf8'), value => typeof value === 'string' && /^\d+$/.test(value.trim()),
    ), 10)
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0)

    controller.abort('test process-tree cancellation')
    const result = await running
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /aborted/)

    await waitFor(() => {
      try { process.kill(descendantPid, 0); return false }
      catch (error) { return error?.code === 'ESRCH' }
    }, value => value === true)
  } finally {
    if (Number.isInteger(descendantPid) && descendantPid > 0) {
      try { process.kill(descendantPid, 'SIGKILL') } catch { /* already contained */ }
    }
    await rm(directory, { recursive: true, force: true })
  }
})

test('bounded subprocess output remains capped after switching to process groups', async () => {
  const result = await defaultSpawnBounded(process.execPath, [
    '-e', "process.stdout.write(Buffer.alloc(9 * 1024 * 1024, 120)); setInterval(() => {}, 1000)",
  ], 30_000)
  assert.equal(result.code, -1)
  assert.match(result.stderr, /output exceeded 8388608 bytes/)
  assert.ok(Buffer.byteLength(result.stdout) <= 8 * 1024 * 1024)
})
