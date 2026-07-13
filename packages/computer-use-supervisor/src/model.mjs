const SAFE_APPROVAL_FIELDS = [
  'actionDigest', 'tool', 'operation', 'actionClass', 'mode', 'expiresAt',
  'targetAppId', 'targetWindowId',
]
const SAFE_POSTCONDITION_FIELDS = [
  'postconditionKind', 'postconditionExpectedState', 'postconditionExpectedDigest',
]
const SENSITIVITY_ASSESSMENTS = new Set(['sensitive', 'non_sensitive', 'unknown'])
const SENSITIVITY_SOURCES = new Set(['accessibility', 'unavailable'])
const SENSITIVITY_SIGNALS = new Set([
  'secure_role', 'secure_subrole', 'protected_content', 'uia_is_password', 'sensitive_label',
  'ambiguous_match', 'element_not_found', 'inspection_error', 'invalid_field',
  'native_signal_unavailable',
])

const SAFE_EVENT_FIELDS = ['sequence', 'type', 'actionId']
const SAFE_EVENT_PAYLOAD_FIELDS = [
  'to', 'state', 'tool', 'mode', 'actionClass', 'interference', 'policyDecision',
  'executable', 'blocker', ...SAFE_APPROVAL_FIELDS,
  'frameId', 'phase', 'mimeType', 'byteLength', 'digest', 'capturedAt', 'expiresAt', 'code',
  'verificationRequired', 'verified', 'method', 'checks', 'postconditionKind',
  'postconditionExpectedState', 'postconditionExpectedDigest',
]

function copySafeSensitivity(source, target) {
  if (SENSITIVITY_ASSESSMENTS.has(source?.sensitivityAssessment)) {
    target.sensitivityAssessment = source.sensitivityAssessment
  }
  if (SENSITIVITY_SOURCES.has(source?.sensitivitySource)) {
    target.sensitivitySource = source.sensitivitySource
  }
  if (Array.isArray(source?.sensitivitySignals)) {
    target.sensitivitySignals = [...new Set(source.sensitivitySignals
      .filter(signal => SENSITIVITY_SIGNALS.has(signal)))].slice(0, 10)
  }
  if (Number.isSafeInteger(source?.sensitivityFieldsChecked)
      && source.sensitivityFieldsChecked >= 0 && source.sensitivityFieldsChecked <= 100) {
    target.sensitivityFieldsChecked = source.sensitivityFieldsChecked
  }
}

const FRAME_PHASES = new Set(['before', 'after', 'observation'])
const FRAME_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const MAX_ENCODED_FRAME_BYTES = Math.ceil((1024 * 1024) / 3) * 4

/** Buffer main-process messages until the isolated renderer installs its listener. */
export function createRendererDeliveryGate(deliver) {
  let ready = false
  const pending = []
  return Object.freeze({
    push(message) {
      if (!ready) {
        pending.push(message)
        return false
      }
      deliver(message)
      return true
    },
    ready() {
      if (ready) return 0
      ready = true
      const count = pending.length
      for (const message of pending.splice(0)) deliver(message)
      return count
    },
    pendingCount: () => pending.length,
  })
}

function sanitizeEvidenceFrame(frame) {
  if (!frame || typeof frame !== 'object') return null
  const mimeType = frame.mimeType
  const phase = frame.phase
  const data = frame.data
  const byteLength = frame.byteLength
  const hasMagic = mimeType === 'image/png'
    ? typeof data === 'string' && data.startsWith('iVBORw0KGgo')
    : mimeType === 'image/jpeg' && typeof data === 'string' && data.startsWith('/9j/')
  const padding = typeof data === 'string' ? (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0) : 0
  const decodedLength = typeof data === 'string' ? (data.length / 4) * 3 - padding : 0
  if (!FRAME_PHASES.has(phase) || !hasMagic || !FRAME_BASE64.test(data)
      || data.length > MAX_ENCODED_FRAME_BYTES
      || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 1024 * 1024
      || decodedLength !== byteLength
      || typeof frame.frameId !== 'string' || !frame.frameId || frame.frameId.length > 128
      || typeof frame.actionId !== 'string' || !frame.actionId || frame.actionId.length > 256
      || typeof frame.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(frame.digest)) return null
  return {
    frameId: frame.frameId, actionId: frame.actionId, phase, mimeType, byteLength,
    digest: frame.digest,
    capturedAt: String(frame.capturedAt ?? '').slice(0, 40),
    expiresAt: String(frame.expiresAt ?? '').slice(0, 40),
    data,
  }
}

/** Converts only an explicit secondary-button confirmation into a reset command. */
export function emergencyResetCommand(dialogResult) {
  return dialogResult?.response === 1 ? { type: 'reset_emergency_stop' } : null
}

