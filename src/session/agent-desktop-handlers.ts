/**
 * v7.5 "agent desktop" tools: read_window_text, click_text (R2) and wait_for_window (R7).
 * v7.6 adds wait_for_text and wait_for_stable (R3): wait on what a window says or shows instead of
 * sleeping and taking screenshots.
 *
 * Unreal and Blender draw their own UI, so their accessibility trees are nearly empty
 * and an agent was left with screenshots and pixel guesses. read_window_text returns
 * the window's text with boxes from Apple's on-device Vision OCR — a few dozen tokens
 * instead of an image — and click_text clicks a piece of text by what it says.
 */

import { createHash } from 'node:crypto'
import type { NativeModule, WindowRecord } from '../native.js'
import { errJson, okJson, platformUnsupported, type ToolResult } from '../result.js'
import { StructuredToolError } from './errors.js'
import type { InputHandler } from './input-handlers.js'
import { HelperFailure, type HelperOcr, type MacosHelper } from './macos-helper.js'
import type { TargetStateController } from './target-state.js'
import { listClassifiedWindows, resolveAppWindow, titleMatches, type WindowKind } from './window-select.js'

export const AGENT_DESKTOP_TOOLS = new Set(['read_window_text', 'click_text', 'wait_for_window', 'wait_for_text', 'wait_for_stable'])
export const WAIT_FOR_WINDOW_POLL_MS = 250
export const WAIT_FOR_TEXT_POLL_MS = 500
export const WAIT_FOR_TEXT_MIN_POLL_MS = 200
export const WAIT_FOR_STABLE_POLL_MS = 250
export const WAIT_FOR_STABLE_MIN_POLL_MS = 50
export const WAIT_FOR_STABLE_QUIET_MS = 800
/** Pixel width of the captures wait_for_stable compares: cheap, and any visible change alters the bytes. */
export const WAIT_FOR_STABLE_CAPTURE_WIDTH = 800
export const WAIT_MAX_TIMEOUT_MS = 120_000

export interface AgentDesktopContext {
  native: NativeModule
  targets: TargetStateController
  helper?: MacosHelper
  input?: InputHandler
  platform?: NodeJS.Platform
  signal?: AbortSignal
  sleepAbortable(milliseconds: number, signal?: AbortSignal): Promise<boolean>
  now?: () => number
}

export interface TextLine {
  text: string
  confidence: number
  /**
   * Window points from the window's top-left. Screen points (the space of left_click)
   * are the window's `bounds` origin plus this box; results carry that as `screen_origin`.
   */
  box: { x: number; y: number; w: number; h: number }
}

const round = (value: number) => Math.round(value)

/**
 * Map OCR boxes (image pixels) to window points. `scale` is image pixels per window
 * point (derived from the window's width when the helper does not report it).
 */
export function mapOcrLines(ocr: HelperOcr, bounds: { width: number }): TextLine[] {
  const scale = ocr.scale && ocr.scale > 0 ? ocr.scale : ocr.width / Math.max(1, bounds.width)
  return ocr.lines.map(line => {
    const x = line.box.x / scale
    const y = line.box.y / scale
    const w = line.box.w / scale
    const h = line.box.h / scale
    return {
      text: line.text,
      confidence: Math.round(line.confidence * 100) / 100,
      box: { x: round(x), y: round(y), w: round(w), h: round(h) },
    }
  })
}

export type TextMatchMode = 'exact' | 'contains' | 'regex'

export interface TextMatch {
  line: TextLine
  matched: string
  /** Screen point at the centre of the matched text. */
  point: { x: number; y: number }
}

export interface ScreenOrigin { x: number; y: number }

/**
 * Find `query` in OCR lines, in reading order (top to bottom, then left to right).
 * For a match inside a longer line, the click point is estimated from the
 * character offsets: Vision gives one box per line, and text is close to
 * proportional across a line for this purpose. `origin` is the window's screen
 * origin; the returned point is in screen points.
 */
