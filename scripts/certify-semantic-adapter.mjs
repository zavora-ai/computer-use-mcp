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
  createSessionReferenceAdapterHost,
  SemanticValueAdapter,
} from '../dist/runtime/reference-adapters.js'

function option(name) {
  const prefix = `--${name}=`
  const value = process.argv.slice(2).find(argument => argument.startsWith(prefix))
  return value === undefined ? undefined : value.slice(prefix.length)
}

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  throw new Error(`semantic certification is unavailable on ${process.platform}`)
}
const appId = option('app-id')
const windowId = Number(option('window-id'))
const role = option('role')
const label = option('label')
if (!appId || !Number.isSafeInteger(windowId) || windowId <= 0 || !role || label === undefined) {
  throw new TypeError('required: --app-id, --window-id, --role=AXTextField|AXTextArea, and --label (may be empty)')
}
if (role !== 'AXTextField' && role !== 'AXTextArea') {
  throw new TypeError('--role must be AXTextField or AXTextArea')
}
const ttlMs = Number(option('ttl-ms') ?? 3_600_000)
if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) {
  throw new RangeError('--ttl-ms must be an integer between 1000 and 86400000')
}
const attempts = Number(option('attempts') ?? 3)
if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
  throw new RangeError('--attempts must be an integer between 1 and 10')
}

const native = loadNative()
const session = createSession({ native, elicitApproval: async () => true })
const host = createSessionReferenceAdapterHost({
  native,
  dispatch: (tool, args) => session.dispatch(tool, args),
})
const target = {
  platform: process.platform,
  adapterId: option('adapter-id') ?? `zavora.operator.${process.platform}.semantic-value`,
  appId,
  operation: option('operation') ?? 'semantic_set_bound_value',
  windowId,
  role,
  label,
  ...(option('max-value-bytes') ? { maxValueBytes: Number(option('max-value-bytes')) } : {}),
}
const traceRoot = process.env.COMPUTER_USE_CERTIFICATION_DIR
  ?? join(homedir(), '.computer-use-mcp', 'certifications')
const service = new CapabilityCertificationService(
  new CapabilityRegistry(),
  [new SemanticValueAdapter(host, target)],
  () => new Date(),
  new FileCertificationTraceStore(traceRoot),
)
let capability
for (let attempt = 1; attempt <= attempts; attempt++) {
  capability = await service.certify({ appId, operation: target.operation, ttlMs })
  if (capability.supportedModes.includes('background')) break
}
const trace = await service.traces.get(capability.certification.certificationId)
const passed = capability.supportedModes.includes('background')
console.log(JSON.stringify({ passed, attempts, target: {
  platform: target.platform,
  appId: target.appId,
  operation: target.operation,
  windowId: target.windowId,
  role: target.role,
  targetBindingDigest: trace?.contract.bindingDigest,
}, capability, trace }))
if (!passed) process.exitCode = 1
