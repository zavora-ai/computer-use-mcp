import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeError } from '../runtime/types.js'

export type ExecutionReceiptStatus = 'pending' | 'committed' | 'rejected' | 'interrupted' | 'indeterminate'

export interface ExecutionReceipt<Result = unknown> {
  receiptId: string
  sessionId: string
  actionId: string
  actionDigest: string
  attempt: number
  status: ExecutionReceiptStatus
  createdAt: string
  updatedAt: string
  result?: Result
  error?: { code: string; message: string }
}

export interface ReceiptStore {
  begin(request: { sessionId: string; actionId: string; actionDigest: string; attempt: number }): Promise<{ receipt: ExecutionReceipt; replay: boolean }>
  finish(receiptId: string, update: { status: Exclude<ExecutionReceiptStatus, 'pending'>; result?: unknown; error?: { code: string; message: string } }): Promise<ExecutionReceipt>
  get(sessionId: string, actionId: string): Promise<ExecutionReceipt | undefined>
  deleteSession(sessionId: string): Promise<number>
}

/**
 * Atomic in-memory idempotency journal. Durable stores implement the same
 * begin/finish contract transactionally (for example with a SQLite UNIQUE key).
 */
export class MemoryReceiptStore implements ReceiptStore {
  readonly #byAction = new Map<string, ExecutionReceipt>()
  readonly #byId = new Map<string, ExecutionReceipt>()
  readonly #now: () => Date

  constructor(now: () => Date = () => new Date()) {
    this.#now = now
  }

  async begin(request: { sessionId: string; actionId: string; actionDigest: string; attempt: number }): Promise<{ receipt: ExecutionReceipt; replay: boolean }> {
    const key = `${request.sessionId}\u0000${request.actionId}`
    const existing = this.#byAction.get(key)
    if (existing) {
      if (existing.actionDigest !== request.actionDigest) {
        throw new RuntimeError('action_id_conflict', 'action_id was reused with a different digest', {
          sessionId: request.sessionId,
          actionId: request.actionId,
        })
      }
      return { receipt: structuredClone(existing), replay: true }
    }
    const at = this.#now().toISOString()
    const receipt: ExecutionReceipt = {
      receiptId: randomUUID(),
      sessionId: request.sessionId,
      actionId: request.actionId,
      actionDigest: request.actionDigest,
      attempt: request.attempt,
      status: 'pending',
      createdAt: at,
      updatedAt: at,
    }
    this.#byAction.set(key, receipt)
    this.#byId.set(receipt.receiptId, receipt)
    return { receipt: structuredClone(receipt), replay: false }
  }

  async finish(receiptId: string, update: { status: Exclude<ExecutionReceiptStatus, 'pending'>; result?: unknown; error?: { code: string; message: string } }): Promise<ExecutionReceipt> {
    const receipt = this.#byId.get(receiptId)
    if (!receipt) throw new Error(`unknown receipt: ${receiptId}`)
    if (receipt.status !== 'pending') return structuredClone(receipt)
    const finished: ExecutionReceipt = {
      ...receipt,
      status: update.status,
      updatedAt: this.#now().toISOString(),
      ...(update.result !== undefined ? { result: structuredClone(update.result) } : {}),
      ...(update.error ? { error: { ...update.error } } : {}),
    }
    this.#byId.set(receiptId, finished)
    this.#byAction.set(`${receipt.sessionId}\u0000${receipt.actionId}`, finished)
    return structuredClone(finished)
  }

  async get(sessionId: string, actionId: string): Promise<ExecutionReceipt | undefined> {
    const receipt = this.#byAction.get(`${sessionId}\u0000${actionId}`)
    return receipt ? structuredClone(receipt) : undefined
  }

  async deleteSession(sessionId: string): Promise<number> {
    let deleted = 0
    for (const [key, receipt] of [...this.#byAction]) {
      if (receipt.sessionId !== sessionId) continue
      this.#byAction.delete(key)
      this.#byId.delete(receipt.receiptId)
      deleted++
    }
    return deleted
  }
}

/**
 * Durable per-action receipt journal.
 *
 * Creation uses O_EXCL so concurrent processes cannot reserve the same action
 * twice. Each state transition is fsynced and atomically renamed. Result bodies
 * are memory-only by default so screenshots and secret-bearing tool output are
 * not persisted merely to provide idempotency.
 */
export class FileReceiptStore implements ReceiptStore {
  readonly #directory: string
  readonly #persistResult: boolean
  readonly #byId = new Map<string, string>()
  readonly #now: () => Date
  readonly #staleLockMs: number