export function findText(
  lines: readonly TextLine[], query: string, mode: TextMatchMode, origin: ScreenOrigin = { x: 0, y: 0 },
): TextMatch[] {
  const matches: TextMatch[] = []
  const pattern = mode === 'regex' ? new RegExp(query, 'i') : undefined
  const needle = query.trim().toLowerCase()
  for (const line of lines) {
    let start = -1
    let length = 0
    if (mode === 'exact') {
      if (line.text.trim().toLowerCase() === needle) { start = line.text.indexOf(line.text.trim()); length = line.text.trim().length }
    } else if (mode === 'contains') {
      start = line.text.toLowerCase().indexOf(needle)
      length = needle.length
    } else {
      const found = pattern!.exec(line.text)
      if (found) { start = found.index; length = found[0].length }
    }
    if (start < 0) continue
    const total = Math.max(1, line.text.length)
    const left = origin.x + line.box.x + line.box.w * (start / total)
    const width = line.box.w * (Math.max(1, length) / total)
    matches.push({
      line,
      matched: line.text.slice(start, start + length),
      point: { x: round(left + width / 2), y: round(origin.y + line.box.y + line.box.h / 2) },
    })
  }
  return matches.sort((a, b) => {
    const rowA = Math.round(a.line.box.y / 8)
    const rowB = Math.round(b.line.box.y / 8)
    return rowA !== rowB ? rowA - rowB : a.line.box.x - b.line.box.x
  })
}

function targetWindow(args: Record<string, unknown>, context: AgentDesktopContext): WindowRecord {
  const native = context.native
  if (typeof args.target_window_id === 'number') {
    const window = native.getWindow(args.target_window_id)
    if (!window) throw new StructuredToolError('window not found', { error: 'window_not_found', target_window_id: args.target_window_id })
    return window
  }
  if (typeof args.target_app === 'string' && args.target_app) {
    const title = typeof args.target_title === 'string' && args.target_title ? args.target_title : undefined
    const window = resolveAppWindow(native, args.target_app, title)
    if (!window) {
      throw new StructuredToolError('no on-screen window', {
        error: 'window_not_found', target_app: args.target_app,
        remediation: ['The app has no on-screen window: open one, unhide the app, or wait_for_window first.'],
      })
    }
    return window
  }
  const remembered = context.targets.observationWindow()
  const window = remembered !== undefined ? native.getWindow(remembered) : null
  if (!window) {
    throw new StructuredToolError('target required', {
      error: 'target_required', remediation: ['Pass target_app (bundle ID) or target_window_id.'],
    })
  }
  return window
}

/** The platform and helper checks every tool that reads window pixels needs. */
function preflight(tool: string, context: AgentDesktopContext): ToolResult | undefined {
  if ((context.platform ?? process.platform) !== 'darwin') {
    return platformUnsupported(tool, 'macOS (Vision OCR / ScreenCaptureKit)',
      'Use screenshot or zoom and read the image, or get_ui_tree/find_element where the app exposes accessibility.')
  }
  if (!context.helper) {
    return errJson({ error: 'helper_unavailable', tool, remediation: ['The macOS agent helper is not configured for this session.'] })
  }
  return undefined
}

/** A helper failure as a structured result with the fix; anything else is rethrown. */
function helperFailureResult(tool: string, error: unknown): ToolResult {
  if (!(error instanceof HelperFailure)) throw error
  return errJson({
    error: error.code === 'helper_unavailable' ? 'helper_unavailable' : tool === 'wait_for_stable' ? 'capture_failed' : 'ocr_failed',
    code: error.code, message: error.message, tool,
    remediation: error.code === 'screen_recording_denied'
      ? ['Enable your agent host in System Settings > Privacy & Security > Screen & System Audio Recording, then restart it.']
      : error.code === 'sck_unavailable'
        ? ['Window capture needs macOS 14 or later; use screenshot/zoom instead.']
        : ['Run doctor for the agent_helper check.'],
  })
}

const regionArg = (args: Record<string, unknown>) =>
  Array.isArray(args.region) && args.region.length === 4
    ? { x: Number(args.region[0]), y: Number(args.region[1]), width: Number(args.region[2]), height: Number(args.region[3]) }
    : undefined

