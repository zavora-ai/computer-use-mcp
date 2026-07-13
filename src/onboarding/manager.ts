import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ToolResult } from '../result.js'
import type { Session } from '../session.js'

export type OnboardingStage =
  | 'created'
  | 'diagnosed'
  | 'capture_tested'
  | 'pointer_tested'
  | 'semantic_tested'
  | 'emergency_acknowledged'
  | 'configured'
  | 'completed'

export interface OnboardingEmergencyCapability {
  chord: string
  backend: string
  physicalChordSupported: boolean
  physicalOnly: boolean
}

export type OnboardingPermissionStatus = 'pass' | 'warn' | 'fail' | 'skip' | 'unknown'

export interface OnboardingPermissionGuidance {
  id: 'display_capture' | 'accessibility' | 'ui_automation' | 'automation'
  label: string
  status: OnboardingPermissionStatus
  required: boolean
  canRequestInProcess: false
  remediation: string
  settingsUri?: string
}

export interface OnboardingProfile {
  filesystemRoots: string[]
  allowedAppIds: string[]
  allowScrape: boolean
  persistAudit: boolean
  captureSupported: boolean
  semanticSupported: boolean
  virtualPointerSupported: boolean
  emergencyStopChord: string
  physicalEmergencyStopSupported: boolean
  platform: NodeJS.Platform
  completedAt?: string
}

export interface OnboardingConfiguration {
  restartRequired: true
  environment: Record<string, string>
}

/** Render the completed profile into the existing environment contract. */
export function configurationForOnboardingProfile(profile: OnboardingProfile): OnboardingConfiguration {
  const environment: Record<string, string> = {
    COMPUTER_USE_V8: 'true',
    COMPUTER_USE_ACTIVE_PROFILE: 'v8-safe',
    COMPUTER_USE_V8_ALLOW_SCRAPE: String(profile.allowScrape),
    COMPUTER_USE_AUDIT_LOG: profile.persistAudit ? 'true' : 'false',
  }
  if (profile.filesystemRoots.length) environment.COMPUTER_USE_FS_ROOTS = profile.filesystemRoots.join(',')
  if (profile.allowedAppIds.length) environment.COMPUTER_USE_ALLOWED_APPS = profile.allowedAppIds.join(',')
  if (profile.emergencyStopChord) environment.COMPUTER_USE_EMERGENCY_STOP_CHORD = profile.emergencyStopChord
  return { restartRequired: true, environment }
}

export interface OnboardingState {
  onboardingId: string
  principalId: string
  stage: OnboardingStage
  revision: number
  createdAt: string
  updatedAt: string
  checks: {
    doctor?: { passed: boolean; failedChecks: number; warningChecks: number }
    permissions?: { inspected: true; entries: OnboardingPermissionGuidance[] }
    capture?: { tested: true; passed: boolean; mimeType?: string }
    pointer?: { shown: true; tested: boolean; passed: boolean; confirmedByUser: boolean }
    semantic?: { tested: true; passed: boolean; windowId: number }
    emergency?: OnboardingEmergencyCapability & { presented: true; acknowledgedByUser: boolean }
  }
  profile?: OnboardingProfile
}

export interface OnboardingStore {
  compareAndSet(state: OnboardingState, expectedRevision: number): Promise<boolean>
  get(onboardingId: string): Promise<OnboardingState | undefined>
}

