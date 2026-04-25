# Implementation Plan: v5 Accessible UI Automation

## Overview

Upgrade `computer-use-mcp` from v4.0.0 to v5.0.0 by adding three faster-than-coordinates automation paths: Accessibility actions, an AppleScript/JXA scripting bridge, and a tool strategy advisor. Implementation follows a phased approach: native accessibility first, then scripting bridge, then semantic session dispatch, then advisor/capabilities, then Spaces (best effort), then docs/tests.

Each phase ends in a checkpoint that runs `npm run build` and `npm run test` to keep the tree green. Tasks reference the requirements they satisfy for traceability.

## Tasks

- [ ] 1. Native Rust: Accessibility tree walker and semantic action primitives
  - [ ] 1.1 Create `native/src/accessibility.rs` with shared AX FFI helpers
    - Extract the existing AX FFI declarations from `windows.rs` into a shared helper module (or re-use via `pub(crate)`)
    - Add a private helper `ax_window_for_cg_window(window_id: u32) -> Option<AXUIElementRef>` that replicates the CG → AX window match logic from `activate_window` (PID lookup, `AXWindows` enumeration, title/bounds match)
    - Add AX attribute key constants: `AXChildren`, `AXRole`, `AXTitle`, `AXDescription`, `AXValue`, `AXPosition`, `AXSize`, `AXFocusedUIElement`, `AXMenuBar`, `AXEnabled`, `AXMenuItemCmdChar`
    - Add `AXUIElementCopyActionNames` and `AXUIElementIsAttributeSettable` FFI declarations
    - _Requirements: 18.7_

  - [ ] 1.2 Implement `get_ui_tree(window_id, max_depth?)` in `native/src/accessibility.rs`
    - Resolve `window_id` → `AXUIElementRef` via the shared helper
    - Depth-first walk reading `AXRole`, `AXTitle`/`AXDescription`, `AXValue`, `AXPosition`, `AXSize`, `AXActionNames`, `AXChildren` per node
    - Apply pruning: skip `AXUnknown` children, collapse single-child unlabeled `AXGroup`, truncate `AXValue` to 500 chars
    - Enforce caps: `max_depth` (default 10, max 20) and hard cap of 500 total nodes
    - Mark `truncated: true` when either cap is hit
    - Return `{ role, label, value, bounds, actions, children }` as `serde_json::Value`
    - _Requirements: 1.1, 1.2, 1.6, 18.1_

  - [ ] 1.3 Implement `get_focused_element()` in `native/src/accessibility.rs`
    - Create system-wide AX element via `AXUIElementCreateSystemWide()`
    - Copy `AXFocusedUIElement` attribute
    - Extract role/label/value/bounds/actions; resolve owning `windowId` by walking up `AXParent` until a node with `AXRole = "AXWindow"` is found, then matching it to a `CGWindowID` via the shared helper
    - Return `null` when no element is focused
    - _Requirements: 2.1, 2.2, 2.3, 18.2_

  - [ ] 1.4 Implement `find_element(window_id, role?, label?, value?, max_results?)`
    - Walk the AX tree (same traversal as `get_ui_tree` but not materialized into JSON)
    - Filter by AND of provided criteria; case-insensitive substring match for `label`/`value`, exact match for `role`
    - Track `path` indices from root for each match
    - Stop at `max_results` (default 25, max 100)
    - Return array of `{ role, label, value, bounds, actions, path }`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 18.3_

  - [ ] 1.5 Implement `perform_action(window_id, role, label, action)`
    - Find the first matching element by (role, label) with same matching rules as `find_element`
    - If the element does not expose `action` in `AXActionNames`, return `{ performed: false, reason: "unsupported_action", bounds }`
    - If the element's `AXEnabled` is false, return `{ performed: false, reason: "disabled", bounds }`
    - Call `AXUIElementPerformAction`; return `{ performed: true }` on `kAXErrorSuccess`, else `{ performed: false, reason: "ax_error:<code>" }`
    - _Requirements: 4.1, 4.2, 6.1, 6.3, 18.4_

  - [ ] 1.6 Implement `set_element_value(window_id, role, label, value)`
    - Find the first matching element
    - Call `AXUIElementIsAttributeSettable(elem, kAXValueAttribute, &settable)`; if false, return `{ set: false, reason: "read_only" }`
    - Convert the Rust `String` to a `CFString` and call `AXUIElementSetAttributeValue(elem, kAXValueAttribute, cfstr)`
    - Return `{ set: true }` on success, `{ set: false, reason: "ax_error:<code>" }` otherwise
    - _Requirements: 5.1, 5.2, 18.5_

  - [ ] 1.7 Implement `get_menu_bar(bundle_id)`
    - Resolve bundle_id → PID via `NSRunningApplication`
    - Create `AXUIElementCreateApplication(pid)` and read `AXMenuBar` attribute
    - Walk children (top-level menus), for each menu walk its menu items
    - Return nested `{ title, enabled, shortcut?, items: [...] }` — `shortcut` from `AXMenuItemCmdChar` + modifiers when present
    - _Requirements: 7.1, 18.6_

  - [ ] 1.8 Implement `press_menu_item(bundle_id, menu, item, submenu?)`
    - Walk `AXMenuBar` to find matching top-level menu (exact match on title)
    - When `submenu` provided, walk the menu's items to find the submenu and descend
    - Find the target item by title
    - Return `{ pressed: false, reason: "menu_not_found" }`, `{ pressed: false, reason: "item_not_found" }`, or `{ pressed: false, reason: "item_disabled" }` per failure
    - On success, call `AXUIElementPerformAction(item, kAXPressAction)` and return `{ pressed: true }`
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ] 1.9 Add structured accessibility-denied error
    - Detect `kAXErrorNotAuthorized` (or `kAXErrorAPIDisabled`) at every AX call site
    - Return `napi::Error::from_reason("accessibility_permission_denied: Grant Accessibility permission in System Settings > Privacy & Security > Accessibility")`
    - Applies to `get_ui_tree`, `get_focused_element`, `find_element`, `perform_action`, `set_element_value`, `get_menu_bar`, `press_menu_item`
    - _Requirements: (Design §Error Handling)_

  - [ ] 1.10 Create `native/src/spaces.rs` with private-API probe
    - Use `libc::dlsym` (via `libloading` or raw `dlopen`) to look up `CGSMainConnectionID`, `CGSGetActiveSpace`, `CGSAddWindowsToSpaces`, `CGSRemoveWindowsFromSpaces`, `CGSManagedDisplaySetCurrentSpace` from `/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics` and `/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight`
    - Cache `supported: bool` per process; if any required symbol is missing, all Space calls return `{ supported: false, reason: "api_unavailable" }`
    - Implement `create_agent_space()` — when supported, use the private API to add a new Space; otherwise return the unsupported shape
    - Implement `move_window_to_space(window_id, space_id)` — resolve the window's owning `CGSWindowID`, call `CGSMoveWindowsToManagedSpace`
    - Return `{ moved: true }` or `{ moved: false, reason: "window_not_found"|"space_not_found"|"api_unavailable" }`
    - _Requirements: 11.1, 11.2, 11.3, 12.1, 12.2, 12.3, 12.4_

  - [ ] 1.11 Register new modules in `native/src/lib.rs`
    - Add `mod accessibility;` and `mod spaces;`
    - _Requirements: 18.1, 11.1, 12.1_

  - [ ] 1.12 Update `native/Cargo.toml` if needed
    - Add `libloading = "0.8"` for `dlsym`-based private API resolution if the raw `libc::dlsym` path proves awkward
    - Confirm AX and CGS declarations don't need additional frameworks beyond already-linked `ApplicationServices` and `CoreGraphics`
    - _Requirements: 18.7_

