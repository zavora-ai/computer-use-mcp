// 8.0 (gaps review P2-11 and P2-15): record and replay, and guide mode.
// - The session keeps the actions that worked; export_steps turns them into run_steps batches with an expect on each
//   step, and a replay stops at the first step whose expect does not hold.
// - Steps recorded with the window's frame follow the window when it moves, and refuse to run when it changed size.
// - A secret typed while recording is redacted, and run_steps refuses the placeholder.
// - The guide profile observes and points; it can click, type and change nothing.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { createSession } from '../dist/session.js'
import { REDACTED, exportSteps, textUnder } from '../dist/session/step-journal.js'
import { digitTolerant, findText, similarLines, textCore } from '../dist/session/agent-desktop-handlers.js'
import { listedTools, buildInstructions } from '../dist/instructions.js'
import { TOOL_CATALOG } from '../dist/tool-catalog.js'
import { describeAction } from '../dist/session/operator-control.js'
import { guidePromptText } from '../dist/prompts.js'

const APP = 'com.example.app'
const at = (x, y, width = 800, height = 600) => ({ windowId: 1, pid: 100, bundleId: APP, title: 'Doc', bounds: { x, y, width, height }, isOnScreen: true, isFocused: true, layer: 0 })

/** A fake desktop. The screen's hash changes when `screen.version` does; tests bump it from an input call. */
function fakeNative(overrides = {}) {
  const calls = []
  const screen = { version: 0, window: at(100, 100), extra: [] }
  const native = {
    calls, screen,
    getDisplaySize: () => ({ width: 2560, height: 1440, pixelWidth: 5120, pixelHeight: 2880, scaleFactor: 2 }),
    listDisplays: () => [{ x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 2 }],
    getWindow: id => (id === 1 ? screen.window : screen.extra.find(window => window.windowId === id) ?? null),
    listWindows: () => [screen.window, ...screen.extra],
    getFrontmostApp: () => ({ bundleId: APP, displayName: 'App', pid: 100 }),
    listRunningApps: () => [{ bundleId: APP, displayName: 'App', pid: 100, isHidden: false }],
    takeScreenshot: () => ({ base64: 'AAAA', width: 400, height: 300, mimeType: 'image/jpeg', hash: `v${screen.version}`, unchanged: false }),
    activateApp: () => ({ activated: true }),
    activateWindow: () => ({ activated: true }),
    mouseMove: (...a) => calls.push(['mouseMove', a]),
    mouseClick: (...a) => { calls.push(['mouseClick', a]); screen.version++ },
    keyPress: (...a) => calls.push(['keyPress', a]),
    typeText: (...a) => calls.push(['typeText', a]),
    cursorPosition: () => ({ x: 1, y: 1 }), getUserIdleTimeMs: () => 60_000,
    findElement: () => [], isNativeEmergencyStopActive: () => false,
    ...overrides,
  }
  return native
}
const clicks = native => native.calls.filter(([name]) => name === 'mouseClick').map(([, args]) => args.slice(0, 2))
const typed = native => native.calls.filter(([name]) => ['mouseClick', 'typeText', 'keyPress'].includes(name)).map(([name]) => name)
const payload = result => result.structuredContent ?? JSON.parse(result.content[0].text)
const connect = (native, profile = 'desktop') => connectInProcess(createComputerUseServer({ native, profile, disableSessionLock: true }))

// ── The text under a click, and the export ─────────────────────────────────────────────────────

test('the text under a click is the word click_text would find again, with the nth that picks it', () => {
  const lines = [
    { text: 'File Edit View', confidence: 1, box: { x: 10, y: 5, w: 140, h: 14 } },
    { text: 'Edit', confidence: 1, box: { x: 300, y: 60, w: 40, h: 14 } },
    { text: 'Render settings', confidence: 1, box: { x: 10, y: 100, w: 150, h: 16 } },
  ]
  // "Edit" in the menu line is the first match in reading order, the button below it the second
  assert.deepEqual(textUnder(lines, 70, 12), { text: 'Edit', match: 'contains', nth: 1 })
  assert.deepEqual(textUnder(lines, 320, 66), { text: 'Edit', match: 'contains', nth: 2 })
  assert.deepEqual(textUnder(lines, 120, 108), { text: 'settings', match: 'contains', nth: 1 })
  assert.equal(textUnder(lines, 600, 400), undefined, 'no text there: the click stays a coordinate')
})

