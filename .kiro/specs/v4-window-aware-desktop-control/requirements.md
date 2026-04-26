# Requirements Document

## Introduction

This document specifies the requirements for upgrading `computer-use-mcp` from v3.0.0 to v4.0.0. The primary goal is to make the MCP server window-aware, introspectable, and recoverable so that AI agents can reliably target individual windows — not just apps — for input delivery. The upgrade addresses the core v3 limitation: the server can see the right window but cannot reliably make that window receive input, especially in multi-window and split-screen layouts.

The v4 upgrade spans four areas: new introspection and activation MCP tools, window-level targeting parameters on all existing tools, a richer session state model with structured error diagnostics, and native Rust module enhancements to replace Swift subprocess calls with direct CoreGraphics/AXUIElement APIs.

## Glossary

- **MCP_Server**: The `computer-use-mcp` MCP server process that registers tools, validates inputs via Zod schemas, and delegates to the Session layer
- **Session**: The stateful dispatch layer (`src/session.ts`) that manages target tracking, focus acquisition, and delegates to the Native_Module
- **Native_Module**: The Rust NAPI addon (`computer-use-napi.node`) that calls macOS CoreGraphics, NSWorkspace, and AXUIElement APIs in-process
- **TargetState**: The session-level record tracking the current target context including `bundleId`, `windowId`, `establishedBy`, and `establishedAt`
- **FocusFailure**: A structured JSON error payload returned when the Session cannot confirm that the requested target is frontmost and ready to receive input
- **Focus_Strategy**: A per-call parameter (`strict`, `best_effort`, or `none`) controlling how aggressively the Session attempts and verifies focus acquisition before delivering input
- **CGWindowID**: The macOS CoreGraphics integer identifier for an on-screen window, unique system-wide at any point in time
- **Observation_Tool**: An MCP tool that reads desktop state without mutating session routing (e.g., `screenshot`, `list_windows`, `get_window`, `get_frontmost_app`, `get_cursor_window`)
- **Mutating_Tool**: An MCP tool that may establish or change the session TargetState (e.g., `activate_app`, `activate_window`, `left_click`, `key`, `type`)
- **Tool_Priority_Guidance**: Documentation advising agents to prefer connectors, shell, and browser automation before falling back to desktop computer use
- **Client_API**: The typed TypeScript client (`src/client.ts`) providing convenience methods over the raw MCP `callTool` interface

## Requirements

### Requirement 1: Window Lookup by CGWindowID

**User Story:** As an AI agent, I want to look up a specific window by its CGWindowID, so that I can inspect its properties before deciding to target it for input.

#### Acceptance Criteria

1. WHEN a `get_window` tool call is received with a valid `window_id` parameter, THE MCP_Server SHALL return a JSON object containing `windowId`, `bundleId`, `displayName`, `pid`, `title`, `bounds`, `isOnScreen`, `isFocused`, and `displayId` for that window
2. WHEN a `get_window` tool call is received with a `window_id` that does not match any on-screen window, THE MCP_Server SHALL return an error response with `isError: true` and a descriptive message
3. THE Native_Module SHALL implement a `getWindow(windowId: number)` function that queries CoreGraphics window APIs directly without spawning a Swift subprocess
4. THE `get_window` tool SHALL NOT mutate the Session TargetState

### Requirement 2: Cursor Window Discovery

**User Story:** As an AI agent, I want to discover which window is currently under the mouse pointer, so that I can understand what the user is looking at and target that window for input.

#### Acceptance Criteria

1. WHEN a `get_cursor_window` tool call is received, THE MCP_Server SHALL return a JSON object containing `windowId`, `bundleId`, `displayName`, `pid`, `title`, `bounds`, `isOnScreen`, `isFocused`, and `displayId` for the window under the current cursor position
2. WHEN no window is found under the cursor position (e.g., cursor is over the desktop), THE MCP_Server SHALL return a JSON object with null values for window-specific fields
3. THE Native_Module SHALL implement a `getCursorWindow()` function that combines `cursorPosition()` with CoreGraphics window enumeration and point-in-bounds checking
4. THE `get_cursor_window` tool SHALL NOT mutate the Session TargetState

### Requirement 3: Dedicated App Activation Tool with Structured Diagnostics

