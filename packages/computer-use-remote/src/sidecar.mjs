import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { isIP } from 'node:net'
import { randomBytes } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { BoundedEventStore } from './event-store.mjs'
import { PairingAuthority, PairingError } from './pairing.mjs'

function isLoopback(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

function isPrivateAddress(host) {
  if (isLoopback(host)) return true
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  const normalized = host.toLowerCase()
  return isIP(host) === 6 && (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:'))
}

function header(req, name) {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function bearer(req) {
  const value = header(req, 'authorization')
  const match = typeof value === 'string' ? /^Bearer ([A-Za-z0-9_-]+)$/.exec(value) : null
  return match?.[1]
}

function json(res, status, body, headers = {}) {
  if (res.headersSent) return
  const data = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers,
  })
  res.end(data)
}

async function readJson(req, maximum) {
  const type = header(req, 'content-type') ?? ''
  if (!String(type).toLowerCase().startsWith('application/json')) throw new HttpError(415, 'json_required')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maximum) throw new HttpError(413, 'request_too_large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new HttpError(400, 'invalid_json') }
}

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}

class FixedWindowLimiter {
  #entries = new Map()
  constructor(limit, windowMs, now = () => Date.now()) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
  }
  consume(key) {
    const now = this.now()
    const current = this.#entries.get(key)
    const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + this.windowMs } : current
    entry.count += 1
    this.#entries.set(key, entry)
    return { allowed: entry.count <= this.limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) }
  }
}

/**
 * Authenticated MCP Streamable HTTP sidecar. It never constructs or exposes a
 * desktop runtime itself; the host supplies a principal-bound MCP server factory.
 */
export class RemoteSidecar {
  #httpServer
  #transports = new Map()
  #authTimers = new Map()
  #suspended = new Set()
  #eventStreams = new Set()
  #unsubscribeRevocations

