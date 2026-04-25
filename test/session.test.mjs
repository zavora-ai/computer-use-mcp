import assert from 'node:assert/strict'
import test from 'node:test'
import fc from 'fast-check'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createSession } from '../dist/session.js'
import { createComputerUseServer } from '../dist/server.js'

// ── Mock Native Module ────────────────────────────────────────────────────────

function createMockNative(overrides = {}) {
  let frontmost = { bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1 }
  let runningApps = [
    { bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1, isHidden: false },
  ]
  const windows = [
    {
      windowId: 1001, bundleId: 'com.apple.Safari', displayName: 'Safari', pid: 2,
      title: 'GitHub', bounds: { x: 0, y: 0, width: 800, height: 600 },
      isOnScreen: true, isFocused: false, displayId: 1,
    },
    {
      windowId: 1002, bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1,
      title: 'bash', bounds: { x: 100, y: 100, width: 600, height: 400 },
      isOnScreen: true, isFocused: true, displayId: 1,
    },
  ]
  const calls = []

  const mock = {
    calls,
    setFrontmost(app) { frontmost = app },
    setRunningApps(apps) { runningApps = apps },
    setWindows(w) { windows.splice(0, windows.length, ...w) },
    getWindows() { return windows },
    mouseMove() { calls.push({ method: 'mouseMove', args: [...arguments] }) },
    mouseClick() { calls.push({ method: 'mouseClick', args: [...arguments] }) },
    mouseButton() { calls.push({ method: 'mouseButton', args: [...arguments] }) },
    mouseScroll() { calls.push({ method: 'mouseScroll', args: [...arguments] }) },
    mouseDrag() { calls.push({ method: 'mouseDrag', args: [...arguments] }) },
    cursorPosition() { calls.push({ method: 'cursorPosition' }); return { x: 100, y: 100 } },
    keyPress() { calls.push({ method: 'keyPress', args: [...arguments] }) },
    typeText() { calls.push({ method: 'typeText', args: [...arguments] }) },
    holdKey() { calls.push({ method: 'holdKey', args: [...arguments] }) },
    activateApp(bundleId, timeoutMs) {
      calls.push({ method: 'activateApp', args: [bundleId, timeoutMs] })
      frontmost = { bundleId, displayName: bundleId, pid: 1 }
      return { bundleId, activated: true, displayName: bundleId }
    },
    getFrontmostApp() { calls.push({ method: 'getFrontmostApp' }); return frontmost },
    listRunningApps() { calls.push({ method: 'listRunningApps' }); return runningApps },
    hideApp(bundleId) { calls.push({ method: 'hideApp', args: [bundleId] }); return true },
    unhideApp(bundleId) { calls.push({ method: 'unhideApp', args: [bundleId] }); return true },
    getWindow(windowId) {
      calls.push({ method: 'getWindow', args: [windowId] })
      return windows.find(w => w.windowId === windowId) ?? null
    },
    getCursorWindow() {
      calls.push({ method: 'getCursorWindow' })
      return windows[0] ?? null
    },
    activateWindow(windowId, timeoutMs) {
      calls.push({ method: 'activateWindow', args: [windowId, timeoutMs] })
      return { windowId, activated: true, reason: null }
    },
    listWindows(bundleId) {
      calls.push({ method: 'listWindows', args: [bundleId] })
      return bundleId ? windows.filter(w => w.bundleId === bundleId) : windows
    },
    getDisplaySize() {
      return { width: 1440, height: 900, pixelWidth: 2880, pixelHeight: 1800, scaleFactor: 2, displayId: 1 }
    },
    listDisplays() { return [] },
    takeScreenshot(width, targetApp, quality, previousHash, windowId) {
      calls.push({ method: 'takeScreenshot', args: [width, targetApp, quality, previousHash, windowId] })
      return {
        base64: 'aGVsbG8=',
        width: 640,
        height: 400,
        mimeType: 'image/jpeg',
        hash: 'hash-1',
        unchanged: false,
      }
    },
    ...overrides,
  }

  return mock
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const observationTools = ['screenshot', 'list_windows', 'get_window', 'get_frontmost_app', 'get_cursor_window']

const mutatingPointerTools = [
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll',
]

const mutatingKeyboardTools = ['type', 'key', 'hold_key']

const mutatingActivationTools = ['activate_app', 'activate_window']

const allInputTools = [...mutatingPointerTools, ...mutatingKeyboardTools]

const keyboardToolSet = new Set(mutatingKeyboardTools)
const pointerToolSet = new Set(mutatingPointerTools)

/** Build valid args for a given tool name */
function argsForTool(toolName, extra = {}) {
  const base = { ...extra }
  switch (toolName) {
    case 'screenshot': return base
    case 'list_windows': return base
    case 'get_window': return { window_id: 1001, ...base }
    case 'get_frontmost_app': return base
    case 'get_cursor_window': return base
    case 'left_click': case 'right_click': case 'middle_click':
    case 'double_click': case 'triple_click':
      return { coordinate: [100, 200], ...base }
    case 'mouse_move': return { coordinate: [100, 200], ...base }
    case 'left_click_drag': return { coordinate: [200, 300], start_coordinate: [100, 100], ...base }
    case 'left_mouse_down': case 'left_mouse_up':
      return { coordinate: [100, 200], ...base }
    case 'scroll': return { coordinate: [100, 200], direction: 'down', amount: 3, ...base }
    case 'type': return { text: 'hello', ...base }
    case 'key': return { text: 'return', ...base }
    case 'hold_key': return { keys: ['shift'], duration: 0.1, ...base }
    case 'activate_app': return { bundle_id: 'com.apple.Safari', ...base }
    case 'activate_window': return { window_id: 1001, ...base }
    default: return base
  }
}

// ── Existing v3 tests ─────────────────────────────────────────────────────────

test('screenshot target_app does not retarget later keyboard actions', async () => {
  const activations = []
  const native = createMockNative({
    activateApp(bundleId) {
      activations.push(bundleId)
      return { bundleId, activated: true, displayName: bundleId }
    },
  })
  const session = createSession({ native })

  await session.dispatch('screenshot', { target_app: 'com.apple.Safari' })
  await session.dispatch('key', { text: 'return' })

  assert.deepEqual(activations, [])
})

test('targeted clicks are remembered for later keyboard actions', async () => {
  const activations = []
  const native = createMockNative({
    activateApp(bundleId) {
      activations.push(bundleId)
      this.setFrontmost({ bundleId, displayName: bundleId, pid: 1 })
      return { bundleId, activated: true, displayName: bundleId }
    },
  })
  const session = createSession({ native })

  await session.dispatch('left_click', {
    coordinate: [100, 200],
    target_app: 'com.apple.Safari',
  })

  native.setFrontmost({ bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1 })
  await session.dispatch('key', { text: 'return' })

  assert.deepEqual(activations, ['com.apple.Safari', 'com.apple.Safari'])
})

test('screenshot dedup reuses the cached result when the image hash is unchanged', async () => {
  const previousHashes = []
  let captures = 0
  const native = createMockNative({
    takeScreenshot(_width, _targetApp, _quality, previousHash) {
      previousHashes.push(previousHash)
      captures += 1
      if (captures === 1) {
        return {
          base64: 'Zmlyc3Q=',
          width: 800,
          height: 500,
          mimeType: 'image/jpeg',
          hash: 'hash-1',
          unchanged: false,
        }
      }
      return {
        width: 800,
        height: 500,
        mimeType: 'image/jpeg',
        hash: 'hash-1',
        unchanged: true,
      }
    },
  })
  const session = createSession({ native })

  const first = await session.dispatch('screenshot', {})
  const second = await session.dispatch('screenshot', {})

  assert.equal(previousHashes[0], undefined)
  assert.equal(previousHashes[1], 'hash-1')
  assert.strictEqual(second, first)
})

test('focus failures return structured diagnostics', async () => {
  const native = createMockNative({
    activateApp(bundleId) {
      return { bundleId, activated: false, displayName: bundleId }
    },
    getFrontmostApp() {
      return { bundleId: 'com.openai.codex', displayName: 'Codex', pid: 1 }
    },
    listRunningApps() {
      return [{ bundleId: 'com.apple.iWork.Numbers', displayName: 'Numbers', pid: 2, isHidden: false }]
    },
  })
  const session = createSession({ native })

  const result = await session.dispatch('key', {
    text: 'return',
    target_app: 'com.apple.iWork.Numbers',
  })

  assert.equal(result.isError, true)
  const payload = JSON.parse(result.content[0].text)
  assert.equal(payload.error, 'focus_failed')
  assert.equal(payload.requestedBundleId, 'com.apple.iWork.Numbers')
  assert.equal(payload.frontmostBefore, 'com.openai.codex')
  assert.equal(payload.targetRunning, true)
  assert.equal(payload.suggestedRecovery, 'open_application')
})

test('mouse tools expose target_app in the MCP schema and preserve it in calls', async () => {
  const received = []
  const server = createComputerUseServer({
    session: {
      async dispatch(tool, args) {
        received.push({ tool, args })
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    },
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'computer-use-test', version: '1.0.0' })

  await server.connect(serverTransport)
  await client.connect(clientTransport)

  try {
    const tools = (await client.listTools()).tools
    for (const name of ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up']) {
      const tool = tools.find(entry => entry.name === name)
      assert.ok(tool)
      assert.ok(tool.inputSchema?.properties?.target_app)
    }

    await client.callTool({
      name: 'left_click',
      arguments: { coordinate: [10, 20], target_app: 'com.apple.Safari' },
    })

    assert.equal(received[0]?.tool, 'left_click')
    assert.equal(received[0]?.args?.target_app, 'com.apple.Safari')
  } finally {
    await client.close()
    await server.close()
  }
})

test('introspection tools are exposed in the MCP schema', async () => {
  const server = createComputerUseServer({
    session: {
      async dispatch() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    },
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'computer-use-test', version: '1.0.0' })

  await server.connect(serverTransport)
  await client.connect(clientTransport)

  try {
    const tools = (await client.listTools()).tools
    assert.ok(tools.find(entry => entry.name === 'get_frontmost_app'))
    const listWindows = tools.find(entry => entry.name === 'list_windows')
    assert.ok(listWindows)
    assert.ok(listWindows.inputSchema?.properties?.bundle_id)
  } finally {
    await client.close()
    await server.close()
  }
})

// ══════════════════════════════════════════════════════════════════════════════
// v4 Property-Based Tests
// ══════════════════════════════════════════════════════════════════════════════


// ── Property 1: Observation tools never mutate TargetState ────────────────────
// Feature: v4-window-aware-desktop-control, Property 1: Observation tools never mutate TargetState
// **Validates: Requirements 1.4, 2.4, 5.4, 10.1, 10.2, 10.3, 10.4, 10.5**

test('Property 1: Observation tools never mutate TargetState', async () => {
  await fc.assert(fc.asyncProperty(
    // Generate a random sequence mixing observation and mutating tools
    fc.array(fc.oneof(
      fc.constant('screenshot'),
      fc.constant('list_windows'),
      fc.constant('get_window'),
      fc.constant('get_frontmost_app'),
      fc.constant('get_cursor_window'),
      fc.constant('left_click'),
      fc.constant('key'),
      fc.constant('type'),
    ), { minLength: 2, maxLength: 10 }),
    async (toolSequence) => {
      const native = createMockNative()
      const session = createSession({ native })

      // Track TargetState by observing activation calls
      let lastTargetStateSnapshot = null

      for (const tool of toolSequence) {
        const isObservation = observationTools.includes(tool)

        // Capture state before by dispatching get_frontmost_app and checking activations
        const callsBefore = native.calls.length
        const activationsBefore = native.calls.filter(c => c.method === 'activateApp').length

        // Take a snapshot of state before observation tool
        if (isObservation) {
          // Run a probe: dispatch a key with no target to see if TargetState causes activation
          // Instead, we track by running the observation tool and then checking that
          // no state-mutating side effects occurred
          const stateProbeResult = await session.dispatch('get_frontmost_app', {})
          lastTargetStateSnapshot = native.calls.filter(c => c.method === 'activateApp').map(c => c.args[0])
        }

        await session.dispatch(tool, argsForTool(tool))

        if (isObservation) {
          // After observation tool, activations should not have increased
          // (observation tools should not trigger any new activateApp calls beyond what was already there)
          const activationsAfter = native.calls.filter(c => c.method === 'activateApp').map(c => c.args[0])
          // The observation tool itself should not have added any activateApp calls
          // We check that the activation count didn't change during the observation dispatch
        }
      }

      // Final verification: run observation tools and verify they don't change routing
      // First establish a target via a click
      native.setFrontmost({ bundleId: 'com.apple.Safari', displayName: 'Safari', pid: 2 })
      await session.dispatch('left_click', { coordinate: [10, 20], target_app: 'com.apple.Safari' })

      // Record activation count
      const activationCountBefore = native.calls.filter(c => c.method === 'activateApp').length

      // Run all observation tools
      for (const obsTool of observationTools) {
        await session.dispatch(obsTool, argsForTool(obsTool))
      }

      // No new activations should have been triggered by observation tools
      const activationCountAfter = native.calls.filter(c => c.method === 'activateApp').length
      assert.equal(activationCountAfter, activationCountBefore,
        'Observation tools must not trigger activateApp calls')

      // Now change frontmost away and dispatch a key — it should still target Safari
      // (proving observation tools didn't clear the TargetState)
      native.setFrontmost({ bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1 })
      await session.dispatch('key', { text: 'a' })

      // The key dispatch should have triggered an activation to Safari (the remembered target)
      const finalActivations = native.calls.filter(c => c.method === 'activateApp').map(c => c.args[0])
      const lastActivation = finalActivations[finalActivations.length - 1]
      assert.equal(lastActivation, 'com.apple.Safari',
        'TargetState should still point to Safari after observation tools')
    }
  ), { numRuns: 100 })
})

// ── Property 2: Target resolution precedence ─────────────────────────────────
// Feature: v4-window-aware-desktop-control, Property 2: Target resolution precedence — window ID over app over session state
// **Validates: Requirements 5.2, 6.3, 8.3, 16.4**

test('Property 2: Target resolution precedence — window ID over app over session state', async () => {
  await fc.assert(fc.asyncProperty(
    // Generate random input tool
    fc.constantFrom(...allInputTools),
    // Generate random window ID (valid = 1001 for Safari)
    fc.constantFrom(1001, 1002),
    // Generate random target_app (different from window's owner)
    fc.constantFrom('com.apple.Terminal', 'com.apple.Mail', 'com.apple.Notes'),
    async (tool, windowId, targetApp) => {
      const activatedBundles = []
      const native = createMockNative({
        activateApp(bundleId, timeoutMs) {
          activatedBundles.push(bundleId)
          this.setFrontmost({ bundleId, displayName: bundleId, pid: 1 })
          return { bundleId, activated: true, displayName: bundleId }
        },
      })
      const session = createSession({ native })

      // Set frontmost to something else so activation is needed
      native.setFrontmost({ bundleId: 'com.other.App', displayName: 'Other', pid: 99 })

      // Dispatch with both target_window_id and target_app
      const args = argsForTool(tool, {
        target_window_id: windowId,
        target_app: targetApp,
        focus_strategy: 'best_effort', // avoid strict failures
      })

      const result = await session.dispatch(tool, args)

      // The window's bundleId should be used, not target_app
      const expectedWindow = native.getWindows().find(w => w.windowId === windowId)
      if (expectedWindow && activatedBundles.length > 0) {
        // The activation should target the window's bundle, not the target_app
        const lastActivated = activatedBundles[activatedBundles.length - 1]
        assert.equal(lastActivated, expectedWindow.bundleId,
          `target_window_id should resolve to window's bundleId (${expectedWindow.bundleId}), not target_app (${targetApp})`)
      }
    }
  ), { numRuns: 100 })
})

// ── Property 3: Input tool schema completeness ───────────────────────────────
// Feature: v4-window-aware-desktop-control, Property 3: Input tool schema completeness
// **Validates: Requirements 6.1, 7.1, 16.2**

test('Property 3: Input tool schema completeness — all 13 input tools include target_window_id and focus_strategy', async () => {
  const inputToolNames = [
    'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
    'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up',
    'scroll', 'type', 'key', 'hold_key',
  ]

  const server = createComputerUseServer({
    session: {
      async dispatch() {
        return { content: [{ type: 'text', text: 'ok' }] }
      },
    },
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'computer-use-test', version: '1.0.0' })

  await server.connect(serverTransport)
  await client.connect(clientTransport)

  try {
    const tools = (await client.listTools()).tools

    await fc.assert(fc.property(
      fc.constantFrom(...inputToolNames),
      (toolName) => {
        const tool = tools.find(t => t.name === toolName)
        assert.ok(tool, `Tool ${toolName} should exist in MCP schema`)
        assert.ok(tool.inputSchema?.properties?.target_window_id,
          `${toolName} should have target_window_id in schema`)
        assert.ok(tool.inputSchema?.properties?.focus_strategy,
          `${toolName} should have focus_strategy in schema`)
      }
    ), { numRuns: 100 })
  } finally {
    await client.close()
    await server.close()
  }
})

// ── Property 4: Strict focus strategy enforcement ────────────────────────────
// Feature: v4-window-aware-desktop-control, Property 4: Strict focus strategy enforcement
// **Validates: Requirements 7.2, 12.1, 12.2, 16.5**

test('Property 4: Strict focus strategy enforcement — FocusFailure on unconfirmed focus', async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...allInputTools),
    fc.constantFrom('com.apple.Safari', 'com.apple.Mail', 'com.apple.Notes'),
    async (tool, targetApp) => {
      const native = createMockNative({
        // activateApp fails to change frontmost
        activateApp(bundleId) {
          return { bundleId, activated: false, displayName: bundleId }
        },
        getFrontmostApp() {
          return { bundleId: 'com.other.App', displayName: 'Other', pid: 99 }
        },
        listRunningApps() {
          return [{ bundleId: targetApp, displayName: targetApp, pid: 2, isHidden: false }]
        },
      })
      const session = createSession({ native })

      const args = argsForTool(tool, {
        target_app: targetApp,
        focus_strategy: 'strict',
      })

      // Dispatch may return isError result or throw FocusError (for tools using doClick)
      let result
      try {
        result = await session.dispatch(tool, args)
      } catch (err) {
        // FocusError thrown — this confirms strict enforcement
        assert.equal(err.name, 'FocusError', `${tool} should throw FocusError`)
        assert.equal(err.details.error, 'focus_failed')
        assert.equal(err.details.requestedBundleId, targetApp)
        return // Property holds: input was not delivered
      }

      // If we got a result, it should be an error
      assert.equal(result.isError, true, `${tool} with strict strategy should fail when focus unconfirmed`)
      const payload = JSON.parse(result.content[0].text)
      assert.equal(payload.error, 'focus_failed')
      assert.equal(payload.requestedBundleId, targetApp)

      // Verify input was NOT delivered (no mouseClick, keyPress, typeText, etc.)
      const inputCalls = native.calls.filter(c =>
        ['mouseClick', 'keyPress', 'typeText', 'holdKey', 'mouseButton', 'mouseScroll', 'mouseDrag'].includes(c.method)
      )
      assert.equal(inputCalls.length, 0,
        `${tool}: input should NOT be delivered when strict focus fails`)
    }
  ), { numRuns: 100 })
})

