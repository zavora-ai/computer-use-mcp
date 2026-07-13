const CONTROL = new Set([
  'onboarding', 'start_session', 'complete_session', 'delete_session', 'prune_sessions',
  'pause_session', 'resume_session', 'take_over', 'stop_session', 'emergency_stop',
  'submit_follow_up',
])
const EXECUTE = new Set([
  'reserve_target', 'release_target_reservation', 'preview_action', 'execute_action',
  'acquire_control_lease', 'release_control_lease',
])
const OBSERVATION_TOOLS = new Set([
  'doctor', 'policy_status', 'get_display_size', 'list_windows', 'get_window',
  'get_cursor_window', 'get_frontmost_app', 'get_ui_tree', 'find_element',
  'get_element_at_point', 'list_menu_bar', 'get_app_dictionary',
  'get_app_capabilities', 'get_tool_guide', 'get_tool_metadata', 'list_spaces',
  'get_active_space', 'read_clipboard',
])
const SCREEN_TOOLS = new Set(['screenshot', 'zoom', 'snapshot'])

export function requiredRemoteScope(toolName, args = {}) {
  if (toolName === 'approve_action') return 'computer:approve'
  if (toolName === 'execute_action') {
    const inner = typeof args.tool === 'string' ? args.tool : ''
    if (SCREEN_TOOLS.has(inner)) return 'computer:screenshot'
    if (OBSERVATION_TOOLS.has(inner)) return 'computer:observe'
    return 'computer:execute'
  }
  if (toolName === 'preview_action') return 'computer:observe'
  if (SCREEN_TOOLS.has(toolName)) return 'computer:screenshot'
  if (EXECUTE.has(toolName)) return 'computer:execute'
  if (CONTROL.has(toolName)) return 'computer:control'
  return 'computer:observe'
}

/** Authorization hook for createComputerUseServer({ authorizeToolCall }). */
export function createRemoteToolAuthorizer(authInfo) {
  const expectedContext = authInfo?.extra?.authContextId
  return ({ definition, args, authInfo: requestAuth }) => {
    if (!requestAuth || requestAuth.extra?.authContextId !== expectedContext) {
      throw new Error('remote authorization context mismatch')
    }
    const required = requiredRemoteScope(definition.name, args)
    if (!requestAuth.scopes.includes(required)) throw new Error(`missing required scope: ${required}`)
  }
}

/** Safe host adapter for a shared, already-constructed v8 runtime/session. */
export function createComputerUseRemoteServerFactory(options) {
  if (typeof options?.createComputerUseServer !== 'function') throw new TypeError('createComputerUseServer is required')
  if (!options.runtime || !options.session) throw new TypeError('runtime and session are required')
  return async ({ principalId, authInfo }) => options.createComputerUseServer({
    session: options.session,
    runtime: options.runtime,
    enableV8: true,
    profile: options.profile ?? 'full',
    activeProfile: 'v8-safe',
    principalId,
    authorizeToolCall: createRemoteToolAuthorizer(authInfo),
  })
}

export function createRuntimeAuthorizationLossHandler(runtime) {
  if (typeof runtime?.suspendPrincipal !== 'function') throw new TypeError('runtime.suspendPrincipal is required')
  return ({ principalId, reason }) => runtime.suspendPrincipal(principalId, reason)
}

/** Principal-filtered adapter for the sidecar's resumable SSE event projection. */
export function createRuntimeRemoteEventSource(runtime) {
  if (!runtime?.events || typeof runtime.getSession !== 'function') throw new TypeError('runtime events are required')
  return {
    async query({ principalId, sessionId, afterSequence = 0, limit = 1000 }) {
      await runtime.getSession(sessionId, principalId)
      return runtime.events.query(sessionId, afterSequence, limit)
    },
    subscribe({ principalId, sessionId, listener }) {
      return runtime.events.subscribe(event => {
        if (event.sessionId === sessionId && event.principalId === principalId) listener(event)
      })
    },
  }
}
