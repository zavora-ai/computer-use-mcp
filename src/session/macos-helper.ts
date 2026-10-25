/**
 * The macOS agent helper (v7.5, design §2): ScreenCaptureKit window capture and
 * Vision OCR in a small Swift program.
 *
 * `libexec/macos-agent-helper.swift` is compiled on first use with `swiftc -O` into
 * `~/Library/Caches/computer-use-mcp/macos-agent-helper-<sha8>` (sha of the source,
 * so an edited source rebuilds) and signed ad hoc. swiftc ships with Xcode and the
 * Command Line Tools; without it the helper reports itself unavailable and callers
 * fall back (screencapture for captures; OCR has no fallback).
 *
 * 7.7.0 (K8): display capture as well as window capture, `--region` crops, and one warm `serve` process instead of a
 * process per call. Starting the helper cost about 150 ms of every capture; a warm capture takes about 60 ms.
 * `COMPUTER_USE_HELPER_SERVE=false` goes back to a process per call.
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams, type ExecFileOptions } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs'
import { homedir, release, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface HelperFrame { x: number; y: number; width: number; height: number }

export interface HelperCapture {
  path: string
  width: number
  height: number
  hash: string
  /** Image pixels per window (or display) point. */
  scale: number
  /** The window, or for a display capture the display, in global screen points. */
  frame: HelperFrame
  mimeType: string
  bytes: number
  /** Set by a helper that cropped the capture to the requested region (points from the frame's top-left). */
  region?: HelperFrame
  window?: number
  /** The display captured (7.7.0). */
  display?: number
  /** 7.8: what changed since the previous capture of this source (`diff`). */
  diff?: HelperDiff
  /** 7.8: nothing changed and `skipUnchanged` was set, so no image was encoded. */
  unchanged?: boolean
}

/** A capture compared with the previous one of the same source. `area` and `dirty` are fractions of the image. */
export interface HelperDiff {
  changed: boolean
  area: number
  dirty?: { x: number; y: number; width: number; height: number }
  /** The first capture of this source in the helper: there was nothing to compare with. */
  first?: boolean
}

export type HelperRegion = { x: number; y: number; width: number; height: number }

export interface HelperOcrLine {
  text: string
  confidence: number
  /** Image pixels, top-left origin. */
  box: { x: number; y: number; w: number; h: number }
}

export interface HelperOcr {
  width: number
  height: number
  /** Image pixels per window point (window OCR only). */
  scale?: number
  frame?: HelperFrame
  lines: HelperOcrLine[]
  ocrMs?: number
}

export type HelperAvailability = { ok: true; path: string } | { ok: false; reason: string; remediation: string }

export interface MacosHelper {
  /** Compile (once) and report whether the helper can run. */
  ensure(signal?: AbortSignal): Promise<HelperAvailability>
  /** True when window and display capture go through ScreenCaptureKit (macOS 14+). */
  supportsCapture(): boolean
  /** One of `windowId` and `displayId`. */
  capture(options: {
    windowId?: number
    /** 7.7.0 (K8): a whole display, by id (list_displays) or `main`. */
    displayId?: number | 'main'
    /** Display capture: processes whose shielding-level windows (the agent pointer) are left out. */
    overlayPids?: number[]
    /** Ignored with `region`, which is cut at full resolution. */
    width?: number
    format?: 'png' | 'jpeg'
    quality?: number
    /** Crop to this region, in points from the window's or display's top-left (helper `--region`). */
    region?: HelperRegion
    /** 7.8: compare with the previous capture of this source kept in the helper; a string names the source. */
    diff?: boolean | string
    /** With `diff`: an unchanged capture is not encoded (`unchanged: true`, empty `data`). */
    skipUnchanged?: boolean
  }, signal?: AbortSignal): Promise<HelperCapture & { data: Buffer }>
  ocr(options: {
    windowId?: number
    imagePath?: string
    /** Window points with windowId; image pixels with imagePath. */
    region?: HelperRegion
    languages?: string[]
    fast?: boolean
  }, signal?: AbortSignal): Promise<HelperOcr>
  /** Stop the warm helper process, if one is running (7.7.0). */
  close?(): void
}