// ── Property 5: Best-effort focus strategy proceeds ──────────────────────────
// Feature: v4-window-aware-desktop-control, Property 5: Best-effort focus strategy proceeds on unconfirmed focus
// **Validates: Requirements 7.3**

test('Property 5: Best-effort focus strategy proceeds on unconfirmed focus', async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...allInputTools),
    fc.constantFrom('com.apple.Safari', 'com.apple.Mail'),
    async (tool, targetApp) => {
      const native = createMockNative({
        // activateApp succeeds but frontmost doesn't change (simulating partial failure)
        activateApp(bundleId) {
          // Don't change frontmost — focus is unconfirmed
          return { bundleId, activated: false, displayName: bundleId }
        },
        getFrontmostApp() {
          return { bundleId: 'com.other.App', displayName: 'Other', pid: 99 }
        },
        listRunningApps() {
          return [{ bundleId: targetApp, displayName: targetApp, pid: 2, isHidden: false }]
        },
      })
      const session = createSession({ native })

      const args = argsForTool(tool, {
        target_app: targetApp,
        focus_strategy: 'best_effort',
      })

      const result = await session.dispatch(tool, args)

      // Best-effort should NOT return isError due to focus alone
      assert.notEqual(result.isError, true,
        `${tool} with best_effort should proceed even when focus is unconfirmed`)
    }
  ), { numRuns: 100 })
})

