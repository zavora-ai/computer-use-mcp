#!/usr/bin/env node

/**
 * Agent console host: the one process that sits between a person and an agent.
 *
 * It owns a single run store and a single desktop session, and serves three
 * faces onto them:
 *
 * - **`/mcp`** — a real MCP endpoint (Streamable HTTP). Point an agent here and
 *   it gets the desktop tools *and* the run tools from the same server, so the
 *   plan it declares and the screenshots it captures land in the store the
 *   browser is reading.
 * - **`/` and `/app`** — the console UI, embedded in an iframe with the MCP Apps
 *   `postMessage` bridge, so the app is exercised the way a product host would.
 * - **`/rpc`** — the narrow bridge the page itself is allowed to call.
 *
 * ## Why one process
 *
 * `createComputerUseHttpHandler` builds a server per request, because modern MCP
 * requests are stateless. A run recorded by one request would be invisible to the
 * next unless the store is injected, so the store and the session are created
 * here, once, and passed in. That is the whole reason this file exists rather
 * than two independent servers.
 *
 * ## The conversation protocol
 *
 * One run is one conversation. The person's first message opens the run; later
 * messages are appended to its transcript. An agent decides there is work to do
 * by a single rule:
 *
 *   the last message has `role: "user"` → it has not been answered yet
 *
 * Answering appends an `agent` turn (any `run_progress` narration or `run_say`
 * does this), which clears the condition. There is no queue and no extra
 * endpoint: the transcript *is* the protocol, and every run tool reply carries
 * it, so an agent mid-task sees a new instruction without polling for it.
 *
 * ## Security
 *
 * Loopback only, and unauthenticated by design. `/mcp` exposes desktop control
 * to anything that can reach the port, so treat it like an open terminal: fine
 * on your own machine, never on a shared or exposed host. The page itself is
 * held to a two-tool allowlist and cannot speak as the agent.
 *
 * Usage:
 *   computer-use-mcp-console                # serve, and run the scripted demo
 *   computer-use-mcp-console --no-demo      # serve, and wait for a real agent
 *   computer-use-mcp-console --port 4600 --no-open
 *   computer-use-mcp-console --no-demo --brand 'Analytics Agent' \
 *     --credits 'ADK Rust,Business Intelligence MCP,running on=DeepSeek Flash'
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node'
import { createComputerUseServer, createComputerUseHttpHandler } from './server.js'
import { connectInProcess } from './client.js'
import { createSession } from './session.js'
import { RunStore, type RunAttachment } from './agent-run.js'
import { RUN_CONSOLE_HTML, runConsoleHtml, type ConsoleBrand } from './run-console.js'
import { isModuleEntrypoint } from './entrypoint.js'

/**
 * The host page: an iframe plus the postMessage bridge. Same origin, so no CSP
 * dance. Chrome is one thin strip, because the app is the thing being shown.
 */
