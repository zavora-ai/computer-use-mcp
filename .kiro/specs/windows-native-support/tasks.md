# Implementation Plan: Windows Native Support

## Overview

This plan implements cross-platform Windows support for `@zavora-ai/computer-use-mcp`, transforming it from a macOS-only MCP server into a dual-platform desktop automation tool. The implementation follows a bottom-up dependency order: build system and platform detection first, then Rust native modules (mouse, keyboard, screenshot, clipboard, windows, apps, accessibility, display, spaces), then TypeScript layer adaptations (session, server, client), then new Windows-specific tools, then testing, CI, benchmarks, documentation, and distribution.

All Rust native modules use `#[cfg(target_os)]` conditional compilation within the same source files. The TypeScript layer uses `process.platform` checks at a few well-defined branch points. The NAPI function signatures are identical on both platforms.

## Tasks

- [x] 1. Build system and Cargo.toml setup for cross-platform compilation
  - [x] 1.1 Update `native/Cargo.toml` with platform-conditional dependencies
    - Move `core-graphics`, `core-graphics-types`, `core-foundation`, `objc` under `[target.'cfg(target_os = "macos")'.dependencies]`
    - Add `[target.'cfg(target_os = "windows")'.dependencies]` section with `windows` crate (v0.58) and required Win32 feature flags: `Win32_UI_Input_KeyboardAndMouse`, `Win32_UI_WindowsAndMessaging`, `Win32_UI_Accessibility`, `Win32_Graphics_Dxgi`, `Win32_Graphics_Dxgi_Common`, `Win32_Graphics_Direct3D11`, `Win32_Graphics_Gdi`, `Win32_System_Com`, `Win32_System_Threading`, `Win32_System_ProcessStatus`, `Win32_System_Diagnostics_ToolHelp`, `Win32_System_DataExchange`, `Win32_System_Memory`, `Win32_System_Ole`, `Win32_Foundation`, `Win32_Security`, `Win32_Storage_FileSystem`
    - Add `image` crate (v0.25, jpeg feature only) under Windows dependencies for screenshot encoding
    - _Requirements: 14.2, 14.3_

  - [x] 1.2 Update `native/build.rs` for conditional framework linking
    - Wrap macOS framework link directives (`AppKit`, `CoreGraphics`, `CoreFoundation`, `ApplicationServices`, `ImageIO`) in `#[cfg(target_os = "macos")]` block
    - Windows linking is handled automatically by `windows-rs` build script — no additional directives needed
    - _Requirements: 14.1, 14.5, 14.6_

  - [x] 1.3 Update `package.json` build scripts for cross-platform binary naming
    - Add `build:native:win` script: `cd native && cargo build --release && copy target\\release\\computer_use_napi.dll ..\\computer-use-napi.win32-x64.node`
    - Update `build:native` (macOS) to produce `computer-use-napi.darwin-arm64.node` or `computer-use-napi.darwin-x64.node` based on architecture
    - Remove `"os": ["darwin"]` restriction from package.json, replace with `["darwin", "win32"]`
    - Update `files` array to include all platform-specific `.node` binaries
    - _Requirements: 15.2, 15.3, 16.1, 16.3_

- [ ] 2. Platform detection and native module loading (`src/native.ts`)
  - [ ] 2.1 Refactor `native.ts` for cross-platform binary loading
    - Remove the `if (process.platform !== 'darwin') throw` guard
    - Implement platform-specific binary path resolution: `computer-use-napi.${process.platform}-${process.arch}.node`
    - Map `process.platform` + `process.arch` to binary names: `darwin`+`arm64` → `darwin-arm64`, `darwin`+`x64` → `darwin-x64`, `win32`+`x64` → `win32-x64`
    - Throw descriptive error on unsupported platform (listing supported platforms) or missing binary (suggesting rebuild)
    - Keep the `NativeModule` TypeScript interface unchanged — same function signatures on both platforms
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

  - [ ] 2.2 Add Windows-specific `NativeModule` extensions to the interface
    - Add `clipboard.rs` exports to the interface: `readClipboard(): string`, `writeClipboard(text: string): void` (on macOS these are handled in session layer via pbcopy/pbpaste; on Windows they go through native)
    - Ensure all existing interface methods remain unchanged for macOS backward compatibility
    - _Requirements: 5.1, 5.2, 14.4_

