import assert from 'node:assert/strict'
import test from 'node:test'
import { handleAccessibilityTool, probeAccessibilityTree } from '../dist/session/accessibility-handlers.js'

// v7.6 R7: get_app_capabilities says whether an app has real controls, not just a window.

const node = (role, label = null, children = []) => ({
  role, label, value: null, sensitive: false, sensitivitySignals: [],
  bounds: { x: 0, y: 0, width: 10, height: 10 }, actions: [], children,
})
const chrome = () => [node('AXButton', 'close button'), node('AXButton', 'minimize button'), node('AXButton', 'zoom button')]

function context({ tree, windows, running = true, throws } = {}) {
  const calls = []
  const native = {
    listRunningApps: () => (running ? [{ bundleId: 'app', pid: 1, isHidden: false }] : []),
    listWindows: () => windows ?? [{ windowId: 5, bundleId: 'app', pid: 1, title: 'Main', bounds: { x: 0, y: 0, width: 800, height: 600 }, isOnScreen: true }],
    getUiTree: (id, depth) => { calls.push([id, depth]); if (throws) throw new Error(throws); return tree },
  }
  return {
    calls,
    context: {
      native, targets: null, focus: null, platform: 'darwin', activeProfile: 'full', sleep: async () => {},
      runScript: async () => ({}), getAppDictionary: async () => ({ error: 'not scriptable' }),
    },
  }
}

test('Unreal-style apps (a window and three buttons) are not accessible', async () => {
  const c = context({ tree: node('AXWindow', 'Editor', chrome()) })
  const body = (await handleAccessibilityTool('get_app_capabilities', { bundle_id: 'app' }, c.context)).structuredContent
  assert.deepEqual(body.accessibility, { nodes: 4, hasControls: false })
  assert.equal(body.accessible, false, 'accessible now follows hasControls')
  assert.equal(body.topLevelCount, 1)
  assert.equal(body.running, true)
  assert.deepEqual(c.calls, [[5, 3]], 'walks the main window to depth 3')
})

test('an app with a text field or a table is accessible', async () => {
  for (const role of ['AXTextField', 'AXTable', 'AXCheckBox', 'AXMenuBar', 'AXList', 'AXButton']) {
    const c = context({ tree: node('AXWindow', 'Main', [...chrome(), node('AXGroup', null, [node(role, 'x')])]) })
    const body = (await handleAccessibilityTool('get_app_capabilities', { bundle_id: 'app' }, c.context)).structuredContent
    assert.equal(body.accessible, true, role)
    assert.equal(body.accessibility.hasControls, true, role)
  }
})

test('the probe stops at depth 3 and caps the count at 200', () => {
  const deep = node('AXWindow', 'W', [node('AXGroup', null, [node('AXGroup', null, [node('AXGroup', null, [node('AXTextField', 'too deep')])])])])
  assert.deepEqual(probeAccessibilityTree(deep), { nodes: 4, hasControls: false })
  const wide = node('AXWindow', 'W', Array.from({ length: 500 }, () => node('AXGroup')))
  assert.deepEqual(probeAccessibilityTree(wide), { nodes: 200, hasControls: false })
  const lateControl = node('AXWindow', 'W', [...Array.from({ length: 300 }, () => node('AXStaticText')), node('AXButton', 'Late')])
  assert.equal(probeAccessibilityTree(lateControl).hasControls, false, 'a control past the cap is not seen')
})

test('no window or an unreadable tree reports zero nodes and no controls, with the reason', async () => {
  const none = context({ tree: undefined, windows: [] })
  const a = (await handleAccessibilityTool('get_app_capabilities', { bundle_id: 'app' }, none.context)).structuredContent
  assert.deepEqual(a.accessibility, { nodes: 0, hasControls: false, error: 'no_window' })
  assert.equal(a.accessible, false)
  assert.equal(a.topLevelCount, 0)
  const denied = context({ throws: 'accessibility permission denied' })
  const b = (await handleAccessibilityTool('get_app_capabilities', { bundle_id: 'app' }, denied.context)).structuredContent
  assert.equal(b.accessible, false)
  assert.equal(b.accessibility.error, 'accessibility permission denied')
})
