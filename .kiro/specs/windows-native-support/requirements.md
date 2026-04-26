# Requirements Document

## Introduction

This document specifies the requirements for adding native Windows support to the `@zavora-ai/computer-use-mcp` package. The project currently provides an MCP server for macOS desktop control backed by a Rust NAPI native module. The goal is to achieve feature parity with the reference project `Windows-MCP` (a Python-based MCP server for Windows desktop control) by implementing Windows equivalents in Rust using the `windows-rs` crate, compiled into the same NAPI module via `#[cfg(target_os)]` conditional compilation. The TypeScript layer (server, session, client) will see identical function signatures on both platforms, with platform-specific behavior handled transparently. This document contains 30 requirements organized across platform infrastructure, input/output, UI automation, build/distribution, and additional tool coverage.

## Glossary

- **NAPI_Module**: The compiled Rust native addon (`.node` file) that exposes platform-specific OS APIs to the TypeScript layer via N-API bindings.
- **Session_Layer**: The TypeScript module (`session.ts`) that dispatches tool calls, manages focus/targeting state, and orchestrates platform-specific behavior.
- **Server_Layer**: The TypeScript module (`server.ts`) that registers MCP tools with Zod schemas and delegates to the Session_Layer.
- **Native_Loader**: The TypeScript module (`native.ts`) that detects the platform and loads the correct NAPI_Module binary.
- **Win32_API**: The set of Windows operating system APIs accessed via the `windows-rs` Rust crate, including SendInput, UI Automation COM, DXGI, and window management functions.
- **UI_Automation**: The Microsoft UI Automation COM framework (`IUIAutomation`) used to inspect and interact with Windows UI elements, analogous to macOS AXUIElement.
- **Conditional_Compilation**: Rust's `#[cfg(target_os = "windows")]` / `#[cfg(target_os = "macos")]` mechanism for including platform-specific code in the same source files.
- **Build_System**: The combination of Cargo (Rust), npm scripts, and CI pipelines that produce platform-specific NAPI_Module binaries and the distributable npm package.
- **Virtual_Desktop_Manager**: The Windows COM interface (`IVirtualDesktopManager`) for querying and managing Windows virtual desktops, analogous to macOS CGS Spaces.
- **PowerShell_Executor**: A component that spawns PowerShell processes to execute commands on Windows, analogous to the macOS `osascript` scripting bridge.
- **Focus_Strategy**: The session-level mechanism (`strict`, `best_effort`, `none`, `prepare_display`) that controls how the server acquires window focus before delivering input.
- **DXGI**: DirectX Graphics Infrastructure, used for high-performance screenshot capture on Windows via `IDXGIOutputDuplication`.
- **SendInput**: The Win32 API function used to synthesize mouse and keyboard input events on Windows, analogous to macOS CGEvent.
- **FileSystem_Tool**: The MCP tool that provides file and directory operations (read, write, copy, move, delete, list, search, info) on Windows, resolving relative paths from the user's Desktop folder.
- **Registry_Tool**: The MCP tool that provides Windows Registry read/write operations using PowerShell-format paths (e.g., `HKCU:\Software\MyApp`).
- **Notification_Tool**: The MCP tool that sends Windows toast notifications via the Windows notification API.
- **Scrape_Tool**: The MCP tool that fetches and extracts web page content from a URL, with optional DOM extraction from the active browser tab.
- **MultiSelect_Tool**: The MCP tool that performs batch element selection by clicking multiple coordinates or UI element labels, with optional Ctrl-key hold for multi-select.
- **MultiEdit_Tool**: The MCP tool that performs batch text input to multiple fields by coordinates or UI element labels.

## Requirements

### Requirement 1: Platform Detection and Native Module Loading

**User Story:** As a developer, I want the package to automatically detect the operating system and load the correct native module, so that the same npm package works on both macOS and Windows without manual configuration.

#### Acceptance Criteria

1. WHEN the package is imported on Windows, THE Native_Loader SHALL load the Windows-specific NAPI_Module binary without error.
2. WHEN the package is imported on macOS, THE Native_Loader SHALL load the macOS-specific NAPI_Module binary without error.
3. IF the package is imported on an unsupported platform (neither macOS nor Windows), THEN THE Native_Loader SHALL throw an error stating the platform is unsupported and listing the supported platforms.
4. THE Native_Loader SHALL expose an identical `NativeModule` TypeScript interface on both platforms, so that the Session_Layer requires no platform-conditional imports.
5. WHEN the NAPI_Module binary for the current platform is missing, THE Native_Loader SHALL throw a descriptive error indicating the binary was not found and suggesting a rebuild.

### Requirement 2: Mouse Input on Windows

**User Story:** As an AI agent, I want to control the mouse on Windows (click, move, scroll, drag), so that I can interact with Windows desktop applications.

#### Acceptance Criteria

