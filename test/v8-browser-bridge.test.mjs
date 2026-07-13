import test from 'node:test'
import assert from 'node:assert/strict'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import {
  adaptProviderAction,
  browserTargetFromEvidence,
} from '../dist/runtime/index.js'
import { createPolicyV2Evaluator } from '../dist/policy/engine.js'

const initialEvidence = () => ({
  bridgeId: 'test-cdp', pageId: 'page-1', url: 'https://example.com/start',
  observationId: 'browser-observation-1', domRevision: 'dom-1', confidence: 1,
  capturedAt: new Date().toISOString(), viewport: { width: 1200, height: 800 },
})

function requestFromAdapted(request) {
  return {
    sessionId: request.sessionId, actionId: request.actionId, tool: request.tool,
    arguments: request.args, mode: request.mode, target: request.target,
  }
}

test('host browser bridge is internal-only and executes through policy, target, lease, and receipt', async () => {
  const bridgeCalls = []
  const bridge = {
    id: 'test-cdp',
    validateTarget: async target => target.uiTreeRevision === 'dom-1' || target.uiTreeRevision === 'dom-2',
    execute: async request => {
      bridgeCalls.push(request)
      return {
        verified: true,
        evidence: {
          ...initialEvidence(), url: request.arguments.url, domRevision: 'dom-2',
          observationId: 'browser-observation-2', capturedAt: new Date().toISOString(),
        },
        result: { content: [{ type: 'text', text: 'navigated' }], structuredContent: { status: 'ok' } },
      }
    },
  }
  const legacyDispatches = []
  const session = { async dispatch(tool) { legacyDispatches.push(tool); return { content: [] } } }
  const client = await connectInProcess(createComputerUseServer({
    session, enableV8: true, principalId: 'browser-owner', browserBridge: bridge,
    runtimeOptions: {
      policy: createPolicyV2Evaluator({ allowedDomains: ['example.com'] }),
      requireAttributedPhysicalInput: false,
    },
  }))
  try {
    assert.equal((await client.listTools()).some(tool => tool.name === 'browser_action'), false)
    const manifestResource = await client.readResource('computer://capabilities/manifest')
    const manifest = JSON.parse(manifestResource.contents[0].text)
    assert.equal(manifest.features.browserBridgeConfigured, true)
    assert.equal(manifest.actuators.find(item => item.tool === 'browser_action').exposed, false)
    assert.equal(manifest.actuators.find(item => item.tool === 'browser_action').capabilities[0].backend, 'browser')
    const sessionId = (await client.startSession()).structuredContent.session.sessionId
    const target = browserTargetFromEvidence(initialEvidence())
    const adapted = adaptProviderAction('gemini', {
      id: 'navigate-1', name: 'navigate', arguments: { url: 'https://example.com/next' },
    }, {
      sessionId, principalId: 'browser-owner', actionId: 'navigate-1', mode: 'background', target,
      browserBridge: { bridgeId: 'test-cdp', currentUrl: initialEvidence().url },
    })
    const request = requestFromAdapted(adapted)
    const preview = await client.previewAction(request)
    assert.equal(preview.structuredContent.executable, true)
    assert.equal(preview.structuredContent.capability.backend, 'browser')
    assert.equal(preview.structuredContent.envelope.resource.browserDomain, 'example.com')
    const lease = (await client.acquireControlLease({
      sessionId, kind: 'cooperative', mode: 'background', ttlMs: 10_000, actionBudget: 1,
      appIds: [target.appId], windowIds: [target.windowId],
    })).structuredContent.lease
    const executed = await client.executeAction({ ...request, leaseId: lease.leaseId })
    assert.equal(executed.structuredContent.receipt.status, 'committed')
    assert.equal(executed.structuredContent.output.browserEvidence.domRevision, 'dom-2')
    assert.equal('url' in executed.structuredContent.output.browserEvidence, false)
    assert.match(executed.structuredContent.output.browserEvidence.urlDigest, /^sha256:/)
    assert.equal(bridgeCalls.length, 1)
    assert.equal(bridgeCalls[0].envelope.actionId, 'navigate-1')
    assert.deepEqual(legacyDispatches, [])
  } finally { await client.close() }
})

test('browser bridge rejects unrecognized operations before calling the host adapter', async () => {
  let executed = false
  const bridge = {
    id: 'test-cdp', validateTarget: async () => true,
    execute: async () => { executed = true; throw new Error('must not execute') },
  }
  const client = await connectInProcess(createComputerUseServer({
    session: { async dispatch() { return { content: [] } } },
    enableV8: true, principalId: 'browser-owner', browserBridge: bridge,
    runtimeOptions: { policy: async () => ({ decision: 'allow', policyDigest: 'test', reasons: ['test'] }) },
  }))
  try {
    const sessionId = (await client.startSession()).structuredContent.session.sessionId
    const target = browserTargetFromEvidence(initialEvidence())
    const result = await client.previewAction({
      sessionId, actionId: 'unknown-browser-op', tool: 'browser_action', mode: 'background', target,
      arguments: {
        bridge_id: 'test-cdp', operation: 'evaluate_javascript',
        current_url: initialEvidence().url, action_arguments: { script: 'dangerous()' },
      },
    })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error, 'policy_denied')
    assert.equal(executed, false)
  } finally { await client.close() }
})