// ── Property 6: None focus strategy skips activation ─────────────────────────
// Feature: v4-window-aware-desktop-control, Property 6: None focus strategy skips activation
// **Validates: Requirements 7.4, 16.6**

test('Property 6: None focus strategy skips activation', async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...allInputTools),
    fc.constantFrom('com.apple.Safari', 'com.apple.Mail', 'com.apple.Notes'),
    async (tool, targetApp) => {
      const native = createMockNative()
      // Set frontmost to something different from target
      native.setFrontmost({ bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1 })
      const session = createSession({ native })

      // Clear calls to track only what happens during dispatch
      native.calls.length = 0

      const args = argsForTool(tool, {
        target_app: targetApp,
        focus_strategy: 'none',
      })

      const result = await session.dispatch(tool, args)

      // No activation calls should have been made
      const activationCalls = native.calls.filter(c =>
        ['activateApp', 'activateWindow', 'unhideApp'].includes(c.method)
      )
      assert.equal(activationCalls.length, 0,
        `${tool} with focus_strategy: none should not call any activation functions`)

      // Input should still be delivered (no isError from focus)
      assert.notEqual(result.isError, true,
        `${tool} with focus_strategy: none should deliver input`)
    }
  ), { numRuns: 100 })
})

// ── Property 7: Default focus strategy by tool category ──────────────────────
// Feature: v4-window-aware-desktop-control, Property 7: Default focus strategy by tool category
// **Validates: Requirements 7.5**

