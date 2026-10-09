import assert from 'node:assert/strict'
import test from 'node:test'
import { handleAgentDesktopTool, AGENT_DESKTOP_TOOLS } from '../dist/session/agent-desktop-handlers.js'
import { HelperFailure } from '../dist/session/macos-helper.js'
import { TargetStateController } from '../dist/session/target-state.js'

// v7.6 R3: wait_for_text and wait_for_stable, over a fake helper and a fake clock.

const bounds = { x: 100, y: 30, width: 1000, height: 600 }
const window = { windowId: 7, bundleId: 'com.epicgames.UnrealEditor', pid: 4242, title: 'Editor', bounds, isOnScreen: true }
const APP = 'com.epicgames.UnrealEditor'

const ocrOf = (...texts) => ({
  width: 2000, height: 1200, scale: 2,
  lines: texts.map((text, index) => ({ text, confidence: 0.95, box: { x: 40, y: 20 + index * 40, w: 200, h: 30 } })),
})

/** A world where time only moves when something sleeps, and each OCR/capture costs `workMs`. */
function world({ ocrs = [ocrOf('Loading')], hashes = ['a'], workMs = 0, windowGoneAfter = Infinity } = {}) {
  let clock = 0
  let ocrCalls = 0
  let captureCalls = 0
  const sleeps = []
  const calls = []
  const native = {
    getWindow: id => (id === 7 ? window : null),
    listWindows: () => (ocrCalls + captureCalls >= windowGoneAfter ? [] : [window]),
  }
  const helper = {
    ensure: async () => ({ ok: true, path: '/fake' }),
    supportsCapture: () => true,
    ocr: async options => {
      calls.push(['ocr', options]); clock += workMs
      return ocrs[Math.min(ocrCalls++, ocrs.length - 1)]
    },
    capture: async options => {
      calls.push(['capture', options]); clock += workMs
      const hash = hashes[Math.min(captureCalls++, hashes.length - 1)]
      return { hash, width: 800, height: 480, scale: 0.8, frame: bounds, mimeType: 'image/jpeg', bytes: 1, path: '', data: Buffer.from(hash) }
    },
  }
  const controller = new AbortController()
  const context = {
    native, helper, platform: 'darwin', targets: new TargetStateController(native, () => 1),
    now: () => clock, signal: controller.signal,
    sleepAbortable: async ms => { sleeps.push(ms); clock += ms; return controller.signal.aborted },
  }
  return { context, sleeps, calls, controller, clock: () => clock }
}

test('both tools are routed by the agent-desktop handler', () => {
  assert.ok(AGENT_DESKTOP_TOOLS.has('wait_for_text'))
  assert.ok(AGENT_DESKTOP_TOOLS.has('wait_for_stable'))
})

// ── wait_for_text ────────────────────────────────────────────────────────────

test('wait_for_text polls the OCR until a line matches, case-insensitively, and returns box and screen point', async () => {
  const w = world({ ocrs: [ocrOf('Loading'), ocrOf('Compiling Shaders (12)'), ocrOf('Ready', 'Compile Complete')] })
  const result = await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'compile complete' }, w.context)
  assert.equal(result.isError, undefined)
  const body = result.structuredContent
  assert.equal(body.found, true)
  assert.equal(body.polls, 3)
  assert.equal(body.match.text, 'Compile Complete')
  assert.deepEqual(body.match.box, { x: 20, y: 30, w: 100, h: 15 })
  // Screen point = window origin + the centre of the matched text.
  assert.deepEqual(body.match.screen, { x: 100 + 20 + 50, y: 30 + 30 + 8 })
  assert.deepEqual(body.screen_origin, { x: 100, y: 30 })
  assert.equal(body.window.windowId, 7)
  assert.deepEqual(w.sleeps, [500, 500], 'default poll interval, no other sleeps')
  assert.equal(body.waitedMs, 1000)
})

