#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { createFilePairingAuthority, createVaultPairingAuthority } from './pairing.mjs'
import { createOperatingSystemCredentialVault } from './os-vault.mjs'
import { RemoteSidecar } from './sidecar.mjs'

const adapterPath = process.env.COMPUTER_USE_REMOTE_HOST_MODULE
if (!adapterPath) throw new Error('COMPUTER_USE_REMOTE_HOST_MODULE is required; the sidecar never exposes a desktop runtime implicitly')
const adapter = await import(pathToFileURL(resolve(adapterPath)).href)
if (typeof adapter.createServer !== 'function' || typeof adapter.onAuthorizationLost !== 'function'
    || typeof adapter.onPairingRequested !== 'function') {
  throw new Error('host module must export createServer, onAuthorizationLost, and onPairingRequested')
}
const authStore = process.env.COMPUTER_USE_REMOTE_AUTH_STORE
const osVaultRequested = process.env.COMPUTER_USE_REMOTE_AUTH_VAULT === 'os'
if (!adapter.authority && !adapter.credentialVault && !osVaultRequested && !authStore) {
  throw new Error('COMPUTER_USE_REMOTE_AUTH_STORE, COMPUTER_USE_REMOTE_AUTH_VAULT=os, or host credentialVault is required unless the host adapter supplies an authority')
}
let native
if (osVaultRequested && process.platform === 'darwin') {
  try {
    native = (await import('@zavora-ai/computer-use-mcp/host-native')).loadNative()
  } catch (packageError) {
    try { native = (await import('../../../dist/native.js')).loadNative() } catch {
      throw new Error(`macOS OS-vault mode requires the computer-use host-native binding: ${packageError.message}`)
    }
  }
}
const credentialVault = adapter.credentialVault ?? (osVaultRequested
  ? createOperatingSystemCredentialVault({
      directory: process.env.COMPUTER_USE_REMOTE_AUTH_VAULT_DIR,
      native,
    })
  : undefined)
const authority = adapter.authority
  ?? (credentialVault
    ? createVaultPairingAuthority(credentialVault, {
        key: process.env.COMPUTER_USE_REMOTE_AUTH_VAULT_KEY
          ?? 'computer-use-remote/device-authorizations',
      })
    : createFilePairingAuthority(resolve(authStore)))
const tlsKey = process.env.COMPUTER_USE_REMOTE_TLS_KEY
const tlsCert = process.env.COMPUTER_USE_REMOTE_TLS_CERT
if (Boolean(tlsKey) !== Boolean(tlsCert)) throw new Error('both COMPUTER_USE_REMOTE_TLS_KEY and _TLS_CERT are required together')
const tls = tlsKey && tlsCert ? { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) } : undefined
const sidecar = new RemoteSidecar({
  host: process.env.COMPUTER_USE_REMOTE_HOST ?? '127.0.0.1',
  port: Number(process.env.COMPUTER_USE_REMOTE_PORT ?? 7331),
  authority,
  ...(tls ? { tls } : {}),
  allowLan: process.env.COMPUTER_USE_REMOTE_ALLOW_LAN === 'true',
  allowedOrigins: (process.env.COMPUTER_USE_REMOTE_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean),
  createServer: adapter.createServer,
  onAuthorizationLost: adapter.onAuthorizationLost,
  onPairingRequested: adapter.onPairingRequested,
  eventSource: adapter.eventSource,
})
const address = await sidecar.start()
process.stderr.write(`[computer-use-remote] listening on ${address.protocol}://${address.host}:${address.port}\n`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void sidecar.stop(signal).then(() => process.exit(0)))
