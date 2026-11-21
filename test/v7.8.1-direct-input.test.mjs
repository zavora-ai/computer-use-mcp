// 7.8.1: what a mouse-and-keyboard-only Blender session needed (the Blender 5.3 features video). Modifiers held through
// a click or scroll, keys held or pressed during a drag, pen pressure, and the numeric keypad. The native halves were
// checked in Blender 5.3.0 on macOS 26.2; these tests pin the server's half with a fake native module.
import assert from 'node:assert/strict'
import test from 'node:test'
import { InputHandler, pressureAt } from '../dist/session/input-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'
import { normalizeHeldKeys, normalizeKeyCombo, validKeyNames } from '../dist/session/keys.js'

function fixture({ platform = 'darwin', native: extra = {} } = {}) {
  const calls = []
  const native = {
    calls,
    getDisplaySize: () => ({ width: 1280, height: 1024 }),
    getWindow: () => null,
    getFrontmostApp: () => ({ bundleId: 'org.blenderfoundation.blender' }),
    mouseMove: (...args) => calls.push(['move', ...args]),
    mouseClick: (...args) => calls.push(['click', ...args]),
    mouseScroll: (...args) => calls.push(['scroll', ...args]),
    mousePress: (...args) => calls.push(['press', ...args]),
    mouseDragTo: (...args) => calls.push(['dragTo', ...args]),
    mouseRelease: (...args) => calls.push(['release', ...args]),
    keyPress: (...args) => calls.push(['key', ...args]),
    keyDown: (...args) => calls.push(['keyDown', ...args]),
    keyUp: (...args) => calls.push(['keyUp', ...args]),
    cursorPosition: () => ({ x: 0, y: 0 }),
    ...extra,
  }
  const targets = new TargetStateController(native, () => 100)
  const focus = { strategyFor: () => 'none', ensure: async () => ({}) }
  const handler = new InputHandler({ native, targets, focus, platform, sleep: async () => {} })
  return { native, calls, handler }
}

const text = result => result.content.map(block => block.text).join('\n')
const kinds = calls => calls.map(call => call[0])

test('click with modifiers uses the native modified click on macOS (keys pressed around it)', async () => {
  const f = fixture({ native: { mouseClickModified: (...args) => f.calls.push(['clickModified', ...args]) } })
  const result = await f.handler.handle('click', { coordinate: [700, 600], modifiers: ['alt'] })
  assert.deepEqual(f.calls.filter(call => call[0] !== 'move'), [['clickModified', 700, 600, 'left', 1, ['alt']]])
  assert.match(text(result), /Clicked \(700, 600\) with alt/)
})

test('click with modifiers falls back to press and release per click elsewhere', async () => {
  const f = fixture({ platform: 'win32' })
  await f.handler.handle('click', { coordinate: [10, 20], count: 2, modifiers: ['shift', 'ctrl', 'shift'] })
  assert.deepEqual(f.calls.filter(call => call[0] !== 'move'), [
    ['press', 10, 20, 'left', ['shift', 'ctrl']], ['release', 10, 20, 'left', ['shift', 'ctrl']],
    ['press', 10, 20, 'left', ['shift', 'ctrl']], ['release', 10, 20, 'left', ['shift', 'ctrl']],
  ])
})

test('click refuses a modifier outside shift, ctrl, alt, cmd before anything moves', async () => {
  const f = fixture()
  await assert.rejects(f.handler.handle('click', { coordinate: [10, 20], modifiers: ['hyper'] }), /Invalid modifiers/)
  assert.deepEqual(f.calls, [])
})

test('click hold_keys holds the keys across the click and releases them even when the click throws', async () => {
  const f = fixture()
  await f.handler.handle('click', { coordinate: [270, 780], hold_keys: ['c'] })
  assert.deepEqual(kinds(f.calls), ['move', 'keyDown', 'click', 'keyUp'])
  assert.deepEqual(f.calls[1], ['keyDown', ['c']])
  assert.deepEqual(f.calls[3], ['keyUp', ['c']])

  const g = fixture({ native: { mouseClick: () => { throw new Error('click failed') } } })
  await assert.rejects(g.handler.handle('click', { coordinate: [1, 1], hold_keys: ['tilde'] }), /click failed/)
  assert.deepEqual(g.calls.filter(call => call[0] === 'keyUp'), [['keyUp', ['shift', '`']]])
})

test('click hold_keys refuses an unknown key with nothing pressed', async () => {
  const f = fixture()
  await assert.rejects(f.handler.handle('click', { coordinate: [1, 1], hold_keys: ['nokey'] }), /Unknown key/)
  assert.deepEqual(f.calls, [])
})

