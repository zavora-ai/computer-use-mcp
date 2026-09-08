import { parentPort, workerData } from 'node:worker_threads'
import { loadNative } from './native.js'
const native = loadNative()
try {
  const capability = native.configureEmergencyStopChord?.(workerData.chord)
  if (!capability?.supported || !native.waitForNativeEmergencyStop) throw new Error('Native emergency stop unavailable')
  parentPort?.postMessage({ type: 'ready', capability })
  const monitor = native.getInputMonitorCapability?.()
  let previousInput = Date.now() - (native.getUserIdleTimeMs?.() ?? 0)
  while (true) {
    const stopped = native.waitForNativeEmergencyStop(25)
    if (stopped.triggered) { parentPort?.postMessage({ type: 'takeover', ...stopped }); break }
    if (workerData.pauseOnHumanInput && monitor?.distinguishesInjected) {
      const idle = native.getUserIdleTimeMs?.()
      if (idle !== null && idle !== undefined) {
        const inputTime = Date.now() - idle
        if (inputTime > previousInput + 10) {
          native.triggerNativeEmergencyStop?.()
          parentPort?.postMessage({ type: 'takeover', reason: 'physical_input' }); break
        }
        previousInput = Math.max(previousInput, inputTime)
      }
    }
  }
} catch (error) { parentPort?.postMessage({ type: 'error', error: String(error) }) }