- [ ] 2. Checkpoint — Native builds cleanly
  - Run `npm run build:native`; ensure all AX and Spaces FFI declarations compile and link
  - Smoke-test manually: `node -e "const n = require('./computer-use-napi.node'); console.log(n.getFocusedElement())"` should return `null` or an element without throwing
  - If any questions surface about AX attribute shapes, ask the user before moving on

- [ ] 3. TypeScript: NativeModule interface updates
  - [ ] 3.1 Update `NativeModule` interface in `src/native.ts`
    - Define `AXElement` and `MenuItem` types (see Design §Updated NativeModule TypeScript Interface)
    - Add method signatures: `getUiTree`, `getFocusedElement`, `findElement`, `performAction`, `setElementValue`, `getMenuBar`, `pressMenuItem`, `createAgentSpace`, `moveWindowToSpace`
    - Export `AXElement` and `MenuItem` so the session layer and client can import them
    - _Requirements: 18.1–18.7, 11.1, 12.1_

- [ ] 4. Session layer: Scripting bridge and dictionary cache
  - [ ] 4.1 Add `spawnBounded` helper to `src/session.ts`
    - Wrap `child_process.execFile` with a promise + `setTimeout` kill switch
    - On timeout, send SIGKILL and resolve with `{ stdout, stderr, code: -1, timedOut: true }`
    - Expose via `SessionOptions.spawnBounded?` for test injection
    - _Requirements: 8.3, 8.4, 9.3, Design §Scripting Bridge_

  - [ ] 4.2 Implement `runScript(language, script, timeoutMs)` helper
    - `applescript` → `osascript -e <script>`
    - `javascript` → `osascript -l JavaScript -e <script>`
    - Clamp `timeoutMs` to `[100, 120000]`; default 30000
    - Capture stdout/stderr/code; trim trailing newline on success stdout
    - Test seam: use `opts.spawnBounded ?? defaultSpawnBounded`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 9.3_

  - [ ] 4.3 Implement `ScriptingDictionaryCache` and `getAppDictionary`
    - Add module-scoped `Map<bundleId, { pid: number; dict: ScriptingDictionary }>` cache
    - Look up app path via `mdfind "kMDItemCFBundleIdentifier == '<id>'"` (first result); fall back to `NSWorkspace.urlForApplicationWithBundleIdentifier`
    - Spawn `sdef <path>` (10 s timeout) and parse XML with a minimal regex extractor: `<suite name="...">`, `<command name="...">`, `<class name="...">`
    - When `suite` arg present, return only that suite (full details)
    - When `suite` absent, return summarized (names only, no properties/descriptions)
    - Invalidate cache entry when the running PID for `bundleId` differs from the cached PID
    - _Requirements: 10.1, 10.2, 10.3, 10.5_

