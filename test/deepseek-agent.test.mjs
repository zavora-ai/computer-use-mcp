// DeepSeek Flash vision example — offline coverage. No network request, no API
// key, and no native module: both the model client and the MCP client are fakes.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runAgent, attachImages, pruneImages, measureImages, assertRequestWithinLimits,
  toImagePart, toUrlImagePart, toFileImagePart, maxDimensionFor, LIMITS,
} from '../agents/deepseek-agent/agent.mjs'
import {
  parseOptions, buildVisionMessages, runVision, SCENARIOS,
} from '../agents/deepseek-agent/vision.mjs'

const image = (data = 'AAAA', mimeType = 'image/jpeg') => ({ type: 'image', data, mimeType })
const textOf = message => (Array.isArray(message.content)
  ? message.content.filter(p => p.type === 'text').map(p => p.text).join(' ')
  : message.content)

/** Model client that replays a scripted list of assistant messages. */
function fakeDeepSeek(replies) {
  const requests = []
  let turn = 0
  return {
    requests,
    chat: {
      completions: {
        create: async request => {
          requests.push(structuredClone(request))
          const message = replies[Math.min(turn++, replies.length - 1)]
          return { choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 } }
        },
      },
    },
  }
}

const fakeMcp = (tools, handler) => ({
  listTools: async () => tools,
  callTool: async (name, args) => handler(name, args),
  close: async () => {},
})

// ── Image content parts ─────────────────────────────────────────────────────

test('MCP image blocks become data-URL image parts with a validated format', () => {
  const part = toImagePart(image('Zm9v', 'image/png'), 'low')
  assert.equal(part.type, 'image_url')
  assert.equal(part.image_url.url, 'data:image/png;base64,Zm9v')
  assert.equal(part.image_url.detail, 'low')

  assert.throws(() => toImagePart(image('Zm9v', 'image/bmp')), /supports image\/jpeg/)
  assert.throws(() => toImagePart({ type: 'text', text: 'x' }), /Not an MCP image block/)
  assert.throws(() => toImagePart(image(), 'ultra'), /detail must be one of/)
})

test('an inline image over the documented cap is refused with the Files API as the way out', () => {
  // base64 is 4/3 of the decoded size, so exceed the cap in decoded terms.
  const oversize = 'A'.repeat(Math.ceil((LIMITS.imageBytes + 1) * 4 / 3))
  assert.throws(() => toImagePart(image(oversize)), /Files API/)
})

test('external URL and Files API parts enforce their own distinct limits', () => {
  assert.deepEqual(toUrlImagePart('https://example.com/a.jpg', 'low'),
    { type: 'image_url', image_url: { url: 'https://example.com/a.jpg', detail: 'low' } })
  assert.throws(() => toUrlImagePart('ftp://example.com/a.jpg'), /http\(s\) URL/)
  assert.throws(() => toUrlImagePart('https://example.com/' + 'a'.repeat(8192)), /8192 characters/)

  assert.deepEqual(toFileImagePart('file-api-abc'), { type: 'file', file_id: 'file-api-abc' })
  assert.throws(() => toFileImagePart('file-abc'), /file-api-/)
})

// ── The constraint that shapes the whole integration ────────────────────────

test('tool images are relocated to a user message, because DeepSeek rejects them elsewhere', () => {
  const messages = []
  const moved = attachImages(messages, { toolCallId: 'call_1', text: '1024x432', images: [image()] })

  assert.equal(moved, 1)
  assert.equal(messages[0].role, 'tool')
  assert.equal(messages[0].tool_call_id, 'call_1')
  assert.equal(messages[0].content, '1024x432', 'the tool message stays text-only')
  assert.equal(messages[1].role, 'user', 'pixels must ride in a user message')
  assert.equal(messages[1].content.filter(p => p.type === 'image_url').length, 1)
  assert.match(textOf(messages[1]), /untrusted data/)
})

test('a tool that returns no image produces no extra user message', () => {
  const messages = []
  assert.equal(attachImages(messages, { toolCallId: 'c', text: 'ok', images: [] }), 0)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'tool')
})

test('an empty tool result still yields non-empty tool content', () => {
  const messages = []
  attachImages(messages, { toolCallId: 'c', text: '', images: [] })
  assert.equal(messages[0].content, '(no text output)')
})

// ── Cost control ────────────────────────────────────────────────────────────

test('pruning keeps the newest images and leaves a visible placeholder', () => {
  const messages = []
  for (const id of ['a', 'b', 'c']) attachImages(messages, { toolCallId: id, text: id, images: [image()] })
  assert.equal(measureImages(messages).images, 3)

  assert.equal(pruneImages(messages, 1), 2)
  assert.equal(measureImages(messages).images, 1)
  const placeholders = messages.filter(m => Array.isArray(m.content) && /omitted to bound cost/.test(textOf(m)))
  assert.equal(placeholders.length, 2, 'a dropped screenshot must not silently vanish')
  assert.ok(placeholders.every(m => m.content.length > 0), 'content must never be empty')
  assert.throws(() => pruneImages(messages, -1), /non-negative/)
})

