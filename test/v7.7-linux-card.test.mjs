// The Linux status card: the presenter, the capture mask and the click guard. Fakes everywhere; the last test runs the
// real GTK card only when there is an X display and python3-gi.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { insideRect, maskCardInCaptures, maskRects, captureArea } from '../dist/session/card-guard.js'
import { LinuxCardPresenter, OperatorControl, defaultCardPresenter, linuxCardFailure, statusCardEnabled } from '../dist/session/operator-control.js'
import { REFUSALS } from '../dist/session/contract.js'
import { createSession } from '../dist/session.js'

const root = join(fileURLToPath(import.meta.url), '..', '..')
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
const text = r => r.content.find(c => c.type === 'text')?.text ?? ''
const CARD = { x: 922, y: 46, width: 344, height: 154 }

test('the card rectangle maps into a scaled capture, rounded outward, and only where it overlaps', () => {
  // 1280x800 screen captured at 1024x640 (0.8).
  assert.deepEqual(maskRects(CARD, { x: 0, y: 0, width: 1280, height: 800 }, { width: 1024, height: 640 }), [737, 36, 276, 124])
  // At full resolution it is the rectangle itself.
  assert.deepEqual(maskRects(CARD, { x: 0, y: 0, width: 1280, height: 800 }, { width: 1280, height: 800 }), [922, 46, 344, 154])
  // A window capture that the card overlaps on its right edge: only the overlap, in window pixels.
  assert.deepEqual(maskRects(CARD, { x: 600, y: 0, width: 400, height: 300 }, { width: 400, height: 300 }), [322, 46, 78, 154])
  // No overlap: nothing to mask.
  assert.equal(maskRects(CARD, { x: 0, y: 0, width: 800, height: 600 }, { width: 800, height: 600 }), undefined)
  assert.equal(insideRect(1000, 100, CARD), true)
  assert.equal(insideRect(921, 100, CARD), false)
  assert.equal(insideRect(CARD.x + CARD.width, 100, CARD), false, 'the right edge is outside')
})

test('a capture covers the window for a window capture and the screen only when the image has its shape', () => {
  const native = { getDisplaySize: () => ({ width: 1280, height: 800 }), getWindow: id => id === 7 ? { bounds: { x: 10, y: 20, width: 300, height: 200 } } : null }
  assert.deepEqual(captureArea(native, 7, { width: 300, height: 200 }), { x: 10, y: 20, width: 300, height: 200 })
  assert.equal(captureArea(native, 8, { width: 300, height: 200 }), undefined)
  assert.deepEqual(captureArea(native, undefined, { width: 1024, height: 640 }), { x: 0, y: 0, width: 1280, height: 800 })
  assert.equal(captureArea(native, undefined, { width: 600, height: 400 }), undefined, 'scrot -u (the focused window) is not the screen')
})

function fakeNative(extra = {}) {
  const calls = []
  return {
    calls,
    getDisplaySize: () => ({ width: 1280, height: 800, scaleFactor: 1 }),
    getWindow: () => null,
    takeScreenshot: (...args) => { calls.push(['takeScreenshot', args]); return { base64: 'UkFX', width: 1024, height: 640, mimeType: 'image/jpeg', hash: 'raw', unchanged: false } },
    maskImage: (base64, rects, quality) => { calls.push(['maskImage', rects, quality]); return { base64: `masked:${rects.join(',')}`, width: 1024, height: 640, mimeType: 'image/jpeg' } },
    other: () => 'untouched',
    ...extra,
  }
}

test('every capture passes through the mask while the card is up, and nothing changes when it is not', async () => {
  let region
  const native = fakeNative({ takeScreenshotAsync: async (...args) => native.takeScreenshot(...args) })
  const wrapped = maskCardInCaptures(native, () => region)
  assert.equal(wrapped.other(), 'untouched')
  assert.equal(wrapped.takeScreenshot(1024, undefined, 80).base64, 'UkFX', 'no card: the raw capture')
  assert.equal(native.calls.filter(c => c[0] === 'maskImage').length, 0)

  region = CARD
  const shot = wrapped.takeScreenshot(1024, undefined, 70)
  assert.equal(shot.base64, 'masked:737,36,276,124')
  assert.equal(shot.cardMasked, true)
  assert.notEqual(shot.hash, 'raw', 'the hash is of the masked image, so the ticking card does not defeat unchanged detection')
  assert.deepEqual(native.calls.at(-1), ['maskImage', [737, 36, 276, 124], 70])

  const again = wrapped.takeScreenshot(1024, undefined, 70, shot.hash)
  assert.equal(again.unchanged, true)
  assert.equal(again.base64, undefined, 'an unchanged masked capture is reported as unchanged')

  const viaWorker = await wrapped.takeScreenshotAsync(1024, undefined, 70)
  assert.equal(viaWorker.base64, 'masked:737,36,276,124', 'the worker-thread variant is masked too')
})

