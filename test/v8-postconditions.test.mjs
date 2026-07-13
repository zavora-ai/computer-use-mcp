import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import { RuntimeCoordinator } from '../dist/runtime/coordinator.js'
import { RuntimeError } from '../dist/runtime/types.js'
import { SessionTransactionHooks } from '../dist/control/session-transaction.js'
import {
  validatePostcondition,
  valueDigest,
  verifySessionPostcondition,
} from '../dist/control/postconditions.js'

const allow = async () => ({ decision: 'allow', policyDigest: 'postcondition-test', reasons: ['allow'] })
const target = () => ({
  platform: process.platform, appId: 'app.safe', windowId: 7,
  observationId: 'postcondition-observation', confidence: 1, capturedAt: new Date().toISOString(),
})

function envelope(tool, postcondition) {
  return {
    actionId: 'a', sessionId: 's', principalId: 'p', tool, operation: tool,
    actionClass: 'edit_reversible', requestedMode: 'foreground', target: target(),
    dataLabels: ['private'], reversible: true, externalSideEffect: true,
    proposedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
    argsDigest: 'digest', ...(postcondition ? { postcondition } : {}),
  }
}

test('postcondition validation accepts digest-only state and rejects malformed or contradictory claims', () => {
  assert.match(valueDigest('private value'), /^sha256:[a-f0-9]{64}$/)
  assert.doesNotMatch(valueDigest('private value'), /private/)
  assert.doesNotThrow(() => validatePostcondition({
    kind: 'ui_element', role: 'AXTextField', exists: true, valueDigest: valueDigest('private'),
  }))
  assert.throws(() => validatePostcondition({ kind: 'ui_element', exists: true }), /role or label/)
  assert.throws(() => validatePostcondition({
    kind: 'filesystem', path: '/safe/file', exists: false, contentDigest: valueDigest('x'),
  }), /absent filesystem/)
  assert.throws(() => validatePostcondition({ kind: 'process', pid: 0, running: false }), /positive pid/)
  assert.throws(() => validatePostcondition({ kind: 'process', pid: 42, running: true }), /non-running/)
})

test('public postcondition schema accepts every contract kind and rejects contradictory absence digests', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/v8/action-postcondition.schema.json', import.meta.url)))
  const validate = new Ajv2020({ strict: false }).compile(schema)
  const digest = valueDigest('expected')
  for (const value of [
    { kind: 'ui_element', role: 'AXTextField', exists: true, valueDigest: digest },
    { kind: 'filesystem', path: '/safe/file', exists: true, contentDigest: digest },
    { kind: 'registry', path: 'HKCU:\\Safe', name: 'Value', exists: false },
    { kind: 'process', pid: 42, running: false },
    { kind: 'window', windowId: 7, exists: false },
  ]) assert.equal(validate(value), true, JSON.stringify(validate.errors))
  assert.equal(validate({
    kind: 'registry', path: 'HKCU:\\Safe', name: 'Value', exists: false, valueDigest: digest,
  }), false)
  assert.equal(validate({ kind: 'process', pid: 42, running: true }), false)
})

test('UI value and form postconditions independently read back every expected field without returning values', async () => {
  const values = new Map([['Name', 'Alice'], ['Email', 'alice@example.test']])
  const session = { async dispatch(tool, args) {
    assert.equal(tool, 'find_element')
    const value = values.get(args.label)
    return { content: [{ type: 'text', text: JSON.stringify(value === undefined ? [] : [{ role: args.role, label: args.label, value }]) }] }
  } }
  const set = await verifySessionPostcondition(session, envelope('set_value'), {
    role: 'AXTextField', label: 'Name', value: 'Alice',
  })
  assert.deepEqual(set, { verified: true, method: 'postcondition.auto_ui_value', details: { checks: 1 } })
  const mismatch = await verifySessionPostcondition(session, envelope('set_value'), {
    role: 'AXTextField', label: 'Name', value: 'Mallory',
  })
  assert.equal(mismatch.verified, false)
  const form = await verifySessionPostcondition(session, envelope('fill_form'), { fields: [
    { role: 'AXTextField', label: 'Name', value: 'Alice' },
    { role: 'AXTextField', label: 'Email', value: 'alice@example.test' },
  ] })
  assert.equal(form.verified, true)
  assert.equal(form.details.checks, 2)
  assert.doesNotMatch(JSON.stringify([set, mismatch, form]), /Alice|Mallory|example\.test/)
})

