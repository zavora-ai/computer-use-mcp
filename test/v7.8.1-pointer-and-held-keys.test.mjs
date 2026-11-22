// 7.8.1, from following a Blender sculpting tutorial through this server:
// - captures said nothing about the pointer, so an agent could not tell where its cursor was in the image;
// - a key could not stay held across calls (hold the C key, click, then let go in a later call).
import assert from 'node:assert/strict'
import test from 'node:test'
import { ScreenshotHandler } from '../dist/session/screenshot-handlers.js'
import { InputHandler } from '../dist/session/input-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'
import { VirtualPointerController } from '../dist/session/virtual-pointer.js'
import { OperatorControl } from '../dist/session/operator-control.js'

const text = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')

function screenshots(overrides = {}) {
  const calls = []
  const native = {
    calls,
    getWindow: id => (id === 42 ? { windowId: 42, bundleId: 'org.blenderfoundation.blender', isOnScreen: true, bounds: { x: 100, y: 50, width: 800, height: 600 } } : null),
    getFrontmostApp: () => ({ bundleId: 'app.front' }),
    getDisplaySize: () => ({ width: 1280, height: 1024 }),
    cursorPosition: () => ({ x: 500, y: 350 }),
    takeScreenshot: () => ({ base64: 'raw', width: 640, height: 512, mimeType: 'image/png', hash: 'h1' }),
    cropImage: () => ({ base64: 'crop', width: 100, height: 100, mimeType: 'image/png' }),
    annotateImage: (...args) => { calls.push(['annotate', ...args]); return { base64: 'marked', width: 640, height: 512, mimeType: 'image/png' } },
    agentPointerOverlayStatus: () => ({ visible: false }),
    ...overrides,
  }
  const targets = new TargetStateController(native, () => 10)
  const pointer = new VirtualPointerController(native, () => 20)
  return { native, targets, pointer, calls }
}

test('every screenshot says where the pointer is, in screen points and image pixels', async () => {
  const f = screenshots()
  const handler = new ScreenshotHandler({ native: f.native, targets: f.targets, pointer: f.pointer, visionEnabled: true, defaultProvider: 'auto', env: {} })
  const shot = await handler.handleAsync('screenshot', { width: 640 })
  // the whole 1280x1024 screen at 640 wide: half scale, so (500, 350) is image (250, 175)
  assert.match(text(shot), /pointer at screen \(500, 350\), image \(250, 175\)/)
  assert.equal(f.calls.filter(c => c[0] === 'annotate').length, 0, 'nothing drawn unless asked')
})

test('include_pointer draws the real cursor through ScreenCaptureKit, and says so', async () => {
  const f = screenshots()
  const seen = []
  const helper = {
    supportsCapture: () => true,
    capture: async options => {
      seen.push(options)
      return { data: Buffer.from('jpg'), width: 400, height: 300, hash: 'x', scale: 2, frame: { x: 100, y: 50, width: 800, height: 600 }, mimeType: 'image/jpeg' }
    },
  }
  const handler = new ScreenshotHandler({ native: f.native, targets: f.targets, pointer: f.pointer, visionEnabled: true, defaultProvider: 'auto', env: {}, helper })
  const shot = await handler.handleAsync('screenshot', { target_window_id: 42, include_pointer: true })
  assert.equal(seen[0].cursor, true, 'the helper is asked to draw the cursor')
  // window at (100, 50), 800 wide in a 400-wide image: (500, 350) is image (200, 150)
  assert.match(text(shot), /pointer at screen \(500, 350\), image \(200, 150\); drawn \(the real cursor\)/)
  const plain = await handler.handleAsync('screenshot', { target_window_id: 42, resend: true })
  assert.equal(seen[1].cursor, undefined, 'left out when not asked')
  assert.doesNotMatch(text(plain), /drawn/)
})

test('a capture path that cannot draw the cursor marks the spot instead', async () => {
  const f = screenshots()
  const handler = new ScreenshotHandler({ native: f.native, targets: f.targets, pointer: f.pointer, visionEnabled: true, defaultProvider: 'auto', env: {} })
  const shot = await handler.handleAsync('screenshot', { width: 640, include_pointer: true })
  assert.match(text(shot), /marked with a box/)
  const marks = f.calls.filter(c => c[0] === 'annotate')
  assert.equal(marks.length, 1)
  const [rect] = JSON.parse(marks[0][2])
  assert.equal(rect.x + rect.width / 2, 250)
  assert.equal(rect.y + rect.height / 2, 175)
  assert.equal(shot.content.find(c => c.type === 'image').data, 'marked')
})

