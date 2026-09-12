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

  /**
   * Run a script in the named language.
   *
   * Dispatched **language first**, then platform. The previous shape was the reverse,
   * and it produced a real contradiction: `bash` was implemented on Linux, promised by
   * the platform table, and recommended by this file's own error message — while the
   * tool's schema enum never contained it. A caller following the advice got
   * `invalid_arguments`, and on an older build got told applescript was unsupported,
   * which is a confusing thing to hear when you asked for bash. Language first means
   * an unsupported combination can only be reported one way, and it is the way the
   * schema and the docs agree on.
   */
  runScript(
    language: string,
    script: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SpawnResult> {
    const platformName = this.#platform === 'win32'
      ? 'Windows'
      : this.#platform === 'linux' ? 'Linux' : 'macOS'

    switch (language) {
      case 'applescript':
      case 'javascript':
        // Apple-event scripting only exists on macOS.
        if (this.#platform !== 'darwin') {
          return Promise.resolve(this.#unsupported(
            language,
            platformName,
            this.#platform === 'win32' ? 'powershell' : 'bash',
          ))
        }
        return this.#spawn(
          'osascript',
          language === 'javascript' ? ['-l', 'JavaScript', '-e', script] : ['-e', script],
          timeoutMs,
          signal,
        )

      case 'powershell': {
        // Present on all three: Windows ships it, and pwsh is installable elsewhere.
        const executable = this.#platform === 'win32' ? this.getPowerShellExe() : 'pwsh'
        // Quoting a script through -Command is where this used to break on Windows, so
        // anything with a quote, a dollar or a newline goes base64 instead.
        if (this.#platform === 'win32' && /['"$`\r\n]/.test(script)) {
          return this.#spawn(executable, [
            '-NoProfile', '-NonInteractive', '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ], timeoutMs, signal)
        }
        return this.#spawn(
          executable,
          ['-NoProfile', '-NonInteractive', '-Command', script],
          timeoutMs,
          signal,
        )
      }

      case 'bash':
        // macOS and Linux both have it. Windows may through WSL or Git Bash, but that
        // is not something to assume, so it is refused there with the alternative.
        if (this.#platform === 'win32') {
          return Promise.resolve(this.#unsupported(language, platformName, 'powershell'))
        }
        return this.#spawn('bash', ['-c', script], timeoutMs, signal)

      default:
        return Promise.resolve(this.#unsupported(
          language,
          platformName,
          this.#platform === 'darwin'
            ? 'applescript", "javascript", "bash" or "powershell'
            : this.#platform === 'linux' ? 'bash" or "powershell' : 'powershell',
        ))
    }
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
