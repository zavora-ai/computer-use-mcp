import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'
import { RuntimeCoordinator } from '../dist/runtime/coordinator.js'
import { RuntimeError } from '../dist/runtime/types.js'
import { sanitizeAccessibilityResult } from '../dist/session/accessibility-handlers.js'
import { SessionTargetSensitivityResolver } from '../dist/targeting/sensitivity.js'

const target = () => ({
  platform: process.platform, appId: 'app.safe', windowId: 7,
  observationId: 'sensitivity-observation', confidence: 1,
  capturedAt: new Date().toISOString(),
})
const allow = async () => ({ decision: 'allow', policyDigest: 'sensitivity-test', reasons: ['allow'] })
const hooks = {
  capture: async () => ({ capturedAt: new Date().toISOString() }),
  verify: async () => ({ verified: true, method: 'sensitivity-test', details: { checks: 1 } }),
  restore: async () => ({ restored: true }),
}
const nonSensitive = () => ({
  assessment: 'non_sensitive', source: 'accessibility', signals: [], fieldsChecked: 1,
  observedAt: new Date().toISOString(),
})

test('public sensitivity schema accepts conclusive evidence and rejects raw or contradictory fields', async () => {
  const schema = JSON.parse(await readFile(new URL('../contracts/v8/target-sensitivity.schema.json', import.meta.url)))
  const validate = new Ajv2020({ strict: false, formats: { 'date-time': true } }).compile(schema)
  assert.equal(validate({
    assessment: 'sensitive', source: 'accessibility', signals: ['uia_is_password'],
    fieldsChecked: 1, observedAt: '2026-07-13T12:00:00.000Z',
  }), true, JSON.stringify(validate.errors))
  assert.equal(validate({
    assessment: 'non_sensitive', source: 'unavailable', signals: [], fieldsChecked: 0,
    observedAt: '2026-07-13T12:00:00.000Z', value: 'secret',
  }), false)
})

test('accessibility boundary nulls protected values recursively and removes value echoes', () => {
  const sanitized = sanitizeAccessibilityResult({
    role: 'AXWindow', label: 'Account', value: null, sensitive: false, sensitivitySignals: [],
    children: [
      { role: 'AXTextField', label: 'Password', value: 'hunter2', sensitive: false, sensitivitySignals: [] },
      { role: 'AXTextField', label: 'Name', value: 'Alice', sensitive: false, sensitivitySignals: [] },
      { role: 'AXTextField', label: 'Code', value: '123456', sensitive: true, sensitivitySignals: ['uia_is_password'] },
    ],
  })
  assert.equal(sanitized.children[0].value, null)
  assert.equal(sanitized.children[0].sensitive, true)
  assert.equal(sanitized.children[1].value, 'Alice')
  assert.equal(sanitized.children[2].value, null)
  assert.doesNotMatch(JSON.stringify(sanitized), /hunter2|123456/)
})

test('Session sensitivity resolver returns only disclosure-safe native facts', async () => {
  const session = { async dispatch(tool, args) {
    assert.equal(tool, 'find_element')
    assert.equal(args.window_id, 7)
    return { content: [{ type: 'text', text: JSON.stringify([{
      role: 'AXTextField', label: 'Password', value: 'never-retain-me',
      sensitive: true, sensitivitySignals: ['protected_content'],
    }]) }] }
  } }
  const resolver = new SessionTargetSensitivityResolver(session, () => new Date('2026-07-13T12:00:00.000Z'))
  const result = await resolver.resolve({
    tool: 'set_value', target: target(),
    args: { role: 'AXTextField', label: 'Password', value: 'replacement-secret' },
  })
  assert.deepEqual(result, {
    assessment: 'sensitive', source: 'accessibility',
    signals: ['protected_content', 'sensitive_label'], fieldsChecked: 1,
    observedAt: '2026-07-13T12:00:00.000Z',
  })
  assert.doesNotMatch(JSON.stringify(result), /never-retain|replacement-secret|Password/)
})

