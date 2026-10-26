// 7.6.1: operator control (pause, stop, the desktop status card). Fake presenter, fake native, no window.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OperatorControl, describeAction, statusCardEnabled } from '../dist/session/operator-control.js'
import { createSession } from '../dist/session.js'
import { listedTools, buildInstructions } from '../dist/instructions.js'

const fakePresenter = () => {
  const calls = []
  return { kind: 'fake', calls, start: directory => { calls.push(['start', directory]) }, stop: () => { calls.push(['stop']) } }
}
const frame = directory => JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

test('the state machine refuses mutations while paused or stopped, and reads keep working', async () => {
  const native = { triggered: 0, triggerNativeEmergencyStop() { this.triggered++ }, isNativeEmergencyStopActive() { return this.triggered > 0 } }
  const presenter = fakePresenter()
  const directory = mkdtempSync(join(tmpdir(), 'card-test-'))
  const control = new OperatorControl({ native, card: { presenter, directory, pollMs: 10 } })
  assert.equal(control.gate('click'), undefined)
  control.begin({ tool: 'click', label: 'click (10, 10)', app: 'com.example.app', window: 'Doc' })
  await settle()
  assert.deepEqual(presenter.calls[0], ['start', directory], 'the card is launched on the first tracked call')
  assert.equal(frame(directory).action.label, 'click (10, 10)')
  const before = control.signal()
  control.pause('person')
  assert.equal(control.state(), 'paused')
  assert.equal(before.aborted, true, 'the call in flight is aborted')
  const refusal = control.gate('type')
  assert.equal(refusal.error, 'paused_by_user')
  assert.match(refusal.hint, /Observation tools still work/)
  assert.equal(frame(directory).state, 'paused')
  assert.equal(readFileSync(join(directory, 'control.txt'), 'utf8'), 'paused')
  control.resume('person')
  assert.equal(control.gate('type'), undefined)
  assert.equal(control.signal().aborted, false, 'a fresh signal after resume')
  control.stop('person')
  assert.equal(control.gate('key').error, 'stopped_by_user')
  assert.equal(native.triggered, 1, 'Stop trips the native emergency-stop latch')
  assert.equal(control.status().emergencyStop.latched, true)
  control.resume('person')
  assert.equal(control.state(), 'stopped', 'stopped is terminal for the session')
  control.close()
  assert.deepEqual(presenter.calls.at(-1), ['stop'])
  assert.equal(existsSync(directory), false, 'the directory is removed on close')
})

test('what the card writes is applied: control.txt drives the state', async () => {
  const presenter = fakePresenter()
  const directory = mkdtempSync(join(tmpdir(), 'card-test-'))
  const control = new OperatorControl({ card: { presenter, directory, pollMs: 10 } })
  control.begin({ tool: 'screenshot', label: 'screenshot' })
  writeFileSync(join(directory, 'control.txt'), 'paused')
  assert.equal(control.state(), 'paused', 'read on demand')
  assert.equal(control.status().reason, 'person')
  writeFileSync(join(directory, 'control.txt'), 'running')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(control.status().state, 'running', 'and by the poll')
  writeFileSync(join(directory, 'control.txt'), 'garbage')
  assert.equal(control.state(), 'running', 'an unknown value is ignored')
  control.close()
})

test('the frame is honest: tool, key argument, app and window; typed text is never written', () => {
  assert.deepEqual(describeAction('click', { coordinate: [120, 340] }, { app: 'com.apple.TextEdit', window: 'Untitled' }),
    { tool: 'click', label: 'click (120, 340)', app: 'com.apple.TextEdit', window: 'Untitled' })
  assert.equal(describeAction('type', { text: 'hunter2 is my password' }, {}).label, 'type 22 chars')
  assert.equal(describeAction('run_script', { language: 'applescript', script: 'tell app "Finder" to quit' }, {}).label, 'run_script applescript')
  assert.equal(describeAction('filesystem', { mode: 'delete', path: '/Users/me/Desktop/notes.txt' }, {}).label, 'filesystem delete /Users/me/Desktop/notes.txt')
  assert.equal(describeAction('process_kill', { mode: 'kill', name: 'Safari' }, {}).label, 'process_kill kill Safari')
  assert.equal(describeAction('wait_for_window', { target_app: 'com.x' }, { app: 'com.x' }).label, 'wait_for_window')
})

