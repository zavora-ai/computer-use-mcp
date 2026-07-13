import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodTypeAny } from 'zod'
import type { Session } from '../session.js'
import {
  TOOL_CATALOG,
  getToolMeta,
  toMcpAnnotations,
  toolInProfile,
  type ProfileName,
  type SurfaceProfileName,
  type ToolMeta,
} from '../tool-catalog.js'
import { PRIORITY_OUTPUT_SCHEMAS } from '../output-schemas.js'
import { toMcpToolResult, type ToolResult } from '../result.js'
import type { RiskMapper } from '../runtime/action.js'
import type { ActionClassification } from '../runtime/action.js'

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
  riskMapper: RiskMapper
  /** v8 definitions may extend the frozen v7 catalog during the preview cycle. */
  apiVersion?: 7 | 8
  handler?: ToolHandler
  /** Preserve the intentionally narrow legacy metadata shape for get_tool_metadata. */
  wireMetaShape?: 'full' | 'legacy_minimal'
  /** Runtime actuator reachable only through preview_action/execute_action. */
  internalOnly?: boolean
}

export interface ToolRegistryOptions {
  profile: ProfileName
  structuredContent: boolean
  legacyFocusTag: boolean
  approvalTokenSchema: ZodTypeAny
  session: Session
  enableV8?: boolean
  /** Initial enabled subset. `profile` remains the immutable maximum authority. */
  activeProfile?: SurfaceProfileName
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
  #activeProfile: SurfaceProfileName

  constructor(options: ToolRegistryOptions) {
    this.#options = options
    this.#activeProfile = options.activeProfile ?? options.profile
  }

  define(definition: ToolDefinition): void {
    if (this.#definitions.has(definition.name)) {
      throw new Error(`duplicate tool definition: "${definition.name}"`)
    }
    const catalogMeta = getToolMeta(definition.name)
    if (!catalogMeta && definition.apiVersion !== 8) {
      throw new Error(`tool "${definition.name}" missing from TOOL_CATALOG`)
    }
    if (catalogMeta && JSON.stringify(catalogMeta) !== JSON.stringify(definition.meta)) {
      throw new Error(`tool "${definition.name}" metadata conflicts with its catalog entry`)
    }
    // Bind the stored definition to the canonical per-name object even when a
    // call site used a structurally equivalent category alias.
    this.#definitions.set(definition.name, { ...definition, meta: catalogMeta ?? definition.meta })
  }

  getMeta(name: string): ToolMeta | undefined {
    return this.#registeredMeta.get(name) ?? this.#definitions.get(name)?.meta ?? getToolMeta(name)
  }

  definitions(): readonly ToolDefinition[] {
    return [...this.#definitions.values()]
  }

  activeProfile(): SurfaceProfileName {
    return this.#activeProfile
  }

  /**
   * Narrow or reshape the enabled tool surface within the host-configured
   * maximum profile. RegisteredTool updates emit MCP tools/list_changed.
   */
  setActiveProfile(profile: SurfaceProfileName): { profile: SurfaceProfileName; enabled: string[]; disabled: string[] } {
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
    return { profile, enabled: enabled.sort(), disabled: disabled.sort() }
  }

  classify(name: string, args: Readonly<Record<string, unknown>>): ActionClassification | undefined {
    return this.#definitions.get(name)?.riskMapper(args)
  }

  isWithinMaximum(name: string): boolean {
    const definition = this.#definitions.get(name)
    return Boolean(definition && this.#withinMaximum(definition))
  }

  assertComplete(): void {
    const catalogNames = new Set(Object.keys(TOOL_CATALOG))
    const definitionNames = new Set(this.#definitions.keys())
    const missing = [...catalogNames].filter(name => !definitionNames.has(name)).sort()
    const extra = [...definitionNames].filter(name =>
      !catalogNames.has(name) && this.#definitions.get(name)?.apiVersion !== 8).sort()
    if (missing.length || extra.length) {
      throw new Error(
        `tool registry incomplete: missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
      )
    }
  }

  registerAll(server: McpServer): void {
    this.assertComplete()

    for (const definition of this.#definitions.values()) {
      if (definition.apiVersion === 8 && !this.#options.enableV8) continue
      const meta = definition.meta
      if (!this.#withinMaximum(definition)) continue

      this.#registeredMeta.set(definition.name, meta)
      if (definition.internalOnly) continue
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
          description,
          inputSchema,
          ...(outputSchema ? { outputSchema } : {}),
          annotations: toMcpAnnotations(meta),
          _meta: wireMeta,
        },
        async (args: Record<string, unknown>, extra) => {
          await this.#options.authorizeToolCall?.({
            definition,
            args,
            ...(extra?.authInfo ? { authInfo: extra.authInfo } : {}),
          })
          const progressToken = extra?._meta?.progressToken
          const pendingProgressNotifications: Promise<void>[] = []
          let onProgress:
            | ((update: { progress: number; total?: number; message?: string }) => void)
            | undefined
          if (progressToken !== undefined && extra?.sendNotification) {
            const send = extra.sendNotification as unknown as (
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

          const result = definition.handler
            ? await definition.handler(args, extra?.signal, onProgress)
            : await this.#options.session.dispatch(
                definition.name,
                args,
                extra?.signal,
                onProgress,
              )
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

  #inActiveSurface(definition: ToolDefinition, profile: SurfaceProfileName): boolean {
    if (profile === 'v8-safe') return definition.apiVersion === 8
    return toolInProfile(definition.meta, profile)
  }
}
