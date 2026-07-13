import { initialViewModel, reduceSupervisorMessage } from './model.mjs'

let model = initialViewModel('local')
const byId = id => document.getElementById(id)

function render() {
  byId('signal').classList.toggle('live', model.connected)
  byId('mode').textContent = model.state
  byId('activity').textContent = model.currentAction?.tool ?? (model.connected ? 'Ready' : 'Connecting…')
  byId('event').textContent = model.lastEvent ? `${model.lastEvent} · #${model.sequence}` : ''
  byId('emergency-state').textContent = model.emergency.active ? 'LATCHED — mutations blocked' : 'Ready'
  byId('emergency-state').classList.toggle('latched', model.emergency.active)
  byId('emergency-chord').textContent = model.emergency.supported
    ? (model.emergency.chord || 'Configured by host')
    : 'Native global chord unavailable'
  byId('emergency-generation').textContent = model.emergency.generation
    ? `Stop generation ${model.emergency.generation}` : ''
  byId('reset-emergency').hidden = !model.emergency.active
  const approval = model.pendingApproval
  byId('approval').hidden = !approval
  if (approval) {
    byId('approval-title').textContent = approval.operation ?? approval.tool ?? 'Action'
    byId('approval-class').textContent = `${approval.actionClass ?? 'unknown'} · ${approval.mode ?? 'unknown'}`
    byId('approval-target').textContent = approval.targetAppId ?? 'Local desktop'
  }
}

window.computerUseSupervisor.onMessage(message => {
  if (message.type === 'disconnected') model = { ...model, connected: false, state: 'disconnected' }
  else model = reduceSupervisorMessage(model, message)
  render()
})

for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('click', () => window.computerUseSupervisor.command(button.dataset.command))
}
byId('approve').addEventListener('click', () => {
  if (model.pendingApproval?.actionId) void window.computerUseSupervisor.approve(model.pendingApproval.actionId)
})
byId('emergency').addEventListener('click', () => window.computerUseSupervisor.emergencyStop())
byId('reset-emergency').addEventListener('click', () => window.computerUseSupervisor.emergencyReset())
render()
