// v5.2 focusRequired metadata tests.
//
// Every registered MCP tool must carry a `[focusRequired: X]` suffix in its
// description, and `get_tool_metadata(name)` must return the structured
// form. Agents filter tools by focusRequired to avoid stepping on the
// frontmost app when they don't need to.

import assert from 'node:assert/strict'
import test from 'node:test'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'

const FOCUS_VALUES = new Set(['scripting', 'ax', 'cgevent', 'none'])
const TAG_RE = /\[focusRequired:\s*(scripting|ax|cgevent|none)\]\s*$/

// We need a mock native so the server can boot under test without the real
// `.node` addon (keeps this test OS-portable for CI if we ever run on Linux).
function createMockNative() {
  return {
    getFrontmostApp: () => ({ bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1 }),
    listRunningApps: () => [],
    listWindows: () => [],
    getWindow: () => null,
    drainRunloop: () => {},
  }
}

test('Phase 4: every tool\'s description ends with [focusRequired: X]', async () => {
  const server = createComputerUseServer({ native: createMockNative() })
  const client = await connectInProcess(server)
  try {
    const res = await client.listTools()
    const tools = Array.isArray(res) ? res : (res.tools ?? [])
    assert.ok(tools.length > 40, `expected at least 40 tools registered, got ${tools.length}`)

    const untagged = []
    for (const t of tools) {
      if (!t.description || !TAG_RE.test(t.description)) {
        untagged.push(t.name)
      }
    }
    assert.deepEqual(untagged, [], `tools missing focusRequired tag: ${untagged.join(', ')}`)
  } finally {
    await client.close()
  }
})

test('Phase 4: get_tool_metadata returns structured metadata for a known tool', async () => {
  const server = createComputerUseServer({ native: createMockNative() })
  const client = await connectInProcess(server)
  try {
    const r = await client.callTool('get_tool_metadata', { tool_name: 'run_script' })
    assert.equal(r.isError, undefined)
    const body = JSON.parse(r.content.find(c => c.type === 'text').text)
    assert.equal(body.tool_name, 'run_script')
    assert.equal(body.focusRequired, 'scripting')
    assert.equal(body.mutates, true)
  } finally {
    await client.close()
  }
})

test('Phase 4: get_tool_metadata returns error on unknown tool', async () => {
  const server = createComputerUseServer({ native: createMockNative() })
  const client = await connectInProcess(server)
  try {
    const r = await client.callTool('get_tool_metadata', { tool_name: 'nope_not_real' })
    assert.equal(r.isError, true)
    const body = JSON.parse(r.content.find(c => c.type === 'text').text)
    assert.equal(body.error, 'unknown_tool')
  } finally {
    await client.close()
  }
})

test('Phase 4: focusRequired values match the known enum', async () => {
  const server = createComputerUseServer({ native: createMockNative() })
  const client = await connectInProcess(server)
  try {
    const res = await client.listTools()
    const tools = Array.isArray(res) ? res : (res.tools ?? [])
    for (const t of tools) {
      const m = TAG_RE.exec(t.description ?? '')
      assert.ok(m, `${t.name}: missing tag`)
      assert.ok(FOCUS_VALUES.has(m[1]), `${t.name}: unexpected focusRequired "${m[1]}"`)
    }
  } finally {
    await client.close()
  }
})

test('Phase 4: spot-check expected mappings for critical tools', async () => {
  const server = createComputerUseServer({ native: createMockNative() })
  const client = await connectInProcess(server)
  try {
    const check = async (name, expected) => {
      const r = await client.callTool('get_tool_metadata', { tool_name: name })
      const body = JSON.parse(r.content.find(c => c.type === 'text').text)
      assert.equal(body.focusRequired, expected.focusRequired, `${name}: focusRequired`)
      assert.equal(body.mutates, expected.mutates, `${name}: mutates`)
    }
    // Representative of each category
    await check('run_script',        { focusRequired: 'scripting', mutates: true })
    await check('get_app_dictionary',{ focusRequired: 'scripting', mutates: false })
    await check('left_click',        { focusRequired: 'cgevent',   mutates: true })
    await check('type',              { focusRequired: 'cgevent',   mutates: true })
    await check('get_ui_tree',       { focusRequired: 'ax',        mutates: false })
    await check('click_element',     { focusRequired: 'ax',        mutates: true })
    await check('activate_app',      { focusRequired: 'ax',        mutates: true })
    await check('screenshot',        { focusRequired: 'none',      mutates: false })
    await check('wait',              { focusRequired: 'none',      mutates: false })
    await check('write_clipboard',   { focusRequired: 'none',      mutates: true })
  } finally {
    await client.close()
  }
})
