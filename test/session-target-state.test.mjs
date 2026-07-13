import assert from 'node:assert/strict'
import test from 'node:test'
import { TargetStateController } from '../dist/session/target-state.js'
import { WindowNotFoundError } from '../dist/session/errors.js'

function native() {
  const windows = new Map([
    [42, { windowId: 42, bundleId: 'app.window', isOnScreen: true }],
  ])
  return {
    windows,
    getWindow: id => windows.get(id) ?? null,
    getFrontmostApp: () => ({ bundleId: 'app.front' }),
  }
}

test('extracted target state preserves explicit-window, explicit-app, then session precedence', () => {
  const service = native()
  const targets = new TargetStateController(service, () => 1234)
  targets.update({ bundleId: 'app.session', windowId: 7 }, 'keyboard')
  assert.deepEqual(targets.resolve({ target_app: 'app.explicit' }), { bundleId: 'app.explicit' })
  assert.deepEqual(
    targets.resolve({ target_app: 'app.explicit', target_window_id: 42 }),
    { bundleId: 'app.window', windowId: 42 },
  )
  assert.deepEqual(targets.resolve({}), { bundleId: 'app.session', windowId: 7 })
  assert.throws(() => targets.resolve({ window_id: 999 }), WindowNotFoundError)
})

test('extracted target state clears a stale observation window without losing app provenance', () => {
  const service = native()
  const targets = new TargetStateController(service, () => 1234)
  targets.update({ bundleId: 'app.window', windowId: 42 }, 'pointer')
  assert.equal(targets.observationWindow(), 42)
  service.windows.set(42, { windowId: 42, bundleId: 'app.window', isOnScreen: false })
  assert.equal(targets.observationWindow(), undefined)
  assert.deepEqual(targets.current(), {
    bundleId: 'app.window', windowId: undefined,
    establishedBy: 'pointer', establishedAt: 1234,
  })
})

test('extracted target state attributes implicit clicks to the current foreground app', () => {
  const targets = new TargetStateController(native(), () => 5678)
  targets.trackClick({})
  assert.deepEqual(targets.current(), {
    bundleId: 'app.front', windowId: undefined,
    establishedBy: 'pointer', establishedAt: 5678,
  })
  assert.equal(targets.establishedByForTool('type'), 'keyboard')
  assert.equal(targets.establishedByForTool('activate_window'), 'activation')
})
