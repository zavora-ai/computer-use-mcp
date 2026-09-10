// v6.2 modernization: annotations, structuredContent, profiles, MUTATING parity, resources/prompts

import assert from 'node:assert/strict'
import test from 'node:test'
const macOnly = { skip: process.platform !== 'darwin' && 'macOS-only integration test' }
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { MUTATING_TOOLS, TOOL_CATALOG, toToolMetaPublic } from '../dist/tool-catalog.js'
import { createSession } from '../dist/session.js'

function createMockNative() {
  return {
    getFrontmostApp: () => ({ bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1 }),
    listRunningApps: () => [{ bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1, isHidden: false }],
    listWindows: () => [{
      windowId: 1, bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1,
      title: 'bash', bounds: { x: 0, y: 0, width: 800, height: 600 },
      isOnScreen: true, isFocused: true, displayId: 1,
    }],
    getWindow: (id) => id === 1 ? {
      windowId: 1, bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1,
      title: 'bash', bounds: { x: 0, y: 0, width: 800, height: 600 },
      isOnScreen: true, isFocused: true, displayId: 1,
    } : null,
    getDisplaySize: () => ({ width: 1920, height: 1080, pixelWidth: 1920, pixelHeight: 1080, scaleFactor: 1 }),
    listDisplays: () => [],
    getActiveSpace: () => 1,
    listSpaces: () => ({ supported: true, active_space_id: 1, displays: [] }),
    drainRunloop: () => {},
  }
}

test('catalog has 65 tools and MUTATING_TOOLS matches mutates flag', () => {
  const names = Object.keys(TOOL_CATALOG)
  assert.equal(names.length, 65, `expected 65 tools, got ${names.length}`)
  for (const [name, meta] of Object.entries(TOOL_CATALOG)) {
    assert.equal(MUTATING_TOOLS.has(name), meta.mutates, `${name}: MUTATING_TOOLS vs mutates mismatch`)
  }
  assert.ok(MUTATING_TOOLS.has('resize_window'), 'resize_window must be mutating (PR-0)')
})

test('tools expose MCP annotations (readOnlyHint etc.)', async () => {
  const server = createComputerUseServer({ native: createMockNative() })
  const client = await connectInProcess(server)
  try {
    const tools = await client.listTools()
    const screenshot = tools.find(t => t.name === 'screenshot')
    assert.ok(screenshot?.annotations, 'screenshot should have annotations')
    assert.equal(screenshot.annotations.readOnlyHint, true)
    assert.equal(screenshot.annotations.openWorldHint, false)

    const runScript = tools.find(t => t.name === 'run_script')
    assert.equal(runScript?.annotations?.destructiveHint, true)
    assert.equal(runScript?.annotations?.openWorldHint, true)

    const wait = tools.find(t => t.name === 'wait')
    assert.equal(wait?.annotations?.idempotentHint, false)

    const scrape = tools.find(t => t.name === 'scrape')
    assert.equal(scrape?.annotations?.readOnlyHint, true)
    assert.equal(scrape?.annotations?.openWorldHint, true)
  } finally {
    await client.close()
  }
})

test('priority tools return structuredContent', async () => {
  const server = createComputerUseServer({ native: createMockNative() })
  const client = await connectInProcess(server)
  try {
    const r = await client.callTool('policy_status')
    assert.ok(r.structuredContent, 'policy_status should return structuredContent')
    assert.equal(typeof r.structuredContent.approval_token_configured, 'boolean')
    assert.ok(r.structuredContent.audit)

    const windows = await client.callTool('list_windows')
    assert.ok(windows.structuredContent?.windows)
    assert.ok(Array.isArray(windows.structuredContent.windows))

    const front = await client.callTool('get_frontmost_app')
    assert.ok('app' in (front.structuredContent ?? {}))

    const space = await client.callTool('get_active_space')
    assert.ok('active_space_id' in (space.structuredContent ?? {}))
  } finally {
    await client.close()
  }
})

test('profile=core hides ax-only tools', async () => {
  const server = createComputerUseServer({ native: createMockNative(), profile: 'core' })
  const client = await connectInProcess(server)
  try {
    const tools = await client.listTools()
    const names = new Set(tools.map(t => t.name))
    assert.ok(names.has('screenshot'))
    assert.ok(names.has('left_click'))
    assert.ok(!names.has('get_ui_tree'), 'get_ui_tree is ax-only')
    assert.ok(!names.has('run_script'), 'run_script is scripting-only')
    assert.ok(!names.has('process_kill'), 'process_kill is windows-admin-only')
    assert.ok(!names.has('scrape'), 'scrape is full-only')
  } finally {
    await client.close()
  }
})

test('server registers prompts and resources', async () => {
  const server = createComputerUseServer({ native: createMockNative() })
  const client = await connectInProcess(server)
  try {
    const prompts = await client.listPrompts()
    const promptNames = prompts.map(p => p.name)
    assert.ok(promptNames.includes('diagnose-desktop'))
    assert.ok(promptNames.includes('fill-form'))
    assert.ok(promptNames.includes('script-first'))
    assert.ok(promptNames.includes('safe-desktop-task'))

    const resources = await client.listResources()
    const uris = resources.map(r => r.uri)
    assert.ok(uris.some(u => u.includes('computer://display')))
    assert.ok(uris.some(u => u.includes('computer://windows')))
    assert.ok(uris.some(u => u.includes('computer://policy')))
  } finally {
    await client.close()
  }
})

