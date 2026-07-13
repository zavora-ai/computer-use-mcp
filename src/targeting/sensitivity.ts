import type { ToolResult } from '../result.js'
import type { Session } from '../session.js'
import type {
  TargetEvidence,
  TargetSensitivityEvidence,
  TargetSensitivitySignal,
} from '../runtime/types.js'

export interface SensitivityActionRequest {
  tool: string
  args: Readonly<Record<string, unknown>>
  target?: TargetEvidence
}

export type TargetSensitivityResolver = (
  request: SensitivityActionRequest,
) => Promise<TargetSensitivityEvidence> | TargetSensitivityEvidence

const SENSITIVE_TEXT = /pass(?:word|code)?|secret|credential|one.?time|otp|api.?key|pin|cvv|cvc|security.?code/i
const NATIVE_SIGNALS = new Set<TargetSensitivitySignal>([
  'secure_role', 'secure_subrole', 'protected_content', 'uia_is_password',
])

function payload(result: ToolResult): unknown {
  if (result.structuredContent) return result.structuredContent
  const item = result.content.find(entry => entry.type === 'text')
  if (!item || item.type !== 'text') return undefined
  try { return JSON.parse(item.text) } catch { return undefined }
}

function fields(request: SensitivityActionRequest): Array<{ role: string; label: string }> | undefined {
  if (request.tool === 'set_value') {
    return typeof request.args.role === 'string' && typeof request.args.label === 'string'
      ? [{ role: request.args.role, label: request.args.label }]
      : undefined
  }
  if (request.tool !== 'fill_form' || !Array.isArray(request.args.fields)) return undefined
  const result: Array<{ role: string; label: string }> = []
  for (const value of request.args.fields) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const field = value as Record<string, unknown>
    if (typeof field.role !== 'string' || typeof field.label !== 'string') return undefined
    result.push({ role: field.role, label: field.label })
  }
  return result.length > 0 && result.length <= 100 ? result : undefined
}

function stableSignals(signals: Iterable<TargetSensitivitySignal>): TargetSensitivitySignal[] {
  return [...new Set(signals)].sort()
}

function evidence(
  assessment: TargetSensitivityEvidence['assessment'],
  source: TargetSensitivityEvidence['source'],
  signals: Iterable<TargetSensitivitySignal>,
  fieldsChecked: number,
  now: () => Date,
): TargetSensitivityEvidence {
  return { assessment, source, signals: stableSignals(signals), fieldsChecked, observedAt: now().toISOString() }
}

/**
 * Reads native AX/UIA sensitivity facts without retaining field labels or values.
 * Native implementations must null protected values before this boundary.
 */
export class SessionTargetSensitivityResolver {
  constructor(readonly session: Session, readonly now: () => Date = () => new Date()) {}

  async resolve(request: SensitivityActionRequest): Promise<TargetSensitivityEvidence> {
    const expected = fields(request)
    const windowId = request.target?.windowId
    if (!expected || typeof windowId !== 'number') {
      return evidence('unknown', 'unavailable', ['invalid_field'], 0, this.now)
    }
    const signals = new Set<TargetSensitivitySignal>()
    let checked = 0
    let unknown = false
    for (const field of expected) {
      let result: ToolResult
      try {
        result = await this.session.dispatch('find_element', {
          window_id: windowId, role: field.role, label: field.label, max_results: 2,
        })
      } catch {
        signals.add('inspection_error'); unknown = true; continue
      }
      if (result.isError) {
        signals.add('inspection_error'); unknown = true; continue
      }
      const found = payload(result)
      const elements = Array.isArray(found) ? found : []
      if (elements.length === 0) {
        signals.add('element_not_found'); unknown = true; continue
      }
      if (elements.length !== 1 || !elements[0] || typeof elements[0] !== 'object') {
        signals.add('ambiguous_match'); unknown = true; continue
      }
      checked++
      const element = elements[0] as Record<string, unknown>
      const native = Array.isArray(element.sensitivitySignals)
        ? element.sensitivitySignals.filter((value): value is TargetSensitivitySignal =>
          typeof value === 'string' && NATIVE_SIGNALS.has(value as TargetSensitivitySignal))
        : []
      for (const signal of native) signals.add(signal)
      const role = typeof element.role === 'string' ? element.role : field.role
      const label = typeof element.label === 'string' ? element.label : field.label
      if (SENSITIVE_TEXT.test(role) || SENSITIVE_TEXT.test(label)) signals.add('sensitive_label')
      if (element.sensitive === true && native.length === 0) signals.add('protected_content')
      if (element.sensitive !== true && element.sensitive !== false) {
        signals.add('native_signal_unavailable'); unknown = true
      }
    }
    const sensitive = [...signals].some(signal =>
      NATIVE_SIGNALS.has(signal) || signal === 'sensitive_label')
    return evidence(
      sensitive ? 'sensitive' : unknown || checked !== expected.length ? 'unknown' : 'non_sensitive',
      'accessibility', signals, checked, this.now,
    )
  }
}
