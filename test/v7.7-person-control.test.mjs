// 7.7.0 (K4, K5): a person's control by default. Stop from the card lands in milliseconds; the person taking over the
// mouse or keyboard pauses the agent until they stop; a locked screen is refused by name; the card is on by default on
// macOS and the emergency chord is armed by default.
import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSession } from '../dist/session.js'
import {
  OperatorControl, statusCardEnabled, emergencyChord, takeoverEnabled, DEFAULT_EMERGENCY_CHORD, TAKEOVER_MOVEMENT,
} from '../dist/session/operator-control.js'

const presenter = { kind: 'test', start() {}, stop() {} }
const until = async (condition, timeoutMs = 2000) => {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) return false
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  return true
}

test('Stop from the card aborts the action in flight within 50 ms (the control file is watched, not only polled)', async () => {
  const latencies = []
  for (let run = 0; run < 5; run++) {
    const stops = []
    const control = new OperatorControl({ native: { triggerNativeEmergencyStop: () => stops.push(Date.now()) }, card: { presenter, pollMs: 10_000 } })
    control.begin({ tool: 'hold_key', label: 'hold_key shift' }, { mutates: true })
    const signal = control.signal()
    await new Promise(resolve => setTimeout(resolve, 20)) // the watcher is up
    const written = Date.now()
    writeFileSync(join(control.status().card.directory, 'control.txt'), 'stopped')
    assert.ok(await until(() => signal.aborted, 1000), 'the in-flight signal aborted')
    latencies.push(Date.now() - written)
    assert.equal(control.state(), 'stopped')
    assert.equal(stops.length, 1, 'the native latch was tripped')
    control.close()
  }
  latencies.sort((a, b) => a - b)
  assert.ok(latencies[2] < 50, `median stop latency ${latencies[2]} ms (all: ${latencies.join(', ')})`)
})

test('the person taking over during an action pauses the agent and aborts the action; it resumes when they stop', async () => {
  let counters = { supported: true, movement: 0, keys: 0, buttons: 0 }
  let idle = 0
  const control = new OperatorControl({
    takeover: { counters: () => counters, idleMs: () => idle, pollMs: 5, resumeIdleMs: 300 },
  })
  control.begin({ tool: 'mouse_drag', label: 'mouse_drag drag' }, { mutates: true })
  const signal = control.signal()
  // A nudge is not a takeover.
  counters = { ...counters, movement: TAKEOVER_MOVEMENT - 1 }
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(control.state(), 'running')
  // A key is.
  counters = { ...counters, keys: 1 }
  assert.ok(await until(() => signal.aborted), 'the action in flight was aborted')
  assert.equal(control.state(), 'paused')
  assert.equal(control.status().reason, 'takeover')
  const refusal = control.gate('click')
  assert.equal(refusal.error, 'taken_over')
  assert.match(refusal.hint, /resumes by itself/)
  // Still busy: no resume. Then quiet long enough: running again.
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(control.state(), 'paused')
  idle = 400
  assert.ok(await until(() => control.state() === 'running'), 'resumed after the person stopped')
  control.close()
})

test('a takeover is never armed without physical-input counters, and a person\'s own pause outlasts it', async () => {
  const unsupported = new OperatorControl({ takeover: { counters: () => ({ supported: false, movement: 0, keys: 0, buttons: 0 }), idleMs: () => 0, pollMs: 5 } })
  unsupported.begin({ tool: 'click', label: 'click' }, { mutates: true })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(unsupported.state(), 'running')
  unsupported.close()

  let counters = { supported: true, movement: 0, keys: 0, buttons: 0 }
  const control = new OperatorControl({ takeover: { counters: () => counters, idleMs: () => 10_000, pollMs: 5, resumeIdleMs: 50 } })
  control.begin({ tool: 'click', label: 'click' }, { mutates: true })
  control.pause('person')
  counters = { ...counters, buttons: 1 }
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(control.status().reason, 'person', 'the takeover never overrode the person\'s pause')
  assert.equal(control.state(), 'paused')
  control.close()
})