1. WHEN a left-click action is dispatched with coordinates (x, y), THE NAPI_Module SHALL synthesize a left mouse click at (x, y) using the SendInput Win32_API.
2. WHEN a right-click action is dispatched with coordinates (x, y), THE NAPI_Module SHALL synthesize a right mouse click at (x, y) using the SendInput Win32_API.
3. WHEN a middle-click action is dispatched with coordinates (x, y), THE NAPI_Module SHALL synthesize a middle mouse click at (x, y) using the SendInput Win32_API.
4. WHEN a double-click action is dispatched with coordinates (x, y), THE NAPI_Module SHALL synthesize two left mouse clicks at (x, y) within the system double-click interval.
5. WHEN a triple-click action is dispatched with coordinates (x, y), THE NAPI_Module SHALL synthesize three left mouse clicks at (x, y) within the system double-click interval.
6. WHEN a mouse-move action is dispatched with coordinates (x, y), THE NAPI_Module SHALL move the cursor to (x, y) using the SendInput Win32_API.
7. WHEN a scroll action is dispatched with a direction and amount, THE NAPI_Module SHALL synthesize mouse wheel events in the specified direction using the SendInput Win32_API.
8. WHEN a drag action is dispatched with start and end coordinates, THE NAPI_Module SHALL synthesize a mouse-down at the start, animated movement, and mouse-up at the end using the SendInput Win32_API.
9. WHEN a cursor-position query is dispatched, THE NAPI_Module SHALL return the current cursor coordinates using the GetCursorPos Win32_API.
10. WHEN a mouse-down action is dispatched with coordinates (x, y), THE NAPI_Module SHALL synthesize a left mouse button press (without release) at (x, y).
11. WHEN a mouse-up action is dispatched with coordinates (x, y), THE NAPI_Module SHALL synthesize a left mouse button release at (x, y).

### Requirement 3: Keyboard Input on Windows

**User Story:** As an AI agent, I want to type text and press key combinations on Windows, so that I can enter data and trigger shortcuts in Windows applications.

#### Acceptance Criteria

1. WHEN a type-text action is dispatched with a string, THE NAPI_Module SHALL synthesize keyboard input for each character using the SendInput Win32_API with Unicode scan codes.
2. WHEN a key-press action is dispatched with a key combination string (e.g., "ctrl+c"), THE NAPI_Module SHALL parse the combination, map modifier names to Windows virtual key codes, and synthesize the key press sequence using the SendInput Win32_API.
3. WHEN a key-press action is dispatched with a repeat count, THE NAPI_Module SHALL repeat the key combination the specified number of times.
4. WHEN a hold-key action is dispatched with keys and a duration, THE NAPI_Module SHALL hold the specified keys down for the specified duration and then release them.
5. THE NAPI_Module SHALL map macOS modifier names to Windows equivalents: "command" and "super" to "win", "option" to "alt", "control" to "ctrl".
6. THE NAPI_Module SHALL support all standard key names: letters (a-z), digits (0-9), function keys (f1-f12), navigation keys (home, end, pageup, pagedown, arrows), and special keys (return, tab, space, delete, backspace, escape).
7. IF an unrecognized key name is provided, THEN THE NAPI_Module SHALL throw an error listing the unrecognized key name.
8. WHEN a type-text action is dispatched with the `clear` parameter set to true, THE Session_Layer SHALL select all existing text in the target field and delete it before typing the new text.
9. WHEN a type-text action is dispatched with the `press_enter` parameter set to true, THE Session_Layer SHALL synthesize a Return key press after typing the text to submit the field.
10. WHEN a type-text action is dispatched with a `caret_position` parameter of "start", THE Session_Layer SHALL move the caret to the beginning of the field before typing; WHEN set to "end", THE Session_Layer SHALL move the caret to the end of the field; WHEN set to "idle", THE Session_Layer SHALL leave the caret at its current position.

### Requirement 4: Screenshot Capture on Windows

**User Story:** As an AI agent, I want to capture screenshots on Windows, so that I can observe the current state of the desktop and applications.

#### Acceptance Criteria

1. WHEN a screenshot action is dispatched without a target, THE NAPI_Module SHALL capture the full primary display using DXGI output duplication or the BitBlt GDI fallback.
2. WHEN a screenshot action is dispatched with a window ID, THE NAPI_Module SHALL capture only the specified window's content.
3. WHEN a screenshot action is dispatched with a width parameter, THE NAPI_Module SHALL resize the captured image to the specified width while preserving the aspect ratio.
4. WHEN a screenshot action is dispatched with a quality parameter, THE NAPI_Module SHALL encode the image as JPEG with the specified quality level (1-100).
5. THE NAPI_Module SHALL return the screenshot as a base64-encoded JPEG string with width, height, mimeType, and a content hash for deduplication.
6. WHEN a screenshot action is dispatched with a previous hash that matches the current capture, THE NAPI_Module SHALL return an unchanged indicator without re-encoding the image.
7. IF DXGI output duplication is unavailable (e.g., in a remote desktop session), THEN THE NAPI_Module SHALL fall back to GDI BitBlt capture and still return a valid screenshot.
8. WHEN a screenshot action is dispatched with a `display` parameter containing a list of display indices, THE NAPI_Module SHALL capture only the specified monitors and return screenshot data scoped to those displays.
9. WHEN a screenshot action is dispatched with `use_annotation` set to true, THE Session_Layer SHALL draw colored bounding box overlays on detected UI elements in the returned screenshot image.
10. WHEN a screenshot action is dispatched with `width_reference_line` or `height_reference_line` parameters, THE Session_Layer SHALL overlay evenly spaced grid reference lines on the screenshot to aid spatial reasoning.

### Requirement 5: Clipboard Operations on Windows

**User Story:** As an AI agent, I want to read and write the Windows clipboard, so that I can transfer text data between the agent and Windows applications.

#### Acceptance Criteria

