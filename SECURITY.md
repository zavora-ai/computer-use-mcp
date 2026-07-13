# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 8.x developer preview | ⚠️ Preview; security reports accepted |
| 7.x     | ✅ Yes    |
| 6.x     | ✅ Yes    |
| 5.x     | ✅ Yes    |
| 4.x     | ✅ Yes    |
| 3.x     | ✅ Yes    |
| 2.x     | ⚠️ Security fixes only |
| < 2.0   | ❌ No     |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Email: **security@zavora.ai**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fix (optional)

You will receive a response within **48 hours**. We aim to release a fix within **7 days** of confirmation.

## Scope

This package has **full control of the desktop** when the required OS permissions are granted:

**macOS:** Accessibility, Screen Recording (and Automation for `run_script`).  
**Windows:** UI Automation / input synthesis; PowerShell for registry and advanced automation.

In scope:

- Privilege escalation via tool inputs
- Symlink attacks on temp files
- Shell injection via clipboard or text inputs
- Bypassing input validation to crash the server
- Memory safety issues in the Rust native module
- Cross-process session lock bypass or race conditions
- AppleScript/JXA injection via `run_script` inputs
- PowerShell abuse via `run_script` on Windows
- Unrestricted absolute path writes/deletes via `filesystem`
- Registry and process kill misuse on Windows

## Out of scope

- Issues requiring physical access to the machine
- Social engineering attacks
- Vulnerabilities in dependencies (report those upstream)

## Security model

