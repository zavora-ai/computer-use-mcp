import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

// ── Helper: connect a fresh stdio client ──────────────────────────────────────

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['./test/fixtures/stdio-server.mjs'],
    cwd: process.cwd(),
  })
  const client = new Client({ name: 'computer-use-stdio-test', version: '1.0.0' })
  await client.connect(transport)
  try {
    await fn(client)
  } finally {
    await client.close()
  }
}

// ── Existing test ─────────────────────────────────────────────────────────────

test('stdio server exposes introspection tools to MCP hosts', async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools
    assert.ok(tools.find(tool => tool.name === 'get_frontmost_app'))
    const listWindows = tools.find(tool => tool.name === 'list_windows')
    assert.ok(listWindows)
    assert.ok(listWindows.inputSchema?.properties?.bundle_id)
  })
})

// ── v4 tool presence (Requirement 16.1) ───────────────────────────────────────

test('v4 tools are present in listTools: get_window, get_cursor_window, activate_app, activate_window', async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools
    const names = tools.map(t => t.name)

    for (const expected of ['get_window', 'get_cursor_window', 'activate_app', 'activate_window']) {
      assert.ok(names.includes(expected), `tool "${expected}" should be present in listTools`)
    }
  })
})

// ── v4 tool schemas: get_window has window_id param ───────────────────────────

test('get_window schema includes window_id parameter', async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools
    const getWindow = tools.find(t => t.name === 'get_window')
    assert.ok(getWindow, 'get_window tool should exist')
    assert.ok(getWindow.inputSchema?.properties?.window_id, 'get_window should have window_id param')
  })
})

// ── v4 tool schemas: activate_app has bundle_id and optional timeout_ms ───────

test('activate_app schema includes bundle_id and timeout_ms parameters', async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools
    const activateApp = tools.find(t => t.name === 'activate_app')
    assert.ok(activateApp, 'activate_app tool should exist')
    assert.ok(activateApp.inputSchema?.properties?.bundle_id, 'activate_app should have bundle_id param')
    assert.ok(activateApp.inputSchema?.properties?.timeout_ms, 'activate_app should have timeout_ms param')
  })
})

// ── v4 tool schemas: activate_window has window_id and optional timeout_ms ────

test('activate_window schema includes window_id and timeout_ms parameters', async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools
    const activateWindow = tools.find(t => t.name === 'activate_window')
    assert.ok(activateWindow, 'activate_window tool should exist')
    assert.ok(activateWindow.inputSchema?.properties?.window_id, 'activate_window should have window_id param')
    assert.ok(activateWindow.inputSchema?.properties?.timeout_ms, 'activate_window should have timeout_ms param')
  })
})

// ── Server version is 6.0.0 ─────────────────────────────────────────────────

test('server reports version 6.0.0', async () => {
  await withClient(async (client) => {
    const info = client.getServerVersion()
    assert.ok(info, 'server version info should be available after connect')
    assert.equal(info.version, '6.0.0', 'server version should be 6.0.0')
    assert.equal(info.name, 'computer-use', 'server name should be computer-use')
  })
})

// ── Property 3: Input tool schema completeness (Requirement 6.1, 7.1, 16.2) ──
// All 13 input tools must include target_window_id and focus_strategy in schemas

test('Property 3 (example-based): all input tools include target_window_id and focus_strategy in schemas', async () => {
  const INPUT_TOOLS = [
    'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
    'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up',
    'scroll', 'type', 'key', 'hold_key',
  ]

  await withClient(async (client) => {
    const tools = (await client.listTools()).tools

    for (const toolName of INPUT_TOOLS) {
      const tool = tools.find(t => t.name === toolName)
      assert.ok(tool, `input tool "${toolName}" should be present`)

      const props = tool.inputSchema?.properties ?? {}
      assert.ok(
        props.target_window_id,
        `"${toolName}" schema should include target_window_id`
      )
      assert.ok(
        props.focus_strategy,
        `"${toolName}" schema should include focus_strategy`
      )
    }
  })
})

// ── v5: All 14 new v5 tools present in listTools (Requirement 21.1) ──────────

const V5_TOOL_NAMES = [
  'get_ui_tree',
  'get_focused_element',
  'find_element',
  'click_element',
  'set_value',
  'press_button',
  'select_menu_item',
  'run_script',
  'get_app_dictionary',
  'fill_form',
  'get_tool_guide',
  'get_app_capabilities',
]

test('v5 tools are present in listTools', async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools
    const names = new Set(tools.map(t => t.name))
    for (const expected of V5_TOOL_NAMES) {
      assert.ok(names.has(expected), `tool "${expected}" should be present in listTools`)
    }
  })
})

// ── v5: Semantic mutating tool schemas (Property 6) ──────────────────────────

