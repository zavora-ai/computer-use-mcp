# Requirements Document

## Introduction

This document specifies the requirements for upgrading `computer-use-mcp` from v4.0.0 to v5.0.0. The primary goal is to make the MCP server dramatically more efficient and capable by adding accessibility tree introspection, semantic UI actions, an AppleScript/JXA scripting bridge, workspace isolation, a tool strategy advisor, and batch interaction patterns.

v4 delivered reliable window-level targeting, structured focus diagnostics, and focus strategies. However, real-world testing (e.g., composing an email in Apple Mail) revealed that the current screenshot-parse-click loop is too slow (15+ tool calls for a 3-field form), the agent lacks semantic understanding of UI elements (clicking pixel coordinates instead of "the To field"), and there is no way to leverage macOS scripting dictionaries for single-call automation. v5 addresses these gaps across six feature areas:

1. **Accessibility Tree Introspection** — Expose the AXUIElement hierarchy so agents can discover UI elements by role, label, and value instead of parsing screenshots
2. **Semantic UI Actions** — Click buttons, set text fields, and select menu items by accessibility properties instead of coordinates
3. **AppleScript/JXA Scripting Bridge** — Execute AppleScript or JavaScript for Automation to automate scriptable apps in a single call
4. **Workspace Isolation** — Create a dedicated macOS Space for agent work so the agent and user do not interfere with each other
5. **Tool Strategy Advisor** — Help agents choose the optimal automation approach for a given task and app
6. **Efficient Interaction Patterns** — Batch form filling, window-targeted screenshots by default, and improved tool descriptions

## Glossary

- **MCP_Server**: The `computer-use-mcp` MCP server process that registers tools, validates inputs via Zod schemas, and delegates to the Session layer
- **Session**: The stateful dispatch layer (`src/session.ts`) that manages target tracking, focus acquisition, and delegates to the Native_Module
- **Native_Module**: The Rust NAPI addon (`computer-use-napi.node`) that calls macOS CoreGraphics, NSWorkspace, and AXUIElement APIs in-process
- **AX_Tree**: The macOS Accessibility tree (AXUIElement hierarchy) representing the UI element structure of a window, including roles, labels, values, positions, and available actions
- **AX_Element**: A single node in the AX_Tree, representing a UI element such as a button, text field, menu item, or group, identified by its role, label, value, and position
- **AX_Role**: The accessibility role of a UI element (e.g., `AXButton`, `AXTextField`, `AXStaticText`, `AXMenuItem`, `AXGroup`, `AXWindow`)
- **AX_Label**: The accessibility label (title or description) of a UI element, typically the human-readable text displayed on or near the element
- **Scripting_Bridge**: The subsystem that executes AppleScript or JXA (JavaScript for Automation) scripts and returns their results
- **Scripting_Dictionary**: The set of commands, classes, and properties that a scriptable macOS application exposes via its `.sdef` file
- **Agent_Space**: A dedicated macOS virtual desktop (Space) where the agent performs its work, isolated from the user's active Space
- **Space_ID**: An integer identifier for a macOS Mission Control Space
- **Tool_Guide**: The strategy advisor subsystem that recommends optimal tool sequences and automation approaches for a given task
- **Form_Fill**: A batch operation that sets multiple UI element values in a single tool call, reducing round-trips
- **TargetState**: The session-level record tracking the current target context including `bundleId`, `windowId`, `establishedBy`, and `establishedAt` (from v4)
- **FocusFailure**: A structured JSON error payload returned when the Session cannot confirm that the requested target is frontmost and ready to receive input (from v4)
- **CGWindowID**: The macOS CoreGraphics integer identifier for an on-screen window, unique system-wide at any point in time (from v4)

## Requirements

### Requirement 1: Accessibility Tree Introspection

**User Story:** As an AI agent, I want to retrieve the accessibility tree for a window, so that I can discover UI elements by their roles, labels, and values instead of parsing screenshots to find pixel coordinates.

#### Acceptance Criteria