1. WHEN a read-clipboard action is dispatched, THE NAPI_Module SHALL open the Windows clipboard, read the CF_UNICODETEXT format, close the clipboard, and return the text content.
2. WHEN a write-clipboard action is dispatched with a text string, THE NAPI_Module SHALL open the Windows clipboard, clear it, write the text in CF_UNICODETEXT format, and close the clipboard.
3. IF the clipboard does not contain text data, THEN THE NAPI_Module SHALL return an empty string or a descriptive message indicating non-text content.
4. IF the clipboard cannot be opened (locked by another process), THEN THE NAPI_Module SHALL retry up to 3 times with a 50ms delay and return an error if all retries fail.

### Requirement 6: Window Enumeration and Management on Windows

**User Story:** As an AI agent, I want to list, inspect, activate, and manage windows on Windows, so that I can target specific application windows for input and observation.

#### Acceptance Criteria

1. WHEN a list-windows action is dispatched, THE NAPI_Module SHALL enumerate all visible top-level windows using EnumWindows and return their window handle (HWND), process name, window title, bounds, and visibility state.
2. WHEN a list-windows action is dispatched with a process name filter, THE NAPI_Module SHALL return only windows belonging to processes matching the filter.
3. WHEN a get-window action is dispatched with a window handle, THE NAPI_Module SHALL return the window's handle, process name, title, bounds, visibility state, and whether it is the foreground window.
4. WHEN a get-cursor-window action is dispatched, THE NAPI_Module SHALL return the window under the current cursor position using WindowFromPoint.
5. WHEN an activate-app action is dispatched with a process name, THE NAPI_Module SHALL bring the matching window to the foreground using SetForegroundWindow with AttachThreadInput for reliable focus acquisition, and return structured before/after diagnostics.
6. WHEN an activate-window action is dispatched with a window handle, THE NAPI_Module SHALL raise the specified window using SetForegroundWindow and BringWindowToTop, restoring it from minimized state if necessary.
7. WHEN a get-frontmost-app action is dispatched, THE NAPI_Module SHALL return the process name, process ID, and window title of the current foreground window using GetForegroundWindow.
8. WHEN a list-running-apps action is dispatched, THE NAPI_Module SHALL enumerate running processes with visible windows using CreateToolhelp32Snapshot and return their process name, process ID, and visibility state.
9. IF a window handle is invalid or the window no longer exists, THEN THE NAPI_Module SHALL return a descriptive error.

### Requirement 7: Application Lifecycle Management on Windows

**User Story:** As an AI agent, I want to launch, switch between, hide, and unhide applications on Windows, so that I can manage the desktop environment during automation.

#### Acceptance Criteria

1. WHEN an open-application action is dispatched with an application name, THE NAPI_Module SHALL launch the application using `std::process::Command` or the Shell API (for Start Menu apps) and return the process ID.
2. WHEN a hide-app action is dispatched with a process name, THE NAPI_Module SHALL minimize all windows belonging to the specified process.
3. WHEN an unhide-app action is dispatched with a process name, THE NAPI_Module SHALL restore all minimized windows belonging to the specified process.
4. IF the specified application is not found in the Start Menu or PATH, THEN THE NAPI_Module SHALL return a descriptive error indicating the application was not found.
5. WHEN a resize action is dispatched with a window name and a `window_size` parameter ([width, height]), THE NAPI_Module SHALL resize the specified window to the given dimensions using MoveWindow or SetWindowPos.
6. WHEN a resize action is dispatched with a window name and a `window_loc` parameter ([x, y]), THE NAPI_Module SHALL move the specified window so its top-left corner is at the given screen coordinates.
7. WHEN a resize action is dispatched without a window name, THE NAPI_Module SHALL apply the resize and move operations to the currently active foreground window.

### Requirement 8: UI Automation Tree on Windows

**User Story:** As an AI agent, I want to inspect the UI element tree of Windows applications, so that I can discover interactive elements by role and label instead of relying on pixel coordinates.

#### Acceptance Criteria

1. WHEN a get-ui-tree action is dispatched with a window handle, THE NAPI_Module SHALL walk the UI_Automation tree rooted at the specified window and return elements with their control type (role), name (label), value, bounding rectangle, and supported patterns (actions).
2. WHEN a get-ui-tree action is dispatched with a max-depth parameter, THE NAPI_Module SHALL limit the tree traversal to the specified depth.
3. THE NAPI_Module SHALL cap the returned tree at 500 nodes to prevent excessive output, setting a truncated flag when the cap is reached.
4. WHEN a find-element action is dispatched with search criteria (role, label, value), THE NAPI_Module SHALL search the UI_Automation tree using condition-based search and return matching elements.
5. WHEN a get-focused-element action is dispatched, THE NAPI_Module SHALL return the currently focused UI_Automation element using GetFocusedElement.
6. THE NAPI_Module SHALL map Windows UI Automation control types to role strings consistent with the macOS AX role naming convention where a direct equivalent exists (e.g., "Button" maps to a role string, "Edit" maps to a text field role string).

### Requirement 9: Semantic UI Actions on Windows

**User Story:** As an AI agent, I want to click buttons, set text field values, and interact with UI elements by role and label on Windows, so that I can perform reliable UI automation that survives window moves and resolution changes.

#### Acceptance Criteria

