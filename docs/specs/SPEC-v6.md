# computer-use-mcp v6.0 — Cross-Platform Desktop Control

**Author:** James Karanja Maina, Zavora Technologies Ltd
**Date:** April 2026
**Status:** Implemented

---

## 1. Purpose

v6.0 transforms `@zavora-ai/computer-use-mcp` from a macOS-only MCP server into a cross-platform desktop automation tool supporting both **macOS** and **Windows**.

The core architectural principle is **performance-first**: every Windows API call goes through Rust via `windows-rs` with zero-overhead NAPI bindings, eliminating the Python interpreter overhead, COM marshaling layers, and subprocess spawning that bottleneck alternative implementations.

---

## 2. Architecture

### Cross-Platform Module Structure

Each Rust source file uses `#[cfg(target_os)]` conditional compilation to provide platform-specific implementations behind identical NAPI export signatures.

```
TypeScript Layer (platform-agnostic)
├── server.ts    — MCP tool registration (58 tools)
├── session.ts   — Focus, targeting, dispatch, platform branching
├── client.ts    — Typed API
└── native.ts    — Platform detection + binary loader

Rust NAPI Module (native/src/)
├── mouse.rs         — CGEvent (macOS) / SendInput (Windows)
├── keyboard.rs      — CGEvent (macOS) / SendInput+Unicode (Windows)
├── screenshot.rs    — screencapture (macOS) / DXGI+GDI (Windows)
├── clipboard.rs     — Windows-only native Win32 clipboard
├── windows.rs       — CGWindowList (macOS) / EnumWindows (Windows)
├── apps.rs          — NSWorkspace (macOS) / Process+Shell (Windows)
├── accessibility.rs — AXUIElement (macOS) / IUIAutomation COM (Windows)
├── display.rs       — CGDisplay (macOS) / EnumDisplayMonitors (Windows)
└── spaces.rs        — CGS private (macOS) / Registry VirtualDesktopIDs (Windows)
```

### Session Layer Platform Branching

The session layer uses `process.platform` checks at initialization, confined to well-defined branch points:

1. **Native module loading** — `computer-use-napi.win32-x64.node` or `computer-use-napi.darwin-arm64.node`
2. **Focus management** — `AttachThreadInput` + `SetForegroundWindow` on Windows vs `NSWorkspace.activateApp` on macOS
3. **Session lock** — `%TEMP%` on Windows vs `/tmp` on macOS
4. **Runloop pump** — `drainRunloop()` on macOS only (no-op on Windows)
5. **Scripting bridge** — PowerShell on Windows vs osascript on macOS
6. **Clipboard** — Native Win32 on Windows vs pbcopy/pbpaste on macOS
7. **`prepare_display`** — Minimize windows on Windows vs hide apps on macOS
8. **Identifier mapping** — Process names on Windows vs bundle IDs on macOS

---

## 3. Windows Native Modules

### 3.1 Mouse (`SendInput`)
- Absolute coordinate normalization: `(x * 65535) / screen_width`
- Move-and-settle pattern: move cursor, sleep 10ms, then click
- Left/right/middle buttons, multi-click, scroll (vertical + horizontal), drag

### 3.2 Keyboard (`SendInput` + `KEYEVENTF_UNICODE`)
- Per-character Unicode input via `wScan` — handles all characters
- VK code map with macOS modifier mapping: `command` → `VK_LWIN`, `option` → `VK_MENU`
- Long text optimization: clipboard paste for strings >100 chars

### 3.3 Screenshot (DXGI Desktop Duplication)
- Primary path: cached `IDXGIOutputDuplication` with pre-allocated staging texture
- Warmup frame during initialization eliminates first-call latency
- GDI `BitBlt` fallback for RDP, VMs, older GPUs
- JPEG encoding via `image` crate, nearest-neighbor resize
- Annotation overlay: `annotate_image` draws colored rectangles + grid lines on JPEG pixels

### 3.4 Clipboard (Native Win32)
- `OpenClipboard` → `GetClipboardData(CF_UNICODETEXT)` → `GlobalLock` → read UTF-16
- 3-retry logic with 50ms delay for locked clipboard
- 31x faster than pywin32

### 3.5 Window Management (`EnumWindows`)
- `GetWindowText`, `GetWindowThreadProcessId`, `GetWindowRect` for window info
- `AttachThreadInput` + `SetForegroundWindow` + `BringWindowToTop` for activation
- `ShowWindow(SW_RESTORE)` for minimized windows
- `MonitorFromWindow` for display mapping
- Process name resolution via `OpenProcess` + `QueryFullProcessImageName`