async function ocrWindow(
  tool: string,
  args: Record<string, unknown>,
  context: AgentDesktopContext,
): Promise<{ window: WindowRecord; lines: TextLine[]; ocrMs?: number } | ToolResult> {
  const blocked = preflight(tool, context)
  if (blocked) return blocked
  const window = targetWindow(args, context)
  const region = regionArg(args)
  const languages = Array.isArray(args.languages) ? (args.languages as unknown[]).filter((v): v is string => typeof v === 'string') : undefined
  let ocr: HelperOcr
  try {
    ocr = await context.helper!.ocr({ windowId: window.windowId, region, languages, fast: args.fast === true }, context.signal)
  } catch (error) {
    return helperFailureResult(tool, error)
  }
  const minConfidence = typeof args.min_confidence === 'number' ? args.min_confidence : 0
  const lines = mapOcrLines(ocr, window.bounds).filter(line => line.confidence >= minConfidence)
  return { window, lines, ...(ocr.ocrMs !== undefined ? { ocrMs: ocr.ocrMs } : {}) }
}

const windowSummary = (window: WindowRecord) => ({
  windowId: window.windowId, bundleId: window.bundleId, title: window.title, bounds: window.bounds,
})

/** Screen = this origin + a line's `box`. */
const screenOrigin = (window: WindowRecord): ScreenOrigin => ({ x: window.bounds.x, y: window.bounds.y })

const clampMs = (value: unknown, fallback: number, min: number, max: number) =>
  Math.min(max, Math.max(min, typeof value === 'number' && Number.isFinite(value) ? value : fallback))

/** Sleep out the rest of a poll interval; true when the wait was cancelled. */
async function pace(
  context: AgentDesktopContext, pollMs: number, pollStarted: number, waitedMs: number, timeoutMs: number,
): Promise<boolean> {
  const now = context.now ?? Date.now
  const remaining = Math.max(1, timeoutMs - waitedMs)
  const delay = Math.min(remaining, Math.max(0, pollMs - (now() - pollStarted)))
  if (delay <= 0) return context.signal?.aborted === true
  const cancelled = await context.sleepAbortable(delay, context.signal)
  return cancelled || context.signal?.aborted === true
}

async function waitForText(args: Record<string, unknown>, context: AgentDesktopContext): Promise<ToolResult> {
  if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('Invalid text: expected a non-empty string')
  const text = args.text
  const mode: TextMatchMode = args.match === 'exact' || args.match === 'regex' ? args.match : 'contains'
  if (mode === 'regex') {
    try { new RegExp(text) } catch (error) {
      return errJson({ error: 'invalid_regex', text, message: (error as Error).message })
    }
  }
  const gone = args.gone === true
  const timeoutMs = clampMs(args.timeout_ms, 10_000, 0, WAIT_MAX_TIMEOUT_MS)
  const pollMs = clampMs(args.poll_ms, WAIT_FOR_TEXT_POLL_MS, WAIT_FOR_TEXT_MIN_POLL_MS, WAIT_MAX_TIMEOUT_MS)
  const now = context.now ?? Date.now
  const started = now()
  let polls = 0
  let lastWindow: WindowRecord | undefined
  for (;;) {
    const pollStarted = now()
    polls++
    let result: Awaited<ReturnType<typeof ocrWindow>>
    try {
      result = await ocrWindow('wait_for_text', args, context)
    } catch (error) {
      // Waiting for the text to go: a window that is gone has no text either.
      if (gone && error instanceof StructuredToolError && error.details?.error === 'window_not_found') {
        return okJson({ gone: true, waitedMs: now() - started, polls, window: lastWindow ? windowSummary(lastWindow) : null, windowGone: true })
      }
      throw error
    }
    if ('content' in result) return result
    lastWindow = result.window
    const seen = result.lines.map(line => line.text)
    const matches = findText(result.lines, text, mode, screenOrigin(result.window))
    const waitedMs = now() - started
    if (!gone && matches.length > 0) {
      const first = matches[0]
      return okJson({
        found: true, waitedMs, polls,
        match: { text: first.line.text, matched: first.matched, confidence: first.line.confidence, box: first.line.box, screen: first.point },
        matches: matches.length,
        window: windowSummary(result.window),
        screen_origin: screenOrigin(result.window),
      })
    }
    if (gone && matches.length === 0) return okJson({ gone: true, waitedMs, polls, window: windowSummary(result.window) })
    if (waitedMs >= timeoutMs) {
      return errJson({
        error: 'timeout', waitedMs, polls, text, match: mode, gone,
        window: windowSummary(result.window),
        // What the last poll read, so the caller can see how the text was read instead.
        seen: seen.slice(0, 20), ...(seen.length > 20 ? { seenTruncated: seen.length - 20 } : {}),
      })
    }
    if (await pace(context, pollMs, pollStarted, waitedMs, timeoutMs)) return errJson({ error: 'cancelled', waitedMs: now() - started, polls })
  }
}