- [ ] 3. Checkpoint — Verify build system compiles on both platforms
  - Ensure `cargo build --release` succeeds on macOS (existing behavior preserved)
  - Ensure `cargo build --release --target x86_64-pc-windows-msvc` cross-compiles or compiles on Windows
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Implement Rust native module: `mouse.rs` — Mouse input on Windows
  - [ ] 4.1 Add Windows mouse input implementation with `#[cfg(target_os = "windows")]`
    - Implement `mouse_click(x, y, button, count)` using `SendInput` with `MOUSEINPUT` structures
    - Implement coordinate normalization: `(x * 65535) / screen_width` for `MOUSEEVENTF_ABSOLUTE`
    - Implement move-and-settle pattern: move cursor first, sleep 10ms, then click
    - Support left, right, middle buttons; validate button string and return error for invalid values
    - Implement `mouse_move(x, y)` using `SendInput` with `MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE`
    - Implement `mouse_button(action, x, y)` for mouse-down/mouse-up without release
    - Implement `mouse_scroll(dy, dx)` using `MOUSEEVENTF_WHEEL` / `MOUSEEVENTF_HWHEEL`
    - Implement `mouse_drag(x, y)` with animated movement (mouse-down, incremental moves, mouse-up)
    - Implement `cursor_position()` using `GetCursorPos` Win32 API
    - Use `GetSystemMetrics(SM_CXVIRTUALSCREEN)` for multi-monitor coordinate normalization
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11_


- [ ] 5. Implement Rust native module: `keyboard.rs` — Keyboard input on Windows
  - [ ] 5.1 Add Windows keyboard input implementation with `#[cfg(target_os = "windows")]`
    - Implement `type_text(text)` using `SendInput` with `KEYBDINPUT` and `KEYEVENTF_UNICODE` for each UTF-16 code unit
    - Implement long text optimization: for strings >100 chars, use clipboard paste (`WriteClipboard` + synthesize Ctrl+V) to avoid per-character overhead
    - Implement `key_press(combo, repeat)` — parse combo string by splitting on "+", map modifier names to Windows VK codes
    - Build the `WIN_KEY_MAP` static HashMap with `OnceLock`: letters a-z (VK_A..VK_Z), digits 0-9, function keys f1-f12, navigation keys (home, end, pageup, pagedown, arrows), special keys (return, tab, space, delete, backspace, escape)
    - Implement modifier mapping: `command`/`super`/`cmd` → `VK_LWIN`, `option`/`alt` → `VK_MENU`, `control`/`ctrl` → `VK_CONTROL`, `shift` → `VK_SHIFT`
    - Implement `hold_key(keys, duration_ms)` — press all keys, sleep for duration, release in reverse order
    - Return descriptive error listing unrecognized key name when an invalid key is provided
    - Support repeat count for key_press
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

  - [ ] 5.2 Write property test for key combination parsing round-trip
    - **Property 2: Key Combination Parsing Round-Trip**
    - Generate random valid key combos from supported modifier + key name sets
    - Verify parsing into VK codes and formatting back produces equivalent combo
    - **Validates: Requirements 3.2, 3.5**

- [ ] 6. Implement Rust native module: `screenshot.rs` — Screenshot capture on Windows
  - [ ] 6.1 Add Windows screenshot implementation with `#[cfg(target_os = "windows")]`
    - Implement primary path: DXGI Desktop Duplication via `IDXGIOutputDuplication::AcquireNextFrame` → `ID3D11Texture2D` → map to CPU memory → JPEG encode with `image` crate
    - Implement GDI BitBlt fallback: `CreateCompatibleDC` → `CreateCompatibleBitmap` → `BitBlt` → read DIB bits; triggered when DXGI returns `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE` or `DXGI_ERROR_UNSUPPORTED`
    - Implement per-window capture using `PrintWindow` API when `window_id` (HWND) is specified
    - Implement resize using `image` crate when `width` parameter is provided (preserve aspect ratio)
    - Implement JPEG encoding with configurable quality (1-100)
    - Return base64-encoded JPEG string with width, height, mimeType ("image/jpeg"), and 16-char hex content hash
    - Implement hash dedup: compare with `previous_hash`, return `unchanged: true` when hashes match
    - Implement multi-monitor support: `EnumDisplayMonitors` to get monitor rects, create DXGI output per adapter/output
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [ ] 6.2 Write property test for screenshot structural invariants
    - **Property 3: Screenshot Structural Invariants**
    - For any successful screenshot, verify: width > 0, height > 0, mimeType === "image/jpeg", hash is 16-char hex, base64 decodes to bytes starting with JPEG SOI marker (0xFF 0xD8)
    - **Validates: Requirements 4.5**

  - [ ] 6.3 Write property test for screenshot hash idempotence
    - **Property 4: Screenshot Hash Idempotence**
    - Capture screenshot twice of stable screen, pass first hash as previous_hash to second; verify second returns unchanged: true with same hash
    - **Validates: Requirements 4.6**

