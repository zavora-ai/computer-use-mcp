import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ManualEmergencyStopMonitor,
  PollingEmergencyStopMonitor,
} from '../dist/control/activity-monitor.js'
import { RuntimeCoordinator } from '../dist/runtime/coordinator.js'

test('physical emergency generation revokes control and remains latched without an active call', async () => {
  const monitor = new ManualEmergencyStopMonitor()
  let nativeTriggers = 0
  const runtime = new RuntimeCoordinator({
    execute: async () => ({ content: [] }),
    emergencyStopMonitor: monitor,
    nativeEmergencyStop: () => { nativeTriggers++ },
  })
  const lease = await runtime.leases.acquire({
    sessionId: 'session-emergency',
    principalId: 'local-user',
    kind: 'cooperative',
    executionMode: 'foreground',
    ttlMs: 10_000,
    actionBudget: 2,
  })

  monitor.emit(7)
  assert.equal(runtime.leases.current(), undefined)
  assert.throws(() => runtime.leases.validate(lease.leaseId), /not active/)
  await assert.rejects(runtime.leases.acquire({
    sessionId: 'new-session',
    principalId: 'local-user',
    kind: 'cooperative',
    executionMode: 'foreground',
    ttlMs: 10_000,
    actionBudget: 1,
  }), /emergency stop is active/)
  assert.equal(nativeTriggers, 0, 'physical monitor reports an already-latched native stop')
  runtime.dispose()
})

test('API emergency stop synchronously invokes the native fail-closed latch', () => {
  let nativeTriggers = 0
  let nativeResets = 0
  let nativeActive = false
  const runtime = new RuntimeCoordinator({
    execute: async () => ({ content: [] }),
    nativeEmergencyStop: () => { nativeTriggers++; nativeActive = true },
    nativeEmergencyReset: () => { nativeResets++; nativeActive = false },
    nativeEmergencyStatus: () => ({
      active: nativeActive, generation: nativeTriggers, supported: true,
      backend: 'test_physical_hook', chord: 'ctrl+alt+shift+escape',
    }),
  })
  runtime.emergencyStop('supervisor_requested')
  assert.equal(nativeTriggers, 1)
  assert.deepEqual(runtime.emergencyStopStatus(), {
    active: true, generation: 1, supported: true,
    backend: 'test_physical_hook', chord: 'ctrl+alt+shift+escape',
  })
  runtime.resetEmergencyStop()
  assert.equal(nativeResets, 1)
  assert.equal(runtime.emergencyStopStatus().active, false)
  runtime.dispose()
})

test('polling monitor emits each native generation once', async () => {
  let generation = 4
  const monitor = new PollingEmergencyStopMonitor(
    { getEmergencyStopGeneration: () => generation },
    { backend: 'test-native-hook', pollMs: 5 },
  )
  const observed = []
  monitor.start(event => observed.push(event.generation))
  generation = 5
  await new Promise(resolve => setTimeout(resolve, 20))
  await new Promise(resolve => setTimeout(resolve, 10))
  generation = 6
  await new Promise(resolve => setTimeout(resolve, 20))
  monitor.stop()
  assert.deepEqual(observed, [5, 6])
})

test('live chord probe refuses to manufacture evidence without a present operator', async () => {
  const { probes } = await import('../scripts/probes/v8-emergency-chord.mjs')
  const result = await probes['physical-emergency-chord']({ platform: process.platform })
  assert.equal(result.evidenceLevel, 'live')
  assert.equal(result.status, 'blocked')
  assert.match(result.blocker, /present operator|does not match/)
})
