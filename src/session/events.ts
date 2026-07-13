import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { redactRecord, type Redactor } from '../policy/redact.js'

export type SessionState =
  | 'created'
  | 'running'
  | 'waiting_for_user'
  | 'paused_by_user'
  | 'paused_by_policy'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'stopped'

export interface SessionEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  schemaVersion: 1
  eventId: string
  sequence: number
  sessionId: string
  actionId?: string
  type: string
  at: string
  principalId?: string
  payload: T
  /** Present only for events recovered from an opt-in durable journal. */
  integrity?: { previousHash: string; hash: string }
}

export interface EventDraft<T extends Record<string, unknown> = Record<string, unknown>> {
  sessionId: string
  actionId?: string
  type: string
  principalId?: string
  payload: T
}

export type EventListener = (event: SessionEvent) => void

export interface EventSink {
  append(event: SessionEvent): void
  lastSequence?(sessionId: string): number
  query?(sessionId: string, afterSequence: number, limit: number): SessionEvent[]
  deleteSession?(sessionId: string): EventDeletionResult
}

export interface EventDeletionResult {
  deletedEvents: number
  retainedEvents: number
  retentionMarkerId?: string
}

/** Versioned, monotonic in-process supervisor event bus. */
export class SupervisorEventBus {
  readonly #events = new Map<string, SessionEvent[]>()
  readonly #listeners = new Set<EventListener>()
  readonly #now: () => Date
  readonly #redact: Redactor
  readonly #sink?: EventSink

  constructor(now: () => Date = () => new Date(), redact: Redactor = redactRecord, sink?: EventSink) {
    this.#now = now
    this.#redact = redact
    this.#sink = sink
  }