test('the export keeps coordinates in the first frame, names dialogs by title and turns a click on a word into click_text', () => {
  const main = { windowId: 1, bundleId: APP, title: 'Doc', bounds: { x: 100, y: 100, width: 800, height: 600 } }
  const moved = { ...main, bounds: { ...main.bounds, x: 140, y: 90 } }
  const dialog = { windowId: 7, bundleId: APP, title: 'Save As', bounds: { x: 300, y: 200, width: 400, height: 200 } }
  const entry = (seq, tool, args, extra = {}) => ({ seq, at: seq, tool, args, checked: true, window: main, ...extra })
  const { batches, unchecked, converted } = exportSteps([
    entry(1, 'click', { coordinate: [300, 200], target_window_id: 1 }, { effect: 'changed' }),
    entry(2, 'mouse_drag', { path: [[340, 190], [440, 190]], button: 'middle' }, { window: moved, effect: 'changed' }),
    entry(3, 'click', { coordinate: [400, 260] }, { window: dialog, under: { text: 'Save', match: 'exact', nth: 1, region: [0, 40, 240, 36] }, opened: undefined, effect: 'changed' }),
    entry(4, 'key', { text: 'cmd+s' }, { opened: { kind: 'dialog', title: 'Save As' } }),
    entry(5, 'key', { text: 'a' }, { effect: 'unverified' }),
    entry(6, 'wait_for_text', { text: 'Saved' }),
  ])
  assert.equal(batches.length, 1)
  const [batch] = batches
  assert.equal(batch.target_app, APP)
  assert.deepEqual(batch.frame, [100, 100, 800, 600])
  assert.deepEqual(batch.steps[0], { tool: 'click', args: { coordinate: [300, 200] }, expect: { changed: true, soft: true } })
  assert.deepEqual(batch.steps[1].args.path, [[300, 200], [400, 200]], 'moved 40 right and 10 up: brought back into the first frame')
  assert.deepEqual(batch.steps[2], { tool: 'click_text', args: { text: 'Save', match: 'exact', region: [0, 40, 240, 36], target_app: APP, target_title: 'Save As' }, expect: { changed: true, soft: true } })
  assert.deepEqual(batch.steps[3].expect, { window: { kind: 'dialog', title: 'Save As' } })
  assert.equal(batch.steps[5].expect, undefined, 'a wait checks itself')
  assert.deepEqual(unchecked, [4])
  assert.deepEqual(converted, [2])
})

test('a long recording is split into batches run_steps accepts, each with the target and frame', () => {
  const main = { windowId: 1, bundleId: APP, bounds: { x: 0, y: 0, width: 800, height: 600 } }
  const entries = Array.from({ length: 65 }, (_, index) => ({ seq: index + 1, at: 0, tool: 'key', args: { text: 'a' }, checked: false, window: main }))
  const { batches } = exportSteps(entries)
  assert.deepEqual(batches.map(batch => batch.steps.length), [30, 30, 5])
  assert.ok(batches.every(batch => batch.target_app === APP && batch.frame))
})

// ── Recording through the server ───────────────────────────────────────────────────────────────

test('the actions that worked come back as a run_steps batch; failures and one-off arguments do not', async () => {
  const native = fakeNative()
  const client = await connect(native)
  try {
    await client.callTool('click', { coordinate: [300, 200], target_window_id: 1, force: true })
    await client.callTool('type', { text: 'hello', target_window_id: 1 })
    const outside = await client.callTool('click', { coordinate: [9000, 9000], target_window_id: 1 })
    assert.equal(outside.isError, true)
    await client.callTool('key', { text: 'return', target_window_id: 1 })
    const body = payload(await client.callTool('export_steps', {}))
    assert.equal(body.count, 3)
    const [batch] = body.batches
    assert.equal(batch.target_app, APP)
    assert.deepEqual(batch.frame, [100, 100, 800, 600])
    assert.deepEqual(batch.steps.map(step => step.tool), ['click', 'type', 'key'])
    assert.deepEqual(batch.steps[0].args.coordinate, [300, 200])
    assert.equal(batch.steps[0].args.force, undefined, 'force is never replayed')
    assert.equal(batch.steps[0].args.target_window_id, undefined, 'window ids do not survive a restart; the batch names the app')
    assert.deepEqual(body.unchecked, [0, 1, 2], 'not recorded with checks: nothing says what they did')
    assert.match(body.hint, /export_steps start/)
    const since = body.next_since
    await client.callTool('key', { text: 'tab', target_window_id: 1 })
    const later = payload(await client.callTool('export_steps', { since }))
    assert.deepEqual(later.batches[0].steps.map(step => step.args.text), ['tab'])
  } finally { await client.close() }
})

