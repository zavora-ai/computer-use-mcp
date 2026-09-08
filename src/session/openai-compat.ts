export interface LegacyOpenAiCompatOptions {
  common: Record<string, unknown>
  width?: number
  quality?: number
  provider?: string
  useVirtualPointer: boolean
  nativeOverlay?: boolean
}

export interface LegacyOpenAiMappedAction {
  actionType: string
  tool: string
  args: Record<string, unknown>
}

function numberFrom(action: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = action[key]
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Action numbers must be finite'); return value }
  }
  return undefined
}

function coordinateFrom(action: Record<string, unknown>): [number, number] {
  const value = action.coordinate ?? action.coordinates ?? action.pos ?? action.position
  if (Array.isArray(value) && value.length >= 2
    && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
    return [value[0], value[1]]
  }
  const x = numberFrom(action, ['x'])
  const y = numberFrom(action, ['y'])
  if (x === undefined || y === undefined) {
    throw new Error('OpenAI computer action requires x/y or coordinate')
  }
  return [x, y]
}

function keypressText(action: Record<string, unknown>): string {
  if (typeof action.text === 'string') return action.text
  if (typeof action.key === 'string') return action.key
  if (Array.isArray(action.keys) && action.keys.every(key => typeof key === 'string')) {
    return (action.keys as string[])
      .map(key => key.toLowerCase().replace(/^ctrl$/, 'control'))
      .join('+')
  }
  throw new Error('keypress action requires text, key, or keys[]')
}

/** Pure compatibility translation for the legacy `openai_computer` batch tool. */
export function mapLegacyOpenAiAction(
  action: Record<string, unknown>,
  options: LegacyOpenAiCompatOptions,
): LegacyOpenAiMappedAction {
  const actionType = String(action.type ?? action.action ?? '').toLowerCase()
  const common = options.common
  if (!['key', 'keypress'].includes(actionType) && action.keys !== undefined) {
    if (!Array.isArray(action.keys) || action.keys.length) throw new Error('Modifier mouse actions are unsupported by this native adapter; use the browser backend')
  }
  switch (actionType) {
    case 'screenshot':
      return {
        actionType,
        tool: 'screenshot',
        args: {
          ...(options.width === undefined ? {} : { width: options.width }),
          ...(options.quality === undefined ? {} : { quality: options.quality }),
          ...(options.provider === undefined ? {} : { provider: options.provider }),
          show_agent_pointer: action.show_agent_pointer === true || options.useVirtualPointer,
        },
      }
    case 'click':
    case 'left_click': {
      const button = action.button ?? 'left'
      const tool = ({ left: 'left_click', right: 'right_click', wheel: 'middle_click', middle: 'middle_click' } as Record<string, string>)[String(button)]
      if (!tool) throw new Error(`Unsupported mouse button: ${button}`)
      return { actionType, tool, args: { coordinate: coordinateFrom(action), ...common } }
    }
    case 'double_click':
      return { actionType, tool: 'double_click', args: { coordinate: coordinateFrom(action), ...common } }
    case 'right_click':
      return { actionType, tool: 'right_click', args: { coordinate: coordinateFrom(action), ...common } }
    case 'move':
    case 'mouse_move': {
      const virtual = options.useVirtualPointer || action.virtual === true
      return {
        actionType,
        tool: virtual ? 'agent_pointer' : 'mouse_move',
        args: virtual
          ? {
              action: 'move', coordinate: coordinateFrom(action), visible: true,
              ...(options.nativeOverlay === undefined ? {} : { native_overlay: options.nativeOverlay }),
              ...(typeof action.native_overlay === 'boolean' ? { native_overlay: action.native_overlay } : {}),
              ...common,
            }
          : { coordinate: coordinateFrom(action), ...common },
      }
    }
    case 'drag': {
      const raw = action.path ?? [action.start_coordinate ?? action.start, action.coordinate ?? action.end]
      if (!Array.isArray(raw) || raw.length < 2 || raw.length > 1000) throw new Error('drag requires 2..1000 points')
      const path = raw.map(point => coordinateFrom(Array.isArray(point) ? { coordinate: point } : point ?? {}))
      return { actionType, tool: 'left_click_drag', args: {
        start_coordinate: path[0], coordinate: path.at(-1), path, ...common,
      } }
    }
    case 'scroll': {
      const [x, y] = coordinateFrom(action)
      const dx = numberFrom(action, ['scroll_x', 'dx'])
      const dy = numberFrom(action, ['scroll_y', 'dy'])
      const direction = typeof action.direction === 'string'
        ? action.direction
        : Math.abs(dx ?? 0) > Math.abs(dy ?? 0)
          ? ((dx ?? 0) > 0 ? 'right' : 'left')
          : ((dy ?? 0) > 0 ? 'down' : 'up')
      // Native scrolling is line-based: API pixel deltas use 100 pixels per line.
      const lines = (delta: number) => delta === 0 ? 0 : Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta) / 100))
      const amount = numberFrom(action, ['amount']) ?? 3
      if (amount < 0 || amount > 10000) throw new Error('scroll amount out of range')
      if (!['left', 'right', 'up', 'down'].includes(direction)) throw new Error('invalid scroll direction')
      return { actionType, tool: 'scroll', args: { coordinate: [x, y], direction, amount,
        ...(dx !== undefined || dy !== undefined ? { delta_x: lines(dx ?? 0), delta_y: lines(dy ?? 0) } : {}), ...common } }
    }
    case 'type':
      if (typeof action.text !== 'string') throw new Error('type requires text')
      return {
        actionType, tool: 'type',
        args: { text: typeof action.text === 'string' ? action.text : '', ...common },
      }
    case 'keypress':
    case 'key':
      return { actionType, tool: 'key', args: { text: keypressText(action), ...common } }
    case 'wait':
      if ((numberFrom(action, ['duration', 'seconds', 'time']) ?? 1) < 0 || (numberFrom(action, ['duration', 'seconds', 'time']) ?? 1) > 120) throw new Error('wait duration must be 0..120 seconds')
      return {
        actionType, tool: 'wait',
        args: { duration: numberFrom(action, ['duration', 'seconds', 'time']) ?? 1 },
      }
    default:
      throw new Error(`unsupported OpenAI computer action: ${actionType || '(missing type)'}`)
  }
}
