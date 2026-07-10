// PR-11b: COMPUTER_USE_FS_ROOTS filesystem jail — unit + integration coverage.

import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fsRootsViolation, resolveForJail, fsRoots } from '../dist/session/fs-jail.js'
import { createSession } from '../dist/session.js'

function withRoots(roots, fn) {
  const prev = process.env.COMPUTER_USE_FS_ROOTS
  if (roots === undefined) delete process.env.COMPUTER_USE_FS_ROOTS
  else process.env.COMPUTER_USE_FS_ROOTS = roots
  try { return fn() } finally {
    if (prev === undefined) delete process.env.COMPUTER_USE_FS_ROOTS
    else process.env.COMPUTER_USE_FS_ROOTS = prev
  }
}

// Async-aware: restores env only after the async callback fully resolves,
// so multi-await bodies (multiple dispatches) keep the jail configured.
async function withRootsAsync(roots, fn) {
  const prev = process.env.COMPUTER_USE_FS_ROOTS
  if (roots === undefined) delete process.env.COMPUTER_USE_FS_ROOTS
  else process.env.COMPUTER_USE_FS_ROOTS = roots
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.COMPUTER_USE_FS_ROOTS
    else process.env.COMPUTER_USE_FS_ROOTS = prev
  }
}

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cu-jail-')))
}

// ── Unit: jail disabled ──────────────────────────────────────────────────

test('jail disabled when COMPUTER_USE_FS_ROOTS unset → no violation', () => {
  withRoots(undefined, () => {
    assert.equal(fsRoots().length, 0)
    assert.equal(fsRootsViolation('/etc/passwd'), null)
    assert.equal(fsRootsViolation('/anywhere/at/all'), null)
  })
})

// ── Unit: containment ────────────────────────────────────────────────────

test('path inside a configured root is allowed', () => {
  const root = tmpDir()
  try {
    withRoots(root, () => {
      assert.equal(fsRootsViolation(path.join(root, 'a', 'b.txt')), null)
      assert.equal(fsRootsViolation(root), null)
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('path outside all roots is denied', () => {
  const root = tmpDir()
  const outside = tmpDir()
  try {
    withRoots(root, () => {
      const v = fsRootsViolation(path.join(outside, 'secret.txt'))
      assert.ok(v, 'expected a violation')
      assert.equal(v.error, 'fs_root_denied')
      assert.ok(v.roots.includes(root))
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) }
})

test('.. traversal that escapes the root is denied (normalized in resolved)', () => {
  const root = tmpDir()
  try {
    withRoots(root, () => {
      const escaping = path.join(root, '..', '..', 'etc', 'passwd')
      const v = fsRootsViolation(escaping)
      assert.ok(v, 'traversal escape must be denied')
      assert.ok(!v.resolved.includes('..'), 'resolved path is normalized')
      assert.ok(!v.resolved.startsWith(root + path.sep) && v.resolved !== root, 'resolved is outside root')
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('.. traversal that stays inside the root is allowed', () => {
  const root = tmpDir()
  try {
    fs.mkdirSync(path.join(root, 'sub'))
    withRoots(root, () => {
      // root/sub/../keep.txt === root/keep.txt (inside)
      assert.equal(fsRootsViolation(path.join(root, 'sub', '..', 'keep.txt')), null)
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('non-existent write target inside root is allowed; outside is denied', () => {
  const root = tmpDir()
  const outside = tmpDir()
  try {
    withRoots(root, () => {
      assert.equal(fsRootsViolation(path.join(root, 'does', 'not', 'exist', 'yet.txt')), null)
      assert.ok(fsRootsViolation(path.join(outside, 'nope', 'x.txt')))
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) }
})

test('symlink escape is denied (realpath resolves through the link)', () => {
  const root = tmpDir()
  const outside = tmpDir()
  try {
    fs.writeFileSync(path.join(outside, 'target.txt'), 'secret')
    // A symlink inside the root that points to an outside directory.
    fs.symlinkSync(outside, path.join(root, 'link'))
    withRoots(root, () => {
      const through = path.join(root, 'link', 'target.txt')
      const resolved = resolveForJail(through)
      assert.ok(resolved.startsWith(outside), 'realpath should resolve the symlink to outside the root')
      const v = fsRootsViolation(through)
      assert.ok(v, 'symlink escape must be denied')
      assert.equal(v.error, 'fs_root_denied')
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) }
})

// ── Integration: filesystem tool via session.dispatch ────────────────────

test('filesystem write inside root succeeds; outside is denied (dispatch)', async () => {
  const root = tmpDir()
  const outside = tmpDir()
  try {
    await withRootsAsync(root, async () => {
      const session = createSession({ disableSessionLock: true })
      const okRes = await session.dispatch('filesystem', {
        mode: 'write', path: path.join(root, 'note.txt'), content: 'hi',
      })
      assert.ok(!okRes.isError, 'write inside root should succeed')
      assert.ok(fs.existsSync(path.join(root, 'note.txt')))

      const denied = await session.dispatch('filesystem', {
        mode: 'write', path: path.join(outside, 'evil.txt'), content: 'x',
      })
      assert.ok(denied.isError, 'write outside root must be denied')
      const body = JSON.parse(denied.content.find(c => c.type === 'text').text)
      assert.equal(body.error, 'fs_root_denied')
      assert.ok(!fs.existsSync(path.join(outside, 'evil.txt')), 'denied write must not create the file')
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) }
})

test('filesystem read with .. escape is denied (dispatch)', async () => {
  const root = tmpDir()
  try {
    await withRootsAsync(root, async () => {
      const session = createSession({ disableSessionLock: true })
      const r = await session.dispatch('filesystem', {
        mode: 'read', path: path.join(root, '..', '..', 'etc', 'hosts'),
      })
      assert.ok(r.isError, 'escaping read must be denied')
      assert.equal(JSON.parse(r.content.find(c => c.type === 'text').text).error, 'fs_root_denied')
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('filesystem unrestricted when COMPUTER_USE_FS_ROOTS unset (legacy, dispatch)', async () => {
  const root = tmpDir()
  try {
    await withRootsAsync(undefined, async () => {
      const session = createSession({ disableSessionLock: true })
      const r = await session.dispatch('filesystem', {
        mode: 'write', path: path.join(root, 'legacy.txt'), content: 'ok',
      })
      assert.ok(!r.isError, 'unset jail preserves legacy unrestricted behavior')
      assert.ok(fs.existsSync(path.join(root, 'legacy.txt')))
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