test('a native module without maskImage withholds the capture rather than show the card', () => {
  const native = fakeNative({ maskImage: undefined })
  const wrapped = maskCardInCaptures(native, () => CARD)
  assert.throws(() => wrapped.takeScreenshot(1024), error => error.details?.error === 'card_mask_unavailable')
})

test('the control reports the card rectangle only for a presenter that shows in captures, and only while it is up', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'card-test-'))
  const presenter = {
    kind: 'fake-linux', visibleInCaptures: true, calls: [],
    start(dir) { writeFileSync(join(dir, 'card.json'), JSON.stringify({ frame: { x: 924, y: 48, width: 340, height: 150 } })) },
    stop() {},
  }
  const control = new OperatorControl({ card: { presenter, directory, pollMs: 10 } })
  assert.equal(control.cardRegion(), undefined, 'not launched yet')
  control.begin({ tool: 'click', label: 'click (1, 1)' }, { mutates: true })
  await settle()
  assert.deepEqual(control.cardRegion(), CARD, 'padded by 2 px')
  control.close()
  assert.equal(control.cardRegion(), undefined)

  const hidden = mkdtempSync(join(tmpdir(), 'card-test-'))
  const macos = new OperatorControl({ card: { presenter: { kind: 'fake-macos', start(dir) { writeFileSync(join(dir, 'card.json'), '{"frame":{"x":1,"y":1,"width":1,"height":1}}') }, stop() {} }, directory: hidden, pollMs: 10 } })
  macos.begin({ tool: 'click', label: 'click' }, { mutates: true })
  await settle()
  assert.equal(macos.cardRegion(), undefined, 'a card excluded from capture needs no mask')
  macos.close()
})

test('a session refuses clicks on the card and paints it out of screenshots', async () => {
  const win = { windowId: 1, pid: 100, bundleId: 'gedit', title: 'Doc', bounds: { x: 0, y: 0, width: 800, height: 600 }, isOnScreen: true, isFocused: true, layer: 0 }
  const native = {
    ...fakeNative(),
    listDisplays: () => [{ x: 0, y: 0, width: 1280, height: 800 }],
    getWindow: id => (id === 1 ? win : null), listWindows: () => [win],
    getFrontmostApp: () => ({ bundleId: 'gedit', pid: 100 }), listRunningApps: () => [{ bundleId: 'gedit', pid: 100, isHidden: false }],
    activateApp: () => ({ activated: true }), activateWindow: () => ({ activated: true }),
    mouseMove: () => {}, mouseClick: (...a) => native.calls.push(['mouseClick', a]), mouseButton: (...a) => native.calls.push(['mouseButton', a]),
    getUserIdleTimeMs: () => 60_000,
  }
  const directory = mkdtempSync(join(tmpdir(), 'card-test-'))
  const presenter = { kind: 'fake-linux', visibleInCaptures: true, start(dir) { writeFileSync(join(dir, 'card.json'), JSON.stringify({ frame: { x: 924, y: 48, width: 340, height: 150 } })) }, stop() {} }
  const control = new OperatorControl({ native, card: { presenter, directory, pollMs: 10 } })
  const session = createSession({ native, macosHelper: null, profile: 'full', operatorControl: control })
  const outside = await session.dispatch('click', { coordinate: [400, 300] })
  assert.equal(outside.isError, undefined, text(outside))
  await settle()

  const onStop = await session.dispatch('click', { coordinate: [1218, 176] })
  assert.equal(onStop.isError, true)
  const payload = JSON.parse(text(onStop))
  assert.equal(payload.error, 'status_card_protected')
  assert.deepEqual(payload.next_call, { tool: 'control_status', arguments: {} })
  const pressed = await session.dispatch('left_mouse_down', { coordinate: [1000, 100] })
  assert.equal(JSON.parse(text(pressed)).error, 'status_card_protected', 'a press is refused too')
  assert.equal(native.calls.filter(c => c[0] === 'mouseClick').length, 1, 'only the click outside reached the native layer')
  assert.equal(native.calls.filter(c => c[0] === 'mouseButton').length, 0)

  const shot = await session.dispatch('screenshot', { full_screen: true })
  assert.equal(shot.isError, undefined, text(shot))
  assert.match(shot.content.find(c => c.type === 'image').data, /^masked:/)
  session.close()
})

test('LinuxCardPresenter starts the card with the X11 backend and off the accessibility bus, and waits for it', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'card-fake-'))
  const script = join(scratch, 'card.mjs')
  // Stands in for linux-status-card.py: records its arguments and environment, reports a rectangle, stays up.
  writeFileSync(script, `import { writeFileSync } from 'node:fs'
const dir = process.argv[2]
writeFileSync(dir + '/seen.json', JSON.stringify({ argv: process.argv.slice(2), gdk: process.env.GDK_BACKEND, atBridge: process.env.NO_AT_BRIDGE }))
setTimeout(() => writeFileSync(dir + '/card.json', '{"frame":{"x":1,"y":2,"width":3,"height":4}}'), 100)
setTimeout(() => {}, 60000)
`)
  const directory = mkdtempSync(join(tmpdir(), 'card-test-'))
  const presenter = new LinuxCardPresenter({ python: process.execPath, scriptPath: script, env: { ...process.env, DISPLAY: ':99' } })
  assert.equal(presenter.visibleInCaptures, true)
  await presenter.start(directory)
  assert.ok(existsSync(join(directory, 'card.json')), 'start resolved once the card reported where it is')
  const seen = JSON.parse(readFileSync(join(directory, 'seen.json'), 'utf8'))
  assert.deepEqual(seen, { argv: [directory], gdk: 'x11', atBridge: '1' })
  presenter.stop()
})

