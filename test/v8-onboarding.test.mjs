import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileOnboardingStore, OnboardingManager, configurationForOnboardingProfile,
} from '../dist/onboarding/manager.js'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'

function onboardingSession(calls = []) {
  return {
    async dispatch(tool, args) {
      calls.push({ tool, args })
      if (tool === 'doctor') {
        return { content: [{ type: 'text', text: '{}' }], structuredContent: {
          checks: [
            { id: 'display_capture', status: 'pass', summary: 'private-doctor-capture-detail' },
            { id: 'accessibility', status: 'warn', summary: 'private-doctor-accessibility-detail' },
            { id: 'automation', status: 'skip', summary: 'private-doctor-automation-detail' },
          ],
        } }
      }
      if (tool === 'screenshot') {
        return {
          content: [{ type: 'image', data: 'sensitive-screen-bytes', mimeType: 'image/png' }],
          structuredContent: { screenshot_hash: 'sha256:screen' },
        }
      }
      if (tool === 'agent_pointer') return { content: [{ type: 'text', text: 'pointer' }] }
      if (tool === 'get_ui_tree') {
        return { content: [{ type: 'text', text: '{}' }], structuredContent: {
          role: 'AXWindow', children: [{ role: 'AXButton', label: 'Sandbox' }],
        } }
      }
      return { content: [] }
    },
  }
}

test('guided onboarding persists only capability facts and produces a safe profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-onboarding-'))
  const calls = []
  try {
    const manager = new OnboardingManager(onboardingSession(calls), new FileOnboardingStore(directory))
    let state = await manager.start('owner')
    state = await manager.diagnose(state.onboardingId, 'owner')
    assert.equal(state.stage, 'diagnosed')
    assert.equal(state.checks.doctor.passed, true)
    assert.equal(state.checks.doctor.warningChecks, 1)
    assert.equal(state.checks.permissions.entries.find(item => item.id === 'display_capture').status, 'pass')
    assert.equal(state.checks.permissions.entries.find(item => item.id === 'accessibility').status, 'warn')
    assert.doesNotMatch(JSON.stringify(state.checks.permissions), /private-doctor/)
    state = await manager.testCapture(state.onboardingId, 'owner')
    state = await manager.testPointer(state.onboardingId, 'owner', [200, 120], true)
    state = await manager.testSemantic(state.onboardingId, 'owner', 42)
    await assert.rejects(
      manager.acknowledgeEmergencyStop(state.onboardingId, 'owner', true),
      /present the emergency-stop capability/,
    )
    state = await manager.acknowledgeEmergencyStop(state.onboardingId, 'owner', false)
    assert.equal(state.stage, 'semantic_tested')
    state = await manager.acknowledgeEmergencyStop(state.onboardingId, 'owner', true)
    assert.equal(state.stage, 'emergency_acknowledged')
    assert.equal(state.checks.emergency.physicalChordSupported, false)
    state = await manager.configure(state.onboardingId, 'owner', {
      filesystemRoots: ['/safe/work'], allowedAppIds: ['app.safe'],
      allowScrape: false, persistAudit: true,
    })
    assert.equal(state.stage, 'configured')
    assert.equal(state.profile.captureSupported, true)
    const configuration = configurationForOnboardingProfile(state.profile)
    assert.deepEqual(configuration, {
      restartRequired: true,
      environment: {
        COMPUTER_USE_V8: 'true', COMPUTER_USE_ACTIVE_PROFILE: 'v8-safe',
        COMPUTER_USE_V8_ALLOW_SCRAPE: 'false',
        COMPUTER_USE_AUDIT_LOG: 'true', COMPUTER_USE_FS_ROOTS: '/safe/work',
        COMPUTER_USE_ALLOWED_APPS: 'app.safe',
        COMPUTER_USE_EMERGENCY_STOP_CHORD: 'ctrl+alt+shift+escape',
      },
    })
    state = await manager.complete(state.onboardingId, 'owner')
    assert.equal(state.stage, 'completed')
    assert.ok(state.profile.completedAt)
    await assert.rejects(manager.get(state.onboardingId, 'attacker'), /another principal/)

    const persisted = await Promise.all(
      (await readdir(directory)).map(name => readFile(join(directory, name), 'utf8')),
    )
    assert.doesNotMatch(persisted.join('\n'), /sensitive-screen-bytes|AXButton|Sandbox|private-doctor/)
    assert.deepEqual(calls.filter(call => call.tool === 'agent_pointer').map(call => call.args.action), ['move', 'hide'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('file onboarding store uses cross-writer revision CAS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-onboarding-cas-'))
  try {
    const store = new FileOnboardingStore(directory)
    const manager = new OnboardingManager(onboardingSession(), store)
    const state = await manager.start('owner')
    const first = { ...state, revision: 2, updatedAt: '2026-07-13T00:00:01.000Z' }
    const second = { ...state, revision: 2, updatedAt: '2026-07-13T00:00:02.000Z' }
    const outcomes = await Promise.all([
      store.compareAndSet(first, state.revision),
      store.compareAndSet(second, state.revision),
    ])
    assert.deepEqual(outcomes.sort(), [false, true])
    assert.equal((await store.get(state.onboardingId)).revision, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('onboarding MCP surface binds ownership to the host principal', async () => {
  const session = onboardingSession()
  const owner = await connectInProcess(createComputerUseServer({
    session, enableV8: true, principalId: 'owner',
  }))
  const attacker = await connectInProcess(createComputerUseServer({
    session, enableV8: true, principalId: 'attacker',
  }))
  try {
    const started = await owner.onboarding('start')
    const id = started.structuredContent.onboarding.onboardingId
    const status = await owner.onboarding('status', { onboarding_id: id })
    assert.equal(status.structuredContent.onboarding.principalId, 'owner')
    // Separate server instances have separate memory stores, so no cross-host lookup exists.
    const denied = await attacker.onboarding('status', { onboarding_id: id })
    assert.equal(denied.isError, true)
  } finally {
    await owner.close()
    await attacker.close()
  }
})

test('onboarding MCP returns restart-explicit environment configuration after policy selection', async () => {
  const client = await connectInProcess(createComputerUseServer({
    session: onboardingSession(), enableV8: true, principalId: 'owner',
  }))
  try {
    const started = await client.onboarding('start')
    const id = started.structuredContent.onboarding.onboardingId
    await client.onboarding('acknowledge_emergency', { onboarding_id: id, acknowledged_by_user: false })
    await client.onboarding('acknowledge_emergency', { onboarding_id: id, acknowledged_by_user: true })
    const configured = await client.onboarding('configure', {
      onboarding_id: id, filesystem_roots: ['/workspace'], allowed_app_ids: ['app.safe'],
      allow_scrape: false, persist_audit: true,
    })
    assert.equal(configured.structuredContent.configuration.restartRequired, true)
    assert.equal(configured.structuredContent.configuration.environment.COMPUTER_USE_ACTIVE_PROFILE, 'v8-safe')
    assert.equal(configured.structuredContent.configuration.environment.COMPUTER_USE_FS_ROOTS, '/workspace')
    assert.equal(configured.structuredContent.configuration.environment.COMPUTER_USE_V8_ALLOW_SCRAPE, 'false')
    assert.equal(configured.structuredContent.configuration.environment.COMPUTER_USE_EMERGENCY_STOP_CHORD, 'ctrl+alt+shift+escape')
  } finally {
    await client.close()
  }
})
