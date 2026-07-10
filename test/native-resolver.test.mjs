// PR-15: native binary dual resolver — env override → optional package → legacy.

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { resolveAddonPath } from '../dist/native.js'

function withNativePath(value, fn) {
  const prev = process.env.COMPUTER_USE_NATIVE_PATH
  if (value === undefined) delete process.env.COMPUTER_USE_NATIVE_PATH
  else process.env.COMPUTER_USE_NATIVE_PATH = value
  try { return fn() } finally {
    if (prev === undefined) delete process.env.COMPUTER_USE_NATIVE_PATH
    else process.env.COMPUTER_USE_NATIVE_PATH = prev
  }
}

test('resolves an existing native binary with clean env (legacy fallthrough)', () => {
  withNativePath(undefined, () => {
    const p = resolveAddonPath()
    assert.ok(existsSync(p), `resolved path should exist: ${p}`)
    assert.match(basename(p), /^computer-use-napi\.(node|darwin-|win32-|linux-)/, `unexpected binary name: ${basename(p)}`)
  })
})

test('COMPUTER_USE_NATIVE_PATH override wins when the file exists', () => {
  const real = withNativePath(undefined, () => resolveAddonPath())
  withNativePath(real, () => {
    assert.equal(resolveAddonPath(), real, 'explicit override should be returned verbatim')
  })
})

test('a non-existent override falls through to a real binary (does not return the bad path or throw)', () => {
  const bad = '/definitely/not/here/computer-use-napi.node'
  withNativePath(bad, () => {
    const p = resolveAddonPath()
    assert.notEqual(p, bad, 'must not return a non-existent override path')
    assert.ok(existsSync(p), 'must fall through to an existing binary')
  })
})