1. WHEN a `get_ui_tree` tool call is received with a `window_id` parameter, THE MCP_Server SHALL return a JSON tree representing the AX_Tree for that window, where each node contains `role`, `label`, `value`, `bounds`, `actions`, and `children`
2. WHEN a `get_ui_tree` tool call includes an optional `max_depth` parameter, THE MCP_Server SHALL limit the tree traversal to that depth
3. WHEN a `get_ui_tree` tool call is received with a `window_id` that does not match any on-screen window, THE MCP_Server SHALL return an error response with `isError: true` and a descriptive message
4. THE Native_Module SHALL implement a `getUiTree(windowId: number, maxDepth?: number)` function that traverses the AXUIElement hierarchy using `AXUIElementCopyAttributeValue` for `AXChildren`, `AXRole`, `AXTitle`, `AXValue`, `AXPosition`, `AXSize`, and `AXActionNames`
5. THE `get_ui_tree` tool SHALL NOT mutate the Session TargetState
6. WHEN the AX_Tree contains more than 500 nodes, THE MCP_Server SHALL truncate the tree at the depth limit and include a `truncated: true` flag in the response

### Requirement 2: Focused Element Discovery

**User Story:** As an AI agent, I want to discover which UI element currently has keyboard focus, so that I can understand where typed text will go and navigate from that element.

#### Acceptance Criteria

1. WHEN a `get_focused_element` tool call is received, THE MCP_Server SHALL return a JSON object containing the `role`, `label`, `value`, `bounds`, `actions`, and `windowId` of the currently focused AX_Element
2. WHEN no element has keyboard focus, THE MCP_Server SHALL return a JSON object with null values for element-specific fields and include the `windowId` of the frontmost window
3. THE Native_Module SHALL implement a `getFocusedElement()` function that queries `AXFocusedUIElement` on the frontmost application's AXUIElement
4. THE `get_focused_element` tool SHALL NOT mutate the Session TargetState

### Requirement 3: Element Search

**User Story:** As an AI agent, I want to search for UI elements within a window by role, label, or value, so that I can find specific controls without traversing the entire accessibility tree manually.

#### Acceptance Criteria

1. WHEN a `find_element` tool call is received with a `window_id` and at least one search criterion (`role`, `label`, or `value`), THE MCP_Server SHALL return an array of matching AX_Elements, each containing `role`, `label`, `value`, `bounds`, `actions`, and a `path` array indicating the element's position in the tree
2. WHEN multiple search criteria are provided, THE MCP_Server SHALL return only elements matching all specified criteria (AND logic)
3. WHEN no elements match the search criteria, THE MCP_Server SHALL return an empty array (not an error)
4. WHEN a `find_element` tool call includes an optional `max_results` parameter, THE MCP_Server SHALL return at most that many matching elements
5. THE `find_element` tool SHALL NOT mutate the Session TargetState
6. THE Native_Module SHALL implement a `findElement(windowId: number, role?: string, label?: string, value?: string, maxResults?: number)` function that performs a depth-first search of the AX_Tree

### Requirement 4: Semantic Element Click

**User Story:** As an AI agent, I want to click a UI element by its accessibility role and label instead of pixel coordinates, so that interactions are more reliable and do not depend on screenshot resolution or element position.

#### Acceptance Criteria

1. WHEN a `click_element` tool call is received with `window_id`, `role`, and `label` parameters, THE MCP_Server SHALL find the matching AX_Element and perform `AXPress` action on it
2. WHEN the matching AX_Element does not support the `AXPress` action, THE Session SHALL fall back to computing the element's center coordinates from its `bounds` and performing a coordinate-based click
3. WHEN no element matches the specified `role` and `label` within the target window, THE MCP_Server SHALL return an error response with `isError: true`, a descriptive message, and a list of up to 5 elements with similar labels
4. WHEN `click_element` succeeds, THE Session SHALL update the TargetState with the window's `bundleId` and `windowId`, and set `establishedBy: 'pointer'`
5. THE `click_element` tool SHALL apply the same focus strategy logic as coordinate-based click tools, defaulting to `best_effort`

### Requirement 5: Semantic Value Setting

**User Story:** As an AI agent, I want to set a text field's value directly by its accessibility label, so that I can fill forms without clicking into each field and typing character by character.

#### Acceptance Criteria

