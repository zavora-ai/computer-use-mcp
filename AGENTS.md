# Using computer-use-mcp with AI Agents

This guide covers how to integrate `computer-use-mcp` into AI agent frameworks and agentic workflows. Works on **macOS**, **Windows**, and **Linux**.

**Skills (recommended):** copy from `skills/` in this package into your agent skills directory:
- `skills/computer-use` — when/how to use desktop control
- `skills/computer-use-forms` — accessibility form fill
- `skills/computer-use-scripting` — AppleScript / PowerShell first
- `skills/computer-use-recovery` — FocusFailure recovery
- `skills/computer-use-windows-admin` — filesystem / registry / process

**MCP prompts:** `diagnose-desktop`, `fill-form`, `script-first`, `safe-desktop-task`  
**Profiles:** `COMPUTER_USE_PROFILE=core|ax|scripting|windows-admin|full` (default `full`)

**v7 environment & behaviors:**
- **Cancellation:** tool calls honor the host `AbortSignal` (`wait` returns early; `run_script` terminates its subprocess tree through a POSIX process group or recursive Windows `taskkill`).
- **Progress:** long `filesystem` searches emit `notifications/progress` when a progress token is present.
- **Argument validation:** arguments are validated against the advertised input schema at the MCP boundary. Schema defaults are applied before the handler runs, and malformed input returns a structured `invalid_arguments` result listing each offending path — not a JSON-RPC fault. Retry with corrected arguments.

## Default security posture

**Out of the box this server is permissive by design.** With no configuration:
`run_script` executes arbitrary AppleScript/JXA/PowerShell, and `filesystem`
reads and writes anywhere the host process can reach. Nothing prompts for
approval. That default exists so desktop automation works without setup — it is
not a sandbox.

The only rule enabled by default is the sensitive-app gate: an action whose
target is a credential manager (Keychain Access, Passwords, 1Password) requires
approval. Because `run_script` takes no target argument, its script body is
matched against the same app names; a script that addresses a sensitive app
requires approval, and one that addresses a blocked app is denied. That matching
is defense in depth, not a boundary — a script can compose a name at runtime.
Use `COMPUTER_USE_REQUIRE_APPROVAL_FOR=run_script` when unconditional consent is
required.

Harden with the variables below before granting a model desktop access on a
machine that holds anything you care about. `doctor` reports the effective
posture, and `policy_status` returns it as structured data.

### Access control and approval

| Variable | Effect |
|---|---|
| `COMPUTER_USE_ALLOWED_APPS` | Comma-separated allowlist. When set, mutating tools may only target these apps. `run_script` cannot be checked against it, so it requires approval whenever an allowlist is configured. |
| `COMPUTER_USE_BLOCKED_APPS` | Comma-separated denylist, checked before everything else. Also denies a `run_script` body that names a blocked app. |
| `COMPUTER_USE_CREDENTIAL_APPS` | Overrides the built-in sensitive-app list. Set to an empty string to opt out entirely. |
| `COMPUTER_USE_REQUIRE_APPROVAL=true` | Every mutating tool requires approval. |
| `COMPUTER_USE_REQUIRE_APPROVAL_FOR` | Comma-separated tool names that always require approval. |
| `COMPUTER_USE_DESTRUCTIVE_REQUIRES_APPROVAL=true` | Require approval for `run_script`, `process_kill --kill`, `registry` set/delete, and `filesystem` write/copy/move/delete. |
| `COMPUTER_USE_APPROVAL_TOKEN` | Shared secret for headless approval; pass it as the `approval_token` argument. Compared in constant time. Without it, approval needs host elicitation. |
| `COMPUTER_USE_FS_ROOTS` | Confine `filesystem` to comma-separated absolute roots, checked on both `path` and `destination` after `..`/symlink resolution. Unset = unrestricted. |
| `COMPUTER_USE_SCRIPT_ENV_ALLOWLIST` | Comma-separated env names a model-authored script may inherit. Secret-shaped and high-risk variables are stripped by default; supervisor/remote authority is never inheritable, even through this list. |
| `COMPUTER_USE_AUDIT_LOG` | Path to a JSONL audit log, or `true`/`false`. Defaults on to `~/.computer-use-mcp/audit.jsonl`. Sensitive argument values are dropped, not hashed. |
| `COMPUTER_USE_REQUEST_STATE_SECRET` | Signing key for multi-round-trip request state. Unset = a random per-process key, so approvals never survive a restart. |

