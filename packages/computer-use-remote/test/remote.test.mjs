import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createComputerUseServer } from '../../../dist/server.js'
import { RuntimeCoordinator } from '../../../dist/runtime/coordinator.js'
import { createFilePairingAuthority, createVaultPairingAuthority, PairingAuthority } from '../src/pairing.mjs'
import {
  createLinuxSecretServiceVault, createMacOSKeychainVault,
  createOperatingSystemCredentialVault, createWindowsDpapiVault,
} from '../src/os-vault.mjs'
import { RemoteSidecar } from '../src/sidecar.mjs'
import { BoundedEventStore } from '../src/event-store.mjs'
import {
  createComputerUseRemoteServerFactory, createRemoteToolAuthorizer,
  createRuntimeAuthorizationLossHandler, createRuntimeRemoteEventSource, requiredRemoteScope,
} from '../src/scope-policy.mjs'

function issue(authority, principalId, scopes = ['computer:observe']) {
  const clientNonce = `nonce-${'x'.repeat(40)}-${principalId}`
  const request = authority.requestPairing({ deviceName: `${principalId} phone`, clientNonce, requestedScopes: scopes })
  authority.confirmPairing(request.requestId, { principalId, scopes })
  return authority.claimPairing({ requestId: request.requestId, code: request.code, clientNonce })
}

test('pairing is host-confirmed, nonce-bound, one-time, rotatable, and revocable', async () => {
  const authority = new PairingAuthority()
  const clientNonce = `client-${'n'.repeat(40)}`
  const request = authority.requestPairing({
    deviceName: 'tablet', clientNonce,
    requestedScopes: ['computer:observe', 'computer:control'],
  })
  assert.throws(() => authority.claimPairing({
    requestId: request.requestId, code: request.code, clientNonce,
  }), /invalid_pairing_claim/)
  authority.confirmPairing(request.requestId, { principalId: 'alice', scopes: ['computer:observe'] })
  assert.throws(() => authority.claimPairing({
    requestId: request.requestId, code: request.code, clientNonce: `${clientNonce}-stolen`,
  }), /invalid_pairing_claim/)
  const claimed = authority.claimPairing({ requestId: request.requestId, code: request.code, clientNonce })
  const verified = await authority.verifyAccessToken(claimed.access_token)
  assert.equal(verified.extra.principalId, 'alice')
  assert.deepEqual(verified.scopes, ['computer:observe'])
  assert.throws(() => authority.claimPairing({ requestId: request.requestId, code: request.code, clientNonce }))

  const rotated = authority.rotateDevice(verified.clientId)
  await assert.rejects(authority.verifyAccessToken(claimed.access_token), /invalid_token/)
  assert.equal((await authority.verifyAccessToken(rotated.access_token)).clientId, verified.clientId)
  assert.equal(authority.revokeDevice(verified.clientId), true)
  await assert.rejects(authority.verifyAccessToken(rotated.access_token), /invalid_token/)
})

test('remote sidecar rejects wildcard and non-TLS LAN binding', () => {
  const createServer = async () => new McpServer({ name: 'test', version: '1' })
  assert.throws(() => new RemoteSidecar({ host: '0.0.0.0', createServer }), /wildcard/)
  assert.throws(() => new RemoteSidecar({ host: '192.168.1.20', allowLan: true, createServer }), /TLS/)
  assert.throws(() => new RemoteSidecar({ host: '8.8.8.8', allowLan: true, tls: {}, createServer }), /private/)
})

test('bounded MCP redelivery replays only the authenticated transport stream after its exact cursor', async () => {
  const store = new BoundedEventStore({ maxEvents: 3, maxBytes: 4096 })
  const first = await store.storeEvent('stream-a', { jsonrpc: '2.0', method: 'one' })
  await store.storeEvent('stream-b', { jsonrpc: '2.0', method: 'private-other-stream' })
  const second = await store.storeEvent('stream-a', { jsonrpc: '2.0', method: 'two' })
  const replayed = []
  assert.equal(await store.replayEventsAfter(first, { send: (id, message) => replayed.push({ id, message }) }), 'stream-a')
  assert.deepEqual(replayed, [{ id: second, message: { jsonrpc: '2.0', method: 'two' } }])
  await store.storeEvent('stream-a', { jsonrpc: '2.0', method: 'three' })
  assert.equal(await store.replayEventsAfter(first, { send: () => assert.fail('evicted cursor must not replay') }), '')
})

