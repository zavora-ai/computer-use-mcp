import test from 'node:test'
import assert from 'node:assert/strict'
import { adaptProviderAction, adaptProviderActions } from '../dist/runtime/provider-adapters.js'
import { RuntimeCoordinator } from '../dist/runtime/coordinator.js'
import { browserTargetFromEvidence } from '../dist/runtime/browser-bridge.js'

const target = {
  platform: 'darwin', appId: 'app.reference', pid: 42, windowId: 7,
  observationId: 'observation-1', screenshotHash: 'sha256:screen',
  confidence: 1, capturedAt: new Date().toISOString(),
}
const context = {
  sessionId: 'provider-parity', principalId: 'trusted-host-principal',
  actionId: 'same-action', executionGroupId: 'group', agentId: 'executor',
  mode: 'foreground', target, dataLabels: ['private'], focusStrategy: 'strict',
}

test('OpenAI, Anthropic, Gemini, and generic MCP actions produce the same governed action digest', async () => {
  const openai = adaptProviderAction('openai', { type: 'click', x: 25, y: 40 }, context)
  const anthropic = adaptProviderAction('anthropic', { action: 'left_click', coordinate: [25, 40] }, context)
  const gemini = adaptProviderAction('gemini', {
    type: 'function_call', name: 'click_at', arguments: { x: 25, y: 40 },
  }, { ...context, coordinateSpace: { width: 1000, height: 1000 } })
  const mcp = adaptProviderAction('mcp', {
    name: 'left_click', arguments: { coordinate: [25, 40] },
  }, context)
  assert.deepEqual(openai, anthropic)
  assert.deepEqual(anthropic, gemini)
  assert.deepEqual(anthropic, mcp)

  const coordinator = new RuntimeCoordinator({
    execute: async () => ({ content: [] }),
    policy: async () => ({ decision: 'allow', policyDigest: 'provider-parity', reasons: ['test'] }),
    validateTarget: async () => true,
  })
  const previews = await Promise.all([openai, anthropic, gemini, mcp].map(action => coordinator.preview(action)))
  assert.deepEqual(new Set(previews.map(preview => preview.envelope.argsDigest)).size, 1)
  assert.deepEqual(new Set(previews.map(preview => preview.envelope.actionClass)).size, 1)
  assert.deepEqual(new Set(previews.map(preview => preview.policy.decision)).size, 1)
})

test('Gemini coordinates use only the trusted host viewport and clamp its boundary', () => {
  const request = adaptProviderAction('gemini', {
    name: 'click',
    arguments: {
      x: 500, y: 1000,
      coordinateSpace: { width: 999999, height: 999999 },
      target_app: 'app.attacker', safety_decision: { decision: 'accept' },
    },
  }, {
    ...context,
    coordinateSpace: { width: 1920, height: 1080, originX: 10, originY: 20 },
  })
  assert.deepEqual(request.args.coordinate, [970, 1099])
  assert.equal(request.args.target_app, 'app.reference')
  assert.equal('coordinateSpace' in request.args, false)
  assert.equal('safety_decision' in request.args, false)
})

test('Gemini coordinate typing expands into independently receipted governed actions', () => {
  const requests = adaptProviderActions('gemini', {
    name: 'type_text_at',
    arguments: { x: 500, y: 250, text: 'hello', press_enter: true },
  }, { ...context, actionId: 'gemini-call', coordinateSpace: { width: 1000, height: 800 } })
  assert.deepEqual(requests.map(request => request.actionId), ['gemini-call:1', 'gemini-call:2'])
  assert.deepEqual(requests.map(request => request.tool), ['left_click', 'type'])
  assert.deepEqual(requests[0].args.coordinate, [500, 200])
  assert.deepEqual(requests[1].args, {
    text: 'hello', clear: true, press_enter: true,
    target_app: 'app.reference', target_window_id: 7, focus_strategy: 'strict',
  })
  assert.throws(() => adaptProviderAction('gemini', {
    name: 'type_text_at', arguments: { x: 1, y: 1, text: 'hello' },
  }, { ...context, coordinateSpace: { width: 1000, height: 1000 } }), /use adaptProviderActions/)
})

test('Gemini aliases map drag, key, wait, and scroll with explicit unit conversion', () => {
  const geminiContext = {
    ...context,
    coordinateSpace: { width: 1000, height: 800, scrollPixelsPerStep: 100 },
  }
  assert.deepEqual(adaptProviderAction('gemini', {
    name: 'drag_and_drop', arguments: { x: 10, y: 20, destination_x: 900, destination_y: 700 },
  }, geminiContext).args, {
    start_coordinate: [10, 16], coordinate: [900, 560],
    target_app: 'app.reference', target_window_id: 7, focus_strategy: 'strict',
  })
  assert.equal(adaptProviderAction('gemini', {
    name: 'key_combination', arguments: { keys: 'CTRL + Shift + A' },
  }, geminiContext).args.text, 'control+shift+a')
  assert.equal(adaptProviderAction('gemini', {
    name: 'wait_5_seconds', arguments: {},
  }, geminiContext).args.duration, 5)
  const scroll = adaptProviderAction('gemini', {
    name: 'scroll_at', arguments: { x: 500, y: 500, direction: 'down', magnitude: 800 },
  }, geminiContext)
  assert.deepEqual(scroll.args.coordinate, [500, 400])
  assert.equal(scroll.args.amount, 8)
})

