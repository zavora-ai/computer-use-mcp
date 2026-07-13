import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryEvidenceFrameStore } from '../dist/session/evidence-frames.js'
import { RuntimeCoordinator } from '../dist/runtime/coordinator.js'

// Valid 1x1 transparent PNG. Keeping the fixture tiny makes byte-limit tests exact.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

test('memory evidence frames validate image bytes, expire, evict, and stay session scoped', () => {
  let now = new Date('2026-07-13T10:00:00Z')
  const bytes = Buffer.from(PNG, 'base64').length
  const store = new MemoryEvidenceFrameStore({
    now: () => now, ttlMs: 100, maxFrameBytes: bytes,
    maxFramesPerSession: 2, maxTotalBytes: bytes * 3,
  })
  assert.throws(() => store.put({
    sessionId: 's', actionId: 'bad', phase: 'before', mimeType: 'image/png',
    data: Buffer.from('not a png').toString('base64'),
  }), /do not match/)
  assert.throws(() => store.put({
    sessionId: 's', actionId: 'bad-mime', phase: 'before', mimeType: 'image/svg+xml', data: PNG,
  }), /PNG or JPEG/)
  assert.throws(() => store.put({
    sessionId: 's', actionId: 'bad-phase', phase: 'during', mimeType: 'image/png', data: PNG,
  }), /phase is invalid/)

  const first = store.put({ sessionId: 's', actionId: 'a1', phase: 'before', mimeType: 'image/png', data: PNG })
  store.put({ sessionId: 's', actionId: 'a1', phase: 'after', mimeType: 'image/png', data: PNG })
  store.put({ sessionId: 's', actionId: 'a2', phase: 'observation', mimeType: 'image/png', data: PNG })
  assert.equal(store.get('s', first.frameId), undefined, 'oldest per-session frame is evicted')
  assert.equal(store.get('other', store.list('s')[0].frameId), undefined, 'cross-session lookup is opaque')
  assert.equal(store.list('s').length, 2)
  assert.equal('data' in store.list('s')[0], false)
  assert.match(store.list('s')[0].digest, /^sha256:[a-f0-9]{64}$/)
  store.put({ sessionId: 't', actionId: 'a3', phase: 'before', mimeType: 'image/png', data: PNG })
  store.put({ sessionId: 'u', actionId: 'a4', phase: 'after', mimeType: 'image/png', data: PNG })
  assert.equal(store.list('s').length + store.list('t').length + store.list('u').length, 3,
    'global byte bound evicts the oldest frame')
  now = new Date(now.getTime() + 101)
  assert.equal(store.list('s').length, 0)
})

test('runtime publishes metadata only and authenticates frame retrieval and deletion', async () => {
  const frames = new MemoryEvidenceFrameStore()
  const runtime = new RuntimeCoordinator({
    evidenceFrames: frames, requireManagedSession: true,
    validateTarget: async () => true,
    policy: async () => ({ decision: 'allow', policyDigest: 'frame-test', reasons: ['allow'] }),
    execute: async () => ({ content: [
      { type: 'image', mimeType: 'image/png', data: PNG },
      { type: 'text', text: '1x1' },
    ] }),
  })
  const session = await runtime.startSession({ principalId: 'owner' })
  await runtime.execute({
    sessionId: session.sessionId, principalId: 'owner', actionId: 'observe-1',
    tool: 'screenshot', args: {}, mode: 'shadow',
  })
  const event = runtime.events.query(session.sessionId).find(item => item.type === 'evidence.frame_available')
  assert.ok(event)
  assert.equal(event.payload.phase, 'observation')
  assert.doesNotMatch(JSON.stringify(event), /iVBOR/)
  assert.equal(Object.hasOwn(event.payload, 'data'), false)
  const frame = await runtime.getEvidenceFrame(session.sessionId, 'owner', event.payload.frameId)
  assert.equal(frame.data, PNG)
  await assert.rejects(runtime.getEvidenceFrame(session.sessionId, 'intruder', event.payload.frameId), /another principal/)
  await runtime.stopSession(session.sessionId, 'owner')
  const deletion = await runtime.deleteSession(session.sessionId, 'owner')
  assert.equal(deletion.deletedEvidenceFrames, 1)
  assert.equal(frames.list(session.sessionId).length, 0)
  runtime.dispose()
})

