import assert from 'node:assert/strict'
import test from 'node:test'
import { createCapabilityManifest } from '../dist/runtime/manifest.js'
import { RuntimeCoordinator } from '../dist/runtime/coordinator.js'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { MemoryEvidenceFrameStore } from '../dist/session/evidence-frames.js'

const runtime = () => new RuntimeCoordinator({ execute: async () => ({ content: [] }) })

test('capability manifest is deterministic, profile-bounded, and honest about interference', () => {
  const options = {
    runtime: runtime(), maximumProfile: 'full', activeProfile: 'v8-safe',
    experimentalTasks: true, durableSessions: true, durableReceipts: false,
    durableEvents: true, supervisorIpcConfigured: false,
    supervisorFramesEnabled: true,
    physicalInputRequiresAttributedMonitor: true,
    platform: 'win32', architecture: 'x64', generatedAt: new Date('2026-07-13T00:00:00.000Z'),
    inputMonitor: {
      supported: true, backend: 'test-clock', distinguishesInjected: false, recommendedPollMs: 25,
      reason: 'test capability',
    },
  }
  const first = createCapabilityManifest(options)
  const second = createCapabilityManifest(options)
  assert.equal(first.manifestDigest, second.manifestDigest)
  assert.equal(first.compatibility.v7WireToolCount, 64)
  assert.equal(first.actuators.length, 64)
  assert.equal(first.actuators.every(entry => entry.exposed === false), true)
  const click = first.actuators.find(entry => entry.tool === 'left_click').capabilities[0]
  assert.equal(click.interference, 'moves_physical_pointer')
  assert.equal(click.supportedModes.includes('background'), false)
  assert.deepEqual(first.features.remoteSidecar, {
    available: true, configured: false, defaultBind: 'loopback', publicIngressSupported: false,
  })
  assert.equal(first.inputMonitor.distinguishesInjected, false)
  assert.equal(first.features.physicalInputRequiresAttributedMonitor, true)
  assert.equal(first.features.supervisorFramesEnabled, true)
})

test('v8 server publishes the capability manifest as a machine-readable resource', async () => {
  const session = { async dispatch() { return { content: [] } } }
  let registry
  const client = await connectInProcess(createComputerUseServer({
    session, runtime: new RuntimeCoordinator({
      evidenceFrames: new MemoryEvidenceFrameStore(), execute: async () => ({ content: [] }),
    }), enableV8: true, enableExperimentalTasks: true,
    profile: 'full', activeProfile: 'v8-safe', principalId: 'manifest-owner',
    onRegistry: value => { registry = value },
    native: {
      getInputMonitorCapability: () => ({
        supported: true, backend: 'native-test', distinguishesInjected: true, recommendedPollMs: 20,
      }),
    },
  }))
  try {
    const listed = await client.listResources()
    assert.ok(listed.some(resource => resource.uri === 'computer://capabilities/manifest'))
    const resource = await client.readResource('computer://capabilities/manifest')
    const manifest = JSON.parse(resource.contents[0].text)
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.host.activeProfile, 'v8-safe')
    assert.equal(manifest.features.experimentalMcpTasks, true)
    assert.equal(manifest.features.supervisorFramesEnabled, true)
    assert.equal(manifest.inputMonitor.distinguishesInjected, true)
    assert.match(manifest.manifestDigest, /^sha256:[a-f0-9]{64}$/)
    registry.setActiveProfile('core')
    const changed = JSON.parse((await client.readResource('computer://capabilities/manifest')).contents[0].text)
    assert.equal(changed.host.activeProfile, 'core')
    assert.equal(changed.actuators.find(entry => entry.tool === 'left_click').exposed, true)
  } finally { await client.close() }
})
