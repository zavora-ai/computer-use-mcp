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

test('extracted screenshot handler deduplicates captures and exposes an immutable cache record', async () => {
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
  const first = await f.handler.handle('screenshot', {})
  const second = await f.handler.handle('screenshot', {})
  // 7.7.0 (K3): the unchanged frame comes back as text, three times in a row at most; the fourth sends the image.
  assert.equal(JSON.parse(second.content[0].text).unchanged, true)
  assert.equal(f.native.calls[1][4], 'h1')
  const third = await f.handler.handle('screenshot', {})
  const fourth = await f.handler.handle('screenshot', {})
  assert.equal(JSON.parse(third.content[0].text).repeats, 2)
  assert.equal(JSON.parse(fourth.content[0].text).repeats, 3)
  assert.strictEqual(await f.handler.handle('screenshot', {}), first, 'after the streak cap the image is sent again')
  assert.equal(JSON.parse((await f.handler.handle('screenshot', {})).content[0].text).repeats, 1, 'and the streak restarts')
  assert.deepEqual(f.handler.lastScreenshot(), {
    mimeType: 'image/png', data: 'raw', capturedAt: 30,
  })
  const copy = f.handler.lastScreenshot()
  copy.data = 'changed'
  assert.equal(f.handler.lastScreenshot().data, 'raw')
})

test('explicit screenshot window wins over app and a stale inferred window is cleared', async () => {
  const f = fixture()
  f.targets.update({ bundleId: 'app.target', windowId: 42 }, 'activation')
  await f.handler.handle('screenshot', { target_window_id: 42, target_app: 'ignored.app' })
  assert.equal(f.native.calls[0][2], undefined)
  assert.equal(f.native.calls[0][5], 42)

  f.native.windows.set(42, { windowId: 42, bundleId: 'app.target', isOnScreen: false })
  await f.handler.handle('screenshot', { show_agent_pointer: true })
  const secondCapture = f.native.calls.find((c, i) => i > 0 && c[0] === 'screenshot')
  assert.equal(secondCapture[5], undefined)
  assert.equal(f.targets.current().windowId, undefined)
})

test('agent pointer projection annotates the image without moving the OS cursor', async () => {
  const f = fixture()
  f.pointer.move(300, 200)
  const result = await f.handler.handle('screenshot', { show_agent_pointer: true })
  assert.equal(result.content[0].data, 'marked')
  assert.equal(f.handler.lastHash(), 'h1:agent-pointer:300,200')
  assert.equal(f.native.calls.some(call => call[0] === 'annotate'), true)
})

test('zoom validates bounds and crops a lossless capture, the region mapped from screen points', async () => {
  const f = fixture()
  await assert.rejects(f.handler.handle('zoom', { region: [3, 0, 2, 1] }), /Invalid region/)
  const result = await f.handler.handle('zoom', { region: [1, 2, 21, 32] })
  assert.equal(result.content[1].text, '20x30 (zoomed from 800x600)')
  // The 1200x800 screen is an 800x600 image: the region is scaled into it, rounded outward.
  assert.deepEqual(f.native.calls.at(-1), ['crop', 'raw', 0, 1, 14, 24, 0])
})

test('zoom on a capture the native layer scaled (Linux, 1024 wide) or doubled (Retina) cuts the region the agent named', async () => {
  const linux = fixture({
    getDisplaySize: () => ({ width: 1920, height: 1080 }),
    takeScreenshot: (...args) => { linux.native.calls.push(['screenshot', ...args]); return { base64: 'raw', width: 1024, height: 576, mimeType: 'image/png', hash: 'h' } },
  })
  await linux.handler.handle('zoom', { region: [1500, 100, 1700, 200] })
  assert.deepEqual(linux.native.calls.at(-1), ['crop', 'raw', 800, 53, 907, 107, 0], 'it used to crop 1500..1700 of a 1024-wide image')
  const retina = fixture({
    getDisplaySize: () => ({ width: 1440, height: 900 }),
    takeScreenshot: (...args) => { retina.native.calls.push(['screenshot', ...args]); return { base64: 'raw', width: 2880, height: 1800, mimeType: 'image/png', hash: 'h' } },
  })
  await retina.handler.handle('zoom', { region: [100, 50, 300, 150] })
  assert.deepEqual(retina.native.calls.at(-1), ['crop', 'raw', 200, 100, 600, 300, 0], 'two pixels per point')
})

test('a screen capture reports an exact mapping from image pixels to click coordinates', async () => {
  // Reporting only WxH left every agent to infer this, and they infer it wrong: one
  // clicked a form three times with a y scale it had guessed, missing by 30, 57 and
  // 87 pixels. A screen capture scales uniformly with no offset, so it can be stated.
  const f = fixture()
  const text = (await f.handler.handle('screenshot', {})).content.find(c => c.type === 'text').text
  assert.match(text, /^800x600 \| screen 1200x800$/m)
  // 1200 display / 800 image = 1.5
  assert.match(text, /screen_x = image_x \* 1\.5000/)
  assert.match(text, /screen_y = image_y \* 1\.5000/)
  assert.match(text, /exact/)
})

