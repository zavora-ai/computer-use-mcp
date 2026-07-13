import type { ActionRequest } from './coordinator.js'
import type { ActionProvenance, DataLabel, ExecutionMode, TargetEvidence } from './types.js'
import { browserUrlDigest, canonicalBrowserUrl } from './browser-bridge.js'

export type ComputerActionProvider = 'openai' | 'anthropic' | 'gemini' | 'mcp'

export interface TrustedCoordinateSpace {
  /** Logical-pixel width of the exact image/viewport sent to the model. */
  width: number
  /** Logical-pixel height of the exact image/viewport sent to the model. */
  height: number
  /** Desktop-space origin when the model saw a cropped window or display. */
  originX?: number
  /** Desktop-space origin when the model saw a cropped window or display. */
  originY?: number
  /** Explicit conversion for Gemini pixel magnitudes to native scroll steps. */
  scrollPixelsPerStep?: number
}

export interface ProviderActionContext {
  sessionId: string
  principalId: string
  actionId?: string
  attempt?: number
  executionGroupId?: string
  agentId?: string
  mode: ExecutionMode
  target?: TargetEvidence
  dataLabels?: DataLabel[]
  provenance?: ActionProvenance
  expiresInMs?: number
  leaseId?: string
  approvalGrantId?: string
  focusStrategy?: 'strict' | 'best_effort' | 'none' | 'prepare_display'
  /** Host-observed coordinate space. Never source this from model output. */
  coordinateSpace?: TrustedCoordinateSpace
  /** Trusted host browser binding; enables the internal governed bridge actuator. */
  browserBridge?: {
    bridgeId: string
    currentUrl: string
    /** Route coordinate/keyboard actions through DOM/CDP instead of desktop input. */
    routeAllActions?: boolean
  }
}

export interface GenericMcpAction {
  name: string
  arguments?: Record<string, unknown>
}

export interface GeminiComputerAction {
  name: string
  arguments?: Record<string, unknown>
  id?: string
  type?: string
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`)
  }
  return value
}

function coordinate(action: Record<string, unknown>): [number, number] {
  const value = action.coordinate ?? action.coordinates ?? action.position
  if (Array.isArray(value) && value.length >= 2) {
    return [finiteNumber(value[0], 'coordinate[0]'), finiteNumber(value[1], 'coordinate[1]')]
  }
  return [finiteNumber(action.x, 'x'), finiteNumber(action.y, 'y')]
}

function point(value: unknown, field: string): [number, number] {
  if (Array.isArray(value) && value.length >= 2) {
    return [finiteNumber(value[0], `${field}[0]`), finiteNumber(value[1], `${field}[1]`)]
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    return [finiteNumber(record.x, `${field}.x`), finiteNumber(record.y, `${field}.y`)]
  }
  throw new TypeError(`${field} must be an [x,y] pair or {x,y} point`)
}

function keyText(action: Record<string, unknown>): string {
  if (typeof action.text === 'string' && action.text) return action.text
  if (typeof action.key === 'string' && action.key) return action.key
  if (Array.isArray(action.keys) && action.keys.length > 0 && action.keys.every(value => typeof value === 'string')) {
    return action.keys.map(value => value.toLowerCase().replace(/^ctrl$/, 'control')).join('+')
  }
  throw new TypeError('key action requires text, key, or keys[]')
}

function booleanValue(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`)
  return value
}

function trustedCoordinateSpace(context: ProviderActionContext): Required<Pick<TrustedCoordinateSpace, 'width' | 'height'>> & TrustedCoordinateSpace {
  const space = context.coordinateSpace
  if (!space) throw new TypeError('Gemini coordinate action requires trusted host coordinateSpace')
  const width = finiteNumber(space.width, 'coordinateSpace.width')
  const height = finiteNumber(space.height, 'coordinateSpace.height')
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new TypeError('coordinateSpace width and height must be positive integers')
  }
  return { ...space, width, height }
}

