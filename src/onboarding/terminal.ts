import type { ToolResult } from '../result.js'
import type { OnboardingConfiguration, OnboardingState } from './manager.js'
import { createSetupViewModel } from './view-model.js'

export interface TerminalOnboardingClient {
  onboarding(action: string, args?: Record<string, unknown>): Promise<ToolResult>
}

export interface TerminalOnboardingIo {
  write(message: string): void | Promise<void>
  prompt(message: string, defaultValue?: string): Promise<string>
  confirm(message: string, defaultValue?: boolean): Promise<boolean>
}

export interface TerminalOnboardingOptions {
  onboardingId?: string
  nonInteractive?: boolean
  pointerCoordinate?: [number, number]
  pointerConfirmed?: boolean
  emergencyStopAcknowledged?: boolean
  windowId?: number
  filesystemRoots?: string[]
  allowedAppIds?: string[]
  allowScrape?: boolean
  persistAudit?: boolean
}

export interface TerminalOnboardingResult {
  state: OnboardingState
  configuration: OnboardingConfiguration
}

function response(result: ToolResult): { state: OnboardingState; configuration?: OnboardingConfiguration } {
  const body = result.structuredContent ?? (() => {
    const text = result.content.find(item => item.type === 'text')
    if (!text || text.type !== 'text') return {}
    try { return JSON.parse(text.text) as Record<string, unknown> } catch { return {} }
  })()
  if (result.isError) throw new Error(`onboarding failed: ${JSON.stringify(body)}`)
  if (!body.onboarding || typeof body.onboarding !== 'object') throw new TypeError('onboarding response is missing state')
  return {
    state: body.onboarding as unknown as OnboardingState,
    ...(body.configuration && typeof body.configuration === 'object'
      ? { configuration: body.configuration as unknown as OnboardingConfiguration }
      : {}),
  }
}

function csv(value: string): string[] {
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

/** Complete or resume setup without writing configuration or persisting observation bytes. */
export async function runTerminalOnboarding(
  client: TerminalOnboardingClient,
  io: TerminalOnboardingIo,
  options: TerminalOnboardingOptions = {},
): Promise<TerminalOnboardingResult> {
  const call = async (action: string, args: Record<string, unknown> = {}) =>
    response(await client.onboarding(action, args))
  let current = options.onboardingId
    ? await call('status', { onboarding_id: options.onboardingId })
    : await call('start')
  const id = current.state.onboardingId
  await io.write(`Onboarding ${id} · ${current.state.stage}`)
  if (current.state.stage === 'completed') {
    if (!current.configuration) {
      current = await call('status', { onboarding_id: id })
    }
    if (!current.configuration) throw new Error('completed onboarding response is missing configuration')
    return { state: current.state, configuration: current.configuration }
  }

  if (!current.state.checks.doctor) current = await call('diagnose', { onboarding_id: id })
  for (const permission of current.state.checks.permissions?.entries ?? []) {
    if (permission.status === 'pass' || permission.status === 'skip') continue
    await io.write(`Permission ${permission.label}: ${permission.status}. ${permission.remediation}`)
  }
  if (!current.state.checks.capture) current = await call('test_capture', { onboarding_id: id })
  if (!current.state.checks.pointer?.shown) {
    current = await call('show_pointer', {
      onboarding_id: id, coordinate: options.pointerCoordinate ?? [200, 120],
    })
  }
  if (!current.state.checks.pointer?.tested) {
    if (options.nonInteractive && options.pointerConfirmed === undefined) {
      throw new Error('non-interactive onboarding requires pointerConfirmed')
    }
    const confirmed = options.pointerConfirmed
      ?? await io.confirm('Can you see the virtual agent pointer?', true)
    current = await call('confirm_pointer', { onboarding_id: id, confirmed_by_user: confirmed })
  }
  if (!current.state.checks.semantic) {
    let windowId = options.windowId
    if (windowId === undefined) {
      if (options.nonInteractive) throw new Error('non-interactive onboarding requires windowId')
      const answer = await io.prompt('Window ID for the accessibility read-only test')
      windowId = Number(answer)
    }
    if (!Number.isInteger(windowId) || Number(windowId) <= 0) throw new TypeError('windowId must be a positive integer')
    current = await call('test_semantic', { onboarding_id: id, window_id: windowId })
  }
  if (!current.state.checks.emergency?.acknowledgedByUser) {
    const presented = await call('acknowledge_emergency', {
      onboarding_id: id, acknowledged_by_user: false,
    })
    const emergency = presented.state.checks.emergency!
    await io.write(emergency.physicalChordSupported
      ? `Emergency stop: ${emergency.chord} (${emergency.backend}, physical input only)`
      : `Physical emergency chord unavailable on this platform (${emergency.backend}); host/API stop remains available.`)
    if (options.nonInteractive && options.emergencyStopAcknowledged !== true) {
      throw new Error('non-interactive onboarding requires emergencyStopAcknowledged=true')
    }
    const acknowledged = options.emergencyStopAcknowledged
      ?? await io.confirm('Do you understand how to stop all computer-use mutation?', false)
    if (!acknowledged) throw new Error('emergency-stop acknowledgment is required')
    current = await call('acknowledge_emergency', {
      onboarding_id: id, acknowledged_by_user: true,
    })
  }
  if (!current.state.profile) {
    const filesystemRoots = options.filesystemRoots ?? (options.nonInteractive
      ? [] : csv(await io.prompt('Allowed filesystem roots (comma-separated absolute paths)', '')))
    const allowedAppIds = options.allowedAppIds ?? (options.nonInteractive
      ? [] : csv(await io.prompt('Allowed application IDs (comma-separated)', '')))
    const allowScrape = options.allowScrape ?? (options.nonInteractive
      ? false : await io.confirm('Allow open-world scrape?', false))
    const persistAudit = options.persistAudit ?? (options.nonInteractive
      ? true : await io.confirm('Enable audit logging?', true))
    current = await call('configure', {
      onboarding_id: id,
      filesystem_roots: filesystemRoots,
      allowed_app_ids: allowedAppIds,
      allow_scrape: allowScrape,
      persist_audit: persistAudit,
    })
  }
  current = await call('complete', { onboarding_id: id })
  if (!current.configuration) throw new Error('completed onboarding response is missing configuration')
  const view = createSetupViewModel(current.state, current.configuration)
  await io.write(`Setup ${view.progress}% · restart required`)
  for (const [key, value] of Object.entries(current.configuration.environment).sort(([a], [b]) => a.localeCompare(b))) {
    await io.write(`${key}=${JSON.stringify(value)}`)
  }
  return { state: current.state, configuration: current.configuration }
}
