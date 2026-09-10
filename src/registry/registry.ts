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
import type { ZodTypeAny } from 'zod'
import type { ElicitApproval, Session, SessionRequestContext } from '../session.js'
import {
  TOOL_CATALOG,
  getToolMeta,
  toMcpAnnotations,
  toolInProfile,
  type ProfileName,
  type ToolMeta,
} from '../tool-catalog.js'
import { PRIORITY_OUTPUT_SCHEMAS } from '../output-schemas.js'
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

function modernClientCapabilities(ctx: ServerContext): Record<string, unknown> | undefined {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined
  if (envelope?.[PROTOCOL_VERSION_META_KEY] !== '2026-07-28') return undefined
  const capabilities = envelope[CLIENT_CAPABILITIES_META_KEY]
  return capabilities && typeof capabilities === 'object'
    ? capabilities as Record<string, unknown>
    : {}
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
      const meta = this.#registeredMeta.get(name)!
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

  registerAll(server: McpServer): void {
    this.assertComplete()

    for (const definition of this.#definitions.values()) {
      const meta = definition.meta
      if (!this.#withinMaximum(definition)) continue

      this.#registeredMeta.set(definition.name, meta)
      const description = this.#options.legacyFocusTag
        ? `${definition.description} [focusRequired: ${meta.focusRequired}]`
        : definition.description
      const inputSchema = meta.mutates
        ? { ...definition.inputSchema, approval_token: this.#options.approvalTokenSchema }
        : definition.inputSchema
      const outputSchema = this.#options.structuredContent
        ? PRIORITY_OUTPUT_SCHEMAS[definition.name]
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
      const wireMeta = definition.wireMetaShape === 'legacy_minimal'
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
                && (Object.keys(elicitation as object).length === 0
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
            // Give transports that schedule notification delivery separately
            // from response delivery one turn to flush the already-awaited
            // progress frames before the terminal tool result is returned.
            await new Promise<void>(resolve => setImmediate(resolve))
          }
          return toMcpToolResult(result, this.#options.structuredContent)
        },
      )
      this.#registeredTools.set(definition.name, registered)
      if (!this.#inActiveSurface(definition, this.#activeProfile)) registered.disable()
    }
  }

  #withinMaximum(definition: ToolDefinition): boolean {
    return toolInProfile(definition.meta, this.#options.profile)
  }

  #inActiveSurface(definition: ToolDefinition, profile: ProfileName): boolean {
    return toolInProfile(definition.meta, profile)
  }
}
