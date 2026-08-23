import assert from 'node:assert/strict'
import test from 'node:test'
import { VirtualPointerController } from '../dist/session/virtual-pointer.js'

function native() {
  const calls = []
  return {
    calls,
    getDisplaySize: () => ({ width: 1000, height: 500 }),
    agentPointerOverlayStatus: () => ({ visible: false }),
    agentPointerOverlayShow: (...args) => { calls.push(['show', ...args]); return { visible: true } },
    agentPointerOverlayHide: () => { calls.push(['hide']); return { visible: false } },
    annotateImage: (...args) => {
      calls.push(['annotate', ...args])
      return { base64: 'annotated', width: 500, height: 250, mimeType: 'image/jpeg' }
    },
  }
}

test('extracted virtual pointer mutates only virtual state and validates display bounds', () => {
  const service = native()
  const pointer = new VirtualPointerController(service, () => 1234)
  assert.deepEqual(pointer.current(), { x: 500, y: 250, visible: false, updatedAt: 1234 })
  assert.deepEqual(pointer.move(100, 200), { x: 100, y: 200, visible: true, updatedAt: 1234 })
  assert.equal(service.calls.length, 0)
  assert.throws(() => pointer.move(1000, 20), /outside display bounds/)
})

test('extracted virtual pointer synchronizes the native overlay only when requested', () => {
  const service = native()
  const pointer = new VirtualPointerController(service)
  pointer.move(12, 34)
  assert.deepEqual(pointer.syncOverlay(false), { requested: false, available: true })
  assert.equal(service.calls.length, 0)
  assert.equal(pointer.syncOverlay(true).available, true)
  assert.deepEqual(service.calls[0], ['show', 12, 34])
  pointer.hide()
  pointer.syncOverlay(true)
  assert.deepEqual(service.calls[1], ['hide'])
})

test('extracted virtual pointer projects logical coordinates into screenshot pixels', () => {
  const service = native()
  const pointer = new VirtualPointerController(service, () => 1)
  pointer.move(400, 200)
  const result = pointer.annotateScreenshot({
    base64: 'original', width: 500, height: 250,
    mimeType: 'image/jpeg', hash: 'base', unchanged: true,
  })
  assert.equal(result.base64, 'annotated')
  assert.equal(result.hash, 'base:agent-pointer:400,200')
  assert.equal(result.unchanged, false)
  assert.match(service.calls[0][2], /"x":195|"y":95/)
})