test('a session gates mutations through the control and exposes control_status', async () => {
  const win = { windowId: 1, pid: 100, bundleId: 'com.example.app', title: 'Doc', bounds: { x: 0, y: 0, width: 800, height: 600 }, isOnScreen: true, isFocused: true, layer: 0 }
  const calls = []
  const native = {
    getDisplaySize: () => ({ width: 2560, height: 1440, scaleFactor: 2 }), listDisplays: () => [{ x: 0, y: 0, width: 2560, height: 1440 }],
    getWindow: id => (id === 1 ? win : null), listWindows: () => [win],
    getFrontmostApp: () => ({ bundleId: 'com.example.app', pid: 100 }), listRunningApps: () => [{ bundleId: 'com.example.app', pid: 100, isHidden: false }],
    activateApp: () => ({ activated: true }), activateWindow: () => ({ activated: true }),
    mouseMove: () => {}, mouseClick: (...a) => calls.push(['mouseClick', a]), getUserIdleTimeMs: () => 60_000,
    takeScreenshot: () => ({ base64: 'AAAA', width: 10, height: 10, mimeType: 'image/png', hash: 'h', unchanged: false }),
    isNativeEmergencyStopActive: () => false, triggerNativeEmergencyStop: () => calls.push(['latch']),
  }
  const presenter = fakePresenter()
  const directory = mkdtempSync(join(tmpdir(), 'card-test-'))
  const control = new OperatorControl({ native, card: { presenter, directory, pollMs: 10 } })
  const session = createSession({ native, macosHelper: null, profile: 'desktop', operatorControl: control })
  const text = r => r.content.find(c => c.type === 'text')?.text ?? ''
  const clicked = await session.dispatch('click', { coordinate: [10, 10], target_window_id: 1 })
  assert.equal(clicked.isError, undefined)
  await settle()
  const shown = frame(directory)
  assert.equal(shown.recent[0].label, 'click (10, 10)')
  assert.equal(shown.recent[0].app, 'com.example.app')
  assert.equal(shown.recent[0].window, 'Doc')
  assert.equal(shown.recent[0].outcome, 'done')
  writeFileSync(join(directory, 'control.txt'), 'paused')
  const refused = await session.dispatch('click', { coordinate: [10, 10], target_window_id: 1 })
  assert.equal(refused.isError, true)
  assert.equal(JSON.parse(text(refused)).error, 'paused_by_user')
  const read = await session.dispatch('screenshot', {})
  assert.equal(read.isError, undefined, 'reads continue while paused')
  const status = JSON.parse(text(await session.dispatch('control_status', {})))
  assert.equal(status.state, 'paused')
  assert.equal(status.reason, 'person')
  assert.equal(status.card.presenter, 'fake')
  assert.equal(status.lastRefused.tool, 'click')
  writeFileSync(join(directory, 'control.txt'), 'stopped')
  const stopped = await session.dispatch('key', { text: 'return', target_window_id: 1 })
  assert.equal(JSON.parse(text(stopped)).error, 'stopped_by_user')
  assert.ok(calls.some(c => c[0] === 'latch'), 'Stop tripped the native latch')
  assert.equal(calls.filter(c => c[0] === 'mouseClick').length, 1, 'only the first click reached the native layer')
  session.close()
  assert.equal(existsSync(directory), false)
})

test('control_status is a core read-only tool on every platform, and the instructions explain the refusals', () => {
  for (const platform of ['darwin', 'win32', 'linux']) assert.ok(listedTools(platform, 'core').includes('control_status'), platform)
  assert.match(buildInstructions('darwin', 'desktop'), /paused_by_user or stopped_by_user/)
})

test('the card was opt-in in 7.6.1; 7.7.0 turns it on by default on macOS and Windows', () => {
  assert.equal(statusCardEnabled({}, 'win32'), true)
  assert.equal(statusCardEnabled({}, 'linux'), false)
  assert.equal(statusCardEnabled({}, 'darwin'), true)
  assert.equal(statusCardEnabled({ COMPUTER_USE_STATUS_CARD: 'true' }, 'win32'), true)
  assert.equal(statusCardEnabled({ COMPUTER_USE_STATUS_CARD: '1' }, 'win32'), true)
  assert.equal(statusCardEnabled({ COMPUTER_USE_STATUS_CARD: 'false' }, 'darwin'), false)
})

test('a presenter that fails to start never breaks a tool call; the status says why', async () => {
  const presenter = { kind: 'broken', start: async () => { throw new Error('swiftc not found') }, stop() {} }
  const directory = mkdtempSync(join(tmpdir(), 'card-test-'))
  const control = new OperatorControl({ card: { presenter, directory, pollMs: 10 } })
  control.begin({ tool: 'click', label: 'click (1, 1)' })
  await settle()
  const status = control.status()
  assert.equal(status.card.launched, false)
  assert.match(status.card.error, /swiftc not found/)
  assert.equal(control.gate('click'), undefined, 'still running')
  control.close()
})
