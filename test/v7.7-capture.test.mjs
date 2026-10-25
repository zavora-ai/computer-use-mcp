// 7.7.0 (K8, M5): macOS capture speed. One warm `serve` helper instead of a process per call; full-screen screenshots
// and zooms through a ScreenCaptureKit display capture instead of screencapture + sips; `--region` crops in the helper,
// so wait_for_stable reports regionApplied: true; wait_for_text polls with fast OCR and confirms with accurate.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMacosHelper, HelperFailure } from '../dist/session/macos-helper.js'
import { handleAgentDesktopTool } from '../dist/session/agent-desktop-handlers.js'
import { ScreenshotHandler } from '../dist/session/screenshot-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'
import { VirtualPointerController } from '../dist/session/virtual-pointer.js'

// ── The warm helper ──────────────────────────────────────────────────────────

/** Speaks the helper's serve protocol. FAKE_MODE picks what the first process (generation 1) does wrong. */
const FAKE_SERVE = `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const mode = process.env.FAKE_MODE
const log = process.env.FAKE_LOG
appendFileSync(log, process.pid + ' ' + process.argv.slice(3).join(' ') + '\\n')
const generation = readFileSync(log, 'utf8').trim().split('\\n').length
const first = generation === 1
let count = 0
const reply = object => process.stdout.write(JSON.stringify(object) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const { id, args } = JSON.parse(line)
  count++
  if (mode === 'die' || (mode === 'die-first' && first)) process.exit(3)
  if (mode === 'stall-first' && first) return
  if (mode === 'sck-timeout-first' && first) { reply({ id, error: 'sck_timeout', message: 'stalled' }); process.exit(0) }
  if (args[0] === 'capture') {
    writeFileSync(args[args.indexOf('--out') + 1], 'IMG' + count)
    process.stdout.write('a framework log line that is not a reply\\n')
    reply({ id, path: 'x', width: 10, height: 10, hash: 'h' + count, scale: 1, frame: { x: 0, y: 0, width: 10, height: 10 }, mimeType: 'image/jpeg', bytes: 4, argv: args })
  } else if (args[0] === 'ocr') {
    reply({ id, width: 10, height: 10, lines: [{ text: 'hello', confidence: 1, box: { x: 0, y: 0, w: 5, h: 5 } }] })
  } else {
    reply({ id, error: 'usage', message: 'unknown' })
  }
}).on('close', () => process.exit(0))
`

function serveFixture(mode = 'ok', extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cu-helper-serve-'))
  const source = join(dir, 'helper.swift')
  writeFileSync(source, '// fixture')
  const sha = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 8)
  writeFileSync(join(dir, `macos-agent-helper-${sha}`), '') // already "compiled"
  const script = join(dir, 'fake-serve.mjs')
  writeFileSync(script, FAKE_SERVE)
  const log = join(dir, 'spawns.log')
  writeFileSync(log, '')
  const helper = createMacosHelper({
    sourcePath: source, cacheDir: dir, platform: 'darwin', darwinRelease: '25.2.0', serve: true,
    spawnServe: (file, args) => spawn(process.execPath, [script, file, ...args], { env: { ...process.env, FAKE_MODE: mode, FAKE_LOG: log } }),
    ...extra,
  })
  const spawns = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split(' '))
  return { dir, helper, spawns, cleanup: () => { helper.close(); rmSync(dir, { recursive: true, force: true }) } }
}

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
async function gone(pid) {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 20))
  return !alive(pid)
}

test('one warm helper answers every call, and close stops it', async () => {
  const f = serveFixture()
  const a = await f.helper.capture({ windowId: 5, width: 800 })
  const b = await f.helper.capture({ displayId: 'main', overlayPids: [process.pid], region: { x: 1, y: 2, width: 30, height: 40 }, format: 'png' })
  const text = await f.helper.ocr({ windowId: 5, fast: true })
  assert.equal(f.spawns().length, 1, 'one process for three calls')
  const [pid, ...argv] = f.spawns()[0]
  assert.deepEqual(argv, ['serve', '--idle-ms', '60000'])
  assert.equal(a.hash, 'h1'); assert.equal(a.data.toString(), 'IMG1')
  assert.equal(b.data.toString(), 'IMG2')
  assert.deepEqual(b.argv.slice(0, 5), ['capture', '--display', 'main', '--overlay-pids', String(process.pid)])
  assert.ok(!b.argv.includes('--window'))
  assert.equal(b.argv[b.argv.indexOf('--region') + 1], '1,2,30,40')
  assert.equal(text.lines[0].text, 'hello')
  assert.equal(existsSync(join(f.dir, 'helper.lock')), false, 'the lock is held per call, not for the process')
  f.helper.close()
  assert.ok(await gone(Number(pid)), 'close stops the warm helper')
  f.cleanup()
})

