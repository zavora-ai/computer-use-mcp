/**
 * Session error types — extracted verbatim from session.ts (PR-13b split).
 * `LockError` lives with the extracted lock/pump service in `lock.ts`.
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

/**
 * v7.5: a failure with a machine-readable payload. The dispatcher returns
 * `details` as a structured error result (`errJson`) instead of `Error: <message>`,
 * so an agent can branch on `error` and follow `hint`/`remediation`.
 */
export class StructuredToolError extends Error {
  readonly details: Record<string, unknown>
  constructor(message: string, details: Record<string, unknown>) {
    super(message)
    this.name = 'StructuredToolError'
    this.details = details
  }
}
