# Computer Use MCP

Standalone MCP server and client for computer control — screenshot, mouse, keyboard, clipboard, and app management. Extracted from Claude Code's "Chicago MCP" architecture and rebuilt with zero native module dependencies (uses macOS built-in `screencapture`, `osascript`, and CoreGraphics via Python).

## Architecture

```
┌─────────────────────┐         MCP Protocol         ┌──────────────────────┐
│     MCP Client      │ ◄──── stdio or in-memory ───► │     MCP Server       │
│                     │                               │                      │
│  client.ts          │                               │  server.ts           │
│  • connectStdio()   │                               │  • 20 tools          │
│  • connectInProcess()│                              │  • screenshot        │
│  • typed methods    │                               │  • mouse/keyboard    │
│                     │                               │  • clipboard         │
└─────────────────────┘                               │  • app management    │
                                                      └──────┬───────────────┘
                                                             │
                                                      ┌──────▼───────────────┐
                                                      │    Executor          │
                                                      │                      │
                                                      │  executor.ts         │
                                                      │  • screencapture     │
                                                      │  • CoreGraphics/py   │
                                                      │  • osascript         │
                                                      │  • pbcopy/pbpaste    │
                                                      └──────────────────────┘
```

## Tools

| Tool | Description |
|------|-------------|
| `screenshot` | Capture the screen (returns PNG image) |
| `left_click` | Left-click at coordinates |
| `right_click` | Right-click at coordinates |
| `middle_click` | Middle-click at coordinates |
| `double_click` | Double-click at coordinates |
| `triple_click` | Triple-click at coordinates |
| `mouse_move` | Move cursor to coordinates |
| `left_click_drag` | Click-drag from one point to another |
| `left_mouse_down` | Press left mouse button |
| `left_mouse_up` | Release left mouse button |
| `cursor_position` | Get current cursor position |
| `scroll` | Scroll at a position (up/down/left/right) |
| `type` | Type text via keystrokes |
| `key` | Press key combination (e.g. `command+c`) |
| `hold_key` | Hold keys for a duration |
| `read_clipboard` | Read clipboard contents |
| `write_clipboard` | Write text to clipboard |
| `open_application` | Open app by bundle ID |
| `wait` | Wait for N seconds |

## Quick Start

```bash
npm install
```

### Run as MCP server (stdio)

```bash
# Start the server — an MCP client (like Claude Desktop) connects via stdio
npx ts-node --esm src/server.ts
```

Add to Claude Desktop's `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "computer-use": {
      "command": "npx",
      "args": ["ts-node", "--esm", "src/server.ts"],
      "cwd": "/path/to/computer-use-mcp"
    }
  }
}
```

### Run the demo (in-process client + server)

```bash
npx ts-node --esm src/demo.ts
```

### Use as a library

```typescript
import { createComputerUseServer } from './server.js'
import { connectInProcess, connectStdio } from './client.js'

// Option 1: In-process (no subprocess)
const server = createComputerUseServer()
const client = await connectInProcess(server)

// Option 2: Subprocess via stdio
const client = await connectStdio('npx', ['ts-node', '--esm', 'src/server.ts'])

// Use typed methods
await client.screenshot()
await client.click(500, 300)
await client.type('Hello world')
await client.key('command+s')
await client.scroll(500, 300, 'down', 5)

// Or call any tool by name
await client.callTool('left_click', { coordinate: [500, 300] })

await client.close()
```

## Requirements

- macOS (uses `screencapture`, `osascript`, CoreGraphics)
- Node.js >= 18
- Python 3 with PyObjC (`Quartz` module — pre-installed on macOS)
- Accessibility permission for the terminal (System Settings → Privacy → Accessibility)

## How It Works

The executor uses macOS built-in tools — no native Node.js modules to compile:

- **Screenshot**: `screencapture` CLI (built into macOS)
- **Mouse**: CoreGraphics `CGEventCreateMouseEvent` via Python's `Quartz` bridge
- **Keyboard**: AppleScript `System Events` via `osascript`
- **Clipboard**: `pbcopy` / `pbpaste`
- **Apps**: `open -b <bundleId>`

The MCP server wraps these in standard MCP tool definitions. The client connects via stdio (subprocess) or in-memory transports (same process).

## Extending

To add cross-platform support, replace `executor.ts` with platform-specific implementations. The server and client are platform-agnostic — only the executor touches OS APIs.