### Surface and behavior

| Variable | Effect |
|---|---|
| `COMPUTER_USE_PROFILE` | `core \| ax \| scripting \| windows-admin \| full` (default `full`). Bounds the maximum exposed tool surface. |
| `COMPUTER_USE_ACTIVE_PROFILE` | Starting profile within that bound; may be narrowed at runtime but never widened past `COMPUTER_USE_PROFILE`. |
| `COMPUTER_USE_NATIVE_PATH` | Override native `.node` resolution (else: separately installed platform package → bundled binary). |
| `COMPUTER_USE_LEGACY_FOCUS_TAG=true` | Restore the legacy `[focusRequired: X]` description suffix (off by default in v7; still in `_meta` / `get_tool_metadata`). |
| `COMPUTER_USE_STRUCTURED_CONTENT=false` | Legacy text-only results (omits `structuredContent` + `outputSchema`). |
| `COMPUTER_USE_PREPARE_KEEP_VISIBLE` | Comma-separated bundle IDs that `focus_strategy: "prepare_display"` must not hide. Defaults to the target plus the terminal. |
| `COMPUTER_USE_SPACES_BACKEND` | `auto \| yabai \| mission_control \| cgs` — virtual-desktop backend selection on macOS. |
| `COMPUTER_USE_PROVIDER`, `COMPUTER_USE_WIDTH`, `COMPUTER_USE_QUALITY`, `COMPUTER_USE_VISION` | Screenshot defaults: provider preset, width, JPEG quality (`0` = PNG), and whether vision is enabled. |

### Hosting and runtime

| Variable | Effect |
|---|---|
| `COMPUTER_USE_HTTP_HOST`, `COMPUTER_USE_HTTP_PORT` | Bind address and port for `computer-use-mcp-http` (default `127.0.0.1:3100`). The bundled runner refuses any non-loopback host. |
| `COMPUTER_USE_MAX_TASKS`, `COMPUTER_USE_TASK_TTL_MS`, `COMPUTER_USE_TASK_POLL_INTERVAL_MS` | Tasks-extension concurrency per owner (16), record TTL (1h), and poll hint (1s). |
| `COMPUTER_USE_PRINCIPAL_ID`, `COMPUTER_USE_SESSION_ID` | Identity labels for audit records in host-managed deployments. |
| `COMPUTER_USE_SUPERVISOR_*`, `COMPUTER_USE_REMOTE_*` | Control-plane configuration for the optional supervisor and remote packages. Never inherited by scripts.


**v7.1 MCP behavior:**
- Legacy MCP clients continue through `initialize`; no tool names or v7 input schemas changed.
- MCP 2026-07-28 clients use stateless requests, `server/discover`, per-request identity/capabilities, cache hints, MRTR, and `subscriptions/listen`.
- The `io.modelcontextprotocol/tasks` extension is opt-in and server-directed for selected long-running read-only calls. Extension-aware hosts poll `tasks/get`; stock clients should omit the extension capability and receive synchronous results.
- `computer-use-mcp-http` serves the bundled loopback-only HTTP endpoint. Remote hosts must embed `createComputerUseHttpHandler`, validate OAuth themselves, and pass only verified `authInfo`.
- Tool annotations are descriptive hints, never an authorization boundary.

**v7.2 behavior changes:**
- Advertised schema defaults now reach handlers, so an omitted argument behaves exactly like its documented default. `snapshot` no longer returns a UI tree unless `use_vision: true`, and `multi_select` is additive unless you pass `press_ctrl: false`.
- Malformed arguments return a structured `invalid_arguments` result instead of a JSON-RPC fault.
- `run_script` is matched against the sensitive-app and blocked-app lists by script body, since it has no target argument.
- The cross-process session lock records a renewed lease, so a crashed holder whose PID is recycled no longer wedges every mutating tool.
- `resize_window` quotes `window_name` for PowerShell and AppleScript rather than interpolating it.

## Tool priority guidance

Desktop computer use should be your **last resort**. Always prefer more precise tools:

1. **Connector / integration** — structured APIs, MCP connectors, app-specific plugins
2. **Shell / filesystem** — terminal commands, file I/O, CLI tools
3. **Browser automation** — Playwright, Puppeteer, Browser Use for web pages
4. **Desktop computer use** — this package, for native desktop apps, simulators, installers, modal dialogs, and UI-only workflows

