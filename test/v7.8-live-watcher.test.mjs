// 7.8 live share: the session's screen watcher, stepped sample by sample over a fake helper, window list and the
// person's controls.
import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveWatcher } from '../dist/session/live-watcher.js'

const DISPLAY = { x: 0, y: 0, width: 1440, height: 900 }
const flush = () => new Promise(resolve => setImmediate(resolve))

function rig({ diffs = [], windows = [], front = { bundleId: 'com.apple.Terminal' }, platform = 'darwin', sensitive = [] } = {}) {
  let clock = 0
  const timers = []
  const captures = []
  const state = { control: 'running', locked: false, windows, front, diffs: [...diffs] }
  const watchingCalls = []
  const helper = {
    supportsCapture: () => true,
    capture: async options => {
      captures.push(options)
      if (!options.diff) return { data: Buffer.from('FULL'), mimeType: 'image/jpeg', width: options.width, height: 800, frame: DISPLAY, hash: 'f', scale: 1, path: '', bytes: 4 }
      const diff = state.diffs.length ? state.diffs.shift() : { changed: false, area: 0 }
      return diff.changed
        ? { data: Buffer.from('S'), mimeType: 'image/jpeg', width: 640, height: 400, frame: DISPLAY, hash: 'x', scale: 0.44, path: '', bytes: 1, diff }
        : { data: Buffer.alloc(0), unchanged: true, width: 640, height: 400, frame: DISPLAY, scale: 0.44, diff }
    },
  }
  const native = {
    listWindows: () => state.windows,
    getFrontmostApp: () => state.front,
    getWindow: id => state.windows.find(window => window.windowId === id) ?? null,
    getDisplaySize: () => ({ width: 1440, height: 900 }),
    getSessionState: () => ({ locked: state.locked }),
    takeScreenshot: (width, _app, _quality, previousHash) => ({ width, height: 400, mimeType: 'image/jpeg', hash: state.diffs.shift() ?? previousHash ?? 'h0', base64: 'N', unchanged: false }),
  }
  const control = { state: () => state.control, watching: info => watchingCalls.push(info) }
  const watcher = new LiveWatcher({
    native, helper, control, platform, sensitiveApps: sensitive,
    now: () => clock,
    gate: { settleMs: 600, maxDelayMs: 3000 },
    setTimer: (run, ms) => { const timer = { run, ms, cancelled: false, cancel() { this.cancelled = true } }; timers.push(timer); return timer },
  })
  /** Advance the clock by one interval and run the scheduled sample. */
  const step = async (ms = 500) => {
    const timer = timers.filter(entry => !entry.cancelled).at(-1)
    timers.length = 0
    clock += ms
    timer?.run()
    await flush(); await flush()
  }
  return { watcher, state, captures, watchingCalls, step, timers, setClock: value => { clock = value } }
}

const win = (windowId, bundleId, title, extra = {}) => ({ windowId, bundleId, displayName: bundleId, pid: windowId * 10, title, bounds: { x: 100, y: 100, width: 800, height: 600 }, isOnScreen: true, isFocused: false, displayId: 1, ...extra })

test('a watch samples through the helper with comparison and turns a settled burst into one screen event', async () => {
  const r = rig({ diffs: [
    { changed: true, area: 1, first: true },
    { changed: true, area: 0.04, dirty: { x: 0.25, y: 0.5, width: 0.5, height: 0.2 } },
    { changed: true, area: 0.06, dirty: { x: 0.25, y: 0.45, width: 0.5, height: 0.25 } },
  ] })
  const status = r.watcher.start()
  assert.equal(status.watching, true)
  assert.equal(status.target, 'the screen')
  assert.equal(r.watchingCalls[0].target, 'the screen', 'the card is told')
  for (let i = 0; i < 6; i++) await r.step()
  const sample = r.captures[0]
  assert.equal(sample.displayId, 'main')
  assert.equal(sample.width, 640)
  assert.equal(sample.diff, true)
  assert.equal(sample.skipUnchanged, true)
  assert.deepEqual(sample.overlayPids, [process.pid])
  const screens = r.watcher.events().filter(event => event.kind === 'screen')
  assert.equal(screens.length, 1, 'the first sample is a baseline; two changes are one burst')
  const event = screens[0]
  assert.equal(event.area, 0.06)
  assert.equal(event.settled, true)
  assert.equal(event.cause, 'other')
  assert.deepEqual(event.region, { x: 360, y: 405, width: 720, height: 225 }, 'in screen points, ready for click')
  assert.equal(r.watcher.status().samples, 6)
})

