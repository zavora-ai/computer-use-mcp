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

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
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

/**
 * An image a person attached to the conversation.
 *
 * Only metadata and a path live here: the bytes stay on disk. That keeps every
 * run payload small, lets the page fetch the file instead of carrying base64,
 * and — the reason it is a path rather than a blob — means Blender can load it
 * directly as a reference image or a texture without anything decoding it first.
 */
export interface RunAttachment {
  name: string
  mimeType: string
  bytes: number
  /** Absolute path the host wrote it to. Never supplied by a model. */
  path: string
  at: string
}

export interface RunMessage {
  /**
   * Stable, monotonic within a run.
   *
   * The original design asked an agent to detect unanswered work by checking whether
   * the last message was the person's. That is wrong, and measurably so: a
   * `run_progress` narration appends an agent message, so a question typed while the
   * agent was working stopped being last and became invisible. An id plus an
   * acknowledgement cursor cannot be erased by anything the agent says.
   */
  id: number
  role: MessageRole
  text: string
  at: string
  /** Set when the person attached an image to this turn. */
  attachment?: RunAttachment
}

/**
 * What an agent is doing, moment to moment.
 *
 * `thought` is the model reasoning aloud before it acts; `tool` is a call going
 * out; `result` is what came back. These are *observed by the host driver*, not
 * self-reported by the model: the driver already sees every streamed token and
 * every tool call, so the feed is complete and costs no extra model calls. Asking
 * a model to narrate its own tool use gets a partial, flattering account.
 */
export type ActivityKind = 'thought' | 'tool' | 'result'

export interface RunActivity {
  kind: ActivityKind
  /** Tool name, for `tool` and `result`. */
  name?: string
  /** The thought, or a short summary of the arguments or the reply. */
  detail: string
  /** Set when a result came back as an error. */
  failed?: boolean
  /** How long the call took, in milliseconds. */
  ms?: number
  at: string
}

/**
 * What a turn has cost so far.
 *
 * Reported by the host driving the run, because only it sees the model's usage
 * fields. Money is only ever shown when a price is configured: token counts are a
 * fact, and a rate hardcoded here would be wrong within a quarter.
 */
export interface RunUsage {
  /** Model calls made. */
  calls: number
  inputTokens: number
  outputTokens: number
  /** Prompt tokens served from cache, when the provider reports them. */
  cachedTokens: number
  /** Reasoning tokens, when the provider bills them separately. */
  reasoningTokens: number
  /** Currency amount, present only when the host was given a price. */
  cost?: number
  /** ISO 4217 code for `cost`, so a reader is never guessing. */
  currency?: string
}

export interface Run {
  runId: string
  prompt: string
  state: RunState
  tasks: RunTask[]
  /** Turn-by-turn transcript: the request, what the agent said, later asks. */
  messages: RunMessage[]
  /** What the agent is doing, as observed: thinking, calls, results. */
  activity: RunActivity[]
  narration: string
  screenshot?: RunShot
  /** What this run has spent. Absent until a host reports any. */
  usage?: RunUsage
  /**
   * The highest message id the agent has said it handled.
   *
   * Anything the person sent above this is still waiting, whatever the agent has
   * said since. Held separately from the transcript precisely so narration cannot
   * move it.
   */
  acknowledged?: number
  /**
   * Set when the person watching asked the agent to stop.
   *
   * Cooperative, and deliberately so. The page cannot terminate a model call in
   * flight, and pretending otherwise would leave a run that looks stopped while it
   * keeps spending. Instead this appears in every run tool's reply, so the agent
   * sees it on its next call and can stop cleanly, reporting what it has. A host
   * driver that watches for it can also abort its own stream, which is faster.
   */
  cancelRequested?: boolean
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
/**
 * Activity is far chattier than the transcript — a single turn can be dozens of
 * calls — so it is bounded separately and kept out of agent-facing replies.
 */
const MAX_ACTIVITY = 400

/** In-memory run store. Bounded, and oldest-first eviction keeps it that way. */
export class RunStore {
  readonly #runs = new Map<string, Run>()
  readonly #now: () => Date
  /**
   * Where runs are kept between restarts. Unset means memory only, which is the
   * default because a console that quietly starts writing to disk would be a
   * surprise, and most hosts are a single session.
   */
  readonly #path: string | undefined
  /** Why persistence is unavailable, if it is. Reported rather than hidden. */
  #unavailable: string | undefined
  /** Coalesces writes: a turn produces many mutations and one file is enough. */
  #pending: ReturnType<typeof setTimeout> | undefined

