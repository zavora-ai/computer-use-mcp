export interface InputMonitorCapability {
  supported: boolean
  backend: string
  distinguishesInjected: boolean
  recommendedPollMs: number
  reason?: string
}

export interface UserActivityEvent {
  at: number
  detectedAt: number
  latencyMs: number
  backend: string
}

export interface InputActivityMonitor {
  readonly capability: InputMonitorCapability
  start(listener: (event: UserActivityEvent) => void): void
  stop(): void
  suppressInjectedFor(durationMs: number): void
}

export interface NativeActivitySource {
  getUserIdleTimeMs(): number | null | undefined
  getInputMonitorCapability?(): InputMonitorCapability
}

export interface EmergencyStopEvent {
  generation: number
  detectedAt: number
  backend: string
}

export interface EmergencyStopMonitor {
  start(listener: (event: EmergencyStopEvent) => void): void
  stop(): void
}

export interface NativeEmergencyStopSource {
  getEmergencyStopGeneration(): number
}

/** Observes the native latch generation; the native latch itself stops input synchronously. */
export class PollingEmergencyStopMonitor implements EmergencyStopMonitor {
  readonly #source: NativeEmergencyStopSource
  readonly #backend: string
  readonly #pollMs: number
  readonly #now: () => number
  #timer?: NodeJS.Timeout
  #generation?: number

  constructor(
    source: NativeEmergencyStopSource,
    options: { backend: string; pollMs?: number; now?: () => number },
  ) {
    this.#source = source
    this.#backend = options.backend
    this.#pollMs = options.pollMs ?? 25
    this.#now = options.now ?? (() => Date.now())
    if (this.#pollMs < 5 || this.#pollMs > 1000) throw new RangeError('pollMs must be between 5 and 1000')
  }

  start(listener: (event: EmergencyStopEvent) => void): void {
    this.stop()
    this.#generation = this.#source.getEmergencyStopGeneration()
    this.#timer = setInterval(() => {
      const generation = this.#source.getEmergencyStopGeneration()
      if (this.#generation === undefined || generation <= this.#generation) return
      this.#generation = generation
      listener({ generation, detectedAt: this.#now(), backend: this.#backend })
    }, this.#pollMs)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }
}

/**
 * Samples the OS last-input clock. The capability advertises when injected
 * input cannot be distinguished; callers can then avoid claiming certified
 * user-versus-agent attribution for that backend.
 */
export class PollingInputActivityMonitor implements InputActivityMonitor {
  readonly capability: InputMonitorCapability
  readonly #source: NativeActivitySource
  readonly #now: () => number
  readonly #pollMs: number
  #timer?: NodeJS.Timeout
  #lastActivityAt?: number
  #suppressedUntil = 0

  constructor(
    source: NativeActivitySource,
    options: { pollMs?: number; now?: () => number } = {},
  ) {
    this.#source = source
    this.#now = options.now ?? (() => Date.now())
    this.capability = source.getInputMonitorCapability?.() ?? {
      supported: true,
      backend: 'native_idle_clock',
      distinguishesInjected: false,
      recommendedPollMs: 25,
      reason: 'native backend did not report injected-event attribution',
    }
    this.#pollMs = options.pollMs ?? this.capability.recommendedPollMs
    if (this.#pollMs < 5 || this.#pollMs > 1000) throw new RangeError('pollMs must be between 5 and 1000')
  }

  start(listener: (event: UserActivityEvent) => void): void {
    this.stop()
    if (!this.capability.supported) return
    this.#sample(listener, true)
    this.#timer = setInterval(() => this.#sample(listener, false), this.#pollMs)
    this.#timer.unref?.()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
  }

  suppressInjectedFor(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10_000) {
      throw new RangeError('injected-input suppression must be between 0 and 10000 ms')
    }
    this.#suppressedUntil = Math.max(this.#suppressedUntil, this.#now() + durationMs)
  }

  #sample(listener: (event: UserActivityEvent) => void, initialize: boolean): void {
    const detectedAt = this.#now()
    const idleMs = this.#source.getUserIdleTimeMs()
    if (idleMs === null || idleMs === undefined || !Number.isFinite(idleMs) || idleMs < 0) return
    const activityAt = detectedAt - idleMs
    if (initialize || this.#lastActivityAt === undefined) {
      this.#lastActivityAt = activityAt
      return
    }
    // OS idle clocks and JS clocks have different precision; require a 2 ms
    // forward step to avoid emitting the same physical event repeatedly.
    if (activityAt <= this.#lastActivityAt + 2) return
    this.#lastActivityAt = activityAt
    if (detectedAt <= this.#suppressedUntil) return
    listener({
      at: activityAt,
      detectedAt,
      latencyMs: Math.max(0, detectedAt - activityAt),
      backend: this.capability.backend,
    })
  }
}

/** Deterministic monitor for fake desktops and race/property tests. */
export class ManualInputActivityMonitor implements InputActivityMonitor {
  readonly capability: InputMonitorCapability = {
    supported: true,
    backend: 'manual_test_monitor',
    distinguishesInjected: true,
    recommendedPollMs: 0,
  }
  #listener?: (event: UserActivityEvent) => void

  start(listener: (event: UserActivityEvent) => void): void {
    this.#listener = listener
  }

  stop(): void {
    this.#listener = undefined
  }

  suppressInjectedFor(): void {}

  emit(at = Date.now(), detectedAt = at): void {
    this.#listener?.({ at, detectedAt, latencyMs: Math.max(0, detectedAt - at), backend: this.capability.backend })
  }
}

export class ManualEmergencyStopMonitor implements EmergencyStopMonitor {
  #listener?: (event: EmergencyStopEvent) => void

  start(listener: (event: EmergencyStopEvent) => void): void {
    this.#listener = listener
  }

  stop(): void {
    this.#listener = undefined
  }

  emit(generation = 1, detectedAt = Date.now()): void {
    this.#listener?.({ generation, detectedAt, backend: 'manual_test_emergency_stop' })
  }
}
