# Using computer-use-mcp with AI Agents

This guide covers how to integrate `computer-use-mcp` into AI agent frameworks and agentic workflows. Works on both **macOS** and **Windows**.

## Tool priority guidance

Desktop computer use should be your **last resort**. Always prefer more precise tools:

1. **Connector / integration** — structured APIs, MCP connectors, app-specific plugins
2. **Shell / filesystem** — terminal commands, file I/O, CLI tools
3. **Browser automation** — Playwright, Puppeteer, Browser Use for web pages
4. **Desktop computer use** — this package, for native desktop apps, simulators, installers, modal dialogs, and UI-only workflows

Desktop control works for anything on screen, but structured tools are faster, more reliable, and easier to recover from.

## Quick setup for any agent

The server speaks standard MCP over stdio. Start it with:

```bash
npx @zavora-ai/computer-use-mcp
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
        input_schema: { type: 'object', properties: {} }
      })),
      messages,
    })

    if (response.stop_reason === 'end_turn') break

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

## OpenAI Agents SDK

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
    parameters: { type: 'object', properties: {}, additionalProperties: true },
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
import { z } from 'zod'

const tools = (await mcpClient.listTools()).map(t =>
  new DynamicStructuredTool({
    name: t.name,
    description: t.description ?? '',
    schema: z.object({}).passthrough(),
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

Before screenshot + click, call the two discovery tools. They exist to save context tokens and wall-clock time.

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

### When `find_element` / `click_element` fails

The error payload includes ranked-by-similarity label suggestions. Use them instead of retrying blindly:

```typescript
const r = await client.clickElement({ role: 'AXButton', label: 'Sumbit', target_app: 'com.example.app' })
if (r.isError) {
  const err = JSON.parse(r.content[0].text)
  // err.similarLabels might be ["Submit", "Submit Form", "Send"]
  await client.clickElement({ role: 'AXButton', label: err.similarLabels[0], target_app: 'com.example.app' })
}
```

### When `select_menu_item` misses

The error returns `availableMenus` — the full menu bar structure — so you can adjust the path without another observation call:

```typescript
const r = await client.selectMenuItem({ menu_path: ['File', 'Save As…'], target_app: 'com.apple.TextEdit' })
if (r.isError) {
  const err = JSON.parse(r.content[0].text)
  // err.availableMenus lets you find the right path (e.g. ["File", "Duplicate"])
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
await client.createAgentSpace()
// → { created: true, name: "Desktop 4", space_id: "{...}" }

// Do work on the new desktop...
await client.callTool('run_script', { language: 'powershell', script: 'Start-Process notepad' })

// Close the desktop when done (Ctrl+Win+F4)
await client.callTool('destroy_space', { space_id: 0 })

// Switch between desktops with keyboard shortcuts
await client.key('ctrl+win+left')   // previous desktop
await client.key('ctrl+win+right')  // next desktop
```

### When to use `focus_strategy: "prepare_display"` (v5.2)

If your mutating call returned a `FocusFailure` payload whose `frontmostAfter` shows a third-party app (screenshot watcher, notification panel, overlay) that you don't control, retry with `focus_strategy: "prepare_display"`. The session will hide every regular app except your target and the terminal, then activate — nothing else on screen can race you to the front.

```typescript
try {
  await client.selectMenuItem('com.apple.freeform', 'Insert', 'Shape', 'Oval')
} catch (err) {
  // Second try with the hammer: hide every other app first.
  await client.selectMenuItem('com.apple.freeform', 'Insert', 'Shape', 'Oval', {
    focus_strategy: 'prepare_display',
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


## Windows-specific tools

These tools are available on Windows and provide direct system access without GUI interaction:

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

| Tool | macOS | Windows |
|---|---|---|
| screenshot, zoom, click, type, key, scroll, mouse_move ✅ |
| clipboard (read/write) | ✅ | ✅ |
| window management (list, activate, hide/unhide) | ✅ | ✅ |
| UI automation (get_ui_tree, find_element, click_element) | ✅ | ✅ |
| run_script | AppleScript, JXA | PowerShell |
| get_app_dictionary, list_menu_bar | ✅ | ❌ (macOS only) |
| filesystem, registry, notification | ❌ | ✅ (Windows only) |
| process_kill | ✅ | ✅ |
| virtual desktops (list, create, destroy) | Read-only | Full lifecycle |
| snapshot (combined capture) | ✅ | ✅ |
| scrape | ✅ | ✅ |
| resize_window | ❌ | ✅ |
| multi_select, multi_edit | ✅ | ✅ |
