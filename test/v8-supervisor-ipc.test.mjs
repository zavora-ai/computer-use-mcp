import test from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeCoordinator } from '../dist/runtime/coordinator.js'
import { SupervisorIpcServer } from '../dist/session/supervisor-ipc.js'

function client(path) {
  const socket = createConnection(path)
  const messages = []
  const waiters = []
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const value = JSON.parse(line)
      messages.push(value)
      for (const wake of waiters.splice(0)) wake()
    }
  })
  return {
    socket, messages,
    send: value => socket.write(`${JSON.stringify(value)}\n`),
    async waitFor(predicate, timeoutMs = 1_000, afterIndex = 0) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = messages.slice(afterIndex).find(predicate)
        if (found) return found
        await Promise.race([
          new Promise(resolve => waiters.push(resolve)),
          new Promise(resolve => setTimeout(resolve, 20)),
        ])
      }
      throw new Error(`timed out waiting for message; received ${JSON.stringify(messages)}`)
    },
  }
}

test('local supervisor IPC authenticates, replays events, controls lifecycle, and binds approvals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-supervisor-'))
  const socketPath = join(directory, 'supervisor.sock')
  const coordinator = new RuntimeCoordinator({
    requireManagedSession: true,
    policy: envelope => envelope.tool === 'notification'
      ? { decision: 'confirm', policyDigest: 'supervisor-test', reasons: ['confirm'] }
      : { decision: 'allow', policyDigest: 'supervisor-test', reasons: ['allow'] },
    execute: async () => ({ content: [{ type: 'text', text: 'done' }] }),
  })
  const session = await coordinator.startSession({ principalId: 'owner', objective: 'supervise' })
  const server = new SupervisorIpcServer({
    runtime: coordinator, socketPath, token: 'local-secret', principalId: 'owner',
  })
  await server.start()
  let connected
  try {
    if (process.platform !== 'win32') assert.equal((await stat(socketPath)).mode & 0o777, 0o600)

    const rejected = client(socketPath)
    rejected.send({ type: 'hello', token: 'wrong', principalId: 'owner' })
    assert.equal((await rejected.waitFor(message => message.error === 'unauthorized')).type, 'error')

    const impersonation = client(socketPath)
    impersonation.send({ type: 'hello', token: 'local-secret', principalId: 'other-principal' })
    assert.equal((await impersonation.waitFor(message => message.error === 'unauthorized')).type, 'error')

    connected = client(socketPath)
    connected.send({ type: 'hello', token: 'local-secret', principalId: 'owner' })
    assert.equal((await connected.waitFor(message => message.type === 'hello')).protocolVersion, 1)
    assert.equal((await connected.waitFor(message => message.type === 'emergency_status' && !message.active)).backend, 'cooperative_runtime_only')
    connected.send({ type: 'subscribe', sessionId: session.sessionId, afterSequence: 0 })
    assert.equal((await connected.waitFor(message => message.type === 'subscribed')).sessionId, session.sessionId)
    assert.ok(await connected.waitFor(message => message.type === 'event' && message.event.type === 'session.created'))

    connected.send({ type: 'pause', sessionId: session.sessionId, reason: 'inspect' })
    await connected.waitFor(message => message.type === 'ack' && message.command === 'pause')
    assert.equal((await coordinator.getSession(session.sessionId, 'owner')).state, 'paused_by_user')
    connected.send({ type: 'resume', sessionId: session.sessionId })
    await connected.waitFor(message => message.type === 'ack' && message.command === 'resume')

    const action = {
      actionId: 'approved-notification', tool: 'notification', mode: 'background',
      args: { title: 'Finished', message: 'The task is complete' },
    }
    await coordinator.preview({ ...action, sessionId: session.sessionId, principalId: 'owner' })
    connected.send({
      type: 'approve', sessionId: session.sessionId, actionId: action.actionId, ttlMs: 30_000,
    })
    const approved = await connected.waitFor(message => message.type === 'approved')
    const preview = await coordinator.preview({
      ...action, sessionId: session.sessionId, principalId: 'owner', approvalGrantId: approved.grant.grantId,
    })
    assert.equal(preview.executable, true)
    const changed = await coordinator.preview({
      ...action, sessionId: session.sessionId, principalId: 'owner',
      args: { ...action.args, message: 'Changed after approval' }, approvalGrantId: approved.grant.grantId,
    })
    assert.equal(changed.blocker, 'approval_required')

    connected.send({ type: 'emergency_stop', reason: 'operator_chord' })
    await connected.waitFor(message => message.type === 'ack' && message.command === 'emergency_stop')
    assert.equal((await connected.waitFor(message => message.type === 'emergency_status' && message.active)).active, true)
    await assert.rejects(coordinator.leases.acquire({
      sessionId: session.sessionId, principalId: 'owner', kind: 'cooperative',
      executionMode: 'foreground', ttlMs: 10_000, actionBudget: 1,
    }), /emergency stop is active/)
    connected.send({ type: 'reset_emergency_stop' })
    await connected.waitFor(message => message.type === 'ack' && message.command === 'reset_emergency_stop')
    assert.equal(coordinator.emergencyStopStatus().active, false)
    const recoveredLease = await coordinator.leases.acquire({
      sessionId: session.sessionId, principalId: 'owner', kind: 'cooperative',
      executionMode: 'foreground', ttlMs: 10_000, actionBudget: 1,
    })
    assert.equal(recoveredLease.state, 'active')
    coordinator.leases.release(recoveredLease.leaseId)

    const beforePhysical = connected.messages.length
    coordinator.emergencyStop('simulated_physical_chord', true)
    assert.equal((await connected.waitFor(
      message => message.type === 'emergency_status' && message.active,
      1_000,
      beforePhysical,
    )).active, true)
    coordinator.resetEmergencyStop()
  } finally {
    connected?.socket.destroy()
    await server.stop()
    coordinator.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