test('a helper that dies before replying is replaced and the call asked once more; twice is helper_failed', async () => {
  const f = serveFixture('die-first')
  const capture = await f.helper.capture({ windowId: 1 })
  assert.equal(capture.hash, 'h1')
  assert.equal(f.spawns().length, 2)
  f.cleanup()
  const always = serveFixture('die')
  await assert.rejects(always.helper.capture({ windowId: 1 }),
    error => error instanceof HelperFailure && error.code === 'helper_failed' && /exited \(code 3\) before replying/.test(error.message))
  assert.equal(always.spawns().length, 2, 'retried once, not forever')
  always.cleanup()
})

test('a stalled call times out as helper_timeout, stops the helper, and the next call gets a fresh one', async () => {
  const f = serveFixture('stall-first', { callTimeoutMs: 200 })
  await assert.rejects(f.helper.capture({ windowId: 1 }), error => error instanceof HelperFailure && error.code === 'helper_timeout')
  const stalled = Number(f.spawns()[0][0])
  assert.ok(await gone(stalled), 'the stalled helper was stopped')
  assert.equal((await f.helper.capture({ windowId: 1 })).hash, 'h1')
  assert.equal(f.spawns().length, 2)
  f.cleanup()
})

test('a cancelled call stops the warm helper and releases the lock', async () => {
  const f = serveFixture('stall-first')
  const controller = new AbortController()
  const pending = f.helper.capture({ windowId: 1 }, controller.signal)
  // Cancel once the helper is running and holding the call (it logs itself on start).
  for (let i = 0; i < 250 && f.spawns().length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20))
  controller.abort()
  await assert.rejects(pending, error => error instanceof HelperFailure && error.code === 'aborted')
  assert.ok(await gone(Number(f.spawns()[0][0])))
  assert.equal(existsSync(join(f.dir, 'helper.lock')), false)
  assert.equal((await f.helper.capture({ windowId: 1 })).hash, 'h1')
  f.cleanup()
})

test('after a ScreenCaptureKit stall the helper exits and the next call starts another', async () => {
  const f = serveFixture('sck-timeout-first')
  await assert.rejects(f.helper.capture({ windowId: 1 }), error => error instanceof HelperFailure && error.code === 'sck_timeout')
  assert.equal((await f.helper.capture({ windowId: 1 })).hash, 'h1')
  assert.equal(f.spawns().length, 2)
  f.cleanup()
})

test('an idle warm helper is stopped after serveIdleMs', async () => {
  const f = serveFixture('ok', { serveIdleMs: 100 })
  await f.helper.capture({ windowId: 1 })
  assert.ok(await gone(Number(f.spawns()[0][0])), 'stopped once idle')
  await f.helper.capture({ windowId: 1 })
  assert.equal(f.spawns().length, 2, 'the next call starts it again')
  f.cleanup()
})

test('COMPUTER_USE_HELPER_SERVE=false runs one process per call, with the display arguments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cu-helper-oneshot-'))
  const source = join(dir, 'helper.swift')
  writeFileSync(source, '// fixture')
  const sha = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 8)
  writeFileSync(join(dir, `macos-agent-helper-${sha}`), '')
  const calls = []
  const run = async (file, args) => {
    if (file === 'codesign') return { code: 0, stdout: '', stderr: '' }
    calls.push(args)
    writeFileSync(args[args.indexOf('--out') + 1], 'IMG')
    return { code: 0, stderr: '', stdout: JSON.stringify({ path: 'x', width: 1, height: 1, hash: 'd', scale: 1, frame: { x: 0, y: 0, width: 1, height: 1 }, mimeType: 'image/png', bytes: 3, display: 2 }) }
  }
  const helper = createMacosHelper({ sourcePath: source, cacheDir: dir, platform: 'darwin', darwinRelease: '25.2.0', run, env: { COMPUTER_USE_HELPER_SERVE: 'false' } })
  const capture = await helper.capture({ displayId: 2, format: 'png' })
  assert.equal(capture.display, 2)
  assert.deepEqual(calls[0].slice(0, 3), ['capture', '--display', '2'])
  await assert.rejects(helper.capture({}), error => error instanceof HelperFailure && error.code === 'usage')
  rmSync(dir, { recursive: true, force: true })
})