test('scroll with modifiers: the native modified scroll on macOS, held keys elsewhere', async () => {
  const mac = fixture({ native: { mouseScrollModified: (...args) => mac.calls.push(['scrollModified', ...args]) } })
  const result = await mac.handler.handle('scroll', { coordinate: [5, 5], direction: 'up', amount: 2, modifiers: ['ctrl'] })
  assert.deepEqual(mac.calls.at(-1), ['scrollModified', -2, 0, ['ctrl']])
  assert.match(text(result), /with ctrl/)

  const linux = fixture({ platform: 'linux' })
  await linux.handler.handle('scroll', { coordinate: [5, 5], direction: 'right', amount: 1, modifiers: ['shift'] })
  assert.deepEqual(linux.calls.slice(-3), [['keyDown', ['shift']], ['scroll', 0, 1], ['keyUp', ['shift']]])
})

test('mouse_drag presses keys mid-drag at the waypoint asked, with the button still down', async () => {
  const f = fixture()
  const result = await f.handler.handle('mouse_drag', {
    path: [[370, 780], [420, 780], [470, 780]], steps: 2, key_presses: [{ at: 2, key: 'v' }, { at: 0, key: 'shift+r' }],
  })
  const sequence = f.calls.filter(call => call[0] !== 'move').map(call => call[0] === 'key' ? `key:${call[1]}` : call[0])
  assert.deepEqual(sequence, ['press', 'key:shift+r', 'dragTo', 'dragTo', 'dragTo', 'dragTo', 'key:v', 'release'])
  assert.match(text(result), /pressing v at waypoint 2, shift\+r at waypoint 0/)
})

test('mouse_drag refuses a key press at a waypoint the path does not have, before anything moves', async () => {
  const f = fixture()
  await assert.rejects(
    f.handler.handle('mouse_drag', { path: [[1, 1], [2, 2]], key_presses: [{ at: 2, key: 'r' }] }),
    /key_presses\[0\]\.at: expected a waypoint index from 0 to 1/,
  )
  await assert.rejects(f.handler.handle('mouse_drag', { path: [[1, 1], [2, 2]], key_presses: [{ at: 1, key: 'nokey' }] }), /Unknown key/)
  assert.deepEqual(f.calls, [])
})

test('mouse_drag hold_keys wraps the whole gesture, and the keys come up after the release', async () => {
  const f = fixture()
  await f.handler.handle('mouse_drag', { path: [[300, 700], [450, 650]], steps: 1, hold_keys: ['d'] })
  assert.deepEqual(kinds(f.calls), ['move', 'keyDown', 'press', 'dragTo', 'release', 'keyUp'])
})

test('mouse_drag as a pen: press, drags and release carry pressure, and the release is at 1.0', async () => {
  const events = []
  const f = fixture({ native: { mousePenEvent: (...args) => events.push(args) } })
  const result = await f.handler.handle('mouse_drag', {
    path: [[0, 0], [10, 0], [20, 0]], steps: 2, pressure: [0.1, 1, 0.1], modifiers: ['ctrl'],
  })
  assert.deepEqual(events.map(event => event[4]), [0, 1, 1, 1, 1, 2])
  assert.deepEqual(events.map(event => Number(event[5].toFixed(3))), [0.1, 0.55, 1, 0.55, 0.1, 1])
  assert.ok(events.every(event => event[2] === 'left' && event[3].join() === 'ctrl'))
  assert.deepEqual(events.at(-1).slice(0, 2), [20, 0])
  assert.equal(f.calls.some(call => call[0] === 'press' || call[0] === 'release'), false)
  assert.match(text(result), /as a pen at pressure 0\.1→1→0\.1/)
})

test('mouse_drag as a pen releases at full pressure even when aborted', async () => {
  const events = []
  const f = fixture({ native: { mousePenEvent: (...args) => events.push(args) } })
  const controller = new AbortController()
  let moves = 0
  f.native.mousePenEvent = (...args) => { events.push(args); if (args[4] === 1 && ++moves === 2) controller.abort() }
  await assert.rejects(f.handler.handle('mouse_drag', { path: [[0, 0], [40, 0]], steps: 8, pressure: 0.5 }, controller.signal))
  assert.deepEqual(events.at(-1).slice(4), [2, 1])
})

