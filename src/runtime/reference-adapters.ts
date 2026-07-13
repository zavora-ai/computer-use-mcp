import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AXElement, NativeModule } from '../native.js'
import type { ToolResult } from '../result.js'
import type {
  AppCapabilityAdapter,
  CapabilityProbeEvidence,
  CapabilityProbeResult,
} from './adapters.js'

export const MACOS_FINDER_COMMENT_OPERATION = 'finder_set_sandbox_file_comment'
export const WINDOWS_POWERSHELL_WRITE_OPERATION = 'powershell_write_sandbox_file'

export interface ReferenceAdapterHost {
  readonly platform: NodeJS.Platform
  getFrontmostAppId(): Promise<string | null>
  getPointer(): Promise<{ x: number; y: number }>
  getPhysicalUserIdleTimeMs?(): Promise<number | undefined>
  getAppVersion(appId: string): Promise<string | undefined>
  runScript(language: 'applescript' | 'powershell', script: string): Promise<{
    code: number
    stdout: string
    stderr: string
  }>
}

export interface SemanticReferenceAdapterHost extends ReferenceAdapterHost {
  getWindowAppId(windowId: number): Promise<string | undefined>
  findElements(windowId: number, role: string, label: string, maxResults?: number): Promise<AXElement[]>
  setElementValue(windowId: number, role: string, label: string, value: string): Promise<{
    set: boolean
    reason?: string
  }>
}

