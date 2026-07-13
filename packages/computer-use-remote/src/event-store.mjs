import { randomBytes } from 'node:crypto'

/** Bounded per-transport MCP redelivery store. */
export class BoundedEventStore {
  #events = new Map()
  #order = []
  #bytes = 0

  constructor(options = {}) {
    this.maxEvents = options.maxEvents ?? 10_000
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  }

  async storeEvent(streamId, message) {
    const eventId = `${streamId}.${randomBytes(12).toString('base64url')}`
    const bytes = Buffer.byteLength(JSON.stringify(message))
    if (bytes > this.maxBytes) throw new Error('MCP event exceeds redelivery store byte limit')
    while (this.#order.length >= this.maxEvents || this.#bytes + bytes > this.maxBytes) {
      const oldest = this.#order.shift()
      if (!oldest) break
      const removed = this.#events.get(oldest)
      if (removed) this.#bytes -= removed.bytes
      this.#events.delete(oldest)
    }
    this.#events.set(eventId, { streamId, message: structuredClone(message), bytes })
    this.#order.push(eventId)
    this.#bytes += bytes
    return eventId
  }

  async replayEventsAfter(lastEventId, { send }) {
    const anchor = this.#events.get(lastEventId)
    if (!anchor) return ''
    const start = this.#order.indexOf(lastEventId)
    for (const eventId of this.#order.slice(start + 1)) {
      const event = this.#events.get(eventId)
      if (event?.streamId === anchor.streamId) await send(eventId, structuredClone(event.message))
    }
    return anchor.streamId
  }
}
