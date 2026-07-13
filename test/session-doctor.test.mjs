import assert from 'node:assert/strict'
import test from 'node:test'
import { runDoctor } from '../dist/session/doctor.js'

function native(overrides = {}) {
  let clipboard = 'saved'
  return {
    getDisplaySize: () => ({ width: 1920, height: 1080 }),
    takeScreenshot: () => ({ base64: 'image', width: 320, height: 180, mimeType: 'image/jpeg' }),
    readClipboard: () => clipboard,
    writeClipboard: value => { clipboard = value },
    getFrontmostApp: () => ({ bundleId: 'notepad.exe' }),
    listWindows: () => [],
    agentPointerOverlayStatus: () => ({ visible: false }),
    ...overrides,
  }
}

function options(overrides = {}) {
  return {
    native: native(),
    includeRemediation: false,
    platform: 'win32', arch: 'x64', nodeVersion: 'v25.0.0', now: () => 1,
    spawnBounded: async () => ({ stdout: '7.5', stderr: '', code: 0, timedOut: false }),
    runScript: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }),
    getPowerShellExe: () => 'pwsh',
    policyConfig: {
      allowedApps: [], blockedApps: [], sensitiveApps: [], requireApprovalFor: [],
      approvalRequiredForAll: false, destructiveRequiresApproval: false,
      approvalTokenConfigured: false,
    },
    policyStatus: () => ({ profile: 'full' }),
    auditEnabled: true,
    auditLogPath: 'C:\\audit.jsonl',
    ...overrides,
  }
}

test('extracted doctor runs deterministic Windows diagnostics with injected services', async () => {
  const result = await runDoctor(options())
  assert.equal(result.ok, true)
  assert.deepEqual(result.platform, { os: 'win32', arch: 'x64', node: 'v25.0.0' })
  assert.equal(result.checks.find(check => check.id === 'powershell').status, 'pass')
  assert.equal(result.checks.find(check => check.id === 'clipboard').status, 'pass')
  assert.equal(result.checks.every(check => !('remediation' in check)), true)
})

test('extracted doctor reports native capture failure without aborting later diagnostics', async () => {
  const result = await runDoctor(options({
    native: native({ takeScreenshot: () => { throw new Error('capture denied') } }),
    includeRemediation: true,
  }))
  assert.equal(result.ok, false)
  const capture = result.checks.find(check => check.id === 'display_capture')
  assert.equal(capture.status, 'fail')
  assert.equal(capture.summary, 'capture denied')
  assert.ok(capture.remediation.length > 0)
  assert.ok(result.checks.some(check => check.id === 'policy'))
})
