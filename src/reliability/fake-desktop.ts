import type { ToolResult } from '../result.js'
import type { DesktopStateSnapshot, RestorationResult, TransactionHooks, VerificationResult } from '../control/transaction.js'
import { RuntimeError, type ActionEnvelope, type TargetEvidence } from '../runtime/types.js'
import { evidenceDigest } from '../targeting/validate.js'

export interface FakeDesktopState {
  appId: string
  pid: number
  windowId: number
  windowTitle: string
  displayId: string
  screenshotHash: string
  uiTreeRevision: string
  frontmostAppId: string
  frontmostWindowId: number
  cursor: { x: number; y: number }
  clipboard: string
  effectCount: number
  restoreCount: number
}

type ExecutionFault = 'none' | 'fail_after_effect' | 'wait_for_abort'

/**
 * Deterministic, image-free desktop used by the public v8 safety corpus.
 * It models the side-effect boundary, target drift, cancellation, verification,
 * and restoration without requiring a real UI session.
 */
export class DeterministicFakeDesktop implements TransactionHooks {
  readonly state: FakeDesktopState
  readonly now: () => Date
  #fault: ExecutionFault = 'none'
  #driftRevision = 1
  #started?: Promise<void>
  #markStarted?: () => void

  constructor(
    initial: Partial<FakeDesktopState> = {},
    now: () => Date = () => new Date('2026-07-13T00:00:00.000Z'),
  ) {
    this.now = now
    this.state = {
      appId: 'app.fake', pid: 4242, windowId: 7, windowTitle: 'Fake Document',
      displayId: 'display-1', screenshotHash: 'sha256:fake-screen-1',
      uiTreeRevision: 'fake-tree-1', frontmostAppId: 'app.user', frontmostWindowId: 99,
      cursor: { x: 40, y: 60 }, clipboard: '', effectCount: 0, restoreCount: 0,
      ...structuredClone(initial),
    }
  }

  targetEvidence(now = this.now()): TargetEvidence {
    return {
      platform: process.platform,
      appId: this.state.appId,
      pid: this.state.pid,
      windowId: this.state.windowId,
      windowTitleDigest: evidenceDigest(this.state.windowTitle),
      displayId: this.state.displayId,
      observationId: `fake-observation-${this.state.uiTreeRevision}`,
      screenshotHash: this.state.screenshotHash,
      uiTreeRevision: this.state.uiTreeRevision,
      confidence: 1,
      capturedAt: now.toISOString(),
    }
  }

  validateTarget = (target: TargetEvidence): boolean =>
    target.appId === this.state.appId
    && target.pid === this.state.pid
    && target.windowId === this.state.windowId
    && target.windowTitleDigest === evidenceDigest(this.state.windowTitle)
    && target.displayId === this.state.displayId
    && target.screenshotHash === this.state.screenshotHash
    && target.uiTreeRevision === this.state.uiTreeRevision

  driftWindow(): void {
    this.#driftRevision++
    this.state.windowTitle = `${this.state.windowTitle} (changed)`
    this.state.screenshotHash = `sha256:fake-screen-${this.#driftRevision}`
    this.state.uiTreeRevision = `fake-tree-${this.#driftRevision}`
  }

  failAfterNextEffect(): void { this.#fault = 'fail_after_effect' }

  waitForAbortOnNextEffect(): Promise<void> {
    this.#fault = 'wait_for_abort'
    this.#started = new Promise(resolve => { this.#markStarted = resolve })
    return this.#started
  }

  execute = async (tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> => {
    if (signal?.aborted) throw new RuntimeError('interrupted', 'fake action aborted before effect')
    this.#markStarted?.()
    this.#markStarted = undefined
    if (this.#fault === 'wait_for_abort') {
      this.#fault = 'none'
      if (!signal) throw new TypeError('wait_for_abort requires an AbortSignal')
      if (!signal.aborted) {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      }
      throw new RuntimeError('interrupted', 'fake action observed lease revocation')
    }

    this.state.effectCount++
    if (tool === 'write_clipboard') this.state.clipboard = String(args.text ?? '')
    if (tool === 'left_click' && Array.isArray(args.coordinate)) {
      this.state.cursor = { x: Number(args.coordinate[0]), y: Number(args.coordinate[1]) }
    }
    const result: ToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ fake: true, effectCount: this.state.effectCount }) }],
      structuredContent: { fake: true, effectCount: this.state.effectCount },
    }
    if (this.#fault === 'fail_after_effect') {
      this.#fault = 'none'
      throw new Error('deterministic crash after fake side effect')
    }
    return result
  }

  async capture(_envelope: ActionEnvelope): Promise<DesktopStateSnapshot> {
    return {
      capturedAt: this.now().toISOString(),
      cursor: structuredClone(this.state.cursor),
      frontmostAppId: this.state.frontmostAppId,
      frontmostWindowId: this.state.frontmostWindowId,
    }
  }

  async verify(_envelope: ActionEnvelope, result: ToolResult): Promise<VerificationResult> {
    return {
      verified: result.structuredContent?.fake === true,
      method: 'deterministic_fake_postcondition',
      details: { effectCount: this.state.effectCount },
    }
  }

  async restore(snapshot: DesktopStateSnapshot, _envelope: ActionEnvelope): Promise<RestorationResult> {
    if (snapshot.cursor) this.state.cursor = structuredClone(snapshot.cursor)
    if (snapshot.frontmostAppId) this.state.frontmostAppId = snapshot.frontmostAppId
    if (typeof snapshot.frontmostWindowId === 'number') this.state.frontmostWindowId = snapshot.frontmostWindowId
    this.state.restoreCount++
    return { restored: true, cursorRestored: Boolean(snapshot.cursor), focusRestored: true }
  }
}