- [ ] 5. Session layer: Semantic action dispatch
  - [ ] 5.1 Update `defaultStrategy` in `src/session.ts`
    - Add `'set_value'` and `'fill_form'` to the `keyboardTools` list so they default to `strict`
    - `click_element`, `press_button`, `select_menu_item` remain best-effort
    - _Requirements: 5.5, 15.6, 4.5_

  - [ ] 5.2 Update `resolveTarget` to accept `window_id` (v5 first-class name)
    - When `args.window_id` is a number, treat it identically to `target_window_id`
    - Preserve precedence: `window_id` | `target_window_id` > `target_app` > session state
    - _Requirements: 4.1, 5.1, 6.1, 15.1_

  - [ ] 5.3 Add Levenshtein `similarLabelsError` helper in `src/session.ts`
    - Inline ~20-line Levenshtein distance implementation
    - Call `n.findElement(windowId, roleFilter, undefined, undefined, 500)`, rank by distance, take top 5
    - Return `{ isError: true, content: [{ type: 'text', text: JSON.stringify({ error, similar }) }] }`
    - _Requirements: 4.3, 5.3, 6.2_

  - [ ] 5.4 Implement `click_element` dispatch case
    - Resolve target from `window_id`, apply focus strategy (default `best_effort`)
    - Call `n.performAction(windowId, role, label, 'AXPress')`
    - On `unsupported_action` with `bounds`: fall back to coordinate click at element center
    - On not found: return `similarLabelsError` result
    - On disabled: return `{ isError: true, text: "Button/element is disabled" }`
    - Update TargetState with `establishedBy: 'pointer'`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ] 5.5 Implement `set_value` dispatch case
    - Resolve target, apply focus strategy (default `strict`)
    - Call `n.setElementValue(windowId, role, label, value)`
    - On `read_only`: `{ isError: true, text: 'Element ... is read-only' }`
    - On not found: `similarLabelsError`
    - Update TargetState with `establishedBy: 'keyboard'`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ] 5.6 Implement `press_button` dispatch case
    - Resolve target, apply focus strategy (default `best_effort`)
    - Call `n.performAction(windowId, 'AXButton', label, 'AXPress')`
    - On not found: `similarLabelsError(windowId, label, ..., 'AXButton')` — only buttons as candidates
    - On disabled: `{ isError: true, text: 'Button "<label>" is disabled' }`
    - Update TargetState with `establishedBy: 'pointer'`
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ] 5.7 Implement `select_menu_item` dispatch case
    - `ensureFocusV4({ bundleId }, 'strict')` — menu bar only responds to frontmost app
    - Call `n.pressMenuItem(bundleId, menu, item, submenu)`
    - On failure: call `n.getMenuBar(bundleId)` and return error with `availableMenus`
    - Update TargetState with `establishedBy: 'activation'`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ] 5.8 Implement `fill_form` dispatch case
    - Resolve target, apply focus strategy (default `strict`)
    - Iterate `fields`: for each, call `n.setElementValue(windowId, role, label, value)` and track succeeded/failed counts + failures array
    - When `succeeded > 0`: update TargetState with `establishedBy: 'keyboard'`
    - Return `{ succeeded, failed, failures }` as JSON text (never `isError: true` unless focus itself failed)
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

  - [ ] 5.9 Implement `run_script` dispatch case
    - Parse `language`, `script`, `timeout_ms`; clamp timeout to `[100, 120000]`
    - Call `runScript(language, script, timeoutMs)`
    - On timedOut: `isError: true` with `"script timed out after <N>ms"`
    - On non-zero exit: `isError: true` with `stderr`
    - On success: return trimmed stdout
    - **Never** update TargetState
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.2, 9.3_

  - [ ] 5.10 Implement `get_ui_tree`, `get_focused_element`, `find_element` dispatch cases (observation)
    - Thin wrappers around native calls; return `JSON.stringify(result)` as text content
    - `find_element`: validate at least one of `role`/`label`/`value` is provided
    - **Never** update TargetState
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 2.1, 2.2, 2.4, 3.1, 3.3, 3.4, 3.5_

  - [ ] 5.11 Implement `get_app_dictionary` dispatch case (observation)
    - Call `getAppDictionary(bundle_id, suite?)`
    - On error (`not_scriptable`, `app_not_found`): `isError: true` with message
    - **Never** update TargetState
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [ ] 6. Session layer: Tool guide, capabilities, spaces, screenshot auto-target
  - [ ] 6.1 Implement `TOOL_GUIDE_TABLE` and `getToolGuide` in `src/session.ts`
    - Static table with 8–10 entries covering common scripting-friendly categories (email, URL open, spreadsheet, file manipulation, calendar, reminders, messages, search)
    - Final catch-all `.*` entry → `accessibility` approach with `[get_ui_tree, find_element, click_element]` sequence
    - Returns `{ approach, toolSequence, explanation, bundleIdHints? }`
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [ ] 6.2 Implement `get_tool_guide` dispatch case (observation)
    - Wrapper around `getToolGuide`; returns JSON text; never mutates TargetState
    - _Requirements: 13.1, 13.6_

  - [ ] 6.3 Implement `get_app_capabilities` dispatch case (observation)
    - Probe scriptability via `getAppDictionary` (cache-friendly)
    - Probe accessibility via `n.listWindows(bundleId).length > 0`
    - Probe running/hidden via `n.listRunningApps().find(a => a.bundleId === bundleId)`
    - Return `{ bundle_id, scriptable, suites, accessible, topLevelCount, running, hidden }`
    - Never mutates TargetState
    - _Requirements: 14.1, 14.2, 14.3, 14.4_

  - [ ] 6.4 Implement `create_agent_space` and `move_window_to_space` dispatch cases
    - `create_agent_space`: session-level cache of the last `space_id`; return it when called twice without tearing down
    - On `supported: false`: return structured error with `workaround` text, `isError: true`
    - `move_window_to_space`: delegate to native; structured error on failure
    - Neither mutates TargetState
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 12.1, 12.2, 12.3, 12.4_

  - [ ] 6.5 Implement auto-target screenshot in `src/session.ts`
    - In the `screenshot` case, when neither `target_window_id` nor `target_app` is provided and `targetState?.windowId` is set, look up the window with `n.getWindow` and use it if `isOnScreen`
    - If stale (not on screen), clear only the `windowId` field from `targetState` (preserve `bundleId`, `establishedBy`, `establishedAt`); proceed with full-screen capture
    - Do not treat the auto-targeting as a state mutation (Property 1 still holds — the only change is a cleanup of stale state)
    - _Requirements: 17.1, 17.2, 17.3, 17.4_

