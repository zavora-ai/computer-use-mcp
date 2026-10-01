import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMacosHelper, darwinSupportsScreenCaptureKit, HelperFailure } from '../dist/session/macos-helper.js'
import { findText, handleAgentDesktopTool, mapOcrLines } from '../dist/session/agent-desktop-handlers.js'
import { createUserActivityGuard, parseIdleThreshold, UserActiveError } from '../dist/session/user-activity.js'
import { PidDeliveryStore } from '../dist/session/pid-delivery.js'
import { InputHandler } from '../dist/session/input-handlers.js'
import { createFocusController } from '../dist/session/focus.js'
import { handleWindowTool } from '../dist/session/window-handlers.js'
import { ScreenshotHandler } from '../dist/session/screenshot-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'
import { VirtualPointerController } from '../dist/session/virtual-pointer.js'
import { createSession } from '../dist/session.js'

// ── Helper wrapper ────────────────────────────────────────────────────────────

function helperFixture(responses = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cu-helper-'))
  const source = join(dir, 'helper.swift')
  writeFileSync(source, '// fake source')
  const calls = []
  const run = async (file, args) => {
    calls.push([file, ...args])
    if (file === 'xcrun' && args[0] === '-f') return { code: responses.noSwiftc ? 1 : 0, stdout: '/usr/bin/swiftc', stderr: '' }
    if (file === 'xcrun' && args[0] === 'swiftc') {
      writeFileSync(args[args.indexOf('-o') + 1], 'binary')
      return { code: 0, stdout: '', stderr: '' }
    }
    if (file === 'codesign') return { code: 0, stdout: '', stderr: '' }
    const command = args[0]
    if (command === 'capture') {
      writeFileSync(args[args.indexOf('--out') + 1], 'IMG')
      return { code: 0, stdout: JSON.stringify({ path: 'x', width: 400, height: 300, hash: 'abc', scale: 1, frame: { x: 0, y: 0, width: 400, height: 300 }, mimeType: 'image/jpeg', bytes: 3 }), stderr: '' }
    }
    if (command === 'ocr') return responses.ocr ?? { code: 1, stdout: JSON.stringify({ error: 'screen_recording_denied', message: 'denied' }), stderr: '' }
    return { code: 1, stdout: '', stderr: 'unknown' }
  }
  return { dir, source, calls, run }
}

test('the helper compiles once into a sha-named cache file, signs it, then reuses it', async () => {
  const f = helperFixture()
  const helper = createMacosHelper({ sourcePath: f.source, cacheDir: f.dir, platform: 'darwin', darwinRelease: '25.2.0', run: f.run })
  const first = await helper.ensure()
  assert.equal(first.ok, true)
  assert.match(first.path, /macos-agent-helper-[0-9a-f]{8}$/)
  assert.ok(existsSync(first.path))
  assert.ok(f.calls.some(call => call[0] === 'codesign'))
  const compiles = f.calls.filter(call => call[1] === 'swiftc').length
  const again = createMacosHelper({ sourcePath: f.source, cacheDir: f.dir, platform: 'darwin', darwinRelease: '25.2.0', run: f.run })
  assert.equal((await again.ensure()).path, first.path)
  assert.equal(f.calls.filter(call => call[1] === 'swiftc').length, compiles, 'cached binary is not rebuilt')

  const capture = await helper.capture({ windowId: 5, width: 800 })
  assert.equal(capture.hash, 'abc')
  assert.equal(capture.data.toString(), 'IMG')
  await assert.rejects(helper.ocr({ windowId: 5 }), error => error instanceof HelperFailure && error.code === 'screen_recording_denied')
})

