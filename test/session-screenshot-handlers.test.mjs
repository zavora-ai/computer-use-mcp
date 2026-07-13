import assert from 'node:assert/strict'
import test from 'node:test'
import { ScreenshotHandler } from '../dist/session/screenshot-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'
import { VirtualPointerController } from '../dist/session/virtual-pointer.js'

function fixture(overrides = {}) {
  const calls = []
  const windows = new Map([[42, { windowId: 42, bundleId: 'app.target', isOnScreen: true }]])
  const native = {
    calls,
    windows,
    getWindow: id => windows.get(id) ?? null,
    getFrontmostApp: () => ({ bundleId: 'app.front', displayName: 'Front' }),
    getDisplaySize: () => ({ width: 1200, height: 800 }),
    takeScreenshot: (...args) => {
      calls.push(['screenshot', ...args])
      return { base64: 'raw', width: 800, height: 600, mimeType: 'image/png', hash: 'h1' }
    },
    cropImage: (...args) => {
      calls.push(['crop', ...args])
      return { base64: 'crop', width: 20, height: 30, mimeType: 'image/png' }
    },
    annotateImage: (...args) => {
      calls.push(['annotate', ...args])
      return { base64: 'marked', width: 800, height: 600, mimeType: 'image/png' }
    },
    agentPointerOverlayStatus: () => ({ visible: false }),
    ...overrides,
  }
  const targets = new TargetStateController(native, () => 10)
  const pointer = new VirtualPointerController(native, () => 20)
  const handler = new ScreenshotHandler({
    native, targets, pointer, visionEnabled: true, defaultProvider: 'auto',
    env: {}, now: () => 30,
  })
  return { native, targets, pointer, handler }
}

test('extracted screenshot handler deduplicates captures and exposes an immutable cache record', () => {
  let captures = 0
  const f = fixture({
    takeScreenshot: (...args) => {
      f.native.calls.push(['screenshot', ...args])
      captures++
      return captures === 1
        ? { base64: 'raw', width: 800, height: 600, mimeType: 'image/png', hash: 'h1' }
        : { base64: '', width: 800, height: 600, mimeType: 'image/png', hash: 'h1', unchanged: true }
    },
  })
  const first = f.handler.handle('screenshot', {})
  const second = f.handler.handle('screenshot', {})
  assert.strictEqual(second, first)
  assert.equal(f.native.calls[1][4], 'h1')
  assert.deepEqual(f.handler.lastScreenshot(), {
    mimeType: 'image/png', data: 'raw', capturedAt: 30,
  })
  const copy = f.handler.lastScreenshot()
  copy.data = 'changed'
  assert.equal(f.handler.lastScreenshot().data, 'raw')
})

test('explicit screenshot window wins over app and a stale inferred window is cleared', () => {
  const f = fixture()
  f.targets.update({ bundleId: 'app.target', windowId: 42 }, 'activation')
  f.handler.handle('screenshot', { target_window_id: 42, target_app: 'ignored.app' })
  assert.equal(f.native.calls[0][2], undefined)
  assert.equal(f.native.calls[0][5], 42)

  f.native.windows.set(42, { windowId: 42, bundleId: 'app.target', isOnScreen: false })
  f.handler.handle('screenshot', { show_agent_pointer: true })
  const secondCapture = f.native.calls.find((c, i) => i > 0 && c[0] === 'screenshot')
  assert.equal(secondCapture[5], undefined)
  assert.equal(f.targets.current().windowId, undefined)
})

test('agent pointer projection annotates the image without moving the OS cursor', () => {
  const f = fixture()
  f.pointer.move(300, 200)
  const result = f.handler.handle('screenshot', { show_agent_pointer: true })
  assert.equal(result.content[0].data, 'marked')
  assert.equal(f.handler.lastHash(), 'h1:agent-pointer:300,200')
  assert.equal(f.native.calls.some(call => call[0] === 'annotate'), true)
})

test('zoom validates bounds and crops a lossless full-resolution capture', () => {
  const f = fixture()
  assert.throws(() => f.handler.handle('zoom', { region: [3, 0, 2, 1] }), /Invalid region/)
  const result = f.handler.handle('zoom', { region: [1, 2, 21, 32] })
  assert.equal(result.content[1].text, '20x30 (zoomed from 800x600)')
  assert.deepEqual(f.native.calls.at(-1), ['crop', 'raw', 1, 2, 21, 32, 0])
})
