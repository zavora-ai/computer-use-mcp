import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { createComputerUseServer } from '../dist/server.js'
import { TOOL_CATALOG } from '../dist/tool-catalog.js'

function mockNative() {
  return {
    getFrontmostApp: () => ({ bundleId: 'com.example.App', displayName: 'App', pid: 1 }),
    listRunningApps: () => [],
    listWindows: () => [],
    getWindow: () => null,
    getDisplaySize: () => ({ width: 100, height: 100, pixelWidth: 100, pixelHeight: 100, scaleFactor: 1 }),
    listDisplays: () => [],
    getActiveSpace: () => 1,
    listSpaces: () => ({ supported: true, active_space_id: 1, displays: [] }),
    drainRunloop: () => {},
  }
}

async function waitFor(predicate, timeout = 1_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for MCP event')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function connect(server, options = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: 'v7.1-test-client', version: '1.0.0' },
    { capabilities: options.capabilities ?? {} },
  )
  options.configure?.(client)
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return { client, close: async () => { await client.close(); await server.close() } }
}

test('v7.1 negotiates client roots and adds readable resource links', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-use-v71-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'computer-use-v71-outside-'))
  let activeRoot = root
  let rootRequests = 0
  const server = createComputerUseServer({ native: mockNative(), disableSessionLock: true })
  const connection = await connect(server, {
    capabilities: { roots: { listChanged: true } },
    configure(client) {
      client.setRequestHandler('roots/list', async () => {
        rootRequests += 1
        return { roots: [{ uri: pathToFileURL(activeRoot).href, name: 'workspace' }] }
      })
    },
  })
  try {
    await waitFor(() => rootRequests > 0)
    const allowedPath = join(root, 'note.txt')
    const allowed = await connection.client.callTool({
      name: 'filesystem',
      arguments: { mode: 'write', path: allowedPath, content: 'hello v7.1' },
    })
    assert.equal(allowed.isError, undefined)
    const link = allowed.content.find(item => item.type === 'resource_link')
    assert.ok(link, 'filesystem success should include a resource link')
    const resource = await connection.client.readResource({ uri: link.uri })
    assert.equal(resource.contents[0].text, 'hello v7.1')
    assert.equal(readFileSync(allowedPath, 'utf8'), 'hello v7.1')

    const denied = await connection.client.callTool({
      name: 'filesystem',
      arguments: { mode: 'write', path: join(outside, 'denied.txt'), content: 'no' },
    })
    assert.equal(denied.isError, true)
    assert.equal(JSON.parse(denied.content[0].text).error, 'fs_root_denied')

    activeRoot = outside
    await connection.client.sendRootsListChanged()
    await waitFor(() => rootRequests > 1)
    const afterChange = await connection.client.callTool({
      name: 'filesystem',
      arguments: { mode: 'write', path: join(outside, 'now-allowed.txt'), content: 'changed roots' },
    })
    assert.equal(afterChange.isError, undefined)
  } finally {
    await connection.close()
  }
})

test('subscriptions, MCP logging, and dynamic tool list changes are observable', async () => {
  const updated = []
  const logs = []
  let listChanges = 0
  let registry
  const server = createComputerUseServer({
    session: {
      async dispatch() { return { content: [{ type: 'text', text: 'ok' }] } },
    },
    onRegistry(value) { registry = value },
  })
  const connection = await connect(server, {
    configure(client) {
      client.setNotificationHandler('notifications/resources/updated', notification => {
        updated.push(notification.params.uri)
      })
      client.setNotificationHandler('notifications/message', notification => {
        logs.push(notification.params)
      })
      client.setNotificationHandler('notifications/tools/list_changed', () => { listChanges += 1 })
    },
  })
  try {
    await connection.client.subscribeResource({ uri: 'computer://frontmost' })
    await connection.client.callTool({ name: 'activate_app', arguments: { bundle_id: 'not-logged.example' } })
    await waitFor(() => updated.includes('computer://frontmost') && logs.some(log => log.data?.tool === 'activate_app'))
    assert.equal(JSON.stringify(logs).includes('not-logged.example'), false, 'MCP logs must not include tool arguments')

    registry.setActiveProfile('core')
    await waitFor(() => listChanges > 0)
    const names = new Set((await connection.client.listTools()).tools.map(tool => tool.name))
    assert.equal(names.has('run_script'), false)
    assert.equal(names.has('screenshot'), true)
    const profileResource = await connection.client.readResource({ uri: 'computer://profile/tools' })
    assert.equal(JSON.parse(profileResource.contents[0].text).profile, 'core')
  } finally {
    await connection.close()
  }
})

