// 7.7.0: the Windows fixes from the 2026-10-25 live check (docs/specs/v7.7/windows-fixes). Fake native, fake spawn;
// every check runs on any platform. macOS and Linux results are pinned as unchanged.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WindowsCardPresenter, statusCardEnabled } from '../dist/session/operator-control.js'
import { runDoctor } from '../dist/session/doctor.js'
import { handleAdminTool, plainPowerShellError } from '../dist/session/admin-handlers.js'
import { handleAccessibilityTool } from '../dist/session/accessibility-handlers.js'
import { TargetStateController } from '../dist/session/target-state.js'
import { GetActiveSpaceOutput, PRIORITY_OUTPUT_SCHEMAS, outputSchemaFor } from '../dist/output-schemas.js'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'

// A CLIXML error block as PowerShell 7 wrote it for `registry set` on a missing key (captured 2026-10-25).
const CLIXML = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">_x001B_[31;1mNew-ItemProperty: _x001B_[31;1mCannot find path \'HKCU:\\Software\\CuMcpLiveTest277005\' because it does not exist._x001B_[0m_x000D__x000A_</S></Objs>'

const decodeScript = args => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')

// ── R1 / D1: the status card ───────────────────────────────────────────────

test('R1: the card is on by default on Windows, off inside node --test unless asked for; macOS and Linux unchanged', () => {
  assert.equal(statusCardEnabled({}, 'win32'), true)
  assert.equal(statusCardEnabled({ NODE_TEST_CONTEXT: 'child-v8' }, 'win32'), false)
  assert.equal(statusCardEnabled({ NODE_TEST_CONTEXT: 'child-v8', COMPUTER_USE_STATUS_CARD: 'true' }, 'win32'), true)
  assert.equal(statusCardEnabled({ COMPUTER_USE_STATUS_CARD: 'false' }, 'win32'), false)
  assert.equal(statusCardEnabled({ COMPUTER_USE_STATUS_CARD: '0' }, 'win32'), false)
  assert.equal(statusCardEnabled({}, 'darwin'), true)
  assert.equal(statusCardEnabled({ NODE_TEST_CONTEXT: 'child-v8' }, 'darwin'), true)
  assert.equal(statusCardEnabled({}, 'linux'), false)
  assert.equal(statusCardEnabled({ NODE_TEST_CONTEXT: 'child-v8' }, 'linux'), false)
})

const node = code => () => ({ file: process.execPath, args: ['-e', code] })

test('R1: the Windows card counts as launched only once its window reports in', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'win-card-'))
  const presenter = new WindowsCardPresenter({
    command: node(`require('fs').writeFileSync(${JSON.stringify(join(directory, 'windows-card.json'))}, '{}'); setTimeout(() => {}, 10000)`),
    startMs: 10_000,
  })
  try {
    await presenter.start(directory)
  } finally {
    presenter.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('R1: a card process that exits first, never starts, or never shows is reported, not counted as launched', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'win-card-'))
  try {
    await assert.rejects(new WindowsCardPresenter({ command: node('process.exit(3)') }).start(directory),
      /exited with code 3 before the card appeared/)
    await assert.rejects(new WindowsCardPresenter({ command: () => ({ file: 'no-such-card-host-7-7-1', args: [] }) }).start(directory),
      /could not be started.*powershell\.exe on PATH/)
    const slow = new WindowsCardPresenter({ command: node('setTimeout(() => {}, 10000)'), startMs: 200 })
    await assert.rejects(slow.start(directory), /did not appear within 0\.2 s/)
    slow.stop()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

function doctorOptions(platform, card) {
  return {
    native: {
      getDisplaySize: () => ({ width: 1920, height: 1080 }),
      takeScreenshot: () => ({ base64: 'image', width: 320, height: 180, mimeType: 'image/jpeg' }),
      readClipboard: () => '', writeClipboard: () => {},
      getFrontmostApp: () => ({ bundleId: 'notepad.exe' }), listWindows: () => [],
      agentPointerOverlayStatus: () => ({ visible: false }),
    },
    includeRemediation: false, platform, arch: 'x64', nodeVersion: 'v22.0.0', now: () => 1,
    spawnBounded: async () => ({ stdout: '7.5', stderr: '', code: 0, timedOut: false }),
    runScript: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }),
    getPowerShellExe: () => 'pwsh',
    policyConfig: {
      allowedApps: [], blockedApps: [], sensitiveApps: [], requireApprovalFor: [],
      approvalRequiredForAll: false, destructiveRequiresApproval: false, approvalTokenConfigured: false,
    },
    policyStatus: () => ({ profile: 'full' }), auditEnabled: false, auditLogPath: '',
    controlStatus: () => ({ state: 'running', card }),
  }
}