test('wait_for_text exact and regex modes, region passthrough, and an invalid regex', async () => {
  const w = world({ ocrs: [ocrOf('Build Succeeded 3 warnings')] })
  const exact = await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'build', match: 'exact', timeout_ms: 0 }, w.context)
  assert.equal(exact.structuredContent.error, 'timeout', 'exact needs the whole line')
  const regex = await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'succeeded \\d+ warn', match: 'regex', region: [0, 0, 500, 100] }, w.context)
  assert.equal(regex.structuredContent.found, true)
  assert.deepEqual(w.calls.at(-1)[1].region, { x: 0, y: 0, width: 500, height: 100 })
  const bad = await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: '(', match: 'regex' }, w.context)
  assert.equal(bad.structuredContent.error, 'invalid_regex')
  await assert.rejects(handleAgentDesktopTool('wait_for_text', { target_app: APP, text: '' }, w.context), /text/)
})

test('wait_for_text with gone waits for the text to disappear', async () => {
  const w = world({ ocrs: [ocrOf('Saving...'), ocrOf('Saving...'), ocrOf('Saved')] })
  const result = await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'saving...', gone: true }, w.context)
  assert.equal(result.structuredContent.gone, true)
  assert.equal(result.structuredContent.polls, 3)
})

test('wait_for_text times out with a structured error listing the last 20 lines seen', async () => {
  const many = ocrOf(...Array.from({ length: 30 }, (_, index) => `line ${index}`))
  const w = world({ ocrs: [many] })
  const result = await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'never', timeout_ms: 1200, poll_ms: 500 }, w.context)
  assert.equal(result.isError, true)
  const body = result.structuredContent
  assert.equal(body.error, 'timeout')
  assert.equal(body.polls, 4)
  assert.ok(body.waitedMs >= 1200)
  assert.equal(body.seen.length, 20)
  assert.equal(body.seen[0], 'line 0')
  assert.equal(body.seenTruncated, 10)
  // The last sleep is trimmed to the time that remained, never a full interval past the deadline.
  assert.deepEqual(w.sleeps, [500, 500, 200])
})

test('wait_for_text takes OCR time out of the poll interval and enforces the poll floor and timeout cap', async () => {
  // A 200 ms floor minus 300 ms of OCR leaves nothing to sleep.
  const busy = world({ ocrs: [ocrOf('x'), ocrOf('target')], workMs: 300 })
  const first = await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'target', poll_ms: 1 }, busy.context)
  assert.equal(first.structuredContent.found, true)
  assert.deepEqual(busy.sleeps, [])
  const slow = world({ ocrs: [ocrOf('x'), ocrOf('target')], workMs: 100 })
  await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'target', poll_ms: 1 }, slow.context)
  assert.deepEqual(slow.sleeps, [100], '200 ms floor minus 100 ms of OCR')
  const capped = world({ ocrs: [ocrOf('x')] })
  const timeout = await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'never', timeout_ms: 9_999_999, poll_ms: 60_000 }, capped.context)
  assert.equal(timeout.structuredContent.error, 'timeout')
  assert.ok(timeout.structuredContent.waitedMs >= 120_000 && timeout.structuredContent.waitedMs <= 121_000)
})

test('wait_for_text honours cancellation, helper failures and non-macOS hosts', async () => {
  const w = world({ ocrs: [ocrOf('x')] })
  w.controller.abort()
  const cancelled = await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'never' }, w.context)
  assert.equal(cancelled.structuredContent.error, 'cancelled')
  const denied = world()
  denied.context.helper.ocr = async () => { throw new HelperFailure('screen_recording_denied', 'no') }
  const failure = await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'a' }, denied.context)
  assert.equal(failure.structuredContent.error, 'ocr_failed')
  const linux = await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'a' }, { ...w.context, platform: 'linux' })
  assert.equal(linux.structuredContent.error, 'platform_unsupported')
})

test('wait_for_text gone counts a vanished window as the text being gone', async () => {
  const w = world({ ocrs: [ocrOf('Saving...')], windowGoneAfter: 1 })
  const result = await handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'saving', gone: true }, w.context)
  assert.equal(result.structuredContent.gone, true)
  assert.equal(result.structuredContent.windowGone, true)
  const waiting = world({ ocrs: [ocrOf('Saving...')], windowGoneAfter: 1 })
  await assert.rejects(handleAgentDesktopTool('wait_for_text', { target_app: APP, text: 'saved' }, waiting.context), error => error.details?.error === 'window_not_found')
})

