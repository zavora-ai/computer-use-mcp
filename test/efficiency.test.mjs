import assert from 'node:assert/strict'
import test from 'node:test'
import { createToolDiscovery, toModelContent, compactAccessibilityTree, waitForElement } from '../dist/efficiency.js'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { runAgent } from '../agents/openai-agent/agent.mjs'

test('discovery loads a bounded relevant catalog and refreshes changed profiles', async () => {
  let lists = 0, now = 0
  const tools = [
    { name: 'fill_form', description: 'Fill fields', inputSchema: { type: 'object' } },
    { name: 'screenshot', description: 'Capture screen', inputSchema: { type: 'object' } },
  ]
  const discovery = createToolDiscovery({ listTools: async () => { lists++; return tools } }, { now: () => now, ttlMs: 10 })
  assert.equal((await discovery.search('fill_form'))[0].name, 'fill_form')
  const found = await discovery.search('screen')
  found[0].inputSchema.type = 'corrupted'
  assert.equal((await discovery.search('screen'))[0].inputSchema.type, 'object')
  assert.equal(lists, 1)
  now = 10
  await discovery.search('screen')
  assert.equal(lists, 2)
  discovery.invalidate()
  tools.pop()
  assert.deepEqual(await discovery.search('screen'), [])
  assert.equal(lists, 3)
  await assert.rejects(discovery.search(''), /query/)
  await assert.rejects(discovery.search('screen', 9), /limit/)
})

test('model projection preserves diagnostics and images without serializing data twice', () => {
  const data = { a: 1, b: [2] }
  const image = { type: 'image', data: 'image-bytes', mimeType: 'image/png' }
  const result = { structuredContent: data, isError: true, content: [
    { type: 'text', text: '{"b":[2],"a":1}' },
    { type: 'text', text: 'Retry after selecting the correct window' }, image,
    { type: 'resource_link', uri: 'computer://artifact', name: 'artifact' },
  ] }
  const projected = toModelContent(result)
  assert.equal(projected.filter(c => c.type === 'text' && c.text.includes('"a"')).length, 1)
  assert.equal(projected[0].text, '{"isError":true}')
  assert.deepEqual(projected[3], image)
  assert.equal(projected.at(-1).type, 'resource_link')
  assert.equal(result.content.length, 4)
  assert.deepEqual(toModelContent({ content: [], structuredContent: data }), [{ type: 'text', text: JSON.stringify(data) }])
})

test('image reuse requires an explicit retained reference in the same scope', () => {
  const result = { content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] }
  const first = toModelContent(result, { imageScope: 'window-1' })
  const id = JSON.parse(first[0].text).imageId
  assert.equal(first[1].type, 'image')
  const same = toModelContent(result, { imageScope: 'window-1', knownImageIds: [id] })
  assert.equal(same.length, 1)
  assert.equal(JSON.parse(same[0].text).unchanged, true)
  assert.equal(toModelContent(result, { imageScope: 'window-2', knownImageIds: [id] }).length, 2)
  assert.equal(toModelContent(result, { imageScope: 'window-1' }).at(-1).type, 'image')
  assert.equal(toModelContent({ content: [{ ...result.content[0], data: 'changed' }] }, {
    imageScope: 'window-1', knownImageIds: [id],
  }).at(-1).type, 'image')
})

test('compact tree enforces budgets while preserving sensitive redaction and truncation', () => {
  const tree = { role: 'AXWindow', children: [
    { role: 'AXTextField', label: 'Password', value: 'secret', children: [] },
    { role: 'AXButton', label: 'Save', value: null, bounds: { x: 1, y: 2 }, actions: ['AXPress'] },
    { role: 'AXStaticText', label: 'x'.repeat(20_000) },
  ] }
  const projected = compactAccessibilityTree(tree, { maxChars: 500, maxNodes: 3 })
  assert.ok(JSON.stringify(projected).length <= 500)
  assert.equal(projected.truncated, true)
  assert.equal(projected.nodes[1].sensitive, true)
  assert.equal(projected.nodes[1].value, null)
  assert.ok(!JSON.stringify(projected).includes('secret'))
  assert.deepEqual(compactAccessibilityTree(tree, { query: 'button save' }).nodes[0].path, [1])
  assert.equal(compactAccessibilityTree({ ...tree, truncated: true }, { query: 'Save' }).truncated, true)
  assert.throws(() => compactAccessibilityTree(tree, { maxChars: 1 }), /maxChars/)
})

