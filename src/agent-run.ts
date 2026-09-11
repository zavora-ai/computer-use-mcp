/**
 * Agent run tracking, surfaced through the run console MCP App.
 *
 * An agent declares a plan, then reports progress against it. The host renders
 * that plan live, so a person watching sees which task is active, what the agent
 * says it is doing, and the last screenshot it looked at — instead of a wall of
 * tool calls.
 *
 * Screenshots are captured server-side from the session rather than accepted as
 * arguments. That keeps request payloads small and means the image on screen is
 * one the desktop actually produced, not one the model described.
 */

import { z, type ZodIssue, type ZodTypeAny } from 'zod'
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { RUN_CONSOLE_HTML } from './run-console.js'

export const RUN_CONSOLE_URI = 'ui://computer-use/run-console/v1'

export type TaskStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped'
export type RunState = 'planning' | 'working' | 'done' | 'failed'

export interface RunTask {
  id: string
  title: string
  status: TaskStatus
  note?: string
  /** ISO time of the last change to this task. */
  at: string
}

export interface RunShot {
  data: string
  mimeType: string
  caption?: string
  at: string
}

export type MessageRole = 'user' | 'agent'

export interface RunMessage {
  role: MessageRole
  text: string
  at: string
}

export interface Run {
  runId: string
  prompt: string
  state: RunState
  tasks: RunTask[]
  /** Turn-by-turn transcript: the request, what the agent said, later asks. */
  messages: RunMessage[]
  narration: string
  screenshot?: RunShot
  startedAt: string
  updatedAt: string
}

/** What a run tool returns: MCP tool-result shape, narrowed to what we emit. */
interface ToolReply {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }
  >
  structuredContent?: Record<string, unknown>
  isError?: boolean
  /** MCP results are open for extension, and the SDK's Result type says so. */
  [key: string]: unknown
}

/** Captures a screenshot for the console. Returns base64 plus its mime type. */
export type RunCapture = (windowId?: number) => Promise<{ data: string; mimeType: string } | null>

const MAX_RUNS = 32
const MAX_TASKS = 40
/** A console image only has to be legible in a panel, so cap what we retain. */
const MAX_SHOT_BYTES = 3 * 1024 * 1024
/** Enough transcript to follow a long run, bounded so a loop cannot grow it forever. */
const MAX_MESSAGES = 200

/** In-memory run store. Bounded, and oldest-first eviction keeps it that way. */
export class RunStore {
  readonly #runs = new Map<string, Run>()
  readonly #now: () => Date

  constructor(now: () => Date = () => new Date()) {
    this.#now = now
  }

