import { execFileSync as defaultExecFileSync } from 'node:child_process'
import type { NativeModule } from '../native.js'
import { parseSdef, type ScriptingDictionary } from './scripting-dictionary.js'
import type { SpawnBounded, SpawnResult } from './spawn.js'

/** Cross-platform script execution and PID-aware macOS dictionary discovery. */
export class ScriptingService {
  readonly #native: NativeModule
  readonly #spawn: SpawnBounded
  readonly #platform: NodeJS.Platform
  readonly #execFile: typeof defaultExecFileSync
  readonly #dictionaryCache = new Map<string, { pid: number; dict: ScriptingDictionary }>()
  #powerShellExe: string | undefined

  constructor(options: {
    native: NativeModule
    spawnBounded: SpawnBounded
    platform?: NodeJS.Platform
    execFile?: typeof defaultExecFileSync
  }) {
    this.#native = options.native
    this.#spawn = options.spawnBounded
    this.#platform = options.platform ?? process.platform
    this.#execFile = options.execFile ?? defaultExecFileSync
  }

  async getAppDictionary(
    bundleId: string,
    suite?: string,
  ): Promise<{ dict: ScriptingDictionary } | { error: string }> {
    const running = this.#native.listRunningApps().find(app => app.bundleId === bundleId)
    const pid = running?.pid
    const cached = this.#dictionaryCache.get(bundleId)
    let dictionary: ScriptingDictionary | undefined
    if (cached && cached.pid === pid) dictionary = cached.dict
    else {
      const path = await this.#findAppPath(bundleId)
      if (!path) return { error: 'app_not_found' }
      const result = await this.#spawn('sdef', [path], 10_000)
      if (result.timedOut) return { error: 'sdef_timeout' }
      if (result.code !== 0) return { error: 'not_scriptable' }
      dictionary = parseSdef(result.stdout, bundleId)
      if (pid !== undefined) this.#dictionaryCache.set(bundleId, { pid, dict: dictionary })
    }
    if (suite) {
      return { dict: { bundleId, suites: dictionary.suites.filter(value => value.name === suite) } }
    }
    return {
      dict: {
        bundleId,
        suites: dictionary.suites.map(value => ({
          name: value.name,
          commands: value.commands.map(command => ({ name: command.name })),
          classes: value.classes.map(cls => ({ name: cls.name })),
        })),
      },
    }
  }

  getPowerShellExe(): string {
    if (this.#powerShellExe) return this.#powerShellExe
    try {
      this.#execFile('pwsh', ['-NoProfile', '-Command', 'exit 0'], { timeout: 3000 })
      this.#powerShellExe = 'pwsh'
    } catch { this.#powerShellExe = 'powershell' }
    return this.#powerShellExe
  }

  runScript(
    language: string,
    script: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    if (this.#platform === 'win32') {
      if (language === 'applescript' || language === 'javascript') {
        return Promise.resolve(this.#unsupported(language, 'Windows', 'powershell'))
      }
      const executable = this.getPowerShellExe()
      if (/['"$`\r\n]/.test(script)) {
        return this.#spawn(executable, [
          '-NoProfile', '-NonInteractive', '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ], timeoutMs, signal)
      }
      return this.#spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs, signal)
    }
    if (this.#platform === 'linux') {
      if (language === 'applescript' || language === 'javascript') {
        return Promise.resolve(this.#unsupported(language, 'Linux', 'bash" or "powershell'))
      }
      return language === 'powershell'
        ? this.#spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], timeoutMs, signal)
        : this.#spawn('bash', ['-c', script], timeoutMs, signal)
    }
    return this.#spawn(
      'osascript',
      language === 'javascript' ? ['-l', 'JavaScript', '-e', script] : ['-e', script],
      timeoutMs,
      signal,
    )
  }

  async #findAppPath(bundleId: string): Promise<string | undefined> {
    if (this.#platform !== 'darwin') return undefined
    const result = await this.#spawn(
      'mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], 5_000,
    )
    if (result.code !== 0) return undefined
    return result.stdout.split('\n').map(value => value.trim()).find(Boolean)
  }

  #unsupported(language: string, platform: string, replacement: string): SpawnResult {
    return {
      stdout: '',
      stderr: `${language} is not supported on ${platform}. Use language: "${replacement}" instead.`,
      code: 1,
      timedOut: false,
    }
  }
}
