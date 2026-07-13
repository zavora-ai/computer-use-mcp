import { describeAgentState, describeApproval, initialViewModel, reduceSupervisorMessage } from './model.mjs'

let model = initialViewModel('local')
const byId = id => document.getElementById(id)

function render() {
  const status = describeAgentState(model)
  const approval = describeApproval(model.pendingApproval)
  byId('signal').classList.toggle('live', model.connected)
  byId('mode').textContent = model.connected ? 'Connected' : 'Connecting'
  byId('objective').textContent = model.objective || 'The agent has not provided a task summary yet.'
  byId('activity').textContent = status.label
  byId('activity-detail').textContent = status.detail
  byId('status-card').dataset.tone = status.tone
  byId('event').textContent = model.lastEvent ? `${model.lastEvent} · event ${model.sequence}` : 'None yet'
  byId('technical-state').textContent = model.state
  byId('session').textContent = model.sessionId || 'Local session'
  byId('emergency-state').textContent = model.emergency.active
    ? 'Emergency stop is active — all changes are blocked'
    : 'Emergency stop is ready'
  byId('emergency-state').classList.toggle('latched', model.emergency.active)
  byId('emergency-chord').textContent = model.emergency.supported
    ? `Keyboard shortcut: ${model.emergency.chord || 'configured by the host'}`
    : 'A system-wide keyboard shortcut is not available on this machine.'
  byId('emergency-generation').textContent = model.emergency.generation
    ? `Safety stop generation ${model.emergency.generation}` : ''
  byId('reset-emergency').hidden = !model.emergency.active
  byId('approval').hidden = !approval
  if (approval) {
    byId('approval-title').textContent = approval.headline
    byId('approval-explanation').textContent = approval.explanation
    byId('approval-safety').textContent = approval.safety
    byId('approve').textContent = approval.onceLabel
    byId('approve-session').textContent = approval.sessionLabel
    byId('approve-session').hidden = model.pendingApproval.sessionScopeEligible !== true
  }
  byId('agent').textContent = approval?.actor ?? 'Waiting for an action'
  byId('approval-target').textContent = approval?.target ?? 'Not selected'
  for (const phase of ['before', 'after', 'observation']) {
    const frame = model.evidenceFrames[phase]
    const image = byId(`${phase}-frame`)
    const placeholder = byId(`${phase}-placeholder`)
    image.hidden = !frame
    placeholder.hidden = Boolean(frame)
    if (frame) {
      image.src = `data:${frame.mimeType};base64,${frame.data}`
      image.alt = `${phase} action evidence`
    } else {
      image.removeAttribute('src')
    }
  }
  byId('before-card').hidden = !model.evidenceFrames.before && !model.currentAction
  byId('after-card').hidden = !model.evidenceFrames.after && !model.evidenceFrames.before
  byId('observation-card').hidden = !model.evidenceFrames.observation
  byId('privacy-note').hidden = !model.evidenceFrames.before
    && !model.evidenceFrames.after && !model.evidenceFrames.observation
}

window.computerUseSupervisor.onMessage(message => {
  if (message.type === 'event' && message.event?.type === 'evidence.frame_available') {
    const frameId = message.event.payload?.frameId
    if (typeof frameId === 'string' && frameId) void window.computerUseSupervisor.requestEvidenceFrame(frameId)
  }
  if (message.type === 'disconnected') model = { ...model, connected: false, state: 'disconnected' }
  else model = reduceSupervisorMessage(model, message)
  render()
})

for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('click', () => window.computerUseSupervisor.command(button.dataset.command))
}
byId('approve').addEventListener('click', () => {
  if (model.pendingApproval?.actionId) {
    void window.computerUseSupervisor.approve(model.pendingApproval.actionId, 'exact_action')
  }
})
byId('approve-session').addEventListener('click', () => {
  if (model.pendingApproval?.actionId && model.pendingApproval.sessionScopeEligible === true) {
    void window.computerUseSupervisor.approve(model.pendingApproval.actionId, 'session_operation')
  }
})
byId('emergency').addEventListener('click', () => window.computerUseSupervisor.emergencyStop())
byId('reset-emergency').addEventListener('click', () => window.computerUseSupervisor.emergencyReset())
render()
