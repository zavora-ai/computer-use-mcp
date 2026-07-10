// v6.2 modernization: annotations, structuredContent, profiles, MUTATING parity, resources/prompts

import assert from 'node:assert/strict'
import test from 'node:test'
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

test('catalog has 64 tools and MUTATING_TOOLS matches mutates flag', () => {
  const names = Object.keys(TOOL_CATALOG)
  assert.equal(names.length, 64, `expected 64 tools, got ${names.length}`)
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