test('a checked recording captures before and after, and notes the window that opened', async () => {
  const native = fakeNative({
    keyPress: (...a) => {
      native.calls.push(['keyPress', a])
      if (a[0] === 'cmd+s') native.screen.extra.push({ windowId: 7, pid: 100, bundleId: APP, title: 'Save As', bounds: { x: 300, y: 200, width: 400, height: 200 }, isOnScreen: true, layer: 0 })
    },
  })
  const client = await connect(native)
  try {
    const started = payload(await client.callTool('export_steps', { action: 'start' }))
    assert.equal(started.recording, true)
    const click = payload(await client.callTool('click', { coordinate: [300, 200], target_window_id: 1 }))
    assert.equal(click.effect, 'changed', 'the agent sees the check too')
    await client.callTool('key', { text: 'x', target_window_id: 1 })
    await client.callTool('key', { text: 'cmd+s', target_window_id: 1 })
    const body = payload(await client.callTool('export_steps', { action: 'stop' }))
    assert.equal(body.recording, false)
    const steps = body.batches[0].steps
    assert.deepEqual(steps[0].expect, { changed: true, soft: true })
    assert.equal(steps[1].expect, undefined, 'x changed nothing on screen')
    assert.equal(steps[2].expect.window.title, 'Save As')
    assert.deepEqual(body.unchecked, [1])
  } finally { await client.close() }
})

test('text typed into a sensitive field while recording is redacted, and run_steps refuses the placeholder', async () => {
  const native = fakeNative({ getFocusedElement: () => ({ role: 'AXSecureTextField', sensitive: true }) })
  // The operator let the agent sign in (a test account in a tutorial); otherwise the typing is handed to the person.
  const client = await connectInProcess(createComputerUseServer({ native, profile: 'desktop', disableSessionLock: true, authHandoff: false }))
  try {
    await client.callTool('export_steps', { action: 'start' })
    await client.callTool('type', { text: 'hunter2', target_window_id: 1 })
    const body = payload(await client.callTool('export_steps', {}))
    assert.equal(body.batches[0].steps[0].args.text, REDACTED)
    assert.deepEqual(body.redacted, [0])
    assert.doesNotMatch(JSON.stringify(body), /hunter2/)
    const replay = await client.callTool('run_steps', body.batches[0])
    assert.equal(replay.isError, true)
    assert.equal(payload(replay).error, 'invalid_arguments')
    assert.match(JSON.stringify(payload(replay).issues), /put the real value in first/)
    assert.deepEqual(typed(native).filter(name => name === 'typeText'), ['typeText'], 'only the recorded call typed')
  } finally { await client.close() }
})

// ── Replaying with expect and frame ────────────────────────────────────────────────────────────

test('a replay checks each step and stops at the first expect that does not hold', async () => {
  const native = fakeNative()
  const client = await connect(native)
  try {
    const result = await client.callTool('run_steps', {
      target_window_id: 1,
      steps: [
        { tool: 'click', args: { coordinate: [300, 200] }, expect: { changed: true } },
        { tool: 'key', args: { text: 'x' }, expect: { changed: true, timeout_ms: 150 } },
        { tool: 'key', args: { text: 'return' } },
      ],
    })
    assert.equal(result.isError, true)
    const body = payload(result)
    assert.equal(body.error, 'step_failed')
    assert.equal(body.stopped_at, 1)
    assert.equal(body.steps[0].expect, 'met')
    assert.equal(body.steps[1].expect, 'unmet')
    assert.equal(body.steps[2].status, 'not_run')
    assert.equal(body.failed_step.error, 'expect_failed')
    assert.deepEqual(body.failed_step.saw, { changed: false })
    assert.match(body.hint, /Nothing changed in the window within 150 ms/)
    assert.deepEqual(body.next_call, { tool: 'screenshot', arguments: { target_window_id: 1 } })
    assert.deepEqual(typed(native), ['mouseClick', 'keyPress'], 'return was never pressed')
  } finally { await client.close() }
})