test('filesystem, registry, window, and process postconditions verify observed state, not handler text', async () => {
  const files = new Map([['/safe/report.txt', 'verified bytes']])
  const registry = new Map([['HKCU:\\Safe\u0000Name', '42']])
  const session = { async dispatch(tool, args) {
    if (tool === 'filesystem') {
      const exists = files.has(args.path)
      if (args.mode === 'info') return exists
        ? { content: [{ type: 'text', text: JSON.stringify({ path: args.path, type: 'file' }) }] }
        : { content: [{ type: 'text', text: 'Not found' }], isError: true }
      return exists
        ? { content: [{ type: 'text', text: files.get(args.path) }] }
        : { content: [{ type: 'text', text: 'Not found' }], isError: true }
    }
    if (tool === 'registry') {
      const key = `${args.path}\u0000${args.name}`
      return registry.has(key)
        ? { content: [{ type: 'text', text: registry.get(key) }] }
        : { content: [{ type: 'text', text: 'missing' }], isError: true }
    }
    if (tool === 'get_window') return args.window_id === 7
      ? { content: [{ type: 'text', text: '{"windowId":7}' }] }
      : { content: [{ type: 'text', text: 'missing' }], isError: true }
    throw new Error(`unexpected ${tool}`)
  } }
  const file = await verifySessionPostcondition(session, envelope('filesystem', {
    kind: 'filesystem', path: '/safe/report.txt', exists: true,
    contentDigest: valueDigest('verified bytes'),
  }), {})
  assert.equal(file.verified, true)
  const badFile = await verifySessionPostcondition(session, envelope('filesystem', {
    kind: 'filesystem', path: '/safe/report.txt', exists: true,
    contentDigest: valueDigest('fabricated handler success'),
  }), {})
  assert.equal(badFile.verified, false)
  assert.equal((await verifySessionPostcondition(session, envelope('registry', {
    kind: 'registry', path: 'HKCU:\\Safe', name: 'Name', exists: true, valueDigest: valueDigest('42'),
  }), {})).verified, true)
  assert.equal((await verifySessionPostcondition(session, envelope('left_click', {
    kind: 'window', windowId: 7, exists: true,
  }), {})).verified, true)
  assert.equal((await verifySessionPostcondition(session, envelope('process_kill', {
    kind: 'process', pid: 2_147_483_647, running: false,
  }), {})).verified, true)
})

test('strict auto-verification makes a false-success UI mutation indeterminate and non-replayable', async () => {
  let observedValue = 'old'
  let executeCalls = 0
  const session = { async dispatch(tool, args) {
    if (tool === 'cursor_position') return { content: [{ type: 'text', text: '{"x":1,"y":2}' }] }
    if (tool === 'get_frontmost_app') return { content: [{ type: 'text', text: '{"bundleId":"app.safe","windowId":7}' }] }
    if (tool === 'find_element') return { content: [{ type: 'text', text: JSON.stringify([
      { role: args.role, label: args.label, value: observedValue },
    ]) }] }
    throw new Error(`unexpected ${tool}`)
  } }
  const runtime = new RuntimeCoordinator({
    policy: allow, validateTarget: async () => true,
    transactionHooks: new SessionTransactionHooks(session),
    execute: async () => {
      executeCalls++
      return { content: [{ type: 'text', text: 'handler claimed success' }] }
    },
  })
  const lease = await runtime.leases.acquire({
    sessionId: 's', principalId: 'p', kind: 'exclusive', executionMode: 'foreground',
    ttlMs: 10_000, actionBudget: 1,
  })
  const request = {
    sessionId: 's', principalId: 'p', actionId: 'false-success', tool: 'set_value',
    args: { window_id: 7, role: 'AXTextField', label: 'Name', value: 'new-secret' },
    mode: 'foreground', target: target(), leaseId: lease.leaseId,
  }
  await assert.rejects(runtime.execute(request), error =>
    error instanceof RuntimeError && error.code === 'indeterminate')
  const receipt = await runtime.receipts.get('s', 'false-success')
  assert.equal(receipt.status, 'indeterminate')
  assert.doesNotMatch(JSON.stringify(runtime.events.query('s')), /new-secret|old/)
  observedValue = 'new-secret'
  const replay = await runtime.execute(request)
  assert.equal(replay.replay, true)
  assert.equal(replay.receipt.status, 'indeterminate')
  assert.equal(executeCalls, 1)
})

