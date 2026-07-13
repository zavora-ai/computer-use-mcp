import test from 'node:test'
import assert from 'node:assert/strict'
import { ControlLeaseManager } from '../dist/control/lease.js'
import { TargetReservationManager } from '../dist/control/reservation.js'
import { FileReceiptStore, MemoryReceiptStore } from '../dist/control/receipts.js'
import { RuntimeCoordinator, digestAction } from '../dist/runtime/coordinator.js'
import { capabilityForTool } from '../dist/runtime/capabilities.js'
import { CapabilityRegistry } from '../dist/runtime/capabilities.js'
import {
  CapabilityCertificationService,
  FileCertificationTraceStore,
  verifyCertificationTrace,
} from '../dist/runtime/adapters.js'
import { RuntimeError } from '../dist/runtime/types.js'
import { TOOL_CATALOG } from '../dist/tool-catalog.js'
import { FileSessionStore, MemorySessionStore } from '../dist/session/store.js'
import { SessionLifecycle } from '../dist/session/lifecycle.js'
import { FileEventJournal, SupervisorEventBus } from '../dist/session/events.js'
import { ManualInputActivityMonitor, PollingInputActivityMonitor } from '../dist/control/activity-monitor.js'
import { MemoryApprovalGrantStore } from '../dist/policy/grants.js'
import { createDefaultV8PolicyFromEnvironment, createPolicyV2Evaluator } from '../dist/policy/engine.js'
import { compareTargetEvidence, evidenceDigest } from '../dist/targeting/validate.js'
import { SessionTargetEvidenceValidator } from '../dist/targeting/session-validator.js'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const allow = async () => ({ decision: 'allow', policyDigest: 'test', reasons: ['test'] })

test('authorization loss revokes control and pauses every active session owned by that principal', async () => {
  const runtime = new RuntimeCoordinator({ execute: async () => ({ content: [] }) })
  const owned = await runtime.startSession({ principalId: 'remote-owner' })
  const other = await runtime.startSession({ principalId: 'other-owner' })
  await runtime.reserveTarget({
    sessionId: owned.sessionId, principalId: 'remote-owner', intentId: 'remote-plan',
    appId: 'app.safe', ttlMs: 10_000,
  })
  const lease = await runtime.leases.acquire({
    sessionId: owned.sessionId, principalId: 'remote-owner', kind: 'cooperative',
    executionMode: 'background', ttlMs: 10_000, actionBudget: 1,
  })
  const affected = await runtime.suspendPrincipal('remote-owner', 'remote_disconnected')
  assert.deepEqual(affected.map(session => session.sessionId), [owned.sessionId])
  assert.equal((await runtime.getSession(owned.sessionId, 'remote-owner')).state, 'paused_by_policy')
  assert.equal((await runtime.getSession(other.sessionId, 'other-owner')).state, 'running')
  assert.equal(runtime.leases.current(), undefined)
  assert.equal(runtime.reservations.active().length, 0)
  assert.equal(lease.state, 'active', 'returned lease snapshot remains immutable historical evidence')
})

test('capability contract never claims physical input is background-safe', () => {
  const physical = capabilityForTool('left_click', TOOL_CATALOG.left_click)
  assert.deepEqual(physical.supportedModes, ['shadow', 'foreground'])
  assert.equal(physical.interference, 'moves_physical_pointer')

  const clipboard = capabilityForTool('write_clipboard', TOOL_CATALOG.write_clipboard)
  assert.deepEqual(clipboard.supportedModes, ['shadow', 'background', 'foreground'])
  assert.equal(clipboard.interference, 'none')

  const arbitraryScript = capabilityForTool('run_script', TOOL_CATALOG.run_script)
  assert.deepEqual(arbitraryScript.supportedModes, ['shadow', 'foreground'])
})