test('R1: doctor says how the Windows card was turned off; the macOS wording is unchanged', async () => {
  const off = { enabled: false, presenter: 'none', launched: false, error: null }
  const windows = (await runDoctor(doctorOptions('win32', off))).checks.find(check => check.id === 'status_card')
  assert.equal(windows.status, 'skip')
  assert.match(windows.summary, /COMPUTER_USE_STATUS_CARD=false; unset it/)
  const macos = (await runDoctor(doctorOptions('darwin', off))).checks.find(check => check.id === 'status_card')
  assert.equal(macos.summary, 'Desktop status card off (set COMPUTER_USE_STATUS_CARD=true to show the person what the agent does, with Pause and Stop).')
  const failed = { enabled: true, presenter: 'windows', launched: false, error: 'powershell.exe exited with code 1 before the card appeared (no interactive desktop?).' }
  const warned = (await runDoctor(doctorOptions('win32', failed))).checks.find(check => check.id === 'status_card')
  assert.equal(warned.status, 'warn')
  assert.match(warned.summary, /could not start: powershell\.exe exited/)
})

// ── R3 / D3 and R4 / D4: notification and registry ─────────────────────────

const adminContext = (spawnBounded) => ({ platform: 'win32', spawnBounded, getPowerShellExe: () => 'pwsh' })

test('R3: notification runs Windows PowerShell 5.1 even when PowerShell 7 is the server\'s PowerShell', async () => {
  let call
  const result = await handleAdminTool('notification', { title: 'T', message: 'M & <b>' }, adminContext(async (...args) => {
    call = args
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  }))
  assert.equal(result.isError, undefined)
  assert.equal(call[0], 'powershell.exe')
  const script = decodeScript(call[1])
  assert.match(script, /ContentType = WindowsRuntime/)
  assert.match(script, /M &amp; &lt;b&gt;/)
  assert.match(script, /\$ErrorActionPreference = 'Stop'[\s\S]*catch[\s\S]*\[Console\]::Error\.WriteLine/)
  assert.match(result.content[0].text, /^Notification sent .*Focus Assist/)
})

test('R3: a failed notification is one readable line', async () => {
  const result = await handleAdminTool('notification', { title: 'T', message: 'M' }, adminContext(async () =>
    ({ stdout: '', stderr: 'Error: spawn powershell.exe ENOENT', code: -1, timedOut: false })))
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text, 'notification failed (powershell.exe): Error: spawn powershell.exe ENOENT')
})

test('R4: registry set creates a missing key before setting the value', async () => {
  let call
  const result = await handleAdminTool('registry', { mode: 'set', path: "HKCU:\\Software\\It's New", name: 'Answer', value: '42', type: 'DWord' },
    adminContext(async (...args) => { call = args; return { stdout: '', stderr: '', code: 0, timedOut: false } }))
  assert.equal(result.content[0].text, "Set HKCU:\\Software\\It's New\\Answer")
  assert.equal(call[0], 'pwsh', 'registry keeps the server\'s PowerShell')
  const script = decodeScript(call[1])
  assert.match(script, /\$key = 'HKCU:\\Software\\It''s New'/)
  assert.match(script, /if \(-not \(Test-Path -LiteralPath \$key\)\) \{ New-Item -Path \$key -Force \| Out-Null \}/)
  assert.match(script, /New-ItemProperty -LiteralPath \$key -Name 'Answer' -Value '42' -PropertyType DWord -Force/)
})

