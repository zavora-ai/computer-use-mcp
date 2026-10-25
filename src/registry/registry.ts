import { issueApproval, useApproval } from '../approval-ledger.js'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  inputRequired,
  inputResponse,
  type InputRequiredResult,
  type CallToolResult,
  type McpServer,
  type RegisteredTool,
  type RequestStateCodec,
  type ServerContext,
} from '@modelcontextprotocol/server'
import { z, type ZodTypeAny } from 'zod'
import type { ElicitApproval, Session, SessionRequestContext } from '../session.js'
import {
  TOOL_CATALOG,
  getToolMeta,
  toMcpAnnotations,
  toolAvailableOn,
  toolInProfile,
  toolListedInProfile,
  type ProfileName,
  type ToolMeta,
} from '../tool-catalog.js'
import { outputSchemaFor } from '../output-schemas.js'
import { coerceToShape } from './coerce.js'
import { toMcpToolResult, type ToolResult } from '../result.js'

export type ToolHandler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
  onProgress?: (update: { progress: number; total?: number; message?: string }) => void,
) => Promise<ToolResult>

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, ZodTypeAny>
  meta: ToolMeta
  handler?: ToolHandler
  /** Preserve the intentionally narrow legacy metadata shape for get_tool_metadata. */
  wireMetaShape?: 'full' | 'legacy_minimal'
  /**
   * 7.6.1: arguments the handler reads that the schema does not advertise (the click aliases' targeting, `scroll`'s
   * `delta_x`/`delta_y`). Everything else that is not in the schema is refused with `invalid_arguments`: a misspelled
   * `target_app` used to be dropped silently and the input went to the wrong window.
   */
  undeclaredArgs?: readonly string[]
}

export interface ToolRegistryOptions {
  profile: ProfileName
  structuredContent: boolean
  legacyFocusTag: boolean
  approvalTokenSchema: ZodTypeAny
  session: Session
  /** HMAC-protected state used by 2026 multi-round-trip roots and approval flows. */
  requestStateCodec?: RequestStateCodec<McpRequestState>
  /** Initial enabled subset. `profile` remains the immutable maximum authority. */
  activeProfile?: ProfileName
  /** v7.6 R7: the platform whose tools are registered (default: this process's). A tool not for it is neither listed nor callable. */
  platform?: NodeJS.Platform
  /** v7.6 R7: advertise `approval_token` in every mutating tool's schema as before 7.6 (default false: the token is accepted in `_meta` and as an undeclared argument). */
  advertiseApprovalToken?: boolean
  /** v7.6 R7: send all seven `computer-use/*` fields in each tool's `_meta` (default false: focusRequired and mutates only). */
  fullWireMeta?: boolean
  /** Transport/host authorization checked immediately before every tool handler. */
  authorizeToolCall?: (context: {
    definition: ToolDefinition
    args: Readonly<Record<string, unknown>>
    authInfo?: {
      token: string
      clientId: string
      scopes: string[]
      expiresAt?: number
      extra?: Record<string, unknown>
    }
  }) => Promise<void> | void
  afterToolCall?: (context: {
    definition: ToolDefinition
    args: Readonly<Record<string, unknown>>
    result: ToolResult
    durationMs: number
    mcpContext: ServerContext
  }) => Promise<ToolResult | void> | ToolResult | void
  onProfileChanged?: (profile: ProfileName) => Promise<void> | void
}

interface McpRequestState {
  kind: 'computer-use-v7.1'
  tool: string
  argsHash: string
  clientRoots?: string[]
  approval?: true
  approvalId?: string
}

class McpInputRequiredSignal extends Error {
  readonly mcpInputRequired = true
  constructor(readonly result: InputRequiredResult) {
    super('MCP input required')
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'approval_token')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function argsHash(tool: string, args: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(`${tool}\0${stableJson(args)}`).digest('hex')
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i++) {
    let diagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= right.length; j++) {
      const saved = previous[j]
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1))
      diagonal = saved
    }
  }
  return previous[right.length]
}

/** The declared name closest to an unknown one, when it is close enough to be a typo. */
export function nearestArgumentName(unknown: string, declared: Iterable<string>): string | undefined {
  let best: { name: string; distance: number } | undefined
  for (const name of declared) {
    const distance = editDistance(unknown.toLowerCase(), name.toLowerCase())
    if (distance <= Math.max(2, Math.floor(name.length / 3)) && (!best || distance < best.distance)) best = { name, distance }
  }
  return best?.name
}

