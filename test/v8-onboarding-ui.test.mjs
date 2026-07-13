import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { runTerminalOnboarding } from '../dist/onboarding/terminal.js'
import { createSetupViewModel } from '../dist/onboarding/view-model.js'
import { createNativePermissionHost, DesktopSetupController } from '../dist/onboarding/desktop.js'
import { registerElectronSetupIpc, electronSetupPreload } from '../examples/v8-electron-setup.mjs'
import { createTauriSetupTransport } from '../examples/v8-tauri-setup.mjs'
import { renderSetupHtml } from '../examples/v8-setup-ui.mjs'

const ajv = new Ajv2020({ strict: false })
const setupCommandValidator = ajv.compile(JSON.parse(await readFile(
  new URL('../contracts/v8/setup-command.schema.json', import.meta.url), 'utf8',
)))
const setupViewValidator = ajv.compile(JSON.parse(await readFile(
  new URL('../contracts/v8/setup-view-model.schema.json', import.meta.url), 'utf8',
)))

function session(calls) {
  return {
    async dispatch(tool, args) {
      calls.push({ tool, args })
      if (tool === 'doctor') return { content: [], structuredContent: { checks: [{ status: 'pass' }] } }
      if (tool === 'screenshot') return { content: [{ type: 'image', data: 'private-pixels', mimeType: 'image/png' }] }
      if (tool === 'get_ui_tree') return { content: [], structuredContent: { role: 'window', secretLabel: 'private-ui' } }
      return { content: [] }
    },
  }
}

const silentIo = writes => ({
  write: message => { writes.push(message) },
  prompt: async () => { throw new Error('non-interactive flow must not prompt') },
  confirm: async () => { throw new Error('non-interactive flow must not confirm') },
})

test('terminal reference completes setup without persisting observations or changing host configuration', async () => {
  const calls = []
  const writes = []
  const client = await connectInProcess(createComputerUseServer({
    session: session(calls), enableV8: true, principalId: 'setup-owner',
  }))
  try {
    const completed = await runTerminalOnboarding(client, silentIo(writes), {
      nonInteractive: true,
      pointerConfirmed: true,
      emergencyStopAcknowledged: true,
      windowId: 42,
      filesystemRoots: ['/safe/work'],
      allowedAppIds: ['app.safe'],
      allowScrape: false,
      persistAudit: true,
    })
    assert.equal(completed.state.stage, 'completed')
    assert.equal(completed.configuration.restartRequired, true)
    assert.deepEqual(calls.map(call => call.tool), [
      'doctor', 'screenshot', 'agent_pointer', 'agent_pointer', 'get_ui_tree',
    ])
    assert.deepEqual(calls.filter(call => call.tool === 'agent_pointer').map(call => call.args.action), ['move', 'hide'])
    assert.ok(writes.some(line => line.includes('COMPUTER_USE_ACTIVE_PROFILE="v8-safe"')))
    assert.ok(writes.some(line => line.includes('Emergency stop:')))
    assert.ok(writes.some(line => line.includes('COMPUTER_USE_EMERGENCY_STOP_CHORD=')))
    assert.doesNotMatch(writes.join('\n'), /private-pixels|private-ui/)

    const resumedWrites = []
    const resumed = await runTerminalOnboarding(client, silentIo(resumedWrites), {
      onboardingId: completed.state.onboardingId,
      nonInteractive: true,
    })
    assert.equal(resumed.state.stage, 'completed')
    assert.equal(calls.length, 5)
  } finally { await client.close() }
})

test('pointer setup separates presentation from user confirmation', async () => {
  const calls = []
  const client = await connectInProcess(createComputerUseServer({
    session: session(calls), enableV8: true, principalId: 'setup-owner',
  }))
  try {
    const id = (await client.onboarding('start')).structuredContent.onboarding.onboardingId
    const shown = await client.onboarding('show_pointer', { onboarding_id: id, coordinate: [50, 60] })
    assert.equal(shown.structuredContent.onboarding.checks.pointer.shown, true)
    assert.equal(shown.structuredContent.onboarding.checks.pointer.tested, false)
    const confirmed = await client.onboarding('confirm_pointer', {
      onboarding_id: id, confirmed_by_user: false,
    })
    assert.equal(confirmed.structuredContent.onboarding.checks.pointer.tested, true)
    assert.equal(confirmed.structuredContent.onboarding.checks.pointer.passed, false)
    assert.deepEqual(calls.map(call => call.args.action), ['move', 'hide'])
  } finally { await client.close() }
})

