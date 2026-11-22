// 8.0: a password or a one-time code is the person's to type. Typing into a sign-in or verification screen is refused
// and the desktop handed to the person until they press Resume; hand_off asks them for anything else only they should
// do. COMPUTER_USE_AUTH_HANDOFF=off lifts the check for an operator whose agent must sign in (a recorded tutorial).
import assert from 'node:assert/strict'
import test from 'node:test'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { OperatorControl } from '../dist/session/operator-control.js'
import { authHandoffEnabled, focusWall, textWall, titleWall, typesText } from '../dist/session/auth-wall.js'

const APP = 'com.example.app'
function fakeNative({ title = 'Doc', focused = null, bundleId = APP } = {}) {
  const calls = []
  const win = { windowId: 1, pid: 100, bundleId, title, bounds: { x: 100, y: 100, width: 800, height: 600 }, isOnScreen: true, isFocused: true, layer: 0 }
  return {
    calls,
    getDisplaySize: () => ({ width: 2560, height: 1440, pixelWidth: 5120, pixelHeight: 2880, scaleFactor: 2 }),
    listDisplays: () => [{ x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 2 }],
    getWindow: id => (id === 1 ? win : null),
    listWindows: () => [win],
    getFrontmostApp: () => ({ bundleId, displayName: 'App', pid: 100 }),
    listRunningApps: () => [{ bundleId, displayName: 'App', pid: 100, isHidden: false }],
    takeScreenshot: () => ({ base64: 'AAAA', width: 400, height: 300, mimeType: 'image/jpeg', hash: 'h', unchanged: false }),
    activateApp: () => ({ activated: true }), activateWindow: () => ({ activated: true }),
    mouseMove: () => {}, mouseClick: (...a) => calls.push(['mouseClick', a]),
    keyPress: (...a) => calls.push(['keyPress', a]), typeText: (...a) => calls.push(['typeText', a]),
    cursorPosition: () => ({ x: 1, y: 1 }), getUserIdleTimeMs: () => 60_000,
    getFocusedElement: () => focused, findElement: () => [], isNativeEmergencyStopActive: () => false,
  }
}
const payload = result => result.structuredContent ?? JSON.parse(result.content[0].text)
const typed = native => native.calls.filter(([name]) => name === 'typeText' || name === 'keyPress').length
async function connect(native, options = {}) {
  const control = new OperatorControl({ native })
  const client = await connectInProcess(createComputerUseServer({ native, profile: 'desktop', disableSessionLock: true, operatorControl: control, ...options }))
  return { client, control }
}

test('what counts as a wall: a protected or code field, a sign-in title, a code prompt on the page', () => {
  assert.equal(focusWall({ role: 'AXSecureTextField', label: 'Password', sensitive: true }).kind, 'sign_in')
  assert.equal(focusWall({ role: 'AXTextField', label: 'Verification code', sensitive: false }).kind, 'verification')
  assert.equal(focusWall({ role: 'AXTextField', label: 'Address and search bar', sensitive: false }), 'none', 'a plain field the tree knows ends the check')
  assert.equal(focusWall({ role: 'AXWebArea', label: null, sensitive: false }), undefined, 'web content: look further')
  assert.equal(titleWall('Sign in - Google Accounts').kind, 'sign_in')
  assert.equal(titleWall('2-Step Verification').kind, 'verification')
  assert.equal(titleWall('Blender [/tmp/face.blend]'), undefined)
  assert.equal(textWall(['Enter the code we sent to your phone']).kind, 'verification')
  assert.equal(textWall(['Welcome back', 'Sign in', 'Email', 'Password']).kind, 'sign_in')
  assert.equal(textWall(['Settings', 'Change password']), undefined, 'a password mention without a sign-in heading is not a wall')
  assert.ok(typesText('type', {}) && typesText('key', { text: '7' }) && typesText('key', { text: 'cmd+v' }))
  assert.ok(!typesText('key', { text: 'return' }) && !typesText('key', { text: 'cmd+s' }) && !typesText('click', {}))
  assert.equal(authHandoffEnabled({}), true)
  assert.equal(authHandoffEnabled({ COMPUTER_USE_AUTH_HANDOFF: 'off' }), false)
})

