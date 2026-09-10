import { AsyncLocalStorage } from 'node:async_hooks'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { NativeModule } from '../native.js'

const IS_WINDOWS = process.platform === 'win32'
const IS_LINUX = process.platform === 'linux'

export const DEFAULT_SESSION_LOCK_PATH = IS_WINDOWS
  ? path.join(os.tmpdir(), '.computer-use-mcp.lock')
  : '/tmp/.computer-use-mcp.lock'

export class LockError extends Error {
  readonly lockingPid: number | null

  constructor(lockingPid: number | null) {
    super(lockingPid != null
      ? `computer-use session locked by PID ${lockingPid}`
      : 'computer-use session locked')
    this.name = 'LockError'
    this.lockingPid = lockingPid
  }
}

export interface LockPumpController {
  acquire(): void
  release(): void
  readonly refcount: number
}

interface LockHandle {
  release(): void
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * A holder renews its lease while it works, so liveness never depends on PID
 * existence alone — an operating system that recycles a dead holder's PID would
 * otherwise make the lock permanently unreclaimable.
 */
const LEASE_TTL_MS = 30_000
const LEASE_RENEW_INTERVAL_MS = 5_000
/** An orphaned reclaim guard must expire, or one crash disables stale recovery forever. */
const RECLAIM_GUARD_TTL_MS = 10_000

/** Exposed so callers and tests can reason about staleness without duplicating the constant. */
export const SESSION_LEASE_TTL_MS = LEASE_TTL_MS

interface Lease {
  pid: number
  /** Absent for locks written by older versions, which only recorded a bare PID. */
  renewedAt?: number
}

export type SessionLease = Lease

export function readSessionLease(lockPath: string): SessionLease | undefined {
  return readLease(lockPath)
}

function readLease(lockPath: string): Lease | undefined {
  let raw: string
  try { raw = fs.readFileSync(lockPath, 'utf8').trim() } catch { return undefined }
  if (!raw) return undefined
  let parsed: unknown
  // A legacy lease is a bare PID, which is itself valid JSON — parse first, then
  // decide by shape rather than relying on a parse failure to signal the format.
  try { parsed = JSON.parse(raw) } catch { parsed = undefined }
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as { pid?: unknown; renewedAt?: unknown }
    const pid = Number(record.pid)
    if (!Number.isInteger(pid) || pid <= 0) return undefined
    return typeof record.renewedAt === 'number'
      ? { pid, renewedAt: record.renewedAt }
      : { pid }
  }
  // Bare PID from an older process: liveness is the only signal available.
  const pid = typeof parsed === 'number' ? parsed : Number.parseInt(raw, 10)
  return Number.isInteger(pid) && pid > 0 ? { pid } : undefined
}

/** Reclaimable when the owner is gone, or when it stopped renewing while still holding a PID. */
function leaseIsStale(lease: Lease, now: number): boolean {
  if (!pidIsAlive(lease.pid)) return true
  return lease.renewedAt !== undefined && now - lease.renewedAt > LEASE_TTL_MS
}

function writeLease(descriptor: number, pid: number): void {
  const payload = JSON.stringify({ pid, renewedAt: Date.now() })
  fs.ftruncateSync(descriptor, 0)
  fs.writeSync(descriptor, payload, 0, 'utf8')
}

/**
 * Serialize stale recovery so two reclaimers cannot remove a new lease. Returns
 * `undefined` when another reclaimer holds a still-fresh guard.
 */
function acquireReclaimGuard(guardPath: string): number | undefined {
  try { return fs.openSync(guardPath, 'wx', 0o600) } catch { /* fall through to expiry */ }
  try {
    if (Date.now() - fs.statSync(guardPath).mtimeMs < RECLAIM_GUARD_TTL_MS) return undefined
    fs.unlinkSync(guardPath)
  } catch { return undefined }
  try { return fs.openSync(guardPath, 'wx', 0o600) } catch { return undefined }
}

function releaseReclaimGuard(descriptor: number, guardPath: string): void {
  try { fs.closeSync(descriptor) } catch { /* already closed */ }
  // A failed unlink must not mask the outcome; RECLAIM_GUARD_TTL_MS expires it.
  try { fs.unlinkSync(guardPath) } catch { /* expiry handles the leftover */ }
}

