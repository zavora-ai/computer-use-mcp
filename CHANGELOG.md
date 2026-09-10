# Changelog

## v7.2.0 (2026-09-10)

Application discovery, optional desktop/browser/runtime services, persistent Tasks,
Responses showcases, efficiency and authorization improvements, and documentation
cleanup. See [the release notes](docs/releases/v7.2.0.md).

### Added

- `mouse_drag` tool: press a chosen button, move through interpolated waypoints and
  release, optionally holding modifiers for the whole gesture. Applications that
  draw their own interface expose no accessible controls and navigate by
  button-and-modifier gestures — a 3D viewport orbits on middle-drag, pans on
  shift+middle, zooms on ctrl+middle — none of which the single-button
  `left_click_drag` could express. Verified against Blender, whose accessibility
  tree contains six nodes and no controls.

- DeepSeek Flash vision example under `agents/deepseek-agent`: `vision.mjs` asks a
  single question about a capture (describe a screen, transcribe a window, read a
  chart, diff two captures, or use an externally hosted image) and `agent.mjs` runs
  the full MCP tool loop with image feedback. DeepSeek accepts images in user
  messages only, so tool screenshots are moved out of the `tool` message into a
  following user message; the per-image, per-request and dimension limits are
  checked locally rather than surfaced as a 400.
- Long-running DeepSeek Flash ledger showcase (`agents/deepseek-agent/showcase.mjs`):
  a receipt whose text exists only as canvas pixels, transcribed into a form and
  scored by a local host that never reveals the answers. Prompt-driven, with
  `--receipt random` pulling a real receipt from Wikimedia Commons. `record.mjs`
  captures a run, cropped to the app window.
- `deepseek-flash` screenshot provider preset at 1280px. The model rescales every
  image to roughly the pixel count of 1300x1300 and caps it at 1024 tokens, so a
  wider capture costs upload bytes without adding detail.

### Fixed

- Arguments are validated against the advertised input schema at the MCP boundary, and
  schema defaults now reach handlers. Previously a declared `.default()` was advertised
  but never applied, so `snapshot` returned an unrequested UI tree and `multi_select`
  was non-additive despite `press_ctrl` defaulting to `true`.
- Malformed arguments return a structured `invalid_arguments` result naming each
  offending path, instead of a JSON-RPC internal error carrying a raw validation dump.
- `multi_select` holds the modifier across each click through a new native additive
  click, rather than tapping it once beforehand where it selected nothing.
- `run_script` is checked against the sensitive-app and blocked-app lists by script
  body. It has no target argument, so those rules previously had nothing to match and
  a script could drive a credential manager ungated.
- The approval token is compared in constant time.
- Audit records drop sensitive values outright. They previously stored an unsalted
  SHA-256 digest and the plaintext length, which is recoverable for short secrets.
  Text digests in audit records are now keyed per session. The audit directory and
  file are created with owner-only permissions.
- The cross-process session lock records a renewed lease. A crashed holder whose PID
  the operating system recycled previously wedged every mutating tool indefinitely, and
  a reclaimer that crashed mid-recovery left a guard file that disabled stale recovery
  permanently.
- `resize_window` quotes `window_name` for PowerShell and AppleScript instead of
  interpolating it, and reports `platform_unsupported` on Linux rather than emitting
  AppleScript that has no interpreter there.
- `destroy_space` accepts the GUID string that `create_agent_space` returns on Windows.
- Tools without an implementation on the running platform return a structured
  `platform_unsupported` result naming the supported platforms and the alternative.
- `select_menu_item` accepts `focus_strategy`, so the documented `prepare_display`
  recovery path works for menu selection.
- `filesystem` operates on the path the root check canonicalized, closing the window
  where a symlink swapped in after the check could redirect the syscall outside the
  configured roots. With no boundary configured the caller's path is used unchanged.
- The loopback HTTP request handler and the v7.1 `oninitialized` hook contain their own
  async failures. Both were passed as promise-returning callbacks where a void return
  was expected, so a rejection became an unhandled rejection rather than a served error.

### Changed

- `AGENTS.md` documents the permissive default security posture explicitly and every
  `COMPUTER_USE_*` variable, and its client examples and platform table now match the
  implementation.
- CI runs `cargo test` and a correctness/suspicious `clippy` gate on macOS, Windows and
  Linux hosts, plus a type-aware ESLint gate (`npm run lint`) focused on unhandled
  promises, unused code, and undocumented empty catches.

### Removed

- Dead `displayClient` helper in the Tasks manager and an unused profile lookup in the
  tool registry.

## v7.1.0 (2026-08-23)

Additive MCP capability release. All 64 v7 tool names and input schemas remain stable.

### Added

