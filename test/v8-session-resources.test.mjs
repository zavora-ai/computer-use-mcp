import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'
import { RuntimeCoordinator } from '../dist/runtime/coordinator.js'
import { AUDIT_EXPORT_SCHEMA } from '../dist/session/event-schema.js'

const session = { async dispatch() { return { content: [{ type: 'text', text: '{}' }] } } }

function textPayload(result) {
  return JSON.parse(result.contents.find(content => content.text)?.text ?? '{}')
}

test('v8 session resources expose current and by-id lifecycle only to the host principal', async () => {
  const runtime = new RuntimeCoordinator({ execute: (tool, args, signal) => session.dispatch(tool, args, signal) })
  const owner = await connectInProcess(createComputerUseServer({
    session, runtime, enableV8: true, principalId: 'owner',
  }))
  const intruder = await connectInProcess(createComputerUseServer({
    session, runtime, enableV8: true, principalId: 'intruder',
  }))
  try {
    const empty = textPayload(await intruder.readResource('computer://session/current'))
    assert.deepEqual(empty, { available: false, reason: 'no_owned_session' })

    const started = await owner.startSession({ objective: 'resource visibility' })
    const sessionId = started.structuredContent.session.sessionId
    const current = textPayload(await owner.readResource('computer://session/current'))
    assert.equal(current.available, true)
    assert.equal(current.session.sessionId, sessionId)

    const exact = textPayload(await owner.readResource(`computer://session/${sessionId}`))
    assert.equal(exact.session.sessionId, sessionId)
    assert.equal(exact.session.principalId, 'owner')

    const templates = await owner.listResourceTemplates()
    assert.ok(templates.some(template => template.uriTemplate === 'computer://session/{sessionId}'))
    const listed = await owner.listResources()
    assert.ok(listed.some(resource => resource.uri === `computer://session/${sessionId}`))
    assert.ok(listed.some(resource => resource.uri === 'computer://audit/schema'))
    const auditSchema = textPayload(await owner.readResource('computer://audit/schema'))
    assert.equal(auditSchema.schema.$id, 'computer://audit/schema')
    assert.match(auditSchema.digest, /^[a-f0-9]{64}$/)

    await assert.rejects(
      intruder.readResource(`computer://session/${sessionId}`),
      /principal_mismatch|belongs to another principal/,
    )
  } finally {
    await owner.close()
    await intruder.close()
  }
})

test('runtime session enumeration is cloned, principal-scoped, and newest-first', async () => {
  let tick = 0
  const now = () => new Date(1_800_000_000_000 + tick++ * 1_000)
  const { SessionLifecycle } = await import('../dist/session/lifecycle.js')
  const { MemorySessionStore } = await import('../dist/session/store.js')
  const lifecycle = new SessionLifecycle(new MemorySessionStore(now), undefined, now)
  const runtime = new RuntimeCoordinator({
    lifecycle,
    execute: async () => ({ content: [] }),
  })
  const older = await runtime.startSession({ principalId: 'owner' })
  await runtime.startSession({ principalId: 'other' })
  const newer = await runtime.startSession({ principalId: 'owner' })
  const owned = await runtime.listSessions('owner')
  assert.deepEqual(owned.map(value => value.sessionId), [newer.sessionId, older.sessionId])
  owned[0].state = 'failed'
  assert.equal((await runtime.getSession(newer.sessionId, 'owner')).state, 'running')
})

test('published audit JSON Schema is identical to the runtime contract', async () => {
  const fixture = JSON.parse(await readFile(new URL('../contracts/v8/audit-export.schema.json', import.meta.url), 'utf8'))
  assert.deepEqual(fixture, AUDIT_EXPORT_SCHEMA)
})
