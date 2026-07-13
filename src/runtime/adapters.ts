import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ToolResult } from '../result.js'
import type { VerificationResult } from '../control/transaction.js'
import { CapabilityRegistry } from './capabilities.js'
import type { ExecutionBackend, ExecutionCapability, InterferenceLevel } from './types.js'

export interface CapabilityProbeEvidence {
  frontmostAppBefore?: string | null
  frontmostAppAfter?: string | null
  pointerBefore?: { x: number; y: number }
  pointerAfter?: { x: number; y: number }
  physicalInputEventsBefore?: number
  physicalInputEventsAfter?: number
  preconditionDigest?: string
  postconditionDigest?: string
  rollbackDigest?: string
  environmentDigest?: string
  quietPeriodSatisfied?: boolean
  executionSucceeded?: boolean
  postconditionSatisfied?: boolean
  rollbackSucceeded?: boolean
}

export interface CapabilityProbeResult {
  supported: boolean
  interference: InterferenceLevel
  focusChanged: boolean
  physicalInputInjected: boolean
  pointerMoved: boolean
  evidence: CapabilityProbeEvidence
}

export interface CapabilityActionContract {
  /** Existing governed low-level tool this adapter is allowed to certify. */
  tool: string
  /** Increment when accepted arguments or execution semantics change. */
  version: string
  /** Digest of instance-specific authority such as sandbox root or semantic target. */
  bindingDigest: string
  description: string
}

