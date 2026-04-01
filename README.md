# computer-use-mcp

> MCP server + client for macOS computer control. Screenshot, mouse, keyboard, clipboard, and app management — all in-process via Rust NAPI. No subprocesses. No focus stealing.

**macOS only** · Node.js 18+ · MIT License

---

## Table of Contents

1. [What is this?](#what-is-this)
2. [How it works](#how-it-works)
3. [Architecture](#architecture)
4. [Installation](#installation)
5. [Permissions setup](#permissions-setup)
6. [Quick start](#quick-start)
7. [Using with MCP clients](#using-with-mcp-clients)
   - [Claude Desktop](#claude-desktop)
   - [Cursor](#cursor)
   - [Windsurf](#windsurf)
   - [Any MCP-compatible client](#any-mcp-compatible-client)
8. [Using as a library](#using-as-a-library)
9. [All 24 tools](#all-24-tools)
10. [API reference](#api-reference)
11. [Building from source](#building-from-source)
12. [Security](#security)
13. [Limitations](#limitations)
14. [Troubleshooting](#troubleshooting)
15. [License](#license)

---

## What is this?

`computer-use-mcp` lets an AI model (or any program) control your Mac — take screenshots, move the mouse, type text, press keys, read/write the clipboard, open and manage apps, and query display information.

It implements the [Model Context Protocol (MCP)](https://modelcontextprotocol.io), which means any MCP-compatible AI client (Claude Desktop, Cursor, Windsurf, etc.) can use it as a tool server with zero extra code.

It also ships a typed TypeScript client so you can drive your Mac programmatically from your own scripts.

---

## How it works

Most computer-use tools work by spawning shell commands (`xdotool`, `osascript`, `cliclick`) for every action. This is slow, unreliable, and causes focus-stealing — your terminal window keeps jumping to the front.

This package takes a different approach: a **Rust native module** (`.node` addon) that calls macOS APIs directly in-process:

| What | How |
|---|---|
| Mouse & keyboard | `CGEvent` (CoreGraphics) — same API the OS uses |
| App management | `NSWorkspace` (AppKit) |
| Display info | `CoreGraphics` display APIs |
| Screenshots | `screencapture` CLI (fastest reliable method on macOS) |
| Clipboard | `pbcopy` / `pbpaste` |

Because everything runs in the same process as Node.js, there are no subprocess round-trips and no window focus changes.

---

## Architecture

```
Your AI client (Claude, Cursor, etc.)
        │
        │  MCP protocol (JSON-RPC over stdio or in-memory)
        ▼
  MCP Server  (src/server.ts)
  ├── Registers 24 tools with Zod schemas
  ├── Validates all inputs at the boundary
  └── Delegates to Session
        │
        ▼
  Session  (src/session.ts)
  ├── Manages target app focus state
  ├── Validates inputs (second layer)
  ├── Handles focus acquisition before keyboard/scroll actions
  └── Calls native module
        │
        ▼
  NAPI Native Module  (computer-use-napi.node)
  ├── mouse.rs    — CGEvent mouse events
  ├── keyboard.rs — CGEvent keyboard events (static keycode map)
  ├── apps.rs     — NSWorkspace app management
  ├── display.rs  — CoreGraphics display queries
  └── screenshot.rs — screencapture + JPEG parsing
```

**Data flow for a tool call:**

```
AI sends: { tool: "left_click", args: { coordinate: [500, 300] } }
  → Zod validates coordinate is [number, number]
  → Session checks focus, validates coord
  → Rust: CGEvent mouse move + click at (500, 300)
  → Returns: { content: [{ type: "text", text: "Clicked (500, 300)" }] }
```

---

## Installation

### Option 1: npm (prebuilt binary, recommended)

```bash
npm install computer-use-mcp
```

The package ships a prebuilt `.node` binary for macOS. No Rust required.

### Option 2: Build from source

Requires [Rust](https://rustup.rs) and Cargo.

```bash
git clone https://github.com/your-org/computer-use-mcp
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
npx tsx node_modules/computer-use-mcp/src/demo.ts
```

If permissions are correct, you'll see Calculator open, compute 42+58, and close. If you see an error about permissions, revisit the steps above.

---

## Quick start

### Run the MCP server

```bash
node node_modules/computer-use-mcp/dist/server.js
```

The server speaks MCP over stdio and is ready to connect to any MCP client.

### Test it works

```bash
# Takes a screenshot and saves it
node -e "
import('computer-use-mcp').then(async ({ createComputerUseServer }) => {
  const { connectInProcess } = await import('computer-use-mcp/client')
  const s = createComputerUseServer()
  const c = await connectInProcess(s)
  const shot = await c.screenshot()
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

### Claude Desktop

1. Find your Claude Desktop config file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

2. Add the server:

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/computer-use-mcp/dist/server.js"]
    }
  }
}
```

3. Restart Claude Desktop.

4. You should see a hammer icon (🔨) in the chat input — click it to see the available tools.

5. Try asking Claude: *"Take a screenshot and describe what you see"* or *"Open Safari and navigate to example.com"*

> **Tip:** Use the absolute path to avoid issues with working directory. You can find it by running `pwd` in your project directory.

---

### Cursor

1. Open Cursor settings: `Cmd+,` → search for "MCP"

2. Click **Add MCP Server** and fill in:
   - **Name**: `computer-use`
   - **Command**: `node`
   - **Args**: `["/absolute/path/to/node_modules/computer-use-mcp/dist/server.js"]`

3. Save and reload the window (`Cmd+Shift+P` → "Reload Window").

4. In the AI chat, the computer-use tools will be available automatically.

---

### Windsurf

1. Open `~/.codeium/windsurf/mcp_config.json` (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "node",
      "args": ["/absolute/path/to/node_modules/computer-use-mcp/dist/server.js"]
    }
  }
}
```

2. Restart Windsurf.

---

### Any MCP-compatible client

The server speaks standard MCP over stdio. Point any MCP client at:

```
command: node
args: ["/path/to/node_modules/computer-use-mcp/dist/server.js"]
```

Or use the npm global install for a cleaner path:

```bash
npm install -g computer-use-mcp
```

Then use:
```
command: node
args: ["$(npm root -g)/computer-use-mcp/dist/server.js"]
```

---

## Using as a library

Import the server and client directly in your TypeScript/JavaScript code.

### In-process (fastest)

Both server and client run in the same Node.js process. No subprocess, no IPC overhead.

```typescript
import { createComputerUseServer } from 'computer-use-mcp'
import { connectInProcess } from 'computer-use-mcp/client'

const server = createComputerUseServer()
const client = await connectInProcess(server)

// Take a screenshot
const shot = await client.screenshot()
const img = shot.content.find(c => c.type === 'image')
if (img?.type === 'image') {
  // img.data is base64-encoded JPEG
  // img.mimeType is "image/jpeg"
}

// Mouse
await client.click(500, 300)           // left click
await client.doubleClick(500, 300)     // double click
await client.rightClick(500, 300)      // right click
await client.moveMouse(500, 300)       // move without clicking
await client.scroll(500, 300, 'down', 5) // scroll down 5 lines
await client.drag([800, 400], [200, 200]) // drag from [200,200] to [800,400]

// Keyboard
await client.type('Hello, world!')     // type text
await client.key('command+s')          // key combo
await client.key('return')             // single key
await client.key('command+z', 'com.apple.TextEdit') // target specific app

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
import { connectStdio } from 'computer-use-mcp/client'

const client = await connectStdio('node', [
  'node_modules/computer-use-mcp/dist/server.js'
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

## All 24 tools

### Screenshot

| Tool | Description | Parameters |
|---|---|---|
| `screenshot` | Capture the full screen | — |

### Mouse

| Tool | Description | Parameters |
|---|---|---|
| `left_click` | Left-click at coordinates | `coordinate: [x, y]` |
| `right_click` | Right-click at coordinates | `coordinate: [x, y]` |
| `middle_click` | Middle-click at coordinates | `coordinate: [x, y]` |
| `double_click` | Double-click at coordinates | `coordinate: [x, y]` |
| `triple_click` | Triple-click (select word) | `coordinate: [x, y]` |
| `mouse_move` | Move cursor without clicking | `coordinate: [x, y]` |
| `left_click_drag` | Click and drag | `coordinate: [x, y]`, `start_coordinate?: [x, y]` |
| `left_mouse_down` | Press mouse button (hold) | `coordinate: [x, y]` |
| `left_mouse_up` | Release mouse button | `coordinate: [x, y]` |
| `scroll` | Scroll at position | `coordinate: [x, y]`, `direction: up\|down\|left\|right`, `amount?: number`, `target_app?: string` |
| `cursor_position` | Get current cursor position | — |

### Keyboard

| Tool | Description | Parameters |
|---|---|---|
| `type` | Type text (Unicode, all characters) | `text: string`, `target_app?: string` |
| `key` | Press a key or combo | `text: string` (e.g. `"command+c"`), `repeat?: number`, `target_app?: string` |
| `hold_key` | Hold keys for a duration | `keys: string[]`, `duration: number` (seconds), `target_app?: string` |

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

### Display

| Tool | Description | Parameters |
|---|---|---|
| `get_display_size` | Get display dimensions and scale | `display_id?: number` |
| `list_displays` | List all connected displays | — |

### Utility

| Tool | Description | Parameters |
|---|---|---|
| `wait` | Pause execution | `duration: number` (seconds, max 300) |

---

## API reference

### `createComputerUseServer(): McpServer`

Creates an MCP server instance with all 24 tools registered. The server is not started until you connect a transport.

```typescript
import { createComputerUseServer } from 'computer-use-mcp'
const server = createComputerUseServer()
```

### `connectInProcess(server): Promise<ComputerUseClient>`

Connects a client to the server using an in-memory transport. Both run in the same process.

```typescript
import { connectInProcess } from 'computer-use-mcp/client'
const client = await connectInProcess(server)
```

### `connectStdio(command, args, cwd?): Promise<ComputerUseClient>`

Connects a client to a server running as a subprocess over stdio.

```typescript
import { connectStdio } from 'computer-use-mcp/client'
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
- Screenshot resolution matches your display's logical resolution (not pixel resolution on Retina displays). Use `get_display_size` to get both.

### Keyboard
- The `type` tool uses Unicode CGEvent injection — it works for all characters but some apps (games, certain terminals) may not receive injected events.
- Key combos only support keys in the built-in keymap. If a key is missing, `key` will throw an error.
- The `type` tool types in chunks of 20 UTF-16 code units with 3ms gaps. Very fast typing may be dropped by some apps — add `wait` calls if needed.

### Focus management
- The session tracks which app should receive keyboard/scroll events. If you switch apps manually between tool calls, the session may send events to the wrong app. Use `target_app` to be explicit.
- `open_application` waits up to 3 seconds for the app to become frontmost. Slow-launching apps may need an additional `wait`.

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
Use the `target_app` parameter to explicitly specify the bundle ID:
```typescript
await client.type('hello', 'com.apple.TextEdit')
await client.key('command+s', 'com.apple.TextEdit')
```

### Screenshots are black or empty
This can happen if Screen Recording permission is needed (macOS 15+). Check:
System Settings → Privacy & Security → Screen Recording → add your terminal.

### App won't open / `activated: false`
- Verify the bundle ID is correct: `mdls -name kMDItemCFBundleIdentifier /Applications/YourApp.app`
- The app may take longer to launch — add `await client.wait(2)` after `openApp`

### Key combo not working
Check that all key names are in the supported list. Common mistakes:
- Use `command` not `cmd+` (both work, but be consistent)
- Use `option` or `alt` for the Option key
- Use `return` not `enter` (both map to the same key)

---

## License

MIT — see [LICENSE](LICENSE)