**User Story:** As an AI agent, I want a dedicated `activate_app` MCP tool that returns structured before/after state, so that I can verify activation succeeded and diagnose failures.

#### Acceptance Criteria

1. WHEN an `activate_app` tool call is received with a `bundle_id` parameter, THE MCP_Server SHALL return a JSON object containing `requestedBundleId`, `frontmostBefore`, `frontmostAfter`, `activated` (boolean), and `reason` (null on success, string on failure)
2. WHEN the `activate_app` tool call includes an optional `timeout_ms` parameter, THE Session SHALL use that value as the activation polling timeout instead of the default
3. WHEN activation succeeds, THE Session SHALL update the TargetState with the activated app's `bundleId` and `establishedBy: 'activation'`
4. WHEN activation fails because the app is not running, THE MCP_Server SHALL return `activated: false` with `reason: "not_running"`
5. WHEN activation fails because the app is hidden, THE MCP_Server SHALL return `activated: false` with `reason: "hidden"` and `suggestedRecovery: "unhide_app"`

### Requirement 4: Window-Level Activation

**User Story:** As an AI agent, I want to activate and raise a specific window by its CGWindowID, so that I can reliably direct input to the correct window in multi-window layouts.

#### Acceptance Criteria

1. WHEN an `activate_window` tool call is received with a `window_id` parameter, THE MCP_Server SHALL attempt to raise that specific window and return a JSON object containing `windowId`, `activated` (boolean), `frontmostAfter`, and `reason`
2. THE Native_Module SHALL implement an `activateWindow(windowId: number)` function using AXUIElement API for window-level raise operations
3. WHEN the target window's app is hidden, THE Session SHALL first unhide the app, then activate the app, then raise the target window, then poll for confirmation
4. WHEN activation succeeds, THE Session SHALL update the TargetState with both the `bundleId` and `windowId`, and set `establishedBy: 'activation'`
5. WHEN the window cannot be found or raised, THE MCP_Server SHALL return `activated: false` with a structured reason

### Requirement 5: Window-Level Screenshot Targeting

**User Story:** As an AI agent, I want to capture a screenshot of a specific window by its CGWindowID, so that I can observe exactly the window I intend to interact with.

#### Acceptance Criteria

1. WHEN a `screenshot` tool call includes a `target_window_id` parameter, THE MCP_Server SHALL capture only that specific window using `screencapture -l <windowId>`
2. WHEN both `target_window_id` and `target_app` are provided, THE MCP_Server SHALL use `target_window_id` and ignore `target_app`
3. WHEN the `target_window_id` does not correspond to a visible on-screen window, THE MCP_Server SHALL return an error response with `isError: true` instead of falling back to full-screen capture
4. THE `screenshot` tool SHALL NOT mutate the Session TargetState regardless of whether `target_window_id` or `target_app` is specified

### Requirement 6: Window-Level Input Targeting

**User Story:** As an AI agent, I want to specify a `target_window_id` on all input tools, so that I can direct clicks, keystrokes, and scrolls to a specific window rather than just an app.

#### Acceptance Criteria