export function createSessionReferenceAdapterHost(options: {
  platform?: NodeJS.Platform
  native: Pick<
    NativeModule,
    | 'getFrontmostApp'
    | 'cursorPosition'
    | 'getUserIdleTimeMs'
    | 'getWindow'
    | 'findElement'
    | 'setElementValue'
  >
  dispatch(tool: string, args: Record<string, unknown>): Promise<ToolResult>
}): SemanticReferenceAdapterHost {
  const platform = options.platform ?? process.platform
  const runScript = async (language: 'applescript' | 'powershell', script: string) => {
    const result = await options.dispatch('run_script', { language, script, timeout_ms: 10_000 })
    const text = result.content.find(block => block.type === 'text')?.text ?? ''
    return { code: result.isError ? 1 : 0, stdout: result.isError ? '' : text, stderr: result.isError ? text : '' }
  }
  return {
    platform,
    async getFrontmostAppId() { return options.native.getFrontmostApp()?.bundleId ?? null },
    async getPointer() { return options.native.cursorPosition() },
    async getPhysicalUserIdleTimeMs() { return options.native.getUserIdleTimeMs?.() ?? undefined },
    async getWindowAppId(windowId) { return options.native.getWindow(windowId)?.bundleId ?? undefined },
    async findElements(windowId, role, label, maxResults) {
      return options.native.findElement(windowId, role, label, undefined, maxResults)
    },
    async setElementValue(windowId, role, label, value) {
      return options.native.setElementValue(windowId, role, label, value)
    },
    async getAppVersion(appId) {
      if (platform === 'darwin' && /^[a-z0-9.-]{3,255}$/i.test(appId)) {
        const result = await runScript('applescript', `tell application id ${appleString(appId)} to get version`)
        return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined
      }
      if (platform === 'win32' && appId.toLowerCase() === 'powershell.exe') {
        const result = await runScript('powershell', '$PSVersionTable.PSVersion.ToString()')
        return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined
      }
      if (platform === 'win32' && /^[a-z0-9._-]{1,128}\.exe$/i.test(appId)) {
        const processName = appId.slice(0, -4)
        const script = `$p=Get-Process -Name ${powershellString(processName)} -ErrorAction Stop | Select-Object -First 1; [Diagnostics.FileVersionInfo]::GetVersionInfo($p.Path).FileVersion`
        const result = await runScript('powershell', script)
        return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined
      }
      return undefined
    },
    runScript,
  }
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function appleString(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')}"`
}

function powershellString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function buildFinderCommentScript(path: string, comment: string): string {
  return `tell application id "com.apple.Finder" to set comment of (POSIX file ${appleString(path)} as alias) to ${appleString(comment)}`
}

export function buildFinderCommentAction(path: string, comment: string): Record<string, unknown> {
  return {
    language: 'applescript',
    script: buildFinderCommentScript(path, comment),
    timeout_ms: 10_000,
    certified_path: path,
    certified_comment: comment,
  }
}

export function buildPowerShellSandboxWriteScript(path: string, content: string): string {
  return `[System.IO.File]::WriteAllText(${powershellString(path)},${powershellString(content)},(New-Object System.Text.UTF8Encoding($false)))`
}

export function buildPowerShellSandboxWriteAction(path: string, content: string): Record<string, unknown> {
  return {
    language: 'powershell',
    script: buildPowerShellSandboxWriteScript(path, content),
    timeout_ms: 10_000,
    certified_path: path,
    certified_content: content,
  }
}

export interface SemanticValueTarget {
  platform: 'darwin' | 'win32'
  adapterId: string
  appId: string
  operation: string
  windowId: number
  role: 'AXTextField' | 'AXTextArea'
  label: string
  maxValueBytes?: number
}

function semanticTargetDigest(target: SemanticValueTarget): string {
  return digest(JSON.stringify({
    platform: target.platform,
    appId: target.appId.toLowerCase(),
    operation: target.operation,
    windowId: target.windowId,
    role: target.role,
    labelDigest: digest(target.label),
    maxValueBytes: target.maxValueBytes ?? 64 * 1024,
  }))
}

export function buildSemanticValueAction(target: SemanticValueTarget, value: string): Record<string, unknown> {
  return {
    window_id: target.windowId,
    role: target.role,
    label: target.label,
    value,
    certified_target_digest: semanticTargetDigest(target),
  }
}

async function isExistingPathInsideRoot(path: string, root: string): Promise<boolean> {
  if (!isAbsolute(path)) return false
  try {
    const [actualRoot, actualPath] = await Promise.all([realpath(root), realpath(path)])
    const rel = relative(actualRoot, actualPath)
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
  } catch { return false }
}

async function capture(host: ReferenceAdapterHost) {
  const [frontmostApp, pointer] = await Promise.all([
    host.getFrontmostAppId(),
    host.getPointer(),
  ])
  return { frontmostApp, pointer }
}

async function waitForPhysicalQuiet(host: ReferenceAdapterHost, minimumIdleMs = 500): Promise<boolean> {
  if (!host.getPhysicalUserIdleTimeMs) return false
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const idle = await host.getPhysicalUserIdleTimeMs()
    if (typeof idle === 'number' && Number.isFinite(idle) && idle >= minimumIdleMs) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

function evidence(
  before: Awaited<ReturnType<typeof capture>>,
  after: Awaited<ReturnType<typeof capture>>,
  values: Pick<
    CapabilityProbeEvidence,
    | 'preconditionDigest'
    | 'postconditionDigest'
    | 'rollbackDigest'
    | 'environmentDigest'
    | 'quietPeriodSatisfied'
    | 'executionSucceeded'
    | 'postconditionSatisfied'
    | 'rollbackSucceeded'
  >,
): CapabilityProbeEvidence {
  return {
    frontmostAppBefore: before.frontmostApp,
    frontmostAppAfter: after.frontmostApp,
    pointerBefore: before.pointer,
    pointerAfter: after.pointer,
    ...values,
  }
}

function probeResult(
  supported: boolean,
  before: Awaited<ReturnType<typeof capture>>,
  after: Awaited<ReturnType<typeof capture>>,
  proof: CapabilityProbeEvidence,
): CapabilityProbeResult {
  const focusChanged = before.frontmostApp !== after.frontmostApp
  const pointerMoved = before.pointer.x !== after.pointer.x || before.pointer.y !== after.pointer.y
  return {
    supported,
    interference: focusChanged ? 'takes_foreground' : pointerMoved ? 'moves_physical_pointer' : 'none',
    focusChanged,
    pointerMoved,
    // Both reference contracts contain only direct scripting primitives and
    // cannot invoke System Events, SendInput, or physical-input tools.
    physicalInputInjected: false,
    evidence: proof,
  }
}

export class MacOSFinderCommentAdapter implements AppCapabilityAdapter {
  readonly id = 'zavora.macos.finder-comment'
  readonly version = '3'
  readonly platform = 'darwin' as const

  readonly sandboxRoot: string

  constructor(readonly host: ReferenceAdapterHost, sandboxRoot: string) {
    mkdirSync(sandboxRoot, { recursive: true, mode: 0o700 })
    this.sandboxRoot = realpathSync(sandboxRoot)
  }

  supports(appId: string, operation: string): boolean {
    return appId === 'com.apple.finder' && operation === MACOS_FINDER_COMMENT_OPERATION
  }

  backend() { return 'applescript' as const }

  contract() {
    return {
      tool: 'run_script',
      version: '1',
      bindingDigest: digest(`${this.platform}:sandbox:${resolve(this.sandboxRoot)}`),
      description: 'Set a Finder comment on an existing file confined to the certification sandbox.',
    }
  }

  getAppVersion(appId: string): Promise<string | undefined> {
    return this.host.getAppVersion(appId)
  }

  async matchesAction(_appId: string, _operation: string, args: Readonly<Record<string, unknown>>): Promise<boolean> {
    const path = args.certified_path
    const comment = args.certified_comment
    return typeof path === 'string'
      && typeof comment === 'string'
      && comment.length <= 1024
      && args.language === 'applescript'
      && args.timeout_ms === 10_000
      && args.script === buildFinderCommentScript(path, comment)
      && await isExistingPathInsideRoot(path, this.sandboxRoot)
  }

  async probe(appId: string, appVersion: string): Promise<CapabilityProbeResult> {
    await mkdir(this.sandboxRoot, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(this.sandboxRoot, 'finder-comment-'))
    const path = join(directory, 'probe.txt')
    const marker = `computer-use-v8-${randomUUID()}`
    await writeFile(path, 'background-certification-probe', { mode: 0o600 })
    const quietPeriodSatisfied = await waitForPhysicalQuiet(this.host)
    const before = await capture(this.host)
    let after = before
    let supported = false
    let postconditionDigest = digest('unsupported')
    let rollbackDigest = digest('not-run')
    let executionSucceeded = false
    let postconditionSatisfied = false
    let rollbackSucceeded = false
    try {
      const action = buildFinderCommentAction(path, marker)
      const result = await this.host.runScript('applescript', String(action.script))
      executionSucceeded = result.code === 0
      after = await capture(this.host)
      if (result.code === 0) {
        const read = await this.host.runScript(
          'applescript',
          `tell application id "com.apple.Finder" to get comment of (POSIX file ${appleString(path)} as alias)`,
        )
        postconditionSatisfied = read.code === 0 && read.stdout.trim() === marker
        supported = postconditionSatisfied
        postconditionDigest = digest(read.stdout.trim())
      }
      const rollback = await this.host.runScript('applescript', buildFinderCommentScript(path, ''))
      const rollbackRead = rollback.code === 0
        ? await this.host.runScript(
          'applescript',
          `tell application id "com.apple.Finder" to get comment of (POSIX file ${appleString(path)} as alias)`,
        )
        : { code: 1, stdout: '', stderr: 'rollback command failed' }
      rollbackSucceeded = rollback.code === 0
        && rollbackRead.code === 0
        && rollbackRead.stdout.trim() === ''
      rollbackDigest = digest(
        `${rollback.code}:${rollbackRead.code}:${rollbackRead.stdout.trim()}:${rollbackRead.stderr.trim()}`,
      )
      // Capture after verification and rollback so any focus/pointer effect
      // from the entire probe is included in the certification decision.
      after = await capture(this.host)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    return probeResult(supported, before, after, evidence(before, after, {
      preconditionDigest: digest('background-certification-probe'),
      postconditionDigest,
      rollbackDigest,
      environmentDigest: digest(`${this.platform}:${appId}:${appVersion}:${resolve(this.sandboxRoot)}`),
      quietPeriodSatisfied,
      executionSucceeded,
      postconditionSatisfied,
      rollbackSucceeded,
    }))
  }
}

export class WindowsPowerShellSandboxAdapter implements AppCapabilityAdapter {
  readonly id = 'zavora.windows.powershell-sandbox-write'
  readonly version = '2'
  readonly platform = 'win32' as const

  readonly sandboxRoot: string

  constructor(readonly host: ReferenceAdapterHost, sandboxRoot: string) {
    mkdirSync(sandboxRoot, { recursive: true, mode: 0o700 })
    this.sandboxRoot = realpathSync(sandboxRoot)
  }

  supports(appId: string, operation: string): boolean {
    return appId === 'powershell.exe' && operation === WINDOWS_POWERSHELL_WRITE_OPERATION
  }

  backend() { return 'powershell' as const }

  contract() {
    return {
      tool: 'run_script',
      version: '1',
      bindingDigest: digest(`${this.platform}:sandbox:${resolve(this.sandboxRoot)}`),
      description: 'Write UTF-8 text to an existing file confined to the certification sandbox.',
    }
  }

  getAppVersion(appId: string): Promise<string | undefined> {
    return this.host.getAppVersion(appId)
  }

  async matchesAction(_appId: string, _operation: string, args: Readonly<Record<string, unknown>>): Promise<boolean> {
    const path = args.certified_path
    const content = args.certified_content
    return typeof path === 'string'
      && typeof content === 'string'
      && Buffer.byteLength(content) <= 64 * 1024
      && args.language === 'powershell'
      && args.timeout_ms === 10_000
      && args.script === buildPowerShellSandboxWriteScript(path, content)
      && await isExistingPathInsideRoot(path, this.sandboxRoot)
  }

  async probe(appId: string, appVersion: string): Promise<CapabilityProbeResult> {
    await mkdir(this.sandboxRoot, { recursive: true, mode: 0o700 })
    const directory = await mkdtemp(join(this.sandboxRoot, 'powershell-write-'))
    const path = join(directory, 'probe.txt')
    const marker = `computer-use-v8-${randomUUID()}`
    await writeFile(path, 'before', { mode: 0o600 })
    const quietPeriodSatisfied = await waitForPhysicalQuiet(this.host)
    const before = await capture(this.host)
    let after = before
    let supported = false
    let postconditionDigest = digest('unsupported')
    let executionSucceeded = false
    let postconditionSatisfied = false
    try {
      const action = buildPowerShellSandboxWriteAction(path, marker)
      const result = await this.host.runScript('powershell', String(action.script))
      executionSucceeded = result.code === 0
      after = await capture(this.host)
      const bytes = await readFile(path)
      postconditionSatisfied = bytes.toString('utf8') === marker
      supported = executionSucceeded && postconditionSatisfied
      postconditionDigest = digest(bytes)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    return probeResult(supported, before, after, evidence(before, after, {
      preconditionDigest: digest('before'),
      postconditionDigest,
      rollbackDigest: digest('removed'),
      environmentDigest: digest(`${this.platform}:${appId}:${appVersion}:${resolve(this.sandboxRoot)}`),
      quietPeriodSatisfied,
      executionSucceeded,
      postconditionSatisfied,
      rollbackSucceeded: true,
    }))
  }
}

/**
 * Exact-window semantic value adapter shared by macOS AX and Windows UIA.
 * It executes the native semantic primitive directly so the legacy
 * focus-enforcing `set_value` handler is never entered for background work.
 */
export class SemanticValueAdapter implements AppCapabilityAdapter {
  readonly id: string
  readonly version = '1'
  readonly platform: 'darwin' | 'win32'
  readonly #targetDigest: string
  readonly #maxValueBytes: number

  constructor(readonly host: SemanticReferenceAdapterHost, readonly target: SemanticValueTarget) {
    if (host.platform !== target.platform) throw new TypeError('semantic adapter platform does not match its host')
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(target.adapterId)) throw new TypeError('invalid semantic adapter id')
    if (!target.appId || !target.operation || !Number.isSafeInteger(target.windowId) || target.windowId <= 0) {
      throw new TypeError('semantic adapter requires app, operation, and a positive window id')
    }
    if (/pass(?:word|code)|secret|token|credential|credit.?card|cvv/i.test(target.label)) {
      throw new TypeError('sensitive semantic targets cannot be certified')
    }
    this.#maxValueBytes = target.maxValueBytes ?? 64 * 1024
    if (!Number.isSafeInteger(this.#maxValueBytes) || this.#maxValueBytes < 1 || this.#maxValueBytes > 64 * 1024) {
      throw new RangeError('semantic maxValueBytes must be between 1 and 65536')
    }
    this.id = target.adapterId
    this.platform = target.platform
    this.#targetDigest = semanticTargetDigest({ ...target, maxValueBytes: this.#maxValueBytes })
  }

  supports(appId: string, operation: string): boolean {
    return appId.toLowerCase() === this.target.appId.toLowerCase() && operation === this.target.operation
  }

  backend() { return this.platform === 'darwin' ? 'ax' as const : 'uia' as const }

  contract() {
    return {
      tool: 'set_value',
      version: '1',
      bindingDigest: this.#targetDigest,
      description: 'Set one non-sensitive text value in an exact app/window/role/label target.',
    }
  }

  getAppVersion(appId: string): Promise<string | undefined> {
    return this.host.getAppVersion(appId)
  }

  async matchesAction(appId: string, operation: string, args: Readonly<Record<string, unknown>>): Promise<boolean> {
    const allowed = new Set(['window_id', 'role', 'label', 'value', 'certified_target_digest'])
    return this.supports(appId, operation)
      && Object.keys(args).every(key => allowed.has(key))
      && args.window_id === this.target.windowId
      && args.role === this.target.role
      && args.label === this.target.label
      && typeof args.value === 'string'
      && Buffer.byteLength(args.value) <= this.#maxValueBytes
      && args.certified_target_digest === this.#targetDigest
      && (await this.host.getWindowAppId(this.target.windowId))?.toLowerCase() === this.target.appId.toLowerCase()
  }

  async execute(
    appId: string,
    operation: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    if (signal?.aborted) throw new Error('certified semantic execution aborted before mutation')
    if (!(await this.matchesAction(appId, operation, args))) {
      return { content: [{ type: 'text', text: 'certified semantic action no longer matches its target' }], isError: true }
    }
    const result = await this.host.setElementValue(
      this.target.windowId, this.target.role, this.target.label, String(args.value),
    )
    return result.set
      ? { content: [{ type: 'text', text: 'Set certified semantic value' }] }
      : { content: [{ type: 'text', text: `semantic set failed: ${result.reason ?? 'unknown'}` }], isError: true }
  }

  async verifyEffect(
    appId: string,
    operation: string,
    args: Readonly<Record<string, unknown>>,
    _result: ToolResult,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted || !(await this.matchesAction(appId, operation, args))) {
      return { verified: false, method: 'certified_semantic_readback', details: { checks: 0 } }
    }
    const observed = await this.host.findElements(
      this.target.windowId, this.target.role, this.target.label, 2,
    )
    return {
      verified: observed.length === 1 && observed[0]?.value === args.value,
      method: 'certified_semantic_readback',
      details: { checks: 1 },
    }
  }

  async probe(appId: string, appVersion: string): Promise<CapabilityProbeResult> {
    const quietPeriodSatisfied = await waitForPhysicalQuiet(this.host)
    const before = await capture(this.host)
    let after = before
    let executionSucceeded = false
    let postconditionSatisfied = false
    let rollbackSucceeded = false
    let preconditionDigest = digest('unavailable')
    let postconditionDigest = digest('unsupported')
    let rollbackDigest = digest('not-run')
    let initial: AXElement[] = []
    try {
      initial = await this.host.findElements(
        this.target.windowId, this.target.role, this.target.label, 2,
      )
    } catch {
      // Locked desktops, closed windows, or permission loss are an
      // unsupported probe result, never grounds for optimistic certification.
    }
    const original = initial.length === 1 && typeof initial[0]?.value === 'string' ? initial[0].value : undefined
    if (original !== undefined && Buffer.byteLength(original) <= this.#maxValueBytes) {
      preconditionDigest = digest(original)
      const marker = `computer-use-v8-${randomUUID()}`
      try {
        const set = await this.host.setElementValue(
          this.target.windowId, this.target.role, this.target.label, marker,
        )
        executionSucceeded = set.set
        const changed = await this.host.findElements(
          this.target.windowId, this.target.role, this.target.label, 2,
        )
        postconditionSatisfied = changed.length === 1 && changed[0]?.value === marker
        postconditionDigest = digest(changed[0]?.value ?? 'missing')
      } catch {
        executionSucceeded = false
      } finally {
        try {
          const rollback = await this.host.setElementValue(
            this.target.windowId, this.target.role, this.target.label, original,
          )
          const restored = await this.host.findElements(
            this.target.windowId, this.target.role, this.target.label, 2,
          )
          rollbackSucceeded = rollback.set && restored.length === 1 && restored[0]?.value === original
          rollbackDigest = digest(restored[0]?.value ?? 'missing')
        } catch {
          rollbackSucceeded = false
        }
      }
    }
    after = await capture(this.host)
    const windowStillBound = (await this.host.getWindowAppId(this.target.windowId))?.toLowerCase()
      === this.target.appId.toLowerCase()
    return probeResult(
      executionSucceeded && postconditionSatisfied && rollbackSucceeded && windowStillBound,
      before,
      after,
      evidence(before, after, {
        preconditionDigest,
        postconditionDigest,
        rollbackDigest,
        environmentDigest: digest(`${this.platform}:${appId}:${appVersion}:${this.#targetDigest}`),
        quietPeriodSatisfied,
        executionSucceeded,
        postconditionSatisfied,
        rollbackSucceeded,
      }),
    )
  }
}

export function createReferenceAdapters(host: ReferenceAdapterHost, sandboxRoot: string): AppCapabilityAdapter[] {
  if (host.platform === 'darwin') return [new MacOSFinderCommentAdapter(host, sandboxRoot)]
  if (host.platform === 'win32') return [new WindowsPowerShellSandboxAdapter(host, sandboxRoot)]
  return []
}