### 3.6 UI Automation (`IUIAutomation` COM)
- `CoCreateInstance<IUIAutomation>` per-call (COM interfaces aren't Send+Sync)
- Tree walking via `IUIAutomationTreeWalker` with depth limit and 500-node cap
- Element search via `CreatePropertyCondition` + `FindAll`
- Invoke/Value/Toggle patterns for semantic actions
- Control type → AX role mapping (20+ types)

### 3.7 Display (`EnumDisplayMonitors`)
- `GetDpiForMonitor` for scale factor
- Physical pixel dimensions computed from DPI

### 3.8 Virtual Desktops (Registry-based)
- Enumerates from `VirtualDesktopIDs` binary blob (concatenated 16-byte GUIDs)
- Fallback to `Desktops` subkey for Win11 builds
- Desktop names from registry `Name` value
- Current desktop from `CurrentVirtualDesktop` binary GUID
- Create/destroy via keyboard shortcuts (`Ctrl+Win+D`, `Ctrl+Win+F4`)
- Works on Windows Server 2022, Win10, Win11

---

## 4. New Tools (57 total)

### Cross-platform additions
| Tool | Description |
|---|---|
| `filesystem` | Read, write, copy, move, delete, list, search, info |
| `process_kill` | List and kill processes by name or PID |
| `multi_select` | Batch click with optional Ctrl hold, label resolution |
| `multi_edit` | Batch click+type for form filling, label resolution |
| `scrape` | HTTP fetch + HTML-to-text extraction |
| `snapshot` | Combined screenshot + UI tree + windows + desktops |
| `resize_window` | Resize/move windows by name, ID, or foreground |
| `zoom` | View a specific screen region at full native resolution (matches Claude's zoom action) |
| `create_agent_space` | Create virtual desktop (keyboard shortcut on Windows) |
| `destroy_space` | Close current virtual desktop |

### Windows-only
| Tool | Description |
|---|---|
| `registry` | Windows Registry get/set/delete/list via PowerShell |
| `notification` | Windows toast notifications |

### Enhanced existing tools
| Tool | Enhancement |
|---|---|
| `type` | `clear`, `press_enter`, `caret_position` parameters |
| `run_script` | Accepts `language: "powershell"` on Windows |
| `get_tool_guide` | Windows-specific recommendations |
| `get_app_capabilities` | Reports `powershell: true` on Windows |

---

## 5. Performance

Benchmarked against Windows-MCP (Python reference implementation):

| Operation | Rust NAPI | Windows-MCP (Python) | Speedup |
|---|---|---|---|
| Screenshot (800px) | 20ms | 32ms | 1.6x |
| Clipboard round-trip | 0.7ms | 21ms | 30x |
| Window listing | 1.7ms | 165ms | 97x |
| Frontmost app | 0.2ms | 169ms | 845x |
| Memory (RSS) | 118MB | ~180MB | 1.5x less |

---

## 6. Platform Compatibility

| Feature | macOS | Windows |
|---|---|---|
| Mouse, keyboard, scroll | CGEvent | SendInput |
| Screenshot | screencapture | DXGI + GDI fallback |
| Clipboard | pbcopy/pbpaste | Native Win32 |
| Window management | CGWindowList + AXUIElement | EnumWindows + SetForegroundWindow |
| UI Automation | AXUIElement | IUIAutomation COM |
| Scripting | AppleScript, JXA | PowerShell |
| Virtual desktops | CGS (read-only) | Registry + keyboard shortcuts |
| App dictionary | sdef parser | Not available |
| Menu bar | AXMenuBar | Not available |
| File system tool | Not available | Node.js fs |
| Registry | Not available | PowerShell |
| Notifications | Not available | ToastNotificationManager |

---

## 7. Examples

9 Windows examples and 4 macOS examples covering the top use cases:

| Example | Use Case |
|---|---|
| `windows/notepad.mjs` | Document creation: open, type, save, screenshot, clipboard, zoom |
| `windows/zoom.mjs` | Screenshot monitoring: full screen + 7 region crops at native resolution |
| `windows/browser.mjs` | Web browsing: navigate, copy text, multi-tab, scrape |
| `windows/cross-app-workflow.mjs` | Cross-app: scrape web -> save file -> open in Notepad -> verify |
| `windows/data-entry.mjs` | Data entry: CSV report with structured employee data |
| `windows/sysadmin.mjs` | System admin: OS, CPU, memory, disk, network, processes, registry |
| `windows/virtual-desktops.mjs` | Desktop isolation: create -> open app -> work -> switch -> cleanup |
| `windows/ui-automation.mjs` | App testing: UI tree, find elements, zoom text, annotations |
| `windows/system-info.mjs` | System monitoring: display, windows, processes, registry, filesystem |
| `macos/calculator.mjs` | Calculator: compute 42+58, screenshot, clipboard |
| `macos/window-targeting.mjs` | Window-level targeting, focus recovery |
| `macos/browser.mjs` | Safari navigation, copy text, multi-tab |
| `macos/crypto-spreadsheet.mjs` | Crypto prices -> Numbers spreadsheet |
