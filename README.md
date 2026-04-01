# computer-use-mcp

MCP server + client for macOS computer control. Screenshot, mouse, keyboard, clipboard, and app management — all in-process via Rust NAPI (no subprocesses, no focus stealing).

**macOS only.** Requires Accessibility permission.

## Install

```bash
npm install computer-use-mcp
```

> The package ships a prebuilt `.node` binary for macOS. To build from source: `npm run build` (requires Rust + Cargo).

## Tools (24)

| Category | Tools |
|---|---|
| Screen | `screenshot` |
| Mouse | `left_click` `right_click` `middle_click` `double_click` `triple_click` `mouse_move` `left_click_drag` `left_mouse_down` `left_mouse_up` `scroll` `cursor_position` |
| Keyboard | `type` `key` `hold_key` |
| Clipboard | `read_clipboard` `write_clipboard` |
| Apps | `open_application` `list_running_apps` `hide_app` `unhide_app` |
| Display | `get_display_size` `list_displays` |
| Util | `wait` |

## Usage

### As MCP server (Claude Desktop / any MCP client)

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "node",
      "args": ["node_modules/computer-use-mcp/dist/server.js"]
    }
  }
}
```

### As a library

```typescript
import { createComputerUseServer } from 'computer-use-mcp'
import { connectInProcess, connectStdio } from 'computer-use-mcp/client'

// In-process (fastest)
const server = createComputerUseServer()
const client = await connectInProcess(server)

// Via stdio subprocess
const client = await connectStdio('node', ['node_modules/computer-use-mcp/dist/server.js'])

await client.screenshot()
await client.click(500, 300)
await client.type('Hello world')
await client.key('command+s')
await client.openApp('com.apple.Safari')

await client.close()
```

## Requirements

- macOS 12+
- Node.js 18+
- System Settings → Privacy → Accessibility → grant permission to your terminal

## Architecture

```
Client (TypeScript)
  └─ MCP protocol (in-memory or stdio)
       └─ Server (TypeScript)
            └─ Session (TypeScript)
                 └─ NAPI (.node binary)
                      ├─ CGEvent      — mouse & keyboard
                      ├─ NSWorkspace  — app management
                      ├─ CoreGraphics — display info
                      └─ screencapture — screenshots
```

## License

MIT