test('typing into a password field is refused and the desktop handed to the person until they resume', async () => {
  const native = fakeNative({ focused: { role: 'AXSecureTextField', label: 'Password', sensitive: true } })
  const { client, control } = await connect(native)
  try {
    const refused = await client.callTool('type', { text: 'hunter2', target_window_id: 1 })
    assert.equal(refused.isError, true)
    const body = payload(refused)
    assert.equal(body.error, 'sign_in_required')
    assert.equal(body.kind, 'sign_in')
    assert.match(body.seen, /protected field/)
    assert.doesNotMatch(JSON.stringify(body), /hunter2/)
    assert.equal(typed(native), 0, 'nothing was typed')
    const status = control.status()
    assert.equal(status.state, 'paused')
    assert.equal(status.reason, 'handoff')
    assert.match(status.handoff.message, /Sign in in com\.example\.app yourself/)
    const click = await client.callTool('click', { coordinate: [300, 200], target_window_id: 1 })
    assert.equal(payload(click).error, 'handed_off', 'every mutation waits for the person')
    const look = await client.callTool('screenshot', { target_window_id: 1 })
    assert.equal(look.isError, undefined, 'looking still works')
    control.resume('person')
    assert.equal(control.status().handoff, null)
  } finally { await client.close() }
})

test('a verification screen named in the window title is handed over too, and a single key counts as typing', async () => {
  const native = fakeNative({ title: 'Two-factor authentication' })
  const { client, control } = await connect(native)
  try {
    const refused = await client.callTool('key', { text: '4', target_window_id: 1 })
    assert.equal(payload(refused).error, 'sign_in_required')
    assert.equal(payload(refused).kind, 'verification')
    assert.equal(control.status().handoff.kind, 'verification')
  } finally { await client.close() }
})

test('the address bar of a sign-in page is a plain field: typing a URL there is not a wall', async () => {
  const native = fakeNative({ title: 'Sign in - Accounts', focused: { role: 'AXTextField', label: 'Address and search bar', sensitive: false } })
  const { client } = await connect(native)
  try {
    const result = await client.callTool('type', { text: 'example.com', target_window_id: 1 })
    assert.equal(result.isError, undefined, JSON.stringify(payload(result)))
    assert.equal(typed(native), 1)
  } finally { await client.close() }
})

test('the operator can let the agent sign in (a test account in a recorded tutorial)', async () => {
  const native = fakeNative({ focused: { role: 'AXSecureTextField', label: 'Password', sensitive: true } })
  const { client, control } = await connect(native, { authHandoff: false })
  try {
    const result = await client.callTool('type', { text: 'test-account-pass', target_window_id: 1 })
    assert.equal(result.isError, undefined)
    assert.equal(control.status().state, 'running')
  } finally { await client.close() }
})

test('a run_steps step that would type into the wall stops the batch there', async () => {
  const native = fakeNative({ focused: { role: 'AXSecureTextField', label: 'Password', sensitive: true } })
  const { client } = await connect(native)
  try {
    const result = await client.callTool('run_steps', { target_window_id: 1, steps: [
      { tool: 'click', args: { coordinate: [300, 200] } },
      { tool: 'type', args: { text: 'hunter2' } },
      { tool: 'key', args: { text: 'return' } },
    ] })
    const body = payload(result)
    assert.equal(body.stopped_at, 1)
    assert.equal(body.failed_step.error, 'sign_in_required')
    assert.equal(body.steps[2].status, 'not_run')
    assert.equal(typed(native), 0)
  } finally { await client.close() }
})

test('hand_off asks the person; done resumes only a hand-off; the person can resume from the card', async () => {
  const native = fakeNative()
  const { client, control } = await connect(native)
  try {
    const asked = payload(await client.callTool('hand_off', { message: 'Solve the CAPTCHA, please.' }))
    assert.equal(asked.handed_off, true)
    assert.equal(asked.resumed, false)
    assert.match(asked.hint, /No status card here/)
    assert.equal(control.status().handoff.message, 'Solve the CAPTCHA, please.')
    assert.equal(payload(await client.callTool('key', { text: 'return', target_window_id: 1 })).error, 'handed_off')
    const done = payload(await client.callTool('hand_off', { action: 'done' }))
    assert.equal(done.resumed, true)
    assert.equal(control.status().state, 'running')
    control.pause('person')
    assert.equal(payload(await client.callTool('hand_off', { action: 'done' })).resumed, false, "the person's own pause is theirs to end")
    control.resume('person')
    // wait_ms returns as soon as the person resumes
    setTimeout(() => control.resume('person'), 120)
    const waited = payload(await client.callTool('hand_off', { message: 'Approve the payment on your phone.', wait_ms: 5000 }))
    assert.equal(waited.resumed, true)
    assert.ok(waited.waitedMs < 2000)
  } finally { await client.close() }
})

test('the card shows the request as the person\'s turn', async () => {
  const { readFileSync } = await import('node:fs')
  const swift = readFileSync(new URL('../libexec/macos-status-card.swift', import.meta.url), 'utf8')
  assert.match(swift, /Your turn/)
  assert.match(readFileSync(new URL('../libexec/windows-status-card.ps1', import.meta.url), 'utf8'), /Your turn/)
  assert.match(readFileSync(new URL('../libexec/linux-status-card.py', import.meta.url), 'utf8'), /Your turn/)
})