1. WHEN a `set_value` tool call is received with `window_id`, `role`, `label`, and `value` parameters, THE MCP_Server SHALL find the matching AX_Element and set its value using `AXUIElementSetAttributeValue` with the `AXValue` attribute
2. WHEN the matching AX_Element does not support setting `AXValue`, THE MCP_Server SHALL return an error response with `isError: true` and a descriptive message indicating the element is read-only
3. WHEN no element matches the specified `role` and `label`, THE MCP_Server SHALL return an error response with `isError: true` and a list of up to 5 elements with similar labels
4. WHEN `set_value` succeeds, THE Session SHALL update the TargetState with the window's `bundleId` and `windowId`, and set `establishedBy: 'keyboard'`
5. THE `set_value` tool SHALL apply focus strategy logic, defaulting to `strict` since it modifies text content

### Requirement 6: Semantic Button Press

**User Story:** As an AI agent, I want to press a button by its label, so that I can trigger actions without locating the button's pixel coordinates.

#### Acceptance Criteria

1. WHEN a `press_button` tool call is received with `window_id` and `label` parameters, THE MCP_Server SHALL find the AX_Element with role `AXButton` matching the label and perform the `AXPress` action
2. WHEN no button matches the specified label, THE MCP_Server SHALL return an error response with `isError: true` and a list of up to 5 buttons with similar labels in the window
3. WHEN the button is disabled (not actionable), THE MCP_Server SHALL return an error response with `isError: true` indicating the button is disabled
4. WHEN `press_button` succeeds, THE Session SHALL update the TargetState with the window's `bundleId` and `windowId`, and set `establishedBy: 'pointer'`

### Requirement 7: Programmatic Menu Selection

**User Story:** As an AI agent, I want to select a menu item programmatically by app, menu name, and item name, so that I can trigger menu actions without navigating the menu bar visually.

#### Acceptance Criteria

1. WHEN a `select_menu_item` tool call is received with `bundle_id`, `menu`, and `item` parameters, THE MCP_Server SHALL navigate the application's menu bar AX_Tree to find and press the specified menu item
2. WHEN the menu item is nested in a submenu, THE `select_menu_item` tool SHALL accept an optional `submenu` parameter to specify the submenu path
3. WHEN the specified menu or item does not exist, THE MCP_Server SHALL return an error response with `isError: true` and a list of available menus or items at the level where the lookup failed
4. WHEN the menu item is disabled (grayed out), THE MCP_Server SHALL return an error response with `isError: true` indicating the item is disabled
5. WHEN `select_menu_item` succeeds, THE Session SHALL update the TargetState with the app's `bundleId` and set `establishedBy: 'activation'`

### Requirement 8: AppleScript Execution

**User Story:** As an AI agent, I want to execute AppleScript code and receive the result, so that I can automate scriptable macOS apps (Mail, Safari, Finder, Numbers) in a single call instead of multi-step GUI automation.

#### Acceptance Criteria

1. WHEN a `run_script` tool call is received with `language: "applescript"` and a `script` parameter, THE MCP_Server SHALL execute the AppleScript using `osascript` and return the script's output as text
2. WHEN the AppleScript execution fails, THE MCP_Server SHALL return an error response with `isError: true` containing the error message from `osascript`
3. WHEN a `run_script` tool call includes an optional `timeout_ms` parameter, THE MCP_Server SHALL terminate the script execution if it exceeds the timeout and return an error indicating timeout
4. THE `run_script` tool SHALL default to a 30-second timeout to prevent runaway scripts
5. THE `run_script` tool SHALL NOT mutate the Session TargetState

### Requirement 9: JXA Execution

**User Story:** As an AI agent, I want to execute JavaScript for Automation (JXA) code and receive the result, so that I can use JavaScript syntax for macOS app scripting when it is more convenient than AppleScript.

#### Acceptance Criteria

1. WHEN a `run_script` tool call is received with `language: "javascript"` and a `script` parameter, THE MCP_Server SHALL execute the JXA script using `osascript -l JavaScript` and return the script's output as text
2. WHEN the JXA execution fails, THE MCP_Server SHALL return an error response with `isError: true` containing the error message
3. THE `run_script` tool SHALL apply the same timeout behavior for JXA as for AppleScript

### Requirement 10: App Scripting Dictionary Retrieval

**User Story:** As an AI agent, I want to retrieve the scripting dictionary for a macOS app, so that I can discover what commands and objects the app supports before writing a script.

#### Acceptance Criteria

