import { z } from 'zod'
import { isInputRequiredResult, type McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { principalKey } from './authority.js'
import { DesktopBroker, type DesktopExecutor } from './desktop-broker.js'
import type { ToolRegistry } from './registry/registry.js'
import { SESSION_CONSOLE_HTML } from './session-console.js'

export const UI_EXTENSION = 'io.modelcontextprotocol/ui'
export const CONSOLE_URI = 'ui://computer-use/session-console/v1'
export type ExtraExecutors = Map<string, (args: unknown, ctx: ServerContext) => Promise<any>>

/** Additive strategy surface, enabled only when the embedding host supplies a broker. */
export function registerStrategy(server: McpServer, registry: ToolRegistry, broker: DesktopBroker): ExtraExecutors {
  const executors: ExtraExecutors = new Map()
  const owner = (ctx: ServerContext) => principalKey(ctx.http?.authInfo) ?? 'local'
  const sid = z.string().min(16).max(128)
  const action = z.discriminatedUnion('type', [
    z.object({ type: z.literal('click'), x: z.number().finite(), y: z.number().finite() }),
    z.object({ type: z.literal('invoke'), elementId: z.string().max(128) }),
  ])
  const expect = z.object({ role: z.string().optional(), label: z.string(), state: z.enum(['present', 'absent']) }).optional()
  const execute = async (ctx: ServerContext, sessionId: string): Promise<DesktopExecutor> => {
    const session = await broker.session(owner(ctx), sessionId)
    const run = async (name: string, args: Record<string, unknown>, signal?: AbortSignal, preflight = false) => {
      const context = signal ? { ...ctx, mcpReq: { ...ctx.mcpReq, signal: AbortSignal.any([ctx.mcpReq.signal, signal]) } } : ctx
      const result = await registry.executeInSession(name, args, context, session, preflight)
      if (isInputRequiredResult(result)) throw Object.assign(new Error('Input required before desktop operation'), { inputRequired: result })
      return result as any
    }
    return Object.assign(run, { preflight: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => run(name, args, signal, true) })
  }
  const tool = (name: string, schema: Record<string, z.ZodType>, description: string, run: (args: any, ctx: ServerContext) => Promise<unknown>, ui = false) => {
    const registered = server.registerTool(name, {
      description, inputSchema: schema,
      ...(ui ? { _meta: { ui: { resourceUri: CONSOLE_URI } } } : {}),
    }, async (args, ctx) => {
      try {
        await registry.authorizeExtension(name, args, ctx)
        const value = await run(args, ctx)
        if (name === 'desktop_observe') {
          const observed = value as Awaited<ReturnType<DesktopBroker['observe']>>
          return { content: [{ type: 'text' as const, text: JSON.stringify(observed.observation) }, ...(observed.image?.content.filter(c => c.type === 'image') ?? [])], structuredContent: observed.observation }
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value }
      } catch (error) {
        if (error && typeof error === 'object' && 'inputRequired' in error) return (error as any).inputRequired
        return { isError: true, content: [{ type: 'text' as const, text: String(error) }] }
      }
    })
    executors.set(name, async (args, ctx) => registered.executor(args, ctx))
  }
  tool('desktop_session', { action: z.enum(['open', 'close']), sessionId: sid.optional() },
    'Open an owner-bound desktop session or close it. Session handles are private capabilities. Use the handle with desktop observation/action tools.',
    async (args, ctx) => args.action === 'open' ? broker.open(owner(ctx)) : broker.dispose(owner(ctx), args.sessionId).then(() => ({ state: 'closed' })))
  tool('desktop_observe', { sessionId: sid, windowId: z.number().int().nonnegative(), screenshot: z.boolean().default(false) },
    'Observe a window with bounded redacted controls, scoped element IDs and capture geometry. Observations expire and actions reject moved windows.',
    async (args, ctx) => {
      const result = await broker.observe(owner(ctx), args.sessionId, args.windowId, await execute(ctx, args.sessionId), args.screenshot)
      return result
    })
  tool('desktop_act', { sessionId: sid, operationId: z.string().min(8).max(128), observationId: z.string(), action, expect },
    'Execute one observation-bound action with deduplication and optional deterministic verification. Unknown outcomes require inspection before retry.',
    async (args, ctx) => broker.act(owner(ctx), args.sessionId, args, await execute(ctx, args.sessionId)))
  tool('desktop_workflow', { sessionId: sid, operationId: z.string().min(8).max(100), windowId: z.number().int().nonnegative(),
    steps: z.array(z.object({ role: z.string(), label: z.string(), expect: expect.unwrap() })).min(1).max(20) },
    'Execute a bounded semantic workflow. Each step obtains a fresh observation, invokes one unambiguous control, waits locally and verifies its expected state. Stops on errors and never replays an existing operation ID.',
    async (args, ctx) => broker.workflow(owner(ctx), args.sessionId, args, await execute(ctx, args.sessionId)))
  tool('desktop_console', { sessionId: sid }, 'Review session state, latest observation and last operation. Complete text fallback for hosts without MCP Apps.',
    async (args, ctx) => broker.status(owner(ctx), args.sessionId), true)
  tool('desktop_pause', { sessionId: sid }, 'Pause this session and invalidate queued observations for human takeover. Only the trusted host can resume.',
    async (args, ctx) => broker.pause(owner(ctx), args.sessionId))
  server.registerResource('session-console', CONSOLE_URI, { mimeType: 'text/html;profile=mcp-app' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/html;profile=mcp-app', text: SESSION_CONSOLE_HTML,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] }, prefersBorder: true } } }],
  }))
  return executors
}
