import type { ToolResult } from '../result.js'
import { loadNative, type NativeModule, type NativePermissionResult } from '../native.js'
import type { OnboardingConfiguration, OnboardingState } from './manager.js'
import { createSetupViewModel, type SetupViewModel } from './view-model.js'

export type DesktopSetupCommand =
  | { action: 'start' }
  | { action: 'status' | 'diagnose' | 'test_capture' | 'complete'; onboardingId: string }
  | { action: 'show_pointer'; onboardingId: string; coordinate: [number, number] }
  | { action: 'confirm_pointer'; onboardingId: string; confirmed: boolean }
  | { action: 'acknowledge_emergency'; onboardingId: string; confirmed: boolean }
  | { action: 'request_permission'; onboardingId: string; permissionId: NativeRequestablePermission }
  | { action: 'open_permission_settings'; onboardingId: string; permissionId: 'display_capture' | 'accessibility' | 'automation' }
  | { action: 'test_semantic'; onboardingId: string; windowId: number }
  | {
      action: 'configure'
      onboardingId: string
      filesystemRoots: string[]
      allowedAppIds: string[]
      allowScrape: boolean
      persistAudit: boolean
    }

export interface DesktopSetupClient {
  onboarding(action: string, args?: Record<string, unknown>): Promise<ToolResult>
}

export type NativeRequestablePermission = 'display_capture' | 'accessibility'

export interface DesktopSetupOptions {
  openPermissionSettings?(settingsUri: string): Promise<void> | void
  requestPermission?(permission: NativeRequestablePermission): Promise<NativePermissionResult> | NativePermissionResult
  canRequestPermission?(permission: NativeRequestablePermission): boolean
}

/**
 * Build host-only native prompt callbacks. Call this in the trusted Electron,
 * Tauri, or WebView host process; never expose the returned functions directly
 * to renderer code.
 */
export function createNativePermissionHost(
  native: Pick<NativeModule, 'getNativePermissionStatus' | 'requestNativePermission'> = loadNative(),
): Pick<DesktopSetupOptions, 'requestPermission' | 'canRequestPermission'> {
  const requestable = new Set<NativeRequestablePermission>()
  for (const permission of ['display_capture', 'accessibility'] as const) {
    try {
      const status = native.getNativePermissionStatus?.(permission)
      if (status?.permission === permission && status.supported === true && status.canPrompt === true) {
        requestable.add(permission)
      }
    } catch { /* A failed native probe is an unavailable capability. */ }
  }
  if (typeof native.requestNativePermission !== 'function' || requestable.size === 0) return {}
  return {
    canRequestPermission: permission => requestable.has(permission),
    requestPermission: permission => {
      if (!requestable.has(permission)) throw new Error('native permission prompt is unavailable for this permission')
      const result = native.requestNativePermission!(permission)
      if (!result || result.permission !== permission || result.supported !== true
        || result.canPrompt !== true || result.promptRequested !== true) {
        throw new Error('native permission host returned an invalid or unsupported result')
      }
      return result
    },
  }
}

function unpack(result: ToolResult): { state: OnboardingState; configuration?: OnboardingConfiguration } {
  const body = result.structuredContent ?? {}
  if (result.isError) {
    const error = typeof body.error === 'string' ? body.error : 'setup_action_failed'
    throw new Error(error)
  }
  if (!body.onboarding || typeof body.onboarding !== 'object') throw new TypeError('invalid onboarding response')
  return {
    state: body.onboarding as unknown as OnboardingState,
    ...(body.configuration && typeof body.configuration === 'object'
      ? { configuration: body.configuration as unknown as OnboardingConfiguration }
      : {}),
  }
}

function boundedTextList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 100 || !value.every(item => typeof item === 'string' && item.length <= 4096)) {
    throw new TypeError(`${field} must be a bounded string array`)
  }
  return [...value]
}

/** Main-process controller. Only its disclosure-safe view may cross into a renderer. */
export class DesktopSetupController {
  #configuration?: OnboardingConfiguration

  constructor(
    readonly client: DesktopSetupClient,
    readonly options: DesktopSetupOptions = {},
  ) {}