test('postconditions are action-digest bound, resource bound, and require a configured verifier', async () => {
  const noVerifier = new RuntimeCoordinator({ policy: allow, validateTarget: async () => true, execute: async () => ({ content: [] }) })
  const base = {
    sessionId: 's', principalId: 'p', actionId: 'bound', tool: 'set_value',
    args: { window_id: 7, role: 'AXTextField', label: 'Name', value: 'value' },
    mode: 'foreground', target: target(),
  }
  const unavailable = await noVerifier.preview(base)
  assert.equal(unavailable.blocker, 'postcondition_unavailable')

  const runtime = new RuntimeCoordinator({
    policy: allow, validateTarget: async () => true,
    transactionHooks: {
      capture: async () => ({ capturedAt: new Date().toISOString() }),
      verify: async () => ({ verified: true, method: 'trusted-test' }),
      restore: async () => ({ restored: true }),
    },
    execute: async () => ({ content: [] }),
  })
  const first = await runtime.preview({ ...base, postcondition: {
    kind: 'ui_element', role: 'AXStaticText', label: 'Saved', exists: true,
  } })
  const changed = await runtime.preview({ ...base, postcondition: {
    kind: 'ui_element', role: 'AXStaticText', label: 'Failed', exists: true,
  } })
  assert.notEqual(first.envelope.argsDigest, changed.envelope.argsDigest)
  await assert.rejects(runtime.preview({
    ...base, tool: 'filesystem', args: { mode: 'write', path: '/safe/a', content: 'x' },
    postcondition: { kind: 'filesystem', path: '/other/path', exists: true },
  }), error => error instanceof RuntimeError && error.code === 'policy_denied')
})

test('approval events disclose only reviewable postcondition metadata, never target text or expected values', async () => {
  const runtime = new RuntimeCoordinator({
    policy: async () => ({
      decision: 'confirm', policyDigest: 'postcondition-confirm', reasons: ['operator review'],
    }),
    validateTarget: async () => true,
    transactionHooks: {
      capture: async () => ({ capturedAt: new Date().toISOString() }),
      verify: async () => ({ verified: true, method: 'trusted-test' }),
      restore: async () => ({ restored: true }),
    },
    execute: async () => ({ content: [] }),
  })
  const expected = valueDigest('private expected value')
  const preview = await runtime.preview({
    sessionId: 'event-session', principalId: 'event-principal', actionId: 'event-action',
    tool: 'set_value', mode: 'foreground', target: target(),
    args: { window_id: 7, role: 'AXTextField', label: 'Secret account field', value: 'private expected value' },
    postcondition: {
      kind: 'ui_element', role: 'AXTextField', label: 'Secret account field', exists: true,
      valueDigest: expected,
    },
  })
  assert.equal(preview.blocker, 'approval_required')
  const events = runtime.events.query('event-session')
  const approval = events.find(event => event.type === 'action.approval_required')
  assert.equal(approval.payload.postconditionKind, 'ui_element')
  assert.equal(approval.payload.postconditionExpectedState, 'exists')
  assert.equal(approval.payload.postconditionExpectedDigest, expected)
  const disclosed = JSON.stringify(events)
  assert.doesNotMatch(disclosed, /Secret account field|private expected value/)
})