function denormalize(value: unknown, size: number, origin: number, field: string): number {
  const normalized = finiteNumber(value, field)
  if (normalized < 0 || normalized > 1000) throw new TypeError(`${field} must be between 0 and 1000`)
  // Google's reference executor floors normalized / 1000 * dimension. Clamp
  // 1000 so a boundary coordinate cannot escape the trusted viewport.
  return origin + Math.min(size - 1, Math.floor((normalized / 1000) * size))
}

function geminiCoordinate(action: Record<string, unknown>, context: ProviderActionContext): [number, number] {
  const space = trustedCoordinateSpace(context)
  const originX = finiteNumber(space.originX ?? 0, 'coordinateSpace.originX')
  const originY = finiteNumber(space.originY ?? 0, 'coordinateSpace.originY')
  return [
    denormalize(action.x, space.width, originX, 'x'),
    denormalize(action.y, space.height, originY, 'y'),
  ]
}

function geminiScrollAmount(action: Record<string, unknown>, context: ProviderActionContext): number {
  const magnitude = finiteNumber(action.magnitude ?? 800, 'magnitude')
  if (magnitude <= 0) throw new TypeError('magnitude must be positive')
  const pixelsPerStep = trustedCoordinateSpace(context).scrollPixelsPerStep
  if (pixelsPerStep === undefined) {
    throw new TypeError('Gemini scroll magnitude requires trusted coordinateSpace.scrollPixelsPerStep')
  }
  const step = finiteNumber(pixelsPerStep, 'coordinateSpace.scrollPixelsPerStep')
  if (step <= 0) throw new TypeError('coordinateSpace.scrollPixelsPerStep must be positive')
  return Math.max(1, Math.round(magnitude / step))
}

function geminiKeyText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('key_combination requires keys')
  return value.trim().split(/\s*\+\s*/).map(key => {
    const normalized = key.toLowerCase()
    return normalized === 'ctrl' ? 'control' : normalized === 'cmd' || normalized === 'meta' ? 'command' : normalized
  }).join('+')
}

function geminiDirection(action: Record<string, unknown>): 'up' | 'down' | 'left' | 'right' {
  const direction = String(action.direction ?? '').toLowerCase()
  if (!['up', 'down', 'left', 'right'].includes(direction)) {
    throw new TypeError('Gemini scroll direction must be up, down, left, or right')
  }
  return direction as 'up' | 'down' | 'left' | 'right'
}

function bridgeAction(
  operation: string,
  actionArguments: Record<string, unknown>,
  context: ProviderActionContext,
): { tool: string; args: Record<string, unknown> } {
  const browser = context.browserBridge
  if (!browser) throw new TypeError(`Gemini action ${operation} requires a host browser/application bridge`)
  if (!browser.bridgeId || !browser.currentUrl) throw new TypeError('trusted browserBridge requires bridgeId and currentUrl')
  let currentUrl: string
  try { currentUrl = canonicalBrowserUrl(browser.currentUrl) } catch { throw new TypeError('trusted browserBridge.currentUrl must be an absolute HTTP(S) URL without credentials') }
  if (context.target?.appId !== `browser:${browser.bridgeId}` || context.target.role !== 'browser_page'
    || context.target.windowId === undefined || context.target.windowTitleDigest !== browserUrlDigest(currentUrl)) {
    throw new TypeError('trusted browserBridge does not match browser page target evidence')
  }
  return {
    tool: 'browser_action',
    args: {
      bridge_id: browser.bridgeId,
      operation,
      current_url: currentUrl,
      action_arguments: structuredClone(actionArguments),
    },
  }
}