1. WHEN a `get_app_dictionary` tool call is received with a `bundle_id` parameter, THE MCP_Server SHALL return a structured summary of the app's scripting dictionary including available suites, commands, classes, and their properties
2. WHEN the specified app does not have a scripting dictionary, THE MCP_Server SHALL return an error response with `isError: true` indicating the app is not scriptable
3. THE MCP_Server SHALL parse the app's `.sdef` file or use `sdef` command-line tool to extract the dictionary
4. THE `get_app_dictionary` tool SHALL NOT mutate the Session TargetState
5. WHEN the scripting dictionary is large, THE MCP_Server SHALL return a summarized version listing suite names, command names, and class names without full property details, and accept an optional `suite` parameter to retrieve details for a specific suite

### Requirement 11: Agent Space Creation

**User Story:** As an AI agent, I want to create a dedicated macOS Space (virtual desktop) for my work, so that my window activations, clicks, and screenshots do not disrupt the user's active workspace.

#### Acceptance Criteria

1. WHEN a `create_agent_space` tool call is received, THE MCP_Server SHALL create a new macOS Space using the Mission Control API and return the `space_id`
2. WHEN the agent Space already exists from a previous call in the same session, THE MCP_Server SHALL return the existing `space_id` instead of creating a duplicate
3. IF the macOS Mission Control API does not support programmatic Space creation, THEN THE MCP_Server SHALL return an error response with `isError: true` and a descriptive message explaining the limitation, along with a suggested manual workaround
4. THE `create_agent_space` tool SHALL NOT mutate the Session TargetState

### Requirement 12: Window-to-Space Movement

**User Story:** As an AI agent, I want to move windows between macOS Spaces, so that I can set up my workspace in the agent Space without affecting the user's desktop layout.

#### Acceptance Criteria

1. WHEN a `move_window_to_space` tool call is received with `window_id` and `space_id` parameters, THE MCP_Server SHALL move the specified window to the target Space
2. WHEN the specified `window_id` does not exist, THE MCP_Server SHALL return an error response with `isError: true` and a descriptive message
3. WHEN the specified `space_id` does not exist, THE MCP_Server SHALL return an error response with `isError: true` and a descriptive message
4. IF programmatic window-to-Space movement is not supported by macOS APIs, THEN THE MCP_Server SHALL return an error response with `isError: true` explaining the limitation

### Requirement 13: Tool Strategy Advisor

**User Story:** As an AI agent, I want to ask the server which tools and approach to use for a given task, so that I can choose the optimal automation strategy instead of defaulting to screenshot-and-click.

#### Acceptance Criteria

1. WHEN a `get_tool_guide` tool call is received with a `task_description` parameter, THE MCP_Server SHALL return a structured recommendation containing the recommended approach (scripting, accessibility, keyboard, coordinate), a suggested tool sequence, and an explanation
2. THE Tool_Guide SHALL recommend AppleScript/JXA as the first choice for apps that have scripting dictionaries
3. THE Tool_Guide SHALL recommend accessibility actions as the second choice for apps with accessible UI elements
4. THE Tool_Guide SHALL recommend keyboard navigation as the third choice
5. THE Tool_Guide SHALL recommend coordinate-based interaction as the last resort
6. THE `get_tool_guide` tool SHALL NOT mutate the Session TargetState

### Requirement 14: App Capabilities Discovery

**User Story:** As an AI agent, I want to discover what automation approaches are available for a specific app, so that I can choose the most efficient method before starting a task.

#### Acceptance Criteria

1. WHEN a `get_app_capabilities` tool call is received with a `bundle_id` parameter, THE MCP_Server SHALL return a JSON object indicating whether the app is scriptable (has a scripting dictionary), whether it exposes accessibility elements, and what known keyboard shortcuts are available
2. WHEN the app is scriptable, THE response SHALL include `scriptable: true` and a list of top-level suite names from the scripting dictionary
3. WHEN the app is running and has visible windows, THE response SHALL include `accessible: true` and a count of top-level accessibility elements
4. THE `get_app_capabilities` tool SHALL NOT mutate the Session TargetState

### Requirement 15: Batch Form Filling

**User Story:** As an AI agent, I want to fill multiple form fields in a single tool call, so that a 3-field email form takes 1 call instead of 6+ calls (click field, type, click field, type, click field, type).

#### Acceptance Criteria

