# computer-use-mcp

> MCP server + client for macOS computer control. Screenshot, mouse, keyboard, clipboard, app management, and window-level targeting — all in-process via Rust NAPI. No subprocesses. No focus stealing.

**macOS only** · Node.js 18+ · MIT License

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

`computer-use-mcp` lets an AI model (or any program) control your Mac — take screenshots, move the mouse, type text, press keys, read/write the clipboard, open and manage apps, target specific windows, and query display information.

It implements the [Model Context Protocol (MCP)](https://modelcontextprotocol.io), which means any MCP-compatible AI client (Claude Desktop, Cursor, Windsurf, etc.) can use it as a tool server with zero extra code.

It also ships a typed TypeScript client so you can drive your Mac programmatically from your own scripts.

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

This package takes a different approach: a **Rust native module** (`.node` addon) that calls macOS APIs directly in-process:

| What | How |
|---|---|
| Mouse & keyboard | `CGEvent` (CoreGraphics) — same API the OS uses |
| App management | `NSWorkspace` (AppKit) |
| Window enumeration | `CGWindowListCopyWindowInfo` (CoreGraphics) — direct FFI, no subprocess |
| Window activation | `AXUIElement` (Accessibility API) — window-level raise |
| Display info | `CoreGraphics` display APIs |
| Screenshots | `screencapture` CLI (fastest reliable method on macOS) |
| Clipboard | `pbcopy` / `pbpaste` |

Mouse, keyboard, focus, window enumeration, and display operations run in-process via the native module. Screenshots and clipboard access still rely on the system utilities that are most reliable on macOS, but the control path avoids per-action shell hops.

---

## Architecture

```
Your AI client (Claude, Cursor, etc.)
        │
        │  MCP protocol (JSON-RPC over stdio or in-memory)
        ▼
  MCP Server  (src/server.ts)
  ├── Registers 45 tools with Zod schemas
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

---

## Permissions setup

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

### Verifying permissions work

Run the built-in demo:

```bash
npx @zavora-ai/computer-use-mcp demo
```

If permissions are correct, you'll see Calculator open, compute 42+58, and close. If you see an error about permissions, revisit the steps above.

---

## Quick start

### Run the MCP server

```bash
npx --yes --prefer-offline @zavora-ai/computer-use-mcp
```

The server speaks MCP over stdio and is ready to connect to any MCP client.

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
| `screenshot` | Capture the screen or a specific app/window | `width?: number` (default 1024), `quality?: number`, `provider?: string`, `target_app?: string` (bundle ID), `target_window_id?: number` (CGWindowID — takes precedence over `target_app`) |

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
| `type` | Type text (Unicode, all characters) | `text: string`, `target_app?: string`, `target_window_id?: number`, `focus_strategy?: string` |
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
| `run_script` | Execute AppleScript or JXA via bounded `osascript`. Fastest path for scriptable apps. | `language: "applescript"\|"jxa"`, `script: string`, `timeout_ms?: number` |
| `get_app_dictionary` | Inspect a scriptable app's dictionary (suites/commands/classes). Cached per PID. | `bundle_id: string`, `suite?: string` |

### Discovery (v5)

| Tool | Description | Parameters |
|---|---|---|
| `get_tool_guide` | Recommend the best approach for a task. Call BEFORE screenshot + click. | `task_description: string` |
| `get_app_capabilities` | Probe: scriptable? accessible? running? hidden? | `bundle_id: string` |

### Spaces — read-only (v5)

| Tool | Description | Parameters |
|---|---|---|
| `list_spaces` | List user Spaces grouped by display. Pure read via CGS. | — |
| `get_active_space` | Currently active Space ID. | — |

> **Note:** Space *mutation* tools (create / move / destroy) are not exposed. CGS-created Spaces are orphaned on SIP-enabled Macs (not visible in Mission Control) and window moves silently no-op without elevated entitlements. See [CHANGELOG](CHANGELOG.md) for details.

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
| `strict` | Fail with `FocusFailure` if the target cannot be confirmed as frontmost. For keyboard tools with a `target_window_id`, also confirms the window is on-screen. | Keyboard tools (`type`, `key`, `hold_key`) |
| `best_effort` | Attempt focus acquisition and proceed with input delivery even if full confirmation is not achieved. | Pointer tools (`left_click`, `scroll`, etc.) |
| `none` | Skip all activation. Send input to the current frontmost target regardless of `target_app` or `target_window_id`. | — (must be explicit) |

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

Creates an MCP server instance with all 45 tools registered. The server is not started until you connect a transport.

```typescript
import { createComputerUseServer } from '@zavora-ai/computer-use-mcp'
const server = createComputerUseServer()
```

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

You need:
- [Rust](https://rustup.rs) (stable, 1.70+)
- [Node.js](https://nodejs.org) 18+
- macOS 10.15+ (Catalina or later)

```bash
# Clone
git clone https://github.com/your-org/computer-use-mcp
cd computer-use-mcp

# Install Node dependencies
npm install

# Build Rust native module + TypeScript
npm run build

# Run the demo to verify
npm run demo
```

### Build scripts

| Script | What it does |
|---|---|
| `npm run build` | Build Rust + TypeScript |
| `npm run build:native` | Build only the Rust `.node` binary |
| `npm run build:ts` | Compile TypeScript to `dist/` |
| `npm run demo` | Run the Calculator demo |
| `npm run server` | Start the MCP server on stdio |

---

## Security

### What this package can do

This package has **full control of your Mac** when Accessibility permission is granted. It can:
- See everything on your screen
- Type into any application
- Click anything
- Read and write your clipboard
- Open, hide, and manage any application

**Only grant Accessibility permission to terminals/apps you trust.**

### What we do to keep it safe

- **Input validation at two layers**: Zod schemas at the MCP boundary, plus runtime guards in the session layer. Malformed inputs return errors rather than crashing.
- **No shell injection**: All system calls use `execFileSync` with argument arrays (never string interpolation). The clipboard tools use `pbcopy`/`pbpaste` directly.
- **Temp file safety**: Screenshots use `O_EXCL` (exclusive create) to prevent symlink attacks, with a monotonic counter to avoid collisions.
- **Bounded waits**: The `wait` tool is capped at 300 seconds to prevent indefinite hangs.
- **No network access**: The native module makes no network calls. The MCP server itself makes no network calls. Only the example scripts (`crypto-numbers.ts`) fetch external data.
- **Error isolation**: All tool errors are caught and returned as `isError: true` responses rather than crashing the server.

### Running in production

- Run the server with the minimum permissions needed.
- Consider running in a dedicated user account with limited app access.
- The server has no authentication — only expose it to trusted local clients.
- Do not expose the stdio server over a network socket without adding authentication.

---

## Limitations

### Platform
- **macOS only.** The native module uses CoreGraphics, NSWorkspace, and `screencapture` — all macOS-specific. Linux and Windows are not supported.
- **Minimum**: macOS 10.15 (Catalina) — required for `NSWorkspaceOpenConfiguration`.
- **Tested on**: macOS 12 (Monterey), 13 (Ventura), 14 (Sonoma), 15 (Sequoia).

### Architecture
- The prebuilt `.node` binary is compiled for the architecture of the machine it was built on (arm64 for Apple Silicon, x86_64 for Intel). If you're on a different architecture, build from source.

### Screenshots
- Screenshots are JPEG (not PNG) for size. Quality is high but not lossless.
- Screenshots are resized to 1024px wide by default to reduce context size. Pass `width` to override.
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
You're running on Linux or Windows. This package is macOS-only.

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