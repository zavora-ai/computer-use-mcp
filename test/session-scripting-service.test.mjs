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

// Issue #19: a Linux caller asking for bash was told "applescript is not supported on
// Linux". Two defects met to produce that. The handler coerced anything that was not
// `javascript` to `applescript` on every non-Windows platform, and the tool's schema
// enum never contained `bash` — while the dispatch implemented it, the platform table
// documented it, and this file's own error message recommended it.

function routing(platform) {
  const calls = []
  const service = new ScriptingService({
    native: {},
    platform,
    execFile: () => { throw new Error('no pwsh here') },
    spawnBounded: async (command, ...rest) => {
      calls.push(command)
      return { stdout: '', stderr: '', code: 0, timedOut: false }
    },
  })
  return { service, calls }
}

test('bash reaches bash on macOS and Linux, and is refused on Windows with the alternative', async () => {
  for (const platform of ['darwin', 'linux']) {
    const { service, calls } = routing(platform)
    const result = await service.runScript('bash', 'echo hello', 1000)
    assert.equal(result.code, 0, `bash should run on ${platform}`)
    assert.equal(calls[0], 'bash', `${platform} must spawn bash, not osascript`)
  }
  const { service } = routing('win32')
  const refused = await service.runScript('bash', 'echo hello', 1000)
  assert.match(refused.stderr, /not supported on Windows/)
  assert.match(refused.stderr, /powershell/, 'the alternative must be named')
})

test('an unsupported language names an alternative the schema actually accepts', async () => {
  // The original message advised `bash` on Linux while the enum rejected it, so a
  // caller following the advice got invalid_arguments.
  const { service } = routing('linux')
  const refused = await service.runScript('applescript', 'return 1', 1000)
  assert.match(refused.stderr, /not supported on Linux/)
  for (const advised of refused.stderr.match(/"([a-z]+)"/g) ?? []) {
    const language = advised.replaceAll('"', '')
    assert.ok(
      ['applescript', 'javascript', 'powershell', 'bash'].includes(language),
      `the message advises "${language}", which the schema must accept`,
    )
  }
})

test('applescript and javascript go to osascript, and only on macOS', async () => {
  const { service, calls } = routing('darwin')
  await service.runScript('applescript', 'return 1', 1000)
  await service.runScript('javascript', '1+1', 1000)
  assert.deepEqual(calls, ['osascript', 'osascript'])

  for (const platform of ['linux', 'win32']) {
    const { service, calls } = routing(platform)
    const result = await service.runScript('javascript', '1+1', 1000)
    assert.equal(result.code, 1, `javascript must be refused on ${platform}`)
    assert.deepEqual(calls, [], 'and nothing should be spawned')
  }
})

test('powershell is reachable off Windows, where pwsh is the executable', async () => {
  const { service, calls } = routing('linux')
  await service.runScript('powershell', 'Write-Output 1', 1000)
  assert.equal(calls[0], 'pwsh')
})