- Negotiated MCP client roots, enforced together with `COMPUTER_USE_FS_ROOTS`.
- Resource subscribe/unsubscribe and state-derived update notifications.
- Readable filesystem `resource_link` results and a root-confined filesystem resource template.
- Disclosure-safe MCP logging with SDK log-level handling.
- Exact-scope form elicitation for one-shot policy approvals.
- Human-readable tool titles and prompt/resource completion.
- Runtime v7 profile list-change notifications.
- `mcp-server.toml` registry manifest and expanded architecture documentation.
- MCP 2026-07-28 stateless serving over stdio and Streamable HTTP, with legacy 2025 fallback.
- Per-request protocol/client/capability envelopes, `server/discover`, server identity, private cache hints, and `subscriptions/listen`.
- In-band multi-round-trip Roots and exact-scope form elicitation protected by signed, expiring request state.
- `io.modelcontextprotocol/tasks` for selected long-running read-only tools, including get/update/cancel, TTL, cancellation, routing-header validation, and authenticated caller isolation.
- Standard behavior annotations on all 64 tools and audience/priority annotations on resources.
- Loopback-only HTTP runner plus a fetch-shaped handler for authenticated embedding.

### Changed

- Migrated from the monolithic SDK 1.30.0 package to exact `@modelcontextprotocol/{server,client,core,node}` 2.0.0 packages.
- Minimum Node.js version is now 20.
- Legacy logging, roots, and reverse elicitation remain available but are deprecated by MCP 2026-07-28.
- The root tarball ships all six native targets and is submitted through npm staged publishing for explicit maintainer/2FA approval. Split-package manifests remain version-locked for a future bootstrap, but v7.1 does not declare package names that npm cannot stage before their first publication.

### Removed

- The unreleased v8 preview facade, contracts, migration commands, remote sidecar, supervisor package, examples, conformance artifacts, and release gates. Its incompatible Tasks adapter was replaced by the standard extension on v7.1.

### Security

- Roots-capable clients fail closed while roots refresh or when `roots/list` fails.
- Filesystem resources repeat containment checks and bound file and directory reads.
- MCP logs exclude arguments, results, secrets, scripts, clipboard values, and image data.

### Verification

- All 208 automated tests pass locally, including legacy MCP, stateless MCP 2026-07-28, Tasks, MRTR, subscriptions, annotations, targeting, cancellation, filesystem containment, and package installation.
- The packed universal npm artifact installs cleanly and all seven public entry points import successfully.
- A live macOS arm64 test loaded the native module, enumerated the desktop, observed Accessibility state, captured a screenshot, injected a no-op pointer event, opened TextEdit, clicked, typed, round-tripped and restored the clipboard, and saved/read files.
- Direct native typing preserves Unicode punctuation, accented text, and emoji. TextEdit AppleScript callers remain responsible for choosing a Unicode-safe file encoding when saving plain text.

## v7.0.0 (2026-07-10)

Architecture-finish release. Builds on the v6.2.1 modernization with cancellation, progress, filesystem containment, a native binary resolver, and a session-layer split. See `docs/specs/MODERNIZATION-v6.2-v7.md`.

### Fixed (Windows)
- **Tool input schemas are now valid JSON Schema draft 2020-12.** Coordinate/region/size parameters were emitted as Zod tuples (`"items": [ … ]`), which draft 2020-12 rejects (it requires `prefixItems`). Some MCP hosts (e.g. Anthropic-backed clients) refused the whole tool list with a 400. These parameters now use length-constrained arrays (`{ type: "array", items: {…}, minItems/maxItems }`), valid across drafts, with identical runtime values. Affects `agent_pointer`, `zoom`, all click/mouse tools, `left_click_drag`, `resize_window`, `snapshot`, `multi_select`, `multi_edit`.
- **`type` no longer drops or garbles characters on Windows.** Native keyboard injection sent one `SendInput` per character, which the Windows 11 (UWP) text stack intermittently dropped/reordered. Characters are now sent as a single batched `SendInput` of `KEYEVENTF_UNICODE` events (atomic, reliably queued).
- **Multi-line typing preserves line breaks.** `write_clipboard` now normalizes `\n` → `\r\n` for `CF_UNICODETEXT`, and the session `type` handler routes newline-containing (or long) text through the clipboard-paste path, which is reliable on UWP controls.

### Docs / examples (Windows)
- Windows examples updated for the v7 wire shapes: `list_windows` → `{ windows: [...] }` and `get_frontmost_app` → `{ app: {...} }`.
- Notepad examples hardened for Windows 11's single-instance/tabbed/session-restoring Notepad: work in a fresh tab (`Ctrl+N`), drive the Save As dialog via accessibility (`set_value` on "File name:" + press "Save"), and close only that tab (`Ctrl+W`) instead of `Alt+F4`. De-hardcoded a `Desktop` path.

### Breaking
- **`[focusRequired: X]` description suffix is now OFF by default.** `focusRequired` remains available via `_meta` (`computer-use/focusRequired`) and `get_tool_metadata`. Restore the suffix with `COMPUTER_USE_LEGACY_FOCUS_TAG=true` (or `ServerOptions.legacyFocusTag: true`).

