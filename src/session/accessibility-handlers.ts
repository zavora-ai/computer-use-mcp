import type { NativeModule } from '../native.js'
import { ok, okJson, type ToolResult } from '../result.js'
import { lookupToolGuide } from './tool-guide.js'
import type { FocusController } from './focus.js'
import type { SpawnResult } from './spawn.js'
import type { ScriptingDictionary } from './scripting-dictionary.js'
import type { TargetStateController } from './target-state.js'

type DictionaryResult = { dict: ScriptingDictionary } | { error: string }

export interface AccessibilityHandlerContext {
  native: NativeModule
  targets: TargetStateController
  focus: FocusController
  platform?: NodeJS.Platform
  activeProfile: string
  signal?: AbortSignal
  sleep(milliseconds: number): Promise<void>
  runScript(language: string, script: string, timeoutMs: number, signal?: AbortSignal): Promise<SpawnResult>
  getAppDictionary(bundleId: string, suite?: string): Promise<DictionaryResult>
}

function stringArg(args: Record<string, unknown>, key: string): string {
  if (typeof args[key] !== 'string') throw new Error(`Invalid ${key}: expected string`)
  return args[key]
}

function windowId(args: Record<string, unknown>): number {
  if (typeof args.window_id !== 'number' || args.window_id < 0) {
    throw new Error('Invalid window_id: expected number')
  }
  return args.window_id
}

const SENSITIVE_ROLE = /pass(?:word|code)?|secure|credential|one.?time|otp|pin|cvv|cvc/i
const TRUSTED_SENSITIVITY_SIGNALS = new Set([
  'secure_role', 'secure_subrole', 'protected_content', 'uia_is_password',
])

/** Defense-in-depth: protected accessibility values never cross the JS tool boundary. */
export function sanitizeAccessibilityResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAccessibilityResult)
  if (!value || typeof value !== 'object') return value
  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(input)) {
    output[key] = key === 'children' ? sanitizeAccessibilityResult(entry) : entry
  }
  const signals = Array.isArray(input.sensitivitySignals)
    ? input.sensitivitySignals.filter(signal =>
      typeof signal === 'string' && TRUSTED_SENSITIVITY_SIGNALS.has(signal))
    : []
  const sensitive = input.sensitive === true
    || signals.length > 0
    || (typeof input.role === 'string' && SENSITIVE_ROLE.test(input.role))
    || (typeof input.label === 'string' && SENSITIVE_ROLE.test(input.label))
  if (sensitive) output.sensitive = true
  else if (input.sensitive === false) output.sensitive = false
  else delete output.sensitive
  output.sensitivitySignals = signals
  if (sensitive) output.value = null
  return output
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  const current = new Array<number>(right.length + 1)
  for (let i = 1; i <= left.length; i++) {
    current[0] = i
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      )
    }
    for (let j = 0; j <= right.length; j++) previous[j] = current[j]
  }
  return previous[right.length]
}

function similarLabels(
  native: NativeModule,
  targetWindowId: number,
  label: string,
  message: string,
  role?: string,
): ToolResult {
  const target = label.toLowerCase()
  const similar = native.findElement(targetWindowId, role, undefined, undefined, 200)
    .map(element => ({
      element: sanitizeAccessibilityResult(element) as typeof element,
      distance: levenshtein((element.label ?? '').toLowerCase(), target),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 5)
    .map(({ element }) => ({ role: element.role, label: element.label, value: element.value }))
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message, similar }) }],
    isError: true,
  }
}

