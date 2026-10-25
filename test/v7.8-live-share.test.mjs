// 7.8 live share: the live tools over MCP, the tiered driver over a fake model, the card's watching state, and the
// console host's Watch button. No screen and no API key.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { RunStore } from '../dist/agent-run.js'
import { LiveDriver } from '../dist/live-driver.js'
import { LiveWatcher } from '../dist/session/live-watcher.js'
import { OperatorControl } from '../dist/session/operator-control.js'
import { serve } from '../dist/run-console-host.js'

const flush = () => new Promise(resolve => setImmediate(resolve))
const text = result => result.content.find(block => block.type === 'text').text
const parse = result => JSON.parse(text(result))
const DISPLAY = { x: 0, y: 0, width: 1440, height: 900 }

/** A watcher over fakes, stepped by hand. */
function fakeWatcher() {
  const timers = []
  const state = { front: { bundleId: 'com.apple.Terminal' }, windows: [] }
  const watcher = new LiveWatcher({
    native: { listWindows: () => state.windows, getFrontmostApp: () => state.front, getDisplaySize: () => DISPLAY, getWindow: () => null },
    helper: {
      supportsCapture: () => true,
      capture: async options => options.diff
        ? { data: Buffer.alloc(0), unchanged: true, width: 640, height: 400, frame: DISPLAY, scale: 0.44, diff: { changed: false, area: 0 } }
        : { data: Buffer.from('FRAME'), mimeType: 'image/jpeg', width: options.width, height: 800, frame: DISPLAY, hash: 'f', scale: 1, path: '', bytes: 5 },
    },
    platform: 'darwin',
    setTimer: run => { const timer = { run, cancelled: false, cancel() { this.cancelled = true } }; timers.push(timer); return timer },
  })
  const step = async () => { const timer = timers.filter(entry => !entry.cancelled).at(-1); timers.length = 0; timer?.run(); await flush(); await flush() }
  return { watcher, state, step }
}

// ── The tools ──────────────────────────────────────────────────────────────────

test('live_watch and live_events are listed only when live share is on', async () => {
  const { watcher } = fakeWatcher()
  const session = { dispatch: async () => ({ content: [{ type: 'text', text: 'ok' }] }), live: watcher }
  const off = await connectInProcess(createComputerUseServer({ session }))
  assert.ok(!(await off.listTools()).some(tool => tool.name.startsWith('live_')))
  await off.close()
  const on = await connectInProcess(createComputerUseServer({ session, live: true }))
  const names = (await on.listTools()).map(tool => tool.name)
  assert.ok(names.includes('live_watch') && names.includes('live_events'))
  await on.close()
})

test('a model starts a watch, waits for the next event, and asks for a frame to look at', async () => {
  const { watcher, state, step } = fakeWatcher()
  const client = await connectInProcess(createComputerUseServer({ session: { dispatch: async () => ({ content: [] }), live: watcher }, live: true }))
  try {
    const started = parse(await client.callTool('live_watch', { action: 'start' }))
    assert.equal(started.watching, true)
    assert.match(started.hint, /live_events/)
    await step()
    const waiting = client.callTool('live_events', { since: started.lastSeq, wait_ms: 5_000, frame: true })
    state.front = { bundleId: 'com.apple.Safari' }
    await step()
    const result = await waiting
    const body = parse(result)
    assert.equal(body.events[0].kind, 'focus_changed')
    assert.equal(body.events[0].app, 'com.apple.Safari')
    assert.ok(body.last_seq >= body.events[0].seq)
    assert.equal(body.frame.width, 1280)
    assert.match(body.frame.mapping, /screen_x = 0 \+ image_x \* 1\.1250/)
    const image = result.content.find(block => block.type === 'image')
    assert.equal(image.data, Buffer.from('FRAME').toString('base64'))
    const stopped = parse(await client.callTool('live_watch', { action: 'stop' }))
    assert.equal(stopped.watching, false)
    assert.equal(stopped.stoppedReason, 'stopped_by_agent')
    const idle = parse(await client.callTool('live_events', { since: body.last_seq + 1 }))
    assert.match(idle.hint ?? '', /Nothing is being watched/)
    const bad = await client.callTool('live_watch', { action: 'start', target_window_id: 99 })
    assert.equal(bad.isError, true)
    assert.equal(parse(bad).error, 'window_not_found')
    const unknown = await client.callTool('live_events', { sinse: 1 })
    assert.equal(parse(unknown).error, 'invalid_arguments', 'a typo is refused by name, not ignored')
  } finally {
    await client.close()
  }
})

