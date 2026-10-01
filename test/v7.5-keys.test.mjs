import assert from 'node:assert/strict'
import test from 'node:test'
import {
  charToUsCombo,
  normalizeHeldKeys,
  normalizeKeyCombo,
  UnknownKeyError,
  validKeyNames,
} from '../dist/session/keys.js'
import { InputHandler } from '../dist/session/input-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'

test('grave, backtick and ` all name the grave key; tilde adds shift', () => {
  for (const name of ['grave', 'backtick', 'GRAVE', '`', 'backquote']) assert.equal(normalizeKeyCombo(name, 'darwin'), '`')
  assert.equal(normalizeKeyCombo('tilde', 'darwin'), 'shift+`')
  assert.equal(normalizeKeyCombo('~', 'darwin'), 'shift+`')
  assert.equal(normalizeKeyCombo('cmd+tilde', 'darwin'), 'cmd+shift+`')
})

test('punctuation names resolve to their keys', () => {
  const expected = {
    minus: '-', equal: '=', leftbracket: '[', rightbracket: ']', backslash: '\\', semicolon: ';',
    quote: "'", comma: ',', period: '.', slash: '/', underscore: 'shift+-', plus: 'shift+=',
    question: 'shift+/', colon: 'shift+;', pipe: 'shift+\\',
  }
  for (const [name, combo] of Object.entries(expected)) assert.equal(normalizeKeyCombo(name, 'darwin'), combo, name)
})

test('existing combos pass through unchanged', () => {
  for (const combo of ['command+c', 'return', 'cmd+shift+4', 'shift+;', 'f11', 'ctrl+alt+delete', 'shift+tab']) {
    assert.equal(normalizeKeyCombo(combo, 'darwin'), combo)
  }
  assert.equal(normalizeKeyCombo('Return', 'darwin'), 'return')
  assert.equal(normalizeKeyCombo('shift+shift+a', 'darwin'), 'shift+a', 'modifiers deduplicated')
})

test('a literal plus key and platform names', () => {
  assert.equal(normalizeKeyCombo('+', 'darwin'), 'shift+=')
  assert.equal(normalizeKeyCombo('cmd++', 'darwin'), 'cmd+shift+=')
  assert.equal(normalizeKeyCombo('meta+a', 'linux'), 'cmd+a')
  assert.equal(normalizeKeyCombo('ctrl+win+f4', 'win32'), 'ctrl+win+f4')
  assert.equal(normalizeKeyCombo('super+a', 'darwin'), 'cmd+a')
  assert.equal(normalizeKeyCombo('forwarddelete', 'darwin'), 'forwarddelete')
  assert.equal(normalizeKeyCombo('forwarddelete', 'win32'), 'delete')
  assert.equal(normalizeKeyCombo('page_down', 'darwin'), 'pagedown')
})

test('an unknown key name is refused with the list of valid names', () => {
  assert.throws(() => normalizeKeyCombo('cmd+frobnicate', 'darwin'), error => {
    assert.ok(error instanceof UnknownKeyError)
    assert.match(error.message, /Unknown key "frobnicate"/)
    assert.match(error.message, /grave/)
    assert.match(error.message, /tilde/)
    return true
  })
  assert.ok(validKeyNames().includes('backtick'))
})

test('held keys expand aliases', () => {
  assert.deepEqual(normalizeHeldKeys(['tilde'], 'darwin'), ['shift', '`'])
  assert.deepEqual(normalizeHeldKeys(['shift', 'w'], 'darwin'), ['shift', 'w'])
})

test('US-ANSI character combos', () => {
  assert.equal(charToUsCombo('`'), '`')
  assert.equal(charToUsCombo('~'), 'shift+`')
  assert.equal(charToUsCombo('A'), 'shift+a')
  assert.equal(charToUsCombo('\n'), 'return')
  assert.equal(charToUsCombo('é'), undefined)
})

function fixture(extra = {}) {
  const calls = []
  const native = {
    getDisplaySize: () => ({ width: 500, height: 400 }),
    getWindow: () => null,
    getFrontmostApp: () => ({ bundleId: 'app.front' }),
    keyPress: (...args) => calls.push(['key', ...args]),
    typeText: (...args) => calls.push(['type', ...args]),
    holdKey: (...args) => calls.push(['hold', ...args]),
    ...extra,
  }
  const handler = new InputHandler({
    native, targets: new TargetStateController(native, () => 1),
    focus: { strategyFor: () => 'none', ensure: async () => ({}) },
    platform: 'linux', sleep: async () => {},
  })
  return { calls, handler }
}

test('key tool sends the resolved combo and explains a native refusal', async () => {
  const f = fixture()
  await f.handler.handle('key', { text: 'grave' })
  assert.deepEqual(f.calls, [['key', '`', undefined]])
  await assert.rejects(f.handler.handle('key', { text: 'cmd+bogus' }), /Valid keys:/)
  const g = fixture({ keyPress: () => { throw new Error('Unknown key in combo: f19') } })
  await assert.rejects(g.handler.handle('key', { text: 'f19' }), /key map lacks it\. Valid keys:/)
})

test('type mode keys uses the native table when present, keyPress per character otherwise', async () => {
  const native = fixture({ typeKeys: text => ({ keys: text.length, unicode: 0, layout: 'current_layout' }) })
  const viaNative = await native.handler.handle('type', { text: '`stat fps', mode: 'keys' })
  assert.match(viaNative.content[0].text, /Typed 9 keys \(layout: current_layout\)/)

  const f = fixture()
  const result = await f.handler.handle('type', { text: '~aé\n', mode: 'keys' })
  assert.deepEqual(f.calls, [['key', 'shift+`'], ['key', 'a'], ['type', 'é'], ['key', 'return']])
  assert.match(result.content[0].text, /Typed 3 keys and 1 character\(s\) as text/)
})

test('type mode keys never pastes long or multi-line text', async () => {
  const f = fixture({ writeClipboard: () => { throw new Error('must not paste') }, readClipboard: () => '' })
  await f.handler.handle('type', { text: 'a\nb', mode: 'keys' })
  assert.deepEqual(f.calls.map(call => call[1]), ['a', 'return', 'b'])
})
