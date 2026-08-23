#!/usr/bin/env node
/**
 * Computer Use MCP Server — stable v7 tools with additive MCP v7.1 features.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  createMcpHandler,
  createRequestStateCodec,
  type CreateMcpHandlerOptions,
  type McpHttpHandler,
  type ServerContext,
} from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createSession, type Session, type SessionOptions } from './session.js'
import { parseProfile, type FocusRequired, type ToolMeta, type ProfileName } from './tool-catalog.js'
import { SERVER_INSTRUCTIONS } from './instructions.js'
import { registerPrompts } from './prompts.js'
import { registerResources } from './resources.js'
import { isStdioEntrypoint } from './entrypoint.js'
import { ToolRegistry } from './registry/registry.js'
import { approvalTokenParam, defineV7Tools } from './registry/definitions.js'
import { McpV71Controller } from './mcp-v7.1.js'
import { FILESYSTEM_RESOURCE_PREFIX, filesystemResourceUri, withFilesystemResourceLink } from './resource-links.js'
import {
  McpTaskManager,
  TASKS_EXTENSION_ID,
  TASKS_MISSING_CAPABILITY_CODE,
  TasksExtensionTransport,
} from './mcp-tasks.js'

export type { FocusRequired, ToolMeta }

const FIXED_RESOURCES = new Set([
  'computer://display/main',
  'computer://windows',
  'computer://frontmost',
  'computer://policy',
  'computer://profile/tools',
  'computer://screenshot/latest',
])

const DESKTOP_STATE_MUTATIONS = new Set([
  'openai_computer', 'left_click', 'right_click', 'middle_click', 'double_click',
  'triple_click', 'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up',
  'scroll', 'type', 'key', 'hold_key', 'open_application', 'hide_app', 'unhide_app',
  'activate_app', 'activate_window', 'resize_window', 'click_element', 'set_value',
  'press_button', 'select_menu_item', 'fill_form', 'run_script', 'create_agent_space',
  'move_window_to_space', 'remove_window_from_space', 'destroy_space', 'process_kill',
  'multi_select', 'multi_edit',
])

const requestStateKey = process.env.COMPUTER_USE_REQUEST_STATE_SECRET
  ? createHash('sha256').update(process.env.COMPUTER_USE_REQUEST_STATE_SECRET).digest()
  : randomBytes(32)

const requestStateCodec = createRequestStateCodec<{
  kind: 'computer-use-v7.1'
  tool: string
  argsHash: string
  clientRoots?: string[]
  approval?: true
}>({
  key: requestStateKey,
  ttlSeconds: 600,
  bind: (ctx: ServerContext) => {
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined
    const clientInfo = envelope?.[CLIENT_INFO_META_KEY] as { name?: unknown } | undefined
    return `${ctx.mcpReq.method}\0${ctx.http?.authInfo?.clientId ?? String(clientInfo?.name ?? 'local')}`
  },
})

const taskManager = new McpTaskManager({
  maxConcurrentPerOwner: Number(process.env.COMPUTER_USE_MAX_TASKS ?? 16),
  ttlMs: Number(process.env.COMPUTER_USE_TASK_TTL_MS ?? 3_600_000),
  pollIntervalMs: Number(process.env.COMPUTER_USE_TASK_POLL_INTERVAL_MS ?? 1_000),
})

export interface ServerOptions extends SessionOptions {
  /** Override session instance for tests. */
  session?: Session
  /** Init-time maximum tool profile. Default full. */
  profile?: ProfileName | string
  /** Initially visible subset within `profile`; hosts may change it through `onRegistry`. */
  activeProfile?: ProfileName | string
  structuredContent?: boolean
  legacyFocusTag?: boolean
  /** Embedding hook for host-controlled dynamic v7 profile negotiation. */
  onRegistry?: (registry: ToolRegistry) => void
  /** Host/transport authorization invoked before every registered tool handler. */
  authorizeToolCall?: ConstructorParameters<typeof ToolRegistry>[0]['authorizeToolCall']
  /** Publish a state-derived update through an embedding transport's shared bus. */
  notifyResourceUpdated?: (uri: string) => Promise<void> | void
  /** Publish a tool-list change through an embedding transport's shared bus. */
  notifyToolsChanged?: () => Promise<void> | void
}