test('recorded coordinates follow the window when it moved, and refuse to run when it changed size', async () => {
  const native = fakeNative()
  native.screen.window = at(150, 120)
  const client = await connect(native)
  try {
    const moved = await client.callTool('run_steps', {
      target_app: APP, frame: [100, 100, 800, 600],
      steps: [{ tool: 'click', args: { coordinate: [300, 200] } }, { tool: 'mouse_move', args: { coordinate: [10, 10] } }],
    })
    assert.equal(moved.isError, undefined, JSON.stringify(moved))
    assert.deepEqual(payload(moved).shifted, [50, 20])
    assert.deepEqual(clicks(native), [[350, 220]])
    native.screen.window = at(150, 120, 1024, 600)
    const resized = await client.callTool('run_steps', { target_app: APP, frame: [100, 100, 800, 600], steps: [{ tool: 'click', args: { coordinate: [300, 200] } }] })
    assert.equal(resized.isError, true)
    const body = payload(resized)
    assert.equal(body.error, 'frame_changed')
    assert.deepEqual(body.now, [150, 120, 1024, 600])
    assert.equal(clicks(native).length, 1, 'nothing ran')
  } finally { await client.close() }
})

test('an exported batch replays as it is', async () => {
  const native = fakeNative()
  const client = await connect(native)
  try {
    await client.callTool('export_steps', { action: 'start' })
    await client.callTool('click', { coordinate: [300, 200], target_window_id: 1 })
    await client.callTool('type', { text: 'hello', target_window_id: 1 })
    const { batches } = payload(await client.callTool('export_steps', { action: 'stop' }))
    native.calls.length = 0
    const replay = await client.callTool('run_steps', batches[0])
    assert.equal(replay.isError, undefined, JSON.stringify(payload(replay)))
    assert.equal(payload(replay).steps[0].expect, 'met')
    assert.deepEqual(typed(native), ['mouseClick', 'typeText'])
  } finally { await client.close() }
})

// ── Guide mode ─────────────────────────────────────────────────────────────────────────────────

test('the guide profile observes and points, and lists nothing that clicks, types or changes the machine', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const tools = listedTools(platform, 'guide')
    assert.ok(tools.includes('agent_pointer') && tools.includes('screenshot') && tools.includes('wait_for_window'))
    for (const name of tools) {
      const meta = TOOL_CATALOG[name]
      assert.ok(!meta.mutates || name === 'agent_pointer', `${name} acts on the machine but is listed in guide`)
    }
  }
  assert.ok(listedTools('darwin', 'guide').includes('read_window_text'))
  const text = buildInstructions('darwin', 'guide')
  assert.match(text, /Guide mode/)
  assert.match(text, /agent_pointer/)
  assert.doesNotMatch(text, /run_steps|click_text/)
})

test('the guide profile refuses input tools at the boundary', async () => {
  const native = fakeNative()
  const client = await connect(native, 'guide')
  try {
    const listed = (await client.listTools()).map(tool => tool.name)
    assert.ok(!listed.includes('click') && !listed.includes('type') && !listed.includes('run_steps'))
    // A tool outside the profile is not there at all, as for every profile.
    await assert.rejects(client.callTool('click', { coordinate: [300, 200], target_window_id: 1 }), /Unknown or disabled tool: click/)
    assert.deepEqual(clicks(native), [])
  } finally { await client.close() }
})

test('agent_pointer points at text read off the window and puts the label on the status card', { skip: process.platform !== 'darwin' }, async () => {
  const native = fakeNative({ agentPointerOverlayShow: (x, y) => ({ shown: [x, y] }) })
  const helper = {
    supportsCapture: () => true,
    ensure: async () => ({ ok: true, path: '/fake' }),
    // the window is 800 points wide in a 1600-pixel image: scale 2
    ocr: async () => ({ width: 1600, height: 1200, scale: 2, lines: [{ text: 'Save', confidence: 1, box: { x: 400, y: 200, w: 80, h: 30 } }] }),
  }
  const session = createSession({ native, macosHelper: helper, profile: 'guide' })
  try {
    const result = await session.dispatch('agent_pointer', { action: 'move', text: 'save', target_app: APP, label: 'Save the file' })
    assert.equal(result.isError, undefined, JSON.stringify(result.content))
    const body = payload(result)
    // box (200, 100, 40, 15) in window points; the window is at (100, 100): centre (320, 208)
    assert.deepEqual(body.pointed_at.screen, { x: 320, y: 208 })
    assert.equal(body.visible, true)
    assert.deepEqual(body.nativeOverlay.status, { shown: [320, 208] })
    assert.deepEqual(clicks(native), [], 'nothing was clicked')
    assert.equal(describeAction('agent_pointer', { label: 'Save the file' }, {}).label, 'Look here: Save the file')
  } finally { session.close() }
})