  constructor(
    now: () => Date = () => new Date(),
    options: { path?: string } = {},
  ) {
    this.#now = now
    this.#path = options.path ?? process.env.COMPUTER_USE_RUN_STORE ?? undefined
    if (this.#path) this.#load()
  }

  /**
   * The run most recently touched, if any.
   *
   * A restarted host needs this: the store can reload a run and still leave it
   * orphaned, because the host tracks which run is current in a variable that does
   * not survive the process. Reconnecting is what makes persistence useful rather
   * than merely true.
   */
  latest(): Run | undefined {
    let newest: Run | undefined
    for (const run of this.#runs.values()) {
      if (!newest || run.updatedAt > newest.updatedAt) newest = run
    }
    return newest
  }

  /** Why a restart would lose this run, if it would. */
  persistence(): { path?: string; problem?: string } {
    return {
      ...(this.#path ? { path: this.#path } : {}),
      ...(this.#unavailable ? { problem: this.#unavailable } : {}),
    }
  }

  #load(): void {
    if (!this.#path) return
    try {
      const text = readFileSync(this.#path, 'utf8')
      if (!text.trim()) return
      const runs = JSON.parse(text) as Run[]
      for (const run of runs) {
        if (typeof run?.runId === 'string') this.#runs.set(run.runId, run)
      }
    } catch (error) {
      const problem = error as NodeJS.ErrnoException
      // A missing file is the normal first start, not a fault.
      if (problem.code !== 'ENOENT') {
        this.#unavailable = `could not read ${this.#path}: ${problem.message}`
      }
    }
  }

  /**
   * Persist, soon.
   *
   * Coalesced because a single turn mutates the run dozens of times and writing on
   * each would spend more effort on the file than on the work. Frame bytes are left
   * out: a capture is hundreds of kilobytes of base64, they are worthless once the
   * screen has moved on, and writing them on every progress call would make the file
   * the most expensive thing in the run. A reloaded run therefore shows no frame
   * until the next capture, which is the honest outcome rather than a stale one.
   */
  #persist(): void {
    if (!this.#path || this.#pending) return
    this.#pending = setTimeout(() => {
      this.#pending = undefined
      if (!this.#path) return
      try {
        const runs = [...this.#runs.values()].map(run => {
          if (!run.screenshot) return run
          const { screenshot, ...rest } = run
          // Keep the caption and timing, drop the pixels.
          return { ...rest, screenshot: { ...screenshot, data: '' } }
        })
        const temporary = `${this.#path}.tmp`
        mkdirSync(dirname(this.#path), { recursive: true })
        writeFileSync(temporary, JSON.stringify(runs))
        renameSync(temporary, this.#path)
        this.#unavailable = undefined
      } catch (error) {
        // A console that cannot write its state is still a working console.
        this.#unavailable = `could not write ${this.#path}: ${(error as Error).message}`
      }
    }, 250)
    // Do not hold the process open for a state file.
    this.#pending.unref?.()
  }

  #stamp(): string {
    return this.#now().toISOString()
  }

  /** Append a turn, evicting the oldest once the transcript is full. */
  #say(run: Run, role: MessageRole, text: string, attachment?: RunAttachment): void {
    const id = (run.messages.at(-1)?.id ?? 0) + 1
    run.messages.push({ id, role, text, at: this.#stamp(), ...(attachment ? { attachment } : {}) })
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
      messages: [{ id: 1, role: 'user', text: prompt, at }],
      activity: [],
      narration: '', startedAt: at, updatedAt: at,
    }
    this.#runs.set(runId, run)
    this.#persist()
    return run
  }

  /**
   * Add a turn to the transcript.
   *
   * A `user` turn is how the person watching steers a run in flight: every tool
   * reply carries the whole transcript, so the agent sees it on its next call
   * without polling for it.
   */
  say(runId: string, role: MessageRole, text: string, attachment?: RunAttachment): Run {
    const run = this.get(runId)
    const trimmed = text.trim()
    if (!trimmed) throw new Error('A message needs text')
    // A new instruction from the person is a new turn, so a cancel they asked for
    // earlier is spent. Leaving it set would stop the very work they just asked for.
    if (role === 'user') delete run.cancelRequested
    this.#say(run, role, trimmed, attachment)
    run.updatedAt = this.#stamp()
    this.#persist()
    return run
  }

  /** Every image attached to this conversation, oldest first. */
  attachments(runId: string): RunAttachment[] {
    return this.get(runId).messages
      .map(message => message.attachment)
      .filter((attachment): attachment is RunAttachment => Boolean(attachment))
  }

  /**
   * Attach an image to the most recent turn.
   *
   * Separate from `say` so the opening request can carry one too: that message is
   * created by `start`, and a person who drags an image in with their first
   * sentence should not end up with it hanging off a second, empty turn.
   */
  attach(runId: string, attachment: RunAttachment): Run {
    const run = this.get(runId)
    const last = run.messages[run.messages.length - 1]
    if (!last) throw new Error('There is no turn to attach to')
    last.attachment = attachment
    run.updatedAt = this.#stamp()
    this.#persist()
    return run
  }

  /**
   * Append observed activity.
   *
   * Takes a batch because a driver watching a stream produces several events at
   * once, and one call per event would be a lot of traffic for a live view.
   */
  /**
   * Add what a model call cost. Cumulative, because a turn is many calls.
   *
   * Only the host driving the run can know this: the usage fields come back with
   * the model response, and nothing inside an MCP server sees them. A price is
   * applied here rather than in the page so the arithmetic is done once.
   */
  spend(runId: string, delta: {
    calls?: number
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    reasoningTokens?: number
    inputPricePerMillion?: number
    outputPricePerMillion?: number
    currency?: string
  }): Run {
    const run = this.get(runId)
    const usage: RunUsage = run.usage ?? {
      calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0,
    }
    const add = (value: number | undefined): number =>
      typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
    usage.calls += add(delta.calls ?? 1)
    usage.inputTokens += add(delta.inputTokens)
    usage.outputTokens += add(delta.outputTokens)
    usage.cachedTokens += add(delta.cachedTokens)
    usage.reasoningTokens += add(delta.reasoningTokens)
    // Money only when a rate was supplied. A rate baked in here would be stale
    // within a quarter, and a wrong cost is worse than no cost.
    const inputRate = delta.inputPricePerMillion
    const outputRate = delta.outputPricePerMillion
    if (typeof inputRate === 'number' || typeof outputRate === 'number') {
      const cost = (usage.inputTokens / 1e6) * (inputRate ?? 0)
        + ((usage.outputTokens + usage.reasoningTokens) / 1e6) * (outputRate ?? 0)
      usage.cost = Math.round(cost * 1e6) / 1e6
      if (delta.currency) usage.currency = delta.currency
    }
    run.usage = usage
    run.updatedAt = this.#stamp()
    this.#persist()
    return run
  }

  /**
   * Mark messages up to `throughId` as handled.
   *
   * Explicit, because the alternative was inferring it from the transcript and that
   * inference lost messages. An agent that answers a mid-run question says so; until
   * it does, the question stays in `pending`.
   */
  acknowledge(runId: string, throughId?: number): Run {
    const run = this.get(runId)
    const highest = run.messages.at(-1)?.id ?? 0
    const target = typeof throughId === 'number' && Number.isFinite(throughId)
      ? Math.max(0, Math.trunc(throughId))
      : highest
    // Never move backwards: a stale acknowledgement must not resurrect handled work.
    run.acknowledged = Math.max(run.acknowledged ?? 0, Math.min(target, highest))
    run.updatedAt = this.#stamp()
    this.#persist()
    return run
  }

  /**
   * Messages from the person that have not been acknowledged.
   *
   * The opening prompt is excluded: it is the run's own subject, and reporting it as
   * unanswered work would make every run start with a false pending item.
   */
  pending(runId: string): RunMessage[] {
    const run = this.get(runId)
    const cursor = run.acknowledged ?? 1
    return run.messages.filter(message => message.role === 'user' && message.id > cursor)
  }

  /**
   * Record that the person watching asked the agent to stop.
   *
   * This does not stop anything by itself, and the naming is deliberate. A model
   * call already in flight cannot be recalled from a browser page, so the honest
   * design is a flag the agent reads on its next call. A run that claimed to be
   * cancelled while still spending would be worse than one that takes a few
   * seconds to notice.
   */
  requestCancel(runId: string): Run {
    const run = this.get(runId)
    run.cancelRequested = true
    run.updatedAt = this.#stamp()
    this.#persist()
    return run
  }

  record(runId: string, events: Array<Omit<RunActivity, 'at'> & { at?: string }>): Run {
    const run = this.get(runId)
    for (const event of events) {
      const detail = event.detail.trim()
      if (!detail && !event.name) continue
      run.activity.push({
        kind: event.kind,
        ...(event.name ? { name: event.name } : {}),
        detail: detail.slice(0, 2000),
        ...(event.failed ? { failed: true } : {}),
        ...(typeof event.ms === 'number' && Number.isFinite(event.ms) ? { ms: Math.max(0, Math.round(event.ms)) } : {}),
        at: event.at ?? this.#stamp(),
      })
    }
    // Oldest-first eviction: a live view cares about now, and the transcript
    // still holds the narrated account of what happened earlier.
    if (run.activity.length > MAX_ACTIVITY) run.activity.splice(0, run.activity.length - MAX_ACTIVITY)
    run.updatedAt = this.#stamp()
    this.#persist()
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
    this.#persist()
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
    this.#persist()
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
 * The run as an agent should see it.
 *
 * Two things are held back. The screenshot's base64 is replaced by its size,
 * because a model cannot read base64 inside a JSON string and repeating ~100 KB
 * on every call is pure waste. The activity log is dropped outright: it is a
 * record of what this agent just did, so returning it is both large and circular.
 * Both exist for the person watching, and `run_console` still carries them.
 */
/**
 * What an agent sees. Activity is elided, frame bytes are described, and unanswered
 * messages are stated rather than left to be inferred.
 *
 * `pending` is computed here so it appears in *every* reply. The failure it replaces
 * was an agent inferring unanswered work from "the last message is the person's",
 * which its own narration then falsified.
 */
function forAgent(run: Run): Omit<Run, 'activity'> & { pending: RunMessage[] } {
  const { activity: _activity, ...rest } = run
  const cursor = run.acknowledged ?? 1
  const pending = run.messages.filter(message => message.role === 'user' && message.id > cursor)
  const base = { ...rest, pending }
  return base.screenshot
    ? { ...base, screenshot: { ...base.screenshot, data: describe(base.screenshot.data) } }
    : base
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
   *
   * The activity log is dropped for the same reason and a stronger one: it is a
   * record of what this agent just did, so feeding it back is both large and
   * circular. It exists for the person watching.
   */
  const reply = (run: Run): ToolReply => {
    const described = forAgent(run)
    return {
      content: [{ type: 'text', text: JSON.stringify(described) }],
      structuredContent: described as unknown as Record<string, unknown>,
    }
  }
  /** The full run, frame and activity included. For the console UI. */
  /**
   * The whole run, frame bytes included. This is what the page renders and what a
   * polling host reads, so it carries `pending` for the same reason every other
   * reply does: unanswered work must be stated, never inferred from the transcript.
   */
  const replyInFull = (run: Run): ToolReply => {
    const cursor = run.acknowledged ?? 1
    const pending = run.messages.filter(message => message.role === 'user' && message.id > cursor)
    const full = { ...run, pending }
    return {
      content: [{ type: 'text', text: JSON.stringify(full) }],
      structuredContent: full as unknown as Record<string, unknown>,
    }
  }
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
    const described = forAgent(run)
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
      acknowledge: z.number().int().min(0).optional().describe('Highest pending message id this answers. Pass it when replying to something the person typed mid-run, so it stops being reported as unanswered.'),
    },
  }, args => {
    const run = store.say(args.runId, args.role, args.text)
    return reply(args.acknowledge === undefined ? run : store.acknowledge(args.runId, args.acknowledge))
  })

  define('run_spend', {
    description: 'Report what a model call cost, so the person watching can see the run\'s price as it accrues. For the host driving the run, which is the only thing that sees the model\'s usage fields — an agent should not call this about itself. Cumulative: send each call\'s usage and the console adds it up. Money appears only when a price per million tokens is supplied.',
    inputSchema: {
      runId,
      calls: z.number().int().min(0).max(1000).optional().default(1).describe('Model calls this covers'),
      input_tokens: z.number().int().min(0).optional().describe('Prompt tokens'),
      output_tokens: z.number().int().min(0).optional().describe('Completion tokens'),
      cached_tokens: z.number().int().min(0).optional().describe('Prompt tokens served from cache'),
      reasoning_tokens: z.number().int().min(0).optional().describe('Reasoning tokens, where billed separately'),
      input_price_per_million: z.number().min(0).optional().describe('Rate for prompt tokens; omit to show tokens only'),
      output_price_per_million: z.number().min(0).optional().describe('Rate for completion and reasoning tokens'),
      currency: z.string().min(3).max(3).optional().describe('ISO 4217 code for the cost figure'),
    },
  }, args => reply(store.spend(args.runId, {
    calls: args.calls,
    inputTokens: args.input_tokens,
    outputTokens: args.output_tokens,
    cachedTokens: args.cached_tokens,
    reasoningTokens: args.reasoning_tokens,
    inputPricePerMillion: args.input_price_per_million,
    outputPricePerMillion: args.output_price_per_million,
    currency: args.currency,
  })))

  define('run_cancel', {
    description: 'Record that the person watching asked the agent to stop. Cooperative: it does not terminate anything, because a model call in flight cannot be recalled. The flag appears in every run tool reply, so an agent that sees cancel_requested should stop where it is, report what it already has with run_progress, and set state "done" or "failed" rather than carrying on.',
    inputSchema: { runId },
  }, args => reply(store.requestCancel(args.runId)))

  define('run_attachment', {
    description: 'Look at an image the person attached to the conversation. Returns the picture itself, plus the path it is saved at on this machine — pass that path to an application when you need it to load the file, for example as a reference image or a texture. Omit index for the most recent attachment.',
    inputSchema: {
      runId,
      index: z.number().int().nonnegative().optional().describe('Which attachment, oldest first from 0. Omit for the latest.'),
    },
  }, args => {
    const attachments = store.attachments(args.runId)
    if (!attachments.length) throw new Error('Nothing has been attached to this conversation')
    const position = args.index ?? attachments.length - 1
    const attachment = attachments[position]
    if (!attachment) {
      throw new Error(`No attachment at index ${position}; this conversation has ${attachments.length}`)
    }
    // The path was recorded by the host when the person uploaded the file. A model
    // only ever supplies an index, so there is no path for it to point anywhere.
    let data: string
    try {
      data = readFileSync(attachment.path).toString('base64')
    } catch (error) {
      throw new Error(`Attachment ${attachment.name} is no longer readable at ${attachment.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ...attachment, index: position, of: attachments.length }) },
        { type: 'image', data, mimeType: attachment.mimeType },
      ],
      structuredContent: { ...attachment, index: position, of: attachments.length },
    }
  })

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