function approvalScope(tool: string, args: Readonly<Record<string, unknown>>): string[] {
  const scope: string[] = []
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return
    const raw = typeof value === 'string' ? value : JSON.stringify(value)
    scope.push(`${label}: ${raw.length > 1_000 ? `${raw.slice(0, 1_000)}…` : raw}`)
  }
  add('tool', tool)
  add('target application', args.target_app ?? args.bundle_id ?? args.app_id)
  add('target window', args.target_window_id ?? args.window_id)
  add('operation', args.mode ?? args.action)
  add('path', args.path)
  add('destination', args.destination)
  add('process', args.pid ?? args.name)
  add('registry value', args.name)
  add('script language', args.language)
  if (typeof args.script === 'string') {
    add('script', args.script)
    scope.push(`script sha256: ${createHash('sha256').update(args.script).digest('hex')}`)
  }
  return scope
}

export function createComputerUseServer(opts: ServerOptions = {}): McpServer {
  const profile = parseProfile(opts.profile ?? process.env.COMPUTER_USE_PROFILE)
  const activeProfile = parseProfile(opts.activeProfile ?? process.env.COMPUTER_USE_ACTIVE_PROFILE ?? profile)
  const structuredContent = opts.structuredContent
    ?? (process.env.COMPUTER_USE_STRUCTURED_CONTENT !== 'false')
  const legacyFocusTag = opts.legacyFocusTag
    ?? (process.env.COMPUTER_USE_LEGACY_FOCUS_TAG === 'true')

  const server = new McpServer(
    SERVER_INFO,
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: {
        logging: {},
        resources: { subscribe: true },
        extensions: { [TASKS_EXTENSION_ID]: {} },
      },
      cacheHints: {
        'server/discover': { ttlMs: 30_000, cacheScope: 'private' },
        'tools/list': { ttlMs: 30_000, cacheScope: 'private' },
        'prompts/list': { ttlMs: 30_000, cacheScope: 'private' },
        'resources/list': { ttlMs: 30_000, cacheScope: 'private' },
        'resources/templates/list': { ttlMs: 30_000, cacheScope: 'private' },
        'resources/read': { ttlMs: 0, cacheScope: 'private' },
      },
      inputRequired: {
        maxRounds: 4,
        roundTimeoutMs: 600_000,
        legacyShim: true,
      },
      requestState: { verify: requestStateCodec.verify },
    },
  )

  const mcp = new McpV71Controller(server, {
    isSubscribable: uri => FIXED_RESOURCES.has(uri) || uri.startsWith(FILESYSTEM_RESOURCE_PREFIX),
  })
  const resourceUpdated = async (uri: string) => {
    await Promise.allSettled([
      mcp.resourceUpdated(uri),
      Promise.resolve().then(() => opts.notifyResourceUpdated?.(uri)),
    ])
  }

  const elicitApproval = opts.elicitApproval ?? (async ctx => {
    try {
      const caps = server.server.getClientCapabilities()
      // Older MCP clients advertised `elicitation: {}` before form/url modes
      // were split. Presence therefore remains the compatibility gate.
      if (!caps?.elicitation) return false
      const scope = approvalScope(ctx.tool, ctx.args)
      const result = await server.server.elicitInput({
        message: [
          `Approve computer-use action?`,
          ...scope,
          `risk: ${ctx.destructive ? 'destructive or difficult to reverse' : 'mutating'}`,
          `policy reasons: ${ctx.reasons.join(', ')}`,
        ].join('\n'),
        requestedSchema: {
          type: 'object',
          properties: {
            approve: {
              type: 'boolean',
              title: `Approve ${ctx.tool}`,
              description: 'Approve this exact, one-shot action only.',
            },
          },
          required: ['approve'],
        },
      }, { timeout: 60_000 })
      const approved = result.action === 'accept' && result.content?.approve === true
      await mcp.log(approved ? 'notice' : 'warning', 'Approval elicitation completed', {
        tool: ctx.tool,
        approved,
        destructive: ctx.destructive,
      })
      return approved
    } catch {
      return false
    }
  })

  const session = opts.session ?? createSession({
    vision: opts.vision ?? (process.env.COMPUTER_USE_VISION !== 'false'),
    provider: opts.provider ?? process.env.COMPUTER_USE_PROVIDER,
    native: opts.native,
    spawnBounded: opts.spawnBounded,
    lockPath: opts.lockPath,
    disableSessionLock: opts.disableSessionLock,
    elicitApproval: opts.elicitApproval !== undefined ? opts.elicitApproval : elicitApproval,
    profile,
    getClientRoots: () => mcp.clientRoots(),
  })

  const registry = new ToolRegistry({
    profile,
    activeProfile,
    structuredContent,
    legacyFocusTag,
    approvalTokenSchema: approvalTokenParam,
    session,
    requestStateCodec,
    ...(opts.authorizeToolCall ? { authorizeToolCall: opts.authorizeToolCall } : {}),
    onProfileChanged: async () => {
      await resourceUpdated('computer://profile/tools')
      try { await opts.notifyToolsChanged?.() } catch { /* advisory */ }
      await mcp.log('notice', 'Visible tool profile changed')
    },
    afterToolCall: async ({ definition, args, result, durationMs, mcpContext }) => {
      const finalResult = definition.name === 'filesystem'
        ? withFilesystemResourceLink(result, args)
        : result
      try {
        await mcpContext.mcpReq.log(result.isError ? 'warning' : 'debug', {
          message: 'Tool call completed',
          tool: definition.name,
          success: !result.isError,
          durationMs,
        }, 'computer-use')
      } catch { /* logging is optional and disclosure-safe */ }
      if (!result.isError) {
        if (definition.name === 'screenshot') {
          await resourceUpdated('computer://screenshot/latest')
        }
        if (DESKTOP_STATE_MUTATIONS.has(definition.name)) {
          await Promise.all([
            resourceUpdated('computer://frontmost'),
            resourceUpdated('computer://windows'),
          ])
        }
        if (definition.name === 'filesystem') {
          const selected = args.mode === 'copy' || args.mode === 'move' ? args.destination : args.path
          if (typeof selected === 'string' && args.mode !== 'delete') {
            await resourceUpdated(filesystemResourceUri(selected))
          }
        }
      }
      return finalResult
    },
  })

  defineV7Tools(registry)
  registry.registerAll(server)
  taskManager.install(server, registry)
  opts.onRegistry?.(registry)
  registerPrompts(server, session)
  registerResources(server, {
    session,
    profile,
    getActiveProfile: () => registry.activeProfile(),
    getLastScreenshot: () => session.getLastScreenshot?.(),
    getClientRoots: () => mcp.clientRoots(),
  })

  return server
}

