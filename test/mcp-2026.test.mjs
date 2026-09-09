import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import test from 'node:test'
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server'
import { createComputerUseHttpHandler } from '../dist/server.js'

const TASKS = 'io.modelcontextprotocol/tasks'

function envelope(capabilities = {}) {
  return {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_INFO_META_KEY]: { name: 'mcp-2026-test', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: capabilities,
  }
}

async function modernRequest(handler, method, params = {}, options = {}) {
  const name = options.name ?? (method.startsWith('tasks/') ? params.taskId : undefined)
  const headers = {
    'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
    ...(name ? { 'mcp-name': String(name) } : {}),
  }
  const response = await handler.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: options.id ?? 1,
      method,
      params: { ...params, _meta: envelope(options.capabilities ?? {}) },
    }),
  }), options.authInfo ? { authInfo: options.authInfo } : undefined)
  return { status: response.status, body: await response.json() }
}

function fakeSession(delayMs = 0) {
  return {
    async dispatch(name, _args, signal) {
      if (delayMs) {
        await new Promise((resolveDelay, reject) => {
          const timer = setTimeout(resolveDelay, delayMs)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(signal.reason ?? new Error('aborted'))
          }, { once: true })
        })
      }
      return { content: [{ type: 'text', text: JSON.stringify({ tool: name, ok: true }) }] }
    },
  }
}

test('2026 discover is stateless and advertises only implemented extensions', async () => {
  const handler = createComputerUseHttpHandler({ session: fakeSession() })
  try {
    const discover = await modernRequest(handler, 'server/discover')
    assert.equal(discover.status, 200)
    assert.deepEqual(discover.body.result.supportedVersions, ['2026-07-28'])
    assert.deepEqual(discover.body.result.capabilities.extensions, { [TASKS]: {} })
    assert.equal(discover.body.result.resultType, 'complete')
    assert.equal(discover.body.result._meta['io.modelcontextprotocol/serverInfo'].version, '7.1.0')

    const listed = await modernRequest(handler, 'tools/list')
    assert.equal(listed.body.result.tools.length, 65)
    for (const tool of listed.body.result.tools) {
      assert.equal(typeof tool.title, 'string')
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name} missing ${hint}`)
      }
    }
    const resources = await modernRequest(handler, 'resources/list')
    assert.equal(resources.body.result.resources.length, 6)
    for (const resource of resources.body.result.resources) {
      assert.deepEqual(resource.annotations?.audience, ['assistant'])
      assert.equal(typeof resource.annotations?.priority, 'number')
    }
    const read = await modernRequest(handler, 'resources/read', { uri: 'computer://display/main' }, { name: 'computer://display/main' })
    assert.deepEqual(read.body.result.contents[0].annotations?.audience, ['assistant'])
  } finally {
    await handler.close()
  }
})

test('Tasks extension creates, polls, isolates, cancels, and validates routing headers', async () => {
  const handler = createComputerUseHttpHandler({ session: fakeSession(80) })
  const capabilities = { extensions: { [TASKS]: {} } }
  const authA = { token: 'a', clientId: 'client-a', scopes: ['mcp'], expiresAt: Date.now() / 1000 + 60 }
  const authB = { token: 'b', clientId: 'client-b', scopes: ['mcp'], expiresAt: Date.now() / 1000 + 60 }
  try {
    const created = await modernRequest(handler, 'tools/call', {
      name: 'get_ui_tree', arguments: {},
    }, { name: 'get_ui_tree', capabilities, authInfo: authA })
    assert.equal(created.body.result.resultType, 'task')
    assert.equal(created.body.result.status, 'working')
    assert.match(created.body.result.taskId, /^cut_[A-Za-z0-9_-]{32}$/)
    const taskId = created.body.result.taskId

    const foreign = await modernRequest(handler, 'tasks/get', { taskId }, { capabilities, authInfo: authB })
    assert.equal(foreign.body.error.code, -32602)

    const badName = await modernRequest(handler, 'tasks/get', { taskId }, {
      name: 'wrong-task', capabilities, authInfo: authA,
    })
    assert.equal(badName.body.error.code, -32020)

    const cancelled = await modernRequest(handler, 'tasks/cancel', { taskId }, { capabilities, authInfo: authA })
    assert.deepEqual(cancelled.body.result.resultType, 'complete')
    const polled = await modernRequest(handler, 'tasks/get', { taskId }, { capabilities, authInfo: authA })
    assert.equal(polled.body.result.status, 'cancelled')

    const noCapability = await modernRequest(handler, 'tasks/get', { taskId }, { authInfo: authA })
    assert.equal(noCapability.status, 400)
    assert.equal(noCapability.body.error.code, -32003)
  } finally {
    await handler.close()
  }
})

test('subscriptions/listen receives only subscribed state-derived resource updates', async () => {
  const handler = createComputerUseHttpHandler({ session: fakeSession() })
  const controller = new AbortController()
  try {
    const request = new Request('http://localhost/mcp', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'subscriptions/listen',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 91, method: 'subscriptions/listen',
        params: {
          notifications: { resourceSubscriptions: ['computer://frontmost'] },
          _meta: envelope(),
        },
      }),
    })
    const response = await handler.fetch(request)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const ack = decoder.decode((await reader.read()).value)
    assert.match(ack, /notifications\/subscriptions\/acknowledged/)
    assert.match(ack, /computer:\/\/frontmost/)

    handler.notify.resourceUpdated('computer://windows')
    await modernRequest(handler, 'tools/call', {
      name: 'activate_app', arguments: { bundle_id: 'com.example.Target' },
    }, { name: 'activate_app' })
    const next = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('resource update timeout')), 500)),
    ])
    const update = decoder.decode(next.value)
    assert.match(update, /notifications\/resources\/updated/)
    assert.match(update, /computer:\/\/frontmost/)
    assert.match(update, /io\.modelcontextprotocol\/subscriptionId/)
    await reader.cancel()
  } finally {
    controller.abort()
    await handler.close()
  }
})

test('Tasks extension returns the final CallToolResult inline', async () => {
  const handler = createComputerUseHttpHandler({ session: fakeSession(10) })
  const capabilities = { extensions: { [TASKS]: {} } }
  try {
    const created = await modernRequest(handler, 'tools/call', {
      name: 'get_ui_tree', arguments: {},
    }, { name: 'get_ui_tree', capabilities })
    const taskId = created.body.result.taskId
    let polled
    for (let i = 0; i < 30; i++) {
      polled = await modernRequest(handler, 'tasks/get', { taskId }, { capabilities })
      if (polled.body.result.status !== 'working') break
      await new Promise(resolveDelay => setTimeout(resolveDelay, 5))
    }
    assert.equal(polled.body.result.status, 'completed')
    assert.equal(polled.body.result.result.resultType, undefined)
    assert.match(polled.body.result.result.content[0].text, /get_ui_tree/)
  } finally {
    await handler.close()
  }
})

test('2026 MRTR requests roots in-band and resumes with signed request state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-use-2026-root-'))
  const selected = join(root, 'note.txt')
  writeFileSync(selected, 'root-scoped')
  const previous = process.env.COMPUTER_USE_FS_ROOTS
  process.env.COMPUTER_USE_FS_ROOTS = root
  const handler = createComputerUseHttpHandler({ disableSessionLock: true, native: {} })
  try {
    const capabilities = { roots: {} }
    const first = await modernRequest(handler, 'tools/call', {
      name: 'filesystem', arguments: { mode: 'read', path: selected },
    }, { name: 'filesystem', capabilities })
    assert.equal(first.body.result.resultType, 'input_required')
    assert.equal(first.body.result.inputRequests.computer_use_roots.method, 'roots/list')
    assert.equal(typeof first.body.result.requestState, 'string')

    const resumed = await modernRequest(handler, 'tools/call', {
      name: 'filesystem',
      arguments: { mode: 'read', path: selected },
      requestState: first.body.result.requestState,
      inputResponses: {
        computer_use_roots: { roots: [{ uri: new URL(`file://${root}/`).href, name: 'workspace' }] },
      },
    }, { name: 'filesystem', capabilities })
    assert.equal(resumed.body.result.resultType, 'complete')
    assert.equal(resumed.body.result.content[0].text, 'root-scoped')
  } finally {
    if (previous === undefined) delete process.env.COMPUTER_USE_FS_ROOTS
    else process.env.COMPUTER_USE_FS_ROOTS = previous
    await handler.close()
  }
})

