// v6.2 regression coverage: profiles (all tiers), resource reads (incl. screenshot cache-only),
// and elicitation approval accept/decline/timeout + token-wins (K13).

import assert from 'node:assert/strict'
import test from 'node:test'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { createSession } from '../dist/session.js'
import { TOOL_CATALOG, toolInProfile } from '../dist/tool-catalog.js'

function createMockNative() {
  return {
    getFrontmostApp: () => ({ bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1 }),
    listRunningApps: () => [{ bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1, isHidden: false }],
    listWindows: () => [{
      windowId: 1, bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1,
      title: 'bash', bounds: { x: 0, y: 0, width: 800, height: 600 },
      isOnScreen: true, isFocused: true, displayId: 1,
    }],
    getWindow: () => null,
    getDisplaySize: () => ({ width: 1920, height: 1080, pixelWidth: 1920, pixelHeight: 1080, scaleFactor: 1 }),
    listDisplays: () => [],
    getActiveSpace: () => 1,
    listSpaces: () => ({ supported: true, active_space_id: 1, displays: [] }),
    drainRunloop: () => {},
  }
}

// ── Profiles: membership across all tiers (Appendix B nesting) ───────────

function toolsIn(profile) {
  return Object.entries(TOOL_CATALOG)
    .filter(([, meta]) => toolInProfile(meta, profile))
    .map(([name]) => name)
}

test('profile nesting: core ⊆ scripting ⊆ windows-admin ⊆ full and core ⊆ ax ⊆ full', () => {
  const core = new Set(toolsIn('core'))
  const ax = new Set(toolsIn('ax'))
  const scripting = new Set(toolsIn('scripting'))
  const winadmin = new Set(toolsIn('windows-admin'))
  const full = new Set(toolsIn('full'))

  assert.equal(full.size, 65, 'full profile exposes all 65 tools')

  for (const t of core) {
    assert.ok(ax.has(t), `core tool ${t} must be in ax`)
    assert.ok(scripting.has(t), `core tool ${t} must be in scripting`)
    assert.ok(winadmin.has(t), `core tool ${t} must be in windows-admin`)
    assert.ok(full.has(t), `core tool ${t} must be in full`)
  }
  for (const t of scripting) {
    assert.ok(winadmin.has(t), `scripting tool ${t} must be in windows-admin (nesting)`)
    assert.ok(full.has(t), `scripting tool ${t} must be in full`)
  }
  // strict growth
  assert.ok(core.size < ax.size, 'ax adds tools over core')
  assert.ok(core.size < scripting.size, 'scripting adds tools over core')
  assert.ok(scripting.size < winadmin.size, 'windows-admin adds tools over scripting')
  assert.ok(winadmin.size < full.size, 'full adds tools over windows-admin')
})

test('profile representative membership per Appendix A/B tiers', () => {
  const inProfile = (name, profile) => toolInProfile(TOOL_CATALOG[name], profile)

  // core: everywhere
  assert.ok(inProfile('screenshot', 'core') && inProfile('left_click', 'core'))
  // ax-only: ax + full, not core/scripting/windows-admin
  assert.ok(inProfile('get_ui_tree', 'ax') && inProfile('get_ui_tree', 'full'))
  assert.ok(!inProfile('get_ui_tree', 'core') && !inProfile('get_ui_tree', 'scripting') && !inProfile('get_ui_tree', 'windows-admin'))
  // scripting-only: scripting + windows-admin + full, not core/ax
  assert.ok(inProfile('run_script', 'scripting') && inProfile('run_script', 'windows-admin') && inProfile('run_script', 'full'))
  assert.ok(!inProfile('run_script', 'core') && !inProfile('run_script', 'ax'))
  // windows-admin-only: windows-admin + full, not scripting
  assert.ok(inProfile('registry', 'windows-admin') && inProfile('registry', 'full'))
  assert.ok(!inProfile('registry', 'scripting') && !inProfile('registry', 'ax') && !inProfile('registry', 'core'))
  // full-only
  assert.ok(inProfile('scrape', 'full'))
  assert.ok(!inProfile('scrape', 'core') && !inProfile('scrape', 'ax') && !inProfile('scrape', 'scripting') && !inProfile('scrape', 'windows-admin'))
})