test('a window capture reports the window origin and says the mapping is approximate', async () => {
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
  const text = (await f.handler.handle('screenshot', { target_window_id: 42 })).content
    .find(c => c.type === 'text').text
  assert.match(text, /window 42 at 100,50 sized 1000x700/)
  assert.match(text, /screen_x ≈ 100 \+ image_x \* 1\.2500/)
  assert.match(text, /screen_y ≈ 50 \+ image_y \* 1\.2500/)
  assert.match(text, /approximate/)
  assert.match(text, /screen capture/, 'should point at the exact alternative')
})

test('a window that could not be captured says so instead of pretending', async () => {
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
  const text = (await f.handler.handle('screenshot', { target_window_id: 42 })).content
    .find(c => c.type === 'text').text
  assert.match(text, /window 42 could not be captured on its own/)
  assert.match(text, /whole screen/)
  assert.match(text, /screen_x = image_x \* 1\.3333/)
})

test('a missing native crop is reported as a capability gap, not a TypeError', async () => {
  // Issue #20: crop_image existed for macOS and Windows and not for Linux, so zoom
  // failed with "cropImage is not a function" — a TypeError that names no platform,
  // no reason and no alternative. The export is now implemented for Linux; this guard
  // is for the next time something is built for two platforms out of three.
  const f = fixture({ cropImage: undefined })
  const result = await f.handler.handle('zoom', { region: [10, 10, 50, 50] })
  assert.equal(result.isError, true)
  const body = JSON.parse(result.content.find(part => part.type === 'text').text)
  assert.equal(body.error, 'platform_unsupported')
  assert.match(JSON.stringify(body), /screenshot/, 'the alternative must be named')
  assert.match(JSON.stringify(body), /rebuild/, 'a local build is the likely cause')
})

test('zoom still crops when the native export is present', async () => {
  const f = fixture()
  const result = await f.handler.handle('zoom', { region: [10, 10, 50, 50] })
  assert.equal(result.isError, undefined)
  assert.ok(f.native.calls.some(([kind]) => kind === 'crop'), 'the native crop should be used')
})

// ── 7.7.0 (C7): a cancelled capture is cancelled ────────────────────────────────────────────────────────────
import { HelperFailure } from '../dist/session/macos-helper.js'

test('a screenshot cancelled during the helper capture never falls through to a second capture', async () => {
  const f = fixture()
  const controller = new AbortController()
  const helper = {
    supportsCapture: () => true,
    capture: async () => { controller.abort(new Error('Desktop control paused by person')); throw new HelperFailure('aborted', 'helper call aborted') },
  }
  const handler = new ScreenshotHandler({
    native: f.native, targets: f.targets, pointer: f.pointer, visionEnabled: true, defaultProvider: 'auto', env: {}, helper,
  })
  await assert.rejects(handler.handleAsync('screenshot', { target_window_id: 42 }, controller.signal), /paused by person/)
  assert.equal(f.native.calls.filter(call => call[0] === 'screenshot').length, 0, 'no fallback capture ran')
  // Already cancelled before it starts: nothing is captured at all.
  await assert.rejects(handler.handleAsync('screenshot', {}, controller.signal), /paused by person/)
  await assert.rejects(handler.handleAsync('zoom', { region: [0, 0, 10, 10] }, controller.signal), /paused by person/)
  assert.equal(f.native.calls.length, 0)
})

test('a helper failure that is not a cancellation still falls back to the native capture', async () => {
  const f = fixture()
  const helper = { supportsCapture: () => true, capture: async () => { throw new HelperFailure('sck_timeout', 'stalled') } }
  const handler = new ScreenshotHandler({
    native: f.native, targets: f.targets, pointer: f.pointer, visionEnabled: true, defaultProvider: 'auto', env: {}, helper,
  })
  const result = await handler.handleAsync('screenshot', { target_window_id: 42 })
  assert.equal(result.content[0].type, 'image')
  assert.equal(handler.helperFailure(), 'sck_timeout: stalled')
})

// ── 7.7.0 (K6): a Windows capture states its exact rectangle and how it was taken ───────────────────────────
test('a capture that reports its rectangle is described exactly, with its method and any occlusion', async () => {
  for (const [capture, phrase] of [
    [{ method: 'print_window', occluded: false, x: 100, y: 50, width: 800, height: 600 }, /PrintWindow\), so it is complete even when covered/],
    [{ method: 'screen_crop', occluded: true, x: -1900, y: 10, width: 800, height: 600 }, /part of the window was covered/],
  ]) {
    const f = fixture({
      takeScreenshot: (...args) => {
        f.native.calls.push(['screenshot', ...args])
        return { base64: 'raw', width: 400, height: 300, mimeType: 'image/png', hash: `h-${capture.method}`, capture }
      },
    })
    const result = await f.handler.handle('screenshot', { target_window_id: 42 })
    const text = result.content[1].text
    assert.match(text, new RegExp(`window 42 at ${capture.x},${capture.y} sized 800x600`))
    assert.match(text, new RegExp(`screen_x = ${capture.x} \\+ image_x \\* 2\\.0000`))
    assert.match(text, phrase)
  }
})

test('display_id reaches the native capture for a full-screen screenshot only', async () => {
  const f = fixture()
  await f.handler.handle('screenshot', { full_screen: true, display_id: 65537 })
  assert.equal(f.native.calls[0][6], 65537)
  await f.handler.handle('screenshot', { target_window_id: 42, display_id: 65537 })
  assert.equal(f.native.calls[1][6], undefined, 'a window capture ignores display_id')
})