test('defaults: card on on macOS and Windows, chord armed on macOS and Windows, takeover on; each can be turned off', () => {
  assert.equal(statusCardEnabled({}, 'darwin'), true)
  assert.equal(statusCardEnabled({}, 'win32'), true)
  assert.equal(statusCardEnabled({}, 'linux'), false)
  assert.equal(statusCardEnabled({ COMPUTER_USE_STATUS_CARD: 'false' }, 'darwin'), false)
  assert.equal(statusCardEnabled({ COMPUTER_USE_STATUS_CARD: 'true' }, 'win32'), true)
  assert.equal(emergencyChord({}, 'darwin'), DEFAULT_EMERGENCY_CHORD)
  assert.equal(emergencyChord({}, 'win32'), DEFAULT_EMERGENCY_CHORD)
  assert.equal(emergencyChord({}, 'linux'), null)
  assert.equal(emergencyChord({ COMPUTER_USE_EMERGENCY_CHORD: 'off' }, 'darwin'), null)
  assert.equal(emergencyChord({ COMPUTER_USE_EMERGENCY_CHORD: 'ctrl+shift+f12' }, 'win32'), 'ctrl+shift+f12')
  assert.equal(takeoverEnabled({}), true)
  assert.equal(takeoverEnabled({ COMPUTER_USE_TAKEOVER: 'false' }), false)
})

test('a locked screen refuses actions and captures by name; reads that do not capture still work', async () => {
  const calls = []
  const native = {
    getDisplaySize: () => ({ width: 1000, height: 800 }), listDisplays: () => [{ x: 0, y: 0, width: 1000, height: 800 }],
    getWindow: () => null, listWindows: () => [], getFrontmostApp: () => ({ bundleId: 'app', displayName: 'App', pid: 1 }),
    listRunningApps: () => [], getUserIdleTimeMs: () => 60_000, isNativeEmergencyStopActive: () => false,
    takeScreenshot: () => { calls.push('capture'); return { base64: 'AAAA', width: 10, height: 10, mimeType: 'image/png', hash: 'h', unchanged: false } },
    mouseMove: () => calls.push('move'), mouseClick: () => calls.push('click'), cursorPosition: () => ({ x: 0, y: 0 }),
    getSessionState: () => ({ locked: true, disconnected: false, secureDesktop: false, offConsole: false, backend: 'test' }),
  }
  const session = createSession({ native, macosHelper: null, profile: 'desktop' })
  const click = await session.dispatch('click', { coordinate: [10, 10], force: true })
  assert.equal(click.isError, true)
  assert.equal(click.structuredContent.error, 'screen_locked')
  assert.match(click.structuredContent.hint, /unlock/)
  const shot = await session.dispatch('screenshot', {})
  assert.equal(shot.structuredContent.error, 'screen_locked')
  assert.deepEqual(calls, [], 'nothing was captured or clicked')
  const position = await session.dispatch('cursor_position', {})
  assert.equal(position.isError, undefined, 'a read that captures nothing still works')
  session.close()
})

test('after Stop the card offers Close, which dismisses it without resuming anything (macOS and Windows sources)', async () => {
  const { readFileSync } = await import('node:fs')
  const swift = readFileSync(new URL('../libexec/macos-status-card.swift', import.meta.url), 'utf8')
  assert.match(swift, /if readControl\(\) == "stopped" \{\s*NSApp\.terminate\(nil\)/, 'a click once stopped closes the card')
  assert.match(swift, /case "stopped":[\s\S]*?stopButton\.title = "Close"\s*stopButton\.isEnabled = true/, 'the stopped card shows an enabled Close')
  assert.doesNotMatch(swift, /if readControl\(\) == "stopped" \{[^}]*writeControl\("running"/, 'closing never writes running')
  const ps1 = readFileSync(new URL('../libexec/windows-status-card.ps1', import.meta.url), 'utf8')
  assert.match(ps1, /\$stop\.Add_Click\(\{ if \(\(Read-Control\) -eq 'stopped'\) \{ \$window\.Close\(\) \}/)
  assert.match(ps1, /'stopped' \{[^\n]*\$stop\.Content = 'Close'; \$stop\.IsEnabled = \$true/)
})