test('browser domain policy rejects before bridge execution', async () => {
  let executed = false
  const bridge = {
    id: 'test-cdp', validateTarget: async () => true,
    execute: async () => { executed = true; throw new Error('must not execute') },
  }
  const client = await connectInProcess(createComputerUseServer({
    session: { async dispatch() { return { content: [] } } },
    enableV8: true, principalId: 'browser-owner', browserBridge: bridge,
    runtimeOptions: { policy: createPolicyV2Evaluator({ allowedDomains: ['example.com'] }) },
  }))
  try {
    const sessionId = (await client.startSession()).structuredContent.session.sessionId
    const adapted = adaptProviderAction('gemini', {
      name: 'navigate', arguments: { url: 'https://evil.example.net/steal' },
    }, {
      sessionId, principalId: 'browser-owner', actionId: 'evil-nav', mode: 'background',
      target: browserTargetFromEvidence(initialEvidence()),
      browserBridge: { bridgeId: 'test-cdp', currentUrl: initialEvidence().url },
    })
    const preview = await client.previewAction(requestFromAdapted(adapted))
    assert.equal(preview.structuredContent.executable, false)
    assert.equal(preview.structuredContent.blocker, 'policy_denied')
    assert.equal(executed, false)
  } finally { await client.close() }
})

test('browser bridge rejects unsafe URLs and coordinates outside evidenced viewport before execution', async () => {
  assert.throws(() => browserTargetFromEvidence({
    ...initialEvidence(), url: 'https://user:secret@example.com/private',
  }), /must not contain embedded credentials/)
  let executed = false
  const bridge = {
    id: 'test-cdp', validateTarget: async () => true,
    execute: async () => { executed = true; throw new Error('must not execute') },
  }
  const client = await connectInProcess(createComputerUseServer({
    session: { async dispatch() { return { content: [] } } },
    enableV8: true, principalId: 'browser-owner', browserBridge: bridge,
  }))
  try {
    const sessionId = (await client.startSession()).structuredContent.session.sessionId
    const target = browserTargetFromEvidence(initialEvidence())
    const outside = await client.previewAction({
      sessionId, actionId: 'outside-click', tool: 'browser_action', mode: 'background', target,
      arguments: {
        bridge_id: 'test-cdp', operation: 'left_click', current_url: initialEvidence().url,
        action_arguments: { coordinate: [1200, 400] },
      },
    })
    assert.equal(outside.isError, true)
    assert.equal(outside.structuredContent.error, 'stale_target')
    const unsafe = await client.previewAction({
      sessionId, actionId: 'unsafe-nav', tool: 'browser_action', mode: 'background', target,
      arguments: {
        bridge_id: 'test-cdp', operation: 'navigate', current_url: initialEvidence().url,
        action_arguments: { url: 'javascript:alert(1)' },
      },
    })
    assert.equal(unsafe.isError, true)
    assert.equal(executed, false)
  } finally { await client.close() }
})

test('unverified browser postconditions become indeterminate and revoke the lease', async () => {
  const bridge = {
    id: 'test-cdp', validateTarget: async () => true,
    execute: async () => ({
      verified: false, evidence: initialEvidence(), result: { content: [] },
    }),
  }
  const client = await connectInProcess(createComputerUseServer({
    session: { async dispatch() { return { content: [] } } },
    enableV8: true, principalId: 'browser-owner', browserBridge: bridge,
  }))
  try {
    const sessionId = (await client.startSession()).structuredContent.session.sessionId
    const target = browserTargetFromEvidence(initialEvidence())
    const adapted = adaptProviderAction('gemini', {
      name: 'navigate', arguments: { url: 'https://example.com/next' },
    }, {
      sessionId, principalId: 'browser-owner', actionId: 'unverified-nav', mode: 'background', target,
      browserBridge: { bridgeId: 'test-cdp', currentUrl: initialEvidence().url },
    })
    const lease = (await client.acquireControlLease({
      sessionId, kind: 'cooperative', mode: 'background', ttlMs: 10_000, actionBudget: 1,
      appIds: [target.appId], windowIds: [target.windowId],
    })).structuredContent.lease
    const result = await client.executeAction({ ...requestFromAdapted(adapted), leaseId: lease.leaseId })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error, 'indeterminate')
    assert.equal((await client.releaseControlLease(lease.leaseId)).isError, true)
  } finally { await client.close() }
})