  async dispatch(command: DesktopSetupCommand): Promise<SetupViewModel> {
    if (!command || typeof command !== 'object' || typeof command.action !== 'string') {
      throw new TypeError('invalid setup command')
    }
    const action = command.action
    let args: Record<string, unknown> = {}
    if (action !== 'start') {
      if (!('onboardingId' in command) || typeof command.onboardingId !== 'string' || !command.onboardingId) {
        throw new TypeError('onboardingId is required')
      }
      args.onboarding_id = command.onboardingId
    }
    if (command.action === 'show_pointer') {
      if (!Array.isArray(command.coordinate) || command.coordinate.length !== 2
        || !command.coordinate.every(Number.isFinite)) throw new TypeError('coordinate must be a finite pair')
      args.coordinate = [...command.coordinate]
    } else if (command.action === 'confirm_pointer') {
      if (typeof command.confirmed !== 'boolean') throw new TypeError('confirmed must be boolean')
      args.confirmed_by_user = command.confirmed
    } else if (command.action === 'acknowledge_emergency') {
      if (typeof command.confirmed !== 'boolean') throw new TypeError('confirmed must be boolean')
      args.acknowledged_by_user = command.confirmed
    } else if (command.action === 'request_permission') {
      if (!['display_capture', 'accessibility'].includes(command.permissionId)) {
        throw new TypeError('permissionId is not requestable through a native operating-system prompt')
      }
      if (!this.options.requestPermission || !this.options.canRequestPermission?.(command.permissionId)) {
        throw new Error('trusted host did not configure a supported native permission prompt')
      }
      await this.options.requestPermission(command.permissionId)
      const diagnosed = unpack(await this.client.onboarding('diagnose', args))
      return this.#view(diagnosed.state, diagnosed.configuration)
    } else if (command.action === 'open_permission_settings') {
      if (!['display_capture', 'accessibility', 'automation'].includes(command.permissionId)) {
        throw new TypeError('permissionId is not requestable through operating-system settings')
      }
      if (!this.options.openPermissionSettings) throw new Error('trusted host did not configure a permission-settings opener')
      const status = unpack(await this.client.onboarding('status', args))
      const view = this.#view(status.state, status.configuration)
      const permission = view.permissions.find(item => item.id === command.permissionId)
      if (!permission?.settingsUri) throw new Error('permission does not have an allowlisted settings URI on this platform')
      await this.options.openPermissionSettings(permission.settingsUri)
      return view
    } else if (command.action === 'test_semantic') {
      if (!Number.isInteger(command.windowId) || command.windowId <= 0) throw new TypeError('windowId must be positive')
      args.window_id = command.windowId
    } else if (command.action === 'configure') {
      args = {
        ...args,
        filesystem_roots: boundedTextList(command.filesystemRoots, 'filesystemRoots'),
        allowed_app_ids: boundedTextList(command.allowedAppIds, 'allowedAppIds'),
        allow_scrape: command.allowScrape === true,
        persist_audit: command.persistAudit === true,
      }
    } else if (!['start', 'status', 'diagnose', 'test_capture', 'complete'].includes(action)) {
      throw new TypeError(`unsupported setup action: ${action}`)
    }
    const result = unpack(await this.client.onboarding(action, args))
    if (result.configuration) this.#configuration = result.configuration
    return this.#view(result.state, result.configuration)
  }

  /** Host-only configuration. Never expose this method through renderer IPC. */
  configuration(): OnboardingConfiguration | undefined {
    return this.#configuration ? structuredClone(this.#configuration) : undefined
  }

  #view(state: OnboardingState, configuration?: OnboardingConfiguration): SetupViewModel {
    const view = createSetupViewModel(state, configuration)
    return {
      ...view,
      permissions: view.permissions.map(permission => ({
        ...permission,
        canRequestInProcess: this.#canRequestPermission(permission.id),
        canOpenSettings: Boolean(this.options.openPermissionSettings && permission.settingsUri),
      })),
    }
  }

  #canRequestPermission(permissionId: string): boolean {
    if ((permissionId !== 'display_capture' && permissionId !== 'accessibility')
      || !this.options.requestPermission || !this.options.canRequestPermission) return false
    try { return this.options.canRequestPermission(permissionId) === true } catch { return false }
  }
}
