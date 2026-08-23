# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 7.1.x | Yes |
| 7.0.x | Security fixes |
| 6.x | Security fixes |
| 5.x and earlier | No |

## Reporting a vulnerability

Do not use a public GitHub issue. Email **security@zavora.ai** with a description, reproduction steps, impact, and any suggested mitigation. We aim to acknowledge reports within 48 hours.

## Security boundary

The server acts with the OS permissions of its process. With Accessibility/UI Automation, Screen Recording, and scripting permission, it can observe and control most of the desktop. The `full` profile is therefore a high-privilege local capability.

The primary command uses MCP over stdio. The separate `computer-use-mcp-http` command opens a loopback-only Streamable HTTP listener with `Host` and `Origin` checks. `scrape` and user-authored `run_script` content can still initiate network access.

## Controls

- Zod validates tool inputs at the MCP boundary.
- Tool annotations describe risk but are not authorization controls.
- `ServerOptions.authorizeToolCall` lets an embedding host enforce transport identity and scope before dispatch.
- `COMPUTER_USE_ALLOWED_APPS` and `COMPUTER_USE_BLOCKED_APPS` constrain application targets.
- `COMPUTER_USE_REQUIRE_APPROVAL`, `COMPUTER_USE_REQUIRE_APPROVAL_FOR`, and `COMPUTER_USE_APPROVAL_TOKEN` gate configured operations.
- MCP form elicitation is one-shot. Accepting one action never approves a later call.
- Modern Roots and elicitation responses carry HMAC-signed, expiring request state bound to the exact method, client, tool, and arguments. Configure `COMPUTER_USE_REQUEST_STATE_SECRET` when retries must survive process restarts.
- Approval messages show the exact bounded scope involved. Tokens never appear in the message or audit log.
- A cross-process session lock serializes mutating calls.
- `wait` is capped at 300 seconds.
- `run_script` has a bounded timeout and output size, propagates cancellation, terminates subprocess trees, and receives a credential-scrubbed environment.
- Screenshot temporary files are created atomically with owner-only access and removed automatically.
- `computer://screenshot/latest` is cache-only and never captures the display when read.
- MCP logs contain tool names, outcomes, and durations only. They exclude arguments, results, file contents, clipboard data, scripts, secrets, and images.
- Tasks extension IDs contain 192 random bits. Authenticated HTTP tasks are bound to the verified OAuth client ID; otherwise the task ID is a bearer capability. Task count and TTL are bounded.

## HTTP and authentication

The bundled HTTP runner refuses non-loopback binds. `createComputerUseHttpHandler` is intended for embedding and does not trust or parse `Authorization` headers. A remote host must verify tokens, enforce scopes, validate origins/hosts, and pass validated `authInfo` to the handler. Passing fabricated `authInfo` defeats task isolation and host authorization.

Modern HTTP task lifecycle requests require both `Mcp-Method` and `Mcp-Name`; `Mcp-Name` must equal the task ID. Modern request identity and capabilities are validated on every exchange. The in-memory task store survives stateless requests and client reconnects but not a server-process restart.

## Filesystem boundary

Relative filesystem paths resolve beneath the user's Desktop for compatibility.

`COMPUTER_USE_FS_ROOTS` accepts a comma-separated operator allow-list. When an MCP client also advertises roots, a path must be inside both boundaries. Paths are normalized and the deepest existing ancestor is resolved with `realpath`, blocking `..` traversal and symlink escape, including for not-yet-created destinations.

A roots-capable client fails closed while roots are refreshing or if `roots/list` fails. Clients without roots support retain legacy behavior; configure `COMPUTER_USE_FS_ROOTS` to avoid unrestricted absolute paths.

Filesystem resource links repeat the containment check when read. Individual file reads are limited to 1 MiB and directory listings to 1,000 entries.

## Residual risks

- With `COMPUTER_USE_FS_ROOTS` unset and a client that does not support roots, `filesystem` can access arbitrary paths permitted to the process.
- `run_script` intentionally executes user-supplied AppleScript, JXA, or PowerShell.
- Coordinate input can affect the wrong UI if the target changes unexpectedly; use explicit application/window targeting and prefer accessibility actions.
- Combining open-world web content with desktop control can create prompt-injection and exfiltration paths. Separate untrusted retrieval from privileged desktop sessions.
- The fetch-shaped HTTP handler can be exposed remotely by an embedding application; its authentication, TLS, rate limiting, and multi-process task-store design are that host's responsibility.
- OS-level permissions and integrity boundaries remain authoritative; this package cannot safely automate applications running at a higher privilege level.

## Release integrity

CI builds and tests supported native targets, checks packed package contents, installs the packed artifact across supported Node versions, generates a CycloneDX SBOM, and emits build provenance attestations. These controls do not replace Apple/Windows signing, notarization, npm account protection, or independent source review.

## Disclosure

We follow coordinated disclosure and credit researchers unless they prefer anonymity.