// ── The driver ─────────────────────────────────────────────────────────────────

/** A fake watcher for the driver: events on demand and a frame. */
function driverRig({ replies = [], act = false, limits } = {}) {
  const listeners = new Set()
  const watcher = {
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    latestFrame: async () => ({ data: 'RlJBTUU=', mimeType: 'image/jpeg', width: 1024, height: 640, frame: DISPLAY, capturedAt: '' }),
  }
  const store = new RunStore()
  const run = store.start('Tell me when the build finishes', 'run-live-1')
  const calls = []
  const queue = [...replies]
  const createMessage = async (params, beta) => {
    calls.push({ params, beta })
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next ?? { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"caption":"nothing","relevant":false,"escalate":false,"reason":""}' }], usage: { input_tokens: 10, output_tokens: 5 } }
  }
  const toolCalls = []
  const client = {
    listTools: async () => [
      { name: 'screenshot', description: 'Capture', inputSchema: { type: 'object', properties: {} } },
      { name: 'click', description: 'Click', inputSchema: { type: 'object', properties: { coordinate: { type: 'array' } } } },
      { name: 'run_say', description: 'Console', inputSchema: { type: 'object' } },
      { name: 'live_events', description: 'Events', inputSchema: { type: 'object' } },
    ],
    callTool: async (name, args) => { toolCalls.push([name, args]); return { content: [{ type: 'text', text: 'Clicked' }] } },
  }
  let now = 1_000_000
  const driver = new LiveDriver({ watcher, store, client, runId: () => run.runId, createMessage, act, now: () => now, ...(limits ? { limits } : {}) })
  const emit = event => { for (const listener of listeners) listener({ seq: 1, at: '', cause: 'other', ...event }) }
  return { driver, store, run, calls, toolCalls, emit, advance: ms => { now += ms } }
}

const settle = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await flush() }
const triageReply = verdict => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(verdict) }], usage: { input_tokens: 900, output_tokens: 30, cache_read_input_tokens: 500 } })

test('triage reads an event with a frame on Haiku, with thinking off and no tools, and captions it for the person', async () => {
  const r = driverRig({ replies: [triageReply({ caption: 'The build log scrolled', relevant: false, escalate: false, reason: 'routine' })] })
  r.driver.start()
  r.emit({ kind: 'screen', area: 0.05, region: { x: 0, y: 400, width: 1440, height: 200 } })
  await settle()
  r.driver.stop()
  assert.equal(r.calls.length, 1)
  const { params, beta } = r.calls[0]
  assert.equal(beta, false)
  assert.equal(params.model, 'claude-haiku-5-5')
  assert.deepEqual(params.thinking, { type: 'disabled' })
  assert.equal(params.output_config.effort, 'low')
  assert.equal(params.output_config.format.type, 'json_schema')
  assert.equal(params.tools, undefined, 'triage cannot act')
  const content = params.messages[0].content
  assert.match(content[0].text, /Goal: Tell me when the build finishes/)
  assert.match(content[0].text, /"kind":"screen"/)
  assert.equal(content[1].type, 'image')
  assert.match(content[2].text, /untrusted/)
  const activity = r.store.status(r.run.runId).activity
  assert.equal(activity.at(-1).detail, 'The build log scrolled')
  assert.equal(r.store.status(r.run.runId).usage.inputTokens, 900)
  assert.equal(r.driver.status().tokens.triage.cacheRead, 500)
})

