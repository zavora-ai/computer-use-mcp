/**
 * 8.0 (gaps review P2-11): record and replay. The session keeps the actions that worked, and export_steps turns them
 * into run_steps arguments with a check on each step, so a replay stops at the first step whose result differs instead
 * of carrying on blind.
 *
 * Each recorded action keeps the window it was aimed at (its title, kind and frame), the text under a click when the
 * recording was checked (export_steps start), and what it did: the window changed, or a window opened. The export
 * turns those into `expect` conditions, coordinates into the first step's window frame, and a click on a word into
 * click_text, so a replay finds the word again even when the layout has moved.
 */
import type { Effect } from './contract.js'
import { findText, type TextLine } from './agent-desktop-handlers.js'

/** How many actions the session keeps (oldest dropped first). */
export const JOURNAL_MAX = 300
/** run_steps takes at most this many steps; a longer export is split into several batches. */
export const BATCH_MAX = 30
/** What a redacted value is replaced with. run_steps refuses to send it, so it must be filled in before a replay. */
export const REDACTED = '<redacted: fill in before replaying>'

export interface JournalWindow {
  windowId: number
  bundleId?: string
  title?: string
  bounds: { x: number; y: number; width: number; height: number }
}

export interface JournalEntry {
  seq: number
  at: number
  tool: string
  /** The arguments as the caller sent them, without the one-off ones (verify, force, resend, approval_token). */
  args: Record<string, unknown>
  effect?: Effect
  /** The window the action was aimed at, read before it ran. */
  window?: JournalWindow
  /** Recorded while export_steps start was on: the target was captured before and after. */
  checked: boolean
  /**
   * The text under a click (OCR before it), as click_text would find it again. `region` ([x, y, w, h] window points) is
   * the band around the click that was read: a long line is split where the controls are, and the replay reads the same.
   */
  under?: { text: string; match: 'exact' | 'contains'; nth: number; region?: [number, number, number, number] }
  /** A window of the app that appeared after the action. */
  opened?: { kind?: string; title?: string }
  /** Typed into a field the accessibility tree marks sensitive (a password field). */
  sensitive?: boolean
  /** The step's own expect (a run_steps step whose check held): exported as written, not derived from the recording. */
  expect?: Record<string, unknown>
}

export type RecordInput = Omit<JournalEntry, 'seq' | 'at'>

const ONE_OFF_ARGS = new Set(['verify', 'force', 'resend', 'approval_token'])
const CLICKS = new Set(['click', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click'])
/** Step tools whose schema takes target_title (the others are aimed by app or window id only). */
const TITLE_TOOLS = new Set([...CLICKS, 'scroll', 'type', 'key', 'click_text', 'wait_for_text', 'wait_for_stable'])
/** Steps that check something themselves; they get no expect of their own. */
const WAITS = new Set(['wait', 'wait_for_window', 'wait_for_text', 'wait_for_stable'])
const SECRET_KEY = /token|password|passwd|secret|passphrase|api[_-]?key|credential|passcode|\bpin\b|\botp\b/i

export function cleanArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([key, value]) => !ONE_OFF_ARGS.has(key) && value !== undefined))
}

/**
 * The text under a click at window point (x, y), as click_text would find it again: the word under the point (or the
 * whole line), with the `nth` that picks this occurrence, when that match lands within a few points of the click.
 */
export function textUnder(lines: readonly TextLine[], x: number, y: number): JournalEntry['under'] | undefined {
  const line = lines.find(candidate => x >= candidate.box.x - 3 && x <= candidate.box.x + candidate.box.w + 3
    && y >= candidate.box.y - 3 && y <= candidate.box.y + candidate.box.h + 3)
  if (!line || line.text.trim().length === 0) return undefined
  const total = Math.max(1, line.text.length)
  const index = Math.min(total - 1, Math.max(0, Math.floor(((x - line.box.x) / Math.max(1, line.box.w)) * total)))
  const words = [...line.text.matchAll(/\S+/g)].map(found => ({ word: found[0], start: found.index ?? 0 }))
  const nearest = words.reduce<{ word: string; start: number } | undefined>((best, word) => {
    const distance = index < word.start ? word.start - index : Math.max(0, index - (word.start + word.word.length - 1))
    const bestDistance = best ? (index < best.start ? best.start - index : Math.max(0, index - (best.start + best.word.length - 1))) : Infinity
    return distance < bestDistance ? word : best
  }, undefined)
  const candidates: Array<{ text: string; match: 'exact' | 'contains' }> = []
  const word = nearest?.word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  if (word && word.length >= 2) candidates.push({ text: word, match: 'contains' })
  if (line.text.trim().length <= 40) candidates.push({ text: line.text.trim(), match: 'exact' })
  const tolerance = Math.max(8, line.box.h)
  for (const candidate of candidates) {
    const matches = findText(lines, candidate.text, candidate.match)
    const ranked = matches.map((match, position) => ({ position, distance: Math.hypot(match.point.x - x, match.point.y - y) }))
      .sort((a, b) => a.distance - b.distance)
    if (ranked[0] && ranked[0].distance <= tolerance) return { ...candidate, nth: ranked[0].position + 1 }
  }
  return undefined
}

