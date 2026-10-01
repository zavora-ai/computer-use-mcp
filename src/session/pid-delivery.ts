/**
 * Pid delivery records (v7.5, requirement R5, design §4).
 *
 * `CGEventPostToPid` hands events to one process without activating it or moving the
 * real cursor. Whether the app acts on them is up to the app: Cocoa text views do;
 * apps that read the hardware state directly may not. Nothing in the API reports
 * which, so the server observes it: the first pid delivery to an app (and every one
 * until a change is seen) captures the target window before and after, and records
 * whether its pixels changed. `delivery: "auto"` only switches to pid delivery for an
 * app recorded as `changed`; `doctor` and `get_app_capabilities` report the record.
 *
 * Records persist in ~/Library/Caches/computer-use-mcp/pid-delivery.json so a later
 * session knows what worked; tests pass no path and keep them in memory.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultHelperCacheDir } from './macos-helper.js'

export type Delivery = 'auto' | 'hid' | 'pid'
export type PidOutcome = 'changed' | 'no_visible_change' | 'unverified' | 'error'
/**
 * Keyboard and pointer events are recorded separately: a background Cocoa text view
 * takes pid-posted keys but ignores a pid-posted click (its window is not key and
 * the view does not accept the first mouse), so one outcome per app would mislead.
 */
export type InputClass = 'keyboard' | 'pointer'

export interface PidDeliveryObservation {
  outcome: PidOutcome
  tool: string
  at: string
  detail?: string
}

export interface PidDeliveryRecord {
  bundleId: string
  keyboard?: PidDeliveryObservation
  pointer?: PidDeliveryObservation
}

export function inputClassFor(tool: string): InputClass {
  return tool === 'key' || tool === 'type' ? 'keyboard' : 'pointer'
}

export function defaultPidDeliveryPath(): string {
  return join(defaultHelperCacheDir(), 'pid-delivery.json')
}

export class PidDeliveryStore {
  readonly #path: string | undefined
  #records: Record<string, PidDeliveryRecord> | undefined

  constructor(path?: string) {
    this.#path = path
  }

  #load(): Record<string, PidDeliveryRecord> {
    if (this.#records) return this.#records
    this.#records = {}
    if (this.#path) {
      try {
        const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as Record<string, PidDeliveryRecord>
        if (parsed && typeof parsed === 'object') this.#records = parsed
      } catch { /* first run */ }
    }
    return this.#records
  }

  get(bundleId: string | undefined): PidDeliveryRecord | undefined {
    return bundleId ? this.#load()[bundleId] : undefined
  }

  observation(bundleId: string | undefined, inputClass: InputClass): PidDeliveryObservation | undefined {
    return this.get(bundleId)?.[inputClass]
  }

  all(): PidDeliveryRecord[] {
    return Object.values(this.#load())
  }

  /** An app accepts pid delivery of a class once such a delivery visibly changed its window. */
  knownGood(bundleId: string | undefined, inputClass: InputClass): boolean {
    return this.observation(bundleId, inputClass)?.outcome === 'changed'
  }

  record(bundleId: string, inputClass: InputClass, observation: PidDeliveryObservation): void {
    const records = this.#load()
    const existing = records[bundleId]?.[inputClass]
    // `unverified` never overwrites an observed outcome.
    if (observation.outcome === 'unverified' && existing && existing.outcome !== 'unverified') return
    records[bundleId] = { ...(records[bundleId] ?? { bundleId }), bundleId, [inputClass]: observation }
    if (!this.#path) return
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const temporary = `${this.#path}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(records, null, 2)}\n`)
      renameSync(temporary, this.#path)
    } catch { /* records are advisory */ }
  }
}