function modernClientCapabilities(ctx: ServerContext): Record<string, unknown> | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined
  if (envelope?.[PROTOCOL_VERSION_META_KEY] !== '2026-07-28') return undefined
  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY]
  return capabilities && typeof capabilities === 'object'
    ? capabilities as Record<string, unknown>
    : {}
}

/** How long a legacy client has to answer the progress barrier's `ping` before the result is written anyway. */
const PROGRESS_BARRIER_TIMEOUT_MS = 1_000

/**
 * 7.7.0 (K10): returns once the client has handled the progress notifications already written for a call, so the
 * result written next cannot discard them. Writing them first is not enough. When the notifications and the result
 * reach the client in one read, the pinned SDK client settles the response at once, which removes the call's progress
 * handler, and handles notifications a microtask later, so each is dropped as "unknown token". A legacy-era client
 * answers a `ping` only after the notifications queued ahead of it, so the result goes out after that answer. Elsewhere
 * it stays one event-loop turn, which narrows the race but does not close it: the 2026-07-28 era has no
 * server-to-client request, and over HTTP the client's answer has no way back to a stateless request, so the ping only
 * waited out its timeout.
 */
async function progressHandled(ctx: ServerContext, modern: boolean): Promise<void> {
  if (!modern && !ctx.http) {
    try {
      await ctx.mcpReq.send({ method: 'ping' }, { timeout: PROGRESS_BARRIER_TIMEOUT_MS, signal: ctx.mcpReq.signal })
      return
    } catch {
      // A client that does not answer ping, or a cancelled call: fall back to one turn.
    }
  }
  await new Promise<void>(resolve => setImmediate(resolve))
}

function approvalMessage(tool: string, args: Readonly<Record<string, unknown>>, details: Parameters<ElicitApproval>[0]): string {
  const scope: string[] = [`tool: ${tool}`]
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return
    const raw = typeof value === 'string' ? value : JSON.stringify(value)
    scope.push(`${label}: ${raw.length > 1_000 ? `${raw.slice(0, 1_000)}…` : raw}`)
  }
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
  return [
    'Approve computer-use action?',
    ...scope,
    `risk: ${details.destructive ? 'destructive or difficult to reverse' : 'mutating'}`,
    `policy reasons: ${details.reasons.join(', ')}`,
  ].join('\n')
}

/**
 * Authoritative runtime registry for tool definitions and registration.
 *
 * Definitions are collected first and registered only after completeness and
 * duplicate checks pass. This prevents catalog/schema/handler drift from
 * becoming a partially initialized MCP server.
 */
export class ToolRegistry {
  readonly #definitions = new Map<string, ToolDefinition>()
  readonly #registeredMeta = new Map<string, ToolMeta>()
  readonly #registeredTools = new Map<string, RegisteredTool>()
  readonly #options: ToolRegistryOptions
  readonly #sessions = new WeakMap<ServerContext, Session>()
  readonly #preflights = new WeakSet<ServerContext>()
  #activeProfile: ProfileName

  constructor(options: ToolRegistryOptions) {
    this.#options = options
    this.#activeProfile = options.activeProfile ?? options.profile
  }

  define(definition: ToolDefinition): void {
    if (this.#definitions.has(definition.name)) {
      throw new Error(`duplicate tool definition: "${definition.name}"`)
    }
    const catalogMeta = getToolMeta(definition.name)
    if (!catalogMeta) {
      throw new Error(`tool "${definition.name}" missing from TOOL_CATALOG`)
    }
    if (catalogMeta && JSON.stringify(catalogMeta) !== JSON.stringify(definition.meta)) {
      throw new Error(`tool "${definition.name}" metadata conflicts with its catalog entry`)
    }
    // Bind the stored definition to the canonical per-name object even when a
    // call site used a structurally equivalent category alias.
    this.#definitions.set(definition.name, { ...definition, meta: catalogMeta })
  }

  getMeta(name: string): ToolMeta | undefined {
    return this.#registeredMeta.get(name) ?? this.#definitions.get(name)?.meta ?? getToolMeta(name)
  }