async function waitForStable(args: Record<string, unknown>, context: AgentDesktopContext): Promise<ToolResult> {
  const blocked = preflight('wait_for_stable', context)
  if (blocked) return blocked
  const helper = context.helper!
  const window = targetWindow(args, context)
  const region = regionArg(args)
  const timeoutMs = clampMs(args.timeout_ms, 10_000, 0, WAIT_MAX_TIMEOUT_MS)
  const quietMs = clampMs(args.quiet_ms, WAIT_FOR_STABLE_QUIET_MS, 0, WAIT_MAX_TIMEOUT_MS)
  const pollMs = clampMs(args.poll_ms, WAIT_FOR_STABLE_POLL_MS, WAIT_FOR_STABLE_MIN_POLL_MS, WAIT_MAX_TIMEOUT_MS)
  const now = context.now ?? Date.now
  const started = now()
  let polls = 0
  let changes = 0
  let lastHash: string | undefined
  let stableSince = started
  let regionApplied: boolean | undefined
  for (;;) {
    const pollStarted = now()
    polls++
    let hash: string
    try {
      const capture = await helper.capture({
        windowId: window.windowId, width: WAIT_FOR_STABLE_CAPTURE_WIDTH, format: 'jpeg', quality: 50, ...(region ? { region } : {}),
      }, context.signal)
      // The helper hashes the encoded image; hash the bytes ourselves if it did not say.
      hash = capture.hash || createHash('sha256').update(capture.data).digest('hex').slice(0, 16)
      if (region) regionApplied = capture.region !== undefined
    } catch (error) {
      if (context.signal?.aborted) return errJson({ error: 'cancelled', waitedMs: now() - started, polls, changes })
      return helperFailureResult('wait_for_stable', error)
    }
    const at = now()
    // Quiet time starts at the first capture (not at the call: the first capture can take seconds when the helper
    // compiles), and "stable" needs two captures to compare.
    if (lastHash === undefined) stableSince = at
    else if (hash !== lastHash) { changes++; stableSince = at }
    lastHash = hash
    const waitedMs = at - started
    const quietFor = at - stableSince
    const summary = {
      waitedMs, polls, hash, window: windowSummary(window),
      ...(region ? { region: [region.x, region.y, region.width, region.height], regionApplied: regionApplied === true } : {}),
    }
    // quiet_ms 0 means "one capture and its hash"; anything longer needs a second capture to compare.
    if ((polls >= 2 || quietMs === 0) && quietFor >= quietMs) return okJson({ stable: true, quietMs: quietFor, changes, ...summary })
    if (waitedMs >= timeoutMs) {
      return errJson({ error: 'timeout', changes, quietMs: quietFor, wantedQuietMs: quietMs, ...summary })
    }
    if (await pace(context, pollMs, pollStarted, waitedMs, timeoutMs)) {
      return errJson({ error: 'cancelled', waitedMs: now() - started, polls, changes })
    }
  }
}

