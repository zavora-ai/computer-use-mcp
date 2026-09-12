// Closing the check-then-use race on the filesystem boundary.
//
// Canonicalizing a path before the syscall narrows the window; it cannot close it. The
// name is resolved at one instant and the kernel resolves it again at another, and for a
// write target that does not exist yet the tail cannot be canonicalized at all — a
// component created as a symlink in between is followed. `openWithinRoots` answers a
// different question: this descriptor, whatever happened to names, refers to this file,
// and here is whether that file is inside the boundary.

import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { openWithinRoots } from '../dist/session/fs-jail.js'

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jail-root-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jail-out-'))
  process.env.COMPUTER_USE_FS_ROOTS = root
  return { root, outside }
}

const WRITE = fs.constants.O_WRONLY | fs.constants.O_CREAT

test('a write inside the roots is allowed, and its identity is verified', () => {
  const { root } = sandbox()
  const target = path.join(root, 'real.txt')
  const opened = openWithinRoots(target, WRITE, undefined, 0o600)
  assert.equal(opened.violation, null)
  assert.equal(opened.verified, true, 'the descriptor must be confirmed, not merely opened')
  fs.writeFileSync(opened.fd, 'hello')
  fs.closeSync(opened.fd)
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello')
})

test('a symlink as the final component cannot redirect a write out of the roots', () => {
  // The case canonicalizing cannot see when the target does not exist yet.
  const { root, outside } = sandbox()
  const escape = path.join(outside, 'stolen.txt')
  fs.symlinkSync(escape, path.join(root, 'notes.txt'))
  const opened = openWithinRoots(path.join(root, 'notes.txt'), WRITE, undefined, 0o600)
  assert.ok(opened.violation, 'must be refused')
  assert.equal(fs.existsSync(escape), false, 'and nothing may be created outside')
})

test('a parent directory replaced by a symlink cannot redirect a write', () => {
  const { root, outside } = sandbox()
  fs.symlinkSync(outside, path.join(root, 'sub'))
  const opened = openWithinRoots(path.join(root, 'sub', 'x.txt'), WRITE, undefined, 0o600)
  assert.ok(opened.violation, 'must be refused')
  assert.equal(fs.existsSync(path.join(outside, 'x.txt')), false)
})

test('a path plainly outside the roots is refused', () => {
  const { outside } = sandbox()
  const opened = openWithinRoots(path.join(outside, 'direct.txt'), WRITE, undefined, 0o600)
  assert.ok(opened.violation)
})

test('the refusal says what happened, so an operator can tell it from an I/O fault', () => {
  const { root, outside } = sandbox()
  fs.symlinkSync(path.join(outside, 's.txt'), path.join(root, 'l.txt'))
  const opened = openWithinRoots(path.join(root, 'l.txt'), WRITE, undefined, 0o600)
  assert.match(opened.violation.message, /symbolic link|changed while/)
  assert.match(opened.violation.message, /roots/)
})

test('with no boundary configured, nothing is refused and deliberate symlinks still work', () => {
  // The jail is opt-in. Refusing a symlink when no boundary is in force would be a
  // behaviour change for every caller who meant it.
  delete process.env.COMPUTER_USE_FS_ROOTS
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jail-off-'))
  const real = path.join(dir, 'real.txt')
  fs.writeFileSync(real, 'original')
  const link = path.join(dir, 'link.txt')
  fs.symlinkSync(real, link)
  const opened = openWithinRoots(link, WRITE, undefined, 0o600)
  assert.equal(opened.violation, null, 'a deliberate symlink must still be followed')
  assert.equal(opened.verified, false, 'and the stronger guarantee is honestly reported absent')
  fs.closeSync(opened.fd)
})