// ── wait_for_stable ──────────────────────────────────────────────────────────

test('wait_for_stable returns once consecutive captures have matched for quiet_ms', async () => {
  const w = world({ hashes: ['a', 'b', 'c', 'c', 'c', 'c', 'c', 'c'] })
  const result = await handleAgentDesktopTool('wait_for_stable', { target_app: APP, quiet_ms: 750 }, w.context)
  assert.equal(result.isError, undefined)
  const body = result.structuredContent
  assert.equal(body.stable, true)
  assert.equal(body.hash, 'c')
  assert.equal(body.changes, 2)
  // Changed at the third capture (t=500); quiet again after 750 ms more: the 6th capture (t=1250).
  assert.equal(body.polls, 6)
  assert.equal(body.waitedMs, 1250)
  assert.equal(body.window.windowId, 7)
  assert.deepEqual(w.sleeps, [250, 250, 250, 250, 250])
  const capture = w.calls[0][1]
  assert.equal(capture.windowId, 7)
  assert.equal(capture.format, 'jpeg')
  assert.ok(capture.width <= 1000, 'a reduced-size capture')
})

test('wait_for_stable times out on a window that keeps changing and counts the changes', async () => {
  const w = world({ hashes: Array.from({ length: 50 }, (_, index) => `h${index}`) })
  const result = await handleAgentDesktopTool('wait_for_stable', { target_app: APP, timeout_ms: 1000 }, w.context)
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.error, 'timeout')
  assert.equal(result.structuredContent.polls, 5)
  assert.equal(result.structuredContent.changes, 4)
  assert.equal(result.structuredContent.wantedQuietMs, 800)
})

test('wait_for_stable with quiet_ms 0 returns on the first capture; region is passed to the helper and reported', async () => {
  const w = world({ hashes: ['z'] })
  const result = await handleAgentDesktopTool('wait_for_stable', { target_window_id: 7, quiet_ms: 0, region: [10, 20, 300, 200] }, w.context)
  assert.equal(result.structuredContent.stable, true)
  assert.equal(result.structuredContent.polls, 1)
  assert.deepEqual(w.calls[0][1].region, { x: 10, y: 20, width: 300, height: 200 })
  assert.deepEqual(result.structuredContent.region, [10, 20, 300, 200])
  assert.equal(result.structuredContent.regionApplied, false, 'a helper that did not crop says so')
  assert.deepEqual(w.sleeps, [])
})

test('wait_for_stable hashes the bytes when the helper reports no hash, and never activates or moves anything', async () => {
  const w = world({ hashes: ['same'] })
  const original = w.context.helper.capture
  w.context.helper.capture = async options => ({ ...(await original(options)), hash: '' })
  const result = await handleAgentDesktopTool('wait_for_stable', { target_app: APP, quiet_ms: 300 }, w.context)
  assert.equal(result.structuredContent.stable, true)
  assert.match(result.structuredContent.hash, /^[0-9a-f]{16}$/)
  // The fake native has no input or activation functions: calling one would have thrown.
  assert.deepEqual(Object.keys(w.context.native).sort(), ['getWindow', 'listWindows'])
})

test('wait_for_stable honours cancellation, helper failures and non-macOS hosts', async () => {
  const w = world({ hashes: ['a', 'b'] })
  w.controller.abort()
  const cancelled = await handleAgentDesktopTool('wait_for_stable', { target_app: APP }, w.context)
  assert.equal(cancelled.structuredContent.error, 'cancelled')
  const denied = world()
  denied.context.helper.capture = async () => { throw new HelperFailure('screen_recording_denied', 'no') }
  const failure = await handleAgentDesktopTool('wait_for_stable', { target_app: APP }, denied.context)
  assert.equal(failure.structuredContent.error, 'capture_failed')
  assert.match(failure.structuredContent.remediation[0], /Screen/)
  const linux = await handleAgentDesktopTool('wait_for_stable', { target_app: APP }, { ...w.context, platform: 'linux' })
  assert.equal(linux.structuredContent.error, 'platform_unsupported')
  const none = await handleAgentDesktopTool('wait_for_stable', {}, w.context).catch(error => error)
  assert.equal(none.details.error, 'target_required')
})
