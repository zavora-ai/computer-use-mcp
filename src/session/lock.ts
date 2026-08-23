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

/** Acquire the cross-process writer lock, reclaiming stale or self-owned files. */
export function acquireSessionLock(lockPath: string): LockHandle {
  try {
    const descriptor = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
      0o600,
    )
    fs.writeSync(descriptor, String(process.pid))
    return {
      release() {
        try { fs.closeSync(descriptor) } catch { /* already closed */ }
        try { fs.unlinkSync(lockPath) } catch { /* already removed */ }
      },
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let holder: number | null = null
    try {
      const parsed = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10)
      if (Number.isFinite(parsed) && parsed > 0) holder = parsed
    } catch { /* raced with another cleanup */ }

    if (holder === null || holder === process.pid || !pidIsAlive(holder)) {
      try { fs.unlinkSync(lockPath) } catch { /* another process reclaimed it */ }
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
