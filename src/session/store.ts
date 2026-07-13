import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionState } from './events.js'

export interface RuntimeSession {
  sessionId: string
  principalId: string
  executionGroupId?: string
  objective?: string
  state: SessionState
  revision: number
  createdAt: string
  updatedAt: string
  waitingReason?: string
  recovered?: boolean
  completion?: SessionCompletionEvidence
}

export interface SessionCompletionEvidence {
  summary: string
  postconditions: Array<{ description: string; satisfied: boolean; evidenceHash?: string }>
  lastAppId?: string
  lastWindowId?: string | number
  actionCounts: Record<string, number>
  reason?: string
  completedAt: string
}

export interface SessionStore {
  create(input: { principalId: string; executionGroupId?: string; objective?: string }): Promise<RuntimeSession>
  get(sessionId: string): Promise<RuntimeSession | undefined>
  compareAndSet(sessionId: string, expectedRevision: number, next: RuntimeSession): Promise<boolean>
  delete(sessionId: string, expectedRevision: number): Promise<boolean>
  list(): Promise<RuntimeSession[]>
}

export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, RuntimeSession>()
  readonly #now: () => Date

  constructor(now: () => Date = () => new Date()) {
    this.#now = now
  }

  async create(input: { principalId: string; executionGroupId?: string; objective?: string }): Promise<RuntimeSession> {
    const at = this.#now().toISOString()
    const session: RuntimeSession = {
      sessionId: randomUUID(),
      principalId: input.principalId,
      ...(input.executionGroupId ? { executionGroupId: input.executionGroupId } : {}),
      ...(input.objective ? { objective: input.objective } : {}),
      state: 'created',
      revision: 1,
      createdAt: at,
      updatedAt: at,
    }
    this.#sessions.set(session.sessionId, session)
    return structuredClone(session)
  }

  async get(sessionId: string): Promise<RuntimeSession | undefined> {
    const value = this.#sessions.get(sessionId)
    return value ? structuredClone(value) : undefined
  }

  async compareAndSet(sessionId: string, expectedRevision: number, next: RuntimeSession): Promise<boolean> {
    const current = this.#sessions.get(sessionId)
    if (!current || current.revision !== expectedRevision || next.sessionId !== sessionId) return false
    this.#sessions.set(sessionId, structuredClone(next))
    return true
  }

  async delete(sessionId: string, expectedRevision: number): Promise<boolean> {
    const current = this.#sessions.get(sessionId)
    if (!current || current.revision !== expectedRevision) return false
    return this.#sessions.delete(sessionId)
  }

  async list(): Promise<RuntimeSession[]> {
    return [...this.#sessions.values()].map(value => structuredClone(value))
  }
}

/** Durable per-session CAS store. Nonterminal recovery is explicit and always paused. */
export class FileSessionStore implements SessionStore {
  readonly #directory: string
  readonly #now: () => Date
  readonly #staleLockMs: number
  readonly #maxSessions: number

  constructor(directory: string, options: {
    now?: () => Date
    staleLockMs?: number
    maxSessions?: number
  } = {}) {
    if (!directory) throw new TypeError('session directory is required')
    this.#directory = directory
    this.#now = options.now ?? (() => new Date())
    this.#staleLockMs = options.staleLockMs ?? 30_000
    this.#maxSessions = options.maxSessions ?? 1000
    if (!Number.isInteger(this.#maxSessions) || this.#maxSessions < 1 || this.#maxSessions > 1_000_000) {
      throw new RangeError('maxSessions must be between 1 and 1000000')
    }
  }

  async create(input: { principalId: string; executionGroupId?: string; objective?: string }): Promise<RuntimeSession> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    return this.#withPathLock(join(this.#directory, '.store.lock'), async () => {
      if ((await this.list()).length >= this.#maxSessions) {
        throw new Error(`session store limit reached (${this.#maxSessions}); prune terminal sessions before starting new work`)
      }
      const at = this.#now().toISOString()
      const session: RuntimeSession = {
        sessionId: randomUUID(), principalId: input.principalId,
        ...(input.executionGroupId ? { executionGroupId: input.executionGroupId } : {}),
        ...(input.objective ? { objective: input.objective } : {}),
        state: 'created', revision: 1, createdAt: at, updatedAt: at,
      }
      const handle = await open(this.#path(session.sessionId), 'wx', 0o600)
      try { await handle.writeFile(JSON.stringify(session)); await handle.sync() } finally { await handle.close() }
      await this.#syncDirectory()
      return structuredClone(session)
    })
  }

  async get(sessionId: string): Promise<RuntimeSession | undefined> {
    try { return JSON.parse(await readFile(this.#path(sessionId), 'utf8')) as RuntimeSession }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async compareAndSet(sessionId: string, expectedRevision: number, next: RuntimeSession): Promise<boolean> {
    return this.#withLock(sessionId, async () => {
      const current = await this.get(sessionId)
      if (!current || current.revision !== expectedRevision || next.sessionId !== sessionId) return false
      await this.#writeAtomic(sessionId, next)
      return true
    })
  }

  async delete(sessionId: string, expectedRevision: number): Promise<boolean> {
    return this.#withLock(sessionId, async () => {
      const current = await this.get(sessionId)
      if (!current || current.revision !== expectedRevision) return false
      await rm(this.#path(sessionId), { force: true })
      await this.#syncDirectory()
      return true
    })
  }

  async list(): Promise<RuntimeSession[]> {
    try {
      const names = (await readdir(this.#directory)).filter(name => name.endsWith('.json'))
      return Promise.all(names.map(async name => JSON.parse(await readFile(join(this.#directory, name), 'utf8')) as RuntimeSession))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /** Mark every recovered nonterminal session paused before exposing it to a host. */
  async recoverAll(): Promise<RuntimeSession[]> {
    const terminal = new Set<SessionState>(['completed', 'failed', 'stopped'])
    const recovered: RuntimeSession[] = []
    for (const session of await this.list()) {
      if (terminal.has(session.state)) continue
      const next: RuntimeSession = {
        ...session, state: 'paused_by_user', recovered: true, waitingReason: 'runtime_recovered',
        revision: session.revision + 1, updatedAt: this.#now().toISOString(),
      }
      if (await this.compareAndSet(session.sessionId, session.revision, next)) recovered.push(next)
    }
    return recovered
  }

  #path(sessionId: string): string {
    const key = createHash('sha256').update(sessionId).digest('hex')
    return join(this.#directory, `${key}.json`)
  }

  async #writeAtomic(sessionId: string, value: RuntimeSession): Promise<void> {
    const path = this.#path(sessionId)
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
    await this.#syncDirectory()
  }

  async #syncDirectory(): Promise<void> {
    try {
      const directory = await open(this.#directory, 'r')
      try { await directory.sync() } finally { await directory.close() }
    } catch { /* directory fsync is unavailable on some Windows filesystems */ }
  }

  async #withLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    return this.#withPathLock(`${this.#path(sessionId)}.lock`, operation)
  }

  async #withPathLock<T>(lock: string, operation: () => Promise<T>): Promise<T> {
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
    throw new Error(`session store lock timeout: ${lock}`)
  }
}