function translateGeminiAction(
  action: GeminiComputerAction,
  context: ProviderActionContext,
): Array<{ tool: string; args: Record<string, unknown> }> {
  if (!action.name || typeof action.name !== 'string') throw new TypeError('Gemini function-call name is required')
  if (action.arguments !== undefined && (!action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments))) {
    throw new TypeError('Gemini function-call arguments must be an object')
  }
  const args = structuredClone(action.arguments ?? {})
  const name = action.name.toLowerCase()
  const at = () => geminiCoordinate(args, context)
  switch (name) {
    case 'click':
    case 'click_at': return [{ tool: 'left_click', args: { coordinate: at() } }]
    case 'double_click': return [{ tool: 'double_click', args: { coordinate: at() } }]
    case 'triple_click': return [{ tool: 'triple_click', args: { coordinate: at() } }]
    case 'right_click': return [{ tool: 'right_click', args: { coordinate: at() } }]
    case 'middle_click': return [{ tool: 'middle_click', args: { coordinate: at() } }]
    case 'move':
    case 'hover_at': return [{ tool: 'mouse_move', args: { coordinate: at() } }]
    case 'drag_and_drop': {
      const start = at()
      const space = trustedCoordinateSpace(context)
      const originX = finiteNumber(space.originX ?? 0, 'coordinateSpace.originX')
      const originY = finiteNumber(space.originY ?? 0, 'coordinateSpace.originY')
      const end: [number, number] = [
        denormalize(args.destination_x, space.width, originX, 'destination_x'),
        denormalize(args.destination_y, space.height, originY, 'destination_y'),
      ]
      return [{ tool: 'left_click_drag', args: { start_coordinate: start, coordinate: end } }]
    }
    case 'type':
    case 'type_text_at': {
      if (typeof args.text !== 'string') throw new TypeError(`${name} requires text`)
      const hasX = args.x !== undefined
      const hasY = args.y !== undefined
      if (hasX !== hasY) throw new TypeError(`${name} requires both x and y when either is present`)
      const translated: Array<{ tool: string; args: Record<string, unknown> }> = []
      if (hasX) translated.push({ tool: 'left_click', args: { coordinate: at() } })
      translated.push({
        tool: 'type',
        args: {
          text: args.text,
          clear: booleanValue(args.clear_before_typing, true, 'clear_before_typing'),
          press_enter: booleanValue(args.press_enter, false, 'press_enter'),
        },
      })
      return translated
    }
    case 'key_combination': return [{ tool: 'key', args: { text: geminiKeyText(args.keys) } }]
    case 'scroll_at': return [{
      tool: 'scroll',
      args: { coordinate: at(), direction: geminiDirection(args), amount: geminiScrollAmount(args, context) },
    }]
    case 'scroll_document': {
      const space = trustedCoordinateSpace(context)
      const originX = finiteNumber(space.originX ?? 0, 'coordinateSpace.originX')
      const originY = finiteNumber(space.originY ?? 0, 'coordinateSpace.originY')
      return [{
        tool: 'scroll',
        args: {
          coordinate: [originX + Math.floor(space.width / 2), originY + Math.floor(space.height / 2)],
          direction: geminiDirection(args),
          amount: geminiScrollAmount(args, context),
        },
      }]
    }
    case 'wait':
    case 'wait_5_seconds': return [{
      tool: 'wait', args: { duration: name === 'wait_5_seconds' ? 5 : finiteNumber(args.seconds ?? 1, 'seconds') },
    }]
    case 'screenshot': return [{ tool: 'screenshot', args: {} }]
    case 'navigate':
      if (typeof args.url !== 'string' || !args.url) throw new TypeError('Gemini navigate requires url')
      return [bridgeAction(name, { url: args.url }, context)]
    case 'search':
      if (typeof args.query !== 'string' || !args.query) throw new TypeError('Gemini search requires query')
      return [bridgeAction(name, { query: args.query }, context)]
    case 'go_back':
    case 'go_forward':
    case 'open_web_browser':
      return [bridgeAction(name, {}, context)]
    case 'open_app':
      throw new TypeError(`Gemini action ${name} requires a host browser/application bridge`)
    case 'long_press':
      throw new TypeError('Gemini action long_press has no exact governed desktop mapping')
    default:
      throw new TypeError(`unsupported Gemini computer action: ${name}`)
  }
}