test('pointing at a label prefers the word itself to a longer word that contains it', { skip: process.platform !== 'darwin' }, async () => {
  const native = fakeNative()
  const helper = {
    supportsCapture: () => true,
    ensure: async () => ({ ok: true, path: '/fake' }),
    // Blender: "v ViewLayer" (top right) is read before the header's "View Sculpt Mask"
    ocr: async () => ({ width: 800, height: 600, scale: 1, lines: [
      { text: 'v ViewLayer', confidence: 1, box: { x: 600, y: 10, w: 100, h: 14 } },
      { text: 'View Sculpt Mask', confidence: 1, box: { x: 100, y: 40, w: 160, h: 14 } },
    ] }),
  }
  const session = createSession({ native, macosHelper: helper, profile: 'guide' })
  try {
    const body = payload(await session.dispatch('agent_pointer', { action: 'move', text: 'View', target_app: APP }))
    assert.equal(body.pointed_at.line, 'View Sculpt Mask')
  } finally { session.close() }
})

// ── Fixes from the Blender trainer's live runs (T4, T5, T6, T8) ────────────────────────────────

test('T4/T5: agent_pointer reads any window of the app, a region of it, and picks the nth match', { skip: process.platform !== 'darwin' }, async () => {
  const native = fakeNative()
  native.screen.extra.push({ windowId: 9, pid: 100, bundleId: APP, title: 'Blender File View', bounds: { x: 400, y: 300, width: 600, height: 400 }, isOnScreen: true, layer: 0 })
  const asked = []
  const helper = {
    supportsCapture: () => true,
    ensure: async () => ({ ok: true, path: '/fake' }),
    ocr: async options => {
      asked.push(options)
      return { width: 600, height: 400, scale: 1, lines: [
        { text: 'Save', confidence: 1, box: { x: 20, y: 10, w: 40, h: 14 } },
        { text: 'Save', confidence: 1, box: { x: 500, y: 360, w: 40, h: 14 } },
      ] }
    },
  }
  const session = createSession({ native, macosHelper: helper, profile: 'guide' })
  try {
    const body = payload(await session.dispatch('agent_pointer', { action: 'move', text: 'Save', target_window_id: 9, region: [0, 300, 600, 100], nth: 2 }))
    assert.equal(asked[0].windowId, 9, 'the File View window, not the main one')
    assert.deepEqual(asked[0].region, { x: 0, y: 300, width: 600, height: 100 })
    // second "Save": box (500, 360, 40, 14) in a window at (400, 300): centre (920, 667)
    assert.deepEqual(body.pointed_at.screen, { x: 920, y: 667 })
    const titled = payload(await session.dispatch('agent_pointer', { action: 'move', text: 'Save', target_app: APP, target_title: 'File View' }))
    assert.equal(asked[1].windowId, 9, 'target_title picks the window by its title')
    assert.ok(titled.pointed_at)
    const missing = await session.dispatch('agent_pointer', { action: 'move', text: 'Save', target_window_id: 9, nth: 3 })
    assert.equal(payload(missing).error, 'text_not_found')
    assert.equal(payload(missing).matches, 2)
  } finally { session.close() }
})

test('T6: a number matches through OCR\'s misreads (comma for point, O for zero)', () => {
  const lines = [
    { text: 'Scale 1,000', confidence: 1, box: { x: 0, y: 0, w: 110, h: 14 } },
    { text: 'Rotation O°', confidence: 1, box: { x: 0, y: 20, w: 110, h: 14 } },
    { text: 'Outliner', confidence: 1, box: { x: 0, y: 40, w: 80, h: 14 } },
  ]
  assert.equal(digitTolerant('1,000 O° 0.25 Outliner'), '1.000 0° 0.25 Outliner', 'same length, words untouched')
  assert.equal(findText(lines, '1.000', 'contains')[0].matched, '1,000', 'the original text is what matched')
  assert.equal(findText(lines, 'Rotation 0°', 'exact').length, 1)
  assert.equal(findText(lines, 'Outliner', 'exact').length, 1, 'a query without digits is matched as before')
  assert.equal(findText(lines, '1\\.000', 'regex').length, 0, 'a regex is matched as written, with no folding')
  assert.equal(findText(lines, '1[.,]000', 'regex').length, 1, 'so a regex allows both itself')
})

