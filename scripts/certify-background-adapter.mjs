#!/usr/bin/env node

import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSession } from '../dist/session.js'
import { loadNative } from '../dist/native.js'
import { CapabilityRegistry } from '../dist/runtime/capabilities.js'
import {
  CapabilityCertificationService,
  FileCertificationTraceStore,
} from '../dist/runtime/adapters.js'
import {
  createReferenceAdapters,
  createSessionReferenceAdapterHost,
  MACOS_FINDER_COMMENT_OPERATION,
  WINDOWS_POWERSHELL_WRITE_OPERATION,
} from '../dist/runtime/reference-adapters.js'

const native = loadNative()
const session = createSession({ native, elicitApproval: async () => true })
const host = createSessionReferenceAdapterHost({
  native,
  dispatch: (tool, args) => session.dispatch(tool, args),
})
const sandboxRoot = process.env.COMPUTER_USE_CERTIFICATION_SANDBOX
  ?? join(homedir(), '.computer-use-mcp', 'certification-sandbox')
const traceRoot = process.env.COMPUTER_USE_CERTIFICATION_DIR
  ?? join(homedir(), '.computer-use-mcp', 'certifications')
const adapters = createReferenceAdapters(host, sandboxRoot)
if (adapters.length === 0) {
  throw new Error(`no reference background adapter is available on ${process.platform}`)
}

const selection = process.argv[2]
const expected = process.platform === 'darwin' ? 'finder' : process.platform === 'win32' ? 'powershell' : undefined
if (selection && selection !== expected) {
  throw new Error(`adapter ${selection} is not available on ${process.platform}; expected ${expected}`)
}
const appId = process.platform === 'darwin' ? 'com.apple.finder' : 'powershell.exe'
const operation = process.platform === 'darwin'
  ? MACOS_FINDER_COMMENT_OPERATION
  : WINDOWS_POWERSHELL_WRITE_OPERATION
const ttlArg = process.argv.find(value => value.startsWith('--ttl-ms='))
const ttlMs = ttlArg ? Number(ttlArg.slice('--ttl-ms='.length)) : 3_600_000
if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) {
  throw new RangeError('--ttl-ms must be an integer between 1000 and 86400000')
}
const attemptsArg = process.argv.find(value => value.startsWith('--attempts='))
const attempts = attemptsArg ? Number(attemptsArg.slice('--attempts='.length)) : 3
if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
  throw new RangeError('--attempts must be an integer between 1 and 10')
}

const service = new CapabilityCertificationService(
  new CapabilityRegistry(),
  adapters,
  () => new Date(),
  new FileCertificationTraceStore(traceRoot),
)
let capability
for (let attempt = 1; attempt <= attempts; attempt++) {
  capability = await service.certify({ appId, operation, ttlMs })
  if (capability.supportedModes.includes('background')) break
}
const trace = await service.traces.get(capability.certification.certificationId)
const passed = capability.supportedModes.includes('background')
console.log(JSON.stringify({ passed, attempts, capability, trace }))
if (!passed) process.exitCode = 1