Desktop control works for anything on screen, but structured tools are faster, more reliable, and easier to recover from.

## Quick setup for any agent

The server speaks both legacy and MCP 2026-07-28 over stdio. Start it with:

```bash
npx --yes @zavora-ai/computer-use-mcp
```

Any agent framework with MCP support can connect to it immediately.

## Codex

Codex reads local MCP servers from `~/.codex/config.toml`:

```toml
[mcp_servers.computer-use]
command = "npx"
args = ["--yes", "--prefer-offline", "@zavora-ai/computer-use-mcp"]
```

You can confirm the server is available with:

```bash
codex mcp list
```

## Claude (Anthropic)

### Claude Desktop

Add to your Claude Desktop config:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

Restart Claude Desktop. Claude will automatically use the tools when asked to interact with your computer.

**Example prompts:**
- *"Take a screenshot and tell me what's on my screen"*
- *"Open Notepad, write a short poem, and save it to the desktop"* (Windows)
- *"Open Safari, go to github.com, and find the trending repositories"* (macOS)
- *"List all virtual desktops and create a new one"*

### Claude API (programmatic)

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { createComputerUseServer } from '@zavora-ai/computer-use-mcp'
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client'

// Start the MCP server in-process
const server = createComputerUseServer()
const mcpClient = await connectInProcess(server)

// List available tools to pass to Claude
const tools = await mcpClient.listTools()

const anthropic = new Anthropic()

// Agent loop
async function runAgent(task: string) {
  const messages: any[] = [{ role: 'user', content: task }]

  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema
      })),
      messages,
    })

    if (response.stop_reason !== 'tool_use') break

    // Execute tool calls
    const toolResults = []
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const result = await mcpClient.callTool(block.name, block.input as any)
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content,
        })
      }
    }

    messages.push({ role: 'assistant', content: response.content })
    if (toolResults.length) {
      messages.push({ role: 'user', content: toolResults })
    }
  }

  await mcpClient.close()
}

await runAgent('Open Calculator and compute 123 * 456')
```

## OpenAI (Chat Completions)

```typescript
import OpenAI from 'openai'
import { createComputerUseServer } from '@zavora-ai/computer-use-mcp'
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client'

const server = createComputerUseServer()
const mcpClient = await connectInProcess(server)
const openai = new OpenAI()

// Wrap MCP tools as OpenAI function tools
const tools = (await mcpClient.listTools()).map(t => ({
  type: 'function' as const,
  function: {
    name: t.name,
    description: t.description ?? '',
    parameters: t.inputSchema,
  },
}))

async function runAgent(task: string) {
  const messages: any[] = [{ role: 'user', content: task }]

  while (true) {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools,
      tool_choice: 'auto',
    })

    const msg = response.choices[0].message
    messages.push(msg)

    if (!msg.tool_calls?.length) break

    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments)
      const result = await mcpClient.callTool(call.function.name, args)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result.content),
      })
    }
  }

  await mcpClient.close()
}

await runAgent('Take a screenshot and describe what you see')
```

## LangChain / LangGraph

```typescript
import { ChatAnthropic } from '@langchain/anthropic'
import { createComputerUseServer } from '@zavora-ai/computer-use-mcp'
import { connectInProcess } from '@zavora-ai/computer-use-mcp/client'

const server = createComputerUseServer()
const mcpClient = await connectInProcess(server)

// Wrap as LangChain tools
import { DynamicStructuredTool } from '@langchain/core/tools'

const tools = (await mcpClient.listTools()).map(t =>
  new DynamicStructuredTool({
    name: t.name,
    description: t.description ?? '',
    // Pass the advertised JSON Schema through. Substituting an empty schema
    // hides every parameter from the model and guarantees malformed calls.
    schema: t.inputSchema,
    func: async (args) => {
      const result = await mcpClient.callTool(t.name, args)
      return result.content.map(c => c.type === 'text' ? c.text : '[image]').join('\n')
    },
  })
)

const model = new ChatAnthropic({ model: 'claude-opus-4-5' }).bindTools(tools)
// Use with LangGraph agent executor as normal
```

## Pick the right approach first

Before screenshot + click, discover the app with `discover_applications({query: "office", include_capabilities: true})` when its identity is unknown. Use the returned `targetApp` for targeting; installed launch IDs are not always process IDs. Then use `get_tool_guide` and `get_app_capabilities` to choose the approach. Discovery never launches apps and is bounded to standard registration locations.

### macOS example
```typescript
const guide = JSON.parse((await client.getToolGuide('rename a file in Finder'))
  .content.find(c => c.type === 'text')!.text)
