// v5.2 lock + pump tests.
//
// Cross-process session-lock semantics (O_EXCL) are the tricky bit — these
// tests use a tmp lockPath so they don't touch the real /tmp/.computer-use-mcp.lock
// that a real running server might be holding.

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createSession } from '../dist/session.js'

// Minimal mock native — we only need drainRunloop counter + enough shape to
// dispatch a mutating + observation tool.
function createMockNative({ mouseClickDelayMs = 0 } = {}) {
  const state = { drainCount: 0 }
  const mock = {
    _drainCount: () => state.drainCount,
    drainRunloop: () => { state.drainCount++ },
    // Observation surface
    getFrontmostApp: () => ({ bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1 }),
    listRunningApps: () => [{ bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1, isHidden: false }],
    listWindows: () => [],
    getWindow: () => null,
    getDisplaySize: () => ({ width: 2560, height: 1440, scaleFactor: 2, pixelWidth: 5120, pixelHeight: 2880 }),
    // Mutation surface — we use mouseClick for timing-sensitive tests because
    // it's routed through session.ts dispatch and the session layer awaits it
    // indirectly via trackClickTarget sleeps.
    mouseMove: () => {},
    mouseClick: async () => {
      if (mouseClickDelayMs > 0) await new Promise(r => setTimeout(r, mouseClickDelayMs))
    },
    mouseButton: () => {},
    cursorPosition: () => ({ x: 100, y: 100 }),
  }
  return mock
}

function newLockPath() {
  return path.join(os.tmpdir(), `cu-mcp-lock-test-${process.pid}-${Math.random().toString(36).slice(2)}.lock`)
}

// Convenience — when a test opts into the real session lock, it must pass
// `disableSessionLock: false` explicitly (the default when a mock native is
// injected is `true`, to keep property-based tests out of the filesystem).
const LOCK_ON = { disableSessionLock: false }

// ── Fresh-path lock lifecycle ────────────────────────────────────────────────

test('Phase 1: mutating tool acquires + releases the lock, observation tool does not', async () => {
  const lockPath = newLockPath()
  const s = createSession({ native: createMockNative(), lockPath, ...LOCK_ON })

  // Observation tool — lockfile must not appear.
  await s.dispatch('get_frontmost_app', {})
  assert.equal(fs.existsSync(lockPath), false, 'observation must not touch lockfile')

  // Mutating tool — lock acquired then released.
  await s.dispatch('left_click', { coordinate: [10, 10], focus_strategy: 'none' })
  assert.equal(fs.existsSync(lockPath), false, 'lockfile must be gone after mutating tool completes')
})

// ── Lockfile holder PID is the current process (observed mid-flight) ────────

test('Phase 1: lockfile holder PID is this process', async () => {
  const lockPath = newLockPath()
  // Use a slow mouseClick mock so we can read the lockfile while it's held.
  const mock = createMockNative({ mouseClickDelayMs: 40 })
  const s = createSession({ native: mock, lockPath, ...LOCK_ON })

  // Fire the mutating call without awaiting — read the lockfile while it's held.
  const p = s.dispatch('left_click', { coordinate: [10, 10], focus_strategy: 'none' })
  // Poll briefly for the file to appear.
  let holder = null
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(lockPath)) {
      holder = fs.readFileSync(lockPath, 'utf8').trim()
      break
    }
    await new Promise(r => setTimeout(r, 2))
  }
  await p
  assert.equal(holder, String(process.pid), `expected lockfile to contain our PID ${process.pid}, got ${holder}`)
})

// ── Stale PID recovery ──────────────────────────────────────────────────────

test('Phase 1: lock with dead-PID holder is reclaimed', async () => {
  const lockPath = newLockPath()
  // Seed a lockfile with an impossibly-high PID that can't be alive.
  fs.writeFileSync(lockPath, '999999', { mode: 0o600 })
  assert.equal(fs.existsSync(lockPath), true)

  const s = createSession({ native: createMockNative(), lockPath, ...LOCK_ON })
  await s.dispatch('left_click', { coordinate: [1, 1], focus_strategy: 'none' })
  // Our session released at end of dispatch.
  assert.equal(fs.existsSync(lockPath), false, 'stale lock should have been reclaimed + released')
})

// ── Live-PID contention ─────────────────────────────────────────────────────

test('Phase 1: mutating tool returns structured locked_by_pid when another live PID holds the lock', async () => {
  const lockPath = newLockPath()
  // Spawn a truly-detached background process that we can signal later.
  // `nohup sleep 30 > /dev/null 2>&1 &` detaches under sh job control.
  // We capture the new child's PID from $!.
  const out = execFileSync('bash', ['-c', 'nohup sleep 30 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' }).trim()
  const foreignPid = parseInt(out, 10)
  assert.ok(Number.isFinite(foreignPid) && foreignPid > 0 && foreignPid !== process.pid,
    `spawned sleeper pid must be real and different from us (got ${foreignPid}, self=${process.pid})`)

  try {
    // Wait briefly for the child to be live.
    await new Promise(r => setTimeout(r, 50))
    fs.writeFileSync(lockPath, String(foreignPid), { mode: 0o600 })

    const s = createSession({ native: createMockNative(), lockPath, ...LOCK_ON })
    const r = await s.dispatch('left_click', { coordinate: [1, 1], focus_strategy: 'none' })
    assert.equal(r.isError, true, 'expected isError when lock is held')
    const body = JSON.parse(r.content[0].text)
    assert.equal(body.error, 'locked_by_pid')
    assert.equal(body.lockingPid, foreignPid)
  } finally {
    try { process.kill(foreignPid, 'SIGKILL') } catch { /* ok */ }
    try { fs.unlinkSync(lockPath) } catch { /* ok */ }
  }
})

// ── Pump drains the runloop while a mutating call is in flight ──────────────

test('Phase 1: pump fires drainRunloop while a mutating tool runs', async () => {
  const lockPath = newLockPath()
  // 30ms delay in mouseClick gives the 1ms pump plenty of ticks.
  const mock = createMockNative({ mouseClickDelayMs: 30 })
  const s = createSession({ native: mock, lockPath, ...LOCK_ON })

  assert.equal(mock._drainCount(), 0)
  await s.dispatch('left_click', { coordinate: [10, 10], focus_strategy: 'none' })

  assert.ok(mock._drainCount() >= 5,
    `pump should have fired many times during a 30ms mutation (got ${mock._drainCount()})`)
})

// ── Observation tools do not pump either ────────────────────────────────────

test('Phase 1: pump does NOT fire for observation tools', async () => {
  const lockPath = newLockPath()
  const mock = createMockNative()
  const s = createSession({ native: mock, lockPath, ...LOCK_ON })

  await s.dispatch('get_frontmost_app', {})
  assert.equal(mock._drainCount(), 0, 'observation tool must not start the pump')
})

// ── disableSessionLock bypass (for in-process multi-session tests) ──────────

test('Phase 1: disableSessionLock lets two in-process sessions coexist', async () => {
  const lockPath = newLockPath()
  const a = createSession({ native: createMockNative(), lockPath, disableSessionLock: true })
  const b = createSession({ native: createMockNative(), lockPath, disableSessionLock: true })
  // Running both in parallel must not throw.
  await Promise.all([
    a.dispatch('write_clipboard', { text: 'a' }),
    b.dispatch('write_clipboard', { text: 'b' }),
  ])
  assert.equal(fs.existsSync(lockPath), false, 'disableSessionLock must not create a lockfile')
})
