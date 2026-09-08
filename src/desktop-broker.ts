import { MUTATING_TOOLS } from './tool-catalog.js'
import type { TaskStore } from './task-store.js'
import { randomUUID } from 'node:crypto'
import type { Session } from './session.js'
import type { ToolResult } from './result.js'
import { compactAccessibilityTree, waitForElement } from './efficiency.js'
import { coordinateDesktop, DEFAULT_SESSION_LOCK_PATH } from './session/lock.js'

export type DesktopExecutor = ((name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>) & { preflight?: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult> }
export interface DesktopObservation {
  id: string; capturedAt: number; windowId: number
  geometry: { x: number; y: number; width: number; height: number; imageWidth?: number; imageHeight?: number }
  generation: string; nodes: Record<string, unknown>[]; truncated: boolean
}
interface DesktopRecord {
  id: string; owner: string; session: Session; touchedAt: number
  controller: AbortController; paused: boolean; revision: number
  observations: Map<string, DesktopObservation>
  operations: Map<string, { fingerprint: string; result: Record<string, unknown> }>
}
export interface DesktopBrokerOptions {
  createSession(): Session
  store?: TaskStore
  maxSessions?: number; idleMs?: number; observationTtlMs?: number; desktop?: string
  /** Rechecked for every broker operation. Owner must come from verified host identity. */
  authorize?: (owner: string, operation: string, sessionId?: string) => Promise<void> | void
}
function data(result: ToolResult): any {
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return JSON.parse(result.content.find(c => c.type === 'text')?.text ?? 'null')
}
function windowFrom(result: ToolResult, id: number) {
  const parsed = data(result)
  const selected = (Array.isArray(parsed) ? parsed : parsed?.windows ?? []).find((w: any) => w.windowId === id || w.window_id === id)
  if (!selected?.bounds) throw new Error('Window unavailable or capture geometry unsupported')
  const { x, y, width, height } = selected.bounds
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('Invalid capture geometry')
  return { geometry: { x, y, width, height }, generation: JSON.stringify([selected.windowId ?? selected.window_id, selected.pid, selected.bundleId, selected.displayId, x, y, width, height]) }
}

/** Explicit application state independent of MCP transport sessions. */
export class DesktopBroker {
  readonly #records = new Map<string, DesktopRecord>()
  readonly #timer: NodeJS.Timeout
  constructor(readonly options: DesktopBrokerOptions) {
    for (const value of [options.maxSessions ?? 32, options.idleMs ?? 900_000, options.observationTtlMs ?? 30_000]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Desktop limits must be positive integers')
    }
    for (const saved of options.store?.load() ?? []) {
      if (saved.kind !== 'desktop' || typeof saved.id !== 'string' || typeof saved.owner !== 'string') throw new Error('Invalid desktop checkpoint')
      if (this.#records.size >= (options.maxSessions ?? 32)) throw new Error('Desktop checkpoint limit exceeded')
      this.#records.set(saved.id, { id: saved.id, owner: saved.owner, session: options.createSession(), touchedAt: Date.now(),
        controller: new AbortController(), paused: true, revision: Number(saved.revision ?? 0) + 1,
        observations: new Map(), operations: new Map(saved.operations as [string, { fingerprint: string; result: Record<string, unknown> }][]) })
    }
    this.#timer = setInterval(() => this.#expire(), Math.min(options.idleMs ?? 900_000, 30_000))
    this.#timer.unref()
  }
  #persist(record: DesktopRecord) {
    this.options.store?.save(record.id.replace('desktop_', 'cut_'), { kind: 'desktop', id: record.id, owner: record.owner,
      revision: record.revision, operations: [...record.operations] })
  }
  #expire() {
    for (const [id, record] of this.#records) if (Date.now() - record.touchedAt >= (this.options.idleMs ?? 900_000)) {
      record.controller.abort(new Error('Desktop session expired')); record.session.close?.(); this.#records.delete(id); this.options.store?.delete(id.replace('desktop_', 'cut_'))
    }
  }
  #get(owner: string, id: string) {
    this.#expire()
    const record = this.#records.get(id)
    if (!record || record.owner !== owner) throw new Error('Desktop session unavailable')
    record.touchedAt = Date.now()
    return record
  }
  async open(owner: string) {
    await this.options.authorize?.(owner, 'open')
    this.#expire()
    if (this.#records.size >= (this.options.maxSessions ?? 32)) throw new Error('Desktop session limit reached')
    const id = 'desktop_' + randomUUID()
    this.#records.set(id, { id, owner, session: this.options.createSession(), touchedAt: Date.now(),
      controller: new AbortController(), paused: false, revision: 0, observations: new Map(), operations: new Map() })
    this.#persist(this.#records.get(id)!)
    return { sessionId: id, state: 'ready' }
  }
  async session(owner: string, id: string) {
    await this.options.authorize?.(owner, 'access', id)
    const record = this.#get(owner, id)
    return {
      dispatch: (tool, args, signal, progress, context) => {
        if (MUTATING_TOOLS.has(tool) && record.paused) return Promise.resolve({ isError: true, content: [{ type: 'text', text: 'Desktop session paused' }] })
        const combined = signal ? AbortSignal.any([signal, record.controller.signal]) : record.controller.signal
        return record.session.dispatch(tool, args, MUTATING_TOOLS.has(tool) ? combined : signal, progress, context)
      },
      preflight: record.session.preflight?.bind(record.session),
      retain: record.session.retain?.bind(record.session),
      getLastScreenshot: record.session.getLastScreenshot?.bind(record.session),
    } satisfies Session
  }
  async status(owner: string, id: string) {
    await this.options.authorize?.(owner, 'status', id)
    const r = this.#get(owner, id)
    return { sessionId: id, state: r.paused ? 'paused' : 'ready', revision: r.revision,
      observation: [...r.observations.values()].at(-1), lastOperation: [...r.operations.values()].at(-1)?.result }
  }
  /** Pause is safe for model access; resuming requires a trusted host path. */
  async pause(owner: string, id: string) {
    await this.options.authorize?.(owner, 'pause', id)
    const r = this.#get(owner, id)
    r.paused = true; r.revision++; r.observations.clear(); r.controller.abort(new Error('Human takeover')); this.#persist(r)
    return { sessionId: id, state: 'paused' }
  }
  async resume(owner: string, id: string) {
    await this.options.authorize?.(owner, 'resume', id)
    const r = this.#get(owner, id)
    r.controller = new AbortController(); r.paused = false; r.revision++; r.observations.clear(); this.#persist(r)
  }
  async dispose(owner: string, id: string) {
    await this.pause(owner, id)
    this.#get(owner, id).session.close?.(); this.#records.delete(id); this.options.store?.delete(id.replace('desktop_', 'cut_'))
  }
  /** Host-only broadcast after a physical input event or native emergency stop. */
  takeover() {
    for (const record of this.#records.values()) {
      record.paused = true; record.revision++; record.observations.clear()
      record.controller.abort(new Error('Physical takeover')); this.#persist(record)
    }
  }
  close() {
    clearInterval(this.#timer)
    for (const r of this.#records.values()) { r.controller.abort(new Error('Broker closed')); r.session.close?.() }
    this.#records.clear()
  }
  async observe(owner: string, id: string, windowId: number, execute: DesktopExecutor, screenshot = false) {
    await this.options.authorize?.(owner, 'observe', id)
    const r = this.#get(owner, id)
    const before = windowFrom(await execute('list_windows', {}), windowId)
    const tree = compactAccessibilityTree(data(await execute('get_ui_tree', { window_id: windowId })))
    const observation: DesktopObservation = { id: 'obs_' + randomUUID(), windowId, capturedAt: Date.now(),
      ...before, ...tree }
    observation.nodes = observation.nodes.map(node => ({ ...node, elementId: 'element_' + randomUUID() }))
    let image: ToolResult | undefined
    if (screenshot) {
      image = await execute('screenshot', { target_window_id: windowId })
      if (image.isError) throw new Error('Screenshot failed')
      const dimensions = image.content.filter(c => c.type === 'text').map(c => c.text).join(' ').match(/(\d+)x(\d+)/)
      if (!dimensions) throw new Error('Screenshot does not report dimensions')
      observation.geometry.imageWidth = Number(dimensions[1]); observation.geometry.imageHeight = Number(dimensions[2])
    }
    const after = windowFrom(await execute('list_windows', {}), windowId)
    if (before.generation !== after.generation) throw new Error('Window changed during observation; observe again')
    r.observations.set(observation.id, observation)
    while (r.observations.size > 16) r.observations.delete(r.observations.keys().next().value!)
    return { observation, ...(image ? { image } : {}) }
  }
  async workflow(owner: string, id: string, input: {
    operationId: string; windowId: number;
    steps: Array<{ role: string; label: string; expect: { role?: string; label: string; state: 'present' | 'absent' } }>
  }, execute: DesktopExecutor) {
    await this.options.authorize?.(owner, 'workflow', id)
    const r = this.#get(owner, id)
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(input.operationId) || !input.steps.length || input.steps.length > 20) throw new Error('Workflow requires 1..20 steps and a stable operation ID')
    const fingerprint = JSON.stringify(input)
    const old = r.operations.get(input.operationId)
    if (old) { if (old.fingerprint !== fingerprint) throw new Error('Workflow operation ID conflict'); return old.result }
    if (r.operations.size + input.steps.length >= 64) throw new Error('Operation journal full')
    const journal = { fingerprint, result: { status: 'unknown_outcome', completed: 0, steps: [] } as Record<string, any> }
    r.operations.set(input.operationId, journal); this.#persist(r)
    for (let index = 0; index < input.steps.length; index++) {
      const step = input.steps[index]
      try {
        if (r.paused) throw new Error('Session paused')
        const { observation } = await this.observe(owner, id, input.windowId, execute)
        const nodes = observation.nodes.filter(n => n.role === step.role && n.label === step.label)
        if (observation.truncated || nodes.length !== 1) throw new Error('Workflow control ambiguous or observation truncated')
        const acted = await this.act(owner, id, { operationId: input.operationId + '_' + index,
          observationId: observation.id, action: { type: 'invoke', elementId: String(nodes[0].elementId) } }, execute)
        journal.result.steps.push(acted)
        if (acted.status !== 'executed') { journal.result.status = acted.status; break }
        const verified = await waitForElement({ callTool: (name, args) => execute(name, args ?? {}, r.controller.signal) },
          { windowId: input.windowId, ...step.expect, signal: r.controller.signal, timeoutMs: 10000 })
        if (verified.isError) { journal.result.status = 'partial'; journal.result.evidence = verified; break }
        journal.result.completed = index + 1
        journal.result.status = index === input.steps.length - 1 ? 'verified' : 'partial'
      } catch (error) { journal.result.error = String(error); break }
      finally { this.#persist(r) }
    }
    return journal.result
  }

  async act(owner: string, id: string, input: {
    operationId: string; observationId: string
    action: { type: 'click'; x: number; y: number } | { type: 'invoke'; elementId: string }
    expect?: { role?: string; label: string; state: 'present' | 'absent' }
  }, execute: DesktopExecutor) {
    await this.options.authorize?.(owner, 'act', id)
    const r = this.#get(owner, id)
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(input.operationId)) throw new Error('operationId must be 8..128 safe characters')
    const operationSignal = r.controller.signal
    const fingerprint = JSON.stringify(input)
    const previous = r.operations.get(input.operationId)
    if (previous) { if (previous.fingerprint !== fingerprint) throw new Error('Operation ID reused with different arguments'); return previous.result }
    if (r.operations.size >= 64) throw new Error('Operation journal full; open a fresh session')
    return coordinateDesktop(this.options.desktop ?? DEFAULT_SESSION_LOCK_PATH, async () => {
      const repeated = r.operations.get(input.operationId)
      if (repeated) { if (repeated.fingerprint !== fingerprint) throw new Error('Operation ID conflict'); return repeated.result }
      if (r.paused) throw new Error('Session paused; trusted host must resume')
      const view = r.observations.get(input.observationId)
      if (!view || Date.now() - view.capturedAt > (this.options.observationTtlMs ?? 30_000)) throw new Error('Stale observation')
      const window = windowFrom(await execute('list_windows', {}, operationSignal), view.windowId)
      if (window.generation !== view.generation) throw new Error('Window geometry changed; observe again')
      let tool: string; let args: Record<string, unknown>
      if (input.action.type === 'click') {
        const { x, y } = input.action
        const g = view.geometry
        if (!g.imageWidth || !g.imageHeight || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= g.imageWidth || y >= g.imageHeight) throw new Error('Click requires in-bounds screenshot coordinates')
        tool = 'left_click'; args = { coordinate: [g.x + x * g.width / g.imageWidth, g.y + y * g.height / g.imageHeight], target_window_id: view.windowId, focus_strategy: 'strict' }
      } else {
        const elementId = input.action.elementId
        const node = view.nodes.find(n => n.elementId === elementId)
        if (!node?.label || !node.role || node.sensitive) throw new Error('Element unavailable')
        const matches = data(await execute('find_element', { window_id: view.windowId, role: node.role, label: node.label, max_results: 100 }, operationSignal))
        if (!Array.isArray(matches) || matches.length !== 1 || matches[0].label !== node.label || matches[0].role !== node.role) throw new Error('Element ambiguous or changed')
        tool = 'click_element'; args = { window_id: view.windowId, role: node.role, label: node.label }
      }
      const prepared = await execute.preflight?.(tool, args, operationSignal)
      if (prepared?.isError) throw new Error(JSON.stringify(prepared.content))
      const journal = { fingerprint, result: { status: 'unknown_outcome', operationId: input.operationId } as Record<string, unknown> }
      r.operations.set(input.operationId, journal)
      this.#persist(r)
      r.observations.clear(); r.revision++
      try {
        operationSignal.throwIfAborted()
        const result = await execute(tool, args, operationSignal)
        journal.result = { status: result.isError ? 'unknown_outcome' : 'executed', operationId: input.operationId, result }
        if (!result.isError && input.expect) {
          const matches = data(await execute('find_element', { window_id: view.windowId, label: input.expect.label, ...(input.expect.role ? { role: input.expect.role } : {}), max_results: 1 }, operationSignal))
          const verified = Array.isArray(matches) && ((input.expect.state === 'absent') === (matches.length === 0))
          journal.result.status = verified ? 'verified' : 'partial'
          journal.result.evidence = matches
        }
      } catch (error) { journal.result.error = String(error) }
      this.#persist(r)
      return journal.result
    }, operationSignal)
  }
}