test('durable pairing authority survives restart without persisting bearer-token bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-remote-auth-'))
  const path = join(directory, 'devices.json')
  try {
    const first = createFilePairingAuthority(path)
    const issued = issue(first, 'durable-principal')
    const persisted = await readFile(path, 'utf8')
    assert.doesNotMatch(persisted, new RegExp(issued.access_token))
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
    const restarted = createFilePairingAuthority(path)
    const verified = await restarted.verifyAccessToken(issued.access_token)
    assert.equal(verified.extra.principalId, 'durable-principal')
    restarted.revokeDevice(verified.clientId)
    const revokedRestart = createFilePairingAuthority(path)
    await assert.rejects(revokedRestart.verifyAccessToken(issued.access_token), /invalid_token/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('credential-vault authority persists hash-only state synchronously across restart', async () => {
  const entries = new Map()
  const writes = []
  const vault = {
    get: key => entries.get(key),
    set: (key, value) => { writes.push({ key, value }); entries.set(key, value) },
  }
  const first = createVaultPairingAuthority(vault, { key: 'test/device-authorizations' })
  const issued = issue(first, 'vault-owner')
  assert.equal(writes.length, 3)
  assert.equal(writes.every(write => !write.value.includes(issued.access_token)), true)
  assert.equal(writes.some(write => write.value.includes('tokenKey')), true)
  assert.equal(writes.some(write => write.key.endsWith('/rollback-anchor')), true)

  const restarted = createVaultPairingAuthority(vault, { key: 'test/device-authorizations' })
  assert.equal((await restarted.verifyAccessToken(issued.access_token)).extra.principalId, 'vault-owner')
  restarted.revokeDevice((await restarted.verifyAccessToken(issued.access_token)).clientId)
  await assert.rejects(restarted.verifyAccessToken(issued.access_token), /invalid_token/)

  assert.throws(() => createVaultPairingAuthority({
    get: async () => undefined, set: () => {},
  }), /get must be synchronous/)
  assert.throws(() => createVaultPairingAuthority({
    get: () => undefined, set: async () => {},
  }), /set must be synchronous/)
})

test('vault rollback anchor detects stale authorization and safely recovers state-first crashes', async () => {
  const key = 'rollback/device-authorizations'
  const anchorKey = `${key}/rollback-anchor`
  const entries = new Map()
  let failAnchor = false
  const vault = {
    get: name => entries.get(name),
    set: (name, value) => {
      if (failAnchor && name === anchorKey) {
        failAnchor = false
        throw new Error('injected anchor commit failure')
      }
      entries.set(name, value)
    },
  }
  const first = createVaultPairingAuthority(vault, { key })
  const issued = issue(first, 'rollback-owner')
  const staleState = entries.get(key)
  const deviceId = (await first.verifyAccessToken(issued.access_token)).clientId
  first.rotateDevice(deviceId)
  entries.set(key, staleState)
  assert.throws(() => createVaultPairingAuthority(vault, { key }), /pairing_state_rollback_detected/)

  // Restore the committed pair, then interrupt a revocation after state but
  // before its anchor. Restart may advance exactly one linked revision and
  // must retain the revocation rather than resurrecting the token.
  const cleanEntries = new Map()
  const crashVault = {
    get: name => cleanEntries.get(name),
    set: (name, value) => {
      if (failAnchor && name === anchorKey) {
        failAnchor = false
        throw new Error('injected anchor commit failure')
      }
      cleanEntries.set(name, value)
    },
  }
  const beforeCrash = createVaultPairingAuthority(crashVault, { key })
  const crashToken = issue(beforeCrash, 'crash-owner')
  const crashDevice = (await beforeCrash.verifyAccessToken(crashToken.access_token)).clientId
  failAnchor = true
  assert.throws(() => beforeCrash.revokeDevice(crashDevice), /injected anchor commit failure/)
  const recovered = createVaultPairingAuthority(crashVault, { key })
  await assert.rejects(recovered.verifyAccessToken(crashToken.access_token), /invalid_token/)
  const stateEnvelope = JSON.parse(cleanEntries.get(key))
  const anchor = JSON.parse(cleanEntries.get(anchorKey))
  assert.equal(anchor.revision, stateEnvelope.revision)
  assert.equal(anchor.stateDigest, stateEnvelope.stateDigest)

  const tampered = structuredClone(stateEnvelope)
  tampered.state.devices[0].principalId = 'attacker'
  cleanEntries.set(key, JSON.stringify(tampered))
  assert.throws(() => createVaultPairingAuthority(crashVault, { key }), /invalid_pairing_state/)
})

test('first-party OS vaults keep authorization values off argv and fail closed', async () => {
  const macCalls = []
  let macValue
  const native = {
    keychainGetGenericPassword: (service, account) => {
      macCalls.push({ operation: 'get', service, account })
      return macValue
    },
    keychainSetGenericPassword: (service, account, value) => {
      macCalls.push({ operation: 'set', service, account, valueInMemory: value })
      macValue = value
    },
  }
  const mac = createMacOSKeychainVault({ native })
  assert.equal(mac.get('device-records'), undefined)
  mac.set('device-records', 'hash-only-json')
  assert.equal(mac.get('device-records'), 'hash-only-json')
  assert.equal(mac.backend, 'macos_keychain')
  assert.equal(macCalls.every(call => call.service === 'ai.zavora.computer-use-remote'), true)
  assert.throws(() => createMacOSKeychainVault(), /host-native binding/)

  const linuxCalls = []
  let linuxValue
  const linux = createLinuxSecretServiceVault({ run: (command, args, options) => {
    linuxCalls.push({ command, args, input: options.input })
    if (args[0] === 'lookup') return linuxValue === undefined
      ? { status: 1, stdout: '', stderr: '' }
      : { status: 0, stdout: `${linuxValue}\n`, stderr: '' }
    linuxValue = options.input.replace(/\n$/, '')
    return { status: 0, stdout: '', stderr: '' }
  } })
  assert.equal(linux.get('device-records'), undefined)
  linux.set('device-records', 'hash-only-json')
  assert.equal(linux.get('device-records'), 'hash-only-json')
  assert.equal(linuxCalls.some(call => call.args.includes('hash-only-json')), false)
  assert.throws(() => createLinuxSecretServiceVault({ run: () => ({
    status: 1, stdout: '', stderr: 'keyring is locked',
  }) }).get('device-records'), /keyring is locked/)

  const directory = await mkdtemp(join(tmpdir(), 'computer-use-dpapi-vault-'))
  const windowsCalls = []
  const run = (command, args, options) => {
    windowsCalls.push({ command, args, input: options.input, env: options.env })
    const payload = JSON.parse(options.input)
    if (args.at(-1).includes('::Protect(')) {
      return { status: 0, stdout: Buffer.from(`wrapped:${payload.data}`).toString('base64'), stderr: '' }
    }
    const wrapped = Buffer.from(payload.data, 'base64').toString()
    return { status: 0, stdout: Buffer.from(wrapped.slice('wrapped:'.length), 'base64').toString(), stderr: '' }
  }
  try {
    const windows = createWindowsDpapiVault({ directory, run })
    const authority = createVaultPairingAuthority(windows, { key: 'device-records' })
    const issued = issue(authority, 'dpapi-owner')
    const files = await readdir(directory)
    assert.equal(files.length, 2)
    for (const file of files) {
      const encrypted = await readFile(join(directory, file), 'utf8')
      assert.doesNotMatch(encrypted, new RegExp(issued.access_token))
      assert.doesNotMatch(encrypted, /tokenKey|dpapi-owner/)
    }
    assert.equal(windowsCalls.some(call => call.args.some(arg => arg.includes(issued.access_token))), false)
    assert.equal(windowsCalls.some(call => Object.values(call.env).includes(issued.access_token)), false)
    const restarted = createVaultPairingAuthority(createWindowsDpapiVault({ directory, run }), {
      key: 'device-records',
    })
    assert.equal((await restarted.verifyAccessToken(issued.access_token)).extra.principalId, 'dpapi-owner')
  } finally { await rm(directory, { recursive: true, force: true }) }

  assert.equal(createOperatingSystemCredentialVault({ platform: 'darwin', native }).backend, 'macos_keychain')
  assert.equal(createOperatingSystemCredentialVault({ platform: 'linux', run: () => ({ status: 1 }) }).backend, 'linux_secret_service')
  assert.throws(() => createOperatingSystemCredentialVault({ platform: 'freebsd' }), /no first-party/)
})

test('remote scope policy separates pixels, approvals, observations, and mutations', () => {
  assert.equal(requiredRemoteScope('execute_action', { tool: 'screenshot' }), 'computer:screenshot')
  assert.equal(requiredRemoteScope('execute_action', { tool: 'get_ui_tree' }), 'computer:observe')
  assert.equal(requiredRemoteScope('execute_action', { tool: 'left_click' }), 'computer:execute')
  assert.equal(requiredRemoteScope('approve_action'), 'computer:approve')
  assert.equal(requiredRemoteScope('pause_session'), 'computer:control')
  const authInfo = {
    token: 'x'.repeat(43), clientId: 'device', scopes: ['computer:observe'],
    extra: { authContextId: 'context', principalId: 'alice' },
  }
  const authorize = createRemoteToolAuthorizer(authInfo)
  assert.doesNotThrow(() => authorize({
    definition: { name: 'execute_action' }, args: { tool: 'get_ui_tree' }, authInfo,
  }))
  assert.throws(() => authorize({
    definition: { name: 'execute_action' }, args: { tool: 'left_click' }, authInfo,
  }), /computer:execute/)
  assert.throws(() => authorize({
    definition: { name: 'get_session' }, args: {},
    authInfo: { ...authInfo, extra: { ...authInfo.extra, authContextId: 'other' } },
  }), /context mismatch/)
})

test('Streamable HTTP binds MCP sessions to one authorization context and suspends on revocation', async () => {
  const authority = new PairingAuthority()
  const alice = issue(authority, 'alice')
  const bob = issue(authority, 'bob')
  const lost = []
  const sidecar = new RemoteSidecar({
    port: 0, authority, authorizationIdleMs: 10_000,
    onAuthorizationLost: event => { lost.push(event) },
    createServer: async ({ principalId }) => {
      const server = new McpServer({ name: 'remote-test', version: '1.0.0' })
      server.registerTool('whoami', { inputSchema: {} }, async (_args, extra) => ({
        content: [{ type: 'text', text: JSON.stringify({
          principalId, transportPrincipal: extra.authInfo?.extra?.principalId,
        }) }],
      }))
      return server
    },
  })
  const address = await sidecar.start()
  const endpoint = new URL(`${address.protocol}://127.0.0.1:${address.port}/mcp`)
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${alice.access_token}` } },
  })
  const client = new Client({ name: 'alice-client', version: '1' })
  try {
    await client.connect(transport)
    const result = await client.callTool({ name: 'whoami', arguments: {} })
    assert.deepEqual(JSON.parse(result.content[0].text), {
      principalId: 'alice', transportPrincipal: 'alice',
    })
    assert.match(transport.sessionId, /^[A-Za-z0-9_-]{43}$/)

    const crossed = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bob.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': transport.sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
    })
    assert.equal(crossed.status, 403)
    assert.deepEqual(await crossed.json(), { error: 'authorization_context_mismatch' })

    const aliceDevice = (await authority.verifyAccessToken(alice.access_token)).clientId
    authority.revokeDevice(aliceDevice, 'host_revoked')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(lost.length, 1)
    assert.equal(lost[0].principalId, 'alice')
    assert.equal(lost[0].reason, 'host_revoked')
  } finally {
    await client.close().catch(() => {})
    await sidecar.stop()
  }
})

test('pairing HTTP response withholds the code and rejects browser origins by default', async () => {
  let hostRequest
  const sidecar = new RemoteSidecar({
    port: 0,
    pairingRequestsPerHour: 1,
    createServer: async () => new McpServer({ name: 'unused', version: '1' }),
    onPairingRequested: request => { hostRequest = request },
  })
  const address = await sidecar.start()
  const base = `${address.protocol}://127.0.0.1:${address.port}`
  try {
    const body = { deviceName: 'phone', clientNonce: 'z'.repeat(40), requestedScopes: ['computer:observe'] }
    const request = await fetch(`${base}/pairing/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(request.status, 202)
    const publicReply = await request.json()
    assert.equal(publicReply.code, undefined)
    assert.equal(hostRequest.requestId, publicReply.requestId)
    assert.match(hostRequest.code, /^\d{8}$/)

    const csrf = await fetch(`${base}/pairing/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify(body),
    })
    assert.equal(csrf.status, 403)
    assert.deepEqual(await csrf.json(), { error: 'origin_not_allowed' })

    const limited = await fetch(`${base}/pairing/request`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    assert.equal(limited.status, 429)
    assert.deepEqual(await limited.json(), { error: 'rate_limited' })
  } finally { await sidecar.stop() }
})

test('core v8 remote adapter enforces scopes and pauses owned work on liveness loss', async () => {
  const authority = new PairingAuthority()
  const observeOnly = issue(authority, 'remote-principal', ['computer:observe'])
  const control = issue(authority, 'remote-principal', ['computer:observe', 'computer:control'])
  const intruder = issue(authority, 'other-principal', ['computer:observe'])
  const session = { async dispatch() { return { content: [] } } }
  const runtime = new RuntimeCoordinator({
    requireManagedSession: true,
    execute: (tool, args, signal) => session.dispatch(tool, args, signal),
  })
  const sidecar = new RemoteSidecar({
    port: 0, authority, authorizationIdleMs: 1_000,
    createServer: createComputerUseRemoteServerFactory({ createComputerUseServer, runtime, session }),
    onAuthorizationLost: createRuntimeAuthorizationLossHandler(runtime),
    eventSource: createRuntimeRemoteEventSource(runtime),
  })
  const address = await sidecar.start()
  const endpoint = new URL(`${address.protocol}://127.0.0.1:${address.port}/mcp`)
  const connect = async token => {
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
    const client = new Client({ name: 'scoped-client', version: '1' })
    await client.connect(transport)
    return { client, transport }
  }
  const observer = await connect(observeOnly.access_token)
  const controller = await connect(control.access_token)
  try {
    const denied = await observer.client.callTool({ name: 'start_session', arguments: {} })
    assert.equal(denied.isError, true)
    assert.match(denied.content[0].text, /missing required scope: computer:control/)
    const started = await controller.client.callTool({ name: 'start_session', arguments: { objective: 'remote work' } })
    const sessionId = started.structuredContent.session.sessionId
    const eventsAbort = new AbortController()
    const events = await fetch(`${endpoint.origin}/events?session_id=${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${control.access_token}` }, signal: eventsAbort.signal,
    })
    assert.equal(events.status, 200)
    const eventReader = events.body.getReader()
    const firstFrame = new TextDecoder().decode((await eventReader.read()).value)
    assert.match(firstFrame, /event: session/)
    assert.match(firstFrame, /session\.created/)

    const crossedEvents = await fetch(`${endpoint.origin}/events?session_id=${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${intruder.access_token}` },
    })
    assert.equal(crossedEvents.status, 404)

    const controllerDevice = (await authority.verifyAccessToken(control.access_token)).clientId
    authority.revokeDevice(controllerDevice, 'host_revoked')
    assert.equal((await eventReader.read()).done, true, 'revocation closes the live event stream')
    eventsAbort.abort()
    assert.equal((await runtime.getSession(sessionId, 'remote-principal')).state, 'paused_by_policy')

    const reauthorized = issue(authority, 'remote-principal', ['computer:observe', 'computer:control'])
    const resumedConnection = await connect(reauthorized.access_token)
    await resumedConnection.client.callTool({ name: 'resume_session', arguments: { session_id: sessionId } })
    await new Promise(resolve => setTimeout(resolve, 1_100))
    assert.equal((await runtime.getSession(sessionId, 'remote-principal')).state, 'paused_by_policy')
    await resumedConnection.client.close().catch(() => {})
  } finally {
    await observer.client.close().catch(() => {})
    await controller.client.close().catch(() => {})
    await sidecar.stop()
    runtime.dispose()
  }
})