function translateAction(action: Record<string, unknown>): { tool: string; args: Record<string, unknown> } {
  const kind = String(action.type ?? action.action ?? '').toLowerCase()
  switch (kind) {
    case 'screenshot':
      return { tool: 'screenshot', args: {} }
    case 'click':
    case 'left_click': {
      const button = String(action.button ?? 'left').toLowerCase()
      const tool = button === 'right' ? 'right_click' : button === 'middle' || button === 'wheel'
        ? 'middle_click' : 'left_click'
      if (!['left', 'right', 'middle', 'wheel'].includes(button)) {
        throw new TypeError(`unsupported click button: ${button}`)
      }
      return { tool, args: { coordinate: coordinate(action) } }
    }
    case 'double_click':
      return { tool: 'double_click', args: { coordinate: coordinate(action) } }
    case 'right_click':
      return { tool: 'right_click', args: { coordinate: coordinate(action) } }
    case 'middle_click':
      return { tool: 'middle_click', args: { coordinate: coordinate(action) } }
    case 'triple_click':
      return { tool: 'triple_click', args: { coordinate: coordinate(action) } }
    case 'move':
    case 'mouse_move':
      return { tool: 'mouse_move', args: { coordinate: coordinate(action) } }
    case 'drag':
    case 'left_click_drag': {
      const path = action.path
      if (Array.isArray(path) && path.length >= 2) {
        return {
          tool: 'left_click_drag',
          args: {
            start_coordinate: point(path[0], 'path[0]'),
            coordinate: point(path.at(-1), `path[${path.length - 1}]`),
          },
        }
      }
      const end = coordinate(action)
      const rawStart = action.start_coordinate ?? action.start
      return {
        tool: 'left_click_drag',
        args: {
          ...(rawStart !== undefined ? { start_coordinate: point(rawStart, 'start_coordinate') } : {}),
          coordinate: end,
        },
      }
    }
    case 'scroll': {
      const dx = typeof action.scroll_x === 'number' ? action.scroll_x : action.dx
      const dy = typeof action.scroll_y === 'number' ? action.scroll_y : action.dy
      const rawDirection = action.direction ?? action.scroll_direction
      const direction = typeof rawDirection === 'string'
        ? rawDirection.toLowerCase()
        : Math.abs(Number(dx ?? 0)) > Math.abs(Number(dy ?? 0))
          ? (Number(dx) > 0 ? 'right' : 'left')
          : (Number(dy) > 0 ? 'down' : 'up')
      if (!['up', 'down', 'left', 'right'].includes(direction)) {
        throw new TypeError('scroll direction must be up, down, left, or right')
      }
      const amountValue = action.amount ?? action.scroll_amount
        ?? (Math.abs(Number(dx ?? 0)) || Math.abs(Number(dy ?? 0)) || 3)
      const amount = Math.max(1, Math.round(finiteNumber(amountValue, 'amount')))
      return { tool: 'scroll', args: { coordinate: coordinate(action), direction, amount } }
    }
    case 'type':
      if (typeof action.text !== 'string') throw new TypeError('type action requires text')
      return { tool: 'type', args: { text: action.text } }
    case 'key':
    case 'keypress':
      return { tool: 'key', args: { text: keyText(action) } }
    case 'wait': {
      const duration = finiteNumber(action.duration ?? action.seconds ?? action.time ?? 1, 'duration')
      return { tool: 'wait', args: { duration } }
    }
    case 'cursor_position':
      return { tool: 'cursor_position', args: {} }
    default:
      throw new TypeError(`unsupported computer action: ${kind || '(missing action)'}`)
  }
}

function targetArguments(context: ProviderActionContext): Record<string, unknown> {
  return {
    ...(context.target?.appId ? { target_app: context.target.appId } : {}),
    ...(context.target?.windowId !== undefined ? { target_window_id: context.target.windowId } : {}),
    ...(context.focusStrategy ? { focus_strategy: context.focusStrategy } : {}),
  }
}

/**
 * Translate provider wire shapes only. Trusted identity, evidence, policy,
 * lease, and approval context comes from the host and is never read from the
 * model-supplied action object.
 */
