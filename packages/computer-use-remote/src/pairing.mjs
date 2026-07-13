import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

const DEFAULT_SCOPES = new Set([
  'computer:observe', 'computer:screenshot', 'computer:control',
  'computer:execute', 'computer:approve',
])

function hash(value) {
  return createHash('sha256').update(value).digest()
}

function equalHash(left, right) {
  return left.length === right.length && timingSafeEqual(left, right)
}

function stateDigest(state) {
  return `sha256:${createHash('sha256').update(JSON.stringify(state)).digest('hex')}`
}

function vaultRead(vault, key) {
  const read = vault.get(key)
  if (read && typeof read.then === 'function') {
    throw new TypeError('credential vault get must be synchronous and durable')
  }
  if (read !== undefined && read !== null && typeof read !== 'string') {
    throw new TypeError('credential vault get must return a string, null, or undefined')
  }
  return read ? JSON.parse(read) : undefined
}

function vaultWrite(vault, key, value) {
  const result = vault.set(key, JSON.stringify(value))
  if (result && typeof result.then === 'function') {
    throw new TypeError('credential vault set must be synchronous and durable')
  }
}

function requiredString(value, name, maximum = 256) {
  if (typeof value !== 'string' || !value || value.length > maximum) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maximum} characters`)
  }
  return value
}

export class PairingError extends Error {
  constructor(code, message = code) {
    super(message)
    this.name = 'PairingError'
    this.code = code
  }
}

/** Opaque OAuth-compatible bearer tokens with explicit, nonce-bound pairing. */
export class PairingAuthority {
  #requests = new Map()
  #devices = new Map()
  #tokens = new Map()
  #listeners = new Set()

  constructor(options = {}) {
    this.now = options.now ?? (() => Date.now())
    this.pairingTtlMs = options.pairingTtlMs ?? 5 * 60_000
    this.tokenTtlMs = options.tokenTtlMs ?? 24 * 60 * 60_000
    this.allowedScopes = new Set(options.allowedScopes ?? DEFAULT_SCOPES)
    this.onStateChanged = options.onStateChanged ?? (() => {})
    if (this.pairingTtlMs < 30_000 || this.pairingTtlMs > 15 * 60_000) {
      throw new RangeError('pairingTtlMs must be between 30000 and 900000')
    }
    if (this.tokenTtlMs < 60_000 || this.tokenTtlMs > 30 * 24 * 60 * 60_000) {
      throw new RangeError('tokenTtlMs must be between 60000 and 2592000000')
    }
    if (options.state !== undefined) this.#restore(options.state)
  }

  requestPairing(input) {
    const clientNonce = requiredString(input.clientNonce, 'clientNonce', 512)
    if (Buffer.byteLength(clientNonce) < 32) throw new TypeError('clientNonce must contain at least 32 bytes')
    const deviceName = requiredString(input.deviceName, 'deviceName', 128)
    const requestedScopes = [...new Set(input.requestedScopes ?? ['computer:observe'])]
    if (!requestedScopes.length || requestedScopes.some(scope => !this.allowedScopes.has(scope))) {
      throw new PairingError('invalid_scope')
    }
    const requestId = randomUUID()
    const code = String(randomBytes(4).readUInt32BE() % 100_000_000).padStart(8, '0')
    const createdAt = this.now()
    this.#requests.set(requestId, {
      requestId, deviceName, requestedScopes, nonceHash: hash(clientNonce), codeHash: hash(code),
      createdAt, expiresAt: createdAt + this.pairingTtlMs, confirmed: false, attempts: 0,
    })
    return {
      requestId, code, deviceName, requestedScopes, expiresAt: createdAt + this.pairingTtlMs,
      pairingUri: `computer-use://pair?request_id=${encodeURIComponent(requestId)}&code=${encodeURIComponent(code)}`,
    }
  }

  confirmPairing(requestId, input) {
    const request = this.#activeRequest(requestId)
    const principalId = requiredString(input.principalId, 'principalId')
    const scopes = [...new Set(input.scopes ?? request.requestedScopes)]
    if (!scopes.length || scopes.some(scope => !request.requestedScopes.includes(scope))) {
      throw new PairingError('invalid_scope')
    }
    request.confirmed = true
    request.principalId = principalId
    request.scopes = scopes
    request.confirmedAt = this.now()
    return { requestId, principalId, scopes, confirmedAt: request.confirmedAt }
  }

  claimPairing(input) {
    const request = this.#activeRequest(input.requestId)
    request.attempts += 1
    if (request.attempts > 5) {
      this.#requests.delete(request.requestId)
      throw new PairingError('pairing_locked')
    }
    const code = requiredString(input.code, 'code', 32)
    const nonce = requiredString(input.clientNonce, 'clientNonce', 512)
    if (!request.confirmed || !equalHash(request.codeHash, hash(code))
        || !equalHash(request.nonceHash, hash(nonce))) {
      throw new PairingError('invalid_pairing_claim')
    }
    this.#requests.delete(request.requestId)
    return this.#issue({
      deviceId: randomUUID(), deviceName: request.deviceName,
      principalId: request.principalId, scopes: request.scopes,
    })
  }

  async verifyAccessToken(token) {
    if (typeof token !== 'string' || token.length < 32) throw new PairingError('invalid_token')
    const tokenKey = hash(token).toString('hex')
    const record = this.#tokens.get(tokenKey)
    if (!record || record.expiresAt <= this.now()) {
      if (record) this.revokeDevice(record.deviceId, 'token_expired')
      throw new PairingError('invalid_token')
    }
    const device = this.#devices.get(record.deviceId)
    if (!device || device.revokedAt || device.authContextId !== record.authContextId) {
      throw new PairingError('invalid_token')
    }
    device.lastSeenAt = this.now()
    return {
      token,
      clientId: device.deviceId,
      scopes: [...device.scopes],
      expiresAt: Math.floor(record.expiresAt / 1000),
      extra: {
        sub: device.principalId,
        principalId: device.principalId,
        deviceId: device.deviceId,
        authContextId: device.authContextId,
      },
    }
  }

  listDevices(principalId) {
    return [...this.#devices.values()]
      .filter(device => !principalId || device.principalId === principalId)
      .map(({ tokenKey: _tokenKey, ...device }) => structuredClone(device))
  }

  /** Persistence snapshot contains token hashes, never bearer-token bytes. */
  exportState() {
    return {
      schemaVersion: 1,
      devices: [...this.#devices.values()].map(device => structuredClone(device)),
    }
  }

  rotateDevice(deviceId) {
    const current = this.#devices.get(deviceId)
    if (!current || current.revokedAt) throw new PairingError('unknown_device')
    this.#tokens.delete(current.tokenKey)
    current.revokedAt = this.now()
    this.onStateChanged(this.exportState())
    this.#notify({ ...current }, 'token_rotated')
    return this.#issue({
      deviceId: current.deviceId, deviceName: current.deviceName,
      principalId: current.principalId, scopes: current.scopes,
    })
  }

  revokeDevice(deviceId, reason = 'device_revoked') {
    const device = this.#devices.get(deviceId)
    if (!device || device.revokedAt) return false
    device.revokedAt = this.now()
    this.#tokens.delete(device.tokenKey)
    this.onStateChanged(this.exportState())
    this.#notify({ ...device }, reason)
    return true
  }

  subscribeRevocations(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #activeRequest(requestId) {
    const request = this.#requests.get(requestId)
    if (!request || request.expiresAt <= this.now()) {
      if (request) this.#requests.delete(requestId)
      throw new PairingError('unknown_or_expired_pairing')
    }
    return request
  }

  #issue(input) {
    const token = randomBytes(32).toString('base64url')
    const tokenKey = hash(token).toString('hex')
    const issuedAt = this.now()
    const authContextId = randomUUID()
    const device = {
      deviceId: input.deviceId, deviceName: input.deviceName, principalId: input.principalId,
      scopes: [...input.scopes], authContextId, issuedAt, lastSeenAt: issuedAt,
      expiresAt: issuedAt + this.tokenTtlMs, tokenKey,
    }
    this.#devices.set(device.deviceId, device)
    this.#tokens.set(tokenKey, {
      deviceId: device.deviceId, authContextId, expiresAt: device.expiresAt,
    })
    this.onStateChanged(this.exportState())
    return {
      access_token: token, token_type: 'Bearer', expires_in: Math.floor(this.tokenTtlMs / 1000),
      scope: device.scopes.join(' '), device: this.listDevices().find(value => value.deviceId === device.deviceId),
    }
  }

  #notify(device, reason) {
    for (const listener of this.#listeners) listener({
      deviceId: device.deviceId, principalId: device.principalId,
      authContextId: device.authContextId, reason,
    })
  }

  #restore(state) {
    if (!state || state.schemaVersion !== 1 || !Array.isArray(state.devices)) {
      throw new PairingError('invalid_pairing_state')
    }
    for (const input of state.devices) {
      if (!input || typeof input !== 'object'
          || typeof input.deviceId !== 'string' || typeof input.principalId !== 'string'
          || typeof input.authContextId !== 'string' || typeof input.tokenKey !== 'string'
          || !Array.isArray(input.scopes) || input.scopes.some(scope => !this.allowedScopes.has(scope))) {
        throw new PairingError('invalid_pairing_state')
      }
      const device = structuredClone(input)
      this.#devices.set(device.deviceId, device)
      if (!device.revokedAt && device.expiresAt > this.now()) {
        this.#tokens.set(device.tokenKey, {
          deviceId: device.deviceId, authContextId: device.authContextId, expiresAt: device.expiresAt,
        })
      }
    }
  }
}