  constructor(options) {
    if (typeof options?.createServer !== 'function') throw new TypeError('createServer is required')
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 7331
    this.tls = options.tls
    this.allowLan = options.allowLan === true
    if (this.host === '0.0.0.0' || this.host === '::') throw new Error('wildcard/public binding is unsupported')
    if (!isLoopback(this.host) && (!this.allowLan || !this.tls || !isPrivateAddress(this.host))) {
      throw new Error('non-loopback binding requires an explicit private address, allowLan=true, and TLS')
    }
    this.createServer = options.createServer
    this.onAuthorizationLost = options.onAuthorizationLost ?? (async () => {})
    this.onPairingRequested = options.onPairingRequested ?? (() => {})
    this.eventSource = options.eventSource
    this.authority = options.authority ?? new PairingAuthority()
    this.maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024
    this.authorizationIdleMs = options.authorizationIdleMs ?? 30_000
    if (this.authorizationIdleMs < 1_000 || this.authorizationIdleMs > 10 * 60_000) {
      throw new RangeError('authorizationIdleMs must be between 1000 and 600000')
    }
    this.allowedHosts = new Set(options.allowedHosts ?? [this.host, ...(isLoopback(this.host) ? ['localhost'] : [])])
    this.allowedOrigins = new Set(options.allowedOrigins ?? [])
    this.requestLimiter = new FixedWindowLimiter(options.requestsPerMinute ?? 120, 60_000)
    this.pairingLimiter = new FixedWindowLimiter(options.pairingRequestsPerHour ?? 10, 60 * 60_000)
    this.eventStoreOptions = options.eventStoreOptions ?? {}
    this.#unsubscribeRevocations = this.authority.subscribeRevocations(event => {
      void this.#authorizationLost(event.authContextId, event.principalId, event.reason)
    })
  }

  async start() {
    if (this.#httpServer) throw new Error('remote sidecar already started')
    const listener = (req, res) => void this.#handle(req, res).catch(error => this.#fail(res, error))
    this.#httpServer = this.tls ? createHttpsServer(this.tls, listener) : createHttpServer(listener)
    await new Promise((resolve, reject) => {
      this.#httpServer.once('error', reject)
      this.#httpServer.listen(this.port, this.host, () => {
        this.#httpServer.off('error', reject)
        resolve()
      })
    })
    return this.address()
  }

  address() {
    const address = this.#httpServer?.address()
    if (!address || typeof address === 'string') return undefined
    return { host: address.address, port: address.port, protocol: this.tls ? 'https' : 'http' }
  }

  async stop(reason = 'remote_sidecar_stopped') {
    for (const binding of [...this.#transports.values()]) {
      await this.#authorizationLost(binding.authContextId, binding.principalId, reason)
    }
    for (const timer of this.#authTimers.values()) clearTimeout(timer)
    this.#authTimers.clear()
    for (const stream of [...this.#eventStreams]) {
      stream.cleanup()
      stream.res.end()
    }
    if (this.#httpServer) {
      const server = this.#httpServer
      this.#httpServer = undefined
      await new Promise(resolve => server.close(() => resolve()))
    }
    this.#unsubscribeRevocations?.()
    this.#unsubscribeRevocations = undefined
  }

  async signalHostLock() { await this.suspendAll('host_locked') }
  async signalRelayLoss() { await this.suspendAll('relay_lost') }

  async suspendAll(reason) {
    const contexts = new Map()
    for (const binding of this.#transports.values()) contexts.set(binding.authContextId, binding.principalId)
    await Promise.all([...contexts].map(([context, principal]) => this.#authorizationLost(context, principal, reason)))
  }

  async #handle(req, res) {
    this.#validateRequestAuthority(req)
    const url = new URL(req.url ?? '/', `${this.tls ? 'https' : 'http'}://${header(req, 'host')}`)
    const remoteKey = req.socket.remoteAddress ?? 'unknown'
    if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok' })
    if (url.pathname === '/.well-known/oauth-protected-resource' && req.method === 'GET') {
      return json(res, 200, {
        resource: `${this.tls ? 'https' : 'http'}://${header(req, 'host')}/mcp`,
        bearer_methods_supported: ['header'],
        scopes_supported: [...this.authority.allowedScopes],
      })
    }
    if (url.pathname === '/pairing/request' && req.method === 'POST') {
      const rate = this.pairingLimiter.consume(remoteKey)
      if (!rate.allowed) throw new HttpError(429, 'rate_limited')
      const request = this.authority.requestPairing(await readJson(req, 16 * 1024))
      await this.onPairingRequested(structuredClone(request))
      return json(res, 202, { requestId: request.requestId, expiresAt: request.expiresAt })
    }
    if (url.pathname === '/pairing/claim' && req.method === 'POST') {
      const rate = this.pairingLimiter.consume(remoteKey)
      if (!rate.allowed) throw new HttpError(429, 'rate_limited')
      return json(res, 200, this.authority.claimPairing(await readJson(req, 16 * 1024)))
    }

    const authInfo = await this.#authenticate(req)
    const rate = this.requestLimiter.consume(`${authInfo.clientId}:${remoteKey}`)
    if (!rate.allowed) return json(res, 429, { error: 'rate_limited' }, { 'retry-after': String(rate.retryAfter) })
    this.#touch(authInfo)
    if (url.pathname === '/events' && req.method === 'GET') {
      if (!this.eventSource) throw new HttpError(404, 'event_stream_unavailable')
      return this.#serveEvents(req, res, url, authInfo)
    }
    if (url.pathname === '/device/rotate' && req.method === 'POST') {
      return json(res, 200, this.authority.rotateDevice(authInfo.clientId))
    }
    if (url.pathname !== '/mcp' || !['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
      throw new HttpError(404, 'not_found')
    }

    const sessionId = header(req, 'mcp-session-id')
    let binding = typeof sessionId === 'string' ? this.#transports.get(sessionId) : undefined
    let body
    if (req.method === 'POST') body = await readJson(req, this.maxBodyBytes)
    if (binding) {
      if (binding.authContextId !== authInfo.extra.authContextId
          || binding.principalId !== authInfo.extra.principalId) {
        throw new HttpError(403, 'authorization_context_mismatch')
      }
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(body)) {
      binding = await this.#createBinding(authInfo)
    } else {
      throw new HttpError(sessionId ? 404 : 400, 'invalid_or_missing_mcp_session')
    }
    req.auth = authInfo
    await binding.transport.handleRequest(req, res, body)
  }

  async #createBinding(authInfo) {
    let binding
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomBytes(32).toString('base64url'),
      eventStore: new BoundedEventStore(this.eventStoreOptions),
      onsessioninitialized: sessionId => {
        binding.sessionId = sessionId
        this.#transports.set(sessionId, binding)
      },
    })
    const server = await this.createServer({
      principalId: authInfo.extra.principalId,
      authInfo,
    })
    binding = {
      transport, server, principalId: authInfo.extra.principalId,
      authContextId: authInfo.extra.authContextId,
    }
    transport.onclose = () => {
      if (binding.sessionId) this.#transports.delete(binding.sessionId)
    }
    await server.connect(transport)
    return binding
  }

  async #authenticate(req) {
    const token = bearer(req)
    if (!token) throw new HttpError(401, 'bearer_token_required')
    try { return await this.authority.verifyAccessToken(token) }
    catch { throw new HttpError(401, 'invalid_or_expired_token') }
  }

  async #serveEvents(req, res, url, authInfo) {
    if (!authInfo.scopes.includes('computer:observe')) throw new HttpError(403, 'missing_observe_scope')
    const sessionId = url.searchParams.get('session_id')
    if (!sessionId) throw new HttpError(400, 'session_id_required')
    const afterHeader = header(req, 'last-event-id')
    const afterSequence = afterHeader === undefined ? 0 : Number(afterHeader)
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new HttpError(400, 'invalid_last_event_id')
    const principalId = authInfo.extra.principalId
    let initial
    try {
      initial = await this.eventSource.query({ principalId, sessionId, afterSequence, limit: 1000 })
    } catch {
      throw new HttpError(404, 'session_not_found')
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive',
      'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff',
    })
    const send = event => {
      if (!res.destroyed) res.write(`id: ${event.sequence}\nevent: session\ndata: ${JSON.stringify(event)}\n\n`)
    }
    for (const event of initial) send(event)
    const unsubscribe = this.eventSource.subscribe({ principalId, sessionId, listener: send })
    const heartbeatMs = Math.max(1_000, Math.min(15_000, Math.floor(this.authorizationIdleMs / 2)))
    const heartbeat = setInterval(() => {
      if (!res.destroyed) {
        res.write(': heartbeat\n\n')
        this.#touch(authInfo)
      }
    }, heartbeatMs)
    heartbeat.unref?.()
    let stream
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearInterval(heartbeat)
      unsubscribe?.()
      if (stream) this.#eventStreams.delete(stream)
    }
    stream = { res, authContextId: authInfo.extra.authContextId, cleanup }
    this.#eventStreams.add(stream)
    req.once('close', cleanup)
    res.once('close', cleanup)
  }

  #touch(authInfo) {
    const context = authInfo.extra.authContextId
    this.#suspended.delete(context)
    const old = this.#authTimers.get(context)
    if (old) clearTimeout(old)
    const expiryMs = authInfo.expiresAt * 1000 - Date.now()
    const delay = Math.max(1, Math.min(this.authorizationIdleMs, expiryMs))
    const timer = setTimeout(() => {
      this.#authTimers.delete(context)
      void this.#authorizationLost(context, authInfo.extra.principalId,
        expiryMs <= this.authorizationIdleMs ? 'token_expired' : 'remote_disconnected')
    }, delay)
    timer.unref?.()
    this.#authTimers.set(context, timer)
  }

  async #authorizationLost(authContextId, principalId, reason) {
    if (this.#suspended.has(authContextId)) return
    this.#suspended.add(authContextId)
    const timer = this.#authTimers.get(authContextId)
    if (timer) clearTimeout(timer)
    this.#authTimers.delete(authContextId)
    const bindings = [...this.#transports.entries()].filter(([, value]) => value.authContextId === authContextId)
    for (const [sessionId, binding] of bindings) {
      this.#transports.delete(sessionId)
      await binding.transport.close().catch(() => {})
    }
    for (const stream of [...this.#eventStreams]) {
      if (stream.authContextId !== authContextId) continue
      stream.cleanup()
      stream.res.end()
    }
    await this.onAuthorizationLost({ authContextId, principalId, reason })
  }

  #validateRequestAuthority(req) {
    const hostHeader = header(req, 'host')
    if (!hostHeader) throw new HttpError(400, 'host_required')
    let hostname
    try { hostname = new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '') }
    catch { throw new HttpError(400, 'invalid_host') }
    if (!this.allowedHosts.has(hostname)) throw new HttpError(421, 'host_not_allowed')
    const origin = header(req, 'origin')
    if (origin && !this.allowedOrigins.has(origin)) throw new HttpError(403, 'origin_not_allowed')
  }

  #fail(res, error) {
    if (res.headersSent) return res.end()
    const status = error instanceof HttpError ? error.status
      : error instanceof PairingError ? 400 : 500
    const code = error instanceof HttpError || error instanceof PairingError ? error.code : 'internal_error'
    const headers = status === 401
      ? { 'www-authenticate': 'Bearer realm="computer-use-remote"' }
      : {}
    json(res, status, { error: code }, headers)
  }
}