1. WHEN a click-element action is dispatched with a window handle, role, and label, THE NAPI_Module SHALL find the matching UI_Automation element and invoke its Invoke pattern, falling back to a coordinate click at the element's center if the Invoke pattern is unsupported.
2. WHEN a set-value action is dispatched with a window handle, role, label, and value, THE NAPI_Module SHALL find the matching UI_Automation element and set its value using the Value pattern.
3. WHEN a press-button action is dispatched with a window handle and label, THE NAPI_Module SHALL find the matching Button element and invoke its Invoke pattern.
4. WHEN a fill-form action is dispatched with a window handle and an array of fields, THE NAPI_Module SHALL set each field's value sequentially, reporting per-field success or failure without aborting the batch on partial failure.
5. IF a matching element is not found, THEN THE NAPI_Module SHALL return an error payload containing the closest matching labels ranked by string similarity.
6. WHEN a select-menu-item action is dispatched with a process name, menu path, and item name, THE NAPI_Module SHALL walk the application's menu structure using UI_Automation and invoke the matching menu item.

### Requirement 10: Display Information on Windows

**User Story:** As an AI agent, I want to query display dimensions and configuration on Windows, so that I can calculate correct coordinates for mouse actions.

#### Acceptance Criteria

1. WHEN a get-display-size action is dispatched, THE NAPI_Module SHALL return the primary monitor's width, height, physical pixel dimensions, and scale factor using EnumDisplayMonitors and GetDpiForMonitor.
2. WHEN a get-display-size action is dispatched with a display ID, THE NAPI_Module SHALL return the dimensions and scale factor for the specified monitor.
3. WHEN a list-displays action is dispatched, THE NAPI_Module SHALL enumerate all connected monitors using EnumDisplayMonitors and return their dimensions, scale factors, and display IDs.

### Requirement 11: Virtual Desktop Support on Windows

**User Story:** As an AI agent, I want to query Windows virtual desktops, so that I can understand the desktop layout and determine which desktop a window is on.

#### Acceptance Criteria

1. WHEN a list-spaces action is dispatched on Windows, THE NAPI_Module SHALL enumerate virtual desktops using the IVirtualDesktopManager COM interface and return their IDs and names.
2. WHEN a get-active-space action is dispatched on Windows, THE NAPI_Module SHALL return the ID and name of the currently active virtual desktop.
3. IF the Virtual_Desktop_Manager COM interface is unavailable (e.g., Windows Server), THEN THE NAPI_Module SHALL return a single default desktop entry and set a supported flag to false.

### Requirement 12: Session Layer Platform Adaptation

**User Story:** As a developer, I want the session layer to handle platform-specific differences transparently, so that the MCP tool surface remains identical on both platforms.

#### Acceptance Criteria

1. THE Session_Layer SHALL detect the current platform at initialization and select platform-appropriate behavior for clipboard operations (pbcopy/pbpaste on macOS, native Win32 clipboard on Windows).
2. THE Session_Layer SHALL adapt the focus acquisition strategy for Windows: using SetForegroundWindow with AttachThreadInput instead of NSWorkspace activation.
3. THE Session_Layer SHALL adapt the session lock mechanism for Windows: using a named mutex or lock file in the user's temp directory instead of `/tmp/.computer-use-mcp.lock`.
4. THE Session_Layer SHALL omit the CFRunLoop drain pump on Windows, as it is macOS-specific.
5. WHEN the `prepare_display` Focus_Strategy is used on Windows, THE Session_Layer SHALL minimize all non-target application windows instead of hiding them (Windows has no direct equivalent to macOS app hiding).
6. THE Session_Layer SHALL map macOS-specific tool concepts to Windows equivalents: bundle IDs to process names or executable paths, CGWindowIDs to HWNDs, AXUIElement roles to UI Automation control types.
7. THE Session_Layer SHALL adapt the scripting bridge: `run_script` on Windows SHALL execute PowerShell commands instead of AppleScript/JXA, and `get_app_dictionary` SHALL return an unsupported indicator on Windows.

### Requirement 13: PowerShell Scripting Bridge on Windows

**User Story:** As an AI agent, I want to execute PowerShell commands on Windows, so that I can perform system automation tasks equivalent to AppleScript on macOS.

#### Acceptance Criteria

1. WHEN a run-script action is dispatched on Windows with language "powershell", THE Session_Layer SHALL spawn a PowerShell process, execute the provided script, and return the stdout output.
2. WHEN a run-script action is dispatched on Windows with a timeout, THE Session_Layer SHALL kill the PowerShell process if it exceeds the specified timeout and return a timeout error.
3. THE Session_Layer SHALL encode PowerShell commands using Base64 encoded UTF-16LE and pass them via the `-EncodedCommand` parameter to avoid quoting issues.
4. THE Session_Layer SHALL prepare a complete environment block for the PowerShell subprocess, supplementing missing variables from the Windows Registry when the MCP host provides a stripped environment.
5. IF a run-script action is dispatched on Windows with language "applescript" or "javascript", THEN THE Session_Layer SHALL return an error indicating that AppleScript and JXA are not supported on Windows and suggesting PowerShell as the alternative.

### Requirement 14: Conditional Compilation and Rust Module Structure

**User Story:** As a developer, I want the Rust native module to compile on both macOS and Windows from the same source tree, so that I can maintain a single codebase.

#### Acceptance Criteria

