import test from 'node:test'
import assert from 'node:assert/strict'
import {
  emergencyResetCommand,
  initialViewModel,
  reduceSupervisorMessage,
  sanitizeSupervisorMessage,
} from '../src/model.mjs'

test('view model allowlists approval metadata and never copies secret payload fields', () => {
  const model = reduceSupervisorMessage(initialViewModel('s'), {
    type: 'event',
    event: {
      sequence: 2, actionId: 'a', type: 'action.approval_required',
      payload: {
        tool: 'set_value', actionClass: 'secret_access', mode: 'foreground',
        targetAppId: 'app.safe', password: 'must-not-render', value: 'must-not-render',
      },
    },
  })
  assert.equal(model.pendingApproval.actionId, 'a')
  assert.equal(model.pendingApproval.password, undefined)
  assert.doesNotMatch(JSON.stringify(model), /must-not-render/)
})

test('main-to-renderer sanitizer strips grants, secrets, and unrecognized event payloads', () => {
  const approved = sanitizeSupervisorMessage({
    type: 'approved', actionId: 'a1', grant: { grantId: 'secret-grant', token: 'secret-token' },
  })
  assert.deepEqual(approved, { type: 'approved', actionId: 'a1' })

  const event = sanitizeSupervisorMessage({
    type: 'event',
    event: {
      sequence: 7, type: 'action.approval_required', actionId: 'a1', principalId: 'private-principal',
      payload: {
        tool: 'notification', actionDigest: 'safe-digest', secret: 'do-not-render',
        arguments: { password: 'hunter2' },
      },
    },
  })
  assert.deepEqual(event, {
    type: 'event',
    event: {
      sequence: 7, type: 'action.approval_required', actionId: 'a1',
      payload: { tool: 'notification', actionDigest: 'safe-digest' },
    },
  })
  assert.doesNotMatch(JSON.stringify(event), /private-principal|do-not-render|hunter2/)
})

test('emergency status is allowlisted, latched visibly, and restores prior state after reset', () => {
  const sanitized = sanitizeSupervisorMessage({
    type: 'emergency_status', active: true, supported: true, generation: 9,
    backend: 'macos_hid_event_tap', chord: 'ctrl+alt+shift+escape',
    token: 'never-render', reason: 'private permission details',
  })
  assert.deepEqual(sanitized, {
    type: 'emergency_status', active: true, supported: true, generation: 9,
    backend: 'macos_hid_event_tap', chord: 'ctrl+alt+shift+escape',
  })
  const running = { ...initialViewModel('s'), state: 'running', connected: true }
  const stopped = reduceSupervisorMessage(running, sanitized)
  assert.equal(stopped.state, 'emergency_stopped')
  assert.equal(stopped.stateBeforeEmergency, 'running')
  assert.equal(stopped.emergency.active, true)
  const reset = reduceSupervisorMessage(stopped, { ...sanitized, active: false })
  assert.equal(reset.state, 'running')
  assert.equal(reset.stateBeforeEmergency, null)
  assert.equal(reset.emergency.active, false)
  assert.doesNotMatch(JSON.stringify(stopped), /never-render|private permission/)
})

test('emergency reset command requires the explicit destructive confirmation choice', () => {
  assert.equal(emergencyResetCommand(undefined), null)
  assert.equal(emergencyResetCommand({ response: 0 }), null)
  assert.deepEqual(emergencyResetCommand({ response: 1, token: 'ignored' }), {
    type: 'reset_emergency_stop',
  })
})
