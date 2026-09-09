# Computer-use strategy implementation

The strategy is implemented as fixes to the existing server plus opt-in host
services. The original 64 tool names and input schemas remain available;
`discover_applications` adds installed-app discovery to the core profile.
Enabling a desktop broker adds six tools; enabling a browser backend adds ten.
This is unreleased source work, not a claim of benchmark superiority or a new
npm release.

## Enable sessions, supervision and persistent Tasks

```ts
import { createComputerUseHttpHandler } from '@zavora-ai/computer-use-mcp'
import { DesktopBroker } from '@zavora-ai/computer-use-mcp/desktop-broker'
import { McpTaskManager } from '@zavora-ai/computer-use-mcp/mcp-tasks'
import { FileTaskStore } from '@zavora-ai/computer-use-mcp/task-store'
import { createSession } from '@zavora-ai/computer-use-mcp/session'

const desktops = new DesktopBroker({
  createSession: () => createSession(),
  store: new FileTaskStore('/private/agent-state/desktops'),
  // Add your verified-principal grant checks here. Never derive grants from model text.
  authorize: async (owner, operation, sessionId) => { /* host policy */ },
})
const tasks = new McpTaskManager({
  store: new FileTaskStore('/private/agent-state/tasks'),
  maxTasks: 256, maxConcurrentPerOwner: 16, maxResultBytes: 4 * 1024 * 1024,
})
const handler = createComputerUseHttpHandler({ desktopBroker: desktops, taskManager: tasks })
// Verify authentication in the embedding host, then pass verified authInfo to fetch.
// On host shutdown: await handler.close(); tasks.close(); desktops.close().
```

Use different store directories for Tasks and desktops. `FileTaskStore` uses
atomic replacement and restrictive file modes; it is a single-worker local
store, not a distributed database. Implement `TaskStore` for another host-owned
storage system. Synchronize shared storage and worker ownership in that system.

HTTP callers use `desktop_session({action:"open"})`, then send the returned
handle in `Computer-Use-Session` for ordinary tools and resources. The MCP
transport remains stateless. The handle selects application state, including
screenshot cache and target provenance. The new desktop tools also accept an
explicit `sessionId`. A missing handle retains the original ephemeral behavior.

Authenticated ownership is derived from verified issuer, tenant, subject and
client claims in `authInfo.extra` (`issuer`/`iss`, `tenant`/`tid`, `subject`/`sub`).
For opaque tokens without subject claims, ownership is bound to the token hash;
token rotation then requires new handles. Anonymous local handles are bearer
capabilities: keep them private and do not expose the loopback server remotely.
Client names are not credentials. Anonymous Tasks share one concurrency quota.

Sessions have idle expiry, bounded observations and a bounded operation journal.
On restart, restored desktop sessions are paused and observations are discarded.
Unfinished Tasks become failed/interrupted. Neither case silently reruns an
external action. Completed operation IDs return their recorded outcome; reusing
an ID with different arguments is rejected. A crash between an action and its
completion checkpoint leaves `unknown_outcome`; verify the application before
starting a new operation.

## Observe, act, verify

- `desktop_observe`: window identity, capture geometry, expiring observation ID,
  bounded redacted controls, scoped element IDs, and optional real image blocks.
- `desktop_act`: observation-bound click or semantic invocation, an operation ID,
  and an optional element-presence/absence predicate. Reports `executed`,
  `verified`, `partial`, or `unknown_outcome`.
- `desktop_workflow`: up to twenty semantic invocation steps. Each step obtains
  a new observation and waits locally for its required predicate. Ambiguity,
  truncation, denial or verification failure stops the workflow.
- `desktop_console`: current session state and last operation with a full text
  fallback and an optional MCP App.
- `desktop_pause`: interrupts session mutations and clears observations. Resume
  is available only through the host's `DesktopBroker.resume`, never an MCP tool.

Window screenshots carry a transform from returned image pixels to desktop
coordinates. Actions revalidate window identity and bounds and reject expired
observations. Display metadata now includes macOS/Windows monitor origins;
coordinate validation accepts points on monitors with negative origins. Native
mixed-DPI and window-capture behavior still needs live validation on each
supported target. This is not an atomic transaction with the application: if
state changes during an action, verify the resulting state.

