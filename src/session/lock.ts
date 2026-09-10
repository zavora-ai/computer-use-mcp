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

/** Acquire the cross-process writer lock, reclaiming only files with a confirmed dead owner. */
export function acquireSessionLock(lockPath: string): LockHandle {
  try {
    const descriptor = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      0o600,
    )
    fs.writeSync(descriptor, String(process.pid))
    const identity = fs.fstatSync(descriptor)
    let released = false
    return {
      release() {
        if (released) return
        released = true
        try {
          const current = fs.lstatSync(lockPath)
          if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(lockPath)
        } catch { /* no longer owned */ }
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
      },
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let holder: number | null = null
    try {
      const parsed = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10)
      if (Number.isFinite(parsed) && parsed > 0) holder = parsed
    } catch { /* raced with another cleanup */ }

    if (holder !== null && holder !== process.pid && !pidIsAlive(holder)) {
      // Serialize stale recovery so two reclaimers cannot remove a new lease.
      const guardPath = lockPath + '.reclaim'
      let guard: number
      try { guard = fs.openSync(guardPath, 'wx', 0o600) } catch { throw new LockError(holder) }
      try {
        const current = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10)
        if (current !== holder || pidIsAlive(current)) throw new LockError(current)
        fs.unlinkSync(lockPath)
        return acquireSessionLock(lockPath)
      } finally { fs.closeSync(guard); fs.unlinkSync(guardPath) }
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