### Added
- **Cancellation** — tool handlers honor the MCP host `AbortSignal`: `wait` returns early, `run_script` `SIGKILL`s the child.
- **Progress** — `filesystem search` (and the bounded spawner path) emit `notifications/progress` **only when the request carries a progressToken** (no token → no spam).
- **Filesystem jail** — `COMPUTER_USE_FS_ROOTS` confines the `filesystem` tool to allowlisted roots (blocks `..`/symlink escapes). Unset = legacy unrestricted.
- **Native binary dual resolver** — `COMPUTER_USE_NATIVE_PATH` → optional platform package → legacy root binary → generic, with a doctor-friendly error. Lazy resolution.
- **Native `optionalDependencies` packaging** — per-platform packages under `packages/*` (lockstep version); the resolver prefers them, falling back to the legacy root binary shipped in the main tarball through the 7.x line.

### Architecture
- Session split continues into `src/session/*` (`tool-guide`, `fs-jail`, …); `session.ts` re-exports.
- rmcp evaluated — **NO-GO** for a rewrite (`docs/specs/SPIKE-rmcp.md`).

### Tests
- Suite expanded to cover cancellation, progress, FS jail, resolver, profiles/resources/elicitation, and the focus-tag deprecation modes.

## v6.2.1 (2026-07-10)

Release-completion gate for the v6.2 modernization (see `docs/specs/MODERNIZATION-v6.2-v7.md`, PR-19).

### Fixed
- **`COMPUTER_USE_STRUCTURED_CONTENT=false` now omits both `outputSchema` and `structuredContent`.** Previously only the `outputSchema` advertisement was suppressed while results still carried `structuredContent`, so the documented legacy text-only mode did not actually take effect. The flag is now evaluated per `createComputerUseServer` (also overridable via `ServerOptions.structuredContent`) and threaded through every result-mapping path, including the server-local `get_tool_metadata` handler.

### Changed
- **Pinned `@modelcontextprotocol/sdk` to exact `1.29.0`** (no caret range) for reproducible release builds (K11).

### Docs
- Corrected stale tool counts in README (feature matrix and architecture diagram) to **64**.
- Reconciled contradictory SDK "pin" wording in the CHANGELOG and modernization spec.

### CI / release assurance
- CI now runs the **full Node test suite on both macOS and Windows** (previously only `stdio.test.mjs` on macOS).
- Added a **package-content assertion** that the published tarball includes `dist/**`, `AGENTS.md`, `README`, `LICENSE`, and `skills/**/SKILL.md`.
- The stdio initialize/list/version smoke runs as part of the full suite on both platforms.

### Tests
- Added positive/negative coverage for the structured-content opt-out (enabled, disabled via option, disabled via env var), asserting both the result field and the `outputSchema` advertisement.

### Cancellation (PR-14)
- Tool handlers now honor the MCP host `AbortSignal` (`extra.signal`), threaded through `Session.dispatch`.
- `wait` returns early on abort instead of blocking the full duration.
- `run_script` (and the bounded spawner) `SIGKILL`s the child process on abort.
- Best-effort: many stdio hosts never send cancellation; unaborted behavior is unchanged. Covered by `test/cancellation.test.mjs`.

### Native loader (PR-15, resolver)
- `src/native.ts` now resolves the native binary via an ordered dual resolver: `COMPUTER_USE_NATIVE_PATH` → optional platform package `@zavora-ai/computer-use-mcp-${platform}-${arch}` → legacy package-root `computer-use-napi.${platform}-${arch}.node` → generic `computer-use-napi.node`, with a doctor-friendly error listing every attempt. Resolution is lazy (first `loadNative`).
- Additive/back-compatible: with the optional packages unpublished, resolution falls through to the legacy root binary (unchanged behavior). Publishing the platform packages + declaring `optionalDependencies` remains a follow-up. Covered by `test/native-resolver.test.mjs`.

### v6.2 MCP protocol modernization (ships in this 6.2.1 release)

Annotations, structured content, profiles, prompts, resources, skills, and approval elicitation. See `docs/specs/MODERNIZATION-v6.2-v7.md`.

### Protocol
- **Pin** `@modelcontextprotocol/sdk` to exact `1.29.0` (K11: exact tested version, no caret); migrate tool registration to `registerTool`
- **Tool annotations:** `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` on all 64 tools (Appendix A)
- **`_meta`:** `computer-use/focusRequired`, mutates, and related fields for hosts that understand them
- **Server instructions** injected at initialize (tool priority hierarchy)
- **`structuredContent`** dual-write for priority tools (`doctor`, `policy_status`, guide, windows, etc.)
- **`outputSchema`** only where structured success paths are complete (K17)
- **MCP prompts:** `diagnose-desktop`, `fill-form`, `script-first`, `safe-desktop-task`
- **MCP resources:** `computer://display/main`, `windows`, `frontmost`, `policy`, `profile/tools`, `screenshot/latest` (**cache-only**, never captures on read)

### Wire format (breaking for text-JSON parsers)
- `list_windows` text JSON is now `{ "windows": [...] }` (was a top-level array)
- `get_frontmost_app` text JSON is now `{ "app": ... | null }`
- `get_active_space` text JSON is now `{ "active_space_id": number | null }`
- Object-shaped tools keep previous keys; additive fields only (`profile` on `policy_status`, guide confidence fields)

