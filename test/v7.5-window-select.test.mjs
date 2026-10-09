import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyAppWindows,
  classifyWindows,
  resolveAppWindow,
  selectMainWindow,
  WindowSelectionError,
} from '../dist/session/window-select.js'
import { handleWindowTool } from '../dist/session/window-handlers.js'
import { ScreenshotHandler } from '../dist/session/screenshot-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'
import { VirtualPointerController } from '../dist/session/virtual-pointer.js'

const display = { x: 0, y: 0, width: 1710, height: 1112 }
const win = (windowId, title, x, y, width, height, extra = {}) => ({
  windowId, bundleId: 'com.epicgames.UnrealEditor', displayName: 'UnrealEditor', pid: 77,
  title, bounds: { x, y, width, height }, isOnScreen: true, isFocused: false, displayId: 1, ...extra,
})

// Front-to-back, as CGWindowListCopyWindowInfo returns it: the toast is in front.
const unreal = [
  win(9001, null, 1340, 1000, 352, 81),
  win(1861, 'NairobiRacer - Unreal Editor', 0, 30, 1589, 927),
  win(1900, 'Message Log', 500, 300, 500, 300),
  win(1950, 'Content Browser', 1600, 100, 100, 600),
]

test('main window is the largest titled window, not the frontmost toast', () => {
  assert.equal(selectMainWindow(unreal).windowId, 1861)
})

test('a title filter picks the matching window, case-insensitively', () => {
  assert.equal(selectMainWindow(unreal, { title: 'message log' }).windowId, 1900)
  assert.equal(selectMainWindow(unreal, { title: 'nope' }), undefined)
})

test('ties go to the earlier (frontmost) window, and titled beats bigger untitled', () => {
  const same = [win(1, 'A', 0, 0, 100, 100), win(2, 'B', 10, 10, 100, 100)]
  assert.equal(selectMainWindow(same).windowId, 1)
  const untitledBig = [win(3, null, 0, 0, 2000, 1000), win(4, 'Small', 0, 0, 200, 100)]
  assert.equal(selectMainWindow(untitledBig).windowId, 4)
  // No titles at all (Screen Recording not granted): the largest wins.
  const noTitles = [win(5, null, 0, 0, 300, 80), win(6, null, 0, 0, 1500, 900)]
  assert.equal(selectMainWindow(noTitles).windowId, 6)
})

test('kinds: main, toast, dialog, panel and other from geometry', () => {
  const kinds = Object.fromEntries(classifyAppWindows(unreal, [display]).map(w => [w.windowId, w.kind]))
  assert.deepEqual(kinds, { 9001: 'toast', 1861: 'main', 1900: 'dialog', 1950: 'panel' })
  const floating = classifyAppWindows([...unreal, win(2000, null, 700, 400, 200, 100)], [display])
  assert.equal(floating.find(w => w.windowId === 2000).kind, 'other', 'untitled but far from an edge')
  const doc = classifyAppWindows([...unreal, win(2100, 'Level 2', 100, 100, 1400, 800)], [display])
  assert.equal(doc.find(w => w.windowId === 2100).kind, 'document')
  for (const entry of doc) {
    assert.equal(entry.kindSource, 'heuristic')
    assert.equal(entry.area, entry.bounds.width * entry.bounds.height)
  }
})

test('AX subroles win over heuristics and fill a hidden title', () => {
  const ax = [
    { title: 'Save Changes?', role: 'AXWindow', subrole: 'AXDialog', modal: true, bounds: { x: 1600, y: 100, width: 100, height: 600 } },
    { title: 'Editor', role: 'AXWindow', subrole: 'AXStandardWindow', modal: false, bounds: { x: 0, y: 30, width: 1589, height: 927 } },
  ]
  const hidden = unreal.map(w => (w.windowId === 1861 ? { ...w, title: null } : w))
  const out = classifyAppWindows(hidden, [display], ax)
  const panel = out.find(w => w.windowId === 1950)
  assert.equal(panel.kind, 'dialog')
  assert.equal(panel.kindSource, 'ax')
  assert.equal(panel.subrole, 'AXDialog')
  const main = out.find(w => w.windowId === 1861)
  assert.equal(main.title, 'Editor')
})

test('classifyWindows groups per process and keeps order and duplicates', () => {
  const other = { ...win(5, 'Doc', 0, 0, 800, 600), pid: 12, bundleId: 'com.apple.TextEdit' }
  const out = classifyWindows([unreal[0], other, unreal[1]], [display])
  assert.deepEqual(out.map(w => [w.windowId, w.kind]), [[9001, 'toast'], [5, 'main'], [1861, 'main']])
})

test('resolveAppWindow explains a title miss and is quiet when the app has no window', () => {
  const native = { listWindows: bundle => (bundle === 'com.epicgames.UnrealEditor' ? unreal : []) }
  assert.equal(resolveAppWindow(native, 'com.epicgames.UnrealEditor').windowId, 1861)
  assert.equal(resolveAppWindow(native, 'app.none'), undefined)
  assert.throws(() => resolveAppWindow(native, 'com.epicgames.UnrealEditor', 'Output Log'), error => {
    assert.ok(error instanceof WindowSelectionError)
    assert.equal(error.details.error, 'window_not_found')
    assert.equal(error.details.windows.length, 4)
    return true
  })
})

test('list_windows reports kinds and consults AX only for a single app', async () => {
  const axCalls = []
  const native = {
    listWindows: bundle => (bundle ? unreal : unreal),
    listDisplays: () => [display],
    getDisplaySize: () => display,
    getWindowAxInfo: pid => { axCalls.push(pid); return [] },
  }
  const context = {
    native, targets: new TargetStateController(native), defaultProvider: 'auto',
    sleep: async () => {}, sleepAbortable: async () => false, runScript: async () => ({}),
  }
  const all = await handleWindowTool('list_windows', {}, context)
  assert.equal(all.structuredContent.windows.find(w => w.windowId === 9001).kind, 'toast')
  assert.deepEqual(axCalls, [])
  await handleWindowTool('list_windows', { bundle_id: 'com.epicgames.UnrealEditor' }, context)
  assert.deepEqual(axCalls, [77])
})

test('screenshot target_app captures the main window and target_title another', () => {
  const calls = []
  const native = {
    listWindows: () => unreal,
    getWindow: id => unreal.find(w => w.windowId === id) ?? null,
    getFrontmostApp: () => null,
    getDisplaySize: () => display,
    takeScreenshot: (...args) => { calls.push(args); return { base64: 'x', width: 1589, height: 927, mimeType: 'image/jpeg', hash: String(calls.length) } },
  }
  const handler = new ScreenshotHandler({
    native, targets: new TargetStateController(native), pointer: new VirtualPointerController(native),
    visionEnabled: true, defaultProvider: 'auto', env: {},
  })
  handler.handle('screenshot', { target_app: 'com.epicgames.UnrealEditor' })
  assert.equal(calls[0][1], undefined, 'native is given the chosen window, not the bundle')
  assert.equal(calls[0][4], 1861)
  handler.handle('screenshot', { target_app: 'com.epicgames.UnrealEditor', target_title: 'Message' })
  assert.equal(calls[1][4], 1900)
  const miss = handler.handle('screenshot', { target_app: 'com.epicgames.UnrealEditor', target_title: 'zzz' })
  assert.equal(miss.isError, true)
  assert.equal(miss.structuredContent.error, 'window_not_found')
})
