/**
 * The result contract (7.7.0, K1).
 *
 * Every action reply says what happened, honestly, and every refusal says what to do next, from this one table:
 *
 * - `effect`: `verified` (the result was read back and matches), `changed` (the target visibly changed after the
 *   action, but the intended state was not read back), `no_visible_change` (it looked the same before and after: the
 *   action probably did nothing) or `unverified` (the input was posted and nothing confirms it landed).
 * - `route`: how the action was carried out (`input`, `accessibility`, `window`, `script`, `system`, `clipboard`,
 *   `pointer_overlay`, `batch`), and `delivery` (`hid` or `pid`) for input.
 * - `hint`: what to do now, at most 240 characters.
 * - `next_call`: one call that is always safe to run as is: a read-only tool, never one that changes anything.
 *
 * Competitors converged on this in October 2026 (cua-driver #5493 and #5586, Peekaboo 4.9.5): agents stopped at the
 * first refusal even when a working route existed, and reported success for clicks nothing had confirmed.
 */

import { callMutates, getToolMeta } from '../tool-catalog.js'
import type { ToolResult } from '../result.js'

export type Effect = 'verified' | 'changed' | 'no_visible_change' | 'unverified'
export type Route = 'input' | 'accessibility' | 'window' | 'script' | 'system' | 'clipboard' | 'pointer_overlay' | 'batch'

export interface NextCall {
  tool: string
  arguments: Record<string, unknown>
}

export interface ActionContract {
  effect: Effect
  route: Route
  delivery?: 'hid' | 'pid'
  hint?: string
  next_call?: NextCall
}

export const HINT_MAX = 240

/** Whether a tool can be called in this session (its profile and platform); defaults to every catalog tool. */
export type ToolAvailable = (tool: string) => boolean

/** Tools whose next_call may be suggested: never one that changes anything, and one this session can call. */
function safe(call: NextCall | undefined, available: ToolAvailable = () => true): NextCall | undefined {
  if (!call) return undefined
  const meta = getToolMeta(call.tool)
  return meta && !meta.mutates && available(call.tool) ? call : undefined
}

function clip(text: string): string {
  return text.length <= HINT_MAX ? text : `${text.slice(0, HINT_MAX - 1)}…`
}

const INPUT_TOOLS = new Set([
  'click', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'click_text',
  'mouse_move', 'left_click_drag', 'mouse_drag', 'left_mouse_down', 'left_mouse_up', 'scroll', 'type', 'key', 'hold_key',
  'multi_select', 'multi_edit', 'openai_computer',
])
const ACCESSIBILITY_TOOLS = new Set(['click_element', 'set_value', 'press_button', 'select_menu_item', 'fill_form'])
const WINDOW_TOOLS = new Set([
  'open_application', 'activate_app', 'activate_window', 'hide_app', 'unhide_app', 'resize_window',
  'create_agent_space', 'move_window_to_space', 'remove_window_from_space', 'destroy_space',
])

export function routeFor(tool: string): Route {
  if (INPUT_TOOLS.has(tool)) return 'input'
  if (ACCESSIBILITY_TOOLS.has(tool)) return 'accessibility'
  if (WINDOW_TOOLS.has(tool)) return 'window'
  if (tool === 'run_script') return 'script'
  if (tool === 'write_clipboard') return 'clipboard'
  if (tool === 'agent_pointer') return 'pointer_overlay'
  if (tool === 'run_steps') return 'batch'
  return 'system'
}

/** The window or app a call was aimed at, as arguments for an observation of it. */
export function targetArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.target_window_id === 'number') return { target_window_id: args.target_window_id }
  if (typeof args.window_id === 'number') return { target_window_id: args.window_id }
  if (typeof args.target_app === 'string' && args.target_app) return { target_app: args.target_app }
  return {}
}