### Agent guidance
- **Skills** shipped under `skills/**` and included in the npm package
- **AGENTS.md** packaged; points at skills and prompts
- `get_tool_guide` returns additive `confidence`, `fallbackSequence`, `platform`, and profile remediation

### Profiles (init-time only)
- `COMPUTER_USE_PROFILE=core|ax|scripting|windows-admin|full` (default **`full`**)
- Filters tools at process start; no runtime `list_changed` in this release

### Policy / safety
- **PR-0:** `resize_window` added to mutating lock set (was missing from `MUTATING_TOOLS`)
- Tool catalog SSOT for mutates + annotations (`src/tool-catalog.ts`)
- Elicitation-based approval when the host supports it; **`approval_token` still wins** when valid
- `SECURITY.md` updated for Windows + 6.x and filesystem residual risk

### Client
- `listTools` returns annotations / `_meta` / schemas
- `listResources` / `readResource` / `listPrompts` / `getPrompt` helpers
- `ToolResult.structuredContent` passthrough

### Env
- `COMPUTER_USE_PROFILE` — tool profile (default `full`)
- `COMPUTER_USE_STRUCTURED_CONTENT=false` — disable structuredContent + outputSchema advertisement

## v6.2.0 (2026-05-16)

v6.1.1 adds **native Linux support** (X11 + Wayland), making computer-use-mcp a true cross-platform desktop automation server for macOS, Windows, and Linux.

### Linux native modules (Rust)
- **Mouse** — X11/XTest for X11 sessions, `ydotool` for Wayland. Absolute positioning, click, drag, scroll
- **Keyboard** — X11/XTest keycodes for X11, `ydotool` evdev keycodes for Wayland. Full key map with combos
- **Text input** — `xdotool type` (X11) or `ydotool type` (Wayland) for reliable Unicode text entry
- **Screenshot** — XDG Desktop Portal (GNOME Wayland), `gnome-screenshot`, `grim` (wlroots), `scrot` (X11 fallback)
- **Clipboard** — `wl-copy`/`wl-paste` on Wayland, `xclip`/`xsel` on X11
- **Window management** — GNOME Shell D-Bus Eval for Wayland, `wmctrl`/`xdotool` for X11
- **App management** — `/proc` filesystem + `wmctrl` + GNOME D-Bus for listing, activation, hide/unhide
- **Display** — X11 `XDisplayWidth`/`XDisplayHeight` for resolution and multi-screen
- **Workspaces** — `wmctrl -d` for listing, `wmctrl -t` for moving windows between desktops
- **Accessibility** — Stubs (AT-SPI2 integration planned for future release)
- **Scripting** — `bash` by default, `pwsh` if installed

### Wayland-native support
- Runtime detection via `XDG_SESSION_TYPE` environment variable
- Automatic fallback: Wayland tools → X11/XWayland tools
- Tested on GNOME 50 (Ubuntu 25.04) with Wayland session

### Platform detection
- `src/native.ts` — added `linux-x64` and `linux-arm64` targets
- `src/session.ts` — `IS_LINUX` constant, Linux-specific clipboard, scripting, and keyboard handling
- All Linux code gated behind `#[cfg(target_os = "linux")]` — zero impact on macOS/Windows

## v6.0.0 (2026-04-26)

v6.0 adds **native Windows support**, transforming computer-use-mcp from a macOS-only tool into a cross-platform desktop automation server. Every Windows API call goes through Rust via `windows-rs` with zero-overhead NAPI bindings — no Python, no pywin32, no subprocess overhead.

### Windows native modules (Rust)
- **Mouse** — `SendInput` with `MOUSEINPUT`, absolute coordinate normalization, move-and-settle pattern
- **Keyboard** — `SendInput` with `KEYBDINPUT` + `KEYEVENTF_UNICODE`, full VK code map with macOS modifier mapping (`command` → `Win`, `option` → `Alt`)
- **Screenshot** — DXGI Desktop Duplication (cached device/staging texture) with GDI BitBlt fallback. 20ms median, 1.5x faster than Python dxcam
- **Clipboard** — Native `OpenClipboard`/`SetClipboardData` with retry logic. 31x faster than pywin32
- **Window management** — `EnumWindows` + `GetWindowText` + `SetForegroundWindow` with `AttachThreadInput`. 80-1000x faster than comtypes
- **UI Automation** — `IUIAutomation` COM with tree walking, element search, Invoke/Value/Toggle patterns, control type → AX role mapping
- **Display** — `EnumDisplayMonitors` + `GetDpiForMonitor` for multi-monitor support
- **Virtual Desktops** — Registry-based enumeration from `VirtualDesktopIDs` binary blob, works on Server 2022 + Win10 + Win11. Create/destroy via keyboard shortcuts
- **Clipboard** — Native Win32 `OpenClipboard`/`SetClipboardData` with 3-retry logic

