import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { ToolRegistry } from '../dist/registry/registry.js'
import { classifyToolAction, createRiskMapper } from '../dist/runtime/action.js'
import { TOOL_CATALOG } from '../dist/tool-catalog.js'

function registry() {
  return new ToolRegistry({
    profile: 'full',
    structuredContent: true,
    legacyFocusTag: false,
    approvalTokenSchema: z.string().optional(),
    session: { async dispatch() { throw new Error('not called') } },
  })
}

function screenshotDefinition() {
  const meta = TOOL_CATALOG.screenshot
  return {
    name: 'screenshot',
    description: 'test',
    inputSchema: {},
    meta,
    riskMapper: createRiskMapper('screenshot', meta),
  }
}

test('registry rejects duplicate definitions before MCP registration', () => {
  const value = registry()
  value.define(screenshotDefinition())
  assert.throws(() => value.define(screenshotDefinition()), /duplicate tool definition/)
})

test('registry completeness reports every missing definition', () => {
  const value = registry()
  value.define(screenshotDefinition())
  assert.throws(
    () => value.assertComplete(),
    error => {
      assert.match(error.message, /tool registry incomplete/)
      assert.match(error.message, /left_click/)
      assert.doesNotMatch(error.message, /missing=\[[^\]]*screenshot/)
      return true
    },
  )
})

test('operation-aware classification distinguishes read and destructive modes', () => {
  assert.equal(
    classifyToolAction('filesystem', { mode: 'read' }, TOOL_CATALOG.filesystem).actionClass,
    'observe',
  )
  assert.equal(
    classifyToolAction('filesystem', { mode: 'delete' }, TOOL_CATALOG.filesystem).actionClass,
    'destructive',
  )
  assert.equal(
    classifyToolAction('registry', { mode: 'set' }, TOOL_CATALOG.registry).actionClass,
    'privilege_change',
  )
  assert.equal(
    classifyToolAction('process_kill', { mode: 'list' }, TOOL_CATALOG.process_kill).actionClass,
    'observe',
  )
})

test('sensitive semantic fields classify as secret access', () => {
  const direct = classifyToolAction(
    'set_value',
    { role: 'AXSecureTextField', label: 'Password', value: 'redacted' },
    TOOL_CATALOG.set_value,
  )
  assert.equal(direct.actionClass, 'secret_access')

  const form = classifyToolAction(
    'fill_form',
    { fields: [{ role: 'AXTextField', label: 'One-time code', value: 'redacted' }] },
    TOOL_CATALOG.fill_form,
  )
  assert.equal(form.actionClass, 'secret_access')
})

test('OpenAI adapter observation batches do not inherit coarse mutating risk', () => {
  const observed = classifyToolAction(
    'openai_computer',
    { actions: [{ type: 'screenshot' }, { type: 'wait' }] },
    TOOL_CATALOG.openai_computer,
  )
  assert.equal(observed.actionClass, 'observe')
  assert.equal(observed.externalSideEffect, false)
})
