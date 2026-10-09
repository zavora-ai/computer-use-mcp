// v7.6 R7: the tool surface. Budgets, platform filtering, one click with aliases, approval_token out of the
// schemas, two _meta fields, the desktop default profile, instructions generated from the catalog.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createComputerUseServer } from '../dist/server.js'
import { DEFAULT_PROFILE, TOOL_CATALOG, parseProfile, toolAvailableOn, toolInProfile } from '../dist/tool-catalog.js'
import { buildInstructions, listedTools } from '../dist/instructions.js'
import { InputHandler, MAX_HOLD_SECONDS } from '../dist/session/input-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'

const noDesktop = { dispatch: async () => { throw new Error('tests must never operate the desktop') } }

/** The list as a host receives it over a real MCP transport (titles, annotations, _meta and output schemas included). */
async function listed(options) {
  const server = createComputerUseServer({ session: noDesktop, ...options })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'tool-surface-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try { return (await client.listTools()).tools } finally { await client.close(); await server.close() }
}
async function callTool(options, name, args) {
  const server = createComputerUseServer({ session: noDesktop, ...options })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'tool-surface-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try { return await client.callTool({ name, arguments: args }) } finally { await client.close(); await server.close() }
}
const bytes = value => JSON.stringify(value).length

// ── Budgets: the list the model loads ───────────────────────────────────────────────────────────

test('the default profile is desktop and its tool list stays under the byte budget on macOS', async () => {
  assert.equal(DEFAULT_PROFILE, 'desktop')
  assert.equal(parseProfile(undefined), 'desktop')
  assert.equal(parseProfile('nonsense'), 'desktop')
  assert.equal(parseProfile('FULL'), 'full')
  const tools = await listed({ platform: 'darwin' })
  const size = bytes(tools)
  assert.ok(size < 48_000, `desktop profile tools/list is ${size} bytes on the wire (budget 48,000; measured 45,942 on 2026-10-09)`)
  const names = new Set(tools.map(t => t.name))
  for (const expected of ['screenshot', 'zoom', 'click', 'type', 'key', 'scroll', 'read_window_text', 'click_text',
    'wait_for_window', 'wait_for_text', 'wait_for_stable', 'set_target', 'get_target', 'list_windows', 'doctor', 'get_tool_guide', 'agent_pointer']) {
    assert.ok(names.has(expected), `${expected} is in the desktop profile`)
  }
  for (const absent of ['run_script', 'get_ui_tree', 'filesystem', 'scrape', 'registry', 'notification', 'list_spaces']) {
    assert.ok(!names.has(absent), `${absent} is not in the desktop profile on macOS`)
  }
})

test('the full profile stays under its byte budget on macOS and still lists everything the platform has', async () => {
  const tools = await listed({ platform: 'darwin', profile: 'full' })
  const size = bytes(tools)
  assert.ok(size < 88_000, `full profile tools/list is ${size} bytes on the wire (budget 88,000; measured 84,037 on 2026-10-09, down from 112,727)`)
  const names = new Set(tools.map(t => t.name))
  const expected = Object.entries(TOOL_CATALOG).filter(([, meta]) => toolAvailableOn(meta, 'darwin')).map(([name]) => name)
  assert.deepEqual([...names].sort(), expected.sort())
})

// ── Platform filtering ──────────────────────────────────────────────────────────────────────────

test('tools that do not exist on a platform are neither listed nor callable there', async () => {
  const mac = new Set((await listed({ platform: 'darwin', profile: 'full' })).map(t => t.name))
  const win = new Set((await listed({ platform: 'win32', profile: 'full' })).map(t => t.name))
  const linux = new Set((await listed({ platform: 'linux', profile: 'full' })).map(t => t.name))
  assert.ok(!mac.has('registry') && !mac.has('notification'), 'Windows-only tools are not on macOS')
  assert.ok(win.has('registry') && win.has('notification'))
  assert.ok(!win.has('read_window_text') && !win.has('click_text') && !win.has('wait_for_text') && !win.has('wait_for_stable'), 'OCR tools are macOS-only')
  assert.ok(!linux.has('list_spaces') && !linux.has('registry'), 'Linux has neither Spaces nor the registry')
  await assert.rejects(callTool({ platform: 'darwin', profile: 'full' }, 'registry', { mode: 'get', path: 'HKCU:\\x', name: 'y' }), /registry|not found|unknown|disabled/i)
})