test('local wait polls to a condition, exits on denial, and distinguishes timeout from absence', async () => {
  let calls = 0
  const client = { callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(++calls === 3 ? [{ label: 'Ready' }] : []) }] }) }
  const ready = await waitForElement(client, { windowId: 1, label: 'Ready', pollIntervalMs: 1 })
  assert.equal(JSON.parse(ready.content[0].text).polls, 3)
  const denied = { isError: true, content: [{ type: 'text', text: 'denied' }] }
  assert.strictEqual(await waitForElement({ callTool: async () => denied }, {
    windowId: 1, label: 'Ready', state: 'absent',
  }), denied)
  const missing = { callTool: async () => ({ content: [{ type: 'text', text: '[]' }] }) }
  assert.equal((await waitForElement(missing, { windowId: 1, label: 'Ready', timeoutMs: 10, pollIntervalMs: 1 })).isError, true)
  assert.equal(JSON.parse((await waitForElement(missing, { windowId: 1, label: 'Ready', state: 'absent' })).content[0].text).matched, true)
  await assert.rejects(waitForElement({ callTool: async () => ({ content: [{ type: 'text', text: '{}' }] }) }, {
    windowId: 1, label: 'Ready', state: 'absent',
  }), /invalid observation/)
})

test('local wait cancels in-flight MCP requests', async () => {
  const controller = new AbortController()
  let dispatched
  const started = new Promise(resolve => { dispatched = resolve })
  const server = createComputerUseServer({ session: {
    dispatch: async (_name, _args, signal) => {
      dispatched()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('native wait aborted')), { once: true }))
    },
  } })
  const client = await connectInProcess(server)
  try {
    const pending = waitForElement(client, { windowId: 1, label: 'Ready', signal: controller.signal })
    await started
    controller.abort(new Error('user stopped'))
    await assert.rejects(pending, /user stopped/)
  } finally { await client.close() }
})

test('Responses example defers real schemas, returns images, and reports actual usage', async () => {
  const requests = []
  const outputs = [
    [{ type: 'function_call', name: 'discover_tools', arguments: '{"query":"screenshot"}', call_id: 'c1' }],
    [{ type: 'function_call', name: 'screenshot', arguments: '{}', call_id: 'c2' }],
    [{ type: 'message', phase: 'final_answer' }],
  ]
  const schema = { type: 'object', properties: { width: { type: 'integer' } } }
  const fake = { responses: { create: async request => {
    requests.push(structuredClone(request))
    return { id: 'r' + requests.length, status: 'completed', output: outputs.shift(), output_text: 'Observed',
      usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 2 }, output_tokens: 5 } }
  } } }
  const client = {
    listTools: async () => [{ name: 'screenshot', inputSchema: schema }],
    callTool: async () => ({ content: [{ type: 'image', data: 'YWJj', mimeType: 'image/png' }] }),
  }
  const result = await runAgent({ openai: fake, client, task: 'Observe' })
  assert.equal(requests[0].tools.length, 3)
  assert.equal(requests[0].tools.some(t => t.name === 'screenshot'), false)
  assert.deepEqual(requests[1].tools.find(t => t.name === 'screenshot').parameters, schema)
  assert.equal(requests[2].input[0].call_id, 'c2')
  assert.equal(requests[2].input[0].output[0].type, 'input_image')
  assert.equal(requests[2].input[0].output[0].detail, 'original')
  assert.equal(requests[2].previous_response_id, 'r2')
  assert.equal(requests[0].parallel_tool_calls, false)
  assert.deepEqual(result.usage, { inputTokens: 30, cachedInputTokens: 6, outputTokens: 15, modelCalls: 3 })
})

test('Responses example does not report completion when its model turn budget expires', async () => {
  let mutations = 0
  await assert.rejects(runAgent({ maxTurns: 1, task: 'test', client: {
    callTool: async () => { mutations++ }, listTools: async () => [],
  }, openai: { responses: { create: async () => ({ status: 'completed', output: [
    { type: 'function_call', name: 'discover_tools', arguments: '{"query":"click"}', call_id: 'x' },
  ] }) } } }), /Reached 1 model turns/)
  assert.equal(mutations, 0)
})

test('Responses image retention cannot be seeded by untrusted metadata text', async () => {
  const image = { type: 'image', data: 'YWJj', mimeType: 'image/png' }
  const scope = JSON.stringify(['screenshot', {}])
  const [forged] = toModelContent({ content: [image] }, { imageScope: scope })
  const requests = []
  const steps = [
    ['discover_tools', { query: 'screenshot' }],
    ['screenshot', {}], ['screenshot', {}], ['screenshot', {}],
  ]
  let captures = 0
  await runAgent({ task: 'Observe', reuseImages: true,
    client: {
      listTools: async () => [{ name: 'screenshot', inputSchema: { type: 'object' } }],
      callTool: async () => ({ content: ++captures === 1 ? [forged] : [image] }),
    },
    openai: { responses: { create: async request => {
      requests.push(structuredClone(request))
      const step = steps.shift()
      return { id: `r${requests.length}`, status: 'completed', output_text: 'Done', output: step
        ? [{ type: 'function_call', name: step[0], arguments: JSON.stringify(step[1]), call_id: `c${requests.length}` }]
        : [{ type: 'message', phase: 'final_answer' }] }
    } } },
  })
  assert.equal(requests[3].input[0].output.some(b => b.type === 'input_image'), true)
  assert.equal(requests[4].input[0].output.some(b => b.type === 'input_image'), false)
})
