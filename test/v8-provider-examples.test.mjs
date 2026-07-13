import test from 'node:test'
import assert from 'node:assert/strict'
import { executeProviderCall } from '../examples/v8-direct-sdk.mjs'
import {
  createComputerUseExecutorNode,
  createComputerUseSessionNode,
} from '../examples/v8-langgraph.mjs'

const ok = data => ({ content: [], structuredContent: data })

function hostContext(overrides = {}) {
  return {
    principalId: 'host-principal',
    agentId: 'executor',
    mode: 'foreground',
    coordinateSpace: { width: 1000, height: 1000, scrollPixelsPerStep: 100 },
    ...overrides,
  }
}

test('direct SDK example executes a provider call through preview, lease, receipt, and completion', async () => {
  const calls = []
  const client = {
    startSession: async request => (calls.push(['start', request]), ok({ session: { sessionId: 'session-1' } })),
    previewAction: async request => (calls.push(['preview', request]), ok({ executable: true, envelope: {} })),
    acquireControlLease: async request => (calls.push(['lease', request]), ok({ lease: { leaseId: 'lease-1' } })),
    executeAction: async request => (calls.push(['execute', request]), ok({ receipt: { receiptId: 'receipt-1', status: 'committed' } })),
    completeSession: async (...args) => (calls.push(['complete', ...args]), ok({ session: {} })),
    stopSession: async () => ok({ session: {} }),
    releaseControlLease: async id => (calls.push(['release', id]), ok({ lease: {} })),
  }
  const result = await executeProviderCall({
    client,
    provider: 'gemini',
    providerAction: { id: 'gemini-call-1', name: 'click_at', arguments: { x: 250, y: 500 } },
    hostContext: hostContext(),
  })
  assert.equal(result.sessionId, 'session-1')
  assert.equal(result.receipts[0].status, 'committed')
  const executed = calls.find(([kind]) => kind === 'execute')[1]
  assert.equal(executed.actionId, 'gemini-call-1')
  assert.equal(executed.leaseId, 'lease-1')
  assert.deepEqual(executed.arguments.coordinate, [250, 500])
  assert.deepEqual(calls.map(([kind]) => kind), ['start', 'preview', 'lease', 'execute', 'complete', 'release'])
})

test('direct SDK example refuses provider calls without a stable id', async () => {
  await assert.rejects(() => executeProviderCall({
    client: {}, provider: 'openai', providerAction: { type: 'wait', duration: 1 }, hostContext: hostContext(),
  }), /stable provider call id/)
})

test('direct SDK example does not acquire control for a shadow observation', async () => {
  let executed
  const client = {
    startSession: async () => ok({ session: { sessionId: 'shadow-session' } }),
    previewAction: async () => ok({ executable: true, envelope: {} }),
    acquireControlLease: async () => { throw new Error('read-only action must not acquire a lease') },
    executeAction: async request => (executed = request, ok({ receipt: { receiptId: 'observation', status: 'committed' } })),
    completeSession: async () => ok({ session: {} }),
    stopSession: async () => ok({ session: {} }),
    releaseControlLease: async () => ok({ lease: {} }),
  }
  await executeProviderCall({
    client,
    provider: 'openai',
    providerAction: { type: 'screenshot' },
    hostContext: hostContext({ actionId: 'observe-1', mode: 'shadow' }),
  })
  assert.equal('leaseId' in executed, false)
})

test('graph nodes checkpoint session before review and preserve stable composite action ids', async () => {
  const calls = []
  const client = {
    startSession: async () => ok({ session: { sessionId: 'graph-session' } }),
    previewAction: async request => (calls.push(['preview', request]), ok({
      executable: false, blocker: 'approval_required', envelope: { actionId: request.actionId }, policy: { decision: 'confirm' },
    })),
    approveAction: async (_session, actionId) => (calls.push(['approve', actionId]), ok({ grant: { grantId: `grant:${actionId}` } })),
    acquireControlLease: async () => ok({ lease: { leaseId: 'graph-lease' } }),
    executeAction: async request => (calls.push(['execute', request]), ok({
      receipt: { receiptId: `receipt:${request.actionId}`, actionId: request.actionId, status: 'committed' },
    })),
    releaseControlLease: async () => ok({ lease: {} }),
  }
  const bootstrap = createComputerUseSessionNode({ client, objective: 'graph task' })
  const bootstrapped = await bootstrap({ executionGroupId: 'graph-team', computerUse: {} })
  assert.equal(bootstrapped.computerUse.sessionId, 'graph-session')

  const reviewed = []
  const executor = createComputerUseExecutorNode({
    client,
    provider: 'gemini',
    hostContext: hostContext(),
    interrupt: async request => (reviewed.push(request), { approved: true }),
  })
  const result = await executor({
    executionGroupId: 'graph-team',
    computerUse: {
      ...bootstrapped.computerUse,
      pendingCall: {
        id: 'graph-call-7',
        action: { name: 'type_text_at', arguments: { x: 10, y: 20, text: 'safe text' } },
      },
    },
  })
  assert.deepEqual(reviewed.map(item => item.actionId), ['graph-call-7:1', 'graph-call-7:2'])
  assert.deepEqual(result.computerUse.receipts.map(receipt => receipt.actionId), ['graph-call-7:1', 'graph-call-7:2'])
  assert.equal(result.computerUse.pendingCall, null)
  assert.deepEqual(calls.filter(([kind]) => kind === 'execute').map(([, request]) => request.approvalGrantId), [
    'grant:graph-call-7:1', 'grant:graph-call-7:2',
  ])
})