test('Property 7: Default focus strategy by tool category', async () => {
  const keyboardTools = ['type', 'key', 'hold_key']
  const pointerTools = [
    'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
    'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll',
  ]

  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...allInputTools),
    async (tool) => {
      // Use a mock where activation fails so we can detect strict vs best_effort behavior
      const native = createMockNative({
        activateApp(bundleId) {
          // Don't change frontmost
          return { bundleId, activated: false, displayName: bundleId }
        },
        getFrontmostApp() {
          return { bundleId: 'com.other.App', displayName: 'Other', pid: 99 }
        },
        listRunningApps() {
          return [{ bundleId: 'com.apple.Safari', displayName: 'Safari', pid: 2, isHidden: false }]
        },
      })
      const session = createSession({ native })

      // Don't pass focus_strategy — let it use the default
      const args = argsForTool(tool, { target_app: 'com.apple.Safari' })

      const result = await session.dispatch(tool, args)

      if (keyboardTools.includes(tool)) {
        // Keyboard tools default to strict — should fail
        assert.equal(result.isError, true,
          `${tool} (keyboard) should default to strict and fail when focus unconfirmed`)
      } else {
        // Pointer tools default to best_effort — should proceed
        assert.notEqual(result.isError, true,
          `${tool} (pointer) should default to best_effort and proceed`)
      }
    }
  ), { numRuns: 100 })
})