export interface AppCapabilityAdapter {
  readonly id: string
  readonly version: string
  readonly platform: NodeJS.Platform
  supports(appId: string, operation: string): boolean
  backend(appId: string, operation: string): ExecutionBackend
  contract(appId: string, operation: string): CapabilityActionContract
  /** Must read the installed/running app version from trusted host state. */
  getAppVersion(appId: string): Promise<string | undefined>
  /** Fail-closed predicate over the actual low-level arguments. */
  matchesAction(
    appId: string,
    operation: string,
    args: Readonly<Record<string, unknown>>,
  ): boolean | Promise<boolean>
  /** Direct semantic execution, used when the legacy tool handler would force focus. */
  execute?(
    appId: string,
    operation: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ToolResult>
  /** Fresh, value-free readback of the effect produced by `execute`. */
  verifyEffect?(
    appId: string,
    operation: string,
    args: Readonly<Record<string, unknown>>,
    result: ToolResult,
    signal?: AbortSignal,
  ): Promise<VerificationResult>
  probe(appId: string, appVersion: string, operation: string): Promise<CapabilityProbeResult>
}

export interface CertificationRequest {
  appId: string
  operation: string
  /** Optional optimistic concurrency check; never used as version authority. */
  expectedAppVersion?: string
  ttlMs?: number
}

export interface CapabilityCertificationTrace {
  schemaVersion: 1
  certificationId: string
  platform: NodeJS.Platform
  adapter: { id: string; version: string }
  app: { id: string; version: string }
  operation: string
  tool: string
  backend: ExecutionBackend
  contract: { version: string; bindingDigest: string; digest: string; description: string }
  probe: {
    startedAt: string
    completedAt: string
    result: CapabilityProbeResult
  }
  capability: ExecutionCapability
  traceDigest: string
}

export interface CertificationTraceStore {
  put(trace: CapabilityCertificationTrace): Promise<void>
  get(certificationId: string): Promise<CapabilityCertificationTrace | undefined>
  list(): Promise<CapabilityCertificationTrace[]>
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function safeDigest(value: unknown): string | undefined {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : undefined
}

/** Copies only the public conformance fields; arbitrary adapter evidence never reaches disk. */
export function sanitizeProbeResult(probe: CapabilityProbeResult): CapabilityProbeResult {
  const evidence = probe.evidence ?? {}
  const point = (value: unknown) => {
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>
    const x = safeNumber(record.x)
    const y = safeNumber(record.y)
    return x === undefined || y === undefined ? undefined : { x, y }
  }
  return {
    supported: probe.supported === true,
    interference: probe.interference,
    focusChanged: probe.focusChanged === true,
    physicalInputInjected: probe.physicalInputInjected === true,
    pointerMoved: probe.pointerMoved === true,
    evidence: {
      ...(typeof evidence.frontmostAppBefore === 'string' || evidence.frontmostAppBefore === null
        ? { frontmostAppBefore: evidence.frontmostAppBefore } : {}),
      ...(typeof evidence.frontmostAppAfter === 'string' || evidence.frontmostAppAfter === null
        ? { frontmostAppAfter: evidence.frontmostAppAfter } : {}),
      ...(point(evidence.pointerBefore) ? { pointerBefore: point(evidence.pointerBefore)! } : {}),
      ...(point(evidence.pointerAfter) ? { pointerAfter: point(evidence.pointerAfter)! } : {}),
      ...(safeNumber(evidence.physicalInputEventsBefore) === undefined ? {}
        : { physicalInputEventsBefore: safeNumber(evidence.physicalInputEventsBefore)! }),
      ...(safeNumber(evidence.physicalInputEventsAfter) === undefined ? {}
        : { physicalInputEventsAfter: safeNumber(evidence.physicalInputEventsAfter)! }),
      ...(safeDigest(evidence.preconditionDigest) ? { preconditionDigest: safeDigest(evidence.preconditionDigest)! } : {}),
      ...(safeDigest(evidence.postconditionDigest) ? { postconditionDigest: safeDigest(evidence.postconditionDigest)! } : {}),
      ...(safeDigest(evidence.rollbackDigest) ? { rollbackDigest: safeDigest(evidence.rollbackDigest)! } : {}),
      ...(safeDigest(evidence.environmentDigest) ? { environmentDigest: safeDigest(evidence.environmentDigest)! } : {}),
      ...(typeof evidence.quietPeriodSatisfied === 'boolean'
        ? { quietPeriodSatisfied: evidence.quietPeriodSatisfied } : {}),
      ...(typeof evidence.executionSucceeded === 'boolean'
        ? { executionSucceeded: evidence.executionSucceeded } : {}),
      ...(typeof evidence.postconditionSatisfied === 'boolean'
        ? { postconditionSatisfied: evidence.postconditionSatisfied } : {}),
      ...(typeof evidence.rollbackSucceeded === 'boolean'
        ? { rollbackSucceeded: evidence.rollbackSucceeded } : {}),
    },
  }
}

function probeProvesBackgroundSafety(probe: CapabilityProbeResult): boolean {
  return probe.supported
    && probe.interference === 'none'
    && !probe.focusChanged
    && !probe.physicalInputInjected
    && !probe.pointerMoved
    && probe.evidence.quietPeriodSatisfied === true
    && probe.evidence.executionSucceeded === true
    && probe.evidence.postconditionSatisfied === true
    && probe.evidence.rollbackSucceeded === true
    && probe.evidence.frontmostAppBefore === probe.evidence.frontmostAppAfter
    && JSON.stringify(probe.evidence.pointerBefore) === JSON.stringify(probe.evidence.pointerAfter)
}

export function verifyCertificationTrace(trace: CapabilityCertificationTrace): boolean {
  return trace.schemaVersion === 1
    && trace.certificationId === trace.capability.certification?.certificationId
    && trace.traceDigest === trace.capability.certification?.traceDigest
    && trace.app.id === trace.capability.appId
    && trace.app.version === trace.capability.certification?.appVersion
    && trace.operation === trace.capability.operation
    && trace.tool === trace.capability.certification?.tool
    && trace.contract.digest === trace.capability.certification?.actionContractDigest
    && /^sha256:[a-f0-9]{64}$/.test(trace.contract.bindingDigest)
    && /^sha256:[a-f0-9]{64}$/.test(trace.traceDigest)
    && certificationTraceDigest(trace) === trace.traceDigest
}

function actionContractDigest(
  adapter: AppCapabilityAdapter,
  appId: string,
  operation: string,
  contract: CapabilityActionContract,
): string {
  return sha256({
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    platform: adapter.platform,
    appId,
    operation,
    tool: contract.tool,
    contractVersion: contract.version,
    bindingDigest: contract.bindingDigest,
  })
}

export class MemoryCertificationTraceStore implements CertificationTraceStore {
  readonly #traces = new Map<string, CapabilityCertificationTrace>()

  async put(trace: CapabilityCertificationTrace): Promise<void> {
    if (!verifyCertificationTrace(trace)) throw new Error('certification trace digest is invalid')
    this.#traces.set(trace.certificationId, structuredClone(trace))
  }

  async get(certificationId: string): Promise<CapabilityCertificationTrace | undefined> {
    const trace = this.#traces.get(certificationId)
    return trace ? structuredClone(trace) : undefined
  }

