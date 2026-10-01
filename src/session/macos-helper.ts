/**
 * The macOS agent helper (v7.5, design §2): ScreenCaptureKit window capture and
 * Vision OCR in a small Swift program.
 *
 * `libexec/macos-agent-helper.swift` is compiled on first use with `swiftc -O` into
 * `~/Library/Caches/computer-use-mcp/macos-agent-helper-<sha8>` (sha of the source,
 * so an edited source rebuilds) and signed ad hoc. swiftc ships with Xcode and the
 * Command Line Tools; without it the helper reports itself unavailable and callers
 * fall back (screencapture for captures; OCR has no fallback).
 */

import { execFile, type ExecFileOptions } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir, release, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface HelperFrame { x: number; y: number; width: number; height: number }

export interface HelperCapture {
  path: string
  width: number
  height: number
  hash: string
  /** Image pixels per window point. */
  scale: number
  frame: HelperFrame
  mimeType: string
  bytes: number
}

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
  /** True when window capture goes through ScreenCaptureKit (macOS 14+). */
  supportsCapture(): boolean
  capture(options: {
    windowId: number
    width?: number
    format?: 'png' | 'jpeg'
    quality?: number
  }, signal?: AbortSignal): Promise<HelperCapture & { data: Buffer }>
  ocr(options: {
    windowId?: number
    imagePath?: string
    /** Window points with windowId; image pixels with imagePath. */
    region?: { x: number; y: number; width: number; height: number }
    languages?: string[]
    fast?: boolean
  }, signal?: AbortSignal): Promise<HelperOcr>
}

export class HelperFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'HelperFailure'
  }
}

type Runner = (
  file: string, args: string[], options: ExecFileOptions & { signal?: AbortSignal },
) => Promise<{ stdout: string; stderr: string; code: number }>

const defaultRunner: Runner = (file, args, options) => new Promise(resolve => {
  execFile(file, args, { ...options, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
    resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? error?.message ?? ''), code })
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

export function createMacosHelper(options: {
  sourcePath?: string
  cacheDir?: string
  platform?: NodeJS.Platform
  darwinRelease?: string
  run?: Runner
  compileTimeoutMs?: number
  callTimeoutMs?: number
  now?: () => number
} = {}): MacosHelper {
  const platform = options.platform ?? process.platform
  const sourcePath = options.sourcePath ?? defaultHelperSourcePath()
  const cacheDir = options.cacheDir ?? defaultHelperCacheDir()
  const run = options.run ?? defaultRunner
  const compileTimeoutMs = options.compileTimeoutMs ?? 180_000
  const callTimeoutMs = options.callTimeoutMs ?? 30_000
  const sck = platform === 'darwin' && darwinSupportsScreenCaptureKit(options.darwinRelease)
  let compiled: Promise<HelperAvailability> | undefined

  const compile = async (signal?: AbortSignal): Promise<HelperAvailability> => {
    if (platform !== 'darwin') {
      return { ok: false, reason: 'macOS only', remediation: 'This needs macOS (ScreenCaptureKit and Vision).' }
    }
    let source: Buffer
    try { source = readFileSync(sourcePath) } catch {
      return { ok: false, reason: `helper source missing: ${sourcePath}`, remediation: 'Reinstall the package; libexec/macos-agent-helper.swift is part of it.' }
    }
    const sha = createHash('sha256').update(source).digest('hex').slice(0, 8)
    const target = join(cacheDir, `macos-agent-helper-${sha}`)
    if (existsSync(target)) return { ok: true, path: target }
    const remediation = 'Install the Xcode Command Line Tools (xcode-select --install) so swiftc can build the helper, then retry.'
    const which = await run('xcrun', ['-f', 'swiftc'], { timeout: 10_000, signal })
    if (which.code !== 0) return { ok: false, reason: 'swiftc not found', remediation }
    try { mkdirSync(cacheDir, { recursive: true }) } catch { /* reported by the compile */ }
    // Build to a unique name and rename into place, so two processes compiling at
    // once never run a half-written binary.
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    const built = await run('xcrun', ['swiftc', '-O', '-o', temporary, sourcePath], { timeout: compileTimeoutMs, signal })
    if (built.code !== 0 || !existsSync(temporary)) {
      try { rmSync(temporary, { force: true }) } catch { /* nothing to remove */ }
      return { ok: false, reason: `swiftc failed: ${built.stderr.trim().slice(0, 400)}`, remediation }
    }
    await run('codesign', ['--force', '--sign', '-', temporary], { timeout: 30_000, signal })
    try { renameSync(temporary, target) } catch (error) {
      return { ok: false, reason: `could not install helper: ${(error as Error).message}`, remediation }
    }
    return { ok: true, path: target }
  }

  const now = options.now ?? Date.now
  let failedAt = 0
  const ensure = (signal?: AbortSignal): Promise<HelperAvailability> => {
    if (!compiled) {
      compiled = compile(signal).then(result => {
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

  const call = async (args: string[], signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const availability = await ensure(signal)
    if (!availability.ok) throw new HelperFailure('helper_unavailable', `${availability.reason}. ${availability.remediation}`)
    const result = await run(availability.path, args, { timeout: callTimeoutMs, signal })
    let parsed: Record<string, unknown> | undefined
    try { parsed = JSON.parse(result.stdout.trim().split('\n').pop() ?? '') as Record<string, unknown> } catch { /* below */ }
    if (!parsed) {
      if (signal?.aborted) throw new HelperFailure('aborted', 'helper call aborted')
      throw new HelperFailure('helper_failed', (result.stderr || result.stdout || `exit ${result.code}`).trim().slice(0, 400))
    }
    if (typeof parsed.error === 'string') throw new HelperFailure(parsed.error, String(parsed.message ?? parsed.error))
    return parsed
  }

  return {
    ensure,
    supportsCapture: () => sck,
    async capture({ windowId, width, format = 'jpeg', quality = 80 }, signal) {
      if (!sck) throw new HelperFailure('sck_unavailable', 'ScreenCaptureKit window capture needs macOS 14 or later')
      const out = join(tmpdir(), `cu-mcp-sck-${process.pid}-${randomBytes(6).toString('hex')}.${format === 'png' ? 'png' : 'jpg'}`)
      const args = ['capture', '--window', String(windowId), '--out', out, '--format', format, '--quality', String(quality)]
      if (width) args.push('--width', String(Math.round(width)))
      try {
        const result = await call(args, signal) as unknown as HelperCapture
        return { ...result, data: readFileSync(out) }
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
