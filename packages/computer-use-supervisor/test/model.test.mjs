import test from 'node:test'
import assert from 'node:assert/strict'
import {
  emergencyResetCommand,
  initialViewModel,
  reduceSupervisorMessage,
  sanitizeSupervisorMessage,
} from '../src/model.mjs'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

test('view model allowlists approval metadata and never copies secret payload fields', () => {
  const model = reduceSupervisorMessage(initialViewModel('s'), {
    type: 'event',
    event: {
      sequence: 2, actionId: 'a', type: 'action.approval_required',
      payload: {
        tool: 'set_value', actionClass: 'secret_access', mode: 'foreground',
        targetAppId: 'app.safe', postconditionKind: 'ui_element',
        postconditionExpectedState: 'exists', postconditionExpectedDigest: `sha256:${'a'.repeat(64)}`,
        postconditionLabel: 'private account name', postconditionPath: '/private/path',
        password: 'must-not-render', value: 'must-not-render',
      },
    },
  })
  assert.equal(model.pendingApproval.actionId, 'a')
  assert.equal(model.pendingApproval.password, undefined)
  assert.equal(model.pendingApproval.postconditionKind, 'ui_element')
  assert.equal(model.pendingApproval.postconditionExpectedState, 'exists')
  assert.match(model.pendingApproval.postconditionExpectedDigest, /^sha256:/)
  assert.doesNotMatch(JSON.stringify(model), /must-not-render|private account|private\/path/)
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

test('visual evidence crosses only the explicit frame response and remains phase bounded', () => {
  const event = sanitizeSupervisorMessage({
    type: 'event', event: { sequence: 8, type: 'evidence.frame_available', actionId: 'a1', payload: {
      frameId: 'frame-1', phase: 'before', mimeType: 'image/png', byteLength: 68,
      digest: `sha256:${'a'.repeat(64)}`, data: PNG, secret: 'event-secret',
    } },
  })
  assert.equal(event.event.payload.frameId, 'frame-1')
  assert.equal(event.event.payload.data, undefined)
  assert.doesNotMatch(JSON.stringify(event), /iVBOR|event-secret/)

  const frame = sanitizeSupervisorMessage({ type: 'evidence_frame', frame: {
    frameId: 'frame-1', sessionId: 'must-not-render', actionId: 'a1', phase: 'before',
    mimeType: 'image/png', byteLength: 68, digest: `sha256:${'b'.repeat(64)}`,
    capturedAt: '2026-07-13T10:00:00.000Z', expiresAt: '2026-07-13T10:05:00.000Z',
    data: PNG, accessibilityTree: 'private UI text', token: 'secret-token',
  } })
  assert.equal(frame.type, 'evidence_frame')
  assert.equal(frame.frame.data, PNG)
  assert.equal(frame.frame.sessionId, undefined)
  assert.doesNotMatch(JSON.stringify(frame), /private UI text|secret-token|must-not-render/)
  const reduced = reduceSupervisorMessage(initialViewModel('s'), frame)
  assert.equal(reduced.evidenceFrames.before.frameId, 'frame-1')
  assert.equal(reduced.evidenceFrames.after, null)
})

test('visual evidence sanitizer rejects malformed, unsupported, and oversized payloads', () => {
  const base = {
    frameId: 'frame', actionId: 'a', phase: 'after', byteLength: 8,
    digest: `sha256:${'c'.repeat(64)}`, capturedAt: '', expiresAt: '',
  }
  assert.equal(sanitizeSupervisorMessage({ type: 'evidence_frame', frame: {
    ...base, mimeType: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64'),
  } }).error, 'invalid_evidence_frame')
  assert.equal(sanitizeSupervisorMessage({ type: 'evidence_frame', frame: {
    ...base, mimeType: 'image/png', data: 'not base64!',
  } }).error, 'invalid_evidence_frame')
  assert.equal(sanitizeSupervisorMessage({ type: 'evidence_frame', frame: {
    ...base, mimeType: 'image/png', byteLength: 1024 * 1024 + 1, data: PNG,
  } }).error, 'invalid_evidence_frame')
})