/** The cheapest way to see whether an action landed, for this platform. */
export function observeCall(args: Record<string, unknown>, platform: NodeJS.Platform = process.platform): NextCall {
  const target = targetArgs(args)
  if (platform === 'darwin' && Object.keys(target).length) {
    return { tool: 'wait_for_stable', arguments: { ...target, quiet_ms: 300, timeout_ms: 3000 } }
  }
  return { tool: 'screenshot', arguments: target }
}

/** What an action did by default, when its handler did not say more. */
export function defaultContract(tool: string, args: Record<string, unknown>, platform: NodeJS.Platform = process.platform): ActionContract {
  const route = routeFor(tool)
  switch (route) {
    case 'input':
      return {
        effect: 'unverified', route, delivery: args.delivery === 'pid' ? 'pid' : 'hid',
        hint: 'The input was posted; nothing confirms it landed. Look before relying on it: a screenshot (a region is cheapest) or a wait.',
        next_call: observeCall(args, platform),
      }
    case 'accessibility':
      return {
        effect: 'unverified', route,
        hint: 'The control accepted the action; its effect was not read back. Check the result before the next step.',
        next_call: observeCall(args, platform),
      }
    case 'clipboard':
      return { effect: 'verified', route }
    case 'pointer_overlay':
      return { effect: 'verified', route }
    case 'script':
      return {
        effect: 'unverified', route,
        hint: 'The script ran; its output above is the only evidence of what it did. Check the app if it changed state.',
      }
    case 'window':
      return { effect: 'unverified', route, next_call: { tool: 'get_frontmost_app', arguments: {} } }
    case 'batch':
      return { effect: 'unverified', route }
    default:
      return { effect: tool === 'filesystem' || tool === 'registry' ? 'verified' : 'unverified', route }
  }
}

// ── Refusals ────────────────────────────────────────────────────────────────

interface RefusalAdvice {
  hint: string
  next?: (args: Record<string, unknown>, tool: string, payload: Record<string, unknown>) => NextCall | undefined
}

const wait = (seconds: number): NextCall => ({ tool: 'wait', arguments: { duration: seconds } })
const controlStatus: NextCall = { tool: 'control_status', arguments: {} }

