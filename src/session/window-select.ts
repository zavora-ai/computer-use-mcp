/**
 * Window choice and window kinds (v7.5, requirement R1).
 *
 * Pure functions over the native window list so the scoring and the heuristics can
 * be tested on canned lists. The native list is front-to-back, layer 0, on screen.
 *
 * Choosing "the first layer-0 window of the app" — the old behaviour — returned a
 * 352x81 Unreal notification toast instead of the editor. The main window is now the
 * largest titled window, ties going to the frontmost; `target_title` picks another.
 */

import type { AXBounds, NativeModule, WindowRecord } from '../native.js'
import { StructuredToolError } from './errors.js'

export type WindowKind = 'main' | 'document' | 'dialog' | 'panel' | 'toast' | 'other'

export interface DisplayRect {
  x?: number
  y?: number
  width: number
  height: number
}

/** One entry of `getWindowAxInfo(pid)`. */
export interface AxWindowInfo {
  title: string | null
  role: string | null
  subrole: string | null
  modal: boolean | null
  bounds: AXBounds | null
}

export interface ClassifiedWindow extends WindowRecord {
  kind: WindowKind
  area: number
  kindSource: 'ax' | 'heuristic'
  subrole?: string
}

/** A toast is at most this fraction of the app's main window. */
export const TOAST_MAX_AREA_RATIO = 0.15
/** ...and sits within this many points of a display edge. */
export const TOAST_EDGE_DISTANCE = 120
/** A titled window this much smaller than the main window is a dialog or panel. */
export const SECONDARY_MAX_AREA_RATIO = 0.4

export function windowArea(window: Pick<WindowRecord, 'bounds'>): number {
  const bounds = window.bounds
  if (!bounds) return 0
  return Math.max(0, bounds.width) * Math.max(0, bounds.height)
}

export function hasTitle(window: Pick<WindowRecord, 'title'>): boolean {
  return typeof window.title === 'string' && window.title.trim().length > 0
}

export function titleMatches(window: Pick<WindowRecord, 'title'>, filter: string): boolean {
  return hasTitle(window) && window.title!.toLowerCase().includes(filter.toLowerCase())
}

/**
 * The best main-window candidate among `windows` (already narrowed to one app):
 * score by (has a title, area); an equal score keeps the earlier, frontmost entry.
 */
export function selectMainWindow<T extends WindowRecord>(
  windows: readonly T[],
  options: { title?: string } = {},
): T | undefined {
  const candidates = options.title
    ? windows.filter(window => titleMatches(window, options.title!))
    : windows
  let best: T | undefined
  let bestScore: [number, number] = [-1, -1]
  for (const window of candidates) {
    if (window.isOnScreen === false) continue
    const score: [number, number] = [hasTitle(window) ? 1 : 0, windowArea(window)]
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
      best = window
      bestScore = score
    }
  }
  return best
}

function sameBounds(a: AXBounds, b: AXBounds, tolerance = 2): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance
}

function centre(bounds: AXBounds): [number, number] {
  return [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2]
}

function contains(outer: AXBounds, x: number, y: number): boolean {
  return x >= outer.x && y >= outer.y && x < outer.x + outer.width && y < outer.y + outer.height
}

/** Distance in points from the window to the nearest edge of the display it is on. */
export function distanceToDisplayEdge(bounds: AXBounds, displays: readonly DisplayRect[]): number {
  if (displays.length === 0) return Number.POSITIVE_INFINITY
  const [cx, cy] = centre(bounds)
  const display = displays.find(d => contains(
    { x: d.x ?? 0, y: d.y ?? 0, width: d.width, height: d.height }, cx, cy,
  )) ?? displays[0]
  const dx = display.x ?? 0
  const dy = display.y ?? 0
  return Math.max(0, Math.min(
    bounds.x - dx,
    bounds.y - dy,
    dx + display.width - (bounds.x + bounds.width),
    dy + display.height - (bounds.y + bounds.height),
  ))
}

function kindFromAx(info: AxWindowInfo | undefined, isMain: boolean): WindowKind | undefined {
  if (!info) return undefined
  if (info.subrole === 'AXDialog' || info.subrole === 'AXSystemDialog' || info.modal === true) return 'dialog'
  if (info.subrole === 'AXFloatingWindow' || info.subrole === 'AXSystemFloatingWindow') return 'panel'
  if (info.subrole === 'AXStandardWindow') return isMain ? 'main' : 'document'
  return undefined
}

/**
 * Label each window of ONE app with a kind. AX subroles win when the window is
 * reachable through AX (matched by bounds); otherwise:
 *
 * - main: the window `selectMainWindow` picks
 * - toast: untitled, under 15% of the main window's area, within 120 pt of a display edge
 * - dialog: titled, under 40% of the main window, centred over the main window
 * - panel: titled, under 40% of the main window, centred elsewhere
 * - document: any other titled window
 * - other: any other untitled window
 */