test('R4: registry errors name the mode and path, in plain text', async () => {
  const result = await handleAdminTool('registry', { mode: 'get', path: 'HKCU:\\Software\\Missing', name: 'x' },
    adminContext(async () => ({ stdout: '', stderr: CLIXML, code: 1, timedOut: false })))
  assert.equal(result.isError, true)
  assert.equal(result.content[0].text,
    "registry get HKCU:\\Software\\Missing failed: New-ItemProperty: Cannot find path 'HKCU:\\Software\\CuMcpLiveTest277005' because it does not exist.")
  const timedOut = await handleAdminTool('registry', { mode: 'list', path: 'HKLM:\\SOFTWARE' },
    adminContext(async () => ({ stdout: '', stderr: '', code: -1, timedOut: true })))
  assert.equal(timedOut.content[0].text, 'registry list HKLM:\\SOFTWARE failed: timed out after 10 s')
})

test('R4: plainPowerShellError decodes CLIXML, strips colour, and leaves plain text alone', () => {
  assert.equal(plainPowerShellError(CLIXML), "New-ItemProperty: Cannot find path 'HKCU:\\Software\\CuMcpLiveTest277005' because it does not exist.")
  assert.equal(plainPowerShellError('Requested registry access is not allowed.\r\n'), 'Requested registry access is not allowed.')
  assert.equal(plainPowerShellError(`${String.fromCharCode(27)}[31;1mBoom${String.fromCharCode(27)}[0m`), 'Boom')
  assert.equal(plainPowerShellError('#< CLIXML\r\n<Objs><S S="Error">a &amp; b &lt;c&gt;_x000D__x000A_</S><S S="Error">second_x000D__x000A_</S></Objs>'), 'a & b <c>\nsecond')
})

// ── R5 / D5: get_active_space ──────────────────────────────────────────────

test('R5: only Windows gets the string schema for get_active_space; every other schema is the same object as before', () => {
  for (const platform of ['darwin', 'linux']) {
    for (const [name, schema] of Object.entries(PRIORITY_OUTPUT_SCHEMAS)) assert.equal(outputSchemaFor(name, platform), schema, `${platform} ${name}`)
  }
  for (const [name, schema] of Object.entries(PRIORITY_OUTPUT_SCHEMAS)) {
    if (name !== 'get_active_space') assert.equal(outputSchemaFor(name, 'win32'), schema, name)
  }
  assert.notEqual(outputSchemaFor('get_active_space', 'win32'), GetActiveSpaceOutput)
  assert.equal(outputSchemaFor('get_active_space', 'win32').safeParse({ active_space_id: '{EC309B65-E497-458E-BA37-A9257D403D85}' }).success, true)
  assert.equal(outputSchemaFor('get_active_space', 'win32').safeParse({ active_space_id: null }).success, true)
  assert.equal(GetActiveSpaceOutput.safeParse({ active_space_id: 3 }).success, true)
})

test('R5: a Windows server returns the desktop GUID from get_active_space without a schema error', async () => {
  const guid = '{EC309B65-E497-458E-BA37-A9257D403D85}'
  const native = {
    getFrontmostApp: () => ({ bundleId: 'explorer.exe', displayName: 'Explorer', pid: 1 }),
    listRunningApps: () => [], listWindows: () => [], getWindow: () => null, drainRunloop: () => {},
    getActiveSpace: () => guid,
  }
  const client = await connectInProcess(createComputerUseServer({ native, platform: 'win32', profile: 'full' }))
  try {
    const result = await client.callTool('get_active_space', {})
    assert.equal(result.isError, undefined, result.content?.[0]?.text)
    assert.deepEqual(result.structuredContent, { active_space_id: guid })
  } finally {
    await client.close()
  }
})