export class HelperFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'HelperFailure'
  }
}

/** A warm helper that went away with a call outstanding (7.7.0): the call is asked once more of a fresh one. */
class HelperExited extends Error {}

type ServeSpawner = (file: string, args: string[]) => ChildProcessWithoutNullStreams

type Runner = (
  file: string, args: string[], options: ExecFileOptions & { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>

/** Runs a process; a process killed by the timeout says so instead of looking like a silent `exit 1`. */
export const defaultRunner: Runner = (file, args, options) => new Promise(resolve => {
  execFile(file, args, { ...options, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
    const killed = error && ((error as { killed?: boolean }).killed || (error as { signal?: string }).signal)
    const explained = String(stderr ?? '').trim() || (killed
      ? `helper timed out after ${options.timeout ?? '?'} ms and was killed (${(error as { signal?: string }).signal ?? 'signal'})`
      : (error?.message ?? ''))
    resolve({ stdout: String(stdout ?? ''), stderr: explained, code })
  })
})

export function defaultHelperSourcePath(): string {
  return join(fileURLToPath(import.meta.url), '..', '..', '..', 'libexec', 'macos-agent-helper.swift')
}

export function defaultHelperCacheDir(): string {
  return join(homedir(), 'Library', 'Caches', 'computer-use-mcp')
}

/** macOS 14 is Darwin 23. */
export function darwinSupportsScreenCaptureKit(darwinRelease: string = release()): boolean {
  const major = Number.parseInt(darwinRelease.split('.')[0] ?? '0', 10)
  return Number.isFinite(major) && major >= 23
}

/**
 * Compile a Swift source into the cache directory, once per source hash, and sign it ad hoc. Shared by the
 * capture/OCR helper and the status card. 7.6.1: no per-call abort signal reaches the compiler, so a cancelled first
 * call can no longer cache "swiftc failed" for ten minutes (the compile timeout bounds it instead).
 */
export async function compileSwiftHelper(options: {
  sourcePath: string
  cacheDir: string
  name: string
  run?: Runner
  compileTimeoutMs?: number
  platform?: NodeJS.Platform
}): Promise<HelperAvailability> {
  const platform = options.platform ?? process.platform
  const run = options.run ?? defaultRunner
  const compileTimeoutMs = options.compileTimeoutMs ?? 180_000
  if (platform !== 'darwin') {
    return { ok: false, reason: 'macOS only', remediation: 'This needs macOS (ScreenCaptureKit and Vision).' }
  }
  let source: Buffer
  try { source = readFileSync(options.sourcePath) } catch {
    return { ok: false, reason: `helper source missing: ${options.sourcePath}`, remediation: `Reinstall the package; ${options.sourcePath} is part of it.` }
  }
  const sha = createHash('sha256').update(source).digest('hex').slice(0, 8)
  const target = join(options.cacheDir, `${options.name}-${sha}`)
  if (existsSync(target)) return { ok: true, path: target }
  const remediation = 'Install the Xcode Command Line Tools (xcode-select --install) so swiftc can build the helper, then retry.'
  const which = await run('xcrun', ['-f', 'swiftc'], { timeout: 10_000 })
  if (which.code !== 0) return { ok: false, reason: 'swiftc not found', remediation }
  try { mkdirSync(options.cacheDir, { recursive: true }) } catch { /* reported by the compile */ }
  // Build to a unique name and rename into place, so two processes compiling at
  // once never run a half-written binary.
  const temporary = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const built = await run('xcrun', ['swiftc', '-O', '-o', temporary, options.sourcePath], { timeout: compileTimeoutMs })
  if (built.code !== 0 || !existsSync(temporary)) {
    try { rmSync(temporary, { force: true }) } catch { /* nothing to remove */ }
    return { ok: false, reason: `swiftc failed: ${built.stderr.trim().slice(0, 400)}`, remediation }
  }
  await run('codesign', ['--force', '--sign', '-', temporary], { timeout: 30_000 })
  try { renameSync(temporary, target) } catch (error) {
    return { ok: false, reason: `could not install helper: ${(error as Error).message}`, remediation }
  }
  return { ok: true, path: target }
}

const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as { code?: string }).code === 'EPERM' }
}