test('tools expose human-readable titles in MCP discovery', async () => {
  const server = createComputerUseServer({ session: { async dispatch() { return { content: [{ type: 'text', text: 'ok' }] } } } })
  const connection = await connect(server)
  try {
    const screenshot = (await connection.client.listTools()).tools.find(tool => tool.name === 'get_frontmost_app')
    assert.equal(screenshot?.title, 'Get Frontmost App')
  } finally {
    await connection.close()
  }
})

test('resources expose assistant audience and priority annotations', async () => {
  const server = createComputerUseServer({ session: { async dispatch() { return { content: [{ type: 'text', text: '{}' }] } } } })
  const connection = await connect(server)
  try {
    const resources = (await connection.client.listResources()).resources
    assert.equal(resources.length, 6)
    for (const resource of resources) {
      assert.deepEqual(resource.annotations?.audience, ['assistant'])
      assert.equal(typeof resource.annotations?.priority, 'number')
    }
  } finally {
    await connection.close()
  }
})

test('form elicitation names the exact bounded action scope', async () => {
  const selected = join(mkdtempSync(join(tmpdir(), 'computer-use-v71-elicit-')), 'note.txt')
  let request
  const previous = process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR
  process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR = 'filesystem'
  const server = createComputerUseServer({ native: mockNative(), disableSessionLock: true })
  if (previous === undefined) delete process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR
  else process.env.COMPUTER_USE_REQUIRE_APPROVAL_FOR = previous

  const connection = await connect(server, {
    capabilities: { elicitation: { form: {} } },
    configure(client) {
      client.setRequestHandler('elicitation/create', async incoming => {
        request = incoming.params
        return { action: 'accept', content: { approve: true } }
      })
    },
  })
  try {
    const result = await connection.client.callTool({
      name: 'filesystem',
      arguments: { mode: 'write', path: selected, content: 'approved' },
    })
    assert.equal(result.isError, undefined)
    assert.match(request.message, /tool: filesystem/)
    assert.match(request.message, new RegExp(selected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(request.message, /one-shot|Approve computer-use action/i)
  } finally {
    await connection.close()
  }
})

test('prompt argument completion returns matching running application IDs', async () => {
  const native = mockNative()
  native.listRunningApps = () => [{ bundleId: 'com.example.Editor', displayName: 'Editor', pid: 2, isHidden: false }]
  const server = createComputerUseServer({ native, disableSessionLock: true })
  const connection = await connect(server)
  try {
    const result = await connection.client.complete({
      ref: { type: 'ref/prompt', name: 'fill-form' },
      argument: { name: 'app', value: 'com.example' },
    })
    assert.deepEqual(result.completion.values, ['com.example.Editor'])
  } finally {
    await connection.close()
  }
})

test('registry manifest covers the complete stable v7 tool catalog', () => {
  const manifest = readFileSync(new URL('../mcp-server.toml', import.meta.url), 'utf8')
  assert.match(manifest, /version = "7\.1\.0"/)
  const names = [...manifest.matchAll(/^name = "([^"]+)"$/gm)].map(match => match[1])
  assert.equal(names.length, 64)
  assert.deepEqual(new Set(names), new Set(Object.keys(TOOL_CATALOG)))
})

test('active profile and profile resource cannot exceed the configured maximum', async () => {
  const server = createComputerUseServer({
    profile: 'core',
    activeProfile: 'full',
    session: { async dispatch() { return { content: [{ type: 'text', text: 'ok' }] } } },
  })
  const connection = await connect(server)
  try {
    const listed = await connection.client.listTools()
    const resource = await connection.client.readResource({ uri: 'computer://profile/tools' })
    const payload = JSON.parse(resource.contents[0].text)
    assert.equal(payload.count, listed.tools.length)
    assert.equal(payload.tools.some(tool => tool.name === 'run_script'), false)
  } finally {
    await connection.close()
  }
})