export function adaptProviderAction(
  provider: ComputerActionProvider,
  action: Record<string, unknown> | GenericMcpAction,
  context: ProviderActionContext,
): ActionRequest {
  const translated = adaptProviderActions(provider, action, context)
  if (translated.length !== 1) {
    throw new TypeError(`provider action expands to ${translated.length} governed actions; use adaptProviderActions`)
  }
  return translated[0]
}

/**
 * Translate one provider call into one or more independently governed v8
 * actions. Composite provider commands never become a hidden side-effect
 * batch: each returned request receives its own action id and receipt.
 */
export function adaptProviderActions(
  provider: ComputerActionProvider,
  action: Record<string, unknown> | GenericMcpAction | GeminiComputerAction,
  context: ProviderActionContext,
): ActionRequest[] {
  let translatedActions: Array<{ tool: string; args: Record<string, unknown> }>
  if (provider === 'mcp') {
    const mcp = action as GenericMcpAction
    if (!mcp.name || typeof mcp.name !== 'string') throw new TypeError('MCP action name is required')
    if (mcp.arguments !== undefined && (!mcp.arguments || typeof mcp.arguments !== 'object' || Array.isArray(mcp.arguments))) {
      throw new TypeError('MCP action arguments must be an object')
    }
    translatedActions = [{ tool: mcp.name, args: structuredClone(mcp.arguments ?? {}) }]
  } else if (provider === 'gemini') {
    translatedActions = translateGeminiAction(action as GeminiComputerAction, context)
    if (context.browserBridge?.routeAllActions) {
      const bounds = context.target?.bounds
      const space = context.coordinateSpace
      if (bounds && space && (bounds.width !== space.width || bounds.height !== space.height
        || bounds.x !== (space.originX ?? 0) || bounds.y !== (space.originY ?? 0))) {
        throw new TypeError('trusted coordinateSpace does not match browser target viewport')
      }
      translatedActions = translatedActions.map(translated =>
        translated.tool === 'wait' || translated.tool === 'screenshot'
          ? translated
          : translated.tool === 'browser_action'
            ? translated
            : bridgeAction(translated.tool, translated.args, context))
    }
  } else {
    translatedActions = [translateAction(action as Record<string, unknown>)]
  }

  const trustedTarget = targetArguments(context)
  return translatedActions.map((translated, index) => {
    for (const key of ['target_app', 'target_window_id', 'focus_strategy']) {
      if (!(key in translated.args)) continue
      if (!(key in trustedTarget)) {
        throw new TypeError(`provider action ${key} may only come from trusted host context`)
      }
      if (translated.args[key] !== trustedTarget[key]) {
        throw new TypeError(`provider action ${key} conflicts with trusted host context`)
      }
    }
    if (translatedActions.length > 1 && context.approvalGrantId) {
      throw new TypeError('composite provider actions require a separate exact-action approval grant per action')
    }
    const args = { ...translated.args, ...trustedTarget }
    return {
      sessionId: context.sessionId,
      principalId: context.principalId,
      ...(context.actionId ? { actionId: translatedActions.length === 1 ? context.actionId : `${context.actionId}:${index + 1}` } : {}),
      ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
      ...(context.executionGroupId ? { executionGroupId: context.executionGroupId } : {}),
      ...(context.agentId ? { agentId: context.agentId } : {}),
      tool: translated.tool,
      args,
      mode: context.mode,
      ...(context.target ? { target: structuredClone(context.target) } : {}),
      ...(context.dataLabels ? { dataLabels: [...context.dataLabels] } : {}),
      ...(context.provenance ? { provenance: structuredClone(context.provenance) } : {}),
      ...(context.expiresInMs !== undefined ? { expiresInMs: context.expiresInMs } : {}),
      ...(context.leaseId ? { leaseId: context.leaseId } : {}),
      ...(context.approvalGrantId ? { approvalGrantId: context.approvalGrantId } : {}),
    }
  })
}
