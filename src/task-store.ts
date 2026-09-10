import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Host-owned storage. Persisted records must never be supplied by a model. */
export interface TaskStore {
  load(): Record<string, unknown>[]
  save(id: string, value: Record<string, unknown>): void
  delete(id: string): void
}

/** Atomic local checkpoints. Use one worker process per directory. */
export class FileTaskStore implements TaskStore {
  constructor(readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }) }
  #path(id: string) {
    if (!/^cut_[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid task storage ID')
    return join(this.directory, id + '.json')
  }
  load(): Record<string, unknown>[] {
    return readdirSync(this.directory).filter(name => /^cut_[A-Za-z0-9_-]+\.json$/.test(name))
      .map(name => JSON.parse(readFileSync(join(this.directory, name), 'utf8')))
  }
  save(id: string, value: Record<string, unknown>): void {
    const target = this.#path(id)
    const temporary = target + '.' + randomUUID() + '.tmp'
    try {
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx', flush: true })
      renameSync(temporary, target)
    } finally { try { unlinkSync(temporary) } catch { /* renamed */ } }
  }
  delete(id: string): void { try { unlinkSync(this.#path(id)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
}
