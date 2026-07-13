import type { NativeModule } from '../native.js'
import { FocusError } from './errors.js'
import type { FocusFailure } from './errors.js'

export type FocusStrategy = 'strict' | 'best_effort' | 'none' | 'prepare_display'

export interface FocusController {
  beginDispatch(): void
  strategyFor(tool: string, args: Record<string, unknown>): FocusStrategy
  ensure(
    target: { bundleId?: string; windowId?: number },
    strategy: FocusStrategy,
  ): Promise<{ hiddenBundleIds?: string[] }>
  hiddenBundleIds(): string[] | undefined
}

function defaultStrategy(tool: string): FocusStrategy {
  return ['type', 'key', 'hold_key', 'set_value', 'fill_form'].includes(tool)
    ? 'strict'
    : 'best_effort'
}

/** Extracted focus acquisition and prepare-display state machine. */
export function createFocusController(options: {
  native: NativeModule
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  sleep(milliseconds: number): Promise<void>
}): FocusController {
  const native = options.native
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  let dispatchHiddenBundleIds: string[] | undefined

  const keepVisibleBundles = (): string[] => {
    if (env.COMPUTER_USE_PREPARE_KEEP_VISIBLE) {
      return env.COMPUTER_USE_PREPARE_KEEP_VISIBLE.split(',').map(value => value.trim()).filter(Boolean)
    }
    if (platform === 'win32') return ['explorer.exe']
    if (platform === 'linux') return ['gnome-shell', 'gnome-terminal', 'xterm']
    return [env.__CFBundleIdentifier || env.TERM_PROGRAM_BUNDLE_ID || 'com.apple.Terminal']
  }

  const failure = (
    requestedBundleId: string,
    requestedWindowId: number | null,
    frontmostBefore: string | null,
    frontmostAfter: string | null,
    activationAttempted: boolean,
  ): FocusFailure => {
    const runningApp = native.listRunningApps().find(entry => entry.bundleId === requestedBundleId)
    const targetWindowVisible = requestedWindowId == null
      ? null
      : native.getWindow(requestedWindowId)?.isOnScreen ?? false
    const suggestedRecovery: FocusFailure['suggestedRecovery'] =
      requestedWindowId != null && targetWindowVisible ? 'activate_window'
        : runningApp?.isHidden ? 'unhide_app'
          : 'open_application'
    return {
      error: 'focus_failed',
      requestedBundleId,
      requestedWindowId,
      frontmostBefore,
      frontmostAfter,
      targetRunning: Boolean(runningApp),
      targetHidden: runningApp?.isHidden ?? false,
      targetWindowVisible,
      activationAttempted,
      suggestedRecovery,
    }
  }

  return {
    beginDispatch() { dispatchHiddenBundleIds = undefined },
    strategyFor(tool, args) {
      const value = args.focus_strategy
      return value === 'strict' || value === 'best_effort' || value === 'none'
        || value === 'prepare_display'
        ? value
        : defaultStrategy(tool)
    },
    async ensure(target, strategy) {
      if (strategy === 'none' || !target.bundleId) return {}
      let hiddenBundleIds: string[] | undefined
      if (strategy === 'prepare_display') {
        hiddenBundleIds = native.prepareDisplay(target.bundleId, keepVisibleBundles()).hiddenBundleIds
        dispatchHiddenBundleIds = hiddenBundleIds
        await options.sleep(50)
      }

      const frontmostBefore = native.getFrontmostApp()?.bundleId ?? null
      if (frontmostBefore === target.bundleId) {
        if (strategy === 'strict' && target.windowId != null
          && !native.getWindow(target.windowId)?.isOnScreen) {
          throw new FocusError(failure(
            target.bundleId, target.windowId, frontmostBefore, frontmostBefore, false,
          ))
        }
        return { hiddenBundleIds }
      }

      const runningApp = native.listRunningApps().find(app => app.bundleId === target.bundleId)
      if (runningApp?.isHidden) {
        native.unhideApp(target.bundleId)
        await options.sleep(100)
      }
      native.activateApp(target.bundleId, 2000)
      await options.sleep(80)
      if (target.windowId != null) {
        try { native.activateWindow(target.windowId) } catch { /* best effort */ }
        await options.sleep(80)
      }
      const frontmostAfter = native.getFrontmostApp()?.bundleId ?? null
      if (strategy === 'strict' && frontmostAfter !== target.bundleId) {
        throw new FocusError(failure(
          target.bundleId, target.windowId ?? null,
          frontmostBefore, frontmostAfter, true,
        ))
      }
      return { hiddenBundleIds }
    },
    hiddenBundleIds() {
      return dispatchHiddenBundleIds ? [...dispatchHiddenBundleIds] : undefined
    },
  }
}