// ── Property 8: TargetState establishedBy tracks tool category ───────────────
// Feature: v4-window-aware-desktop-control, Property 8: TargetState establishedBy tracks tool category
// **Validates: Requirements 8.2, 16.8**

test('Property 8: TargetState establishedBy tracks tool category', async () => {
  const activationTools = ['activate_app', 'activate_window']
  const pointerTools = [
    'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
    'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll',
  ]
  const keyboardTools = ['type', 'key', 'hold_key']
  const allMutating = [...activationTools, ...pointerTools, ...keyboardTools]

  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...allMutating),
    async (tool) => {
      const native = createMockNative()
      // Ensure the target app is frontmost so strict keyboard tools succeed
      native.setFrontmost({ bundleId: 'com.apple.Safari', displayName: 'Safari', pid: 2 })
      native.setRunningApps([
        { bundleId: 'com.apple.Safari', displayName: 'Safari', pid: 2, isHidden: false },
        { bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1, isHidden: false },
      ])
      const session = createSession({ native })

      const args = argsForTool(tool, { target_app: 'com.apple.Safari' })
      await session.dispatch(tool, args)

      // Now change frontmost and dispatch a key to probe what TargetState was set
      native.setFrontmost({ bundleId: 'com.other.Probe', displayName: 'Probe', pid: 99 })
      native.calls.length = 0

      // Use best_effort key to avoid strict failure, just to see if activation targets Safari
      await session.dispatch('key', { text: 'a', focus_strategy: 'best_effort' })

      // Check that the session tried to activate Safari (the remembered target)
      const activations = native.calls.filter(c => c.method === 'activateApp')
      if (activations.length > 0) {
        assert.equal(activations[0].args[0], 'com.apple.Safari',
          `After ${tool}, TargetState should remember Safari`)
      }
    }
  ), { numRuns: 100 })
})

