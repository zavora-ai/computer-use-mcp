import { createHash } from 'node:crypto'
import type { TargetEvidence } from '../runtime/types.js'

export interface FreshTargetObservation {
  platform: NodeJS.Platform
  appId: string
  pid?: number
  windowId?: number | string
  windowTitle?: string
  displayId?: string
  role?: string
  label?: string
  bounds?: { x: number; y: number; width: number; height: number }
  screenshotHash?: string
  uiTreeRevision?: string
}

export interface EvidenceValidation {
  valid: boolean
  mismatches: string[]
}

export function evidenceDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function compareTargetEvidence(
  evidence: TargetEvidence,
  fresh: FreshTargetObservation,
  boundsTolerance = 4,
): EvidenceValidation {
  const mismatches: string[] = []
  const exact = (field: string, expected: unknown, actual: unknown) => {
    if (expected !== undefined && expected !== actual) mismatches.push(field)
  }
  exact('platform', evidence.platform, fresh.platform)
  exact('appId', evidence.appId, fresh.appId)
  exact('pid', evidence.pid, fresh.pid)
  exact('windowId', evidence.windowId, fresh.windowId)
  exact('displayId', evidence.displayId, fresh.displayId)
  exact('role', evidence.role, fresh.role)
  exact('windowTitleDigest', evidence.windowTitleDigest,
    fresh.windowTitle === undefined ? undefined : evidenceDigest(fresh.windowTitle))
  exact('labelDigest', evidence.labelDigest, fresh.label === undefined ? undefined : evidenceDigest(fresh.label))
  exact('screenshotHash', evidence.screenshotHash, fresh.screenshotHash)
  exact('uiTreeRevision', evidence.uiTreeRevision, fresh.uiTreeRevision)
  if (evidence.bounds) {
    if (!fresh.bounds) mismatches.push('bounds')
    else if (Object.keys(evidence.bounds).some(key =>
      Math.abs(evidence.bounds![key as keyof typeof evidence.bounds] - fresh.bounds![key as keyof typeof fresh.bounds]) > boundsTolerance)) {
      mismatches.push('bounds')
    }
  }
  return { valid: mismatches.length === 0, mismatches }
}
