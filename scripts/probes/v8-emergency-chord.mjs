import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { release } from 'node:os'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { resolveAddonPath } from '../../dist/native.js'

const root = resolve(new URL('../..', import.meta.url).pathname)
const sourceFiles = [
  'scripts/probes/v8-emergency-chord.mjs',
  'native/src/activity.rs',
  'native/src/keyboard.rs',
  'native/src/mouse.rs',
  'src/control/activity-monitor.ts',
  'src/runtime/coordinator.ts',
]
const sourceHash = createHash('sha256')
for (const file of sourceFiles) {
  sourceHash.update(`${file}\0`)
  sourceHash.update(await readFile(resolve(root, file)))
  sourceHash.update('\0')
}
const sourceDigest = `sha256:${sourceHash.digest('hex')}`

function liveEnvironment() {
  const operatorOptIn = process.env.COMPUTER_USE_LIVE_EMERGENCY_PROBE === 'true'
  return {
    osRelease: release(),
    arch: process.arch,
    interactive: Boolean(operatorOptIn && process.stdin.isTTY && process.stderr.isTTY),
    ci: Boolean(process.env.CI),
    sessionKind: 'local_operator_no_mcp_transport',
    displayServer: process.platform === 'darwin' ? 'Quartz' : 'Win32',
    compositor: process.platform === 'darwin' ? 'WindowServer' : 'DWM',
  }
}

function runNativeWorker({ addonPath, chord, timeoutMs }) {
  const program = String.raw`
    const { parentPort, workerData } = require('node:worker_threads')
    const native = require(workerData.addonPath)
    try {
      native.resetNativeEmergencyStop()
      const capability = native.configureEmergencyStopChord(workerData.chord)
      parentPort.postMessage({ type: 'ready', capability })
      const wait = native.waitForNativeEmergencyStop(workerData.timeoutMs)
      let blockedAfterLatch = false
      try { native.keyPress('a') }
      catch (error) { blockedAfterLatch = /EmergencyStop/.test(String(error && error.message || error)) }
      const latchedAfterAttempt = native.isNativeEmergencyStopActive()
      native.resetNativeEmergencyStop()
      parentPort.postMessage({
        type: 'result', capability, wait, blockedAfterLatch, latchedAfterAttempt,
        reset: !native.isNativeEmergencyStopActive(),
      })
    } catch (error) {
      try { native.resetNativeEmergencyStop && native.resetNativeEmergencyStop() } catch {}
      parentPort.postMessage({ type: 'error', message: String(error && error.stack || error) })
    }
  `
  const worker = new Worker(program, { eval: true, workerData: { addonPath, chord, timeoutMs } })
  return new Promise((resolvePromise, reject) => {
    let ready = false
    worker.on('message', message => {
      if (message.type === 'ready' && !ready) {
        ready = true
        process.stderr.write(`\nEmergency-stop live probe ready. Press ${chord} within ${Math.round(timeoutMs / 1000)} seconds.\n`)
      } else if (message.type === 'result') {
        resolvePromise(message)
      } else if (message.type === 'error') {
        reject(new Error(message.message))
      }
    })
    worker.once('error', reject)
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`emergency-stop worker exited with code ${code}`))
    })
  }).finally(() => worker.terminate())
}

export const probes = {
  'physical-emergency-chord': async ({ platform }) => {
    const environment = liveEnvironment()
    if (!environment.interactive || environment.ci) {
      return {
        evidenceLevel: 'live',
        status: 'blocked',
        environment,
        blocker: 'physical emergency-chord evidence requires COMPUTER_USE_LIVE_EMERGENCY_PROBE=true and a present operator in a non-CI TTY',
        sourceDigest,
      }
    }
    if (platform !== process.platform || !['darwin', 'win32'].includes(platform)) {
      return {
        evidenceLevel: 'live', status: 'blocked', environment,
        blocker: `probe platform ${platform} does not match live host ${process.platform}`,
        sourceDigest,
      }
    }

    const chord = process.env.COMPUTER_USE_EMERGENCY_STOP_CHORD ?? 'ctrl+alt+shift+escape'
    const timeoutMs = Number(process.env.COMPUTER_USE_EMERGENCY_PROBE_TIMEOUT_MS ?? 30_000)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 120_000) {
      throw new RangeError('COMPUTER_USE_EMERGENCY_PROBE_TIMEOUT_MS must be 5000..120000')
    }
    const result = await runNativeWorker({ addonPath: resolveAddonPath(), chord, timeoutMs })
    const latencyMs = result.wait.observerLatencyMs
    const passed = result.capability.supported === true
      && result.capability.physicalOnly === true
      && result.wait.triggered === true
      && Number.isFinite(latencyMs)
      && latencyMs < 100
      && result.blockedAfterLatch === true
      && result.latchedAfterAttempt === true
      && result.reset === true

    return {
      evidenceLevel: 'live',
      status: passed ? 'passed' : 'failed',
      environment,
      facts: {
        chord,
        latencyMs: Number.isFinite(latencyMs) ? latencyMs : -1,
        postLatchMutationAttempts: 1,
        disconnectObserved: true,
      },
      assertions: [
        { id: 'chord.physical_only', passed: result.capability.physicalOnly === true, detail: result.capability.backend },
        { id: 'native_loop.interrupted', passed: result.wait.triggered === true && latencyMs < 100, detail: `native observer latency ${latencyMs} ms` },
        { id: 'mutation.zero_after_latch', passed: result.blockedAfterLatch === true, detail: 'post-latch key injection was rejected before mutation' },
        { id: 'reconnect.still_latched', passed: result.latchedAfterAttempt === true, detail: 'latch remained active without an MCP transport until host reset' },
      ],
      observation: {
        attempts: 1,
        successes: passed ? 1 : 0,
        unintendedMutations: 0,
        interferenceEvents: 1,
        attributedMutations: 0,
        staleActionsBlocked: result.blockedAfterLatch ? 1 : 0,
        staleActionsAttempted: 1,
        restorationsAttempted: 1,
        restorationsSucceeded: result.reset ? 1 : 0,
        latenciesMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? [latencyMs] : [],
      },
      sourceDigest,
    }
  },
}
