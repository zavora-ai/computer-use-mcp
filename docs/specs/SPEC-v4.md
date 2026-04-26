# computer-use-mcp v4.0 — Reliable Desktop Control Spec

**Author:** James Karanja Maina, Zavora Technologies Ltd  
**Date:** April 2026  
**Status:** Draft

---

## 1. Purpose

`@zavora-ai/computer-use-mcp` is an MCP server for desktop control. It must remain:

- MCP-native
- client-neutral
- reliable enough for Codex, Claude Desktop, Cursor, VS Code, Kiro, and other MCP hosts

This spec addresses the next bottleneck after v3:

**the server can often see the right window, but it cannot reliably make that window receive input.**

That is the primary blocker for real-world adoption.

---

## 2. Problem Statement

The current server exposes screenshots, app activation, keyboard input, clipboard, and some pointer actions. That is necessary, but not sufficient.

In real desktop sessions, the server fails in several common cases:

1. `target_app` is too coarse
   - Many apps have multiple windows.
   - A model may identify one window visually but send input to another window in the same app.

2. Focus state is under-specified
   - The agent cannot ask which app or window is actually frontmost.
   - Errors like `Failed to focus com.apple.iWork.Numbers` are not actionable.

3. Input depends on app-level activation
   - The screenshot path can isolate a specific window.
   - The input path still relies on bundle-level foreground state.
   - This mismatch causes failures in split-screen and multi-window layouts.

4. The tool surface is too low-level for recovery
   - Raw screenshots plus click/type/key are enough for demos.
   - They are not enough for consistent autonomous recovery.

5. Desktop control is being asked to do too much
   - Computer use should be the fallback for tasks that cannot be handled more precisely by shell, browser, connectors, or app-specific integrations.

---

## 3. Design Principles

### 3.1 Client Neutrality

The server must not depend on Codex-specific behavior. It should speak standard MCP over `stdio` and behave consistently regardless of host.

### 3.2 Precise Tool First, GUI Last

Hosts and prompts should prefer:

1. structured connector / integration
2. shell / filesystem
3. browser-specific automation
4. desktop computer use

Desktop control remains the broadest and slowest fallback.

### 3.3 Window Targeting Over App Targeting

The correct abstraction is not only “which app?” but also “which window?”

### 3.4 Introspection Before Action

The agent must be able to inspect focus, windows, bounds, and activation status before it chooses an input action.

### 3.5 Structured Errors Over Generic Failures

Failures must help the model recover, not just stop.

### 3.6 Deterministic State

Observation tools must not silently mutate later action routing.

---

## 4. Competitive Direction

This spec is informed by the public behavior and documentation of stronger systems:

- Anthropic treats computer use as a broad fallback and explicitly prefers more precise tools first.
- Claude Code exposes app permission tiers and calls out lower reliability in multi-app and niche-app situations.
- Codex is moving toward a hybrid architecture: desktop control plus browser use, plugins, skills, and structured workflows.
- Browser Use succeeds on web tasks by giving the model structured browser state and session continuity instead of pure pixel control.

Implication:

**desktop computer use should not be designed as screenshot + coordinates only.**

It needs richer state and clearer recovery semantics.

Sources:

- [Anthropic computer use docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)
- [Claude Code Desktop docs](https://code.claude.com/docs/en/desktop)
- [Codex for (almost) everything](https://openai.com/index/codex-for-almost-everything/)
- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [Browser Use docs](https://docs.browser-use.com/open-source/introduction)
- [Browser Use GitHub](https://github.com/browser-use/browser-use)

---

## 5. v4 Goals

### 5.1 Primary Goals

- reliable focus acquisition
- explicit window targeting
- actionable failure diagnostics
- stable MCP behavior across hosts
- better recovery loops for agents

### 5.2 Non-Goals

- replacing browser-specific automation for web tasks
- replacing shell tools for file/system tasks
- building a full accessibility automation framework in one release

---

## 6. Proposed Tool Model

v4 introduces a layered surface.

### Layer A: Session and Focus Introspection

These tools expose current desktop state.

#### `get_frontmost_app`

Returns:

```json
{
  "bundleId": "com.apple.iWork.Numbers",
  "displayName": "Numbers",
  "pid": 99106
}
```

#### `list_windows`

Returns on-screen windows with:

- `window_id`
- `bundle_id`
- `display_name`
- `pid`
- `title`
- `bounds`
- `is_on_screen`
- `is_focused`
- `display_id`

#### `get_window`

Lookup by `window_id`.

#### `get_cursor_window`

Returns the window currently under the pointer.

### Layer B: Deterministic Activation

#### `activate_app`

Promotes the existing native activation path into a first-class MCP tool.

Input:

```json
{
  "bundle_id": "com.apple.iWork.Numbers",
  "timeout_ms": 3000
}
```

Output:

```json
{
  "requestedBundleId": "com.apple.iWork.Numbers",
  "frontmostBefore": "com.openai.codex",
  "frontmostAfter": "com.apple.iWork.Numbers",
  "activated": true,
  "reason": null
}
```

#### `activate_window`

Input:

```json
{
  "window_id": 12345,
  "timeout_ms": 3000
}
```

Output includes:

- `window_id`
- `activated`
- `frontmost_after`
- `reason`

### Layer C: Observation

#### `screenshot`

Keep the existing screenshot behavior, but add:

- `target_window_id?: number`
- fail closed if the requested target cannot be resolved
- never mutate session routing state

If both `target_window_id` and `target_app` are provided, `target_window_id` wins.

### Layer D: Input

All input tools gain:

- `target_window_id?: number`
- `target_app?: string`
- `focus_strategy?: "strict" | "best_effort" | "none"`

Resolution order:

1. `target_window_id`
2. `target_app`
3. current session target, only for mutating actions that explicitly established one

#### `focus_strategy`

- `strict`
  - fail if the requested target cannot be confirmed
- `best_effort`
  - try to recover and proceed if confirmation becomes good enough
- `none`
  - skip activation entirely and send input to the current frontmost target

Default:

- keyboard tools: `strict`
- pointer move/click tools: `best_effort`

---

## 7. Structured Error Model

All focus-related failures should return structured JSON in the text payload instead of only a plain string.

Example:

```json
{
  "error": "focus_failed",
  "requestedBundleId": "com.apple.iWork.Numbers",
  "requestedWindowId": null,
  "frontmostBefore": "com.openai.codex",
  "frontmostAfter": "com.openai.codex",
  "targetRunning": true,
  "targetHidden": false,
  "targetWindowVisible": true,
  "activationAttempted": true,
  "suggestedRecovery": "activate_window"
}
```

This gives the model a direct next step.

---

## 8. Native Requirements

### 8.1 Window Inventory

Add native window enumeration using CoreGraphics window APIs.

Required native functions:

- `listWindows()`
- `getWindow(windowId)`
- `getCursorWindow()`

### 8.2 Window Activation

App activation via `NSRunningApplication.activateWithOptions` is not enough.

v4 must add a window-level raise path where possible.

Expected recovery order:

1. unhide app if hidden
2. activate app
3. raise target window if identifiable
4. poll frontmost app/window
5. return structured failure if still unresolved

### 8.3 Focus Confirmation

Session code must confirm:

- frontmost app
- target window visibility
- optional target window match

before sending strict keyboard input.

---

## 9. Session Semantics

### 9.1 Observation Does Not Retarget

These tools must never change session routing:

- `screenshot`
- `list_windows`
- `get_window`
- `get_frontmost_app`
- `get_cursor_window`

### 9.2 Mutating Tools Can Retarget

These tools may establish session target state:

- `activate_app`
- `activate_window`
- `left_click`
- `left_click_drag`
- `type`
- `key`
- `hold_key`

### 9.3 Target State Shape

Session target state should become:

```ts
interface TargetState {
  bundleId?: string
  windowId?: number
  establishedBy: 'activation' | 'pointer' | 'keyboard'
  establishedAt: number
}
```

This replaces a single mutable `targetApp` string.

---

## 10. Tool Priority Guidance

The README and AGENTS documentation should explicitly guide agents and users:

- if a connector exists, use the connector first
- if a shell command solves it, use shell first
- if it is a web page, use browser automation first
- use computer use for native desktop apps, simulators, installers, modal dialogs, and UI-only workflows

This matches the strongest competitor pattern and reduces failure rates.

---

## 11. Testing Plan

### 11.1 MCP Compatibility Tests

Add stdio tests that:

- start the built server as a subprocess
- call `listTools()`
- assert the expected tool surface
- verify schemas for new fields like `target_window_id`

### 11.2 Session Tests

Add unit tests for:

- observation tools not mutating target state
- `target_window_id` taking precedence over `target_app`
- strict vs best-effort focus strategy
- structured error payloads

### 11.3 Native Integration Tests

Add real macOS smoke tests for:

- TextEdit typing
- Numbers data entry
- Safari or Chrome address bar focus
- split-screen / side-by-side windows
- hidden app recovery

### 11.4 Codex / Claude / Cursor Validation

For release QA, verify:

- Codex can mount and call the tool set over MCP
- Claude Desktop can register and use the same stdio server
- Cursor or VS Code MCP host sees the same tool schemas

The important check is not client-specific code. It is client-agnostic MCP compatibility.

---

## 12. Rollout Plan

### Phase 1: Introspection and Diagnostics

- expose `get_frontmost_app`
- add `list_windows`
- add structured focus errors
- add stdio compatibility tests

### Phase 2: Window-Aware Activation

- add `activate_window`
- add `target_window_id`
- add focus strategy controls

### Phase 3: Reliability Hardening

- hidden-app recovery
- window raise improvements
- split-screen tests
- Numbers / spreadsheet smoke tests

### Phase 4: Optional Higher-Level Helpers

These are not required for v4, but likely valuable:

- `select_menu`
- `list_menu_items`
- `paste_clipboard`
- spreadsheet helpers
- accessibility snapshot for focused app

---

## 13. Example v4 Flows

### 13.1 Safe Spreadsheet Entry

1. `open_application(bundle_id="com.apple.iWork.Numbers")`
2. `list_windows(bundle_id="com.apple.iWork.Numbers")`
3. `activate_window(window_id=...)`
4. `screenshot(target_window_id=...)`
5. `write_clipboard(...)`
6. `key(text="command+v", target_window_id=..., focus_strategy="strict")`

This is safer than app-level targeting only.

### 13.2 Recovery Loop

1. `key(..., target_window_id=...)`
2. receive `focus_failed` with structured diagnostics
3. call `activate_window(...)`
4. re-check with `get_frontmost_app`
5. retry input

---

## 14. Success Criteria

v4 is successful if:

- the agent can reliably control a visible target window in split-screen layouts
- input failures produce structured recovery data
- Codex, Claude Desktop, Cursor, and similar MCP hosts can use the same server unchanged
- native-app tasks like Numbers and TextEdit stop failing on focus more often than they fail on visual understanding

---

## 15. Summary

The next version of `computer-use-mcp` should not be “more screenshot tooling.”

It should be:

- window-aware
- introspectable
- deterministic
- recoverable
- MCP-standard

That is the path from a demo-quality computer use server to a production-quality MCP server that agents can trust.
