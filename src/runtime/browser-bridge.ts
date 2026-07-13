import { createHash } from 'node:crypto'
import type { ToolResult } from '../result.js'
import { RuntimeError, type ActionEnvelope, type TargetEvidence } from './types.js'

export interface BrowserPageEvidence {
  bridgeId: string
  pageId: string
  url: string
  observationId: string
  domRevision: string
  confidence: number
  capturedAt: string
  viewport?: { x?: number; y?: number; width: number; height: number }
  screenshotHash?: string
}

export interface BrowserBridgeExecutionRequest {
  operation: string
  arguments: Readonly<Record<string, unknown>>
  currentUrl: string
  target: Readonly<TargetEvidence>
  envelope: Readonly<ActionEnvelope>
}

export interface BrowserBridgeExecutionResult {
  result: ToolResult
  /** Host bridge must prove and return fresh post-action page evidence. */
  evidence: BrowserPageEvidence
  verified: boolean
}

export const BROWSER_BRIDGE_OPERATIONS = new Set([
  'open_web_browser', 'navigate', 'go_back', 'go_forward', 'search',
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'mouse_move', 'left_click_drag', 'type', 'key', 'scroll',
])

/** Host-supplied DOM/CDP integration. No browser engine is bundled. */
export interface BrowserBridge {
  readonly id: string
  validateTarget(target: Readonly<TargetEvidence>, signal?: AbortSignal): Promise<boolean> | boolean
  execute(request: BrowserBridgeExecutionRequest, signal?: AbortSignal): Promise<BrowserBridgeExecutionResult>
}

export function browserUrlDigest(url: string): string {
  return `sha256:${createHash('sha256').update(url).digest('hex')}`
}

function safeWebUrl(raw: string, field: string): URL {
  let url: URL
  try { url = new URL(raw) } catch { throw new TypeError(`${field} must be an absolute URL`) }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError(`${field} must use http or https`)
  }
  if (url.username || url.password) throw new TypeError(`${field} must not contain embedded credentials`)
  url.hash = ''
  return url
}

export function canonicalBrowserUrl(raw: string): string {
  return safeWebUrl(raw, 'browser URL').toString()
}

export function validateBrowserActionArguments(
  operation: string,
  args: Readonly<Record<string, unknown>>,
  target: Readonly<TargetEvidence> | undefined,
): void {
  const exact = (allowed: string[]) => {
    const unknown = Object.keys(args).filter(key => !allowed.includes(key))
    if (unknown.length) throw new TypeError(`unsupported ${operation} argument: ${unknown[0]}`)
  }
  const text = (key: string, maximum: number) => {
    if (typeof args[key] !== 'string' || !(args[key] as string).length || (args[key] as string).length > maximum) {
      throw new TypeError(`${operation}.${key} must be a non-empty string of at most ${maximum} characters`)
    }
  }
  const coordinate = (key: string) => {
    const point = args[key]
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
      throw new TypeError(`${operation}.${key} must be a finite [x,y] coordinate`)
    }
    const bounds = target?.bounds
    if (!bounds || point[0] < bounds.x || point[1] < bounds.y
      || point[0] >= bounds.x + bounds.width || point[1] >= bounds.y + bounds.height) {
      throw new RuntimeError('stale_target', `${operation}.${key} is outside the evidenced browser viewport`)
    }
  }
  if (operation === 'navigate') {
    exact(['url']); text('url', 8192); safeWebUrl(String(args.url), 'navigate.url'); return
  }
  if (operation === 'search') { exact(['query']); text('query', 10_000); return }
  if (['go_back', 'go_forward', 'open_web_browser'].includes(operation)) { exact([]); return }
  if (['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'mouse_move'].includes(operation)) {
    exact(['coordinate']); coordinate('coordinate'); return
  }
  if (operation === 'left_click_drag') {
    exact(['start_coordinate', 'coordinate'])
    if (args.start_coordinate !== undefined) coordinate('start_coordinate')
    coordinate('coordinate'); return
  }
  if (operation === 'type') {
    exact(['text', 'clear', 'press_enter', 'caret_position']); text('text', 1_000_000)
    for (const key of ['clear', 'press_enter']) {
      if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new TypeError(`type.${key} must be a boolean`)
    }
    return
  }
  if (operation === 'key') { exact(['text']); text('text', 256); return }
  if (operation === 'scroll') {
    exact(['coordinate', 'direction', 'amount']); coordinate('coordinate')
    if (!['up', 'down', 'left', 'right'].includes(String(args.direction))) throw new TypeError('scroll.direction is invalid')
    if (!Number.isInteger(args.amount) || Number(args.amount) <= 0 || Number(args.amount) > 10_000) {
      throw new TypeError('scroll.amount must be an integer between 1 and 10000')
    }
    return
  }
  throw new RuntimeError('policy_denied', `unsupported browser bridge operation: ${operation}`)
}