/** One table: every refusal code the server returns, with what to do and one safe call to make. */
export const REFUSALS: Readonly<Record<string, RefusalAdvice>> = {
  user_active: {
    hint: 'The person is using the keyboard or mouse; the call was refused, not queued. Wait a moment and retry, use delivery "pid" where supported, or ask them. Never force it unless they asked.',
    next: () => wait(2),
  },
  paused_by_user: {
    hint: 'The person paused the agent from the status card. Observation still works; wait and retry, or report what you have.',
    next: () => controlStatus,
  },
  stopped_by_user: {
    hint: 'The person stopped the agent. Nothing that changes the desktop runs again in this session: report what you have and finish.',
    next: () => controlStatus,
  },
  taken_over: {
    hint: 'The person took over the mouse or keyboard. Wait until control_status says running again, then look before acting.',
    next: () => controlStatus,
  },
  status_card_protected: {
    hint: 'That point is on the status card the person uses to pause or stop the agent. Never press it; aim elsewhere.',
    next: () => controlStatus,
  },
  card_mask_unavailable: {
    hint: 'The status card could not be masked out of the capture, so it was withheld. Report it; the person can rebuild or turn the card off.',
    next: () => controlStatus,
  },
  emergency_stop_active: {
    hint: 'The emergency stop is latched; nothing that changes the desktop runs until the host resets it. Report and finish.',
    next: () => controlStatus,
  },
  screen_locked: {
    hint: 'The screen is locked, so input and captures go nowhere. Ask the person to unlock it; do not try to type a password.',
    next: () => controlStatus,
  },
  session_disconnected: {
    hint: 'The Remote Desktop session is disconnected; input and captures go nowhere until someone reconnects. Report it.',
    next: () => controlStatus,
  },
  secure_desktop: {
    hint: 'A UAC prompt or the sign-in screen has the input, and Windows keeps other processes out of it. Ask the person to answer it.',
    next: () => wait(3),
  },
  input_blocked: {
    hint: 'Windows blocked the input: the foreground window is elevated (administrator) or protected. Use accessibility tools, run elevated, or ask the person.',
    next: () => ({ tool: 'get_frontmost_app', arguments: {} }),
  },
  focus_failed: {
    hint: 'The target could not be brought to the front. Follow suggestedRecovery (activate_window, unhide_app or open_application), or use delivery "pid".',
    next: (_args, _tool, payload) => {
      const bundle = typeof payload.requestedBundleId === 'string' && payload.requestedBundleId ? payload.requestedBundleId : undefined
      return { tool: 'list_windows', arguments: bundle ? { bundle_id: bundle } : {} }
    },
  },
  window_not_found: {
    hint: 'That window is gone or the id is wrong. List the windows and pick it again.',
    next: (args) => ({ tool: 'list_windows', arguments: typeof args.target_app === 'string' ? { bundle_id: args.target_app } : {} }),
  },
  window_minimized: {
    hint: 'The window is minimised, so there is nothing on screen to capture or click. Restore it with activate_window or unhide_app.',
    next: (args) => ({ tool: 'list_windows', arguments: typeof args.target_app === 'string' ? { bundle_id: args.target_app } : {} }),
  },
  app_not_found: {
    hint: 'No running app matches. Find its id, then open it.',
    next: (args) => ({ tool: 'discover_applications', arguments: typeof args.bundle_id === 'string' ? { query: args.bundle_id } : {} }),
  },
  activation_failed: {
    hint: 'The app or window did not come to the front. It may be hidden, still launching, or behind a dialog: look at what is in front, then retry or unhide it.',
    next: () => ({ tool: 'get_frontmost_app', arguments: {} }),
  },
  not_activated: {
    hint: 'The app did not come to the front. It may be hidden, launching, or behind a dialog; check, then activate it again.',
    next: () => ({ tool: 'get_frontmost_app', arguments: {} }),
  },
  approval_required: {
    hint: 'A person must approve this call (the host asks them, or a configured approval token goes in _meta). Ask them; do not retry unchanged.',
    next: () => ({ tool: 'policy_status', arguments: {} }),
  },
  policy_denied: {
    hint: 'Policy forbids this action or target. Choose another route, or ask the person to change the policy.',
    next: () => ({ tool: 'policy_status', arguments: {} }),
  },
  locked_by_pid: {
    hint: 'Another computer-use server holds the desktop lock. Wait for it, or stop that session.',
    next: () => wait(2),
  },
  invalid_arguments: {
    hint: 'The arguments do not match the tool\'s schema; the errors name each path. Fix them and call again.',
    next: (_args, tool) => ({ tool: 'get_tool_metadata', arguments: { tool_name: tool } }),
  },
  platform_unsupported: {
    hint: 'This platform cannot do that. Follow remediation, or ask get_tool_guide for the route that works here.',
    next: (_args, tool) => ({ tool: 'get_tool_guide', arguments: { task: tool.replace(/_/g, ' ') } }),
  },
  pid_delivery_unsupported: {
    hint: 'Background (pid) delivery is not available for this tool or platform. Use delivery "hid" with the target focused.',
    next: () => ({ tool: 'get_target', arguments: {} }),
  },
  pid_target_missing: {
    hint: 'Background delivery needs a running target: pass target_app or target_window_id, or set_target first.',
    next: () => ({ tool: 'get_target', arguments: {} }),
  },
  native_capability_missing: {
    hint: 'The native module predates this capability. Rebuild it (npm run build:native) or reinstall the package.',
    next: () => ({ tool: 'doctor', arguments: { include_remediation: true } }),
  },
  accessibility_permission_denied: {
    hint: 'The host app lacks the Accessibility permission (Device Control and Data Access on macOS 27), so macOS discards its input. The person grants it in System Settings, then restarts the host.',
    next: () => ({ tool: 'doctor', arguments: { include_remediation: true } }),
  },
  helper_busy: {
    hint: 'Another capture is running; this one gave up waiting. Retry in a moment.',
    next: () => wait(1),
  },
  helper_timeout: {
    hint: 'The capture helper did not answer in time and was stopped. Retry once; if it repeats, run doctor.',
    next: () => ({ tool: 'doctor', arguments: { include_remediation: true } }),
  },
  element_not_found: {
    hint: 'No control matched. Use similarLabels if offered, or look at the tree (find_element with a looser label) before trying coordinates.',
    next: (args) => typeof args.window_id === 'number' ? { tool: 'get_ui_tree', arguments: { window_id: args.window_id, max_depth: 6 } } : undefined,
  },
  outside_display: {
    hint: 'Those coordinates are not on any display. Take a screenshot and map the point again with the mapping it states.',
    next: (args) => ({ tool: 'screenshot', arguments: targetArgs(args) }),
  },
  step_failed: {
    hint: 'A run_steps step failed; the steps before it ran. Look at the current state, then continue from the failed step.',
    next: (args) => ({ tool: 'screenshot', arguments: targetArgs(args) }),
  },
  aborted: {
    hint: 'The call was cancelled before it finished (the person paused or stopped, or the host cancelled). Look before retrying.',
    next: () => controlStatus,
  },
  tool_failed: {
    hint: 'The tool failed; the message says why. Look at the current state before retrying a different way.',
    next: (args, tool) => (getToolMeta(tool)?.mutates ? { tool: 'screenshot', arguments: targetArgs(args) } : undefined),
  },
}