test('the helper reports a missing swiftc, non-macOS hosts and pre-14 macOS', async () => {
  const f = helperFixture({ noSwiftc: true })
  const helper = createMacosHelper({ sourcePath: f.source, cacheDir: f.dir, platform: 'darwin', darwinRelease: '25.0.0', run: f.run })
  const result = await helper.ensure()
  assert.equal(result.ok, false)
  assert.match(result.remediation, /xcode-select --install/)
  const linux = createMacosHelper({ platform: 'linux', run: f.run })
  assert.equal((await linux.ensure()).ok, false)
  assert.equal(darwinSupportsScreenCaptureKit('22.6.0'), false)
  assert.equal(darwinSupportsScreenCaptureKit('23.0.0'), true)
  const old = createMacosHelper({ sourcePath: f.source, cacheDir: f.dir, platform: 'darwin', darwinRelease: '22.6.0', run: f.run })
  await assert.rejects(old.capture({ windowId: 1 }), error => error.code === 'sck_unavailable')
})

// ── OCR mapping and text matching ────────────────────────────────────────────

const ocr = {
  width: 2000, height: 1200, scale: 2,
  lines: [
    { text: 'File  Edit  Window', confidence: 0.98, box: { x: 20, y: 10, w: 360, h: 30 } },
    { text: 'Build', confidence: 0.91, box: { x: 1600, y: 10, w: 100, h: 30 } },
    { text: 'Output Log', confidence: 0.4, box: { x: 40, y: 1100, w: 200, h: 28 } },
  ],
}
const bounds = { x: 100, y: 30, width: 1000, height: 600 }

test('OCR boxes map from image pixels to window points and screen points', () => {
  const lines = mapOcrLines(ocr, bounds)
  assert.deepEqual(lines[1].box, { x: 800, y: 5, w: 50, h: 15 })
  assert.deepEqual(lines[1].screen, { x: 900, y: 35, w: 50, h: 15 })
  // Without a reported scale it is derived from the image and window widths.
  const derived = mapOcrLines({ ...ocr, scale: undefined }, bounds)
  assert.deepEqual(derived[1].screen, lines[1].screen)
})

test('findText matches exact, contains and regex, in reading order, centring on the substring', () => {
  const lines = mapOcrLines(ocr, bounds)
  assert.equal(findText(lines, 'build', 'exact').length, 1)
  assert.equal(findText(lines, 'buil', 'exact').length, 0)
  const edit = findText(lines, 'edit', 'contains')[0]
  assert.equal(edit.matched, 'Edit')
  // "Edit" starts at character 6 of 18 in a line 180 points wide starting at x=110.
  assert.equal(edit.point.x, Math.round(110 + 180 * (6 / 18) + (180 * (4 / 18)) / 2))
  assert.deepEqual(findText(lines, '^(build|file)', 'regex').map(m => m.line.text), ['File  Edit  Window', 'Build'])
})

// ── Tools over a fake helper ─────────────────────────────────────────────────

