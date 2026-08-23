import assert from 'node:assert/strict'
import test from 'node:test'
import { OpenAiCompatibilityHandler } from '../dist/session/openai-handler.js'

test('OpenAI compatibility batches map to canonical tools and preserve target context', async () => {
  const calls = []
  const handler = new OpenAiCompatibilityHandler(async (tool, args) => {
    calls.push([tool, args])
    return { content: [{ type: 'text', text: tool }] }
  })
  const result = await handler.handle('openai_computer', {
    target_app: 'app.editor',
    actions: [{ type: 'click', x: 10, y: 20 }, { type: 'keypress', keys: ['CTRL', 'S'] }],
  })
  assert.equal(result.isError, undefined)
  assert.deepEqual(calls[0], ['left_click', {
    coordinate: [10, 20], target_app: 'app.editor',
  }])
  assert.equal(calls[1][0], 'key')
  assert.equal(JSON.parse(result.content[0].text).count, 2)
})

test('OpenAI compatibility stops at the first canonical tool error', async () => {
  let calls = 0
  const handler = new OpenAiCompatibilityHandler(async () => {
    calls++
    return { content: [{ type: 'text', text: 'denied' }], isError: true }
  })
  const result = await handler.handle('openai_computer', {
    actions: [{ type: 'click', x: 1, y: 2 }, { type: 'click', x: 3, y: 4 }],
  })
  assert.equal(result.isError, true)
  assert.equal(calls, 1)
  assert.equal(JSON.parse(result.content[0].text).failed_index, 0)
})

test('OpenAI compatibility can append a projected screenshot after the batch', async () => {
  const calls = []
  const handler = new OpenAiCompatibilityHandler(async (tool, args) => {
    calls.push([tool, args])
    return tool === 'screenshot'
      ? { content: [{ type: 'image', data: 'shot', mimeType: 'image/png' }] }
      : { content: [{ type: 'text', text: 'ok' }] }
  })
  const result = await handler.handle('openai_computer', {
    action: { type: 'wait' }, return_screenshot: true, use_virtual_pointer: true,
  })
  assert.equal(calls.at(-1)[0], 'screenshot')
  assert.equal(calls.at(-1)[1].show_agent_pointer, true)
  assert.equal(result.content.at(-1).type, 'image')
})