/** Native and handler errors that carry a code: `window_minimized: …`, `EmergencyStop: …`. */
export function classifyError(message: string): { code: string; message: string } {
  const prefixed = /^([a-z][a-z0-9_]{2,40}):\s*(.*)$/s.exec(message)
  if (prefixed && REFUSALS[prefixed[1]]) return { code: prefixed[1], message: prefixed[2] }
  if (/^EmergencyStop:/i.test(message)) return { code: 'emergency_stop_active', message }
  if (/accessibility_permission_denied/.test(message)) return { code: 'accessibility_permission_denied', message }
  if (/outside display bounds/i.test(message)) return { code: 'outside_display', message }
  if (/\baborted\b|AbortError|paused by|stopped by|Desktop session closed/i.test(message)) return { code: 'aborted', message }
  if (/^Invalid [a-z_]+:/.test(message)) return { code: 'invalid_arguments', message }
  return { code: 'tool_failed', message }
}

/** A structured refusal for a thrown error, with the table's advice. */
export function errorResult(tool: string, args: Record<string, unknown>, error: unknown, available?: ToolAvailable): ToolResult {
  const raw = error instanceof Error ? error.message : String(error)
  const { code, message } = classifyError(raw)
  return withRefusalAdvice(tool, args, {
    content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
    structuredContent: { error: code, message },
    isError: true,
  }, available)
}