function desktop({ idle = null, helperOcr = ocr, known = [] } = {}) {
  const calls = []
  const window = { windowId: 7, bundleId: 'com.epicgames.UnrealEditor', pid: 4242, title: 'Editor', bounds, isOnScreen: true, displayName: 'UE', isFocused: false, displayId: 1 }
  let frontmost = { bundleId: 'com.apple.Terminal', pid: 1 }
  const native = {
    calls,
    getWindow: id => (id === 7 ? window : null),
    listWindows: bundle => (!bundle || bundle === window.bundleId ? [window] : []),
    listDisplays: () => [{ x: 0, y: 0, width: 2560, height: 1080 }],
    getDisplaySize: () => ({ width: 2560, height: 1080 }),
    getFrontmostApp: () => frontmost,
    listRunningApps: () => [{ bundleId: window.bundleId, pid: 4242, isHidden: false }],
    activateApp: bundle => { calls.push(['activate', bundle]); frontmost = { bundleId: bundle }; return { activated: true } },
    activateWindow: () => ({ activated: true }),
    unhideApp: () => true,
    getUserIdleTimeMs: () => idle,
    mouseMove: (...args) => calls.push(['move', ...args]),
    mouseClick: (...args) => calls.push(['click', ...args]),
    mouseClickToPid: (...args) => calls.push(['clickToPid', ...args]),
    mouseScrollToPid: (...args) => calls.push(['scrollToPid', ...args]),
    keyPress: (...args) => calls.push(['key', ...args]),
    keyPressToPid: (...args) => calls.push(['keyToPid', ...args]),
    typeText: (...args) => calls.push(['type', ...args]),
    typeTextToPid: (...args) => calls.push(['typeToPid', ...args]),
  }
  let hash = 0
  const helper = {
    ensure: async () => ({ ok: true, path: '/fake' }),
    supportsCapture: () => true,
    capture: async () => ({ hash: `h${calls.filter(c => c[0].endsWith('ToPid')).length}`, width: 480, height: 288, scale: 0.48, frame: bounds, mimeType: 'image/jpeg', bytes: 1, path: '', data: Buffer.from(`img${hash++}`) }),
    ocr: async options => { calls.push(['ocr', options]); return helperOcr },
  }
  const store = new PidDeliveryStore()
  for (const bundleId of known) {
    store.record(bundleId, 'keyboard', { outcome: 'changed', tool: 'key', at: 'then' })
    store.record(bundleId, 'pointer', { outcome: 'changed', tool: 'left_click', at: 'then' })
  }
  const targets = new TargetStateController(native, () => 1)
  const guard = createUserActivityGuard({ native, env: {}, platform: 'darwin' })
  const focus = createFocusController({ native, platform: 'darwin', env: {}, sleep: async () => {}, guard })
  const input = new InputHandler({ native, targets, focus, platform: 'darwin', sleep: async () => {}, guard, pidStore: store, helper })
  const context = { native, targets, helper, input, platform: 'darwin', sleepAbortable: async () => false }
  return { native, calls, helper, store, targets, guard, input, context, window }
}

test('read_window_text returns lines with window and screen boxes and honours min_confidence', async () => {
  const d = desktop()
  const result = await handleAgentDesktopTool('read_window_text', { target_app: 'com.epicgames.UnrealEditor', region: [0, 0, 500, 100], min_confidence: 0.5 }, d.context)
  assert.equal(result.isError, undefined)
  assert.equal(result.structuredContent.count, 2)
  assert.deepEqual(result.structuredContent.lines[1].screen, { x: 900, y: 35, w: 50, h: 15 })
  assert.deepEqual(d.calls.find(c => c[0] === 'ocr')[1].region, { x: 0, y: 0, width: 500, height: 100 })
  const linux = await handleAgentDesktopTool('read_window_text', { target_app: 'x' }, { ...d.context, platform: 'linux' })
  assert.equal(linux.structuredContent.error, 'platform_unsupported')
  const missing = await handleAgentDesktopTool('read_window_text', {}, d.context).catch(error => error)
  assert.equal(missing.details.error, 'target_required')
})

test('click_text clicks the centre of the matched text and reports what it matched', async () => {
  const d = desktop()
  const result = await handleAgentDesktopTool('click_text', { text: 'Build', target_app: 'com.epicgames.UnrealEditor', focus_strategy: 'none' }, d.context)
  assert.equal(result.structuredContent.clicked.matched, 'Build')
  assert.deepEqual(d.calls.find(c => c[0] === 'click'), ['click', 925, 43, 'left', 1])
  const miss = await handleAgentDesktopTool('click_text', { text: 'Play', target_app: 'com.epicgames.UnrealEditor' }, d.context)
  assert.equal(miss.structuredContent.error, 'text_not_found')
  assert.ok(miss.structuredContent.seen.includes('Build'))
})

test('click_text with delivery pid posts to the process at screen coordinates without activating', async () => {
  const d = desktop()
  const result = await handleAgentDesktopTool('click_text', { text: 'Build', target_app: 'com.epicgames.UnrealEditor', delivery: 'pid' }, d.context)
  assert.match(result.structuredContent.result, /delivery: pid/)
  const click = d.calls.find(c => c[0] === 'clickToPid')
  assert.deepEqual(click, ['clickToPid', 4242, 925, 43, 'left', 1, 7])
  assert.equal(d.calls.some(c => c[0] === 'activate' || c[0] === 'move'), false)
})