test('server registered under profile=scripting exposes scripting tier, hides ax-only', async () => {
  const server = createComputerUseServer({ native: createMockNative(), profile: 'scripting' })
  const client = await connectInProcess(server)
  try {
    const names = new Set((await client.listTools()).map(t => t.name))
    assert.ok(names.has('run_script'), 'run_script present in scripting')
    assert.ok(names.has('filesystem'), 'filesystem present in scripting')
    assert.ok(names.has('screenshot'), 'core tool present')
    assert.ok(!names.has('get_ui_tree'), 'ax-only hidden in scripting')
    assert.ok(!names.has('registry'), 'windows-admin-only hidden in scripting')
  } finally {
    await client.close()
  }
})

// ── Resources: read each + screenshot cache-only (K15) ───────────────────

test('all six computer:// resources are listed and readable', async () => {
  const server = createComputerUseServer({ native: createMockNative() })
  const client = await connectInProcess(server)
  try {
    const resources = await client.listResources()
    const uris = new Set(resources.map(r => r.uri))
    for (const u of [
      'computer://display/main', 'computer://windows', 'computer://frontmost',
      'computer://policy', 'computer://profile/tools', 'computer://screenshot/latest',
    ]) {
      assert.ok(uris.has(u), `resource ${u} should be listed`)
    }

    const display = await client.readResource('computer://display/main')
    const dj = JSON.parse(display.contents[0].text)
    assert.equal(dj.width, 1920)

    const windows = await client.readResource('computer://windows')
    assert.ok(Array.isArray(JSON.parse(windows.contents[0].text).windows))

    const frontmost = await client.readResource('computer://frontmost')
    assert.ok('app' in JSON.parse(frontmost.contents[0].text))

    const policy = await client.readResource('computer://policy')
    assert.equal(typeof JSON.parse(policy.contents[0].text).approval_token_configured, 'boolean')

    const profileTools = await client.readResource('computer://profile/tools')
    const pj = JSON.parse(profileTools.contents[0].text)
    assert.equal(pj.profile, 'full')
    assert.equal(pj.count, 65)
  } finally {
    await client.close()
  }
})

test('computer://screenshot/latest is cache-only — never captures on read (K15)', async () => {
  const server = createComputerUseServer({ native: createMockNative() })
  const client = await connectInProcess(server)
  try {
    const r = await client.readResource('computer://screenshot/latest')
    const body = JSON.parse(r.contents[0].text)
    assert.equal(body.available, false, 'no screenshot cached → available:false')
    assert.equal(body.reason, 'no_cached_screenshot')
  } finally {
    await client.close()
  }
})

// ── Elicitation approval: accept / decline / timeout + token-wins (K13) ──

function withApprovalEnv(overrides, fn) {
  const keys = ['COMPUTER_USE_REQUIRE_APPROVAL_FOR', 'COMPUTER_USE_APPROVAL_TOKEN']
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]))
  for (const k of keys) delete process.env[k]
  Object.assign(process.env, overrides)
  try {
    return fn()
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
}

async function dispatchWithElicit({ overrides, elicitApproval, args = {} }) {
  return withApprovalEnv(overrides, async () => {
    const session = createSession({ native: createMockNative(), elicitApproval, disableSessionLock: true })
    return session.dispatch('get_display_size', args)
  })
}

function parse(result) {
  const text = result.content.find(c => c.type === 'text')?.text ?? '{}'
  return JSON.parse(text)
}

test('elicitation ACCEPT → tool proceeds (not approval_required)', async () => {
  let calls = 0
  const r = await dispatchWithElicit({
    overrides: { COMPUTER_USE_REQUIRE_APPROVAL_FOR: 'get_display_size' },
    elicitApproval: async () => { calls++; return true },
  })
  assert.equal(calls, 1, 'elicitApproval called once')
  assert.ok(!r.isError, 'approved call should not error')
  assert.equal(parse(r).width, 1920, 'get_display_size executed after approval')
})

test('elicitation approval is one-shot and cannot silently approve a later call', async () => {
  await withApprovalEnv({ COMPUTER_USE_REQUIRE_APPROVAL_FOR: 'get_display_size' }, async () => {
    let calls = 0
    const session = createSession({
      native: createMockNative(), disableSessionLock: true,
      elicitApproval: async () => { calls++; return calls === 1 },
    })
    assert.equal((await session.dispatch('get_display_size', {})).isError, undefined)
    const second = await session.dispatch('get_display_size', {})
    assert.equal(calls, 2)
    assert.equal(parse(second).error, 'approval_required')
  })
})