### New tools (58 total, up from 46)
- **`filesystem`** — Read, write, copy, move, delete, list, search, info. Node.js `fs` based, cross-platform
- **`process_kill`** — List and kill processes by name or PID. `taskkill` on Windows, `kill`/`pkill` on macOS
- **`registry`** — Windows Registry get/set/delete/list via PowerShell. Accepts `HKCU:\...` paths
- **`notification`** — Windows toast notifications via `ToastNotificationManager`
- **`multi_select`** — Batch click with optional Ctrl hold. Resolves labels via `find_element`
- **`multi_edit`** — Batch click+type for form filling. Resolves labels via `find_element`
- **`scrape`** — HTTP fetch + HTML-to-text extraction
- **`resize_window`** — Resize/move windows by name, ID, or foreground
- **`snapshot`** — Combined screenshot + UI tree + window list + desktop info in one call, with annotation overlay and grid reference lines
- **`zoom`** — View a specific screen region at full native resolution. Crops without downscaling — ideal for reading small text. Matches Claude's `computer_20251124` zoom action
- **`create_agent_space`** — Create virtual desktop (Ctrl+Win+D on Windows)
- **`destroy_space`** — Close current virtual desktop (Ctrl+Win+F4 on Windows)

### Screenshot enhancements
- **PNG format support** — `quality: 0` produces lossless PNG. 45% faster encoding than JPEG with pixel-perfect quality
- **Coordinate validation** — clicks/moves to coordinates outside display bounds return a clear error with valid range
- **Box-filter downscaling** — smoother resize with better quality than nearest-neighbor, also faster

### Session layer cross-platform
- Platform detection (`IS_WINDOWS`/`IS_MACOS`) at initialization
- Session lock path: `%TEMP%` on Windows, `/tmp` on macOS
- CFRunLoop pump skipped on Windows (no-op `drainRunloop`)
- Clipboard: native Win32 on Windows, `pbcopy`/`pbpaste` on macOS
- Long-text typing: clipboard + `Ctrl+V` on Windows, clipboard + `Cmd+V` on macOS
- PowerShell scripting bridge: `run_script` accepts `language: "powershell"` on Windows, Base64 UTF-16LE encoding
- `get_app_dictionary` and `list_menu_bar` return `platform_unsupported` on Windows
- `get_tool_guide` returns Windows-specific recommendations (PowerShell, process names, filesystem tool)
- `get_app_capabilities` reports `powershell: true` on Windows
- `type` tool gains `clear`, `press_enter`, `caret_position` parameters
- `prepare_display` minimizes windows on Windows (vs hiding apps on macOS)
- Identifier mapping: bundle IDs on macOS, process names on Windows — transparent to callers

### Performance vs Windows-MCP (Python reference)
| Operation | Rust NAPI | Windows-MCP | Speedup |
|---|---|---|---|
| Screenshot (800px) | 20ms | 32ms | 1.6x |
| Clipboard round-trip | 0.7ms | 21ms | 30x |
| Window listing | 1.7ms | 165ms | 97x |
| Frontmost app | 0.2ms | 169ms | 845x |
| Memory (RSS) | 118MB | ~180MB | 1.5x less |

### Breaking changes
- `run_script` language enum now includes `"powershell"` (additive, not breaking for existing macOS users)
- `package.json` `os` field changed from `["darwin"]` to `["darwin", "win32"]`

## v5.2.0 (2026-04-25)

v5.2 adds three reliability primitives — **cross-process session lock**, **main-runloop pump during sessions**, and **`prepare_display` focus strategy** — plus a new **`focusRequired` metadata** surface so agents can reason about which tools actually need the target frontmost.

Architectural choice: we follow Claude Code's foreground-only contract. Opt-in background AX automation was explored and rejected as unreliable in the general case (Freeform, SwiftUI popovers, Electron apps). Use `run_script` (AppleScript/JXA) when you need true background work.

### New tools
- **`get_tool_metadata(tool_name)`** — Structured per-tool metadata: `{ focusRequired: "scripting" | "ax" | "cgevent" | "none", mutates: boolean }`. Every tool also carries `[focusRequired: X]` as a suffix in its description so agents that read descriptions can filter without a separate call.

### New focus strategy
- **`focus_strategy: "prepare_display"`** — Before activating the target, hide every regular running app except the target and the terminal host (plus anything in `COMPUTER_USE_PREPARE_KEEP_VISIBLE`). Defends against focus-stealing background apps (screenshot watchers, notification banners) that race your activation. The response payload gains a trailing JSON block with `hiddenBundleIds` so callers can restore the layout later.

### Reliability
- **Cross-process session lock** — `/tmp/.computer-use-mcp.lock` held via `O_EXCL` for the duration of any mutating tool call. Prevents two MCP servers from fighting over the cursor. Stale-PID recovery: a lock held by a dead PID is reclaimed automatically. Observation tools skip the lock and stay concurrent.
- **Main-runloop pump during sessions** — While a mutating tool is in flight, a 1 ms `setInterval` drains the main CFRunLoop via a new `drainRunloop()` NAPI export. Matches Claude Code's `drainRunLoop.ts` pattern. Keeps NSWorkspace KVO updates and `@MainActor` async continuations making progress under libuv. Pump is refcounted and `.unref()`-ed so it doesn't keep Node alive on its own.
- **`return await` fix in `doClick`** — Latent bug since v4: the outer `try/finally` in dispatch was firing before the click helper's Promise resolved, which broke any code relying on session state set inside the helper. Fixed by changing `return doClick(...)` to `return await doClick(...)` in the five click case branches.