test('T8: a step\'s own expect that held is what export_steps gives back', async () => {
  const native = fakeNative()
  const client = await connect(native)
  try {
    const since = payload(await client.callTool('export_steps', { last: 0 })).next_since
    const ran = await client.callTool('run_steps', { target_window_id: 1, steps: [
      { tool: 'click', args: { coordinate: [300, 200] }, expect: { changed: true, region: [0, 0, 400, 300], timeout_ms: 500 } },
      { tool: 'key', args: { text: 'return' } },
    ] })
    assert.equal(ran.isError, undefined, JSON.stringify(payload(ran)))
    const { batches } = payload(await client.callTool('export_steps', { since }))
    assert.deepEqual(batches[0].steps[0].expect, { changed: true, region: [0, 0, 400, 300], timeout_ms: 500 }, 'kept as written')
    assert.equal(batches[0].steps[1].expect, undefined)
  } finally { await client.close() }
})

test('T6: an expect on text passes its match to the wait', { skip: process.platform !== 'darwin' }, async () => {
  const native = fakeNative()
  const seen = []
  const helper = {
    supportsCapture: () => true,
    ensure: async () => ({ ok: true, path: '/fake' }),
    capture: async () => ({ data: Buffer.from('x'), width: 10, height: 10, hash: 'same', scale: 1, mimeType: 'image/jpeg' }),
    ocr: async options => { seen.push(options); return { width: 800, height: 600, scale: 1, lines: [{ text: 'Torus.001', confidence: 1, box: { x: 10, y: 10, w: 80, h: 14 } }] } },
  }
  const session = createSession({ native, macosHelper: helper, profile: 'desktop' })
  try {
    const met = payload(await session.dispatch('run_steps', { target_window_id: 1, steps: [
      { tool: 'key', args: { text: 'return' }, expect: { text: '^Torus\\.\\d{3}$', match: 'regex', timeout_ms: 500 } },
    ] }))
    assert.equal(met.steps[0].expect, 'met', JSON.stringify(met))
  } finally { session.close() }
})

test('exact matching ignores an icon read as a glyph beside the label (Blender\'s mode pie)', () => {
  const lines = [
    { text: '• Object Mode', confidence: 1, box: { x: 0, y: 0, w: 130, h: 14 } },
    { text: '& Edit Mode', confidence: 1, box: { x: 200, y: 0, w: 110, h: 14 } },
    { text: 'Object Mode Settings', confidence: 1, box: { x: 0, y: 40, w: 200, h: 14 } },
  ]
  const [hit] = findText(lines, 'Object Mode', 'exact')
  assert.equal(hit.matched, 'Object Mode', 'the words, not the glyph')
  // the click lands on the words: they start after "• " (2 of 13 characters)
  assert.equal(hit.point.x, Math.round(130 * (2 / 13) + (130 * (11 / 13)) / 2))
  assert.equal(findText(lines, 'Object Mode', 'exact').length, 1, 'a longer line is still not an exact match')
  assert.equal(findText(lines, 'Edit Mode', 'exact').length, 1)
  assert.deepEqual(textCore('  * Vertex Paint  '), { text: 'Vertex Paint', start: 4 })
  assert.deepEqual(similarLines(lines, 'object mode'), ['• Object Mode', 'Object Mode Settings'])
})

test('click_text that finds nothing lists the near misses first', { skip: process.platform !== 'darwin' }, async () => {
  const native = fakeNative()
  const lines = Array.from({ length: 45 }, (_, i) => ({ text: `row ${i}`, confidence: 1, box: { x: 0, y: i * 15, w: 60, h: 12 } }))
  lines.push({ text: 'Mode: Object', confidence: 1, box: { x: 0, y: 700, w: 90, h: 12 } })
  const helper = { supportsCapture: () => true, ensure: async () => ({ ok: true, path: '/fake' }), ocr: async () => ({ width: 800, height: 900, scale: 1, lines }) }
  const session = createSession({ native, macosHelper: helper, profile: 'desktop' })
  try {
    const r = payload(await session.dispatch('click_text', { text: 'Object', match: 'exact', target_window_id: 1 }))
    assert.equal(r.error, 'text_not_found')
    assert.deepEqual(r.similar, ['Mode: Object'], 'beyond the first 40 lines, and still reported')
  } finally { session.close() }
})

test('the guide-me prompt asks to point and wait, never to act', () => {
  const text = guidePromptText('turn on X-ray', 'org.blenderfoundation.blender')
  assert.match(text, /Do not click, type or change anything/)
  assert.match(text, /agent_pointer/)
  assert.match(text, /wait_for_text, wait_for_stable or wait_for_window/)
})