// ── User-active guard (R4) ───────────────────────────────────────────────────

test('the idle threshold parses from the environment', () => {
  assert.equal(parseIdleThreshold(undefined), 4000)
  assert.equal(parseIdleThreshold('1500'), 1500)
  assert.equal(parseIdleThreshold('0'), 0)
  assert.equal(parseIdleThreshold('nope'), 4000)
  const off = createUserActivityGuard({ native: { getUserIdleTimeMs: () => 10 }, env: { COMPUTER_USE_USER_IDLE_MS: '0' }, platform: 'darwin' })
  assert.doesNotThrow(() => off.check({ tool: 'key', wouldDo: 'x' }))
  // Windows and Linux keep their behaviour unless the variable is set.
  const windows = createUserActivityGuard({ native: { getUserIdleTimeMs: () => 10 }, env: {}, platform: 'win32' })
  assert.doesNotThrow(() => windows.check({ tool: 'key', wouldDo: 'x' }))
  const optedIn = createUserActivityGuard({ native: { getUserIdleTimeMs: () => 10 }, env: { COMPUTER_USE_USER_IDLE_MS: '4000' }, platform: 'linux' })
  assert.throws(() => optedIn.check({ tool: 'key', wouldDo: 'x' }), UserActiveError)
})

test('HID input while the user is active is refused with user_active unless forced', async () => {
  const d = desktop({ idle: 500 })
  await assert.rejects(d.input.handle('key', { text: 'return', target_app: 'com.epicgames.UnrealEditor' }), error => {
    assert.ok(error instanceof UserActiveError)
    assert.equal(error.details.status, 'user_active')
    assert.equal(error.details.msSinceInput, 500)
    assert.match(error.details.wouldDo, /press return in com.epicgames.UnrealEditor/)
    assert.match(error.details.hint, /delivery: "pid"/)
    return true
  })
  assert.equal(d.calls.some(c => c[0] === 'key' || c[0] === 'activate'), false, 'nothing was sent or activated')
  await d.input.handle('key', { text: 'return', target_app: 'com.epicgames.UnrealEditor', force: true })
  assert.ok(d.calls.some(c => c[0] === 'key'))
})

test('an idle user, or no clock, leaves the old path untouched', async () => {
  for (const idle of [60_000, null]) {
    const d = desktop({ idle })
    await d.input.handle('left_click', { coordinate: [200, 200], target_app: 'com.epicgames.UnrealEditor' })
    assert.ok(d.calls.some(c => c[0] === 'click'))
  }
})

test('auto delivery uses pid only for the input class an app is known to accept', async () => {
  const d = desktop({ idle: 200 })
  d.store.record('com.epicgames.UnrealEditor', 'keyboard', { outcome: 'changed', tool: 'type', at: 'then' })
  await d.input.handle('key', { text: 'a', target_app: 'com.epicgames.UnrealEditor' })
  assert.ok(d.calls.some(c => c[0] === 'keyToPid'))
  await assert.rejects(d.input.handle('left_click', { coordinate: [300, 300], target_app: 'com.epicgames.UnrealEditor' }), UserActiveError)
})

test('auto delivery switches to pid while the user is active, for an app known to accept it', async () => {
  const d = desktop({ idle: 200, known: ['com.epicgames.UnrealEditor'] })
  const result = await d.input.handle('key', { text: 'grave', target_app: 'com.epicgames.UnrealEditor' })
  assert.match(result.content[0].text, /delivery: pid .*because the user is active/)
  assert.deepEqual(d.calls.find(c => c[0] === 'keyToPid'), ['keyToPid', 4242, '`', undefined])
  // Auto never reinterprets coordinates: a screen point stays a screen point.
  await d.input.handle('left_click', { coordinate: [300, 300], target_window_id: 7 })
  assert.deepEqual(d.calls.find(c => c[0] === 'clickToPid'), ['clickToPid', 4242, 300, 300, 'left', 1, 7])
})