const HOST_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent run console — MCP App host</title>
<link rel="icon" href="data:,">
<style>
:root{color-scheme:dark;font:14px system-ui}
body{margin:0;background:#101215;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#frame{flex:1;border:0;width:100%;background:transparent}
footer{display:flex;align-items:center;gap:12px;padding:0 12px;height:26px;flex:none;
  border-top:1px solid #262c34;background:#0c0e11;color:#5d6875;
  font:11px ui-monospace,Menlo,monospace;white-space:nowrap;overflow:hidden}
footer b{color:#8b95a3;font-weight:500}
#tail{flex:1;overflow:hidden;text-overflow:ellipsis}
</style></head><body>
<iframe id="frame" src="/app" title="Agent run console"></iframe>
<footer>
  <b>mcp app host</b><span>ui://computer-use/run-console/v1</span>
  <span id="status">initialising…</span><span id="tail"></span>
</footer>
<script>
const frame = document.getElementById('frame')
const log = line => { document.getElementById('tail').textContent = line }
let initialised = false

async function callTool(name, args) {
  const response = await fetch('/rpc', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  })
  return response.json()
}

// Host side of the MCP Apps handshake.
window.addEventListener('message', async event => {
  const message = event.data
  if (!message || message.jsonrpc !== '2.0') return
  const reply = payload => frame.contentWindow.postMessage({ jsonrpc: '2.0', id: message.id, ...payload }, '*')

  if (message.method === 'ui/initialize') {
    log('← ui/initialize')
    reply({ result: { hostInfo: { name: 'minimal-mcp-app-host', version: '1.0.0' }, hostCapabilities: {} } })
  } else if (message.method === 'ui/notifications/initialized') {
    initialised = true
    document.getElementById('status').textContent = 'app initialised'
    log('← ui/notifications/initialized')
    poll()
  } else if (message.method === 'tools/call') {
    log('← tools/call ' + message.params.name)
    reply({ result: await callTool(message.params.name, message.params.arguments) })
  }
})

// Push tool results as the run changes, which is what a host does for a live run.
let last = ''
async function poll() {
  if (!initialised) return
  try {
    const runId = await fetch('/run-id').then(r => r.text())
    if (runId) {
      const result = await callTool('run_console', { runId })
      // The screenshot dominates the payload and changes only when a frame lands,
      // so compare on the fields that decide whether the view needs repainting.
      const run = result.structuredContent ?? {}
      const serialised = JSON.stringify([run.state, run.updatedAt, run.screenshot?.at,
        run.messages?.length, run.activity?.length])
      if (serialised !== last) {
        last = serialised
        frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result }, '*')
        log('→ ui/notifications/tool-result (' + (run.state ?? '?') + ')')
      }
    } else {
      log('waiting for the first message')
    }
  } catch (error) {
    log('poll failed: ' + (error?.message ?? error))
  }
  setTimeout(poll, 900)
}
</script></body></html>`

/**
 * Image formats accepted from the page, and the ceiling on one upload.
 *
 * Restricted to what a model can actually look at, so an unusable file is
 * refused at the door rather than failing later inside a tool call.
 */
const IMAGE_TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
])
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024

/** Minimal shape of a tool result, which is all this host needs to inspect. */
interface ToolResult {
  content?: Array<{ type: string; text?: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

const textOf = (result: ToolResult): string =>
  result.content?.find(block => block.type === 'text')?.text ?? '{}'
const value = (result: ToolResult): Record<string, unknown> =>
  JSON.parse(textOf(result)) as Record<string, unknown>

export interface ConsoleHost {
  url: string
  mcpUrl: string
  port: number
  store: RunStore
  runId: () => string
  close: () => Promise<void>
}

export interface ServeOptions {
  /** Port to bind on loopback. `0` picks a free one, which tests want. */
  port?: number
  /** Run the scripted walkthrough, for looking at the console without an agent. */
  demo?: boolean
  /** Desktop session to drive. Injectable so tests need no real desktop. */
  session?: Parameters<typeof createComputerUseServer>[0] extends { session?: infer S } ? S : never
  /** Where to report activity. Printing is the CLI's job, not this function's. */
  onLog?: (line: string) => void
  /**
   * What the console header calls the agent. Omit it and the header reads
   * `Blender Agent`, which is what the published console has always shown.
   */
  brand?: ConsoleBrand
}

export async function serve({
  port = 4517,
  demo = false,
  session: injected,
  onLog = () => {},
  brand,
}: ServeOptions = {}): Promise<ConsoleHost> {
  // Built once: the header is fixed for the life of the host, so there is no
  // reason to re-render the document on every request for it.
  const app = brand ? runConsoleHtml(brand) : RUN_CONSOLE_HTML
  // Created once and injected, so every per-request server the MCP endpoint
  // builds records into the same transcript and captures through the same
  // desktop. This is the difference between a live console and an empty one.
  const store = new RunStore()
  const session = injected ?? createSession()
  const shared = { runConsole: true as const, runStore: store, session }

  // The page talks to this one; an agent gets its own per-request servers.
  const client = await connectInProcess(createComputerUseServer(shared))
  const mcp = createComputerUseHttpHandler(shared)
  const handleMcp = toNodeHandler(mcp, {
    onerror: (error: Error) => onLog(`mcp transport: ${error.message}`),
  })
  const validateHost = localhostHostValidation()
  const validateOrigin = localhostOriginValidation()

  /** The conversation. Empty until the person, or the demo, says something. */
  let currentRunId = ''
  /** Where uploads land. One directory per host, created on first use. */
  let uploadDirectory = ''

  /**
   * Save an image the person attached, and describe where it went.
   *
   * Written to disk rather than held in memory because the point of an attached
   * reference is that an application can open it: the path is what makes the
   * image usable to Blender, and it keeps run payloads free of base64.
   */
  function saveUpload(image: { name?: unknown; mimeType?: unknown; data?: unknown }): RunAttachment {
    const mimeType = String(image.mimeType ?? '')
    const suffix = IMAGE_TYPES.get(mimeType)
    if (!suffix) {
      throw new Error(`${mimeType || 'that file type'} cannot be attached; use ${[...IMAGE_TYPES.keys()].join(', ')}`)
    }
    if (typeof image.data !== 'string' || !image.data) throw new Error('The attachment had no data')
    const bytes = Buffer.from(image.data, 'base64')
    if (!bytes.byteLength) throw new Error('The attachment decoded to nothing')
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new Error(`The attachment is ${bytes.byteLength} bytes, over the ${MAX_UPLOAD_BYTES}-byte limit`)
    }
    if (!uploadDirectory) uploadDirectory = mkdtempSync(join(tmpdir(), 'run-console-'))
    // Keep the person's filename for readability, but build the path ourselves so
    // nothing from the page decides where a file is written. The stem allows no
    // dots or separators, so it stays one path segment and reads cleanly: the
    // extension comes from the mime type we already validated.
    const original = typeof image.name === 'string' ? image.name : 'attachment'
    const stem = (original.replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48)) || 'attachment'
    const path = join(uploadDirectory, `${Date.now()}-${stem}${suffix}`)
    writeFileSync(path, bytes)
    onLog(`attachment saved: ${path} (${bytes.byteLength} bytes)`)
    return { name: original, mimeType, bytes: bytes.byteLength, path, at: new Date().toISOString() }
  }

  const json = (response: ServerResponse, body: unknown, status = 200): void => {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(body))
  }
  const html = (response: ServerResponse, body: string): void => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(body)
  }
  const readBody = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  }

  /**
   * Everything the page is allowed to do.
   *
   * It may read the run and add a turn to it. It may not report progress, attach
   * a screenshot, or speak as the agent: those come from the agent through the
   * session, so a page cannot invent any of them. `runId` is pinned to the
   * current conversation rather than taken from the request, so the page cannot
   * read or write some other run either.
   */
  async function callForPage(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    if (name === 'run_say') {
      const text = typeof args.text === 'string' ? args.text.trim() : ''
      const image = args.image as Record<string, unknown> | undefined
      // An attachment on its own is a message: "look at this" needs no sentence.
      if (!text && !image) return { isError: true, content: [{ type: 'text', text: 'A message needs text' }] }
      let attachment: RunAttachment | undefined
      if (image) {
        try {
          attachment = saveUpload(image)
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
        }
      }
      const said = attachment && !text ? `Attached ${attachment.name}` : text
      let result: ToolResult
      // The first message opens the conversation, so the run's prompt is the
      // person's own words rather than a placeholder written by this host.
      if (!currentRunId) {
        result = await client.callTool('run_start', { prompt: said }) as ToolResult
        if (!result.isError) currentRunId = String(value(result).runId ?? '')
        onLog(`run ${currentRunId} opened: ${said.slice(0, 72)}`)
      } else {
        onLog(`ask: ${said.slice(0, 72)}`)
        result = await client.callTool('run_say', { runId: currentRunId, text: said, role: 'user' }) as ToolResult
      }
      // Attach after the turn exists, so an image can ride along with the very
      // first sentence instead of dangling off an empty second turn.
      if (attachment && currentRunId && !result.isError) {
        store.attach(currentRunId, attachment)
        return client.callTool('run_console', { runId: currentRunId }) as Promise<ToolResult>
      }
      return result
    }
    if (name === 'run_console') {
      if (!currentRunId) return { content: [{ type: 'text', text: '{}' }] }
      return client.callTool('run_console', { runId: currentRunId }) as Promise<ToolResult>
    }
    return { isError: true, content: [{ type: 'text', text: `${name} may not be called from the app` }] }
  }

  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = (request.url ?? '/').split('?')[0]
        if (url === '/mcp') {
          if (!validateHost(request, response) || !validateOrigin(request, response)) return
          await handleMcp(request, response)
          return
        }
        if (url === '/') return html(response, HOST_HTML)
        if (url === '/app') return html(response, app)
        if (url === '/run-id') {
          response.writeHead(200, { 'Content-Type': 'text/plain' })
          return response.end(currentRunId)
        }
        // The page renders attachments as ordinary images, so it fetches the file
        // rather than carrying base64 through the run payload.
        if (url.startsWith('/attachment/')) {
          if (!currentRunId) return void response.writeHead(404).end('No run')
          const attachments = store.attachments(currentRunId)
          const attachment = attachments[Number(url.slice('/attachment/'.length))]
          if (!attachment) return void response.writeHead(404).end('No such attachment')
          try {
            const bytes = readFileSync(attachment.path)
            response.writeHead(200, {
              'Content-Type': attachment.mimeType,
              'Content-Length': bytes.byteLength,
              'Cache-Control': 'no-store',
            })
            return void response.end(bytes)
          } catch {
            return void response.writeHead(410).end('Attachment no longer on disk')
          }
        }
        if (request.method === 'POST' && url === '/rpc') {
          const body = await readBody(request)
          const result = await callForPage(
            String(body.name ?? ''),
            (body.arguments ?? {}) as Record<string, unknown>,
          )
          return json(response, result, result.isError && body.name !== 'run_say' ? 403 : 200)
        }
        /**
         * Activity the driver observed: thinking, calls, results.
         *
         * Reported by the driver rather than the model because the driver already
         * sees every streamed token and every tool call, so the feed is complete
         * and costs nothing extra. A model asked to narrate its own tool use gives
         * a partial, flattering account. Written straight to the store: this is
         * observation, not something an agent should be able to shape.
         */
        if (request.method === 'POST' && url === '/driver/activity') {
          const body = await readBody(request)
          if (!currentRunId) return json(response, { recorded: 0 }, 409)
          const events = Array.isArray(body.events) ? body.events : []
          store.record(currentRunId, events as Parameters<RunStore['record']>[1])
          return json(response, { recorded: events.length })
        }
        // The agent driver reporting a turn that died before the agent could say
        // anything — a model error, a dropped connection. Without this the run
        // would simply stop updating and the person would be left watching a
        // spinner. This grants nothing new: /mcp already accepts run_progress
        // from anything that can reach this port.
        if (request.method === 'POST' && url === '/driver') {
          const body = await readBody(request)
          if (!currentRunId) return json(response, { isError: true, content: [{ type: 'text', text: 'No run yet' }] }, 409)
          return json(response, await client.callTool('run_progress', { ...body, runId: currentRunId }))
        }
        response.writeHead(404).end('Not found')
      } catch (error) {
        onLog(error instanceof Error ? error.message : String(error))
        if (!response.headersSent) json(response, { error: String(error) }, 500)
        else if (!response.writableEnded) response.end()
      }
    })()
  })

  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', () => resolve()))
  const address = server.address()
  const bound = typeof address === 'object' && address ? address.port : port
  const url = `http://127.0.0.1:${bound}/`
  if (demo) {
    void runScriptedDemo(client, id => { currentRunId = id }, onLog)
  }

  return {
    url,
    mcpUrl: `${url}mcp`,
    port: bound,
    store,
    runId: () => currentRunId,
    close: async () => {
      await client.close()
      await mcp.close()
      // Only tear down a session this host made; an injected one is the caller's.
      if (!injected) session.close?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/**
 * A scripted walkthrough, so the console can be seen working with no API key.
 *
 * This is **not** an agent: the steps and the words are written here. What is
 * real is everything it looks at — the display geometry, the window list and the
 * captured frame all come off this desktop through the MCP session, so the panel
 * on the right shows a picture of your actual screen. It exists because a console
 * with nothing in it teaches you nothing about whether the console works.
 *
 * For a real agent, run with `--no-demo` and point one at `/mcp`.
 */
async function runScriptedDemo(
  client: { callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown> },
  onRunId: (id: string) => void,
  onLog: (line: string) => void = () => {},
): Promise<void> {
  const call = (name: string, args?: Record<string, unknown>) =>
    client.callTool(name, args) as Promise<ToolResult>
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  try {
    const started = await call('run_start', {
      prompt: 'Show me you can see my desktop: check the display, find a window, and capture it.',
    })
    const runId = String(value(started).runId ?? '')
    onRunId(runId)
    await call('run_say', {
      runId,
      text: 'Heads up: this walkthrough is scripted, not a model — the words below are written into the host. '
        + 'Everything it looks at is real, though: the frame on the right is a live capture of this desktop. '
        + 'Restart with --no-demo and point an agent at /mcp to see one drive this for itself.',
    })

    await call('run_plan', {
      runId,
      tasks: [
        { id: 'display', title: 'Read the display geometry' },
        { id: 'find', title: 'Find a window to look at' },
        { id: 'capture', title: 'Capture what is on screen' },
        { id: 'front', title: 'Confirm which app is frontmost' },
      ],
    })

    const step = (taskId: string, narration: string) =>
      call('run_progress', { runId, taskId, status: 'active', narration })
    const finish = (taskId: string, note: string, extra: Record<string, unknown> = {}) =>
      call('run_progress', { runId, taskId, status: 'done', note, ...extra })

    await step('display', 'Reading the display geometry first, so image pixels can be mapped back to real coordinates.')
    await wait(1200)
    const display = value(await call('get_display_size'))
    await finish('display', `${display.width}×${display.height} at ${display.scaleFactor}x, ${display.pixelWidth}×${display.pixelHeight} physical`)

    await step('find', 'Listing the windows on screen and picking the largest one to look at.')
    await wait(1100)
    const windows = (value(await call('list_windows')).windows ?? []) as Array<{
      windowId: number
      displayName?: string
      bounds: { width: number; height: number }
    }>
    const biggest = windows
      .slice()
      .sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0]
    await finish('find', biggest
      ? `${biggest.displayName ?? 'a window'} · ${biggest.bounds.width}×${biggest.bounds.height}`
      : 'no windows reported — capturing the whole desktop instead')

    await step('capture', biggest
      ? 'Capturing that window through the session. This frame is a real screen capture.'
      : 'Capturing the whole desktop. This frame is a real screen capture.')
    await wait(1300)
    await finish('capture', 'frame captured', {
      capture: true,
      ...(biggest ? { window_id: biggest.windowId } : {}),
      caption: biggest
        ? `${biggest.displayName ?? 'A window'}, captured through the MCP session`
        : 'This desktop, captured through the MCP session',
    })

    await step('front', 'Checking which application has focus, since keystrokes follow focus.')
    await wait(1000)
    const front = (value(await call('get_frontmost_app')).app ?? {}) as {
      displayName?: string
      bundleId?: string
      pid?: number
    }
    await finish('front', front.displayName
      ? `${front.displayName} · ${front.bundleId} · pid ${front.pid}`
      : 'nothing reported focus')

    await call('run_progress', {
      runId,
      state: 'done',
      narration: 'That is the console working: a plan on the right, a real frame from your screen, '
        + 'and a transcript you can type into. Nothing here was an agent — run with --no-demo and '
        + 'connect one to /mcp to watch it plan and work for itself.',
    })
  } catch (error) {
    onLog(`demo stopped: ${error instanceof Error ? error.message : String(error)}`)
  }
}

if (isModuleEntrypoint(import.meta.url, process.argv[1])) {
  const flag = (name: string): number => process.argv.indexOf(name)
  const portFlag = flag('--port')
  const brandFlag = flag('--brand')
  const creditsFlag = flag('--credits')
  // Comma separated. A segment written `label=value` emphasises only the value,
  // which is how the default byline reads `running on DeepSeek Flash`.
  const credits = creditsFlag > -1
    ? process.argv[creditsFlag + 1].split(',').map(segment => {
        const [label, ...rest] = segment.trim().split('=')
        return rest.length ? { label, value: rest.join('=') } : segment.trim()
      })
    : undefined
  const host = await serve({
    port: portFlag > -1 ? Number(process.argv[portFlag + 1]) : 4517,
    // The scripted walkthrough is the default so the console shows something the
    // moment it opens. An agent driving it is the real thing; ask for --no-demo.
    demo: flag('--no-demo') === -1,
    // Name the agent in the header. The console is generic infrastructure, so a
    // host reading dashboards should not have to say `Blender Agent`.
    brand: brandFlag > -1 ? { name: process.argv[brandFlag + 1], credits } : undefined,
    onLog: line => console.error(`[console] ${line}`),
  })
  console.log(`Console  ${host.url}`)
  console.log(`MCP      ${host.mcpUrl}   ← point an agent here`)
  if (flag('--no-open') === -1) spawn('open', [host.url], { stdio: 'ignore', detached: true }).unref()
  console.log('Ctrl-C to stop.')
}