### Native module
- **`prepare_display(target_bundle_id, keep_visible)`** — Hides every regular non-target app except the keep list. Returns only the bundles we newly hid (already-hidden apps are excluded from the return), so restore is idempotent.
- **`drain_runloop` exposed as `drainRunloop()` NAPI** — Previously internal only.

### Session layer changes
- **`MUTATING_TOOLS`** — An explicit set of tool names that acquire the session lock + pump. Observation tools (`get_*`, `list_*`, `find_*`, `screenshot`) skip both.
- **`FocusStrategy`** union extended with `'prepare_display'`.
- **`ensureFocusV4`** return type extended to `{ hiddenBundleIds?: string[] }`. Dispatch decorates the response when set.
- **`resolveKeepVisibleBundles()`** — Env (`COMPUTER_USE_PREPARE_KEEP_VISIBLE`) > `__CFBundleIdentifier` > `TERM_PROGRAM_BUNDLE_ID` > fallback `com.apple.Terminal`.
- **Lock disabled by default when a mock native is injected** (`opts.native` present). Keeps property-based tests out of the filesystem without requiring every test to opt out.

### Tests
- 78/78 tests pass (up from 61 in v5.1). 17 new tests: 7 lock/pump, 5 prepare_display, 5 metadata.
- 12/12 smoke probes pass. Expected tool count bumped from 45 to 46.

### Tool count
- 45 → 46 (added `get_tool_metadata`).

---

## v5.1.0 (2026-04-25)

v5.1 fixes a latent bug that made `list_running_apps` / `activate_app` return stale data after the server had been running a while, and adds a new `list_menu_bar` tool that exposes every menu item's keyboard shortcut — letting agents skip menu traversal and press `cmd+X` directly.

### Bug fixes
- **NSWorkspace staleness** — `NSWorkspace.runningApplications` is KVO-observed; its contents only refresh when the main run loop pumps notifications. Long-lived Node hosts never spin the run loop, so the array was frozen at process-start state — apps launched afterward were invisible to `list_running_apps`, and `activate_app` returned `not_running` for them. Fix: drain pending sources via `CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.0, true)` before each read. Affects `list_running_apps`, `activate_app`, `get_frontmost_app`, and (transitively) `ensureFocusV4` / focus recovery.

### New tools
- **`list_menu_bar`** — Full menu bar for any app, with per-item keyboard shortcuts. Renders `AXMenuItemCmdChar` + `AXMenuItemCmdModifiers` as `"cmd+shift+n"` style strings. Call this BEFORE `select_menu_item` to see what exists — agents can then press the shortcut directly (one keystroke) instead of walking the menu bar.

### Enhancements
- **Complete shortcut extraction** — `get_menu_bar` (native) / `list_menu_bar` (MCP) now honour the modifier bitmask (Shift=1, Option=2, Control=4, "no Cmd"=8) instead of just the character. Previously only the raw key was returned, losing modifier information.

### Tests
- 61/61 tests pass. 12/12 smoke probes pass (tool count expanded to 45).

---

## v5.0.0 (2026-04-25)

v5 adds a **semantic accessibility layer** and a **scripting bridge** on top of the coordinate-based v4 surface. Agents now have three ordered approaches to automate macOS — scripting first, accessibility second, coordinates last — with two new discovery tools (`get_tool_guide`, `get_app_capabilities`) that help the agent pick correctly before it ever takes a screenshot.

### New tools (14)

**Accessibility (observation):**
- **`get_ui_tree`** — Accessibility tree for a window. Returns role/label/value/bounds/actions/children per node. Capped at 500 nodes.
- **`get_focused_element`** — Currently focused UI element (where typed text will go). Returns null if nothing is focused.
- **`find_element`** — Search a window by role, label, or value (AND of provided criteria). Faster than walking the full tree.

**Accessibility (mutation, strict-focus by default):**
- **`click_element`** — Click by role + label. Falls back to coordinate click if AXPress is unsupported.
- **`set_value`** — Set a UI element's value directly (e.g. text field content). Avoids the click → type dance.
- **`press_button`** — Shortcut for `click_element` with `role=AXButton`.
- **`select_menu_item`** — Walk AXMenuBar and select an item by path. Returns `availableMenus` on miss for recovery.
- **`fill_form`** — Set multiple values in one call. Partial failures are reported per field without aborting the batch.

**Scripting bridge:**
- **`run_script`** — Execute AppleScript or JXA via bounded `osascript`. Fastest path for scriptable apps (Mail, Safari, Finder, Numbers, Music, Messages, Notes, Calendar). Bounded by `timeout_ms`.
- **`get_app_dictionary`** — Inspect a scriptable app's dictionary (suites, commands, classes). Cached; invalidates on PID change.

**Discovery:**
- **`get_tool_guide`** — Recommend the best approach for a task description. Call BEFORE committing to screenshot-and-click.
- **`get_app_capabilities`** — Probe an app: scriptable? accessible? running? hidden?

