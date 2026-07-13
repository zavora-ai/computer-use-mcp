import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { createComputerUseServer } from '../dist/server.js'

const session = { async dispatch() { return { content: [] } } }

async function waitTaskStatus(client, taskId, expected) {
  const deadline = Date.now() + 500
  let task
  do {
    task = await client.experimental.tasks.getTask(taskId)
    if (task.status === expected) return task
    await new Promise(resolve => setTimeout(resolve, 5))
  } while (Date.now() < deadline)
  assert.equal(task.status, expected)
}

async function taskFixture() {
  let runtime
  const server = createComputerUseServer({
    session,
    enableV8: true,
    enableExperimentalTasks: true,
    principalId: 'task-owner',
    onRuntime: value => { runtime = value },
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client(
    { name: 'task-test', version: '1.0.0' },
    { capabilities: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } } },
  )
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    runtime,
    client,
    async close() { await client.close(); await server.close() },
  }
}

test('experimental MCP Task completes from authoritative v8 completion evidence', async () => {
  const fixture = await taskFixture()
  try {
    const tools = (await fixture.client.listTools()).tools
    const tool = tools.find(value => value.name === 'run_session_task')
    assert.equal(tool.execution.taskSupport, 'required')
    const stream = fixture.client.experimental.tasks.callToolStream(
      { name: 'run_session_task', arguments: { objective: 'task projection' } },
      undefined,
      { task: { ttl: 120_000 } },
    )
    const createdMessage = await stream.next()
    assert.equal(createdMessage.value.type, 'taskCreated')
    const created = createdMessage.value
    assert.equal(created.task.status, 'working')
    const [runtimeSession] = await fixture.runtime.listSessions('task-owner')
    assert.equal(runtimeSession.executionGroupId, `mcp-task:${created.task.taskId}`)

    await fixture.runtime.completeSession(runtimeSession.sessionId, 'task-owner', {
      summary: 'done',
      postconditions: [{ description: 'complete', satisfied: true }],
      actionCounts: { committed: 0 },
    })
    let terminal
    for await (const message of stream) {
      if (message.type === 'result') terminal = message.result
    }
    assert.ok(terminal)
    const task = await fixture.client.experimental.tasks.getTask(created.task.taskId)
    assert.equal(task.status, 'completed')
    const result = await fixture.client.experimental.tasks.getTaskResult(
      created.task.taskId, CallToolResultSchema,
    )
    assert.equal(result.structuredContent.session.state, 'completed')
    assert.equal(result.structuredContent.session.sessionId, runtimeSession.sessionId)
  } finally { await fixture.close() }
})

test('MCP task cancellation stops v8 first and leaves no active session', async () => {
  const fixture = await taskFixture()
  try {
    const stream = fixture.client.experimental.tasks.callToolStream(
      { name: 'run_session_task', arguments: {} }, undefined, { task: { ttl: 120_000 } },
    )
    const createdMessage = await stream.next()
    assert.equal(createdMessage.value.type, 'taskCreated')
    const created = createdMessage.value
    const [runtimeSession] = await fixture.runtime.listSessions('task-owner')
    await fixture.runtime.leases.acquire({
      sessionId: runtimeSession.sessionId,
      principalId: 'task-owner',
      kind: 'cooperative', executionMode: 'background',
      ttlMs: 10_000, actionBudget: 1,
    })
    assert.ok(fixture.runtime.leases.current())
    await fixture.client.experimental.tasks.cancelTask(created.task.taskId)
    const deadline = Date.now() + 500
    let stopped
    do {
      stopped = await fixture.runtime.getSession(runtimeSession.sessionId, 'task-owner')
      if (stopped.state === 'stopped') break
      await new Promise(resolve => setTimeout(resolve, 10))
    } while (Date.now() < deadline)
    assert.equal(stopped.state, 'stopped')
    assert.equal(fixture.runtime.leases.current(), undefined)
    assert.equal((await fixture.client.experimental.tasks.getTask(created.task.taskId)).status, 'cancelled')
    await stream.return()
  } finally { await fixture.close() }
})

test('paused v8 lifecycle projects as input_required and resumes as working', async () => {
  const fixture = await taskFixture()
  try {
    const stream = fixture.client.experimental.tasks.callToolStream(
      { name: 'run_session_task', arguments: {} }, undefined, { task: { ttl: 120_000 } },
    )
    const created = (await stream.next()).value
    const [runtimeSession] = await fixture.runtime.listSessions('task-owner')
    await fixture.runtime.pauseSession(runtimeSession.sessionId, 'task-owner', 'approval_needed')
    await waitTaskStatus(fixture.client, created.task.taskId, 'input_required')
    await fixture.runtime.resumeSession(runtimeSession.sessionId, 'task-owner')
    await waitTaskStatus(fixture.client, created.task.taskId, 'working')
    await fixture.client.experimental.tasks.cancelTask(created.task.taskId)
    await stream.return()
  } finally { await fixture.close() }
})

test('experimental tasks are opt-in and cannot be enabled over the legacy dispatcher', async () => {
  assert.throws(
    () => createComputerUseServer({ session, enableExperimentalTasks: true }),
    /require the enforced v8 runtime/,
  )
  const server = createComputerUseServer({ session, enableV8: true })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'no-tasks', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    assert.equal((await client.listTools()).tools.some(value => value.name === 'run_session_task'), false)
  } finally { await client.close(); await server.close() }
})
