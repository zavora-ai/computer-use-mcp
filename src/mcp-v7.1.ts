import { fileURLToPath } from 'node:url'
import type { LoggingLevel, McpServer, ServerContext } from '@modelcontextprotocol/server'
import {
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server'

export interface McpV71Options {
  isSubscribable(uri: string): boolean
  authorizeSubscription?(uri: string, context: ServerContext): Promise<void>
  onRootsChanged?(roots: readonly string[] | undefined): void
}

/** Negotiated MCP 7.1 features that are additive to the stable v7 tool API. */
export class McpV71Controller {
  readonly #server: McpServer
  readonly #options: McpV71Options
  readonly #subscriptions = new Map<string, ServerContext>()
  #clientRoots: string[] | undefined

  constructor(server: McpServer, options: McpV71Options) {
    this.#server = server
    this.#options = options

    server.server.setRequestHandler('resources/subscribe', async (request, context) => {
      await options.authorizeSubscription?.(request.params.uri, context)
      if (!options.isSubscribable(request.params.uri)) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource is not subscribable: ${request.params.uri}`)
      }
      this.#subscriptions.set(request.params.uri, context)
      return {}
    })
    server.server.setRequestHandler('resources/unsubscribe', async request => {
      this.#subscriptions.delete(request.params.uri)
      return {}
    })
    server.server.setNotificationHandler('notifications/roots/list_changed', async () => {
      await this.refreshRoots()
    })

    const previousInitialized = server.server.oninitialized
    server.server.oninitialized = async () => {
      previousInitialized?.()
      await this.refreshRoots()
      await this.log('info', 'computer-use v7.1 MCP capabilities initialized', {
        roots: this.#clientRoots?.length ?? null,
        resourceSubscriptions: true,
      })
    }
  }

  clientRoots(): readonly string[] | undefined {
    return this.#clientRoots === undefined ? undefined : [...this.#clientRoots]
  }

  async refreshRoots(): Promise<void> {
    const capabilities = this.#server.server.getClientCapabilities()
    if (!capabilities?.roots) {
      this.#clientRoots = undefined
      this.#options.onRootsChanged?.(undefined)
      return
    }

    // Deny filesystem access while a roots-capable client is being refreshed.
    this.#clientRoots = []
    this.#options.onRootsChanged?.([])
    try {
      const result = await this.#server.server.listRoots(undefined, { timeout: 10_000 })
      this.#clientRoots = result.roots.flatMap(root => {
        try {
          const parsed = new URL(root.uri)
          if (parsed.protocol !== 'file:') return []
          return [fileURLToPath(parsed)]
        } catch {
          return []
        }
      })
      this.#options.onRootsChanged?.(this.clientRoots())
      await this.log('info', 'MCP client roots refreshed', { count: this.#clientRoots.length })
    } catch (error) {
      await this.log('warning', 'Unable to refresh MCP client roots; filesystem access remains denied', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async resourceUpdated(uri: string): Promise<void> {
    if (!this.#server.isConnected()) return
    // Modern subscriptions are owned by the stateless entry handler and are
    // matched there when this notification is emitted. Legacy subscriptions
    // remain connection-local and are tracked by this controller.
    const modern = this.#server.server.getNegotiatedProtocolVersion() === '2026-07-28'
    if (!modern && !this.#subscriptions.has(uri)) return
    try {
      const context = this.#subscriptions.get(uri)
      if (context) await this.#options.authorizeSubscription?.(uri, context)
      await this.#server.server.sendResourceUpdated({ uri })
    } catch {
      // Update notifications are advisory and must never fail a tool call.
    }
  }

  async log(level: LoggingLevel, message: string, fields: Record<string, unknown> = {}): Promise<void> {
    if (!this.#server.isConnected()) return
    try {
      await this.#server.sendLoggingMessage({
        level,
        logger: 'computer-use',
        data: { message, ...fields },
      })
    } catch {
      // Logging is best effort and contains no arguments, results, or secrets.
    }
  }
}