  publish<T extends Record<string, unknown>>(draft: EventDraft<T>): SessionEvent<T> {
    const stream = this.#events.get(draft.sessionId) ?? []
    const lastSequence = Math.max(stream.at(-1)?.sequence ?? 0, this.#sink?.lastSequence?.(draft.sessionId) ?? 0)
    const event: SessionEvent<T> = {
      schemaVersion: 1,
      eventId: randomUUID(),
      sequence: lastSequence + 1,
      sessionId: draft.sessionId,
      ...(draft.actionId ? { actionId: draft.actionId } : {}),
      type: draft.type,
      at: this.#now().toISOString(),
      ...(draft.principalId ? { principalId: draft.principalId } : {}),
      payload: this.#redact(draft.payload) as T,
    }
    this.#sink?.append(event)
    stream.push(event)
    this.#events.set(draft.sessionId, stream)
    for (const listener of this.#listeners) listener(event)
    return event
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  query(sessionId: string, afterSequence = 0, limit = 100): SessionEvent[] {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new RangeError('afterSequence must be a non-negative integer')
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('limit must be between 1 and 1000')
    if (this.#sink?.query) return this.#sink.query(sessionId, afterSequence, limit)
    return (this.#events.get(sessionId) ?? [])
      .filter(event => event.sequence > afterSequence)
      .slice(0, limit)
  }

  deleteSession(sessionId: string): EventDeletionResult {
    const persisted = this.#sink?.deleteSession?.(sessionId)
    const deletedInMemory = this.#events.get(sessionId)?.length ?? 0
    this.#events.delete(sessionId)
    return persisted ?? {
      deletedEvents: deletedInMemory,
      retainedEvents: [...this.#events.values()].reduce((total, stream) => total + stream.length, 0),
    }
  }
}

export interface JournalRecord extends SessionEvent {
  integrity: { previousHash: string; hash: string }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Opt-in redacted JSONL audit journal with a tamper-evident SHA-256 chain. */
export class FileEventJournal implements EventSink {
  readonly #path: string
  readonly #lockPath: string
  readonly #events = new Map<string, SessionEvent[]>()
  readonly #orderedEvents: SessionEvent[] = []
  readonly #maxBytes: number
  #previousHash = '0'.repeat(64)

  constructor(path: string, options: { maxBytes?: number } = {}) {
    if (!path) throw new TypeError('event journal path is required')
    this.#path = path
    this.#lockPath = `${path}.lock`
    this.#maxBytes = options.maxBytes ?? 64 * 1024 * 1024
    if (!Number.isInteger(this.#maxBytes) || this.#maxBytes < 1024) {
      throw new RangeError('event journal maxBytes must be an integer of at least 1024')
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.#withLock(() => this.#reload())
  }

  append(event: SessionEvent): void {
    this.#withLock(() => {
      // Another server may have appended since this sink last observed the file.
      // Rebuild under the writer lock, then let the durable sink own sequencing.
      this.#reload()
      event.sequence = this.lastSequence(event.sessionId) + 1
      const hash = createHash('sha256')
        .update(`${this.#previousHash}\n${canonical(event)}`)
        .digest('hex')
      const record: JournalRecord = {
        ...event, integrity: { previousHash: this.#previousHash, hash },
      }
      const line = `${JSON.stringify(record)}\n`
      const currentBytes = existsSync(this.#path) ? statSync(this.#path).size : 0
      if (currentBytes + Buffer.byteLength(line) > this.#maxBytes) {
        throw new Error(`event journal size limit reached (${this.#maxBytes} bytes); prune terminal sessions before continuing`)
      }
      appendFileSync(this.#path, line, { encoding: 'utf8', mode: 0o600 })
      chmodSync(this.#path, 0o600)
      const fd = openSync(this.#path, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      try {
        const directory = openSync(dirname(this.#path), 'r')
        try { fsyncSync(directory) } finally { closeSync(directory) }
      } catch { /* directory fsync is unavailable on some Windows filesystems */ }
      this.#previousHash = hash
      event.integrity = { ...record.integrity }
      const stream = this.#events.get(event.sessionId) ?? []
      stream.push(structuredClone(event))
      this.#events.set(event.sessionId, stream)
      this.#orderedEvents.push(structuredClone(event))
    })
  }

  lastSequence(sessionId: string): number {
    return this.#events.get(sessionId)?.at(-1)?.sequence ?? 0
  }

  query(sessionId: string, afterSequence = 0, limit = 100): SessionEvent[] {
    return this.#withLock(() => {
      this.#reload()
      return (this.#events.get(sessionId) ?? [])
        .filter(event => event.sequence > afterSequence)
        .slice(0, limit)
        .map(event => structuredClone(event))
    })
  }

  deleteSession(sessionId: string): EventDeletionResult {
    return this.#withLock(() => {
      this.#reload()
      const removed = this.#orderedEvents.filter(event => event.sessionId === sessionId)
      if (removed.length === 0) {
        return { deletedEvents: 0, retainedEvents: this.#orderedEvents.length }
      }
      const retained = this.#orderedEvents.filter(event => event.sessionId !== sessionId)
      const previousTerminalHash = this.#previousHash
      const retentionSessionId = '__journal_retention__'
      const marker: SessionEvent = {
        schemaVersion: 1,
        eventId: randomUUID(),
        sequence: (retained.filter(event => event.sessionId === retentionSessionId).at(-1)?.sequence ?? 0) + 1,
        sessionId: retentionSessionId,
        type: 'journal.retention_applied',
        at: new Date().toISOString(),
        payload: {
          removedRecords: removed.length,
          previousTerminalHash,
          operationId: randomUUID(),
        },
      }
      this.#rewrite([...retained, marker])
      return {
        deletedEvents: removed.length,
        retainedEvents: retained.length + 1,
        retentionMarkerId: marker.eventId,
      }
    })
  }

  #reload(): void {
    this.#events.clear()
    this.#orderedEvents.splice(0)
    this.#previousHash = '0'.repeat(64)
    if (!existsSync(this.#path)) return
    const lines = readFileSync(this.#path, 'utf8').trim().split('\n').filter(Boolean)
    for (let index = 0; index < lines.length; index++) {
      const record = JSON.parse(lines[index]!) as JournalRecord
      const { integrity, ...event } = record
      const expected = createHash('sha256').update(`${this.#previousHash}\n${canonical(event)}`).digest('hex')
      if (integrity.previousHash !== this.#previousHash || integrity.hash !== expected) {
        throw new Error(`event journal integrity verification failed at record ${index + 1}`)
      }
      const stream = this.#events.get(event.sessionId) ?? []
      const expectedSequence = (stream.at(-1)?.sequence ?? 0) + 1
      if (event.sequence !== expectedSequence) {
        throw new Error(`event journal sequence verification failed for ${event.sessionId} at ${event.sequence}`)
      }
      const exported = { ...event, integrity }
      stream.push(exported)
      this.#events.set(event.sessionId, stream)
      this.#orderedEvents.push(exported)
      this.#previousHash = integrity.hash
    }
  }

  #rewrite(events: SessionEvent[]): void {
    let previousHash = '0'.repeat(64)
    const lines: string[] = []
    for (const stored of events) {
      const { integrity: _discardedIntegrity, ...event } = stored
      const hash = createHash('sha256').update(`${previousHash}\n${canonical(event)}`).digest('hex')
      lines.push(JSON.stringify({
        ...event,
        integrity: { previousHash, hash },
      } satisfies JournalRecord))
      previousHash = hash
    }
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, lines.length ? `${lines.join('\n')}\n` : '', 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, this.#path)
    chmodSync(this.#path, 0o600)
    try {
      const directory = openSync(dirname(this.#path), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } catch { /* directory fsync is unavailable on some Windows filesystems */ }
    this.#reload()
  }

  #withLock<T>(operation: () => T): T {
    const waiter = new Int32Array(new SharedArrayBuffer(4))
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        mkdirSync(this.#lockPath, { mode: 0o700 })
        try { return operation() } finally { rmSync(this.#lockPath, { recursive: true, force: true }) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          if (Date.now() - statSync(this.#lockPath).mtimeMs > 30_000) {
            rmSync(this.#lockPath, { recursive: true, force: true })
            continue
          }
        } catch { /* another process released it */ }
        Atomics.wait(waiter, 0, 0, 5)
      }
    }
    throw new Error(`event journal writer lock timeout: ${this.#path}`)
  }

  static verify(path: string): { valid: boolean; records: number; failedAt?: number } {
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    let previousHash = '0'.repeat(64)
    for (let index = 0; index < lines.length; index++) {
      const record = JSON.parse(lines[index]!) as JournalRecord
      const { integrity, ...event } = record
      const expected = createHash('sha256').update(`${previousHash}\n${canonical(event)}`).digest('hex')
      if (integrity.previousHash !== previousHash || integrity.hash !== expected) {
        return { valid: false, records: lines.length, failedAt: index + 1 }
      }
      previousHash = integrity.hash
    }
    return { valid: true, records: lines.length }
  }
}
