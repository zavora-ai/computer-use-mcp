import type { ToolMeta } from '../tool-catalog.js'
import type { ToolResult } from '../result.js'
import type { VerificationResult } from '../control/transaction.js'
import type {
  ExecutionBackend,
  ExecutionCapability,
  ExecutionMode,
  InterferenceLevel,
} from './types.js'

const modeRank: Record<ExecutionMode, number> = { shadow: 0, background: 1, foreground: 2 }

export function capabilityForTool(
  tool: string,
  meta: ToolMeta,
  appId = '*',
): ExecutionCapability {
  let backend: ExecutionBackend = meta.focusRequired === 'cgevent'
    ? 'physical_input'
    : meta.focusRequired
  if (tool === 'filesystem') backend = 'filesystem'
  if (tool === 'registry') backend = 'registry'
  if (tool === 'process_kill') backend = 'process'
  if (tool === 'browser_action') backend = 'browser'

  let interference: InterferenceLevel = 'none'
  if (meta.movesUserCursor || meta.physicalInput) interference = 'moves_physical_pointer'
  else if (meta.requiresFocus) interference = 'takes_foreground'
  else if (meta.usesVirtualPointer) interference = 'visual_overlay_only'

  const supportedModes: ExecutionMode[] = ['shadow']
  // Only explicit no-focus platform rules may grant background mutation.
  // `scripting` is not a guarantee: arbitrary AppleScript/PowerShell can
  // activate apps or inject input and therefore needs an action-bound adapter
  // certification before background execution.
  if (!meta.mutates || (
    meta.focusRequired === 'none'
    && !meta.requiresFocus
    && !meta.physicalInput
    && !meta.movesUserCursor
  )) {
    supportedModes.push('background')
  }
  if (meta.mutates) supportedModes.push('foreground')

  return {
    appId,
    operation: tool,
    backend,
    supportedModes,
    interference,
    confidence: meta.focusRequired === 'none' ? 1 : 0.75,
    verificationSource: 'platform_rule',
  }
}

export function supportsMode(capability: ExecutionCapability, requested: ExecutionMode): boolean {
  return capability.supportedModes.includes(requested)
}

export function minimumSupportedMode(capability: ExecutionCapability): ExecutionMode {
  return [...capability.supportedModes].sort((a, b) => modeRank[a] - modeRank[b])[0] ?? 'foreground'
}

export interface CapabilityCertificationBinding {
  certificationId: string
  tool: string
  actionContractDigest: string
  matchesAction(args: Readonly<Record<string, unknown>>): boolean | Promise<boolean>
  getAppVersion(): Promise<string | undefined>
  /** Optional direct semantic executor that bypasses focus-enforcing legacy handlers. */
  execute?(args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<ToolResult>
  /** Independent per-action readback supplied by the trusted certified adapter. */
  verifyEffect?(
    args: Readonly<Record<string, unknown>>,
    result: ToolResult,
    signal?: AbortSignal,
  ): Promise<VerificationResult>
}

export interface CertifiedCapabilityResolution {
  capability: ExecutionCapability
  binding: CapabilityCertificationBinding
}

export interface CertifiedCapabilityUse {
  appId: string
  operation: string
  certificationId: string
  tool: string
  args: Readonly<Record<string, unknown>>
}

export class CapabilityRegistry {
  readonly #entries = new Map<string, ExecutionCapability>()
  readonly #bindings = new Map<string, CapabilityCertificationBinding>()
  readonly #now: () => Date
  #ready: Promise<unknown> = Promise.resolve()

  constructor(now: () => Date = () => new Date()) {
    this.#now = now
  }

  setReady(initialization: Promise<unknown>): void {
    this.#ready = initialization
  }

  #key(appId: string, operation: string, backend: ExecutionBackend): string {
    return `${appId}\u0000${operation}\u0000${backend}`
  }

  certify(capability: ExecutionCapability, binding?: CapabilityCertificationBinding): void {
    if (capability.confidence < 0 || capability.confidence > 1) {
      throw new RangeError('capability confidence must be between 0 and 1')
    }
    if (capability.certification) {
      if (!binding || binding.certificationId !== capability.certification.certificationId) {
        throw new TypeError('certified capabilities require their trusted execution binding')
      }
      if (binding.tool !== capability.certification.tool
        || binding.actionContractDigest !== capability.certification.actionContractDigest) {
        throw new TypeError('certification binding does not match the capability contract')
      }
    }
    const key = this.#key(capability.appId, capability.operation, capability.backend)
    const replaced = this.#entries.get(key)
    if (replaced?.certification) this.#bindings.delete(replaced.certification.certificationId)
    this.#entries.set(key, {
      ...capability,
      supportedModes: [...new Set(capability.supportedModes)],
    })
    if (binding) this.#bindings.set(binding.certificationId, binding)
  }

  find(appId: string, operation: string): ExecutionCapability[] {
    const found: ExecutionCapability[] = []
    for (const [key, entry] of this.#entries) {
      if (entry.certification && Date.parse(entry.certification.validUntil) <= this.#now().getTime()) {
        this.#entries.delete(key)
        this.#bindings.delete(entry.certification.certificationId)
        continue
      }
      if (entry.operation === operation && (entry.appId === appId || entry.appId === '*')) found.push(entry)
    }
    return found
  }

  async resolve(use: CertifiedCapabilityUse): Promise<ExecutionCapability | undefined> {
    return (await this.resolveBinding(use))?.capability
  }

  async resolveBinding(use: CertifiedCapabilityUse): Promise<CertifiedCapabilityResolution | undefined> {
    await this.#ready
    const entry = this.find(use.appId, use.operation)
      .find(candidate => candidate.certification?.certificationId === use.certificationId)
    if (!entry?.certification) return undefined
    const binding = this.#bindings.get(use.certificationId)
    if (!binding || binding.tool !== use.tool || !(await binding.matchesAction(use.args))) return undefined
    const currentVersion = await binding.getAppVersion()
    if (!currentVersion || currentVersion !== entry.certification.appVersion) {
      this.invalidateVersion(use.appId, currentVersion ?? '')
      return undefined
    }
    return { capability: structuredClone(entry), binding }
  }

  invalidateVersion(appId: string, currentVersion: string): number {
    let removed = 0
    for (const [key, value] of this.#entries) {
      if (value.appId === appId && value.certification?.appVersion !== currentVersion) {
        this.#entries.delete(key)
        if (value.certification) this.#bindings.delete(value.certification.certificationId)
        removed++
      }
    }
    return removed
  }

  invalidateApp(appId: string): number {
    let removed = 0
    for (const [key, value] of this.#entries) {
      if (value.appId === appId) {
        this.#entries.delete(key)
        if (value.certification) this.#bindings.delete(value.certification.certificationId)
        removed++
      }
    }
    return removed
  }
}