/**
 * Fetch-shaped, per-request MCP endpoint for protocol 2026-07-28.
 *
 * Modern requests are stateless and carry identity, capabilities, and the
 * negotiated protocol revision in every request envelope. Claim-less 2025
 * clients are served by the SDK's stateless compatibility path by default.
 * HTTP authentication is deliberately supplied by the embedding host through
 * `handler.fetch(request, { authInfo })`; this function never trusts an
 * Authorization header without a verifier.
 */
export function createComputerUseHttpHandler(
  opts: ServerOptions = {},
  handlerOptions: CreateMcpHandlerOptions = {},
): McpHttpHandler {
  let handler!: McpHttpHandler
  handler = createMcpHandler(() => createComputerUseServer({
    ...opts,
    notifyResourceUpdated: uri => handler.notify.resourceUpdated(uri),
    notifyToolsChanged: () => handler.notify.toolsChanged(),
  }), {
    legacy: 'stateless',
    maxSubscriptions: 256,
    ...handlerOptions,
  })
  return {
    ...handler,
    fetch: async (request, requestOptions) => {
      const taskResponse = await handleHttpTaskExtension(request, requestOptions?.authInfo?.clientId)
      return taskResponse ?? handler.fetch(request, requestOptions)
    },
  }
}

const TASK_PROTOCOL_METHODS = new Set(['tasks/get', 'tasks/update', 'tasks/cancel'])
const SERVER_INFO = {
  name: 'computer-use',
  title: 'Computer Use MCP',
  version: '7.1.0',
  description: 'Cross-platform desktop control with policy-aware automation.',
  websiteUrl: 'https://github.com/zavora-ai/computer-use-mcp',
}