  constructor(directory: string, options: {
    persistResult?: boolean
    now?: () => Date
    staleLockMs?: number
  } = {}) {
    if (!directory) throw new TypeError('receipt directory is required')
    this.#directory = directory
    this.#persistResult = options.persistResult ?? false
    this.#now = options.now ?? (() => new Date())
    this.#staleLockMs = options.staleLockMs ?? 30_000
  }

  async begin(request: { sessionId: string; actionId: string; actionDigest: string; attempt: number }): Promise<{ receipt: ExecutionReceipt; replay: boolean }> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const path = this.#path(request.sessionId, request.actionId)
    const at = this.#now().toISOString()
    const receipt: ExecutionReceipt = {
      receiptId: randomUUID(),
      sessionId: request.sessionId,
      actionId: request.actionId,
      actionDigest: request.actionDigest,
      attempt: request.attempt,
      status: 'pending',
      createdAt: at,
      updatedAt: at,
    }
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(receipt))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.#syncDirectory()
      this.#byId.set(receipt.receiptId, path)
      return { receipt: structuredClone(receipt), replay: false }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = await this.#readReservation(path, request)
      if (existing.sessionId !== request.sessionId || existing.actionId !== request.actionId) {
        throw new Error('receipt journal key collision')
      }
      if (existing.actionDigest !== request.actionDigest) {
        throw new RuntimeError('action_id_conflict', 'action_id was reused with a different digest', {
          sessionId: request.sessionId,
          actionId: request.actionId,
        })
      }
      this.#byId.set(existing.receiptId, path)
      return { receipt: existing, replay: true }
    }
  }

  async finish(receiptId: string, update: { status: Exclude<ExecutionReceiptStatus, 'pending'>; result?: unknown; error?: { code: string; message: string } }): Promise<ExecutionReceipt> {
    const path = this.#byId.get(receiptId)
    if (!path) throw new Error(`unknown receipt in this store instance: ${receiptId}`)
    return this.#withLock(path, async () => {
      const current = await this.#read(path)
      if (current.status !== 'pending') return current
      const finished: ExecutionReceipt = {
        ...current,
        status: update.status,
        updatedAt: this.#now().toISOString(),
        ...(this.#persistResult && update.result !== undefined ? { result: structuredClone(update.result) } : {}),
        ...(update.error ? { error: {
          code: update.error.code,
          message: `[REDACTED sha256:${createHash('sha256').update(update.error.message).digest('hex')} length:${update.error.message.length}]`,
        } } : {}),
      }
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(finished))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, path)
      await this.#syncDirectory()
      return structuredClone(finished)
    })
  }

  async get(sessionId: string, actionId: string): Promise<ExecutionReceipt | undefined> {
    try {
      const receipt = await this.#read(this.#path(sessionId, actionId))
      this.#byId.set(receipt.receiptId, this.#path(sessionId, actionId))
      return receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async deleteSession(sessionId: string): Promise<number> {
    let names: string[]
    try { names = (await readdir(this.#directory)).filter(name => name.endsWith('.json')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
    let deleted = 0
    for (const name of names) {
      const path = join(this.#directory, name)
      await this.#withLock(path, async () => {
        let receipt: ExecutionReceipt
        try { receipt = await this.#read(path) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
          throw error
        }
        if (receipt.sessionId !== sessionId) return
        await rm(path, { force: true })
        this.#byId.delete(receipt.receiptId)
        deleted++
      })
    }
    if (deleted > 0) await this.#syncDirectory()
    return deleted
  }

  #path(sessionId: string, actionId: string): string {
    const key = createHash('sha256').update(`${sessionId}\u0000${actionId}`).digest('hex')
    return join(this.#directory, `${key}.json`)
  }

  async #read(path: string): Promise<ExecutionReceipt> {
    return JSON.parse(await readFile(path, 'utf8')) as ExecutionReceipt
  }

  async #readReservation(
    path: string,
    request: { sessionId: string; actionId: string },
  ): Promise<ExecutionReceipt> {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { return await this.#read(path) }
      catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    throw new RuntimeError('indeterminate', 'receipt reservation exists but is incomplete or corrupt', {
      sessionId: request.sessionId,
      actionId: request.actionId,
    })
  }

  async #syncDirectory(): Promise<void> {
    try {
      const directory = await open(this.#directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch { /* directory fsync is unavailable on some Windows filesystems */ }
  }

  async #withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const lock = `${path}.lock`
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await mkdir(lock, { mode: 0o700 })
        try { return await operation() } finally { await rm(lock, { recursive: true, force: true }) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          if (Date.now() - (await stat(lock)).mtimeMs > this.#staleLockMs) {
            await rm(lock, { recursive: true, force: true })
            continue
          }
        } catch { /* another process released it */ }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
    }
    throw new Error(`receipt terminal-state lock timeout: ${path}`)
  }
}