export async function handleAgentDesktopTool(
  tool: string,
  args: Record<string, unknown>,
  context: AgentDesktopContext,
): Promise<ToolResult | undefined> {
  if (!AGENT_DESKTOP_TOOLS.has(tool)) return undefined

  if (tool === 'read_window_text') {
    const result = await ocrWindow(tool, args, context)
    if ('content' in result) return result
    return okJson({
      window: windowSummary(result.window),
      // screen = screen_origin + a line's box (the window's bounds origin).
      screen_origin: screenOrigin(result.window),
      count: result.lines.length,
      lines: result.lines,
      ...(result.ocrMs !== undefined ? { ocrMs: result.ocrMs } : {}),
    })
  }

  if (tool === 'click_text') {
    if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('Invalid text: expected a non-empty string')
    const mode: TextMatchMode = args.match === 'exact' || args.match === 'regex' ? args.match : 'contains'
    if (mode === 'regex') {
      try { new RegExp(args.text) } catch (error) {
        return errJson({ error: 'invalid_regex', text: args.text, message: (error as Error).message })
      }
    }
    if (!context.input) return errJson({ error: 'input_unavailable', tool })
    const result = await ocrWindow(tool, args, context)
    if ('content' in result) return result
    const matches = findText(result.lines, args.text, mode, screenOrigin(result.window))
    const nth = typeof args.nth === 'number' && args.nth >= 1 ? Math.floor(args.nth) : 1
    if (matches.length < nth) {
      return errJson({
        error: 'text_not_found', text: args.text, match: mode, nth, matches: matches.length,
        window: windowSummary(result.window),
        seen: result.lines.slice(0, 40).map(line => line.text),
        remediation: ['Check `seen` for how the text was read; try match "contains" or "regex", or read_window_text with a region.'],
      })
    }
    const chosen = matches[nth - 1]
    const button = args.button === 'right' ? 'right' : 'left'
    const count = typeof args.click_count === 'number' ? Math.min(3, Math.max(1, Math.floor(args.click_count))) : 1
    // Click the window the text was read from, whatever chose it.
    const clickArgs = { ...args, target_window_id: result.window.windowId }
    const clicked = await context.input.clickAt({ ...chosen.point, screen: true }, button, count, 'click_text', clickArgs)
    const message = clicked.content.find(part => part.type === 'text')
    return okJson({
      clicked: {
        text: chosen.line.text, matched: chosen.matched, confidence: chosen.line.confidence,
        screen: chosen.point, box: chosen.line.box,
      },
      matches: matches.length,
      window: windowSummary(result.window),
      result: message && message.type === 'text' ? message.text : 'Clicked',
    })
  }

  if (tool === 'wait_for_text') return waitForText(args, context)
  if (tool === 'wait_for_stable') return waitForStable(args, context)

  // wait_for_window
  if (typeof args.target_app !== 'string' || !args.target_app) throw new Error('Invalid target_app: expected a bundle ID or process name')
  const app = args.target_app
  const kind = typeof args.kind === 'string' ? args.kind as WindowKind : undefined
  const title = typeof args.title === 'string' && args.title ? args.title : undefined
  const gone = args.gone === true
  const timeoutMs = Math.min(120_000, Math.max(0, typeof args.timeout_ms === 'number' ? args.timeout_ms : 10_000))
  const now = context.now ?? Date.now
  const started = now()
  // AX subroles only change dialog/panel/document labels; skip the AX round trip otherwise.
  const useAx = kind === 'dialog' || kind === 'panel' || kind === 'document'
  let polls = 0
  for (;;) {
    polls++
    const windows = listClassifiedWindows(context.native, app, { ax: useAx })
    const match = windows.find(window => (!kind || window.kind === kind) && (!title || titleMatches(window, title)))
    const waitedMs = now() - started
    if (!gone && match) {
      return okJson({
        found: true, waitedMs, polls,
        window: { windowId: match.windowId, kind: match.kind, title: match.title, bounds: match.bounds, kindSource: match.kindSource },
      })
    }
    if (gone && !match) return okJson({ gone: true, waitedMs, polls })
    if (waitedMs >= timeoutMs) {
      return errJson({
        error: 'timeout', waitedMs, polls, target_app: app, kind: kind ?? null, title: title ?? null, gone,
        windows: windows.slice(0, 20).map(window => ({ windowId: window.windowId, kind: window.kind, title: window.title })),
      })
    }
    const cancelled = await context.sleepAbortable(Math.min(WAIT_FOR_WINDOW_POLL_MS, Math.max(1, timeoutMs - waitedMs)), context.signal)
    if (cancelled || context.signal?.aborted) return errJson({ error: 'cancelled', waitedMs: now() - started, polls })
  }
}