test('request limits are checked before the call, not discovered from a 400', () => {
  const many = []
  for (let i = 0; i <= LIMITS.imagesPerRequest; i++) {
    many.push({ role: 'user', content: [toImagePart(image())] })
  }
  assert.throws(() => assertRequestWithinLimits(many), /exceeds the 600-image request limit/)
  assert.deepEqual(assertRequestWithinLimits([{ role: 'user', content: [toImagePart(image('AAAA'))] }]),
    { images: 1, inlineBytes: measureImages([{ role: 'user', content: [toImagePart(image('AAAA'))] }]).inlineBytes })
})

test('the accepted image dimension drops once a request carries many images', () => {
  assert.equal(maxDimensionFor(1), 8192)
  assert.equal(maxDimensionFor(LIMITS.manyImagesThreshold), 4096)
})

// ── Agent loop ──────────────────────────────────────────────────────────────

test('the agent forwards MCP schemas, calls the tool, and returns the final answer', async () => {
  const deepseek = fakeDeepSeek([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{"provider":"deepseek-flash"}' } }] },
    { role: 'assistant', content: 'Calculator is showing 2436.' },
  ])
  const dispatched = []
  const client = fakeMcp(
    [{ name: 'screenshot', description: 'Capture', inputSchema: { type: 'object', properties: { provider: { type: 'string' } } } }],
    (name, args) => { dispatched.push([name, args]); return { content: [{ type: 'text', text: '1024x432' }, image()] } },
  )

  const run = await runAgent({ deepseek, client, task: 'What does Calculator show?', platform: 'darwin' })

  assert.equal(run.text, 'Calculator is showing 2436.')
  assert.deepEqual(dispatched, [['screenshot', { provider: 'deepseek-flash' }]])
  assert.equal(run.usage.modelCalls, 2)
  assert.equal(run.usage.images, 1)
  assert.equal(run.usage.cachedTokens, 8)
  // The advertised schema must reach the model or it cannot fill parameters.
  assert.deepEqual(deepseek.requests[0].tools[0].function.parameters,
    { type: 'object', properties: { provider: { type: 'string' } } })
  // Images are rejected in system messages, so that message stays a plain string.
  assert.equal(typeof deepseek.requests[0].messages[0].content, 'string')
  assert.equal(deepseek.requests[0].messages[0].role, 'system')
})

test('no message other than a user message ever carries an image', async () => {
  const deepseek = fakeDeepSeek([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }] },
    { role: 'assistant', content: 'done' },
  ])
  const client = fakeMcp([{ name: 'screenshot', inputSchema: { type: 'object', properties: {} } }],
    () => ({ content: [{ type: 'text', text: 'shot' }, image()] }))

  await runAgent({ deepseek, client, task: 'look' })

  for (const request of deepseek.requests) {
    for (const message of request.messages) {
      if (!Array.isArray(message.content)) continue
      const carriesImage = message.content.some(p => p.type === 'image_url' || p.type === 'file')
      if (carriesImage) assert.equal(message.role, 'user', `image found in a ${message.role} message`)
    }
  }
})

test('a failing or malformed tool call is reported to the model instead of throwing', async () => {
  const deepseek = fakeDeepSeek([
    { role: 'assistant', content: null, tool_calls: [
      { id: 'bad', type: 'function', function: { name: 'screenshot', arguments: '{not json' } },
      { id: 'boom', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
    ] },
    { role: 'assistant', content: 'reported' },
  ])
  const client = fakeMcp([{ name: 'screenshot', inputSchema: { type: 'object', properties: {} } }],
    () => { throw new Error('native module unavailable') })

  const run = await runAgent({ deepseek, client, task: 'look' })

  assert.equal(run.text, 'reported')
  const toolMessages = deepseek.requests[1].messages.filter(m => m.role === 'tool')
  assert.equal(JSON.parse(toolMessages[0].content).error, 'invalid_tool_arguments')
  assert.equal(JSON.parse(toolMessages[1].content).error, 'tool_call_failed')
  assert.match(JSON.parse(toolMessages[1].content).message, /native module unavailable/)
})

test('the agent stops at its turn budget rather than looping forever', async () => {
  const deepseek = fakeDeepSeek([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'noop', arguments: '{}' } }] },
  ])
  const client = fakeMcp([{ name: 'noop', inputSchema: { type: 'object', properties: {} } }], () => ({ content: [] }))
  await assert.rejects(runAgent({ deepseek, client, task: 'spin', maxTurns: 3 }), /did not finish within 3 turns/)
  assert.equal(deepseek.requests.length, 3)
  await assert.rejects(runAgent({ deepseek, client, task: 'x', maxTurns: 0 }), /maxTurns must be 1\.\.100/)
  await assert.rejects(runAgent({ deepseek, client, task: 'x', detail: 'nope' }), /detail must be one of/)
})

test('an aborted run stops before issuing another model call', async () => {
  const controller = new AbortController()
  const deepseek = fakeDeepSeek([{ role: 'assistant', content: 'unreachable' }])
  const client = fakeMcp([], () => ({ content: [] }))
  controller.abort(new Error('cancelled'))
  await assert.rejects(runAgent({ deepseek, client, task: 'x', signal: controller.signal }), /cancelled/)
  assert.equal(deepseek.requests.length, 0)
})