test('mutations capture target evidence before and after verified execution without persisting pixels', async () => {
  const frames = new MemoryEvidenceFrameStore()
  const phases = []
  const runtime = new RuntimeCoordinator({
    evidenceFrames: frames, requireManagedSession: true,
    validateTarget: async () => true,
    policy: async () => ({ decision: 'allow', policyDigest: 'frame-test', reasons: ['allow'] }),
    transactionHooks: {
      capture: async () => ({ capturedAt: new Date().toISOString() }),
      captureEvidence: async (_envelope, phase) => {
        phases.push(phase)
        return { content: [{ type: 'image', mimeType: 'image/png', data: PNG }] }
      },
      verify: async () => ({ verified: true, method: 'test_postcondition' }),
      restore: async () => ({ restored: true }),
    },
    execute: async () => ({ content: [{ type: 'text', text: 'mutated' }] }),
  })
  const session = await runtime.startSession({ principalId: 'owner' })
  const lease = await runtime.leases.acquire({
    sessionId: session.sessionId, principalId: 'owner', kind: 'cooperative',
    executionMode: 'background', ttlMs: 10_000, actionBudget: 1,
  })
  await runtime.execute({
    sessionId: session.sessionId, principalId: 'owner', actionId: 'mutate-1',
    tool: 'notification', args: { title: 'done', message: 'done' }, mode: 'background',
    leaseId: lease.leaseId,
    target: {
      platform: process.platform, appId: 'app.target', windowId: 7,
      observationId: 'target-observation', confidence: 1, capturedAt: new Date().toISOString(),
    },
  })
  assert.deepEqual(phases, ['before', 'after'])
  assert.deepEqual(frames.list(session.sessionId).map(frame => frame.phase), ['before', 'after'])
  const serializedEvents = JSON.stringify(runtime.events.query(session.sessionId))
  assert.doesNotMatch(serializedEvents, /iVBOR/)
  assert.ok(serializedEvents.indexOf('"phase":"before"') < serializedEvents.indexOf('action.started'))
  assert.ok(serializedEvents.indexOf('action.verified') < serializedEvents.indexOf('"phase":"after"'))
  runtime.dispose()
})

test('optional visual capture failure is disclosure-safe and does not become action authority', async () => {
  const runtime = new RuntimeCoordinator({
    evidenceFrames: new MemoryEvidenceFrameStore(), requireManagedSession: true,
    validateTarget: async () => true,
    policy: async () => ({ decision: 'allow', policyDigest: 'frame-test', reasons: ['allow'] }),
    transactionHooks: {
      capture: async () => ({ capturedAt: new Date().toISOString() }),
      captureEvidence: async () => { throw new Error('private screenshot backend failure at /secret/path') },
      verify: async () => ({ verified: true, method: 'test_postcondition' }),
      restore: async () => ({ restored: true }),
    },
    execute: async () => ({ content: [{ type: 'text', text: 'mutated' }] }),
  })
  const session = await runtime.startSession({ principalId: 'owner' })
  const lease = await runtime.leases.acquire({
    sessionId: session.sessionId, principalId: 'owner', kind: 'cooperative',
    executionMode: 'background', ttlMs: 10_000, actionBudget: 1,
  })
  const outcome = await runtime.execute({
    sessionId: session.sessionId, principalId: 'owner', actionId: 'capture-fails',
    tool: 'notification', args: { title: 'done', message: 'done' }, mode: 'background',
    leaseId: lease.leaseId,
    target: {
      platform: process.platform, appId: 'app.target', windowId: 7,
      observationId: 'capture-failure-target', confidence: 1, capturedAt: new Date().toISOString(),
    },
  })
  assert.equal(outcome.receipt.status, 'committed')
  const unavailable = runtime.events.query(session.sessionId)
    .filter(event => event.type === 'evidence.frame_unavailable')
  assert.equal(unavailable.length, 2)
  assert.deepEqual(unavailable.map(event => event.payload.code), ['capture_error', 'capture_error'])
  assert.doesNotMatch(JSON.stringify(unavailable), /secret|backend failure|path/)
  runtime.dispose()
})