// → { approach: "scripting", toolSequence: ["run_script"] }

const caps = JSON.parse((await client.getAppCapabilities('com.apple.Finder'))
  .content.find(c => c.type === 'text')!.text)
// → { scriptable: true, accessible: true, ... }

await client.runScript('applescript',
  'tell application "Finder" to set name of file "old.txt" of desktop to "new.txt"')
```

### Windows example
```typescript
const guide = JSON.parse((await client.getToolGuide('copy files to desktop'))
  .content.find(c => c.type === 'text')!.text)
// → { approach: "scripting", toolSequence: ["filesystem", "run_script"] }

const caps = JSON.parse((await client.getAppCapabilities('notepad.exe'))
  .content.find(c => c.type === 'text')!.text)
// → { scriptable: false, powershell: true, accessible: true, running: true }

// Use filesystem tool for file ops
await client.callTool('filesystem', { mode: 'copy', path: 'report.txt', destination: 'C:\\Users\\Me\\Desktop\\report.txt' })

// Or PowerShell for complex tasks
await client.runScript('powershell', 'Get-ChildItem C:\\Users\\Me\\Desktop | Sort-Object LastWriteTime')
```

### Approach priority (high → low)

**macOS:**
1. **Scripting (`run_script`)** — AppleScript / JXA. Best for Mail, Safari, Finder, Numbers, Music, Messages, Notes, Calendar.
2. **Accessibility (`click_element`, `set_value`, `select_menu_item`, `fill_form`)** — Works for most GUI apps that expose AX.
3. **Coordinates (`left_click`, `type`, `key`)** — Fallback when nothing else works.

**Windows:**
1. **Built-in tools (`filesystem`, `registry`, `process_kill`)** — Direct operations without GUI interaction.
2. **PowerShell (`run_script`)** — System automation, COM objects, .NET calls.
3. **Accessibility (`click_element`, `set_value`, `fill_form`)** — UI Automation for GUI apps.
4. **Coordinates (`left_click`, `type`, `key`)** — Fallback when nothing else works.

### Applications with no accessible controls

Some applications draw their entire interface themselves and expose nothing to the
accessibility tree. Blender is the clearest example: `get_ui_tree` returns six
nodes — the window, its three title-bar buttons, a group and the title text — and
`find_element` for `File`, `Add` or `Render` finds nothing, because those menus are
painted in OpenGL. Its native macOS menu bar carries only Apple, Blender and
Window. `discover_applications` reports `scriptable: false, accessible: false`.

For these, every action is a coordinate or a keystroke read from pixels:

- `screenshot` and `zoom` to see. Capture the window, not the desktop, and read
  `get_window` bounds plus the returned image size to map image pixels back to
  logical desktop coordinates — the capture is scaled.
- `mouse_drag` for navigation. A 3D viewport orbits on a middle-button drag, pans
  on shift+middle and zooms on ctrl+middle; none of that is expressible with the
  single-button `left_click_drag`. Motion is interpolated because these
  applications integrate incremental movement and ignore a jump to the endpoint.
- `mouse_move` before `key`. Blender routes hotkeys to whichever editor the
  pointer is over, so position the pointer first, then press.
- `scroll` for wheel zoom.

```typescript
// Orbit a 3D viewport: middle-button drag across the centre of the window.
await client.callTool('mouse_drag', {
  path: [[cx, cy], [cx + 260, cy - 120]],
  button: 'middle',
  steps: 16,
  target_window_id: windowId,
  focus_strategy: 'strict',
})
// Pan instead, by holding shift for the whole gesture.
await client.callTool('mouse_drag', {
  path: [[cx, cy], [cx + 150, cy]], button: 'middle', modifiers: ['shift'], target_window_id: windowId,
})
```

Expect to verify visually after each step rather than trusting that an action
landed: there is no accessible state to read back.

### When `find_element` / `click_element` fails

Accessibility observations mark sensitive controls with value-free
`sensitive`/`sensitivitySignals` facts and return `value: null`; never infer or
request the hidden value. Treat ambiguous sensitive fields as unavailable and
ask the user to complete them directly.

The error payload includes ranked-by-similarity label suggestions. Use them instead of retrying blindly:

```typescript
// clickElement(windowId, role, label, opts?) — the window comes first.
const r = await client.clickElement(windowId, 'AXButton', 'Sumbit')
if (r.isError) {
  const err = JSON.parse(r.content[0].text)
  // err.similarLabels might be ["Submit", "Submit Form", "Send"]
  await client.clickElement(windowId, 'AXButton', err.similarLabels[0])
}
```

### When `select_menu_item` misses

The error returns `availableMenus` — the full menu bar structure — so you can adjust the path without another observation call:

```typescript
// selectMenuItem(bundleId, menu, item, submenu?, opts?) — `item` is the leaf,
// `submenu` is the optional level between `menu` and `item`.
const r = await client.selectMenuItem('com.apple.TextEdit', 'File', 'Save As…')
if (r.isError) {
  const err = JSON.parse(r.content[0].text)
  // err.availableMenus lets you find the right path (e.g. File ▸ Duplicate)
}
```

### Virtual Desktops / Spaces

**macOS:** `list_spaces` and `get_active_space` are reliable read-only tools. Space creation via CGS is not exposed (silently no-ops on SIP-enabled Macs).

**Windows:** Full virtual desktop lifecycle is supported:
```typescript
// List desktops
const spaces = await client.listSpaces()
// → { supported: true, displays: [{ spaces: [{ name: "Desktop 1", uuid: "{...}" }, ...] }] }