test('windows opening and closing, focus and title changes are events; the first look is the baseline', async () => {
  const editor = win(1, 'com.apple.TextEdit', 'notes.txt', { isFocused: true })
  const r = rig({ windows: [editor], front: { bundleId: 'com.apple.TextEdit' } })
  r.watcher.start()
  await r.step()
  assert.deepEqual(r.watcher.events().map(event => event.kind), ['watch_started'])
  r.state.windows = [editor, win(2, 'com.apple.TextEdit', 'Save As')]
  await r.step()
  r.state.windows = [{ ...editor, title: 'notes.txt — Edited' }]
  await r.step()
  r.state.front = { bundleId: 'com.apple.Safari' }
  await r.step()
  const kinds = r.watcher.events().map(event => `${event.kind}:${event.title ?? event.app ?? ''}`)
  assert.deepEqual(kinds, ['watch_started:', 'window_opened:Save As', 'title_changed:notes.txt — Edited', 'window_closed:Save As', 'focus_changed:com.apple.Safari'])
  assert.equal(r.watcher.events().at(-1).title, null, 'the focused window belongs to TextEdit, not to the new frontmost app')
})

test('a window watch keeps its burst when the person switches between other apps, and reports focus only for its own app', async () => {
  // Found live on 2026-10-25: the person moving between Chrome and Claude reset the gate, so a build failure in the
  // watched window never became an event.
  const build = win(7, 'ai.test.build', 'Build status', { isFocused: false })
  const r = rig({ windows: [build], front: { bundleId: 'com.google.Chrome' }, diffs: [
    { changed: true, area: 1, first: true },
    { changed: true, area: 0.05, dirty: { x: 0.1, y: 0.2, width: 0.6, height: 0.3 } },
  ] })
  r.watcher.start({ windowId: 7 })
  await r.step()
  await r.step()
  r.state.front = { bundleId: 'com.anthropic.claudefordesktop' }
  await r.step()
  r.state.front = { bundleId: 'com.google.Chrome' }
  await r.step(); await r.step()
  const kinds = r.watcher.events().map(event => event.kind)
  assert.ok(kinds.includes('screen'), `the change in the watched window survives: ${kinds.join(' ')}`)
  assert.ok(!kinds.includes('focus_changed'), 'switching between two other apps is not news to this watch')
  r.state.front = { bundleId: 'ai.test.build' }
  await r.step()
  assert.equal(r.watcher.events().at(-1).kind, 'focus_changed', 'the watched app coming forward is')
})

test('changes made while the agent acts are marked as its own', async () => {
  const r = rig({ diffs: [{ changed: true, area: 1, first: true }, { changed: true, area: 0.1, dirty: { x: 0, y: 0.2, width: 0.5, height: 0.5 } }] })
  r.watcher.start()
  await r.step()
  r.watcher.agentActing(true)
  await r.step()
  r.watcher.agentActing(false)
  for (let i = 0; i < 3; i++) await r.step()
  const screen = r.watcher.events().find(event => event.kind === 'screen')
  assert.equal(screen.cause, 'agent')
})

test('Pause and a locked screen stop the sampling; Stop ends the watch', async () => {
  const r = rig()
  r.watcher.start()
  await r.step()
  const before = r.captures.length
  r.state.control = 'paused'
  await r.step(); await r.step()
  assert.equal(r.captures.length, before, 'nothing is sampled while paused')
  assert.equal(r.watcher.status().paused, true)
  await assert.rejects(r.watcher.latestFrame(), error => error.code === 'paused_by_user', 'and no frame is served')
  r.state.control = 'running'
  await r.step()
  r.state.locked = true
  await r.step()
  assert.deepEqual(r.watcher.events().filter(event => ['paused', 'resumed'].includes(event.kind)).map(event => `${event.kind}:${event.reason}`),
    ['paused:paused_by_user', 'resumed:running', 'paused:screen_locked'])
  r.state.locked = false
  r.state.control = 'stopped'
  await r.step()
  assert.equal(r.watcher.watching, false)
  assert.equal(r.watcher.status().stoppedReason, 'stopped_by_user')
  assert.equal(r.watchingCalls.at(-1), null, 'the card is told the watch ended')
  assert.throws(() => r.watcher.start(), error => error.code === 'stopped_by_user', 'a stopped session cannot watch again')
})

