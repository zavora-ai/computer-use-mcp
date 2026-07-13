import type { ToolResult } from '../result.js'
import type { ActionEnvelope } from '../runtime/types.js'

export interface DesktopStateSnapshot {
  capturedAt: string
  cursor?: { x: number; y: number }
  frontmostAppId?: string
  frontmostWindowId?: string | number
}

export interface VerificationResult {
  verified: boolean
  method: string
  details?: Record<string, unknown>
}

export interface RestorationResult {
  restored: boolean
  cursorRestored?: boolean
  focusRestored?: boolean
  reason?: string
}

export interface TransactionHooks {
  capture(envelope: ActionEnvelope): Promise<DesktopStateSnapshot>
  /** Optional, explicitly enabled process-memory-only supervisor evidence. */
  captureEvidence?(envelope: ActionEnvelope, phase: 'before' | 'after'): Promise<ToolResult | undefined>
  verify(envelope: ActionEnvelope, result: ToolResult): Promise<VerificationResult>
  restore(snapshot: DesktopStateSnapshot, envelope: ActionEnvelope): Promise<RestorationResult>
}
