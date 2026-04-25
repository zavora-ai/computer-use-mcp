# Changelog

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