test('an escalation goes to Opus, which may only speak unless actions were allowed', async () => {
  const r = driverRig({ replies: [
    triageReply({ caption: 'Build failed with 3 errors', relevant: true, escalate: true, reason: 'the goal' }),
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Your build just failed: 3 type errors in server.ts.' }], usage: { input_tokens: 2000, output_tokens: 40 } },
  ] })
  r.driver.start()
  r.emit({ kind: 'screen', area: 0.2 })
  await settle(16)
  r.driver.stop()
  assert.equal(r.calls.length, 2)
  const { params, beta } = r.calls[1]
  assert.equal(beta, true, 'the beta endpoint, for server-side fallbacks')
  assert.equal(params.model, 'claude-opus-5-5')
  assert.equal(params.fallbacks, 'default')
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01'])
  assert.deepEqual(params.thinking, { type: 'adaptive' })
  assert.equal(params.tools, undefined, 'no tools: the person did not ask and actions were not allowed')
  assert.match(params.messages[0].content[0].text, /Build failed with 3 errors/)
  const messages = r.store.status(r.run.runId).messages
  assert.equal(messages.at(-1).role, 'agent')
  assert.match(messages.at(-1).text, /build just failed/)
  assert.equal(r.driver.status().escalated, 1)
})

test('the person\'s message goes straight to Opus with the desktop tools, and the tool loop runs through the session', async () => {
  const r = driverRig({ replies: [
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Clicking Retry.' }, { type: 'tool_use', id: 'tu_1', name: 'click', input: { coordinate: [400, 300] } }], usage: { input_tokens: 3000, output_tokens: 60 } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done: I clicked Retry and the build restarted.' }], usage: { input_tokens: 3100, output_tokens: 20 } },
  ] })
  r.store.say(r.run.runId, 'user', 'click retry please')
  r.driver.start()
  await new Promise(resolve => setTimeout(resolve, 400))
  await settle(16)
  r.driver.stop()
  assert.equal(r.calls.length, 2)
  const tools = r.calls[0].params.tools.map(tool => tool.name)
  assert.deepEqual(tools, ['screenshot', 'click'], 'the console and watch tools are the driver\'s own')
  assert.deepEqual(r.calls[0].params.tools.at(-1).cache_control, { type: 'ephemeral' })
  assert.match(r.calls[0].params.messages[0].content[0].text, /The person just said:\nclick retry please/)
  assert.deepEqual(r.toolCalls, [['click', { coordinate: [400, 300] }]])
  const followUp = r.calls[1].params.messages
  assert.equal(followUp[1].role, 'assistant')
  assert.equal(followUp[2].content[0].type, 'tool_result')
  assert.equal(followUp[2].content[0].tool_use_id, 'tu_1')
  const run = r.store.status(r.run.runId)
  assert.match(run.messages.at(-1).text, /clicked Retry/)
  assert.deepEqual(r.store.pending(r.run.runId), [], 'the person\'s message was answered')
  assert.ok(run.activity.some(entry => entry.kind === 'tool' && entry.name === 'click'))
})

test('changes the agent made, a credential manager in front, and the watcher\'s own reports are not triaged', async () => {
  const r = driverRig()
  r.driver.start()
  r.emit({ kind: 'screen', area: 0.3, cause: 'agent' })
  r.emit({ kind: 'focus_changed', sensitive: true })
  r.emit({ kind: 'watch_started' })
  r.emit({ kind: 'paused' })
  await settle()
  r.driver.stop()
  assert.equal(r.calls.length, 0)
  assert.equal(r.driver.status().skipped, 2)
})

