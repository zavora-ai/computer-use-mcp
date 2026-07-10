/**
 * Spawn + timing helpers — extracted verbatim from session.ts (PR-13b split).
 */

import { execFile } from 'child_process'

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Sleep that resolves early if the signal aborts. Resolves `true` when it was
 * cut short by an abort, `false` when the full duration elapsed. (PR-14 cancellation.)
 */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true)
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => { cleanup(); resolve(false) }, ms)
    const onAbort = () => { clearTimeout(timer); cleanup(); resolve(true) }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ── Scripting bridge ──────────────────────────────────────────────────────────

export interface SpawnResult {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
}

export type SpawnBounded = (
  cmd: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<SpawnResult>

/** Spawn a process with a hard timeout. Kills the child on overrun or abort. */
export const defaultSpawnBounded: SpawnBounded = (cmd, args, timeoutMs, signal) =>
  new Promise<SpawnResult>(resolve => {
    if (signal?.aborted) {
      resolve({ stdout: '', stderr: 'aborted', code: -1, timedOut: false })
      return
    }
    const child = execFile(cmd, args, { timeout: 0, maxBuffer: 8 * 1024 * 1024 })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => { stdout += chunk.toString() })
    child.stderr?.on('data', chunk => { stderr += chunk.toString() })
    let timedOut = false
    let aborted = false
    const onAbort = () => {
      aborted = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const killer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, Math.max(timeoutMs, 100))
    child.on('error', err => {
      clearTimeout(killer)
      cleanup()
      resolve({ stdout, stderr: stderr || String(err), code: -1, timedOut })
    })
    child.on('close', code => {
      clearTimeout(killer)
      cleanup()
      resolve({ stdout, stderr: aborted ? (stderr || 'aborted') : stderr, code: code ?? -1, timedOut })
    })
  })