// Create a new desktop (Ctrl+Win+D)
const created = await client.createAgentSpace()
// → { created: true, name: "Desktop 4", space_id: "{...}" }  ← a GUID string on Windows

// Do work on the new desktop...
await client.callTool('run_script', { language: 'powershell', script: 'Start-Process notepad' })

// Close the desktop when done (Ctrl+Win+F4). Windows always closes the current
// desktop, so space_id is accepted and ignored; pass it through for traceability.
const { space_id } = JSON.parse(created.content.find(c => c.type === 'text').text)
await client.callTool('destroy_space', { space_id })

// Switch between desktops with keyboard shortcuts
await client.key('ctrl+win+left')   // previous desktop
await client.key('ctrl+win+right')  // next desktop
```

### When to use `focus_strategy: "prepare_display"` (v5.2)

If your mutating call returned a `FocusFailure` payload whose `frontmostAfter` shows a third-party app (screenshot watcher, notification panel, overlay) that you don't control, retry with `focus_strategy: "prepare_display"`. The session will hide every regular app except your target and the terminal, then activate — nothing else on screen can race you to the front.

```typescript
// Insert ▸ Shape ▸ Oval — the leaf is `item`, the level above it is `submenu`.
const first = await client.selectMenuItem('com.apple.freeform', 'Insert', 'Oval', 'Shape')
if (first.isError) {
  // Second try with the hammer: hide every other app first.
  await client.selectMenuItem('com.apple.freeform', 'Insert', 'Oval', 'Shape', {
    focusStrategy: 'prepare_display',
  })
}
```

The tool response gains a trailing JSON block with `hiddenBundleIds`. Save it so you can restore the user's layout with `unhide_app` after your automation finishes. Don't call `prepare_display` on every action — it's disruptive UX; use it only after a focus race has been observed.

## Best practices for agents

### Use window-level targeting for multi-window apps

When an app has multiple windows (e.g., a spreadsheet and a settings dialog), use `target_window_id` instead of `target_app` to ensure input goes to the right window:

```typescript
// 1. List windows to find the one you want
const windows = await client.listWindows('com.apple.iWork.Numbers')
// 2. Pick the target window from the list
const targetId = 12345  // from the list_windows response
// 3. Use target_window_id for precise targeting
await client.key('command+v', undefined, { targetWindowId: targetId, focusStrategy: 'strict' })
```

### Always specify `target_app` or `target_window_id`

Agents should explicitly target the app or window they want to control to avoid sending keystrokes to the wrong place:

```typescript
// macOS — use bundle IDs
await client.type('Hello', 'com.apple.TextEdit')
await client.key('command+s', 'com.apple.TextEdit')

