# computer-use-mcp v8 threat model

## Assets and trust boundaries

Protected assets are desktop input authority, private screen/app state, clipboard
and filesystem data, approval authority, authenticated principal identity,
session/event history, and execution receipts. The model/planner is untrusted.
The launching host authenticates the principal. The v8 runtime—not ADK, PiP, or
MCP annotations—is authoritative for policy, leases, target freshness, and
exactly-once effects.

## Principal threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| Malicious screenshot/page instruction | Provenance-bound digest; confirm/deny boundary crossing | Detection depends on the host marking open-world provenance |
| Stale/replaced UI target | Live app/PID/window/title/bounds/revision comparison | Semantic evidence needs an observation resolver; unresolved fields fail closed |
| Agent fights user | One-writer lease, macOS hardware-source event tap, Windows injected-flag filtering, best-effort X11 XI2 monitoring that excludes XTEST devices without claiming full attribution, fail-closed physical input on attributed platforms, bounded action budget, and an out-of-band physical chord that latches native plus compatibility mutation off | Kernel/driver spoofing, hook removal after startup, arbitrary Linux virtual/uinput devices, native Wayland monitoring, and Linux physical-chord attribution remain uncertified |
| Agent suppresses or fakes emergency stop | Chord recognition runs on the native OS-hook thread, accepts only physical-source events, increments a native generation, interrupts native loops without the JS event loop, and remains latched across MCP disconnect/reconnect | Kernel/driver injection or killing the host process can defeat an in-process hook; signed live hardware evidence and independent review remain mandatory |
| Unauthorized emergency reset | No MCP reset tool; only the authenticated local supervisor/embedding host can reset both native and lease latches, and the reference PiP requires present-user main-process confirmation | Local account compromise or a compromised embedding host remains in the TCB |
| Emergency-stop denial of service | Chord requires at least two modifiers plus Escape/F12; stop is reversible only by the trusted host and observation remains available for diagnosis | A local physical user can intentionally latch work off; this is an availability tradeoff in favor of user control |
| Crash repeats physical action | Durable `(session, actionId, digest)` receipt | Crash across the native side-effect boundary can be `indeterminate`, never auto-retried |
| Approval substitution/replay | Runtime-stored preview; grant binds principal/session/digest/class/mode/TTL/use | Compromised host principal can approve its own work |
| Secret leakage | Key redaction before events/journal; screenshot results memory-only | Pixels can contain secrets while live; persistence must remain opt-in |
| Credential-field value disclosure or caller-label forgery | Native AX secure/protected-content and UIA `IsPassword` classification precedes value reads; sensitive values are null at the native boundary and recursively redacted again; only allowlisted value-free signals enter action digests/events; unknown or changed sensitivity blocks semantic mutation | OS accessibility APIs and heuristic fallbacks can have false negatives; generic physical `type` lacks focused-field sensitivity attribution; pixels can still display secret text and require separate capture controls |
| Retained private history | Principal-bound terminal deletion removes sessions, receipts, grants, reservations, and the selected event stream; the journal chain is atomically rebuilt | A retention marker preserves record counts and the prior terminal hash, which may permit coarse timing/volume correlation |
| Unbounded local persistence | Configurable session-count and journal-byte caps fail closed and require explicit terminal pruning | A full store denies new governed work until an authenticated caller prunes data |
| PiP privilege escalation | Separate sandboxed process with no desktop native module; token stays in main process; fixed IPC commands; frame retrieval requires authenticated principal plus prior session subscription; server removes the token variable after capture and every model-authored subprocess receives a credential-scrubbed environment | Same-account malware can attack OS process/socket boundaries and remains part of the independent-review threat model |
| PiP visual evidence leaks unrelated desktop state | Explicit opt-in; target app/window capture only with no whole-display fallback; validated PNG/JPEG; 1 MiB/frame, six/session, 8 MiB/process, five-minute TTL; process-memory-only deletion; metadata-only events/journal; renderer gets only explicit allowlisted frame responses | The authorized target itself can display secrets; a compromised same-account supervisor main process can read frames during their short lifetime |
| Script steals control-plane credentials | Supervisor/remote/principal/session/approval variables are unconditionally removed from child environments; generic token/secret/password/API-key/credential variables and signing-agent sockets require an explicit host allowlist | Arbitrary same-account code may use OS-specific process inspection or credential stores; scripting remains high risk and must stay policy/approval constrained |
| Cancelled script leaves descendants mutating | Model-authored subprocesses run in a dedicated POSIX process group or are recursively terminated with Windows `taskkill /T`; cancellation, lease revocation, emergency stop, timeout, and output overflow use the same tree terminator | A hostile POSIX child can deliberately escape into a new session before revocation; OS sandboxing/service isolation remains a stronger host boundary for untrusted arbitrary code |
| Filesystem escape | Canonical roots and symlink checks; v8 mutation denied if unconfigured | v7 compatibility mode can remain unrestricted |
| Remote exposure | No listener by default; optional sidecar rejects wildcard/public binds, requires TLS for an explicit private LAN address, and validates Host/Origin | A separately deployed relay and public ingress remain unsupported without review |
| Stolen pairing code | Pairing is short-lived, nonce-bound, attempt-bounded, one-time, and inert until explicit local confirmation | Malware controlling both the remote nonce and host confirmation channel can still pair |
| Remote token replay | Opaque token hash, expiry, rotation/revocation, and MCP-session binding to a unique authorization context | A live stolen bearer token retains its granted scopes until detected, expired, or revoked |
| Remote authorization-store disclosure or rollback | Bearer bytes are never persisted; a host may place hash-only device records in an OS credential vault through a synchronous durable adapter, or use the atomic mode-`0600` file fallback | Hash records reveal device metadata and can be rolled back by a compromised same-account vault/file provider; first-party OS-vault bindings and rollback counters remain hardening work |
| Task/session enumeration | 256-bit MCP session IDs plus per-context binding and runtime principal checks on sessions, events, tasks, and follow-ups | Traffic metadata remains visible to the terminating endpoint |
| Screenshot leakage | Separate `computer:screenshot` scope; pixels return only through explicit governed action results, never the live event feed | An authorized screenshot client can observe whatever the local capture policy permits |
| Confused deputy / CSRF | `v8-safe` factory, per-call scope authorization, immutable host principal, Host validation, and default-deny browser Origin policy | Incorrect custom host adapters can weaken the boundary and require review |
| Remote denial of service | Body/event/queue limits and per-device/IP pairing/request rate limits | Local CPU/network exhaustion remains possible below operating-system connection limits |
| Multi-agent collision | Fair single mutation lease; action/agent/group attribution | Read-only observers can still consume resources or infer shared state |
| Capability-label confused deputy | Operator-only probe; explicit certification ID; adapter/app-version/tool/action-contract/instance-authority/expiry binding; trusted live argument predicate | A malicious or compromised trusted host adapter remains inside the execution TCB |
| Certification probe escape or trace forgery | Reversible realpath-confined sandbox mutation, postcondition and rollback proof, redacted evidence allowlist, atomic mode-`0600` trace, canonical digest | OS/app behavior can change without a version change; certification remains short-lived and broader matrices are required |
| AX/UIA focus laundering | Certified semantic execution uses an exact-target direct native executor; raw `set_value` keeps its focus requirement; the full v8 lease/policy/target/receipt transaction still applies | Window-ID reuse and app accessibility regressions require live target revalidation and short-lived certification |
| Browser bridge bypass or URL confusion | Host bridge actuator is internal-only; fixed operation allowlist, HTTP(S)-only URLs, domain policy, bridge/page/URL-digest/DOM/viewport evidence, live preflight, lease, receipt, and verified fresh post-evidence are mandatory | The injected DOM/CDP adapter is trusted code; a compromised adapter can falsify its own observations and verification |
| Vacuous or forged handler success | Typed postconditions are bound to the exact action/resource/approval/receipt digest; automatic UI/filesystem/registry/process checks and explicit click/target checks use a separate readback dispatch; expected values/content leave the kernel only as SHA-256 digests; failed checks become non-replayable indeterminate receipts | Accessibility and OS readback APIs can themselves be stale or dishonest; copy proves destination presence unless byte equality is explicitly requested; arbitrary click semantics still require a caller/adapter-supplied final-state assertion |
| Forged compatibility report | Badge evaluator scopes assertion IDs, validates live trace digests, publishes per-source/output/report digests, and reports missing platforms as partial | Digests prove integrity, not author identity; local reports are self-attested until signed CI provenance is implemented |

## Security release gates

- No mutation after a recorded lease revocation in the race corpus.
- No committed mutation without policy, active lease, target revalidation, and receipt.
- No changed digest or principal can consume an approval grant.
- No screenshot/result bytes persist without explicit configuration.
- Terminal deletion leaves no selected session/event/error bytes in durable v8 file stores, and the retained journal verifies after rewrite.
- Recovered sessions remain paused until a new lease is acquired.
- Local supervisor rejects unauthenticated, oversized, cross-principal, and unknown commands.
- PiP frame bytes never enter the event journal, require an authenticated subscribed session, expire from bounded process memory, and are deleted with terminal session data.
- A physical emergency chord must interrupt a native wait without an MCP transport, reject every post-latch native and compatibility mutation, remain latched across reconnect, and require authenticated present-user reset.
- Remote disconnect, token expiry/revocation, host lock, relay loss, and sidecar shutdown invoke principal suspension before further mutation.
- Remote control is not declared stable without signed cross-platform validation and independent security review.
