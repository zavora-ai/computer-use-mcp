import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLegacyPolicyRuntime } from '../dist/session/legacy-policy.js'

function runtime(overrides = {}) {
  return createLegacyPolicyRuntime({
    activeProfile: 'full', nativeInjected: true, isWindows: false,
    hasElicitation: false, targetApp: args => args.target_app,
    env: {}, homeDirectory: '/tmp', ...overrides,
  })
}

test('extracted legacy policy preserves app boundaries, destructive classification, and token approval', () => {
  const policy = runtime({
    env: {
      COMPUTER_USE_ALLOWED_APPS: 'app.allowed',
      COMPUTER_USE_BLOCKED_APPS: 'app.blocked',
      COMPUTER_USE_DESTRUCTIVE_REQUIRES_APPROVAL: 'true',
      COMPUTER_USE_APPROVAL_TOKEN: 'private-token',
    },
  })
  assert.equal(policy.evaluate('type', { target_app: 'app.blocked' }, true).approval, 'denied')
  assert.equal(policy.evaluate('type', { target_app: 'app.other' }, true).approval, 'denied')
  const pending = policy.evaluate('filesystem', {
    mode: 'delete', target_app: 'app.allowed',
  }, true)
  assert.equal(pending.approval, 'required')
  const approved = policy.evaluate('filesystem', {
    mode: 'delete', target_app: 'app.allowed', approval_token: 'private-token',
  }, true)
  assert.equal(approved.approval, 'approved')
  assert.equal(approved.destructive, true)
  assert.equal(policy.evaluate('filesystem', {
    mode: 'copy', target_app: 'app.allowed', path: '/a', destination: '/b',
  }, true).approval, 'required')
})

test('extracted legacy audit recursively hashes sensitive values without retaining bytes', () => {
  const policy = runtime()
  const redacted = policy.redactAuditValue('args', {
    text: 'erase-me', nested: { approval_token: 'secret-token' }, coordinate: [1, 2],
  })
  const serialized = JSON.stringify(redacted)
  assert.doesNotMatch(serialized, /erase-me|secret-token/)
  assert.match(serialized, /sha256|coordinate/)
})

test('extracted legacy audit persists only caller-redacted records to an explicit destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-legacy-audit-'))
  const auditLog = join(directory, 'audit.jsonl')
  try {
    const policy = runtime({ env: { COMPUTER_USE_AUDIT_LOG: auditLog } })
    policy.writeAudit({
      tool: 'type', args: policy.redactAuditValue('args', { text: 'private-input' }),
    })
    const persisted = await readFile(auditLog, 'utf8')
    assert.doesNotMatch(persisted, /private-input/)
    assert.match(persisted, /"tool":"type"|sha256/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