test('shared setup view model is disclosure-safe for sandboxed desktop renderers', () => {
  const state = {
    onboardingId: 'setup-1', principalId: 'private-principal', stage: 'configured', revision: 7,
    createdAt: '2026-07-13T00:00:00Z', updatedAt: '2026-07-13T00:00:01Z',
    checks: {
      doctor: { passed: true, failedChecks: 0, warningChecks: 1 },
      capture: { tested: true, passed: true, mimeType: 'image/png' },
      pointer: { shown: true, tested: true, passed: true, confirmedByUser: true },
      semantic: { tested: true, passed: true, windowId: 999 },
      emergency: {
        presented: true, acknowledgedByUser: true, chord: 'ctrl+alt+shift+escape',
        backend: 'macos_hid_event_tap', physicalChordSupported: true, physicalOnly: true,
      },
      permissions: { inspected: true, entries: [{
        id: 'accessibility', status: 'fail', label: 'private-label', required: false,
        canRequestInProcess: false, remediation: 'private-remediation-secret',
        settingsUri: 'https://attacker.invalid/private',
      }] },
    },
    profile: {
      filesystemRoots: ['/private/customer/path'], allowedAppIds: ['private.app'],
      allowScrape: false, persistAudit: true, captureSupported: true,
      semanticSupported: true, virtualPointerSupported: true, platform: 'darwin',
      emergencyStopChord: 'ctrl+alt+shift+escape', physicalEmergencyStopSupported: true,
    },
  }
  const view = createSetupViewModel(state, {
    restartRequired: true,
    environment: { COMPUTER_USE_FS_ROOTS: '/private/customer/path', COMPUTER_USE_ACTIVE_PROFILE: 'v8-safe' },
  })
  assert.equal(view.policy.filesystemRootCount, 1)
  assert.equal(setupViewValidator(view), true, JSON.stringify(setupViewValidator.errors))
  assert.deepEqual(view.environmentKeys, ['COMPUTER_USE_ACTIVE_PROFILE', 'COMPUTER_USE_FS_ROOTS'])
  assert.doesNotMatch(JSON.stringify(view), /private-principal|private\/customer|private\.app|private-label|private-remediation|attacker|999/)
  assert.equal(view.permissions.find(item => item.id === 'accessibility').status, 'fail')
  assert.match(view.permissions.find(item => item.id === 'accessibility').remediation, /System Settings/)
})

test('versioned setup contracts accept the emergency presentation and acknowledgment wire shape', () => {
  for (const command of [
    { action: 'start' },
    { action: 'acknowledge_emergency', onboardingId: 'setup-1', confirmed: false },
    { action: 'acknowledge_emergency', onboardingId: 'setup-1', confirmed: true },
    { action: 'request_permission', onboardingId: 'setup-1', permissionId: 'accessibility' },
    { action: 'open_permission_settings', onboardingId: 'setup-1', permissionId: 'accessibility' },
    {
      action: 'configure', onboardingId: 'setup-1', filesystemRoots: ['/safe'],
      allowedAppIds: ['app.safe'], allowScrape: false, persistAudit: true,
    },
  ]) assert.equal(setupCommandValidator(command), true, JSON.stringify(setupCommandValidator.errors))
})

test('desktop controller keeps configuration host-only and Electron exposes dispatch only', async () => {
  const calls = []
  const client = await connectInProcess(createComputerUseServer({
    session: session(calls), enableV8: true, principalId: 'desktop-owner',
  }))
  try {
    const openedSettings = []
    const requestedPermissions = []
    const controller = new DesktopSetupController(client, {
      openPermissionSettings: uri => { openedSettings.push(uri) },
      canRequestPermission: permission => permission === 'accessibility',
      requestPermission: permission => {
        requestedPermissions.push(permission)
        return {
          permission, supported: true, canPrompt: true, granted: false,
          promptRequested: true, backend: 'private-native-backend', restartMayBeRequired: true,
          reason: 'private-native-reason',
        }
      },
    })
    const handlers = new Map()
    const ipcMain = {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: channel => handlers.delete(channel),
    }
    const unregister = registerElectronSetupIpc(ipcMain, controller)
    const renderer = electronSetupPreload({
      invoke: (channel, command) => handlers.get(channel)({}, command),
    })
    assert.deepEqual(Object.keys(renderer), ['dispatch'])
    const toolNames = new Set((await client.listTools()).map(tool => tool.name))
    assert.equal(toolNames.has('request_permission'), false)
    assert.equal(toolNames.has('open_permission_settings'), false)
    assert.equal([...toolNames].some(name => /native.*permission|permission.*request/.test(name)), false)
    let view = await renderer.dispatch({ action: 'start' })
    const id = view.onboardingId
    if (process.platform === 'darwin') {
      assert.equal(view.permissions.find(item => item.id === 'accessibility').canRequestInProcess, true)
      assert.equal(view.permissions.find(item => item.id === 'accessibility').canOpenSettings, true)
      view = await renderer.dispatch({ action: 'request_permission', onboardingId: id, permissionId: 'accessibility' })
      assert.deepEqual(requestedPermissions, ['accessibility'])
      assert.doesNotMatch(JSON.stringify(view), /private-native/)
      await renderer.dispatch({ action: 'open_permission_settings', onboardingId: id, permissionId: 'accessibility' })
      assert.deepEqual(openedSettings, [
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      ])
    } else {
      assert.equal(view.permissions.every(item => !item.canOpenSettings), true)
      await assert.rejects(
        () => renderer.dispatch({ action: 'open_permission_settings', onboardingId: id, permissionId: 'accessibility' }),
        /allowlisted settings URI/,
      )
    }
    await assert.rejects(
      () => renderer.dispatch({ action: 'request_permission', onboardingId: id, permissionId: 'https://attacker.invalid' }),
      /permissionId is not requestable/,
    )
    await assert.rejects(
      () => renderer.dispatch({ action: 'open_permission_settings', onboardingId: id, permissionId: 'https://attacker.invalid' }),
      /permissionId is not requestable/,
    )
    view = await renderer.dispatch({ action: 'acknowledge_emergency', onboardingId: id, confirmed: false })
    assert.equal(view.emergencyStop.acknowledged, false)
    view = await renderer.dispatch({ action: 'acknowledge_emergency', onboardingId: id, confirmed: true })
    assert.equal(view.emergencyStop.acknowledged, true)
    view = await renderer.dispatch({
      action: 'configure', onboardingId: id,
      filesystemRoots: ['/private/desktop'], allowedAppIds: ['private.desktop.app'],
      allowScrape: false, persistAudit: true,
    })
    assert.equal(view.policy.filesystemRootCount, 1)
    assert.doesNotMatch(JSON.stringify(view), /private\/desktop|private\.desktop/)
    assert.equal(controller.configuration().environment.COMPUTER_USE_FS_ROOTS, '/private/desktop')
    unregister()
    assert.equal(handlers.size, 0)
    await assert.rejects(() => controller.dispatch({ action: 'evaluate_javascript', onboardingId: id }), /unsupported setup action/)
  } finally { await client.close() }
})