- [ ] 7. Checkpoint — TypeScript compiles and v4 tests still pass
  - Run `npm run build:ts`
  - Run `npm run test`
  - All 100+ v4 tests must still pass. Ask the user if a v4 test now fails for a non-v5 reason.

- [ ] 8. Server layer: Register all new v5 tools and update schemas
  - [ ] 8.1 Register v5 observation tools in `src/server.ts`
    - `get_ui_tree` with `window_id: z.number().int()`, `max_depth: z.number().int().positive().max(20).optional()`
    - `get_focused_element` with no parameters
    - `find_element` with `window_id`, optional `role`/`label`/`value`, optional `max_results: z.number().int().positive().max(100).optional()`
    - `get_app_dictionary` with `bundle_id: z.string()`, optional `suite: z.string().optional()`
    - `get_tool_guide` with `task_description: z.string()`
    - `get_app_capabilities` with `bundle_id: z.string()`
    - _Requirements: 1.1, 2.1, 3.1, 10.1, 13.1, 14.1_

  - [ ] 8.2 Register v5 semantic mutating tools in `src/server.ts`
    - `click_element`: `window_id`, `role`, `label`, `focus_strategy?`
    - `set_value`: `window_id`, `role`, `label`, `value`, `focus_strategy?`
    - `press_button`: `window_id`, `label`, `focus_strategy?`
    - `select_menu_item`: `bundle_id`, `menu`, `item`, `submenu?`
    - `fill_form`: `window_id`, `fields: z.array(z.object({ role, label, value }))`, `focus_strategy?`
    - _Requirements: 4.1, 5.1, 6.1, 7.1, 15.1_

  - [ ] 8.3 Register v5 scripting and spaces tools in `src/server.ts`
    - `run_script`: `language: z.enum(['applescript', 'javascript'])`, `script: z.string()`, `timeout_ms: z.number().int().positive().max(120_000).optional()`
    - `create_agent_space` with no parameters
    - `move_window_to_space`: `window_id`, `space_id`
    - _Requirements: 8.1, 9.1, 11.1, 12.1_

  - [ ] 8.4 Update `type`, `key`, `screenshot` tool descriptions
    - `type`: include guidance that `set_value` / `fill_form` are preferred when AX is available
    - `key`: include guidance about Tab / Shift+Tab navigation and keyboard shortcuts vs coordinate clicks
    - `screenshot`: include guidance about `get_ui_tree` / `find_element` as primary discovery before visual parsing
    - _Requirements: 16.1, 16.2, 16.3_

  - [ ] 8.5 Bump server version to 5.0.0 in `src/server.ts`
    - `new McpServer({ name: 'computer-use', version: '5.0.0' })`
    - _Requirements: 20.2_