// ── R6 / D6: roles ─────────────────────────────────────────────────────────

const ROLES = ['AXButton', 'AXTextField', 'AXTextArea', 'AXGroup', 'AXRadioButton', 'AXWebArea', 'AXUnknown']

function accessibility(platform, overrides = {}) {
  const calls = []
  const service = {
    getWindow: id => id === 42 ? { windowId: 42, bundleId: 'app.fixture', isOnScreen: true } : null,
    getFrontmostApp: () => ({ bundleId: 'app.fixture' }),
    findElement: (...args) => { calls.push(['findElement', ...args]); return [] },
    performAction: (...args) => { calls.push(['performAction', ...args]); return { performed: true } },
    setElementValue: (...args) => { calls.push(['setElementValue', ...args]); return { set: true } },
    uiaRoles: () => ROLES,
    ...overrides,
  }
  const focused = []
  return {
    calls, focused,
    context: {
      native: service, platform,
      targets: new TargetStateController(service, () => 1),
      focus: { strategyFor: () => 'strict', ensure: async () => { focused.push(true); return {} }, beginDispatch() {}, hiddenBundleIds() {} },
      activeProfile: 'full', sleep: async () => {},
    },
  }
}

test('R6: on Windows an unknown role is refused with the valid roles and the closest ones', async () => {
  const { context, calls } = accessibility('win32')
  const result = await handleAccessibilityTool('find_element', { window_id: 42, role: 'AXButon', label: 'OK' }, context)
  assert.equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  assert.equal(body.error, 'unknown_role')
  assert.equal(body.role, 'AXButon')
  assert.deepEqual(body.valid_roles, ROLES)
  assert.equal(body.similar_roles[0], 'AXButton')
  assert.equal(calls.length, 0, 'the native search is not run')
})

test('R6: click_element and set_value refuse an unknown role before taking focus; fill_form reports it per field', async () => {
  for (const tool of ['click_element', 'set_value']) {
    const { context, calls, focused } = accessibility('win32')
    const result = await handleAccessibilityTool(tool, { window_id: 42, role: 'AXPane', label: 'x', value: 'v' }, context)
    assert.equal(JSON.parse(result.content[0].text).error, 'unknown_role', tool)
    assert.equal(focused.length, 0, `${tool} did not focus`)
    assert.equal(calls.length, 0, `${tool} did not reach native`)
  }
  const { context, calls } = accessibility('win32')
  const result = await handleAccessibilityTool('fill_form', { window_id: 42, fields: [
    { role: 'AXTextField', label: 'Name', value: 'Ada' },
    { role: 'AXEdit', label: 'Email', value: 'a@b' },
  ] }, context)
  assert.deepEqual(JSON.parse(result.content[0].text), {
    succeeded: 1, failed: 1, failures: [{ role: 'AXEdit', label: 'Email', reason: 'unknown_role' }],
  })
  assert.deepEqual(calls.map(call => call[0]), ['setElementValue'])
})

test('R6: known Windows roles, label-only searches and every macOS role go straight to the native search', async () => {
  const windows = accessibility('win32')
  for (const role of ['AXGroup', 'AXRadioButton', 'AXUnknown', 'AXTextArea']) {
    const result = await handleAccessibilityTool('find_element', { window_id: 42, role }, windows.context)
    assert.equal(result.isError, undefined, role)
  }
  await handleAccessibilityTool('find_element', { window_id: 42, label: 'OK' }, windows.context)
  assert.equal(windows.calls.length, 5)
  const macos = accessibility('darwin')
  const result = await handleAccessibilityTool('find_element', { window_id: 42, role: 'AXSplitGroup' }, macos.context)
  assert.equal(result.isError, undefined)
  assert.deepEqual(macos.calls[0].slice(0, 3), ['findElement', 42, 'AXSplitGroup'])
})