// ── screenshot and zoom through a display capture ────────────────────────────

const DISPLAY_FRAME = { x: -1440, y: 0, width: 1440, height: 900 }

function shots({ capture } = {}) {
  const calls = []
  const window = { windowId: 42, bundleId: 'app.target', title: 'Doc', bounds: { x: 100, y: 50, width: 400, height: 300 }, isOnScreen: true }
  const native = {
    getWindow: id => (id === 42 ? window : null),
    listWindows: () => [window],
    getFrontmostApp: () => ({ bundleId: 'app.front', displayName: 'Front' }),
    getDisplaySize: () => ({ width: 1440, height: 900 }),
    takeScreenshot: (...args) => { calls.push(['native', ...args]); return { base64: 'native', width: 720, height: 450, mimeType: 'image/jpeg', hash: 'n' } },
    cropImage: (...args) => { calls.push(['crop', ...args]); return { base64: 'crop', width: 20, height: 30, mimeType: 'image/png' } },
  }
  const helper = {
    ensure: async () => ({ ok: true, path: '/fake' }),
    supportsCapture: () => true,
    capture: async options => {
      calls.push(['helper', options])
      if (capture) return capture(options)
      const region = options.region
      return {
        path: 'x', hash: 'd1', mimeType: options.format === 'png' ? 'image/png' : 'image/jpeg', bytes: 7,
        width: region ? region.width : 1024, height: region ? region.height : 640, scale: 1024 / 1440,
        frame: options.displayId !== undefined ? DISPLAY_FRAME : window.bounds,
        ...(options.displayId !== undefined ? { display: 3 } : { window: options.windowId }),
        ...(region ? { region } : {}), data: Buffer.from('HELPER'),
      }
    },
  }
  const targets = new TargetStateController(native, () => 1)
  const handler = new ScreenshotHandler({
    native, targets, pointer: new VirtualPointerController(native), visionEnabled: true, defaultProvider: 'auto', env: {}, helper,
  })
  return { calls, handler, targets }
}

test('a full-screen screenshot is a ScreenCaptureKit display capture that leaves the agent pointer out', async () => {
  const s = shots()
  const shot = await s.handler.handleAsync('screenshot', { full_screen: true, display_id: 3 })
  assert.deepEqual(s.calls.map(call => call[0]), ['helper'], 'no screencapture')
  const options = s.calls[0][1]
  assert.equal(options.displayId, 3)
  assert.deepEqual(options.overlayPids, [process.pid])
  assert.equal(options.width, 1024)
  assert.equal(options.windowId, undefined)
  assert.equal(shot.content[0].data, Buffer.from('HELPER').toString('base64'))
  const text = shot.content[1].text
  assert.match(text, /^1024x640 \| screen: display 3 at -1440,0 sized 1440x900 \(ScreenCaptureKit\)/)
  assert.match(text, /screen_x = -1440 \+ image_x \* 1\.4063/)
  assert.deepEqual(s.handler.lastMapping(), { originX: -1440, originY: 0, scaleX: 1440 / 1024, scaleY: 900 / 640, imageWidth: 1024, imageHeight: 640 })
  // The same frame again comes back as text (K3), with no second encode sent.
  const again = await s.handler.handleAsync('screenshot', { full_screen: true, display_id: 3 })
  assert.equal(JSON.parse(again.content[0].text).unchanged, true)
})

test('with no target the main display is captured; an unknown display_id is refused, not swapped for another', async () => {
  const s = shots()
  await s.handler.handleAsync('screenshot', {})
  assert.equal(s.calls[0][1].displayId, 'main')
  const missing = shots({ capture: async () => { throw new HelperFailure('display_not_found', 'No display with id 9') } })
  const refused = await missing.handler.handleAsync('screenshot', { full_screen: true, display_id: 9 })
  assert.equal(refused.isError, true)
  assert.equal(refused.structuredContent.error, 'display_not_found')
  assert.ok(!missing.calls.some(call => call[0] === 'native'))
})

