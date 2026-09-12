import type { NativeModule } from '../native.js'
import { ok, type ToolResult } from '../result.js'
import { PROVIDER_QUALITY, PROVIDER_WIDTH } from './constants.js'
import type { TargetStateController } from './target-state.js'
import type { VirtualPointerController } from './virtual-pointer.js'

export interface CachedScreenshot {
  mimeType: string
  data: string
  capturedAt: number
  targetArgs?: Record<string, unknown>
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
  #lastCaptureScope: string | undefined
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
    return this.#lastScreenshot ? structuredClone(this.#lastScreenshot) : undefined
  }

  /**
   * Describe a capture so a point in the image can be turned into a click.
   *
   * Reporting only `WxH`, as this used to, left every agent to infer the mapping —
   * and they infer it wrong. A screen capture scales uniformly with no offset, so
   * its mapping is exact and worth stating. A window capture includes the window's
   * shadow, so its scale is approximate and that has to be said rather than implied.
   * A window that could not be captured falls back to the screen, which is the case
   * that silently produces coordinates far from where an agent believes it clicked.
   */
  #describeCapture(width: number, height: number, windowId: number | undefined): string {
    const size = `${width}x${height}`
    const display = this.#native.getDisplaySize()
    const imageAspect = width / height
    const screenAspect = display.width / display.height
    const looksLikeScreen = Math.abs(imageAspect - screenAspect) < 0.02

    const bounds = windowId !== undefined ? this.#native.getWindow?.(windowId)?.bounds : undefined

    if (windowId !== undefined && bounds && !looksLikeScreen) {
      // Scaled from width, because the shadow adds more height than width.
      const scale = bounds.width / width
      return [
        `${size} | window ${windowId} at ${bounds.x},${bounds.y} sized ${bounds.width}x${bounds.height}`,
        `screen_x ≈ ${bounds.x} + image_x * ${scale.toFixed(4)}`,
        `screen_y ≈ ${bounds.y} + image_y * ${scale.toFixed(4)}`,
        'the capture includes the window shadow, so this mapping is approximate:'
          + ' click, then capture again to confirm before typing.'
          + ' For exact coordinates omit target_window_id and use a screen capture.',
      ].join('\n')
    }

    const scale = display.width / width
    const fellBack = windowId !== undefined
      ? ` | window ${windowId} could not be captured on its own, so this is the whole screen`
      : ''
    return [
      `${size} | screen ${display.width}x${display.height}${fellBack}`,
      `screen_x = image_x * ${scale.toFixed(4)}`,
      `screen_y = image_y * ${scale.toFixed(4)}`,
      'a screen capture scales uniformly with no offset, so this mapping is exact.',
    ].join('\n')
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
      const scope = JSON.stringify([app, windowId, width, quality, windowId !== undefined ? this.#native.getWindow?.(windowId)?.bounds : undefined])
      let image = this.#native.takeScreenshot(
        width, app, quality, showPointer || scope !== this.#lastCaptureScope ? undefined : this.#lastHash, windowId,
      )
      if (!showPointer && image.unchanged && this.#lastResult) return this.#lastResult
      if (!image.base64) throw new Error('Screenshot capture missing image payload')
      if (showPointer) image = this.#pointer.annotateScreenshot(image)
      if (!image.base64) throw new Error('Screenshot capture missing image payload')
      this.#lastCaptureScope = scope
      this.#lastHash = image.hash
      this.#lastScreenshot = { mimeType: image.mimeType, data: image.base64, capturedAt: this.#now(), ...(windowId !== undefined || app ? { targetArgs: { ...(windowId !== undefined ? { target_window_id: windowId } : {}), ...(app ? { target_app: app } : {}) } } : {}) }
      this.#lastResult = {
        content: [
          { type: 'image', data: image.base64, mimeType: image.mimeType },
          { type: 'text', text: this.#describeCapture(image.width, image.height, windowId) },
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