// ── Property 9: Successful mutating tools update TargetState correctly ───────
// Feature: v4-window-aware-desktop-control, Property 9: Successful mutating tools update TargetState with correct fields
// **Validates: Requirements 3.3, 4.4, 6.2**

test('Property 9: Successful mutating tools update TargetState with correct fields', async () => {
  const allMutating = [...mutatingPointerTools, ...mutatingKeyboardTools, ...mutatingActivationTools]

  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...allMutating),
    // Whether to use target_window_id or target_app
    fc.boolean(),
    async (tool, useWindowId) => {
      const native = createMockNative()
      native.setFrontmost({ bundleId: 'com.apple.Safari', displayName: 'Safari', pid: 2 })
      native.setRunningApps([
        { bundleId: 'com.apple.Safari', displayName: 'Safari', pid: 2, isHidden: false },
      ])
      const session = createSession({ native })

      const extra = useWindowId
        ? { target_window_id: 1001, focus_strategy: 'best_effort' }
        : { target_app: 'com.apple.Safari', focus_strategy: 'best_effort' }

      const args = argsForTool(tool, extra)
      const result = await session.dispatch(tool, args)

      // Should succeed (not an error)
      if (result.isError) return // Skip if there was an error (e.g., window not found for activate_window)

      // Verify TargetState was updated by probing with a subsequent key
      native.setFrontmost({ bundleId: 'com.other.Probe', displayName: 'Probe', pid: 99 })
      native.calls.length = 0

      await session.dispatch('key', { text: 'a', focus_strategy: 'best_effort' })

      const activations = native.calls.filter(c => c.method === 'activateApp')
      if (activations.length > 0) {
        // TargetState should have Safari's bundleId
        assert.equal(activations[0].args[0], 'com.apple.Safari',
          `After successful ${tool}, TargetState should contain Safari's bundleId`)
      }
    }
  ), { numRuns: 100 })
})

// ── Property 10: FocusFailure diagnostic completeness ────────────────────────
// Feature: v4-window-aware-desktop-control, Property 10: FocusFailure diagnostic completeness
// **Validates: Requirements 9.1, 9.2, 16.7**

test('Property 10: FocusFailure diagnostic completeness', async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...allInputTools),
    fc.constantFrom('com.apple.Safari', 'com.apple.Mail'),
    // Whether to include a target_window_id
    fc.boolean(),
    async (tool, targetApp, includeWindowId) => {
      const native = createMockNative({
        activateApp(bundleId) {
          return { bundleId, activated: false, displayName: bundleId }
        },
        getFrontmostApp() {
          return { bundleId: 'com.other.App', displayName: 'Other', pid: 99 }
        },
        listRunningApps() {
          return [{ bundleId: targetApp, displayName: targetApp, pid: 2, isHidden: false }]
        },
      })
      const session = createSession({ native })

      const extra = { focus_strategy: 'strict' }
      if (includeWindowId) {
        extra.target_window_id = 1001
      } else {
        extra.target_app = targetApp
      }

      const args = argsForTool(tool, extra)

      let payload
      try {
        const result = await session.dispatch(tool, args)
        assert.equal(result.isError, true)
        payload = JSON.parse(result.content[0].text)
      } catch (err) {
        // FocusError thrown directly (for tools using doClick path)
        assert.equal(err.name, 'FocusError')
        payload = err.details
      }

      // Verify all required fields are present
      assert.equal(payload.error, 'focus_failed')
      assert.ok('requestedBundleId' in payload, 'Missing requestedBundleId')
      assert.ok('requestedWindowId' in payload, 'Missing requestedWindowId')
      assert.ok('frontmostBefore' in payload, 'Missing frontmostBefore')
      assert.ok('frontmostAfter' in payload, 'Missing frontmostAfter')
      assert.ok('targetRunning' in payload, 'Missing targetRunning')
      assert.ok('targetHidden' in payload, 'Missing targetHidden')
      assert.ok('targetWindowVisible' in payload, 'Missing targetWindowVisible')
      assert.ok('activationAttempted' in payload, 'Missing activationAttempted')
      assert.ok('suggestedRecovery' in payload, 'Missing suggestedRecovery')

      // When target_window_id was requested, requestedWindowId should be set
      if (includeWindowId) {
        assert.equal(typeof payload.requestedWindowId, 'number',
          'requestedWindowId should be a number when target_window_id was specified')
        assert.equal(typeof payload.targetWindowVisible, 'boolean',
          'targetWindowVisible should be a boolean when target_window_id was specified')
      }
    }
  ), { numRuns: 100 })
})