  #stamp(): string {
    return this.#now().toISOString()
  }

  /** Append a turn, evicting the oldest once the transcript is full. */
  #say(run: Run, role: MessageRole, text: string): void {
    run.messages.push({ role, text, at: this.#stamp() })
    // Keep the opening request, which is the run's context, and drop from just
    // after it — losing the prompt would make the transcript unreadable.
    while (run.messages.length > MAX_MESSAGES) run.messages.splice(1, 1)
  }

  start(prompt: string, runId: string): Run {
    if (this.#runs.size >= MAX_RUNS) {
      const oldest = this.#runs.keys().next().value
      if (oldest) this.#runs.delete(oldest)
    }
    const at = this.#stamp()
    const run: Run = {
      runId, prompt, state: 'planning', tasks: [],
      messages: [{ role: 'user', text: prompt, at }],
      narration: '', startedAt: at, updatedAt: at,
    }
    this.#runs.set(runId, run)
    return run
  }

  /**
   * Add a turn to the transcript.
   *
   * A `user` turn is how the person watching steers a run in flight: every tool
   * reply carries the whole transcript, so the agent sees it on its next call
   * without polling for it.
   */
  say(runId: string, role: MessageRole, text: string): Run {
    const run = this.get(runId)
    const trimmed = text.trim()
    if (!trimmed) throw new Error('A message needs text')
    this.#say(run, role, trimmed)
    run.updatedAt = this.#stamp()
    return run
  }

  get(runId: string): Run {
    const run = this.#runs.get(runId)
    if (!run) throw new Error(`Unknown runId: ${runId}`)
    return run
  }

  /**
   * Replace the plan. Statuses of tasks that keep their id are preserved, so an
   * agent can add or reword steps mid-run without losing what is already done.
   *
   * Except after the run finished: a plan declared once a run is done or failed
   * is the next thing the person asked for, not a revision of the last one, so
   * nothing is inherited. Without that, an agent reusing an id like `capture`
   * across two requests would show the second one's step as already complete.
   */
  plan(runId: string, tasks: Array<{ id: string; title: string }>): Run {
    const run = this.get(runId)
    if (tasks.length > MAX_TASKS) throw new Error(`A plan may hold at most ${MAX_TASKS} tasks`)
    const ids = new Set(tasks.map(task => task.id))
    if (ids.size !== tasks.length) throw new Error('Task ids must be unique')
    const fresh = run.state === 'done' || run.state === 'failed'
    const previous = fresh ? new Map<string, RunTask>() : new Map(run.tasks.map(task => [task.id, task]))
    run.tasks = tasks.map(task => {
      const existing = previous.get(task.id)
      return {
        id: task.id,
        title: task.title,
        status: existing?.status ?? 'pending',
        ...(existing?.note !== undefined ? { note: existing.note } : {}),
        at: existing?.at ?? this.#stamp(),
      }
    })
    if (run.state === 'planning' || fresh) run.state = 'working'
    run.updatedAt = this.#stamp()
    return run
  }

  progress(runId: string, update: {
    taskId?: string
    status?: TaskStatus
    note?: string
    narration?: string
    state?: RunState
    screenshot?: { data: string; mimeType: string; caption?: string }
  }): Run {
    const run = this.get(runId)
    if (update.taskId !== undefined) {
      const task = run.tasks.find(candidate => candidate.id === update.taskId)
      if (!task) throw new Error(`Unknown taskId: ${update.taskId}. Declare it with run_plan first.`)
      if (update.status) task.status = update.status
      if (update.note !== undefined) task.note = update.note
      task.at = this.#stamp()
      // Exactly one task is the active one; advancing implicitly clears the rest.
      if (update.status === 'active') {
        for (const other of run.tasks) {
          if (other.id !== task.id && other.status === 'active') other.status = 'pending'
        }
      }
    } else if (update.status) {
      throw new Error('status applies to a task; pass taskId, or use state for the run')
    }
    if (update.narration !== undefined) {
      run.narration = update.narration
      const trimmed = update.narration.trim()
      const last = run.messages[run.messages.length - 1]
      // Narration is what the agent is saying, so it belongs in the transcript.
      // Repeating the same line does not, or a polling agent would spam it.
      if (trimmed && !(last?.role === 'agent' && last.text === trimmed)) {
        this.#say(run, 'agent', trimmed)
      }
    }
    if (update.state) run.state = update.state
    if (update.screenshot) {
      const bytes = Math.floor(update.screenshot.data.length * 3 / 4)
      if (bytes > MAX_SHOT_BYTES) throw new Error(`Screenshot is ${bytes} bytes, over the ${MAX_SHOT_BYTES}-byte console limit`)
      run.screenshot = { ...update.screenshot, at: this.#stamp() }
    }
    run.updatedAt = this.#stamp()
    return run
  }

  /** Console payload. The image is included so the app can render it inline. */
  status(runId: string): Run {
    return structuredClone(this.get(runId))
  }
}

/** A short opaque run id. Not a secret, but not guessable enough to collide. */
export function newRunId(random: () => number = Math.random): string {
  return 'run_' + Array.from({ length: 16 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)]).join('')
}

/** A short stand-in for image bytes, so a reply says what it is not carrying. */
function describe(data: string): string {
  return `<${Math.floor(data.length * 3 / 4)} bytes of image, not repeated here>`
}

/**
 * Register the run-tracking tools and the console UI resource.
 *
 * `capture` is optional: without it the tools still work and the console simply
 * shows no screenshot, which keeps this usable in a host with no desktop.
 */