// Windows — use process names
await client.type('Hello', 'notepad.exe')
await client.key('ctrl+s', 'notepad.exe')
```

### Screenshot before acting
Take a screenshot first to understand the current state before clicking or typing:

```typescript
const shot = await client.screenshot()
// Pass shot to the model to understand what's on screen
// Then decide where to click
```

### Use zoom for small text or details
When you need to read small text, verify a value, or inspect a specific UI element closely, use `zoom` instead of taking a full screenshot:

```typescript
// Zoom into a 400x300 region at coordinates (500, 200)
const zoomed = await client.callTool('zoom', { region: [500, 200, 900, 500] })
// Returns the region at full native resolution (no downscaling)
// Default format is PNG (lossless) — best for text readability
```

### Use PNG for pixel-perfect screenshots
When you need lossless quality (OCR, text reading, pixel comparison), set `quality: 0`:

```typescript
const shot = await client.screenshot({ quality: 0 })  // PNG, lossless
const shot2 = await client.screenshot({ quality: 80 }) // JPEG, smaller file
```

### Use clipboard for long text
For typing long content, use clipboard paste instead of `type` — it's faster and more reliable:

```typescript
await client.writeClipboard(longText)
// macOS
await client.key('command+v', targetApp)
// Windows
await client.key('ctrl+v', targetApp)
```

The `type` tool already routes long or newline-containing text through the
clipboard internally, so a single `type` call is reliable for multi-line text.
Prefer **one** `type` call with the full block over many rapid back-to-back
calls — rapid successive calls can race the clipboard save/restore.

### Windows 11 Notepad (single-instance, tabbed, session-restoring)

Modern Notepad reuses one process, opens files as **tabs**, and restores the
previous session on launch. `Start-Process notepad` therefore does **not** give
you a clean document — it may add a tab to a window that already holds the
user's work. To automate it safely:

- **Work in a fresh tab.** If a Notepad window already exists, activate it and
  press `Ctrl+N` for a new tab; only launch a new process when none is running.
  Never assume the active tab is empty.
- **Save via accessibility, not blind keystrokes.** After `Ctrl+S`, set the
  dialog's file-name field and press Save directly:
  ```typescript
  await client.key('ctrl+s', undefined, { targetWindowId: winId, focusStrategy: 'strict' })
  await client.setValue(winId, 'AXTextField', 'File name:', savePath)
  await client.pressButton(winId, 'Save')
  await client.pressButton(winId, 'Yes') // confirm overwrite if prompted (no-op otherwise)
  ```
- **Close only your tab with `Ctrl+W`, never `Alt+F4`.** `Alt+F4` closes the
  whole window (all tabs, including the user's). For an unsaved scratch tab,
  press the "Don't save" button to discard.
- **Avoid `Stop-Process notepad` for cleanup.** Force-killing leaves the session
  dirty, so Notepad resurrects (and accumulates) tabs on the next launch.

### Use `activate_window` for recovery

When a focus failure occurs, use the structured diagnostics to recover:

```typescript
const result = await client.key('command+v', undefined, {
  targetWindowId: 12345,
  focusStrategy: 'strict'
})

// If focus failed, check the error and recover
if (result.isError) {
  const error = JSON.parse(result.content[0].text)
  if (error.suggestedRecovery === 'activate_window') {
    await client.activateWindow(error.requestedWindowId)
    // Retry the original action
    await client.key('command+v', undefined, {
      targetWindowId: 12345,
      focusStrategy: 'strict'
    })
  } else if (error.suggestedRecovery === 'unhide_app') {
    await client.unhideApp(error.requestedBundleId)
    await client.wait(0.5)
    await client.activateWindow(error.requestedWindowId)
    // Retry
  } else if (error.suggestedRecovery === 'open_application') {
    await client.openApp(error.requestedBundleId)
    await client.wait(2)
    // Retry
  }
}
```

### Use `activate_app` for structured diagnostics

Instead of `open_application`, use `activate_app` when you need to verify activation succeeded:

```typescript
const result = await client.activateApp('com.apple.Safari')
const diag = JSON.parse(result.content.find(c => c.type === 'text')?.text ?? '{}')
if (!diag.activated) {
  if (diag.reason === 'hidden') {
    await client.unhideApp('com.apple.Safari')
  } else if (diag.reason === 'not_running') {
    await client.openApp('com.apple.Safari')
    await client.wait(2)
  }
}
```

### Coordinate system
Coordinates are in logical pixels (not physical pixels on Retina displays). Use `get_display_size` to get the screen dimensions before calculating click positions:

```typescript
const size = await client.getDisplaySize()
// size contains width, height, pixelWidth, pixelHeight, scaleFactor
```


## Direct system access tools

These tools provide system access without GUI interaction. The examples use
Windows paths, but only `registry` and `notification` are Windows-only —
`filesystem`, `process_kill`, `resize_window`, `snapshot` and `scrape` all work
on macOS and Linux too. See the platform table below.

### FileSystem
```typescript
// Read a file
await client.callTool('filesystem', { mode: 'read', path: 'C:\\Users\\Me\\report.txt' })

