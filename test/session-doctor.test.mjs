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

// ── macOS: permission facts come from TCC, not from calls that need no grant ──

function fakeClipboardExec() {
  let clip = Buffer.from('saved')
  return (file, _args, opts) => {
    if (file === 'pbcopy') { clip = Buffer.from(opts?.input ?? ''); return Buffer.alloc(0) }
    if (file === 'pbpaste') return clip
    throw new Error(`unexpected exec ${file}`)
  }
}

function macosOptions({ accessibility, displayCapture, nativeOverrides = {} } = {}) {
  const permissions = { accessibility, display_capture: displayCapture }
  return options({
    platform: 'darwin', arch: 'arm64',
    includeRemediation: true,
    execFileSync: fakeClipboardExec(),
    native: native({
      getFrontmostApp: () => ({ bundleId: 'co.zeit.hyper' }),
      getNativePermissionStatus: permission => ({
        permission, supported: true, canPrompt: true, granted: permissions[permission] === true,
        promptRequested: false, backend: 'macos_tcc', restartMayBeRequired: true, reason: null,
      }),
      ...nativeOverrides,
    }),
  })
}

test('macOS doctor fails accessibility when TCC denies it even though a frontmost app is visible', async () => {
  const result = await runDoctor(macosOptions({ accessibility: false, displayCapture: true }))
  assert.equal(result.ok, false)
  const ax = result.checks.find(check => check.id === 'accessibility')
  assert.equal(ax.status, 'fail')
  assert.match(ax.summary, /Accessibility is not granted/)
  assert.match(ax.summary, /co\.zeit\.hyper/)
  assert.equal(ax.details.accessibilityGranted, false)
  assert.ok(ax.remediation.some(line => /Privacy & Security > Accessibility/.test(line)))
  assert.equal(result.checks.find(check => check.id === 'display_capture').status, 'pass')
})

test('macOS doctor fails display capture when TCC denies Screen Recording even if an image came back', async () => {
  const result = await runDoctor(macosOptions({ accessibility: true, displayCapture: false }))
  assert.equal(result.ok, false)
  const capture = result.checks.find(check => check.id === 'display_capture')
  assert.equal(capture.status, 'fail')
  assert.match(capture.summary, /Screen Recording is not granted/)
  assert.equal(capture.details.screenRecordingGranted, false)
  assert.equal(result.checks.find(check => check.id === 'accessibility').status, 'pass')
})

test('macOS doctor passes both checks when TCC grants them', async () => {
  const result = await runDoctor(macosOptions({ accessibility: true, displayCapture: true }))
  assert.equal(result.ok, true)
  const ax = result.checks.find(check => check.id === 'accessibility')
  assert.equal(ax.status, 'pass')
  assert.equal(ax.details.accessibilityGranted, true)
  assert.equal(result.checks.find(check => check.id === 'display_capture').details.screenRecordingGranted, true)
})

test('macOS doctor falls back to behavioural checks with a native binary that predates permission probes', async () => {
  const result = await runDoctor(macosOptions({ nativeOverrides: { getNativePermissionStatus: undefined } }))
  assert.equal(result.ok, true)
  const ax = result.checks.find(check => check.id === 'accessibility')
  assert.equal(ax.status, 'pass')
  assert.equal('accessibilityGranted' in ax.details, false)
  assert.equal('screenRecordingGranted' in result.checks.find(check => check.id === 'display_capture').details, false)
})

test('macOS doctor ignores a permission probe that throws', async () => {
  const result = await runDoctor(macosOptions({
    nativeOverrides: { getNativePermissionStatus: () => { throw new Error('probe exploded') } },
  }))
  assert.equal(result.checks.find(check => check.id === 'accessibility').status, 'pass')
  assert.equal(result.checks.find(check => check.id === 'display_capture').status, 'pass')
})

test('Windows doctor never consults the macOS-only permission probe', async () => {
  const result = await runDoctor(options({
    native: native({
      getNativePermissionStatus: () => ({ supported: false, granted: false }),
    }),
  }))
  assert.equal(result.ok, true)
  assert.equal(result.checks.find(check => check.id === 'ui_automation').status, 'pass')
})