/** Accessibility, scripting, and capability-advisor handlers. */
export async function handleAccessibilityTool(
  tool: string,
  args: Record<string, unknown>,
  context: AccessibilityHandlerContext,
): Promise<ToolResult | undefined> {
  const native = context.native
  const isWindows = (context.platform ?? process.platform) === 'win32'

  if (tool === 'get_ui_tree') {
    return ok(JSON.stringify(sanitizeAccessibilityResult(native.getUiTree(
      windowId(args), typeof args.max_depth === 'number' ? args.max_depth : undefined,
    ))))
  }
  if (tool === 'get_focused_element') {
    return ok(JSON.stringify(sanitizeAccessibilityResult(native.getFocusedElement())))
  }
  if (tool === 'find_element') {
    const role = typeof args.role === 'string' ? args.role : undefined
    const label = typeof args.label === 'string' ? args.label : undefined
    const value = typeof args.value === 'string' ? args.value : undefined
    if (!role && !label && !value) throw new Error('find_element requires at least one of: role, label, value')
    return ok(JSON.stringify(sanitizeAccessibilityResult(native.findElement(
      windowId(args), role, label, value,
      typeof args.max_results === 'number' ? args.max_results : undefined,
    ))))
  }

  if (['click_element', 'set_value', 'press_button', 'fill_form'].includes(tool)) {
    const target = context.targets.resolve({ window_id: args.window_id })
    if (target.windowId == null) throw new Error(`${tool} requires window_id`)
    await context.focus.ensure(target, context.focus.strategyFor(tool, args))

    if (tool === 'click_element') {
      const role = stringArg(args, 'role')
      const label = stringArg(args, 'label')
      const result = native.performAction(target.windowId, role, label, 'AXPress')
      if (result.performed) {
        context.targets.update(target, 'pointer')
        return ok(`Clicked ${role} "${label}"`)
      }
      if (result.reason === 'unsupported_action' && result.bounds) {
        const x = Math.round(result.bounds.x + result.bounds.width / 2)
        const y = Math.round(result.bounds.y + result.bounds.height / 2)
        native.mouseMove(x, y)
        await context.sleep(50)
        native.mouseClick(x, y, 'left', 1)
        context.targets.update(target, 'pointer')
        return ok(`Clicked ${role} "${label}" via coordinate fallback (${x}, ${y})`)
      }
      if (result.reason === 'disabled') {
        return { content: [{ type: 'text', text: `Element ${role} "${label}" is disabled` }], isError: true }
      }
      return similarLabels(native, target.windowId, label, `No element matches role="${role}" label="${label}"`)
    }

    if (tool === 'set_value') {
      const role = stringArg(args, 'role')
      const label = stringArg(args, 'label')
      const value = stringArg(args, 'value')
      const result = native.setElementValue(target.windowId, role, label, value)
      if (result.set) {
        context.targets.update(target, 'keyboard')
        return ok(`Set ${role} "${label}"`)
      }
      if (result.reason === 'read_only') {
        return { content: [{ type: 'text', text: `Element ${role} "${label}" is read-only` }], isError: true }
      }
      if (result.reason === 'not_found') {
        return similarLabels(native, target.windowId, label, `No element matches role="${role}" label="${label}"`)
      }
      return { content: [{ type: 'text', text: `set_value failed: ${result.reason ?? 'unknown'}` }], isError: true }
    }

    if (tool === 'press_button') {
      const label = stringArg(args, 'label')
      const result = native.performAction(target.windowId, 'AXButton', label, 'AXPress')
      if (result.performed) {
        context.targets.update(target, 'pointer')
        return ok(`Pressed "${label}"`)
      }
      if (result.reason === 'disabled') {
        return { content: [{ type: 'text', text: `Button "${label}" is disabled` }], isError: true }
      }
      return similarLabels(native, target.windowId, label, `No button matches label="${label}"`, 'AXButton')
    }

    const fields = args.fields
    if (!Array.isArray(fields)) throw new Error('fill_form requires fields: array')
    let succeeded = 0
    const failures: Array<{ role: string; label: string; reason: string }> = []
    for (const raw of fields) {
      if (context.signal?.aborted) throw new Error('fill_form aborted before the next field mutation')
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        failures.push({ role: '', label: '', reason: 'invalid_entry' })
        continue
      }
      const field = raw as Record<string, unknown>
      const role = typeof field.role === 'string' ? field.role : ''
      const label = typeof field.label === 'string' ? field.label : ''
      const value = typeof field.value === 'string' ? field.value : ''
      if (!role) failures.push({ role, label, reason: 'invalid_entry' })
      else {
        const result = native.setElementValue(target.windowId, role, label, value)
        if (result.set) succeeded += 1
        else failures.push({ role, label, reason: result.reason ?? 'not_found' })
      }
      await context.sleep(0)
    }
    if (succeeded > 0) context.targets.update(target, 'keyboard')
    return ok(JSON.stringify({ succeeded, failed: failures.length, failures }))
  }

  if (tool === 'select_menu_item') {
    const bundleId = stringArg(args, 'bundle_id')
    const menu = stringArg(args, 'menu')
    const item = stringArg(args, 'item')
    const submenu = typeof args.submenu === 'string' ? args.submenu : undefined
    await context.focus.ensure({ bundleId }, 'strict')
    const result = native.pressMenuItem(bundleId, menu, item, submenu)
    if (result.pressed) {
      context.targets.update({ bundleId }, 'activation')
      return ok(`Selected ${bundleId} → ${menu}${submenu ? ` → ${submenu}` : ''} → ${item}`)
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: result.reason ?? 'menu_item_not_found', bundle_id: bundleId,
        menu, item, submenu, availableMenus: native.getMenuBar(bundleId).map(entry => entry.title),
      }) }],
      isError: true,
    }
  }
  if (tool === 'list_menu_bar') {
    if (isWindows) return { content: [{ type: 'text', text: 'platform_unsupported: list_menu_bar is macOS-only. Use get_ui_tree to discover menu structure on Windows.' }], isError: true }
    return ok(JSON.stringify(native.getMenuBar(stringArg(args, 'bundle_id'))))
  }

  if (tool === 'run_script') {
    const language = isWindows
      ? (args.language === 'powershell' ? 'powershell' : String(args.language ?? 'powershell'))
      : (args.language === 'javascript' ? 'javascript' : 'applescript')
    const requested = typeof args.timeout_ms === 'number' ? args.timeout_ms : 30_000
    const timeoutMs = Math.max(100, Math.min(requested, 120_000))
    const result = await context.runScript(language, stringArg(args, 'script'), timeoutMs, context.signal)
    if (result.timedOut) return { content: [{ type: 'text', text: `script timed out after ${timeoutMs}ms` }], isError: true }
    if (result.code !== 0) return { content: [{ type: 'text', text: (result.stderr || `script exited with code ${result.code}`).trimEnd() }], isError: true }
    return ok(result.stdout.replace(/\n+$/, ''))
  }

  if (tool === 'get_app_dictionary') {
    if (isWindows) return { content: [{ type: 'text', text: 'platform_unsupported: get_app_dictionary is macOS-only. Use get_ui_tree to discover UI structure on Windows.' }], isError: true }
    const result = await context.getAppDictionary(
      stringArg(args, 'bundle_id'), typeof args.suite === 'string' ? args.suite : undefined,
    )
    return 'error' in result
      ? { content: [{ type: 'text', text: result.error }], isError: true }
      : ok(JSON.stringify(result.dict))
  }
  if (tool === 'get_tool_guide') {
    return okJson(lookupToolGuide(
      stringArg(args, 'task_description'), context.activeProfile,
    ) as unknown as Record<string, unknown>)
  }
  if (tool === 'get_app_capabilities') {
    const bundleId = stringArg(args, 'bundle_id')
    const running = native.listRunningApps().find(app => app.bundleId === bundleId)
    const windows = native.listWindows(bundleId)
    if (isWindows) return okJson({
      bundle_id: bundleId, scriptable: false, suites: [], powershell: true,
      accessible: windows.length > 0, topLevelCount: windows.length,
      running: Boolean(running), hidden: running?.isHidden ?? false,
    })
    const dictionary = await context.getAppDictionary(bundleId)
    const scriptable = !('error' in dictionary)
    return okJson({
      bundle_id: bundleId,
      scriptable,
      suites: scriptable ? dictionary.dict.suites.map(suite => suite.name) : [],
      accessible: windows.length > 0,
      topLevelCount: windows.length,
      running: Boolean(running),
      hidden: running?.isHidden ?? false,
    })
  }

  return undefined
}
