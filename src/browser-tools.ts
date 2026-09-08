import { z } from 'zod'
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import type { ToolRegistry } from './registry/registry.js'
import { BrowserBackend } from './browser.js'
import { principalKey } from './authority.js'
import type { ExtraExecutors } from './strategy.js'

export function registerBrowserTools(server: McpServer, browser: BrowserBackend, registry: ToolRegistry): ExtraExecutors {
  const executors: ExtraExecutors = new Map()
  const target = z.object({ role: z.string().max(100), name: z.string().max(1000), frameName: z.string().max(1000).optional() })
  const definitions = [
    ['browser_open', { url: z.string().url() }, 'Open a fresh isolated browser context at a host-permitted origin.'],
    ['browser_navigate', { tabId: z.string(), url: z.string().url() }, 'Navigate an owned tab within host origin grants. Redirects are rejected.'],
    ['browser_observe', { tabId: z.string() }, 'Read bounded, value-free page text and controls, frame names and diagnostics.'],
    ['browser_screenshot', { tabId: z.string() }, 'Capture the current owned tab viewport as an image.'],
    ['browser_click', { tabId: z.string(), target, button: z.enum(['left', 'right', 'middle']).optional(), modifiers: z.array(z.enum(['Alt', 'Control', 'Meta', 'Shift'])).max(4).optional() }, 'Click one exact semantic match, optionally holding modifiers.'],
    ['browser_fill', { tabId: z.string(), target, value: z.string().max(100000) }, 'Fill one non-sensitive field identified by its exact accessible name.'],
    ['browser_wait', { tabId: z.string(), target, state: z.enum(['visible', 'hidden']), timeoutMs: z.number().int().min(1).max(120000).optional() }, 'Wait locally for browser element visibility.'],
    ['browser_upload', { tabId: z.string(), target, path: z.string() }, 'Upload a file from host-issued upload roots, limited to 8 MiB.'],
    ['browser_download', { tabId: z.string(), target }, 'Download from an exact control into a host-issued private directory, limited to 8 MiB.'],
    ['browser_close', { tabId: z.string() }, 'Close only the owned isolated tab/context.'],
  ] as const
  for (const [name, schema, description] of definitions) {
    const registered = server.registerTool(name, { inputSchema: schema, description }, async (args: any, ctx: ServerContext) => {
      const owner = principalKey(ctx.http?.authInfo) ?? 'local'
      try {
        await registry.authorizeExtension(name, args, ctx)
        let value: unknown
        switch (name) {
          case 'browser_open': value = await browser.open(owner, args.url); break
          case 'browser_navigate': value = await browser.navigate(owner, args.tabId, args.url); break
          case 'browser_observe': value = await browser.inspect(owner, args.tabId); break
          case 'browser_screenshot': return await browser.screenshot(owner, args.tabId)
          case 'browser_click': value = await browser.click(owner, args.tabId, args.target, args); break
          case 'browser_fill': value = await browser.fill(owner, args.tabId, args.target, args.value); break
          case 'browser_wait': value = await browser.wait(owner, args.tabId, args.target, args.state, args.timeoutMs); break
          case 'browser_upload': value = await browser.upload(owner, args.tabId, args.target, args.path); break
          case 'browser_download': value = await browser.download(owner, args.tabId, args.target); break
          case 'browser_close': await browser.closeTab(owner, args.tabId); value = { status: 'closed' }; break
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value }
      } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: String(error) }] } }
    })
    executors.set(name, async (args, ctx) => registered.executor(args, ctx))
  }
  return executors
}
