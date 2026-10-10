import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { WindowsStatusOverlay, friendlyToolName } from '../dist/status-overlay.js'

test('status overlay maps GUI activity into human-readable steps', () => {
  assert.equal(friendlyToolName('screenshot'), 'Inspecting the screen')
  assert.equal(friendlyToolName('click'), 'Selecting')
  assert.equal(friendlyToolName('type'), 'Typing')
  assert.equal(friendlyToolName('mouse_drag'), 'Navigating')
})

test('local Pause / Resume / Stop gate mutations, not observation', () => {
  const overlay = new WindowsStatusOverlay(false)
  // Integration-level test: private paths compile to class properties; do not
  // create a real Windows desktop window inside CI.
  const control = overlay.controlFile
  const state = overlay.stateFile
  try {
    overlay.begin('click')
    assert.equal(overlay.check(true), undefined)
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).steps.at(-1).label, 'Selecting')
    writeFileSync(control, 'paused')
    assert.equal(overlay.check(true), 'paused_by_user')
    assert.equal(overlay.check(false), undefined)
    assert.equal(overlay.signal.aborted, true)
    writeFileSync(control, 'running')
    assert.equal(overlay.check(true), undefined)
    assert.equal(overlay.signal.aborted, false)
    overlay.finish(false)
    assert.equal(JSON.parse(readFileSync(state, 'utf8')).steps.at(-1).outcome, 'done')
    writeFileSync(control, 'stopped')
    assert.equal(overlay.check(true), 'stopped_by_user')
    assert.equal(overlay.signal.aborted, true)
  } finally {
    overlay.close()
  }
  assert.equal(existsSync(state), false)
})

test('status overlay never spawns a desktop panel when launch is disabled', () => {
  const overlay = new WindowsStatusOverlay(false)
  try {
    overlay.begin('screenshot')
    overlay.finish(false)
    assert.equal(overlay.child, undefined)
  } finally {
    overlay.close()
  }
})
