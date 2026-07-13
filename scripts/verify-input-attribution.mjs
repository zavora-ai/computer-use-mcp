#!/usr/bin/env node

import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const native = require('../computer-use-napi.node')
const interactive = process.argv.includes('--interactive')

function fail(message, evidence = {}) {
  console.error(JSON.stringify({ passed: false, message, ...evidence }))
  process.exit(1)
}

const capability = native.getInputMonitorCapability?.()
if (!capability?.supported || !capability.distinguishesInjected) {
  fail('attributed native input monitoring is unavailable', { capability })
}

// Establish a non-zero baseline, then inject a no-op pointer movement at the
// current location. A physical-only clock must continue advancing rather than
// resetting when the synthetic event crosses the OS input stream.
await delay(60)
const syntheticBefore = native.getUserIdleTimeMs?.()
const pointer = native.cursorPosition()
native.mouseMove(pointer.x, pointer.y)
await delay(50)
const syntheticAfter = native.getUserIdleTimeMs?.()
const syntheticAdvanceMs = syntheticAfter - syntheticBefore
if (!Number.isFinite(syntheticAdvanceMs) || syntheticAdvanceMs < 20) {
  fail('synthetic input advanced the physical-user clock', {
    capability, syntheticBefore, syntheticAfter, syntheticAdvanceMs,
  })
}

const emergencyCapability = native.configureEmergencyStopChord?.('ctrl+alt+shift+escape')
if (!emergencyCapability?.supported || !emergencyCapability.physicalOnly) {
  fail('physical-only native emergency-stop monitoring is unavailable', { emergencyCapability })
}
const generationBefore = native.getEmergencyStopGeneration()
const waitWorker = new Worker(String.raw`
  const { parentPort, workerData } = require('node:worker_threads')
  const native = require(workerData.addonPath)
  parentPort.postMessage({ type: 'ready' })
  parentPort.postMessage({ type: 'result', result: native.waitForNativeEmergencyStop(2000) })
`, { eval: true, workerData: { addonPath: fileURLToPath(new URL('../computer-use-napi.node', import.meta.url)) } })
const nativeWait = await new Promise((resolve, reject) => {
  waitWorker.on('message', message => {
    if (message.type === 'ready') native.triggerNativeEmergencyStop()
    if (message.type === 'result') resolve(message.result)
  })
  waitWorker.once('error', reject)
})
await waitWorker.terminate()
const generationAfter = native.getEmergencyStopGeneration()
let blockedAfterLatch = false
try { native.keyPress('a') }
catch (error) { blockedAfterLatch = /EmergencyStop/.test(String(error?.message ?? error)) }
const latched = native.isNativeEmergencyStopActive?.() === true
native.resetNativeEmergencyStop()
if (!latched || generationAfter !== generationBefore + 1 || !blockedAfterLatch
    || !nativeWait.triggered || !Number.isFinite(nativeWait.observerLatencyMs) || nativeWait.observerLatencyMs >= 100
    || native.isNativeEmergencyStopActive?.()) {
  fail('native emergency latch did not block and reset exactly once', {
    emergencyCapability, generationBefore, generationAfter, latched, blockedAfterLatch, nativeWait,
  })
}

const evidence = {
  schemaVersion: 1,
  platform: process.platform,
  architecture: process.arch,
  capability,
  syntheticExclusion: {
    passed: true,
    beforeIdleMs: syntheticBefore,
    afterIdleMs: syntheticAfter,
    advanceMs: syntheticAdvanceMs,
  },
  emergencyStop: {
    passed: true,
    capability: emergencyCapability,
    generationBefore,
    generationAfter,
    blockedAfterLatch,
    nativeWait,
    reset: true,
  },
}

if (interactive) {
  process.stderr.write('Move the physical mouse or press a physical key within 10 seconds…\n')
  const deadline = Date.now() + 10_000
  let priorIdle = native.getUserIdleTimeMs()
  let detectionLatencyMs
  while (Date.now() < deadline) {
    await delay(2)
    const idle = native.getUserIdleTimeMs()
    if (Number.isFinite(idle) && idle + 5 < priorIdle) {
      detectionLatencyMs = idle
      break
    }
    priorIdle = idle
  }
  if (detectionLatencyMs === undefined) {
    fail('no physical input was detected before the interactive timeout', evidence)
  }
  evidence.physicalDetection = {
    passed: detectionLatencyMs < 100,
    latencyMs: detectionLatencyMs,
    targetP95Ms: 100,
  }
  if (!evidence.physicalDetection.passed) {
    fail('physical input detection exceeded the v8 latency gate', evidence)
  }
}

console.log(JSON.stringify({ passed: true, ...evidence }))