test('v5 semantic mutating tools include window_id + focus_strategy (where applicable)', async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools

    for (const name of ['click_element', 'press_button', 'set_value', 'fill_form']) {
      const t = tools.find(x => x.name === name)
      assert.ok(t, `${name} should exist`)
      const props = t.inputSchema?.properties ?? {}
      assert.ok(props.window_id, `${name} must have window_id`)
      assert.ok(props.focus_strategy, `${name} must have focus_strategy`)
    }

    const clickEl = tools.find(x => x.name === 'click_element')
    const clickProps = clickEl.inputSchema?.properties ?? {}
    assert.ok(clickProps.role && clickProps.label, 'click_element needs role + label')

    const setVal = tools.find(x => x.name === 'set_value')
    const setValProps = setVal.inputSchema?.properties ?? {}
    assert.ok(setValProps.role && setValProps.label && setValProps.value,
      'set_value needs role + label + value')

    const fillForm = tools.find(x => x.name === 'fill_form')
    const ffProps = fillForm.inputSchema?.properties ?? {}
    assert.ok(ffProps.fields, 'fill_form needs fields')
  })
})

test('select_menu_item schema has bundle_id + menu + item + optional submenu', async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools
    const t = tools.find(x => x.name === 'select_menu_item')
    assert.ok(t)
    const props = t.inputSchema?.properties ?? {}
    assert.ok(props.bundle_id, 'select_menu_item needs bundle_id')
    assert.ok(props.menu, 'select_menu_item needs menu')
    assert.ok(props.item, 'select_menu_item needs item')
    assert.ok(props.submenu, 'select_menu_item should accept optional submenu')
  })
})

test('run_script schema has language enum + script + optional timeout_ms', async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools
    const t = tools.find(x => x.name === 'run_script')
    assert.ok(t)
    const props = t.inputSchema?.properties ?? {}
    assert.ok(props.language, 'run_script needs language')
    assert.ok(props.script, 'run_script needs script')
    assert.ok(props.timeout_ms, 'run_script should accept optional timeout_ms')
    // language should be an enum with applescript + javascript
    const enumVals = props.language.enum ?? []
    assert.ok(enumVals.includes('applescript'), 'language enum must include applescript')
    assert.ok(enumVals.includes('javascript'), 'language enum must include javascript')
  })
})

test('v5 observation tools have the expected required parameters', async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools

    const getUiTree = tools.find(x => x.name === 'get_ui_tree')
    assert.ok(getUiTree.inputSchema?.properties?.window_id, 'get_ui_tree needs window_id')

    const getFocused = tools.find(x => x.name === 'get_focused_element')
    const focusedProps = getFocused.inputSchema?.properties ?? {}
    assert.equal(Object.keys(focusedProps).length, 0, 'get_focused_element takes no params')

    const findEl = tools.find(x => x.name === 'find_element')
    const findProps = findEl.inputSchema?.properties ?? {}
    assert.ok(findProps.window_id, 'find_element needs window_id')
    assert.ok(findProps.role && findProps.label && findProps.value,
      'find_element should accept role/label/value criteria')
  })
})

// ── Property 12: Tool response field completeness (schema presence check) ─────
// Verify get_window, get_cursor_window, activate_app, activate_window schemas
// have the expected parameter fields registered

test('Property 12 (schema presence): new v4 tool schemas have correct parameter fields', async () => {
  await withClient(async (client) => {
    const tools = (await client.listTools()).tools

    // get_window: must have window_id
    const getWindow = tools.find(t => t.name === 'get_window')
    assert.ok(getWindow, 'get_window should exist')
    assert.ok(getWindow.inputSchema?.properties?.window_id, 'get_window needs window_id')
    assert.deepEqual(
      Object.keys(getWindow.inputSchema.properties).sort(),
      ['window_id'],
      'get_window should only have window_id param'
    )

    // get_cursor_window: no required params
    const getCursorWindow = tools.find(t => t.name === 'get_cursor_window')
    assert.ok(getCursorWindow, 'get_cursor_window should exist')
    const cursorProps = Object.keys(getCursorWindow.inputSchema?.properties ?? {})
    assert.equal(cursorProps.length, 0, 'get_cursor_window should have no parameters')

    // activate_app: must have bundle_id and timeout_ms
    const activateApp = tools.find(t => t.name === 'activate_app')
    assert.ok(activateApp, 'activate_app should exist')
    const appProps = Object.keys(activateApp.inputSchema?.properties ?? {}).sort()
    assert.ok(appProps.includes('bundle_id'), 'activate_app needs bundle_id')
    assert.ok(appProps.includes('timeout_ms'), 'activate_app needs timeout_ms')

    // activate_window: must have window_id and timeout_ms
    const activateWindow = tools.find(t => t.name === 'activate_window')
    assert.ok(activateWindow, 'activate_window should exist')
    const winProps = Object.keys(activateWindow.inputSchema?.properties ?? {}).sort()
    assert.ok(winProps.includes('window_id'), 'activate_window needs window_id')
    assert.ok(winProps.includes('timeout_ms'), 'activate_window needs timeout_ms')
  })
})
