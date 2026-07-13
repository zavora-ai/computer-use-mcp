import assert from 'node:assert/strict'
import test from 'node:test'
import { handleAdminTool } from '../dist/session/admin-handlers.js'

function context(overrides = {}) {
  return {
    platform: 'win32',
    spawnBounded: async () => ({ stdout: 'ok', stderr: '', code: 0, timedOut: false }),
    getPowerShellExe: () => 'pwsh',
    ...overrides,
  }
}

test('extracted admin router declines tools outside its bounded domain', async () => {
  assert.equal(await handleAdminTool('left_click', {}, context()), undefined)
})

test('extracted registry handler encodes quoted values without shell interpolation', async () => {
  let invocation
  const result = await handleAdminTool('registry', {
    mode: 'set', path: 'HKCU:\\Software\\Fixture', name: "Owner's value",
    value: "a'b", type: 'String',
  }, context({
    spawnBounded: async (...args) => {
      invocation = args
      return { stdout: '', stderr: '', code: 0, timedOut: false }
    },
  }))
  assert.equal(result.isError, undefined)
  assert.equal(invocation[0], 'pwsh')
  const encoded = invocation[1].at(-1)
  const script = Buffer.from(encoded, 'base64').toString('utf16le')
  assert.match(script, /Owner''s value|a''b/)
  assert.doesNotMatch(invocation.join(' '), /Owner's value|a'b/)
})

test('extracted scrape handler strips active markup and truncates through injected fetch', async () => {
  const result = await handleAdminTool('scrape', { url: 'https://fixture.invalid' }, context({
    fetch: async () => ({
      ok: true, status: 200, statusText: 'OK',
      text: async () => '<style>private-style</style><script>private-script</script><p>Hello &amp; safe</p>',
    }),
  }))
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /Hello & safe/)
  assert.doesNotMatch(result.content[0].text, /private-style|private-script|<p>/)
})
