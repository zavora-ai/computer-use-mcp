import assert from 'node:assert/strict'
import test from 'node:test'
import { ScriptingService } from '../dist/session/scripting-service.js'

const success = (stdout = '') => ({ stdout, stderr: '', code: 0, timedOut: false })

test('scripting dictionaries are summarized, cached by PID, and suite-filterable', async () => {
  let pid = 7
  const calls = []
  const xml = '<suite name="Mail"><command name="send" description="Send it"/><class name="message"><property name="subject"/></class></suite>'
  const service = new ScriptingService({
    native: { listRunningApps: () => [{ bundleId: 'app.mail', pid }] },
    platform: 'darwin',
    spawnBounded: async (command, args) => {
      calls.push([command, ...args])
      return command === 'mdfind' ? success('/Applications/Mail.app\n') : success(xml)
    },
  })
  const summary = await service.getAppDictionary('app.mail')
  assert.deepEqual(summary.dict.suites[0], {
    name: 'Mail', commands: [{ name: 'send' }], classes: [{ name: 'message' }],
  })
  const full = await service.getAppDictionary('app.mail', 'Mail')
  assert.deepEqual(full.dict.suites[0].classes[0].properties, ['subject'])
  assert.equal(calls.filter(call => call[0] === 'sdef').length, 1)
  pid = 8
  await service.getAppDictionary('app.mail')
  assert.equal(calls.filter(call => call[0] === 'sdef').length, 2)
})

test('Windows scripts use UTF-16LE EncodedCommand when quoting requires it', async () => {
  const calls = []
  const service = new ScriptingService({
    native: {}, platform: 'win32', execFile: () => Buffer.from(''),
    spawnBounded: async (command, args) => { calls.push([command, ...args]); return success() },
  })
  await service.runScript('powershell', 'Write-Host "hello"', 1000)
  assert.equal(calls[0][0], 'pwsh')
  assert.equal(calls[0][3], '-EncodedCommand')
  assert.equal(Buffer.from(calls[0][4], 'base64').toString('utf16le'), 'Write-Host "hello"')
})

test('platform-incompatible script languages fail without spawning a process', async () => {
  let spawned = false
  const service = new ScriptingService({
    native: {}, platform: 'linux',
    spawnBounded: async () => { spawned = true; return success() },
  })
  const result = await service.runScript('applescript', 'return 1', 1000)
  assert.equal(result.code, 1)
  assert.match(result.stderr, /not supported on Linux/)
  assert.equal(spawned, false)
})
