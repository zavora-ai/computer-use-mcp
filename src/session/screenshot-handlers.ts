import type { NativeModule } from '../native.js'
import { ok, type ToolResult } from '../result.js'
import { PROVIDER_QUALITY, PROVIDER_WIDTH } from './constants.js'
import type { TargetStateController } from './target-state.js'
import type { VirtualPointerController } from './virtual-pointer.js'

export interface CachedScreenshot {
  mimeType: string
  data: string
  capturedAt: number
}

/** Screenshot/zoom handler with cache and pointer projection isolated from dispatch. */
export class ScreenshotHandler {
  readonly #native: NativeModule
  readonly #targets: TargetStateController
  readonly #pointer: VirtualPointerController
  readonly #visionEnabled: boolean
  readonly #defaultProvider: string
  readonly #env: NodeJS.ProcessEnv
  readonly #now: () => number
  #lastHash: string | undefined
  #lastResult: ToolResult | undefined
  #lastScreenshot: CachedScreenshot | undefined

  constructor(options: {
    native: NativeModule
    targets: TargetStateController
    pointer: VirtualPointerController
    visionEnabled: boolean
    defaultProvider: string
    env?: NodeJS.ProcessEnv
    now?: () => number
  }) {
    this.#native = options.native
    this.#targets = options.targets
    this.#pointer = options.pointer
    this.#visionEnabled = options.visionEnabled
    this.#defaultProvider = options.defaultProvider
    this.#env = options.env ?? process.env
    this.#now = options.now ?? Date.now
  }

  lastHash(): string | undefined { return this.#lastHash }
  lastScreenshot(): CachedScreenshot | undefined {
    return this.#lastScreenshot ? { ...this.#lastScreenshot } : undefined
  }

  handle(tool: string, args: Record<string, unknown>): ToolResult | undefined {
    if (tool === 'screenshot') {
      const provider = typeof args.provider === 'string' ? args.provider : this.#defaultProvider
      const width = typeof args.width === 'number' ? args.width
        : this.#env.COMPUTER_USE_WIDTH !== undefined ? Number.parseInt(this.#env.COMPUTER_USE_WIDTH)
          : PROVIDER_WIDTH[provider] ?? 1024
      const quality = typeof args.quality === 'number' ? args.quality
        : this.#env.COMPUTER_USE_QUALITY !== undefined ? Number.parseInt(this.#env.COMPUTER_USE_QUALITY)
          : PROVIDER_QUALITY[provider] ?? PROVIDER_QUALITY.default
      let windowId = typeof args.target_window_id === 'number' ? args.target_window_id : undefined
      const app = windowId ? undefined
        : typeof args.target_app === 'string' && args.target_app.length > 0 ? args.target_app : undefined
      if (windowId === undefined && app === undefined) windowId = this.#targets.observationWindow()
      if (!this.#visionEnabled) {
        const frontmost = this.#native.getFrontmostApp()
        const display = this.#native.getDisplaySize()
        return ok(`Screen: ${display.width}×${display.height} | Frontmost: ${frontmost?.bundleId ?? 'unknown'} (${frontmost?.displayName ?? ''})`)
      }
      const showPointer = args.show_agent_pointer === true
      let image = this.#native.takeScreenshot(
        width, app, quality, showPointer ? undefined : this.#lastHash, windowId,
      )
      if (!showPointer && image.unchanged && this.#lastResult) return this.#lastResult
      if (!image.base64) throw new Error('Screenshot capture missing image payload')
      if (showPointer) image = this.#pointer.annotateScreenshot(image)
      if (!image.base64) throw new Error('Screenshot capture missing image payload')
      this.#lastHash = image.hash
      this.#lastScreenshot = { mimeType: image.mimeType, data: image.base64, capturedAt: this.#now() }
      this.#lastResult = {
        content: [
          { type: 'image', data: image.base64, mimeType: image.mimeType },
          { type: 'text', text: `${image.width}x${image.height}` },
        ],
      }
      return this.#lastResult
    }
    if (tool === 'zoom') {
      const region = args.region
      if (!Array.isArray(region) || region.length !== 4) {
        throw new Error('zoom requires region: [x1, y1, x2, y2]')
      }
      const [x1, y1, x2, y2] = region as [number, number, number, number]
      if (x1 >= x2 || y1 >= y2) {
        throw new Error(`Invalid region: x1(${x1}) must be < x2(${x2}), y1(${y1}) must be < y2(${y2})`)
      }
      const source = this.#native.takeScreenshot(undefined, undefined, 0, undefined, undefined)
      if (!source.base64) throw new Error('Screenshot capture failed')
      const cropped = this.#native.cropImage(
        source.base64, x1, y1, x2, y2, typeof args.quality === 'number' ? args.quality : 0,
      )
      return { content: [
        { type: 'image', data: cropped.base64, mimeType: cropped.mimeType },
        { type: 'text', text: `${cropped.width}x${cropped.height} (zoomed from ${source.width}x${source.height})` },
      ] }
    }
    return undefined
  }
}
