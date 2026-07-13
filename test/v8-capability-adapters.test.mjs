import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CapabilityCertificationService,
  MemoryCertificationTraceStore,
  verifyCertificationTrace,
} from '../dist/runtime/adapters.js'
import { CapabilityRegistry } from '../dist/runtime/capabilities.js'
import {
  buildFinderCommentAction,
  buildPowerShellSandboxWriteAction,
  buildSemanticValueAction,
  MacOSFinderCommentAdapter,
  MACOS_FINDER_COMMENT_OPERATION,
  WindowsPowerShellSandboxAdapter,
  WINDOWS_POWERSHELL_WRITE_OPERATION,
  SemanticValueAdapter,
} from '../dist/runtime/reference-adapters.js'
import { RuntimeCoordinator } from '../dist/runtime/coordinator.js'
import { RuntimeError } from '../dist/runtime/types.js'
import { createComputerUseServer } from '../dist/server.js'
import { connectInProcess } from '../dist/client.js'

const fixedDesktop = platform => ({
  platform,
  async getFrontmostAppId() { return 'app.user' },
  async getPointer() { return { x: 100, y: 200 } },
  async getPhysicalUserIdleTimeMs() { return 1_000 },
})

test('macOS Finder reference adapter certifies a reversible sandbox workflow and rejects path escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computer-use-finder-adapter-'))
  const changedRoot = await mkdtemp(join(tmpdir(), 'computer-use-finder-adapter-changed-'))
  let comment = ''
  let commentReads = 0
  const host = {
    ...fixedDesktop('darwin'),
    async getAppVersion() { return '15.5' },
    async runScript(_language, script) {
      if (script.includes(' to set comment ')) {
        const match = script.match(/ to "([^"]*)"$/)
        comment = match?.[1] ?? ''
        return { code: 0, stdout: '', stderr: '' }
      }
      if (script.includes(' to get comment ')) {
        commentReads++
        return { code: 0, stdout: comment, stderr: '' }
      }
      return { code: 1, stdout: '', stderr: 'unexpected script' }
    },
  }
  try {
    const adapter = new MacOSFinderCommentAdapter(host, root)
    const registry = new CapabilityRegistry()
    const traces = new MemoryCertificationTraceStore()
    const service = new CapabilityCertificationService(
      registry, [adapter], () => new Date('2026-07-13T12:00:00Z'), traces, 'darwin',
    )
    const capability = await service.certify({
      appId: 'com.apple.finder', operation: MACOS_FINDER_COMMENT_OPERATION,
    })
    assert.ok(capability.supportedModes.includes('background'))
    const trace = await traces.get(capability.certification.certificationId)
    assert.equal(verifyCertificationTrace(trace), true)
    assert.equal(trace.probe.result.focusChanged, false)
    assert.equal(trace.probe.result.pointerMoved, false)
    assert.equal(trace.probe.result.evidence.rollbackSucceeded, true)
    assert.equal(commentReads, 2, 'probe must read back both the mutation and rollback')

    const changedRegistry = new CapabilityRegistry(() => new Date('2026-07-13T12:00:00Z'))
    const changedService = new CapabilityCertificationService(
      changedRegistry,
      [new MacOSFinderCommentAdapter(host, changedRoot)],
      () => new Date('2026-07-13T12:00:00Z'),
      traces,
      'darwin',
    )
    assert.deepEqual(await changedService.restore(), {
      restored: [],
      rejected: [{ certificationId: capability.certification.certificationId, reason: 'contract_changed' }],
    })

    const inside = join(root, 'inside.txt')
    await writeFile(inside, 'inside')
    assert.equal(await adapter.matchesAction(
      'com.apple.finder', MACOS_FINDER_COMMENT_OPERATION,
      buildFinderCommentAction(inside, 'safe'),
    ), true)
    const outsideRoot = await mkdtemp(join(tmpdir(), 'computer-use-outside-'))
    const outside = join(outsideRoot, 'outside.txt')
    await writeFile(outside, 'outside')
    const link = join(root, 'escape-link')
    await symlink(outside, link)
    assert.equal(await adapter.matchesAction(
      'com.apple.finder', MACOS_FINDER_COMMENT_OPERATION,
      buildFinderCommentAction(link, 'unsafe'),
    ), false)
    await rm(outsideRoot, { recursive: true, force: true })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(changedRoot, { recursive: true, force: true })
  }
})