1. WHEN a `fill_form` tool call is received with a `window_id` and a `fields` array (each containing `role`, `label`, and `value`), THE MCP_Server SHALL set each field's value using `AXUIElementSetAttributeValue` in sequence
2. WHEN a field in the `fields` array cannot be found, THE MCP_Server SHALL include that field in a `failures` array in the response and continue processing remaining fields
3. WHEN a field in the `fields` array is read-only, THE MCP_Server SHALL include that field in the `failures` array with a reason of `"read_only"` and continue processing remaining fields
4. THE response SHALL include a `succeeded` count, a `failed` count, and the `failures` array with details for each failed field
5. WHEN `fill_form` succeeds for at least one field, THE Session SHALL update the TargetState with the window's `bundleId` and `windowId`, and set `establishedBy: 'keyboard'`
6. THE `fill_form` tool SHALL apply focus strategy logic, defaulting to `strict`

### Requirement 16: Improved Tool Descriptions for Keyboard-First Navigation

**User Story:** As an AI agent developer, I want tool descriptions that guide agents toward keyboard-first navigation patterns, so that agents prefer Tab/Shift+Tab and keyboard shortcuts over coordinate clicking.

#### Acceptance Criteria

1. THE MCP_Server SHALL update the `key` tool description to include guidance that Tab and Shift+Tab navigate between form fields and that keyboard shortcuts are faster than coordinate clicking
2. THE MCP_Server SHALL update the `type` tool description to include guidance that agents should use `set_value` or `fill_form` for form fields when accessibility elements are available
3. THE MCP_Server SHALL update the `screenshot` tool description to include guidance that agents should use `get_ui_tree` or `find_element` to discover UI elements before falling back to visual parsing

### Requirement 17: Window-Targeted Screenshots by Default

**User Story:** As an AI agent, I want screenshots to automatically target the current session window when one is established, so that I do not waste tokens on full-screen captures when I am working with a specific window.

#### Acceptance Criteria

1. WHEN a `screenshot` tool call is received without `target_app` or `target_window_id`, and the Session has an active TargetState with a `windowId`, THE Session SHALL automatically use that `windowId` for the screenshot capture
2. WHEN a `screenshot` tool call explicitly provides `target_app` or `target_window_id`, THE MCP_Server SHALL use the explicit parameter and ignore the session TargetState
3. WHEN the session TargetState `windowId` refers to a window that is no longer on-screen, THE Session SHALL fall back to full-screen capture and clear the stale `windowId` from TargetState
4. THE `screenshot` tool SHALL continue to NOT mutate the Session TargetState (the auto-targeting reads but does not write state)

### Requirement 18: Native Accessibility Module Extensions

**User Story:** As a developer, I want the Rust NAPI module to expose AXUIElement tree traversal, element search, and semantic action functions, so that the Session layer can implement accessibility-based tools without spawning subprocesses.

#### Acceptance Criteria

1. THE Native_Module SHALL implement `getUiTree(windowId: number, maxDepth?: number)` that returns a JSON tree of AX_Elements using `AXUIElementCopyAttributeValue` for `AXChildren`, `AXRole`, `AXTitle`, `AXValue`, `AXDescription`, `AXPosition`, `AXSize`, and `AXActionNames`
2. THE Native_Module SHALL implement `getFocusedElement()` that queries `AXFocusedUIElement` on the system-wide accessibility element and returns the focused AX_Element's properties
3. THE Native_Module SHALL implement `findElement(windowId: number, role?: string, label?: string, value?: string, maxResults?: number)` that performs a depth-first search of the AX_Tree
4. THE Native_Module SHALL implement `performAction(windowId: number, role: string, label: string, action: string)` that finds a matching AX_Element and calls `AXUIElementPerformAction`
5. THE Native_Module SHALL implement `setElementValue(windowId: number, role: string, label: string, value: string)` that finds a matching AX_Element and calls `AXUIElementSetAttributeValue` with `AXValue`
6. THE Native_Module SHALL implement `getMenuBar(bundleId: string)` that traverses the `AXMenuBar` of the specified application and returns the menu structure
7. THE Native_Module SHALL reuse the existing AXUIElement FFI declarations in `windows.rs` and extend them with the additional attribute and action constants needed for tree traversal

### Requirement 19: TypeScript Client API Updates for v5

