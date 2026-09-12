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

test('a screen capture reports an exact mapping from image pixels to click coordinates', () => {
  // Reporting only WxH left every agent to infer this, and they infer it wrong: one
  // clicked a form three times with a y scale it had guessed, missing by 30, 57 and
  // 87 pixels. A screen capture scales uniformly with no offset, so it can be stated.
  const f = fixture()
  const text = f.handler.handle('screenshot', {}).content.find(c => c.type === 'text').text
  assert.match(text, /^800x600 \| screen 1200x800$/m)
  // 1200 display / 800 image = 1.5
  assert.match(text, /screen_x = image_x \* 1\.5000/)
  assert.match(text, /screen_y = image_y \* 1\.5000/)
  assert.match(text, /exact/)
})

test('a window capture reports the window origin and says the mapping is approximate', () => {
  // A window capture includes the window's shadow, so its scale cannot be exact.
  // Saying so is the difference between an agent verifying and an agent trusting.
  const windows = new Map([[42, {
    windowId: 42, bundleId: 'app.target', isOnScreen: true,
    bounds: { x: 100, y: 50, width: 1000, height: 700 },
  }]])
  const f = fixture({
    getWindow: id => windows.get(id) ?? null,
    // 800x600 is aspect 1.333, distinct from the 1.5 display, so it is a window shot.
    takeScreenshot: () => ({ base64: 'raw', width: 800, height: 600, mimeType: 'image/png', hash: 'w' }),
  })
  const text = f.handler.handle('screenshot', { target_window_id: 42 }).content
    .find(c => c.type === 'text').text
  assert.match(text, /window 42 at 100,50 sized 1000x700/)
  assert.match(text, /screen_x ≈ 100 \+ image_x \* 1\.2500/)
  assert.match(text, /screen_y ≈ 50 \+ image_y \* 1\.2500/)
  assert.match(text, /approximate/)
  assert.match(text, /screen capture/, 'should point at the exact alternative')
})

test('a window that could not be captured says so instead of pretending', () => {
  // The failure that actually misled an agent: a window capture silently returning
  // the whole screen. Its mapping is then valid but its frame of reference is not
  // the one the agent believes, so every coordinate it derives is wrong.
  const windows = new Map([[42, {
    windowId: 42, bundleId: 'app.target', isOnScreen: true,
    bounds: { x: 100, y: 50, width: 1000, height: 700 },
  }]])
  const f = fixture({
    getWindow: id => windows.get(id) ?? null,
    // Aspect 1.5 matches the display, so this is the screen, not the window.
    takeScreenshot: () => ({ base64: 'raw', width: 900, height: 600, mimeType: 'image/png', hash: 's' }),
  })
  const text = f.handler.handle('screenshot', { target_window_id: 42 }).content
    .find(c => c.type === 'text').text
  assert.match(text, /window 42 could not be captured on its own/)
  assert.match(text, /whole screen/)
  assert.match(text, /screen_x = image_x \* 1\.3333/)
})
