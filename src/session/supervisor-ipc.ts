import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import type { RuntimeCoordinator } from '../runtime/coordinator.js'

export interface SupervisorIpcOptions {
  runtime: RuntimeCoordinator
  socketPath: string
  token?: string
  principalId?: string
  maxMessageBytes?: number
}

interface ClientState {
  authenticated: boolean
  principalId?: string
  sessionIds: Set<string>
  buffer: string
}

/**
 * Authenticated newline-delimited local supervisor protocol.
 * The UI gets event/control access only; it never receives native desktop handles.
 */
export class SupervisorIpcServer {
  readonly token: string
  readonly #runtime: RuntimeCoordinator
  readonly #socketPath: string
  readonly #principalId?: string
  readonly #maxMessageBytes: number
  readonly #clients = new Map<Socket, ClientState>()
  #server?: Server
  #unsubscribe?: () => void
  #unsubscribeEmergency?: () => void

  constructor(options: SupervisorIpcOptions) {
    this.#runtime = options.runtime
    this.#socketPath = options.socketPath
    this.#principalId = options.principalId
    this.#maxMessageBytes = options.maxMessageBytes ?? 64 * 1024
    this.token = options.token ?? randomBytes(32).toString('base64url')
  }

  async start(): Promise<void> {
    if (this.#server) throw new Error('supervisor IPC server already started')
    if (process.platform !== 'win32') await rm(this.#socketPath, { force: true })
    this.#server = createServer(socket => this.#accept(socket))
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject)
      this.#server!.listen(this.#socketPath, () => {
        this.#server!.off('error', reject)
        resolve()
      })
    })
    if (process.platform !== 'win32') await chmod(this.#socketPath, 0o600)
    this.#unsubscribe = this.#runtime.events.subscribe(event => {
      for (const [socket, state] of this.#clients) {
        if (state.authenticated && state.sessionIds.has(event.sessionId)) this.#send(socket, { type: 'event', event })
      }
    })
    this.#unsubscribeEmergency = this.#runtime.onEmergencyStopChanged(status => {
      for (const [socket, state] of this.#clients) {
        if (state.authenticated) this.#send(socket, { type: 'emergency_status', ...status })
      }
    })
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#unsubscribeEmergency?.()
    this.#unsubscribeEmergency = undefined
    for (const socket of this.#clients.keys()) socket.destroy()
    this.#clients.clear()
    if (this.#server) {
      const server = this.#server
      this.#server = undefined
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    if (process.platform !== 'win32') await rm(this.#socketPath, { force: true })
  }

  #accept(socket: Socket): void {
    this.#clients.set(socket, { authenticated: false, sessionIds: new Set(), buffer: '' })
    socket.setEncoding('utf8')
    socket.on('data', chunk => this.#receive(socket, String(chunk)))
    socket.on('error', () => socket.destroy())
    socket.on('close', () => this.#clients.delete(socket))
  }

  #receive(socket: Socket, chunk: string): void {
    const state = this.#clients.get(socket)
    if (!state) return
    state.buffer += chunk
    if (Buffer.byteLength(state.buffer) > this.#maxMessageBytes) {
      this.#send(socket, { type: 'error', error: 'message_too_large' })
      socket.destroy()
      return
    }
    let newline: number
    while ((newline = state.buffer.indexOf('\n')) >= 0) {
      const line = state.buffer.slice(0, newline)
      state.buffer = state.buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message: Record<string, unknown>
      try { message = JSON.parse(line) as Record<string, unknown> }
      catch {
        this.#send(socket, { type: 'error', error: 'invalid_json' })
        continue
      }
      void this.#handle(socket, state, message).catch(error => {
        this.#send(socket, { type: 'error', error: 'request_failed', message: error instanceof Error ? error.message : String(error) })
      })
    }
  }

  async #handle(socket: Socket, state: ClientState, message: Record<string, unknown>): Promise<void> {
    const type = String(message.type ?? '')
    if (!state.authenticated) {
      const suppliedToken = typeof message.token === 'string' ? message.token : ''
      const suppliedPrincipal = typeof message.principalId === 'string' ? message.principalId : undefined
      const expected = Buffer.from(this.token)
      const supplied = Buffer.from(suppliedToken)
      const tokenMatches = expected.length === supplied.length && timingSafeEqual(expected, supplied)
      if (type !== 'hello' || !tokenMatches || !suppliedPrincipal
          || (this.#principalId !== undefined && suppliedPrincipal !== this.#principalId)) {
        this.#send(socket, { type: 'error', error: 'unauthorized' })
        socket.destroy()
        return
      }
      state.authenticated = true
      state.principalId = suppliedPrincipal
      this.#send(socket, { type: 'hello', protocolVersion: 2 })
      this.#sendEmergencyStatus(socket)
      return
    }
    const principalId = state.principalId!
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined
    if (type === 'subscribe' && sessionId) {
      await this.#runtime.getSession(sessionId, principalId)
      state.sessionIds.add(sessionId)
      const after = typeof message.afterSequence === 'number' ? message.afterSequence : 0
      for (const event of this.#runtime.events.query(sessionId, after, 1000)) this.#send(socket, { type: 'event', event })
      this.#send(socket, { type: 'subscribed', sessionId })
      return
    }
    if (type === 'emergency_stop') {
      this.#runtime.emergencyStop(typeof message.reason === 'string' ? message.reason : 'supervisor')
      this.#send(socket, { type: 'ack', command: type })
      return
    }
    if (type === 'reset_emergency_stop') {
      this.#runtime.resetEmergencyStop()
      this.#send(socket, { type: 'ack', command: type })
      return
    }
    if (type === 'emergency_status') {
      this.#sendEmergencyStatus(socket)
      return
    }
    if (!sessionId) throw new TypeError('sessionId is required')
    await this.#runtime.getSession(sessionId, principalId)
    if (type === 'get_frame') {
      if (!state.sessionIds.has(sessionId)) throw new Error('session subscription is required')
      if (typeof message.frameId !== 'string' || !message.frameId || message.frameId.length > 128) {
        throw new TypeError('a valid frameId is required')
      }
      const frame = await this.#runtime.getEvidenceFrame(sessionId, principalId, message.frameId)
      if (!frame) throw new Error('evidence frame is unavailable or expired')
      this.#send(socket, { type: 'evidence_frame', frame })
      return
    }
    if (type === 'pause') await this.#runtime.pauseSession(sessionId, principalId, String(message.reason ?? 'supervisor_pause'))
    else if (type === 'resume') await this.#runtime.resumeSession(sessionId, principalId)
    else if (type === 'takeover') await this.#runtime.takeOver(sessionId, principalId)
    else if (type === 'stop') await this.#runtime.stopSession(sessionId, principalId, String(message.reason ?? 'supervisor_stop'))
    else if (type === 'approve') {
      if (typeof message.actionId !== 'string') throw new TypeError('actionId is required')
      const scope = message.scope === 'session_operation' ? 'session_operation' : 'exact_action'
      const uses = scope === 'session_operation' && Number.isInteger(message.uses)
        ? Number(message.uses) : undefined
      const grant = await this.#runtime.approveAction(
        sessionId, principalId, message.actionId, Number(message.ttlMs ?? 60_000),
        { scope, ...(uses !== undefined ? { uses } : {}) },
      )
      this.#send(socket, { type: 'approved', actionId: message.actionId, grant })
      return
    } else throw new Error(`unknown supervisor command: ${type}`)
    this.#send(socket, { type: 'ack', command: type, sessionId })
  }

  #send(socket: Socket, message: unknown): void {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
  }

  #sendEmergencyStatus(socket: Socket): void {
    this.#send(socket, { type: 'emergency_status', ...this.#runtime.emergencyStopStatus() })
  }
}
