import { createHash } from 'node:crypto'
import { SupervisorEventBus, type SessionState } from './events.js'
import type { RuntimeSession, SessionCompletionEvidence, SessionStore } from './store.js'

function disclosureSafeTextMetadata(value: string): { digest: string; length: number } {
  return {
    digest: `sha256:${createHash('sha256').update(value).digest('hex')}`,
    length: value.length,
  }
}

const transitions: Record<SessionState, ReadonlySet<SessionState>> = {
  created: new Set(['running', 'stopped']),
  running: new Set(['waiting_for_user', 'paused_by_user', 'paused_by_policy', 'stopping', 'completed', 'failed']),
  waiting_for_user: new Set(['running', 'paused_by_user', 'stopping', 'failed']),
  paused_by_user: new Set(['running', 'stopping', 'stopped']),
  paused_by_policy: new Set(['running', 'stopping', 'failed', 'stopped']),
  stopping: new Set(['stopped', 'failed']),
  completed: new Set(),
  failed: new Set(),
  stopped: new Set(),
}

export class SessionLifecycle {
  readonly #ready: Promise<void>

  constructor(
    readonly store: SessionStore,
    readonly events = new SupervisorEventBus(),
    readonly now: () => Date = () => new Date(),
  ) {
    const recover = (store as SessionStore & { recoverAll?: () => Promise<RuntimeSession[]> }).recoverAll
    this.#ready = recover
      ? recover.call(store).then(sessions => {
          for (const session of sessions) {
            this.events.publish({
              sessionId: session.sessionId, principalId: session.principalId, type: 'session.recovered',
              payload: { state: session.state, reason: session.waitingReason ?? 'runtime_recovered' },
            })
          }
        })
      : Promise.resolve()
  }

  async start(input: { principalId: string; executionGroupId?: string; objective?: string }): Promise<RuntimeSession> {
    await this.#ready
    const created = await this.store.create(input)
    this.events.publish({ sessionId: created.sessionId, principalId: created.principalId, type: 'session.created', payload: { state: created.state } })
    return this.transition(created.sessionId, 'running')
  }

  async transition(sessionId: string, state: SessionState, reason?: string): Promise<RuntimeSession> {
    await this.#ready
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.store.get(sessionId)
      if (!current) throw new Error(`unknown session: ${sessionId}`)
      if (current.state === state) return current
      if (!transitions[current.state].has(state)) {
        throw new Error(`invalid session transition: ${current.state} -> ${state}`)
      }
      const next: RuntimeSession = {
        ...current,
        state,
        revision: current.revision + 1,
        updatedAt: this.now().toISOString(),
        ...(reason ? { waitingReason: reason } : { waitingReason: undefined }),
      }
      if (await this.store.compareAndSet(sessionId, current.revision, next)) {
        this.events.publish({
          sessionId,
          principalId: current.principalId,
          type: 'session.state_changed',
          payload: {
            from: current.state,
            to: state,
            ...(reason ? { reasonMetadata: disclosureSafeTextMetadata(reason) } : {}),
          },
        })
        return next
      }
    }
    throw new Error(`session transition contention: ${sessionId}`)
  }

  async complete(
    sessionId: string,
    evidence: Omit<SessionCompletionEvidence, 'completedAt'>,
  ): Promise<RuntimeSession> {
    await this.#ready
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.store.get(sessionId)
      if (!current) throw new Error(`unknown session: ${sessionId}`)
      if (!transitions[current.state].has('completed')) {
        throw new Error(`invalid session transition: ${current.state} -> completed`)
      }
      const completion: SessionCompletionEvidence = {
        ...structuredClone(evidence), completedAt: this.now().toISOString(),
      }
      const next: RuntimeSession = {
        ...current, state: 'completed', completion,
        revision: current.revision + 1, updatedAt: completion.completedAt, waitingReason: undefined,
      }
      if (await this.store.compareAndSet(sessionId, current.revision, next)) {
        this.events.publish({
          sessionId, principalId: current.principalId, type: 'session.completed',
          payload: {
            summaryMetadata: disclosureSafeTextMetadata(completion.summary),
            postconditions: {
              total: completion.postconditions.length,
              satisfied: completion.postconditions.filter(item => item.satisfied).length,
              evidenceHashes: completion.postconditions.flatMap(item => item.evidenceHash ? [item.evidenceHash] : []),
            },
            actionCounts: completion.actionCounts,
          },
        })
        return next
      }
    }
    throw new Error(`session completion contention: ${sessionId}`)
  }
}