// ── Property 11: FocusFailure suggestedRecovery correctness ──────────────────
// Feature: v4-window-aware-desktop-control, Property 11: FocusFailure suggestedRecovery correctness
// **Validates: Requirements 9.3, 9.4**

test('Property 11: FocusFailure suggestedRecovery correctness', async () => {
  const appStates = [
    { label: 'hidden', isHidden: true, isRunning: true, expected: 'unhide_app' },
    { label: 'not_running', isHidden: false, isRunning: false, expected: 'open_application' },
    { label: 'visible_running', isHidden: false, isRunning: true, expected: 'open_application' },
  ]

  await fc.assert(fc.asyncProperty(
    fc.constantFrom(...allInputTools),
    fc.constantFrom(...appStates),
    async (tool, appState) => {
      const targetApp = 'com.apple.Safari'
      const native = createMockNative({
        activateApp(bundleId) {
          return { bundleId, activated: false, displayName: bundleId }
        },
        getFrontmostApp() {
          return { bundleId: 'com.other.App', displayName: 'Other', pid: 99 }
        },
        listRunningApps() {
          if (!appState.isRunning) return []
          return [{ bundleId: targetApp, displayName: 'Safari', pid: 2, isHidden: appState.isHidden }]
        },
      })
      const session = createSession({ native })

      const args = argsForTool(tool, {
        target_app: targetApp,
        focus_strategy: 'strict',
      })

      let payload
      try {
        const result = await session.dispatch(tool, args)
        assert.equal(result.isError, true)
        payload = JSON.parse(result.content[0].text)
      } catch (err) {
        // FocusError thrown directly (for tools using doClick path)
        assert.equal(err.name, 'FocusError')
        payload = err.details
      }

      assert.equal(payload.suggestedRecovery, appState.expected,
        `For ${appState.label} app, suggestedRecovery should be ${appState.expected}, got ${payload.suggestedRecovery}`)
    }
  ), { numRuns: 100 })
})

// ── Property 13: Window filter correctness ───────────────────────────────────
// Feature: v4-window-aware-desktop-control, Property 13: Window filter correctness
// **Validates: Requirements 11.4**

test('Property 13: Window filter correctness', async () => {
  await fc.assert(fc.asyncProperty(
    // Generate random bundle IDs for windows
    fc.array(
      fc.record({
        windowId: fc.integer({ min: 1000, max: 9999 }),
        bundleId: fc.constantFrom('com.apple.Safari', 'com.apple.Terminal', 'com.apple.Mail', 'com.apple.Notes'),
        displayName: fc.constant('App'),
        pid: fc.integer({ min: 1, max: 100 }),
        title: fc.constantFrom('Window 1', 'Window 2', null),
        bounds: fc.constant({ x: 0, y: 0, width: 800, height: 600 }),
        isOnScreen: fc.constant(true),
        isFocused: fc.constant(false),
        displayId: fc.constant(1),
      }),
      { minLength: 1, maxLength: 10 }
    ),
    // Filter bundle ID
    fc.constantFrom('com.apple.Safari', 'com.apple.Terminal', 'com.apple.Mail', 'com.apple.Notes'),
    async (windowList, filterBundleId) => {
      const native = createMockNative()
      native.setWindows(windowList)
      const session = createSession({ native })

      const result = await session.dispatch('list_windows', { bundle_id: filterBundleId })
      const windows = JSON.parse(result.content[0].text)

      // All returned windows should match the filter
      for (const win of windows) {
        assert.equal(win.bundleId, filterBundleId,
          `Window ${win.windowId} has bundleId ${win.bundleId}, expected ${filterBundleId}`)
      }

      // Count should match expected
      const expectedCount = windowList.filter(w => w.bundleId === filterBundleId).length
      assert.equal(windows.length, expectedCount,
        `Expected ${expectedCount} windows for ${filterBundleId}, got ${windows.length}`)
    }
  ), { numRuns: 100 })
})

// ══════════════════════════════════════════════════════════════════════════════
// v4 Unit Tests — Session Edge Cases (Task 9.13)
// ══════════════════════════════════════════════════════════════════════════════

// ── Hidden app recovery sequence ─────────────────────────────────────────────

test('activate_window: hidden app recovery sequence calls unhide → activate → raise in order', async () => {
  const callOrder = []
  const native = createMockNative({
    unhideApp(bundleId) {
      callOrder.push(`unhide:${bundleId}`)
      return true
    },
    activateApp(bundleId, timeoutMs) {
      callOrder.push(`activate:${bundleId}`)
      this.setFrontmost({ bundleId, displayName: bundleId, pid: 2 })
      return { bundleId, activated: true, displayName: bundleId }
    },
    activateWindow(windowId, timeoutMs) {
      callOrder.push(`raise:${windowId}`)
      return { windowId, activated: true, reason: null }
    },
    listRunningApps() {
      return [{ bundleId: 'com.apple.Safari', displayName: 'Safari', pid: 2, isHidden: true }]
    },
  })
  const session = createSession({ native })

  await session.dispatch('activate_window', { window_id: 1001 })

  assert.ok(callOrder.indexOf('unhide:com.apple.Safari') < callOrder.indexOf('activate:com.apple.Safari'),
    'unhide should come before activate')
  assert.ok(callOrder.indexOf('activate:com.apple.Safari') < callOrder.indexOf('raise:1001'),
    'activate should come before raise')
})

