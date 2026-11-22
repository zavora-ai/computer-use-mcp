// 7.8.1: on macOS the status card is not in screen captures, so the agent aims at the app it sees beneath the card.
// Before this, a click there landed on the card: in Blender the card covers the viewport header's X-ray and shading
// buttons, the navigation gizmo and the first outliner rows. Pointer input now asks the card to move off its points
// first, and is refused only when the card does not move.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OperatorControl } from '../dist/session/operator-control.js'
import { createSession } from '../dist/session.js'

const TOP_RIGHT = { x: 924, y: 46, width: 340, height: 150 }
const BOTTOM_RIGHT = { x: 924, y: 828, width: 340, height: 150 }
const settle = () => new Promise(resolve => setTimeout(resolve, 60))

/** A fake macOS card: writes where it is, and moves to the bottom right when asked to dodge (unless stuck). */
function fakeCard({ stuck = false } = {}) {
  const state = { requests: [] }
  return {
    state,
    presenter: {
      kind: 'fake-macos',
      start(dir) {
        writeFileSync(join(dir, 'card.json'), JSON.stringify({ frame: TOP_RIGHT }))
        state.watcher = watch(dir, (_event, file) => {
          if (file !== 'dodge.json' || !existsSync(join(dir, 'dodge.json'))) return
          let request
          try { request = JSON.parse(readFileSync(join(dir, 'dodge.json'), 'utf8')) } catch { return }
          if (state.requests.some(r => r.seq === request.seq)) return
          state.requests.push(request)
          if (!stuck) setTimeout(() => writeFileSync(join(dir, 'card.json'), JSON.stringify({ frame: BOTTOM_RIGHT })), 30)
        })
      },
      stop() { state.watcher?.close() },
    },
  }
}

test('a point under the hidden card moves the card, and the call waits for the move', async () => {
  const { presenter, state } = fakeCard()
  const directory = mkdtempSync(join(tmpdir(), 'card-dodge-'))
  const control = new OperatorControl({ card: { presenter, directory, pollMs: 10 } })
  control.begin({ tool: 'click', label: 'click' }, { mutates: true })
  await settle()
  assert.deepEqual(control.hiddenCardFrame(), TOP_RIGHT)
  assert.equal(control.cardRegion(), undefined, 'still no capture mask: the card is excluded from captures')
  await control.clearOfCard([[930, 100]])
  assert.deepEqual(control.hiddenCardFrame(), BOTTOM_RIGHT, 'returned only once the card had moved')
  assert.equal(state.requests.length, 1)
  assert.deepEqual(state.requests[0].avoid, [[930, 100]])
  control.close()
})

test('a point clear of the card asks for nothing', async () => {
  const { presenter, state } = fakeCard()
  const directory = mkdtempSync(join(tmpdir(), 'card-dodge-'))
  const control = new OperatorControl({ card: { presenter, directory, pollMs: 10 } })
  control.begin({ tool: 'click', label: 'click' }, { mutates: true })
  await settle()
  await control.clearOfCard([[400, 300], [500, 500]])
  assert.equal(existsSync(join(directory, 'dodge.json')), false)
  assert.equal(state.requests.length, 0)
  control.close()
})

test('a card that does not move refuses the action rather than let the agent press it', async () => {
  const { presenter } = fakeCard({ stuck: true })
  const directory = mkdtempSync(join(tmpdir(), 'card-dodge-'))
  const control = new OperatorControl({ card: { presenter, directory, pollMs: 10 } })
  control.begin({ tool: 'click', label: 'click' }, { mutates: true })
  await settle()
  await assert.rejects(control.clearOfCard([[1218, 176]], 150), error => error.details?.error === 'status_card_protected')
  control.close()
})

test('a click under the hidden card reaches the app once the card has moved', async () => {
  const native = {
    calls: [],
    getDisplaySize: () => ({ width: 1280, height: 1024, pixelWidth: 1280, pixelHeight: 1024, scaleFactor: 1 }),
    listDisplays: () => [{ id: 1, x: 0, y: 0, width: 1280, height: 1024 }],
    getFrontmostApp: () => ({ bundleId: 'org.blenderfoundation.blender', pid: 100 }),
    listRunningApps: () => [{ bundleId: 'org.blenderfoundation.blender', pid: 100, isHidden: false }],
    activateApp: () => ({ activated: true }), activateWindow: () => ({ activated: true }),
    mouseMove: () => {}, mouseClick: (...a) => native.calls.push(['mouseClick', a]), mouseButton: () => {},
    getUserIdleTimeMs: () => 60_000,
  }
  const { presenter, state } = fakeCard()
  const directory = mkdtempSync(join(tmpdir(), 'card-dodge-'))
  const control = new OperatorControl({ native, card: { presenter, directory, pollMs: 10 } })
  const session = createSession({ native, macosHelper: null, profile: 'full', operatorControl: control })
  const first = await session.dispatch('click', { coordinate: [400, 300] })
  assert.equal(first.isError, undefined)
  await settle()
  const under = await session.dispatch('click', { coordinate: [930, 100] })
  assert.equal(under.isError, undefined, JSON.stringify(under.content))
  assert.equal(state.requests.length, 1, 'the card was asked to move')
  assert.equal(native.calls.filter(c => c[0] === 'mouseClick').length, 2, 'both clicks reached the native layer')
  assert.deepEqual(control.hiddenCardFrame(), BOTTOM_RIGHT)
  session.close()
})

test('the Windows card publishes its rectangle and moves off requested points, like the macOS card', async () => {
  const { readFileSync } = await import('node:fs')
  const ps1 = readFileSync(new URL('../libexec/windows-status-card.ps1', import.meta.url), 'utf8')
  assert.match(ps1, /GetWindowRect/, 'the frame comes from the window in screen pixels')
  assert.match(ps1, /'card\.json'/, 'written where the server reads it')
  assert.match(ps1, /"pid":' \+ \$PID/, 'with its pid, so a dead card frees the area')
  assert.match(ps1, /'dodge\.json'/)
  assert.match(ps1, /TransformToDevice/, 'screen pixels converted to WPF units before placing the window')
  assert.match(ps1, /Add_LocationChanged\(\{ Publish-Geometry \}\)/, 'a card the person drags reports its new place')
  assert.match(ps1, /NullString/, 'Windows PowerShell 5.1 has no File.Move overwrite; Replace keeps the write atomic')
  const swift = readFileSync(new URL('../libexec/macos-status-card.swift', import.meta.url), 'utf8')
  assert.match(swift, /func checkDodge\(\)/)
})