/** The actions that worked, newest last, and whether a checked recording is on. */
export class StepJournal {
  #entries: JournalEntry[] = []
  #seq = 0
  #recordingSince: number | undefined
  readonly #max: number
  readonly #now: () => number

  constructor(options: { max?: number; now?: () => number } = {}) {
    this.#max = options.max ?? JOURNAL_MAX
    this.#now = options.now ?? Date.now
  }

  /** Whether actions are checked as they are recorded (export_steps start). */
  get recording(): boolean { return this.#recordingSince !== undefined }
  get lastSeq(): number { return this.#seq }

  start(): number { this.#recordingSince = this.#seq; return this.#seq }
  stop(): number | undefined { const since = this.#recordingSince; this.#recordingSince = undefined; return since }

  record(input: RecordInput): JournalEntry {
    const entry: JournalEntry = { ...input, seq: ++this.#seq, at: this.#now() }
    this.#entries.push(entry)
    if (this.#entries.length > this.#max) this.#entries.splice(0, this.#entries.length - this.#max)
    return entry
  }

  /** Entries after `since`, or the last `last`; by default those since the recording started, else the last 30. */
  select(options: { since?: number; last?: number } = {}): JournalEntry[] {
    if (typeof options.since === 'number') return this.#entries.filter(entry => entry.seq > options.since!)
    if (typeof options.last === 'number') return options.last <= 0 ? [] : this.#entries.slice(-options.last)
    if (this.#recordingSince !== undefined) return this.#entries.filter(entry => entry.seq > this.#recordingSince!)
    return this.#entries.slice(-BATCH_MAX)
  }

  /** Add to a kept entry: the expect its run_steps step carried and met. */
  annotate(seq: number, patch: Pick<JournalEntry, 'expect'>): void {
    const entry = this.#entries.find(candidate => candidate.seq === seq)
    if (entry) Object.assign(entry, patch)
  }

  /** The oldest sequence number still kept, to say when an export asked for more than the journal holds. */
  oldestSeq(): number | undefined { return this.#entries[0]?.seq }
}

export interface ExportedStep { tool: string; args: Record<string, unknown>; expect?: Record<string, unknown> }
export interface ExportedBatch { target_app?: string; frame?: [number, number, number, number]; steps: ExportedStep[] }

const shift = (value: unknown, dx: number, dy: number): unknown => {
  if (!Array.isArray(value)) return value
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    return [Math.round(value[0] + dx), Math.round(value[1] + dy), ...value.slice(2)]
  }
  return value.map(point => shift(point, dx, dy))
}

/** Replace secret-shaped values: arguments named like a secret, and text typed into a sensitive field. */
function redact(entry: JournalEntry, args: Record<string, unknown>): boolean {
  let redacted = false
  for (const key of Object.keys(args)) {
    if (SECRET_KEY.test(key)) { args[key] = REDACTED; redacted = true }
  }
  const label = typeof args.label === 'string' ? args.label : ''
  if ((entry.tool === 'type' && entry.sensitive) || (entry.tool === 'set_value' && (entry.sensitive || SECRET_KEY.test(label)))) {
    for (const key of ['text', 'value']) if (typeof args[key] === 'string') { args[key] = REDACTED; redacted = true }
  }
  if (entry.tool === 'fill_form' && Array.isArray(args.fields)) {
    args.fields = args.fields.map(field => {
      if (field && typeof field === 'object' && SECRET_KEY.test(String((field as Record<string, unknown>).label ?? ''))) {
        redacted = true
        return { ...(field as Record<string, unknown>), value: REDACTED }
      }
      return field
    })
  }
  return redacted
}

/**
 * Turn recorded actions into run_steps batches. The batch target is the app most steps were aimed at; `frame` is its
 * window's frame at the first step, and every coordinate aimed at that window is expressed in that frame (run_steps
 * moves them with the window on replay). A step aimed at another window of the app (a dialog) names it by title.
 */
export function exportSteps(entries: readonly JournalEntry[]): {
  batches: ExportedBatch[]; unchecked: number[]; redacted: number[]; converted: number[]
} {
  const apps = new Map<string, number>()
  for (const entry of entries) {
    const app = entry.window?.bundleId ?? (typeof entry.args.target_app === 'string' ? entry.args.target_app : undefined)
    if (app) apps.set(app, (apps.get(app) ?? 0) + 1)
  }
  const app = [...apps.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  const main = entries.find(entry => entry.window && entry.window.bundleId === app)?.window
  const frame: ExportedBatch['frame'] = main ? [main.bounds.x, main.bounds.y, main.bounds.width, main.bounds.height] : undefined
  const steps: ExportedStep[] = []
  const unchecked: number[] = []
  const redacted: number[] = []
  const converted: number[] = []
  entries.forEach((entry, index) => {
    let tool = entry.tool
    let args: Record<string, unknown> = cleanArgs(entry.args)
    delete args.target_window_id
    if (args.target_app === app) delete args.target_app
    const window = entry.window
    const sameWindow = Boolean(window && main && window.windowId === main.windowId)
    if (window && main && sameWindow && (window.bounds.x !== main.bounds.x || window.bounds.y !== main.bounds.y)) {
      // The window moved during the recording: keep every coordinate in the first frame.
      const dx = main.bounds.x - window.bounds.x
      const dy = main.bounds.y - window.bounds.y
      for (const key of ['coordinate', 'start_coordinate', 'path']) if (args[key] !== undefined) args[key] = shift(args[key], dx, dy)
    }
    if (window && !sameWindow && window.title) {
      if (window.bundleId && window.bundleId !== app) args.target_app = window.bundleId
      else if (app && !args.target_app) args.target_app = app
      if (TITLE_TOOLS.has(tool)) args.target_title = window.title
    }
    // A click on a word becomes click_text: on replay the word is found again wherever the layout put it.
    const button = tool === 'right_click' ? 'right' : tool === 'middle_click' ? 'middle' : (args.button ?? 'left')
    const count = tool === 'double_click' ? 2 : tool === 'triple_click' ? 3 : (args.count ?? 1)
    const plain = !args.modifiers && !args.hold_keys
    if (CLICKS.has(tool) && entry.under && plain && (button === 'left' || button === 'right')) {
      const next: Record<string, unknown> = { text: entry.under.text, match: entry.under.match }
      if (entry.under.nth > 1) next.nth = entry.under.nth
      if (entry.under.region) next.region = entry.under.region
      if (button === 'right') next.button = 'right'
      if (count !== 1) next.click_count = count
      for (const key of ['target_app', 'target_title', 'delivery', 'focus_strategy']) if (args[key] !== undefined) next[key] = args[key]
      tool = 'click_text'
      args = next
      converted.push(index)
    }
    if (redact(entry, args)) redacted.push(index)
    const step: ExportedStep = { tool, args }
    // A check someone wrote (and that held) says more than one derived from the recording: keep it.
    if (entry.expect) {
      step.expect = { ...entry.expect }
    } else if (!WAITS.has(entry.tool)) {
      if (entry.opened && (entry.opened.kind || entry.opened.title)) {
        step.expect = { window: { ...(entry.opened.kind ? { kind: entry.opened.kind } : {}), ...(entry.opened.title ? { title: entry.opened.title } : {}) } }
      } else if (entry.effect === 'changed' || entry.effect === 'verified') {
        // 8.0 (v8 plan, 18a): soft. The recording saw the window change, but a change can be about time rather than the
        // step (a hover tooltip that appeared while a model thought, then a key that dismissed it), and a replay runs at
        // machine speed. An unmet soft check is reported and the replay goes on; a window that opened stays a hard check.
        step.expect = { changed: true, soft: true }
      } else if (entry.tool !== 'write_clipboard' && entry.tool !== 'hold_key' && entry.tool !== 'mouse_move') {
        unchecked.push(index)
      }
    }
    steps.push(step)
  })
  const batches: ExportedBatch[] = []
  for (let start = 0; start < steps.length; start += BATCH_MAX) {
    batches.push({
      ...(app ? { target_app: app } : {}),
      ...(frame ? { frame } : {}),
      steps: steps.slice(start, start + BATCH_MAX),
    })
  }
  return { batches, unchecked, redacted, converted }
}

/** Whether a run_steps step still holds a redaction placeholder anywhere in its arguments. */
export function holdsRedaction(value: unknown): boolean {
  if (value === REDACTED) return true
  if (Array.isArray(value)) return value.some(holdsRedaction)
  if (value && typeof value === 'object') return Object.values(value).some(holdsRedaction)
  return false
}
