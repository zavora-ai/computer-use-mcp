import assert from 'node:assert/strict'
import test from 'node:test'
import { handleAccessibilityTool } from '../dist/session/accessibility-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'

function native(overrides = {}) {
  const calls = []
  return {
    calls,
    getWindow: id => id === 42 ? { windowId: 42, bundleId: 'app.fixture', isOnScreen: true } : null,
    getFrontmostApp: () => ({ bundleId: 'app.fixture' }),
    getUiTree: (...args) => ({ args }),
    getFocusedElement: () => null,
    findElement: () => [],
    performAction: () => ({ performed: true }),
    setElementValue: () => ({ set: true }),
    mouseMove: (...args) => calls.push(['mouseMove', ...args]),
    mouseClick: (...args) => calls.push(['mouseClick', ...args]),
    pressMenuItem: () => ({ pressed: true }),
    getMenuBar: () => [],
    listRunningApps: () => [],
    listWindows: () => [],
    ...overrides,
  }
}

function context(service, overrides = {}) {
  return {
    native: service,
    targets: new TargetStateController(service, () => 1),
    focus: { strategyFor: () => 'strict', ensure: async () => ({}), beginDispatch() {}, hiddenBundleIds() {} },
    activeProfile: 'full', sleep: async () => {},
    runScript: async () => ({ stdout: 'output\n', stderr: '', code: 0, timedOut: false }),
    getAppDictionary: async bundleId => ({ dict: { bundleId, suites: [] } }),
    ...overrides,
  }
}

test('extracted accessibility observations leave target provenance unchanged', async () => {
  const service = native()
  const ctx = context(service)
  ctx.targets.update({ bundleId: 'app.original' }, 'keyboard')
  const before = ctx.targets.current()
  const result = await handleAccessibilityTool('get_ui_tree', { window_id: 42 }, ctx)
  assert.equal(result.isError, undefined)
  assert.deepEqual(ctx.targets.current(), before)
})

test('extracted accessibility click uses bounded coordinate fallback and records provenance', async () => {
  const service = native({
    performAction: () => ({
      performed: false, reason: 'unsupported_action',
      bounds: { x: 10, y: 20, width: 30, height: 40 },
    }),
  })
  const ctx = context(service)
  const result = await handleAccessibilityTool('click_element', {
    window_id: 42, role: 'AXButton', label: 'Submit',
  }, ctx)
  assert.equal(result.isError, undefined)
  assert.deepEqual(service.calls, [['mouseMove', 25, 40], ['mouseClick', 25, 40, 'left', 1]])
  assert.equal(ctx.targets.current().establishedBy, 'pointer')
})

test('extracted accessibility miss returns ranked label recovery candidates', async () => {
  const service = native({
    performAction: () => ({ performed: false, reason: 'not_found' }),
    findElement: () => [
      { role: 'AXButton', label: 'Cancel', value: null },
      { role: 'AXButton', label: 'Submit', value: null },
    ],
  })
  const result = await handleAccessibilityTool('click_element', {
    window_id: 42, role: 'AXButton', label: 'Sumbit',
  }, context(service))
  assert.equal(result.isError, true)
  assert.equal(JSON.parse(result.content[0].text).similar[0].label, 'Submit')
})

test('extracted scripting handler preserves output and cancellation signal', async () => {
  const service = native()
  const controller = new AbortController()
  let observedSignal
  const result = await handleAccessibilityTool('run_script', {
    language: 'applescript', script: 'return 1',
  }, context(service, {
    signal: controller.signal,
    runScript: async (_language, _script, _timeout, signal) => {
      observedSignal = signal
      return { stdout: 'one\n', stderr: '', code: 0, timedOut: false }
    },
  }))
  assert.equal(result.content[0].text, 'one')
  assert.equal(observedSignal, controller.signal)
})