test('elicitation DECLINE → approval_required error', async () => {
  let calls = 0
  const r = await dispatchWithElicit({
    overrides: { COMPUTER_USE_REQUIRE_APPROVAL_FOR: 'get_display_size' },
    elicitApproval: async () => { calls++; return false },
  })
  assert.equal(calls, 1)
  assert.ok(r.isError, 'declined call must error')
  assert.equal(parse(r).error, 'approval_required')
})

test('elicitation TIMEOUT/throw → treated as denied (approval_required)', async () => {
  let calls = 0
  const r = await dispatchWithElicit({
    overrides: { COMPUTER_USE_REQUIRE_APPROVAL_FOR: 'get_display_size' },
    elicitApproval: async () => { calls++; throw new Error('timeout') },
  })
  assert.equal(calls, 1)
  assert.ok(r.isError)
  assert.equal(parse(r).error, 'approval_required')
})

test('token WINS over elicitation (K13): valid token approves without eliciting', async () => {
  let calls = 0
  const r = await dispatchWithElicit({
    overrides: { COMPUTER_USE_REQUIRE_APPROVAL_FOR: 'get_display_size', COMPUTER_USE_APPROVAL_TOKEN: 's3cret' },
    elicitApproval: async () => { calls++; return false },
    args: { approval_token: 's3cret' },
  })
  assert.equal(calls, 0, 'elicitApproval must NOT be called when a valid token is present')
  assert.ok(!r.isError, 'valid token should approve')
  assert.equal(parse(r).width, 1920)
})

test('no token + no elicitation callback → approval_required', async () => {
  const r = await withApprovalEnv({ COMPUTER_USE_REQUIRE_APPROVAL_FOR: 'get_display_size' }, async () => {
    const session = createSession({ native: createMockNative(), disableSessionLock: true })
    return session.dispatch('get_display_size', {})
  })
  assert.ok(r.isError)
  assert.equal(parse(r).error, 'approval_required')
})

// Argument validation runs at the MCP boundary. It must apply advertised schema
// defaults and report malformed input as a recoverable tool result — a thrown
// JSON-RPC fault gives an agent nothing to retry against.

test('malformed arguments return a structured invalid_arguments result, not a JSON-RPC fault', async () => {
  const client = await connectInProcess(createComputerUseServer({ session: createSession({
    native: createMockNative(), disableSessionLock: true,
  }) }))
  try {
    const missing = await client.callTool('get_ui_tree', {})
    assert.ok(missing.isError, 'missing required argument must be an error result')
    const payload = parse(missing)
    assert.equal(payload.error, 'invalid_arguments')
    assert.equal(payload.tool, 'get_ui_tree')
    assert.deepEqual(payload.issues.map(issue => issue.path), ['window_id'])
    assert.ok(Array.isArray(payload.remediation) && payload.remediation.length > 0)

    const badEnum = await client.callTool('scroll', { coordinate: [1, 2], direction: 'sideways' })
    assert.ok(badEnum.isError)
    assert.equal(parse(badEnum).error, 'invalid_arguments')
    assert.deepEqual(parse(badEnum).issues.map(issue => issue.path), ['direction'])
  } finally {
    await client.close()
  }
})

test('advertised schema defaults reach handlers so declared and actual behavior agree', async () => {
  const client = await connectInProcess(createComputerUseServer({ session: createSession({
    native: createMockNative(), disableSessionLock: true,
  }) }))
  try {
    // snapshot.use_vision advertises default false, so an omitted flag must behave
    // exactly like an explicit false rather than smuggling in a UI tree.
    const textOf = result => result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
    const omitted = textOf(await client.callTool('snapshot', {}))
    const explicit = textOf(await client.callTool('snapshot', { use_vision: false }))
    assert.equal(omitted.includes('UI Tree'), false, 'omitted use_vision must not include a UI tree')
    assert.equal(omitted, explicit, 'omitted default must match the advertised default')
  } finally {
    await client.close()
  }
})
