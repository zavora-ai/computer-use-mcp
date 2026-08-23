import assert from 'node:assert/strict'
import test from 'node:test'
import { handleCoreTool } from '../dist/session/core-handlers.js'

function context() {
  const pointer = {
    state: { x: 0, y: 0, visible: false, updatedAt: 1 },
    move(x, y, visible) { this.state = { ...this.state, x, y, visible } },
    show() { this.state.visible = true },
    hide() { this.state.visible = false },
    reset(visible) { this.state = { x: 50, y: 50, visible, updatedAt: 2 } },
    current() { return { ...this.state } },
    syncOverlay(requested) { return { requested, available: true } },
  }
  return {
    pointer,
    runDoctor: async include => ({ healthy: true, include }),
    policyStatus: () => ({ mode: 'balanced' }),
  }
}

test('core handler serves doctor and policy status without claiming unknown tools', async () => {
  const ctx = context()
  assert.equal(await handleCoreTool('unknown', {}, ctx), undefined)
  assert.deepEqual(JSON.parse((await handleCoreTool('doctor', {}, ctx)).content[0].text), {
    healthy: true, include: true,
  })
  assert.equal(JSON.parse((await handleCoreTool('policy_status', {}, ctx)).content[0].text).mode, 'balanced')
})

test('core handler changes only virtual pointer state', async () => {
  const ctx = context()
  const result = await handleCoreTool('agent_pointer', {
    action: 'move', coordinate: [12, 34], native_overlay: false,
  }, ctx)
  const payload = JSON.parse(result.content[0].text)
  assert.deepEqual([payload.x, payload.y, payload.visible], [12, 34, true])
  assert.deepEqual(payload.nativeOverlay, { requested: false, available: true })
})
