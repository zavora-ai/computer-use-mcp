import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, chmod, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

test('extracted legacy audit drops sensitive values entirely instead of retaining a reversible digest', () => {
  const policy = runtime()
  const redacted = policy.redactAuditValue('args', {
    text: 'erase-me', nested: { approval_token: 'secret-token' }, coordinate: [1, 2],
  })
  const serialized = JSON.stringify(redacted)
  assert.doesNotMatch(serialized, /erase-me|secret-token/)
  // An unsalted digest of a low-entropy value (PIN, short password) is brute-forceable,
  // so redaction must not retain a digest or the plaintext length.
  assert.doesNotMatch(serialized, /sha256|length/)
  assert.equal(redacted.text.redacted, true)
  assert.equal(redacted.nested.approval_token.redacted, true)
  assert.deepEqual(redacted.coordinate, [1, 2])
})

test('audit text digests are keyed per runtime so equal plaintexts are not correlatable across sessions', () => {
  const first = runtime().digestText('same-plaintext')
  const second = runtime().digestText('same-plaintext')
  assert.notEqual(first, second)
  assert.match(first, /^[0-9a-f]{64}$/)
})

test('run_script requires approval only when the script names a sensitive application', () => {
  const policy = runtime()
  // Default posture: the scripting-first workflow stays usable.
  assert.equal(policy.evaluate('run_script', {
    language: 'applescript', script: 'tell application "Finder" to get name of home',
  }, true).approval, 'not_required')
  // run_script takes no target argument, so the sensitive-app rule has to read the body.
  const keychain = policy.evaluate('run_script', {
    language: 'applescript', script: 'tell application "Keychain Access" to activate',
  }, true)
  assert.equal(keychain.approval, 'required')
  assert.deepEqual(keychain.reasons, ['script_targets_sensitive_app:com.apple.keychainaccess'])
  // Display name, bundle ID and case/spacing variants all resolve to the same app.
  for (const script of ['tell app "1Password" to activate', 'com.1password.1password', 'keychainACCESS']) {
    assert.equal(policy.evaluate('run_script', { language: 'applescript', script }, true).approval,
      'required', `expected approval for: ${script}`)
  }
})

test('run_script cannot reach an app that COMPUTER_USE_BLOCKED_APPS forbids', () => {
  const policy = runtime({ env: { COMPUTER_USE_BLOCKED_APPS: 'com.apple.Terminal' } })
  const denied = policy.evaluate('run_script', {
    language: 'applescript', script: 'tell application "Terminal" to do script "id"',
  }, true)
  assert.equal(denied.approval, 'denied')
  assert.deepEqual(denied.reasons, ['script_targets_blocked_app:com.apple.Terminal'])
  assert.equal(policy.evaluate('run_script', {
    language: 'applescript', script: 'return 1 + 1',
  }, true).approval, 'not_required')
})

test('an allowlist makes run_script scope unverifiable, so it requires approval', () => {
  // A script can address any app, so allowlist membership cannot be proven the
  // way it can for a target_app argument. Fail closed rather than pretend.
  const policy = runtime({ env: { COMPUTER_USE_ALLOWED_APPS: 'com.apple.Finder' } })
  const decision = policy.evaluate('run_script', {
    language: 'applescript', script: 'tell application "Finder" to get name of home',
  }, true)
  assert.equal(decision.approval, 'required')
  assert.deepEqual(decision.reasons, ['script_scope_unverifiable'])
})

test('approval tokens of differing length are rejected without a raw string comparison', () => {
  const policy = runtime({ env: { COMPUTER_USE_APPROVAL_TOKEN: 'private-token', COMPUTER_USE_REQUIRE_APPROVAL: 'true' } })
  assert.equal(policy.evaluate('type', { approval_token: 'private' }, true).approval, 'required')
  assert.equal(policy.evaluate('type', { approval_token: 'private-token!' }, true).approval, 'required')
  assert.equal(policy.evaluate('type', { approval_token: 12345 }, true).approval, 'required')
  assert.equal(policy.evaluate('type', { approval_token: 'private-token' }, true).approval, 'approved')
})

test('an explicitly empty COMPUTER_USE_CREDENTIAL_APPS clears the built-in sensitive list', () => {
  const policy = runtime({ env: { COMPUTER_USE_CREDENTIAL_APPS: '' } })
  assert.deepEqual(policy.policyConfig.sensitiveApps, [])
  assert.equal(policy.evaluate('run_script', {
    language: 'applescript', script: 'tell application "Keychain Access" to activate',
  }, true).approval, 'not_required')
})

// Windows has no POSIX permission bits: fs.chmod there only toggles read-only, and
// stat reports 0o666 regardless. The narrowing is a POSIX behaviour, so only its
// mode assertions are skipped — the append itself is checked everywhere.
const posixOnly = { skip: process.platform === 'win32' && 'POSIX permission bits' }

test('the default audit log is narrowed to owner-only even when an older version left it readable', posixOnly, async () => {
  const home = await mkdtemp(join(tmpdir(), 'computer-use-audit-perms-'))
  try {
    const directory = join(home, '.computer-use-mcp')
    const auditLog = join(directory, 'audit.jsonl')
    // Reproduce an upgrade: the log already exists with the permissive bits that
    // earlier versions created, so `mode` at creation time cannot fix it.
    await mkdir(directory, { recursive: true, mode: 0o755 })
    await writeFile(auditLog, '{"tool":"legacy"}\n', { mode: 0o644 })
    await chmod(directory, 0o755)
    await chmod(auditLog, 0o644)

    runtime({ homeDirectory: home, nativeInjected: false }).writeAudit({ tool: 'type' })

    assert.equal((await stat(auditLog)).mode & 0o777, 0o600)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.match(await readFile(auditLog, 'utf8'), /"tool":"legacy"[\s\S]*"tool":"type"/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the default audit log is appended to on every platform', async () => {
  const home = await mkdtemp(join(tmpdir(), 'computer-use-audit-append-'))
  try {
    const auditLog = join(home, '.computer-use-mcp', 'audit.jsonl')
    const policy = runtime({ homeDirectory: home, nativeInjected: false })
    policy.writeAudit({ tool: 'first' })
    policy.writeAudit({ tool: 'second' })
    assert.match(await readFile(auditLog, 'utf8'), /"tool":"first"[\s\S]*"tool":"second"/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an explicitly configured audit path keeps the permissions the operator chose', posixOnly, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'computer-use-audit-explicit-'))
  const auditLog = join(directory, 'audit.jsonl')
  try {
    await writeFile(auditLog, '', { mode: 0o644 })
    await chmod(auditLog, 0o644)
    runtime({ env: { COMPUTER_USE_AUDIT_LOG: auditLog } }).writeAudit({ tool: 'type' })
    assert.equal((await stat(auditLog)).mode & 0o777, 0o644)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
    assert.match(persisted, /"tool":"type"/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