**Spaces (read-only):**
- **`list_spaces`** — List user Spaces grouped by display. Pure read via CGS.
- **`get_active_space`** — Currently active Space ID.

### Session layer changes
- **Target resolution extended** — `window_id` is now first-class alongside `target_app`. Stale window IDs are cleaned from session state automatically.
- **Strict focus defaults** — `set_value` and `fill_form` join the keyboard tools in defaulting to `strict` focus (they write text, so wrong-target writes are more damaging than wrong-target clicks).
- **Similarity-ranked errors** — When an element is not found, `find_element` / `click_element` / `press_button` return the closest available labels (Levenshtein-ranked) in the error payload.
- **Scripting dictionary cache** — `get_app_dictionary` parses `sdef` XML once per PID; cached results survive across calls.
- **Tool guide table** — 12-entry regex table maps task phrases ("send email", "fill form", "rename file") to the preferred approach.

### Native module changes
- **`native/src/accessibility.rs`** (new) — AXUIElement FFI: tree walker, `find_element`, `perform_action`, `set_element_value`, `get_menu_bar`, `press_menu_item`. `ax_copy_value_as_string` uses `CFGetTypeID` to safely read CFString/CFNumber/CFBoolean values without crashing on type mismatch.
- **`native/src/spaces.rs`** (new) — dlsym-resolved CGS/SkyLight symbols for Space enumeration. Read surface (`list_spaces`, `get_active_space`) is reliable.

### Disabled / removed
- **Space mutation tools (`create_agent_space`, `move_window_to_space`, `remove_window_from_space`, `destroy_space`)** are not exposed via MCP. CGS-created Spaces are orphaned on SIP-enabled Macs (not visible in Mission Control) and window moves silently no-op without elevated entitlements. Gesture-based (Mission Control "+" click) and AX-based approaches both proved unreliable — dispatch and native code remain in the codebase for possible future revival but are not routed through the server.

### Client API updates
- New typed methods: `getUITree()`, `getFocusedElement()`, `findElement()`, `clickElement()`, `setValue()`, `pressButton()`, `selectMenuItem()`, `fillForm()`, `runScript()`, `getAppDictionary()`, `getToolGuide()`, `getAppCapabilities()`, `listSpaces()`, `getActiveSpace()`.
- All v5 mutating methods accept `SemanticOpts` (`targetWindowId`, `focusStrategy`).

### Breaking changes
- Version bumped to 5.0.0.
- Space mutation tools removed from the MCP tool surface (clients that called `create_agent_space` etc. will now get "tool not found").
- Screenshot auto-targeting now cleans up stale window IDs from `TargetState` when the window is no longer on-screen.

### Tests
- 61 tests (v5-session.test.mjs adds 22 property-based + example-based tests covering observation read-only guarantees, mutating-tool provenance, strict-focus defaults, similarity errors, timeout behavior, dictionary caching, and graceful Spaces degradation).

---

## v4.0.0 (2026-04-03)

### New tools
- **`get_window`** — Look up a window by its CGWindowID. Returns `windowId`, `bundleId`, `displayName`, `pid`, `title`, `bounds`, `isOnScreen`, `isFocused`, and `displayId`. Does not mutate session state.
- **`get_cursor_window`** — Get the window currently under the mouse cursor. Returns the same fields as `get_window`, or null values if the cursor is over the desktop. Does not mutate session state.
- **`activate_app`** — Activate an app and return structured before/after diagnostics: `requestedBundleId`, `frontmostBefore`, `frontmostAfter`, `activated`, `reason`, and optional `suggestedRecovery`. Replaces guesswork with actionable failure data.
- **`activate_window`** — Raise a specific window by CGWindowID using AXUIElement API. Handles hidden-app recovery automatically (unhide → activate app → raise window → poll). Returns `windowId`, `activated`, `frontmostAfter`, and `reason`.

