import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { sanitizedChildEnvironment } from './session/spawn.js'

export interface RuntimeOptions {
  /** Every call must go through the host's current authorization and execution broker. */
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  allowedTools: readonly string[]
  image?: string
  timeoutMs?: number
  /** Tests or OS-sandbox integrations only. Never launch untrusted code unsandboxed. */
  launch?: () => ChildProcessWithoutNullStreams
}
/** Persistent state and local loops in a networkless, read-only, resource-bounded Docker worker. */
export class ComputerRuntime {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #name = 'computer-runtime-' + randomUUID()
  readonly #allowed: Set<string>
  #active?: { resolve(value: unknown[]): void; reject(error: Error): void; output: unknown[]; controller: AbortController; calls: number; bytes: number; inflight: number }
  #closed = false
  #buffer = ''
  constructor(readonly options: RuntimeOptions) {
    this.#allowed = new Set(options.allowedTools)
    const timeout = options.timeoutMs ?? 30000
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw new Error('Runtime timeout must be 1..120000 ms')
    this.#child = options.launch?.() ?? spawn('docker', ['run', '--rm', '-i', '--name', this.#name,
      '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit=32', '--memory=128m', '--cpus=1', '--user=65534:65534',
      '--mount', `type=bind,source=${fileURLToPath(new URL('./runtime-worker.js', import.meta.url))},target=/runtime.mjs,readonly`,
      options.image ?? 'node:22-alpine', 'node', '--max-old-space-size=64', '/runtime.mjs'],
    { stdio: 'pipe', env: sanitizedChildEnvironment() })
    this.#child.stdout.setEncoding('utf8')
    this.#child.stdout.on('data', chunk => {
      this.#buffer += chunk
      if (this.#buffer.length > 1_048_576) { this.#fail(new Error('Runtime frame exceeds limit')); return }
      let index: number
      while ((index = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, index); this.#buffer = this.#buffer.slice(index + 1)
        try { this.#message(JSON.parse(line)) } catch (error) { this.#fail(error as Error) }
      }
    })
    this.#child.stderr.resume() // Prevent a noisy child from blocking the pipe; never expose host diagnostics as data.
    this.#child.on('error', error => this.#fail(error))
    this.#child.on('exit', () => this.#fail(new Error('Runtime worker exited; inspect outcomes before retry')))
  }
  #send(message: unknown) { if (!this.#closed) this.#child.stdin.write(JSON.stringify(message) + '\n') }
  #message(message: any) {
    const active = this.#active
    if (!active) throw new Error('Unexpected worker message outside a run')
    active.bytes += Buffer.byteLength(JSON.stringify(message))
    if (active.bytes > 8_388_608) throw new Error('Runtime output budget exceeded')
    if (message.type === 'call') {
      if (++active.calls > 100 || !this.#allowed.has(message.name) || !message.args || typeof message.args !== 'object' || Array.isArray(message.args)) throw new Error('Runtime capability or call budget denied')
      active.inflight++
      void this.options.execute(message.name, message.args, active.controller.signal)
        .then(value => { if (this.#active === active) { active.inflight--; this.#send({ type: 'result', id: message.id, value }) } })
        .catch(error => { if (this.#active === active) { active.inflight--; this.#send({ type: 'result', id: message.id, error: String(error) }) } })
    } else if (message.type === 'output') active.output.push(message.value)
    else if (message.type === 'done') { if (active.inflight) throw new Error('Unfinished broker operations'); this.#active = undefined; active.resolve(active.output) }
    else if (message.type === 'failed') this.#fail(new Error(String(message.error)))
    else throw new Error('Unknown runtime frame')
  }
  #fail(error: Error) {
    const active = this.#active; this.#active = undefined
    active?.controller.abort(error); active?.reject(error)
    this.close()
  }
  async run(code: string, signal?: AbortSignal): Promise<unknown[]> {
    if (this.#closed || this.#active) throw new Error('Runtime closed or busy')
    if (typeof code !== 'string' || code.length > 64000) throw new Error('Runtime code exceeds budget')
    signal?.throwIfAborted()
    const stop = () => this.#fail(new Error('Runtime cancelled; inspect outcomes before retry'))
    signal?.addEventListener('abort', stop, { once: true })
    const timer = setTimeout(() => this.#fail(new Error('Runtime deadline exceeded')), this.options.timeoutMs ?? 30000)
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        this.#active = { resolve, reject, output: [], controller: new AbortController(), calls: 0, bytes: 0, inflight: 0 }
        this.#send({ type: 'run', code })
      })
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop) }
  }
  close() {
    if (this.#closed) return
    this.#closed = true
    const active = this.#active; this.#active = undefined
    active?.controller.abort(new Error('Runtime closed')); active?.reject(new Error('Runtime closed'))
    this.#child.kill('SIGKILL')
    if (!this.options.launch) {
      const cleanup = spawn('docker', ['rm', '-f', this.#name], { stdio: 'ignore', env: sanitizedChildEnvironment() })
      cleanup.on('error', () => {})
    }
  }
}