- [ ] 9. Client layer: Add typed methods for all new v5 tools
  - [ ] 9.1 Extend `ComputerUseClient` interface in `src/client.ts`
    - Add method signatures for all 14 new tools per Design §Client Layer
    - Export `AXElement`, `MenuItem`, `FillFormResponse`, `ToolGuideResponse`, `AppCapabilitiesResponse` types (re-export from native.ts where appropriate)
    - _Requirements: 19.1–19.12_

  - [ ] 9.2 Implement the 14 new typed methods in the `wrap` function
    - Each method is a thin wrapper over `call(toolName, args)` with argument marshaling
    - `findElement(windowId, criteria)` spreads criteria into the args object
    - `fillForm(windowId, fields, opts?)` passes `fields` array and optional `focus_strategy`
    - `runScript(language, script, timeoutMs?)` only includes `timeout_ms` when provided
    - _Requirements: 19.1–19.12_

- [ ] 10. Checkpoint — Full build passes
  - Run `npm run build` (native + TypeScript)
  - Run `npm run test`
  - Fix any issues; ask the user if unexpected failures appear

- [ ] 11. Documentation and packaging
  - [ ] 11.1 Update `package.json`
    - Set `version` to `"5.0.0"`
    - _Requirements: 20.1_

  - [ ] 11.2 Update `README.md`
    - Bump tool count to 42 (28 v4 + 14 v5)
    - Add "Automation Strategy" section explaining the priority: scripting → accessibility → keyboard → coordinate
    - Document the 14 new tools grouped by category (observation, semantic actions, scripting, advisor, spaces) with one code example per category
    - Update architecture diagram to show the scripting bridge and AX tree walker
    - _Requirements: 20.3, 20.4, 20.7_

  - [ ] 11.3 Update `AGENTS.md`
    - Add "Choosing the right tool" section: call `get_app_capabilities` → `get_tool_guide` first for non-trivial tasks
    - Add example: fill-form in Mail via `fill_form` (AX path) vs `run_script` (scripting path)
    - Document the strict default on `set_value` / `fill_form` and how to override with `focus_strategy: "best_effort"`
    - _Requirements: 20.5_

  - [ ] 11.4 Update `CHANGELOG.md`
    - Add a v5.0.0 entry listing: 14 new tools grouped by category, new `AXElement` / `ScriptingDictionary` shapes, tool description updates on `type`/`key`/`screenshot`, screenshot auto-target, strict-default on `fill_form` / `set_value`
    - Call out no breaking changes to v4 tool schemas — only additions and description updates
    - _Requirements: 20.6_

