import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const DEFAULT_SERVICE = 'ai.zavora.computer-use-remote'

function bounded(value, name, maximum = 512) {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new TypeError(`${name} must be a bounded single-line string`)
  }
  return value
}

function runCommand(run, command, args, input) {
  const result = run(command, args, {
    input, encoding: 'utf8', windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env },
  })
  if (!result || result.error) throw result?.error ?? new Error(`${command} did not return a result`)
  return {
    status: Number.isInteger(result.status) ? result.status : 1,
    stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? ''),
  }
}

function commandFailure(command, result) {
  const detail = result.stderr.trim().slice(0, 512)
  return new Error(`${command} credential vault failed with status ${result.status}${detail ? `: ${detail}` : ''}`)
}

export function createMacOSKeychainVault(options = {}) {
  const service = bounded(options.service ?? DEFAULT_SERVICE, 'Keychain service', 256)
  const native = options.native
  if (typeof native?.keychainGetGenericPassword !== 'function'
      || typeof native?.keychainSetGenericPassword !== 'function') {
    throw new Error('macOS Keychain vault requires the computer-use host-native binding')
  }
  return Object.freeze({
    backend: 'macos_keychain',
    get(key) {
      key = bounded(key, 'credential vault key')
      const value = native.keychainGetGenericPassword(service, key)
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new TypeError('native Keychain get returned an invalid value')
      }
      return value ?? undefined
    },
    set(key, value) {
      key = bounded(key, 'credential vault key')
      value = bounded(value, 'credential vault value', 8 * 1024 * 1024)
      native.keychainSetGenericPassword(service, key, value)
    },
  })
}

export function createLinuxSecretServiceVault(options = {}) {
  const run = options.run ?? spawnSync
  const service = bounded(options.service ?? DEFAULT_SERVICE, 'Secret Service name', 256)
  return Object.freeze({
    backend: 'linux_secret_service',
    get(key) {
      key = bounded(key, 'credential vault key')
      const result = runCommand(run, 'secret-tool', ['lookup', 'service', service, 'account', key])
      if (result.status === 1 && !result.stdout && !result.stderr) return undefined
      if (result.status !== 0) throw commandFailure('secret-tool', result)
      return result.stdout.replace(/\r?\n$/, '')
    },
    set(key, value) {
      key = bounded(key, 'credential vault key')
      value = bounded(value, 'credential vault value', 8 * 1024 * 1024)
      const result = runCommand(run, 'secret-tool', [
        'store', `--label=${options.label ?? 'Computer Use Remote authorization'}`,
        'service', service, 'account', key,
      ], `${value}\n`)
      if (result.status !== 0) throw commandFailure('secret-tool', result)
    },
  })
}

const PROTECT_SCRIPT = [
  '$ErrorActionPreference="Stop"',
  '$p=[Console]::In.ReadToEnd()|ConvertFrom-Json',
  '$d=[Convert]::FromBase64String($p.data)',
  '$e=[Convert]::FromBase64String($p.entropy)',
  '$o=[Security.Cryptography.ProtectedData]::Protect($d,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($o))',
].join(';')

const UNPROTECT_SCRIPT = [
  '$ErrorActionPreference="Stop"',
  '$p=[Console]::In.ReadToEnd()|ConvertFrom-Json',
  '$d=[Convert]::FromBase64String($p.data)',
  '$e=[Convert]::FromBase64String($p.entropy)',
  '$o=[Security.Cryptography.ProtectedData]::Unprotect($d,$e,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($o))',
].join(';')

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, value, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
  chmodSync(path, 0o600)
  try {
    const directory = openSync(dirname(path), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  } catch { /* Windows may not permit opening a directory for fsync. */ }
}

export function createWindowsDpapiVault(options = {}) {
  const run = options.run ?? spawnSync
  const executable = options.executable ?? 'powershell.exe'
  const service = bounded(options.service ?? DEFAULT_SERVICE, 'DPAPI service', 256)
  const directory = options.directory ?? join(
    process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'),
    'Zavora', 'computer-use-remote', 'vault',
  )
  return Object.freeze({
    backend: 'windows_dpapi_current_user',
    get(key) {
      key = bounded(key, 'credential vault key')
      const entropy = createHash('sha256').update(`${service}\0${key}`).digest('base64')
      const path = join(directory, `${createHash('sha256').update(`${service}\0${key}`).digest('hex')}.dpapi`)
      if (!existsSync(path)) return undefined
      const data = readFileSync(path, 'utf8')
      const result = runCommand(run, executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', UNPROTECT_SCRIPT,
      ], JSON.stringify({ data, entropy }))
      if (result.status !== 0) throw commandFailure(executable, result)
      return result.stdout
    },
    set(key, value) {
      key = bounded(key, 'credential vault key')
      value = bounded(value, 'credential vault value', 8 * 1024 * 1024)
      const entropy = createHash('sha256').update(`${service}\0${key}`).digest('base64')
      const path = join(directory, `${createHash('sha256').update(`${service}\0${key}`).digest('hex')}.dpapi`)
      const result = runCommand(run, executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROTECT_SCRIPT,
      ], JSON.stringify({ data: Buffer.from(value).toString('base64'), entropy }))
      if (result.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.stdout)) {
        throw commandFailure(executable, { ...result, status: result.status || 1 })
      }
      atomicWrite(path, result.stdout)
    },
  })
}

/** Explicit platform selection; unsupported platforms fail instead of falling back to plaintext. */
export function createOperatingSystemCredentialVault(options = {}) {
  const platform = options.platform ?? process.platform
  if (platform === 'darwin') return createMacOSKeychainVault(options)
  if (platform === 'win32') return createWindowsDpapiVault(options)
  if (platform === 'linux') return createLinuxSecretServiceVault(options)
  throw new Error(`no first-party credential vault for platform: ${platform}`)
}