test('explicit pid delivery with target_window_id takes window-relative coordinates', async () => {
  const d = desktop()
  await d.input.handle('double_click', { coordinate: [10, 20], target_window_id: 7, delivery: 'pid' })
  assert.deepEqual(d.calls.find(c => c[0] === 'clickToPid'), ['clickToPid', 4242, 110, 50, 'left', 2, 7])
  await d.input.handle('scroll', { coordinate: [10, 20], direction: 'down', amount: 2, target_window_id: 7, delivery: 'pid' })
  assert.deepEqual(d.calls.find(c => c[0] === 'scrollToPid'), ['scrollToPid', 4242, 110, 50, 2, 0, 7])
  await d.input.handle('type', { text: 'stat fps', press_enter: true, target_app: 'com.epicgames.UnrealEditor', delivery: 'pid' })
  assert.ok(d.calls.some(c => c[0] === 'typeToPid' && c[2] === 'stat fps'))
  assert.ok(d.calls.some(c => c[0] === 'keyToPid' && c[2] === 'return'))
})

test('the first pid delivery to an app is verified by capture and recorded', async () => {
  const d = desktop()
  await d.input.handle('key', { text: 'a', target_app: 'com.epicgames.UnrealEditor', delivery: 'pid' })
  assert.equal(d.store.get('com.epicgames.UnrealEditor').keyboard.outcome, 'changed')
  assert.equal(d.store.knownGood('com.epicgames.UnrealEditor', 'keyboard'), true)
  assert.equal(d.store.knownGood('com.epicgames.UnrealEditor', 'pointer'), false, 'keys working says nothing about clicks')
})

test('pid delivery off macOS or without a target is refused with a structured error', async () => {
  const d = desktop()
  const linux = new InputHandler({ native: d.native, targets: d.targets, focus: { strategyFor: () => 'none', ensure: async () => ({}) }, platform: 'linux', sleep: async () => {} })
  await assert.rejects(linux.handle('key', { text: 'a', target_app: 'x', delivery: 'pid' }), error => error.details?.error === 'pid_delivery_unsupported')
  await assert.rejects(d.input.handle('key', { text: 'a', delivery: 'pid' }), error => error.details?.error === 'pid_target_missing')
  await assert.rejects(d.input.handle('mouse_move', { coordinate: [1, 1], delivery: 'pid' }), error => error.details?.error === 'pid_delivery_unsupported')
})

test('activation is refused while the user is active; reads are never blocked', async () => {
  const d = desktop({ idle: 100 })
  const context = { native: d.native, targets: d.targets, defaultProvider: 'auto', sleep: async () => {}, sleepAbortable: async () => false, runScript: async () => ({}), guard: d.guard }
  await assert.rejects(handleWindowTool('activate_app', { bundle_id: 'com.epicgames.UnrealEditor' }, context), UserActiveError)
  const forced = await handleWindowTool('activate_app', { bundle_id: 'com.epicgames.UnrealEditor', force: true }, context)
  assert.equal(JSON.parse(forced.content[0].text).activated, true)
  const listed = await handleWindowTool('list_windows', {}, context)
  assert.equal(listed.isError, undefined)
  const read = await handleAgentDesktopTool('read_window_text', { target_window_id: 7 }, d.context)
  assert.equal(read.isError, undefined)
})

test('the session returns user_active as a structured error result', async () => {
  const d = desktop({ idle: 50 })
  const session = createSession({
    native: d.native, macosHelper: null,
    userActivityGuard: createUserActivityGuard({ native: d.native, env: {}, platform: 'darwin' }),
  })
  const result = await session.dispatch('key', { text: 'return', target_app: 'com.epicgames.UnrealEditor' })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.error, 'user_active')
  const shot = await session.dispatch('list_windows', {})
  assert.equal(shot.isError, undefined)
})

// ── wait_for_window (R7) ─────────────────────────────────────────────────────

