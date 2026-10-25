// 7.8 live share: the change gate turns bursts of change into single events, and drops noise.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChangeGate } from '../dist/session/change-gate.js'
import { createMacosHelper } from '../dist/session/macos-helper.js'

const box = (x, y, width, height) => ({ x, y, width, height })

test('a burst becomes one event once the screen has been quiet for settleMs', () => {
  const gate = new ChangeGate({ settleMs: 600, maxDelayMs: 3000 })
  gate.observe({ at: 0, area: 0.02, dirty: box(0.4, 0.4, 0.1, 0.1) })
  gate.observe({ at: 500, area: 0.05, dirty: box(0.45, 0.3, 0.2, 0.2) })
  assert.equal(gate.poll(900), undefined, 'still settling: the last change was 400 ms ago')
  const event = gate.poll(1100)
  assert.equal(event.settled, true)
  assert.equal(event.samples, 2)
  assert.equal(event.area, 0.05, 'the largest single change')
  assert.deepEqual(event.startedAt, 0)
  const dirty = event.dirty
  assert.ok(Math.abs(dirty.x - 0.4) < 1e-9 && Math.abs(dirty.y - 0.3) < 1e-9, 'the union of the boxes')
  assert.ok(Math.abs(dirty.width - 0.25) < 1e-9 && Math.abs(dirty.height - 0.2) < 1e-9)
  assert.equal(gate.poll(5000), undefined, 'nothing left')
})

test('a screen that keeps changing still yields an event every maxDelayMs', () => {
  const gate = new ChangeGate({ settleMs: 600, maxDelayMs: 3000 })
  const events = []
  for (let t = 0; t <= 7000; t += 500) {
    gate.observe({ at: t, area: 0.2, dirty: box(0.1, 0.1, 0.5, 0.5) })
    const event = gate.poll(t)
    if (event) events.push(event)
  }
  assert.equal(events.length, 2, 'a video or a progress bar reports itself, not every frame')
  assert.ok(events.every(event => event.settled === false))
})

test('a blinking caret and the menu bar clock are dropped; a line of output arriving is not', () => {
  const caret = new ChangeGate({ settleMs: 600, minArea: 0.001 })
  for (let t = 0; t < 2000; t += 500) caret.observe({ at: t, area: 0.0002, dirty: box(0.22, 0.47, 0.01, 0.02) })
  assert.equal(caret.poll(5000), undefined, 'the same tiny box, over and over')

  const clock = new ChangeGate({ settleMs: 600, ignore: [box(0, 0, 1, 0.035)] })
  clock.observe({ at: 0, area: 0.004, dirty: box(0.9, 0.005, 0.05, 0.02) })
  assert.equal(clock.poll(1000), undefined, 'inside the ignored menu bar')

  // A terminal printing a line in chunks: each sample changes few pixels, but the box grows across the line.
  const output = new ChangeGate({ settleMs: 600, minArea: 0.001 })
  for (let i = 0; i < 6; i++) output.observe({ at: i * 300, area: 0.0005, dirty: box(0.05 + i * 0.06, 0.5, 0.06, 0.02) })
  assert.ok(output.poll(3000), 'each chunk is small, but the changed box grows to a line')
  // The same few keystrokes in one word stay below the line (a person typing is not news).
  const word = new ChangeGate({ settleMs: 600, minArea: 0.001 })
  for (let i = 0; i < 4; i++) word.observe({ at: i * 300, area: 0.0003, dirty: box(0.2 + i * 0.01, 0.5, 0.01, 0.02) })
  assert.equal(word.poll(3000), undefined)
})

test('a source that cannot say where (the native capture) still passes on a change', () => {
  const gate = new ChangeGate({ settleMs: 600 })
  gate.observe({ at: 0, area: 1 })
  const event = gate.poll(700)
  assert.equal(event.area, 1)
  assert.equal(event.dirty, undefined)
  gate.observe({ at: 1000, area: 1 })
  gate.reset()
  assert.equal(gate.poll(5000), undefined, 'reset drops a burst in progress')
})

test('the helper client asks for a compared capture and handles an unencoded unchanged one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cu-helper-diff-'))
  const source = join(dir, 'helper.swift')
  writeFileSync(source, '// fixture')
  const sha = createHash('sha256').update(readFileSync(source)).digest('hex').slice(0, 8)
  writeFileSync(join(dir, `macos-agent-helper-${sha}`), '')
  const calls = []
  let changed = true
  const run = async (file, args) => {
    if (file === 'codesign') return { code: 0, stdout: '', stderr: '' }
    calls.push(args)
    const frame = { x: 0, y: 0, width: 1440, height: 900 }
    if (!changed) return { code: 0, stderr: '', stdout: JSON.stringify({ unchanged: true, diff: { changed: false, area: 0 }, width: 640, height: 400, scale: 0.44, frame, display: 1 }) }
    writeFileSync(args[args.indexOf('--out') + 1], 'IMG')
    return { code: 0, stderr: '', stdout: JSON.stringify({ path: 'x', width: 640, height: 400, hash: 'h', scale: 0.44, frame, mimeType: 'image/jpeg', bytes: 3, display: 1, diff: { changed: true, area: 0.03, dirty: box(0.1, 0.2, 0.3, 0.1) } }) }
  }
  const helper = createMacosHelper({ sourcePath: source, cacheDir: dir, platform: 'darwin', darwinRelease: '25.2.0', run, serve: false })
  const first = await helper.capture({ displayId: 'main', width: 640, diff: 'watch:1', skipUnchanged: true })
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--diff'), calls[0].indexOf('--diff') + 4), ['--diff', '--diff-key', 'watch:1', '--skip-unchanged'])
  assert.equal(first.diff.area, 0.03)
  assert.equal(first.data.toString(), 'IMG')
  changed = false
  const second = await helper.capture({ displayId: 'main', width: 640, diff: true, skipUnchanged: true })
  assert.equal(second.unchanged, true)
  assert.equal(second.data.length, 0, 'nothing was encoded, so nothing is read')
  assert.ok(!calls[1].includes('--diff-key'), 'diff: true lets the helper name the source')
  rmSync(dir, { recursive: true, force: true })
})