/** Construct the only message shape allowed to cross into the renderer. */
export function sanitizeSupervisorMessage(message) {
  if (!message || typeof message !== 'object') return { type: 'error', error: 'invalid_message' }
  if (message.type === 'hello') return { type: 'hello', protocolVersion: Number(message.protocolVersion ?? 0) }
  if (message.type === 'disconnected') return { type: 'disconnected' }
  if (message.type === 'subscribed') return { type: 'subscribed', sessionId: String(message.sessionId ?? '') }
  if (message.type === 'emergency_status') {
    return {
      type: 'emergency_status',
      active: message.active === true,
      supported: message.supported === true,
      generation: Number.isSafeInteger(message.generation) && message.generation >= 0 ? message.generation : 0,
      backend: String(message.backend ?? 'unknown').slice(0, 80),
      chord: typeof message.chord === 'string' ? message.chord.slice(0, 80) : '',
    }
  }
  if (message.type === 'ack') {
    return { type: 'ack', command: String(message.command ?? ''), sessionId: String(message.sessionId ?? '') }
  }
  if (message.type === 'approved') {
    // The runtime keeps the action-bound grant. It is never renderer data.
    return { type: 'approved', actionId: String(message.actionId ?? '') }
  }
  if (message.type === 'evidence_frame') {
    const frame = sanitizeEvidenceFrame(message.frame)
    return frame ? { type: 'evidence_frame', frame } : { type: 'error', error: 'invalid_evidence_frame' }
  }
  if (message.type === 'event' && message.event && typeof message.event === 'object') {
    const event = {}
    for (const field of SAFE_EVENT_FIELDS) {
      if (message.event[field] !== undefined) event[field] = message.event[field]
    }
    const payload = {}
    for (const field of SAFE_EVENT_PAYLOAD_FIELDS) {
      if (message.event.payload?.[field] !== undefined) payload[field] = message.event.payload[field]
    }
    if (message.event.payload?.sessionScopeEligible === true) payload.sessionScopeEligible = true
    copySafeSensitivity(message.event.payload, payload)
    event.payload = payload
    return { type: 'event', event }
  }
  return { type: 'error', error: String(message.error ?? 'unsupported_message') }
}

export function initialViewModel(sessionId) {
  return {
    sessionId, state: 'connecting', currentAction: null, pendingApproval: null,
    lastEvent: null, sequence: 0, connected: false,
    emergency: { active: false, supported: false, generation: 0, backend: 'unknown', chord: '' },
    stateBeforeEmergency: null,
    evidenceFrames: { before: null, after: null, observation: null },
    evidenceActionId: null,
  }
}

export function reduceSupervisorMessage(model, message) {
  if (message.type === 'hello') return { ...model, connected: true, state: 'connected' }
  if (message.type === 'emergency_status') {
    const active = message.active === true
    return {
      ...model,
      emergency: {
        active,
        supported: message.supported === true,
        generation: Number(message.generation ?? 0),
        backend: String(message.backend ?? 'unknown'),
        chord: String(message.chord ?? ''),
      },
      ...(active
        ? {
            state: 'emergency_stopped',
            stateBeforeEmergency: model.state === 'emergency_stopped' ? model.stateBeforeEmergency : model.state,
            currentAction: null,
          }
        : {
            state: model.state === 'emergency_stopped' ? (model.stateBeforeEmergency ?? 'connected') : model.state,
            stateBeforeEmergency: null,
          }),
    }
  }
  if (message.type === 'evidence_frame' && message.frame) {
    if (model.evidenceActionId && message.frame.actionId !== model.evidenceActionId) return model
    return {
      ...model,
      evidenceFrames: { ...model.evidenceFrames, [message.frame.phase]: message.frame },
    }
  }
  if (message.type !== 'event' || !message.event) return model
  const event = message.event
  const next = {
    ...model,
    sequence: Number(event.sequence ?? model.sequence),
    lastEvent: String(event.type ?? 'event'),
  }
  if (event.type === 'evidence.frame_available') {
    next.evidenceActionId = event.actionId ?? null
    if (event.payload?.phase === 'before' || event.payload?.phase === 'observation') {
      next.evidenceFrames = { before: null, after: null, observation: null }
    }
  } else if (event.type === 'session.state_changed' || event.type === 'session.recovered') {
    next.state = String(event.payload?.to ?? event.payload?.state ?? model.state)
  } else if (event.type === 'session.completed') {
    next.state = 'completed'
    next.currentAction = null
  } else if (event.type === 'action.started') {
    next.currentAction = { actionId: event.actionId, tool: String(event.payload?.tool ?? 'action') }
  } else if (event.type === 'action.committed' || event.type === 'action.rejected'
    || event.type === 'action.interrupted' || event.type === 'action.indeterminate') {
    next.currentAction = null
    if (next.pendingApproval?.actionId === event.actionId) next.pendingApproval = null
  } else if (event.type === 'action.approval_required') {
    const safe = { actionId: event.actionId }
    for (const field of SAFE_APPROVAL_FIELDS) {
      if (event.payload?.[field] !== undefined) safe[field] = event.payload[field]
    }
    for (const field of SAFE_POSTCONDITION_FIELDS) {
      if (event.payload?.[field] !== undefined) safe[field] = event.payload[field]
    }
    if (event.payload?.sessionScopeEligible === true) safe.sessionScopeEligible = true
    copySafeSensitivity(event.payload, safe)
    next.pendingApproval = safe
    next.state = 'waiting_for_user'
  }
  return next
}