- [ ] 12. Testing: Session layer property-based tests and unit tests
  - [ ] 12.1 Extend mock native module in `test/session.test.mjs`
    - Add mock implementations for `getUiTree`, `getFocusedElement`, `findElement`, `performAction`, `setElementValue`, `getMenuBar`, `pressMenuItem`, `createAgentSpace`, `moveWindowToSpace`
    - Add test setters `_setTree(windowId, tree)`, `_setFocusedElement(el)`, `_setPerformActionResult(resultFn)`, `_setSetElementValueResult(resultFn)` so tests can inject results
    - Add `mockSpawnBounded(responses)` helper that returns a Map-backed spawner for `osascript`/`sdef` calls
    - _Requirements: (Design §Mock Native Module Extensions)_

  - [ ] 12.2 Write Property 1 test: v5 observation non-mutation
    - Generate random sequences interleaving v5 observation tools (`get_ui_tree`, `get_focused_element`, `find_element`, `get_app_dictionary`, `get_tool_guide`, `get_app_capabilities`) and v4 mutating tools
    - After each call, assert TargetState changes only on the v4 mutating tools
    - **Property 1: v5 observation tools never mutate TargetState**
    - **Validates: Requirements 1.5, 2.4, 3.5, 10.4, 13.6, 14.4**

  - [ ] 12.3 Write Property 2 test: v5 observation never calls mutating native
    - For each v5 observation tool with random valid args, assert the post-call `mock.calls` contains only read-only method names
    - **Property 2: v5 observation tools never call mutating native methods**
    - **Validates: Requirements 1.5, 2.4, 3.5, 10.4, 13.6, 14.4**

  - [ ] 12.4 Write Property 3 test: Semantic mutating establishedBy
    - Generate random successful calls to `click_element` / `press_button` / `set_value` / `fill_form` / `select_menu_item`
    - Assert TargetState `establishedBy` matches the expected category
    - **Property 3: Semantic mutating tools update TargetState with correct provenance**
    - **Validates: Requirements 4.4, 5.4, 6.4, 7.5, 15.5**

  - [ ] 12.5 Write Property 4 test: `run_script` non-mutation
    - Generate random scripts with random spawn results (success, failure, timeout)
    - Assert TargetState is byte-identical before and after
    - **Property 4: `run_script` never mutates TargetState**
    - **Validates: Requirement 8.5**

  - [ ] 12.6 Write Property 5 test: `fill_form` partial failure
    - Generate random `fields` arrays with 1–10 entries; mock `setElementValue` to randomly succeed/fail with `not_found` or `read_only`
    - Assert `succeeded + failed === fields.length`, `failures.length === failed`, and `isError` is not set unless all fields failed AND no target resolved
    - **Property 5: `fill_form` partial failure semantics**
    - **Validates: Requirements 15.2, 15.3, 15.4**

  - [ ] 12.7 Write Property 7 test: `fill_form` / `set_value` default strict
    - Set mock frontmost to a different app than the target
    - Call `fill_form` / `set_value` without `focus_strategy`
    - Assert FocusFailure returned (strict behavior)
    - Call with `focus_strategy: 'best_effort'` and assert it succeeds
    - **Property 7: `fill_form` / `set_value` default to strict focus**
    - **Validates: Requirements 5.5, 15.6**

  - [ ] 12.8 Write Property 8 test: Similar labels hint
    - Mock a findElement result containing `[{ label: 'Send' }, { label: 'Save' }, { label: 'Scam' }]`
    - Request `click_element(..., label: 'Sen')` (close to "Send"); mock performAction returns not-found
    - Assert error JSON contains `similar` with "Send" ranked first
    - **Property 8: Element not found returns structured similar-labels hint**
    - **Validates: Requirements 4.3, 5.3, 6.2**

  - [ ] 12.9 Write Property 9 test: Tree caps
    - Generate synthetic AX trees with 10–1000 nodes; verify the session-level `get_ui_tree` response respects the cap by having the mock return the correct shape
    - This property is enforced by the native module; at session-level assert the response is passed through unchanged including `truncated` flag
    - **Property 9: AX tree depth and node cap**
    - **Validates: Requirements 1.2, 1.6**

  - [ ] 12.10 Write Property 10 test: Screenshot auto-target
    - Generate random `targetState` values (with/without `windowId`, with valid/stale `windowId`)
    - Assert `takeScreenshot` receives the expected `windowId` parameter
    - Assert `targetState.bundleId` is unchanged; `targetState.windowId` is cleared only when stale
    - **Property 10: Screenshot auto-target read-only**
    - **Validates: Requirements 17.1, 17.2, 17.3, 17.4**

  - [ ] 12.11 Write Property 11 test: Tool guide priority
    - Generate random task descriptions from buckets (email, URL, spreadsheet, form-fill, unmatched)
    - Assert `approach` matches expected category, and never `"coordinate"` for the unmatched fallback
    - **Property 11: `get_tool_guide` priority ordering**
    - **Validates: Requirements 13.2, 13.3, 13.4, 13.5**

  - [ ] 12.12 Write Property 12 test: App capabilities accuracy
    - Generate random app states via mock; call `get_app_capabilities`
    - Assert `scriptable`, `suites`, `accessible`, `topLevelCount`, `running`, `hidden` all reflect the mock state
    - **Property 12: `get_app_capabilities` accuracy**
    - **Validates: Requirements 14.1, 14.2, 14.3**

  - [ ] 12.13 Write Property 13 test: `run_script` timeout enforcement
    - Mock `spawnBounded` to return `{ timedOut: true }` after a fake delay
    - Call `run_script` with various `timeout_ms` values including negative, zero, 200000 (clamped)
    - Assert the clamped effective timeout and that timeout errors are returned
    - **Property 13: `run_script` timeout enforcement**
    - **Validates: Requirements 8.3, 8.4, 9.3**

  - [ ] 12.14 Write Property 14 test: Spaces graceful degradation
    - Mock `createAgentSpace` / `moveWindowToSpace` to return `{ supported: false, reason: 'api_unavailable' }` and `{ moved: false, reason: 'api_unavailable' }`
    - Call `create_agent_space` and `move_window_to_space` with random args
    - Assert `isError: true` and response JSON contains `workaround` / `error` keys; session does not throw
    - **Property 14: Spaces API unavailable degrades gracefully**
    - **Validates: Requirements 11.3, 12.4**

  - [ ] 12.15 Write example-based unit tests
    - AX permission denied on `get_ui_tree` → structured error
    - `click_element` falls back to coord click on `unsupported_action` with `bounds`
    - `set_value` on read-only returns exact error text
    - `select_menu_item` returns `availableMenus` when `menu` typo'd
    - `fill_form` with zero successful fields still returns JSON (not isError) as long as target resolved
    - `get_app_dictionary` second call hits cache (assert `sdef` only spawned once)
    - `get_app_dictionary` cache invalidation on simulated PID change
    - `run_script` success trims trailing newline
    - Auto-target screenshot with stale windowId clears only `windowId`
    - _Requirements: 1.4, 4.2, 5.2, 7.3, 10.1, 17.3_