**User Story:** As a developer using the typed client, I want convenience methods for all new v5 tools, so that I can use accessibility actions, scripting, and batch operations without dropping to raw `callTool`.

#### Acceptance Criteria

1. THE Client_API SHALL expose a `getUiTree(windowId: number, maxDepth?: number)` method that calls the `get_ui_tree` MCP tool
2. THE Client_API SHALL expose a `getFocusedElement()` method that calls the `get_focused_element` MCP tool
3. THE Client_API SHALL expose a `findElement(windowId: number, criteria: { role?: string; label?: string; value?: string; maxResults?: number })` method that calls the `find_element` MCP tool
4. THE Client_API SHALL expose a `clickElement(windowId: number, role: string, label: string)` method that calls the `click_element` MCP tool
5. THE Client_API SHALL expose a `setValue(windowId: number, role: string, label: string, value: string)` method that calls the `set_value` MCP tool
6. THE Client_API SHALL expose a `pressButton(windowId: number, label: string)` method that calls the `press_button` MCP tool
7. THE Client_API SHALL expose a `selectMenuItem(bundleId: string, menu: string, item: string, submenu?: string)` method that calls the `select_menu_item` MCP tool
8. THE Client_API SHALL expose a `runScript(language: 'applescript' | 'javascript', script: string, timeoutMs?: number)` method that calls the `run_script` MCP tool
9. THE Client_API SHALL expose a `getAppDictionary(bundleId: string, suite?: string)` method that calls the `get_app_dictionary` MCP tool
10. THE Client_API SHALL expose a `fillForm(windowId: number, fields: Array<{ role: string; label: string; value: string }>)` method that calls the `fill_form` MCP tool
11. THE Client_API SHALL expose a `getToolGuide(taskDescription: string)` method that calls the `get_tool_guide` MCP tool
12. THE Client_API SHALL expose a `getAppCapabilities(bundleId: string)` method that calls the `get_app_capabilities` MCP tool

### Requirement 20: Version Bump and Documentation

**User Story:** As a package maintainer, I want the version bumped to 5.0.0 with updated documentation covering all new tools and automation strategies, so that the release is complete and discoverable.

#### Acceptance Criteria

1. THE `package.json` SHALL have its `version` field set to `"5.0.0"`
2. THE MCP_Server SHALL report version `'5.0.0'` in its server metadata
3. THE README SHALL document all new tools, their parameters, and usage examples
4. THE README SHALL update the tool count to reflect the new v5 tool surface
5. THE AGENTS.md SHALL include guidance on when to use accessibility actions versus scripting versus coordinate-based interaction
6. THE CHANGELOG SHALL include a v5.0.0 entry documenting all new tools, capabilities, and breaking changes
7. THE README SHALL include an "Automation Strategy" section explaining the priority: AppleScript/JXA for scriptable apps, accessibility actions for UI elements, keyboard navigation, then coordinate clicking as last resort

### Requirement 21: MCP Schema and Integration Tests for v5

**User Story:** As a developer, I want automated tests verifying that all v5 MCP tool schemas are correct and that the new tools integrate properly with the session layer, so that MCP host compatibility is validated.

#### Acceptance Criteria

1. WHEN the stdio test suite runs, THE test SHALL verify that all new v5 tools (`get_ui_tree`, `get_focused_element`, `find_element`, `click_element`, `set_value`, `press_button`, `select_menu_item`, `run_script`, `get_app_dictionary`, `fill_form`, `get_tool_guide`, `get_app_capabilities`) are present in the `listTools` response
2. WHEN the session test suite runs, THE test SHALL verify that all new Observation tools (`get_ui_tree`, `get_focused_element`, `find_element`, `get_app_dictionary`, `get_tool_guide`, `get_app_capabilities`) do not mutate the Session TargetState
3. WHEN the session test suite runs, THE test SHALL verify that `click_element`, `set_value`, `press_button`, `select_menu_item`, and `fill_form` update the Session TargetState on success
4. WHEN the session test suite runs, THE test SHALL verify that `run_script` does not mutate the Session TargetState
5. WHEN the session test suite runs, THE test SHALL verify that `fill_form` continues processing remaining fields when one field fails and returns both `succeeded` and `failed` counts
6. WHEN the session test suite runs, THE test SHALL verify that `screenshot` auto-targets the session `windowId` when no explicit target is provided