- [ ] 7. Implement Rust native module: `clipboard.rs` — Clipboard operations on Windows
  - [ ] 7.1 Create `native/src/clipboard.rs` with Windows clipboard implementation
    - Implement `read_clipboard()`: `OpenClipboard(NULL)` → `GetClipboardData(CF_UNICODETEXT)` → `GlobalLock` → read UTF-16 → `GlobalUnlock` → `CloseClipboard` → convert to UTF-8 string
    - Implement `write_clipboard(text)`: `OpenClipboard(NULL)` → `EmptyClipboard` → `GlobalAlloc(GMEM_MOVEABLE)` → `GlobalLock` → write UTF-16 → `GlobalUnlock` → `SetClipboardData(CF_UNICODETEXT)` → `CloseClipboard`
    - Implement retry logic: if `OpenClipboard` fails, retry up to 3 times with 50ms delay; return error if all retries fail
    - Return empty string or descriptive message when clipboard contains non-text data
    - On macOS, provide no-op stubs or `#[cfg]` exclude — macOS clipboard is handled in session layer via pbcopy/pbpaste
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ] 7.2 Write property test for clipboard text round-trip
    - **Property 5: Clipboard Text Round-Trip**
    - Generate random Unicode strings (excluding null characters), write to clipboard, read back, verify equality
    - **Validates: Requirements 5.1, 5.2**

- [ ] 8. Implement Rust native module: `windows.rs` — Window enumeration and management on Windows
  - [ ] 8.1 Add Windows window management implementation with `#[cfg(target_os = "windows")]`
    - Implement `list_windows(process_name?)`: `EnumWindows` callback collecting HWND, filter by `IsWindowVisible` and `GetWindowLong(GWL_EXSTYLE)` to exclude tool windows; get title via `GetWindowText`, PID via `GetWindowThreadProcessId`, bounds via `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)` with `GetWindowRect` fallback, process name via `OpenProcess` + `QueryFullProcessImageName`
    - Implement `get_window(hwnd)`: return WindowRecord for specific HWND with all fields populated
    - Implement `get_cursor_window()`: `GetCursorPos` → `WindowFromPoint` → return WindowRecord
    - Implement `activate_app(process_name, timeout_ms?)`: find windows by process name, `AttachThreadInput` + `SetForegroundWindow` + `BringWindowToTop`, return before/after diagnostics
    - Implement `activate_window(hwnd, timeout_ms?)`: `ShowWindow(SW_RESTORE)` if minimized, then `SetForegroundWindow` + `BringWindowToTop`
    - Implement `get_frontmost_app()`: `GetForegroundWindow` → get process name, PID, window title
    - Implement display mapping: `MonitorFromWindow` to determine which monitor contains a window
    - Return descriptive error for invalid/stale HWND
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9_

- [ ] 9. Implement Rust native module: `apps.rs` — Application lifecycle on Windows
  - [ ] 9.1 Add Windows application lifecycle implementation with `#[cfg(target_os = "windows")]`
    - Implement `list_running_apps()`: `CreateToolhelp32Snapshot` + `Process32First`/`Process32Next`, filter to processes with visible windows via `EnumWindows`, return process name, PID, executable path, isHidden (all windows minimized)
    - Filter out system processes without user-visible windows (svchost, csrss, etc.)
    - Implement `open_application(name)`: search Start Menu shortcuts and `shell:AppsFolder` for matching app, launch via `ShellExecute` or `CreateProcess`; return PID; return error if app not found
    - Implement `hide_app(process_name)`: `EnumWindows` for target process → `ShowWindow(hwnd, SW_MINIMIZE)` for each window
    - Implement `unhide_app(process_name)`: `EnumWindows` for target process → `ShowWindow(hwnd, SW_RESTORE)` for each window
    - Implement `prepare_display(target, keep_visible)`: minimize all non-target windows, return list of minimized HWNDs
    - Implement `drainRunloop()` as a no-op on Windows (no CFRunLoop equivalent needed)
    - Implement window resize: `MoveWindow` or `SetWindowPos` with specified dimensions and/or position
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 12.4, 24.1, 24.2, 24.3_

