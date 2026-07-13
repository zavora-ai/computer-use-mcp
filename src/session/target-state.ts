import type { NativeModule } from '../native.js'
import { WindowNotFoundError } from './errors.js'

export interface TargetState {
  bundleId?: string
  windowId?: number
  establishedBy: 'activation' | 'pointer' | 'keyboard'
  establishedAt: number
}

export interface ResolvedTarget {
  bundleId?: string
  windowId?: number
}

/** Session-local target provenance with explicit precedence and stale-window cleanup. */
export class TargetStateController {
  readonly #native: Pick<NativeModule, 'getWindow' | 'getFrontmostApp'>
  readonly #now: () => number
  #state: TargetState | undefined

  constructor(
    native: Pick<NativeModule, 'getWindow' | 'getFrontmostApp'>,
    now: () => number = Date.now,
  ) {
    this.#native = native
    this.#now = now
  }

  current(): TargetState | undefined {
    return this.#state ? { ...this.#state } : undefined
  }

  resolve(args: Record<string, unknown>): ResolvedTarget {
    const windowId = typeof args.window_id === 'number' ? args.window_id
      : typeof args.target_window_id === 'number' ? args.target_window_id
        : undefined
    if (windowId !== undefined) {
      const window = this.#native.getWindow(windowId)
      if (!window) throw new WindowNotFoundError(windowId)
      return { bundleId: window.bundleId ?? undefined, windowId: window.windowId }
    }
    if (typeof args.target_app === 'string' && args.target_app.length > 0) {
      return { bundleId: args.target_app }
    }
    return { bundleId: this.#state?.bundleId, windowId: this.#state?.windowId }
  }

  targetAppForPolicy(args: Record<string, unknown>): string | undefined {
    if (typeof args.target_app === 'string' && args.target_app) return args.target_app
    if (typeof args.bundle_id === 'string' && args.bundle_id) return args.bundle_id
    const windowId = typeof args.window_id === 'number' ? args.window_id
      : typeof args.target_window_id === 'number' ? args.target_window_id
        : undefined
    if (windowId !== undefined) {
      try { return this.#native.getWindow(windowId)?.bundleId ?? undefined } catch { return undefined }
    }
    return this.#state?.bundleId
  }

  update(target: ResolvedTarget, establishedBy: TargetState['establishedBy']): void {
    this.#state = {
      bundleId: target.bundleId,
      windowId: target.windowId,
      establishedBy,
      establishedAt: this.#now(),
    }
  }

  trackClick(target: ResolvedTarget): void {
    if (target.bundleId) return this.update(target, 'pointer')
    const frontmost = this.#native.getFrontmostApp()
    if (frontmost?.bundleId) this.update({ bundleId: frontmost.bundleId }, 'pointer')
  }

  /** Return a still-visible cached window or clear only its stale identity. */
  observationWindow(): number | undefined {
    const windowId = this.#state?.windowId
    if (windowId == null) return undefined
    if (this.#native.getWindow(windowId)?.isOnScreen) return windowId
    this.#state = this.#state ? { ...this.#state, windowId: undefined } : undefined
    return undefined
  }

  establishedByForTool(tool: string): TargetState['establishedBy'] {
    if (['type', 'key', 'hold_key'].includes(tool)) return 'keyboard'
    if (['activate_app', 'activate_window', 'open_application'].includes(tool)) return 'activation'
    return 'pointer'
  }
}
