# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
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
- The `run_script` tool is bounded by `timeout_ms` (default 30s, max 120s)
- Cross-process session lock prevents concurrent mutating tool calls from multiple server instances
- Policy gates: `COMPUTER_USE_ALLOWED_APPS`, `COMPUTER_USE_BLOCKED_APPS`, `COMPUTER_USE_REQUIRE_APPROVAL`, `COMPUTER_USE_APPROVAL_TOKEN`
- Interactive hosts may receive elicitation prompts when approval is required (token still wins when present)
- MCP tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) are **hints only** — hosts must treat them as untrusted from untrusted servers; policy/approval is the real gate
- The server has no network listener by default — it communicates over stdio
- `computer://screenshot/latest` is cache-only and never captures on resource read

### Residual risk (filesystem)

Relative `filesystem` paths resolve under the Desktop. **Absolute paths are unrestricted** by default (no path jail). Treat `mode=delete|write|move` as destructive. An optional root allowlist may be added in a future release (`COMPUTER_USE_FS_ROOTS`).

### Residual risk (scrape + desktop)

Combining `scrape` (open-world content) with desktop control and private data access can form a prompt-injection exfiltration chain. Prefer isolating open-world tools from high-privilege sessions.

## Disclosure policy

We follow coordinated disclosure. We will credit researchers in the release notes unless they prefer to remain anonymous.