  definitions(): readonly ToolDefinition[] {
    return [...this.#definitions.values()]
  }

  activeProfile(): ProfileName {
    return this.#activeProfile
  }

  /**
   * Narrow or reshape the enabled tool surface within the host-configured
   * maximum profile. RegisteredTool updates emit MCP tools/list_changed.
   */
  setActiveProfile(profile: ProfileName): { profile: ProfileName; enabled: string[]; disabled: string[] } {
    this.#activeProfile = profile
    const enabled: string[] = []
    const disabled: string[] = []
    for (const [name, tool] of this.#registeredTools) {
      const definition = this.#definitions.get(name)!
      const shouldEnable = this.#withinMaximum(definition) && this.#inActiveSurface(definition, profile)
      if (shouldEnable && !tool.enabled) tool.enable()
      else if (!shouldEnable && tool.enabled) tool.disable()
      ;(shouldEnable ? enabled : disabled).push(name)
    }
    void this.#options.onProfileChanged?.(profile)
    return { profile, enabled: enabled.sort(), disabled: disabled.sort() }
  }

  isWithinMaximum(name: string): boolean {
    const definition = this.#definitions.get(name)
    return Boolean(definition && this.#withinMaximum(definition))
  }

  /** Execute through the registered schema validator and the same policy/MCP wrapper as tools/call. */
  async executeRegistered(name: string, args: unknown, context: ServerContext): Promise<CallToolResult | InputRequiredResult> {
    const registered = this.#registeredTools.get(name)
    if (!registered || !registered.enabled) {
      throw new Error(`Unknown or disabled tool: ${name}`)
    }
    return registered.executor(args, context)
  }

  retainSession(): () => void { return this.#options.session.retain?.() ?? (() => {}) }

  async resumeReadOnly(name: string, args: unknown, context: ServerContext, pending: InputRequiredResult, responses: Record<string, unknown>) {
    if (this.getMeta(name)?.mutates !== false || !pending.requestState || !this.#options.requestStateCodec) throw new Error('No safe read-only continuation')
    const state = await this.#options.requestStateCodec.verify(pending.requestState, context)
    const resumed = { ...context, mcpReq: { ...context.mcpReq, inputResponses: responses as any,
      requestState: <T>() => state as T } }
    return this.executeRegistered(name, args, resumed)
  }

  async authorizeExtension(name: string, args: Record<string, unknown>, context: ServerContext): Promise<void> {
    await this.#options.authorizeToolCall?.({ definition: { name, description: name, inputSchema: {}, meta: TOOL_CATALOG.openai_computer },
      args, ...(context.http?.authInfo ? { authInfo: context.http.authInfo } : {}) })
  }

  async executeInSession(name: string, args: unknown, context: ServerContext, session: Session, preflight = false) {
    this.#sessions.set(context, session)
    try { return await (preflight ? this.preflight(name, args, context) : this.executeRegistered(name, args, context)) }
    finally { this.#sessions.delete(context) }
  }

  /** Validate schema, host authority, roots and policy without executing the operation. */
  async preflight(name: string, args: unknown, context: ServerContext): Promise<CallToolResult | InputRequiredResult> {
    this.#preflights.add(context)
    try { return await this.executeRegistered(name, args, context) }
    finally { this.#preflights.delete(context) }
  }

  assertComplete(): void {
    const catalogNames = new Set(Object.keys(TOOL_CATALOG))
    const definitionNames = new Set(this.#definitions.keys())
    const missing = [...catalogNames].filter(name => !definitionNames.has(name)).sort()
    const extra = [...definitionNames].filter(name => !catalogNames.has(name)).sort()
    if (missing.length || extra.length) {
      throw new Error(
        `tool registry incomplete: missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
      )
    }
  }

  /**
   * 7.7.0 (K2): the checks a direct call gets, for a call that does not arrive over MCP (a run_steps step): unknown
   * arguments refused by name with the nearest declared one, then the schema applied with its defaults.
   */
  validateArguments(tool: string, args: Record<string, unknown>):
    | { ok: true; args: Record<string, unknown> }
    | { ok: false; issues: Array<{ path: string; message: string }> } {
    const definition = this.#definitions.get(tool)
    if (!definition) return { ok: false, issues: [{ path: '(tool)', message: `unknown tool ${tool}` }] }
    const accepted = new Set([...Object.keys(definition.inputSchema), 'approval_token', ...(definition.undeclaredArgs ?? [])])
    const unknownKeys = Object.keys(args ?? {}).filter(key => !accepted.has(key))
    if (unknownKeys.length > 0) {
      return {
        ok: false,
        issues: unknownKeys.map(key => {
          const nearest = nearestArgumentName(key, accepted)
          return { path: key, message: `unknown argument${nearest ? `; did you mean "${nearest}"?` : ''}` }
        }),
      }
    }
    const validated = z.object(definition.inputSchema).passthrough().safeParse(coerceToShape(definition.inputSchema, args ?? {}))
    if (!validated.success) {
      return {
        ok: false,
        issues: validated.error.issues.map(issue => ({ path: issue.path.join('.') || '(root)', message: issue.message })),
      }
    }
    return { ok: true, args: validated.data }
  }

  registerAll(server: McpServer): void {
    this.assertComplete()

    const platform = this.#options.platform ?? process.platform
    for (const definition of this.#definitions.values()) {
      const meta = definition.meta
      // v7.6 R7: a tool that doesn't exist on this platform is not registered at all (it used to be listed and fail
      // with platform_unsupported at call time).
      if (!toolAvailableOn(meta, platform)) continue
      if (!this.#withinMaximum(definition)) continue

      this.#registeredMeta.set(definition.name, meta)
      const description = this.#options.legacyFocusTag
        ? `${definition.description} [focusRequired: ${meta.focusRequired}]`
        : definition.description
      // v7.6 R7: the approval token is no longer advertised on 40 schemas. It is still accepted: the registry parses
      // arguments with passthrough, and `_meta["computer-use/approval_token"]` on the call is copied into the arguments.
      const inputSchema = meta.mutates && this.#options.advertiseApprovalToken
        ? { ...definition.inputSchema, approval_token: this.#options.approvalTokenSchema }
        : definition.inputSchema
      const outputSchema = this.#options.structuredContent
        ? outputSchemaFor(definition.name, platform)
        : undefined
      const fullMeta = {
        'computer-use/focusRequired': meta.focusRequired,
        'computer-use/mutates': meta.mutates,
        'computer-use/requiresFocus': meta.requiresFocus,
        'computer-use/movesUserCursor': meta.movesUserCursor,
        'computer-use/usesVirtualPointer': meta.usesVirtualPointer,
        'computer-use/physicalInput': meta.physicalInput,
        'computer-use/tier': meta.tier,
      }
      // v7.6 R7: two fields by default (7 KB less in tools/list); get_tool_metadata still returns the full set.
      const wireMeta = definition.wireMetaShape === 'legacy_minimal' || !this.#options.fullWireMeta
        ? {
            'computer-use/focusRequired': meta.focusRequired,
            'computer-use/mutates': meta.mutates,
          }
        : fullMeta

      const registered = server.registerTool(
        definition.name,
        {
          title: definition.name.split('_').map(part => part[0]?.toUpperCase() + part.slice(1)).join(' '),
          description,
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
          annotations: toMcpAnnotations(meta),
          _meta: wireMeta,
        },
        async (args: Record<string, unknown>, extra) => {
          // 7.6.1: an argument the schema does not declare is refused by name, with the nearest declared name. The
          // parse below stays passthrough so the accepted undeclared keys (approval_token, an alias's targeting)
          // reach the handler.
          const accepted = new Set([...Object.keys(inputSchema), 'approval_token', ...(definition.undeclaredArgs ?? [])])
          const unknownKeys = Object.keys(args ?? {}).filter(key => !accepted.has(key))
          if (unknownKeys.length > 0) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                error: 'invalid_arguments',
                tool: definition.name,
                issues: unknownKeys.map(key => {
                  const nearest = nearestArgumentName(key, accepted)
                  return { path: key, message: `unknown argument${nearest ? `; did you mean "${nearest}"?` : ''}` }
                }),
                accepted: [...accepted].filter(key => key !== 'approval_token'),
                remediation: ['Remove or rename the listed arguments; the tool input schema lists what this tool accepts.'],
              }) }],
              isError: true,
            }
          }
          // Apply advertised defaults and coercions before anything reads `args`,
          // so handlers never have to restate a schema default. Malformed input
          // becomes a recoverable tool result rather than a JSON-RPC fault: an
          // agent can read `issues` and retry, but cannot retry a thrown error.
          const validated = z.object(inputSchema).passthrough().safeParse(coerceToShape(inputSchema, args))
          if (!validated.success) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                error: 'invalid_arguments',
                tool: definition.name,
                issues: validated.error.issues.map(issue => ({
                  path: issue.path.join('.') || '(root)',
                  message: issue.message,
                })),
                remediation: ['Correct the listed arguments against the tool input schema and call again.'],
              }) }],
              isError: true,
            }
          }
          args = validated.data
          // v7.6 R7: an approval token passed in the call's _meta (not in the model-visible arguments).
          const callMeta = (extra as { mcpReq?: { params?: { _meta?: Record<string, unknown> } }; _meta?: Record<string, unknown> })
          const metaToken = callMeta.mcpReq?.params?._meta?.['computer-use/approval_token'] ?? callMeta._meta?.['computer-use/approval_token']
          if (typeof metaToken === 'string' && typeof args.approval_token !== 'string') args = { ...args, approval_token: metaToken }
          const capabilities = modernClientCapabilities(extra)
          const hash = argsHash(definition.name, args)
          const echoedState = extra.mcpReq.requestState<McpRequestState>()
          const validState = echoedState?.kind === 'computer-use-v7.1'
            && echoedState.tool === definition.name
            && echoedState.argsHash === hash
            ? echoedState
            : undefined
          if (echoedState && !validState) {
            return {
              content: [{ type: 'text', text: JSON.stringify({
                error: 'invalid_request_state',
                message: 'The multi-round-trip state does not match this exact tool call.',
              }) }],
              isError: true,
            }
          }

          const preflight = this.#preflights.has(extra)
          const requestContext: SessionRequestContext = { preflight }
          if (capabilities && definition.name === 'filesystem'
            && capabilities.roots && typeof capabilities.roots === 'object') {
            let clientRoots = validState?.clientRoots
            if (!clientRoots) {
              const roots = inputResponse(extra.mcpReq.inputResponses, 'computer_use_roots')
              if (roots.kind === 'roots') {
                clientRoots = roots.roots.flatMap(root => {
                  try {
                    const parsed = new URL(root.uri)
                    return parsed.protocol === 'file:' ? [fileURLToPath(parsed)] : []
                  } catch {
                    return []
                  }
                })
              } else {
                const requestState = await this.#options.requestStateCodec?.mint({
                  kind: 'computer-use-v7.1',
                  tool: definition.name,
                  argsHash: hash,
                }, extra)
                return inputRequired({
                  inputRequests: { computer_use_roots: inputRequired.listRoots() },
                  ...(requestState ? { requestState } : {}),
                })
              }
            }
            requestContext.clientRoots = clientRoots
          }

          if (capabilities) {
            requestContext.elicitApproval = async details => {
              const response = inputResponse(extra.mcpReq.inputResponses, 'computer_use_approval')
              if (response.kind === 'elicit') {
                return response.action === 'accept'
                  && response.content?.approve === true
                  && validState?.approval === true
                  && useApproval(validState.approvalId, preflight)
              }
              const elicitation = capabilities.elicitation
              const supportsForm = elicitation && typeof elicitation === 'object'
                && (Object.keys(elicitation).length === 0
                  || 'form' in (elicitation as Record<string, unknown>))
              if (!supportsForm) return false
              const requestState = await this.#options.requestStateCodec?.mint({
                kind: 'computer-use-v7.1',
                tool: definition.name,
                argsHash: hash,
                ...(requestContext.clientRoots ? { clientRoots: [...requestContext.clientRoots] } : {}),
                approval: true,
                approvalId: issueApproval(),
              }, extra)
              throw new McpInputRequiredSignal(inputRequired({
                inputRequests: {
                  computer_use_approval: inputRequired.elicit({
                    message: approvalMessage(definition.name, args, details),
                    requestedSchema: {
                      type: 'object',
                      properties: {
                        approve: {
                          type: 'boolean',
                          title: `Approve ${definition.name}`,
                          description: 'Approve this exact, one-shot action only.',
                        },
                      },
                      required: ['approve'],
                    },
                  }),
                },
                ...(requestState ? { requestState } : {}),
              }))
            }
          }

          await this.#options.authorizeToolCall?.({
            definition,
            args,
            ...(extra.http?.authInfo ? { authInfo: extra.http.authInfo } : {}),
          })
          const progressToken = extra.mcpReq._meta?.progressToken
          const pendingProgressNotifications: Promise<void>[] = []
          let onProgress:
            | ((update: { progress: number; total?: number; message?: string }) => void)
            | undefined
          if (progressToken !== undefined) {
            const send = extra.mcpReq.notify as unknown as (
              notification: { method: string; params: Record<string, unknown> },
            ) => Promise<void>
            onProgress = update => {
              try {
                pendingProgressNotifications.push(Promise.resolve(send({
                  method: 'notifications/progress',
                  params: {
                    progressToken,
                    progress: update.progress,
                    ...(update.total !== undefined ? { total: update.total } : {}),
                    ...(update.message ? { message: update.message } : {}),
                  },
                })).catch(() => { /* best effort */ }))
              } catch {
                // Progress is best effort and must never fail the tool call.
              }
            }
          }

          const startedAt = Date.now()
          let result: ToolResult
          try {
            if (preflight) {
              const selected = this.#sessions.get(extra) ?? this.#options.session
              return selected.preflight
                ? toMcpToolResult(await selected.preflight(definition.name, args, extra.mcpReq.signal, requestContext), false)
                : { content: [{ type: 'text', text: JSON.stringify({ authorized: true, clientRoots: requestContext.clientRoots }) }] }
            }
            result = definition.handler
              ? await definition.handler(args, extra.mcpReq.signal, onProgress)
              : await (this.#sessions.get(extra) ?? this.#options.session).dispatch(
                  definition.name,
                  args,
                  extra.mcpReq.signal,
                  onProgress,
                  requestContext,
                )
          } catch (error) {
            if (error instanceof McpInputRequiredSignal) return error.result
            throw error
          }
          const transformed = await this.#options.afterToolCall?.({
            definition,
            args,
            result,
            durationMs: Date.now() - startedAt,
            mcpContext: extra,
          })
          if (transformed) result = transformed
          // Preserve notification-before-result ordering. Fire-and-forget
          // progress can otherwise arrive after a fast synchronous handler's
          // response (or after transport close under parallel CI load).
          if (pendingProgressNotifications.length > 0) {
            await Promise.all(pendingProgressNotifications)
            await progressHandled(extra, capabilities !== undefined)
          }
          return toMcpToolResult(result, this.#options.structuredContent)
        },
      )
      this.#registeredTools.set(definition.name, registered)
      if (!this.#inActiveSurface(definition, this.#activeProfile)) registered.disable()
    }
    this.#listOnlyListedTools(server)
  }

  /**
   * 7.7.0 (K2): tools/list leaves out a tool its catalog entry lists only from a later profile (the click aliases,
   * listed in `full`), while the tool stays registered and callable. The SDK lists every enabled tool, so its handler
   * is wrapped through the protocol's own handler accessors; a test pins this against the pinned SDK version.
   */
  #listOnlyListedTools(server: McpServer): void {
    type ListHandler = (request: unknown, context: unknown) => Promise<{ tools: Array<{ name: string }> } & Record<string, unknown>>
    const protocol = (server as unknown as {
      server: {
        _getRequestHandler?(method: string): ListHandler | undefined
        removeRequestHandler?(method: string): void
        setRequestHandler(method: string, handler: ListHandler): void
      }
    }).server
    const original = protocol._getRequestHandler?.('tools/list')
    if (!original || typeof protocol.removeRequestHandler !== 'function') return
    protocol.removeRequestHandler('tools/list')
    protocol.setRequestHandler('tools/list', async (request, context) => {
      const result = await original(request, context)
      return {
        ...result,
        tools: result.tools.filter(tool => {
          const meta = this.#registeredMeta.get(tool.name)
          return !meta || toolListedInProfile(meta, this.#activeProfile)
        }),
      }
    })
  }

  #withinMaximum(definition: ToolDefinition): boolean {
    return toolInProfile(definition.meta, this.#options.profile)
  }

  #inActiveSurface(definition: ToolDefinition, profile: ProfileName): boolean {
    return toolInProfile(definition.meta, profile)
  }
}