test('nothing is sampled or served while a credential manager is frontmost, and its titles are not reported', async () => {
  const r = rig({ windows: [win(1, 'com.apple.Terminal', 'zsh', { isFocused: true })], front: { bundleId: 'com.apple.Terminal' }, sensitive: ['com.1password.1password'] })
  r.watcher.start()
  await r.step()
  const before = r.captures.length
  r.state.front = { bundleId: 'com.1password.1password' }
  r.state.windows = [win(1, 'com.apple.Terminal', 'zsh'), win(3, 'com.1password.1password', 'Bank login', { isFocused: true })]
  await r.step(); await r.step()
  assert.equal(r.captures.length, before)
  assert.equal(r.watcher.status().sensitive, true)
  await assert.rejects(r.watcher.latestFrame(), error => error.code === 'sensitive_app_frontmost')
  const events = r.watcher.events()
  assert.ok(events.some(event => event.kind === 'focus_changed' && event.sensitive === true && event.title === null))
  assert.ok(events.every(event => event.title !== 'Bank login'))
})

test('waitForEvents returns as soon as an event lands, or empty after the timeout', async () => {
  const r = rig({ windows: [], front: { bundleId: 'a' } })
  r.watcher.start()
  const since = r.watcher.status().lastSeq
  const waiting = r.watcher.waitForEvents(since, 5_000)
  await r.step()
  r.state.front = { bundleId: 'b' }
  await r.step()
  const events = await waiting
  assert.equal(events[0].kind, 'focus_changed')
  const none = await r.watcher.waitForEvents(r.watcher.status().lastSeq, 20)
  assert.deepEqual(none, [])
})

test('a frame for a model is a full capture of the target, with its screen area', async () => {
  const r = rig()
  r.watcher.start()
  const frame = await r.watcher.latestFrame({ width: 1024 })
  assert.equal(frame.data, Buffer.from('FULL').toString('base64'))
  assert.deepEqual(frame.frame, DISPLAY)
  assert.equal(r.captures.at(-1).width, 1024)
  assert.equal(r.captures.at(-1).diff, undefined, 'not a sample: no comparison')
  await assert.rejects(new LiveWatcher({ native: {}, platform: 'darwin' }).latestFrame(), error => error.code === 'not_watching')
})

test('without the helper (Windows, Linux) the native capture says that something changed, not where', async () => {
  const r = rig({ platform: 'linux', diffs: ['h1', 'h1', 'h2', 'h2', 'h2', 'h2'] })
  r.watcher.start()
  for (let i = 0; i < 6; i++) await r.step()
  assert.equal(r.watcher.status().source, 'native')
  const screens = r.watcher.events().filter(event => event.kind === 'screen')
  assert.equal(screens.length, 1)
  assert.equal(screens[0].area, 1)
  assert.equal(screens[0].region, undefined)
})

test('a helper that keeps failing stops the watch with the reason', async () => {
  let calls = 0
  const failing ={ supportsCapture: () => true, capture: async () => { calls++; throw Object.assign(new Error('Screen Recording is off'), { code: 'x' }) } }
  const w = new LiveWatcher({ native: { listWindows: () => [], getFrontmostApp: () => null, getDisplaySize: () => DISPLAY }, helper: failing, platform: 'darwin',
    setTimer: (run) => { queueMicrotask(run); return { cancel() {} } } })
  w.start()
  for (let i = 0; i < 10 && w.watching; i++) await flush()
  assert.equal(w.watching, false)
  assert.match(w.status().stoppedReason, /capture_failed: Screen Recording is off/)
  assert.equal(calls, 3, 'three failures in a row, then it gives up')
})