/** Permission-restricted, atomically replaced durable device authorization. */
export function createFilePairingAuthority(path, options = {}) {
  if (typeof path !== 'string' || !path) throw new TypeError('pairing authority path is required')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
  const persist = next => {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(next), 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
    chmodSync(path, 0o600)
    try {
      const directory = openSync(dirname(path), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    } catch { /* directory fsync is unavailable on some Windows filesystems */ }
  }
  return new PairingAuthority({ ...options, ...(state ? { state } : {}), onStateChanged: persist })
}

/**
 * Persist device authorization metadata through a host-owned OS credential
 * vault. Vault methods must be synchronous: issuing or rotating a bearer token
 * cannot be acknowledged before the durable authorization record is written.
 * Stored bytes contain token hashes only, never the bearer token.
 */
export function createVaultPairingAuthority(vault, options = {}) {
  if (!vault || typeof vault.get !== 'function' || typeof vault.set !== 'function') {
    throw new TypeError('credential vault must provide synchronous get(key) and set(key, value) methods')
  }
  const key = requiredString(options.key ?? 'computer-use-remote/device-authorizations', 'credential vault key', 512)
  const anchorKey = `${key}/rollback-anchor`
  if (anchorKey.length > 512) throw new TypeError('credential vault key is too long for rollback protection')
  let stored = vaultRead(vault, key)
  let anchor = vaultRead(vault, anchorKey)
  const emptyState = { schemaVersion: 1, devices: [] }
  let state
  let revision
  let digest

  if (stored?.schemaVersion === 1 && Array.isArray(stored.devices)) {
    // In-place migration from the original unanchored record. Committing both
    // records before authority construction prevents issuing against a state
    // whose rollback baseline was never durably established.
    state = stored
    revision = 0
    digest = stateDigest(state)
    stored = { schemaVersion: 2, revision, previousDigest: null, stateDigest: digest, state }
    anchor = { schemaVersion: 1, revision, stateDigest: digest }
    vaultWrite(vault, key, stored)
    vaultWrite(vault, anchorKey, anchor)
  } else if (stored === undefined && anchor === undefined) {
    state = emptyState
    revision = 0
    digest = stateDigest(state)
    anchor = { schemaVersion: 1, revision, stateDigest: digest }
    vaultWrite(vault, anchorKey, anchor)
  } else if (stored === undefined) {
    if (anchor?.schemaVersion !== 1 || anchor.revision !== 0
      || anchor.stateDigest !== stateDigest(emptyState)) {
      throw new PairingError('pairing_state_rollback_detected')
    }
    state = emptyState
    revision = 0
    digest = anchor.stateDigest
  } else {
    if (stored?.schemaVersion !== 2 || !Number.isSafeInteger(stored.revision) || stored.revision < 0
      || typeof stored.stateDigest !== 'string' || !stored.state
      || stored.stateDigest !== stateDigest(stored.state)
      || anchor?.schemaVersion !== 1 || !Number.isSafeInteger(anchor.revision)
      || typeof anchor.stateDigest !== 'string') {
      throw new PairingError('invalid_pairing_state')
    }
    if (stored.revision === anchor.revision && stored.stateDigest === anchor.stateDigest) {
      // Fully committed state.
    } else if (stored.revision === anchor.revision + 1
      && stored.previousDigest === anchor.stateDigest) {
      // The state record committed but the process stopped before advancing its
      // high-water anchor. Forward recovery is safe and never restores authority.
      anchor = { schemaVersion: 1, revision: stored.revision, stateDigest: stored.stateDigest }
      vaultWrite(vault, anchorKey, anchor)
    } else {
      throw new PairingError('pairing_state_rollback_detected')
    }
    state = stored.state
    revision = stored.revision
    digest = stored.stateDigest
  }
  const persist = next => {
    const nextDigest = stateDigest(next)
    const nextRevision = revision + 1
    vaultWrite(vault, key, {
      schemaVersion: 2, revision: nextRevision,
      previousDigest: digest, stateDigest: nextDigest, state: next,
    })
    vaultWrite(vault, anchorKey, {
      schemaVersion: 1, revision: nextRevision, stateDigest: nextDigest,
    })
    revision = nextRevision
    digest = nextDigest
  }
  const { key: _key, ...authorityOptions } = options
  return new PairingAuthority({
    ...authorityOptions,
    ...(state ? { state } : {}),
    onStateChanged: persist,
  })
}