- [ ] 13. Testing: MCP schema and stdio tests
  - [ ] 13.1 Extend `test/stdio.test.mjs` with v5 tool presence checks
    - Assert all 14 new tool names present in `listTools`: `get_ui_tree`, `get_focused_element`, `find_element`, `click_element`, `set_value`, `press_button`, `select_menu_item`, `run_script`, `get_app_dictionary`, `fill_form`, `get_tool_guide`, `get_app_capabilities`, `create_agent_space`, `move_window_to_space`
    - _Requirements: 21.1_

  - [ ] 13.2 Extend `test/stdio.test.mjs` with v5 schema completeness
    - `click_element`, `set_value`, `press_button`, `fill_form` all have `window_id` and `focus_strategy`
    - `set_value` also has `role`, `label`, `value`; `click_element` / `set_value` have `role` + `label`; `press_button` has `label`; `fill_form` has `fields`
    - `run_script` has `language` (enum) and `script`; optional `timeout_ms`
    - `select_menu_item` has `bundle_id`, `menu`, `item`, optional `submenu`
    - _Requirements: 21.1, Property 6_

  - [ ] 13.3 Update existing stdio version test
    - Expect server version `"5.0.0"`
    - **Property 15: Server version reporting**
    - _Requirements: 20.2_

- [ ] 14. Session test: end-to-end integration assertions
  - [ ] 14.1 Add end-to-end session integration tests in `test/session.test.mjs`
    - Verify `screenshot` auto-targets the session windowId established by a prior successful `click_element`
    - Verify `fill_form` after `activate_window` succeeds without an explicit `focus_strategy`
    - Verify `run_script` result does not affect subsequent `type` targeting
    - _Requirements: 21.2, 21.3, 21.4, 21.5, 21.6_

