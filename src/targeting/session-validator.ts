import type { Session } from '../session.js'
import type { TargetEvidence } from '../runtime/types.js'
import type { ToolResult } from '../result.js'
import { compareTargetEvidence, type FreshTargetObservation } from './validate.js'

function payload(result: ToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent
  const text = result.content.find(item => item.type === 'text')
  if (!text || text.type !== 'text') return {}
  try { return JSON.parse(text.text) as Record<string, unknown> } catch { return {} }
}

export type ObservationResolver = (evidence: TargetEvidence) =>
  Promise<Partial<FreshTargetObservation> | undefined> | Partial<FreshTargetObservation> | undefined

/** Re-resolves live window identity and combines it with optional semantic/screenshot evidence. */
export class SessionTargetEvidenceValidator {
  constructor(
    readonly session: Session,
    readonly resolveObservation?: ObservationResolver,
    readonly boundsTolerance = 4,
  ) {}

  async validate(evidence: TargetEvidence): Promise<boolean> {
    if (typeof evidence.windowId !== 'number') return false
    const result = await this.session.dispatch('get_window', { window_id: evidence.windowId })
    if (result.isError) return false
    const window = payload(result)
    if (typeof window.windowId !== 'number' || typeof window.bundleId !== 'string') return false
    const bounds = window.bounds && typeof window.bounds === 'object'
      ? window.bounds as FreshTargetObservation['bounds']
      : undefined
    const extended = await this.resolveObservation?.(evidence)
    const fresh: FreshTargetObservation = {
      platform: process.platform,
      appId: window.bundleId,
      windowId: window.windowId,
      ...(typeof window.pid === 'number' ? { pid: window.pid } : {}),
      ...(typeof window.title === 'string' ? { windowTitle: window.title } : {}),
      ...(typeof window.displayId === 'number' ? { displayId: String(window.displayId) } : {}),
      ...(bounds ? { bounds } : {}),
      ...extended,
    }
    return compareTargetEvidence(evidence, fresh, this.boundsTolerance).valid
  }
}
