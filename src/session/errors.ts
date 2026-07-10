/**
 * Session error types — extracted verbatim from session.ts (PR-13b split).
 * `LockError` stays with the lock/pump logic in session.ts.
 */

export interface FocusFailure {
  error: 'focus_failed'
  requestedBundleId: string
  requestedWindowId: number | null
  frontmostBefore: string | null
  frontmostAfter: string | null
  targetRunning: boolean
  targetHidden: boolean
  targetWindowVisible: boolean | null
  activationAttempted: boolean
  suggestedRecovery: 'activate_window' | 'unhide_app' | 'open_application'
}

export class FocusError extends Error {
  constructor(readonly details: FocusFailure) {
    super(`Failed to focus ${details.requestedBundleId}`)
    this.name = 'FocusError'
  }
}

export class WindowNotFoundError extends Error {
  constructor(readonly windowId: number) {
    super(`Window not found: ${windowId}`)
    this.name = 'WindowNotFoundError'
  }
}