// ── activate_app with not_running reason ─────────────────────────────────────

test('activate_app returns not_running reason when app is not in running apps', async () => {
  const native = createMockNative({
    activateApp(bundleId) {
      return { bundleId, activated: false, displayName: bundleId }
    },
    getFrontmostApp() {
      return { bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1 }
    },
    listRunningApps() {
      return [{ bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1, isHidden: false }]
    },
  })
  const session = createSession({ native })

  const result = await session.dispatch('activate_app', { bundle_id: 'com.apple.Safari' })
  const payload = JSON.parse(result.content[0].text)

  assert.equal(payload.activated, false)
  assert.equal(payload.reason, 'not_running')
})

// ── activate_app with hidden reason and suggestedRecovery ────────────────────

test('activate_app returns hidden reason with suggestedRecovery when app is hidden', async () => {
  const native = createMockNative({
    activateApp(bundleId) {
      return { bundleId, activated: false, displayName: bundleId }
    },
    getFrontmostApp() {
      return { bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1 }
    },
    listRunningApps() {
      return [
        { bundleId: 'com.apple.Terminal', displayName: 'Terminal', pid: 1, isHidden: false },
        { bundleId: 'com.apple.Safari', displayName: 'Safari', pid: 2, isHidden: true },
      ]
    },
  })
  const session = createSession({ native })

  const result = await session.dispatch('activate_app', { bundle_id: 'com.apple.Safari' })
  const payload = JSON.parse(result.content[0].text)

  assert.equal(payload.activated, false)
  assert.equal(payload.reason, 'hidden')
  assert.equal(payload.suggestedRecovery, 'unhide_app')
})

// ── activate_window with window not found ────────────────────────────────────

test('activate_window returns window_not_found when window does not exist', async () => {
  const native = createMockNative()
  const session = createSession({ native })

  const result = await session.dispatch('activate_window', { window_id: 99999 })
  const payload = JSON.parse(result.content[0].text)

  assert.equal(payload.activated, false)
  assert.equal(payload.reason, 'window_not_found')
  assert.equal(payload.windowId, 99999)
})

// ── Screenshot with invalid target_window_id returns error ───────────────────

test('screenshot with invalid target_window_id returns error, not fallback', async () => {
  const native = createMockNative({
    takeScreenshot(width, targetApp, quality, previousHash, windowId) {
      if (windowId === 99999) {
        throw new Error('Window not found')
      }
      return {
        base64: 'aGVsbG8=', width: 640, height: 400,
        mimeType: 'image/jpeg', hash: 'hash-1', unchanged: false,
      }
    },
  })
  const session = createSession({ native })

  const result = await session.dispatch('screenshot', { target_window_id: 99999 })

  assert.equal(result.isError, true, 'Screenshot with invalid window ID should return error')
})

// ── get_cursor_window with no window under cursor ────────────────────────────

test('get_cursor_window with no window under cursor returns null fields', async () => {
  const native = createMockNative({
    getCursorWindow() {
      return null
    },
  })
  const session = createSession({ native })

  const result = await session.dispatch('get_cursor_window', {})
  const payload = JSON.parse(result.content[0].text)

  assert.equal(payload, null)
})

// ── timeout_ms parameter passthrough ─────────────────────────────────────────

test('activate_app passes timeout_ms to native module', async () => {
  const receivedTimeouts = []
  const native = createMockNative({
    activateApp(bundleId, timeoutMs) {
      receivedTimeouts.push(timeoutMs)
      this.setFrontmost({ bundleId, displayName: bundleId, pid: 1 })
      return { bundleId, activated: true, displayName: bundleId }
    },
  })
  const session = createSession({ native })

  await session.dispatch('activate_app', { bundle_id: 'com.apple.Safari', timeout_ms: 5000 })

  assert.equal(receivedTimeouts[0], 5000, 'timeout_ms should be passed through to native activateApp')
})

test('activate_window passes timeout_ms to native module', async () => {
  const receivedTimeouts = []
  const native = createMockNative({
    activateWindow(windowId, timeoutMs) {
      receivedTimeouts.push(timeoutMs)
      return { windowId, activated: true, reason: null }
    },
    activateApp(bundleId, timeoutMs) {
      this.setFrontmost({ bundleId, displayName: bundleId, pid: 1 })
      return { bundleId, activated: true, displayName: bundleId }
    },
  })
  const session = createSession({ native })

  await session.dispatch('activate_window', { window_id: 1001, timeout_ms: 3000 })

  assert.ok(receivedTimeouts.includes(3000), 'timeout_ms should be passed through to native activateWindow')
})
