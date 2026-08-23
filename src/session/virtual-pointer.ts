import type { NativeModule } from '../native.js'

export interface AgentPointerState {
  x: number
  y: number
  visible: boolean
  updatedAt: number
}

export interface ScreenshotImage {
  base64?: string
  width: number
  height: number
  mimeType: string
  hash: string
  unchanged: boolean
}

/** Virtual pointer state, native overlay synchronization, and screenshot projection. */
export class VirtualPointerController {
  readonly #native: NativeModule
  readonly #now: () => number
  #state: AgentPointerState | undefined

  constructor(native: NativeModule, now: () => number = Date.now) {
    this.#native = native
    this.#now = now
  }

  current(): AgentPointerState {
    if (!this.#state) {
      const display = this.#native.getDisplaySize()
      this.#state = {
        x: Math.round(display.width / 2),
        y: Math.round(display.height / 2),
        visible: false,
        updatedAt: this.#now(),
      }
    }
    return { ...this.#state }
  }

  move(x: number, y: number, visible = true): AgentPointerState {
    const display = this.#native.getDisplaySize()
    if (x < 0 || y < 0 || x >= display.width || y >= display.height) {
      throw new Error(
        `Coordinates (${x}, ${y}) are outside display bounds (${display.width}x${display.height}). `
        + `Valid range: x=[0, ${display.width - 1}], y=[0, ${display.height - 1}].`,
      )
    }
    this.#state = { x, y, visible, updatedAt: this.#now() }
    return this.current()
  }

  show(): AgentPointerState {
    this.#state = { ...this.current(), visible: true, updatedAt: this.#now() }
    return this.current()
  }

  hide(): AgentPointerState {
    this.#state = { ...this.current(), visible: false, updatedAt: this.#now() }
    return this.current()
  }

  reset(visible = false): AgentPointerState {
    const display = this.#native.getDisplaySize()
    this.#state = {
      x: Math.round(display.width / 2),
      y: Math.round(display.height / 2),
      visible,
      updatedAt: this.#now(),
    }
    return this.current()
  }

  syncOverlay(requested: boolean): Record<string, unknown> {
    const pointer = this.current()
    if (!requested) {
      return { requested: false, available: typeof this.#native.agentPointerOverlayStatus === 'function' }
    }
    try {
      if (pointer.visible) {
        const show = this.#native.agentPointerOverlayShow ?? this.#native.agentPointerOverlayMove
        if (!show) return { requested: true, available: false }
        return { requested: true, available: true, status: show(pointer.x, pointer.y) }
      }
      if (this.#native.agentPointerOverlayHide) {
        return { requested: true, available: true, status: this.#native.agentPointerOverlayHide() }
      }
      return { requested: true, available: false }
    } catch (error) {
      return {
        requested: true,
        available: true,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  annotateScreenshot(image: ScreenshotImage): ScreenshotImage {
    const pointer = this.#state
    if (!pointer?.visible || !image.base64 || typeof this.#native.annotateImage !== 'function') {
      return image
    }
    const display = this.#native.getDisplaySize()
    const scaleX = image.width / display.width
    const scaleY = image.height / display.height
    const size = Math.max(10, Math.round(18 * Math.min(scaleX, scaleY)))
    const annotated = this.#native.annotateImage(
      image.base64,
      JSON.stringify([{
        x: Math.round(pointer.x * scaleX - size / 2),
        y: Math.round(pointer.y * scaleY - size / 2),
        width: size,
        height: size,
      }]),
      null,
      null,
      85,
    )
    return {
      ...image,
      base64: annotated.base64,
      width: annotated.width,
      height: annotated.height,
      mimeType: annotated.mimeType,
      hash: `${image.hash}:agent-pointer:${pointer.x},${pointer.y}`,
      unchanged: false,
    }
  }
}
