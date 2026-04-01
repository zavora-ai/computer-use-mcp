# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 2.x     | ✅ Yes    |
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

This package has **full control of your Mac** when Accessibility permission is granted. The following are in scope:

- Privilege escalation via tool inputs
- Symlink attacks on temp files
- Shell injection via clipboard or text inputs
- Bypassing input validation to crash the server
- Memory safety issues in the Rust native module

## Out of scope

- Issues requiring physical access to the machine
- Social engineering attacks
- Vulnerabilities in dependencies (report those upstream)

## Security model

- All tool inputs are validated with Zod schemas at the MCP boundary and again in the session layer
- No shell string interpolation — all subprocess calls use argument arrays
- Screenshot temp files use `O_EXCL` exclusive creation with a monotonic counter to prevent symlink attacks
- The `wait` tool is capped at 300 seconds
- The server has no network listener — it communicates only over stdio

## Disclosure policy

We follow coordinated disclosure. We will credit researchers in the release notes unless they prefer to remain anonymous.
