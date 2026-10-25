import assert from 'node:assert/strict'
import test from 'node:test'
import { handleWindowTool, LAUNCH_WAIT_MS } from '../dist/session/window-handlers.js'
import { linuxApplicationDirs } from '../dist/session/application-discovery.js'
import { TargetStateController } from '../dist/session/target-state.js'

// 7.7.x: open_application on Linux starts an app that is not running from its desktop entry.

function setup({ launch, windowAfterMs = Infinity, processAfterMs = Infinity }) {
  let clock = 0
  const calls = []
  const service = {
    activateApp: (name) => {
      calls.push(['activateApp', name])
      return clock >= windowAfterMs && name === 'firefox' ? { activated: true } : { activated: false, reason: 'not_running' }
    },
    launchApp: (name) => { calls.push(['launchApp', name]); return launch },
    linuxProcessRunning: (name) => name === 'firefox' && clock >= processAfterMs,
    listRunningApps: () => [],
    getFrontmostApp: () => null,
  }
  const targets = new TargetStateController(service, () => 1)
  const context = {
    native: service, targets, defaultProvider: 'default', platform: 'linux',
    sleep: async ms => { clock += ms }, sleepAbortable: async () => false,
    runScript: async () => ({ stdout: '', stderr: '', code: 0, timedOut: false }),
    now: () => clock,
  }
  return { calls, context, targets }
}

const firefox = {
  launched: true, bundleId: 'firefox', desktopEntry: '/var/lib/snapd/desktop/applications/firefox_firefox.desktop',
  desktopId: 'firefox_firefox', name: 'Firefox', process: 'firefox', launcher: 'gio',
}
const json = result => JSON.parse(result.content[0].text)

test('an app with no window is launched, and its window is activated once it appears', async () => {
  const { calls, context, targets } = setup({ launch: firefox, windowAfterMs: 2_000, processAfterMs: 1_000 })
  const result = await handleWindowTool('open_application', { bundle_id: 'firefox' }, context)
  assert.equal(result.isError, undefined)
  assert.equal(result.contract.effect, 'verified')
  assert.deepEqual({ launched: json(result).launched, activated: json(result).activated }, { launched: true, activated: true })
  assert.equal(calls.filter(([name]) => name === 'launchApp').length, 1)
  assert.equal(targets.current()?.bundleId, 'firefox')
})

test('a running app whose window cannot be listed (native Wayland) is launched but unverified', async () => {
  const { context } = setup({ launch: firefox, processAfterMs: 1_000 })
  const result = await handleWindowTool('open_application', { bundle_id: 'firefox' }, context)
  assert.equal(result.isError, undefined)
  assert.equal(result.contract.effect, 'unverified')
  const payload = json(result)
  assert.equal(payload.process_running, true)
  assert.equal(payload.activated, false)
  assert.match(payload.note, /screenshot/)
})

test('an app with no desktop entry is app_not_installed, and one that never appears times out', async () => {
  const missing = setup({ launch: { launched: false, reason: 'not_installed', bundleId: 'nope', searched: ['/usr/share/applications'] } })
  const refused = await handleWindowTool('open_application', { bundle_id: 'nope' }, missing.context)
  assert.equal(refused.isError, true)
  assert.equal(json(refused).error, 'app_not_installed')
  assert.match(json(refused).remediation[0], /discover_applications/)

  const silent = setup({ launch: firefox })
  const timedOut = await handleWindowTool('open_application', { bundle_id: 'firefox' }, silent.context)
  assert.equal(timedOut.isError, true)
  assert.equal(json(timedOut).error, 'launch_timeout')
  assert.ok(LAUNCH_WAIT_MS >= 10_000)
})

test('discovery reads the XDG directories and the snap and Flatpak exports', () => {
  const dirs = linuxApplicationDirs({ XDG_DATA_DIRS: '/usr/share/ubuntu:/usr/share/' }, '/home/p')
  assert.equal(dirs[0], '/home/p/.local/share/applications')
  assert.ok(dirs.includes('/usr/share/applications'))
  assert.ok(dirs.includes('/var/lib/snapd/desktop/applications'))
  assert.ok(dirs.includes('/home/p/.local/share/flatpak/exports/share/applications'))
  assert.equal(new Set(dirs).size, dirs.length)
})
