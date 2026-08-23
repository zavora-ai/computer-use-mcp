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
    if (typeof value === 'number') return value
  }
  return undefined
}

function coordinateFrom(action: Record<string, unknown>): [number, number] {
  const value = action.coordinate ?? action.coordinates ?? action.pos ?? action.position
  if (Array.isArray(value) && value.length >= 2
    && typeof value[0] === 'number' && typeof value[1] === 'number') {
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
    case 'left_click':
      return { actionType, tool: 'left_click', args: { coordinate: coordinateFrom(action), ...common } }
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
      const path = action.path
      if (Array.isArray(path) && path.length >= 2) {
        const first = path[0]
        const last = path[path.length - 1]
        if (!Array.isArray(first) || !Array.isArray(last)
          || typeof first[0] !== 'number' || typeof first[1] !== 'number'
          || typeof last[0] !== 'number' || typeof last[1] !== 'number') {
          throw new Error('drag path must contain [x,y] points')
        }
        return {
          actionType, tool: 'left_click_drag',
          args: { start_coordinate: [first[0], first[1]], coordinate: [last[0], last[1]], ...common },
        }
      }
      const start = action.start_coordinate ?? action.start
      const end = action.coordinate ?? action.end
      if (!Array.isArray(start) || !Array.isArray(end)
        || typeof start[0] !== 'number' || typeof start[1] !== 'number'
        || typeof end[0] !== 'number' || typeof end[1] !== 'number') {
        throw new Error('drag requires path[] or start/end coordinates')
      }
      return {
        actionType, tool: 'left_click_drag',
        args: { start_coordinate: [start[0], start[1]], coordinate: [end[0], end[1]], ...common },
      }
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
      const amount = Math.max(1, Math.round(Math.abs(dx ?? dy ?? numberFrom(action, ['amount']) ?? 3)))
      return { actionType, tool: 'scroll', args: { coordinate: [x, y], direction, amount, ...common } }
    }
    case 'type':
      return {
        actionType, tool: 'type',
        args: { text: typeof action.text === 'string' ? action.text : '', ...common },
      }
    case 'keypress':
    case 'key':
      return { actionType, tool: 'key', args: { text: keypressText(action), ...common } }
    case 'wait':
      return {
        actionType, tool: 'wait',
        args: { duration: numberFrom(action, ['duration', 'seconds', 'time']) ?? 1 },
      }
    default:
      throw new Error(`unsupported OpenAI computer action: ${actionType || '(missing type)'}`)
  }
}