export function registerRunConsole(
  server: McpServer,
  options: { store?: RunStore; capture?: RunCapture } = {},
): { store: RunStore; executors: Map<string, (args: unknown, ctx: ServerContext) => Promise<unknown>> } {
  const store = options.store ?? new RunStore()
  // The Tasks interceptor routes tools/call through a name → executor map, so a
  // tool registered straight onto the server is unreachable unless it is listed
  // here too. Collect each registration as we make it.
  const executors = new Map<string, (args: unknown, ctx: ServerContext) => Promise<unknown>>()
  const runId = z.string().min(4).max(128).describe('Run handle returned by run_start')

  /**
   * Reply for the agent's own calls.
   *
   * The frame is described rather than included. A run carries its last
   * screenshot, and that is ~100 KB of base64 an agent cannot read anyway, so
   * repeating it on every plan, progress and message reply would send the same
   * unusable pixels back dozens of times in a run. `run_console` is the one
   * caller that gets the bytes, because the page has to draw them.
   */
  const reply = (run: Run): ToolReply => {
    const described = run.screenshot
      ? { ...run, screenshot: { ...run.screenshot, data: describe(run.screenshot.data) } }
      : run
    return {
      content: [{ type: 'text', text: JSON.stringify(described) }],
      structuredContent: described as unknown as Record<string, unknown>,
    }
  }
  /** The full run, frame included. For the console UI, which renders it. */
  const replyInFull = (run: Run): ToolReply => ({
    content: [{ type: 'text', text: JSON.stringify(run) }],
    structuredContent: run as unknown as Record<string, unknown>,
  })
  /**
   * Reply to a capture, handing the frame back as an image.
   *
   * Without this, an agent that captures a frame for the console cannot see what
   * it just captured — base64 inside a JSON string is not something a model can
   * look at — so it would call `screenshot` as well and pay for the same pixels
   * twice. Attaching the image makes one call do both jobs, and the copy inside
   * the JSON is replaced by its size so the bytes are not sent twice over.
   */
  const replyWithFrame = (run: Run, shot: RunShot): ToolReply => {
    const described = { ...run, screenshot: { ...shot, data: describe(shot.data) } }
    return {
      content: [
        { type: 'text', text: JSON.stringify(described) },
        { type: 'image', data: shot.data, mimeType: shot.mimeType },
      ],
      structuredContent: described as unknown as Record<string, unknown>,
    }
  }
  const fail = (error: unknown): ToolReply => ({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: 'run_console_error', message: String(error instanceof Error ? error.message : error) }) }],
  })
  const malformed = (tool: string, issues: ZodIssue[]): ToolReply => ({
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({
      error: 'invalid_arguments',
      tool,
      issues: issues.map(issue => ({ path: issue.path.join('.') || '(root)', message: issue.message })),
      remediation: ['Correct the listed arguments against the tool input schema and call again.'],
    }) }],
  })

  /**
   * Register a tool, validating arguments against its own advertised schema.
   *
   * The catalog registration path applies schema defaults and turns malformed
   * input into a recoverable result. A tool registered straight onto the server
   * gets neither, so an advertised default would silently never reach its
   * handler. Do that here, once, instead of restating each default per handler.
   */
  const define = <Shape extends Record<string, ZodTypeAny>>(
    name: string,
    config: { description: string; inputSchema: Shape; _meta?: Record<string, unknown> },
    handler: (args: z.output<z.ZodObject<Shape>>) => ToolReply | Promise<ToolReply>,
  ): void => {
    const guard = async (args: unknown): Promise<ToolReply> => {
      const validated = z.object(config.inputSchema).passthrough().safeParse(args)
      if (!validated.success) return malformed(name, validated.error.issues)
      try {
        return await handler(validated.data as z.output<z.ZodObject<Shape>>)
      } catch (error) {
        return fail(error)
      }
    }
    // Register with the schema object rather than a raw shape: that overload
    // types its callback as (args: unknown), so the guard below is what actually
    // sees the arguments. The raw-shape overload's callback type is a deferred
    // conditional over the shape generic, which no concrete function satisfies.
    server.registerTool(name, { ...config, inputSchema: z.object(config.inputSchema) }, guard)
    executors.set(name, args => guard(args))
  }

  define('run_start', {
    description: 'Begin a tracked run so the person watching can see what you are doing. Pass the user\'s request verbatim. Returns a runId to use with run_plan and run_progress.',
    inputSchema: { prompt: z.string().min(1).max(8000).describe('The user request, as given') },
  }, args => reply(store.start(args.prompt, newRunId())))

  define('run_plan', {
    description: 'Declare or revise the plan for a run. Call this before working so the person can see the whole shape of the job. Re-calling it preserves the status of tasks that keep their id, so you may add or reword steps mid-run.',
    inputSchema: {
      runId,
      tasks: z.array(z.object({
        id: z.string().min(1).max(64).describe('Stable short id, e.g. "build-desk"'),
        title: z.string().min(1).max(200).describe('One line a person can read'),
      })).min(1).max(MAX_TASKS),
    },
  }, args => reply(store.plan(args.runId, args.tasks)))

  define('run_progress', {
    description: 'Report progress. Mark one task active before you start it and done when it is finished, say what you are doing in narration, and set capture to attach the screenshot the person should see. Capturing also returns that frame to you as an image, so this is how you look at the desktop and show it in one call. Call this as you go, not at the end.',
    inputSchema: {
      runId,
      taskId: z.string().max(64).optional().describe('Task this update is about'),
      status: z.enum(['pending', 'active', 'done', 'failed', 'skipped']).optional(),
      note: z.string().max(1000).optional().describe('Short detail shown under the task'),
      narration: z.string().max(2000).optional().describe('What you are doing right now, in plain language'),
      state: z.enum(['planning', 'working', 'done', 'failed']).optional().describe('Overall run state'),
      capture: z.boolean().default(false).describe('Attach a fresh screenshot to the console, and return it to you as an image'),
      window_id: z.number().int().nonnegative().optional().describe('Capture this window instead of the screen'),
      caption: z.string().max(200).optional().describe('Caption for the screenshot'),
    },
  }, async args => {
    let screenshot: { data: string; mimeType: string; caption?: string } | undefined
    if (args.capture && options.capture) {
      const shot = await options.capture(args.window_id)
      if (shot) {
        screenshot = { ...shot, ...(args.caption !== undefined ? { caption: args.caption } : {}) }
      }
    }
    const run = store.progress(args.runId, {
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.narration !== undefined ? { narration: args.narration } : {}),
      ...(args.state ? { state: args.state } : {}),
      ...(screenshot ? { screenshot } : {}),
    })
    // Only a fresh capture rides back as an image; a run carrying an older frame
    // should not re-send those bytes on every unrelated progress call.
    return screenshot && run.screenshot ? replyWithFrame(run, run.screenshot) : reply(run)
  })

  define('run_say', {
    description: 'Add a turn to the run transcript. Use it to speak to the person watching without changing task state. A turn with role "user" is a message from that person; every run tool reply carries the whole transcript, so read it and adjust rather than ignoring a mid-run instruction.',
    inputSchema: {
      runId,
      text: z.string().min(1).max(4000).describe('What is being said'),
      role: z.enum(['user', 'agent']).default('agent').describe('Who is speaking'),
    },
  }, args => reply(store.say(args.runId, args.role, args.text)))

  define('run_console', {
    description: 'Read the current state of a run: prompt, transcript, plan with task statuses, narration and latest screenshot. This is the complete text fallback for hosts that cannot render MCP Apps.',
    inputSchema: { runId },
    _meta: { ui: { resourceUri: RUN_CONSOLE_URI } },
  }, args => replyInFull(store.status(args.runId)))

  server.registerResource('run-console', RUN_CONSOLE_URI, { mimeType: 'text/html;profile=mcp-app' }, async uri => ({
    contents: [{
      uri: uri.href,
      mimeType: 'text/html;profile=mcp-app',
      text: RUN_CONSOLE_HTML,
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] }, prefersBorder: true } },
    }],
  }))

  return { store, executors }
}