test('2026 form elicitation is an exact-scope in-band request', async () => {
  const previous = process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR
  process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR = 'activate_app'
  const handler = createComputerUseHttpHandler({ disableSessionLock: true, native: {} })
  try {
    const result = await modernRequest(handler, 'tools/call', {
      name: 'activate_app', arguments: { bundle_id: 'com.example.Target' },
    }, { name: 'activate_app', capabilities: { elicitation: { form: {} } } })
    assert.equal(result.body.result.resultType, 'input_required')
    const request = result.body.result.inputRequests.computer_use_approval
    assert.equal(request.method, 'elicitation/create')
    assert.equal(request.params.mode, 'form')
    assert.match(request.params.message, /tool: activate_app/)
    assert.match(request.params.message, /com\.example\.Target/)
    assert.equal(typeof result.body.result.requestState, 'string')
  } finally {
    if (previous === undefined) delete process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR
    else process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR = previous
    await handler.close()
  }
})

test('stdio modern mode serves the Tasks extension lifecycle without initialize', async () => {
  const child = spawn(process.execPath, [resolve('dist/server.js')], {
    cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
  })
  const pending = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      pending.get(message.id)?.(message)
      pending.delete(message.id)
    }
  })
  let nextId = 1
  const send = (method, params, capabilities, name) => new Promise((resolveMessage, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 4_000)
    pending.set(id, message => { clearTimeout(timer); resolveMessage(message) })
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id, method,
      params: { ...params, _meta: envelope(capabilities) },
    })}\n`)
  })
  const capabilities = { extensions: { [TASKS]: {} } }
  try {
    const discover = await send('server/discover', {}, capabilities)
    assert.deepEqual(discover.result.supportedVersions, ['2026-07-28'])
    const created = await send('tools/call', { name: 'wait', arguments: { duration: 2 } }, capabilities, 'wait')
    assert.equal(created.result.resultType, 'task')
    const taskId = created.result.taskId
    assert.equal((await send('tasks/cancel', { taskId }, capabilities)).result.resultType, 'complete')
    assert.equal((await send('tasks/get', { taskId }, capabilities)).result.status, 'cancelled')
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolveExit => child.once('exit', resolveExit))
  }
})
