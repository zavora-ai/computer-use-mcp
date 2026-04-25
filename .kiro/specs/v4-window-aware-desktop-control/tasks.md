# Implementation Plan: v4 Window-Aware Desktop Control

## Overview

Upgrade `computer-use-mcp` from v3.0.0 to v4.0.0 with window-level targeting, introspection tools, configurable focus strategies, and structured error diagnostics. Implementation follows the phased approach from SPEC-v4 §12: native introspection first, then window-aware activation, then client/docs/packaging, then testing.

## Tasks

- [x] 1. Native Rust: Window enumeration module and CoreGraphics FFI
  - [x] 1.1 Create `native/src/windows.rs` with `list_windows` using CoreGraphics FFI
    - Implement `CGWindowListCopyWindowInfo` via raw FFI (the `core-graphics` crate doesn't expose it directly)
    - Use `core_foundation` for CFArray/CFDictionary traversal
    - Filter to layer-0 windows, resolve `bundleId` via `NSRunningApplication(processIdentifier:)`
    - Include `displayId` field from `kCGWindowBounds` display mapping
    - Return same shape as existing Swift implementation plus `displayId`
    - _Requirements: 11.1, 11.2, 11.4_

  - [x] 1.2 Implement `get_window(window_id)` in `native/src/windows.rs`
    - Query `CGWindowListCopyWindowInfo` and find the matching `kCGWindowNumber`
    - Return single window record or null if not found
    - _Requirements: 1.3_

  - [x] 1.3 Implement `get_cursor_window()` in `native/src/windows.rs`
    - Get cursor position via `CGEvent::mouseLocation` or existing `cursorPosition()`
    - Enumerate on-screen windows and find the topmost window whose bounds contain the cursor point
    - Return window record or null if cursor is over the desktop
    - _Requirements: 2.3_

  - [x] 1.4 Implement `activate_window(window_id, timeout_ms)` in `native/src/windows.rs`
    - Look up owning PID from `CGWindowListCopyWindowInfo`
    - Create `AXUIElementCreateApplication(pid)` reference
    - Enumerate `kAXWindowsAttribute` children, match by title + bounds
    - Call `AXUIElementPerformAction(kAXRaiseAction)` and `AXUIElementSetAttributeValue(kAXFrontmostAttribute)` as fallback
    - Link `ApplicationServices` framework (already in `build.rs`)
    - _Requirements: 4.2_

  - [x] 1.5 Register `mod windows;` in `native/src/lib.rs`
    - Add `mod windows;` to `native/src/lib.rs`
    - _Requirements: 11.1_

  - [x] 1.6 Remove Swift subprocess `list_windows` from `native/src/apps.rs`
    - Delete the `list_windows` function that spawns `swift -e` from `apps.rs`
    - The new `windows.rs` implementation replaces it
    - _Requirements: 11.1_

  - [x] 1.7 Consolidate `window_id_for_bundle` in `native/src/screenshot.rs`
    - Replace the Swift subprocess in `window_id_for_bundle` with a call to the native window enumeration
    - Add optional `window_id: Option<u32>` parameter to `take_screenshot` to bypass bundle-to-window lookup
    - When `window_id` is provided, use it directly with `screencapture -l`
    - _Requirements: 11.3, 5.1_

  - [x] 1.8 Update `native/Cargo.toml` if needed
    - Verify `core-graphics`, `core-foundation`, and `objc` crates are sufficient for AXUIElement FFI
    - Add `accessibility` or raw FFI declarations for AXUIElement if needed
    - _Requirements: 4.2_

- [x] 2. Checkpoint — Verify native module compiles
  - Run `npm run build:native` and ensure the Rust module compiles without errors
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. TypeScript: Update NativeModule interface and Session layer
  - [x] 3.1 Update `NativeModule` interface in `src/native.ts`
    - Add `getWindow(windowId: number)` returning window record or null
    - Add `getCursorWindow()` returning window record or null
    - Add `activateWindow(windowId: number, timeoutMs?: number)` returning `{ windowId, activated, reason }`
    - Update `listWindows` return type to include `displayId`
    - Update `takeScreenshot` signature to accept optional `windowId` parameter
    - _Requirements: 1.3, 2.3, 4.2, 11.2_

  - [x] 3.2 Implement `TargetState` and replace `targetApp` in `src/session.ts`
    - Define `TargetState` interface with `bundleId`, `windowId`, `establishedBy`, `establishedAt`
    - Define `FocusStrategy` type: `'strict' | 'best_effort' | 'none'`
    - Replace `let targetApp: string | undefined` with `let targetState: TargetState | undefined`
    - Update all references to `targetApp` to use `targetState.bundleId`
    - _Requirements: 8.1, 8.2, 8.3_

  - [x] 3.3 Implement target resolution logic in `src/session.ts`
    - Add `resolveTarget(args)` function: `target_window_id` → `target_app` → current `TargetState`
    - When `target_window_id` is provided, call `n.getWindow()` to resolve `bundleId`
    - Throw `WindowNotFoundError` if window ID is invalid
    - _Requirements: 5.2, 6.2, 6.3, 6.4_

  - [x] 3.4 Implement focus strategy dispatch in `src/session.ts`
    - Add `defaultStrategy(tool)` function: `strict` for keyboard tools, `best_effort` for pointer tools
    - Implement `ensureFocusV4(target, strategy)` replacing the existing `ensureFocus`
    - `strict`: confirm frontmost app + window on-screen, fail with FocusFailure if not
    - `best_effort`: attempt focus, proceed even if unconfirmed
    - `none`: skip all activation
    - Include hidden-app recovery sequence: unhide → activate → raise → poll → fail
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 12.1, 12.2, 12.3_

  - [x] 3.5 Enhance `FocusFailure` with window-level fields in `src/session.ts`
    - Add `requestedWindowId: number | null` field
    - Add `targetWindowVisible: boolean | null` field
    - Update `suggestedRecovery` to include `'activate_window'` option
    - Update `focusFailureText` to serialize all new fields
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 3.6 Add new tool dispatch cases in `src/session.ts`
    - `get_window`: call `n.getWindow(window_id)`, return JSON, do NOT mutate TargetState
    - `get_cursor_window`: call `n.getCursorWindow()`, return JSON, do NOT mutate TargetState
    - `activate_app`: capture frontmostBefore, call `n.activateApp()`, capture frontmostAfter, update TargetState on success, return structured response
    - `activate_window`: call `n.getWindow()` to resolve bundleId, attempt recovery sequence, call `n.activateWindow()`, update TargetState on success, return structured response
    - _Requirements: 1.1, 1.4, 2.1, 2.4, 3.1, 3.3, 4.1, 4.3, 4.4, 10.3, 10.4, 10.5_

  - [x] 3.7 Update existing tool dispatch to use new target resolution and focus strategy
    - Update all click tools to use `resolveTarget()` + `ensureFocusV4()` + `defaultStrategy()`
    - Update keyboard tools (`type`, `key`, `hold_key`) similarly
    - Update `scroll`, `mouse_move`, `left_click_drag`, `left_mouse_down`, `left_mouse_up`
    - Update `screenshot` to accept `target_window_id` and pass `windowId` to `takeScreenshot`
    - Ensure observation tools (`screenshot`, `list_windows`, `get_frontmost_app`) never mutate TargetState
    - Update TargetState with correct `establishedBy` on successful mutating tools
    - _Requirements: 5.1, 5.3, 5.4, 6.1, 6.2, 8.2, 10.1, 10.2_

- [x] 4. Checkpoint — Verify TypeScript compiles
  - Run `npm run build:ts` and ensure no type errors
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Server layer: Register new tools and update schemas
  - [x] 5.1 Register new MCP tools in `src/server.ts`
    - `get_window` with `window_id: z.number().int()` parameter
    - `get_cursor_window` with no parameters
    - `activate_app` with `bundle_id: z.string()` and optional `timeout_ms: z.number().int().positive()`
    - `activate_window` with `window_id: z.number().int()` and optional `timeout_ms: z.number().int().positive()`
    - _Requirements: 1.1, 2.1, 3.1, 4.1_

  - [x] 5.2 Update input tool schemas with `target_window_id` and `focus_strategy`
    - Add `target_window_id: z.number().int().optional()` to all input tools
    - Add `focus_strategy: z.enum(['strict', 'best_effort', 'none']).optional()` to all input tools
    - Update `screenshot` schema to include `target_window_id`
    - Update `withTargetApp` helper to `withTargeting` that includes all three params
    - _Requirements: 6.1, 7.1, 14.4_

  - [x] 5.3 Bump server version to 4.0.0
    - Change `McpServer({ name: 'computer-use', version: '4.0.0' })`
    - _Requirements: 15.2_

- [x] 6. Client layer: Add new methods and update signatures
  - [x] 6.1 Add new typed methods to `src/client.ts`
    - `getWindow(windowId: number)` → calls `get_window`
    - `getCursorWindow()` → calls `get_cursor_window`
    - `activateApp(bundleId: string, timeoutMs?: number)` → calls `activate_app`
    - `activateWindow(windowId: number, timeoutMs?: number)` → calls `activate_window`
    - _Requirements: 13.1, 13.2, 13.3, 13.4_

  - [x] 6.2 Update existing client method signatures
    - Add optional `opts?: { targetWindowId?: number; focusStrategy?: 'strict' | 'best_effort' | 'none' }` to `click`, `doubleClick`, `rightClick`, `moveMouse`, `drag`, `type`, `key`, `scroll`
    - Update `screenshot` to accept `target_window_id`
    - Preserve backward compatibility with existing positional `targetApp` parameter
    - _Requirements: 13.5, 13.6_

- [x] 7. Checkpoint — Full build and existing tests pass
  - Run `npm run build` (native + TypeScript)
  - Run `npm run test` and verify all existing tests still pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Documentation and packaging
  - [x] 8.1 Update `README.md`
    - Add tool priority guidance section (connector → shell → browser → desktop)
    - Update tool count from 24 to 28
    - Document new tools: `get_window`, `get_cursor_window`, `activate_app`, `activate_window`
    - Document new parameters: `target_window_id`, `focus_strategy`
    - Document focus strategy semantics (strict/best_effort/none)
    - Update architecture diagram to show window resolution path
    - _Requirements: 14.1, 14.3, 14.4_

  - [x] 8.2 Update `AGENTS.md`
    - Add tool priority guidance near the top
    - Add best practices for window-level targeting
    - Document `activate_window` recovery pattern
    - _Requirements: 14.2_

  - [x] 8.3 Update `package.json`
    - Set `version` to `"4.0.0"`
    - Remove self-dependency `"@zavora-ai/computer-use-mcp": "^3.0.0"` from `dependencies`
    - _Requirements: 15.1, 15.3_

  - [x] 8.4 Update `CHANGELOG.md`
    - Add v4.0.0 entry documenting all new tools, parameters, session changes, native module changes, and bug fixes
    - _Requirements: 15.4_

- [x] 9. Testing: Session layer property-based tests and unit tests
  - [x] 9.1 Install `fast-check` and write Property 1 test: Observation tools never mutate TargetState
    - Install `fast-check` as a dev dependency
    - Generate random sequences mixing observation and mutating tools
    - Verify TargetState only changes on mutating tools
    - **Property 1: Observation tools never mutate TargetState**
    - **Validates: Requirements 1.4, 2.4, 5.4, 10.1, 10.2, 10.3, 10.4, 10.5**

  - [x] 9.2 Write Property 2 test: Target resolution precedence
    - Generate random combinations of `target_window_id`, `target_app`, and session state
    - Verify `target_window_id` always wins over `target_app`
    - **Property 2: Target resolution precedence — window ID over app over session state**
    - **Validates: Requirements 5.2, 6.3, 8.3, 16.4**

  - [x] 9.3 Write Property 3 test: Input tool schema completeness
    - Verify all 13 input tools include `target_window_id` and `focus_strategy` in MCP schemas
    - **Property 3: Input tool schema completeness**
    - **Validates: Requirements 6.1, 7.1, 16.2**

  - [x] 9.4 Write Property 4 test: Strict focus strategy enforcement
    - Generate random targets with unconfirmed focus
    - Verify FocusFailure returned and input NOT delivered
    - **Property 4: Strict focus strategy enforcement**
    - **Validates: Requirements 7.2, 12.1, 12.2, 16.5**

  - [x] 9.5 Write Property 5 test: Best-effort focus strategy proceeds
    - Generate random targets with unconfirmed focus
    - Verify input IS delivered (no isError from focus alone)
    - **Property 5: Best-effort focus strategy proceeds on unconfirmed focus**
    - **Validates: Requirements 7.3**

  - [x] 9.6 Write Property 6 test: None focus strategy skips activation
    - Generate random targets with `focus_strategy: 'none'`
    - Verify no activation calls made, input delivered to current frontmost
    - **Property 6: None focus strategy skips activation**
    - **Validates: Requirements 7.4, 16.6**

  - [x] 9.7 Write Property 7 test: Default focus strategy by tool category
    - Generate random tool names from keyboard and pointer sets
    - Verify keyboard tools default to `strict`, pointer tools to `best_effort`
    - **Property 7: Default focus strategy by tool category**
    - **Validates: Requirements 7.5**

  - [x] 9.8 Write Property 8 test: TargetState establishedBy tracks tool category
    - Generate random mutating tool calls
    - Verify `establishedBy` matches tool category (activation/pointer/keyboard)
    - **Property 8: TargetState establishedBy tracks tool category**
    - **Validates: Requirements 8.2, 16.8**

  - [x] 9.9 Write Property 9 test: Successful mutating tools update TargetState correctly
    - Generate random successful tool calls with various target params
    - Verify TargetState contains correct `bundleId`, `windowId`, and `establishedAt`
    - **Property 9: Successful mutating tools update TargetState with correct fields**
    - **Validates: Requirements 3.3, 4.4, 6.2**

  - [x] 9.10 Write Property 10 test: FocusFailure diagnostic completeness
    - Generate random failure scenarios
    - Verify all required fields present in FocusFailure payload
    - **Property 10: FocusFailure diagnostic completeness**
    - **Validates: Requirements 9.1, 9.2, 16.7**

  - [x] 9.11 Write Property 11 test: FocusFailure suggestedRecovery correctness
    - Generate random app states (hidden/not running/visible)
    - Verify correct `suggestedRecovery` value for each state
    - **Property 11: FocusFailure suggestedRecovery correctness**
    - **Validates: Requirements 9.3, 9.4**

  - [x] 9.12 Write Property 13 test: Window filter correctness
    - Generate random window lists and filter values
    - Verify all results match the filter
    - **Property 13: Window filter correctness**
    - **Validates: Requirements 11.4**

  - [x] 9.13 Write unit tests for session edge cases
    - Hidden app recovery sequence (verify operation order via mock calls)
    - `activate_app` with `not_running` reason
    - `activate_app` with `hidden` reason and `suggestedRecovery`
    - `activate_window` with window not found
    - Screenshot with invalid `target_window_id` returns error (not fallback)
    - `get_cursor_window` with no window under cursor returns null fields
    - `timeout_ms` parameter passthrough to native module
    - _Requirements: 3.4, 3.5, 4.5, 5.3, 2.2_

- [x] 10. Testing: MCP schema and stdio tests
  - [x] 10.1 Add schema tests to `test/stdio.test.mjs`
    - Verify `get_window`, `get_cursor_window`, `activate_app`, `activate_window` present in `listTools`
    - Verify all input tools include `target_window_id` and `focus_strategy` in schemas
    - Verify server version is `4.0.0`
    - **Property 3: Input tool schema completeness** (example-based complement)
    - **Property 12: Tool response field completeness** (schema presence check)
    - _Requirements: 16.1, 16.2, 15.2_

- [x] 11. Final checkpoint — Full build and all tests pass
  - Run `npm run build` and `npm run test`
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation after each major phase
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The implementation language is TypeScript (session/server/client) and Rust (native module), matching the existing codebase
- Phase 1 (tasks 1–2) can be validated independently with `npm run build:native`
- Phase 2 (tasks 3–7) is the core session/server/client work
- Phase 3 (task 8) is docs and packaging
- Phase 4 (tasks 9–11) is testing