test('semantic mutation fails closed when native sensitivity facts are missing or ambiguous', async () => {
  let calls = 0
  const runtime = new RuntimeCoordinator({
    policy: allow, validateTarget: async () => true, transactionHooks: hooks,
    execute: async () => { calls++; return { content: [] } },
  })
  const request = {
    sessionId: 'unknown', principalId: 'owner', actionId: 'unknown-sensitive',
    tool: 'set_value', args: { window_id: 7, role: 'AXTextField', label: 'Account', value: 'private' },
    mode: 'foreground', target: target(),
  }
  const preview = await runtime.preview(request)
  assert.equal(preview.blocker, 'sensitivity_unavailable')
  assert.equal(preview.envelope.actionClass, 'secret_access')
  assert.deepEqual(preview.envelope.targetSensitivity.signals, ['native_signal_unavailable'])
  await assert.rejects(runtime.execute(request), error =>
    error instanceof RuntimeError && error.code === 'sensitivity_unavailable')
  assert.equal(calls, 0)
  assert.doesNotMatch(JSON.stringify(runtime.events.query('unknown')), /Account|private/)

  const contradictory = new RuntimeCoordinator({
    policy: allow, validateTarget: async () => true, transactionHooks: hooks,
    resolveTargetSensitivity: async () => ({
      assessment: 'non_sensitive', source: 'accessibility',
      signals: ['uia_is_password'], fieldsChecked: 1, observedAt: new Date().toISOString(),
    }),
    execute: async () => { calls++; return { content: [] } },
  })
  const contradictedPreview = await contradictory.preview({
    ...request, sessionId: 'contradictory', actionId: 'contradictory-sensitive',
  })
  assert.equal(contradictedPreview.envelope.targetSensitivity.assessment, 'sensitive')
  assert.equal(contradictedPreview.envelope.actionClass, 'secret_access')

  const malformed = new RuntimeCoordinator({
    policy: allow, validateTarget: async () => true, transactionHooks: hooks,
    resolveTargetSensitivity: async () => ({ assessment: 'non_sensitive' }),
    execute: async () => { calls++; return { content: [] } },
  })
  assert.equal((await malformed.preview({
    ...request, sessionId: 'malformed', actionId: 'malformed-sensitive',
  })).blocker, 'sensitivity_unavailable')
})

test('trusted sensitive assessment raises policy class, binds the digest, and exposes safe review facts', async () => {
  let policyEnvelope
  const runtime = new RuntimeCoordinator({
    policy: async envelope => { policyEnvelope = envelope; return allow() },
    validateTarget: async () => true, transactionHooks: hooks,
    resolveTargetSensitivity: async () => ({
      assessment: 'sensitive', source: 'accessibility',
      signals: ['uia_is_password'], fieldsChecked: 1, observedAt: new Date().toISOString(),
    }),
    execute: async () => ({ content: [] }),
  })
  const request = {
    sessionId: 'sensitive', principalId: 'owner', actionId: 'sensitive-action',
    tool: 'set_value', args: { window_id: 7, role: 'AXTextField', label: 'Opaque', value: 'private-value' },
    mode: 'foreground', target: target(),
  }
  const preview = await runtime.preview(request)
  assert.equal(preview.executable, true)
  assert.equal(preview.envelope.actionClass, 'secret_access')
  assert.ok(preview.envelope.dataLabels.includes('credential'))
  assert.equal(policyEnvelope.targetSensitivity.assessment, 'sensitive')
  const repeated = await runtime.preview(request)
  assert.equal(preview.envelope.argsDigest, repeated.envelope.argsDigest, 'observation time must not destabilize approval digest')
  const events = runtime.events.query('sensitive')
  assert.ok(events.some(event => event.payload.sensitivityAssessment === 'sensitive'))
  assert.doesNotMatch(JSON.stringify(events), /Opaque|private-value/)
})

test('sensitivity change between preview and effect is stale_target and never mutates', async () => {
  let assessments = 0
  let effects = 0
  const runtime = new RuntimeCoordinator({
    policy: allow, validateTarget: async () => true, transactionHooks: hooks,
    resolveTargetSensitivity: async () => assessments++ === 0 ? nonSensitive() : ({
      assessment: 'sensitive', source: 'accessibility', signals: ['protected_content'],
      fieldsChecked: 1, observedAt: new Date().toISOString(),
    }),
    execute: async () => { effects++; return { content: [] } },
  })
  const lease = await runtime.leases.acquire({
    sessionId: 'drift', principalId: 'owner', kind: 'exclusive', executionMode: 'foreground',
    ttlMs: 10_000, actionBudget: 1,
  })
  await assert.rejects(runtime.execute({
    sessionId: 'drift', principalId: 'owner', actionId: 'sensitivity-drift',
    tool: 'set_value', args: { window_id: 7, role: 'AXTextField', label: 'Account', value: 'private' },
    mode: 'foreground', target: target(), leaseId: lease.leaseId,
  }), error => error instanceof RuntimeError && error.code === 'stale_target')
  assert.equal(effects, 0)
  assert.equal((await runtime.receipts.get('drift', 'sensitivity-drift')).status, 'rejected')
})