1. THE NAPI_Module source SHALL use `#[cfg(target_os = "macos")]` and `#[cfg(target_os = "windows")]` attributes to conditionally compile platform-specific code within each source file.
2. THE Cargo.toml SHALL declare macOS-specific dependencies (core-graphics, core-foundation, objc) under a `[target.'cfg(target_os = "macos")'.dependencies]` section.
3. THE Cargo.toml SHALL declare Windows-specific dependencies (windows-rs with selected Win32 features) under a `[target.'cfg(target_os = "windows")'.dependencies]` section.
4. THE NAPI_Module SHALL export the same set of NAPI function names on both platforms, so that the TypeScript Native_Loader interface remains unchanged.
5. WHEN compiled on Windows, THE NAPI_Module SHALL produce a `.node` file that loads without error in Node.js on Windows.
6. WHEN compiled on macOS, THE NAPI_Module SHALL produce a `.node` file identical in behavior to the current macOS-only build.

### Requirement 15: Build System and CI Pipeline

**User Story:** As a developer, I want the build system to produce native binaries for both macOS and Windows, so that the npm package ships prebuilt binaries for both platforms.

#### Acceptance Criteria

1. THE Build_System SHALL include CI jobs that build the NAPI_Module on both macOS (x86_64 and aarch64) and Windows (x86_64) runners.
2. THE Build_System SHALL produce platform-specific `.node` binary artifacts named to distinguish the platform and architecture (e.g., `computer-use-napi.win32-x64.node`, `computer-use-napi.darwin-arm64.node`).
3. THE package.json SHALL remove the `"os": ["darwin"]` restriction and list both `"darwin"` and `"win32"` as supported platforms.
4. THE npm package SHALL include prebuilt binaries for all supported platform-architecture combinations, so that users do not need a Rust toolchain to install the package.
5. THE Build_System SHALL run the TypeScript test suite on both macOS and Windows CI runners to verify cross-platform correctness.
6. THE Build_System SHALL run platform-specific smoke tests on each CI runner to verify that the native module loads and basic operations (screenshot, mouse move, key press) succeed.

### Requirement 16: npm Package Distribution

**User Story:** As a user, I want to install the package on Windows via npm and have it work without additional setup, so that I can use it the same way as on macOS.

#### Acceptance Criteria

1. WHEN a user runs `npm install @zavora-ai/computer-use-mcp` on Windows, THE package SHALL install successfully and include the prebuilt Windows NAPI_Module binary.
2. WHEN a user runs `npx @zavora-ai/computer-use-mcp` on Windows, THE MCP server SHALL start and accept tool calls over stdio.
3. THE package.json `bin` entry SHALL work on both macOS and Windows (the server entrypoint script SHALL be platform-agnostic).
4. THE package SHALL not require Python, pywin32, or any Python dependencies on Windows — all Windows functionality SHALL be implemented in Rust.

### Requirement 17: Tool Surface Parity and Platform-Specific Tools

**User Story:** As an AI agent developer, I want a clear understanding of which tools work on both platforms and which are platform-specific, so that I can build cross-platform agent workflows.

#### Acceptance Criteria

1. THE Server_Layer SHALL expose the following tools on both macOS and Windows with identical schemas: screenshot, left_click, right_click, middle_click, double_click, triple_click, mouse_move, left_click_drag, left_mouse_down, left_mouse_up, scroll, cursor_position, type, key, hold_key, read_clipboard, write_clipboard, open_application, get_frontmost_app, list_windows, list_running_apps, get_window, get_cursor_window, activate_app, activate_window, hide_app, unhide_app, get_display_size, list_displays, wait, get_ui_tree, get_focused_element, find_element, click_element, set_value, press_button, fill_form, select_menu_item, list_spaces, get_active_space, get_tool_metadata, get_tool_guide, get_app_capabilities, scrape, multi_select, multi_edit.
2. THE Server_Layer SHALL expose `run_script` on both platforms: accepting "applescript" and "javascript" languages on macOS, and "powershell" on Windows.
3. THE Server_Layer SHALL expose `get_app_dictionary` on macOS only; on Windows it SHALL return an error indicating the tool is not supported on this platform.
4. THE Server_Layer SHALL expose `list_menu_bar` on macOS only; on Windows it SHALL return an error indicating the tool is not supported on this platform, with a suggestion to use `get_ui_tree` to discover menu structure.
5. THE `get_tool_metadata` tool SHALL return accurate `focusRequired` values adapted for Windows (e.g., "cgevent" maps to "sendinput", or a platform-neutral label is used).
6. THE `get_tool_guide` tool SHALL return Windows-appropriate recommendations when running on Windows (e.g., suggesting PowerShell instead of AppleScript, process names instead of bundle IDs).
7. THE `get_app_capabilities` tool on Windows SHALL report whether an application's window supports UI_Automation, whether it is running, and whether it is minimized.
8. THE Server_Layer SHALL expose the following tools on Windows only: filesystem, registry, notification. On macOS these tools SHALL return an error indicating they are Windows-only, with a suggestion to use shell commands or osascript for equivalent operations.
9. THE Server_Layer SHALL expose `process_kill` on both platforms; on Windows it SHALL terminate processes by name or PID using TerminateProcess, and on macOS it SHALL use the `kill` signal mechanism.

### Requirement 18: Windows-Specific Identifier Mapping