  async list(): Promise<CapabilityCertificationTrace[]> {
    return [...this.#traces.values()].map(trace => structuredClone(trace))
  }
}

/** Private atomic file store for public, redacted certification evidence. */
export class FileCertificationTraceStore implements CertificationTraceStore {
  constructor(readonly root: string) {}

  async put(trace: CapabilityCertificationTrace): Promise<void> {
    if (!verifyCertificationTrace(trace)) throw new Error('certification trace digest is invalid')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const destination = this.#path(trace.certificationId)
    const temporary = join(this.root, `.${trace.certificationId}.${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(trace)}\n`, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    await rename(temporary, destination)
    const directory = await open(dirname(destination), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }

  async get(certificationId: string): Promise<CapabilityCertificationTrace | undefined> {
    try {
      const trace = JSON.parse(await readFile(this.#path(certificationId), 'utf8')) as CapabilityCertificationTrace
      if (!verifyCertificationTrace(trace)) throw new Error('certification trace integrity check failed')
      return trace
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async list(): Promise<CapabilityCertificationTrace[]> {
    let files: string[]
    try { files = await readdir(this.root) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const traces: CapabilityCertificationTrace[] = []
    for (const file of files.filter(name => /^cert_[a-f0-9]{32}\.json$/.test(name)).sort()) {
      const trace = await this.get(file.slice(0, -5))
      if (trace) traces.push(trace)
    }
    return traces
  }

  #path(certificationId: string): string {
    if (!/^cert_[a-f0-9]{32}$/.test(certificationId)) throw new TypeError('invalid certification id')
    return join(this.root, `${certificationId}.json`)
  }
}

/**
 * Runs an interference probe and publishes a usable capability only after its
 * version-bound, redacted trace is durable. The registry retains the trusted
 * adapter predicate/version resolver; a trace alone never grants authority.
 */
export class CapabilityCertificationService {
  readonly traces: CertificationTraceStore

  constructor(
    readonly registry: CapabilityRegistry,
    readonly adapters: readonly AppCapabilityAdapter[],
    readonly now: () => Date = () => new Date(),
    traces: CertificationTraceStore = new MemoryCertificationTraceStore(),
    readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.traces = traces
  }

  async certify(request: CertificationRequest): Promise<ExecutionCapability> {
    const adapter = this.adapters.find(candidate =>
      candidate.platform === this.platform && candidate.supports(request.appId, request.operation))
    if (!adapter) throw new Error(`no capability adapter for ${request.appId}:${request.operation} on ${this.platform}`)
    const appVersion = await adapter.getAppVersion(request.appId)
    if (!appVersion) throw new Error(`trusted app version unavailable for ${request.appId}`)
    if (request.expectedAppVersion && request.expectedAppVersion !== appVersion) {
      throw new Error(`app version changed before certification: expected ${request.expectedAppVersion}, observed ${appVersion}`)
    }
    const contract = adapter.contract(request.appId, request.operation)
    const contractDigest = actionContractDigest(adapter, request.appId, request.operation, contract)
    const startedAt = this.now()
    const probe = sanitizeProbeResult(await adapter.probe(request.appId, appVersion, request.operation))
    const completedAt = this.now()
    const backgroundSafe = probeProvesBackgroundSafety(probe)
    const probeFingerprint = sha256({
      adapter: adapter.id,
      adapterVersion: adapter.version,
      appVersion,
      operation: request.operation,
      contractDigest,
      probe,
    })
    const certificationId = `cert_${createHash('sha256').update(probeFingerprint).digest('hex').slice(0, 32)}`
    const capability: ExecutionCapability = {
      appId: request.appId,
      operation: request.operation,
      backend: adapter.backend(request.appId, request.operation),
      supportedModes: backgroundSafe ? ['shadow', 'background', 'foreground'] : ['shadow', 'foreground'],
      interference: probe.interference,
      confidence: backgroundSafe ? 1 : 0.9,
      verifiedAt: completedAt.toISOString(),
      verificationSource: 'live_probe',
      certification: {
        certificationId,
        adapterId: adapter.id,
        adapterVersion: adapter.version,
        appVersion,
        tool: contract.tool,
        actionContractDigest: contractDigest,
        probeFingerprint,
        traceDigest: '',
        validUntil: new Date(completedAt.getTime() + (request.ttlMs ?? 3_600_000)).toISOString(),
      },
    }
    const body: Omit<CapabilityCertificationTrace, 'traceDigest'> = {
      schemaVersion: 1,
      certificationId,
      platform: adapter.platform,
      adapter: { id: adapter.id, version: adapter.version },
      app: { id: request.appId, version: appVersion },
      operation: request.operation,
      tool: contract.tool,
      backend: capability.backend,
      contract: {
        version: contract.version,
        bindingDigest: contract.bindingDigest,
        digest: contractDigest,
        description: contract.description,
      },
      probe: { startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(), result: probe },
      capability,
    }
    const trace: CapabilityCertificationTrace = {
      ...body,
      capability: structuredClone(capability),
      traceDigest: '',
    }
    trace.traceDigest = certificationTraceDigest(trace)
    capability.certification!.traceDigest = trace.traceDigest
    trace.capability.certification!.traceDigest = trace.traceDigest
    if (!verifyCertificationTrace(trace)) throw new Error('internal certification trace digest mismatch')
    await this.traces.put(trace)
    this.registry.certify(capability, {
      certificationId,
      tool: contract.tool,
      actionContractDigest: contractDigest,
      matchesAction: args => adapter.matchesAction(request.appId, request.operation, args),
      getAppVersion: () => adapter.getAppVersion(request.appId),
      ...(adapter.execute ? {
        execute: (args, signal) => adapter.execute!(request.appId, request.operation, args, signal),
      } : {}),
      ...(adapter.verifyEffect ? {
        verifyEffect: (args, result, signal) => adapter.verifyEffect!(
          request.appId, request.operation, args, result, signal,
        ),
      } : {}),
    })
    return structuredClone(capability)
  }

  invalidateVersion(appId: string, currentVersion: string): number {
    return this.registry.invalidateVersion(appId, currentVersion)
  }

  async restore(): Promise<{ restored: string[]; rejected: Array<{ certificationId: string; reason: string }> }> {
    const restored: string[] = []
    const rejected: Array<{ certificationId: string; reason: string }> = []
    for (const trace of await this.traces.list()) {
      const reject = (reason: string) => rejected.push({ certificationId: trace.certificationId, reason })
      if (!verifyCertificationTrace(trace)) { reject('trace_integrity'); continue }
      const adapter = this.adapters.find(candidate =>
        candidate.id === trace.adapter.id
        && candidate.version === trace.adapter.version
        && candidate.platform === this.platform
        && candidate.supports(trace.app.id, trace.operation))
      if (!adapter) { reject('adapter_unavailable'); continue }
      const contract = adapter.contract(trace.app.id, trace.operation)
      if (contract.tool !== trace.tool
        || contract.version !== trace.contract.version
        || contract.bindingDigest !== trace.contract.bindingDigest
        || actionContractDigest(adapter, trace.app.id, trace.operation, contract) !== trace.contract.digest) {
        reject('contract_changed')
        continue
      }
      const currentVersion = await adapter.getAppVersion(trace.app.id)
      if (!currentVersion || currentVersion !== trace.app.version) { reject('app_version_changed'); continue }
      if (Date.parse(trace.capability.certification!.validUntil) <= this.now().getTime()) {
        reject('expired')
        continue
      }
      const probe = trace.probe.result
      const backgroundSafe = probeProvesBackgroundSafety(probe)
      if (trace.capability.supportedModes.includes('background') !== backgroundSafe) {
        reject('capability_probe_mismatch')
        continue
      }
      this.registry.certify(trace.capability, {
        certificationId: trace.certificationId,
        tool: contract.tool,
        actionContractDigest: trace.contract.digest,
        matchesAction: args => adapter.matchesAction(trace.app.id, trace.operation, args),
        getAppVersion: () => adapter.getAppVersion(trace.app.id),
        ...(adapter.execute ? {
          execute: (args, signal) => adapter.execute!(trace.app.id, trace.operation, args, signal),
        } : {}),
        ...(adapter.verifyEffect ? {
          verifyEffect: (args, result, signal) => adapter.verifyEffect!(
            trace.app.id, trace.operation, args, result, signal,
          ),
        } : {}),
      })
      restored.push(trace.certificationId)
    }
    return { restored, rejected }
  }
}

/** Avoids a self-referential digest by blanking the embedded trace pointer. */
function certificationTraceDigest(trace: CapabilityCertificationTrace): string {
  const body = structuredClone(trace) as CapabilityCertificationTrace
  delete (body as Partial<CapabilityCertificationTrace>).traceDigest
  if (body.capability.certification) body.capability.certification.traceDigest = ''
  return sha256(body)
}
