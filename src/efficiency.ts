/** Opt-in host helpers. The MCP wire contract and server authority stay unchanged. */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ComputerUseClient, ListedTool, ToolResult } from './client.js'
import { sanitizeAccessibilityResult } from './session/accessibility-handlers.js'

function integer(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`)
  }
  return value
}

const SEARCH_HINTS: Record<string, string> = {
  screenshot: 'see screen image capture visual',
  get_ui_tree: 'inspect observe accessibility controls semantic',
  find_element: 'locate search button field control semantic',
  fill_form: 'form fields bulk data entry',
  run_script: 'automate applescript jxa javascript powershell script',
  list_windows: 'discover windows applications',
  get_tool_guide: 'choose approach strategy recommend',
}

/** Cache schemas in the host, and expose only a relevant subset to the model. */
export function createToolDiscovery(
  client: Pick<ComputerUseClient, 'listTools'>,
  options: { ttlMs?: number; now?: () => number } = {},
) {
  const ttlMs = integer(options.ttlMs ?? 30_000, 0, 3_600_000, 'ttlMs')
  const now = options.now ?? Date.now
  let catalog: ListedTool[] | undefined
  let expiresAt = 0
  let pending: Promise<ListedTool[]> | undefined
  let generation = 0
  const get = async (): Promise<ListedTool[]> => {
    if (catalog && now() < expiresAt) return catalog
    if (pending) return pending
    const current = generation
    const request = client.listTools().then(tools => {
      // A list-changed invalidation during discovery must not repopulate stale state.
      if (generation === current) { catalog = tools; expiresAt = now() + ttlMs }
      return tools
    })
    pending = request
    try { return await request } finally { if (pending === request) pending = undefined }
  }
  return {
    /** Call when the host receives tools/list_changed or changes a profile. */
    invalidate() { generation++; catalog = undefined; expiresAt = 0; pending = undefined },
    async search(query: string, limit = 6): Promise<ListedTool[]> {
      integer(limit, 1, 8, 'limit')
      if (typeof query !== 'string' || query.length > 500) throw new Error('query must be at most 500 characters')
      const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
      if (words.length === 0) throw new Error('query must contain a tool name or search terms')
      const tools = await get()
      return tools.map(tool => {
        const name = tool.name.toLowerCase()
        const terms = new Set(`${name.replaceAll('_', ' ')} ${tool.description ?? ''} ${SEARCH_HINTS[name] ?? ''}`
          .toLowerCase().match(/[\p{L}\p{N}_]+/gu))
        const score = words.reduce((total, word) => total
          + (name === word ? 100 : name.includes(word) ? 8 : terms.has(word) ? 2 : 0), 0)
        return { tool, score }
      }).filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .slice(0, limit).map(({ tool }) => structuredClone(tool))
    },
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

export interface ModelContentOptions {
  /** Only IDs whose images are still in THIS model conversation's retained context. */
  knownImageIds?: readonly string[]
  /** Bind image reuse to a desktop/window/capture scope. Required to issue image IDs. */
  imageScope?: string
}

/** One model-visible representation, preserving images, links, extra diagnostics, and errors. */
export function toModelContent(result: ToolResult, options: ModelContentOptions = {}): ToolResult['content'] {
  const output: ToolResult['content'] = []
  if (result.isError) output.push({ type: 'text', text: '{"isError":true}' })
  let structured = result.structuredContent === undefined ? undefined : canonical(result.structuredContent)
  for (const block of result.content) {
    if (block.type === 'text' && structured !== undefined) {
      try {
        if (canonical(JSON.parse(block.text)) === structured) {
          // The existing text already carries the structured data: include it once.
          structured = undefined
        }
      } catch { /* Extra diagnostic text is not duplicated structured data. */ }
    }
    if (block.type === 'image' && options.imageScope) {
      const imageId = 'img_' + createHash('sha256')
        .update(JSON.stringify([options.imageScope, block.mimeType, block.data])).digest('hex')
      const unchanged = options.knownImageIds?.includes(imageId) === true
      output.push({ type: 'text', text: JSON.stringify({ imageId, unchanged, scope: options.imageScope }) })
      if (!unchanged) output.push({ ...block })
    } else output.push({ ...block })
  }
  if (structured !== undefined) output.unshift({ type: 'text', text: JSON.stringify(result.structuredContent) })
  return output
}

export interface CompactTreeOptions {
  maxNodes?: number
  maxChars?: number
  /** Case-insensitive role/label terms. All terms must match a node. */
  query?: string
}

/** A bounded read-only projection. Paths are observation locations, never durable action IDs. */
export function compactAccessibilityTree(tree: unknown, options: CompactTreeOptions = {}) {
  const maxNodes = integer(options.maxNodes ?? 80, 1, 500, 'maxNodes')
  const maxChars = integer(options.maxChars ?? 8_000, 256, 100_000, 'maxChars')
  const words = (options.query ?? '').toLowerCase().trim().split(/\s+/).filter(Boolean)
  const result: { nodes: Record<string, unknown>[]; truncated: boolean } = { nodes: [], truncated: false }
  const stack: Array<{ value: unknown; path: number[] }> = [{ value: tree, path: [] }]
  let visited = 0
  while (stack.length) {
    if (++visited > 10_000) { result.truncated = true; break }
    const { value, path } = stack.pop()!
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const original = value as Record<string, unknown>
    const children = Array.isArray(original.children) ? original.children : []
    // Sanitize each node without recursively copying the entire tree for every entry.
    const node = sanitizeAccessibilityResult({ ...original, children: undefined }) as Record<string, unknown>
    if (original.truncated) result.truncated = true
    for (let i = children.length - 1; i >= 0; i--) stack.push({ value: children[i], path: [...path, i] })
    const searchable = `${node.role ?? ''} ${node.label ?? ''}`.toLowerCase()
    if (!words.every(word => searchable.includes(word))) continue
    const compact: Record<string, unknown> = { path }
    for (const key of ['role', 'label', 'value', 'bounds', 'actions', 'sensitive', 'sensitivitySignals']) {
      const entry = node[key]
      if (entry !== undefined && entry !== null && entry !== '' && entry !== false
        && !(Array.isArray(entry) && entry.length === 0)) compact[key] = entry
    }
    if (node.sensitive) compact.value = null
    result.nodes.push(compact)
    // Reserve the longer false spelling so the bound holds in either state.
    if (result.nodes.length > maxNodes || JSON.stringify({ ...result, truncated: false }).length > maxChars) {
      result.nodes.pop()
      result.truncated = true
      // Continue to consider small later matches when one label exceeds the budget.
    }
  }
  return result
}

export interface WaitForElementOptions {
  windowId: number
  role?: string
  label?: string
  state?: 'present' | 'absent'
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
}

/** Wait in the host, without another LLM turn. Errors/denials are never treated as absence. */
export async function waitForElement(
  client: Pick<ComputerUseClient, 'callTool'>,
  options: WaitForElementOptions,
): Promise<ToolResult> {
  if (!options.role && !options.label) throw new Error('waitForElement requires role or label')
  integer(options.windowId, 0, Number.MAX_SAFE_INTEGER, 'windowId')
  if (options.state !== undefined && options.state !== 'present' && options.state !== 'absent') throw new Error('invalid wait state')
  const timeoutMs = integer(options.timeoutMs ?? 10_000, 1, 120_000, 'timeoutMs')
  const pollIntervalMs = integer(options.pollIntervalMs ?? 250, 1, 10_000, 'pollIntervalMs')
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal
  let polls = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const observed = await client.callTool('find_element', {
        window_id: options.windowId,
        ...(options.role ? { role: options.role } : {}),
        ...(options.label ? { label: options.label } : {}),
        max_results: 1,
      }, { signal, timeoutMs })
      polls++
      signal.throwIfAborted()
      if (observed.isError) return observed
      const text = observed.content.find(block => block.type === 'text')
      const matches: unknown = text?.type === 'text' ? JSON.parse(text.text) : undefined
      if (!Array.isArray(matches)) throw new Error('find_element returned an invalid observation')
      if ((options.state === 'absent') === (matches.length === 0)) {
        return { content: [{ type: 'text', text: JSON.stringify({
          matched: true, state: options.state ?? 'present', polls,
          elements: sanitizeAccessibilityResult(matches),
        }) }] }
      }
      await delay(pollIntervalMs, undefined, { signal })
    }
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason
    if (!deadline.signal.aborted) throw error
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({
      error: 'wait_timeout', state: options.state ?? 'present', timeoutMs, polls,
    }) }] }
  } finally { clearTimeout(timer) }
}
