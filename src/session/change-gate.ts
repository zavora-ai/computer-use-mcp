/**
 * The live watcher's change gate (7.8): decides when a change on screen is worth a model's attention.
 *
 * The watcher samples the screen a few times a second and the helper says what changed between samples. Most of that is
 * noise for a model: a blinking caret, a clock, a spinner, the frames of an animation. The gate turns bursts of change
 * into at most one event each: it waits until the screen has been quiet for `settleMs` (so a dialog that slides in is
 * reported once, finished), reports a screen that keeps changing every `maxDelayMs` anyway, and drops bursts too small
 * to matter or entirely inside an ignored region (the menu bar clock). Pure and clock-driven, so it is tested without a
 * screen.
 */

/** A rectangle as fractions of the captured frame, top-left origin. */
export interface FrameRect { x: number; y: number; width: number; height: number }

export interface ScreenChange {
  at: number
  /** Share of the frame that changed (0-1); 1 when the source cannot say. */
  area: number
  /** The box around what changed, when the source knows. */
  dirty?: FrameRect
}

export interface GateOptions {
  /** Quiet time after the last change before a burst becomes an event (default 600 ms). */
  settleMs?: number
  /** A screen that keeps changing still yields an event this often (default 3,000 ms). */
  maxDelayMs?: number
  /** A burst whose largest change and whose changed box are both smaller than this share of the frame is dropped. */
  minArea?: number
  /** Changes entirely inside one of these are dropped. */
  ignore?: FrameRect[]
}

export interface GatedChange {
  startedAt: number
  at: number
  /** The largest single change in the burst. */
  area: number
  /** The box around everything that changed in the burst. */
  dirty?: FrameRect
  /** False when reported because the screen kept changing past maxDelayMs. */
  settled: boolean
  samples: number
}

export const GATE_SETTLE_MS = 600
export const GATE_MAX_DELAY_MS = 3_000
export const GATE_MIN_AREA = 0.001

const inside = (outer: FrameRect, inner: FrameRect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height

const union = (a: FrameRect | undefined, b: FrameRect | undefined): FrameRect | undefined => {
  if (!a) return b
  if (!b) return a
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
}

export class ChangeGate {
  readonly #settleMs: number
  readonly #maxDelayMs: number
  readonly #minArea: number
  readonly #ignore: FrameRect[]
  #burst: { startedAt: number; lastAt: number; area: number; dirty?: FrameRect; known: boolean; samples: number } | undefined

  constructor(options: GateOptions = {}) {
    this.#settleMs = options.settleMs ?? GATE_SETTLE_MS
    this.#maxDelayMs = options.maxDelayMs ?? GATE_MAX_DELAY_MS
    this.#minArea = options.minArea ?? GATE_MIN_AREA
    this.#ignore = options.ignore ?? []
  }

  observe(change: ScreenChange): void {
    if (!(change.area > 0)) return
    if (change.dirty && this.#ignore.some(region => inside(region, change.dirty!))) return
    const burst = this.#burst ?? { startedAt: change.at, lastAt: change.at, area: 0, known: true, samples: 0 }
    burst.lastAt = change.at
    burst.area = Math.max(burst.area, change.area)
    burst.dirty = union(burst.dirty, change.dirty)
    burst.known &&= change.dirty !== undefined
    burst.samples += 1
    this.#burst = burst
  }

  /** The event a settled (or overdue) burst becomes, or undefined. Call once per sample. */
  poll(now: number): GatedChange | undefined {
    const burst = this.#burst
    if (!burst) return undefined
    const settled = now - burst.lastAt >= this.#settleMs
    if (!settled && now - burst.startedAt < this.#maxDelayMs) return undefined
    this.#burst = undefined
    // A caret blinks in the same small box for ever; a sentence being typed grows its box. Judge both.
    const box = burst.dirty ? burst.dirty.width * burst.dirty.height : burst.area
    if (burst.area < this.#minArea && (!burst.known || box < this.#minArea * 4)) return undefined
    return {
      startedAt: burst.startedAt, at: burst.lastAt, area: burst.area,
      ...(burst.known && burst.dirty ? { dirty: burst.dirty } : {}),
      settled, samples: burst.samples,
    }
  }

  /** Drop a burst in progress (the watch paused or its target changed). */
  reset(): void { this.#burst = undefined }
}