**User Story:** As an AI agent, I want to use consistent identifiers across platforms, so that I can write cross-platform automation logic without platform-specific branching.

#### Acceptance Criteria

1. WHEN a tool accepts a `bundle_id` parameter on macOS, THE equivalent parameter on Windows SHALL accept a process name (e.g., "notepad.exe") or executable path, and the Session_Layer SHALL handle the mapping transparently.
2. WHEN a tool accepts a `window_id` parameter (CGWindowID on macOS), THE equivalent parameter on Windows SHALL accept an HWND (window handle), and the Session_Layer SHALL handle the mapping transparently.
3. THE Session_Layer SHALL normalize the `target_app` parameter: on macOS it SHALL be treated as a bundle ID, on Windows it SHALL be treated as a process name or executable path.
4. THE Session_Layer SHALL normalize window targeting: on macOS using CGWindowID, on Windows using HWND, with the same `target_window_id` parameter name in both cases.

### Requirement 19: Focus Management on Windows

**User Story:** As an AI agent, I want reliable focus management on Windows, so that keyboard and mouse input is delivered to the correct window.

#### Acceptance Criteria

1. WHEN a mutating tool is dispatched with `focus_strategy: "strict"`, THE Session_Layer SHALL verify that the target window is the foreground window after activation, and return a FocusFailure error if verification fails.
2. WHEN a mutating tool is dispatched with `focus_strategy: "best_effort"`, THE Session_Layer SHALL attempt to bring the target window to the foreground and proceed with input delivery regardless of the outcome.
3. WHEN a mutating tool is dispatched with `focus_strategy: "none"`, THE Session_Layer SHALL skip all focus acquisition and deliver input to the current foreground window.
4. WHEN a mutating tool is dispatched with `focus_strategy: "prepare_display"`, THE Session_Layer SHALL minimize all non-target application windows, activate the target window, and return the list of minimized window handles so the caller can restore them.
5. THE Session_Layer SHALL use AttachThreadInput combined with SetForegroundWindow for reliable focus acquisition on Windows, matching the pattern used by the Windows-MCP reference project.
6. WHEN focus acquisition fails on Windows, THE Session_Layer SHALL return a structured FocusFailure payload with the same schema as macOS (requestedBundleId mapped to process name, suggestedRecovery, etc.).

### Requirement 20: Testing Strategy

**User Story:** As a developer, I want a comprehensive testing strategy for Windows support, so that I can verify correctness on both platforms.

#### Acceptance Criteria

1. THE test suite SHALL include unit tests for all Windows-specific Rust functions that can be tested in isolation (key code mapping, coordinate normalization, input structure construction).
2. THE test suite SHALL include property-based tests for cross-platform invariants: the NativeModule interface SHALL have the same set of exported function names on both platforms.
3. THE test suite SHALL include property-based tests for keyboard mapping: FOR ALL valid key combination strings, parsing then formatting SHALL produce an equivalent string (round-trip property).
4. THE test suite SHALL include integration tests that run on Windows CI and verify basic tool operations: screenshot capture returns a valid image, mouse move changes cursor position, key press generates input, clipboard read/write round-trips text.
5. THE test suite SHALL include smoke tests that verify the MCP server starts on Windows, lists the expected number of tools, and responds to a screenshot tool call.
6. THE existing macOS test suite (78 tests) SHALL continue to pass without modification after the Windows support changes.

### Requirement 21: Documentation Updates

**User Story:** As a user, I want updated documentation that covers Windows installation, permissions, and usage, so that I can set up and use the package on Windows.

#### Acceptance Criteria

1. THE README SHALL be updated to remove the "macOS only" designation and list both macOS and Windows as supported platforms.
2. THE README SHALL include a Windows-specific permissions section explaining that no special permissions are required for most operations (unlike macOS Accessibility permission), but that UI Automation access may require running as a non-restricted user.
3. THE README SHALL include Windows-specific MCP client configuration examples (Claude Desktop on Windows, Cursor on Windows, etc.).
4. THE README SHALL include a platform compatibility table listing each tool and its support status on macOS and Windows.
5. THE CHANGELOG SHALL include a version entry documenting the addition of Windows support, listing all new capabilities and any behavioral differences from macOS.
6. THE README SHALL document the Windows-specific `run_script` language ("powershell") and provide usage examples.

### Requirement 22: Error Handling and Graceful Degradation

**User Story:** As an AI agent, I want clear error messages when a tool is unavailable or fails on a specific platform, so that I can adapt my automation strategy.

#### Acceptance Criteria

1. IF a macOS-only tool (get_app_dictionary, list_menu_bar) is called on Windows, THEN THE Server_Layer SHALL return an error with `isError: true` containing a message that identifies the tool as macOS-only and suggests a Windows alternative.
2. IF a Windows-specific API call fails due to insufficient permissions (e.g., UI Automation blocked by UIPI), THEN THE NAPI_Module SHALL return a descriptive error explaining the permission issue and suggesting running with appropriate privileges.
3. IF a window handle becomes invalid between resolution and action (race condition), THEN THE NAPI_Module SHALL return a descriptive error indicating the window no longer exists.
4. THE NAPI_Module SHALL catch and convert all Windows HRESULT errors and COM exceptions into descriptive JavaScript error messages, avoiding raw numeric error codes in user-facing output.

### Requirement 23: Session Lock on Windows