test('zoom reports the pointer in the zoomed image, or says it is outside', async () => {
  const f = screenshots()
  const helper = {
    supportsCapture: () => true,
    capture: async options => ({ data: Buffer.from('png'), width: 200, height: 200, hash: 'z', scale: 1, frame: { x: 0, y: 0, width: 100, height: 100 }, mimeType: 'image/png', display: 1, _o: options }),
  }
  const handler = new ScreenshotHandler({ native: f.native, targets: f.targets, pointer: f.pointer, visionEnabled: true, defaultProvider: 'auto', env: {}, helper })
  const inside = await handler.handleAsync('zoom', { region: [450, 300, 550, 400] })
  // 100x100 points shown at 200x200: (500, 350) is image (100, 100)
  assert.match(text(inside), /pointer at screen \(500, 350\), image \(100, 100\)/)
  const outside = await handler.handleAsync('zoom', { region: [0, 0, 100, 100] })
  assert.match(text(outside), /pointer at screen \(500, 350\), outside this image/)
})

function held({ maxMs } = {}) {
  const calls = []
  const native = {
    calls,
    getDisplaySize: () => ({ width: 500, height: 400 }),
    getWindow: () => null,
    getFrontmostApp: () => ({ bundleId: 'app.front' }),
    keyDown: keys => calls.push(['down', keys]),
    keyUp: keys => calls.push(['up', keys]),
  }
  const targets = new TargetStateController(native, () => 100)
  const focus = { strategyFor: () => 'none', ensure: async () => ({}) }
  const control = new OperatorControl({ native: {} })
  const handler = new InputHandler({ native, targets, focus, platform: 'darwin', sleep: async () => {}, haltSignal: () => control.signal(), ...(maxMs ? { heldKeysMaxMs: maxMs } : {}) })
  return { native, handler, control, calls }
}

test('hold_key down keeps a key held across calls until up', async () => {
  const f = held()
  const down = await f.handler.handle('hold_key', { action: 'down', keys: ['c'] })
  assert.match(text(down), /Holding c until hold_key/)
  assert.deepEqual(f.handler.heldKeys(), ['c'])
  assert.deepEqual(f.calls, [['down', ['c']]], 'down only: the key stays held after the call returns')
  const up = await f.handler.handle('hold_key', { action: 'up', keys: ['c'] })
  assert.match(text(up), /Released c/)
  assert.deepEqual(f.calls.at(-1), ['up', ['c']])
  assert.deepEqual(f.handler.heldKeys(), [])
})

test('release lets go of everything held, in reverse order', async () => {
  const f = held()
  await f.handler.handle('hold_key', { action: 'down', keys: ['shift'] })
  await f.handler.handle('hold_key', { action: 'down', keys: ['c'] })
  const r = await f.handler.handle('hold_key', { action: 'release' })
  assert.match(text(r), /Released shift\+c/)
  assert.deepEqual(f.calls.at(-1), ['up', ['c', 'shift']])
  assert.match(text(await f.handler.handle('hold_key', { action: 'release' })), /Nothing was held/)
})

test('held keys come up when the person pauses or stops the agent', async () => {
  const f = held()
  await f.handler.handle('hold_key', { action: 'down', keys: ['alt'] })
  f.control.pause('person')
  assert.deepEqual(f.calls.at(-1), ['up', ['alt']])
  assert.deepEqual(f.handler.heldKeys(), [])
  f.control.close()
})

test('held keys come up by themselves after the cap', async () => {
  const f = held({ maxMs: 40 })
  await f.handler.handle('hold_key', { action: 'down', keys: ['d'] })
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.deepEqual(f.calls.at(-1), ['up', ['d']])
  assert.deepEqual(f.handler.heldKeys(), [])
  f.control.close()
})

test('hold without a duration says how to hold across calls; down needs keys', async () => {
  const f = held()
  await assert.rejects(f.handler.handle('hold_key', { keys: ['shift'] }), /hold needs duration/)
  await assert.rejects(f.handler.handle('hold_key', { action: 'down' }), /non-empty string/)
  await assert.rejects(f.handler.handle('hold_key', { action: 'sideways', keys: ['a'] }), /Invalid action/)
  f.control.close()
})
