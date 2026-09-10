import { principalKey } from './authority.js'
import { getToolMeta } from './tool-catalog.js'
import type { ToolRegistryOptions } from './registry/registry.js'
import type { TaskStore } from './task-store.js'
import { randomBytes } from 'node:crypto'
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  isJSONRPCRequest,
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult,
  type JSONRPCMessage,
  type McpServer,
  type MessageExtraInfo,
  type ServerContext,
  type Transport,
} from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ToolRegistry } from './registry/registry.js'

export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks'
export const TASKS_MISSING_CAPABILITY_CODE = -32_003

type TaskStatus = 'working' | 'input_required' | 'completed' | 'cancelled' | 'failed'

interface TaskRecord {
  taskId: string
  tool: string
  args?: Record<string, unknown>
  scopes?: string[]
  status: TaskStatus
  statusMessage?: string
  createdAt: string
  lastUpdatedAt: string
  ttlMs: number
  pollIntervalMs: number
  expiresAt: number
  /** Stable accounting key; never used as an authorization credential. */
  rateOwner: string
  authenticatedOwner?: string
  controller: AbortController
  releaseSession?: () => void
  result?: CallToolResult
  error?: { code: number; message: string; data?: unknown }
  inputRequests?: Record<string, unknown>
  answeredKeys: Set<string>
  responses?: Record<string, unknown>
  resume?: (responses: Record<string, unknown>, client: TaskClientIdentity) => void
}

const GetTaskParams = z.object({ taskId: z.string().min(16) })
const UpdateTaskParams = z.object({
  taskId: z.string().min(16),
  inputResponses: z.record(z.string(), z.unknown()),
})
const CancelTaskParams = z.object({ taskId: z.string().min(16) })
const TASK_METHODS = new Set(['tasks/get', 'tasks/update', 'tasks/cancel'])

interface TaskClientIdentity {
  envelope?: Record<string, unknown>
  authInfo?: Parameters<typeof principalKey>[0]
}

function clientIdentity(ctx: ServerContext): TaskClientIdentity {
  return {
    envelope: ctx.mcpReq.envelope as Record<string, unknown> | undefined,
    ...(ctx.http?.authInfo ? { authInfo: ctx.http.authInfo } : {}),
  }
}

function envelopeCapabilities(client: TaskClientIdentity): Record<string, unknown> | undefined {
  const envelope = client.envelope
  if (envelope?.[PROTOCOL_VERSION_META_KEY] !== '2026-07-28') return undefined
  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY]
  return capabilities && typeof capabilities === 'object'
    ? capabilities as Record<string, unknown>
    : {}
}

function hasTasksCapability(client: TaskClientIdentity): boolean {
  const capabilities = envelopeCapabilities(client)
  if (!capabilities) return false
  const extensions = capabilities.extensions
  return Boolean(extensions && typeof extensions === 'object' && TASKS_EXTENSION_ID in extensions)
}

function authenticatedOwner(client: TaskClientIdentity): string | undefined {
  return principalKey(client.authInfo)
}

function shouldCreateTask(tool: string, args: Record<string, unknown>): boolean {
  if (tool === 'wait') return Number(args.duration ?? 0) >= 2
  if (tool === 'scrape' || tool === 'get_ui_tree' || tool === 'get_app_dictionary') return true
  if (tool === 'snapshot') return args.use_vision === true
  return false
}

function nowIso(): string { return new Date().toISOString() }

function taskId(): string {
  return `cut_${randomBytes(24).toString('base64url')}`
}

/** Process-durable Tasks extension store shared by stateless per-request server instances. */
export class McpTaskManager {
  readonly #tasks = new Map<string, TaskRecord>()
  readonly #maxConcurrentPerOwner: number
  readonly #ttlMs: number
  readonly #pollIntervalMs: number
  readonly #store?: TaskStore
  readonly #maxTasks: number
  readonly #maxResultBytes: number
  readonly #expiry: NodeJS.Timeout
  #closed = false