test('get_tool_metadata returns public meta fields from catalog', async () => {
  const server = createComputerUseServer({ native: createMockNative() })
  const client = await connectInProcess(server)
  try {
    const r = await client.callTool('get_tool_metadata', { tool_name: 'resize_window' })
    const body = JSON.parse(r.content.find(c => c.type === 'text').text)
    assert.equal(body.mutates, true)
    assert.equal(body.focusRequired, 'ax')
    assert.deepEqual(body, { tool_name: 'resize_window', ...toToolMetaPublic(TOOL_CATALOG.resize_window) })
  } finally {
    await client.close()
  }
})

test('session list_windows wire is { windows: [...] }', async () => {
  const session = createSession({ native: createMockNative() })
  const r = await session.dispatch('list_windows', {})
  const body = JSON.parse(r.content[0].text)
  assert.ok(Array.isArray(body.windows))
  assert.ok(r.structuredContent?.windows)
})

// ── Structured-content opt-out (PR-19 release blocker) ───────────────────

test('structured content ENABLED: results carry structuredContent + outputSchema advertised', async () => {
  const server = createComputerUseServer({ native: createMockNative(), structuredContent: true })
  const client = await connectInProcess(server)
  try {
    const r = await client.callTool('policy_status')
    assert.ok(r.structuredContent !== undefined, 'structuredContent should be present when enabled')

    const tools = await client.listTools()
    const ps = tools.find(t => t.name === 'policy_status')
    assert.ok(ps?.outputSchema !== undefined, 'outputSchema should be advertised when enabled')
  } finally {
    await client.close()
  }
})

test('structured content DISABLED: strips BOTH structuredContent and outputSchema (opts override)', async () => {
  const server = createComputerUseServer({ native: createMockNative(), structuredContent: false })
  const client = await connectInProcess(server)
  try {
    const r = await client.callTool('policy_status')
    assert.equal(r.structuredContent, undefined, 'structuredContent must be absent when disabled')
    // Text content is still present and parseable (legacy shape preserved)
    const text = r.content.find(c => c.type === 'text')?.text
    assert.ok(text, 'text content should remain')
    const body = JSON.parse(text)
    assert.equal(typeof body.approval_token_configured, 'boolean')

    const tools = await client.listTools()
    const withSchema = tools.filter(t => t.outputSchema !== undefined)
    assert.equal(withSchema.length, 0, `no outputSchema should be advertised when disabled, got ${withSchema.map(t => t.name).join(',')}`)

    // Server-local handler (get_tool_metadata) must also honor the opt-out
    const meta = await client.callTool('get_tool_metadata', { tool_name: 'run_script' })
    assert.equal(meta.structuredContent, undefined, 'get_tool_metadata must not emit structuredContent when disabled')
    assert.ok(meta.content.find(c => c.type === 'text')?.text, 'get_tool_metadata text content should remain')
  } finally {
    await client.close()
  }
})

test('structured content DISABLED via COMPUTER_USE_STRUCTURED_CONTENT=false env var', async () => {
  const prev = process.env.COMPUTER_USE_STRUCTURED_CONTENT
  process.env.COMPUTER_USE_STRUCTURED_CONTENT = 'false'
  try {
    const server = createComputerUseServer({ native: createMockNative() })
    const client = await connectInProcess(server)
    try {
      const r = await client.callTool('policy_status')
      assert.equal(r.structuredContent, undefined, 'env opt-out must strip structuredContent')
      const tools = await client.listTools()
      assert.equal(tools.filter(t => t.outputSchema !== undefined).length, 0, 'env opt-out must strip outputSchema')
    } finally {
      await client.close()
    }
  } finally {
    if (prev === undefined) delete process.env.COMPUTER_USE_STRUCTURED_CONTENT
    else process.env.COMPUTER_USE_STRUCTURED_CONTENT = prev
  }
})

// ── get_tool_guide additive fields (PR-7) ────────────────────────────────

test('get_tool_guide keeps core fields and adds confidence/platform/fallbackSequence', async () => {
  const server = createComputerUseServer({ native: createMockNative() })
  const client = await connectInProcess(server)
  try {
    const r = await client.callTool('get_tool_guide', { task_description: 'reply to the selected email' })
    const guide = r.structuredContent ?? JSON.parse(r.content.find(c => c.type === 'text').text)
    // core fields preserved
    assert.ok(['scripting', 'accessibility', 'keyboard', 'coordinate'].includes(guide.approach), 'approach present')
    assert.ok(Array.isArray(guide.toolSequence) && guide.toolSequence.length > 0, 'toolSequence present')
    assert.equal(typeof guide.explanation, 'string')
    // additive fields present
    assert.equal(typeof guide.confidence, 'number', 'confidence additive field')
    assert.ok(guide.confidence >= 0 && guide.confidence <= 1, 'confidence in [0,1]')
    assert.ok(['darwin', 'win32', 'any'].includes(guide.platform), 'platform additive field')
    assert.ok(Array.isArray(guide.fallbackSequence), 'fallbackSequence additive field')
  } finally {
    await client.close()
  }
})

test('get_tool_guide flags unavailableInProfile + remediation under profile=core', macOnly, async () => {
  const server = createComputerUseServer({ native: createMockNative(), profile: 'core' })
  const client = await connectInProcess(server)
  try {
    // "send an email" maps to a scripting sequence that includes run_script (not in core)
    const r = await client.callTool('get_tool_guide', { task_description: 'send an email' })
    const guide = r.structuredContent ?? JSON.parse(r.content.find(c => c.type === 'text').text)
    assert.ok(Array.isArray(guide.unavailableInProfile), 'unavailableInProfile present under core')
    assert.ok(guide.unavailableInProfile.includes('run_script'), 'run_script flagged unavailable in core profile')
    assert.equal(typeof guide.remediation, 'string')
    assert.ok(/COMPUTER_USE_PROFILE/.test(guide.remediation), 'remediation mentions the profile env var')
  } finally {
    await client.close()
  }
})