// ── One click, five aliases ─────────────────────────────────────────────────────────────────────

test('click carries the full schema and the v7 variants are thin aliases', async () => {
  const tools = await listed({ platform: 'darwin', profile: 'full' })
  const byName = Object.fromEntries(tools.map(t => [t.name, t]))
  const click = byName.click
  assert.ok(click, 'click exists')
  assert.deepEqual(click.inputSchema.properties.button.enum, ['left', 'right', 'middle'])
  assert.ok(click.inputSchema.properties.count)
  assert.ok(click.inputSchema.properties.delivery && click.inputSchema.properties.target_app, 'click keeps targeting and delivery')
  for (const alias of ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click']) {
    const tool = byName[alias]
    assert.ok(tool, `${alias} still listed`)
    assert.ok(bytes(tool) < 600, `${alias} is thin (${bytes(tool)} bytes)`)
    assert.match(tool.description, /Alias of click/)
  }
})

test('click dispatches button and count and validates them; aliases still work with passthrough targeting', async () => {
  const calls = []
  const native = {
    calls,
    getDisplaySize: () => ({ width: 500, height: 400 }),
    getWindow: () => null,
    getFrontmostApp: () => ({ bundleId: 'app.front' }),
    mouseMove: (...a) => calls.push(['move', ...a]),
    mouseClick: (...a) => calls.push(['click', ...a]),
    cursorPosition: () => ({ x: 7, y: 8 }),
    findElement: () => [],
  }
  const targets = new TargetStateController(native, () => 100)
  const handler = new InputHandler({ native, targets, focus: { strategyFor: () => 'none', ensure: async () => ({}) }, platform: 'linux', sleep: async () => {} })
  await handler.handle('click', { coordinate: [10, 20], button: 'right', count: 2 })
  assert.deepEqual(calls.at(-1), ['click', 10, 20, 'right', 2])
  await handler.handle('click', { coordinate: [10, 20] })
  assert.deepEqual(calls.at(-1), ['click', 10, 20, 'left', 1])
  await assert.rejects(handler.handle('click', { coordinate: [10, 20], button: 'back' }), /Invalid button/)
  await assert.rejects(handler.handle('click', { coordinate: [10, 20], count: 5 }), /Invalid count/)
  await handler.handle('triple_click', { coordinate: [1, 2], target_app: 'app.x' })
  assert.deepEqual(calls.at(-1), ['click', 1, 2, 'left', 3])
})

// ── approval_token and _meta ───────────────────────────────────────────────────────────────────

test('approval_token is advertised on no schema by default and on every mutating tool when asked', async () => {
  const tools = await listed({ platform: 'darwin', profile: 'full' })
  for (const tool of tools) assert.ok(!(tool.inputSchema.properties ?? {}).approval_token, `${tool.name} does not advertise approval_token`)
  const legacy = await listed({ platform: 'darwin', profile: 'full', advertiseApprovalToken: true })
  const mutating = legacy.filter(t => TOOL_CATALOG[t.name].mutates)
  assert.ok(mutating.length > 20)
  for (const tool of mutating) assert.ok(tool.inputSchema.properties.approval_token, `${tool.name} advertises approval_token in legacy mode`)
})

test('each tool carries two _meta fields by default and seven when asked', async () => {
  const tools = await listed({ platform: 'darwin', profile: 'full' })
  for (const tool of tools) {
    assert.deepEqual(Object.keys(tool._meta ?? {}).sort(), ['computer-use/focusRequired', 'computer-use/mutates'], `${tool.name} _meta`)
  }
  const full = await listed({ platform: 'darwin', profile: 'full', fullWireMeta: true })
  const screenshot = full.find(t => t.name === 'screenshot')
  assert.equal(Object.keys(screenshot._meta).length, 7)
})