async function handleHttpTaskExtension(request: Request, clientId?: string): Promise<Response | undefined> {
  if (request.method !== 'POST') return undefined
  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return undefined
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const rpc = body as Record<string, unknown>
  if (typeof rpc.method !== 'string' || !TASK_PROTOCOL_METHODS.has(rpc.method)) return undefined
  if (request.headers.get('mcp-protocol-version') !== '2026-07-28') return undefined

  const id = rpc.id
  const error = (code: number, message: string, data?: unknown, status = 400) => new Response(JSON.stringify({
    jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return error(ProtocolErrorCode.InvalidRequest, 'Content-Type must be application/json', undefined, 415)
  }
  if (rpc.jsonrpc !== '2.0' || (typeof id !== 'string' && typeof id !== 'number')) {
    return error(ProtocolErrorCode.InvalidRequest, 'Invalid JSON-RPC request')
  }
  if (request.headers.get('mcp-method') !== rpc.method) {
    return error(-32020, 'MCP-Method header does not match the request method')
  }
  if (!rpc.params || typeof rpc.params !== 'object' || Array.isArray(rpc.params)) {
    return error(ProtocolErrorCode.InvalidParams, 'Task params must be an object')
  }
  const params = { ...(rpc.params as Record<string, unknown>) }
  const meta = params._meta
  delete params._meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return error(ProtocolErrorCode.InvalidParams, 'The 2026-07-28 request envelope is required')
  }
  const envelope = meta as Record<string, unknown>
  if (envelope[PROTOCOL_VERSION_META_KEY] !== '2026-07-28') {
    return error(-32020, 'Protocol version header and request envelope do not match')
  }
  const info = envelope[CLIENT_INFO_META_KEY]
  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY]
  if (!info || typeof info !== 'object' || typeof (info as Record<string, unknown>).name !== 'string'
    || typeof (info as Record<string, unknown>).version !== 'string'
    || !capabilities || typeof capabilities !== 'object') {
    return error(ProtocolErrorCode.InvalidParams, 'The 2026-07-28 clientInfo and clientCapabilities envelope fields are required')
  }
  if (request.headers.get('mcp-name') !== params.taskId) {
    return error(-32020, 'MCP-Name header must match params.taskId for Tasks extension methods')
  }

  try {
    const result = taskManager.handleProtocolRequest(rpc.method, params, {
      envelope,
      ...(clientId ? { authInfo: { clientId } } : {}),
    })
    return new Response(JSON.stringify({
      jsonrpc: '2.0', id,
      result: { ...result, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO } },
    }), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  } catch (caught) {
    if (caught instanceof ProtocolError) {
      return error(caught.code, caught.message, caught.data, caught.code === TASKS_MISSING_CAPABILITY_CODE ? 400 : 200)
    }
    return error(ProtocolErrorCode.InvalidParams, caught instanceof Error ? caught.message : String(caught), undefined, 200)
  }
}

if (isStdioEntrypoint(process.argv[1])) {
  const handle = serveStdio(() => createComputerUseServer(), {
    legacy: 'serve',
    maxSubscriptions: 256,
    transport: new TasksExtensionTransport(new StdioServerTransport(), taskManager),
    onerror: error => console.error('[computer-use-mcp]', error.message),
  })
  console.error('[computer-use-mcp] Server running (MCP 2026-07-28 + legacy 2025)')
  const shutdown = async () => { await handle.close() }
  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })
}
