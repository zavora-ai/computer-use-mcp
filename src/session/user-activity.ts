/**
 * Don't take over while the user works (v7.5, requirement R4, design §3).
 *
 * The native input monitor records the last *physical* keyboard or mouse event
 * (a passive HID event tap that ignores this server's own synthetic events). When a
 * tool would activate an app or post HID input — which goes to the frontmost app and
 * moves the real cursor — within COMPUTER_USE_USER_IDLE_MS of the user's last input,
 * the call is refused with `user_active` unless it passes `force: true` or its input
 * can be delivered to the target process without focus (`delivery: "pid"`).
 *
 * Reads never consult the guard. When the clock is unavailable (Input Monitoring not
 * granted, or a platform without a monitor) the guard allows the call and says so in
 * `doctor`; it cannot tell, and refusing everything would make the server unusable.
 */

import type { NativeModule } from '../native.js'
import { StructuredToolError } from './errors.js'

export const DEFAULT_USER_IDLE_MS = 4_000

export interface UserActivity {
  /** Milliseconds since the last physical input, or null when the clock is unavailable. */
  msSinceInput: number | null
  thresholdMs: number
  active: boolean
}

export interface UserActiveDetails extends Record<string, unknown> {
  status: 'user_active'
  error: 'user_active'
  tool: string
  msSinceInput: number
  thresholdMs: number
  wouldDo: string
  hint: string
}

export class UserActiveError extends StructuredToolError {
  declare readonly details: UserActiveDetails
  constructor(details: UserActiveDetails) {
    super(`user_active: physical input ${details.msSinceInput} ms ago; refused to ${details.wouldDo}`, details)
    this.name = 'UserActiveError'
  }
}

export interface UserActivityGuard {
  activity(): UserActivity
  /** Throw UserActiveError when the user is active and the call is not forced. */
  check(action: { tool: string; wouldDo: string; force?: boolean; pidPossible?: boolean }): void
  status(): Record<string, unknown>
}

export function parseIdleThreshold(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_USER_IDLE_MS
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_USER_IDLE_MS
}

export function createUserActivityGuard(options: {
  native: Partial<Pick<NativeModule, 'getUserIdleTimeMs'>>
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): UserActivityGuard {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  // Windows and Linux keep their v7.4 behaviour unless the variable is set explicitly.
  const explicit = env.COMPUTER_USE_USER_IDLE_MS !== undefined && env.COMPUTER_USE_USER_IDLE_MS.trim() !== ''
  const thresholdMs = platform === 'darwin' || explicit ? parseIdleThreshold(env.COMPUTER_USE_USER_IDLE_MS) : 0

  const read = (): number | null => {
    if (thresholdMs === 0) return null
    try {
      const value = options.native.getUserIdleTimeMs?.()
      return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
    } catch { return null }
  }

  const activity = (): UserActivity => {
    const msSinceInput = read()
    return { msSinceInput, thresholdMs, active: msSinceInput !== null && msSinceInput < thresholdMs }
  }

  return {
    activity,
    check({ tool, wouldDo, force, pidPossible }) {
      if (force) return
      const now = activity()
      if (!now.active || now.msSinceInput === null) return
      const waitMs = Math.max(0, thresholdMs - now.msSinceInput)
      throw new UserActiveError({
        status: 'user_active',
        error: 'user_active',
        tool,
        msSinceInput: now.msSinceInput,
        thresholdMs,
        wouldDo,
        hint: [
          `The user typed or moved the mouse ${now.msSinceInput} ms ago; acting now would take the keyboard, pointer or focus from them.`,
          `Wait at least ${waitMs} ms and retry,`,
          ...(pidPossible === false ? [] : ['deliver the input to the target app without focus (delivery: "pid", macOS),']),
          'or pass force: true if the user asked for this action.',
        ].join(' '),
      })
    },
    status() {
      const now = activity()
      return {
        thresholdMs,
        enabled: thresholdMs > 0,
        clockAvailable: thresholdMs === 0 ? null : now.msSinceInput !== null,
        msSinceInput: now.msSinceInput,
        userActive: now.active,
      }
    },
  }
}