export function browserTargetFromEvidence(evidence: BrowserPageEvidence): TargetEvidence {
  if (!evidence.bridgeId || !evidence.pageId || !evidence.observationId || !evidence.domRevision) {
    throw new TypeError('browser evidence requires bridgeId, pageId, observationId, and domRevision')
  }
  if (!Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1) {
    throw new RangeError('browser evidence confidence must be between 0 and 1')
  }
  if (!Number.isFinite(Date.parse(evidence.capturedAt))) throw new TypeError('browser evidence capturedAt must be an ISO timestamp')
  const url = safeWebUrl(evidence.url, 'browser evidence url').toString()
  const viewport = evidence.viewport
  if (viewport && (!Number.isFinite(viewport.width) || viewport.width <= 0
    || !Number.isFinite(viewport.height) || viewport.height <= 0)) {
    throw new RangeError('browser evidence viewport must have positive dimensions')
  }
  return {
    platform: process.platform,
    appId: `browser:${evidence.bridgeId}`,
    windowId: evidence.pageId,
    windowTitleDigest: browserUrlDigest(url),
    role: 'browser_page',
    observationId: evidence.observationId,
    ...(evidence.screenshotHash ? { screenshotHash: evidence.screenshotHash } : {}),
    uiTreeRevision: evidence.domRevision,
    ...(viewport ? { bounds: {
      x: viewport.x ?? 0, y: viewport.y ?? 0,
      width: viewport.width, height: viewport.height,
    } } : {}),
    confidence: evidence.confidence,
    capturedAt: evidence.capturedAt,
  }
}

export class BrowserBridgeHost {
  readonly bridge: BrowserBridge

  constructor(bridge: BrowserBridge) {
    if (!bridge.id || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(bridge.id)) {
      throw new TypeError('browser bridge id must be a bounded identifier')
    }
    this.bridge = bridge
  }

  owns(target: Readonly<TargetEvidence>): boolean {
    return target.appId === `browser:${this.bridge.id}` && target.role === 'browser_page'
  }

  async validateTarget(target: Readonly<TargetEvidence>, signal?: AbortSignal): Promise<boolean> {
    if (!this.owns(target) || target.windowId === undefined || !target.windowTitleDigest || !target.uiTreeRevision) return false
    return this.bridge.validateTarget(target, signal)
  }

  async execute(
    args: Readonly<Record<string, unknown>>,
    envelope: Readonly<ActionEnvelope> | undefined,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (!envelope?.target || !this.owns(envelope.target)) {
      throw new RuntimeError('stale_target', 'browser action requires bridge-owned page evidence')
    }
    if (args.bridge_id !== this.bridge.id) throw new RuntimeError('policy_denied', 'browser bridge id mismatch')
    const operation = typeof args.operation === 'string' ? args.operation : ''
    if (!operation) throw new TypeError('browser action operation is required')
    if (!BROWSER_BRIDGE_OPERATIONS.has(operation)) {
      throw new RuntimeError('policy_denied', `unsupported browser bridge operation: ${operation}`)
    }
    const currentUrl = safeWebUrl(String(args.current_url ?? ''), 'current_url').toString()
    if (browserUrlDigest(currentUrl) !== envelope.target.windowTitleDigest) {
      throw new RuntimeError('stale_target', 'browser URL no longer matches target evidence')
    }
    if (!(await this.validateTarget(envelope.target, signal))) {
      throw new RuntimeError('stale_target', 'browser page evidence is stale')
    }
    const actionArguments = args.action_arguments
    if (!actionArguments || typeof actionArguments !== 'object' || Array.isArray(actionArguments)) {
      throw new TypeError('browser action_arguments must be an object')
    }
    validateBrowserActionArguments(operation, actionArguments as Record<string, unknown>, envelope.target)
    const executed = await this.bridge.execute({
      operation,
      arguments: structuredClone(actionArguments as Record<string, unknown>),
      currentUrl,
      target: envelope.target,
      envelope,
    }, signal)
    if (!executed.verified) throw new RuntimeError('indeterminate', 'browser bridge did not verify its postcondition')
    const postTarget = browserTargetFromEvidence(executed.evidence)
    if (!this.owns(postTarget) || postTarget.windowId !== envelope.target.windowId
      || !(await this.bridge.validateTarget(postTarget, signal))) {
      throw new RuntimeError('indeterminate', 'browser bridge returned invalid post-action evidence')
    }
    if (executed.result.isError) throw new RuntimeError('indeterminate', 'browser bridge returned an error after execution')
    return {
      ...executed.result,
      structuredContent: {
        ...(executed.result.structuredContent ?? {}),
        browserEvidence: {
          bridgeId: executed.evidence.bridgeId,
          pageId: executed.evidence.pageId,
          urlDigest: browserUrlDigest(new URL(executed.evidence.url).toString()),
          observationId: executed.evidence.observationId,
          domRevision: executed.evidence.domRevision,
          confidence: executed.evidence.confidence,
          capturedAt: executed.evidence.capturedAt,
          ...(executed.evidence.viewport ? { viewport: executed.evidence.viewport } : {}),
          ...(executed.evidence.screenshotHash ? { screenshotHash: executed.evidence.screenshotHash } : {}),
        },
      },
    }
  }
}