test('mouse_drag refuses pressure where there is no pen, and a value outside 0-1', async () => {
  const linux = fixture({ platform: 'linux' })
  const refused = await linux.handler.handle('mouse_drag', { path: [[0, 0], [5, 5]], pressure: 0.5 }).then(
    () => assert.fail('expected a refusal'), error => error)
  assert.equal(refused.details.error, 'pressure_unsupported')
  assert.deepEqual(linux.calls, [])

  const oldMac = fixture()
  await assert.rejects(oldMac.handler.handle('mouse_drag', { path: [[0, 0], [5, 5]], pressure: 0.5 }), /pen pressure is unavailable/)
  await assert.rejects(oldMac.handler.handle('mouse_drag', { path: [[0, 0], [5, 5]], pressure: [0.5, 1.5] }), /Invalid pressure/)
  assert.deepEqual(oldMac.calls, [])
})

test('pressureAt spreads values evenly along the stroke', () => {
  assert.equal(pressureAt([0.4], 0.7), 0.4)
  assert.equal(pressureAt([0, 1], 0.25), 0.25)
  assert.equal(pressureAt([0.2, 1, 0.2], 0.5), 1)
  assert.equal(pressureAt([0.2, 1, 0.2], 1), 0.2)
  assert.equal(pressureAt([0, 1], -1), 0)
  assert.equal(pressureAt([0, 1], 2), 1)
})

test('modifiers and hold_keys are refused with pid delivery rather than silently dropped', async () => {
  const f = fixture({ native: {
    mouseClickToPid: () => assert.fail('must not post'), keyPressToPid: () => {}, typeTextToPid: () => {},
    listRunningApps: () => [{ bundleId: 'org.blenderfoundation.blender', pid: 42 }],
    listWindows: () => [],
  } })
  await assert.rejects(
    f.handler.handle('click', { coordinate: [5, 5], modifiers: ['alt'], delivery: 'pid', target_app: 'org.blenderfoundation.blender' }),
    /cannot hold keys with pid delivery/,
  )
})

test('the numeric keypad has names on every platform, with spellings agents reach for', () => {
  for (let digit = 0; digit <= 9; digit++) {
    assert.equal(normalizeKeyCombo(`numpad${digit}`, 'darwin'), `numpad${digit}`)
    assert.equal(normalizeKeyCombo(`kp${digit}`, 'win32'), `numpad${digit}`)
    assert.equal(normalizeKeyCombo(`kp_${digit}`, 'linux'), `numpad${digit}`)
  }
  assert.equal(normalizeKeyCombo('numpad.', 'darwin'), 'numpad_decimal')
  assert.equal(normalizeKeyCombo('numpad_period', 'darwin'), 'numpad_decimal')
  assert.equal(normalizeKeyCombo('numpad_plus', 'darwin'), 'numpad_add')
  assert.equal(normalizeKeyCombo('numpad-', 'darwin'), 'numpad_subtract')
  assert.equal(normalizeKeyCombo('numpad*', 'darwin'), 'numpad_multiply')
  assert.equal(normalizeKeyCombo('numpad/', 'darwin'), 'numpad_divide')
  assert.equal(normalizeKeyCombo('ctrl+numpad0', 'darwin'), 'ctrl+numpad0')
  assert.deepEqual(normalizeHeldKeys(['numpad_enter'], 'linux'), ['numpad_enter'])
  assert.ok(validKeyNames().includes('numpad_decimal'))
})

test('type sends short text to Blender as key events on macOS, unless a mode is asked for', async () => {
  const typed = []
  const native = { typeKeys: text => { typed.push(['keys', text]); return { keys: text.length, unicode: 0, layout: 'us' } },
    typeText: text => typed.push(['text', text]) }
  const blender = fixture({ native })
  const result = await blender.handler.handle('type', { text: 'Relax Edge Loops', target_app: 'org.blenderfoundation.blender' })
  assert.match(text(result), /as key events/)
  await blender.handler.handle('type', { text: 'Relax', target_app: 'org.blenderfoundation.blender', mode: 'text' })
  // No target: the frontmost app decides (the fixture's frontmost app is Blender).
  await blender.handler.handle('type', { text: 'Quad' })
  assert.deepEqual(typed, [['keys', 'Relax Edge Loops'], ['text', 'Relax'], ['keys', 'Quad']])

  typed.length = 0
  const other = fixture({ native: { ...native, getFrontmostApp: () => ({ bundleId: 'com.apple.TextEdit' }) } })
  await other.handler.handle('type', { text: 'hello' })
  const linux = fixture({ platform: 'linux', native })
  await linux.handler.handle('type', { text: 'hello', target_app: 'org.blenderfoundation.blender' })
  assert.deepEqual(typed, [['text', 'hello'], ['text', 'hello']])
})