1. THE MCP_Server SHALL accept an optional `target_window_id` parameter (number) on all input tools: `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `scroll`, `type`, `key`, and `hold_key`
2. WHEN `target_window_id` is provided, THE Session SHALL resolve the owning app's `bundleId` from the window and use that for focus acquisition, then update TargetState with both `bundleId` and `windowId`
3. WHEN both `target_window_id` and `target_app` are provided on the same call, THE Session SHALL use `target_window_id` and ignore `target_app`
4. WHEN `target_window_id` is provided but the window cannot be found, THE Session SHALL return a FocusFailure with `requestedWindowId` set

### Requirement 7: Focus Strategy Parameter

**User Story:** As an AI agent, I want to control how aggressively the server acquires focus before delivering input, so that I can choose between strict verification, best-effort recovery, or skipping activation entirely.

#### Acceptance Criteria

1. THE MCP_Server SHALL accept an optional `focus_strategy` parameter with values `strict`, `best_effort`, or `none` on all input tools
2. WHEN `focus_strategy` is `strict`, THE Session SHALL fail with a FocusFailure if the requested target cannot be confirmed as frontmost before delivering input
3. WHEN `focus_strategy` is `best_effort`, THE Session SHALL attempt focus acquisition and proceed with input delivery even if full confirmation is not achieved
4. WHEN `focus_strategy` is `none`, THE Session SHALL skip all activation and send input to the current frontmost target
5. WHEN `focus_strategy` is not specified, THE Session SHALL default to `strict` for keyboard tools (`type`, `key`, `hold_key`) and `best_effort` for pointer tools (`left_click`, `right_click`, `middle_click`, `double_click`, `triple_click`, `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`, `scroll`)

### Requirement 8: Rich Session TargetState

**User Story:** As a developer maintaining the session layer, I want the session to track both app and window targeting with provenance metadata, so that the dispatch logic can make informed decisions about focus reuse.

#### Acceptance Criteria

1. THE Session SHALL replace the simple `targetApp: string` state with a `TargetState` object containing `bundleId` (optional string), `windowId` (optional number), `establishedBy` (`'activation'`, `'pointer'`, or `'keyboard'`), and `establishedAt` (timestamp)
2. WHEN a Mutating_Tool establishes a new target, THE Session SHALL record the `establishedBy` field based on the tool category: `'activation'` for `activate_app` and `activate_window`, `'pointer'` for click and drag tools, `'keyboard'` for `type`, `key`, and `hold_key`
3. THE Session SHALL use the target resolution order: explicit `target_window_id` parameter first, then explicit `target_app` parameter, then current TargetState — only for Mutating_Tools that previously established a target

### Requirement 9: Enhanced Structured Error Model

**User Story:** As an AI agent, I want focus failure errors to include window-level diagnostic fields, so that I can choose the correct recovery action (e.g., `activate_window` instead of `open_application`).

#### Acceptance Criteria

1. WHEN a focus failure occurs, THE Session SHALL return a FocusFailure JSON payload containing `requestedWindowId` (number or null) in addition to the existing fields
2. WHEN a focus failure occurs and a `target_window_id` was requested, THE Session SHALL include `targetWindowVisible` (boolean) indicating whether the requested window is currently on-screen
3. THE FocusFailure payload SHALL include `suggestedRecovery` with value `"activate_window"` when the target window is visible but the app is not frontmost
4. THE FocusFailure payload SHALL include `suggestedRecovery` with value `"unhide_app"` when the target app is hidden, and `"open_application"` when the target app is not running

### Requirement 10: Observation Tools Non-Mutation Guarantee

**User Story:** As an AI agent, I want to be certain that observation tools never change which app or window receives my next input, so that I can safely introspect desktop state between actions.

#### Acceptance Criteria

1. THE `screenshot` tool SHALL NOT modify the Session TargetState regardless of `target_app` or `target_window_id` parameters
2. THE `list_windows` tool SHALL NOT modify the Session TargetState
3. THE `get_window` tool SHALL NOT modify the Session TargetState
4. THE `get_frontmost_app` tool SHALL NOT modify the Session TargetState
5. THE `get_cursor_window` tool SHALL NOT modify the Session TargetState

### Requirement 11: Native Window Enumeration via CoreGraphics

**User Story:** As a developer, I want the `list_windows` implementation to use CoreGraphics APIs directly in Rust instead of spawning a Swift subprocess, so that window enumeration is faster and does not incur ~200ms subprocess overhead.

#### Acceptance Criteria

1. THE Native_Module SHALL implement `listWindows(bundleId?: string)` using `CGWindowListCopyWindowInfo` called directly from Rust via the `core-graphics` crate, replacing the current Swift subprocess implementation in `apps.rs`
2. THE Native_Module SHALL include a `displayId` field in each window record returned by `listWindows`
3. THE Native_Module SHALL consolidate the Swift subprocess in `screenshot.rs` (`window_id_for_bundle`) to use the same native window enumeration path
4. WHEN a `bundle_id` filter is provided, THE Native_Module SHALL return only windows belonging to that app

### Requirement 12: Focus Confirmation for Strict Keyboard Input

**User Story:** As an AI agent, I want the server to confirm both frontmost app and target window visibility before delivering strict keyboard input, so that keystrokes are not lost to the wrong window.

#### Acceptance Criteria

1. WHEN `focus_strategy` is `strict` and a keyboard tool is dispatched, THE Session SHALL confirm that the frontmost app matches the target before delivering input
2. WHEN `focus_strategy` is `strict` and a `target_window_id` is specified, THE Session SHALL additionally confirm that the target window is on-screen before delivering input
3. WHEN the target app is hidden, THE Session SHALL attempt the recovery sequence: unhide the app, activate the app, raise the target window, poll for confirmation, and return a structured FocusFailure if still unresolved

### Requirement 13: TypeScript Client API Updates

**User Story:** As a developer using the typed client, I want convenience methods for the new v4 tools and updated signatures for existing methods, so that I can use window-level targeting without dropping to raw `callTool`.

#### Acceptance Criteria

1. THE Client_API SHALL expose a `getWindow(windowId: number)` method that calls the `get_window` MCP tool
2. THE Client_API SHALL expose a `getCursorWindow()` method that calls the `get_cursor_window` MCP tool
3. THE Client_API SHALL expose an `activateApp(bundleId: string, timeoutMs?: number)` method that calls the `activate_app` MCP tool and returns the structured diagnostics
4. THE Client_API SHALL expose an `activateWindow(windowId: number, timeoutMs?: number)` method that calls the `activate_window` MCP tool
5. THE Client_API SHALL update all existing input methods (`click`, `doubleClick`, `rightClick`, `moveMouse`, `drag`, `type`, `key`, `scroll`) to accept optional `targetWindowId` and `focusStrategy` parameters
6. THE Client_API SHALL update the `screenshot` method to accept an optional `target_window_id` parameter

### Requirement 14: Tool Priority Documentation

**User Story:** As an AI agent developer, I want the README and AGENTS.md to explicitly guide tool selection priority, so that agents prefer more precise tools before falling back to desktop control.

#### Acceptance Criteria

1. THE README SHALL include a section documenting tool priority guidance: connector/integration first, shell/filesystem second, browser automation third, desktop computer use fourth
2. THE AGENTS.md SHALL include the same tool priority guidance near the top of the document
3. THE README SHALL update the tool count from 24 to reflect the new v4 tool surface (28 tools)
4. THE README SHALL document all new tools (`get_window`, `get_cursor_window`, `activate_app`, `activate_window`), new parameters (`target_window_id`, `focus_strategy`), and the focus strategy semantics

### Requirement 15: Version Bump and Bug Fixes

**User Story:** As a package maintainer, I want the version bumped to 4.0.0 and known bugs fixed, so that the release is clean and the package metadata is correct.

#### Acceptance Criteria

1. THE `package.json` SHALL have its `version` field set to `"4.0.0"`
2. THE MCP_Server SHALL report version `'4.0.0'` in its server metadata
3. THE `package.json` SHALL NOT contain a self-dependency on `@zavora-ai/computer-use-mcp` in its `dependencies` field
4. THE CHANGELOG SHALL include a v4.0.0 entry documenting all new tools, parameters, session changes, native module changes, and bug fixes

### Requirement 16: MCP Schema and Stdio Compatibility Tests

**User Story:** As a developer, I want automated tests verifying that the MCP tool schemas include all v4 fields and that the stdio transport works correctly with the new tools, so that MCP host compatibility is validated.

#### Acceptance Criteria

1. WHEN the stdio test suite runs, THE test SHALL verify that `get_window`, `get_cursor_window`, `activate_app`, and `activate_window` tools are present in the `listTools` response
2. WHEN the stdio test suite runs, THE test SHALL verify that input tools include `target_window_id` and `focus_strategy` in their schemas
3. WHEN the session test suite runs, THE test SHALL verify that all Observation_Tools (`screenshot`, `list_windows`, `get_window`, `get_frontmost_app`, `get_cursor_window`) do not mutate the Session TargetState
4. WHEN the session test suite runs, THE test SHALL verify that `target_window_id` takes precedence over `target_app` in target resolution
5. WHEN the session test suite runs, THE test SHALL verify that `focus_strategy: strict` returns a FocusFailure when the target cannot be confirmed
6. WHEN the session test suite runs, THE test SHALL verify that `focus_strategy: none` skips activation and delivers input to the current frontmost target
7. WHEN the session test suite runs, THE test SHALL verify that the enhanced FocusFailure payload includes `requestedWindowId`, `targetWindowVisible`, and `suggestedRecovery: "activate_window"` fields
8. WHEN the session test suite runs, THE test SHALL verify that TargetState tracks `bundleId`, `windowId`, and `establishedBy` correctly across tool sequences
