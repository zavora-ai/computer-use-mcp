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
  result?: CallToolResult
  error?: { code: number; message: string; data?: unknown }
  inputRequests?: Record<string, unknown>
  answeredKeys: Set<string>
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
  authInfo?: { clientId: string }
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
  if (client.authInfo?.clientId) return `oauth:${client.authInfo.clientId}`
  return undefined
}

function displayClient(client: TaskClientIdentity): string {
  const envelope = client.envelope
  const info = envelope?.[CLIENT_INFO_META_KEY]
  if (!info || typeof info !== 'object') return 'anonymous'
  const record = info as Record<string, unknown>
  return `${String(record.name ?? 'anonymous')}@${String(record.version ?? 'unknown')}`
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

  constructor(options: { maxConcurrentPerOwner?: number; ttlMs?: number; pollIntervalMs?: number } = {}) {
    this.#maxConcurrentPerOwner = options.maxConcurrentPerOwner ?? 16
    this.#ttlMs = options.ttlMs ?? 60 * 60 * 1_000
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000
  }

  install(server: McpServer, registry: ToolRegistry): void {
    server.server.setRequestHandler('tools/call', async (request, ctx) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      if (!hasTasksCapability(clientIdentity(ctx)) || !shouldCreateTask(request.params.name, args)) {
        return registry.executeRegistered(request.params.name, args, ctx)
      }
      return this.#create(request.params.name, args, ctx, registry)
    })
  }

  /**
   * Handle the three Tasks extension lifecycle methods. SDK v2.0's modern
   * core codec intentionally has no Tasks extension runtime yet, so serving
   * entries invoke this narrow bridge before core dispatch.
   */
  handleProtocolRequest(method: string, params: unknown, client: TaskClientIdentity): Record<string, unknown> {
    this.#requireCapability(client)
    if (method === 'tasks/get') {
      const { taskId: selected } = GetTaskParams.parse(params)
      return { resultType: 'complete', ...this.#view(this.#get(selected, client)) }
    }
    if (method === 'tasks/update') {
      const { taskId: selected, inputResponses } = UpdateTaskParams.parse(params)
      const task = this.#get(selected, client)
      this.#applyInputResponses(task, inputResponses)
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
    this.#purgeExpired()
    const client = clientIdentity(ctx)
    const owner = authenticatedOwner(client)
    const ownerLabel = owner ?? `client:${displayClient(client)}`
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
      answeredKeys: new Set(),
    }
    this.#tasks.set(record.taskId, record)

    const taskContext: ServerContext = {
      ...ctx,
      mcpReq: {
        ...ctx.mcpReq,
        _meta: undefined,
        inputResponses: undefined,
        droppedInputResponseKeys: undefined,
        requestState: () => undefined,
        signal: record.controller.signal,
        notify: async () => {},
        log: async () => {},
      },
    }
    void registry.executeRegistered(tool, args, taskContext).then(result => {
      if (record.status === 'cancelled') return
      if (isInputRequiredResult(result)) {
        record.status = 'input_required'
        record.statusMessage = 'Additional client input is required.'
        record.inputRequests = result.inputRequests as Record<string, unknown>
      } else {
        record.status = 'completed'
        record.statusMessage = result.isError ? `${tool} completed with a tool error.` : `${tool} completed.`
        record.result = result
      }
      record.lastUpdatedAt = nowIso()
    }).catch(error => {
      if (record.status === 'cancelled') return
      record.status = 'failed'
      record.statusMessage = error instanceof Error ? error.message : String(error)
      record.error = {
        code: error instanceof ProtocolError ? error.code : ProtocolErrorCode.InternalError,
        message: record.statusMessage,
      }
      record.lastUpdatedAt = nowIso()
    })

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
      if (task.expiresAt <= now) this.#tasks.delete(id)
    }
  }

  #applyInputResponses(task: TaskRecord, inputResponses: Record<string, unknown>): void {
    if (task.status !== 'input_required' || !task.inputRequests) return
    for (const key of Object.keys(inputResponses)) {
      if (key in task.inputRequests) task.answeredKeys.add(key)
    }
    if (Object.keys(task.inputRequests).every(key => task.answeredKeys.has(key))) {
      task.status = 'failed'
      task.statusMessage = 'This computer-use task cannot resume embedded input; approval is resolved before task creation.'
      task.error = { code: ProtocolErrorCode.InternalError, message: task.statusMessage }
      task.lastUpdatedAt = nowIso()
    }
  }

  #cancel(task: TaskRecord): void {
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return
    task.controller.abort(new Error('Task cancelled by MCP client'))
    task.status = 'cancelled'
    task.statusMessage = 'Cancellation requested by client.'
    task.lastUpdatedAt = nowIso()
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
                name: 'computer-use', title: 'Computer Use MCP', version: '7.1.0',
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