// Write a file (relative paths resolve from Desktop)
await client.callTool('filesystem', { mode: 'write', path: 'notes.txt', content: 'Hello' })

// List directory
await client.callTool('filesystem', { mode: 'list', path: 'C:\\Users\\Me\\Documents' })

// Search for files
await client.callTool('filesystem', { mode: 'search', path: 'C:\\Users\\Me', pattern: '*.pdf', recursive: true })
```

### Registry
```typescript
// Read a registry value
await client.callTool('registry', { mode: 'get', path: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion', name: 'ProgramFilesDir' })

// Set a registry value
await client.callTool('registry', { mode: 'set', path: 'HKCU:\\Software\\MyApp', name: 'Setting', value: '42', type: 'DWord' })

// List registry keys
await client.callTool('registry', { mode: 'list', path: 'HKCU:\\Software\\Microsoft' })
```

### Process management
```typescript
// List running processes (sorted by memory)
await client.callTool('process_kill', { mode: 'list', sort_by: 'memory', limit: 10 })

// Kill a process by name
await client.callTool('process_kill', { mode: 'kill', name: 'notepad.exe' })

// Force kill by PID
await client.callTool('process_kill', { mode: 'kill', pid: 1234, force: true })
```

### Notifications
```typescript
await client.callTool('notification', { title: 'Task Complete', message: 'Your automation finished successfully' })
```

### Window resize/move
```typescript
// Resize the foreground window
await client.callTool('resize_window', { window_size: [800, 600] })

// Move and resize a specific window
await client.callTool('resize_window', { window_name: 'notepad', window_size: [600, 400], window_loc: [100, 100] })
```

### Snapshot (combined state capture)
```typescript
// Get everything in one call: screenshot + UI tree + windows + desktops
const snap = await client.callTool('snapshot', { use_vision: true, use_annotation: true, width: 800 })
// Returns: desktop info text, annotated screenshot image, window annotations

// With grid reference lines for spatial reasoning
await client.callTool('snapshot', { use_vision: true, grid_lines: [4, 3] })
```

### Scrape (web content)
```typescript
await client.callTool('scrape', { url: 'https://example.com' })
// Returns clean text extracted from the web page
```

## Platform compatibility

Verified against the platform guards in `src/session/` and the `target_os` gates in
`native/src/`. An available tool is not a promise that every application exposes
usable controls.

| Tool | macOS | Windows | Linux |
|---|---|---|---|
| screenshot, zoom, click, type, key, scroll, mouse_move | ✅ | ✅ | ✅ X11; Wayland needs `ydotool` |
| clipboard (read/write) | ✅ | ✅ | ✅ |
| window management (list, activate, hide/unhide) | ✅ | ✅ | ✅ |
| UI automation (get_ui_tree, find_element, click_element) | ✅ | ✅ | ✅ AT-SPI |
| run_script | AppleScript, JXA | PowerShell | bash, PowerShell (`pwsh`) |
| get_app_dictionary, list_menu_bar | ✅ | ❌ macOS only | ❌ macOS only |
| filesystem | ✅ | ✅ | ✅ |
| registry, notification | ❌ Windows only | ✅ | ❌ Windows only |
| process_kill | ✅ | ✅ | ✅ |
| virtual desktops (list, create, destroy) | Read-only | Full lifecycle | ❌ |
| snapshot (combined capture) | ✅ | ✅ | ✅ |
| scrape | ✅ | ✅ | ✅ |
| resize_window | ✅ AppleScript | ✅ | ❌ use `wmctrl`/`xdotool` via run_script |
| multi_select, multi_edit | ✅ | ✅ | ✅ X11 only |
| mouse_drag (button + modifiers) | ✅ | ✅ | ✅ X11 only |
| doctor, discover_applications, get_tool_guide, get_tool_metadata | ✅ | ✅ | ✅ |

Tools that exist in the catalog but have no implementation on the running platform
return a structured `platform_unsupported` result naming the supported platforms
and the alternative to use, so the tool count is the same everywhere.