/** This process's helper copies, removed when it exits. */
const ownCopies = new Set<string>()
let ownCopiesHooked = false
const HELPER_COPY = /^macos-agent-helper-[0-9a-f]{8}-p(\d+)-[0-9a-f]+$/

/**
 * A signed copy of the compiled helper with an identifier of its own, for one helper instance to run (7.7.0). While a
 * helper process holds a ScreenCaptureKit session, a capture in another process with the same code identity hangs
 * until the first exits (measured 2026-10-25 on macOS 26.2: a copy signed with another identifier, and screencapture,
 * were unaffected). Every server shares one compiled binary, so a warm helper in one session stalled every other
 * session's captures for 10 s each. Copies left by processes that have exited are removed here; this process's go
 * when it exits. If the copy cannot be made, the shared binary is used.
 */
export async function ownHelperCopy(shared: string, run: Runner = defaultRunner): Promise<string> {
  const directory = dirname(shared)
  try {
    for (const name of readdirSync(directory)) {
      const match = HELPER_COPY.exec(name)
      if (match && !processAlive(Number(match[1]))) rmSync(join(directory, name), { force: true })
    }
  } catch { /* nothing to clean */ }
  const tag = `${process.pid}-${randomBytes(3).toString('hex')}`
  const copy = `${shared}-p${tag}`
  try {
    copyFileSync(shared, copy)
    chmodSync(copy, 0o755)
    const signed = await run('codesign', ['--force', '--sign', '-', '--identifier', `ai.zavora.computer-use.helper.${tag}`, copy], { timeout: 30_000 })
    if (signed.code !== 0) throw new Error(signed.stderr)
  } catch {
    try { rmSync(copy, { force: true }) } catch { /* never made */ }
    return shared
  }
  ownCopies.add(copy)
  if (!ownCopiesHooked) {
    ownCopiesHooked = true
    process.once('exit', () => {
      for (const file of ownCopies) { try { rmSync(file, { force: true }) } catch { /* already gone */ } }
    })
  }
  return copy
}

