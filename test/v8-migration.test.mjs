import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  generateV8MigrationReport,
  renderV8MigrationShell,
  v8StartupWarnings,
} from '../dist/migration/v8.js'
import { createDefaultV8PolicyFromEnvironment } from '../dist/policy/engine.js'
import { classifyToolAction } from '../dist/runtime/action.js'
import { TOOL_CATALOG } from '../dist/tool-catalog.js'

function action(tool, args, dataLabels = ['public']) {
  const classification = classifyToolAction(tool, args, TOOL_CATALOG[tool])
  return {
    actionId: `migration-${tool}`,
    sessionId: 'migration-session',
    principalId: 'migration-principal',
    tool,
    operation: typeof args.mode === 'string' ? args.mode : tool,
    actionClass: classification.actionClass,
    requestedMode: 'background',
    resource: tool === 'filesystem' ? { filesystemPath: args.path }
      : tool === 'scrape' ? { browserDomain: new URL(args.url).hostname }
        : undefined,
    dataLabels,
    reversible: classification.reversible,
    externalSideEffect: classification.externalSideEffect,
    proposedAt: '2026-07-13T00:00:00.000Z',
    expiresAt: '2026-07-13T00:01:00.000Z',
    argsDigest: 'sha256:test',
  }
}

test('safer v8 defaults deny unrooted filesystem mutation and open-world scrape', () => {
  const evaluate = createDefaultV8PolicyFromEnvironment({})
  assert.equal(evaluate(action('filesystem', { mode: 'write', path: '/tmp/unsafe' })).decision, 'deny')
  assert.equal(evaluate(action('scrape', { url: 'https://example.com' })).decision, 'deny')
})

test('v7 compatibility restores only documented unsafe policy defaults', () => {
  const evaluate = createDefaultV8PolicyFromEnvironment({ COMPUTER_USE_V7_COMPAT: 'true' })
  assert.notEqual(evaluate(action('filesystem', { mode: 'write', path: '/tmp/legacy' })).decision, 'deny')
  assert.notEqual(evaluate(action('scrape', { url: 'https://example.com' })).decision, 'deny')

  const sensitive = evaluate(action('filesystem', {
    mode: 'write', path: '/tmp/legacy', content: 'secret',
  }, ['credential']))
  assert.notEqual(sensitive.decision, 'allow', 'compatibility cannot bypass sensitive-action confirmation')
})

test('migration report is exact, safer, disclosure-bounded, and shell-escaped', () => {
  const report = generateV8MigrationReport({
    COMPUTER_USE_V7_COMPAT: 'true',
    COMPUTER_USE_FS_ROOTS: "/safe/it's here",
    COMPUTER_USE_ALLOWED_APPS: 'com.example.safe',
    COMPUTER_USE_SUPERVISOR_TOKEN: 'must-not-appear',
    COMPUTER_USE_EVENT_JOURNAL: '/private/audit/path',
  })
  assert.equal(report.compatibilityMode, true)
  assert.equal(report.environment.COMPUTER_USE_V7_COMPAT, 'false')
  assert.equal(report.environment.COMPUTER_USE_V8_ALLOW_SCRAPE, 'false')
  assert.equal(report.environment.COMPUTER_USE_FS_ROOTS, "/safe/it's here")
  assert.equal(JSON.stringify(report).includes('must-not-appear'), false)
  assert.equal(JSON.stringify(report).includes('/private/audit/path'), false)
  assert.match(renderV8MigrationShell(report, 'posix'), /'"'"'/)
  assert.match(renderV8MigrationShell(report, 'powershell'), /it''s/)
})

test('startup warnings are value-free and emitted only for explicit compatibility', () => {
  assert.deepEqual(v8StartupWarnings({}), [])
  const warnings = v8StartupWarnings({
    COMPUTER_USE_V7_COMPAT: 'true',
    COMPUTER_USE_FS_ROOTS: '/sensitive/user/path',
  })
  assert.ok(warnings.length >= 2)
  assert.equal(warnings.join(' ').includes('/sensitive/user/path'), false)
  assert.match(warnings.at(-1), /computer-use-migrate-v8 --shell/)
})

test('packaged migration CLI prints JSON and POSIX or PowerShell configuration', () => {
  const cli = new URL('../dist/migration/cli.js', import.meta.url)
  for (const option of ['--json', '--shell', '--shell=powershell']) {
    const result = spawnSync(process.execPath, [cli.pathname, option], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, COMPUTER_USE_V7_COMPAT: 'true' },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.includes('COMPUTER_USE_V7_COMPAT'), true)
    assert.equal(result.stdout.includes('must-not-appear'), false)
  }
})