**User Story:** As a developer, I want the cross-process session lock to work on Windows, so that two MCP server instances do not fight over the cursor.

#### Acceptance Criteria

1. THE Session_Layer SHALL implement the session lock on Windows using a named mutex (e.g., `Global\computer-use-mcp-session`) or a lock file in the user's temp directory.
2. WHEN a second MCP server instance attempts to acquire the session lock on Windows, THE Session_Layer SHALL throw a LockError identifying the holding process.
3. WHEN the holding process terminates without releasing the lock, THE Session_Layer SHALL detect the stale lock and reclaim it.
4. THE session lock mechanism SHALL be transparent to the rest of the Session_Layer — the same `acquire`/`release` interface SHALL be used on both platforms.

### Requirement 24: Process Management on Windows

**User Story:** As an AI agent, I want to list and manage running processes on Windows, so that I can identify applications and their windows.

#### Acceptance Criteria

1. WHEN a list-running-apps action is dispatched on Windows, THE NAPI_Module SHALL enumerate processes with visible windows using CreateToolhelp32Snapshot and return process name, process ID, executable path, and whether the process has a visible (non-minimized) window.
2. THE NAPI_Module SHALL filter out system processes without user-visible windows (e.g., svchost, csrss) from the list-running-apps results, returning only applications with at least one visible or minimized top-level window.
3. WHEN an open-application action is dispatched with an application name on Windows, THE NAPI_Module SHALL search the Start Menu shortcuts and shell:AppsFolder for a matching application and launch it.
4. WHEN a process-kill action is dispatched with a process name, THE NAPI_Module SHALL terminate all processes matching the specified name using TerminateProcess.
5. WHEN a process-kill action is dispatched with a PID, THE NAPI_Module SHALL terminate the process with the specified process ID using TerminateProcess.
6. WHEN a process-kill action is dispatched with the `force` parameter set to true, THE NAPI_Module SHALL forcefully terminate the process without allowing graceful shutdown; WHEN `force` is false, THE NAPI_Module SHALL attempt a graceful close by sending WM_CLOSE to the process's windows before falling back to TerminateProcess.
7. IF the specified process name or PID does not match any running process, THEN THE NAPI_Module SHALL return a descriptive error indicating no matching process was found.


### Requirement 25: FileSystem Operations on Windows

**User Story:** As an AI agent, I want to read, write, copy, move, delete, list, search, and inspect files and directories on Windows, so that I can manage files during automation workflows without relying on shell commands.

#### Acceptance Criteria

1. WHEN a filesystem read action is dispatched with a file path, THE FileSystem_Tool SHALL read the file contents using the specified encoding (defaulting to UTF-8) and return the text content.
2. WHEN a filesystem read action is dispatched with `offset` and `limit` parameters, THE FileSystem_Tool SHALL return only the specified range of lines from the file.
3. WHEN a filesystem write action is dispatched with a file path and content, THE FileSystem_Tool SHALL create or overwrite the file with the provided content.
4. WHEN a filesystem write action is dispatched with the `append` parameter set to true, THE FileSystem_Tool SHALL append the content to the existing file instead of overwriting it.
5. WHEN a filesystem copy action is dispatched with a source path and destination path, THE FileSystem_Tool SHALL copy the file or directory to the destination, respecting the `overwrite` parameter.
6. WHEN a filesystem move action is dispatched with a source path and destination path, THE FileSystem_Tool SHALL move or rename the file or directory to the destination, respecting the `overwrite` parameter.
7. WHEN a filesystem delete action is dispatched with a path, THE FileSystem_Tool SHALL delete the file; WHEN the path is a non-empty directory and `recursive` is false, THE FileSystem_Tool SHALL return an error; WHEN `recursive` is true, THE FileSystem_Tool SHALL delete the directory and all its contents.
8. WHEN a filesystem list action is dispatched with a directory path, THE FileSystem_Tool SHALL return the directory contents, optionally filtered by a glob `pattern` and optionally including hidden files when `show_hidden` is true.
9. WHEN a filesystem search action is dispatched with a base path and a glob pattern, THE FileSystem_Tool SHALL find all files matching the pattern, optionally searching recursively.
10. WHEN a filesystem info action is dispatched with a path, THE FileSystem_Tool SHALL return metadata including file size, creation date, modification date, and whether the path is a file or directory.
11. WHEN a relative path is provided, THE FileSystem_Tool SHALL resolve it from the user's Desktop folder on Windows.
12. IF the specified file or directory does not exist, THEN THE FileSystem_Tool SHALL return a descriptive error indicating the path was not found.

### Requirement 26: Windows Registry Operations

**User Story:** As an AI agent, I want to read, write, delete, and list Windows Registry keys and values, so that I can inspect and modify system and application settings during automation.

#### Acceptance Criteria