test('live capability certification is version, tool, action-contract, and trace bound', async () => {
  let now = Date.parse('2026-07-13T10:00:00Z')
  const registry = new CapabilityRegistry(() => new Date(now))
  let appVersion = '2.1'
  let probe = {
    supported: true, interference: 'none', focusChanged: false,
    physicalInputInjected: false, pointerMoved: false,
    evidence: {
      frontmostAppBefore: 'app.foreground', frontmostAppAfter: 'app.foreground',
      pointerBefore: { x: 10, y: 20 }, pointerAfter: { x: 10, y: 20 },
      quietPeriodSatisfied: true, executionSucceeded: true,
      postconditionSatisfied: true, rollbackSucceeded: true,
      postconditionDigest: `sha256:${'a'.repeat(64)}`,
      secretValue: 'must-never-persist',
    },
  }
  const adapter = {
    id: 'sandbox-applescript', version: '1', platform: process.platform,
    supports: (appId, operation) => appId === 'app.safe' && operation === 'write_document',
    backend: () => 'applescript',
    contract: () => ({ tool: 'run_script', version: '1', bindingDigest: `sha256:${'1'.repeat(64)}`, description: 'sandbox document write' }),
    getAppVersion: async () => appVersion,
    matchesAction: (_appId, _operation, args) => args.document_id === 'safe-document',
    probe: async () => probe,
  }
  const service = new CapabilityCertificationService(registry, [adapter], () => new Date(now))
  const certified = await service.certify({
    appId: 'app.safe', expectedAppVersion: '2.1', operation: 'write_document', ttlMs: 100,
  })
  assert.ok(certified.supportedModes.includes('background'))
  assert.match(certified.certification.certificationId, /^cert_[a-f0-9]{32}$/)
  assert.match(certified.certification.traceDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(registry.find('app.safe', 'write_document').length, 1)
  assert.ok(await registry.resolve({
    appId: 'app.safe', operation: 'write_document',
    certificationId: certified.certification.certificationId,
    tool: 'run_script', args: { document_id: 'safe-document' },
  }))
  assert.equal(await registry.resolve({
    appId: 'app.safe', operation: 'write_document',
    certificationId: certified.certification.certificationId,
    tool: 'run_script', args: { document_id: 'other-document' },
  }), undefined)
  const trace = await service.traces.get(certified.certification.certificationId)
  assert.equal(verifyCertificationTrace(trace), true)
  assert.doesNotMatch(JSON.stringify(trace), /must-never-persist/)

  probe = { ...probe, interference: 'takes_foreground', focusChanged: true }
  const unsafe = await service.certify({
    appId: 'app.safe', expectedAppVersion: '2.1', operation: 'write_document', ttlMs: 100,
  })
  assert.equal(unsafe.supportedModes.includes('background'), false)
  now += 101
  assert.equal(registry.find('app.safe', 'write_document').length, 0)

  now -= 101
  probe = { ...probe, interference: 'none', focusChanged: false }
  const versionBound = await service.certify({
    appId: 'app.safe', expectedAppVersion: '2.1', operation: 'write_document',
  })
  appVersion = '2.2'
  assert.equal(await registry.resolve({
    appId: 'app.safe', operation: 'write_document',
    certificationId: versionBound.certification.certificationId,
    tool: 'run_script', args: { document_id: 'safe-document' },
  }), undefined)
  assert.equal(registry.find('app.safe', 'write_document').length, 0)
})

test('durable certification traces are private, atomic, and tamper evident', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-certification-'))
  try {
    const store = new FileCertificationTraceStore(directory)
    const certificationNow = () => new Date('2026-07-13T10:00:01Z')
    const registry = new CapabilityRegistry(certificationNow)
    let durableAppVersion = '1.0'
    const adapter = {
      id: 'durable-test', version: '1', platform: process.platform,
      supports: () => true,
      backend: () => 'scripting',
      contract: () => ({ tool: 'run_script', version: '1', bindingDigest: `sha256:${'2'.repeat(64)}`, description: 'durable test' }),
      getAppVersion: async () => durableAppVersion,
      matchesAction: () => true,
      probe: async () => ({
        supported: true, interference: 'none', focusChanged: false,
        physicalInputInjected: false, pointerMoved: false,
        evidence: {
          frontmostAppBefore: 'same', frontmostAppAfter: 'same',
          pointerBefore: { x: 1, y: 1 }, pointerAfter: { x: 1, y: 1 },
          quietPeriodSatisfied: true, executionSucceeded: true,
          postconditionSatisfied: true, rollbackSucceeded: true,
        },
      }),
    }
    const service = new CapabilityCertificationService(
      registry, [adapter], () => new Date('2026-07-13T10:00:00Z'), store, process.platform,
    )
    const capability = await service.certify({ appId: 'app', operation: 'operation' })
    const id = capability.certification.certificationId
    const path = join(directory, `${id}.json`)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.equal((await store.list()).length, 1)
    const restoredRegistry = new CapabilityRegistry(certificationNow)
    const restoredService = new CapabilityCertificationService(
      restoredRegistry, [adapter], () => new Date('2026-07-13T10:00:01Z'), store, process.platform,
    )
    assert.deepEqual(await restoredService.restore(), { restored: [id], rejected: [] })
    assert.ok(await restoredRegistry.resolve({
      appId: 'app', operation: 'operation', certificationId: id,
      tool: 'run_script', args: {},
    }))
    durableAppVersion = '2.0'
    const changedRegistry = new CapabilityRegistry(certificationNow)
    const changedService = new CapabilityCertificationService(
      changedRegistry, [adapter], () => new Date('2026-07-13T10:00:01Z'), store, process.platform,
    )
    assert.deepEqual(await changedService.restore(), {
      restored: [], rejected: [{ certificationId: id, reason: 'app_version_changed' }],
    })
    const bytes = await readFile(path, 'utf8')
    await writeFile(path, bytes.replace('durable test', 'tampered test'))
    await assert.rejects(store.get(id), /integrity check failed/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('operation labels cannot borrow certification and app versions are rechecked before execution', async () => {
  let appVersion = '1.0'
  const registry = new CapabilityRegistry()
  const adapter = {
    id: 'bound-script', version: '1', platform: process.platform,
    supports: (appId, operation) => appId === 'app.safe' && operation === 'safe_script',
    backend: () => 'applescript',
    contract: () => ({ tool: 'run_script', version: '1', bindingDigest: `sha256:${'3'.repeat(64)}`, description: 'one canonical script' }),
    getAppVersion: async () => appVersion,
    matchesAction: (_appId, _operation, args) => args.language === 'applescript' && args.script === 'safe-script',
    probe: async () => ({
      supported: true, interference: 'none', focusChanged: false,
      physicalInputInjected: false, pointerMoved: false,
      evidence: {
        frontmostAppBefore: 'app.user', frontmostAppAfter: 'app.user',
        pointerBefore: { x: 1, y: 2 }, pointerAfter: { x: 1, y: 2 },
        quietPeriodSatisfied: true, executionSucceeded: true,
        postconditionSatisfied: true, rollbackSucceeded: true,
      },
    }),
  }
  const certification = await new CapabilityCertificationService(registry, [adapter]).certify({
    appId: 'app.safe', operation: 'safe_script',
  })
  let calls = 0
  const leases = new ControlLeaseManager()
  const coordinator = new RuntimeCoordinator({
    capabilities: registry, leases, policy: allow,
    validateTarget: async () => true,
    execute: async () => { calls++; return { content: [] } },
  })
  const target = {
    platform: process.platform, appId: 'app.safe', observationId: 'app-observation',
    confidence: 1, capturedAt: new Date().toISOString(),
  }
  const base = {
    sessionId: 'certified', principalId: 'p', tool: 'run_script', operation: 'safe_script',
    mode: 'background', target,
  }
  assert.equal((await coordinator.preview({
    ...base, actionId: 'label-only', args: { language: 'applescript', script: 'safe-script' },
  })).blocker, 'foreground_required')
  assert.equal((await coordinator.preview({
    ...base, actionId: 'wrong-args', certificationId: certification.certification.certificationId,
    args: { language: 'applescript', script: 'unsafe-script' },
  })).blocker, 'foreground_required')

  const lease = await leases.acquire({
    sessionId: 'certified', principalId: 'p', kind: 'cooperative', executionMode: 'background',
    ttlMs: 10_000, actionBudget: 1, boundaries: { appIds: ['app.safe'] },
  })
  const valid = {
    ...base, actionId: 'valid', certificationId: certification.certification.certificationId,
    args: { language: 'applescript', script: 'safe-script' }, leaseId: lease.leaseId,
  }
  assert.equal((await coordinator.execute(valid)).receipt.status, 'committed')
  assert.equal(calls, 1)

  appVersion = '2.0'
  assert.equal((await coordinator.preview({ ...valid, actionId: 'changed-version' })).blocker, 'foreground_required')
  assert.equal(registry.find('app.safe', 'safe_script').length, 0)
  coordinator.dispose()
})

test('lease manager is one-writer, priority-aware, bounded, and user-revocable', async () => {
  let now = 1_000
  const leases = new ControlLeaseManager(() => now)
  const first = await leases.acquire({
    sessionId: 's1', principalId: 'p1', kind: 'cooperative', executionMode: 'background',
    ttlMs: 1_000, actionBudget: 2, boundaries: { appIds: ['app.safe'] },
  })
  const low = leases.acquire({
    sessionId: 's2', principalId: 'p2', kind: 'cooperative', executionMode: 'background',
    ttlMs: 1_000, actionBudget: 1, priority: 0,
  })
  const high = leases.acquire({
    sessionId: 's3', principalId: 'p3', kind: 'exclusive', executionMode: 'foreground',
    ttlMs: 1_000, actionBudget: 1, priority: 10,
  })
  assert.equal(leases.queued(), 2)
  leases.validate(first.leaseId, { appId: 'app.safe' })
  leases.consume(first.leaseId)
  const revoked = leases.recordUserActivity(now + 1)
  assert.equal(revoked?.revokedReason, 'physical_user_activity')
  const second = await high
  assert.equal(second.sessionId, 's3')
  leases.release(second.leaseId)
  assert.equal((await low).sessionId, 's2')
})

test('lease expiry and emergency stop prevent later mutations', async () => {
  let now = 10
  const leases = new ControlLeaseManager(() => now)
  const lease = await leases.acquire({
    sessionId: 's', principalId: 'p', kind: 'cooperative', executionMode: 'background',
    ttlMs: 5, actionBudget: 1,
  })
  now = 16
  assert.throws(() => leases.validate(lease.leaseId), error =>
    error instanceof RuntimeError && error.code === 'lease_revoked')
  leases.emergencyStop()
  await assert.rejects(leases.acquire({
    sessionId: 's2', principalId: 'p', kind: 'cooperative', executionMode: 'background',
    ttlMs: 5, actionBudget: 1,
  }), error => error instanceof RuntimeError && error.code === 'interrupted')
})

test('lease boundary escape revokes ownership instead of leaving a usable lease', async () => {
  const leases = new ControlLeaseManager()
  const lease = await leases.acquire({
    sessionId: 'bounded', principalId: 'p', kind: 'cooperative', executionMode: 'background',
    ttlMs: 1_000, actionBudget: 2, boundaries: { appIds: ['app.safe'] },
  })
  assert.throws(() => leases.validate(lease.leaseId, { appId: 'app.escape' }), error =>
    error instanceof RuntimeError && error.code === 'lease_revoked')
  assert.equal(leases.current(), undefined)
})

test('target reservations are idempotent, expiring planner intent without writer authority', () => {
  let now = 1_000
  const reservations = new TargetReservationManager(() => now)
  const request = {
    intentId: 'intent-a', sessionId: 'session-a', principalId: 'principal', agentId: 'planner-a',
    scope: { appId: 'app.safe', windowId: 7 }, ttlMs: 10,
  }
  const first = reservations.reserve(request)
  assert.equal(reservations.reserve(request).reservationId, first.reservationId)
  assert.throws(() => reservations.reserve({
    ...request, intentId: 'intent-b', sessionId: 'session-b', agentId: 'planner-b',
  }), error => error instanceof RuntimeError && error.code === 'target_conflict')
  assert.throws(() => reservations.reserve({
    ...request, intentId: 'intent-private', sessionId: 'session-private',
    principalId: 'other-principal', agentId: 'private-agent',
  }), error => error instanceof RuntimeError
    && error.code === 'target_conflict'
    && error.details.occupied === true
    && error.details.agentId === undefined)
  assert.equal(reservations.reserve({
    ...request, intentId: 'intent-c', sessionId: 'session-c', scope: { appId: 'app.safe', windowId: 8 },
  }).state, 'active')
  now = 1_011
  assert.equal(reservations.get(first.reservationId).state, 'expired')
  assert.doesNotThrow(() => reservations.reserve({
    ...request, intentId: 'intent-d', sessionId: 'session-d',
  }))
})

test('receipt store returns committed result and rejects action-id digest reuse', async () => {
  const receipts = new MemoryReceiptStore()
  const begun = await receipts.begin({ sessionId: 's', actionId: 'a', actionDigest: 'd1', attempt: 1 })
  assert.equal(begun.replay, false)
  await receipts.finish(begun.receipt.receiptId, { status: 'committed', result: { ok: true } })
  const replay = await receipts.begin({ sessionId: 's', actionId: 'a', actionDigest: 'd1', attempt: 2 })
  assert.equal(replay.replay, true)
  assert.equal(replay.receipt.status, 'committed')
  await assert.rejects(
    receipts.begin({ sessionId: 's', actionId: 'a', actionDigest: 'different', attempt: 2 }),
    error => error instanceof RuntimeError && error.code === 'action_id_conflict',
  )
})

test('durable receipt store survives restart, excludes result bytes, and detects pending recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-receipts-'))
  try {
    const firstStore = new FileReceiptStore(directory)
    const begun = await firstStore.begin({ sessionId: 's', actionId: 'committed', actionDigest: 'd1', attempt: 1 })
    await firstStore.finish(begun.receipt.receiptId, {
      status: 'committed',
      result: { content: [{ type: 'image', data: 'secret-image-bytes', mimeType: 'image/png' }] },
    })

    const restarted = new FileReceiptStore(directory)
    const replay = await restarted.begin({ sessionId: 's', actionId: 'committed', actionDigest: 'd1', attempt: 2 })
    assert.equal(replay.replay, true)
    assert.equal(replay.receipt.status, 'committed')
    assert.equal(replay.receipt.result, undefined)
    const persisted = await Promise.all(
      (await readdir(directory)).map(name => readFile(join(directory, name), 'utf8')),
    )
    assert.doesNotMatch(persisted.join('\n'), /secret-image-bytes/)

    const pending = await restarted.begin({ sessionId: 's', actionId: 'pending', actionDigest: 'd2', attempt: 1 })
    assert.equal(pending.receipt.status, 'pending')
    const afterCrash = await new FileReceiptStore(directory).begin({
      sessionId: 's', actionId: 'pending', actionDigest: 'd2', attempt: 2,
    })
    assert.equal(afterCrash.replay, true)
    assert.equal(afterCrash.receipt.status, 'pending')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('durable receipt terminal state is first-writer-wins across store instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-receipt-cas-'))
  try {
    const first = new FileReceiptStore(directory)
    const begun = await first.begin({ sessionId: 's', actionId: 'race', actionDigest: 'digest', attempt: 1 })
    const second = new FileReceiptStore(directory)
    await second.get('s', 'race')
    const outcomes = await Promise.all([
      first.finish(begun.receipt.receiptId, { status: 'committed' }),
      second.finish(begun.receipt.receiptId, {
        status: 'indeterminate', error: { code: 'race', message: 'competing terminal writer' },
      }),
    ])
    assert.equal(outcomes[0].status, outcomes[1].status)
    assert.notEqual(outcomes[0].status, 'pending')
    assert.equal((await new FileReceiptStore(directory).get('s', 'race')).status, outcomes[0].status)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('incomplete durable receipt reservation fails closed instead of repeating an action', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-receipt-corrupt-'))
  try {
    const sessionId = 's'
    const actionId = 'reserved'
    const key = createHash('sha256').update(`${sessionId}\u0000${actionId}`).digest('hex')
    await writeFile(join(directory, `${key}.json`), '')
    const store = new FileReceiptStore(directory)
    await assert.rejects(
      store.begin({ sessionId, actionId, actionDigest: 'digest', attempt: 2 }),
      error => error instanceof RuntimeError && error.code === 'indeterminate',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('durable receipt errors redact messages and session deletion removes only matching receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-receipt-retention-'))
  try {
    const store = new FileReceiptStore(directory)
    const privateReceipt = await store.begin({
      sessionId: 'private-session', actionId: 'private-action', actionDigest: 'private-digest', attempt: 1,
    })
    await store.finish(privateReceipt.receipt.receiptId, {
      status: 'rejected', error: { code: 'failed', message: 'password=hunter2' },
    })
    const retainedReceipt = await store.begin({
      sessionId: 'retained-session', actionId: 'retained-action', actionDigest: 'retained-digest', attempt: 1,
    })
    await store.finish(retainedReceipt.receipt.receiptId, { status: 'committed' })
    const before = (await Promise.all((await readdir(directory))
      .filter(name => name.endsWith('.json'))
      .map(name => readFile(join(directory, name), 'utf8')))).join('\n')
    assert.doesNotMatch(before, /hunter2/)
    assert.match(before, /REDACTED sha256:/)

    assert.equal(await store.deleteSession('private-session'), 1)
    assert.equal(await store.get('private-session', 'private-action'), undefined)
    assert.equal((await store.get('retained-session', 'retained-action')).status, 'committed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('action digest is deterministic across object key order', () => {
  assert.equal(digestAction({ b: 2, a: { y: 1, x: 0 } }), digestAction({ a: { x: 0, y: 1 }, b: 2 }))
})

test('approval grants bind principal, session, digest, class, mode, and action idempotently', async () => {
  let now = Date.parse('2026-07-13T10:00:00Z')
  const grants = new MemoryApprovalGrantStore(() => now)
  const coordinator = new RuntimeCoordinator({
    grants,
    now: () => new Date(now),
    execute: async () => ({ content: [{ type: 'text', text: 'sent' }] }),
  })
  const request = {
    sessionId: 'approval-session', principalId: 'principal', actionId: 'approved-action',
    tool: 'notification', args: { title: 'Done', message: 'Complete' }, mode: 'background',
  }
  const blocked = await coordinator.preview(request)
  assert.equal(blocked.blocker, 'approval_required')
  const grant = grants.issue({
    principalId: 'principal', sessionId: 'approval-session',
    actionDigest: blocked.envelope.argsDigest, actionClass: blocked.envelope.actionClass,
    policyDigest: blocked.policy.policyDigest, mode: 'background', ttlMs: 1_000,
  })
  const approved = await coordinator.preview({ ...request, approvalGrantId: grant.grantId })
  assert.equal(approved.executable, true)
  const wrongPrincipal = await coordinator.preview({
    ...request, principalId: 'attacker', approvalGrantId: grant.grantId,
  })
  assert.equal(wrongPrincipal.blocker, 'approval_required')

  const lease = await coordinator.leases.acquire({
    sessionId: 'approval-session', principalId: 'principal', kind: 'cooperative',
    executionMode: 'background', ttlMs: 1_000, actionBudget: 2,
  })
  const executed = await coordinator.execute({
    ...request, approvalGrantId: grant.grantId, leaseId: lease.leaseId,
  })
  assert.equal(executed.receipt.status, 'committed')
  const replay = await coordinator.execute({
    ...request, approvalGrantId: grant.grantId, leaseId: lease.leaseId, attempt: 2,
  })
  assert.equal(replay.replay, true)
  const regenerated = await coordinator.preview({
    ...request, actionId: 'regenerated-action', approvalGrantId: grant.grantId,
  })
  assert.equal(regenerated.blocker, 'approval_required')
  now += 2_000
  assert.throws(() => grants.validate(grant.grantId, blocked.envelope, blocked.policy.policyDigest), /expired|unknown/)
})

test('approval grant is invalidated when the active policy digest changes', async () => {
  let policyDigest = 'policy-v1'
  const grants = new MemoryApprovalGrantStore()
  const coordinator = new RuntimeCoordinator({
    grants,
    policy: () => ({ decision: 'confirm', policyDigest, reasons: ['test'] }),
    execute: async () => ({ content: [] }),
  })
  const request = {
    sessionId: 'policy-change', principalId: 'p', actionId: 'exact', tool: 'notification',
    args: { title: 'Done', message: 'Done' }, mode: 'background',
  }
  const preview = await coordinator.preview(request)
  const grant = grants.issue({
    principalId: 'p', sessionId: 'policy-change', actionDigest: preview.envelope.argsDigest,
    policyDigest: preview.policy.policyDigest, actionClass: preview.envelope.actionClass,
    mode: 'background', ttlMs: 30_000,
  })
  assert.equal((await coordinator.preview({ ...request, approvalGrantId: grant.grantId })).executable, true)
  policyDigest = 'policy-v2'
  assert.equal(
    (await coordinator.preview({ ...request, approvalGrantId: grant.grantId })).blocker,
    'approval_required',
  )
})

test('policy v2 enforces operation resource boundaries before lease acquisition', async () => {
  const coordinator = new RuntimeCoordinator({
    policy: createPolicyV2Evaluator({
      filesystemRoots: ['/safe/root'],
      registryHives: ['HKCU:\\Software\\Allowed'],
      allowedDomains: ['example.com'],
      blockedProcesses: ['security-agent.exe'],
    }),
    execute: async () => ({ content: [] }),
  })
  const filesystem = await coordinator.preview({
    sessionId: 'policy', principalId: 'p', actionId: 'fs', tool: 'filesystem', mode: 'background',
    args: { mode: 'write', path: '/outside/value.txt', content: 'x' },
  })
  assert.equal(filesystem.blocker, 'policy_denied')
  assert.match(filesystem.policy.reasons[0], /filesystem_outside_roots/)

  const registry = await coordinator.preview({
    sessionId: 'policy', principalId: 'p', actionId: 'reg', tool: 'registry', mode: 'background',
    args: { mode: 'set', path: 'HKLM:\\Software\\Unsafe', name: 'x', value: '1' },
  })
  assert.equal(registry.blocker, 'policy_denied')

  const scrape = await coordinator.preview({
    sessionId: 'policy', principalId: 'p', actionId: 'web', tool: 'scrape', mode: 'background',
    args: { url: 'https://evil.invalid/instructions' },
  })
  assert.equal(scrape.blocker, 'policy_denied')

  const allowedRead = await coordinator.preview({
    sessionId: 'policy', principalId: 'p', actionId: 'read', tool: 'filesystem', mode: 'background',
    args: { mode: 'read', path: '/safe/root/report.txt' },
  })
  assert.equal(allowedRead.executable, true)
  assert.equal(allowedRead.envelope.resource.filesystemPath, '/safe/root/report.txt')
})

test('declared app/window targets are digest-bound and enforced by policy and lease boundaries', async () => {
  const policy = createDefaultV8PolicyFromEnvironment({
    COMPUTER_USE_ALLOWED_APPS: 'app.safe',
    COMPUTER_USE_BLOCKED_APPS: 'app.blocked',
    COMPUTER_USE_CREDENTIAL_APPS: 'app.credentials',
    COMPUTER_USE_V8_ALLOW_SCRAPE: 'false',
  })
  const coordinator = new RuntimeCoordinator({
    policy,
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  })
  const base = {
    sessionId: 'target-policy', principalId: 'p', mode: 'foreground', tool: 'mouse_move',
    args: { coordinate: [10, 20], target_app: 'app.safe', target_window_id: 7 },
  }
  const allowed = await coordinator.preview({ ...base, actionId: 'allowed' })
  assert.equal(allowed.policy.decision, 'allow')
  assert.deepEqual(allowed.envelope.resource, { targetAppId: 'app.safe', targetWindowId: 7 })

  const blocked = await coordinator.preview({
    ...base, actionId: 'blocked', args: { ...base.args, target_app: 'app.blocked' },
  })
  assert.equal(blocked.blocker, 'policy_denied')
  const outside = await coordinator.preview({
    ...base, actionId: 'outside', args: { ...base.args, target_app: 'app.other' },
  })
  assert.equal(outside.blocker, 'policy_denied')
  const sensitive = await coordinator.preview({
    ...base, actionId: 'sensitive', args: { ...base.args, target_app: 'app.credentials' },
  })
  // The allowlist is authoritative; sensitive apps must also be explicitly allowed.
  assert.equal(sensitive.blocker, 'policy_denied')

  const lease = await coordinator.leases.acquire({
    sessionId: 'target-policy', principalId: 'p', kind: 'exclusive', executionMode: 'foreground',
    ttlMs: 1_000, actionBudget: 1, boundaries: { appIds: ['app.other'], windowIds: [7] },
  })
  await assert.rejects(coordinator.execute({
    sessionId: 'target-policy', principalId: 'p', actionId: 'lease-escape',
    tool: 'open_application', args: { bundle_id: 'app.safe' }, mode: 'foreground',
    leaseId: lease.leaseId,
  }), error => error instanceof RuntimeError && error.code === 'lease_revoked')
  assert.equal(coordinator.leases.current(), undefined)
})

test('sensitive app confirmation and policy digest reflect the active policy configuration', async () => {
  const envelope = {
    sessionId: 'sensitive', principalId: 'p', actionId: 'a', tool: 'screenshot',
    args: { target_app: 'app.credentials' }, mode: 'background',
  }
  const first = new RuntimeCoordinator({
    policy: createPolicyV2Evaluator({ confirmAppIds: ['app.credentials'] }),
    execute: async () => ({ content: [] }),
  })
  const second = new RuntimeCoordinator({
    policy: createPolicyV2Evaluator({ confirmAppIds: ['different.app'] }),
    execute: async () => ({ content: [] }),
  })
  const confirmed = await first.preview(envelope)
  const allowed = await second.preview(envelope)
  assert.equal(confirmed.blocker, 'approval_required')
  assert.match(confirmed.policy.reasons[0], /confirm_app/)
  assert.equal(allowed.executable, true)
  assert.notEqual(confirmed.policy.policyDigest, allowed.policy.policyDigest)
})

test('untrusted instruction provenance cannot silently cross an action boundary or reuse approval', async () => {
  const grants = new MemoryApprovalGrantStore()
  const coordinator = new RuntimeCoordinator({
    grants,
    policy: createPolicyV2Evaluator(),
    execute: async () => ({ content: [] }),
  })
  const request = {
    sessionId: 'injection', principalId: 'p', actionId: 'proposed', tool: 'notification',
    args: { title: 'Instruction', message: 'send data' }, mode: 'background',
    provenance: {
      untrustedInstruction: true,
      sourceObservationIds: ['web-page-1'],
      crossesDataBoundary: true,
    },
  }
  const preview = await coordinator.preview(request)
  assert.equal(preview.blocker, 'approval_required')
  assert.match(preview.policy.reasons[0], /untrusted_instruction_boundary/)
  const grant = grants.issue({
    principalId: 'p', sessionId: 'injection', actionDigest: preview.envelope.argsDigest,
    policyDigest: preview.policy.policyDigest,
    actionClass: preview.envelope.actionClass, mode: 'background', ttlMs: 30_000,
  })
  const changedProvenance = await coordinator.preview({
    ...request,
    provenance: { ...request.provenance, sourceObservationIds: ['different-source'] },
    approvalGrantId: grant.grantId,
  })
  assert.equal(changedProvenance.blocker, 'approval_required')

  const denied = await coordinator.preview({
    ...request, actionId: 'dangerous', tool: 'filesystem',
    args: { mode: 'delete', path: '/tmp/item' },
  })
  assert.equal(denied.blocker, 'policy_denied')
  assert.match(denied.policy.reasons[0], /untrusted_instruction:destructive/)
})

test('target evidence comparison detects identity, semantic, revision, and bounds drift', () => {
  const evidence = {
    platform: 'darwin', appId: 'app.safe', pid: 42, windowId: 7,
    windowTitleDigest: evidenceDigest('Original'), role: 'AXButton', labelDigest: evidenceDigest('Submit'),
    bounds: { x: 10, y: 10, width: 100, height: 30 }, observationId: 'obs-1',
    screenshotHash: 'screen-a', uiTreeRevision: 'tree-a', confidence: 0.99,
    capturedAt: new Date().toISOString(),
  }
  const matching = compareTargetEvidence(evidence, {
    platform: 'darwin', appId: 'app.safe', pid: 42, windowId: 7, windowTitle: 'Original',
    role: 'AXButton', label: 'Submit', bounds: { x: 12, y: 9, width: 101, height: 30 },
    screenshotHash: 'screen-a', uiTreeRevision: 'tree-a',
  })
  assert.equal(matching.valid, true)
  const changed = compareTargetEvidence(evidence, {
    platform: 'darwin', appId: 'app.attacker', pid: 99, windowId: 8, windowTitle: 'Changed',
    role: 'AXTextField', label: 'Authorize', bounds: { x: 500, y: 500, width: 20, height: 20 },
    screenshotHash: 'screen-b', uiTreeRevision: 'tree-b',
  })
  assert.equal(changed.valid, false)
  assert.deepEqual(changed.mismatches, [
    'appId', 'pid', 'windowId', 'role', 'windowTitleDigest', 'labelDigest',
    'screenshotHash', 'uiTreeRevision', 'bounds',
  ])
})

test('live session target validator fails closed on stale window identity and unresolved semantic evidence', async () => {
  const session = {
    dispatch: async () => ({
      content: [{ type: 'text', text: '{}' }],
      structuredContent: {
        windowId: 7, bundleId: 'app.safe', pid: 42, title: 'Document', displayId: 1,
        bounds: { x: 10, y: 10, width: 100, height: 30 },
      },
    }),
  }
  const validator = new SessionTargetEvidenceValidator(session)
  const base = {
    platform: process.platform, appId: 'app.safe', pid: 42, windowId: 7,
    windowTitleDigest: evidenceDigest('Document'), displayId: '1',
    bounds: { x: 10, y: 10, width: 100, height: 30 }, observationId: 'obs',
    confidence: 1, capturedAt: new Date().toISOString(),
  }
  assert.equal(await validator.validate(base), true)
  assert.equal(await validator.validate({ ...base, appId: 'app.replaced' }), false)
  assert.equal(await validator.validate({ ...base, role: 'AXButton' }), false)
  assert.equal(await validator.validate({ ...base, windowId: 'non-native-window' }), false)
})

test('coordinator blocks shadow mutation and background physical input before executor', async () => {
  let calls = 0
  const coordinator = new RuntimeCoordinator({
    execute: async () => { calls++; return { content: [{ type: 'text', text: 'unexpected' }] } },
    policy: allow,
  })
  const base = { sessionId: 's', principalId: 'p', actionId: 'a', tool: 'left_click', args: { coordinate: [1, 2] } }
  await assert.rejects(coordinator.execute({ ...base, mode: 'shadow' }), error =>
    error instanceof RuntimeError && error.code === 'shadow_mutation')
  await assert.rejects(coordinator.execute({ ...base, actionId: 'b', mode: 'background' }), error =>
    error instanceof RuntimeError && error.code === 'foreground_required')
  const foreground = await coordinator.preview({ ...base, actionId: 'c', mode: 'foreground' })
  assert.equal(foreground.blocker, 'target_evidence_required')
  assert.equal(calls, 0)
})

test('physical input fails closed when attributed user-activity monitoring is required', async () => {
  const unattributedMonitor = {
    capability: {
      supported: true,
      backend: 'combined_idle_clock',
      distinguishesInjected: false,
      recommendedPollMs: 25,
    },
    start() {},
    stop() {},
    suppressInjectedFor() {},
  }
  const coordinator = new RuntimeCoordinator({
    policy: allow,
    activityMonitor: unattributedMonitor,
    requireAttributedPhysicalInput: true,
    execute: async () => { throw new Error('must not execute') },
  })
  const request = {
    sessionId: 'attribution', principalId: 'p', actionId: 'physical', tool: 'left_click',
    args: { coordinate: [1, 2] }, mode: 'foreground',
  }
  const preview = await coordinator.preview(request)
  assert.equal(preview.executable, false)
  assert.equal(preview.blocker, 'input_attribution_unavailable')
  await assert.rejects(coordinator.execute(request), error =>
    error instanceof RuntimeError && error.code === 'input_attribution_unavailable')
  coordinator.dispose()
})

test('attributed monitors never suppress physical user takeover during agent input', async () => {
  let suppressionCalls = 0
  const attributedMonitor = {
    capability: {
      supported: true,
      backend: 'physical_only_test_clock',
      distinguishesInjected: true,
      recommendedPollMs: 5,
    },
    start() {},
    stop() {},
    suppressInjectedFor() { suppressionCalls++ },
  }
  const leases = new ControlLeaseManager()
  const lease = await leases.acquire({
    sessionId: 'attributed', principalId: 'p', kind: 'exclusive', executionMode: 'foreground',
    ttlMs: 10_000, actionBudget: 1,
  })
  const coordinator = new RuntimeCoordinator({
    leases,
    policy: allow,
    activityMonitor: attributedMonitor,
    requireAttributedPhysicalInput: true,
    validateTarget: async () => true,
    execute: async () => ({ content: [{ type: 'text', text: 'clicked' }] }),
  })
  const outcome = await coordinator.execute({
    sessionId: 'attributed', principalId: 'p', actionId: 'physical', tool: 'left_click',
    args: { coordinate: [1, 2] }, mode: 'foreground', leaseId: lease.leaseId,
    target: {
      platform: process.platform, appId: 'app.fake', windowId: 1,
      observationId: 'attributed-observation', confidence: 1, capturedAt: new Date().toISOString(),
    },
  })
  assert.equal(outcome.receipt.status, 'committed')
  assert.equal(suppressionCalls, 0)
  coordinator.dispose()
})

test('coordinator rejects nested provider batches below the MCP registry boundary', async () => {
  const coordinator = new RuntimeCoordinator({
    policy: allow, execute: async () => { throw new Error('must not execute') },
  })
  await assert.rejects(coordinator.preview({
    sessionId: 'nested', principalId: 'p', actionId: 'batch', tool: 'openai_computer',
    args: { actions: [{ type: 'click', x: 1, y: 2 }] }, mode: 'foreground',
  }), error => error instanceof RuntimeError && error.code === 'policy_denied')
})

test('coordinator executes a background-safe mutation once and replays its receipt', async () => {
  let calls = 0
  const leases = new ControlLeaseManager()
  const lease = await leases.acquire({
    sessionId: 's', principalId: 'p', kind: 'cooperative', executionMode: 'background',
    ttlMs: 10_000, actionBudget: 2,
  })
  const coordinator = new RuntimeCoordinator({
    leases,
    policy: allow,
    execute: async () => {
      calls++
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  })
  const request = {
    sessionId: 's', principalId: 'p', actionId: 'stable-action', tool: 'write_clipboard',
    args: { text: 'hello' }, mode: 'background', leaseId: lease.leaseId,
  }
  const first = await coordinator.execute(request)
  const replay = await coordinator.execute({ ...request, attempt: 2 })
  assert.equal(first.receipt.status, 'committed')
  assert.equal(replay.replay, true)
  assert.equal(replay.receipt.receiptId, first.receipt.receiptId)
  assert.equal(calls, 1)
  assert.deepEqual(coordinator.events.query('s').map(event => event.sequence), [1, 2, 3, 4])
})

test('stale evidence rejects before the side-effect boundary', async () => {
  const now = new Date('2026-07-13T10:00:00.000Z')
  const leases = new ControlLeaseManager(() => now.getTime())
  const lease = await leases.acquire({
    sessionId: 's', principalId: 'p', kind: 'exclusive', executionMode: 'foreground',
    ttlMs: 10_000, actionBudget: 1,
  })
  let calls = 0
  const coordinator = new RuntimeCoordinator({
    leases, policy: allow, now: () => now, maxTargetAgeMs: 100,
    execute: async () => { calls++; return { content: [] } },
  })
  await assert.rejects(coordinator.execute({
    sessionId: 's', principalId: 'p', actionId: 'a', tool: 'left_click', mode: 'foreground',
    args: { coordinate: [1, 2] }, leaseId: lease.leaseId,
    target: {
      platform: 'darwin', appId: 'app', observationId: 'obs', confidence: 1,
      capturedAt: '2026-07-13T09:59:59.000Z',
    },
  }), error => error instanceof RuntimeError && error.code === 'stale_target')
  assert.equal(calls, 0)
  assert.equal((await coordinator.receipts.get('s', 'a')).status, 'rejected')
})

test('executor failure after mutation boundary becomes indeterminate and is never retried', async () => {
  const leases = new ControlLeaseManager()
  const lease = await leases.acquire({
    sessionId: 's', principalId: 'p', kind: 'cooperative', executionMode: 'background',
    ttlMs: 10_000, actionBudget: 2,
  })
  let calls = 0
  const coordinator = new RuntimeCoordinator({
    leases, policy: allow,
    execute: async () => { calls++; throw new Error('transport lost after dispatch') },
  })
  const request = {
    sessionId: 's', principalId: 'p', actionId: 'a', tool: 'write_clipboard', mode: 'background',
    args: { text: 'x' }, leaseId: lease.leaseId,
  }
  await assert.rejects(coordinator.execute(request), /transport lost/)
  const replay = await coordinator.execute({ ...request, attempt: 2 })
  assert.equal(replay.receipt.status, 'indeterminate')
  assert.equal(calls, 1)
})

test('legacy error results cannot be committed as successful v8 receipts', async () => {
  let calls = 0
  const leases = new ControlLeaseManager()
  const coordinator = new RuntimeCoordinator({
    leases, policy: allow,
    execute: async () => {
      calls++
      return { content: [{ type: 'text', text: 'native handler failed' }], isError: true }
    },
  })
  const lease = await leases.acquire({
    sessionId: 'handler-error', principalId: 'p', kind: 'cooperative', executionMode: 'background',
    ttlMs: 10_000, actionBudget: 1,
  })
  const request = {
    sessionId: 'handler-error', principalId: 'p', actionId: 'handler-error-action',
    tool: 'write_clipboard', args: { text: 'value' }, mode: 'background', leaseId: lease.leaseId,
  }
  await assert.rejects(coordinator.execute(request), error =>
    error instanceof RuntimeError && error.code === 'indeterminate')
  assert.equal(leases.current(), undefined)
  const replay = await coordinator.execute({ ...request, attempt: 2 })
  assert.equal(replay.receipt.status, 'indeterminate')
  assert.equal(calls, 1)

  const observation = new RuntimeCoordinator({
    policy: allow,
    execute: async () => ({ content: [{ type: 'text', text: 'capture failed' }], isError: true }),
  })
  await assert.rejects(observation.execute({
    sessionId: 'observe-error', principalId: 'p', actionId: 'observe-error-action',
    tool: 'screenshot', args: {}, mode: 'shadow',
  }), error => error instanceof RuntimeError && error.code === 'execution_failed')
})

test('bounded transaction captures, executes, verifies, and restores before commit', async () => {
  const order = []
  const leases = new ControlLeaseManager()
  const lease = await leases.acquire({
    sessionId: 'transaction', principalId: 'p', kind: 'cooperative', executionMode: 'background',
    ttlMs: 10_000, actionBudget: 1,
  })
  const coordinator = new RuntimeCoordinator({
    leases,
    policy: allow,
    transactionHooks: {
      capture: async () => {
        order.push('capture')
        return { capturedAt: new Date().toISOString(), cursor: { x: 10, y: 20 } }
      },
      verify: async () => {
        order.push('verify')
        return { verified: true, method: 'test_postcondition' }
      },
      restore: async () => {
        order.push('restore')
        return { restored: true, cursorRestored: true }
      },
    },
    execute: async () => {
      order.push('execute')
      return { content: [{ type: 'text', text: 'ok' }] }
    },
  })
  const outcome = await coordinator.execute({
    sessionId: 'transaction', principalId: 'p', actionId: 'bounded', tool: 'write_clipboard',
    args: { text: 'safe' }, mode: 'background', leaseId: lease.leaseId,
  })
  assert.equal(outcome.receipt.status, 'committed')
  assert.deepEqual(order, ['capture', 'execute', 'verify', 'restore'])
  assert.deepEqual(
    coordinator.events.query('transaction').map(event => event.type),
    ['action.previewed', 'action.started', 'action.verified', 'action.restored', 'action.committed'],
  )
})

test('user takeover during verification suppresses cursor and focus restoration', async () => {
  const leases = new ControlLeaseManager()
  const lease = await leases.acquire({
    sessionId: 'takeover', principalId: 'p', kind: 'exclusive', executionMode: 'foreground',
    ttlMs: 10_000, actionBudget: 1,
  })
  let restoreCalls = 0
  const coordinator = new RuntimeCoordinator({
    leases,
    policy: allow,
    validateTarget: async () => true,
    transactionHooks: {
      capture: async () => ({ capturedAt: new Date().toISOString(), cursor: { x: 10, y: 20 } }),
      verify: async () => {
        leases.revoke(lease.leaseId, 'physical_user_activity')
        return { verified: true, method: 'test_postcondition' }
      },
      restore: async () => {
        restoreCalls++
        return { restored: true }
      },
    },
    execute: async () => ({ content: [{ type: 'text', text: 'clicked' }] }),
  })
  const outcome = await coordinator.execute({
    sessionId: 'takeover', principalId: 'p', actionId: 'no-restore', tool: 'left_click',
    args: { coordinate: [100, 100] }, mode: 'foreground', leaseId: lease.leaseId,
    target: {
      platform: process.platform, appId: 'app.fake', windowId: 7,
      observationId: 'takeover-observation', confidence: 1, capturedAt: new Date().toISOString(),
    },
  })
  assert.equal(outcome.receipt.status, 'committed')
  assert.equal(restoreCalls, 0)
  assert.equal(coordinator.events.query('takeover').some(event => event.type === 'action.restored'), false)
})

test('lease revocation aborts an active action and makes its side effect indeterminate', async () => {
  const leases = new ControlLeaseManager()
  const lease = await leases.acquire({
    sessionId: 'active-revoke', principalId: 'p', kind: 'cooperative', executionMode: 'background',
    ttlMs: 10_000, actionBudget: 1,
  })
  let executorStarted
  const started = new Promise(resolve => { executorStarted = resolve })
  let observedAbort = false
  const coordinator = new RuntimeCoordinator({
    leases,
    policy: allow,
    execute: async (_tool, _args, signal) => {
      executorStarted()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      observedAbort = signal.aborted
      throw new RuntimeError('interrupted', 'cancelled by lease revocation')
    },
  })
  const request = {
    sessionId: 'active-revoke', principalId: 'p', actionId: 'in-flight', tool: 'write_clipboard',
    args: { text: 'value' }, mode: 'background', leaseId: lease.leaseId,
  }
  const execution = coordinator.execute(request)
  await started
  leases.revoke(lease.leaseId, 'physical_user_activity')
  await assert.rejects(execution, error => error instanceof RuntimeError && error.code === 'interrupted')
  assert.equal(observedAbort, true)
  const replay = await coordinator.execute({ ...request, attempt: 2 })
  assert.equal(replay.receipt.status, 'indeterminate')
})

test('lease TTL actively aborts an in-flight action without waiting for another lease call', async () => {
  const leases = new ControlLeaseManager()
  const lease = await leases.acquire({
    sessionId: 'active-expiry', principalId: 'p', kind: 'cooperative', executionMode: 'background',
    ttlMs: 10, actionBudget: 1,
  })
  let aborted = false
  const coordinator = new RuntimeCoordinator({
    leases,
    policy: allow,
    execute: async (_tool, _args, signal) => {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      aborted = true
      throw new RuntimeError('interrupted', 'lease expired')
    },
  })
  await assert.rejects(coordinator.execute({
    sessionId: 'active-expiry', principalId: 'p', actionId: 'ttl-action', tool: 'write_clipboard',
    args: { text: 'value' }, mode: 'background', leaseId: lease.leaseId,
  }), error => error instanceof RuntimeError && error.code === 'interrupted')
  assert.equal(aborted, true)
  assert.equal(leases.current(), undefined)
})

test('failed postcondition verification is indeterminate and cannot repeat the mutation', async () => {
  const leases = new ControlLeaseManager()
  const lease = await leases.acquire({
    sessionId: 'verification', principalId: 'p', kind: 'cooperative', executionMode: 'background',
    ttlMs: 10_000, actionBudget: 2,
  })
  let calls = 0
  let restoreCalls = 0
  const coordinator = new RuntimeCoordinator({
    leases,
    policy: allow,
    transactionHooks: {
      capture: async () => ({ capturedAt: new Date().toISOString() }),
      verify: async () => ({ verified: false, method: 'missing_postcondition' }),
      restore: async () => {
        restoreCalls++
        return { restored: true }
      },
    },
    execute: async () => {
      calls++
      return { content: [{ type: 'text', text: 'possibly changed' }] }
    },
  })
  const request = {
    sessionId: 'verification', principalId: 'p', actionId: 'uncertain', tool: 'write_clipboard',
    args: { text: 'value' }, mode: 'background', leaseId: lease.leaseId,
  }
  await assert.rejects(coordinator.execute(request), error =>
    error instanceof RuntimeError && error.code === 'indeterminate')
  assert.equal(leases.current(), undefined)
  const replay = await coordinator.execute({ ...request, attempt: 2 })
  assert.equal(replay.receipt.status, 'indeterminate')
  assert.equal(calls, 1)
  assert.equal(restoreCalls, 0)
})

test('session lifecycle enforces transitions and emits monotonic events', async () => {
  const lifecycle = new SessionLifecycle(new MemorySessionStore())
  const running = await lifecycle.start({ principalId: 'principal', objective: 'test' })
  const paused = await lifecycle.transition(running.sessionId, 'paused_by_user', 'takeover')
  assert.equal(paused.state, 'paused_by_user')
  await assert.rejects(lifecycle.transition(running.sessionId, 'completed'), /invalid session transition/)
  const events = lifecycle.events.query(running.sessionId)
  assert.deepEqual(events.map(event => event.sequence), [1, 2, 3])
  assert.deepEqual(events.map(event => event.type), ['session.created', 'session.state_changed', 'session.state_changed'])
  assert.doesNotMatch(JSON.stringify(events), /takeover/)
  assert.match(events.at(-1).payload.reasonMetadata.digest, /^sha256:/)
})

test('session completion events disclose evidence metadata without free-form text', async () => {
  const lifecycle = new SessionLifecycle(new MemorySessionStore())
  const running = await lifecycle.start({ principalId: 'principal', objective: 'private objective' })
  await lifecycle.complete(running.sessionId, {
    summary: 'private completion narrative',
    postconditions: [{ description: 'private document name', satisfied: true, evidenceHash: 'sha256:evidence' }],
    actionCounts: { committed: 1 },
  })
  const event = lifecycle.events.query(running.sessionId).at(-1)
  const serialized = JSON.stringify(event)
  assert.equal(event.type, 'session.completed')
  assert.doesNotMatch(serialized, /private completion narrative|private document name/)
  assert.match(event.payload.summaryMetadata.digest, /^sha256:/)
  assert.deepEqual(event.payload.postconditions, {
    total: 1, satisfied: 1, evidenceHashes: ['sha256:evidence'],
  })
})

test('durable session CAS recovers nonterminal work paused and persists completion evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-sessions-'))
  try {
    const store = new FileSessionStore(directory)
    const lifecycle = new SessionLifecycle(store)
    const running = await lifecycle.start({ principalId: 'owner', objective: 'durable work' })
    const current = await store.get(running.sessionId)
    const first = { ...current, revision: current.revision + 1, objective: 'first writer' }
    const second = { ...current, revision: current.revision + 1, objective: 'second writer' }
    const outcomes = await Promise.all([
      store.compareAndSet(running.sessionId, current.revision, first),
      store.compareAndSet(running.sessionId, current.revision, second),
    ])
    assert.deepEqual(outcomes.sort(), [false, true])

    const restarted = new FileSessionStore(directory)
    const recovered = await restarted.recoverAll()
    assert.equal(recovered.length, 1)
    assert.equal(recovered[0].state, 'paused_by_user')
    assert.equal(recovered[0].recovered, true)
    assert.equal(recovered[0].waitingReason, 'runtime_recovered')

    const resumedLifecycle = new SessionLifecycle(restarted)
    await resumedLifecycle.transition(running.sessionId, 'running')
    const completed = await resumedLifecycle.complete(running.sessionId, {
      summary: 'objective satisfied',
      postconditions: [{ description: 'document exists', satisfied: true, evidenceHash: 'sha256:evidence' }],
      lastAppId: 'app.safe', lastWindowId: 7,
      actionCounts: { committed: 1 },
    })
    assert.equal(completed.state, 'completed')
    assert.equal(completed.completion.summary, 'objective satisfied')
    assert.equal((await new FileSessionStore(directory).recoverAll()).length, 0)
    assert.equal(await restarted.delete(completed.sessionId, completed.revision), true)
    assert.equal(await restarted.get(completed.sessionId), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('durable session deletion is revision-bound and terminal retention pruning is owner-scoped', async () => {
  let now = new Date('2026-07-01T00:00:00Z')
  const store = new MemorySessionStore(() => now)
  const coordinator = new RuntimeCoordinator({
    lifecycle: new SessionLifecycle(store, undefined, () => now),
    requireManagedSession: true,
    policy: allow,
    execute: async () => ({ content: [] }),
  })
  const old = await coordinator.startSession({ principalId: 'owner' })
  await coordinator.stopSession(old.sessionId, 'owner')
  now = new Date('2026-07-10T00:00:00Z')
  const recent = await coordinator.startSession({ principalId: 'owner' })
  await coordinator.stopSession(recent.sessionId, 'owner')
  const other = await coordinator.startSession({ principalId: 'other' })
  await coordinator.stopSession(other.sessionId, 'other')

  const deleted = await coordinator.pruneSessions('owner', new Date('2026-07-05T00:00:00Z'))
  assert.deepEqual(deleted.map(value => value.sessionId), [old.sessionId])
  assert.equal(await store.get(old.sessionId), undefined)
  assert.ok(await store.get(recent.sessionId))
  assert.ok(await store.get(other.sessionId))
  assert.equal(await store.delete(recent.sessionId, 999), false)
})

test('session deletion revokes receipts, approval grants, and pending approval state', async () => {
  const receipts = new MemoryReceiptStore()
  const grants = new MemoryApprovalGrantStore()
  const coordinator = new RuntimeCoordinator({
    receipts, grants, requireManagedSession: true,
    policy: envelope => envelope.tool === 'notification'
      ? { decision: 'confirm', policyDigest: 'delete-policy', reasons: ['confirm'] }
      : { decision: 'allow', policyDigest: 'delete-policy', reasons: ['allow'] },
    execute: async () => ({ content: [] }),
  })
  const session = await coordinator.startSession({ principalId: 'owner' })
  const observed = await coordinator.execute({
    sessionId: session.sessionId, principalId: 'owner', actionId: 'observation',
    tool: 'screenshot', args: {}, mode: 'shadow',
  })
  const pending = await coordinator.preview({
    sessionId: session.sessionId, principalId: 'owner', actionId: 'pending-approval',
    tool: 'notification', args: { title: 'done', message: 'private' }, mode: 'background',
  })
  const grant = await coordinator.approveAction(session.sessionId, 'owner', 'pending-approval')
  await coordinator.stopSession(session.sessionId, 'owner')
  const deletion = await coordinator.deleteSession(session.sessionId, 'owner')
  assert.equal(deletion.deletedReceipts, 1)
  assert.equal(deletion.revokedGrants, 1)
  assert.equal(await receipts.get(session.sessionId, 'observation'), undefined)
  assert.throws(() => grants.validate(grant.grantId, pending.envelope, pending.policy.policyDigest),
    error => error instanceof RuntimeError && error.code === 'approval_required')
  await assert.rejects(coordinator.approveAction(session.sessionId, 'owner', 'pending-approval'),
    error => error instanceof RuntimeError && error.code === 'session_not_found')
  assert.equal(observed.receipt.status, 'committed')
})

test('supervisor events redact nested credential-bearing fields before storage and emission', () => {
  const bus = new SupervisorEventBus()
  let emitted
  bus.subscribe(event => { emitted = event })
  const stored = bus.publish({
    sessionId: 'redaction', type: 'test.secret',
    payload: {
      username: 'alice', password: 'do-not-store',
      nested: { api_key: 'also-secret', safe: 'visible' },
    },
  })
  assert.equal(stored.payload.password, '[REDACTED]')
  assert.equal(stored.payload.nested.api_key, '[REDACTED]')
  assert.equal(stored.payload.nested.safe, 'visible')
  assert.deepEqual(emitted, stored)
})

test('opt-in event journal is redacted, permission-restricted, and tamper evident', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-events-'))
  const path = join(directory, 'events.jsonl')
  try {
    const journal = new FileEventJournal(path)
    const bus = new SupervisorEventBus(() => new Date('2026-07-13T10:00:00Z'), undefined, journal)
    bus.publish({
      sessionId: 'audit', type: 'test',
      payload: { safe: 'visible', password: 'never-persist-this' },
    })
    bus.publish({ sessionId: 'audit', type: 'test.second', payload: { count: 2 } })
    const persisted = await readFile(path, 'utf8')
    assert.doesNotMatch(persisted, /never-persist-this/)
    assert.match(persisted, /\[REDACTED\]/)
    assert.deepEqual(FileEventJournal.verify(path), { valid: true, records: 2 })
    const exported = bus.query('audit')
    assert.equal(exported[0].integrity.previousHash, '0'.repeat(64))
    assert.equal(exported[1].integrity.previousHash, exported[0].integrity.hash)
    const restarted = new SupervisorEventBus(
      () => new Date('2026-07-13T10:01:00Z'), undefined, new FileEventJournal(path),
    )
    const afterRestart = restarted.publish({ sessionId: 'audit', type: 'test.recovered', payload: {} })
    assert.equal(afterRestart.sequence, 3)
    assert.deepEqual(restarted.query('audit').map(event => event.sequence), [1, 2, 3])

    const withRestart = await readFile(path, 'utf8')
    await writeFile(path, withRestart.replace('visible', 'tampered'))
    assert.deepEqual(FileEventJournal.verify(path), { valid: false, records: 3, failedAt: 1 })
    assert.throws(() => new FileEventJournal(path), /integrity verification failed/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('event journal serializes competing writers into one valid per-session stream', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-event-writers-'))
  const path = join(directory, 'events.jsonl')
  try {
    const first = new SupervisorEventBus(undefined, undefined, new FileEventJournal(path))
    const second = new SupervisorEventBus(undefined, undefined, new FileEventJournal(path))
    const one = first.publish({ sessionId: 'shared', type: 'writer.one', payload: {} })
    const two = second.publish({ sessionId: 'shared', type: 'writer.two', payload: {} })
    assert.deepEqual([one.sequence, two.sequence], [1, 2])
    assert.deepEqual(first.query('shared').map(event => event.sequence), [1, 2])
    assert.deepEqual(FileEventJournal.verify(path), { valid: true, records: 2 })
    const reopened = new FileEventJournal(path)
    assert.deepEqual(reopened.query('shared').map(event => event.sequence), [1, 2])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('event journal deletion atomically rewrites a valid retained chain and removes private stream bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-event-retention-'))
  const path = join(directory, 'events.jsonl')
  try {
    const bus = new SupervisorEventBus(undefined, undefined, new FileEventJournal(path))
    bus.publish({ sessionId: 'private-session', type: 'private.one', payload: { marker: 'erase-me' } })
    bus.publish({ sessionId: 'retained-session', type: 'keep.one', payload: { marker: 'keep-me' } })
    bus.publish({ sessionId: 'private-session', type: 'private.two', payload: { count: 2 } })
    bus.publish({ sessionId: 'retained-session', type: 'keep.two', payload: { count: 2 } })

    const deletion = bus.deleteSession('private-session')
    assert.equal(deletion.deletedEvents, 2)
    assert.ok(deletion.retentionMarkerId)
    assert.deepEqual(bus.query('private-session'), [])
    assert.deepEqual(bus.query('retained-session').map(event => event.sequence), [1, 2])
    assert.deepEqual(FileEventJournal.verify(path), { valid: true, records: 3 })
    const persisted = await readFile(path, 'utf8')
    assert.doesNotMatch(persisted, /private-session|erase-me|private\.one|private\.two/)
    assert.match(persisted, /journal\.retention_applied|previousTerminalHash/)

    const restarted = new SupervisorEventBus(undefined, undefined, new FileEventJournal(path))
    assert.equal(restarted.publish({
      sessionId: 'retained-session', type: 'keep.three', payload: {},
    }).sequence, 3)
    assert.deepEqual(FileEventJournal.verify(path), { valid: true, records: 4 })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('durable session limit serializes competing creators and permits reuse only after deletion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-session-limit-'))
  try {
    const firstWriter = new FileSessionStore(directory, { maxSessions: 1 })
    const secondWriter = new FileSessionStore(directory, { maxSessions: 1 })
    const attempts = await Promise.allSettled([
      firstWriter.create({ principalId: 'one' }),
      secondWriter.create({ principalId: 'two' }),
    ])
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
    const rejected = attempts.find(result => result.status === 'rejected')
    assert.match(String(rejected?.reason), /session store limit reached.*prune terminal sessions/)

    const existing = (await firstWriter.list())[0]
    assert.ok(existing)
    assert.equal(await secondWriter.delete(existing.sessionId, existing.revision), true)
    const replacement = await firstWriter.create({ principalId: 'replacement' })
    assert.equal(replacement.principalId, 'replacement')
    assert.equal((await secondWriter.list()).length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('event journal size limit fails before persistence and preserves the existing chain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-event-limit-'))
  const path = join(directory, 'events.jsonl')
  try {
    const bus = new SupervisorEventBus(undefined, undefined, new FileEventJournal(path, { maxBytes: 1024 }))
    bus.publish({ sessionId: 'bounded', type: 'small', payload: { value: 1 } })
    assert.throws(
      () => bus.publish({ sessionId: 'bounded', type: 'oversized', payload: { data: 'x'.repeat(2000) } }),
      /event journal size limit reached.*prune terminal sessions/,
    )
    assert.deepEqual(bus.query('bounded').map(event => event.type), ['small'])
    assert.deepEqual(FileEventJournal.verify(path), { valid: true, records: 1 })
    assert.doesNotMatch(await readFile(path, 'utf8'), /oversized/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('activity monitor revokes cooperative lease and emits supervisor event', async () => {
  const monitor = new ManualInputActivityMonitor()
  const leases = new ControlLeaseManager()
  const coordinator = new RuntimeCoordinator({
    leases,
    activityMonitor: monitor,
    policy: allow,
    execute: async () => ({ content: [] }),
  })
  const lease = await leases.acquire({
    sessionId: 'activity-session', principalId: 'person', kind: 'cooperative',
    executionMode: 'background', ttlMs: 10_000, actionBudget: 1,
  })
  monitor.emit(Date.now() + 1, Date.now() + 2)
  assert.equal(leases.current(), undefined)
  const event = coordinator.events.query('activity-session').at(-1)
  assert.equal(event.type, 'control.user_activity_revoked')
  assert.equal(event.payload.leaseId, lease.leaseId)
  coordinator.dispose()
})

test('polling monitor detects a forward OS input-clock edge within polling interval', async () => {
  let now = 5_000
  let idle = 1_000
  const source = {
    getUserIdleTimeMs: () => idle,
    getInputMonitorCapability: () => ({
      supported: true, backend: 'fake_idle_clock', distinguishesInjected: false,
      recommendedPollMs: 5,
    }),
  }
  const monitor = new PollingInputActivityMonitor(source, { now: () => now, pollMs: 5 })
  const event = new Promise(resolve => monitor.start(resolve))
  now = 5_010
  idle = 0
  const detected = await Promise.race([
    event,
    new Promise((_, reject) => setTimeout(() => reject(new Error('activity was not detected')), 100)),
  ])
  assert.equal(detected.backend, 'fake_idle_clock')
  assert.equal(detected.latencyMs, 0)
  monitor.stop()
})
