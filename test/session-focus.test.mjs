import assert from 'node:assert/strict'
import test from 'node:test'
import { createFocusController } from '../dist/session/focus.js'
import { FocusError } from '../dist/session/errors.js'

function native(overrides = {}) {
  const calls = []
  return {
    calls,
    getFrontmostApp: () => ({ bundleId: 'app.front' }),
    listRunningApps: () => [],
    getWindow: () => null,
    prepareDisplay: (...args) => { calls.push(['prepareDisplay', ...args]); return { hiddenBundleIds: ['app.hidden'] } },
    unhideApp: (...args) => calls.push(['unhideApp', ...args]),
    activateApp: (...args) => calls.push(['activateApp', ...args]),
    activateWindow: (...args) => calls.push(['activateWindow', ...args]),
    ...overrides,
  }
}

test('extracted focus controller applies strict defaults and none performs no native work', async () => {
  const service = native()
  const focus = createFocusController({ native: service, sleep: async () => {} })
  assert.equal(focus.strategyFor('type', {}), 'strict')
  assert.equal(focus.strategyFor('left_click', {}), 'best_effort')
  assert.equal(focus.strategyFor('type', { focus_strategy: 'none' }), 'none')
  await focus.ensure({ bundleId: 'app.target' }, 'none')
  assert.deepEqual(service.calls, [])
})

test('extracted prepare-display flow retains only disclosure-safe hidden bundle IDs for its dispatch', async () => {
  const service = native({
    getFrontmostApp: () => ({ bundleId: 'app.target' }),
    listRunningApps: () => [{ bundleId: 'app.target', isHidden: false }],
  })
  const sleeps = []
  const focus = createFocusController({
    native: service,
    env: { COMPUTER_USE_PREPARE_KEEP_VISIBLE: 'host.one, host.two' },
    sleep: async milliseconds => sleeps.push(milliseconds),
  })
  focus.beginDispatch()
  await focus.ensure({ bundleId: 'app.target' }, 'prepare_display')
  assert.deepEqual(service.calls[0], [
    'prepareDisplay', 'app.target', ['host.one', 'host.two'],
  ])
  assert.deepEqual(sleeps, [50])
  assert.deepEqual(focus.hiddenBundleIds(), ['app.hidden'])
  focus.beginDispatch()
  assert.equal(focus.hiddenBundleIds(), undefined)
})

test('extracted strict focus returns structured recovery diagnostics when activation loses', async () => {
  const service = native({
    getFrontmostApp: () => ({ bundleId: 'app.thief' }),
    listRunningApps: () => [{ bundleId: 'app.target', isHidden: true }],
  })
  const focus = createFocusController({ native: service, sleep: async () => {} })
  await assert.rejects(
    focus.ensure({ bundleId: 'app.target' }, 'strict'),
    error => error instanceof FocusError
      && error.details.requestedBundleId === 'app.target'
      && error.details.suggestedRecovery === 'unhide_app',
  )
  assert.deepEqual(service.calls.slice(0, 2), [
    ['unhideApp', 'app.target'], ['activateApp', 'app.target', 2000],
  ])
})
