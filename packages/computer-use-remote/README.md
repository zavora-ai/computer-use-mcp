# `@zavora-ai/computer-use-remote`

Optional authenticated remote sidecar for the computer-use-mcp v8 runtime.

It exposes MCP Streamable HTTP with secure stateful session IDs, bounded event
redelivery, opaque OAuth-compatible bearer tokens, per-authorization-context
session binding, origin/Host validation, rate limiting, and an optional
principal-filtered resumable SSE event projection at `/events?session_id=...`.
Pairing codes are
short-lived, nonce-bound, one-time, and useless until the local host explicitly
confirms the request.

The package never starts a listener when imported and never constructs a legacy
desktop dispatcher. The CLI requires `COMPUTER_USE_REMOTE_HOST_MODULE`, whose
module must export:

```js
export async function createServer({ principalId, authInfo }) {
  // Return a new principal-bound McpServer using v8-safe and
  // createRemoteToolAuthorizer(authInfo).
}

export async function onAuthorizationLost({ principalId, reason }) {
  await runtime.suspendPrincipal(principalId, reason)
}

export const eventSource = createRuntimeRemoteEventSource(runtime)
```

The host module may export a synchronous durable `credentialVault` with
`get(key)` and `set(key, value)` methods backed by macOS Keychain, Windows
Credential Manager/DPAPI, or Linux Secret Service. The CLI stores the
authorization record under `COMPUTER_USE_REMOTE_AUTH_VAULT_KEY` (default
`computer-use-remote/device-authorizations`). Vault methods must complete
durably before returning; Promise-returning adapters are rejected so a bearer
token is never acknowledged before its authorization record is committed.

Set `COMPUTER_USE_REMOTE_AUTH_VAULT=os` to use the packaged first-party backend:

- macOS: Security.framework generic-password records through the host-native addon;
- Windows: DPAPI `CurrentUser` protection plus an atomically replaced ciphertext file;
- Linux: Secret Service through `secret-tool`, with values supplied only on stdin.

The macOS and Windows implementations do not place authorization values in
process arguments or environment variables. Linux requires `secret-tool` and an
available, unlocked Secret Service collection; missing or locked services fail
closed. `COMPUTER_USE_REMOTE_AUTH_VAULT_DIR` optionally changes the Windows
ciphertext directory. OS-vault selection is explicit and never falls back to
the plaintext-metadata file store.

Vault-backed authority state uses a digest-bound monotonic revision and a
separate high-water anchor. Restart rejects stale or edited state and advances
the anchor only for the single linked state-first crash window. Existing v1
vault records migrate in place before token issuance. This detects partial
record rollback; a privileged platform backup or attacker that atomically
restores both the state and its same-vault anchor remains a platform-level
residual risk and still requires independent OS/backup hardening.

For headless/self-hosted deployments without a vault, the CLI requires
`COMPUTER_USE_REMOTE_AUTH_STORE`; only token hashes and device authorization
metadata are persisted, using an atomic mode-`0600` file. Bearer-token bytes
are never persisted by either backend.
For an explicit LAN address, set `COMPUTER_USE_REMOTE_ALLOW_LAN=true` and provide
both `COMPUTER_USE_REMOTE_TLS_KEY` and `COMPUTER_USE_REMOTE_TLS_CERT`.

Default binding is `127.0.0.1`. Wildcard binding is rejected. LAN operation
requires an explicit private IP, `allowLan: true`, TLS key/certificate options,
bearer authentication, and an explicit allowed-origin policy. Public ingress is
unsupported without a separately reviewed relay.

Remote scopes are `computer:observe`, `computer:screenshot`,
`computer:control`, `computer:execute`, and `computer:approve`. Screenshot scope
is separate because observation authority must not imply permission to transmit
screen pixels.