1. WHEN a registry get action is dispatched with a path and name, THE Registry_Tool SHALL read the specified registry value and return its data and type.
2. WHEN a registry set action is dispatched with a path, name, value, and type, THE Registry_Tool SHALL create or update the specified registry value with the given data and type (String, DWord, QWord, Binary, MultiString, or ExpandString).
3. WHEN a registry delete action is dispatched with a path and name, THE Registry_Tool SHALL delete the specified registry value; WHEN name is omitted, THE Registry_Tool SHALL delete the entire registry key.
4. WHEN a registry list action is dispatched with a path, THE Registry_Tool SHALL return all values and sub-keys under the specified registry path.
5. THE Registry_Tool SHALL accept paths in PowerShell format (e.g., "HKCU:\Software\MyApp", "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion").
6. IF the specified registry path or value does not exist, THEN THE Registry_Tool SHALL return a descriptive error indicating the path or value was not found.
7. IF the registry operation fails due to insufficient permissions (e.g., writing to HKLM without elevation), THEN THE Registry_Tool SHALL return a descriptive error explaining the permission issue.
8. THE Registry_Tool SHALL be exposed on Windows only; on macOS it SHALL return an error indicating the tool is Windows-only, with a suggestion to use `defaults` commands via `run_script` for equivalent operations.

### Requirement 27: Windows Toast Notifications

**User Story:** As an AI agent, I want to send Windows toast notifications, so that I can alert the user about automation progress or completed tasks.

#### Acceptance Criteria

1. WHEN a notification action is dispatched with a title and message, THE Notification_Tool SHALL display a Windows toast notification with the specified title and body text.
2. WHEN a notification action is dispatched with an `app_id` parameter, THE Notification_Tool SHALL associate the toast notification with the specified Application User Model ID so it appears under the correct app in the notification center.
3. IF the notification cannot be displayed (e.g., notifications are disabled for the app), THEN THE Notification_Tool SHALL return a descriptive error explaining the failure.
4. THE Notification_Tool SHALL be exposed on Windows only; on macOS it SHALL return an error indicating the tool is Windows-only, with a suggestion to use `osascript` via `run_script` for equivalent notification functionality.

### Requirement 28: Web Page Scraping

**User Story:** As an AI agent, I want to fetch and extract content from web pages, so that I can gather information from the web during automation workflows.

#### Acceptance Criteria

1. WHEN a scrape action is dispatched with a URL, THE Scrape_Tool SHALL perform an HTTP request to the URL and return the extracted text content.
2. WHEN a scrape action is dispatched with a `query` parameter, THE Scrape_Tool SHALL focus the content extraction on information relevant to the specified query.
3. WHEN a scrape action is dispatched with `use_dom` set to true, THE Scrape_Tool SHALL extract content from the active browser tab's DOM instead of performing an HTTP request, returning the visible page text with scroll position indicators.
4. WHEN a scrape action is dispatched with `use_sampling` set to true (the default), THE Scrape_Tool SHALL process the raw content through an LLM sampling call to produce a clean, concise summary stripped of navigation, ads, and boilerplate.
5. WHEN a scrape action is dispatched with `use_sampling` set to false, THE Scrape_Tool SHALL return the raw extracted content without LLM processing.
6. IF the HTTP request fails (e.g., network error, 404 response), THEN THE Scrape_Tool SHALL return a descriptive error including the HTTP status code or network error message.
7. IF `use_dom` is true and no browser tab is open with the specified URL, THEN THE Scrape_Tool SHALL return a descriptive error indicating the URL must be opened in the browser first.

### Requirement 29: Batch Element Selection (MultiSelect)

**User Story:** As an AI agent, I want to select multiple UI elements in a single action, so that I can efficiently perform multi-select operations like selecting multiple files or checkboxes.

#### Acceptance Criteria

1. WHEN a multi-select action is dispatched with a list of coordinates (`locs`), THE MultiSelect_Tool SHALL click each coordinate sequentially.
2. WHEN a multi-select action is dispatched with a list of UI element labels (`labels`), THE MultiSelect_Tool SHALL resolve each label to screen coordinates using the current UI tree snapshot and click each resolved coordinate.
3. WHEN a multi-select action is dispatched with `press_ctrl` set to true, THE MultiSelect_Tool SHALL hold the Ctrl key while clicking each coordinate, enabling additive selection (e.g., selecting multiple files in a file explorer).
4. WHEN a multi-select action is dispatched with `press_ctrl` set to false, THE MultiSelect_Tool SHALL click each coordinate without holding Ctrl, performing individual clicks at each location.
5. IF a label cannot be resolved to coordinates (e.g., the element is not in the current snapshot), THEN THE MultiSelect_Tool SHALL return a descriptive error identifying the unresolvable label.
6. IF no UI tree snapshot is available when labels are used, THEN THE MultiSelect_Tool SHALL return an error indicating that a Snapshot must be taken first.

### Requirement 30: Batch Text Input (MultiEdit)

**User Story:** As an AI agent, I want to enter text into multiple input fields in a single action, so that I can efficiently fill forms with many fields.

#### Acceptance Criteria

1. WHEN a multi-edit action is dispatched with a list of coordinate-text tuples (`locs` as [[x, y, text], ...]), THE MultiEdit_Tool SHALL click each coordinate and type the associated text sequentially.
2. WHEN a multi-edit action is dispatched with a list of label-text tuples (`labels` as [[label, text], ...]), THE MultiEdit_Tool SHALL resolve each label to screen coordinates using the current UI tree snapshot, click each resolved coordinate, and type the associated text.
3. THE MultiEdit_Tool SHALL process each field sequentially, clicking the target location before typing the text for that field.
4. IF a label cannot be resolved to coordinates, THEN THE MultiEdit_Tool SHALL return a descriptive error identifying the unresolvable label and the text that was not entered.
5. IF no UI tree snapshot is available when labels are used, THEN THE MultiEdit_Tool SHALL return an error indicating that a Snapshot must be taken first.