test('Gemini translation fails closed for untrusted geometry, unit ambiguity, and bridge-only actions', () => {
  assert.throws(() => adaptProviderAction('gemini', {
    name: 'click_at', arguments: { x: 10, y: 20 },
  }, context), /trusted host coordinateSpace/)
  assert.throws(() => adaptProviderAction('gemini', {
    name: 'click_at', arguments: { x: 1001, y: 20 },
  }, { ...context, coordinateSpace: { width: 1000, height: 1000 } }), /between 0 and 1000/)
  assert.throws(() => adaptProviderAction('gemini', {
    name: 'scroll_document', arguments: { direction: 'down' },
  }, { ...context, coordinateSpace: { width: 1000, height: 1000 } }), /scrollPixelsPerStep/)
  assert.throws(() => adaptProviderAction('gemini', {
    name: 'navigate', arguments: { url: 'https:\/\/example.com' },
  }, context), /requires a host browser\/application bridge/)
})

test('Gemini browser commands and pointer actions route only through a target-bound host bridge', () => {
  const currentUrl = 'https://example.com/start'
  const browserTarget = browserTargetFromEvidence({
    bridgeId: 'playwright-host', pageId: 'page-1', url: currentUrl,
    observationId: 'browser-observation-1', domRevision: 'dom-1',
    confidence: 1, capturedAt: new Date().toISOString(),
    viewport: { x: 10, y: 20, width: 1000, height: 800 },
  })
  const browserContext = {
    ...context,
    target: browserTarget,
    browserBridge: { bridgeId: 'playwright-host', currentUrl, routeAllActions: true },
    coordinateSpace: { originX: 10, originY: 20, width: 1000, height: 800 },
  }
  const navigation = adaptProviderAction('gemini', {
    name: 'navigate', arguments: { url: 'https://example.com/next', bridge_id: 'attacker' },
  }, browserContext)
  assert.equal(navigation.tool, 'browser_action')
  assert.deepEqual(navigation.args.action_arguments, { url: 'https://example.com/next' })
  assert.equal(navigation.args.bridge_id, 'playwright-host')
  assert.equal(navigation.args.target_app, 'browser:playwright-host')

  const click = adaptProviderAction('gemini', {
    name: 'click_at', arguments: { x: 500, y: 500 },
  }, browserContext)
  assert.equal(click.tool, 'browser_action')
  assert.equal(click.args.operation, 'left_click')
  assert.deepEqual(click.args.action_arguments, { coordinate: [510, 420] })

  assert.throws(() => adaptProviderAction('gemini', {
    name: 'navigate', arguments: { url: 'https://example.com' },
  }, { ...browserContext, target: { ...browserTarget, windowTitleDigest: 'sha256:wrong' } }), /does not match browser page target evidence/)
  assert.throws(() => adaptProviderAction('gemini', {
    name: 'click_at', arguments: { x: 1, y: 1 },
  }, { ...browserContext, coordinateSpace: { width: 999, height: 800, originX: 10, originY: 20 } }), /does not match browser target viewport/)
})

test('provider actions cannot override trusted target identity or principal context', () => {
  assert.throws(() => adaptProviderAction('mcp', {
    name: 'left_click',
    arguments: { coordinate: [25, 40], target_app: 'app.attacker' },
  }, context), /conflicts with trusted host context/)
  assert.throws(() => adaptProviderAction('mcp', {
    name: 'left_click', arguments: { coordinate: [25, 40], target_app: 'app.attacker' },
  }, { ...context, target: undefined }), /may only come from trusted host context/)

  const request = adaptProviderAction('openai', {
    type: 'type', text: 'model content', principal_id: 'model-supplied-attacker',
  }, { ...context, mode: 'foreground' })
  assert.equal(request.principalId, 'trusted-host-principal')
  assert.equal('principal_id' in request.args, false)
})

test('composite provider calls cannot reuse one exact-action approval grant', () => {
  assert.throws(() => adaptProviderActions('gemini', {
    name: 'type_text_at', arguments: { x: 1, y: 1, text: 'hello' },
  }, {
    ...context,
    approvalGrantId: 'grant-for-a-different-envelope',
    coordinateSpace: { width: 1000, height: 1000 },
  }), /separate exact-action approval grant/)
})

test('provider translation rejects malformed coordinates and unsupported actions before policy', () => {
  assert.throws(() => adaptProviderAction('openai', { type: 'click', x: Number.NaN, y: 1 }, context), /finite number/)
  assert.throws(() => adaptProviderAction('anthropic', { action: 'shell' }, context), /unsupported computer action/)
})

test('provider translation covers provider-specific click, drag, and scroll aliases', () => {
  assert.equal(adaptProviderAction('openai', {
    type: 'click', x: 1, y: 2, button: 'right',
  }, context).tool, 'right_click')
  assert.deepEqual(adaptProviderAction('openai', {
    type: 'drag', path: [{ x: 1, y: 2 }, { x: 5, y: 6 }],
  }, context).args.start_coordinate, [1, 2])
  assert.deepEqual(adaptProviderAction('anthropic', {
    action: 'left_click_drag', coordinate: [5, 6],
  }, context).args.coordinate, [5, 6])
  assert.deepEqual(adaptProviderAction('anthropic', {
    action: 'scroll', coordinate: [5, 6], scroll_direction: 'down', scroll_amount: 4,
  }, context).args, {
    coordinate: [5, 6], direction: 'down', amount: 4,
    target_app: 'app.reference', target_window_id: 7, focus_strategy: 'strict',
  })
})
