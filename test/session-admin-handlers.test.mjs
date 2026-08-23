import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('Windows taskkill receives switch and value as separate argv entries', async () => {
  let invocation
  const result = await handleAdminTool('process_kill', { mode: 'kill', pid: 4242, force: true }, context({
    spawnBounded: async (...args) => {
      invocation = args
      return { stdout: 'ok', stderr: '', code: 0, timedOut: false }
    },
  }))
  assert.equal(result.isError, undefined)
  assert.deepEqual(invocation.slice(0, 2), ['taskkill', ['/PID', '4242', '/F']])
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

test('filesystem info computes path-independent byte digests for files and directory trees', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-digest-'))
  try {
    const source = join(directory, 'source')
    const destination = join(directory, 'destination')
    await mkdir(join(source, 'nested'), { recursive: true })
    await writeFile(join(source, 'binary.dat'), Buffer.from([0, 255, 1, 254, 2]))
    await writeFile(join(source, 'nested', 'text.txt'), 'same bytes')
    const copied = await handleAdminTool('filesystem', {
      mode: 'copy', path: source, destination,
    }, context())
    assert.equal(copied.isError, undefined)
    const digest = async path => {
      const result = await handleAdminTool('filesystem', {
        mode: 'info', path, include_digest: true,
      }, context())
      return JSON.parse(result.content[0].text).contentDigest
    }
    assert.match(await digest(source), /^sha256:[a-f0-9]{64}$/)
    assert.equal(await digest(source), await digest(destination))
    await writeFile(join(destination, 'binary.dat'), Buffer.from([0, 255, 1, 253, 2]))
    assert.notEqual(await digest(source), await digest(destination))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
