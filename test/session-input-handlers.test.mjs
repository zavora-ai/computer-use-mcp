import assert from 'node:assert/strict'
import test from 'node:test'
import { InputHandler } from '../dist/session/input-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'

function fixture({ platform = 'linux', sleep, execFile } = {}) {
  const calls = []
  let clipboard = 'original'
  const native = {
    calls,
    getDisplaySize: () => ({ width: 500, height: 400 }),
    getWindow: () => null,
    getFrontmostApp: () => ({ bundleId: 'app.front' }),
    mouseMove: (...args) => calls.push(['move', ...args]),
    mouseClick: (...args) => calls.push(['click', ...args]),
    mouseButton: (...args) => calls.push(['button', ...args]),
    mouseDrag: (...args) => calls.push(['drag', ...args]),
    mouseScroll: (...args) => calls.push(['scroll', ...args]),
    cursorPosition: () => ({ x: 7, y: 8 }),
    keyPress: (...args) => calls.push(['key', ...args]),
    holdKey: (...args) => calls.push(['hold', ...args]),
    typeText: (...args) => calls.push(['type', ...args]),
    readClipboard: () => clipboard,
    writeClipboard: value => { calls.push(['clipboard', value]); clipboard = value },
    findElement: () => [],
  }
  const targets = new TargetStateController(native, () => 100)
  const focus = {
    strategyFor: () => 'none',
    ensure: async () => ({}),
  }
  const handler = new InputHandler({
    native, targets, focus, platform, execFile,
    sleep: sleep ?? (async () => {}),
  })
  return { native, targets, handler, clipboard: () => clipboard }
}

test('extracted input handler validates clicks and records foreground provenance', async () => {
  const f = fixture()
  await f.handler.handle('left_click', { coordinate: [25, 30] })
  assert.deepEqual(f.native.calls.slice(0, 2), [['move', 25, 30], ['click', 25, 30, 'left', 1]])
  assert.equal(f.targets.current().bundleId, 'app.front')
  await assert.rejects(
    f.handler.handle('left_click', { coordinate: [500, 1] }),
    /outside display bounds/,
  )
})

test('long typing uses and restores the native clipboard on Linux', async () => {
  const f = fixture()
  await f.handler.handle('type', {
    text: 'line one\nline two', target_app: 'app.editor', focus_strategy: 'none',
  })
  assert.deepEqual(f.native.calls, [
    ['clipboard', 'line one\nline two'],
    ['key', 'ctrl+v'],
    ['clipboard', 'original'],
  ])
  assert.equal(f.clipboard(), 'original')
  assert.equal(f.targets.current().establishedBy, 'keyboard')
})

test('paste preserves a different value copied by the user while it settles', async () => {
  const f = fixture({ sleep: async () => { f.native.writeClipboard('user copied this') } })
  await f.handler.handle('type', { text: 'line one\nline two' })
  assert.equal(f.clipboard(), 'user copied this')
  assert.equal(f.native.calls.some(call => call[0] === 'clipboard' && call[1] === 'original'), false)
})

test('macOS clipboard paste restores unchanged text but preserves a concurrent copy', async () => {
  for (const userCopies of [false, true]) {
    let clipboard = 'original'
    const f = fixture({ platform: 'darwin',
      execFile: (command, _args, options) => {
        if (command === 'pbcopy') clipboard = options.input
        else assert.equal(command, 'pbpaste')
        return Buffer.from(clipboard)
      },
      sleep: async () => { if (userCopies) clipboard = 'new user text' },
    })
    await f.handler.handle('type', { text: 'line one\nline two' })
    assert.equal(clipboard, userCopies ? 'new user text' : 'original')
    assert.deepEqual(f.native.calls, [['key', 'command+v']])
  }
})

test('multi-edit checks cancellation between irreversible mutations', async () => {
  const controller = new AbortController()
  const f = fixture({
    sleep: async () => { controller.abort() },
  })
  await assert.rejects(
    f.handler.handle('multi_edit', { locs: [[10, 20, 'value']] }, controller.signal),
    /aborted before click/,
  )
  assert.deepEqual(f.native.calls, [['move', 10, 20]])
})

test('drag always emits a terminal release at the requested endpoint', async () => {
  const f = fixture()
  const result = await f.handler.handle('left_click_drag', {
    start_coordinate: [10, 10], coordinate: [42, 10],
  })
  assert.equal(result.content[0].text, 'Dragged to (42, 10)')
  assert.deepEqual(f.native.calls.at(-1), ['button', 'release', 42, 10])
  assert.equal(f.native.calls.some(call => call[0] === 'drag'), true)
})