export function classifyAppWindows(
  windows: readonly WindowRecord[],
  displays: readonly DisplayRect[],
  ax: readonly AxWindowInfo[] = [],
): ClassifiedWindow[] {
  // AX can name a window whose CoreGraphics title is hidden (no Screen Recording
  // permission); use it for scoring and report it.
  const withAx = windows.map(window => {
    const info = window.bounds ? ax.find(entry => entry.bounds && sameBounds(entry.bounds, window.bounds)) : undefined
    const title = hasTitle(window) ? window.title : info?.title && info.title.trim() ? info.title : window.title
    return { window: { ...window, title }, info }
  })
  const main = selectMainWindow(withAx.map(entry => entry.window))
  const mainArea = main ? windowArea(main) : 0
  return withAx.map(({ window, info }) => {
    const area = windowArea(window)
    const isMain = main !== undefined && window.windowId === main.windowId
    const fromAx = kindFromAx(info, isMain)
    const extra = info?.subrole ? { subrole: info.subrole } : {}
    if (fromAx) return { ...window, ...extra, kind: fromAx, area, kindSource: 'ax' as const }
    let kind: WindowKind
    if (isMain) kind = 'main'
    else if (!hasTitle(window)) {
      const small = mainArea > 0 ? area < mainArea * TOAST_MAX_AREA_RATIO : area < 400 * 200
      const nearEdge = window.bounds
        ? distanceToDisplayEdge(window.bounds, displays) <= TOAST_EDGE_DISTANCE
        : false
      kind = small && nearEdge ? 'toast' : 'other'
    } else if (main && mainArea > 0 && area < mainArea * SECONDARY_MAX_AREA_RATIO) {
      const [cx, cy] = centre(window.bounds)
      kind = contains(main.bounds, cx, cy) ? 'dialog' : 'panel'
    } else kind = 'document'
    return { ...window, ...extra, kind, area, kindSource: 'heuristic' as const }
  })
}

/** Classify a mixed list: windows are grouped per owning process, order kept. */
export function classifyWindows(
  windows: readonly WindowRecord[],
  displays: readonly DisplayRect[],
  axByPid: ReadonlyMap<number, readonly AxWindowInfo[]> = new Map(),
): ClassifiedWindow[] {
  const byPid = new Map<number, number[]>()
  windows.forEach((window, index) => {
    const list = byPid.get(window.pid) ?? []
    list.push(index)
    byPid.set(window.pid, list)
  })
  const classified: ClassifiedWindow[] = new Array(windows.length)
  for (const [pid, indices] of byPid) {
    const labelled = classifyAppWindows(indices.map(index => windows[index]), displays, axByPid.get(pid) ?? [])
    indices.forEach((index, position) => { classified[index] = labelled[position] })
  }
  return classified
}

function safeDisplays(native: Pick<NativeModule, 'listDisplays' | 'getDisplaySize'>): DisplayRect[] {
  try {
    const displays = native.listDisplays?.()
    if (Array.isArray(displays) && displays.length) return displays
  } catch { /* fall through */ }
  try { return [native.getDisplaySize()] } catch { return [] }
}

function safeAx(native: Partial<Pick<NativeModule, 'getWindowAxInfo'>>, pid: number): AxWindowInfo[] {
  try {
    const info = native.getWindowAxInfo?.(pid)
    return Array.isArray(info) ? info : []
  } catch { return [] }
}

/**
 * The windows of one app (or all apps), labelled with kinds. AX is consulted only
 * when the list is narrowed to one app: a few calls per app are cheap, a call to
 * every running app is not (and a hung app would stall the whole list).
 */
export function listClassifiedWindows(
  native: Pick<NativeModule, 'listWindows' | 'listDisplays' | 'getDisplaySize'> & Partial<Pick<NativeModule, 'getWindowAxInfo'>>,
  bundleId?: string,
  options: { ax?: boolean } = {},
): ClassifiedWindow[] {
  const windows = native.listWindows(bundleId)
  if (!Array.isArray(windows)) return []
  const axByPid = new Map<number, AxWindowInfo[]>()
  if (bundleId && options.ax !== false) {
    for (const pid of new Set(windows.map(window => window.pid))) axByPid.set(pid, safeAx(native, pid))
  }
  return classifyWindows(windows, safeDisplays(native), axByPid)
}

export class WindowSelectionError extends StructuredToolError {
  constructor(message: string, details: Record<string, unknown>) {
    super(message, details)
    this.name = 'WindowSelectionError'
  }
}

/**
 * Resolve `target_app` (+ optional `target_title`) to one window id.
 * Returns undefined when the app has no on-screen window (the caller keeps its
 * previous behaviour); throws when a title was asked for and none matches, listing
 * the titles that exist.
 */
export function resolveAppWindow(
  native: Pick<NativeModule, 'listWindows'>,
  bundleId: string,
  title?: string,
): WindowRecord | undefined {
  let windows: WindowRecord[]
  try { windows = native.listWindows(bundleId) } catch { return undefined }
  if (!Array.isArray(windows) || windows.length === 0) {
    if (title) {
      throw new WindowSelectionError(`No on-screen window of ${bundleId}`, {
        error: 'window_not_found', target_app: bundleId, target_title: title, windows: [],
      })
    }
    return undefined
  }
  const chosen = selectMainWindow(windows, title ? { title } : {})
  if (!chosen && title) {
    throw new WindowSelectionError(`No window of ${bundleId} has a title containing "${title}"`, {
      error: 'window_not_found',
      target_app: bundleId,
      target_title: title,
      windows: windows.map(window => ({ windowId: window.windowId, title: window.title })),
    })
  }
  return chosen
}
