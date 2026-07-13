import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ControlLeaseManager } from '../dist/control/lease.js'
import { DeterministicFakeDesktop } from '../dist/reliability/index.js'
import { RuntimeCoordinator } from '../dist/runtime/coordinator.js'
import { RuntimeError } from '../dist/runtime/types.js'

const corpus = JSON.parse(await readFile(new URL('../contracts/v8/safety-corpus.json', import.meta.url), 'utf8'))
const allow = async () => ({ decision: 'allow', policyDigest: 'fake-corpus', reasons: ['deterministic_corpus'] })

async function setup(fake) {
  const leases = new ControlLeaseManager()
  const coordinator = new RuntimeCoordinator({
    leases,
    policy: allow,
    execute: fake.execute,
    validateTarget: fake.validateTarget,
    transactionHooks: fake,
    now: fake.now,
  })
  const lease = await leases.acquire({
    sessionId: 'corpus-session', principalId: 'corpus-principal', kind: 'cooperative',
    executionMode: 'background', ttlMs: 10_000, actionBudget: 2,
    boundaries: { appIds: [fake.state.appId], windowIds: [fake.state.windowId] },
  })
  const request = {
    sessionId: 'corpus-session', principalId: 'corpus-principal', actionId: 'corpus-action',
    tool: 'write_clipboard', args: { text: 'corpus value' }, mode: 'background',
    target: fake.targetEvidence(), leaseId: lease.leaseId,
  }
  return { coordinator, leases, lease, request }
}

test('versioned deterministic safety corpus enforces effect and replay invariants', async t => {
  assert.equal(corpus.schemaVersion, 1)
  for (const scenario of corpus.scenarios) {
    await t.test(scenario.id, async () => {
      const fake = new DeterministicFakeDesktop()
      const { coordinator, leases, lease, request } = await setup(fake)
      try {
        if (scenario.fault === 'target_drift') fake.driftWindow()
        if (scenario.fault === 'fail_after_effect') fake.failAfterNextEffect()
        const started = scenario.fault === 'wait_for_abort' ? fake.waitForAbortOnNextEffect() : undefined

        const execution = coordinator.execute(request)
        if (started) {
          await started
          leases.revoke(lease.leaseId, 'physical_user_activity')
        }

        let outcome
        let error
        try { outcome = await execution } catch (value) { error = value }
        if (scenario.expected.status) assert.equal(outcome?.receipt.status, scenario.expected.status)
        if (scenario.expected.error) {
          const code = error instanceof RuntimeError ? error.code
            : scenario.fault === 'fail_after_effect' ? 'indeterminate' : undefined
          assert.equal(code, scenario.expected.error)
        }
        assert.equal(fake.state.effectCount, scenario.expected.effects)
        assert.equal(fake.state.restoreCount, scenario.expected.restores)

        if (scenario.expected.replayEffects !== undefined || scenario.expected.receiptStatus) {
          const replay = await coordinator.execute({ ...request, attempt: 2 })
          assert.equal(fake.state.effectCount, scenario.expected.replayEffects ?? scenario.expected.effects)
          assert.equal(replay.receipt.status, scenario.expected.receiptStatus ?? scenario.expected.status ?? 'indeterminate')
          assert.equal(replay.replay, true)
        }
      } finally {
        coordinator.dispose()
      }
    })
  }
})

test('10,000 deterministic lease schedules preserve one-writer and terminal-revocation invariants', async () => {
  let now = Date.parse('2026-07-13T00:00:00Z')
  let seed = 0x8badf00d
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  const leases = new ControlLeaseManager(() => now)
  const revoked = new Set()
  leases.onRevoked(lease => {
    assert.notEqual(lease.state, 'active')
    assert.equal(revoked.has(lease.leaseId), false, 'a lease terminated more than once')
    revoked.add(lease.leaseId)
  })
  let emergency = false

  for (let step = 0; step < 10_000; step++) {
    let active = leases.current()
    if (!active) {
      if (emergency) { leases.resetEmergencyStop(); emergency = false }
      active = await leases.acquire({
        sessionId: `session-${step}`, principalId: 'corpus-principal', kind: 'cooperative',
        executionMode: 'background', ttlMs: 1 + (random() % 20),
        actionBudget: 1 + (random() % 4), boundaries: { appIds: ['app.fake'] },
      })
    }

    switch (random() % 7) {
      case 0:
        try { leases.consume(active.leaseId) } catch (error) {
          assert.ok(error instanceof RuntimeError && error.code === 'lease_revoked')
        }
        break
      case 1:
        assert.throws(() => leases.validate(active.leaseId, { appId: 'app.escape' }), error =>
          error instanceof RuntimeError && error.code === 'lease_revoked')
        break
      case 2:
        leases.recordUserActivity(now + 1)
        break
      case 3:
        now += 25
        leases.current()
        break
      case 4:
        leases.release(active.leaseId)
        break
      case 5:
        leases.revoke(active.leaseId, 'deterministic_schedule')
        break
      case 6:
        leases.emergencyStop('deterministic_schedule')
        emergency = true
        break
    }

    const current = leases.current()
    if (current) {
      assert.equal(current.state, 'active')
      assert.equal(current.principalId, 'corpus-principal')
      assert.ok(current.actionsUsed <= current.actionBudget)
    }
  }
})