test('Windows PowerShell reference adapter certifies canonical UTF-8 sandbox writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'computer-use-powershell-adapter-'))
  const host = {
    ...fixedDesktop('win32'),
    async getAppVersion() { return '7.5.2' },
    async runScript(_language, script) {
      const match = script.match(/WriteAllText\('([^']*)','([^']*)'/)
      if (!match) return { code: 1, stdout: '', stderr: 'unexpected script' }
      await writeFile(match[1], match[2], 'utf8')
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  try {
    const adapter = new WindowsPowerShellSandboxAdapter(host, root)
    const registry = new CapabilityRegistry()
    const service = new CapabilityCertificationService(
      registry, [adapter], () => new Date('2026-07-13T12:00:00Z'),
      new MemoryCertificationTraceStore(), 'win32',
    )
    const capability = await service.certify({
      appId: 'powershell.exe', operation: WINDOWS_POWERSHELL_WRITE_OPERATION,
    })
    assert.ok(capability.supportedModes.includes('background'))
    const target = join(root, 'target.txt')
    await writeFile(target, '')
    const action = buildPowerShellSandboxWriteAction(target, "it's bounded")
    assert.equal(await adapter.matchesAction(
      'powershell.exe', WINDOWS_POWERSHELL_WRITE_OPERATION, action,
    ), true)
    assert.equal(await adapter.matchesAction(
      'powershell.exe', WINDOWS_POWERSHELL_WRITE_OPERATION,
      { ...action, script: `${action.script}; Start-Process notepad` },
    ), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

for (const platform of ['darwin', 'win32']) {
  test(`${platform === 'darwin' ? 'AX' : 'UIA'} semantic adapter executes directly without legacy focus acquisition`, async () => {
    const target = {
      platform,
      adapterId: `zavora.test.${platform}.semantic`,
      appId: platform === 'darwin' ? 'com.example.Editor' : 'editor.exe',
      operation: 'set_bound_document_value',
      windowId: 42,
      role: 'AXTextField',
      label: 'Document body',
      maxValueBytes: 1024,
    }
    let value = 'original'
    let suppressReadback = false
    const host = {
      ...fixedDesktop(platform),
      async getAppVersion() { return '1.2.3' },
      async runScript() { return { code: 1, stdout: '', stderr: 'not used' } },
      async getWindowAppId(windowId) { return windowId === 42 ? target.appId : undefined },
      async findElements(windowId, role, label) {
        return windowId === 42 && role === target.role && label === target.label
          ? [{ role, label, value: suppressReadback ? 'stale readback' : value, bounds: { x: 0, y: 0, width: 10, height: 10 }, actions: [] }]
          : []
      },
      async setElementValue(windowId, role, label, next) {
        if (windowId !== 42 || role !== target.role || label !== target.label) return { set: false, reason: 'not_found' }
        value = next
        return { set: true }
      },
    }
    const registry = new CapabilityRegistry()
    const adapter = new SemanticValueAdapter(host, target)
    const service = new CapabilityCertificationService(
      registry, [adapter], () => new Date(), new MemoryCertificationTraceStore(), platform,
    )
    const capability = await service.certify({ appId: target.appId, operation: target.operation })
    assert.ok(capability.supportedModes.includes('background'))
    assert.equal(capability.backend, platform === 'darwin' ? 'ax' : 'uia')
    assert.equal(value, 'original', 'probe must restore the original semantic value')

    let legacyCalls = 0
    const runtime = new RuntimeCoordinator({
      capabilities: registry,
      policy: async () => ({ decision: 'allow', policyDigest: 'allow', reasons: [] }),
      validateTarget: async () => true,
      execute: async () => { legacyCalls++; return { content: [] } },
    })
    try {
      const lease = await runtime.leases.acquire({
        sessionId: 'semantic-session', principalId: 'owner', kind: 'cooperative',
        executionMode: 'background', ttlMs: 10_000, actionBudget: 1,
        boundary: { appIds: [target.appId], windowIds: [target.windowId] },
      })
      const args = buildSemanticValueAction(target, 'certified value')
      const result = await runtime.execute({
        sessionId: 'semantic-session', actionId: `semantic-${platform}`, principalId: 'owner',
        tool: 'set_value', operation: target.operation,
        certificationId: capability.certification.certificationId,
        args, mode: 'background', leaseId: lease.leaseId,
        target: {
          platform, appId: target.appId, windowId: target.windowId,
          observationId: 'semantic-observation', confidence: 1,
          capturedAt: new Date().toISOString(),
        },
      })
      assert.equal(result.receipt.status, 'committed')
      assert.equal(value, 'certified value')
      assert.equal(legacyCalls, 0, 'certified semantic execution must bypass the focus-enforcing handler')

      runtime.leases.release(lease.leaseId)
      suppressReadback = true
      const failedLease = await runtime.leases.acquire({
        sessionId: 'semantic-session', principalId: 'owner', kind: 'cooperative',
        executionMode: 'background', ttlMs: 10_000, actionBudget: 1,
        boundary: { appIds: [target.appId], windowIds: [target.windowId] },
      })
      await assert.rejects(runtime.execute({
        sessionId: 'semantic-session', actionId: `semantic-false-success-${platform}`, principalId: 'owner',
        tool: 'set_value', operation: target.operation,
        certificationId: capability.certification.certificationId,
        args: buildSemanticValueAction(target, 'unverified value'), mode: 'background',
        leaseId: failedLease.leaseId,
        target: {
          platform, appId: target.appId, windowId: target.windowId,
          observationId: 'semantic-observation-2', confidence: 1,
          capturedAt: new Date().toISOString(),
        },
      }), error => error instanceof RuntimeError && error.code === 'indeterminate')
      assert.equal((await runtime.receipts.get(
        'semantic-session', `semantic-false-success-${platform}`,
      )).status, 'indeterminate')
    } finally { runtime.dispose() }

    assert.throws(() => new SemanticValueAdapter(host, { ...target, label: 'Password' }), /sensitive/)
  })
}

test('semantic probe attempts and verifies rollback when postcondition observation fails', async () => {
  const target = {
    platform: 'darwin', adapterId: 'zavora.test.ax.rollback', appId: 'com.example.Editor',
    operation: 'set_bound_document_value', windowId: 7, role: 'AXTextField', label: 'Body',
  }
  let value = 'original'
  let reads = 0
  const host = {
    ...fixedDesktop('darwin'),
    async getAppVersion() { return '1' },
    async runScript() { return { code: 1, stdout: '', stderr: 'not used' } },
    async getWindowAppId() { return target.appId },
    async findElements() {
      reads++
      if (reads === 2) throw new Error('injected postcondition read failure')
      return [{ role: target.role, label: target.label, value, bounds: { x: 0, y: 0, width: 1, height: 1 }, actions: [] }]
    },
    async setElementValue(_windowId, _role, _label, next) { value = next; return { set: true } },
  }
  const probe = await new SemanticValueAdapter(host, target).probe(target.appId, '1')
  assert.equal(probe.supported, false)
  assert.equal(probe.evidence.postconditionSatisfied, false)
  assert.equal(probe.evidence.rollbackSucceeded, true)
  assert.equal(value, 'original')
})

test('host-certified trace is observable over MCP and required by explicit background preview', async () => {
  const registry = new CapabilityRegistry()
  const adapter = {
    id: 'mcp-test', version: '1', platform: process.platform,
    supports: (appId, operation) => appId === 'app.safe' && operation === 'safe_operation',
    backend: () => 'applescript',
    contract: () => ({ tool: 'run_script', version: '1', bindingDigest: `sha256:${'4'.repeat(64)}`, description: 'MCP-bound test' }),
    getAppVersion: async () => '1.0',
    matchesAction: (_appId, _operation, args) => args.script === 'canonical',
    probe: async () => ({
      supported: true, interference: 'none', focusChanged: false,
      physicalInputInjected: false, pointerMoved: false,
      evidence: {
        frontmostAppBefore: 'app.user', frontmostAppAfter: 'app.user',
        pointerBefore: { x: 1, y: 2 }, pointerAfter: { x: 1, y: 2 },
        quietPeriodSatisfied: true, executionSucceeded: true,
        postconditionSatisfied: true, rollbackSucceeded: true,
      },
    }),
  }
  const certification = new CapabilityCertificationService(registry, [adapter])
  const capability = await certification.certify({
    appId: 'app.safe', operation: 'safe_operation', expectedAppVersion: '1.0', ttlMs: 60_000,
  })
  const runtime = new RuntimeCoordinator({
    capabilities: registry,
    policy: async () => ({ decision: 'allow', policyDigest: 'allow', reasons: [] }),
    execute: async () => ({ content: [] }),
  })
  const session = { async dispatch() { return { content: [] } } }
  const client = await connectInProcess(createComputerUseServer({
    session, runtime, certificationService: certification,
    enableV8: true, profile: 'full', activeProfile: 'v8-safe', principalId: 'owner',
  }))
  try {
    const schema = JSON.parse(await readFile(
      new URL('../contracts/v8/capability-certification-trace.schema.json', import.meta.url), 'utf8',
    ))
    const manifest = JSON.parse(await readFile(new URL('../contracts/v8/manifest.json', import.meta.url), 'utf8'))
    const publicTrace = JSON.parse(await readFile(
      new URL('../docs/conformance/v8/macos-finder-comment-26.2.json', import.meta.url), 'utf8',
    ))
    assert.equal(schema.$defs.digest.pattern, '^sha256:[a-f0-9]{64}$')
    assert.equal(schema.$defs.evidence.additionalProperties, false)
    assert.ok(manifest.fixtures.includes('capability-certification-trace.schema.json'))
    assert.equal(verifyCertificationTrace(publicTrace), true)
    assert.ok(Date.parse(publicTrace.capability.certification.validUntil) < Date.now())

    const tools = await client.listTools()
    assert.equal(tools.some(tool => tool.name === 'certify_execution_capability'), false)
    assert.ok(tools.some(tool => tool.name === 'get_certification_trace'))
    const traceResult = await client.getCertificationTrace(capability.certification.certificationId)
    assert.equal(traceResult.structuredContent.trace.traceDigest, capability.certification.traceDigest)

    const target = {
      platform: process.platform, appId: 'app.safe', observationId: 'obs',
      confidence: 1, capturedAt: new Date().toISOString(),
    }
    const labelOnly = await client.previewAction({
      sessionId: 'session', actionId: 'label', tool: 'run_script', operation: 'safe_operation',
      arguments: { script: 'canonical' }, mode: 'background', target,
    })
    assert.equal(labelOnly.structuredContent.blocker, 'foreground_required')
    const bound = await client.previewAction({
      sessionId: 'session', actionId: 'bound', tool: 'run_script', operation: 'safe_operation',
      certificationId: capability.certification.certificationId,
      arguments: { script: 'canonical' }, mode: 'background', target,
    })
    assert.equal(bound.structuredContent.executable, true)
    assert.equal(bound.structuredContent.capability.certification.traceDigest, capability.certification.traceDigest)
  } finally {
    runtime.dispose()
    await client.close()
  }
})