- All tool inputs are validated with Zod schemas at the MCP boundary and again in the session layer
- No shell string interpolation — all subprocess calls use argument arrays
- Screenshot temp files use exclusive creation patterns to prevent symlink attacks
- The `wait` tool is capped at 300 seconds
- The `run_script` tool is bounded by `timeout_ms` (default 30s, max 120s), an 8 MiB combined-output cap, a credential-scrubbed environment, and subprocess-tree termination on cancellation/timeout (POSIX process group or recursive Windows `taskkill`)
- Cross-process session lock prevents concurrent mutating tool calls from multiple server instances
- Policy gates: `COMPUTER_USE_ALLOWED_APPS`, `COMPUTER_USE_BLOCKED_APPS`, `COMPUTER_USE_REQUIRE_APPROVAL`, `COMPUTER_USE_APPROVAL_TOKEN`
- Interactive hosts may receive elicitation prompts when approval is required (token still wins when present)
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) are **hints only** — hosts must treat them as untrusted from untrusted servers; policy/approval is the real gate
- The server has no network listener by default — it communicates over stdio
- `scrape` and user-supplied scripts can access the network. v8 disables `scrape` unless `COMPUTER_USE_V8_ALLOW_SCRAPE=true`.
- `computer://screenshot/latest` is cache-only and never captures on resource read
- The v8 supervisor uses an opt-in local socket, requires an explicit 32+ character token, and is mode `0600` on Unix.
- v8 emergency stop is a process-global native/lease latch. On macOS and Windows, a configurable physical-only global chord is detected on the OS-hook thread and does not depend on the MCP connection or JavaScript event loop. All native input and legacy compatibility mutations fail closed while latched. There is no MCP reset tool; the reference PiP requires an explicit main-process confirmation before its authenticated host reset command.
- Model-authored script subprocesses receive a scrubbed environment. Supervisor, remote, approval, principal, and session control-plane variables are never inherited; generic secret-shaped variables and signing-agent/config paths require an explicit `COMPUTER_USE_SCRIPT_ENV_ALLOWLIST` entry. The standalone server deletes its supervisor-token environment entry immediately after constructing the authenticated supervisor.
- The reference onboarding flow presents the configured emergency-stop chord/backend before it can record acknowledgment, refuses policy configuration without that acknowledgment, and exposes only capability facts through renderer IPC. A setup acknowledgment is user education, not a substitute for the native latch or authenticated reset boundary.
- Onboarding permission guidance persists only allowlisted permission IDs/statuses. Desktop labels, remediation, and macOS Settings URIs are rebuilt locally. A trusted host may inject the settings opener and the host-only native macOS TCC prompt adapter; renderer commands carry only a fixed permission ID, and native result details are discarded before rendering. Prompt capability and settings-navigation capability are reported separately. No MCP tool can request permissions or open settings, and no renderer-provided URL is accepted.
- The optional remote sidecar is separately packaged, starts only when explicitly invoked, defaults to loopback, rejects wildcard/public binds, and requires TLS for an explicit private LAN address. Bearer tokens are pairing-confirmed, scope-limited, expiring, rotatable, stored only as hashes, and bound to MCP sessions by authorization context.
- Remote device-authorization metadata can be stored through a host-owned synchronous durable credential-vault adapter or the first-party OS adapters. macOS calls Security.framework in-process, Windows stores atomic DPAPI CurrentUser ciphertext, and Linux sends values to Secret Service over stdin; authorization values never enter child-process arguments or environment variables. Promise-returning vaults are rejected so token issuance cannot complete before persistence. Vault state carries a digest-linked monotonic revision plus a separately committed high-water anchor: stale/tampered state fails closed, while exactly one linked state-before-anchor crash is recovered forward. Atomic rollback of both same-vault records remains a privileged platform-backup residual risk. The atomic mode-`0600` plaintext-metadata file backend remains the explicit headless fallback. No backend persists bearer-token bytes.
- Remote screenshot access has a distinct scope, browser origins are denied unless allowlisted, and authorization loss pauses owned v8 sessions and revokes their control state.
- v8 mutating actions require an attributable session, policy decision, control lease, target revalidation, and idempotent receipt.
- Background capability probes are operator/host-only. Agents cannot invoke certification over MCP, and operation labels do not grant background authority. Each use requires an explicit unexpired ID bound to the trusted adapter, live app version, exact tool, instance-authority digest, and canonical action predicate.
- Reference probes mutate only reversible files inside a realpath-confined sandbox, verify the postcondition, and roll back. Arbitrary adapter evidence is stripped before atomic mode-`0600` trace persistence; trace digests detect tampering, but a trace by itself never grants execution authority.
- AX/UIA certification is restricted to one exact live app/window and non-sensitive text role/label. Its direct semantic executor is reachable only through the trusted certification binding and remains inside v8 policy, target revalidation, lease, cancellation, transaction, and receipt enforcement. Raw `set_value` calls retain the legacy focus requirement.
- Conformance reports include per-source, aggregate-output, trace, and report digests and never promote deterministic tests into live platform coverage. These digests provide integrity and reproducibility, not publisher identity; unsigned local reports remain self-attested until release provenance is supplied by CI/signing infrastructure.
- Release CI binds every target-specific native package to the root version, exact target identity, parsed Mach-O/PE/ELF architecture, size, and SHA-256; verifies copied and already-published bytes; publishes exact pre-attested tarballs with npm provenance; and emits a CycloneDX SBOM plus GitHub build/SBOM attestations. These controls provide build provenance and artifact integrity but do not replace Apple/Windows code signing, notarization, npm account security, or independent source review.
- The v8 readiness evaluator has an immutable mandatory gate set. Digest-valid local reports can prove reproducibility but not publisher identity; live background, hardware revocation, all-target CI, ADK crash/resume, platform signing, and independent review gates require unexpired Ed25519 statements from explicitly trusted keys and bind the relevant artifact/report digests. Trust-key distribution and protection remain release-operator responsibilities.
- v8 uses a passive HID event tap on macOS and dedicated low-level mouse/keyboard hooks on Windows. The macOS monitor accepts only hardware-source-state events; Windows rejects `LLMHF_INJECTED`/`LLKHF_INJECTED` events. On these platforms, governed physical-input actions fail closed if attributed monitoring cannot start. Linux X11 uses best-effort XI2 raw events and excludes the server's XTEST source devices, but reports `distinguishesInjected: false` because arbitrary virtual/uinput devices cannot be proven physical; native Wayland reports the monitor unavailable. Kernel/driver-level spoofing, virtual-device spoofing on Linux, and an OS hook removed after startup remain defense-in-depth concerns and are part of the release security-review gate.

### Residual risk (filesystem)

Relative `filesystem` paths resolve under the Desktop. The v7 low-level tool remains unrestricted when `COMPUTER_USE_FS_ROOTS` is unset for compatibility. The v8 high-level action path denies filesystem mutation until roots are configured unless `COMPUTER_USE_V7_COMPAT=true`. Configured roots block `..` traversal and symlink escape. Treat unrestricted v7 `delete|write|move` as admin-equivalent.

### Residual risk (scrape + desktop)

Combining `scrape` (open-world content) with desktop control and private data access can form a prompt-injection exfiltration chain. Prefer isolating open-world tools from high-privilege sessions.

## Disclosure policy

We follow coordinated disclosure. We will credit researchers in the release notes unless they prefer to remain anonymous.