test('native permission host exposes only audited prompt capabilities and validates native results', () => {
  const requested = []
  const host = createNativePermissionHost({
    getNativePermissionStatus: permission => ({
      permission, supported: permission === 'accessibility', canPrompt: permission === 'accessibility',
      granted: false, promptRequested: false, backend: 'macos_tcc', restartMayBeRequired: true,
    }),
    requestNativePermission: permission => {
      requested.push(permission)
      return {
        permission, supported: true, canPrompt: true, granted: false, promptRequested: true,
        backend: 'macos_tcc', restartMayBeRequired: true,
      }
    },
  })
  assert.equal(host.canRequestPermission('accessibility'), true)
  assert.equal(host.canRequestPermission('display_capture'), false)
  assert.equal(host.requestPermission('accessibility').promptRequested, true)
  assert.deepEqual(requested, ['accessibility'])
  assert.throws(() => host.requestPermission('display_capture'), /unavailable/)

  const unsupported = createNativePermissionHost({
    getNativePermissionStatus: permission => ({
      permission, supported: false, canPrompt: false, granted: false, promptRequested: false,
      backend: 'unsupported', restartMayBeRequired: false,
    }),
    requestNativePermission: () => { throw new Error('must not run') },
  })
  assert.deepEqual(unsupported, {})

  const invalid = createNativePermissionHost({
    getNativePermissionStatus: permission => ({
      permission, supported: true, canPrompt: true, granted: false, promptRequested: false,
      backend: 'macos_tcc', restartMayBeRequired: true,
    }),
    requestNativePermission: permission => ({
      permission, supported: true, canPrompt: true, granted: false, promptRequested: false,
      backend: 'macos_tcc', restartMayBeRequired: true,
    }),
  })
  assert.throws(() => invalid.requestPermission('accessibility'), /invalid or unsupported/)

  assert.deepEqual(createNativePermissionHost({
    getNativePermissionStatus: () => { throw new Error('native probe failed') },
    requestNativePermission: () => { throw new Error('must not run') },
  }), {})
})

test('Tauri transport uses the same bounded command envelope', async () => {
  const invocations = []
  const transport = createTauriSetupTransport(async (name, payload) => {
    invocations.push({ name, payload })
    return { onboardingId: 'setup-1', stage: 'created' }
  })
  const view = await transport.dispatch({ action: 'status', onboardingId: 'setup-1' })
  assert.equal(view.stage, 'created')
  assert.deepEqual(invocations, [{
    name: 'computer_use_setup',
    payload: { command: { action: 'status', onboardingId: 'setup-1' } },
  }])
})

test('shared Electron/Tauri setup UI escapes every projected string', () => {
  const html = renderSetupHtml({
    onboardingId: 'id"><script>attack()</script>', stage: '<img src=x>', revision: 1,
    progress: 25, nextAction: 'diagnose', capabilities: {}, policy: undefined,
    restartRequired: false, environmentKeys: [],
    steps: [{ id: 'diagnostics', status: 'failed', detail: '<script>private()</script>' }],
  })
  assert.doesNotMatch(html, /<script>|<img/)
  assert.match(html, /&lt;script&gt;attack\(\)&lt;\/script&gt;/)
  assert.match(html, /&lt;script&gt;private\(\)&lt;\/script&gt;/)
})