### New parameters on all input tools
- **`target_window_id`** (optional number) — CGWindowID to target. Takes precedence over `target_app`. Available on all 13 input tools: `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `scroll`, `type`, `key`, `hold_key`.
- **`focus_strategy`** (optional: `strict`, `best_effort`, `none`) — Controls focus acquisition behavior before input delivery. `strict` fails if the target cannot be confirmed frontmost (default for keyboard tools). `best_effort` attempts focus and proceeds regardless (default for pointer tools). `none` skips activation entirely.
- **`target_window_id`** on `screenshot` — Capture a specific window by CGWindowID. Takes precedence over `target_app`. Returns error (not fallback) if the window is not visible.

### Session layer changes
- **TargetState** replaces simple `targetApp: string` — now tracks `bundleId`, `windowId`, `establishedBy` (`'activation'` | `'pointer'` | `'keyboard'`), and `establishedAt` timestamp
- **Target resolution order**: `target_window_id` → `target_app` → current TargetState
- **Focus strategy dispatch**: per-call control over focus acquisition with `strict`/`best_effort`/`none`
- **Enhanced FocusFailure diagnostics** — structured JSON payload with `requestedWindowId`, `targetWindowVisible`, and `suggestedRecovery` (`"activate_window"`, `"unhide_app"`, or `"open_application"`)
- **Observation tools guarantee** — `screenshot`, `list_windows`, `get_window`, `get_frontmost_app`, and `get_cursor_window` never mutate TargetState

### Native module changes
- **CoreGraphics window enumeration** — `list_windows` now uses `CGWindowListCopyWindowInfo` directly from Rust via FFI, replacing the Swift subprocess (~200ms overhead eliminated)
- **`displayId` field** — all window records now include the `CGDirectDisplayID` of the display containing the window
- **AXUIElement window raise** — `activate_window` uses Accessibility API for window-level raise operations
- **Screenshot consolidation** — `window_id_for_bundle` in `screenshot.rs` replaced with native window enumeration; `take_screenshot` accepts optional `windowId` parameter directly

### Client API updates
- New typed methods: `getWindow()`, `getCursorWindow()`, `activateApp()`, `activateWindow()`
- All input methods (`click`, `doubleClick`, `rightClick`, `moveMouse`, `drag`, `type`, `key`, `scroll`) accept optional `{ targetWindowId, focusStrategy }` options
- `screenshot()` accepts optional `target_window_id` parameter
- Backward compatible — existing positional `targetApp` parameter preserved

### Bug fixes
- **Removed self-dependency** — `@zavora-ai/computer-use-mcp` no longer lists itself in `dependencies`

### Breaking changes
- Version bumped to 4.0.0
- `TargetState` replaces `targetApp` in session internals (no public API break — session is internal)
- Keyboard tools now default to `strict` focus strategy (previously best-effort). This may cause `FocusFailure` errors where v3 would silently send keystrokes to the wrong window. Use `focus_strategy: "best_effort"` to restore v3 behavior.

---

## v3.0.0 (2026-04-02)

### Features
- **Multi-provider screenshot sizing** — `provider` param on `screenshot` tool sets optimal width/quality per AI provider. Supported: `anthropic` (1024px), `openai` (1024px), `openai-low` (512px), `gemini` (768px), `llama` (1120px), `grok` (1024px), `mistral` (1024px), `qwen` (896px), `nova` (1024px), `deepseek-vl` (896px), `phi` (896px)
- **JPEG quality control** — `quality` param (1–100) on `screenshot` tool, passed through to `sips --setProperty formatOptions`. Default: 80
- **Non-vision model guard** — `COMPUTER_USE_VISION=false` env var (or `createComputerUseServer({ vision: false })`) makes `screenshot` return text metadata instead of image data, enabling text-only models (DeepSeek-V3, R1, etc.)
- **Server-wide provider default** — `COMPUTER_USE_PROVIDER` env var or `createComputerUseServer({ provider: 'gemini' })` sets the default for all screenshot calls
- **Screenshot deduplication** — consecutive identical screenshots return cached result without re-capturing
- **Animated drag** — ease-out-cubic at 60fps, distance-proportional duration (max 500ms). Fixes drag in canvas, scrollbar, and window-resize scenarios

### Reliability fixes
- **Move-and-settle before clicks** — all click operations now move the cursor first, wait 50ms for HID round-trip, then click. Fixes missed clicks on fast-rendering UIs
- **Clipboard-based typing** — text longer than 100 characters is typed via clipboard paste (save → write → verify → paste → restore) instead of CGEvent injection. Fixes long text in Electron apps, web inputs, and terminals

### Breaking changes
- `createComputerUseServer()` now accepts optional `ServerOptions` — backward compatible (no required params)
- Version bumped to 3.0.0

All notable changes to this project will be documented in this file.

## [2.0.4] - 2026-04-02

### Fixed
- `client.screenshot()` now accepts `width` and `target_app` parameters — previously they were silently dropped, causing full-screen captures even when a specific app window was requested.

## [2.0.3] - 2026-04-02

### Fixed
- Server entrypoint guard now matches the bin symlink path (`computer-use-mcp`), fixing MCP handshake timeout when running via global install.

## [2.0.2] - 2026-04-02

### Fixed
- Added `--prefer-offline` to npx invocation in README and mcp.json config to skip registry check on startup, preventing MCP handshake timeout on cached installs.

## [2.0.1] - 2026-04-02

### Added
- `screenshot` tool: `width` parameter — resizes output to specified pixel width using `sips`. Default: 1024px (reduces context size ~5× vs full resolution).
- `screenshot` tool: `target_app` parameter — captures only the target app's window using `screencapture -l <windowID>` instead of the full screen.
- TypeScript client `screenshot()` method updated to accept `{ width?, target_app? }`.

## [2.0.0] - 2026-04-01

### Added
- Initial public release with 24 tools: screenshot, mouse, keyboard, clipboard, app management, display info, and wait.
- Rust NAPI native module for in-process macOS API calls (no subprocess round-trips, no focus stealing).
- Full MCP server over stdio.
- Typed TypeScript client with in-process and stdio transport modes.
- Security hardening: two-layer input validation, no shell injection, temp file O_EXCL, bounded waits.
