import assert from 'node:assert/strict'
import test from 'node:test'
import { handleWindowTool } from '../dist/session/window-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'

function native(overrides = {}) {
  const calls = []
  const windows = [{
    windowId: 42, bundleId: 'app.fixture', title: 'Fixture', isFocused: true,
    isOnScreen: true, bounds: { x: 10, y: 20, width: 400, height: 300 },
  }]
  return {
    calls,
    getWindow: id => windows.find(window => window.windowId === id) ?? null,
    getCursorWindow: () => windows[0],
    getFrontmostApp: () => ({ bundleId: 'app.fixture', displayName: 'Fixture' }),
    listRunningApps: () => [{ bundleId: 'app.fixture', isHidden: false }],
    listWindows: () => windows,
    activateApp: (...args) => { calls.push(['activateApp', ...args]); return { activated: true } },
    activateWindow: (...args) => { calls.push(['activateWindow', ...args]); return { activated: true, reason: null } },
    hideApp: () => true,
    unhideApp: (...args) => { calls.push(['unhideApp', ...args]); return true },
    getDisplaySize: () => ({ width: 1000, height: 500, scaleFactor: 2 }),
    listDisplays: () => [],
    getUiTree: () => ({ role: 'window' }),
    takeScreenshot: () => ({ base64: 'image', width: 500, height: 250, mimeType: 'image/jpeg' }),
    annotateImage: (...args) => {
      calls.push(['annotateImage', ...args])
      return { base64: 'annotated', width: 500, height: 250, mimeType: 'image/jpeg' }
    },
    ...overrides,
  }
}

function context(service, targets = new TargetStateController(service, () => 1)) {
  return {
    native: service, targets, defaultProvider: 'default',
    sleep: async () => {}, sleepAbortable: async () => false,
    runScript: async () => ({ stdout: 'Resized', stderr: '', code: 0, timedOut: false }),
  }
}

test('extracted window observations do not mutate target provenance', async () => {
  const service = native()
  const targets = new TargetStateController(service, () => 1)
  targets.update({ bundleId: 'app.original' }, 'keyboard')
  const before = targets.current()
  const result = await handleWindowTool('list_windows', {}, context(service, targets))
  assert.equal(result.isError, undefined)
  assert.deepEqual(targets.current(), before)
})

test('extracted window activation performs hidden-app recovery and records exact target', async () => {
  let frontmost = { bundleId: 'app.other' }
  const service = native({
    getFrontmostApp: () => frontmost,
    listRunningApps: () => [{ bundleId: 'app.fixture', isHidden: true }],
    activateApp: (...args) => { service.calls.push(['activateApp', ...args]); frontmost = { bundleId: 'app.fixture' }; return { activated: true } },
  })
  const targets = new TargetStateController(service, () => 2)
  const result = await handleWindowTool('activate_window', { window_id: 42 }, context(service, targets))
  assert.equal(result.isError, undefined)
  assert.deepEqual(service.calls.slice(0, 3), [
    ['unhideApp', 'app.fixture'], ['activateApp', 'app.fixture', 2000], ['activateWindow', 42, undefined],
  ])
  assert.deepEqual(targets.current(), {
    bundleId: 'app.fixture', windowId: 42, establishedBy: 'activation', establishedAt: 2,
  })
})

test('extracted snapshot preserves image blocks and semantic annotations', async () => {
  const service = native()
  const result = await handleWindowTool('snapshot', {
    use_vision: true, use_annotation: true, grid_lines: [2, 2],
  }, context(service))
  assert.ok(result.content.some(block => block.type === 'image' && block.data === 'annotated'))
  assert.ok(result.content.some(block => block.type === 'text' && block.text.includes('UI Tree')))
  assert.ok(result.content.some(block => block.type === 'text' && block.text.includes('Annotations')))
})
