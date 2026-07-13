# computer-use-mcp

> Computer Use MCP is an open source high performance MCP server + client for controlling your desktop computer with AI Agents. Tools include screenshot, mouse, keyboard, clipboard, app management, and window-level targeting — all in-process via Rust NAPI. Easy to install via npm and works with Claude Code, Claude DEsktop, Codex CLi, Codex Desktop, Gemnini Cli, Kiro CLi, Kiro VS Code Extension, Github Copilot, Cursor, OpenCode, OpenClaw, Hermes Agent and any other provider that supports Model Context Protocol.

**macOS + Windows + Linux** · Node.js 18+ · MIT License

---

## Table of Contents

1. [What is this?](#what-is-this)
2. [Tool priority guidance](#tool-priority-guidance)
3. [How it works](#how-it-works)
4. [Architecture](#architecture)
5. [Installation](#installation)
6. [Permissions setup](#permissions-setup)
7. [Quick start](#quick-start)
8. [Using with MCP clients](#using-with-mcp-clients)
   - [Codex](#codex)
   - [Claude Desktop](#claude-desktop)
   - [Cursor](#cursor)
   - [Windsurf](#windsurf)
   - [Any MCP-compatible client](#any-mcp-compatible-client)
9. [Using as a library](#using-as-a-library)
10. [All tools](#all-tools)
11. [Window targeting and focus strategies](#window-targeting-and-focus-strategies)
12. [API reference](#api-reference)
13. [Building from source](#building-from-source)
14. [Security](#security)
15. [Limitations](#limitations)
16. [Troubleshooting](#troubleshooting)
17. [License](#license)

---

## What is this?

`computer-use-mcp` lets an AI model (or any program) control your computer — take screenshots, move the mouse, type text, press keys, read/write the clipboard, open and manage apps, target specific windows, and query display information.

It works on **macOS**, **Windows**, and **Linux**, with platform-specific native implementations backed by a Rust NAPI module. On macOS it uses CoreGraphics/AppKit/AXUIElement; on Windows it uses SendInput/EnumWindows/IUIAutomation/DXGI — all direct Win32 API calls through Rust, no Python dependencies. On Linux it uses X11/XTest for input synthesis, xdotool/wmctrl for window management, and scrot for screenshots.

It implements the [Model Context Protocol (MCP)](https://modelcontextprotocol.io), which means any MCP-compatible AI client (Claude Desktop, Cursor, Windsurf, etc.) can use it as a tool server with zero extra code.

It also ships a typed TypeScript client so you can drive your Mac programmatically from your own scripts.

---

## What's new in v7.0

- **Cancellation** — tool calls honor the MCP host `AbortSignal`: `wait` returns early and `run_script` terminates its subprocess tree when the host cancels (POSIX process groups; recursive Windows `taskkill`).
- **Progress notifications** — long `filesystem` searches emit `notifications/progress` when the request carries a progress token (silent otherwise).
- **Filesystem jail** — `COMPUTER_USE_FS_ROOTS` confines the `filesystem` tool to allowlisted roots, blocking `..` traversal and symlink escapes.
- **Native binary resolver + packaging** — `COMPUTER_USE_NATIVE_PATH` override → optional per-platform package → bundled binary; installs never fail on the native layer.
- **MCP modernization** — tool annotations, `structuredContent` + `outputSchema`, server instructions, prompts, resources, and init-time tool profiles (`COMPUTER_USE_PROFILE`).
- **Deprecation** — the `[focusRequired: X]` description suffix is off by default (`focusRequired` remains in `_meta` / `get_tool_metadata`); restore it with `COMPUTER_USE_LEGACY_FOCUS_TAG=true`.

See [CHANGELOG.md](CHANGELOG.md) for the full list.

---

## Tool priority guidance

Desktop computer use is powerful but should be your **last resort**. Prefer more precise tools when they exist:

| Priority | Approach | When to use |
|---|---|---|
| 1. **Connector / integration** | Structured APIs, MCP connectors, app-specific plugins | Always prefer if available |
| 2. **Shell / filesystem** | Terminal commands, file I/O, `execFile` | File operations, CLI tools, system tasks |
| 3. **Browser automation** | Playwright, Puppeteer, Browser Use | Web pages, web apps |
| 4. **Desktop computer use** | This package | Native desktop apps, simulators, installers, modal dialogs, UI-only workflows |

Desktop control is the broadest and slowest fallback. It works for anything on screen, but structured tools are faster, more reliable, and easier to recover from.

---

## How it works

Most computer-use tools work by spawning shell commands (`xdotool`, `osascript`, `cliclick`) for every action. This is slow, unreliable, and causes focus-stealing — your terminal window keeps jumping to the front.

This package takes a different approach: a **Rust native module** (`.node` addon) that calls OS APIs directly in-process:

**macOS:**

| What | How |
|---|---|
| Mouse & keyboard | `CGEvent` (CoreGraphics) — same API the OS uses |
| App management | `NSWorkspace` (AppKit) |
| Window enumeration | `CGWindowListCopyWindowInfo` (CoreGraphics) — direct FFI, no subprocess |
| Window activation | `AXUIElement` (Accessibility API) — window-level raise |
| Display info | `CoreGraphics` display APIs |
| Screenshots | `screencapture` CLI (fastest reliable method on macOS) |
| Clipboard | `pbcopy` / `pbpaste` |

**Windows:**

| What | How |
|---|---|
| Mouse & keyboard | `SendInput` (Win32) — direct input synthesis |
| App management | `EnumWindows` + `CreateToolhelp32Snapshot` |
| Window enumeration | `EnumWindows` + `GetWindowText` + `GetWindowRect` |
| Window activation | `AttachThreadInput` + `SetForegroundWindow` |
| Display info | `EnumDisplayMonitors` + `GetDpiForMonitor` |
| Screenshots | DXGI Desktop Duplication (GPU framebuffer) with GDI BitBlt fallback |
| Clipboard | `OpenClipboard` / `SetClipboardData` (native Win32) |
| UI Automation | `IUIAutomation` COM (direct vtable calls from Rust) |

**Linux:**

| What | How |
|---|---|
| Mouse & keyboard | X11/XTest (X11) or `ydotool` (Wayland) — direct synthetic events |
| Text input | `xdotool type` (X11) or `ydotool type` (Wayland) — Unicode support |
| App management | `/proc` filesystem + `wmctrl` + GNOME Shell D-Bus |
| Window enumeration | `wmctrl` (X11) or GNOME Shell D-Bus Eval (Wayland) |
| Window activation | `xdotool windowactivate` (X11) or GNOME D-Bus (Wayland) |
| Display info | X11 `XDisplayWidth`/`XDisplayHeight` |
| Screenshots | XDG Desktop Portal (GNOME Wayland), `grim` (wlroots), `scrot` (X11) |
| Clipboard | `wl-copy`/`wl-paste` (Wayland) or `xclip`/`xsel` (X11) |
| Workspaces | `wmctrl -d` for listing, `wmctrl -t` for moving windows |

Mouse, keyboard, focus, window enumeration, and display operations run in-process via the native module. Screenshots and clipboard access still rely on the system utilities that are most reliable on macOS, but the control path avoids per-action shell hops.

---

## Comparison with alternatives

### Feature matrix

| Feature | computer-use-mcp (ours) | CursorTouch/Windows-MCP | sinmb79/windows-computer-mcp | Claude Computer Use | OpenAI CUA |
|---|---|---|---|---|---|
| **Platform** | macOS + Windows + Linux | Windows only | Windows only | Linux (Docker) | Linux (Docker) |
| **Language** | Rust NAPI + TypeScript | Python | Python | Python (reference) | Python (reference) |
| **Protocol** | MCP (stdio + in-process) | MCP (stdio) | MCP (stdio) | Claude API built-in | OpenAI API built-in |
| **Tools** | 64 | 14 | 10 | 3 (computer, bash, editor) | 1 (computer) |
| **Screenshot** | DXGI + GDI + PNG/JPEG | dxcam + PIL | mss + PIL | Xvfb screenshot | Xvfb screenshot |
| **Mouse input** | SendInput (Rust) | ctypes→SendInput | pyautogui | xdotool | xdotool |
| **Keyboard** | SendInput Unicode (Rust) | SendKeys wrapper | pyautogui.write | xdotool | xdotool |
| **UI Automation** | IUIAutomation COM (Rust) | comtypes COM | ❌ | ❌ | ❌ |
| **Clipboard** | Native Win32 (Rust) | pywin32 | ❌ | ❌ | ❌ |
| **Window targeting** | HWND + focus strategies | ❌ | title match | ❌ | ❌ |
| **Virtual desktops** | Registry + keyboard | comtypes COM (fragile) | ❌ | ❌ | ❌ |
| **File system tool** | ✅ (Node.js fs) | ✅ (Python os) | ❌ | ✅ (bash) | ❌ |
| **Registry** | ✅ (PowerShell) | ✅ (PowerShell) | ❌ | ❌ | ❌ |
| **Scripting** | PowerShell + AppleScript | PowerShell | ❌ | bash | ❌ |
| **Zoom (region inspect)** | ✅ (full-res crop) | ❌ | ❌ | ✅ (20251124) | ❌ |
| **Annotation overlay** | ✅ (Rust pixel drawing) | ✅ (PIL drawing) | ❌ | ❌ | ❌ |
| **Grid reference lines** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Snapshot (combined)** | ✅ (screenshot+UI tree+windows) | ✅ (screenshot+elements) | ❌ | ❌ | ❌ |
| **Multi-select/edit** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Process management** | ✅ | ✅ | ❌ | ✅ (bash) | ❌ |
| **Notifications** | ✅ (toast) | ✅ (toast) | ❌ | ❌ | ❌ |
| **Scrape (web fetch)** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Tool guide/discovery** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Focus strategies** | strict/best_effort/none/prepare_display | ❌ | ❌ | ❌ | ❌ |
| **Coordinate validation** | ✅ | ❌ | ✅ | ❌ | ❌ |
| **PNG format option** | ✅ (quality=0) | ❌ (JPEG only) | ✅ (PNG only) | ❌ | ❌ |
| **No Python required** | ✅ | ❌ (Python 3.13) | ❌ (Python 3.11) | ❌ | ❌ |
| **Memory footprint** | ~120MB | ~180MB | ~150MB | ~200MB+ | ~200MB+ |

### Performance benchmark

Measured on Windows Server 2022 (2560×1080, single monitor). All times are median of 15 runs.

| Operation | computer-use-mcp | CursorTouch/Windows-MCP | sinmb79/windows-computer-mcp | Speedup vs CT |
|---|---|---|---|---|
| Screenshot (800px JPEG) | **17ms** | 31ms | - | 1.8× |
| Screenshot (800px PNG) | **10ms** | - | - | - |
| Screenshot (full-res PNG) | **12ms** | - | 94ms | 7.6× vs sinmb79 |
| Clipboard round-trip | **0.7ms** | 22ms | - | 31× |
| List windows | **1.3ms** | 127ms | 0.6ms | 98× |
| Get frontmost app | **0.1ms** | 129ms | - | 939× |
| List running apps | **0.4ms** | 13ms | - | 35× |
| Scrape (example.com) | **7ms** | 179ms | - | 25× |
| PowerShell execution | 213ms | **171ms** | - | 0.8× |
| Registry list | 244ms | **212ms** | - | 0.9× |
| Virtual desktops list | **0.2ms** | 0.0ms | - | ~same |
| Cursor position | **0.1ms** | 0.0ms | 0.0ms | ~same |

> PowerShell and registry operations are bottlenecked by subprocess spawn time (~200ms), not our code. Both implementations pay the same cost. All other operations are 2–939× faster due to direct Rust→Win32 API calls vs Python→ctypes/comtypes marshaling.

---

## Architecture

```
Your AI client (Claude, Cursor, etc.)
        │
        │  MCP protocol (JSON-RPC over stdio or in-memory)
        ▼
  MCP Server  (src/server.ts)
  ├── Registers 64 tools with Zod schemas
  ├── Validates all inputs at the boundary
  └── Delegates to Session
        │
        ▼
  Session  (src/session.ts)
  ├── Manages TargetState (bundleId + windowId + provenance)
  ├── Resolves target: target_window_id → target_app → session state
  ├── Applies focus strategy (strict / best_effort / none)
  ├── Returns structured FocusFailure diagnostics on failure
  └── Calls native module
        │
        ▼
  NAPI Native Module  (computer-use-napi.node)
  ├── mouse.rs         — CGEvent mouse events
  ├── keyboard.rs      — CGEvent keyboard events (static keycode map)
  ├── apps.rs          — NSWorkspace app management
  ├── windows.rs       — CGWindowListCopyWindowInfo + AXUIElement window raise
  ├── display.rs       — CoreGraphics display queries
  ├── accessibility.rs — AXUIElement tree walk / find / perform / set / menu (v5)
  ├── spaces.rs        — CGS Space enumeration (read-only, v5)
  └── screenshot.rs    — screencapture + JPEG parsing
```

**Data flow for a window-targeted tool call:**

```
AI sends: { tool: "key", args: { text: "command+v", target_window_id: 12345, focus_strategy: "strict" } }
  → Zod validates parameters
  → Session resolves window 12345 → bundleId "com.apple.iWork.Numbers"
  → Session checks focus_strategy: strict
  → Session confirms frontmost app == "com.apple.iWork.Numbers"
  → Session confirms window 12345 is on-screen
  → If not confirmed: attempt recovery (unhide → activate → raise → poll)
  → If still not confirmed: return FocusFailure with suggestedRecovery
  → If confirmed: Rust keyPress("command+v")
  → Session updates TargetState { bundleId, windowId: 12345, establishedBy: 'keyboard' }
  → Returns: { content: [{ type: "text", text: "Pressed command+v" }] }
```

---

## Installation

### Option 1: npx (no install required — recommended)

Run the server directly without installing anything:

```bash
npx --yes --prefer-offline @zavora-ai/computer-use-mcp
```

That's it. Use this path in your MCP client config:

```
command: npx
args: ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"]
```

### Option 2: npm install

```bash
npm install @zavora-ai/computer-use-mcp
```

### Option 3: Build from source

Requires [Rust](https://rustup.rs) and Cargo.

```bash
git clone https://github.com/zavora-ai/computer-use-mcp
cd computer-use-mcp
npm install
npm run build
```

### Native binaries

The published `@zavora-ai/computer-use-mcp` package **bundles prebuilt Rust native binaries for every supported target** (`darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`, `linux-arm64`), so it works out of the box on any of them with no build step.

At load time the native module is resolved in this order (v7):

1. `COMPUTER_USE_NATIVE_PATH` — an explicit path override (custom builds / non-standard layouts).
2. An optional per-platform package `@zavora-ai/computer-use-mcp-${platform}-${arch}` (a slimmer install, when present).
3. The bundled binary in the main package (default — always available).

The optional per-platform packages are an install-size optimization; when they are absent, resolution transparently falls back to the bundled binary, so installs never fail on the native layer.

---

## Permissions setup

### macOS

macOS requires explicit permission for apps that control the computer. You need to grant **Accessibility** access to your terminal.

### Step-by-step

1. Open **System Settings** (Apple menu → System Settings)
2. Go to **Privacy & Security** → **Accessibility**
3. Click the **+** button
4. Navigate to your terminal app and add it:
   - **Terminal.app**: `/Applications/Utilities/Terminal.app`
   - **iTerm2**: `/Applications/iTerm.app`
   - **VS Code terminal**: `/Applications/Visual Studio Code.app`
   - **Cursor**: `/Applications/Cursor.app`
5. Make sure the toggle next to your terminal is **on** (blue)
6. You may need to restart your terminal after granting permission

> **Why is this needed?** macOS sandboxes apps from controlling other apps by default. The Accessibility permission grants the ability to send synthetic mouse and keyboard events via `CGEvent`.

### Verifying permissions work (macOS)

Run the built-in demo:

```bash
npx @zavora-ai/computer-use-mcp demo
```

If permissions are correct, you'll see Calculator open, compute 42+58, and close. If you see an error about permissions, revisit the steps above.

### Windows

No special permissions are required for most operations on Windows. The native module uses standard Win32 APIs (`SendInput`, `EnumWindows`, DXGI) that work without elevation.

**Notes:**
- UI Automation access may be blocked by UIPI (User Interface Privilege Isolation) when targeting elevated processes. Run your terminal as Administrator if you need to automate elevated apps.
- No Python, pywin32, or any Python dependencies are required — everything is implemented in Rust.

### Linux

No special permissions are required beyond having an X11 display available. Ensure the following tools are installed:

```bash
sudo apt-get install -y xdotool wmctrl xclip scrot
```

**Notes:**
- XTest extension must be enabled (it is by default on most X11 setups).
- For Wayland sessions, you may need to run under XWayland or set `GDK_BACKEND=x11`.
- No Python dependencies required — the native module uses Rust + X11 directly.

---

## Quick start

### Run the MCP server

```bash
npx --yes --prefer-offline @zavora-ai/computer-use-mcp
```

The server speaks MCP over stdio and is ready to connect to any MCP client.

### First-run doctor

Run `doctor` from any MCP client before the first real automation. It returns machine-readable checks plus exact remediation steps for native binary compatibility, display capture, clipboard, Accessibility/UI Automation, macOS Automation, PowerShell, policy, and audit logging.

```typescript
const status = await client.doctor()
console.log(status.content.find(c => c.type === 'text')?.text)
```

### Test it works

```bash
# Takes a screenshot and saves it
node -e "
import('@zavora-ai/computer-use-mcp').then(async ({ createComputerUseServer }) => {
  const { connectInProcess } = await import('@zavora-ai/computer-use-mcp/client')
  const s = createComputerUseServer()
  const c = await connectInProcess(s)
  const shot = await c.screenshot({ width: 1024 })
  const img = shot.content.find(x => x.type === 'image')
  if (img?.type === 'image') {
    const { writeFileSync } = await import('fs')
    writeFileSync('/tmp/test.jpg', Buffer.from(img.data, 'base64'))
    console.log('Screenshot saved to /tmp/test.jpg')
  }
  await c.close()
})
"
```

---

## Using with MCP clients

### Codex

Codex reads MCP server definitions from `~/.codex/config.toml`. Add this block:

```toml
[mcp_servers.computer-use]
command = "npx"
args = ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"]
```

If you already use the Codex CLI, you can verify the server is visible with:

```bash
codex mcp list
```

### Claude Desktop

1. Find your Claude Desktop config file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

2. Add the server:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"]
    }
  }
}
```

3. Restart Claude Desktop.

4. You should see a hammer icon (🔨) in the chat input — click it to see the available tools.

5. Try asking Claude: *"Take a screenshot and describe what you see"* or *"Open Safari and navigate to example.com"*

---

### Cursor

1. Open Cursor settings: `Cmd+,` → search for "MCP"

2. Click **Add MCP Server** and fill in:
   - **Name**: `computer-use`
   - **Command**: `npx`
   - **Args**: `["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"]`

3. Save and reload the window (`Cmd+Shift+P` → "Reload Window").

4. In the AI chat, the computer-use tools will be available automatically.

---

### Windsurf

1. Open `~/.codeium/windsurf/mcp_config.json` (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"]
    }
  }
}
```

2. Restart Windsurf.

---

### Any MCP-compatible client

The server speaks standard MCP over stdio. The simplest config for any client:

```
command: npx
args: ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"]
```

---

## Using as a library

Import the server and client directly in your TypeScript/JavaScript code.

### In-process (fastest)

Both server and client run in the same Node.js process. No subprocess, no IPC overhead.

```typescript
import { createComputerUseServer } from '@zavora-ai/computer-use-mcp'
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client'

const server = createComputerUseServer()
const client = await connectInProcess(server)

// Take a screenshot (full screen, resized to 1024px wide)
const shot = await client.screenshot()

// Capture a specific app window only
const shot = await client.screenshot({ target_app: 'com.apple.Safari' })

// Capture a specific window by ID
const shot = await client.screenshot({ target_window_id: 12345 })

// Custom width
const shot = await client.screenshot({ width: 800, target_app: 'com.apple.iCal' })
const img = shot.content.find(c => c.type === 'image')
if (img?.type === 'image') {
  // img.data is base64-encoded JPEG
  // img.mimeType is "image/jpeg"
}

// Mouse (with optional window targeting)
await client.click(500, 300, 'com.apple.Safari')           // left click
await client.click(500, 300, undefined, { targetWindowId: 12345 }) // target specific window
await client.doubleClick(500, 300, 'com.apple.Safari')     // double click
await client.rightClick(500, 300, 'com.apple.Safari')      // right click
await client.moveMouse(500, 300, 'com.apple.Safari')       // move without clicking
await client.scroll(500, 300, 'down', 5, 'com.apple.Safari') // scroll down 5 lines
await client.drag([800, 400], [200, 200], 'com.apple.Safari') // drag from [200,200] to [800,400]

// Keyboard (with optional focus strategy)
await client.type('Hello, world!')     // type text
await client.key('command+s')          // key combo
await client.key('return')             // single key
await client.key('command+z', 'com.apple.TextEdit') // target specific app
await client.key('command+v', undefined, { targetWindowId: 12345, focusStrategy: 'strict' })

// Window introspection (v4)
const windows = await client.listWindows('com.apple.Safari')
const win = await client.getWindow(12345)
const cursorWin = await client.getCursorWindow()

// Window activation (v4)
await client.activateApp('com.apple.Safari')
await client.activateWindow(12345)

// First-run onboarding diagnostics
await client.doctor()

// Non-interrupting native overlay pointer. This does not move the OS cursor.
await client.agentPointer('move', { coordinate: [400, 300], nativeOverlay: true })
await client.screenshot({ show_agent_pointer: true })

// OpenAI Computer Use compatibility adapter
await client.openaiComputer({
  useVirtualPointer: true,
  actions: [
    { type: 'move', x: 400, y: 300 },
    { type: 'screenshot' }
  ]
})

// Clipboard
await client.writeClipboard('some text')
const clip = await client.readClipboard()
const text = clip.content.find(c => c.type === 'text')?.text ?? ''

// Apps
await client.openApp('com.apple.Safari')
await client.openApp('com.apple.calculator')
const apps = await client.listRunningApps()
await client.hideApp('com.apple.Finder')
await client.unhideApp('com.apple.Finder')

// Display
const size = await client.getDisplaySize()
const displays = await client.listDisplays()

// Cursor
const pos = await client.cursorPosition()

// Wait
await client.wait(1.5) // wait 1.5 seconds (max 300)

// Always close when done
await client.close()
```

### Via stdio subprocess

Useful when you want the server in a separate process (e.g. for isolation).

```typescript
import { connectStdio } from '@zavora-ai/computer-use-mcp/client'

const client = await connectStdio('node', [
  'node_modules/@zavora-ai/computer-use-mcp/dist/server.js'
])

await client.screenshot()
await client.close()
```

### Raw tool calls

If you need a tool not exposed as a typed method:

```typescript
const result = await client.callTool('triple_click', {
  coordinate: [500, 300]
})
```

---


## Semantic automation (v5)

v5 gives agents three ordered approaches: **scripting → accessibility → coordinates**. Before reaching for screenshot + click, call `get_tool_guide` with the task description and `get_app_capabilities` with the bundle ID — the returned plan tells you whether AppleScript, AX, or coordinate automation is the right path.

### Typical v5 flow

```typescript
// 1. Ask which approach to use
const guide = await client.getToolGuide('reply to the selected email')
// → { recommendedApproach: "scripting", suggestedTools: ["run_script"], ... }

// 2. Probe the target app
const caps = await client.getAppCapabilities('com.apple.mail')
// → { scriptable: true, accessible: true, running: true, ... }

// 3a. Scriptable app → run_script (fastest path)
await client.runScript({
  language: 'applescript',
  script: 'tell application "Mail" to reply front message',
})

// 3b. Non-scriptable GUI → use AX instead of screenshot+click
await client.fillForm({
  target_app: 'com.apple.systempreferences',
  fields: [
    { role: 'AXTextField', label: 'Full Name', value: 'Jane Doe' },
    { role: 'AXTextField', label: 'Email', value: 'jane@example.com' },
  ],
})
```

### Why prefer AX / scripting over pixel clicks?

| Concern | Coordinate clicks | `click_element` / `run_script` |
|---|---|---|
| Survives window moves | No | Yes |
| Survives resolution / scale changes | No | Yes |
| Reliable on retina scaling edge cases | No | Yes |
| Faster than screenshot + vision parse | No | Yes |
| Reports structured errors | No | Yes (similar-labels ranking) |

---

## All tools

### Screenshot

| Tool | Description | Parameters |
|---|---|---|
| `screenshot` | Capture the screen or a specific app/window | `width?: number` (default 1024), `quality?: number` (0=PNG, 1-100=JPEG, default 80), `provider?: string`, `target_app?: string`, `target_window_id?: number`, `show_agent_pointer?: bool` |
| `zoom` | View a specific screen region at full resolution. Best for reading small text or inspecting UI details. | `region: [x1, y1, x2, y2]`, `quality?: number` (0=PNG default, 1-100=JPEG) |

### Onboarding, compatibility, policy, and audit

| Tool | Description | Parameters |
|---|---|---|
| `doctor` | First-run onboarding diagnostics with exact remediation steps. | `include_remediation?: bool` |
| `policy_status` | Show active app allow/block lists, approval settings, and audit destination without revealing tokens. | — |
| `agent_pointer` | Manage a virtual pointer that does not move the OS cursor or focus apps. When native overlay support is available, it shows a click-through always-on-top dot. Render it into screenshots with `screenshot(show_agent_pointer=true)`. | `action: get\|move\|show\|hide\|reset`, `coordinate?: [x,y]`, `visible?: bool`, `native_overlay?: bool` |
| `openai_computer` | OpenAI Computer Use compatibility adapter for single or batched actions. | `action?`, `actions?`, `target_app?`, `target_window_id?`, `focus_strategy?`, `return_screenshot?`, `use_virtual_pointer?`, `native_overlay?` |

`openai_computer` accepts action types `click`, `double_click`, `right_click`, `scroll`, `type`, `wait`, `keypress`, `drag`, `move`, and `screenshot`. Batched `actions[]` execute in order and stop on the first error.

The native overlay pointer is non-activating, always-on-top, and click-through. Moving it updates the overlay window and internal virtual pointer state without moving the user's hardware cursor. Physical input tools still use the real OS cursor; use `get_tool_metadata` to check `movesUserCursor`, `requiresFocus`, `usesVirtualPointer`, and `physicalInput`.

### Mouse

| Tool | Description | Parameters |
|---|---|---|
| `left_click` | Left-click at coordinates | `coordinate: [x, y]`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
| `right_click` | Right-click at coordinates | `coordinate: [x, y]`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
| `middle_click` | Middle-click at coordinates | `coordinate: [x, y]`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
| `double_click` | Double-click at coordinates | `coordinate: [x, y]`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
| `triple_click` | Triple-click (select word) | `coordinate: [x, y]`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
| `mouse_move` | Move cursor without clicking | `coordinate: [x, y]`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
| `left_click_drag` | Click and drag | `coordinate: [x, y]`, `start_coordinate?: [x, y]`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
| `left_mouse_down` | Press mouse button (hold) | `coordinate: [x, y]`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
| `left_mouse_up` | Release mouse button | `coordinate: [x, y]`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
| `scroll` | Scroll at position | `coordinate: [x, y]`, `direction: up\|down\|left\|right`, `amount?: number`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
| `cursor_position` | Get current cursor position | — |

### Keyboard

| Tool | Description | Parameters |
|---|---|---|
| `type` | Type text (Unicode, all characters) | `text: string`, `clear?: bool`, `press_enter?: bool`, `caret_position?: "start"\|"end"\|"idle"`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
| `key` | Press a key or combo | `text: string` (e.g. `"command+c"`), `repeat?: number`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
| `hold_key` | Hold keys for a duration | `keys: string[]`, `duration: number` (seconds), `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |

**Supported key names:** `return`, `enter`, `tab`, `space`, `delete`, `backspace`, `escape`, `command`, `shift`, `option`, `alt`, `control`, `ctrl`, `fn`, `f1`–`f12`, `home`, `end`, `pageup`, `pagedown`, `left`, `right`, `up`, `down`, `a`–`z`, `0`–`9`, `-`, `=`, `[`, `]`, `\`, `;`, `'`, `,`, `.`, `/`, `` ` ``

**Key combos:** Separate with `+`. Examples: `command+c`, `command+shift+4`, `control+a`

### Clipboard

| Tool | Description | Parameters |
|---|---|---|
| `read_clipboard` | Read clipboard contents | — |
| `write_clipboard` | Write text to clipboard | `text: string` |

### Apps

| Tool | Description | Parameters |
|---|---|---|
| `open_application` | Open and focus an app | `bundle_id: string` |
| `list_running_apps` | List all running apps | — |
| `hide_app` | Hide an app (Cmd+H equivalent) | `bundle_id: string` |
| `unhide_app` | Unhide a hidden app | `bundle_id: string` |

**Common bundle IDs:**

| App | Bundle ID |
|---|---|
| Safari | `com.apple.Safari` |
| Chrome | `com.google.Chrome` |
| Firefox | `org.mozilla.firefox` |
| Terminal | `com.apple.Terminal` |
| iTerm2 | `com.googlecode.iterm2` |
| VS Code | `com.microsoft.VSCode` |
| Cursor | `com.todesktop.230313mzl4w4u92` |
| Finder | `com.apple.Finder` |
| Calculator | `com.apple.calculator` |
| TextEdit | `com.apple.TextEdit` |
| Numbers | `com.apple.iWork.Numbers` |
| Xcode | `com.apple.dt.Xcode` |
| Slack | `com.tinyspeck.slackmacgap` |

### Window Introspection (v4)

| Tool | Description | Parameters |
|---|---|---|
| `get_window` | Look up a window by CGWindowID | `window_id: number` |
| `get_cursor_window` | Get the window under the mouse cursor | — |
| `list_windows` | List visible on-screen windows | `bundle_id?: string` (filter by app) |
| `get_frontmost_app` | Get the currently frontmost app | — |

These are **observation tools** — they never change which app or window receives your next input. Safe to call between actions.

### Window Activation (v4)

| Tool | Description | Parameters |
|---|---|---|
| `activate_app` | Activate an app with structured diagnostics | `bundle_id: string`, `timeout_ms?: number` |
| `activate_window` | Raise a specific window by CGWindowID | `window_id: number`, `timeout_ms?: number` |

These return structured before/after state so you can verify activation succeeded and diagnose failures.

### Display

| Tool | Description | Parameters |
|---|---|---|
| `get_display_size` | Get display dimensions and scale | `display_id?: number` |
| `list_displays` | List all connected displays | — |

### Utility

| Tool | Description | Parameters |
|---|---|---|
| `wait` | Pause execution | `duration: number` (seconds, max 300) |

### Accessibility — observation (v5)

| Tool | Description | Parameters |
|---|---|---|
| `get_ui_tree` | Accessibility tree for a window (role/label/value/bounds/actions/children). Capped at 500 nodes. | `target_app?: string`, `target_window_id?: number`, `max_depth?: number` |
| `get_focused_element` | Currently focused element (where typed text will go). | — |
| `find_element` | Search by role/label/value (AND of criteria). | `role?`, `label?`, `value?`, `target_app?`, `target_window_id?` |

### Accessibility — mutation (v5)

| Tool | Description | Parameters |
|---|---|---|
| `click_element` | Click a UI element by role + label. Falls back to coordinate click if AXPress is unsupported. | `role`, `label`, `target_app?`, `target_window_id?`, `focus_strategy?` |
| `set_value` | Set a UI element's value directly (e.g. text field content). Defaults to `strict` focus. | `role`, `label`, `value`, `target_app?`, `target_window_id?`, `focus_strategy?` |
| `press_button` | Shortcut for a button press (`role=AXButton`). | `label`, `target_app?`, `target_window_id?`, `focus_strategy?` |
| `list_menu_bar` | Full menu bar for any app, with per-item keyboard shortcuts (`cmd+shift+n` style). Call this BEFORE `select_menu_item` — pressing the shortcut is one keystroke vs. a menu walk. | `bundle_id: string` |
| `select_menu_item` | Walk AXMenuBar and select by path. Returns `availableMenus` on miss. | `menu_path: string[]`, `target_app?`, `focus_strategy?` |
| `fill_form` | Set multiple values in one call; per-field results, no abort on partial failure. | `fields: Array<{ role, label, value }>`, `target_app?`, `target_window_id?`, `focus_strategy?` |

### Scripting bridge (v5)

| Tool | Description | Parameters |
|---|---|---|
| `run_script` | Execute scripts: AppleScript/JXA on macOS, PowerShell on Windows. | `language: "applescript"\|"javascript"\|"powershell"`, `script: string`, `timeout_ms?: number` |
| `get_app_dictionary` | Inspect a scriptable app's dictionary (suites/commands/classes). Cached per PID. | `bundle_id: string`, `suite?: string` |

### Discovery (v5)

| Tool | Description | Parameters |
|---|---|---|
| `get_tool_guide` | Recommend the best approach for a task. Call BEFORE screenshot + click. | `task_description: string` |
| `get_app_capabilities` | Probe: scriptable? accessible? running? hidden? | `bundle_id: string` |

### Spaces (v5 + v6)

| Tool | Description | Parameters |
|---|---|---|
| `list_spaces` | List virtual desktops/Spaces grouped by display. | — |
| `get_active_space` | Currently active Space/desktop ID. | — |
| `create_agent_space` | Create a new virtual desktop. On Windows: Ctrl+Win+D. | — |
| `move_window_to_space` | Move a window to a Space/desktop. | `window_id: number`, `space_id: number` |
| `remove_window_from_space` | Remove a window from a Space/desktop. | `window_id: number`, `space_id: number` |
| `destroy_space` | Close current virtual desktop. On Windows: Ctrl+Win+F4. | `space_id?: number` |

### Cross-platform tools (v6)

| Tool | Description | Parameters |
|---|---|---|
| `snapshot` | Combined screenshot + UI tree + windows + desktops in one call. | `use_vision?: bool`, `use_annotation?: bool`, `grid_lines?: [cols, rows]`, `width?: number` |
| `filesystem` | File operations: read, write, copy, move, delete, list, search, info. | `mode`, `path`, `content?`, `destination?`, `pattern?`, `recursive?`, `append?` |
| `process_kill` | List or kill processes by name or PID. | `mode: list\|kill`, `name?`, `pid?`, `force?`, `sort_by?` |
| `multi_select` | Batch click at coordinates or UI element labels. | `locs?`, `labels?`, `press_ctrl?`, `target_app?` |
| `multi_edit` | Batch click+type at coordinates or labels. | `locs?`, `labels?`, `target_app?` |
| `scrape` | Fetch and extract text content from a URL. | `url`, `query?`, `use_dom?` |
| `resize_window` | Resize and/or move a window. | `window_name?`, `window_id?`, `window_size?`, `window_loc?` |

### Windows-only tools (v6)

| Tool | Description | Parameters |
|---|---|---|
| `registry` | Windows Registry get/set/delete/list. | `mode`, `path`, `name?`, `value?`, `type?` |
| `notification` | Send a Windows toast notification. | `title`, `message`, `app_id?` |

> **Note on macOS Spaces:** macOS does not expose a public API for mutating Spaces. By default, `COMPUTER_USE_SPACES_BACKEND=auto` tries `yabai`, then Mission Control gesture automation, then the private CGS fallback. Set `COMPUTER_USE_SPACES_BACKEND=yabai|mission_control|cgs` to force one path. The `yabai` backend requires installing `yabai`, granting Accessibility permission, and installing/loading yabai's scripting addition for Space create/destroy. The CGS fallback may create orphaned Spaces on SIP-enabled Macs.

---

## Window targeting and focus strategies

### `target_window_id` parameter

All input tools accept an optional `target_window_id` parameter (CGWindowID). When provided, the session resolves the owning app from the window and uses that for focus acquisition. This is more precise than `target_app` for multi-window layouts.

```typescript
// Target a specific window instead of just an app
await client.key('command+v', undefined, { targetWindowId: 12345, focusStrategy: 'strict' })
```

When both `target_window_id` and `target_app` are provided, `target_window_id` takes precedence.

### `focus_strategy` parameter

Controls how aggressively the server acquires focus before delivering input:

| Strategy | Behavior | Default for |
|---|---|---|
| `strict` | Fail with `FocusFailure` if the target cannot be confirmed as frontmost. For keyboard tools with a `target_window_id`, also confirms the window is on-screen. | Keyboard tools (`type`, `key`, `hold_key`) and text-writing AX tools (`set_value`, `fill_form`) |
| `best_effort` | Attempt focus acquisition and proceed with input delivery even if full confirmation is not achieved. | Pointer tools (`left_click`, `scroll`, etc.) |
| `none` | Skip all activation. Send input to the current frontmost target regardless of `target_app` or `target_window_id`. | — (must be explicit) |
| `prepare_display` *(v5.2)* | Hide every regular running app except the target, the terminal, and any bundles in the `COMPUTER_USE_PREPARE_KEEP_VISIBLE` env var, **then** activate the target. Defends against focus-stealing background apps (screenshot watchers, notification panels). The response payload gains a trailing `hiddenBundleIds` block so callers can restore the layout later with `unhide_app`. | — (must be explicit) |

> **Tip:** Use `prepare_display` whenever you see a `focus_failed` with a `thief` app that isn't yours (for example, a macOS screenshot watcher grabbing focus after your screenshot call). It's a hammer, not a default — it leaves non-target apps hidden until you restore them.

### Policy and audit

Mutating tools pass through a policy gate before dispatch. By default, the server allows existing behavior, blocks known credential apps unless approved, and writes audit JSONL in production sessions unless disabled.

| Environment variable | Purpose |
|---|---|
| `COMPUTER_USE_ALLOWED_APPS` | Comma-separated allowlist for mutating targeted app control. If set, targeted mutations outside the list are denied. |
| `COMPUTER_USE_BLOCKED_APPS` | Comma-separated app bundle IDs/process names that are always denied. |
| `COMPUTER_USE_CREDENTIAL_APPS` | Override the default sensitive-app list that requires approval. |
| `COMPUTER_USE_REQUIRE_APPROVAL` | Set `true` to require approval for every mutating tool. |
| `COMPUTER_USE_REQUIRE_APPROVAL_FOR` | Comma-separated tool names that require approval. |
| `COMPUTER_USE_DESTRUCTIVE_REQUIRES_APPROVAL` | Set `true` to require approval for destructive filesystem/process/registry/script operations. |
| `COMPUTER_USE_APPROVAL_TOKEN` | Private token callers must pass as `approval_token` after user approval. |
| `COMPUTER_USE_AUDIT_LOG` | JSONL audit destination. Set `false` to disable, `true` for the default `~/.computer-use-mcp/audit.jsonl`, or an explicit path. |
| `COMPUTER_USE_FS_ROOTS` | Optional filesystem jail. Comma-separated absolute roots; when set, the `filesystem` tool may only touch paths inside a root. Blocks `..` traversal and symlink escapes (resolved via `realpath`). Unset = unrestricted (legacy). |
| `COMPUTER_USE_NATIVE_PATH` | Explicit path to the native `.node` addon, overriding automatic resolution (optional platform package → legacy root binary). Useful for custom builds or non-standard install layouts. |
| `COMPUTER_USE_LEGACY_FOCUS_TAG` | Append the legacy `[focusRequired: X]` suffix to tool descriptions. **Off by default in v7** (`focusRequired` is still available via `_meta` and `get_tool_metadata`). Set `true` to restore the suffix. |
| `COMPUTER_USE_V8` | Enable the additive v8 action/session/lease facade. The 64-tool v7 surface remains the default. |
| `COMPUTER_USE_V7_COMPAT` | Restore the legacy unrooted-filesystem and open-world `scrape` defaults for one migration cycle. Emits disclosure-safe startup warnings. It never bypasses emergency stop, redaction, target validation, leases, or exact-action approval. |
| `COMPUTER_USE_EMERGENCY_STOP_CHORD` | Global physical emergency-stop chord for v8 on macOS/Windows. Defaults to `ctrl+alt+shift+escape`; requires at least two modifiers and an `escape` or `f12` trigger. It latches native input off until the authenticated host/supervisor resets it. |
| `COMPUTER_USE_EXPERIMENTAL_TASKS` | Opt in to the experimental MCP Tasks adapter for principal-bound v8 sessions. Requires `COMPUTER_USE_V8=true`; cancellation stops the authoritative v8 session and revokes its lease. |
| `COMPUTER_USE_ACTIVE_PROFILE` | Runtime-visible surface inside the immutable `COMPUTER_USE_PROFILE` maximum. Use `v8-safe` to expose only governed v8 facade tools and hide every raw actuator/observer. |
| `COMPUTER_USE_V8_ALLOW_SCRAPE` | Explicitly allow `scrape` through the v8 default policy. Off by default. |
| `COMPUTER_USE_V8_ALLOWED_DOMAINS` | Comma-separated domain allowlist for v8 network resources; subdomains match an allowed parent domain. |
| `COMPUTER_USE_V8_REGISTRY_HIVES` | Comma-separated Windows registry prefixes allowed through v8 policy. |
| `COMPUTER_USE_V8_BLOCKED_PROCESSES` | Comma-separated process names denied through v8 policy. |
| `COMPUTER_USE_RECEIPT_DIR` | Durable idempotency receipt directory. Result/image bytes remain memory-only by default. |
| `COMPUTER_USE_SESSION_DIR` | Durable session directory. Recovered nonterminal sessions always start paused. |
| `COMPUTER_USE_MAX_SESSIONS` | Maximum durable session records (default `1000`). New sessions fail closed at the limit until terminal sessions are explicitly pruned. |
| `COMPUTER_USE_EVENT_JOURNAL` | Opt-in redacted, integrity-chained supervisor event journal. |
| `COMPUTER_USE_EVENT_JOURNAL_MAX_BYTES` | Maximum event-journal size in bytes (default `67108864`). Appends fail closed at the limit; terminal-session pruning rewrites a valid retained chain with a retention marker. |
| `COMPUTER_USE_ONBOARDING_DIR` | Optional private directory for resumable v8 onboarding state. Raw screenshots and accessibility trees are never persisted by onboarding. |
| `COMPUTER_USE_CERTIFICATION_DIR` | Private directory for atomic, mode-`0600`, digest-verifiable background-capability traces. Defaults to `~/.computer-use-mcp/certifications`. |
| `COMPUTER_USE_CERTIFICATION_SANDBOX` | Root used by reversible reference-adapter probes. Paths are realpath-confined and symlink escape is rejected. Defaults to `~/.computer-use-mcp/certification-sandbox`. |
| `COMPUTER_USE_SUPERVISOR_SOCKET` | Opt-in local PiP supervisor socket. Requires v8 and a supervisor token. |
| `COMPUTER_USE_SUPERVISOR_TOKEN` | Explicit local supervisor secret of at least 32 characters; never exposed to renderer code. |
| `COMPUTER_USE_SUPERVISOR_FRAMES` | Set `true` to enable target-only before/after/observation frames in PiP. Frames are process-memory-only, limited to 1 MiB each and six per session, expire after five minutes, and require authenticated local session subscription. |
| `COMPUTER_USE_SCRIPT_ENV_ALLOWLIST` | Comma-separated variable names that model-authored scripts may inherit when their names look secret-bearing. Supervisor/remote/principal/session/approval control-plane variables are always stripped and cannot be allowlisted. |
| `COMPUTER_USE_REMOTE_HOST_MODULE` | Host adapter module required by the optional remote-sidecar CLI. It constructs principal-bound `v8-safe` servers and handles authorization loss. |
| `COMPUTER_USE_REMOTE_AUTH_STORE` | Private device-authorization file used by the remote CLI. Stores token hashes, never bearer-token bytes. |
| `COMPUTER_USE_REMOTE_AUTH_VAULT` | Set to `os` to use the first-party macOS Keychain, Windows DPAPI CurrentUser, or Linux Secret Service backend. Fails closed if the platform binding is unavailable. |
| `COMPUTER_USE_REMOTE_AUTH_VAULT_DIR` | Optional Windows-only directory for atomically stored DPAPI ciphertext. Defaults beneath the current user's `LOCALAPPDATA`. |
| `COMPUTER_USE_REMOTE_HOST` / `COMPUTER_USE_REMOTE_PORT` | Remote sidecar bind address and port. Defaults to `127.0.0.1:7331`; wildcard/public binds are rejected. |
| `COMPUTER_USE_REMOTE_ALLOW_LAN` | Permit an explicit private LAN address only when set to `true` and TLS key/certificate files are supplied. |
| `COMPUTER_USE_REMOTE_TLS_KEY` / `COMPUTER_USE_REMOTE_TLS_CERT` | TLS material required together for LAN operation. |
| `COMPUTER_USE_REMOTE_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the remote sidecar. Browser origins are denied by default. |
| `COMPUTER_USE_REMOTE_AUTH_VAULT_KEY` | Non-secret record key used by an injected or first-party synchronous durable credential vault. Defaults to `computer-use-remote/device-authorizations`. |

### Migrating unsafe v7 defaults

The governed v8 policy denies filesystem mutation until
`COMPUTER_USE_FS_ROOTS` is configured and disables open-world `scrape` unless
explicitly enabled. `COMPUTER_USE_V7_COMPAT=true` temporarily restores both
legacy defaults and prints value-free warnings at stdio startup. Generate an
exact safer replacement without exposing supervisor tokens, persistence paths,
or other control-plane values:

```bash
npx computer-use-migrate-v8 --json
npx computer-use-migrate-v8 --shell              # POSIX exports
npx computer-use-migrate-v8 --shell=powershell   # PowerShell assignments
```

The generated configuration preserves only non-secret policy boundaries such
as filesystem roots, app/domain rules, and the emergency chord. It explicitly
turns compatibility and scrape back off and selects the `v8-safe` surface.

Run `npx computer-use-onboard` for the reference terminal setup. It performs
diagnostics, capture, virtual-pointer confirmation, a read-only accessibility
probe, disclosure-safe operating-system permission guidance, explicit
emergency-stop presentation/acknowledgment, and least-privilege
policy selection. It refuses to configure a profile before the stop mechanism
has been presented and acknowledged, then prints a restart-required
environment block but never edits shell profiles or applies configuration
implicitly. Use `--resume <onboarding-id>` to continue durable setup, or
`--non-interactive --pointer-confirmed --emergency-stop-acknowledged --window-id <id>`
in managed hosts. The generated profile records the configured chord while
reporting platforms without a physical global chord as API-stop-only.
The `@zavora-ai/computer-use-mcp/onboarding` export provides the same terminal
runner plus `DesktopSetupController` and the disclosure-safe `SetupViewModel`.
Packaged Electron, Tauri, and shared WebView references live under
`examples/v8-*-setup.mjs`; their renderer contract intentionally excludes
principal/window IDs, paths, app IDs, environment values, pixels, and UI-tree
content. Permission labels, statuses, remediation text, and macOS Settings URIs
are reconstructed from a local allowlist; raw doctor summaries never cross into
renderer state. A trusted Electron/Tauri host may inject
`openPermissionSettings(uri)` and may spread `createNativePermissionHost()`
into `DesktopSetupController`. The native host adapter uses macOS TCC
status/request APIs for Accessibility and Screen Capture, reruns diagnostics
after an explicit renderer gesture, and discards native backend output before
rendering. `canRequestInProcess` and `canOpenSettings` are separate capability
facts. Renderer commands carry only an allowlisted permission ID; Automation,
arbitrary URLs, and unsupported-platform prompts fail closed. Neither opening
settings nor requesting permission is registered as an MCP tool.

On macOS and Windows, the governed v8 path disables physical mouse/keyboard
actions if the native monitor cannot distinguish physical user activity from
injected events. macOS uses a passive hardware-source event tap; Windows uses
low-level hook injection flags. The capability and fail-closed setting are
published in `computer://capabilities/manifest`. Linux currently reports this
as a best-effort X11 XI2 raw-event monitor: server-created XTEST devices are
excluded by source ID, but arbitrary virtual/uinput devices cannot be proven
physical, so `distinguishesInjected` remains false and governed physical input
does not borrow a certified attribution claim. Native Wayland reports the
monitor unavailable. After building the native module, run
`npm run test:input-attribution`; add `-- --interactive` to measure a real
physical event against the 100 ms release target.

Background certification is deliberately an operator workflow, not an MCP
mutation tool. Run `npm run certify:background -- finder` on macOS or
`npm run certify:background -- powershell` on Windows. A passing trace is bound
to the installed app version, adapter version, exact low-level tool, canonical
action contract, instance authority (such as the canonical sandbox root), live
interference evidence, expiry, and SHA-256 digest. An agent must
pass the returned `certification_id` to `preview_action`/`execute_action`; an
operation label alone never inherits background authority. App-version changes,
expiry, mismatched arguments, or a missing trusted adapter fail closed. The MCP
surface exposes only the redacted `get_certification_trace` reader.

For an existing non-sensitive text control, an operator can run
`npm run certify:semantic -- --app-id=... --window-id=... --role=AXTextField --label=...`.
The shared macOS AX/Windows UIA adapter binds the exact app, live window, role,
label digest, and value-size limit. Certified execution calls the native
semantic primitive directly inside the v8 policy/lease/receipt transaction; it
does not enter the legacy `set_value` handler that acquires foreground focus.
The probe writes a random marker, reads it back, restores the original value,
reads the rollback back, and rejects password/credential-like targets.

The v8 semantic `set_value` and `fill_form` paths also inspect the exact AX/UIA
control before preview. macOS secure roles/protected-content attributes and
Windows UIA `IsPassword`, plus a bounded role/label fallback, produce only
allowlisted value-free sensitivity signals. Native accessibility results null
the value of a sensitive control, and the TypeScript boundary recursively
redacts it again. Missing, ambiguous, or stale sensitivity evidence fails
closed; a sensitive target is reclassified as `secret_access` and requires the
corresponding policy decision. The assessment is revalidated immediately
before the effect and is included in the action digest without retaining the
field label or value. Generic physical `type` into the currently focused field
does not yet have equivalent field attribution, so it remains governed by the
existing foreground/target/approval controls rather than this semantic proof.

### Exact and session-operation approvals

Exact-action approval remains the default and is bound to one action digest,
principal, session, policy digest, risk class, execution mode, TTL, and use.
An operator may explicitly choose `session_operation` only when v8 proves a
reusable scope for `set_value` or `fill_form`: the same agent/execution group, app, PID/window,
role/label selectors, operation, risk, mode, public/private data labels, trusted
provenance, and conclusive non-sensitive accessibility evidence. Field values
and labels are not stored in the grant; the reusable scope is a SHA-256 digest.
Session-operation grants are capped at 20 uses and five minutes, and the PiP
reference UI uses 10 uses/two minutes. A changed field, window, policy,
sensitivity assessment, provenance boundary, or use budget requires new
review. Pause, takeover, authorization loss, emergency stop, stop, completion,
and deletion revoke both grants and pending approvals before work can resume.
PiP-issued grants remain inside the v8 runtime and are matched to the exact
action or approved semantic scope during preview and execution. The renderer
and orchestrating graph resume with reviewed action/policy digests without
receiving the bearer grant ID.

### Effect-level postconditions

The v8 facade does not treat a low-level handler's success message as proof that
the requested state changed. `set_value`, `fill_form`, filesystem write/copy/
move/delete, named registry set/delete, and PID-based process kill receive
automatic independent readback. An unsatisfied or unavailable required check
produces an indeterminate receipt, revokes the lease, and cannot be retried as a
new mutation under the same action ID.

For clicks and other targeted mutations, callers can provide an explicit typed
`postcondition`. Expected values and file contents are represented by SHA-256
digests, never copied into approval or audit events. The postcondition is bound
to the action, resource, approval, and receipt digest:

```json
{
  "session_id": "session-123",
  "action_id": "save-action-1",
  "tool": "click_element",
  "arguments": {
    "window_id": 42,
    "role": "AXButton",
    "label": "Save"
  },
  "mode": "foreground",
  "postcondition": {
    "kind": "ui_element",
    "role": "AXStaticText",
    "label": "Saved",
    "exists": true
  }
}
```

The public contract also supports filesystem, registry, non-running process,
and window existence checks. Explicit postconditions must refer to the same
target or resource as the action; unrelated checks are rejected before policy
approval. Copy automatically compares independently read source and destination
SHA-256 digests. Regular files are hashed as raw bytes; directories use a
path-independent canonical tree digest covering sorted relative entries, file
bytes, and symlink targets. Move proves destination presence and source
disappearance because its source is unavailable for post-effect comparison.

Run `npm run conformance:v8` to execute the public policy, multi-agent, and
supervisor suites and combine their source/output digests with live capability
traces. The report carries an integrity digest and explicit evidence levels.
Overall `background-safe` and `supervisor-ready` badges require both macOS and
Windows proof; one platform produces `partial`, not a global pass. The checked-in
report under `docs/conformance/v8/` currently passes deterministic `policy-v2`
and `multi-agent-safe`, while accurately reporting partial live platform and
supervisor coverage. Reports are self-attested build evidence, not a substitute
for signed release provenance or independent security review.

With v8 enabled, `computer://session/current` and the
`computer://session/{sessionId}` resource template expose only sessions owned by
the authenticated host principal. MCP Tasks are a wire projection over that
lifecycle—not an independent execution engine. A recovered session remains
paused, and task cancellation stops v8 before the task is considered cancelled.
`computer://capabilities/manifest` provides a digest-bearing, machine-readable
view of the active/maximum profiles, execution modes, persistence features,
native input-monitor limitations, and per-actuator interference contracts.
`get_session_events` returns a paginated audit-export envelope bound to the
stable JSON Schema and SHA-256 digest published at `computer://audit/schema`.
When the opt-in durable journal is active, exported events retain their
`previousHash`/`hash` links so hosts can verify the disclosed chain.

The optional `@zavora-ai/computer-use-remote` package provides authenticated
MCP Streamable HTTP without changing stdio defaults. Pairing is short-lived,
nonce-bound, one-time, and requires explicit confirmation on the local host.
Each 256-bit MCP session ID is bound to one bearer-token authorization context;
rotation, revocation, expiry, disconnect, host lock, relay loss, or sidecar
shutdown pauses owned work and revokes control. A separate resumable SSE feed
streams principal-owned redacted events, while screen pixels require the
distinct `computer:screenshot` scope and an explicit governed action result.
`submit_follow_up`/`get_follow_ups` provide bounded remote steering without
putting instruction text into the audit event stream.

Audit records redact text, scripts, values, messages, and tokens, replacing them with length and SHA-256 hashes. Use `policy_status` to inspect the active policy without exposing the approval token.

### Focus failure diagnostics

When focus acquisition fails, the server returns a structured `FocusFailure` JSON payload with `isError: true`:

```json
{
  "error": "focus_failed",
  "requestedBundleId": "com.apple.iWork.Numbers",
  "requestedWindowId": 12345,
  "frontmostBefore": "com.openai.codex",
  "frontmostAfter": "com.openai.codex",
  "targetRunning": true,
  "targetHidden": false,
  "targetWindowVisible": true,
  "activationAttempted": true,
  "suggestedRecovery": "activate_window"
}
```

The `suggestedRecovery` field tells you what to do next:

| `suggestedRecovery` | Meaning | Action |
|---|---|---|
| `"activate_window"` | Window is visible but app is not frontmost | Call `activate_window(window_id)` |
| `"unhide_app"` | App is hidden | Call `unhide_app(bundle_id)` then retry |
| `"open_application"` | App is not running | Call `open_application(bundle_id)` then retry |

---

## API reference

### `createComputerUseServer(): McpServer`

Creates an MCP server instance with all registered tools. The server is not started until you connect a transport.

```typescript
import { createComputerUseServer } from '@zavora-ai/computer-use-mcp'
const server = createComputerUseServer()
```

Embedding hosts can expose a smaller provider-facing tool surface and change it
at runtime. Changes use the MCP SDK's `notifications/tools/list_changed`
mechanism. The immutable `profile` is the maximum authority, so negotiation can
never enable a tool excluded by host configuration.

```typescript
let toolRegistry
const server = createComputerUseServer({
  enableV8: true,
  profile: 'full',       // host-authorized maximum
  activeProfile: 'core', // initially visible subset
  onRegistry: registry => { toolRegistry = registry },
})

toolRegistry.setActiveProfile('ax')
```

The public `@zavora-ai/computer-use-mcp/reliability` entry point exports
`DeterministicFakeDesktop`. Integrators can run the versioned
`contracts/v8/safety-corpus.json` without capturing a real screen. The bundled
CI gate covers normal commit/restore, stale-target rejection, post-effect crash
recovery, in-flight user revocation, and 10,000 seeded lease schedules.

The same entry point now exports the v8 reliability-lab API. The public
[`reliability-lab-corpus.json`](contracts/v8/reliability-lab-corpus.json)
separately tracks deterministic, integration, and live evidence for mixed-DPI
displays, UAC/integrity boundaries, remote/lock/sleep/VM sessions, macOS
Spaces/full-screen/Stage Manager, X11 and three Wayland families, and focus,
notification, overlay, and modal interference. Run the safe baseline with:

```bash
npm run reliability:v8
```

The default runner passes only its three image-free deterministic guards and
leaves interactive rows as `not_run`. It never converts a headless CI result
into live proof. Interactive labs can supply an explicit module:

```bash
node scripts/run-v8-reliability-lab.mjs \
  --probe-module ./private-lab/probes.mjs
```

That module exports `probes`, keyed by scenario ID. Each probe receives the
scenario, platform, approach, and clock, and returns its evidence level,
environment facts, named assertions, raw observation counters/latencies, and a
digest of the actual probe source. A passing `live` result requires
`environment.interactive: true`, every corpus assertion, and every required
environment fact. The report recomputes success, attribution, stale-block,
restoration, interference, unintended-mutation, and p50/p95 latency metrics by
platform, approach, and evidence level. Result and report digests detect edits.

The packaged physical emergency-chord probe is opt-in and requires a present
operator. It runs with no MCP transport attached, blocks inside the native
addon, measures hook-to-observer latency, attempts and rejects a post-latch
mutation, then resets through the host-only native path:

```bash
COMPUTER_USE_LIVE_EMERGENCY_PROBE=true npm run reliability:emergency-chord
```

Without that explicit opt-in and an interactive TTY it reports `blocked`; it
cannot create live evidence in headless CI.

The current published workstation baseline is
[`reliability-report-2026-07-13.json`](docs/conformance/v8/reliability-report-2026-07-13.json):
3 deterministic cells pass, 16 local cells remain unrun, and no live platform
claim is made. CI emits a separate report artifact on macOS, Windows, Linux
x64, and Linux arm64 so release reviewers can inspect environments separately.

### Release integrity

Release CI builds all five native targets independently, then generates a
versioned `release-artifacts.json` that binds each optional package and exact
target identity to its Mach-O/PE/ELF format, byte length, and SHA-256 digest.
Copied platform-package binaries are verified against that manifest. If an npm
version already exists, CI downloads it and compares the published native bytes
or main-tarball integrity; mismatched immutable versions fail with a required
version bump instead of being silently skipped.

The workflow packs once and publishes those exact tarballs, produces a
CycloneDX SBOM, attaches GitHub build/SBOM attestations, and uses npm provenance.
The main package cannot publish after a platform-package failure. A separate
tarball install matrix imports the public client, runtime, reliability, and
release entry points on Node 18, 20, 22, and current with optional packages
omitted, proving the bundled native fallback remains installable. Locally, a
partial manifest for available binaries can be inspected with:

```bash
npm run release:manifest -- --allow-missing
```

Code signing and notarization still require release credentials and platform
services; the manifest and provenance checks do not claim to replace them.

Release stage decisions are also executable:

```bash
npm run readiness:v8       # report without failing the shell
npm run readiness:gate     # exit 2 unless the requested stage is proven
```

The evaluator has ten built-in, non-removable gates spanning governed runtime,
dual-platform background purity, supervisor isolation, ADK crash/resume,
supported-target CI, hardware revocation, live reliability, all native
artifacts, platform signing, and independent review. External evidence is
version-bound, expiring, Ed25519-signed, and bound to report/artifact digests;
the host supplies the trusted public-key map. Deleting a gate, editing a claim,
recomputing a public report digest, using an untrusted key, or replaying expired
evidence cannot produce `go`.

The checked-in
[`readiness-report-2026-07-13.json`](docs/conformance/v8/readiness-report-2026-07-13.json)
is intentionally `no_go` with `highestReadyStage: none`. This reflects missing
Windows live background proof, trusted ADK/CI/hardware evidence, the interactive
reliability matrix, complete release artifacts, signing/notarization, and review.

The `@zavora-ai/computer-use-mcp/runtime` entry point exports
`adaptProviderAction` and `adaptProviderActions`. They normalize OpenAI,
Anthropic, Gemini, and generic MCP action shapes before every expanded action
enters the same policy, evidence, lease, receipt, and event pipeline. Gemini's
normalized 1000×1000 coordinates are converted only against host-observed
viewport geometry; model-supplied geometry, target identity, principal,
approval, and safety-decision fields grant no authority. Pixel scroll
magnitudes require an explicit host conversion factor, and browser-only
commands require a separate browser bridge. This follows Google's documented
[Computer Use action protocol](https://ai.google.dev/gemini-api/docs/computer-use)
without pretending browser operations are desktop primitives.

Runnable host patterns are included for the [direct SDK lifecycle](examples/v8-direct-sdk.mjs)
and a [LangGraph-compatible durable executor](examples/v8-langgraph.mjs). The
graph example checkpoints the v8 session before review interrupts and derives
stable action IDs from the provider call, so receipt replay prevents duplicate
mutation after a graph crash/resume.

Embedding hosts may also supply a `BrowserBridge` to `createComputerUseServer`.
It is an internal-only DOM/CDP actuator: `browser_action` never appears in
`list_tools` and can be reached only through `preview_action`/`execute_action`.
Use `browserTargetFromEvidence` to bind the bridge/page identity, URL digest,
DOM revision, viewport, and observation time. The runtime revalidates that page,
enforces the requested/current domain, requires the normal mutation lease and
receipt, and accepts completion only when the bridge returns fresh verified
post-action evidence. No browser engine or raw JavaScript evaluator is bundled.

```typescript
import { createComputerUseServer } from '@zavora-ai/computer-use-mcp'
import { browserTargetFromEvidence } from '@zavora-ai/computer-use-mcp/runtime'

const evidence = await trustedCdpHost.observePage()
const target = browserTargetFromEvidence(evidence)
const server = createComputerUseServer({ enableV8: true, browserBridge: trustedCdpHost })
```

Multi-agent planners can call `reserve_target` before requesting the one-writer
lease. Reservations are short-lived conflict signals, not execution authority;
`release_target_reservation` releases intent, and session pause/takeover/stop
cancels outstanding reservations automatically.

### `connectInProcess(server): Promise<ComputerUseClient>`

Connects a client to the server using an in-memory transport. Both run in the same process.

```typescript
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client'
const client = await connectInProcess(server)
```

### `connectStdio(command, args, cwd?): Promise<ComputerUseClient>`

Connects a client to a server running as a subprocess over stdio.

```typescript
import { connectStdio } from '@zavora-ai/computer-use-mcp/client'
const client = await connectStdio('node', ['dist/server.js'])
```

### `ComputerUseClient`

All methods return `Promise<ToolResult>`.

```typescript
interface ToolResult {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; data: string; mimeType: string }  // base64 JPEG
  >
  isError?: boolean
}
```

---

## Building from source

### macOS

You need:
- [Rust](https://rustup.rs) (stable, 1.70+)
- [Node.js](https://nodejs.org) 18+
- macOS 10.15+ (Catalina or later)

```bash
git clone https://github.com/zavora-ai/computer-use-mcp
cd computer-use-mcp
npm install
npm run build
npm run demo  # verify
```

### Windows

You need:
- [Rust](https://rustup.rs) (stable, 1.70+) with MSVC toolchain
- [Node.js](https://nodejs.org) 18+
- Visual Studio Build Tools (C++ workload) or Visual Studio with C++ support
- Windows 10/11 or Windows Server 2022+

```bash
git clone https://github.com/zavora-ai/computer-use-mcp
cd computer-use-mcp
npm install
npm run build:native:win   # builds Rust native module (.dll -> .node)
npm run build:ts            # compiles TypeScript
node test/smoke-windows.mjs # verify
```

### Linux

You need:
- [Rust](https://rustup.rs) (stable, 1.70+)
- [Node.js](https://nodejs.org) 18+
- X11 development libraries and tools

```bash
# Install dependencies (Ubuntu/Debian)
sudo apt-get install -y pkg-config libx11-dev libxtst-dev libxrandr-dev libxi-dev xdotool wmctrl xclip scrot

git clone https://github.com/zavora-ai/computer-use-mcp
cd computer-use-mcp
npm install
npm run build:native:linux  # builds Rust native module (.so -> .node)
npm run build:ts            # compiles TypeScript
```

**Linux implementation details:**

| What | How |
|---|---|
| Mouse & keyboard | X11/XTest — direct synthetic events via `XTestFakeKeyEvent`/`XTestFakeButtonEvent` |
| User activity | XI2 raw-event monitor excluding XTEST source devices; best-effort only (`distinguishesInjected: false`) |
| Text input | `xdotool type` — reliable Unicode text entry |
| App management | `wmctrl` + `xdotool` + `/proc` |
| Window enumeration | `wmctrl -l -p` + `xdotool` |
| Window activation | `xdotool windowactivate` |
| Display info | X11 `XDisplayWidth`/`XDisplayHeight` |
| Screenshots | `scrot` (fallback: `gnome-screenshot`, `import`) |
| Clipboard | `xclip` (fallback: `xsel`) |
| Workspaces | `wmctrl -d` for listing, `wmctrl -t` for moving windows |
| Accessibility | Stubs (AT-SPI2 integration planned) |
| Scripting | `bash` (or `pwsh` if installed) |

**Notes:**
- X11 is the fully supported Linux path. Wayland uses compositor-dependent helpers (`ydotool`, portals, `grim`, and GNOME D-Bus where available); capability gaps are reported and must not be treated as equivalent to X11.
- Accessibility features (UI tree, find_element, click_element) are stubbed — they return empty results rather than errors.
- The `run_script` tool uses `bash` by default on Linux. Use `language: "bash"` in your scripts.

### Try the examples

**Windows:**
```bash
node examples/windows/notepad.mjs              # Full demo: type, save, zoom, snapshot
node examples/windows/browser.mjs              # Browser navigation + scraping
node examples/windows/sysadmin.mjs             # System health report (no GUI needed)
node examples/windows/cross-app-workflow.mjs   # Web scrape -> file -> Notepad -> verify
node examples/windows/data-entry.mjs           # Structured data entry + CSV report
node examples/windows/virtual-desktops.mjs     # Virtual desktop lifecycle
node examples/windows/ui-automation.mjs        # UI tree + element interaction
node examples/windows/zoom.mjs                 # Region inspection at native resolution
node examples/windows/system-info.mjs          # System introspection
```

**macOS:**
```bash
node examples/macos/calculator.mjs
node examples/macos/window-targeting.mjs
node examples/macos/browser.mjs
node examples/macos/crypto-spreadsheet.mjs
```

### Build scripts

| Script | What it does |
|---|---|
| `npm run build` | Build Rust (macOS) + TypeScript |
| `npm run build:native` | Build Rust `.node` binary (macOS) |
| `npm run build:native:win` | Build Rust `.node` binary (Windows) |
| `npm run build:ts` | Compile TypeScript to `dist/` |
| `npm test` | Build TypeScript + run automated test suite |
| `npm run smoke` | Build all + run live macOS smoke test |
| `npm run demo` | Run the Calculator demo (macOS) |
| `npm run server` | Start the MCP server on stdio |

---

## Security

### What this package can do

This package has **full control of your computer** when permissions are granted. It can:
- See everything on your screen
- Type into any application
- Click anything
- Read and write your clipboard
- Open, hide, and manage any application

**Only grant Accessibility permission to terminals/apps you trust.**

### What we do to keep it safe

- **Input validation at two layers**: Zod schemas at the MCP boundary, plus runtime guards in the session layer. Malformed inputs return errors rather than crashing.
- **Shell injection resistance**: Shell-backed tools use bounded subprocess calls with argument arrays or encoded PowerShell commands. User-provided PowerShell literals are escaped before script construction, and clipboard tools use `pbcopy`/`pbpaste` directly.
- **Temp file safety**: Screenshots use `O_EXCL` (exclusive create) to prevent symlink attacks, with a monotonic counter to avoid collisions.
- **Bounded waits**: The `wait` tool is capped at 300 seconds to prevent indefinite hangs.
- **Explicit network surface**: The native module makes no network calls. The `scrape` tool and user-supplied scripts can access the network; v8 disables `scrape` by default unless explicitly enabled.
- **Error isolation**: All tool errors are caught and returned as `isError: true` responses rather than crashing the server.

### Running in production

- Run the server with the minimum permissions needed.
- Consider running in a dedicated user account with limited app access.
- The server has no authentication — only expose it to trusted local clients.
- Do not expose the stdio server over a network socket without adding authentication.

---

## Limitations

### Platform
- **macOS + Windows + Linux.** Each platform has a native Rust backend.
- **macOS minimum**: macOS 10.15 (Catalina) — required for `NSWorkspaceOpenConfiguration`.
- **macOS tested on**: macOS 12 (Monterey), 13 (Ventura), 14 (Sonoma), 15 (Sequoia).
- **Linux**: X11 has the broadest support. Wayland support is best effort and depends on compositor/portal helpers; semantic accessibility remains limited.
- **Linux tested on**: Ubuntu 24.04+ (GNOME on X11).

### Architecture
- The prebuilt `.node` binary is compiled for the architecture of the machine it was built on (arm64 for Apple Silicon, x86_64 for Intel). If you're on a different architecture, build from source.

### Spaces
- macOS has no public API for creating, moving, or destroying Spaces. The server supports `COMPUTER_USE_SPACES_BACKEND=auto` (default), `yabai`, `mission_control`, and `cgs`.
- `auto` prefers `yabai` when it is installed and authorized, falls back to Mission Control gesture automation, then falls back to private CGS calls.
- `yabai` provides the most reliable visible Spaces behavior, but macOS must grant Accessibility permission to `/opt/homebrew/bin/yabai` or the service will not start. Space create/destroy also require yabai's scripting addition; on yabai v7.1.24 this is installed and loaded with `sudo yabai --load-sa`. On SIP-enabled systems, that may require Recovery-mode SIP configuration before loading succeeds.
- `mission_control` uses visible UI automation and can fail when display layout, animation timing, or Mission Control settings differ.
- `cgs` is best effort only; on SIP-enabled Macs it can return `attached:false`, which means the created Space is internal/orphaned rather than visible in Mission Control.

### Screenshots
- Screenshots default to JPEG (quality 80) for size efficiency. Set `quality: 0` for lossless PNG.
- Screenshots are resized to 1024px wide by default to reduce context size. Pass `width` to override.
- Use `zoom` with a `region: [x1, y1, x2, y2]` to inspect a specific area at full native resolution — ideal for reading small text.
- Use `target_app` (bundle ID) to capture only a specific app window instead of the full screen. Use `target_window_id` (CGWindowID) for even more precise targeting.
- If the target app or window does not have a visible on-screen window, `screenshot` returns an error instead of falling back to the entire display.
- Screenshot resolution matches your display's logical resolution (not pixel resolution on Retina displays). Use `get_display_size` to get both.

### Keyboard
- The `type` tool uses Unicode CGEvent injection — it works for all characters but some apps (games, certain terminals) may not receive injected events.
- Key combos only support keys in the built-in keymap. If a key is missing, `key` will throw an error.
- The `type` tool types in chunks of 20 UTF-16 code units with 3ms gaps. Very fast typing may be dropped by some apps — add `wait` calls if needed.

### Focus management
- The session tracks which app and window should receive keyboard/scroll events via `TargetState`. If you switch apps manually between tool calls, the session may send events to the wrong target. Use `target_app` or `target_window_id` to be explicit.
- `open_application` waits up to 3 seconds for the app to become frontmost. Slow-launching apps may need an additional `wait`.
- Window-level activation (`activate_window`) uses AXUIElement APIs which require Accessibility permission.

### Clipboard
- `read_clipboard` reads plain text only. Rich text, images, and files in the clipboard are not accessible.
- `write_clipboard` writes plain text only.

### Concurrency
- The session is not thread-safe. Do not call tools concurrently from multiple async contexts — await each call before making the next.

---

## Troubleshooting

### "Error: computer-use-mcp requires macOS"
You're running on an unsupported platform. This package supports macOS, Windows, and Linux (X11).

### "Error: Cannot find module '...computer-use-napi.node'"
The native binary is missing. Either:
- Run `npm install` again (the binary should be included in the package)
- Or build from source: `npm run build:native`

### Mouse/keyboard events aren't working
1. Check Accessibility permission: System Settings → Privacy & Security → Accessibility
2. Make sure your terminal app is in the list and the toggle is **on**
3. Restart your terminal after granting permission
4. Run `npm run demo` to verify

### The wrong app is receiving keyboard events
Use the `target_app` or `target_window_id` parameter to explicitly specify the target:
```typescript
await client.type('hello', 'com.apple.TextEdit')
await client.key('command+s', undefined, { targetWindowId: 12345, focusStrategy: 'strict' })
```

### Screenshots are black or empty
This can happen if Screen Recording permission is needed (macOS 15+). Check:
System Settings → Privacy & Security → Screen Recording → add your terminal.

### App won't open / `activated: false`
- Verify the bundle ID is correct: `mdls -name kMDItemCFBundleIdentifier /Applications/YourApp.app`
- The app may take longer to launch — add `await client.wait(2)` after `openApp`
- Use `activate_app` for structured diagnostics — it returns `reason` and `suggestedRecovery`

### Focus failure with `suggestedRecovery`
When you get a `FocusFailure`, follow the `suggestedRecovery` field:
- `"activate_window"` → call `activate_window(window_id)`
- `"unhide_app"` → call `unhide_app(bundle_id)` then retry
- `"open_application"` → call `open_application(bundle_id)` then retry

### Key combo not working
Check that all key names are in the supported list. Common mistakes:
- Use `command` not `cmd+` (both work, but be consistent)
- Use `option` or `alt` for the Option key
- Use `return` not `enter` (both map to the same key)

---

## License

MIT — see [LICENSE](LICENSE)

---

*Built by [James Karanja Maina](https://github.com/jkmaina) at [Zavora Technologies Ltd](https://zavora.ai)*
