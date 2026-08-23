import assert from 'node:assert/strict'
import test from 'node:test'
import { createSession } from '../dist/session.js'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { mapLegacyOpenAiAction } from '../dist/session/openai-compat.js'

function createMockNative() {
  const calls = []
  return {
    calls,
    mouseMove(...args) { calls.push({ method: 'mouseMove', args }) },
    mouseClick(...args) { calls.push({ method: 'mouseClick', args }) },
    mouseButton(...args) { calls.push({ method: 'mouseButton', args }) },
    mouseScroll(...args) { calls.push({ method: 'mouseScroll', args }) },
    mouseDrag(...args) { calls.push({ method: 'mouseDrag', args }) },
    cursorPosition() { return { x: 10, y: 20 } },
    keyPress(...args) { calls.push({ method: 'keyPress', args }) },
    typeText(...args) { calls.push({ method: 'typeText', args }) },
    holdKey(...args) { calls.push({ method: 'holdKey', args }) },
    activateApp(bundleId) { calls.push({ method: 'activateApp', args: [bundleId] }); return { bundleId, activated: true } },
    getFrontmostApp() { return { bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1 } },
    getWindow() { return null },
    getCursorWindow() { return null },
    activateWindow(windowId) { calls.push({ method: 'activateWindow', args: [windowId] }); return { windowId, activated: true, reason: null } },
    listWindows() { return [] },
    listRunningApps() { return [] },
    hideApp() { return true },
    unhideApp() { return true },
    getDisplaySize() { return { width: 1440, height: 900, pixelWidth: 2880, pixelHeight: 1800, scaleFactor: 2, displayId: 1 } },
    listDisplays() { return [] },
    takeScreenshot() {
      return { base64: 'aGVsbG8=', width: 640, height: 400, mimeType: 'image/jpeg', hash: 'h1', unchanged: false }
    },
    getUiTree() { return { role: 'AXWindow', label: null, value: null, bounds: { x: 0, y: 0, width: 100, height: 100 }, actions: [] } },
    getFocusedElement() { return null },
    findElement() { return [] },
    performAction() { return { performed: false, reason: 'not_found' } },
    setElementValue() { return { set: false, reason: 'not_found' } },
    getMenuBar() { return [] },
    pressMenuItem() { return { pressed: false, reason: 'not_found' } },
    listSpaces() { return { supported: true, active_space_id: null, displays: [] } },
    getActiveSpace() { return null },
    createAgentSpace() { return { supported: true, spaceId: 1, attached: true } },
    moveWindowToSpace() { return { moved: true, verified: true } },
    removeWindowFromSpace() { return { removed: true } },
    destroySpace() { return { destroyed: true } },
    drainRunloop() {},
    annotateImage(base64) { return { base64, width: 640, height: 400, mimeType: 'image/jpeg' } },
    cropImage(base64) { return { base64, width: 10, height: 10, mimeType: 'image/png' } },
    prepareDisplay(targetBundleId) { return { targetBundleId, hiddenBundleIds: [] } },
  }
}

test('v6 priority tools are exposed with interruption metadata', async () => {
  const server = createComputerUseServer({
    session: {
      async dispatch() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    },
  })
  const client = await connectInProcess(server)
  try {
    const tools = await client.listTools()
    for (const name of ['doctor', 'policy_status', 'agent_pointer', 'openai_computer']) {
      assert.ok(tools.find(t => t.name === name), `${name} should be registered`)
    }

    const meta = await client.callTool('get_tool_metadata', { tool_name: 'agent_pointer' })
    const body = JSON.parse(meta.content.find(c => c.type === 'text').text)
    assert.equal(body.usesVirtualPointer, true)
    assert.equal(body.movesUserCursor, false)
    assert.equal(body.requiresFocus, false)
  } finally {
    await client.close()
  }
})

test('agent_pointer move does not move the OS cursor', async () => {
  const native = createMockNative()
  const session = createSession({ native })

  const result = await session.dispatch('agent_pointer', {
    action: 'move',
    coordinate: [123, 234],
  })

  assert.equal(result.isError, undefined)
  const body = JSON.parse(result.content[0].text)
  assert.equal(body.x, 123)
  assert.equal(body.y, 234)
  assert.equal(body.visible, true)
  assert.equal(native.calls.some(c => c.method === 'mouseMove'), false)
})

