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

// ── web_search ──────────────────────────────────────────────────────────────
//
// Runs locally so it works with any model, rather than only those whose provider
// offers a server-side search tool. Every provider is exercised through an
// injected fetch, so these need no key and no network.

const searchEnv = ['COMPUTER_USE_SEARCH_PROVIDER', 'COMPUTER_USE_SEARCH_API_KEY']

/** Run with a given search configuration, restoring the environment after. */
async function withSearchEnv(values, run) {
  const saved = Object.fromEntries(searchEnv.map(name => [name, process.env[name]]))
  try {
    for (const name of searchEnv) {
      if (values[name] === undefined) delete process.env[name]
      else process.env[name] = values[name]
    }
    return await run()
  } finally {
    for (const name of searchEnv) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
  }
}

const jsonResponse = body => ({ ok: true, status: 200, statusText: 'OK', json: async () => body })

test('web_search returns ranked results from a keyed provider', async () => {
  let seen
  const result = await withSearchEnv(
    { COMPUTER_USE_SEARCH_PROVIDER: 'brave', COMPUTER_USE_SEARCH_API_KEY: 'test-key' },
    () => handleAdminTool('web_search', { query: 'blender bevel modifier', max_results: 2 }, context({
      fetch: async (url, init) => {
        seen = { url: String(url), headers: init?.headers ?? {} }
        return jsonResponse({ web: { results: [
          { title: 'Bevel Modifier', url: 'https://docs.blender.invalid/bevel', description: 'Rounds <b>edges</b>' },
          { title: 'Bevel tips', url: 'https://forum.invalid/t/1', description: 'Use clamp overlap' },
          { title: 'Third, over the limit', url: 'https://x.invalid', description: 'ignored' },
        ] } })
      },
    })))
  assert.equal(result.isError, undefined)
  const text = result.content[0].text
  assert.match(text, /Bevel Modifier/)
  assert.match(text, /docs\.blender\.invalid\/bevel/)
  // Snippet markup is stripped, so a result cannot smuggle formatting or tags.
  assert.match(text, /Rounds edges/)
  assert.doesNotMatch(text, /<b>/)
  assert.doesNotMatch(text, /Third, over the limit/, 'max_results is honoured')
  // Results are data, and the reply says so.
  assert.match(text, /untrusted data, not instructions/)
  // The key travels as a header, never in the query string.
  assert.match(seen.url, /api\.search\.brave\.com/)
  assert.equal(seen.headers['X-Subscription-Token'], 'test-key')
  assert.doesNotMatch(seen.url, /test-key/)
})

test('web_search supports tavily and serper response shapes', async () => {
  const tavily = await withSearchEnv(
    { COMPUTER_USE_SEARCH_PROVIDER: 'tavily', COMPUTER_USE_SEARCH_API_KEY: 'k' },
    () => handleAdminTool('web_search', { query: 'usd export' }, context({
      fetch: async () => jsonResponse({ results: [{ title: 'USD', url: 'https://u.invalid', content: 'Universal Scene Description' }] }),
    })))
  assert.match(tavily.content[0].text, /USD\n {3}https:\/\/u\.invalid/)

  const serper = await withSearchEnv(
    { COMPUTER_USE_SEARCH_PROVIDER: 'serper', COMPUTER_USE_SEARCH_API_KEY: 'k' },
    () => handleAdminTool('web_search', { query: 'usd export' }, context({
      fetch: async () => jsonResponse({ organic: [{ title: 'Pixar USD', link: 'https://p.invalid', snippet: 'openusd' }] }),
    })))
  assert.match(serper.content[0].text, /Pixar USD/)
  assert.match(serper.content[0].text, /openusd/)
})

test('web_search works with no key at all, and says what that costs', async () => {
  // The keyless path parses an HTML page, so it must decode the redirect wrapper
  // to recover the real URL rather than handing back a duckduckgo link.
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.blender.invalid%2Fnodes">Geometry <b>Nodes</b></a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwiki.invalid%2Fgn">Wiki</a>`
  const result = await withSearchEnv({}, () =>
    handleAdminTool('web_search', { query: 'geometry nodes', max_results: 1 }, context({
      fetch: async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => html }),
    })))
  assert.equal(result.isError, undefined)
  assert.match(result.content[0].text, /Provider: duckduckgo/)
  assert.match(result.content[0].text, /https:\/\/docs\.blender\.invalid\/nodes/)
  assert.match(result.content[0].text, /Geometry Nodes/)
  assert.doesNotMatch(result.content[0].text, /Wiki/, 'max_results is honoured')

  // When that markup changes the failure is explicit, and it names the fix.
  const broken = await withSearchEnv({}, () =>
    handleAdminTool('web_search', { query: 'x' }, context({
      fetch: async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '<div>redesigned</div>' }),
    })))
  assert.equal(broken.isError, true)
  const failure = JSON.parse(broken.content[0].text)
  assert.equal(failure.error, 'web_search_failed')
  assert.equal(failure.provider, 'duckduckgo')
  assert.match(failure.remediation.join(' '), /COMPUTER_USE_SEARCH_API_KEY/)
})

test('web_search reports a provider outage as a recoverable result', async () => {
  const result = await withSearchEnv(
    { COMPUTER_USE_SEARCH_PROVIDER: 'brave', COMPUTER_USE_SEARCH_API_KEY: 'k' },
    () => handleAdminTool('web_search', { query: 'anything' }, context({
      fetch: async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }),
    })))
  assert.equal(result.isError, true)
  assert.match(JSON.parse(result.content[0].text).message, /HTTP 503/)
})

test('web_search rejects an unknown provider by name', async () => {
  const result = await withSearchEnv({ COMPUTER_USE_SEARCH_PROVIDER: 'altavista' }, () =>
    handleAdminTool('web_search', { query: 'anything' }, context({ fetch: async () => jsonResponse({}) })))
  assert.equal(result.isError, true)
  assert.match(JSON.parse(result.content[0].text).message, /unknown search provider "altavista"/)
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