// ── set_target / get_target ─────────────────────────────────────────────────────────────────────

test('set_target and get_target make the session target explicit', async () => {
  const windows = { 42: { windowId: 42, bundleId: 'com.example.app', title: 'Example - Main', isOnScreen: true, bounds: { x: 0, y: 0, width: 800, height: 600 }, isFocused: false } }
  const native = {
    getDisplaySize: () => ({ width: 2000, height: 1200 }),
    getWindow: id => windows[id] ?? null,
    getFrontmostApp: () => ({ bundleId: 'app.front' }),
    listWindows: () => Object.values(windows),
    cursorPosition: () => ({ x: 0, y: 0 }),
    findElement: () => [],
  }
  const targets = new TargetStateController(native, () => 1234)
  const handler = new InputHandler({ native, targets, focus: { strategyFor: () => 'none', ensure: async () => ({}) }, platform: 'darwin', sleep: async () => {} })
  const none = await handler.handle('get_target', {})
  assert.equal(none.structuredContent.target, null)
  const set = await handler.handle('set_target', { window_id: 42 })
  assert.equal(set.structuredContent.target.windowId, 42)
  assert.equal(set.structuredContent.target.app, 'com.example.app')
  assert.equal(set.structuredContent.target.title, 'Example - Main')
  assert.equal(set.structuredContent.target.onScreen, true)
  assert.equal(set.structuredContent.target.establishedBy, 'activation')
  assert.deepEqual(targets.resolve({}), { bundleId: 'com.example.app', windowId: 42 })
  const cleared = await handler.handle('set_target', { clear: true })
  assert.equal(cleared.structuredContent.cleared, true)
  assert.equal((await handler.handle('get_target', {})).structuredContent.target, null)
  await assert.rejects(handler.handle('set_target', {}), /needs app, window_id, or clear/)
  await assert.rejects(handler.handle('set_target', { window_id: 7 }), /7/)
  assert.ok(MAX_HOLD_SECONDS >= 1)
})

// ── Instructions generated from the catalog ─────────────────────────────────────────────────────

test('instructions name only tools that are listed on that platform and profile, and name the key ones', () => {
  for (const [platform, profile] of [['darwin', 'desktop'], ['darwin', 'full'], ['win32', 'desktop'], ['linux', 'full']]) {
    const text = buildInstructions(platform, profile)
    const listedSet = new Set(listedTools(platform, profile))
    const mentioned = [...new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])].filter(name => name in TOOL_CATALOG)
    for (const name of mentioned) assert.ok(listedSet.has(name), `${platform}/${profile} instructions mention ${name}, which is not listed`)
    for (const key of ['screenshot', 'zoom', 'click', 'type', 'key', 'scroll', 'list_windows', 'set_target', 'doctor', 'get_tool_guide', 'wait_for_window']) {
      assert.ok(text.includes(key), `${platform}/${profile} instructions name ${key}`)
    }
    assert.ok(!/macOS and Windows/.test(text))
  }
  const mac = buildInstructions('darwin', 'desktop')
  assert.match(mac, /read_window_text/)
  assert.match(mac, /user_active/)
  assert.match(mac, /delivery: "pid"/)
  assert.ok(!/get_ui_tree/.test(mac), 'the desktop profile has no accessibility tools, so the instructions do not send the agent there')
  const win = buildInstructions('win32', 'full')
  assert.ok(!/read_window_text/.test(win), 'OCR tools are not promised on Windows')
  assert.match(win, /get_ui_tree/)
})

test('every catalog tool has a job and desktop sits between core and full', () => {
  for (const [name, meta] of Object.entries(TOOL_CATALOG)) assert.ok(meta.job, `${name} has a job`)
  const core = Object.values(TOOL_CATALOG).filter(m => toolInProfile(m, 'core')).length
  const desktop = Object.values(TOOL_CATALOG).filter(m => toolInProfile(m, 'desktop')).length
  const full = Object.keys(TOOL_CATALOG).length
  assert.ok(core < desktop && desktop < full, `core ${core} < desktop ${desktop} < full ${full}`)
})
