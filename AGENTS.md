# Using computer-use-mcp with AI Agents

This guide covers how to integrate `computer-use-mcp` into AI agent frameworks and agentic workflows.

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

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Restart Claude Desktop. Claude will automatically use the tools when asked to interact with your Mac.

**Example prompts:**
- *"Take a screenshot and tell me what's on my screen"*
- *"Open Safari, go to github.com, and find the trending repositories"*
- *"Open TextEdit, write a short poem, and save it to the desktop"*

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

## v5: pick the right approach first

Before screenshot + click, call the two discovery tools. They exist to save context tokens and wall-clock time — a scriptable app can be driven by one `run_script` call that would otherwise take a dozen screenshot / click / verify round-trips.

```typescript
// 1. Tell the guide what you're trying to do
const guide = JSON.parse((await client.getToolGuide('rename a file in Finder'))
  .content.find(c => c.type === 'text')!.text)
// → { recommendedApproach: "scripting", suggestedTools: ["run_script"] }

// 2. Confirm the app supports that approach
const caps = JSON.parse((await client.getAppCapabilities('com.apple.Finder'))
  .content.find(c => c.type === 'text')!.text)
// → { scriptable: true, accessible: true, ... }

// 3. Use the suggested tool
await client.runScript({
  language: 'applescript',
  script: 'tell application "Finder" to set name of file "old.txt" of desktop to "new.txt"',
})
```

### Approach priority (high → low)

1. **Scripting (`run_script`)** — AppleScript / JXA. Best for Mail, Safari, Finder, Numbers, Music, Messages, Notes, Calendar.
2. **Accessibility (`click_element`, `set_value`, `select_menu_item`, `fill_form`)** — Works for most GUI apps that expose AX. Survives window moves, resolution changes, and retina scaling.
3. **Coordinates (`left_click`, `type`, `key`)** — Fallback when nothing else works. Brittle across layouts.

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

### Spaces

`list_spaces` and `get_active_space` are reliable — use them to tell which Space a window is in. Space creation / window moves via CGS are **not exposed**: they silently no-op or orphan Spaces on SIP-enabled Macs. If you need a new Space, ask the user to create one in Mission Control.

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
await client.type('Hello', 'com.apple.TextEdit')
await client.key('command+s', 'com.apple.TextEdit')
```

### Screenshot before acting
Take a screenshot first to understand the current state before clicking or typing:

```typescript
const shot = await client.screenshot()
// Pass shot to the model to understand what's on screen
// Then decide where to click
```

### Use clipboard for long text
For typing long content, use clipboard paste instead of `type` — it's faster and more reliable:

```typescript
await client.writeClipboard(longText)
await client.key('command+v', targetApp)
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
