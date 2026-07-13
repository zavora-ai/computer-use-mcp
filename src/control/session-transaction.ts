import type { ToolResult } from '../result.js'
import type { Session } from '../session.js'
import type { ActionEnvelope } from '../runtime/types.js'
import type {
  DesktopStateSnapshot,
  RestorationResult,
  TransactionHooks,
  VerificationResult,
} from './transaction.js'

function payload(result: ToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent
  const text = result.content.find(item => item.type === 'text')
  if (!text || text.type !== 'text') return {}
  try { return JSON.parse(text.text) as Record<string, unknown> } catch { return {} }
}

/** Existing-session adapter for the v8 bounded transaction hooks. */
export class SessionTransactionHooks implements TransactionHooks {
  constructor(readonly session: Session, readonly now: () => Date = () => new Date()) {}

  async capture(_envelope: ActionEnvelope): Promise<DesktopStateSnapshot> {
    const [cursorResult, appResult] = await Promise.all([
      this.session.dispatch('cursor_position', {}),
      this.session.dispatch('get_frontmost_app', {}),
    ])
    const cursorPayload = payload(cursorResult)
    const appPayload = payload(appResult)
    const cursor = (cursorPayload.position ?? cursorPayload.cursor ?? cursorPayload) as Record<string, unknown>
    const app = (appPayload.app ?? appPayload) as Record<string, unknown>
    return {
      capturedAt: this.now().toISOString(),
      ...(typeof cursor.x === 'number' && typeof cursor.y === 'number'
        ? { cursor: { x: cursor.x, y: cursor.y } }
        : {}),
      ...(typeof app.bundleId === 'string' ? { frontmostAppId: app.bundleId } : {}),
      ...(typeof app.windowId === 'number' || typeof app.windowId === 'string'
        ? { frontmostWindowId: app.windowId }
        : {}),
    }
  }

  async captureEvidence(envelope: ActionEnvelope, _phase: 'before' | 'after'): Promise<ToolResult | undefined> {
    // Never fall back to a whole-display capture: evidence is limited to the
    // already-authorized action target so unrelated desktop content is absent.
    if (typeof envelope.target?.windowId === 'number') {
      return this.session.dispatch('screenshot', {
        target_window_id: envelope.target.windowId, width: 480, quality: 45,
      })
    }
    if (envelope.target?.appId) {
      return this.session.dispatch('screenshot', {
        target_app: envelope.target.appId, width: 480, quality: 45,
      })
    }
    return undefined
  }

  async verify(envelope: ActionEnvelope, result: ToolResult): Promise<VerificationResult> {
    if (result.isError) return { verified: false, method: 'tool_result', details: { isError: true } }
    if (!envelope.target?.windowId) return { verified: true, method: 'successful_result' }
    if (typeof envelope.target.windowId !== 'number') {
      return { verified: true, method: 'successful_result_non_numeric_window' }
    }
    const fresh = payload(await this.session.dispatch('get_window', { window_id: envelope.target.windowId }))
    const window = (fresh.window ?? fresh) as Record<string, unknown>
    const appId = typeof window.bundleId === 'string' ? window.bundleId : undefined
    return {
      verified: Boolean(Object.keys(window).length) && (!appId || appId === envelope.target.appId),
      method: 'fresh_window_identity',
      details: { observationId: envelope.target.observationId, appMatched: !appId || appId === envelope.target.appId },
    }
  }

  async restore(snapshot: DesktopStateSnapshot, envelope: ActionEnvelope): Promise<RestorationResult> {
    if (envelope.requestedMode !== 'foreground') {
      return { restored: true, reason: 'background mode made no foreground restoration claim' }
    }
    let focusRestored = false
    let cursorRestored = false
    if (typeof snapshot.frontmostWindowId === 'number') {
      const result = await this.session.dispatch('activate_window', { window_id: snapshot.frontmostWindowId })
      focusRestored = !result.isError
    } else if (snapshot.frontmostAppId) {
      const result = await this.session.dispatch('activate_app', { bundle_id: snapshot.frontmostAppId })
      focusRestored = !result.isError
    }
    if (snapshot.cursor) {
      const result = await this.session.dispatch('mouse_move', {
        coordinate: [snapshot.cursor.x, snapshot.cursor.y],
        focus_strategy: 'none',
      })
      cursorRestored = !result.isError
    }
    const expectedFocus = Boolean(snapshot.frontmostWindowId || snapshot.frontmostAppId)
    const expectedCursor = Boolean(snapshot.cursor)
    return {
      restored: (!expectedFocus || focusRestored) && (!expectedCursor || cursorRestored),
      ...(expectedFocus ? { focusRestored } : {}),
      ...(expectedCursor ? { cursorRestored } : {}),
    }
  }
}