The existing OpenAI batch adapter validates the entire batch before mutation,
preserves left/right/middle buttons and all drag points, and reports screenshot
errors. API scroll deltas are converted at 100 pixels per native line, preserving
both axes. This is an explicit approximation, not pixel-perfect scrolling.
Native modifier-assisted mouse actions fail explicitly; the browser backend
supports modifier-assisted semantic clicks. Unsupported semantics are never
silently dropped. Pointer release runs in `finally` during drag failures.

## MCP App console

The portable UI is `ui://computer-use/session-console/v1`, with MIME type
`text/html;profile=mcp-app` and `_meta.ui.resourceUri` on `desktop_console`.
It implements the standard `ui/initialize` exchange, handles tool results,
sends selected control IDs through `ui/message`, and supports pause/refresh and
teardown. It needs no network, third-party assets, storage, camera or microphone.
Observed labels use `textContent`, never HTML interpolation.

The component does not authorize actions or reset the physical emergency-stop
latch. The host still enforces permissions. It is tested with standard-origin
and opaque-origin protocol harnesses and a text-only MCP client; those tests are
not certification in two shipping host applications.

[Portable MCP Apps contract](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

## Authorization and Tasks changes

Live resources execute through the registry. Cache reads and file resources
perform authorization preflight. Modern file resources request client roots
through MRTR before access. Application completion uses the same registry.
Filesystem completion denies access when the SDK's completion method cannot
carry the required MRTR negotiation; it does not bypass roots.

Legacy subscriptions authorize both creation and delivery. The SDK's shared
modern event bus cannot reauthorize individual recipients, so restricted HTTP
hosts (custom authorization or desktop sessions) reject modern subscriptions
and use authorized polling. This restriction is intentional until a transport
with per-recipient delivery authorization is supplied.

Tasks resolve initial policy/roots input before creation. Selected read-only
operations can resume later input using a signed continuation; input keys and
duplicate answers are validated. Writes are never restarted as read-only
continuations. Task ownership, current scopes and the host authorization hook
are checked on result access and updates. Cancellation remains available to the
owner after scope revocation. Expiry and shutdown abort active work; task count,
concurrency and result bytes are bounded.

MRTR approvals have an issuance allowlist and one-shot consumption. Replays,
unissued IDs, expired IDs and approvals from before a process restart are
rejected. Legacy static approval tokens retain their compatibility behavior;
they are reusable credentials and should not be described as one-shot decisions.

`waitForTask` in `./task-client` polls without model turns and returns pending
input to the host instead of auto-approving it. Configure a network timeout in
the supplied request function as well as the overall wait deadline.

## Browser backend

```ts
import { BrowserBackend } from '@zavora-ai/computer-use-mcp/browser'
const browser = new BrowserBackend({
  origins: ['https://example.com'],
  uploadRoots: ['/private/approved-uploads'],
  downloadRoot: '/private/approved-downloads',
  authorize: async (owner, url, operation) => { /* current host grants */ },
})
// Pass browserBackend: browser to createComputerUseServer/HttpHandler.
// Close with await browser.close().
```

Playwright is optional. Install its Chromium browser with `npx playwright install
chromium`, or supply a host-controlled `launch` callback. Contexts are isolated;
existing browser profiles are never attached. Tabs are owner-bound and actions
are serialized per tab. The backend exposes exact semantic selection, frame
selection, navigation, value-free DOM observations, screenshots, bounded
console/network diagnostics, local waits, uploads from host-issued roots, and explicit downloads into a private host-issued directory.
Passwords and other recognized sensitive controls cannot be filled by this API.

Redirects, service workers, WebSockets, popups, unsolicited downloads and automatic dialogs
are blocked in this first backend. These are explicit capability limits, not
claimed implementations. Origin grants are checked for operations and routed
requests. Use OS/container network controls as well for hostile applications;
browser routing is not a replacement for an OS security boundary. There is no
browser extension for attaching a user's existing authenticated tabs.

[Playwright browser contexts](https://playwright.dev/docs/api/class-browsercontext),
[OpenAI action semantics](https://developers.openai.com/api/docs/guides/tools-computer-use-integration#supported-actions).

## Runtime and isolated workers

`ComputerRuntime` in `./runtime` runs a persistent JavaScript context inside a
Docker container. The default container has no network or host credentials, a
read-only filesystem, no capabilities, a non-root user, CPU/memory/PID limits,
and one read-only mounted worker file. `node:vm` provides language state inside
that container; it is not the security boundary.

```ts
import { ComputerRuntime } from '@zavora-ai/computer-use-mcp/runtime'
const runtime = new ComputerRuntime({
  allowedTools: ['observe'],
  execute: async (name, args, signal) => {
    // Validate args and call your current owner-bound broker here.
    return hostBrokerCall(name, args, signal)
  },
})
await runtime.run('state.view = await computer.call("observe", {windowId: 1}); emit(state.view);')
runtime.close()
```

Persistent data lives in the explicit `state` object. Output is selected with
`emit`. Every run has a deadline, output limit and broker-call limit. A failure
or cancellation terminates the worker and aborts broker calls. The injectable
`launch` hook is for tests or a host-provided OS sandbox; do not use it to run
untrusted code unsandboxed. There is no model-visible capability to change the
allowlist or launch configuration.

`connectIsolatedWorker` starts a separate Linux desktop image over MCP stdio,
with no network or host mounts and a bounded lifetime. The image recipe in
`workers/linux` requires built Linux native artifacts from CI. It supplies Xvfb,
Openbox, D-Bus and AT-SPI. It does not reproduce macOS locked use or attach the
user's desktop. The Docker daemon must already be running.

`DesktopSupervisor` in `./supervisor` monitors the native stop latch from a
worker thread. Physical takeover pauses sessions and invalidates observations.
Native input primitives enforce the latch independently of a blocked main JS
loop. Host reset and resume remain separate explicit actions. Await `.ready`;
an unavailable native monitor is an error, not a successful safety claim.
Stop-latency guarantees require measurement on the deployed OS/native build.

## Linux semantics

The server routes common accessibility operations through a fixed Python/GI
AT-SPI helper: tree inspection, lookup, invocation, field setting and forms.
Requests go through stdin, with a deadline and cancellation. Windows are matched
by PID and exact title; ambiguous windows or controls fail. Trees are bounded
and value-free, sensitive fields are unavailable, and truncated searches cannot
prove absence. The direct native fallback now returns an explicit unsupported
error rather than a successful empty tree.

Install `python3-gi`, `gir1.2-atspi-2.0`, and the desktop accessibility bus. This
bridge needs a working graphical user session. Wayland-wide coordinate input,
focused-element lookup and every application's AT-SPI behavior are not claimed
as universal support. [GNOME AT-SPI interfaces](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/class.Accessible.html).

## Validation and release gates

- `npm test`: TypeScript build and deterministic unit/protocol regressions.
- `npm run test:strategy`: broker, authorization, Tasks, runtime and evaluation tests.
- `npm run test:browser`: real browser test against a disposable loopback fixture.
- `node scripts/evaluate-strategy.mjs baseline.json candidate.json`: paired metrics
  from externally verified traces; rejects mismatched model, access mode,
  environment, task revision or budgets.
- `cargo check --manifest-path native/Cargo.toml`: native compile checks on the host.

The evaluation schema is exported by `./evaluation`. It reports success, elapsed
time, token usage, calls, interventions, attention time, cost per verified
success when supplied, and a paired bootstrap interval. Failed attempts count
in the efficiency denominator. No benchmark result is inferred from tool count
or the model's own completion message.

Local validation includes a real headless Chromium workflow, protocol harnesses,
mocked native calls and a macOS native compile check. Docker integration, a live
Linux AT-SPI desktop, native Windows/mixed-DPI coverage, actual MCP App host
certification, and matched-model OSWorld-style trials remain release gates.
These environmental validations are distinct from implemented code. Current
results do not establish that this repository exceeds OpenAI computer use.

The local `measure:efficiency` fixture reports 78,256 JSON characters for the full
catalog versus 9,499 for five selected tools (88% less), and 15,440 versus 5,902
characters for its compact tree (62% less). Repeated retained images emit zero
new image blocks. These are synthetic payload measurements, not tokenizer,
latency, task-success or OpenAI benchmark results.