function windowSource(sequence) {
  let poll = 0
  return {
    native: {
      listWindows: () => sequence[Math.min(poll++, sequence.length - 1)],
      listDisplays: () => [{ x: 0, y: 0, width: 2000, height: 1000 }],
      getDisplaySize: () => ({ width: 2000, height: 1000 }),
    },
    polls: () => poll,
  }
}
const main = { windowId: 1, pid: 9, bundleId: 'app', title: 'Main', bounds: { x: 0, y: 0, width: 1600, height: 900 }, isOnScreen: true }
const dialog = { windowId: 2, pid: 9, bundleId: 'app', title: 'Save changes?', bounds: { x: 600, y: 300, width: 400, height: 200 }, isOnScreen: true }

test('wait_for_window returns as soon as a matching window appears', async () => {
  const source = windowSource([[main], [main], [main, dialog]])
  let clock = 0
  const sleeps = []
  const context = { native: source.native, targets: null, now: () => clock, sleepAbortable: async ms => { sleeps.push(ms); clock += ms; return false } }
  const result = await handleAgentDesktopTool('wait_for_window', { target_app: 'app', kind: 'dialog', timeout_ms: 5000 }, context)
  assert.equal(result.structuredContent.found, true)
  assert.equal(result.structuredContent.window.windowId, 2)
  assert.equal(result.structuredContent.window.kind, 'dialog')
  assert.equal(result.structuredContent.polls, 3)
  assert.deepEqual(sleeps, [250, 250])
})

test('wait_for_window waits for a window to go, times out, and honours cancellation', async () => {
  let clock = 0
  const tick = async ms => { clock += ms; return false }
  const gone = await handleAgentDesktopTool('wait_for_window', { target_app: 'app', title: 'save', gone: true, timeout_ms: 5000 },
    { native: windowSource([[main, dialog], [main]]).native, now: () => clock, sleepAbortable: tick })
  assert.equal(gone.structuredContent.gone, true)
  clock = 0
  const timeout = await handleAgentDesktopTool('wait_for_window', { target_app: 'app', kind: 'dialog', timeout_ms: 1000 },
    { native: windowSource([[main]]).native, now: () => clock, sleepAbortable: tick })
  assert.equal(timeout.structuredContent.error, 'timeout')
  assert.ok(timeout.structuredContent.waitedMs >= 1000)
  const controller = new AbortController()
  const cancelled = await handleAgentDesktopTool('wait_for_window', { target_app: 'app', kind: 'dialog', timeout_ms: 60000 },
    { native: windowSource([[main]]).native, signal: controller.signal, sleepAbortable: async () => { controller.abort(); return true } })
  assert.equal(cancelled.structuredContent.error, 'cancelled')
})

// ── ScreenCaptureKit capture path (R3) ───────────────────────────────────────

test('screenshot of a window goes through the helper with an exact mapping, and falls back on failure', async () => {
  const d = desktop()
  const handler = new ScreenshotHandler({
    native: { ...d.native, takeScreenshot: () => ({ base64: 'native', width: 10, height: 10, mimeType: 'image/jpeg', hash: 'n' }) },
    targets: d.targets, pointer: new VirtualPointerController(d.native), visionEnabled: true, defaultProvider: 'auto', env: {}, helper: d.helper,
  })
  const shot = await handler.handleAsync('screenshot', { target_app: 'com.epicgames.UnrealEditor' })
  assert.equal(shot.content[0].type, 'image')
  assert.match(shot.content[1].text, /ScreenCaptureKit/)
  assert.match(shot.content[1].text, /mapping is exact/)
  const failing = { ...d.helper, capture: async () => { throw new HelperFailure('screen_recording_denied', 'no') } }
  const fallback = new ScreenshotHandler({
    native: { ...d.native, takeScreenshot: () => ({ base64: 'native', width: 1000, height: 600, mimeType: 'image/jpeg', hash: 'n' }) },
    targets: d.targets, pointer: new VirtualPointerController(d.native), visionEnabled: true, defaultProvider: 'auto', env: {}, helper: failing,
  })
  const viaNative = await fallback.handleAsync('screenshot', { target_window_id: 7 })
  assert.equal(viaNative.content[0].data, 'native')
  assert.match(fallback.helperFailure(), /screen_recording_denied/)
})