- [ ] 10. Implement Rust native module: `accessibility.rs` — UI Automation on Windows
  - [ ] 10.1 Add Windows UI Automation implementation with `#[cfg(target_os = "windows")]`
    - Initialize COM: `CoInitializeEx(COINIT_MULTITHREADED)` at module load via `OnceLock`
    - Create singleton `IUIAutomation` instance via `CoCreateInstance` cached in `OnceLock`
    - Implement `get_ui_tree(hwnd, max_depth?)`: `IUIAutomation::ElementFromHandle(hwnd)` → walk tree with `IUIAutomationTreeWalker::GetFirstChildElement`/`GetNextSiblingElement`, depth limit (default 10, max 20), 500-node cap, set truncated flag when cap reached
    - Implement control type to role string mapping table (UIA_ButtonControlTypeId → "AXButton", UIA_EditControlTypeId → "AXTextField", etc. — full table from design)
    - Map element properties: Name → label, Value pattern → value, BoundingRectangle → bounds, supported patterns → actions (Invoke → "AXPress", Value → "AXSetValue", Toggle → "AXPress")
    - Implement `find_element(hwnd, role?, label?, value?, max_results?)`: `IUIAutomation::CreatePropertyCondition` for ControlType/Name/Value → `FindAll` with `TreeScope_Descendants`
    - Implement `get_focused_element()`: `IUIAutomation::GetFocusedElement` → return AXElement or null
    - Implement `perform_action(hwnd, role, label, action)`: find element, invoke pattern (Invoke → `Invoke()`, Toggle → `Toggle()`), fall back to coordinate click at element center if pattern unsupported
    - Implement `set_element_value(hwnd, role, label, value)`: find element, use Value pattern `SetValue()`
    - Implement menu navigation: walk MenuBar → MenuItem tree using `FindFirst` with Name conditions for `press_menu_item`
    - Implement `get_menu_bar(process_name)`: walk menu bar structure via UI Automation tree
    - Return error with closest matching labels (ranked by string similarity) when element not found
    - Handle UIPI errors: return descriptive error when UI Automation is blocked by privilege isolation
    - Convert all HRESULT/COM errors to descriptive strings using `windows-rs` `Error::message()`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 22.2, 22.4_

- [ ] 11. Implement Rust native module: `display.rs` — Display information on Windows
  - [ ] 11.1 Add Windows display information implementation with `#[cfg(target_os = "windows")]`
    - Implement `get_display_size(display_id?)`: `MonitorFromPoint(POINT{0,0}, MONITOR_DEFAULTTOPRIMARY)` for primary, `GetMonitorInfo` for dimensions, `GetDpiForMonitor` for scale factor; compute pixelWidth/pixelHeight from DPI (scale = DPI / 96.0)
    - Implement `list_displays()`: `EnumDisplayMonitors` callback + `GetMonitorInfo` + `GetDpiForMonitor` for each monitor; return dimensions, scale factors, display IDs
    - _Requirements: 10.1, 10.2, 10.3_

- [ ] 12. Implement Rust native module: `spaces.rs` — Virtual desktop support on Windows
  - [ ] 12.1 Add Windows virtual desktop implementation with `#[cfg(target_os = "windows")]`
    - Implement `list_spaces()`: use `IVirtualDesktopManager` COM interface (public API) + `IVirtualDesktopManagerInternal` (undocumented, build-dependent GUIDs) for `GetDesktops`, `GetCurrentDesktop`
    - Handle build-dependent GUIDs for Windows 10 (19041+), Windows 11 22H2 (22621+), Windows 11 24H2 (26100+)
    - Read desktop names from registry `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops\Desktops\{GUID}\Name`
    - Implement `get_active_space()`: return ID and name of currently active virtual desktop
    - Implement fallback: when COM interfaces unavailable (Windows Server), return single "Default Desktop" entry with `supported: false`
    - _Requirements: 11.1, 11.2, 11.3_

- [ ] 13. Update Rust module root: `lib.rs`
  - [ ] 13.1 Update `native/src/lib.rs` to include `clipboard` module and ensure all modules compile on both platforms
    - Add `mod clipboard;` declaration
    - Ensure all module declarations work with `#[cfg]` conditional compilation — each module file contains both macOS and Windows implementations gated by `#[cfg(target_os)]`
    - Verify all NAPI exports are present on both platforms (same function names)
    - _Requirements: 14.1, 14.4, 14.5, 14.6_

  - [ ] 13.2 Write property test for NAPI export parity
    - **Property 1: NAPI Export Parity**
    - Enumerate all function names exported by the NativeModule interface
    - Verify the same set of function names is available on both platforms
    - **Validates: Requirements 1.4, 14.4**