test('agent_pointer syncs native overlay when available', async () => {
  const native = createMockNative()
  native.agentPointerOverlayShow = (...args) => {
    native.calls.push({ method: 'agentPointerOverlayShow', args })
    return { supported: true, native: true, visible: true, x: args[0], y: args[1] }
  }
  native.agentPointerOverlayHide = (...args) => {
    native.calls.push({ method: 'agentPointerOverlayHide', args })
    return { supported: true, native: true, visible: false }
  }
  native.agentPointerOverlayStatus = () => ({ supported: true, native: true, visible: false })
  const session = createSession({ native })

  const move = await session.dispatch('agent_pointer', {
    action: 'move',
    coordinate: [300, 350],
    native_overlay: true,
  })
  assert.equal(move.isError, undefined)
  assert.deepEqual(native.calls.find(c => c.method === 'agentPointerOverlayShow')?.args, [300, 350])
  const body = JSON.parse(move.content[0].text)
  assert.equal(body.nativeOverlay.available, true)
  assert.equal(body.nativeOverlay.status.visible, true)

  await session.dispatch('agent_pointer', { action: 'hide', native_overlay: true })
  assert.equal(native.calls.some(c => c.method === 'agentPointerOverlayHide'), true)
})

test('openai_computer maps batched actions and supports virtual pointer moves', async () => {
  const native = createMockNative()
  const session = createSession({ native })

  const result = await session.dispatch('openai_computer', {
    use_virtual_pointer: true,
    actions: [
      { type: 'move', x: 50, y: 60 },
      { type: 'click', x: 100, y: 120 },
      { type: 'keypress', keys: ['ctrl', 'l'] },
    ],
  })

  assert.equal(result.isError, undefined)
  assert.equal(native.calls.filter(c => c.method === 'mouseMove').length, 1)
  assert.equal(native.calls.filter(c => c.method === 'mouseClick').length, 1)
  assert.deepEqual(native.calls.find(c => c.method === 'keyPress')?.args, ['control+l', undefined])
})

test('legacy OpenAI compatibility mapping is pure and preserves drag, scroll, and target arguments', () => {
  const common = { target_app: 'app.fixture', focus_strategy: 'strict' }
  assert.deepEqual(
    mapLegacyOpenAiAction({ type: 'drag', path: [[1, 2], [8, 9]] }, {
      common, useVirtualPointer: false,
    }),
    {
      actionType: 'drag', tool: 'left_click_drag',
      args: { start_coordinate: [1, 2], coordinate: [8, 9], ...common },
    },
  )
  assert.deepEqual(
    mapLegacyOpenAiAction({ type: 'scroll', x: 5, y: 6, dx: -4 }, {
      common, useVirtualPointer: false,
    }),
    {
      actionType: 'scroll', tool: 'scroll',
      args: { coordinate: [5, 6], direction: 'left', amount: 4, ...common },
    },
  )
  assert.throws(
    () => mapLegacyOpenAiAction({ type: 'drag', path: [[1], [2, 3]] }, {
      common, useVirtualPointer: false,
    }),
    /drag path must contain \[x,y\] points/,
  )
})

test('policy approval gate blocks configured tools until token is supplied', async () => {
  const oldRequire = process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR
  const oldToken = process.env.COMPUTER_USE_APPROVAL_TOKEN
  process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR = 'agent_pointer'
  process.env.COMPUTER_USE_APPROVAL_TOKEN = 'test-token'

  try {
    const session = createSession({ native: createMockNative() })
    const denied = await session.dispatch('agent_pointer', {
      action: 'move',
      coordinate: [1, 2],
    })
    assert.equal(denied.isError, true)
    assert.equal(JSON.parse(denied.content[0].text).error, 'approval_required')

    const allowed = await session.dispatch('agent_pointer', {
      action: 'move',
      coordinate: [1, 2],
      approval_token: 'test-token',
    })
    assert.equal(allowed.isError, undefined)
  } finally {
    if (oldRequire === undefined) delete process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR
    else process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR = oldRequire
    if (oldToken === undefined) delete process.env.COMPUTER_USE_APPROVAL_TOKEN
    else process.env.COMPUTER_USE_APPROVAL_TOKEN = oldToken
  }
})
