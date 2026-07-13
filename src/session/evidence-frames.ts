import { createHash, randomUUID } from 'node:crypto'
import type { ToolResult } from '../result.js'

export type EvidenceFramePhase = 'before' | 'after' | 'observation'

export interface EvidenceFrameMetadata {
  frameId: string
  sessionId: string
  actionId: string
  phase: EvidenceFramePhase
  mimeType: 'image/png' | 'image/jpeg'
  byteLength: number
  digest: string
  capturedAt: string
  expiresAt: string
}

export interface EvidenceFrame extends EvidenceFrameMetadata {
  data: string
}

export interface EvidenceFrameStoreOptions {
  now?: () => Date
  ttlMs?: number
  maxFrameBytes?: number
  maxFramesPerSession?: number
  maxTotalBytes?: number
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function decodeImage(data: string, mimeType: string, maximum: number): Buffer {
  if ((mimeType !== 'image/png' && mimeType !== 'image/jpeg') || !data || !BASE64.test(data)) {
    throw new TypeError('evidence frame must be a canonical base64 PNG or JPEG')
  }
  const bytes = Buffer.from(data, 'base64')
  if (!bytes.length || bytes.length > maximum) {
    throw new RangeError(`evidence frame must contain between 1 and ${maximum} bytes`)
  }
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if ((mimeType === 'image/png' && !png) || (mimeType === 'image/jpeg' && !jpeg)) {
    throw new TypeError('evidence frame bytes do not match the declared image MIME type')
  }
  return bytes
}

/**
 * Process-memory-only visual evidence. Frames are short lived, bounded, and
 * session scoped; no persistence adapter is intentionally provided.
 */
export class MemoryEvidenceFrameStore {
  readonly #now: () => Date
  readonly #ttlMs: number
  readonly #maxFrameBytes: number
  readonly #maxFramesPerSession: number
  readonly #maxTotalBytes: number
  readonly #frames = new Map<string, EvidenceFrame>()
  #totalBytes = 0

  constructor(options: EvidenceFrameStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date())
    this.#ttlMs = options.ttlMs ?? 5 * 60_000
    this.#maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024
    this.#maxFramesPerSession = options.maxFramesPerSession ?? 6
    this.#maxTotalBytes = options.maxTotalBytes ?? 8 * 1024 * 1024
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) throw new RangeError('evidence frame ttlMs must be positive')
    if (!Number.isSafeInteger(this.#maxFrameBytes) || this.#maxFrameBytes < 8) throw new RangeError('maxFrameBytes must be at least 8')
    if (!Number.isSafeInteger(this.#maxFramesPerSession) || this.#maxFramesPerSession < 1) throw new RangeError('maxFramesPerSession must be positive')
    if (!Number.isSafeInteger(this.#maxTotalBytes) || this.#maxTotalBytes < this.#maxFrameBytes) {
      throw new RangeError('maxTotalBytes must be at least maxFrameBytes')
    }
  }

  put(input: {
    sessionId: string
    actionId: string
    phase: EvidenceFramePhase
    mimeType: string
    data: string
  }): EvidenceFrameMetadata {
    if (!input.sessionId || input.sessionId.length > 256 || !input.actionId || input.actionId.length > 256) {
      throw new TypeError('bounded sessionId and actionId are required')
    }
    if (!['before', 'after', 'observation'].includes(input.phase)) {
      throw new TypeError('evidence frame phase is invalid')
    }
    this.prune()
    const bytes = decodeImage(input.data, input.mimeType, this.#maxFrameBytes)
    const now = this.#now()
    const frame: EvidenceFrame = {
      frameId: randomUUID(), sessionId: input.sessionId, actionId: input.actionId,
      phase: input.phase, mimeType: input.mimeType as EvidenceFrame['mimeType'],
      byteLength: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      capturedAt: now.toISOString(), expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
      data: input.data,
    }
    this.#frames.set(frame.frameId, frame)
    this.#totalBytes += frame.byteLength
    this.#enforceSessionLimit(input.sessionId)
    this.#enforceGlobalLimit()
    return this.#metadata(frame)
  }

  putFromToolResult(input: {
    sessionId: string
    actionId: string
    phase: EvidenceFramePhase
    result: ToolResult
  }): EvidenceFrameMetadata | undefined {
    const image = input.result.content.find(item => item.type === 'image')
    if (!image || image.type !== 'image') return undefined
    return this.put({ ...input, mimeType: image.mimeType, data: image.data })
  }

  get(sessionId: string, frameId: string): EvidenceFrame | undefined {
    this.prune()
    const frame = this.#frames.get(frameId)
    return frame?.sessionId === sessionId ? structuredClone(frame) : undefined
  }

  list(sessionId: string): EvidenceFrameMetadata[] {
    this.prune()
    return [...this.#frames.values()]
      .filter(frame => frame.sessionId === sessionId)
      .map(frame => this.#metadata(frame))
  }

  deleteSession(sessionId: string): number {
    let deleted = 0
    for (const [frameId, frame] of this.#frames) {
      if (frame.sessionId !== sessionId) continue
      this.#delete(frameId, frame)
      deleted++
    }
    return deleted
  }

  prune(): number {
    const now = this.#now().getTime()
    let deleted = 0
    for (const [frameId, frame] of this.#frames) {
      if (Date.parse(frame.expiresAt) > now) continue
      this.#delete(frameId, frame)
      deleted++
    }
    return deleted
  }

  clear(): void {
    this.#frames.clear()
    this.#totalBytes = 0
  }

  #metadata(frame: EvidenceFrame): EvidenceFrameMetadata {
    const { data: _data, ...metadata } = frame
    return structuredClone(metadata)
  }

  #delete(frameId: string, frame: EvidenceFrame): void {
    if (this.#frames.delete(frameId)) this.#totalBytes -= frame.byteLength
  }

  #enforceSessionLimit(sessionId: string): void {
    const entries = [...this.#frames.entries()].filter(([, frame]) => frame.sessionId === sessionId)
    while (entries.length > this.#maxFramesPerSession) {
      const [frameId, frame] = entries.shift()!
      this.#delete(frameId, frame)
    }
  }

  #enforceGlobalLimit(): void {
    while (this.#totalBytes > this.#maxTotalBytes) {
      const first = this.#frames.entries().next().value as [string, EvidenceFrame] | undefined
      if (!first) break
      this.#delete(first[0], first[1])
    }
  }
}
