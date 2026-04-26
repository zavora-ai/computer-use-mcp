// v5.2 prepareDisplay tests.
//
// Covers:
//   - focus_strategy "prepare_display" calls native.prepareDisplay with
//     target + keep-visible list
//   - response decoration: hiddenBundleIds appears in a trailing content
//     block when prepare_display ran, absent otherwise
//   - resolveKeepVisibleBundles honours env override and terminal bundle

import assert from 'node:assert/strict'
import test from 'node:test'
import * as os from 'node:os'
import * as path from 'node:path'
import { createSession } from '../dist/session.js'

function newLockPath() {
  return path.join(os.tmpdir(), `cu-pd-${process.pid}-${Math.random().toString(36).slice(2)}.lock`)
}

function createMockNative({ prepareResult } = {}) {
  const calls = []
  return {
    calls,
    // Observation surface
    getFrontmostApp: () => ({ bundleId: 'com.apple.TextEdit', displayName: 'TextEdit', pid: 2 }),
    listRunningApps: () => [
      { bundleId: 'com.apple.TextEdit', pid: 2, isHidden: false },
      { bundleId: 'com.apple.Safari', pid: 3, isHidden: false },
    ],
    listWindows: () => [],
    getWindow: () => null,
    // Pump
    drainRunloop: () => {},
    // Mutating
    mouseMove: () => {},
    mouseClick: () => {},
    mouseButton: () => {},
    cursorPosition: () => ({ x: 0, y: 0 }),
    activateApp: (bundleId) => {
      calls.push({ method: 'activateApp', bundleId })
      return { bundleId, activated: true }
    },
    unhideApp: () => true,
    // v5.2
    prepareDisplay: (target, keepVisible) => {
      calls.push({ method: 'prepareDisplay', target, keepVisible })
      return prepareResult ?? {
        targetBundleId: target,
        hiddenBundleIds: ['com.apple.Safari', 'com.apple.mail'],
      }
    },
  }
}

// ── prepare_display routes through native.prepareDisplay ────────────────────

test('Phase 2: focus_strategy=prepare_display calls native.prepareDisplay with terminal in keep list', async () => {
  // Simulate running inside Terminal.app (macOS) or use Windows default
  const originalBundle = process.env.__CFBundleIdentifier
  process.env.__CFBundleIdentifier = 'com.apple.Terminal'
  delete process.env.COMPUTER_USE_PREPARE_KEEP_VISIBLE

  const isWindows = process.platform === 'win32'
  const expectedKeep = isWindows ? ['explorer.exe'] : ['com.apple.Terminal']

  try {
    const mock = createMockNative()
    const s = createSession({ native: mock, lockPath: newLockPath() })
    await s.dispatch('left_click', {
      coordinate: [10, 10],
      target_app: 'com.apple.TextEdit',
      focus_strategy: 'prepare_display',
    })

    const prep = mock.calls.find(c => c.method === 'prepareDisplay')
    assert.ok(prep, 'expected prepareDisplay to be called')
    assert.equal(prep.target, 'com.apple.TextEdit')
    assert.deepEqual(prep.keepVisible, expectedKeep,
      'keep list should include the terminal host by default')
  } finally {
    if (originalBundle === undefined) delete process.env.__CFBundleIdentifier
    else process.env.__CFBundleIdentifier = originalBundle
  }
})

// ── Env override replaces the default keep-list ──────────────────────────────

test('Phase 2: COMPUTER_USE_PREPARE_KEEP_VISIBLE env overrides the default', async () => {
  const savedEnv = process.env.COMPUTER_USE_PREPARE_KEEP_VISIBLE
  process.env.COMPUTER_USE_PREPARE_KEEP_VISIBLE = 'com.slack.Slack, com.apple.Notes'

  try {
    const mock = createMockNative()
    const s = createSession({ native: mock, lockPath: newLockPath() })
    await s.dispatch('left_click', {
      coordinate: [10, 10],
      target_app: 'com.apple.TextEdit',
      focus_strategy: 'prepare_display',
    })
    const prep = mock.calls.find(c => c.method === 'prepareDisplay')
    assert.deepEqual(prep.keepVisible, ['com.slack.Slack', 'com.apple.Notes'])
  } finally {
    if (savedEnv === undefined) delete process.env.COMPUTER_USE_PREPARE_KEEP_VISIBLE
    else process.env.COMPUTER_USE_PREPARE_KEEP_VISIBLE = savedEnv
  }
})

// ── Response decoration ──────────────────────────────────────────────────────

test('Phase 2: dispatch response includes hiddenBundleIds when prepare_display ran', async () => {
  const mock = createMockNative({
    prepareResult: {
      targetBundleId: 'com.apple.TextEdit',
      hiddenBundleIds: ['com.apple.Safari', 'com.apple.mail'],
    },
  })
  const s = createSession({ native: mock, lockPath: newLockPath() })
  const r = await s.dispatch('left_click', {
    coordinate: [10, 10],
    target_app: 'com.apple.TextEdit',
    focus_strategy: 'prepare_display',
  })
  // The last content block should be a JSON blob with hiddenBundleIds.
  const tail = r.content.at(-1)
  assert.equal(tail.type, 'text')
  const parsed = JSON.parse(tail.text)
  assert.deepEqual(parsed.hiddenBundleIds, ['com.apple.Safari', 'com.apple.mail'])
})

// ── No decoration when strategy is NOT prepare_display ──────────────────────

test('Phase 2: dispatch response does NOT include hiddenBundleIds for other strategies', async () => {
  const mock = createMockNative()
  const s = createSession({ native: mock, lockPath: newLockPath() })
  const r = await s.dispatch('left_click', {
    coordinate: [10, 10],
    target_app: 'com.apple.TextEdit',
    focus_strategy: 'best_effort',
  })
  const anyHidden = r.content.some(c =>
    c.type === 'text' && c.text.includes('hiddenBundleIds'))
  assert.equal(anyHidden, false, 'prepare_display was NOT requested, so no decoration')
  assert.equal(mock.calls.some(c => c.method === 'prepareDisplay'), false,
    'native.prepareDisplay must not be called when strategy != prepare_display')
})

// ── prepare_display with no target app skips the call ───────────────────────

test('Phase 2: prepare_display with no target bundleId is a no-op (ensureFocusV4 returns early)', async () => {
  const mock = createMockNative()
  // No target_app, no window_id — ensureFocusV4 should return early without
  // calling prepareDisplay (you can't hide "everything except nothing").
  const s = createSession({ native: mock, lockPath: newLockPath() })
  await s.dispatch('left_click', {
    coordinate: [10, 10],
    focus_strategy: 'prepare_display',
  })
  assert.equal(mock.calls.some(c => c.method === 'prepareDisplay'), false,
    'prepareDisplay must not be called when no target is resolvable')
})