test('with act: true, Opus gets the tools for what triage escalates too', async () => {
  const r = driverRig({ act: true, replies: [
    triageReply({ caption: 'A dialog asks to save', relevant: true, escalate: true, reason: 'waiting' }),
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'A save dialog is open.' }], usage: {} },
  ] })
  r.driver.start()
  r.emit({ kind: 'window_opened', title: 'Save' })
  await settle(16)
  r.driver.stop()
  assert.deepEqual(r.calls[1].params.tools.map(tool => tool.name), ['screenshot', 'click'])
})

test('triage is rate-limited, and a rate-limited API backs off; a rejected key stops the driver', async () => {
  const limited = driverRig({ limits: { triagePerHour: 1, triageSpacingMs: 0 } })
  limited.driver.start()
  limited.emit({ kind: 'screen', area: 0.1 })
  await settle()
  limited.emit({ kind: 'screen', area: 0.1 })
  await settle()
  limited.driver.stop()
  assert.equal(limited.calls.length, 1, 'one triage an hour')

  const busy = driverRig({ replies: [Object.assign(new Error('rate limited'), { status: 429 })], limits: { triageSpacingMs: 0 } })
  busy.driver.start()
  busy.emit({ kind: 'screen', area: 0.1 })
  await settle()
  busy.emit({ kind: 'screen', area: 0.1 })
  await settle()
  assert.equal(busy.calls.length, 1, 'backing off after a 429')
  assert.match(busy.driver.status().lastError, /^429: rate limited/)
  assert.ok(busy.store.status(busy.run.runId).activity.some(entry => entry.failed && entry.name === 'model'))
  busy.driver.stop()

  const denied = driverRig({ replies: [Object.assign(new Error('invalid x-api-key'), { status: 401 })] })
  denied.driver.start()
  denied.emit({ kind: 'screen', area: 0.1 })
  await settle()
  assert.equal(denied.driver.status().running, false)
})

// ── The card and the host ──────────────────────────────────────────────────────

test('watching shows on the card, which launches for a watch that only looks', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'card-watch-'))
  let started = 0
  const control = new OperatorControl({ card: { presenter: { kind: 'fake', start() { started += 1 }, stop() {} }, directory, pollMs: 10 } })
  control.watching({ target: 'the screen', since: 1_000 })
  await flush()
  const frame = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))
  assert.deepEqual(frame.watching, { target: 'the screen', since: 1_000 })
  assert.equal(started, 1)
  assert.equal(control.status().watching.target, 'the screen')
  control.watching(null)
  assert.equal(JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')).watching, null)
  control.close()
})

test('the console offers Watch only with live share on, and the person\'s Watch button starts the watch', async () => {
  const { watcher } = fakeWatcher()
  const session = { dispatch: async () => ({ content: [{ type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' }] }), live: watcher }
  const post = async (host, body) => (await fetch(`${host.url}rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json()

  const plain = await serve({ port: 0, session, demo: false })
  try {
    const refused = await post(plain, { name: 'live_watch', arguments: { action: 'start' } })
    assert.equal(refused.isError, true)
    assert.equal(JSON.parse(text(await post(plain, { name: 'run_console', arguments: {} }))).live, undefined)
  } finally { await plain.close() }

  const host = await serve({ port: 0, session, demo: false, live: { createMessage: async () => ({ stop_reason: 'end_turn', content: [], usage: {} }) } })
  try {
    const before = JSON.parse(text(await post(host, { name: 'run_console', arguments: {} })))
    assert.equal(before.live.watching, false, 'offered before the first message')
    assert.equal(before.live.driver.running, true)
    const after = JSON.parse(text(await post(host, { name: 'live_watch', arguments: { action: 'start' } })))
    assert.equal(after.live.watching, true)
    assert.match(after.prompt, /Watch the screen with me/, 'a conversation is opened for the replies')
    const tools = await fetch(host.mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }).then(response => response.text())
    assert.match(tools, /live_events/, 'an agent on /mcp gets the live tools too')
    const stopped = JSON.parse(text(await post(host, { name: 'live_watch', arguments: { action: 'stop' } })))
    assert.equal(stopped.live.watching, false)
  } finally { await host.close() }
})