test('a display capture that fails for another reason falls back to the native capture and says why', async () => {
  const s = shots({ capture: async () => { throw new HelperFailure('screen_recording_denied', 'no') } })
  const shot = await s.handler.handleAsync('screenshot', { full_screen: true })
  assert.equal(shot.content[0].data, 'native')
  assert.match(s.handler.helperFailure(), /screen_recording_denied/)
  const pointer = shots()
  await pointer.handler.handleAsync('screenshot', { show_agent_pointer: true })
  assert.deepEqual(pointer.calls.map(call => call[0]), ['native'], 'drawing the pointer in still takes the native path')
})

test('zoom with no target is cut from the main display at full resolution, region in screen points', async () => {
  const s = shots()
  const zoomed = await s.handler.handleAsync('zoom', { region: [10, 20, 100, 80] })
  assert.deepEqual(s.calls.map(call => call[0]), ['helper'])
  assert.deepEqual(s.calls[0][1].region, { x: 10, y: 20, width: 90, height: 60 })
  assert.equal(s.calls[0][1].displayId, 'main')
  assert.equal(s.calls[0][1].format, 'png')
  assert.equal(zoomed.content[0].mimeType, 'image/png')
  assert.match(zoomed.content[1].text, /^90x60 \(zoomed from display 3 at full resolution; region 10,20-100,80 in screen points\)$/)
  const outside = shots({ capture: async () => { throw new HelperFailure('invalid_region', 'The region lies outside the capture') } })
  const refused = await outside.handler.handleAsync('zoom', { region: [5000, 5000, 5100, 5100] })
  assert.equal(refused.structuredContent.error, 'invalid_region')
  await assert.rejects(s.handler.handleAsync('zoom', { region: [10, 20, 5, 80] }), /x1\(10\) must be < x2\(5\)/)
})

test('zoom on a window is cropped by the helper, so only the region is encoded', async () => {
  const s = shots()
  const zoomed = await s.handler.handleAsync('zoom', { target_window_id: 42, region: [0, 0, 50, 40], quality: 70 })
  assert.deepEqual(s.calls.map(call => call[0]), ['helper'], 'no cropImage, no screen capture')
  assert.deepEqual(s.calls[0][1], { windowId: 42, region: { x: 0, y: 0, width: 50, height: 40 }, format: 'jpeg', quality: 70 })
  assert.match(zoomed.content[1].text, /window 42 region 0,0-50,40 in window points, zoomed from a window capture at full resolution/)
})

// ── wait_for_text: fast polls, accurate confirmation ─────────────────────────

const ocrOf = (...texts) => ({
  width: 2000, height: 1200, scale: 2,
  lines: texts.map((text, index) => ({ text, confidence: 0.95, box: { x: 40, y: 20 + index * 40, w: 200, h: 30 } })),
})

function reader({ fast, accurate }) {
  let clock = 0
  const reads = []
  const index = { fast: 0, accurate: 0 }
  const window = { windowId: 7, bundleId: 'app', title: 'W', bounds: { x: 0, y: 0, width: 1000, height: 600 }, isOnScreen: true }
  const native = { getWindow: id => (id === 7 ? window : null), listWindows: () => [window] }
  const helper = {
    ensure: async () => ({ ok: true, path: '/fake' }),
    supportsCapture: () => true,
    ocr: async options => {
      const kind = options.fast ? 'fast' : 'accurate'
      reads.push(kind)
      const list = kind === 'fast' ? fast : accurate
      return list[Math.min(index[kind]++, list.length - 1)]
    },
  }
  const context = {
    native, helper, platform: 'darwin', targets: new TargetStateController(native, () => 1), now: () => clock,
    sleepAbortable: async ms => { clock += ms; return false },
  }
  return { context, reads }
}