- [ ] 14. Checkpoint — Verify all Rust native modules compile and export correctly
  - Ensure `cargo build --release` succeeds on both platforms
  - Ensure all NAPI function exports match the NativeModule TypeScript interface
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Session layer platform adaptations (`src/session.ts`)
  - [ ] 15.1 Add platform detection constants and adapt session initialization
    - Add `const IS_WINDOWS = process.platform === 'win32'` and `const IS_MACOS = process.platform === 'darwin'` constants
    - Adapt session lock path: use `%TEMP%\.computer-use-mcp.lock` on Windows, `/tmp/.computer-use-mcp.lock` on macOS
    - Skip CFRunLoop drain pump on Windows (don't start the 1ms `drainRunloop()` interval when `IS_WINDOWS`)
    - Adapt clipboard operations: on Windows, delegate to native `readClipboard()`/`writeClipboard()` instead of pbcopy/pbpaste
    - _Requirements: 12.1, 12.3, 12.4, 23.1, 23.2, 23.3, 23.4_

  - [ ] 15.2 Adapt focus management for Windows
    - Update `ensureFocusV4` to use Windows-appropriate activation: `n.activateApp(processName)` which internally uses `AttachThreadInput` + `SetForegroundWindow`
    - Adapt `prepare_display` strategy: minimize non-target windows on Windows (via `ShowWindow(SW_MINIMIZE)`) instead of hiding apps; return `minimizedHwnds` instead of `hiddenBundleIds`
    - Adapt `buildFocusFailure` to use process names instead of bundle IDs on Windows
    - Adapt `resolveKeepVisibleBundles` for Windows: use process name of terminal host instead of bundle ID
    - _Requirements: 12.2, 12.5, 19.1, 19.2, 19.3, 19.4, 19.5, 19.6_

  - [ ] 15.3 Adapt identifier mapping in session layer
    - Normalize `target_app` parameter: treat as bundle ID on macOS, process name on Windows
    - Normalize `window_id` / `target_window_id`: CGWindowID on macOS, HWND (as number) on Windows
    - Update `resolveTarget` to handle both identifier types transparently
    - _Requirements: 12.6, 18.1, 18.2, 18.3, 18.4_

  - [ ] 15.4 Implement PowerShell scripting bridge for Windows
    - Handle `run_script` on Windows: accept `language: "powershell"`, reject "applescript"/"javascript" with platform error and PowerShell suggestion
    - Encode PowerShell commands as Base64 UTF-16LE, spawn via `-EncodedCommand` parameter
    - Try `pwsh` (PowerShell 7) first, fall back to `powershell` (5.1)
    - Prepare complete environment block by supplementing missing variables from Windows Registry
    - Implement timeout handling: kill PowerShell process on timeout, return timeout error
    - Handle `get_app_dictionary` on Windows: return `platform_unsupported` error with suggestion to use `get_ui_tree`
    - _Requirements: 12.7, 13.1, 13.2, 13.3, 13.4, 13.5_

  - [ ] 15.5 Write property test for PowerShell command encoding round-trip
    - **Property 6: PowerShell Command Encoding Round-Trip**
    - Generate random PowerShell command strings, encode as Base64 UTF-16LE, decode back, verify equality
    - **Validates: Requirements 13.3**

  - [ ] 15.6 Adapt `type` tool for Windows-specific parameters
    - Implement `clear` parameter: select all + delete before typing on Windows (Ctrl+A, Delete)
    - Implement `press_enter` parameter: synthesize Return key after typing
    - Implement `caret_position` parameter: move caret to start (Home), end (End), or leave idle before typing
    - _Requirements: 3.8, 3.9, 3.10_

  - [ ] 15.7 Adapt screenshot tool for Windows-specific parameters
    - Implement `display` parameter: capture specific monitors by index using `EnumDisplayMonitors`
    - Implement `use_annotation` parameter: draw colored bounding box overlays on detected UI elements
    - Implement `width_reference_line` / `height_reference_line` parameters: overlay grid reference lines
    - _Requirements: 4.8, 4.9, 4.10_

- [ ] 16. Checkpoint — Verify session layer works on both platforms
  - Ensure session initialization succeeds on both macOS and Windows
  - Ensure focus management, session lock, and scripting bridge work correctly
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 17. Implement new MCP tools in server layer (`src/server.ts`)
  - [ ] 17.1 Implement FileSystem tool (Windows-only, TypeScript)
    - Register `filesystem` tool in server.ts with Zod schema for operations: read, write, copy, move, delete, list, search, info
    - Implement using Node.js `fs` and `path` modules — no Rust needed
    - Support parameters: `mode` (read/write/copy/move/delete/list/search/info), `path`, `content`, `encoding` (default UTF-8), `offset`, `limit`, `append`, `overwrite`, `recursive`, `pattern`, `show_hidden`
    - Resolve relative paths from `os.homedir() + '/Desktop'` on Windows
    - On macOS, return error indicating tool is Windows-only with suggestion to use shell commands or osascript
    - _Requirements: 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.7, 25.8, 25.9, 25.10, 25.11, 25.12, 17.8_

  - [ ] 17.2 Write property test for FileSystem write-read round-trip
    - **Property 8: FileSystem Write-Read Round-Trip**
    - Generate random UTF-8 strings and file paths, write via FileSystem tool, read back, verify equality
    - **Validates: Requirements 25.1, 25.3**

  - [ ] 17.3 Implement Registry tool (Windows-only, PowerShell)
    - Register `registry` tool in server.ts with Zod schema for operations: get, set, delete, list
    - Implement via PowerShell commands dispatched through session's `spawnBounded`: `Get-ItemProperty` for reads, `Set-ItemProperty`/`New-ItemProperty` for writes, `Remove-ItemProperty`/`Remove-Item` for deletes, `Get-ChildItem` for listing
    - Accept PowerShell-format paths (e.g., `HKCU:\Software\MyApp`)
    - Support value types: String, DWord, QWord, Binary, MultiString, ExpandString
    - Return descriptive errors for missing paths/values and permission issues
    - On macOS, return error indicating tool is Windows-only with suggestion to use `defaults` commands
    - _Requirements: 26.1, 26.2, 26.3, 26.4, 26.5, 26.6, 26.7, 26.8, 17.8_

  - [ ] 17.4 Implement Notification tool (Windows-only, PowerShell)
    - Register `notification` tool in server.ts with Zod schema for title, message, and optional app_id
    - Implement via PowerShell using Windows toast notification API (`ToastNotificationManager`)
    - Support custom Application User Model ID via `app_id` parameter
    - Return descriptive error when notifications are disabled
    - On macOS, return error indicating tool is Windows-only with suggestion to use osascript
    - _Requirements: 27.1, 27.2, 27.3, 27.4, 17.8_

  - [ ] 17.5 Implement Scrape tool (cross-platform, Node.js)
    - Register `scrape` tool in server.ts with Zod schema for url, query, use_dom, use_sampling
    - Implement HTTP fetching using Node.js built-in `fetch` (Node 18+)
    - Implement HTML-to-text content extraction (lightweight converter)
    - Implement `use_dom` mode: extract content from active browser tab via UI Automation on Windows
    - Implement `use_sampling` mode: process raw content through LLM sampling for clean summary (default true)
    - Return descriptive errors for network failures, 404 responses, missing browser tabs
    - _Requirements: 28.1, 28.2, 28.3, 28.4, 28.5, 28.6, 28.7_

  - [ ] 17.6 Implement MultiSelect tool (cross-platform, session-layer orchestration)
    - Register `multi_select` tool in server.ts with Zod schema for locs (coordinates), labels, press_ctrl
    - Implement by composing existing primitives: loop over coordinates, hold Ctrl if `press_ctrl`, click each
    - Support label-based selection: resolve labels to coordinates using UI tree snapshot
    - Return error for unresolvable labels or missing snapshot
    - _Requirements: 29.1, 29.2, 29.3, 29.4, 29.5, 29.6_

  - [ ] 17.7 Implement MultiEdit tool (cross-platform, session-layer orchestration)
    - Register `multi_edit` tool in server.ts with Zod schema for locs (coordinate-text tuples), labels (label-text tuples)
    - Implement by composing existing primitives: loop over coordinate-text pairs, click then type each
    - Support label-based input: resolve labels to coordinates using UI tree snapshot
    - Return error for unresolvable labels or missing snapshot
    - _Requirements: 30.1, 30.2, 30.3, 30.4, 30.5_

  - [ ] 17.8 Implement process_kill tool (cross-platform)
    - Register `process_kill` tool in server.ts with Zod schema for process_name, pid, force
    - On Windows: terminate by name or PID using `TerminateProcess`; when `force` is false, send `WM_CLOSE` first
    - On macOS: use `kill` signal mechanism
    - Return error when no matching process found
    - _Requirements: 24.4, 24.5, 24.6, 24.7, 17.9_

- [ ] 18. Update server layer tool registrations and platform guards (`src/server.ts`)
  - [ ] 18.1 Add platform guards for macOS-only and Windows-only tools
    - `get_app_dictionary`: on Windows, return `platform_unsupported` error with suggestion to use `get_ui_tree`
    - `list_menu_bar`: on Windows, return `platform_unsupported` error with suggestion to use `get_ui_tree` for menu discovery
    - `filesystem`, `registry`, `notification`: on macOS, return `platform_unsupported` error with macOS alternative suggestions
    - _Requirements: 17.3, 17.4, 17.8, 22.1_

  - [ ] 18.2 Update `run_script` tool schema for cross-platform language support
    - On macOS: accept "applescript" and "javascript" languages (existing behavior)
    - On Windows: accept "powershell" language
    - Update Zod schema to use platform-conditional enum or accept all three and validate in handler
    - _Requirements: 17.2_

  - [ ] 18.3 Adapt `get_tool_metadata` for Windows
    - Return accurate `focusRequired` values: use same labels ('cgevent', 'ax', 'scripting', 'none') on both platforms for consistency
    - Document that 'cgevent' maps to SendInput on Windows, 'ax' maps to IUIAutomation, 'scripting' maps to PowerShell
    - _Requirements: 17.5_

  - [ ] 18.4 Adapt `get_tool_guide` for Windows
    - Return Windows-appropriate recommendations: suggest PowerShell instead of AppleScript, process names instead of bundle IDs
    - Update `TOOL_GUIDE_TABLE` patterns with Windows-specific entries
    - _Requirements: 17.6_

  - [ ] 18.5 Adapt `get_app_capabilities` for Windows
    - Report whether application window supports UI Automation, whether it is running, whether it is minimized
    - _Requirements: 17.7_

  - [ ] 18.6 Register all cross-platform tools with identical schemas
    - Verify all tools listed in Requirement 17.1 are registered on both platforms with identical Zod schemas
    - _Requirements: 17.1_

  - [ ] 18.7 Write property test for MCP tool surface parity
    - **Property 7: MCP Tool Surface Parity**
    - Enumerate all tool names from the cross-platform tool set (Requirement 17.1)
    - Verify each tool is registered on both platforms with identical schema
    - **Validates: Requirements 17.1**

- [ ] 19. Update client API (`src/client.ts`)
  - [ ] 19.1 Add typed methods for new tools to `ComputerUseClient` interface
    - Add `filesystem(mode, path, opts?)` method for FileSystem tool
    - Add `registry(mode, path, opts?)` method for Registry tool
    - Add `notification(title, message, appId?)` method for Notification tool
    - Add `scrape(url, opts?)` method for Scrape tool
    - Add `multiSelect(opts)` method for MultiSelect tool
    - Add `multiEdit(opts)` method for MultiEdit tool
    - Add `processKill(nameOrPid, force?)` method for process_kill tool
    - Update `runScript` method signature to accept "powershell" language on Windows
    - Add all new methods to the `wrap()` function implementation
    - _Requirements: 17.1, 17.2, 17.8, 17.9_

- [ ] 20. Checkpoint — Verify all tools register and dispatch correctly on both platforms
  - Ensure MCP server starts on both platforms and lists all expected tools
  - Ensure platform-specific tools return appropriate errors on the wrong platform
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 21. Error handling and graceful degradation
  - [ ] 21.1 Implement platform-specific error handling patterns
    - Implement Tier 1 errors: platform unavailability — macOS-only tools on Windows return `platform_unsupported` with suggestion; Windows-only tools on macOS return equivalent
    - Implement Tier 2 errors: UIPI permission errors with descriptive message and remediation hint; COM HRESULT errors converted to descriptive strings via `windows-rs` `Error::message()`
    - Implement Tier 3 errors: stale HWND → `window_not_found`; clipboard lock after 3 retries → `clipboard_locked`; focus race → `FocusFailure` payload with `suggestedRecovery`
    - Implement `safe_com_call` pattern in Rust for all Windows COM calls
    - _Requirements: 22.1, 22.2, 22.3, 22.4_

- [ ] 22. CI pipeline setup (GitHub Actions for macOS + Windows)
  - [ ] 22.1 Create GitHub Actions workflow for cross-platform CI
    - Define matrix strategy with three runners: `macos-14` (aarch64-apple-darwin), `macos-13` (x86_64-apple-darwin), `windows-latest` (x86_64-pc-windows-msvc)
    - Install Rust toolchain and Node.js on each runner
    - Build native module: `cargo build --release` in `native/` directory
    - Copy built binary to platform-specific name (e.g., `computer-use-napi.win32-x64.node`)
    - Build TypeScript: `npm run build:ts`
    - Run TypeScript test suite on both platforms
    - Run platform-specific smoke tests on each runner
    - Upload platform-specific `.node` binaries as CI artifacts
    - _Requirements: 15.1, 15.2, 15.5, 15.6_

  - [ ] 22.2 Write integration tests for Windows CI
    - Verify screenshot returns valid JPEG on Windows
    - Verify mouse_move changes cursor position
    - Verify key_press generates input
    - Verify clipboard read/write round-trips text
    - Verify UI tree returns nodes for a known application (Notepad)
    - Verify MCP server starts and lists expected tools
    - _Requirements: 20.4, 20.5_

  - [ ] 22.3 Write smoke tests for Windows
    - Create `test/smoke-windows.test.mjs`: start server, connect in-process, verify tool count >= 45, verify screenshot succeeds
    - _Requirements: 20.5_

- [ ] 23. Performance benchmark harness
  - [ ] 23.1 Create benchmark runner script
    - Create `benchmarks/compare.ts` Node.js script that:
      - Starts our MCP server in-process
      - Optionally starts Windows-MCP as a subprocess for comparison
      - Runs each benchmark operation N times (default: 100)
      - Records timestamps with `performance.now()` (sub-ms precision)
      - Computes median, p95, p99 latencies
      - Outputs markdown comparison table
    - Define benchmark operations: screenshot (full screen), screenshot (single window), mouse click, mouse move, key press (single), type text (100 chars), UI tree (500 nodes), find element, clipboard write+read, tool dispatch overhead, memory baseline (RSS)
    - Define `BenchmarkResult` and `BenchmarkSuite` TypeScript interfaces matching design schema
    - Save results as JSON artifact for CI
    - _Requirements: Design Section 6.1_

- [ ] 24. Checkpoint — Verify CI pipeline and benchmarks
  - Ensure CI workflow runs successfully on all three platform runners
  - Ensure benchmark harness produces valid results
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 25. Documentation updates
  - [ ] 25.1 Update README.md for cross-platform support
    - Remove "macOS only" designation, list both macOS and Windows as supported platforms
    - Add Windows-specific permissions section (no special permissions for most operations; UI Automation may require non-restricted user)
    - Add Windows-specific MCP client configuration examples (Claude Desktop on Windows, Cursor on Windows)
    - Add platform compatibility table listing each tool and its support status on macOS and Windows
    - Document Windows-specific `run_script` language ("powershell") with usage examples
    - Document new tools: filesystem, registry, notification, scrape, multi_select, multi_edit, process_kill
    - _Requirements: 21.1, 21.2, 21.3, 21.4, 21.6_

  - [ ] 25.2 Update CHANGELOG.md
    - Add version entry documenting addition of Windows support
    - List all new capabilities: Windows native modules, new tools, cross-platform session layer
    - Document behavioral differences from macOS (process names vs bundle IDs, PowerShell vs AppleScript, etc.)
    - _Requirements: 21.5_

  - [ ] 25.3 Update CONTRIBUTING.md
    - Add Windows development setup instructions (Rust toolchain, Windows SDK, Visual Studio Build Tools)
    - Document cross-platform build and test workflow
    - Document `#[cfg(target_os)]` conditional compilation conventions

- [ ] 26. Package distribution updates
  - [ ] 26.1 Finalize package.json for cross-platform distribution
    - Verify `"os": ["darwin", "win32"]` is set
    - Verify `files` array includes all platform-specific `.node` binaries: `computer-use-napi.darwin-arm64.node`, `computer-use-napi.darwin-x64.node`, `computer-use-napi.win32-x64.node`
    - Verify `bin` entry works on both platforms (platform-agnostic server entrypoint)
    - Verify no Python dependencies are required on Windows
    - Verify `npx @zavora-ai/computer-use-mcp` starts correctly on Windows
    - _Requirements: 15.3, 15.4, 16.1, 16.2, 16.3, 16.4_

- [ ] 27. Final checkpoint — Full cross-platform verification
  - Ensure all tests pass on both macOS and Windows
  - Ensure MCP server starts and all tools are functional on both platforms
  - Ensure existing macOS test suite (78 tests) passes without modification
  - Ensure all tests pass, ask the user if questions arise.
  - _Requirements: 20.6_

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at key milestones
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The Rust native modules use `#[cfg(target_os)]` conditional compilation — each `.rs` file contains both macOS and Windows implementations
- The TypeScript layer branches on `process.platform` at a few well-defined points (native loader, session init, focus management, scripting bridge)
- All NAPI function signatures are identical on both platforms — the `NativeModule` TypeScript interface is unchanged