/** Acquire the cross-process writer lock, reclaiming only files with a confirmed dead owner. */
export function acquireSessionLock(lockPath: string): LockHandle {
  try {
    const descriptor = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      0o600,
    )
    writeLease(descriptor, process.pid)
    const identity = fs.fstatSync(descriptor)
    let released = false
    const renew = setInterval(() => {
      if (released) return
      try { writeLease(descriptor, process.pid) } catch { /* release reports the real failure */ }
    }, LEASE_RENEW_INTERVAL_MS)
    renew.unref?.()
    return {
      release() {
        if (released) return
        released = true
        clearInterval(renew)
        try {
          const current = fs.lstatSync(lockPath)
          if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(lockPath)
        } catch { /* no longer owned */ }
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
      },
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const lease = readLease(lockPath)
    const holder = lease?.pid ?? null

    if (lease && holder !== process.pid && leaseIsStale(lease, Date.now())) {
      const guardPath = lockPath + '.reclaim'
      const guard = acquireReclaimGuard(guardPath)
      if (guard === undefined) throw new LockError(holder)
      try {
        const current = readLease(lockPath)
        // Re-read under the guard: the lease may have been replaced or renewed.
        if (!current || current.pid !== lease.pid || !leaseIsStale(current, Date.now())) {
          throw new LockError(current?.pid ?? holder)
        }
        fs.unlinkSync(lockPath)
      } finally { releaseReclaimGuard(guard, guardPath) }
      return acquireSessionLock(lockPath)
    }
    throw new LockError(holder)
  }
}

/**
 * Refcounted adapter over the cross-process lock and the macOS CFRunLoop pump.
 * The injected drain function keeps this service directly testable and avoids
 * coupling the lock lifecycle to the rest of the session dispatcher.
 */
export function createLockPumpController(options: {
  lockPath?: string
  disableLock?: boolean
  drainRunloop?: NativeModule['drainRunloop']
  pumpIntervalMs?: number
} = {}): LockPumpController {
  const lockPath = options.lockPath ?? DEFAULT_SESSION_LOCK_PATH
  const disableLock = options.disableLock ?? false
  const pumpIntervalMs = options.pumpIntervalMs ?? 1
  if (!Number.isFinite(pumpIntervalMs) || pumpIntervalMs < 1) {
    throw new RangeError('pumpIntervalMs must be at least 1')
  }

  let refcount = 0
  let handle: LockHandle | undefined
  let pump: NodeJS.Timeout | undefined

  const startPump = () => {
    if (IS_WINDOWS || IS_LINUX || pump || !options.drainRunloop) return
    pump = setInterval(() => {
      try { options.drainRunloop?.() } catch { /* a pump error cannot escape */ }
    }, pumpIntervalMs)
    pump.unref?.()
  }

  const stopPump = () => {
    if (!pump) return
    clearInterval(pump)
    pump = undefined
  }

  return {
    acquire() {
      if (refcount === 0 && !disableLock) handle = acquireSessionLock(lockPath)
      refcount += 1
      if (refcount === 1) startPump()
    },
    release() {
      if (refcount === 0) return
      refcount -= 1
      if (refcount !== 0) return
      stopPump()
      const acquired = handle
      handle = undefined
      acquired?.release()
    },
    get refcount() { return refcount },
  }
}

/** One in-process queue per physical desktop; only an active logical lease is reentrant. */
const operations = new AsyncLocalStorage<{ desktop: string; active: boolean }>()
const queues = new Map<string, Promise<void>>()
export async function coordinateDesktop<T>(desktop: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const inherited = operations.getStore()
  if (inherited?.active && inherited.desktop === desktop) return operation()
  const previous = queues.get(desktop) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(resolve => { release = resolve })
  const queued = previous.then(() => next)
  queues.set(desktop, queued)
  await previous
  const lease = { desktop, active: true }
  try {
    signal?.throwIfAborted()
    return await operations.run(lease, operation)
  } finally {
    lease.active = false
    release()
    if (queues.get(desktop) === queued) queues.delete(desktop)
  }
}