test('wait_for_text does not report text gone on a fast read that missed it: accurate OCR confirms', async () => {
  // Fast recognition misses the line every time; accurate reads it twice, then it is really gone.
  const r = reader({ fast: [ocrOf('other')], accurate: [ocrOf('Saving...'), ocrOf('Saving...'), ocrOf('Saved')] })
  const result = await handleAgentDesktopTool('wait_for_text', { target_window_id: 7, text: 'saving', gone: true }, r.context)
  assert.equal(result.structuredContent.gone, true)
  assert.equal(result.structuredContent.polls, 3)
  // poll 1: fast says gone, accurate says no; poll 2 the same; poll 3 is an accurate poll and it is gone.
  assert.deepEqual(r.reads, ['fast', 'accurate', 'fast', 'accurate', 'accurate'])
  assert.deepEqual(result.structuredContent.reads, { fast: 2, accurate: 3 })
})

test('wait_for_text finds text that fast recognition never reads, on an accurate poll', async () => {
  const r = reader({ fast: [ocrOf('noise')], accurate: [ocrOf('Build Complete')] })
  const result = await handleAgentDesktopTool('wait_for_text', { target_window_id: 7, text: 'build complete' }, r.context)
  assert.equal(result.structuredContent.found, true)
  assert.equal(result.structuredContent.polls, 3)
  assert.deepEqual(r.reads, ['fast', 'fast', 'accurate'])
})

test('wait_for_text confirms a fast hit with accurate OCR, and a single check (timeout 0) reads accurately', async () => {
  const r = reader({ fast: [ocrOf('Ready')], accurate: [ocrOf('Ready')] })
  const found = await handleAgentDesktopTool('wait_for_text', { target_window_id: 7, text: 'ready' }, r.context)
  assert.equal(found.structuredContent.found, true)
  assert.deepEqual(r.reads, ['fast', 'accurate'])
  const once = reader({ fast: [ocrOf('x')], accurate: [ocrOf('x')] })
  const timeout = await handleAgentDesktopTool('wait_for_text', { target_window_id: 7, text: 'never', timeout_ms: 0 }, once.context)
  assert.equal(timeout.structuredContent.error, 'timeout')
  assert.deepEqual(once.reads, ['accurate'], 'the last poll before the timeout is accurate')
})

test('wait_for_text with fast: true reads fast throughout, fast: false accurate throughout', async () => {
  const fastOnly = reader({ fast: [ocrOf('a'), ocrOf('Done')], accurate: [ocrOf('never used')] })
  await handleAgentDesktopTool('wait_for_text', { target_window_id: 7, text: 'done', fast: true }, fastOnly.context)
  assert.deepEqual(fastOnly.reads, ['fast', 'fast'])
  const accurateOnly = reader({ fast: [ocrOf('never used')], accurate: [ocrOf('a'), ocrOf('Done')] })
  await handleAgentDesktopTool('wait_for_text', { target_window_id: 7, text: 'done', fast: false }, accurateOnly.context)
  assert.deepEqual(accurateOnly.reads, ['accurate', 'accurate'])
})

// ── wait_for_stable: the region is applied ───────────────────────────────────

test('wait_for_stable reports regionApplied: true when the helper cropped to the region', async () => {
  const r = reader({ fast: [], accurate: [] })
  const captures = []
  r.context.helper.capture = async options => {
    captures.push(options)
    return { hash: 'same', width: 300, height: 200, scale: 1, frame: { x: 0, y: 0, width: 1000, height: 600 }, mimeType: 'image/jpeg', bytes: 1, path: '', region: { x: 10, y: 20, width: 300, height: 200 }, data: Buffer.from('x') }
  }
  const result = await handleAgentDesktopTool('wait_for_stable', { target_window_id: 7, quiet_ms: 0, region: [10, 20, 300, 200] }, r.context)
  assert.equal(result.structuredContent.stable, true)
  assert.equal(result.structuredContent.regionApplied, true)
  assert.deepEqual(captures[0].region, { x: 10, y: 20, width: 300, height: 200 })
})

// 7.7.0 (M6): macOS 27 renamed the Accessibility row; every remediation names both.
test('the Accessibility remediation names the macOS 27 row as well', async () => {
  const { ACCESSIBILITY_SETTINGS } = await import('../dist/session/doctor.js')
  assert.match(ACCESSIBILITY_SETTINGS, /Privacy & Security > Accessibility/)
  assert.match(ACCESSIBILITY_SETTINGS, /Device Control and Data Access/)
})