  constructor(options: { maxConcurrentPerOwner?: number; ttlMs?: number; pollIntervalMs?: number; store?: TaskStore; maxTasks?: number; maxResultBytes?: number } = {}) {
    this.#maxConcurrentPerOwner = options.maxConcurrentPerOwner ?? 16
    this.#ttlMs = options.ttlMs ?? 60 * 60 * 1_000
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.#store = options.store
    this.#maxTasks = options.maxTasks ?? 256
    this.#maxResultBytes = options.maxResultBytes ?? 4_194_304
    for (const value of [this.#maxConcurrentPerOwner, this.#ttlMs, this.#pollIntervalMs, this.#maxTasks, this.#maxResultBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Task limits must be positive integers')
    }
    for (const saved of this.#store?.load() ?? []) {
      if (this.#tasks.size >= this.#maxTasks) throw new Error('Persisted task count exceeds limit')
      const task = { ...saved, controller: new AbortController(), answeredKeys: new Set<string>() } as unknown as TaskRecord
      if (!['completed', 'cancelled', 'failed'].includes(task.status)) {
        task.status = 'failed'
        task.error = { code: ProtocolErrorCode.InternalError, message: 'Worker restarted; operation was interrupted. Verify state before retrying.' }
      }
      this.#tasks.set(task.taskId, task)
      this.#persist(task)
    }
    this.#purgeExpired()
    this.#expiry = setInterval(() => this.#purgeExpired(), Math.min(this.#ttlMs, 30_000))
    this.#expiry.unref()
  }

  close(): void {
    this.#closed = true
    clearInterval(this.#expiry)
    for (const task of this.#tasks.values()) this.#cancel(task)
  }

  #persist(task: TaskRecord): void {
    const { controller, answeredKeys, resume, releaseSession, ...record } = task
    this.#store?.save(task.taskId, record)

  }

  install(server: McpServer, registry: ToolRegistry, extensions = new Map<string, (args: unknown, ctx: ServerContext) => Promise<any>>()): void {
    server.server.setRequestHandler('tools/call', async (request, ctx) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      if (extensions.has(request.params.name)) return extensions.get(request.params.name)!(args, ctx)
      if (!hasTasksCapability(clientIdentity(ctx)) || !shouldCreateTask(request.params.name, args)) {
        return registry.executeRegistered(request.params.name, args, ctx)
      }
      const prepared = await registry.preflight(request.params.name, args, ctx)
      if (isInputRequiredResult(prepared) || prepared.isError) return prepared
      return this.#create(request.params.name, args, ctx, registry)
    })
  }

  /**
   * Handle the three Tasks extension lifecycle methods. SDK v2.0's modern
   * core codec intentionally has no Tasks extension runtime yet, so serving
   * entries invoke this narrow bridge before core dispatch.
   */
  async handleProtocolRequest(method: string, params: unknown, client: TaskClientIdentity,
    authorize?: ToolRegistryOptions['authorizeToolCall']): Promise<Record<string, unknown>> {
    this.#requireCapability(client)
    const selected = GetTaskParams.parse(params).taskId
    const record = this.#get(selected, client)
    if (method !== 'tasks/cancel') {
      if (record.scopes?.some(scope => !client.authInfo?.scopes?.includes(scope))) throw new Error('Task authority revoked')
      await authorize?.({ definition: { name: record.tool, description: record.tool, inputSchema: {}, meta: getToolMeta(record.tool)! },
        args: record.args ?? {}, ...(client.authInfo ? { authInfo: client.authInfo as any } : {}) })
    }
    if (method === 'tasks/get') {
      const { taskId: selected } = GetTaskParams.parse(params)
      return { resultType: 'complete', ...this.#view(this.#get(selected, client)) }
    }
    if (method === 'tasks/update') {
      const { taskId: selected, inputResponses } = UpdateTaskParams.parse(params)
      const task = this.#get(selected, client)
      this.#applyInputResponses(task, inputResponses, client)
      return { resultType: 'complete' }
    }
    if (method === 'tasks/cancel') {
      const { taskId: selected } = CancelTaskParams.parse(params)
      this.#cancel(this.#get(selected, client))
      return { resultType: 'complete' }
    }
    throw new ProtocolError(ProtocolErrorCode.MethodNotFound, 'Method not found')
  }

  #create(tool: string, args: Record<string, unknown>, ctx: ServerContext, registry: ToolRegistry) {
    if (this.#closed) throw new Error('Task manager closed')
    this.#purgeExpired()
    if (this.#tasks.size >= this.#maxTasks) throw new Error('Task retention limit reached')
    const client = clientIdentity(ctx)
    const owner = authenticatedOwner(client)
    const ownerLabel = owner ?? 'anonymous'
    const concurrent = [...this.#tasks.values()].filter(task =>
      task.rateOwner === ownerLabel
      && (task.status === 'working' || task.status === 'input_required'),
    ).length
    if (concurrent >= this.#maxConcurrentPerOwner) {
      throw new ProtocolError(ProtocolErrorCode.InternalError, 'Concurrent task limit reached')
    }

    const createdAt = nowIso()
    const record: TaskRecord = {
      taskId: taskId(),
      tool,
      args: structuredClone(args),
      scopes: client.authInfo?.scopes ?? [],
      status: 'working',
      statusMessage: `Running ${tool}`,
      createdAt,
      lastUpdatedAt: createdAt,
      ttlMs: this.#ttlMs,
      pollIntervalMs: this.#pollIntervalMs,
      expiresAt: Date.now() + this.#ttlMs,
      rateOwner: ownerLabel,
      ...(owner ? { authenticatedOwner: owner } : {}),
      controller: new AbortController(),
      releaseSession: registry.retainSession(),
      answeredKeys: new Set(),
    }
    try { this.#persist(record) } catch (error) { record.releaseSession?.(); throw error }
    this.#tasks.set(record.taskId, record)

    const taskContext: ServerContext = {
      ...ctx,
      mcpReq: {
        ...ctx.mcpReq,
        _meta: undefined,
        inputResponses: ctx.mcpReq.inputResponses,
        droppedInputResponseKeys: undefined,
        requestState: ctx.mcpReq.requestState.bind(ctx.mcpReq),
        signal: record.controller.signal,
        notify: async () => {},
        log: async () => {},
      },
    }
    const run = (pending: Promise<CallToolResult | InputRequiredResult>) => { void pending.then(result => {
      if (record.status === 'cancelled' || this.#closed) return
      if (isInputRequiredResult(result)) {
        record.status = 'input_required'
        record.statusMessage = 'Additional client input is required.'
        record.inputRequests = result.inputRequests as Record<string, unknown>
        record.responses = {}; record.answeredKeys.clear()
        record.resume = (responses, identity) => {
          const context = { ...taskContext, ...(identity.authInfo && taskContext.http ? { http: { ...taskContext.http, authInfo: identity.authInfo as any } } : {}) }
          run(registry.resumeReadOnly(tool, args, context, result, responses))
        }
      } else {
        record.status = 'completed'
        record.statusMessage = result.isError ? `${tool} completed with a tool error.` : `${tool} completed.`
        if (Buffer.byteLength(JSON.stringify(result)) > this.#maxResultBytes) throw new Error('Task result exceeds configured byte limit')
        record.result = result
        record.releaseSession?.(); record.releaseSession = undefined
      }
      record.lastUpdatedAt = nowIso()
      this.#persist(record)
    }).catch(error => {
      if (record.status === 'cancelled' || this.#closed) return
      record.releaseSession?.(); record.releaseSession = undefined
      record.status = 'failed'
      record.statusMessage = error instanceof Error ? error.message : String(error)
      record.error = {
        code: error instanceof ProtocolError ? error.code : ProtocolErrorCode.InternalError,
        message: record.statusMessage,
      }
      record.lastUpdatedAt = nowIso()
      this.#persist(record)
    })

    }
    run(registry.executeRegistered(tool, args, taskContext))

    // `content` is an allowed extension member needed by the current SDK's
    // tools/call validator; `resultType: task` remains the wire discriminator.
    return { content: [], resultType: 'task', ...this.#view(record, false) }
  }

  #view(task: TaskRecord, detailed = true): Record<string, unknown> {
    return {
      taskId: task.taskId,
      status: task.status,
      ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      ttlMs: task.ttlMs,
      pollIntervalMs: task.pollIntervalMs,
      ...(detailed && task.status === 'input_required' && task.inputRequests
        ? { inputRequests: task.inputRequests }
        : {}),
      ...(detailed && task.status === 'completed' && task.result ? { result: task.result } : {}),
      ...(detailed && task.status === 'failed' && task.error ? { error: task.error } : {}),
    }
  }

  #requireCapability(client: TaskClientIdentity): void {
    if (hasTasksCapability(client)) return
    throw new ProtocolError(
      TASKS_MISSING_CAPABILITY_CODE,
      'Missing required client capability',
      { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
    )
  }

  #get(selected: string, client: TaskClientIdentity): TaskRecord {
    this.#purgeExpired()
    const task = this.#tasks.get(selected)
    if (!task || (task.authenticatedOwner && task.authenticatedOwner !== authenticatedOwner(client))) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Task not found or expired')
    }
    return task
  }

  #purgeExpired(): void {
    const now = Date.now()
    for (const [id, task] of this.#tasks) {
      if (task.expiresAt <= now) { task.controller.abort(new Error('Task expired')); task.releaseSession?.(); task.releaseSession = undefined; task.status = 'cancelled'; this.#tasks.delete(id); this.#store?.delete(id) }
    }
  }

  #applyInputResponses(task: TaskRecord, inputResponses: Record<string, unknown>, client: TaskClientIdentity): void {
    if (task.status !== 'input_required' || !task.inputRequests) return
    for (const [key, value] of Object.entries(inputResponses)) {
      if (!(key in task.inputRequests)) throw new Error('Unknown task input key')
      if (!value || typeof value !== 'object') throw new Error('Invalid task input')
      const response = value as Record<string, unknown>
      const request = task.inputRequests[key] as { method?: string }
      if (request.method === 'elicitation/create') {
        if (!['accept', 'decline', 'cancel'].includes(String(response.action))) throw new Error('Invalid elicitation action')
        if (response.action === 'accept' && (typeof response.content !== 'object' || typeof (response.content as any)?.approve !== 'boolean')) throw new Error('Approval requires a boolean decision')
      } else if (request.method === 'roots/list') {
        if (!Array.isArray(response.roots) || response.roots.some(root => !root || typeof root.uri !== 'string')) throw new Error('Invalid roots response')
      } else throw new Error('Unsupported continuation input')
      if (task.answeredKeys.has(key) && JSON.stringify(task.responses?.[key]) !== JSON.stringify(value)) throw new Error('Conflicting duplicate response')
      task.answeredKeys.add(key)
      ;(task.responses ??= {})[key] = value
    }
    this.#persist(task)
    if (Object.keys(task.inputRequests).every(key => task.answeredKeys.has(key))) {
      const resume = task.resume
      if (!resume) throw new Error('Continuation unavailable; verify state before starting a fresh task')
      task.resume = undefined; task.status = 'working'; task.lastUpdatedAt = nowIso()
      this.#persist(task)
      resume(task.responses ?? {}, client)
    }
  }

  #cancel(task: TaskRecord): void {
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return
    task.controller.abort(new Error('Task cancelled by MCP client'))
    task.releaseSession?.(); task.releaseSession = undefined
    task.status = 'cancelled'
    task.statusMessage = 'Cancellation requested by client.'
    task.lastUpdatedAt = nowIso()
    this.#persist(task)
  }
}

function taskEnvelope(message: JSONRPCMessage): Record<string, unknown> | undefined {
  if (!isJSONRPCRequest(message) || !TASK_METHODS.has(message.method)) return undefined
  const params = message.params
  if (!params || typeof params !== 'object') return undefined
  const meta = (params as { _meta?: unknown })._meta
  if (!meta || typeof meta !== 'object') return undefined
  const envelope = meta as Record<string, unknown>
  const info = envelope[CLIENT_INFO_META_KEY]
  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY]
  return envelope[PROTOCOL_VERSION_META_KEY] === '2026-07-28'
    && info && typeof info === 'object'
    && typeof (info as Record<string, unknown>).name === 'string'
    && typeof (info as Record<string, unknown>).version === 'string'
    && capabilities && typeof capabilities === 'object'
    ? envelope
    : undefined
}

/** Intercept Tasks extension lifecycle methods before the SDK's core era gate. */
export class TasksExtensionTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void

  constructor(readonly inner: Transport, readonly manager: McpTaskManager) {}

  get sessionId(): string | undefined { return this.inner.sessionId }
  setProtocolVersion(version: string): void { this.inner.setProtocolVersion?.(version) }
  setSupportedProtocolVersions(versions: string[]): void { this.inner.setSupportedProtocolVersions?.(versions) }

  async start(): Promise<void> {
    this.inner.onclose = () => this.onclose?.()
    this.inner.onerror = error => this.onerror?.(error)
    this.inner.onmessage = (message, extra) => {
      const envelope = taskEnvelope(message)
      if (!envelope || !isJSONRPCRequest(message)) {
        this.onmessage?.(message, extra)
        return
      }
      const params = { ...((message.params ?? {}) as Record<string, unknown>) }
      delete params._meta
      Promise.resolve().then(() => this.manager.handleProtocolRequest(message.method, params, { envelope }))
        .then(result => this.inner.send({
          jsonrpc: '2.0', id: message.id,
          result: {
            ...result,
            _meta: {
              'io.modelcontextprotocol/serverInfo': {
                name: 'computer-use', title: 'Computer Use MCP', version: '7.2.0',
                description: 'Cross-platform desktop control with policy-aware automation.',
                websiteUrl: 'https://github.com/zavora-ai/computer-use-mcp',
              },
            },
          },
        }))
        .catch(error => {
          const protocol = error instanceof ProtocolError
            ? error
            : new ProtocolError(ProtocolErrorCode.InvalidParams, error instanceof Error ? error.message : String(error))
          return this.inner.send({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: protocol.code, message: protocol.message, ...(protocol.data !== undefined ? { data: protocol.data } : {}) },
          })
        })
        .catch(error => this.onerror?.(error instanceof Error ? error : new Error(String(error))))
    }
    await this.inner.start()
  }

  close(): Promise<void> { return this.inner.close() }
  send(message: JSONRPCMessage): Promise<void> { return this.inner.send(message) }
}