- [ ] 15. Final checkpoint — Full build and all tests pass
  - Run `npm run build`
  - Run `npm run test`
  - Manually smoke-test on a real macOS session: open TextEdit, get its window ID, call `get_ui_tree`, inspect the tree, call `set_value` on the text area with `role: "AXTextArea", label: ""`
  - If any real-world test fails due to AX quirks (common: text-area label is null, not empty string), adjust the matching rules in native to accept `null` labels when the requested `label === ""`
  - Ask the user before any substantive behavior change past this point

## Notes

- Tasks are ordered so each phase leaves the codebase buildable and testable. Phase 1 (tasks 1–2) validates with `npm run build:native`. Phase 2 (tasks 3–7) adds the TS session logic without the server surface. Phase 3 (task 8–10) exposes the tools. Phase 4 (task 11) documents. Phase 5 (tasks 12–15) tests.
- v5 does not introduce breaking changes to v4 tool schemas; all new tools are additive and v4 tools gain only description updates (3 tools: `type`, `key`, `screenshot`).
- The AX tree walker is the single most complex native change; if Rust FFI for AX attributes proves unstable, a fallback is to spawn a tiny helper binary (but this would add ~100ms per call, so prefer the FFI path).
- The Spaces module is best-effort: Requirements 11.3 and 12.4 explicitly accept `isError: true` with a clear message when APIs are unavailable. This is the correct behavior, not a bug.
- Property-based tests mirror the v4 pattern exactly — use `fast-check` with ≥100 iterations per property, inject mock native + mock spawner, and assert on both state transitions and call logs.
- For the `similarLabelsError` Levenshtein implementation, a naive O(m×n) DP is fine (labels are short; `find_element` already caps results at 500).
- `get_tool_guide` is explicitly not an LLM call — it's a regex table. This keeps latency negligible and avoids network dependencies.
- Phase 1 (tasks 1–2) can be validated independently with `npm run build:native` and a quick `node -e` smoke test.
- Phases 3–5 (tasks 3–7) and 8–10 can be tested with `npm run build && npm run test`.
- Phase 11 is docs-only; no code risk.
- Phase 12–14 is the bulk of the test suite work and maps 1:1 to the 14 properties from the design.
