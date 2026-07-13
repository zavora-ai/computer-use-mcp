import test from 'node:test'
import assert from 'node:assert/strict'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { RuntimeCoordinator } from '../dist/runtime/coordinator.js'

const imageResult = {
  content: [
    { type: 'text', text: '{"observation_id":"obs-1"}' },
    { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
  ],
  structuredContent: { observation_id: 'obs-1' },
}

test('v8 facade is additive and opt-in while v7 default remains frozen', async () => {
  const session = { async dispatch() { return imageResult } }
  const v7 = await connectInProcess(createComputerUseServer({ session }))
  const v8 = await connectInProcess(createComputerUseServer({ session, enableV8: true }))
  try {
    assert.equal((await v7.listTools()).length, 64)
    const tools = await v8.listTools()
    assert.equal(tools.length, 87)
    for (const name of [
      'get_execution_capabilities', 'preview_action', 'execute_action',
      'acquire_control_lease', 'release_control_lease', 'emergency_stop',
      'start_session', 'get_session', 'pause_session', 'resume_session',
      'take_over', 'stop_session', 'approve_action', 'complete_session', 'get_session_events',
      'submit_follow_up', 'get_follow_ups',
      'delete_session', 'prune_sessions', 'reserve_target', 'release_target_reservation', 'onboarding',
    ]) assert.ok(tools.some(tool => tool.name === name), `${name} missing`)
  } finally {
    await v7.close()
    await v8.close()
  }
})

test('host can negotiate dynamic tool profiles without expanding its configured maximum', async () => {
  const session = { async dispatch() { return { content: [] } } }
  let registry
  const client = await connectInProcess(createComputerUseServer({
    session, enableV8: true, profile: 'full', activeProfile: 'core',
    onRegistry: value => { registry = value },
  }))
  try {
    let names = new Set((await client.listTools()).map(tool => tool.name))
    assert.equal(names.has('execute_action'), true)
    assert.equal(names.has('run_script'), false)
    assert.equal(names.has('get_ui_tree'), false)

    const scripting = registry.setActiveProfile('scripting')
    assert.equal(scripting.enabled.includes('run_script'), true)
    names = new Set((await client.listTools()).map(tool => tool.name))
    assert.equal(names.has('run_script'), true)
    assert.equal(names.has('get_ui_tree'), false)

    registry.setActiveProfile('ax')
    names = new Set((await client.listTools()).map(tool => tool.name))
    assert.equal(names.has('run_script'), false)
    assert.equal(names.has('get_ui_tree'), true)

    registry.setActiveProfile('v8-safe')
    names = new Set((await client.listTools()).map(tool => tool.name))
    assert.equal(names.has('execute_action'), true)
    assert.equal(names.has('reserve_target'), true)
    assert.equal(names.has('left_click'), false)
    assert.equal(names.has('screenshot'), false)
  } finally {
    await client.close()
  }

  let boundedRegistry
  const bounded = await connectInProcess(createComputerUseServer({
    session, enableV8: true, profile: 'core',
    onRegistry: value => { boundedRegistry = value },
  }))
  try {
    boundedRegistry.setActiveProfile('full')
    const names = new Set((await bounded.listTools()).map(tool => tool.name))
    assert.equal(names.has('execute_action'), true)
    assert.equal(names.has('run_script'), false)
    assert.equal(names.has('get_ui_tree'), false)
  } finally {
    await bounded.close()
  }
})

test('v8-safe surface exposes only governed facade and respects immutable host maximum', async () => {
  let rawDispatches = 0
  const session = { async dispatch() { rawDispatches++; return { content: [] } } }
  const safe = await connectInProcess(createComputerUseServer({
    session, enableV8: true, profile: 'full', activeProfile: 'v8-safe',
  }))
  try {
    const names = new Set((await safe.listTools()).map(tool => tool.name))
    assert.equal(names.size, 23)
    assert.equal(names.has('certify_execution_capability'), false)
    assert.equal(names.has('get_certification_trace'), true)
    assert.equal(names.has('approve_action'), true)
    assert.equal(names.has('execute_action'), true)
    assert.equal(names.has('acquire_control_lease'), true)
    assert.equal(names.has('left_click'), false)
    assert.equal(names.has('read_clipboard'), false)
    assert.equal(names.has('scrape'), false)
    const bypass = await safe.callTool('left_click', { coordinate: [1, 2] })
    assert.equal(bypass.isError, true)
    assert.equal(rawDispatches, 0)
    const started = await safe.startSession()
    const nestedBatch = await safe.previewAction({
      sessionId: started.structuredContent.session.sessionId,
      actionId: 'nested-batch', tool: 'openai_computer',
      arguments: { actions: [{ type: 'click', x: 1, y: 2 }, { type: 'click', x: 3, y: 4 }] },
      mode: 'foreground',
    })
    assert.equal(nestedBatch.isError, true)
    assert.match(nestedBatch.content[0].text, /provider_adapter_requires_translation/)
  } finally {
    await safe.close()
  }

  const bounded = await connectInProcess(createComputerUseServer({
    session, enableV8: true, profile: 'core', activeProfile: 'v8-safe',
  }))
  try {
    const started = await bounded.startSession()
    const denied = await bounded.previewAction({
      sessionId: started.structuredContent.session.sessionId,
      actionId: 'outside-maximum', tool: 'snapshot', arguments: {}, mode: 'shadow',
    })
    assert.equal(denied.isError, true)
    assert.match(denied.content[0].text, /tool_outside_host_profile/)
  } finally {
    await bounded.close()
  }
})

test('complete_session returns inspectable postcondition evidence and revokes control', async () => {
  const session = { async dispatch() { return { content: [] } } }
  const client = await connectInProcess(createComputerUseServer({ session, enableV8: true }))
  try {
    const started = await client.startSession({ objective: 'finish with evidence' })
    const sessionId = started.structuredContent.session.sessionId
    await client.acquireControlLease({
      sessionId, kind: 'cooperative', mode: 'background', ttlMs: 10_000, actionBudget: 1,
    })
    const completed = await client.completeSession(sessionId, {
      summary: 'Finished safely',
      postconditions: [{ description: 'result exists', satisfied: true, evidenceHash: 'sha256:result' }],
      lastAppId: 'app.safe', lastWindowId: 7, actionCounts: { committed: 1 },
    })
    assert.equal(completed.structuredContent.session.state, 'completed')
    assert.equal(completed.structuredContent.session.completion.postconditions[0].evidenceHash, 'sha256:result')
    const events = await client.getSessionEvents(sessionId)
    assert.ok(events.structuredContent.events.some(event => event.type === 'session.completed'))
  } finally {
    await client.close()
  }
})

test('preview reports foreground requirement instead of silently escalating', async () => {
  const session = { async dispatch() { throw new Error('preview must not dispatch') } }
  const client = await connectInProcess(createComputerUseServer({ session, enableV8: true, principalId: 'host-principal' }))
  try {
    const started = await client.callTool('start_session', { objective: 'preview' })
    const result = await client.callTool('preview_action', {
      session_id: started.structuredContent.session.sessionId, action_id: 'action-1', tool: 'left_click',
      arguments: { coordinate: [10, 20] }, mode: 'background',
    })
    assert.equal(result.isError, undefined)
    assert.equal(result.structuredContent.executable, false)
    assert.equal(result.structuredContent.blocker, 'foreground_required')
    assert.equal(result.structuredContent.capability.interference, 'moves_physical_pointer')
  } finally {
    await client.close()
  }
})

test('typed client maps digest-only postconditions into the action envelope and approval digest', async () => {
  const session = { async dispatch() { throw new Error('preview must not dispatch') } }
  const client = await connectInProcess(createComputerUseServer({
    session, enableV8: true, principalId: 'host-principal',
  }))
  try {
    const sessionId = (await client.startSession()).structuredContent.session.sessionId
    const target = {
      platform: process.platform, appId: 'app.safe', windowId: 7,
      observationId: 'wire-postcondition', confidence: 1, capturedAt: new Date().toISOString(),
    }
    const first = await client.previewAction({
      sessionId, actionId: 'postcondition-wire', tool: 'left_click',
      arguments: { coordinate: [10, 20] }, mode: 'foreground', target,
      postcondition: { kind: 'ui_element', role: 'AXStaticText', label: 'Saved', exists: true },
    })
    assert.deepEqual(first.structuredContent.envelope.postcondition, {
      kind: 'ui_element', role: 'AXStaticText', label: 'Saved', exists: true,
    })
    const changed = await client.previewAction({
      sessionId, actionId: 'postcondition-wire-2', tool: 'left_click',
      arguments: { coordinate: [10, 20] }, mode: 'foreground', target,
      postcondition: { kind: 'ui_element', role: 'AXStaticText', label: 'Failed', exists: true },
    })
    assert.notEqual(
      first.structuredContent.envelope.argsDigest,
      changed.structuredContent.envelope.argsDigest,
    )
  } finally { await client.close() }
})

test('approve_action grants only the exact pending v8 action through the MCP boundary', async () => {
  const session = { async dispatch() { return { content: [{ type: 'text', text: 'ok' }] } } }
  const runtime = new RuntimeCoordinator({
    requireManagedSession: true,
    execute: (tool, args, signal) => session.dispatch(tool, args, signal),
    policy: async () => ({ decision: 'confirm', policyDigest: 'remote-review-policy', reasons: ['review'] }),
  })
  const client = await connectInProcess(createComputerUseServer({
    session, runtime, enableV8: true, principalId: 'reviewer',
  }))
  try {
    const sessionId = (await client.startSession()).structuredContent.session.sessionId
    const request = {
      sessionId, actionId: 'reviewed-action', tool: 'write_clipboard',
      arguments: { text: 'reviewed' }, mode: 'background',
    }
    const preview = await client.previewAction(request)
    assert.equal(preview.structuredContent.blocker, 'approval_required')
    const approval = await client.approveAction(sessionId, 'reviewed-action', 30_000)
    assert.equal(approval.structuredContent.grant.actionDigest, preview.structuredContent.envelope.argsDigest)
    const lease = await client.acquireControlLease({
      sessionId, kind: 'cooperative', mode: 'background', ttlMs: 10_000, actionBudget: 1,
    })
    const executed = await client.executeAction({
      ...request,
      approvalGrantId: approval.structuredContent.grant.grantId,
      leaseId: lease.structuredContent.lease.leaseId,
    })
    assert.equal(executed.structuredContent.receipt.status, 'committed')
  } finally { await client.close() }
})

test('session lifecycle tools revoke leases before takeover and paginate events', async () => {
  const session = { async dispatch() { return { content: [] } } }
  const client = await connectInProcess(createComputerUseServer({ session, enableV8: true }))
  try {
    const started = await client.callTool('start_session', { objective: 'lifecycle' })
    const sessionId = started.structuredContent.session.sessionId
    const acquired = await client.callTool('acquire_control_lease', {
      session_id: sessionId, kind: 'cooperative', mode: 'background', ttl_ms: 10_000, action_budget: 1,
    })
    assert.equal(acquired.structuredContent.lease.state, 'active')

    const submitted = await client.submitFollowUp(sessionId, 'Use the revised local document, not the emailed copy.')
    assert.equal(submitted.structuredContent.follow_up.sequence, 1)
    const followUps = await client.getFollowUps(sessionId)
    assert.equal(followUps.structuredContent.follow_ups[0].instruction, 'Use the revised local document, not the emailed copy.')

    const takeover = await client.callTool('take_over', { session_id: sessionId })
    assert.equal(takeover.structuredContent.session.state, 'paused_by_user')
    const resumed = await client.callTool('resume_session', { session_id: sessionId })
    assert.equal(resumed.structuredContent.session.state, 'running')
    const stopped = await client.callTool('stop_session', { session_id: sessionId })
    assert.equal(stopped.structuredContent.session.state, 'stopped')

    const page = await client.callTool('get_session_events', {
      session_id: sessionId, after_sequence: 0, limit: 2,
    })
    assert.equal(page.structuredContent.schema_uri, 'computer://audit/schema')
    assert.match(page.structuredContent.schema_digest, /^[a-f0-9]{64}$/)
    assert.equal(page.structuredContent.events.length, 2)
    assert.equal(page.structuredContent.next_sequence, 2)
    const next = await client.callTool('get_session_events', {
      session_id: sessionId, after_sequence: 2, limit: 100,
    })
    assert.ok(next.structuredContent.events.every(event => event.sequence > 2))
    assert.doesNotMatch(JSON.stringify(next.structuredContent.events), /revised local document/)
  } finally {
    await client.close()
  }
})

test('session deletion requires terminal ownership and removes retained events', async () => {
  const session = { async dispatch() { return { content: [] } } }
  const client = await connectInProcess(createComputerUseServer({
    session, enableV8: true, principalId: 'retention-owner',
  }))
  try {
    const sessionId = (await client.startSession({ objective: 'private objective' }))
      .structuredContent.session.sessionId
    const premature = await client.deleteSession(sessionId)
    assert.equal(premature.isError, true)
    assert.match(premature.content[0].text, /session_not_terminal/)
    await client.stopSession(sessionId)
    assert.ok((await client.getSessionEvents(sessionId)).structuredContent.events.length > 0)
    const deleted = await client.deleteSession(sessionId)
    assert.equal(deleted.structuredContent.deletion.deleted, true)
    assert.ok(deleted.structuredContent.deletion.deletedEvents > 0)
    const missing = await client.getSession(sessionId)
    assert.equal(missing.isError, true)
    assert.match(missing.content[0].text, /session_not_found/)
  } finally {
    await client.close()
  }
})

test('multi-agent target reservations detect conflicts before lease acquisition', async () => {
  const session = { async dispatch() { return { content: [] } } }
  const client = await connectInProcess(createComputerUseServer({ session, enableV8: true }))
  try {
    const firstSession = (await client.startSession({ executionGroupId: 'team' })).structuredContent.session.sessionId
    const secondSession = (await client.startSession({ executionGroupId: 'team' })).structuredContent.session.sessionId
    const first = await client.reserveTarget({
      sessionId: firstSession, intentId: 'edit-report', agentId: 'planner-a',
      appId: 'app.report', windowId: 7, ttlMs: 30_000,
    })
    const replay = await client.reserveTarget({
      sessionId: firstSession, intentId: 'edit-report', agentId: 'planner-a',
      appId: 'app.report', windowId: 7, ttlMs: 30_000,
    })
    assert.equal(replay.structuredContent.reservation.reservationId,
      first.structuredContent.reservation.reservationId)

    const conflict = await client.reserveTarget({
      sessionId: secondSession, intentId: 'also-edit-report', agentId: 'planner-b',
      appId: 'APP.REPORT', windowId: 7, ttlMs: 30_000,
    })
    assert.equal(conflict.isError, true)
    assert.match(conflict.content[0].text, /target_conflict/)

    const independent = await client.reserveTarget({
      sessionId: secondSession, intentId: 'edit-other-window', agentId: 'planner-b',
      appId: 'app.report', windowId: 8, ttlMs: 30_000,
    })
    assert.equal(independent.structuredContent.reservation.state, 'active')
    const released = await client.releaseTargetReservation(
      firstSession, first.structuredContent.reservation.reservationId,
    )
    assert.equal(released.structuredContent.reservation.state, 'released')
    const afterRelease = await client.reserveTarget({
      sessionId: secondSession, intentId: 'now-edit-report', agentId: 'planner-b',
      appId: 'app.report', windowId: 7, ttlMs: 30_000,
    })
    assert.equal(afterRelease.structuredContent.reservation.state, 'active')
  } finally {
    await client.close()
  }
})

test('execute_action preserves model-visible image content and replays receipt once', async () => {
  let dispatches = 0
  const session = { async dispatch(tool) { dispatches++; assert.equal(tool, 'screenshot'); return imageResult } }
  const runtime = new RuntimeCoordinator({ execute: (tool, args, signal) => session.dispatch(tool, args, signal) })
  const client = await connectInProcess(createComputerUseServer({
    session, runtime, enableV8: true, principalId: 'authenticated-host',
  }))
  const args = {
    session_id: 'session-vision', action_id: 'action-vision', tool: 'screenshot',
    arguments: { quality: 0 }, mode: 'shadow',
  }
  try {
    const first = await client.callTool('execute_action', args)
    assert.equal(first.isError, undefined)
    assert.ok(first.content.some(item => item.type === 'image' && item.data === 'aW1hZ2U='))
    assert.equal(first.structuredContent.output.observation_id, 'obs-1')
    assert.equal(first.structuredContent.receipt.status, 'committed')

    const replay = await client.callTool('execute_action', { ...args, attempt: 2 })
    assert.equal(replay.structuredContent.replay, true)
    assert.equal(replay.structuredContent.receipt.receiptId, first.structuredContent.receipt.receiptId)
    assert.equal(dispatches, 1)
    assert.ok(runtime.events.query('session-vision').every(event => event.principalId === 'authenticated-host'))
  } finally {
    await client.close()
  }
})

test('lease MCP tools enforce exclusive foreground pairing and emergency stop', async () => {
  const session = { async dispatch() { return { content: [] } } }
  const client = await connectInProcess(createComputerUseServer({ session, enableV8: true }))
  try {
    const invalid = await client.callTool('acquire_control_lease', {
      session_id: 's', kind: 'exclusive', mode: 'background', ttl_ms: 1000, action_budget: 1,
    })
    assert.equal(invalid.isError, true)
    assert.match(invalid.content[0].text, /exclusive leases require foreground/)

    const stopped = await client.callTool('emergency_stop', {})
    assert.equal(stopped.structuredContent.stopped, true)
    const afterStop = await client.callTool('acquire_control_lease', {
      session_id: 's', kind: 'cooperative', mode: 'background', ttl_ms: 1000, action_budget: 1,
    })
    assert.equal(afterStop.isError, true)
    assert.match(afterStop.content[0].text, /interrupted/)
  } finally {
    await client.close()
  }
})