test('LinuxCardPresenter says why the card could not start', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'card-test-'))
  await assert.rejects(new LinuxCardPresenter({ env: { PATH: process.env.PATH } }).start(directory), /No X display/)

  const scratch = mkdtempSync(join(tmpdir(), 'card-fake-'))
  const missing = join(scratch, 'missing-gi.mjs')
  writeFileSync(missing, `process.stderr.write("ModuleNotFoundError: No module named 'gi'\\n"); process.exit(1)`)
  await assert.rejects(new LinuxCardPresenter({ python: process.execPath, scriptPath: missing, env: { ...process.env, DISPLAY: ':99' } }).start(directory),
    /python3-gi with GTK 3 is missing.*apt|python3-gi and gir1.2-gtk-3.0/)

  const silent = join(scratch, 'silent.mjs')
  writeFileSync(silent, 'setTimeout(() => {}, 60000)')
  await assert.rejects(new LinuxCardPresenter({ python: process.execPath, scriptPath: silent, env: { ...process.env, DISPLAY: ':99' }, startMs: 200 }).start(directory),
    /did not come up within 0.2 s/)
  assert.match(linuxCardFailure(3, 'linux-status-card: no X display\n'), /exited with code 3 before it came up: linux-status-card: no X display/)
})

test('Linux gets the card when asked for; it stays opt-in, and its refusals are in the contract table', () => {
  assert.equal(defaultCardPresenter('linux')?.kind, 'linux')
  assert.equal(statusCardEnabled({}, 'linux'), false)
  assert.equal(statusCardEnabled({ COMPUTER_USE_STATUS_CARD: 'true' }, 'linux'), true)
  assert.ok(REFUSALS.status_card_protected)
  assert.ok(REFUSALS.card_mask_unavailable)
})

test('the card script is valid Python', () => {
  const compiled = spawnSync('python3', ['-c', 'import ast, sys; ast.parse(open(sys.argv[1]).read())', join(root, 'libexec', 'linux-status-card.py')], { encoding: 'utf8' })
  if (compiled.error) return // no python3 on this machine
  assert.equal(compiled.status, 0, compiled.stderr)
})

const gtk = process.platform === 'linux' && process.env.DISPLAY
  && spawnSync('python3', ['-c', "import gi; gi.require_version('Gtk', '3.0'); from gi.repository import Gtk"], { stdio: 'ignore' }).status === 0
const xprop = gtk && spawnSync('sh', ['-c', 'command -v xprop'], { stdio: 'ignore' }).status === 0

test('live: the GTK card comes up top-right, reserves its strip, and closes with the server', { skip: gtk ? false : 'needs Linux, an X display and python3-gi' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'card-live-'))
  // The "server" whose pid the card watches.
  const server = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  writeFileSync(join(directory, 'control.txt'), 'running')
  writeFileSync(join(directory, 'state.json'), JSON.stringify({ pid: server.pid, state: 'running', reason: null, startedAt: Date.now(), updatedAt: Date.now(), action: { tool: 'click', label: 'click (1, 1)', at: '', outcome: 'active' }, recent: [], waiting: null, chord: null, platform: 'linux' }))
  const workarea = () => xprop ? spawnSync('xprop', ['-root', '_NET_WORKAREA'], { encoding: 'utf8' }).stdout.match(/= (\d+), (\d+), (\d+)/)?.slice(1).map(Number) : undefined
  const before = workarea()
  const presenter = new LinuxCardPresenter()
  try {
    await presenter.start(directory)
    await settle(1500)
    const card = JSON.parse(readFileSync(join(directory, 'card.json'), 'utf8'))
    assert.equal(card.frame.width, 340 * card.scale)
    assert.equal(card.frame.height, 150 * card.scale)
    assert.ok(card.buttons.stop.x > card.buttons.pause.x, 'Stop is right of Pause')
    const after = workarea()
    if (before && after && before[0] + before[2] >= card.frame.x + card.frame.width) {
      assert.ok(after[0] + after[2] <= card.frame.x, `the work area (${after}) ends left of the card at x=${card.frame.x}`)
    }
    server.kill()
    await settle(1200)
    assert.equal(existsSync(join(directory, 'card.json')), false, 'the card closed and removed card.json when the server died')
  } finally {
    presenter.stop()
    server.kill()
  }
})
