import { Worker } from 'node:worker_threads'
import type { DesktopBroker } from './desktop-broker.js'

/** Native latch monitoring lives outside the main event loop. Reset is a trusted host responsibility. */
export class DesktopSupervisor {
  readonly #worker: Worker
  readonly ready: Promise<unknown>
  constructor(broker: DesktopBroker, options: { chord?: string; pauseOnHumanInput?: boolean; onEvent?: (event: unknown) => void } = {}) {
    this.#worker = new Worker(new URL('./supervisor-worker.js', import.meta.url), {
      workerData: { chord: options.chord ?? 'ctrl+alt+escape', pauseOnHumanInput: options.pauseOnHumanInput ?? true },
    })
    this.ready = new Promise((resolve, reject) => {
      this.#worker.on('message', event => {
        options.onEvent?.(event)
        if (event.type === 'ready') resolve(event.capability)
        else if (event.type === 'takeover') broker.takeover()
        else if (event.type === 'error') { broker.takeover(); reject(new Error(event.error)) }
      })
      this.#worker.on('error', error => { broker.takeover(); reject(error) })
    })
  }
  async close() { await this.#worker.terminate() }
}