export function createMacosHelper(options: {
  sourcePath?: string
  cacheDir?: string
  platform?: NodeJS.Platform
  darwinRelease?: string
  run?: Runner
  compileTimeoutMs?: number
  callTimeoutMs?: number
  now?: () => number
  /** One helper process at a time across every server on this Mac (default true; see `call`). */
  lock?: boolean
  /** How long a call waits for another server's capture to finish before `helper_busy` (default: the call timeout). */
  lockWaitMs?: number
  /** One warm `serve` process for every call (7.7.0; default true unless COMPUTER_USE_HELPER_SERVE=false). */
  serve?: boolean
  spawnServe?: ServeSpawner
  /** A warm helper with no call for this long is stopped (default 30 s). */
  serveIdleMs?: number
  env?: NodeJS.ProcessEnv
} = {}): MacosHelper {
  const platform = options.platform ?? process.platform
  const sourcePath = options.sourcePath ?? defaultHelperSourcePath()
  const cacheDir = options.cacheDir ?? defaultHelperCacheDir()
  const run = options.run ?? defaultRunner
  const compileTimeoutMs = options.compileTimeoutMs ?? 180_000
  const callTimeoutMs = options.callTimeoutMs ?? 30_000
  const sck = platform === 'darwin' && darwinSupportsScreenCaptureKit(options.darwinRelease)
  let compiled: Promise<HelperAvailability> | undefined

  const compile = (): Promise<HelperAvailability> =>
    compileSwiftHelper({ sourcePath, cacheDir, name: 'macos-agent-helper', run, compileTimeoutMs, platform })

  const now = options.now ?? Date.now
  let failedAt = 0
  // The signal is accepted for API compatibility; the compile itself runs without it (7.6.1).
  const ensure = (signal?: AbortSignal): Promise<HelperAvailability> => {
    if (!compiled) {
      compiled = compile().then(result => {
        if (!result.ok) failedAt = now()
        return result
      })
    } else if (failedAt && now() - failedAt > 10 * 60_000) {
      // A failed build is retried after ten minutes, not on every capture: each
      // attempt can cost a swiftc run, and screenshot falls back meanwhile.
      failedAt = 0
      compiled = undefined
      return ensure(signal)
    }
    return compiled
  }

  // Two ScreenCaptureKit captures running at once hang each other until killed (measured 2026-10-09: fifteen
  // sequential helper runs passed, two side by side both stalled). So helper runs are serialised: a promise chain
  // within this server, and an advisory lock file in the cache directory across servers (James runs several
  // sessions, each with its own server). A lock left by a dead process is taken over; a live holder is waited for.
  // 2026-10-25: those helpers shared one code identity, which is what makes ScreenCaptureKit hang (see
  // ownHelperCopy). Each instance now runs its own copy; the lock stays as defence in depth.
  const useLock = options.lock ?? true
  const lockWaitMs = options.lockWaitMs ?? callTimeoutMs
  const lockPath = join(cacheDir, 'helper.lock')
  const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new HelperFailure('aborted', 'helper call aborted')) }, { once: true })
  })
  const pidAlive = processAlive
  const acquireLock = async (signal?: AbortSignal): Promise<void> => {
    const deadline = now() + lockWaitMs
    for (;;) {
      try {
        const fd = openSync(lockPath, 'wx')
        try { writeSync(fd, String(process.pid)) } finally { closeSync(fd) }
        return
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error
      }
      let holder = Number.NaN
      try { holder = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10) } catch { /* being written or gone */ }
      if (Number.isFinite(holder) && holder !== process.pid && !pidAlive(holder)) {
        try { unlinkSync(lockPath) } catch { /* someone else took it */ }
        continue
      }
      if (now() > deadline) {
        throw new HelperFailure('helper_busy',
          `another capture (pid ${Number.isFinite(holder) ? holder : 'unknown'}) has held ${lockPath} for over ${lockWaitMs} ms; `
          + 'two ScreenCaptureKit captures at once hang each other, so this one was not started')
      }
      await sleep(50, signal)
    }
  }
  const releaseLock = (): void => {
    try { if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) unlinkSync(lockPath) } catch { /* not ours or gone */ }
  }
  let queue: Promise<unknown> = Promise.resolve()
  const serialised = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  // 7.7.0 (K8): one warm `serve` process answers every call, a JSON line each way. It is stopped after serveIdleMs
  // without a call and exits by itself when this process goes (its stdin closes). A timeout or a cancel stops it, and
  // the helper exits after a ScreenCaptureKit stall, so a stuck capture never holds up the next one. Calls stay
  // serialised and locked as before: the lock is about two captures at once, not about processes.
  const serveMode = options.serve ?? (options.env ?? process.env).COMPUTER_USE_HELPER_SERVE !== 'false'
  const spawnServe: ServeSpawner = options.spawnServe ?? ((file, args) => spawn(file, args))
  const serveIdleMs = options.serveIdleMs ?? 30_000
  type Waiter = (reply: Record<string, unknown> | Error) => void
  let warm: { child: ChildProcessWithoutNullStreams; waiters: Map<number, Waiter>; stderr: string } | undefined
  let nextId = 0
  let idleTimer: NodeJS.Timeout | undefined

  // A warm helper keeps the event loop alive only while a call is waiting for it.
  const hold = (child: ChildProcessWithoutNullStreams, on: boolean): void => {
    for (const handle of [child, child.stdin, child.stdout, child.stderr] as Array<{ ref?(): void; unref?(): void }>) {
      if (on) handle.ref?.()
      else handle.unref?.()
    }
  }
  const stopWarm = (): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined }
    const state = warm
    if (!state) return
    warm = undefined
    for (const waiter of state.waiters.values()) waiter(new HelperFailure('aborted', 'the helper was stopped'))
    state.waiters.clear()
    try { state.child.stdin.end() } catch { /* already closed */ }
    try { state.child.kill() } catch { /* already gone */ }
  }
  const startWarm = (path: string): NonNullable<typeof warm> => {
    const child = spawnServe(path, ['serve', '--idle-ms', String(serveIdleMs * 2)])
    const state = { child, waiters: new Map<number, Waiter>(), stderr: '' }
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        let reply: Record<string, unknown> | null = null
        try { reply = JSON.parse(line) as Record<string, unknown> | null } catch { /* not a reply */ }
        const waiter = typeof reply?.id === 'number' ? state.waiters.get(reply.id) : undefined
        if (reply && waiter) waiter(reply)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { state.stderr = (state.stderr + chunk).slice(-400) })
    const gone = (why: string): void => {
      if (warm === state) warm = undefined
      const detail = state.stderr.trim()
      for (const waiter of state.waiters.values()) waiter(new HelperExited(detail ? `${why}: ${detail}` : why))
      state.waiters.clear()
    }
    child.on('exit', (code, signal) => gone(`the helper exited (${signal ?? `code ${code}`}) before replying`))
    child.on('error', error => gone(`the helper could not run: ${error.message}`))
    child.stdin.on('error', () => { /* EPIPE; the exit reports it */ })
    hold(child, false)
    warm = state
    return state
  }
  const serveCall = (path: string, args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new HelperFailure('aborted', 'helper call aborted')); return }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined }
    const state = warm ?? startWarm(path)
    const id = ++nextId
    let settled = false
    // A cancelled or timed-out capture would still finish in the helper after its lock was released, so the helper
    // is stopped with it, as the one-shot process was.
    const timer = setTimeout(() => {
      finish(new HelperFailure('helper_timeout', `helper timed out after ${callTimeoutMs} ms and was stopped`))
      stopWarm()
    }, callTimeoutMs)
    const finish = (reply: Record<string, unknown> | Error): void => {
      if (settled) return
      settled = true
      state.waiters.delete(id)
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (warm === state && state.waiters.size === 0) {
        hold(state.child, false)
        idleTimer = setTimeout(stopWarm, serveIdleMs)
        idleTimer.unref()
      }
      if (reply instanceof Error) reject(reply)
      else resolve(reply)
    }
    const onAbort = (): void => { finish(new HelperFailure('aborted', 'helper call aborted')); stopWarm() }
    state.waiters.set(id, finish)
    signal?.addEventListener('abort', onAbort, { once: true })
    hold(state.child, true)
    state.child.stdin.write(`${JSON.stringify({ id, args })}\n`)
  })
  // Every helper command only reads, so a call whose helper died under it (its idle exit raced the call, or a crash)
  // is asked once more of a fresh process.
  const serveRetrying = async (path: string, args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> => {
    try { return await serveCall(path, args, signal) } catch (error) {
      if (!(error instanceof HelperExited)) throw error
    }
    try { return await serveCall(path, args, signal) } catch (error) {
      throw error instanceof HelperExited ? new HelperFailure('helper_failed', error.message.slice(0, 400)) : error
    }
  }

  const oneShot = async (path: string, args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const result = await run(path, args, { timeout: callTimeoutMs, signal })
    let parsed: Record<string, unknown> | undefined
    try { parsed = JSON.parse(result.stdout.trim().split('\n').pop() ?? '') as Record<string, unknown> } catch { /* below */ }
    if (!parsed) {
      if (signal?.aborted) throw new HelperFailure('aborted', 'helper call aborted')
      const detail = (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 400)
      throw new HelperFailure(/timed out/.test(detail) ? 'helper_timeout' : 'helper_failed', detail)
    }
    return parsed
  }

  // The binary this instance runs: its own signed copy of the compiled helper (see ownHelperCopy).
  let runnable: { shared: string; path: Promise<string> } | undefined
  const runnablePath = (shared: string): Promise<string> => {
    if (runnable?.shared !== shared) runnable = { shared, path: ownHelperCopy(shared, run) }
    return runnable.path
  }

  const call = (args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> => serialised(async () => {
    const availability = await ensure(signal)
    if (!availability.ok) throw new HelperFailure('helper_unavailable', `${availability.reason}. ${availability.remediation}`)
    const path = await runnablePath(availability.path)
    if (useLock) {
      try { mkdirSync(cacheDir, { recursive: true }) } catch { /* exists */ }
      await acquireLock(signal)
    }
    let parsed: Record<string, unknown>
    try {
      parsed = serveMode ? await serveRetrying(path, args, signal) : await oneShot(path, args, signal)
    } finally {
      if (useLock) releaseLock()
    }
    if (typeof parsed.error === 'string') throw new HelperFailure(parsed.error, String(parsed.message ?? parsed.error))
    return parsed
  })

  return {
    ensure,
    supportsCapture: () => sck,
    close: stopWarm,
    async capture({ windowId, displayId, overlayPids, width, format = 'jpeg', quality = 80, region, diff, skipUnchanged }, signal) {
      if (!sck) throw new HelperFailure('sck_unavailable', 'ScreenCaptureKit capture needs macOS 14 or later')
      const out = join(tmpdir(), `cu-mcp-sck-${process.pid}-${randomBytes(6).toString('hex')}.${format === 'png' ? 'png' : 'jpg'}`)
      const args = ['capture']
      if (displayId !== undefined) {
        args.push('--display', String(displayId))
        if (overlayPids?.length) args.push('--overlay-pids', overlayPids.join(','))
      } else if (windowId !== undefined) {
        args.push('--window', String(windowId))
      } else {
        throw new HelperFailure('usage', 'capture needs a window or a display')
      }
      args.push('--out', out, '--format', format, '--quality', String(quality))
      if (width) args.push('--width', String(Math.round(width)))
      if (region) args.push('--region', [region.x, region.y, region.width, region.height].join(','))
      if (diff) {
        args.push('--diff')
        if (typeof diff === 'string') args.push('--diff-key', diff)
        if (skipUnchanged) args.push('--skip-unchanged')
      }
      try {
        const result = await call(args, signal) as unknown as HelperCapture
        // An unchanged capture with skipUnchanged was never encoded: there is no file.
        return { ...result, data: result.unchanged ? Buffer.alloc(0) : readFileSync(out) }
      } finally {
        try { rmSync(out, { force: true }) } catch { /* already gone */ }
      }
    },
    async ocr({ windowId, imagePath, region, languages, fast }, signal) {
      if (windowId !== undefined && !sck) {
        throw new HelperFailure('sck_unavailable', 'Window OCR captures with ScreenCaptureKit, which needs macOS 14 or later')
      }
      const args = ['ocr']
      if (windowId !== undefined) args.push('--window', String(windowId))
      else if (imagePath) args.push('--image', imagePath)
      else throw new HelperFailure('usage', 'ocr needs a window or an image')
      if (region) args.push('--region', [region.x, region.y, region.width, region.height].join(','))
      if (languages?.length) args.push('--languages', languages.join(','))
      if (fast) args.push('--fast')
      return await call(args, signal) as unknown as HelperOcr
    },
  }
}