export class MemoryOnboardingStore implements OnboardingStore {
  readonly #states = new Map<string, OnboardingState>()
  async compareAndSet(state: OnboardingState, expectedRevision: number): Promise<boolean> {
    if ((this.#states.get(state.onboardingId)?.revision ?? 0) !== expectedRevision) return false
    this.#states.set(state.onboardingId, structuredClone(state))
    return true
  }
  async get(id: string): Promise<OnboardingState | undefined> {
    const state = this.#states.get(id)
    return state ? structuredClone(state) : undefined
  }
}

export class FileOnboardingStore implements OnboardingStore {
  constructor(readonly directory: string) {
    if (!directory) throw new TypeError('onboarding directory is required')
  }

  async compareAndSet(state: OnboardingState, expectedRevision: number): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const path = this.#path(state.onboardingId)
    const lockPath = `${path}.lock`
    let lock
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        lock = await open(lockPath, 'wx', 0o600)
        try { await lock.writeFile(String(process.pid)); await lock.sync() }
        catch (error) {
          await lock.close()
          lock = undefined
          await rm(lockPath, { force: true })
          throw error
        }
        break
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const raw = await readFile(lockPath, 'utf8')
          const pid = Number.parseInt(raw, 10)
          let alive = false
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); alive = true }
            catch (probe) { alive = (probe as NodeJS.ErrnoException).code === 'EPERM' }
          }
          const old = Date.now() - (await stat(lockPath)).mtimeMs > 30_000
          if (!alive && (raw.trim().length > 0 || old)) await rm(lockPath, { force: true })
        } catch { /* owner may have released between probes */ }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    if (!lock) throw new Error('timed out acquiring onboarding revision lock')
    try {
      const current = await this.get(state.onboardingId)
      if ((current?.revision ?? 0) !== expectedRevision) return false
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
      const handle = await open(temporary, 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(state)); await handle.sync() } finally { await handle.close() }
      await rename(temporary, path)
      try {
        const directory = await open(this.directory, 'r')
        try { await directory.sync() } finally { await directory.close() }
      } catch { /* directory fsync is not supported on every Windows filesystem */ }
      return true
    } finally {
      await lock.close()
      await rm(lockPath, { force: true })
    }
  }

  async get(id: string): Promise<OnboardingState | undefined> {
    try { return JSON.parse(await readFile(this.#path(id), 'utf8')) as OnboardingState }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  #path(id: string): string {
    return join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`)
  }
}

function payload(result: ToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent
  const text = result.content.find(item => item.type === 'text')
  if (!text || text.type !== 'text') return {}
  try { return JSON.parse(text.text) as Record<string, unknown> } catch { return {} }
}

function countDoctor(value: unknown): { failed: number; warnings: number } {
  let failed = 0
  let warnings = 0
  const visit = (entry: unknown) => {
    if (Array.isArray(entry)) return entry.forEach(visit)
    if (!entry || typeof entry !== 'object') return
    const record = entry as Record<string, unknown>
    if (record.status === 'fail' || record.ok === false) failed++
    if (record.status === 'warning' || record.status === 'warn') warnings++
    Object.values(record).forEach(visit)
  }
  visit(value)
  return { failed, warnings }
}

const permissionDefinitions = (platform: NodeJS.Platform): Array<Omit<OnboardingPermissionGuidance, 'status'>> => platform === 'darwin'
  ? [
      {
        id: 'display_capture', label: 'Screen & System Audio Recording', required: true,
        canRequestInProcess: false,
        remediation: 'Enable the terminal, IDE, or agent host in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the host.',
        settingsUri: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      },
      {
        id: 'accessibility', label: 'Accessibility', required: true,
        canRequestInProcess: false,
        remediation: 'Enable the terminal, IDE, or agent host in System Settings > Privacy & Security > Accessibility, then restart the host.',
        settingsUri: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      },
      {
        id: 'automation', label: 'Automation', required: false,
        canRequestInProcess: false,
        remediation: 'Allow the terminal, IDE, or agent host to control System Events and selected target apps when macOS prompts.',
        settingsUri: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
      },
    ]
  : platform === 'win32'
    ? [
        {
          id: 'display_capture', label: 'Interactive display capture', required: true,
          canRequestInProcess: false,
          remediation: 'Run the host in an unlocked interactive desktop session; verify Desktop Duplication or GDI capture is available for RDP and VM sessions.',
        },
        {
          id: 'ui_automation', label: 'UI Automation integrity', required: true,
          canRequestInProcess: false,
          remediation: 'Run the host at the same integrity level as the target application; elevation boundaries intentionally fail closed.',
        },
      ]
    : [
        {
          id: 'display_capture', label: 'Desktop capture portal', required: true,
          canRequestInProcess: false,
          remediation: 'Grant the desktop capture/input portal requested by the active X11 or Wayland compositor and keep the session unlocked.',
        },
      ]

export function sanitizeOnboardingPermissionGuidance(
  entries: unknown,
  platform: NodeJS.Platform = process.platform,
): OnboardingPermissionGuidance[] {
  const checks = Array.isArray(entries) ? entries : []
  const statuses = new Map<string, OnboardingPermissionStatus>()
  for (const check of checks) {
    if (!check || typeof check !== 'object') continue
    const record = check as Record<string, unknown>
    if (typeof record.id !== 'string' || !['pass', 'warn', 'fail', 'skip'].includes(String(record.status))) continue
    statuses.set(record.id, record.status as OnboardingPermissionStatus)
  }
  return permissionDefinitions(platform).map(definition => ({
    ...definition, status: statuses.get(definition.id) ?? 'unknown',
  }))
}

function projectPermissionGuidance(value: unknown, platform: NodeJS.Platform): OnboardingPermissionGuidance[] {
  const checks = value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).checks)
    ? (value as { checks: unknown[] }).checks : []
  return sanitizeOnboardingPermissionGuidance(checks, platform)
}

/** Resumable host-neutral onboarding. Screenshot bytes are inspected in memory and discarded. */
export class OnboardingManager {
  constructor(
    readonly session: Session,
    readonly store: OnboardingStore = new MemoryOnboardingStore(),
    readonly now: () => Date = () => new Date(),
    readonly emergencyCapability: () => OnboardingEmergencyCapability = () => ({
      chord: process.env.COMPUTER_USE_EMERGENCY_STOP_CHORD ?? 'ctrl+alt+shift+escape',
      backend: 'unavailable',
      physicalChordSupported: false,
      physicalOnly: false,
    }),
  ) {}

  async start(principalId: string): Promise<OnboardingState> {
    const at = this.now().toISOString()
    const state: OnboardingState = {
      onboardingId: randomUUID(), principalId, stage: 'created', revision: 1,
      createdAt: at, updatedAt: at, checks: {},
    }
    if (!await this.store.compareAndSet(state, 0)) throw new Error('onboarding session ID collision')
    return state
  }

  async get(id: string, principalId: string): Promise<OnboardingState> {
    const state = await this.store.get(id)
    if (!state) throw new Error('onboarding session not found')
    if (state.principalId !== principalId) throw new Error('onboarding session belongs to another principal')
    return state
  }

  async diagnose(id: string, principalId: string): Promise<OnboardingState> {
    const state = await this.get(id, principalId)
    const result = await this.session.dispatch('doctor', { include_remediation: true })
    const doctorPayload = payload(result)
    const counts = countDoctor(doctorPayload)
    return this.#update(state, {
      checks: { ...state.checks, doctor: {
        passed: !result.isError && counts.failed === 0,
        failedChecks: counts.failed, warningChecks: counts.warnings,
      }, permissions: {
        inspected: true, entries: projectPermissionGuidance(doctorPayload, process.platform),
      } },
    })
  }

  async testCapture(id: string, principalId: string): Promise<OnboardingState> {
    const state = await this.get(id, principalId)
    const result = await this.session.dispatch('screenshot', { width: 640, quality: 70 })
    const image = result.content.find(item => item.type === 'image')
    return this.#update(state, {
      checks: { ...state.checks, capture: {
        tested: true, passed: !result.isError && Boolean(image),
        ...(image?.type === 'image' ? { mimeType: image.mimeType } : {}),
      } },
    })
  }

  async testPointer(
    id: string,
    principalId: string,
    coordinate: [number, number],
    confirmedByUser: boolean,
  ): Promise<OnboardingState> {
    const state = await this.get(id, principalId)
    const result = await this.session.dispatch('agent_pointer', {
      action: 'move', coordinate, visible: true, native_overlay: true,
    })
    if (confirmedByUser) await this.session.dispatch('agent_pointer', { action: 'hide', native_overlay: true })
    return this.#update(state, {
      checks: { ...state.checks, pointer: {
        shown: true, tested: true, passed: !result.isError && confirmedByUser, confirmedByUser,
      } },
    })
  }

  async showPointer(
    id: string,
    principalId: string,
    coordinate: [number, number],
  ): Promise<OnboardingState> {
    const state = await this.get(id, principalId)
    const result = await this.session.dispatch('agent_pointer', {
      action: 'move', coordinate, visible: true, native_overlay: true,
    })
    return this.#update(state, {
      checks: { ...state.checks, pointer: {
        shown: true, tested: false, passed: false, confirmedByUser: false,
        ...(!result.isError ? {} : { passed: false }),
      } },
    })
  }

  async confirmPointer(
    id: string,
    principalId: string,
    confirmedByUser: boolean,
  ): Promise<OnboardingState> {
    const state = await this.get(id, principalId)
    if (!state.checks.pointer?.shown) throw new Error('show the virtual pointer before confirming it')
    const result = await this.session.dispatch('agent_pointer', { action: 'hide', native_overlay: true })
    return this.#update(state, {
      checks: { ...state.checks, pointer: {
        shown: true, tested: true,
        passed: !result.isError && confirmedByUser,
        confirmedByUser,
      } },
    })
  }

  async testSemantic(id: string, principalId: string, windowId: number): Promise<OnboardingState> {
    const state = await this.get(id, principalId)
    const result = await this.session.dispatch('get_ui_tree', { window_id: windowId, max_depth: 3 })
    const value = payload(result)
    const passed = !result.isError && Object.keys(value).length > 0
    return this.#update(state, {
      checks: { ...state.checks, semantic: { tested: true, passed, windowId } },
    })
  }

  async acknowledgeEmergencyStop(
    id: string,
    principalId: string,
    acknowledgedByUser: boolean,
  ): Promise<OnboardingState> {
    const state = await this.get(id, principalId)
    if (acknowledgedByUser && !state.checks.emergency?.presented) {
      throw new Error('present the emergency-stop capability before recording acknowledgment')
    }
    const capability = this.emergencyCapability()
    if (typeof capability.chord !== 'string' || capability.chord.length < 3 || capability.chord.length > 128
      || /[\u0000-\u001f\u007f]/.test(capability.chord)) throw new Error('invalid emergency-stop chord capability')
    if (typeof capability.backend !== 'string' || !capability.backend || capability.backend.length > 128) {
      throw new Error('invalid emergency-stop backend capability')
    }
    return this.#update(state, {
      checks: { ...state.checks, emergency: {
        ...structuredClone(capability), presented: true, acknowledgedByUser,
      } },
    })
  }

  async configure(id: string, principalId: string, profile: Omit<OnboardingProfile,
    'captureSupported' | 'semanticSupported' | 'virtualPointerSupported' | 'emergencyStopChord'
    | 'physicalEmergencyStopSupported' | 'platform' | 'completedAt'>): Promise<OnboardingState> {
    const state = await this.get(id, principalId)
    if (!state.checks.emergency?.acknowledgedByUser) {
      throw new Error('emergency-stop acknowledgment is required before policy configuration')
    }
    for (const root of profile.filesystemRoots) {
      if (!isAbsolute(root)) throw new Error('filesystem roots must be absolute')
      if (root.includes(',')) throw new Error('filesystem roots cannot contain commas in the environment profile')
    }
    if (profile.allowedAppIds.some(appId => appId.includes(','))) {
      throw new Error('allowed app IDs cannot contain commas in the environment profile')
    }
    return this.#update(state, { profile: {
      ...structuredClone(profile),
      captureSupported: state.checks.capture?.passed ?? false,
      semanticSupported: state.checks.semantic?.passed ?? false,
      virtualPointerSupported: state.checks.pointer?.passed ?? false,
      emergencyStopChord: state.checks.emergency?.chord ?? '',
      physicalEmergencyStopSupported: state.checks.emergency?.physicalChordSupported ?? false,
      platform: process.platform,
    } })
  }

  async complete(id: string, principalId: string): Promise<OnboardingState> {
    const state = await this.get(id, principalId)
    if (!state.checks.doctor || !state.checks.capture?.tested || !state.checks.pointer?.tested
      || !state.checks.semantic?.tested || !state.checks.emergency?.acknowledgedByUser || !state.profile) {
      throw new Error('diagnostics, capture, pointer, semantic test, emergency-stop acknowledgment, and policy configuration are required')
    }
    if (!state.checks.capture.passed) throw new Error('screen capture must pass before onboarding completes')
    return this.#update(state, {
      profile: { ...state.profile, completedAt: this.now().toISOString() },
      stage: 'completed',
    })
  }

  async #update(state: OnboardingState, update: Partial<OnboardingState>): Promise<OnboardingState> {
    const next: OnboardingState = {
      ...state, ...update, revision: state.revision + 1, updatedAt: this.now().toISOString(),
    }
    if (next.stage !== 'completed') next.stage = this.#stage(next)
    if (!await this.store.compareAndSet(next, state.revision)) {
      throw new Error('onboarding revision conflict; reload status before retrying')
    }
    return structuredClone(next)
  }

  #stage(state: OnboardingState): OnboardingStage {
    if (state.profile) return 'configured'
    if (state.checks.emergency?.acknowledgedByUser) return 'emergency_acknowledged'
    if (state.checks.semantic) return 'semantic_tested'
    if (state.checks.pointer?.tested) return 'pointer_tested'
    if (state.checks.capture) return 'capture_tested'
    if (state.checks.doctor) return 'diagnosed'
    return 'created'
  }
}