// ── Vision scenarios ────────────────────────────────────────────────────────

test('scenario detail levels match what each task actually needs', () => {
  // Layout questions do not need full resolution; transcription and charts do.
  assert.equal(SCENARIOS.describe.detail, 'low')
  assert.equal(SCENARIOS.read.detail, 'original')
  assert.equal(SCENARIOS.chart.detail, 'original')
  assert.equal(SCENARIOS.compare.detail, 'low')
})

test('vision argument parsing rejects unusable combinations', () => {
  assert.deepEqual(parseOptions([]), { scenario: 'describe', prompt: undefined, url: undefined, detail: undefined })
  assert.equal(parseOptions(['read', '--detail', 'original']).detail, 'original')
  assert.equal(parseOptions(['url', '--url', 'https://e.com/a.png']).url, 'https://e.com/a.png')
  assert.throws(() => parseOptions(['nope']), /Unknown scenario/)
  assert.throws(() => parseOptions(['url']), /requires --url/)
  assert.throws(() => parseOptions(['describe', '--url', 'https://e.com/a.png']), /applies only to the url scenario/)
  assert.throws(() => parseOptions(['describe', '--wat']), /Unrecognized argument/)
})

test('a vision request puts the instruction before the pixels in one user message', () => {
  const built = buildVisionMessages({ prompt: 'Read this', images: [image()], detail: 'original' })
  assert.equal(built.messages.length, 1)
  assert.equal(built.messages[0].role, 'user')
  assert.equal(built.messages[0].content[0].type, 'text')
  assert.equal(built.messages[0].content[1].image_url.detail, 'original')
  assert.equal(built.imageCount, 1)
  assert.throws(() => buildVisionMessages({ prompt: 'x', images: [] }), /at least one image/)
})

test('the compare scenario sends both captures in order for a single question', async () => {
  const calls = []
  const client = fakeMcp([], (name, args) => {
    calls.push(name)
    if (name === 'wait') { assert.equal(args.duration, 3); return { content: [] } }
    return { content: [{ type: 'text', text: 'shot' }, image(name + calls.length)] }
  })
  const deepseek = fakeDeepSeek([{ role: 'assistant', content: 'The dialog closed.' }])

  const result = await runVision({ deepseek, client, options: parseOptions(['compare']) })

  assert.deepEqual(calls, ['screenshot', 'wait', 'screenshot'])
  assert.equal(result.imageCount, 2)
  assert.equal(result.detail, 'low')
  const parts = deepseek.requests[0].messages[0].content.filter(p => p.type === 'image_url')
  assert.equal(parts.length, 2)
  assert.ok(parts[0].image_url.url.endsWith('screenshot1'), 'before must precede after')
  assert.equal(result.text, 'The dialog closed.')
})

test('the url scenario sends only a link and never captures the desktop', async () => {
  const client = fakeMcp([], () => { throw new Error('must not capture') })
  const deepseek = fakeDeepSeek([{ role: 'assistant', content: 'A cat.' }])
  const result = await runVision({ deepseek, client, options: parseOptions(['url', '--url', 'https://e.com/cat.jpg']) })
  assert.equal(result.imageCount, 1)
  assert.equal(deepseek.requests[0].messages[0].content[1].image_url.url, 'https://e.com/cat.jpg')
  assert.equal(result.text, 'A cat.')
})

test('a failed capture is surfaced instead of sending an imageless request', async () => {
  const client = fakeMcp([], () => ({ isError: true, content: [{ type: 'text', text: 'screen recording permission missing' }] }))
  const deepseek = fakeDeepSeek([{ role: 'assistant', content: 'unreachable' }])
  await assert.rejects(
    runVision({ deepseek, client, options: parseOptions(['describe']) }),
    /screen recording permission missing/,
  )
  assert.equal(deepseek.requests.length, 0)
})

test('the read scenario targets the focused window at full resolution', async () => {
  const seen = []
  const client = fakeMcp([], (name, args) => {
    seen.push([name, args])
    if (name === 'list_windows') {
      return { content: [{ type: 'text', text: JSON.stringify({ windows: [
        { windowId: 7, isFocused: false }, { windowId: 9, isFocused: true },
      ] }) }] }
    }
    return { content: [image()] }
  })
  const deepseek = fakeDeepSeek([{ role: 'assistant', content: 'transcribed' }])

  await runVision({ deepseek, client, options: parseOptions(['read']) })

  assert.deepEqual(seen[1], ['screenshot', { target_window_id: 9, quality: 0 }],
    'quality 0 is PNG, which keeps small text legible')
})

test('the read scenario says so when there is nothing to read', async () => {
  const client = fakeMcp([], () => ({ content: [{ type: 'text', text: JSON.stringify({ windows: [] }) }] }))
  await assert.rejects(
    runVision({ deepseek: fakeDeepSeek([]), client, options: parseOptions(['read']) }),
    /No window is open to read/,
  )
})
