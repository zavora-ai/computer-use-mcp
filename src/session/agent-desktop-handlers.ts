/**
 * v7.5 "agent desktop" tools: read_window_text, click_text (R2) and wait_for_window (R7).
 *
 * Unreal and Blender draw their own UI, so their accessibility trees are nearly empty
 * and an agent was left with screenshots and pixel guesses. read_window_text returns
 * the window's text with boxes from Apple's on-device Vision OCR — a few dozen tokens
 * instead of an image — and click_text clicks a piece of text by what it says.
 */

import type { NativeModule, WindowRecord } from '../native.js'
import { errJson, okJson, platformUnsupported, type ToolResult } from '../result.js'
import { StructuredToolError } from './errors.js'
import type { InputHandler } from './input-handlers.js'
import { HelperFailure, type HelperOcr, type MacosHelper } from './macos-helper.js'
import type { TargetStateController } from './target-state.js'
import { listClassifiedWindows, resolveAppWindow, titleMatches, type WindowKind } from './window-select.js'

export const AGENT_DESKTOP_TOOLS = new Set(['read_window_text', 'click_text', 'wait_for_window'])
export const WAIT_FOR_WINDOW_POLL_MS = 250

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
  /** Window points from the window's top-left. */
  box: { x: number; y: number; w: number; h: number }
  /** Screen points (the coordinate space of left_click). */
  screen: { x: number; y: number; w: number; h: number }
}

const round = (value: number) => Math.round(value)

/**
 * Map OCR boxes (image pixels) to window points and screen points. `scale` is image
 * pixels per window point; the window's screen origin comes from its bounds.
 */
export function mapOcrLines(ocr: HelperOcr, bounds: { x: number; y: number; width: number }): TextLine[] {
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
      screen: { x: round(bounds.x + x), y: round(bounds.y + y), w: round(w), h: round(h) },
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

/**
 * Find `query` in OCR lines, in reading order (top to bottom, then left to right).
 * For a match inside a longer line, the click point is estimated from the
 * character offsets: Vision gives one box per line, and text is close to
 * proportional across a line for this purpose.
 */
export function findText(lines: readonly TextLine[], query: string, mode: TextMatchMode): TextMatch[] {
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
    const left = line.screen.x + line.screen.w * (start / total)
    const width = line.screen.w * (Math.max(1, length) / total)
    matches.push({
      line,
      matched: line.text.slice(start, start + length),
      point: { x: round(left + width / 2), y: round(line.screen.y + line.screen.h / 2) },
    })
  }
  return matches.sort((a, b) => {
    const rowA = Math.round(a.line.screen.y / 8)
    const rowB = Math.round(b.line.screen.y / 8)
    return rowA !== rowB ? rowA - rowB : a.line.screen.x - b.line.screen.x
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

async function ocrWindow(
  tool: string,
  args: Record<string, unknown>,
  context: AgentDesktopContext,
): Promise<{ window: WindowRecord; lines: TextLine[]; ocrMs?: number } | ToolResult> {
  if ((context.platform ?? process.platform) !== 'darwin') {
    return platformUnsupported(tool, 'macOS (Vision OCR)',
      'Use screenshot or zoom and read the image, or get_ui_tree/find_element where the app exposes accessibility.')
  }
  if (!context.helper) {
    return errJson({ error: 'helper_unavailable', tool, remediation: ['The macOS agent helper is not configured for this session.'] })
  }
  const window = targetWindow(args, context)
  const region = Array.isArray(args.region) && args.region.length === 4
    ? { x: Number(args.region[0]), y: Number(args.region[1]), width: Number(args.region[2]), height: Number(args.region[3]) }
    : undefined
  const languages = Array.isArray(args.languages) ? (args.languages as unknown[]).filter((v): v is string => typeof v === 'string') : undefined
  let ocr: HelperOcr
  try {
    ocr = await context.helper.ocr({ windowId: window.windowId, region, languages, fast: args.fast === true }, context.signal)
  } catch (error) {
    if (error instanceof HelperFailure) {
      return errJson({
        error: error.code === 'helper_unavailable' ? 'helper_unavailable' : 'ocr_failed',
        code: error.code, message: error.message, tool,
        remediation: error.code === 'screen_recording_denied'
          ? ['Enable your agent host in System Settings > Privacy & Security > Screen & System Audio Recording, then restart it.']
          : error.code === 'sck_unavailable'
            ? ['Window OCR needs macOS 14 or later; use screenshot/zoom instead.']
            : ['Run doctor for the agent_helper check.'],
      })
    }
    throw error
  }
  const minConfidence = typeof args.min_confidence === 'number' ? args.min_confidence : 0
  const lines = mapOcrLines(ocr, window.bounds).filter(line => line.confidence >= minConfidence)
  return { window, lines, ...(ocr.ocrMs !== undefined ? { ocrMs: ocr.ocrMs } : {}) }
}

const windowSummary = (window: WindowRecord) => ({
  windowId: window.windowId, bundleId: window.bundleId, title: window.title, bounds: window.bounds,
})

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
    const matches = findText(result.lines, args.text, mode)
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