function firstJson(result: ToolResult): Record<string, unknown> | undefined {
  if (result.structuredContent) return result.structuredContent
  const first = result.content[0]
  if (first?.type !== 'text') return undefined
  try {
    const parsed = JSON.parse(first.text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch { return undefined }
}

/**
 * Add a JSON block after a plain-text reply: merged into a trailing JSON block when there is one (prepare_display's
 * hiddenBundleIds), so a reply never ends in two. Returns the content, the merged block and the text before it.
 */
function appendJsonBlock(result: ToolResult, block: Record<string, unknown>): {
  content: ToolResult['content']; merged: Record<string, unknown>; message: string
} {
  const last = result.content.length > 1 ? result.content[result.content.length - 1] : undefined
  let trailing: Record<string, unknown> | undefined
  if (last?.type === 'text') {
    try {
      const parsed = JSON.parse(last.text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) trailing = parsed
    } catch { /* plain text */ }
  }
  const before = trailing ? result.content.slice(0, -1) : result.content
  const message = before.filter(entry => entry.type === 'text').map(entry => (entry as { text: string }).text).join('\n')
  const merged = { ...(trailing ?? {}), ...block }
  return { content: [...before, { type: 'text' as const, text: JSON.stringify(merged) }], merged, message }
}

/** Rewrite a JSON reply with extra fields, keeping its text and structuredContent identical. */
function rewriteJson(result: ToolResult, payload: Record<string, unknown>): ToolResult {
  const text = JSON.stringify(payload)
  const [first, ...rest] = result.content
  const content = first?.type === 'text' ? [{ type: 'text' as const, text }, ...rest] : [{ type: 'text' as const, text }, ...result.content]
  return { ...result, content, structuredContent: payload }
}

/** Add the table's hint and next_call to a refusal, unless it already carries its own. */
export function withRefusalAdvice(tool: string, args: Record<string, unknown>, result: ToolResult, available?: ToolAvailable): ToolResult {
  const payload = firstJson(result)
  if (!payload) {
    // A plain-text refusal (a script's stderr, a thrown error) keeps its text first and gains the advice after it.
    const first = result.content.find(block => block.type === 'text')
    const { code } = classifyError(first && first.type === 'text' ? first.text.replace(/^Error:\s*/, '') : '')
    const advice = REFUSALS[code] ?? REFUSALS.tool_failed
    const next = safe(advice.next?.(args, tool, {}), available)
    const { content, merged, message } = appendJsonBlock(result, { error: code, hint: clip(advice.hint), ...(next ? { next_call: next } : {}) })
    return { ...result, content, structuredContent: { ...merged, message } }
  }
  const code = typeof payload.error === 'string' ? payload.error : 'tool_failed'
  const advice = REFUSALS[code] ?? REFUSALS.tool_failed
  const next = payload.next_call === undefined ? safe(advice.next?.(args, tool, payload), available) : undefined
  return rewriteJson(result, {
    ...payload,
    error: code,
    ...(payload.hint === undefined ? { hint: clip(advice.hint) } : {}),
    ...(next ? { next_call: next } : {}),
  })
}

/**
 * Decorate a dispatch result: the contract on every successful action, advice on every refusal. Read-only tools'
 * successes are left alone.
 */
export function applyContract(
  tool: string,
  args: Record<string, unknown>,
  result: ToolResult,
  platform: NodeJS.Platform = process.platform,
  available?: ToolAvailable,
): ToolResult {
  const { contract: given, ...rest } = result
  if (result.isError) return withRefusalAdvice(tool, args, rest, available)
  if (!callMutates(tool, args) && tool !== 'run_steps') return rest
  const base = defaultContract(tool, args, platform)
  const contract: ActionContract = { ...base, ...given }
  if (contract.effect === 'verified') {
    delete contract.hint
    delete contract.next_call
  } else if (given?.effect && given.effect !== base.effect && !given.hint) {
    contract.hint = EFFECT_HINTS[contract.effect] ?? base.hint
  }
  if (contract.hint) contract.hint = clip(contract.hint)
  const next = safe(contract.next_call, available)
  if (next) contract.next_call = next
  else delete contract.next_call
  const payload = firstJson(rest)
  if (payload && !Array.isArray(payload)) return rewriteJson(rest, { ...payload, ...contract })
  // A plain-text reply keeps its text first; the contract follows as a JSON block and as structuredContent.
  const { content, merged, message } = appendJsonBlock(rest, { ...contract })
  return { ...rest, content, structuredContent: { message, ...merged } }
}

const EFFECT_HINTS: Partial<Record<Effect, string>> = {
  changed: 'The target changed after the action; that it changed the way you meant was not read back. Look before the next step.',
  no_visible_change: 'The target looked the same before and after: the action probably did nothing (wrong spot, a dialog, or the app ignores this input). Look, then try another route.',
}
